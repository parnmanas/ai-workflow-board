// Self-update for agent-manager.
//
// Two install modes, selected by detectInstallMode() (see InstallMode):
//   - 'git'        — running from an AWB monorepo checkout. Version-check =
//                    `git fetch` + read `origin/<branch>:.../package.json`;
//                    self-update = fetch → detached checkout → npm build →
//                    detached re-exec with `--force`.
//   - 'npm-global' — installed via `npm i -g awb-agent-manager` (no checkout,
//                    running file lives under `npm root -g`). Version-check =
//                    `npm view awb-agent-manager version` (registry);
//                    self-update = a detached temp helper that waits for this
//                    process to exit, runs `npm install -g
//                    awb-agent-manager@latest`, then relaunches the manager
//                    (install-after-exit dodges the Windows self-overwrite
//                    EBUSY/EPERM).
//   - 'unknown'    — neither (packaged/vendored copy): auto-update impossible,
//                    the admin UI shows a manual-upgrade hint.
//
// Cadence (both modes):
//   - UpdateChecker (slow timer, default 5 min) refreshes the cached
//     `latest_version` / `update_available` snapshot so InstanceHeartbeat can
//     attach it to every payload without paying the network cost each tick.
//   - runSelfUpdate() (one-shot, fired by `update_manager` SSE command or
//     SIGUSR1) does the heavy lifting for the active install mode.

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, statSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve, join, relative, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { log } from './logging.js';
import { AGENT_MANAGER_HOME } from './constants.js';

const PACKAGE_JSON_REL = 'apps/agent-manager/package.json';
// Our own npm package name. detectRepoRoot() uses this to tell an actual AWB
// monorepo checkout apart from an *unrelated* ancestor `.git` (a home dotfiles
// repo, a git-tracked prefix an `npm i -g` install happens to sit under). It is
// also the registry spec the npm-global mode reads / installs.
const MANAGER_PACKAGE_NAME = 'awb-agent-manager';
// `npm install -g <this>` / `npm view <pkg> version` target for npm-global mode.
const NPM_GLOBAL_LATEST_SPEC = `${MANAGER_PACKAGE_NAME}@latest`;
const DEFAULT_CHECK_INTERVAL_MS = 5 * 60 * 1000;
const FETCH_TIMEOUT_MS = 30_000;
const NPM_VIEW_TIMEOUT_MS = 30_000;
const BUILD_TIMEOUT_MS = 10 * 60_000;
const MANAGED_GIT_RUNTIME = join(AGENT_MANAGER_HOME, 'runtime');

/**
 * How this manager binary was installed — decides the self-update strategy.
 *   - 'git'        — running from an AWB monorepo checkout (detectRepoRoot != null).
 *   - 'npm-global' — no checkout, but the running file sits under `npm root -g`
 *                    (installed via `npm i -g awb-agent-manager`).
 *   - 'unknown'    — neither (packaged / vendored copy): auto-update impossible.
 */
export type InstallMode = 'git' | 'npm-global' | 'unknown';

export interface RepoInfo {
  root: string;
  branch: string;
}

export interface UpdateStatus {
  /** Currently-running manager version (from package.json on disk). */
  current_version: string;
  /** Latest version from `origin/<branch>:apps/agent-manager/package.json`,
   *  or null when we couldn't read it (no repo / network error / first tick
   *  hasn't run yet). */
  latest_version: string | null;
  /** True when latest_version > current_version (semver-aware). False when
   *  equal or current is ahead (dev branch). */
  update_available: boolean;
  /** How this manager was installed — the self-update strategy selector.
   *  'git' checks a git remote; 'npm-global' checks the npm registry and can
   *  auto-update via `npm i -g`; 'unknown' can only be upgraded manually. */
  install_mode: InstallMode;
  /** Absolute repo root, or null when not running from a git checkout. */
  repo_root: string | null;
  /** Default-branch the checker is tracking ('main' typically). null when
   *  not running from a git checkout. */
  branch: string | null;
  /** ISO-8601 timestamp of the last successful remote check; null until the
   *  first check completes. */
  last_checked_at: string | null;
  /** Last error message from the checker, or null when last check succeeded.
   *  Surfaced to operators so a silently-failing fetch is debuggable from the
   *  admin dashboard. */
  last_error: string | null;
}

export interface SelfUpdateResult {
  changed: boolean;
  summary: string;
  /** Set when runSelfUpdate scheduled a detached re-exec. The caller (SSE
   *  command handler / SIGUSR1 path) inspects this so it can hand the ack
   *  POST + log line a head start before the parent exits. */
  willReExec?: boolean;
}

export interface SelfUpdateOpts {
  log?: (msg: string) => void;
  /** Skip the actual re-exec — useful for tests / dry runs. */
  noReExec?: boolean;
}

interface RunResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
}

/**
 * True when `dir` is the root of THIS monorepo — it carries
 * `apps/agent-manager/package.json` whose name is our own package. This is
 * the guard that keeps detectRepoRoot() from latching onto an *unrelated*
 * ancestor `.git`: a home-dir dotfiles repo, or any git-tracked prefix an
 * `npm i -g awb-agent-manager` install happens to sit beneath.
 *
 * Without it, a false-positive repo root feeds the self-update machinery
 * someone else's checkout, where `git fetch` + `git show
 * origin/<branch>:apps/agent-manager/package.json` both fail. That drives the
 * admin badge to a scary "(update check failed)" on what is really a plain
 * npm-global install that should read "(manual updates only)".
 */
function isAwbRepoRoot(dir: string): boolean {
  try {
    const pkgPath = join(dir, PACKAGE_JSON_REL);
    if (!existsSync(pkgPath)) return false;
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
    return pkg?.name === MANAGER_PACKAGE_NAME;
  } catch {
    return false;
  }
}

/**
 * Walk up from this file's location until we hit the root of THIS monorepo —
 * a directory that both contains `.git` AND carries our own
 * `apps/agent-manager/package.json`. Returns null when the manager isn't
 * running from an AWB checkout (npm-global install, packaged binary, or an
 * install nested under an unrelated git repo).
 *
 * The `.git`-plus-package check is deliberate: a bare `.git` test alone
 * false-positives on an ancestor dotfiles/monorepo `.git` above an
 * `npm i -g` prefix, handing self-update a foreign checkout it can't fetch
 * from (see isAwbRepoRoot). When a `.git` belongs to someone else's repo we
 * keep walking up rather than returning it, so the traversal ends at null and
 * the install is correctly reported as "manual updates only".
 */
export function detectRepoRoot(_startDir?: string): string | null {
  // Self-update must never infer ownership from the running script's parents.
  // Only the manager-owned fallback runtime is disposable/updateable.
  return existsSync(join(MANAGED_GIT_RUNTIME, '.git')) && isAwbRepoRoot(MANAGED_GIT_RUNTIME)
    ? MANAGED_GIT_RUNTIME
    : null;
}

/**
 * True when `child` is `parent` itself or nested beneath it. Path-segment safe
 * (a `relative()` that stays within the tree has no leading `..` and isn't
 * absolute) so `.../npm/node_modules` does NOT match `.../npm/node_modules-x`.
 */
function isPathInside(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/**
 * Absolute path of npm's GLOBAL `node_modules` (`npm root -g`), or null when
 * npm can't be reached. Best-effort + bounded: a slow/absent npm just yields a
 * null root → the caller falls back to install mode 'unknown', never throws.
 */
function detectNpmGlobalRoot(): string | null {
  // shell:true on Windows so `npm` resolves the `npm.cmd` shim via PATH.
  const r = runSyncShell('npm', ['root', '-g'], 10_000);
  if (!r.ok) return null;
  const root = r.stdout.split('\n').map((s) => s.trim()).filter(Boolean).pop();
  return root ? resolve(root) : null;
}

/**
 * Pure install-mode classifier — separated from the detectors so it can be
 * unit-tested without spawning `git` / `npm`. See InstallMode for the meaning
 * of each result.
 *   - repoRoot present            → 'git'
 *   - running file under npmRoot  → 'npm-global'
 *   - otherwise                   → 'unknown'
 */
export function classifyInstallMode(
  runningDir: string,
  repoRoot: string | null,
  npmGlobalRoot: string | null,
): InstallMode {
  // npm is the canonical distribution channel even when an older service is
  // still launched from a source checkout. This prevents self-update from
  // moving/stashing the operator's repository. Git is fallback-only when npm
  // is genuinely unavailable.
  if (npmGlobalRoot) return 'npm-global';
  if (repoRoot) return 'git';
  if (npmGlobalRoot && isPathInside(npmGlobalRoot, runningDir)) return 'npm-global';
  return 'unknown';
}

/**
 * Classify how this manager was installed. Wires the real detectors into
 * classifyInstallMode(): detectRepoRoot() for 'git', and `npm root -g` +
 * a path-containment check for 'npm-global'. npm is probed even for a checkout
 * because it is the preferred update channel; git is fallback-only.
 */
export function detectInstallMode(startDir?: string): InstallMode {
  const runningDir = resolve(startDir || dirname(fileURLToPath(import.meta.url)));
  const repoRoot = detectRepoRoot(startDir);
  const npmGlobalRoot = detectNpmGlobalRoot();
  return classifyInstallMode(runningDir, repoRoot, npmGlobalRoot);
}

/**
 * Read `apps/agent-manager/package.json` from a working tree (current
 * checkout). The manager's own version lives here; we use this when the
 * manager is invoked from a binary build that doesn't carry its source pkg.
 */
function readWorkingTreeVersion(repoRoot: string): string | null {
  try {
    const pkgPath = join(repoRoot, PACKAGE_JSON_REL);
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
    return typeof pkg?.version === 'string' ? pkg.version : null;
  } catch {
    return null;
  }
}

/**
 * Read the manager's own running version from a build-time snapshot of
 * package.json baked into dist/ during `npm run build`.
 *
 * Priority:
 *   1. `dist/package.json`  — copied by the build script, frozen at build
 *      time. Immune to subsequent `git pull` / `git checkout` touching the
 *      working-tree package.json while the process is still running the old
 *      dist.
 *   2. `../../package.json` — fallback for dev mode (`tsx watch src/…`)
 *      where dist/ doesn't exist yet; in that case the working tree IS the
 *      running code, so reading the live file is correct.
 *   3. `'0.0.0'`           — last-resort so callers never crash.
 */
export function readBundledVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    // When running from dist/lib/self-update.js, ../package.json is
    // dist/package.json (build-time snapshot).
    const distPkg = resolve(here, '..', 'package.json');
    if (existsSync(distPkg)) {
      const pkg = JSON.parse(readFileSync(distPkg, 'utf8'));
      if (typeof pkg?.version === 'string') return pkg.version;
    }
    // Fallback: ../../package.json (working-tree root, used in dev mode).
    const rootPkg = resolve(here, '..', '..', 'package.json');
    const pkg = JSON.parse(readFileSync(rootPkg, 'utf8'));
    return typeof pkg?.version === 'string' ? pkg.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/**
 * Detect the remote's default branch (usually 'main') from the local
 * `origin/HEAD` symbolic ref. This is what the UpdateChecker should
 * track — not the currently-checked-out branch, which on a dev machine
 * could be anything (`production.private`, a feature branch, …).
 *
 * Falls back to 'main' when `origin/HEAD` is unset (bare clone, fresh
 * remote, `git remote set-head origin --delete`).
 */
function detectDefaultBranch(repoRoot: string): string {
  // `git symbolic-ref refs/remotes/origin/HEAD` → refs/remotes/origin/main
  const r = runSync(
    'git',
    ['-C', repoRoot, 'symbolic-ref', 'refs/remotes/origin/HEAD'],
    5_000,
  );
  if (r.ok) {
    const ref = r.stdout.trim(); // e.g. "refs/remotes/origin/main"
    const match = ref.match(/^refs\/remotes\/origin\/(.+)$/);
    if (match?.[1]) return match[1];
  }
  return 'main';
}

/**
 * Compare two semver-ish strings. Returns -1, 0, 1 for a<b, a==b, a>b.
 * Tolerates any prerelease / build suffix by stripping it (we only care
 * about the numeric core).
 */
export function compareSemver(a: string, b: string): number {
  const parse = (v: string): number[] => {
    const core = v.split(/[-+]/, 1)[0];
    const parts = core.split('.').map((p) => parseInt(p, 10));
    while (parts.length < 3) parts.push(0);
    return parts.map((n) => (Number.isFinite(n) ? n : 0));
  };
  const aa = parse(a);
  const bb = parse(b);
  for (let i = 0; i < 3; i++) {
    if (aa[i] !== bb[i]) return aa[i] < bb[i] ? -1 : 1;
  }
  return 0;
}

/**
 * Run a shell command synchronously, capturing stdout / stderr. Used for
 * the bounded git lookups that feed the heartbeat — async would just
 * complicate the cadence loop without any gain on these sub-second calls.
 */
function runSync(cmd: string, args: string[], timeoutMs: number): RunResult {
  const r = spawnSync(cmd, args, {
    encoding: 'utf8',
    timeout: timeoutMs,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return {
    ok: r.status === 0 && !r.error,
    stdout: r.stdout || '',
    stderr: r.stderr || '',
    exitCode: r.status,
    signal: r.signal,
  };
}

/**
 * Like runSync but with `shell:true` on Windows so `npm`/`npm.cmd` resolves via
 * PATH (a bare `spawnSync('npm', …)` can't exec a `.cmd` shim without a shell).
 * Used for the bounded npm lookups (`npm root -g`) that feed install-mode
 * detection at construction time. Args here are fixed literals — no user input —
 * so shell quoting is a non-issue.
 */
function runSyncShell(cmd: string, args: string[], timeoutMs: number): RunResult {
  const r = spawnSync(cmd, args, {
    encoding: 'utf8',
    timeout: timeoutMs,
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: process.platform === 'win32',
  });
  return {
    ok: r.status === 0 && !r.error,
    stdout: r.stdout || '',
    stderr: r.stderr || '',
    exitCode: r.status,
    signal: r.signal,
  };
}

/**
 * Run a shell command asynchronously, capturing stdout / stderr with a
 * hard timeout. Used for the long-running self-update steps (npm install,
 * npm run build) where blocking the event loop would stall the heartbeat.
 */
function runAsync(
  cmd: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
  onLine?: (line: string) => void,
): Promise<RunResult> {
  return new Promise((resolve) => {
    // Windows requires shell:true to resolve npm.cmd / git.exe shims via
    // PATH. POSIX is fine without shell, which keeps argument quoting
    // unambiguous for paths containing spaces.
    const isWin = process.platform === 'win32';
    const child = spawn(cmd, args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: isWin,
      env: process.env,
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
      resolve({ ok: false, stdout, stderr: stderr + `\n[timeout after ${timeoutMs}ms]`, exitCode: null, signal: 'SIGKILL' });
    }, timeoutMs);
    child.stdout?.on('data', (b) => {
      const s = String(b);
      stdout += s;
      onLine?.(s.trimEnd());
    });
    child.stderr?.on('data', (b) => {
      const s = String(b);
      stderr += s;
      onLine?.(s.trimEnd());
    });
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: false, stdout, stderr: stderr + `\n[spawn error: ${err?.message ?? err}]`, exitCode: null, signal: null });
    });
    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: code === 0, stdout, stderr, exitCode: code, signal });
    });
  });
}

/**
 * Read `apps/agent-manager/package.json` from `origin/<branch>` without
 * checking out anything. Returns the parsed version, or null on any
 * failure.
 */
function readRemoteVersion(repoRoot: string, branch: string): string | null {
  // First try origin/<branch>; falls back to the default ref of `origin`
  // in case `origin/<branch>` doesn't exist yet (fresh clone, no fetch).
  const refs = [`origin/${branch}:${PACKAGE_JSON_REL}`, `origin/HEAD:${PACKAGE_JSON_REL}`];
  for (const ref of refs) {
    const r = runSync('git', ['-C', repoRoot, 'show', ref], 10_000);
    if (!r.ok) continue;
    try {
      const pkg = JSON.parse(r.stdout);
      const v = typeof pkg?.version === 'string' ? pkg.version : null;
      if (v) return v;
    } catch {
      /* try next ref */
    }
  }
  return null;
}

/**
 * Periodically refresh the remote version cache so the heartbeat can
 * advertise an up-to-date `latest_version` without paying the round-trip
 * cost on every 30s tick.
 */
export class UpdateChecker {
  #status: UpdateStatus;
  #timer: NodeJS.Timeout | null = null;
  #stopped = false;
  #intervalMs: number;
  #log: (msg: string) => void;

  constructor(opts: { intervalMs?: number; log?: (msg: string) => void } = {}) {
    this.#intervalMs = opts.intervalMs ?? DEFAULT_CHECK_INTERVAL_MS;
    this.#log = opts.log ?? log;
    const repoRoot = detectRepoRoot();
    // Classify the install once at boot. In git mode we skip the `npm root -g`
    // spawn entirely; in the no-checkout case it decides npm-global vs unknown.
    const runningDir = resolve(dirname(fileURLToPath(import.meta.url)));
    const npmGlobalRoot = detectNpmGlobalRoot();
    const install_mode = classifyInstallMode(runningDir, repoRoot, npmGlobalRoot);
    const branch = repoRoot ? detectDefaultBranch(repoRoot) : null;
    // Prefer the build-time snapshot (dist/package.json) over the working-tree
    // file. On dev machines the repo root is also the running source tree, so
    // `readWorkingTreeVersion(repoRoot)` returns whatever version the working
    // tree currently has — which drifts ahead of the actually-running dist
    // after a `git pull` that wasn't followed by a rebuild. The bundled
    // version is frozen at build time and always matches the running code.
    const current_version = readBundledVersion() || (repoRoot && readWorkingTreeVersion(repoRoot)) || '0.0.0';
    // last_error is reserved for actionable failures (fetch couldn't reach
    // the remote, package.json couldn't be read, …). The "not running from
    // a git checkout" case is signalled via repo_root === null + a one-line
    // log on start; the UI uses the null repo_root to render a distinct
    // "manual updates only" badge instead of a misleading "check failed".
    this.#status = {
      current_version,
      latest_version: null,
      update_available: false,
      install_mode,
      repo_root: repoRoot,
      branch,
      last_checked_at: null,
      last_error: null,
    };
  }

  /** Snapshot of the current cache. Heartbeat reads this on every tick. */
  status(): UpdateStatus {
    // Defensive copy so the caller can't accidentally mutate the cache.
    return { ...this.#status };
  }

  start(): void {
    if (this.#stopped || this.#timer) return;
    // npm-global mode polls the npm registry instead of a git remote — no
    // repo_root, but still a live checker. Must be handled before the
    // repo_root guard below or it would be misfiled as "auto-update disabled".
    if (this.#status.install_mode === 'npm-global') {
      this.#tick().catch(() => undefined);
      this.#timer = setInterval(() => {
        this.#tick().catch(() => undefined);
      }, this.#intervalMs);
      this.#timer.unref?.();
      this.#log(
        `UpdateChecker started (npm-global mode: npm view ${MANAGER_PACKAGE_NAME} ` +
          `interval=${Math.round(this.#intervalMs / 1000)}s)`,
      );
      return;
    }
    if (!this.#status.repo_root) {
      this.#log(
        'UpdateChecker: not running from a git checkout or npm-global install — auto-update disabled',
      );
      return;
    }
    // Fire once immediately (best-effort), then every interval.
    this.#tick().catch(() => undefined);
    this.#timer = setInterval(() => {
      this.#tick().catch(() => undefined);
    }, this.#intervalMs);
    this.#timer.unref?.();
    this.#log(
      `UpdateChecker started (root=${this.#status.repo_root} branch=${this.#status.branch} ` +
        `interval=${Math.round(this.#intervalMs / 1000)}s)`,
    );
  }

  stop(): void {
    this.#stopped = true;
    if (this.#timer) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
  }

  /** Force a check now (used by SSE handler post-update to refresh the
   *  cache so the next heartbeat already shows update_available=false). */
  async checkNow(): Promise<UpdateStatus> {
    await this.#tick();
    return this.status();
  }

  async #tick(): Promise<void> {
    if (this.#stopped) return;
    // npm-global mode reads the registry, not a git remote.
    if (this.#status.install_mode === 'npm-global') {
      await this.#tickNpmGlobal();
      return;
    }
    const repoRoot = this.#status.repo_root;
    const branch = this.#status.branch;
    if (!repoRoot || !branch) return;
    try {
      // git fetch is the slow step. Run it async so we don't block the
      // event loop; restrict to the single branch we care about so an
      // operator with a 100-branch fork doesn't pay for the full fetch.
      const fetchResult = await runAsync(
        'git',
        ['-C', repoRoot, 'fetch', '--quiet', 'origin', branch],
        repoRoot,
        FETCH_TIMEOUT_MS,
      );
      if (!fetchResult.ok) {
        // Fetch failed (SSH key unavailable in systemd context, network
        // down, …). Still try reading the existing `origin/<branch>` ref —
        // it may be stale but is far more useful than showing "check failed"
        // with no version info at all. Only set last_error if the fallback
        // read also fails.
        const stale = readRemoteVersion(repoRoot, branch);
        if (stale) {
          const current = this.#status.current_version;
          const update_available = compareSemver(stale, current) > 0;
          const detail = (fetchResult.stderr.trim() || fetchResult.stdout.trim() || 'unknown')
            .split('\n')
            .filter(Boolean)
            .pop()
            ?.slice(0, 240) || 'fetch failed';
          this.#status = {
            ...this.#status,
            current_version: current,
            latest_version: stale,
            update_available,
            // Keep the existing last_checked_at — the data is stale, not fresh.
            last_error: `git fetch failed (using cached ref): ${detail}`,
          };
          return;
        }
        const detail = (fetchResult.stderr.trim() || fetchResult.stdout.trim() || 'unknown')
          .split('\n')
          .filter(Boolean)
          .pop()
          ?.slice(0, 240) || 'fetch failed';
        this.#status = {
          ...this.#status,
          last_error: `git fetch failed: ${detail}`,
        };
        return;
      }
      const latest = readRemoteVersion(repoRoot, branch);
      if (!latest) {
        this.#status = {
          ...this.#status,
          last_error: `could not read ${PACKAGE_JSON_REL} from origin/${branch}`,
        };
        return;
      }
      // current_version is the in-memory snapshot captured at process start
      // (constructor: readWorkingTreeVersion → readBundledVersion). We do NOT
      // re-read working tree each tick: the working tree only matters at boot,
      // when it must equal the running binary's version. Re-reading was a bug
      // — on hosts where the operator git-pulls in the same checkout (dev
      // machines, manager + dev share a workspace) it pulled the working tree
      // ahead of the actually-running process, making `latest == current ==
      // working_tree_future_version` and silently hiding the Update button
      // while the running code was still stale.
      //
      // Self-update doesn't need the re-read either: it ends in detached
      // re-exec, so the post-update new process re-runs the constructor
      // against the just-pulled tree and the cache restarts fresh.
      const current = this.#status.current_version;
      const update_available = compareSemver(latest, current) > 0;
      this.#status = {
        ...this.#status,
        current_version: current,
        latest_version: latest,
        update_available,
        last_checked_at: new Date().toISOString(),
        last_error: null,
      };
    } catch (err: any) {
      this.#status = {
        ...this.#status,
        last_error: err?.message ?? String(err),
      };
    }
  }

  /**
   * npm-global mode tick: read the latest published version from the npm
   * registry (`npm view awb-agent-manager version`) and refresh the cache.
   * current_version is the build-time bundled version (dist/package.json) — the
   * actually-installed build — so the semver compare is apples-to-apples.
   */
  async #tickNpmGlobal(): Promise<void> {
    try {
      // shell:true on Windows (npm.cmd). cwd is irrelevant for a registry read.
      const r = await runAsync(
        'npm',
        ['view', MANAGER_PACKAGE_NAME, 'version'],
        process.cwd(),
        NPM_VIEW_TIMEOUT_MS,
      );
      if (!r.ok) {
        const detail =
          (r.stderr.trim() || r.stdout.trim() || 'unknown')
            .split('\n')
            .filter(Boolean)
            .pop()
            ?.slice(0, 240) || 'npm view failed';
        this.#status = { ...this.#status, last_error: `npm view failed: ${detail}` };
        return;
      }
      // `npm view <pkg> version` prints just the bare version (e.g. "1.6.18\n").
      const latest =
        r.stdout.split('\n').map((s) => s.trim()).filter(Boolean).pop() || '';
      if (!/^\d+\.\d+\.\d+/.test(latest)) {
        this.#status = {
          ...this.#status,
          last_error: `could not parse npm view output: ${latest.slice(0, 120)}`,
        };
        return;
      }
      const current = this.#status.current_version;
      const update_available = compareSemver(latest, current) > 0;
      this.#status = {
        ...this.#status,
        latest_version: latest,
        update_available,
        last_checked_at: new Date().toISOString(),
        last_error: null,
      };
    } catch (err: any) {
      this.#status = { ...this.#status, last_error: err?.message ?? String(err) };
    }
  }
}

/**
 * Module-level mutex shared by every entry point that can kick off a self-update
 * (SSE `update_manager`, SIGUSR1, future direct callers). Hoisting this out of
 * `main.ts` is load-bearing: prior versions kept the flag local to
 * `runRuntime()` and only guarded SIGUSR1, so two concurrent SSE dispatches
 * (or one SSE + one SIGUSR1) would race in three places — workspace-root
 * `npm install`, `tsc` writing `dist/`, and the double `setTimeout(reExecManager,
 * 1500)` lockfile-takeover loop. Gating `runSelfUpdate` itself collapses all
 * those entry points onto a single in-flight bit.
 */
let selfUpdateInFlight = false;

/** Test-only escape hatch: clear the in-flight flag between unit tests. */
export function _resetSelfUpdateInFlightForTests(): void {
  selfUpdateInFlight = false;
}

/**
 * Run the full self-update pipeline: pull → install → build → re-exec.
 *
 * Returns once the build completes. The detached re-exec is scheduled on a
 * short timer so the caller (SSE handler / SIGUSR1 path) can finish its
 * ack POST + log line before the parent exits.
 *
 * Cross-platform: uses `npm` with shell:true on Windows (so .cmd shims
 * resolve via PATH) and bare `npm` everywhere else. No shell scripts,
 * same code path on Linux + Windows.
 *
 * Mutex: a module-level `selfUpdateInFlight` guard short-circuits concurrent
 * calls from any entry point (SSE / SIGUSR1 / direct). The contended caller
 * gets `{ changed: false, summary: 'self-update already in flight' }`; the
 * SSE dispatcher promotes this to an error ack so the operator sees the
 * contention on the admin UI rather than silently no-op'ing.
 */
export async function runSelfUpdate(opts: SelfUpdateOpts = {}): Promise<SelfUpdateResult> {
  const out = opts.log ?? log;
  if (selfUpdateInFlight) {
    const summary = 'self-update already in flight';
    out(`Self-update: ${summary}`);
    return { changed: false, summary };
  }
  selfUpdateInFlight = true;
  try {
    return await runSelfUpdateLocked(opts, out);
  } finally {
    // Release on every exit path EXCEPT a successful re-exec — at that point
    // the parent is on its way out (process.exit on the 250ms tail) and the
    // child has its own fresh module instance with its own flag = false. If
    // we cleared it here a quick second SSE arriving in that 1.5s grace
    // window could race the re-exec; leaving it set is the safer default.
    if (!_lastReExecScheduled) {
      selfUpdateInFlight = false;
    }
    _lastReExecScheduled = false;
  }
}

/**
 * Tracks whether the most recent runSelfUpdate scheduled a detached re-exec.
 * Used by the runSelfUpdate finally{} to decide whether to release the
 * in-flight flag — see the comment there for the rationale.
 */
let _lastReExecScheduled = false;

/**
 * Set by reExecManager (systemd branch) just before it sends SIGTERM to self.
 * Read by main.ts's shutdown handler so the final `process.exit(...)` can pick
 * the right code: 1 when we're tearing down to re-exec into the just-built
 * dist, 0 for a normal operator-driven stop.
 *
 * The unit now runs `Restart=always`, so restart no longer hinges on the exit
 * code — systemd respawns on any exit (a deliberate `systemctl stop` is the
 * one case it leaves down). We keep the exit-1 signal anyway: it's correct
 * under any restart policy and keeps the exit code semantically honest
 * (1 = abnormal/re-exec, 0 = clean stop) for logs and journald.
 */
let _systemdReExecPending = false;

/** Read by main.ts's shutdown handler to pick its exit code. */
export function isSystemdReExecPending(): boolean {
  return _systemdReExecPending;
}

/**
 * Adopt `origin/<branch>` into the working tree WITHOUT occupying or moving any
 * local branch ref. This is the structural fix for ticket dc38dce6.
 *
 * The previous self-update flow did `git checkout <branch>` followed by
 * `git pull --ff-only origin <branch>`. In agent-manager's per-(ticket,role)
 * worktree-pool setup that fails *permanently*: a ticket worktree can hold
 * `<branch>` checked out — an agent ran `git checkout main` inside its worktree
 * per the column workflow, then the worktree was left behind — and git allows a
 * branch to be checked out in at most ONE worktree. So `git checkout main` in
 * this shared base repo aborts with
 *   fatal: '<branch>' is already used by worktree at <path>
 * and the manager self-locks into its current version forever (it can never
 * pull + build the new release; see the field reports in ticket dc38dce6).
 *
 * `git fetch` + `git checkout --detach origin/<branch>` sidesteps the whole
 * class of conflict:
 *   - a detached HEAD never *holds* the `<branch>` ref, so it cannot collide
 *     with a ticket worktree that has `<branch>` checked out;
 *   - it never *moves* a local branch ref, so it cannot silently clobber an
 *     unrelated branch the operator left checked out (e.g. production.private)
 *     the way `git reset --hard origin/<branch>` would;
 *   - it unconditionally adopts the published commit — exactly the "run the
 *     latest released code" semantic self-update wants.
 * Detached HEAD is also the manager checkout's documented steady state, so the
 * post-update tree matches what the worktree pool already expects.
 *
 * Tracked-file safety is handled by the caller's earlier steps (lockfile reset
 * + auto-stash), so the checkout has a clean tree to move by the time we get
 * here; a genuine conflict still surfaces as { ok:false } rather than being
 * force-discarded.
 */
export async function adoptRemoteBranch(
  repoRoot: string,
  branch: string,
  out: (msg: string) => void,
): Promise<{ ok: true } | { ok: false; summary: string }> {
  out(`Self-update: git fetch --quiet origin ${branch}`);
  const fetchResult = await runAsync(
    'git',
    ['-C', repoRoot, 'fetch', '--quiet', 'origin', branch],
    repoRoot,
    FETCH_TIMEOUT_MS,
    (line) => out(`  [git] ${line}`),
  );
  if (!fetchResult.ok) {
    const detail =
      (fetchResult.stderr.trim() || fetchResult.stdout.trim() || 'unknown').split('\n').pop() || '';
    return { ok: false, summary: `git fetch failed: ${detail.slice(0, 240)}` };
  }

  out(`Self-update: git checkout --detach origin/${branch}`);
  const checkoutResult = await runAsync(
    'git',
    ['-C', repoRoot, 'checkout', '--detach', `origin/${branch}`],
    repoRoot,
    15_000,
    (line) => out(`  [git] ${line}`),
  );
  if (!checkoutResult.ok) {
    const detail =
      (checkoutResult.stderr.trim() || checkoutResult.stdout.trim() || 'unknown')
        .split('\n')
        .pop() || '';
    return {
      ok: false,
      summary: `git checkout --detach origin/${branch} failed: ${detail.slice(0, 240)}`,
    };
  }
  return { ok: true };
}

async function runSelfUpdateLocked(
  opts: SelfUpdateOpts,
  out: (msg: string) => void,
): Promise<SelfUpdateResult> {
  const repoRoot = detectRepoRoot();
  // npm-first policy: availability of an npm global root is enough to migrate
  // a legacy checkout-run manager onto the published package. Never mutate the
  // checkout merely because process.argv[1] currently lives inside it.
  if (detectNpmGlobalRoot()) {
    return await runNpmGlobalSelfUpdate(opts, out);
  }
  if (!repoRoot) {
    // No checkout — either an npm-global install (auto-updatable via
    // `npm i -g`) or an unknown build (manual upgrade only). Reuse the already
    // known repoRoot=null so we don't detectRepoRoot() a second time.
    const runningDir = resolve(dirname(fileURLToPath(import.meta.url)));
    const mode = classifyInstallMode(runningDir, null, null);
    if (mode === 'npm-global') {
      return await runNpmGlobalSelfUpdate(opts, out);
    }
    const summary =
      'self-update skipped: not a git checkout or npm-global install (upgrade this build manually)';
    out(`Self-update: ${summary}`);
    return { changed: false, summary };
  }

  const branch = detectDefaultBranch(repoRoot);
  out(`Self-update: git fallback in manager-owned runtime (root=${repoRoot} branch=${branch})`);

  // The fallback runtime is disposable. Never preserve, merge, or stash its
  // contents: fetch the selected ref, replace tracked state, and remove every
  // untracked/ignored build artifact before rebuilding.
  const fetched = await runAsync(
    'git', ['-C', repoRoot, 'fetch', '--quiet', 'origin', branch], repoRoot, FETCH_TIMEOUT_MS,
    (line) => out(`  [git] ${line}`),
  );
  if (!fetched.ok) {
    const detail = fetched.stderr.trim() || fetched.stdout.trim() || 'unknown';
    return { changed: false, summary: `git fallback fetch failed: ${detail.slice(0, 240)}` };
  }
  for (const args of [
    ['checkout', '--detach', `origin/${branch}`],
    ['reset', '--hard', `origin/${branch}`],
    ['clean', '-fdx'],
  ]) {
    const replaced = await runAsync('git', ['-C', repoRoot, ...args], repoRoot, 30_000);
    if (!replaced.ok) {
      const detail = replaced.stderr.trim() || replaced.stdout.trim() || 'unknown';
      return { changed: false, summary: `git fallback overwrite failed: ${detail.slice(0, 240)}` };
    }
  }

  // 0. Reset package-lock.json before adopting origin/<branch>.
  //
  // The previous self-update's step 2 (`npm install` at workspace root) can
  // silently rewrite the lockfile — npm reorders sub-deps, recomputes
  // integrity hashes, and resolves optionalDependencies differently across
  // platforms (Windows vs Linux npm both legitimately produce non-identical
  // lockfiles from the same package.json). The lockfile is then dirty in
  // the working tree, which makes the NEXT `git checkout --detach
  // origin/<branch>` (step 0c+1) abort with `Your local changes to the
  // following files would be overwritten by checkout: package-lock.json` and
  // self-locks the manager into its current version forever. Operators see
  // "update_manager: ... failed" with a one-line tail that doesn't make the
  // trap obvious.
  //
  // The reset is safe: step 2 regenerates package-lock.json from the
  // workspace's package.json files anyway, so any local lockfile diff is
  // disposable. We narrowly target this one file (vs e.g. `git reset
  // --hard` or `git stash`) so a real local mod elsewhere — service-install.ts
  // hand-edits, operator config tweaks — is still protected by the dirty-tree
  // guard below.
  out('Self-update: git checkout -- package-lock.json (regenerated by npm install)');
  const lockResetResult = await runAsync(
    'git',
    ['-C', repoRoot, 'checkout', '--', 'package-lock.json'],
    repoRoot,
    10_000,
    (line) => out(`  [git] ${line}`),
  );
  if (!lockResetResult.ok) {
    // Non-fatal: a missing lockfile (fresh clone before first install) means
    // there's nothing to reset; a real failure here would also be caught by
    // the next git pull's own error path. Log and continue.
    const detail =
      (lockResetResult.stderr.trim() || lockResetResult.stdout.trim() || 'unknown')
        .split('\n')
        .pop() || '';
    out(`Self-update: lockfile reset returned non-zero (continuing): ${detail.slice(0, 200)}`);
  }

  // 0b. Auto-stash any remaining dirty tracked files. Previous version
  // aborted here and the operator was expected to commit/stash/revert by
  // hand — in practice that means update_manager fails on every run when
  // any session has uncommitted edits in the shared worktree, and the user
  // has to interrupt to fix it. Self-update is a non-interactive context;
  // stash the changes ourselves with a timestamped message so they survive
  // in the stash list (`git stash list`) and can be recovered manually.
  //
  // Untracked files (`??`) are excluded — `git pull` never touches them.
  const statusResult = await runAsync(
    'git',
    ['-C', repoRoot, 'status', '--porcelain'],
    repoRoot,
    10_000,
  );
  if (statusResult.ok) {
    const dirty = statusResult.stdout
      .split('\n')
      .map((s) => s.trimEnd())
      .filter(Boolean)
      .filter((line) => !line.startsWith('??'));
    if (dirty.length > 0) {
      const stashMsg = `self-update auto-stash ${new Date().toISOString()}`;
      out(
        `Self-update: working tree has ${dirty.length} dirty file(s); auto-stashing as "${stashMsg}" (recover via: git stash list / git stash pop)`,
      );
      for (const line of dirty.slice(0, 10)) out(`  [dirty] ${line}`);
      if (dirty.length > 10) out(`  [dirty] (+${dirty.length - 10} more)`);

      const stashResult = await runAsync(
        'git',
        ['-C', repoRoot, 'stash', 'push', '-u', '-m', stashMsg],
        repoRoot,
        15_000,
        (l) => out(`  [git] ${l}`),
      );
      if (!stashResult.ok) {
        const detail =
          (stashResult.stderr.trim() || stashResult.stdout.trim() || 'unknown')
            .split('\n')
            .pop() || '';
        const summary = `auto-stash failed: ${detail.slice(0, 240)}`;
        out(`Self-update: ${summary}`);
        return { changed: false, summary };
      }
    }
  }

  // 0c + 1. Adopt origin/<branch> WITHOUT occupying or moving any branch ref.
  //
  // The agent-manager runs from a shared worktree the operator may also use
  // interactively (current branch could be production.private, a ticket
  // branch, …) AND its per-(ticket,role) worktree pool can hold <branch>
  // checked out in another worktree. The old `git checkout <branch>` +
  // `git pull --ff-only` flow collided with both: a branch is checkable-out in
  // only one worktree, so the checkout aborted with "already used by worktree"
  // and self-locked the manager forever. `git fetch` + detached checkout of
  // origin/<branch> never holds or moves a branch ref, so it is immune to the
  // worktree conflict and never clobbers an unrelated local branch. See
  // adoptRemoteBranch() for the full rationale (ticket dc38dce6).
  const adopt = await adoptRemoteBranch(repoRoot, branch, out);
  if (!adopt.ok) {
    out(`Self-update: ${adopt.summary}`);
    return { changed: false, summary: adopt.summary };
  }

  // 2. npm install (workspace root — installs everything for monorepo).
  // Note: we install at repo root because `npm install -w apps/agent-manager`
  // doesn't always re-run hoisted devDeps install in a monorepo. A bare
  // `npm install` is the cheapest universally-correct option.
  out('Self-update: npm install');
  const installResult = await runAsync(
    'npm',
    ['install'],
    repoRoot,
    BUILD_TIMEOUT_MS,
    (line) => out(`  [npm-install] ${line}`),
  );
  if (!installResult.ok) {
    const detail = (installResult.stderr.trim() || installResult.stdout.trim() || 'unknown').split('\n').pop() || '';
    const summary = `npm install failed: ${detail.slice(0, 240)}`;
    out(`Self-update: ${summary}`);
    return { changed: false, summary };
  }

  // 3. npm run build -w apps/agent-manager — builds JUST the manager's
  // dist/. We don't need to rebuild the server / client; the operator only
  // restarted us, not those.
  out('Self-update: npm run build -w apps/agent-manager');
  const buildResult = await runAsync(
    'npm',
    ['run', 'build', '-w', 'apps/agent-manager'],
    repoRoot,
    BUILD_TIMEOUT_MS,
    (line) => out(`  [build] ${line}`),
  );
  if (!buildResult.ok) {
    const detail = (buildResult.stderr.trim() || buildResult.stdout.trim() || 'unknown').split('\n').pop() || '';
    const summary = `npm run build failed: ${detail.slice(0, 240)}`;
    out(`Self-update: ${summary}`);
    return { changed: false, summary };
  }

  const newVersion = readWorkingTreeVersion(repoRoot) || '?';
  const summary = `pulled + built (now v${newVersion})${opts.noReExec ? ' — re-exec skipped' : ' — re-execing'}`;
  out(`Self-update: ${summary}`);

  if (opts.noReExec) return { changed: true, summary, willReExec: false };

  // 4. Schedule the detached re-exec on a short timer so the caller can
  // finish its ack POST + final log line before we exit. 1.5s is plenty
  // for the local POST round-trip on the loopback that the manager uses.
  // Mark the re-exec so runSelfUpdate's finally{} keeps the in-flight flag
  // set during the 1.5s grace window — see comment there.
  _lastReExecScheduled = true;
  setTimeout(() => {
    try {
      reExecManager(out);
    } catch (err: any) {
      out(`Self-update: re-exec failed: ${err?.stack || err?.message || err}`);
    }
  }, 1500).unref?.();

  return { changed: true, summary, willReExec: true };
}

/**
 * Source of the detached temp helper that performs an npm-global self-update.
 *
 * It runs as its own throwaway node process from the OS temp dir, OUTSIDE the
 * package being replaced. Sequence:
 *   1. wait (bounded) for the manager pid to exit — running `npm i -g` only
 *      after the manager is gone dodges the Windows self-overwrite EBUSY/EPERM
 *      (a live node process holding files inside its own global package dir);
 *   2. `npm install -g awb-agent-manager@latest`;
 *   3. relaunch the manager (`node <main.js> … --force`) regardless of the
 *      install outcome — on failure the prior build comes back, so the operator
 *      is never left with no manager;
 *   4. delete itself.
 *
 * Kept dependency-free (node builtins only) and free of backticks / `${…}` so
 * it embeds cleanly in this template literal. argv:
 *   [node, self, managerPid, npmSpec, nodePath, managerScript, ...restartArgs]
 */
const NPM_GLOBAL_UPDATER_SOURCE = `// Auto-generated by awb-agent-manager self-update (npm-global mode). Safe to delete.
import { spawn, spawnSync } from 'node:child_process';
import { unlinkSync } from 'node:fs';
import { join } from 'node:path';

const [, selfPath, managerPidStr, npmSpec, nodePath, managerScript, ...restartArgs] = process.argv;
const managerPid = Number.parseInt(managerPidStr, 10);
const isWin = process.platform === 'win32';

function managerAlive() {
  if (!Number.isFinite(managerPid) || managerPid <= 0) return false;
  try { process.kill(managerPid, 0); return true; } catch { return false; }
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

(async () => {
  // 1. Wait (bounded) for the manager to exit and release its files.
  const deadline = Date.now() + 60000;
  while (managerAlive() && Date.now() < deadline) await sleep(500);
  // Small grace so the OS finishes releasing handles from the dying process.
  await sleep(750);

  // 2. Reinstall globally. shell:true on Windows resolves the npm.cmd shim.
  const install = spawnSync('npm', ['install', '-g', npmSpec], {
    stdio: 'ignore',
    shell: isWin,
    windowsHide: true,
  });
  const ok = install.status === 0 && !install.error;

  // 3. Relaunch the globally installed manager. A legacy service may have
  // started this update from a git checkout; do not jump back into that tree.
  let restartScript = managerScript;
  if (ok) {
    const root = spawnSync('npm', ['root', '-g'], { encoding: 'utf8', shell: isWin, windowsHide: true });
    const globalRoot = root.status === 0 ? String(root.stdout || '').trim() : '';
    if (globalRoot) restartScript = join(globalRoot, 'awb-agent-manager', 'dist', 'main.js');
  }
  if (restartScript) {
    try {
      const child = spawn(nodePath, [restartScript, ...restartArgs, '--force'], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      });
      child.unref();
    } catch { /* nothing more the helper can do */ }
  }

  // 4. Best-effort self-cleanup of this temp helper file.
  try { unlinkSync(selfPath); } catch { /* already gone */ }
  process.exit(ok ? 0 : 1);
})();
`;

/** Test-only accessor for the embedded helper source (so a test can `node
 *  --check` it and catch syntax rot in the string). */
export function _npmGlobalUpdaterSourceForTests(): string {
  return NPM_GLOBAL_UPDATER_SOURCE;
}

/**
 * Write the npm-global updater helper to the OS temp dir and return its path.
 * The temp location is deliberate: it lives OUTSIDE the global package tree npm
 * is about to replace, and node reads it fully into V8 at spawn (closing the fd)
 * so a later package reinstall can't disturb the running helper.
 */
function writeNpmGlobalUpdater(out: (msg: string) => void): string {
  const helperPath = join(tmpdir(), `awb-agent-manager-updater-${process.pid}.mjs`);
  writeFileSync(helperPath, NPM_GLOBAL_UPDATER_SOURCE, 'utf8');
  out(`Self-update: staged npm-global updater helper at ${helperPath}`);
  return helperPath;
}

/**
 * npm-global self-update: stage a detached helper, hand it our pid + restart
 * command, then shut ourselves down so it can reinstall + relaunch. This is the
 * npm-mode analogue of adoptRemoteBranch()+build+reExecManager(), split across a
 * helper process specifically so the `npm i -g` runs AFTER we exit (Windows
 * can't replace a running node process's own package dir — EBUSY/EPERM).
 */
async function runNpmGlobalSelfUpdate(
  opts: SelfUpdateOpts,
  out: (msg: string) => void,
): Promise<SelfUpdateResult> {
  const current = readBundledVersion();
  out(`Self-update: npm-global mode (current v${current}) — target ${NPM_GLOBAL_LATEST_SPEC}`);

  // Dry-run / test hook: report intent without spawning the helper or exiting.
  if (opts.noReExec) {
    const summary = `npm-global update: would run \`npm install -g ${NPM_GLOBAL_LATEST_SPEC}\` + restart (re-exec skipped)`;
    out(`Self-update: ${summary}`);
    return { changed: true, summary, willReExec: false };
  }

  let helperPath: string;
  try {
    helperPath = writeNpmGlobalUpdater(out);
  } catch (err: any) {
    const summary = `npm-global update failed: could not stage updater helper: ${err?.message ?? err}`;
    out(`Self-update: ${summary}`);
    return { changed: false, summary };
  }

  const nodePath = process.execPath;
  const scriptPath = process.argv[1] || '';
  // Strip any pre-existing --force / -f so the helper's appended --force doesn't
  // accumulate across updates (mirrors reExecManager's argv hygiene).
  const baseArgs = (process.argv.slice(2) || []).filter((a) => a !== '--force' && a !== '-f');
  const helperArgs = [
    helperPath,
    String(process.pid),
    NPM_GLOBAL_LATEST_SPEC,
    nodePath,
    scriptPath,
    ...baseArgs,
  ];

  out(`Self-update: spawning detached npm-global updater (reinstalls after pid=${process.pid} exits)`);
  try {
    const child = spawn(nodePath, helperArgs, {
      detached: true,
      stdio: 'ignore',
      // Run from tmp, NOT the package dir, so npm can freely replace the global
      // node_modules/awb-agent-manager tree.
      cwd: tmpdir(),
      env: process.env,
      shell: false,
      windowsHide: true,
    });
    child.unref();
  } catch (err: any) {
    const summary = `npm-global update failed: could not spawn updater helper: ${err?.message ?? err}`;
    out(`Self-update: ${summary}`);
    return { changed: false, summary };
  }

  const summary = `npm-global update scheduled: detached helper runs \`npm install -g ${NPM_GLOBAL_LATEST_SPEC}\` after exit, then restarts`;
  out(`Self-update: ${summary}`);

  // Same 1.5s tail as the git path: let the caller finish its ack POST + log
  // line, then shut down. The helper is already polling our pid. Keep the
  // in-flight flag set across the grace window (see runSelfUpdate's finally).
  _lastReExecScheduled = true;
  setTimeout(() => {
    try {
      shutdownForNpmGlobalUpdate(out);
    } catch (err: any) {
      out(`Self-update: shutdown for npm-global update failed: ${err?.stack || err?.message || err}`);
    }
  }, 1500).unref?.();

  return { changed: true, summary, willReExec: true };
}

/**
 * Trigger a clean shutdown so the detached npm-global updater can reinstall +
 * relaunch. Unlike reExecManager() we do NOT spawn a replacement here — the
 * helper owns the relaunch AFTER `npm install -g` finishes. We just tear down
 * sessions (SIGTERM self) and exit; the helper is waiting on our pid. A backstop
 * force-exit fires well inside the helper's 60s wait window so a hung SIGTERM
 * handler can't strand the update.
 */
function shutdownForNpmGlobalUpdate(out: (msg: string) => void): void {
  out('Self-update: shutting down so the npm-global updater can reinstall + restart');
  setTimeout(() => {
    try {
      process.kill(process.pid, 'SIGTERM');
    } catch {
      process.exit(0);
    }
    setTimeout(() => process.exit(0), 25_000).unref?.();
  }, 250).unref?.();
}

/**
 * Re-exec the running manager in place — no git pull, no install, no build.
 * Used by the `restart_manager` SSE command (and a future `awb-agent-manager
 * restart` CLI sub-command) when an operator wants a clean process bounce
 * without pulling new source.
 *
 * Shares the same `selfUpdateInFlight` mutex as `runSelfUpdate` so a restart
 * racing an in-flight update doesn't double-schedule the re-exec timer or
 * fight over the agent lockfile. Same 1.5s tail as the update path so the
 * caller can finish its ack POST + log line before the parent exits.
 */
export async function restartManager(opts: SelfUpdateOpts = {}): Promise<SelfUpdateResult> {
  const out = opts.log ?? log;
  if (selfUpdateInFlight) {
    const summary = 'restart_manager skipped: self-update / restart already in flight';
    out(`Restart: ${summary}`);
    return { changed: false, summary };
  }
  selfUpdateInFlight = true;
  try {
    const version = readBundledVersion();
    if (opts.noReExec) {
      const summary = `restart_manager: re-exec skipped (v${version})`;
      out(`Restart: ${summary}`);
      return { changed: true, summary, willReExec: false };
    }
    const summary = `restart_manager: re-execing manager (v${version}) in place`;
    out(`Restart: ${summary}`);
    _lastReExecScheduled = true;
    setTimeout(() => {
      try {
        reExecManager(out);
      } catch (err: any) {
        out(`Restart: re-exec failed: ${err?.stack || err?.message || err}`);
      }
    }, 1500).unref?.();
    return { changed: true, summary, willReExec: true };
  } finally {
    // Same release rule as runSelfUpdate: keep the flag set across the
    // 1.5s grace window so a second restart_manager arriving in that
    // gap can't race the re-exec we just scheduled.
    if (!_lastReExecScheduled) {
      selfUpdateInFlight = false;
    }
    _lastReExecScheduled = false;
  }
}

/**
 * True when the running process was launched by a systemd unit. systemd v232+
 * always sets INVOCATION_ID for unit-started processes; JOURNAL_STREAM is the
 * older fallback. Either one is sufficient — both being absent means we're
 * running outside systemd (Windows, raw bash, macOS launchd, …).
 *
 * We don't trust /proc/1/comm because user-session managers can run under a
 * non-systemd init, and we don't trust NOTIFY_SOCKET because Type=simple units
 * (ours) don't get one.
 */
function isManagedBySystemd(): boolean {
  return Boolean(process.env.INVOCATION_ID || process.env.JOURNAL_STREAM);
}

/**
 * Re-exec the manager so the just-built dist/main.js takes over.
 *
 * Two strategies depending on the supervisor:
 *
 * 1. **systemd** (Linux + a `.service` unit): the parent exits 1 and lets the
 *    unit's `Restart=always` bring up a fresh process. We MUST NOT spawn
 *    a detached child here — systemd's default `KillMode=control-group` would
 *    sweep the new child into the same cgroup teardown when the parent dies,
 *    killing the very process we just launched. Symptom: `update_manager` SSE
 *    command lands, build succeeds, parent exits, child appears for a moment
 *    in `ps`, then the entire unit goes inactive(dead) and the operator's
 *    Update button vanishes with no replacement process.
 *
 * 2. **everything else** (Windows, raw bash, macOS launchd, npm-global
 *    install): spawn a detached child with --force and SIGTERM-self. No
 *    cgroup means the child outlives the parent's exit; the --force lets the
 *    child take over the agent lockfile without a 60s wait.
 */
function reExecManager(out: (msg: string) => void): void {
  if (isManagedBySystemd()) {
    out('Self-update: re-exec via systemd (Restart=always → exit 1)');
    // We trigger the SIGTERM shutdown handler so chat / ticket sessions get
    // cleaned up, but we MUST set _systemdReExecPending first so the handler's
    // final `process.exit(...)` picks exit code 1 instead of 0. Under
    // Restart=always a clean exit(0) would respawn too, but exit 1 keeps the
    // journald record honest about why the unit restarted (re-exec, not a
    // crash or operator stop).
    _systemdReExecPending = true;
    setTimeout(() => {
      try {
        process.kill(process.pid, 'SIGTERM');
      } catch {
        process.exit(1);
      }
      // Backup: if the SIGTERM handler hangs (subagent stop stuck, lockfile
      // release timeout, …), force exit(1) after the shutdown grace window
      // so we still respawn instead of holding the unit in a half-dead state.
      setTimeout(() => process.exit(1), 30_000).unref?.();
    }, 250).unref?.();
    return;
  }

  const execPath = process.execPath;
  const scriptPath = process.argv[1];
  // Strip any pre-existing --force / -f from the original argv so we
  // don't accumulate duplicates across self-updates. The new --force is
  // appended back at the tail.
  const baseArgs = (process.argv.slice(2) || []).filter((a) => a !== '--force' && a !== '-f');
  const childArgs = [scriptPath, ...baseArgs, '--force'];
  out(`Self-update: re-exec ${execPath} ${childArgs.join(' ')}`);
  const child = spawn(execPath, childArgs, {
    detached: true,
    stdio: 'ignore',
    cwd: process.cwd(),
    env: process.env,
    // shell:false everywhere — process.execPath is the absolute node binary,
    // no PATH lookup needed and no .cmd shim involved.
    shell: false,
    windowsHide: true,
  });
  child.unref();
  // Trigger main.ts's shutdown handler (chat/ticket session SIGTERM,
  // monitor stop, lockfile release) BEFORE the parent exits. Previously
  // this was `process.exit(0)`, which short-circuited the SIGTERM handler
  // entirely — every running chat-session / ticket-session CLI child
  // survived re-exec as a detached + unref'd orphan that the new manager
  // could no longer find (in-memory `_sessions` empty after re-exec;
  // orphan-cleanup misses chat-sessions because they reuse the agent's
  // persistent mcp-config and write no .pid sidecar). The net effect was
  // that an `update_manager` carrying a server-side fix would re-exec
  // into a v-new manager while v-old chat-session children kept talking
  // to the server with whatever MCP / credential snapshot they captured
  // at spawn time. Asking the platform's SIGTERM handler to do the
  // cleanup is the cheap, well-tested path.
  //
  // Windows note: Node's libuv emits a synthetic 'SIGTERM' from
  // process.kill(pid, 'SIGTERM') in-process; it never reaches the
  // platform's console-control-event mechanism so we don't need
  // CTRL_BREAK_EVENT magic here.
  setTimeout(() => {
    try {
      process.kill(process.pid, 'SIGTERM');
    } catch {
      // Last-ditch fallback: if SIGTERM somehow can't be delivered to
      // self, still exit so the new child takes over cleanly.
      process.exit(0);
    }
  }, 250).unref?.();
}
