// Self-update for agent-manager.
//
// Cadence:
//   - UpdateChecker (slow timer, default 5 min) runs `git fetch` + reads
//     `origin/<branch>:apps/agent-manager/package.json` and caches the version
//     so InstanceHeartbeat can attach a fresh `latest_version` /
//     `update_available` snapshot to every payload without paying the network
//     cost on each tick.
//   - runSelfUpdate() (one-shot, fired by `update_manager` SSE command or
//     SIGUSR1) does the heavy lifting: pull → install → build. On success it
//     schedules a detached re-exec with `--force` so the new node process
//     adopts the lockfile from the dying parent.
//
// The whole pipeline is a no-op when the manager is running outside a git
// checkout (e.g. installed via `npm i -g`). detectRepoRoot() returns null in
// that case and every public method becomes a structured stub so callers can
// keep the same control surface.

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, statSync, readFileSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { log } from './logging.js';

const PACKAGE_JSON_REL = 'apps/agent-manager/package.json';
const DEFAULT_CHECK_INTERVAL_MS = 5 * 60 * 1000;
const FETCH_TIMEOUT_MS = 30_000;
const BUILD_TIMEOUT_MS = 10 * 60_000;

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
 * Walk up from this file's location until a directory containing `.git`
 * shows up. Returns null when the manager isn't running from a checkout
 * (npm-global install, packaged binary, …).
 */
export function detectRepoRoot(startDir?: string): string | null {
  const seed = startDir || dirname(fileURLToPath(import.meta.url));
  let dir = resolve(seed);
  // Hard cap on iterations so a pathological cwd can't loop forever.
  for (let i = 0; i < 16; i++) {
    if (existsSync(join(dir, '.git'))) {
      try {
        const st = statSync(join(dir, '.git'));
        if (st.isDirectory() || st.isFile()) return dir;
      } catch {
        /* fall through to parent */
      }
    }
    const parent = dirname(dir);
    if (!parent || parent === dir) return null;
    dir = parent;
  }
  return null;
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
 * Read the manager's own running version from the bundled package.json
 * (sibling of dist/). Falls back to '0.0.0' so callers don't crash on a
 * missing file in odd packaging scenarios.
 */
export function readBundledVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    // dist/lib/self-update.js → ../../package.json
    const pkgPath = resolve(here, '..', '..', 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
    return typeof pkg?.version === 'string' ? pkg.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/**
 * Best-effort current branch detection. Falls back to 'main' when
 * `git rev-parse` fails (detached HEAD, missing git binary, …).
 */
function detectBranch(repoRoot: string): string {
  const r = runSync('git', ['-C', repoRoot, 'rev-parse', '--abbrev-ref', 'HEAD'], 5_000);
  const branch = r.ok ? r.stdout.trim() : '';
  if (!branch || branch === 'HEAD') return 'main';
  return branch;
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
    const branch = repoRoot ? detectBranch(repoRoot) : null;
    const current_version = (repoRoot && readWorkingTreeVersion(repoRoot)) || readBundledVersion();
    // last_error is reserved for actionable failures (fetch couldn't reach
    // the remote, package.json couldn't be read, …). The "not running from
    // a git checkout" case is signalled via repo_root === null + a one-line
    // log on start; the UI uses the null repo_root to render a distinct
    // "manual updates only" badge instead of a misleading "check failed".
    this.#status = {
      current_version,
      latest_version: null,
      update_available: false,
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
    if (!this.#status.repo_root) {
      this.#log('UpdateChecker: not running from a git checkout — auto-update disabled');
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

async function runSelfUpdateLocked(
  opts: SelfUpdateOpts,
  out: (msg: string) => void,
): Promise<SelfUpdateResult> {
  const repoRoot = detectRepoRoot();
  if (!repoRoot) {
    const summary =
      'self-update skipped: not running from a git checkout (install upgrades via `npm i` in the AWB repo)';
    out(`Self-update: ${summary}`);
    return { changed: false, summary };
  }

  const branch = detectBranch(repoRoot);
  out(`Self-update: starting (root=${repoRoot} branch=${branch})`);

  // 1. git pull --ff-only origin <branch>
  out(`Self-update: git pull --ff-only origin ${branch}`);
  const pullResult = await runAsync(
    'git',
    ['-C', repoRoot, 'pull', '--ff-only', 'origin', branch],
    repoRoot,
    FETCH_TIMEOUT_MS,
    (line) => out(`  [git] ${line}`),
  );
  if (!pullResult.ok) {
    const detail = (pullResult.stderr.trim() || pullResult.stdout.trim() || 'unknown').split('\n').pop() || '';
    const summary = `git pull failed: ${detail.slice(0, 240)}`;
    out(`Self-update: ${summary}`);
    return { changed: false, summary };
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
 *    unit's `Restart=on-failure` bring up a fresh process. We MUST NOT spawn
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
    out('Self-update: re-exec via systemd (Restart=on-failure → exit 1)');
    // We still trigger the SIGTERM shutdown handler so chat / ticket sessions
    // get cleaned up; the handler short-circuits to process.exit(1) at the
    // tail so systemd sees a failure exit code and respawns.
    setTimeout(() => {
      try {
        process.kill(process.pid, 'SIGTERM');
        // SIGTERM handlers call process.exit(0) on the happy path, which
        // would mark the unit "success" and skip the Restart=on-failure
        // trigger. Schedule an exit(1) tail after the shutdown grace window
        // so we still land on a non-zero code even if the handler ran first.
        setTimeout(() => process.exit(1), 5_000).unref?.();
      } catch {
        process.exit(1);
      }
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
