// Self-update for agent-manager: pull the manager's git repo, rebuild, then
// re-exec a detached child so the supervising lockfile + service wrapper hand
// off cleanly. Cross-platform (Linux + Windows + macOS) because every step is
// node-native: git/npm via child_process.spawn (no shell), re-exec via spawn
// with `detached: true, stdio: 'ignore'`. There are no .sh / .bat scripts.
//
// Why git, not npm: agent-manager isn't published to the npm registry yet
// (see apps/agent-manager/README.md → "Install"). Operators run from a clone
// of the AWB monorepo, and the ticket explicitly asks for git-based version
// comparisons against `apps/agent-manager/package.json` on the upstream
// tracked branch. When npm distribution lands later, swap `runGitPull` for
// an `npm i -g` call — the rest of the pipeline (probe → ack → re-exec) stays.
//
// Re-exec strategy:
//   1. Run the new `awb-agent-manager` binary as a detached, ignored-stdio
//      child. Pass `--force` so the child takes the lockfile from the dying
//      parent without waiting for SIGTERM grace.
//   2. Child unref()ed → parent can exit independently. On Windows
//      `detached: true` puts the child into its own process group so the
//      console-controlled parent's exit doesn't take it down.
//   3. Parent ack-s success, releases its lock, exits 0.
//
// Service-supervised hosts (systemd / launchd / Windows Task Scheduler) also
// work: if the spawn fails or the child can't start, the parent still exits
// and the supervisor restarts the (already-updated) binary. The detached
// spawn is the optimistic fast-path; the supervisor is the fallback.

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, promises as fsp } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { log } from './logging.js';

export interface SelfUpdateResult {
  changed: boolean;
  summary: string;
  /** Best-effort version strings so callers can include them in the ack. */
  prevVersion?: string;
  newVersion?: string;
}

export interface SelfUpdateOpts {
  log?: (msg: string) => void;
  /** Inject for tests; defaults to walking up from this module's URL. */
  repoRoot?: string;
  /** Skip the spawn-detach step (used by tests / dry-runs). */
  reExec?: boolean;
  /** Hard cap per spawned child (git/npm). Default 5min — `npm install` on
   * a cold cache can be slow. */
  stepTimeoutMs?: number;
}

const DEFAULT_STEP_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Walk up from `start` looking for `.git/`. Returns the first matching dir
 * or null when we hit the filesystem root with nothing found. Used both as
 * the inbound "is this a git checkout?" check and as the cwd for git/npm.
 */
export function findRepoRoot(start: string): string | null {
  let dir = resolve(start);
  // Bound the loop at 32 levels so a broken filesystem can't hang us.
  for (let i = 0; i < 32; i++) {
    if (existsSync(join(dir, '.git'))) return dir;
    const parent = dirname(dir);
    if (!parent || parent === dir) return null;
    dir = parent;
  }
  return null;
}

/**
 * Default repo-root resolver: walk up from the manager's main.js. Built into
 * a function so tests + the heartbeat probe + the command handler all agree
 * on the same lookup.
 */
export function defaultRepoRoot(): string | null {
  // import.meta.url resolves to .../apps/agent-manager/dist/lib/self-update.js
  // in built form, .../apps/agent-manager/src/lib/self-update.ts in tsx-dev.
  // findRepoRoot walks up — for the built form: dist/lib → dist → agent-manager
  // → apps → repo (.git here). Same for src.
  try {
    return findRepoRoot(fileURLToPath(import.meta.url));
  } catch {
    return null;
  }
}

/**
 * Read the manager's *upstream* package version without touching the working
 * tree. Runs `git fetch` (silently skipped on no-network) then
 * `git show <upstream-ref>:apps/agent-manager/package.json`. Returns null on
 * any failure — callers fall back to "no upstream info available" rather
 * than break the heartbeat.
 *
 * We deliberately read the file at the upstream ref instead of running
 * `npm view` so the probe works for private repos and offline mirrors. The
 * upstream ref defaults to `@{u}` (current branch's upstream); falls back
 * to `origin/HEAD` when no upstream is configured.
 */
export async function probeUpstreamVersion(
  repoRoot: string,
  opts: { log?: (msg: string) => void; timeoutMs?: number } = {},
): Promise<{ latest_version: string; upstream_ref: string } | null> {
  const out = opts.log ?? log;
  const timeout = opts.timeoutMs ?? 30_000;

  // Fetch is best-effort: a transient network blip shouldn't make us forget
  // a previously-known latest_version. We log but don't return null.
  const fetchResult = await runCmd('git', ['-C', repoRoot, 'fetch', '--quiet'], { timeoutMs: timeout });
  if (!fetchResult.ok) {
    out(`self-update probe: git fetch failed — ${fetchResult.detail}`);
    // Continue: we may still have a stale upstream ref from a prior fetch.
  }

  // Resolve the upstream ref. `git rev-parse --abbrev-ref @{u}` returns
  // e.g. "origin/main" when an upstream is set; non-zero exit otherwise.
  let upstreamRef = '';
  const refResult = await runCmd('git', ['-C', repoRoot, 'rev-parse', '--abbrev-ref', '@{u}'], { timeoutMs: 10_000 });
  if (refResult.ok) {
    upstreamRef = refResult.stdout.trim();
  }
  if (!upstreamRef) {
    // Try origin/HEAD → e.g. "origin/main"
    const headResult = await runCmd('git', ['-C', repoRoot, 'rev-parse', '--abbrev-ref', 'origin/HEAD'], { timeoutMs: 10_000 });
    if (headResult.ok) upstreamRef = headResult.stdout.trim();
  }
  if (!upstreamRef) {
    out('self-update probe: no upstream tracked and origin/HEAD missing — skipping');
    return null;
  }

  const showResult = await runCmd(
    'git',
    ['-C', repoRoot, 'show', `${upstreamRef}:apps/agent-manager/package.json`],
    { timeoutMs: 10_000 },
  );
  if (!showResult.ok || !showResult.stdout) {
    out(`self-update probe: git show ${upstreamRef}:apps/agent-manager/package.json failed — ${showResult.detail}`);
    return null;
  }

  let parsed: any;
  try {
    parsed = JSON.parse(showResult.stdout);
  } catch (err: any) {
    out(`self-update probe: upstream package.json parse failed — ${err?.message ?? err}`);
    return null;
  }
  const v = typeof parsed?.version === 'string' ? parsed.version : '';
  if (!v) {
    out('self-update probe: upstream package.json missing version field');
    return null;
  }
  return { latest_version: v, upstream_ref: upstreamRef };
}

/**
 * Strict "this version is older than that one" comparator. Tries semver
 * first (split on `.`, numeric where possible) and falls back to string
 * compare. Equal returns false. Used by the heartbeat to compute
 * `update_available` so the manager — not the server — owns version-string
 * semantics.
 */
export function isVersionOlder(local: string, remote: string): boolean {
  if (!local || !remote) return false;
  if (local === remote) return false;
  const a = local.split('.');
  const b = remote.split('.');
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const ai = parseInt(a[i] ?? '0', 10);
    const bi = parseInt(b[i] ?? '0', 10);
    const aIsNum = Number.isFinite(ai) && /^\d+$/.test(a[i] ?? '');
    const bIsNum = Number.isFinite(bi) && /^\d+$/.test(b[i] ?? '');
    if (aIsNum && bIsNum) {
      if (ai < bi) return true;
      if (ai > bi) return false;
      continue;
    }
    // Mixed / pre-release segment — fall back to localeCompare on the slice.
    const cmp = (a.slice(i).join('.') || '').localeCompare(b.slice(i).join('.') || '');
    return cmp < 0;
  }
  return false;
}

/**
 * Read the in-tree manager package.json. Used as the "previous" version in
 * the result so callers can render `0.1.22 → 0.1.23` in the ack.
 */
async function readLocalManagerVersion(repoRoot: string): Promise<string | null> {
  try {
    const raw = await fsp.readFile(join(repoRoot, 'apps', 'agent-manager', 'package.json'), 'utf8');
    const v = JSON.parse(raw)?.version;
    return typeof v === 'string' ? v : null;
  } catch {
    return null;
  }
}

/**
 * Run a single subprocess with a hard timeout. Captures stdout/stderr
 * separately and reports the last useful line on failure so the ack stays
 * legible. SIGKILL on timeout — `git` and `npm` ignore SIGTERM in a few
 * deadlock cases (auth prompts, broken hooks). The detail string is capped
 * at 400 chars to keep the SSE ack payload reasonable.
 */
async function runCmd(
  cmd: string,
  args: string[],
  opts: { cwd?: string; timeoutMs?: number; env?: NodeJS.ProcessEnv } = {},
): Promise<{ ok: boolean; detail: string; stdout: string; stderr: string; exitCode: number | null }> {
  return new Promise((resolveP) => {
    const timeoutMs = opts.timeoutMs ?? DEFAULT_STEP_TIMEOUT_MS;
    let stdout = '';
    let stderr = '';
    let settled = false;
    let child: ChildProcess;
    try {
      child = spawn(cmd, args, {
        cwd: opts.cwd,
        env: opts.env ?? process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        // Do not rely on a shell — keeps argv quoting consistent across
        // Linux + Windows. Node spawns `git.exe` / `npm.cmd` correctly via
        // PATH on Windows when shell is false.
        shell: false,
        windowsHide: true,
      });
    } catch (err: any) {
      resolveP({ ok: false, detail: `spawn failed: ${err?.message ?? err}`, stdout: '', stderr: '', exitCode: null });
      return;
    }
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
      resolveP({
        ok: false,
        detail: `timeout after ${Math.round(timeoutMs / 1000)}s`,
        stdout,
        stderr,
        exitCode: null,
      });
    }, timeoutMs);
    // stdio is fixed to ['ignore', 'pipe', 'pipe'] above so stdout/stderr
    // are always Readable here; the optional types come from the broader
    // ChildProcess shape (which covers stdio: 'ignore' too).
    child.stdout?.on('data', (b) => {
      stdout += String(b);
    });
    child.stderr?.on('data', (b) => {
      stderr += String(b);
    });
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveP({ ok: false, detail: `spawn error: ${err?.message ?? err}`, stdout, stderr, exitCode: null });
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const lastLine =
        (stderr.trim() || stdout.trim()).split('\n').filter(Boolean).pop() || '';
      const detail = lastLine.slice(0, 400) || (code === 0 ? 'ok' : `exit=${code} (no output)`);
      resolveP({ ok: code === 0, detail, stdout, stderr, exitCode: code });
    });
  });
}

/**
 * The full update pipeline. Throws on any non-resumable failure (caller
 * wraps and reports via the ack). Returns a summary that includes the
 * before/after versions for the ack line.
 *
 * Pipeline:
 *   1. Resolve repo root.
 *   2. Refuse on a dirty working tree (`git status --porcelain`).
 *   3. `git pull --ff-only` — fail if not fast-forwardable so we never
 *      silently rewrite a checkout that's diverged.
 *   4. `npm install --workspaces=false` in apps/agent-manager (skip the
 *      whole-monorepo install — much faster, only what we need).
 *   5. `npm run build` in apps/agent-manager (tsc → dist).
 *   6. Compute prev/new version, return summary. Re-exec is the caller's
 *      decision (the SSE handler does it after acking; SIGUSR1 too).
 */
export async function runSelfUpdate(opts: SelfUpdateOpts = {}): Promise<SelfUpdateResult> {
  const out = opts.log ?? log;
  const stepTimeout = opts.stepTimeoutMs ?? DEFAULT_STEP_TIMEOUT_MS;
  const repoRoot = opts.repoRoot ?? defaultRepoRoot();
  if (!repoRoot) {
    const summary = 'self-update: no .git found in or above the agent-manager install — install upgrades manually';
    out(summary);
    return { changed: false, summary };
  }

  const managerDir = join(repoRoot, 'apps', 'agent-manager');
  if (!existsSync(join(managerDir, 'package.json'))) {
    const summary = `self-update: ${managerDir} has no package.json — repo layout unexpected`;
    out(summary);
    return { changed: false, summary };
  }

  const prevVersion = (await readLocalManagerVersion(repoRoot)) ?? 'unknown';

  // 2. Refuse if the working tree is dirty. We don't want a silent
  // git pull --ff-only to fail mid-checkout because of a stray local edit
  // (and we definitely don't want --autostash here — losing operator-edited
  // files is much worse than skipping an update).
  const dirty = await runCmd('git', ['-C', repoRoot, 'status', '--porcelain'], { timeoutMs: 15_000 });
  if (dirty.ok && dirty.stdout.trim()) {
    const msg =
      `self-update: refusing to update — working tree at ${repoRoot} is dirty ` +
      `(first line: ${dirty.stdout.trim().split('\n')[0]?.slice(0, 200)}). ` +
      `Stash or commit local changes and retry.`;
    out(msg);
    throw new Error(msg);
  }

  // 3. Pull. --ff-only so we never auto-merge or rewrite history.
  out(`self-update: git pull --ff-only in ${repoRoot}`);
  const pull = await runCmd('git', ['-C', repoRoot, 'pull', '--ff-only'], { timeoutMs: stepTimeout });
  if (!pull.ok) {
    throw new Error(`self-update: git pull --ff-only failed — ${pull.detail}`);
  }
  out(`self-update: git pull → ${pull.detail}`);

  // 4. Install workspace deps. `--workspaces=false` keeps npm scoped to the
  // single package (we're in apps/agent-manager); without it npm walks the
  // whole monorepo and reinstalls client/server too. The `--no-audit
  // --no-fund` pair removes noise that can otherwise dominate the ack
  // detail line.
  out(`self-update: npm install in ${managerDir}`);
  const install = await runCmd(
    npmBin(),
    ['install', '--workspaces=false', '--no-audit', '--no-fund'],
    { cwd: managerDir, timeoutMs: stepTimeout },
  );
  if (!install.ok) {
    throw new Error(`self-update: npm install failed — ${install.detail}`);
  }
  out(`self-update: npm install → ${install.detail}`);

  // 5. Build. Per apps/agent-manager/package.json, `npm run build` is
  // `tsc -p tsconfig.json` — fast, no turbo dep needed at runtime.
  out(`self-update: npm run build in ${managerDir}`);
  const build = await runCmd(npmBin(), ['run', 'build'], { cwd: managerDir, timeoutMs: stepTimeout });
  if (!build.ok) {
    throw new Error(`self-update: npm run build failed — ${build.detail}`);
  }
  out(`self-update: npm run build → ${build.detail}`);

  const newVersion = (await readLocalManagerVersion(repoRoot)) ?? 'unknown';
  const changed = newVersion !== prevVersion;
  const summary = changed
    ? `updated ${prevVersion} → ${newVersion} (repo=${repoRoot})`
    : `repo pulled but package version unchanged at ${newVersion} (repo=${repoRoot})`;
  out(`self-update: ${summary}`);
  return { changed, summary, prevVersion, newVersion };
}

/**
 * Re-exec the manager as a detached, ignored-stdio child. Returns once the
 * spawn syscall completes; does NOT wait for the child to acquire its
 * lockfile (that happens after the parent exits).
 *
 * `--force` is appended (or kept idempotent if already present) so the
 * child takes the lockfile from the dying parent's pid without waiting on
 * SIGTERM grace. We also set `AWB_AGENT_MANAGER_RESPAWN=1` so the child can
 * tell — via the env — that it was started by a self-update vs. a fresh
 * boot, in case future telemetry wants to log it.
 */
export async function respawnManager(opts: { log?: (msg: string) => void } = {}): Promise<void> {
  const out = opts.log ?? log;
  const execPath = process.execPath; // node binary
  const scriptPath = process.argv[1] || ''; // dist/main.js
  if (!scriptPath) {
    throw new Error('respawn: process.argv[1] is empty — cannot reconstruct invocation');
  }

  // Drop --force/-f if present, then add it back so we don't accidentally
  // duplicate the flag. Pass through everything else verbatim.
  const passthroughArgs = process.argv.slice(2).filter((a) => a !== '--force' && a !== '-f');
  const childArgs = [scriptPath, ...passthroughArgs, '--force'];

  const env: NodeJS.ProcessEnv = { ...process.env, AWB_AGENT_MANAGER_RESPAWN: '1' };

  out(`self-update: respawn ${execPath} ${childArgs.join(' ')} (cwd=${process.cwd()})`);
  const child = spawn(execPath, childArgs, {
    cwd: process.cwd(),
    env,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  // unref() so the parent's event loop is no longer blocked by the child.
  // Without this the parent stays alive until the child exits.
  child.unref();

  if (child.pid) {
    out(`self-update: respawned child pid=${child.pid}, parent will exit shortly`);
  } else {
    // pid is null very briefly between fork and exec on some platforms;
    // in practice it's set by the time spawn returns. Treat null as a
    // soft warning rather than an error — the supervisor will catch us.
    out('self-update: respawn returned without a pid — relying on supervisor restart');
  }
}

/**
 * Pick the npm binary name in a way Windows can spawn. On POSIX `npm` is
 * a shell script; on Windows it's `npm.cmd`. Node's spawn auto-resolves
 * extensions on Windows when `shell: false` is set ONLY for `.exe` — for
 * `.cmd` we have to be explicit.
 */
function npmBin(): string {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}
