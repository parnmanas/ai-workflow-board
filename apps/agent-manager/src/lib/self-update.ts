// Self-update for agent-manager.
//
// npm is the ONLY distribution channel. The manager never fetches, checks out,
// or builds from a git remote to update itself — an earlier 'git' install mode
// did exactly that and was removed (see the update-channel note below for how
// to run an unpublished build instead).
//
// Two install modes, selected by detectInstallMode() (see InstallMode):
//   - 'npm-global' — installed via `npm i -g awb-agent-manager` (the running
//                    file lives under `npm root -g`). Version-check =
//                    `npm view awb-agent-manager@<channel> version` (registry);
//                    self-update = verify the published SLSA provenance, then
//                    `npm install -g awb-agent-manager@<verified version>` and
//                    relaunch (Windows routes that through a detached
//                    install-after-exit helper to dodge the self-overwrite
//                    EBUSY/EPERM). The provenance gate is fail-closed — see
//                    parseProvenanceView() below.
//   - 'unknown'    — npm is unreachable (packaged/vendored copy, no npm on
//                    PATH): auto-update impossible, the admin UI shows a
//                    manual-upgrade hint.
//
// Update channel (AWB_AGENT_MANAGER_UPDATE_CHANNEL, default 'latest'):
//   - 'latest'      — track the published release line.
//   - any dist-tag  — e.g. 'next': track a pre-release line published by the
//                     same provenance-signed workflow.
//   - exact version — e.g. '1.6.99': pin to one published build.
//   - 'off'         — disable auto-update entirely. This is the knob for
//                     TESTING AN UNPUBLISHED BUILD without any git involvement:
//                       npm pack -w awb-agent-manager           # → .tgz
//                       npm i -g ./awb-agent-manager-<v>.tgz    # install it
//                       AWB_AGENT_MANAGER_UPDATE_CHANNEL=off    # keep it
//                     The install stays 'npm-global' (it sits under `npm root
//                     -g`), so everything except auto-update behaves normally.
//
// Cadence:
//   - UpdateChecker (slow timer, default 5 min) refreshes the cached
//     `latest_version` / `update_available` snapshot so InstanceHeartbeat can
//     attach it to every payload without paying the network cost each tick.
//   - runSelfUpdate() (one-shot, fired by `update_manager` SSE command or
//     SIGUSR1) does the heavy lifting.

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { log } from './logging.js';

// Our own npm package name — the registry spec npm-global mode reads/installs.
const MANAGER_PACKAGE_NAME = 'awb-agent-manager';
const DEFAULT_CHECK_INTERVAL_MS = 5 * 60 * 1000;
const NPM_VIEW_TIMEOUT_MS = 30_000;
const BUILD_TIMEOUT_MS = 10 * 60_000;
/**
 * Upper bound on how long a self-update stays deferred (across separate
 * runSelfUpdate() calls — see _deferredSince) waiting for in-flight chat /
 * action / QA / ticket-dispatch sessions to drain before forcing the
 * restart anyway. Sessions still running past this cap get SIGTERM'd same
 * as before — the difference is the kill is now tagged
 * `reason=self_update_restart` accurately instead of guessed.
 *
 * Round 2 (ticket b831b896 review): this is now a WALL-CLOCK cap checked on
 * each retry, not a single in-call blocking sleep. Round 1 blocked inside
 * one runSelfUpdate() call for up to this long, which held the
 * selfUpdateInFlight mutex the whole time (silently no-op'ing a concurrent
 * operator restart_manager) and made the SSE update_manager ack arrive
 * after the server's command-ledger RECORD_TTL_MS (also 10 minutes —
 * apps/server/src/modules/agent-manager/command-ledger.service.ts),
 * getting rejected 410 even though the update itself succeeded.
 */
export const SELF_UPDATE_DRAIN_MAX_WAIT_MS = 10 * 60_000;

/** Env var selecting the update channel. See the file header for the values. */
export const UPDATE_CHANNEL_ENV = 'AWB_AGENT_MANAGER_UPDATE_CHANNEL';
const DEFAULT_UPDATE_CHANNEL = 'latest';
/** Sentinel channel that pins the installed build (no auto-update at all). */
export const UPDATE_CHANNEL_OFF = 'off';

/**
 * How this manager binary was installed — decides the self-update strategy.
 *   - 'npm-global' — installed via `npm i -g awb-agent-manager` (npm is
 *                    reachable, so the registry channel is usable).
 *   - 'unknown'    — npm unreachable (packaged / vendored copy): auto-update
 *                    impossible, upgrade manually.
 */
export type InstallMode = 'npm-global' | 'unknown';

/**
 * Resolve the configured update channel, sanitized.
 *
 * The result is interpolated into an `npm view` / `npm install -g` spec that
 * runs with `shell:true` on Windows, so an unvalidated value would be a command
 * -injection vector via the environment. Only npm dist-tag / version characters
 * survive; anything else falls back to the default channel.
 */
export function resolveUpdateChannel(raw?: string | null): string {
  const v = String(raw ?? process.env[UPDATE_CHANNEL_ENV] ?? '').trim();
  if (!v) return DEFAULT_UPDATE_CHANNEL;
  if (v.toLowerCase() === UPDATE_CHANNEL_OFF) return UPDATE_CHANNEL_OFF;
  // npm dist-tags and versions: start alphanumeric, then [A-Za-z0-9._-].
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(v) ? v : DEFAULT_UPDATE_CHANNEL;
}

/** True when the channel pins the current build (auto-update disabled). */
export function isAutoUpdateDisabled(channel: string): boolean {
  return channel === UPDATE_CHANNEL_OFF;
}

/** `awb-agent-manager@<channel>` — the npm spec for the active channel. */
function npmChannelSpec(channel: string): string {
  return `${MANAGER_PACKAGE_NAME}@${channel}`;
}

export interface UpdateStatus {
  /** Currently-running manager version (from package.json on disk). */
  current_version: string;
  /** Latest version published on the active channel, or null when we couldn't
   *  read it (network error / auto-update off / first tick hasn't run yet). */
  latest_version: string | null;
  /** True when latest_version > current_version (semver-aware). False when
   *  equal or current is ahead (locally-packed build). */
  update_available: boolean;
  /** How this manager was installed — the self-update strategy selector.
   *  'npm-global' checks the npm registry and can auto-update via `npm i -g`;
   *  'unknown' can only be upgraded manually. */
  install_mode: InstallMode;
  /** Active npm update channel: 'latest', a dist-tag, an exact version, or
   *  'off' when the operator pinned this build (see UPDATE_CHANNEL_ENV). */
  update_channel: string;
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
  /** ticket b831b896 round 2: true when `changed:false` means "an update IS
   *  needed but is waiting for in-flight sessions to drain — UpdateChecker
   *  will retry automatically", as opposed to a genuine skip/refuse
   *  (channel off, npm unreachable, provenance refused, already up to
   *  date) or a real failure (install failed). Callers that otherwise treat
   *  `changed:false` as an error (e.g. the SSE update_manager ack) should
   *  NOT do so when this is true — nothing is wrong, the update is simply
   *  pending. */
  deferred?: boolean;
}

export interface SelfUpdateOpts {
  log?: (msg: string) => void;
  /** Skip the actual re-exec — useful for tests / dry runs. */
  noReExec?: boolean;
  /**
   * Returns the number of chat/action/QA/ticket-dispatch sessions currently
   * in flight. Checked ONCE an actual install has been confirmed (channel
   * on, npm reachable, provenance verified, not already up to date) — a
   * non-zero count returns a `changed:false` "deferred" result immediately
   * (no blocking sleep); UpdateChecker's periodic tick retries automatically
   * until drainMaxWaitMs elapses (ticket b831b896 round 2 — round 1 blocked
   * in-call, which held the selfUpdateInFlight mutex and delayed the SSE
   * ack past the server's command-ledger TTL). Omitted by callers that
   * can't tell us what's running (legacy tests, dry-run probes) — the check
   * is skipped entirely rather than guessing. */
  countInFlightSessions?: () => number;
  /** Test-only override for the drain wait cap (default SELF_UPDATE_DRAIN_MAX_WAIT_MS). */
  drainMaxWaitMs?: number;
}

interface RunResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
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
 * unit-tested without spawning `npm`. See InstallMode for the meaning of each
 * result.
 *   - npm reachable → 'npm-global' (the registry channel is usable)
 *   - otherwise     → 'unknown'    (manual upgrade only)
 *
 * Reachable npm is the whole test, deliberately — it is NOT narrowed to
 * "the running file sits under `npm root -g`". A locally-packed tarball
 * installed to a custom prefix is still moved by `npm i -g`, so it belongs on
 * the same path.
 */
export function classifyInstallMode(npmGlobalRoot: string | null): InstallMode {
  return npmGlobalRoot ? 'npm-global' : 'unknown';
}

/** Classify how this manager was installed by probing `npm root -g`. */
export function detectInstallMode(): InstallMode {
  return classifyInstallMode(detectNpmGlobalRoot());
}

/**
 * Read the manager's own running version from a build-time snapshot of
 * package.json baked into dist/ during `npm run build`.
 *
 * Priority:
 *   1. `dist/package.json`  — copied by the build script, frozen at build
 *      time, so it always describes the code actually loaded into this
 *      process rather than whatever the working tree currently holds.
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
 * Run a bounded command synchronously with `shell:true` on Windows so `npm`/`npm.cmd` resolves via
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
      windowsHide: true,
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
  /** ticket b831b896 round 2: lets #tick retry a self-update that an
   *  earlier runSelfUpdate() call deferred because sessions were in flight.
   *  Nullable — main.ts wires this in via setCountInFlightSessions() AFTER
   *  construction, since the session managers it reads don't exist yet at
   *  the point UpdateChecker itself is constructed. */
  #countInFlightSessions: (() => number) | null = null;

  constructor(
    opts: {
      intervalMs?: number;
      log?: (msg: string) => void;
      /** Test-only injection: drive #tick without the real detectors.
       *  Production callers pass none of these — everything below is
       *  auto-detected. */
      installMode?: InstallMode;
      updateChannel?: string;
      currentVersion?: string;
      /** See setCountInFlightSessions — accepted here too so a test can
       *  construct a fully-wired checker in one call. */
      countInFlightSessions?: () => number;
    } = {},
  ) {
    this.#intervalMs = opts.intervalMs ?? DEFAULT_CHECK_INTERVAL_MS;
    this.#log = opts.log ?? log;
    this.#countInFlightSessions = opts.countInFlightSessions ?? null;
    const install_mode = opts.installMode ?? classifyInstallMode(detectNpmGlobalRoot());
    const update_channel = resolveUpdateChannel(opts.updateChannel);
    // The build-time snapshot (dist/package.json) is the running code's own
    // version — frozen at build, so it always matches what is actually loaded.
    const current_version = opts.currentVersion ?? (readBundledVersion() || '0.0.0');
    // last_error is reserved for actionable failures (registry unreachable,
    // unparseable response, …). "npm not available" is signalled via
    // install_mode='unknown' + a one-line log on start; the UI uses that to
    // render a "manual updates only" badge instead of a misleading
    // "check failed".
    this.#status = {
      current_version,
      latest_version: null,
      update_available: false,
      install_mode,
      update_channel,
      last_checked_at: null,
      last_error: null,
    };
  }

  /** Snapshot of the current cache. Heartbeat reads this on every tick. */
  status(): UpdateStatus {
    // Defensive copy so the caller can't accidentally mutate the cache.
    return { ...this.#status };
  }

  /** ticket b831b896 round 2: wire the live in-flight session counter in
   *  after construction (main.ts builds this checker before the chat /
   *  ticket / subagent managers it reads from exist). Once set, #tick
   *  retries any self-update that's currently deferred waiting for
   *  sessions to drain — see hasPendingSelfUpdate(). */
  setCountInFlightSessions(fn: () => number): void {
    this.#countInFlightSessions = fn;
  }

  start(): void {
    if (this.#stopped || this.#timer) return;
    if (this.#status.install_mode !== 'npm-global') {
      this.#log('UpdateChecker: npm is not reachable — auto-update disabled (upgrade manually)');
      return;
    }
    if (isAutoUpdateDisabled(this.#status.update_channel)) {
      this.#log(
        `UpdateChecker: ${UPDATE_CHANNEL_ENV}=${UPDATE_CHANNEL_OFF} — auto-update disabled, ` +
          `pinned to v${this.#status.current_version}`,
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
      `UpdateChecker started (npm-global mode: npm view ` +
        `${npmChannelSpec(this.#status.update_channel)} ` +
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
    if (this.#status.install_mode !== 'npm-global') return;
    if (isAutoUpdateDisabled(this.#status.update_channel)) return;
    await this.#tickNpmGlobal();
    // ticket b831b896 round 2: retry a self-update that an earlier
    // runSelfUpdate() call (SIGUSR1 / SSE update_manager) deferred because
    // sessions were in flight — that call already returned immediately
    // rather than blocking, so this periodic tick is the only thing that
    // ever revisits it. runSelfUpdate owns the selfUpdateInFlight mutex and
    // the SELF_UPDATE_DRAIN_MAX_WAIT_MS wall-clock cap itself, so this is a
    // plain retry, not a special case.
    if (this.#countInFlightSessions && hasPendingSelfUpdate()) {
      try {
        await runSelfUpdate({ log: this.#log, countInFlightSessions: this.#countInFlightSessions });
      } catch (err: any) {
        this.#log(`Self-update retry failed: ${err?.stack || err?.message || err}`);
      }
    }
  }

  /**
   * npm-global mode tick: read the latest published version from the npm
   * registry (`npm view awb-agent-manager@<channel> version`) and refresh the
   * cache.
   * current_version is the build-time bundled version (dist/package.json) — the
   * actually-installed build — so the semver compare is apples-to-apples.
   */
  async #tickNpmGlobal(): Promise<void> {
    try {
      // shell:true on Windows (npm.cmd). cwd is irrelevant for a registry read.
      const r = await runAsync(
        'npm',
        ['view', npmChannelSpec(this.#status.update_channel), 'version'],
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
  _pendingRestartReason = null;
  _deferredSince = null;
  _lastDeferredDueToSessions = false;
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
    // _deferredSince tracks a "waiting for sessions to drain" streak ACROSS
    // separate runSelfUpdate() calls (this call may be a UpdateChecker retry
    // of an earlier deferral) — clear it on any outcome except "still
    // deferred", same one-shot-flag idiom as _lastReExecScheduled above.
    if (!_lastDeferredDueToSessions) {
      _deferredSince = null;
    }
    _lastDeferredDueToSessions = false;
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
 * Set by runNpmGlobalSelfUpdate right before it schedules the self-SIGTERM
 * that drives reExecManager / shutdownForNpmGlobalUpdate. Read by main.ts's
 * shutdown handler so a session killed by THAT SIGTERM is reported with an
 * accurate `reason=self_update_restart` instead of a guessed idle/watchdog
 * cause (ticket b831b896) — main.ts has no other way to distinguish "I'm
 * restarting myself for a version update" from a plain operator SIGTERM /
 * SIGINT or a manual `restart_manager` command, both of which route through
 * the exact same shutdown() → stop() call chain.
 */
let _pendingRestartReason: 'self_update_restart' | null = null;

/** Read by main.ts's shutdown handler — see _pendingRestartReason. */
export function pendingRestartReason(): 'self_update_restart' | null {
  return _pendingRestartReason;
}

/**
 * Wall-clock timestamp (Date.now()) of the first deferred-due-to-sessions
 * self-update attempt in the current streak, or null when nothing is
 * currently deferred. Tracked ACROSS separate runSelfUpdate() calls (a
 * retry from UpdateChecker's tick is a fresh call) rather than held across
 * one blocking sleep — see SELF_UPDATE_DRAIN_MAX_WAIT_MS for why round 1's
 * in-call blocking wait was wrong.
 */
let _deferredSince: number | null = null;

/** Set (once) right before a "still deferred, within cap" return so
 *  runSelfUpdate's finally{} knows NOT to clear _deferredSince — same
 *  one-shot-flag idiom as _lastReExecScheduled. */
let _lastDeferredDueToSessions = false;

/** True while a self-update is deferred waiting for in-flight sessions to
 *  drain. UpdateChecker's periodic tick reads this to decide whether to
 *  retry runSelfUpdate on its own (see UpdateChecker#tick). */
export function hasPendingSelfUpdate(): boolean {
  return _deferredSince !== null;
}

export interface NpmUpdateGateResult {
  /** True = go ahead and install (sessions are clear, or the cap forced it). */
  proceed: boolean;
  /** True = `proceed:false` because the count was zero anyway (nothing to
   *  install to begin with) — never true when proceed is true. */
  deferred: boolean;
  /** _deferredSince value the caller should hold going forward — null clears
   *  it (nothing pending anymore), a timestamp starts/continues a streak. */
  nextDeferredSinceMs: number | null;
  /** Human-readable outcome, or null when there's nothing worth logging
   *  (count was 0 and no prior deferral was in progress). */
  summary: string | null;
}

/**
 * Pure decision point for whether an install-confirmed self-update should
 * proceed now, defer, or force through past the drain cap. Synchronous and
 * side-effect-free by construction — cannot block — so it's the thing to
 * unit test directly rather than the full runNpmGlobalSelfUpdate pipeline,
 * which needs a real npm registry round-trip to even reach this point
 * (ticket b831b896 round 2 review — round 1's blocking in-call sleep here
 * was the actual defect: it held the caller for up to `capMs`, which held
 * the module-level self-update mutex that whole time and made the SSE
 * update_manager ack arrive after the server's command-ledger TTL).
 */
export function evaluateNpmUpdateGate(input: {
  countInFlightSessions: number | null;
  deferredSinceMs: number | null;
  nowMs: number;
  capMs: number;
}): NpmUpdateGateResult {
  const { countInFlightSessions, deferredSinceMs, nowMs, capMs } = input;
  if (countInFlightSessions === null) {
    // Not wired (legacy caller, dry-run probe) — never block on a question
    // we have no way to answer.
    return { proceed: true, deferred: false, nextDeferredSinceMs: null, summary: null };
  }
  if (countInFlightSessions <= 0) {
    const summary = deferredSinceMs !== null ? 'in-flight sessions drained — proceeding with restart' : null;
    return { proceed: true, deferred: false, nextDeferredSinceMs: null, summary };
  }
  const since = deferredSinceMs ?? nowMs;
  const deferredForMs = nowMs - since;
  if (deferredForMs < capMs) {
    const summary =
      `npm-global update deferred: ${countInFlightSessions} in-flight session(s) — will retry ` +
      `automatically (deferred ${Math.round(deferredForMs / 1000)}s so far, ` +
      `cap ${Math.round(capMs / 60_000)}min)`;
    return { proceed: false, deferred: true, nextDeferredSinceMs: since, summary };
  }
  const summary =
    `drain wait cap (${Math.round(capMs / 60_000)}min) exceeded — ` +
    `proceeding with ${countInFlightSessions} session(s) still in flight`;
  return { proceed: true, deferred: false, nextDeferredSinceMs: null, summary };
}

async function runSelfUpdateLocked(
  opts: SelfUpdateOpts,
  out: (msg: string) => void,
): Promise<SelfUpdateResult> {
  const channel = resolveUpdateChannel();
  if (isAutoUpdateDisabled(channel)) {
    const summary =
      `self-update skipped: ${UPDATE_CHANNEL_ENV}=${UPDATE_CHANNEL_OFF} pins this build ` +
      `(v${readBundledVersion()})`;
    out(`Self-update: ${summary}`);
    return { changed: false, summary };
  }
  if (classifyInstallMode(detectNpmGlobalRoot()) !== 'npm-global') {
    const summary = 'self-update skipped: npm is not reachable (upgrade this build manually)';
    out(`Self-update: ${summary}`);
    return { changed: false, summary };
  }
  return await runNpmGlobalSelfUpdate(opts, out, channel);
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
  // --ignore-scripts: same reason as the POSIX path — provenance covers our own
  // tarball, not the transitive tree's install scripts. Bin linking is npm core,
  // not a lifecycle script, so the shim below is still created.
  const install = spawnSync('npm', ['install', '-g', '--ignore-scripts', npmSpec], {
    stdio: 'ignore',
    shell: isWin,
    windowsHide: true,
  });
  const ok = install.status === 0 && !install.error;

  // 3. Relaunch the globally installed manager. A legacy service unit may still
  // point at a source checkout's main.js; resolve npm root -g and relaunch the
  // package we just installed rather than jumping back into that stale tree.
  // (No backticks in this string — it is embedded in a template literal.)
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

// ---------------------------------------------------------------------------
// npm-global self-update: SLSA provenance gate (2026-08-15 보안 감사)
// ---------------------------------------------------------------------------
// publish 쪽은 2026-08-10 감사 이후 `npm publish --provenance` 로 Sigstore SLSA
// 증명을 남긴다. 하지만 **소비 쪽은 그 증명을 한 번도 확인하지 않았다** — 이
// 경로는 `npm install -g awb-agent-manager@latest` 를 그대로 실행하고, 받은
// tarball 이 우리 CI 에서 나온 것인지 묻지 않은 채 fleet 전체를 재시작한다.
// 즉 publish 워크플로의 NPM_TOKEN(Automation, 2FA bypass)이 유출되면 공격자가
// 올린 임의 tarball 이 self-update 를 타고 모든 매니저 호스트에서 실행된다.
//
// 왜 이 게이트가 실효가 있나: provenance 증명은 GitHub Actions 의 OIDC 토큰으로
// Sigstore 에 서명해야만 만들어진다. 유출된 npm 토큰만 쥔 공격자는 tarball 은
// 올릴 수 있어도 provenance 는 만들 수 없다. 따라서 "증명 없는 버전은 설치하지
// 않는다"는 규칙 하나가 그 시나리오를 통째로 막는다.
//
// fail-closed: 레지스트리 조회 실패/파싱 실패/증명 없음 — 전부 설치 거부다.
// 애매한 오류에 설치를 강행하는 fail-open 은 publish 워크플로의 probe-exists
// 단계에서 이미 한 번 막은 실수라 여기서도 반복하지 않는다. 거부의 결과는
// "업데이트가 안 된다"일 뿐 매니저는 계속 돌아가므로 안전한 실패 방향이다.
// 복구용 탈출구는 AWB_SELF_UPDATE_ALLOW_UNVERIFIED=1 (명시적 opt-in) 하나뿐.
const PROVENANCE_BYPASS_ENV = 'AWB_SELF_UPDATE_ALLOW_UNVERIFIED';
const SLSA_PREDICATE_PREFIX = 'https://slsa.dev/provenance/';

export interface ProvenanceVerdict {
  /** true = 레지스트리 최신 버전이 SLSA provenance 증명을 갖고 있다. */
  ok: boolean;
  /** 검증에 성공한 정확한 버전. 설치 spec 을 이 값으로 고정한다. */
  version: string | null;
  /** 사람이 읽는 판정 사유 (거부 시 그대로 SelfUpdateResult.summary 에 실린다). */
  reason: string;
}

/**
 * `npm view <pkg>@<channel> version dist.attestations --json` 의 stdout 을 판정.
 *
 * 순수 함수로 분리한 이유: 네트워크 없이 "공격자가 만들 수 있는 응답"들
 * (증명 필드 없음 / provenance 없음 / predicateType 위조)을 단위 테스트로
 * 직접 먹여볼 수 있어야 게이트가 실제로 무는지 증명된다.
 */
export function parseProvenanceView(stdout: string): ProvenanceVerdict {
  const text = String(stdout ?? '');
  // npm 은 warn 을 stderr 로 보내지만, 셸 래퍼가 섞어 넘길 수 있으니 첫 `{` 부터 판다.
  const start = text.indexOf('{');
  if (start < 0) {
    return { ok: false, version: null, reason: 'npm view returned no JSON object' };
  }
  let parsed: any;
  try {
    parsed = JSON.parse(text.slice(start));
  } catch {
    return { ok: false, version: null, reason: 'npm view output was not valid JSON' };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, version: null, reason: 'npm view output was not a metadata object' };
  }

  const version = typeof parsed.version === 'string' ? parsed.version.trim() : '';
  if (!/^\d+\.\d+\.\d+/.test(version)) {
    return { ok: false, version: null, reason: `npm view returned no usable version (${JSON.stringify(parsed.version)?.slice(0, 60)})` };
  }

  // 필드를 여러 개 요청하면 npm 은 평평한 `"dist.attestations"` 키로 준다.
  // 단일 필드/전체 문서 조회 형태(dist.attestations 중첩)도 같이 받아준다.
  const attestations =
    parsed['dist.attestations'] ??
    (parsed.dist && typeof parsed.dist === 'object' ? parsed.dist.attestations : undefined);
  if (!attestations || typeof attestations !== 'object') {
    return { ok: false, version, reason: `${MANAGER_PACKAGE_NAME}@${version} has no npm attestations (unsigned publish — refusing)` };
  }
  const provenance = (attestations as any).provenance;
  if (!provenance || typeof provenance !== 'object') {
    return { ok: false, version, reason: `${MANAGER_PACKAGE_NAME}@${version} has attestations but no provenance predicate (refusing)` };
  }
  const predicateType = typeof provenance.predicateType === 'string' ? provenance.predicateType : '';
  if (!predicateType.startsWith(SLSA_PREDICATE_PREFIX)) {
    return { ok: false, version, reason: `${MANAGER_PACKAGE_NAME}@${version} provenance predicate is not SLSA (${predicateType.slice(0, 80) || 'absent'}) — refusing` };
  }
  const url = typeof (attestations as any).url === 'string' ? (attestations as any).url : '';
  if (!url.startsWith('https://')) {
    return { ok: false, version, reason: `${MANAGER_PACKAGE_NAME}@${version} attestation bundle is not served over https — refusing` };
  }

  return { ok: true, version, reason: `${MANAGER_PACKAGE_NAME}@${version} carries SLSA provenance (${predicateType})` };
}

/** 명시적 opt-in 탈출구. 레지스트리가 증명을 못 내주는 장애 상황의 운영 복구용. */
function provenanceGateBypassed(): boolean {
  const v = String(process.env[PROVENANCE_BYPASS_ENV] ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

/**
 * 레지스트리에서 최신 버전 + 그 버전의 provenance 증명을 함께 읽어 판정한다.
 * 조회 자체가 실패하면 fail-closed (ok=false).
 */
async function verifyNpmGlobalProvenance(
  out: (msg: string) => void,
  channel: string,
): Promise<ProvenanceVerdict> {
  const r = await runAsync(
    'npm',
    ['view', npmChannelSpec(channel), 'version', 'dist.attestations', '--json'],
    tmpdir(),
    NPM_VIEW_TIMEOUT_MS,
  );
  if (!r.ok) {
    const detail =
      (r.stderr.trim() || r.stdout.trim() || 'unknown')
        .split('\n')
        .filter(Boolean)
        .pop()
        ?.slice(0, 200) || 'npm view failed';
    return { ok: false, version: null, reason: `could not read publish provenance: ${detail}` };
  }
  const verdict = parseProvenanceView(r.stdout);
  out(`Self-update: provenance check — ${verdict.reason}`);
  return verdict;
}

/**
 * npm-global self-update: stage a detached helper, hand it our pid + restart
 * command, then shut ourselves down so it can reinstall + relaunch. This is the
 * helper process specifically so the `npm i -g` runs AFTER we exit (Windows
 * can't replace a running node process's own package dir — EBUSY/EPERM).
 */
async function runNpmGlobalSelfUpdate(
  opts: SelfUpdateOpts,
  out: (msg: string) => void,
  channel: string,
): Promise<SelfUpdateResult> {
  const current = readBundledVersion();
  const channelSpec = npmChannelSpec(channel);
  out(`Self-update: npm-global mode (current v${current}) — target ${channelSpec}`);

  // 설치 전에 증명을 먼저 본다. dry-run 보다도 앞에 두는 이유: dry-run 의 목적이
  // "이 업데이트가 실제로 진행될지"를 보고하는 것이라, 거부될 업데이트를
  // "would run" 이라고 보고하면 거짓말이 된다.
  const verdict = await verifyNpmGlobalProvenance(out, channel);
  if (!verdict.ok) {
    if (!provenanceGateBypassed()) {
      const summary = `npm-global update refused: ${verdict.reason}`;
      out(`Self-update: ${summary}`);
      return { changed: false, summary };
    }
    out(`Self-update: ${PROVENANCE_BYPASS_ENV} set — proceeding despite unverified provenance`);
  }

  // ticket b831b896 review round 2: nothing upstream of this ever compared
  // current-vs-latest — every call unconditionally reinstalled, even a
  // no-op reinstall of the version already running. That made an
  // already-latest / auto-update-off manager pay the full drain-wait below
  // for a restart that was never going to happen. verdict.version is the
  // exact version we'd install (resolved + provenance-verified above), so
  // this is the earliest point we can know "is there actually anything to
  // do" — skip before it costs a session-drain check or an npm install.
  if (verdict.version && compareSemver(verdict.version, current) <= 0) {
    const summary = `npm-global update skipped: already on v${current} (registry has v${verdict.version})`;
    out(`Self-update: ${summary}`);
    return { changed: false, summary };
  }

  // 검증된 정확한 버전으로 설치 spec 을 고정한다. dist-tag(`@latest`/`@next`) 를
  // 검증한 뒤 다시 같은 태그로 설치하면 그 사이 태그가 옮겨간 tarball 이 들어오는
  // TOCTOU 구멍이 남는다 — 검증한 바이트와 설치하는 바이트가 같아야 게이트가
  // 의미를 갖는다.
  const installSpec =
    verdict.ok && verdict.version ? `${MANAGER_PACKAGE_NAME}@${verdict.version}` : channelSpec;

  // Dry-run / test hook: report intent without spawning the helper or exiting.
  if (opts.noReExec) {
    const summary = `npm-global update: would run \`npm install -g --ignore-scripts ${installSpec}\` + restart (re-exec skipped)`;
    out(`Self-update: ${summary}`);
    return { changed: true, summary, willReExec: false };
  }

  // ticket b831b896 review round 2: an install + restart is now DEFINITELY
  // about to happen (every earlier gate passed) — this is the one place a
  // session-drain check belongs. evaluateNpmUpdateGate is synchronous and
  // side-effect-free (cannot block); UpdateChecker's periodic tick retries
  // this whole call automatically until the gate reports proceed:true.
  const gate = evaluateNpmUpdateGate({
    countInFlightSessions: opts.countInFlightSessions ? opts.countInFlightSessions() : null,
    deferredSinceMs: _deferredSince,
    nowMs: Date.now(),
    capMs: opts.drainMaxWaitMs ?? SELF_UPDATE_DRAIN_MAX_WAIT_MS,
  });
  _deferredSince = gate.nextDeferredSinceMs;
  if (gate.summary) out(`Self-update: ${gate.summary}`);
  if (!gate.proceed) {
    _lastDeferredDueToSessions = gate.deferred;
    return { changed: false, summary: gate.summary!, deferred: gate.deferred || undefined };
  }

  // POSIX can replace the package files while Node has the old modules mapped.
  // Install FIRST and restart only after npm succeeds. The previous universal
  // exit-first helper raced systemd's Restart=always: systemd relaunched the old
  // package after five seconds while the detached helper was still waiting or
  // installing, yet the command had already reported success.
  if (process.platform !== 'win32') {
    out(`Self-update: npm install -g --ignore-scripts ${installSpec}`);
    // `--ignore-scripts` — provenance 게이트는 **우리 tarball 의 출처**만 보증한다.
    // 그 아래 95개 전이 의존성은 `^` 범위로 그 시점 레지스트리에서 해석되므로,
    // 그중 하나가 postinstall 을 달고 들어오면 CVE 없이도 이 호스트에서 매니저
    // 권한으로 임의 코드가 돈다. 발행 트리의 install-script 패키지는 실측 0개이고
    // (scripts/audit-published-deps.mjs 가 매 cron 마다 그 0 을 재확인한다), 위
    // bin 링크는 lifecycle script 가 아니라 npm 코어 동작이라 이 플래그에 영향받지
    // 않는다 — 실측: `--ignore-scripts` 로 설치해도 bin 심링크·실행 모두 정상.
    const installed = await runAsync(
      'npm',
      ['install', '-g', '--ignore-scripts', installSpec],
      tmpdir(),
      BUILD_TIMEOUT_MS,
      (line) => out(`  [npm-global] ${line}`),
    );
    if (!installed.ok) {
      const detail = (installed.stderr.trim() || installed.stdout.trim())
        .split('\n').filter(Boolean).pop() || `exit=${installed.exitCode}`;
      const summary = `npm-global update failed: ${detail.slice(0, 240)}`;
      out(`Self-update: ${summary}`);
      return { changed: false, summary };
    }
    const summary = `npm-global update installed ${installSpec}; restarting manager`;
    out(`Self-update: ${summary}`);
    _lastReExecScheduled = true;
    _pendingRestartReason = 'self_update_restart';
    setTimeout(() => reExecManager(out), 1500).unref?.();
    return { changed: true, summary, willReExec: true };
  }

  // Windows cannot replace files in the running package tree. Keep the
  // exit-first helper there, where no systemd restart race exists.
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
    installSpec,
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

  const summary = `npm-global update scheduled: detached helper runs \`npm install -g --ignore-scripts ${installSpec}\` after exit, then restarts`;
  out(`Self-update: ${summary}`);

  // Same 1.5s tail as the git path: let the caller finish its ack POST + log
  // line, then shut down. The helper is already polling our pid. Keep the
  // in-flight flag set across the grace window (see runSelfUpdate's finally).
  _lastReExecScheduled = true;
  _pendingRestartReason = 'self_update_restart';
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
