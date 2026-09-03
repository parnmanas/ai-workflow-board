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
import {
  BOOT_VERIFY_TIMEOUT_MS,
  MAX_INSTALL_ATTEMPTS,
  clearBootVerificationRecord,
  evaluateBootProbe,
  evaluateBootVerification,
  evaluateInstallRetryGate,
  newInstallRecord,
  readBootVerificationRecord,
  readUpdatePin,
  updatePinPath,
  withAwaitingBoot,
  withBootAttempt,
  withInstallFailure,
  withRollbackAttempt,
  withinMaintenanceWindowNow,
  writeBootVerificationRecord,
  writeUpdatePin,
  type BootDecisionKind,
  type BootVerificationRecord,
  type UpdatePinRecord,
} from './self-update-rollback.js';

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

/** 복귀 재기동이 끝내 발화하지 않을 때 프로세스를 비정상 종료시키는 상한
 *  (감독자가 다시 띄우게 한다). scheduleRollbackRestart 참고. */
const ROLLBACK_RESTART_BACKSTOP_MS = 60_000;

/** 새 진입점 프로브의 상한. `--version` 은 즉시 끝나므로 넉넉하다. */
const ENTRYPOINT_PROBE_TIMEOUT_MS = 60_000;

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

/**
 * 복귀 핀을 반영한 실효 채널 (ticket 23753dc7 — 정책 C·G).
 *
 * 부팅 검증에 실패해 이전 버전으로 되돌린 뒤에는 채널을 그 정확한 버전으로
 * 고정한다. 이것이 "같은 나쁜 버전을 즉시 다시 집지 않는다"를 만드는 장치다:
 * 채널이 dist-tag(`latest`) 로 남아 있으면 다음 tick 이 곧바로 같은 불량
 * 버전을 다시 해석해 재설치 루프가 된다. 정확한 버전으로 고정하면 provenance
 * 조회도 그 버전만 해석하고, 이어지는 `compareSemver(target, current) <= 0`
 * 스킵에 걸려 아무것도 설치하지 않는다.
 *
 * `off` 는 핀보다도 우선한다 — 운영자가 건 하드 핀이 자동 복구가 건 핀에
 * 덮이면 안 된다(정책 D).
 *
 * 핀 해제는 사람만 한다: 핀 파일을 지우는 것이 유일한 해제 수단이고, 이
 * 코드베이스 어디에도 핀을 지우는 경로는 없다.
 */
export function resolveEffectiveUpdateChannel(
  channel: string,
  pin: UpdatePinRecord | null,
): string {
  if (channel === UPDATE_CHANNEL_OFF) return channel;
  return pin?.version ? pin.version : channel;
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
  /** 부팅 검증 상태 / 복귀 핀 파일을 둘 디렉터리. 생략하면 매니저 홈
   *  (`$AWB_AGENT_MANAGER_HOME`). 테스트가 tmp 디렉터리로 격리하기 위한 주입점.  */
  stateDir?: string;
  /**
   * 지금이 유지보수 창 안인지 (ticket 23753dc7 — 정책 G 의 설치 실패 재시도
   * 게이트 입력). 생략하면 `AWB_AGENT_MANAGER_UPDATE_WINDOW` 를 읽어 판정한다
   * (미설정이면 항상 창 안 = 현행 동작). 테스트가 벽시계에 의존하지 않도록 값을
   * 직접 넘길 수 있게 열어 둔다.
   */
  withinWindow?: boolean;
  /**
   * 설치 / provenance / 재기동 / 진입점 프로브를 주입 가능한 포트로 뺀 것
   * (리뷰 지적 3). 복귀 경로는 실제 npm 레지스트리와 프로세스 종료를 요구해
   * 통합 테스트로 분기를 태울 수 없다. 프로덕션 호출부는 아무것도 넘기지
   * 않으며, 그때 각 포트는 아래 실제 구현으로 해석된다.
   */
  ports?: SelfUpdatePorts;
}

/** 새로 설치된 진입점을 실제로 실행해 본 결과. */
export interface EntrypointProbeResult {
  ok: boolean;
  /** 진입점이 스스로 보고한 버전(`--version` 출력). 실패면 null. */
  reportedVersion: string | null;
  detail: string;
}

export interface SelfUpdatePorts {
  /** `npm install -g --ignore-scripts <spec>` */
  install?: (spec: string) => Promise<{ ok: boolean; detail: string }>;
  /** 레지스트리 provenance 판정 */
  verifyProvenance?: (channel: string) => Promise<ProvenanceVerdict>;
  /** 재기동 예약 */
  restart?: () => void;
  /** 새로 설치된 진입점이 실제로 뜨는지 확인 */
  probe?: (input: { expectVersion: string }) => Promise<EntrypointProbeResult>;
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
      /** 복귀 핀 파일을 읽을 디렉터리. 생략하면 매니저 홈. 테스트 격리용. */
      stateDir?: string;
    } = {},
  ) {
    this.#intervalMs = opts.intervalMs ?? DEFAULT_CHECK_INTERVAL_MS;
    this.#log = opts.log ?? log;
    this.#countInFlightSessions = opts.countInFlightSessions ?? null;
    const install_mode = opts.installMode ?? classifyInstallMode(detectNpmGlobalRoot());
    // ticket 23753dc7: 복귀 핀이 걸려 있으면 그 정확한 버전이 실효 채널이다.
    // 체커가 광고하는 `update_available` 까지 핀을 반영해야, 되돌린 호스트의
    // 대시보드가 방금 되돌린 불량 버전을 다시 "업데이트 가능"으로 띄우지 않는다.
    const update_channel = resolveEffectiveUpdateChannel(
      resolveUpdateChannel(opts.updateChannel),
      readUpdatePin(opts.stateDir),
    );
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
 * 이 유닛은 `Restart=on-failure`로 동작하므로 재시작 여부는 exit 코드에 달려
 * 있다: 0이 아닌 exit여야 systemd가 재기동시키고, 정상 exit(0)(예: 의도적인
 * `systemctl stop`)이면 멈춘 채로 남는다. 여기서 exit 1을 쓰는 것 자체가
 * re-exec이 실제로 재시작되게 만드는 조건이며, 동시에 exit 코드의 의미도
 * 정직하게 유지한다(1 = 비정상/재기동, 0 = 정상 정지) — 로그와 journald
 * 기록을 위해서도 그렇다.
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

/** 테스트 전용 탈출구: runNpmGlobalSelfUpdate() 를 통해 실제 npm-global 설치 +
 *  자가 SIGTERM 을 구동하지 않고도 pendingRestartReason() 을 검증할 수 있게
 *  한다(ticket 6abe2b79 — pendingRestartReason 자체는 b831b896 이 도입했지만
 *  이 getter 를 직접 검증하는 테스트는 없었다; main.ts 의 SubagentManager.stop()
 *  배선이 이 값에 의존하므로 여기서 커버한다). */
export function _setPendingRestartReasonForTests(reason: 'self_update_restart' | null): void {
  _pendingRestartReason = reason;
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

/**
 * True while a self-update still has work pending that UpdateChecker's
 * periodic tick should revisit (see UpdateChecker#tick). Two sources:
 *
 *  1. 진행 중 세션이 빠지길 기다리는 drain 연기 (_deferredSince, ticket b831b896).
 *  2. ticket 23753dc7 — 설치가 실패했고 아직 재시도 상한이 남은 상태. 이 신호가
 *     없으면 정책 G 의 백오프(5분 → 15분)를 소진할 주체가 없어 "재시도한다"가
 *     선언에 그친다. 상태 파일을 읽으므로 **재기동을 넘어서도** 성립한다 —
 *     Windows 경로에서는 실패를 관측한 프로세스와 재시도할 프로세스가 아예 다르다.
 *     상한을 소진하면 phase 가 install_blocked 로 바뀌어 여기서 false 가 되고,
 *     자동 시도는 그대로 멈춘다.
 */
export function hasPendingSelfUpdate(opts: { stateDir?: string } = {}): boolean {
  if (_deferredSince !== null) return true;
  return readBootVerificationRecord(opts.stateDir)?.phase === 'install_failed';
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
  const rawChannel = resolveUpdateChannel();
  if (isAutoUpdateDisabled(rawChannel)) {
    const summary =
      `self-update skipped: ${UPDATE_CHANNEL_ENV}=${UPDATE_CHANNEL_OFF} pins this build ` +
      `(v${readBundledVersion()})`;
    out(`Self-update: ${summary}`);
    return { changed: false, summary };
  }
  // ticket 23753dc7: 복귀 핀이 있으면 채널을 그 정확한 버전으로 고정한다.
  // 아래 provenance 조회와 already-latest 스킵이 이 채널을 그대로 쓰므로,
  // 되돌린 뒤에는 같은 불량 버전이 다시 해석될 수 없다(루프 부재).
  const pin = readUpdatePin(opts.stateDir);
  const channel = resolveEffectiveUpdateChannel(rawChannel, pin);
  if (pin) {
    out(
      `Self-update: channel pinned to v${pin.version} by rollback (${pin.reason || 'no reason recorded'}) — ` +
        `delete ${updatePinPath(opts.stateDir)} to release`,
    );
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
import { unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [, selfPath, managerPidStr, npmSpec, expectVersion, previousSpec, pinPath, nodePath, managerScript, ...restartArgs] = process.argv;
const managerPid = Number.parseInt(managerPidStr, 10);
const isWin = process.platform === 'win32';

function managerAlive() {
  if (!Number.isFinite(managerPid) || managerPid <= 0) return false;
  try { process.kill(managerPid, 0); return true; } catch { return false; }
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function npmInstall(spec) {
  const r = spawnSync('npm', ['install', '-g', '--ignore-scripts', spec], {
    stdio: 'ignore', shell: isWin, windowsHide: true,
  });
  return r.status === 0 && !r.error;
}
function globalRoot() {
  const r = spawnSync('npm', ['root', '-g'], { encoding: 'utf8', shell: isWin, windowsHide: true });
  return r.status === 0 ? String(r.stdout || '').trim() : '';
}
// previousSpec 은 부모가 provenance 를 이미 검증한 정확한 버전만 온다(검증 실패
// 시 빈 문자열). 헬퍼는 부모가 죽은 뒤에 돌아 레지스트리 판정을 스스로 할 수
// 없으므로, 이 계약을 깨고 임의 spec 을 넘기면 정책 E 게이트가 우회된다.
// 새로 설치된 진입점을 실제로 띄워 본다. --version 은 런타임을 시작하지 않지만
// 정적 import 그래프는 전부 로드하므로, 구문 오류/누락 모듈/최상위 import 예외로
// 죽는 빌드가 여기서 드러난다. 부모는 이미 종료했으므로 Windows 에서 이 판정을
// 내릴 수 있는 곳은 (교체 대상 패키지 밖에 있는) 이 헬퍼뿐이다.
function entrypointStarts(entry, want) {
  if (!entry) return false;
  const r = spawnSync(nodePath, [entry, '--version'], {
    encoding: 'utf8', windowsHide: true, timeout: 60000,
  });
  if (r.status !== 0 || r.error) return false;
  const reported = String(r.stdout || '').split('\\n').map(function (x) { return x.trim(); }).filter(Boolean).pop();
  return !want || reported === want;
}

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
  const ok = npmInstall(npmSpec);

  // 3. 설치가 됐다면 새 진입점이 실제로 뜨는지 확인하고, 못 뜨면 이전 버전으로
  // 되돌린 뒤 채널을 그 버전으로 핀한다. 되돌리기가 실패해도 아래 4단계가
  // 그대로 재기동하므로 운영자가 매니저 없는 상태로 남지는 않는다.
  let root = ok ? globalRoot() : '';
  let rolledBack = false;
  if (ok && previousSpec) {
    const entry = root ? join(root, 'awb-agent-manager', 'dist', 'main.js') : '';
    if (!entrypointStarts(entry, expectVersion)) {
      if (npmInstall(previousSpec)) {
        rolledBack = true;
        root = globalRoot();
      }
      if (pinPath) {
        const version = String(previousSpec).split('@').pop();
        try {
          writeFileSync(pinPath, JSON.stringify({
            version: version,
            reason: 'installed build ' + String(expectVersion) + ' failed to start (helper probe)',
            pinnedAtMs: Date.now(),
          }, null, 2) + '\\n', 'utf8');
        } catch { /* 핀을 못 써도 재기동은 계속한다 */ }
      }
    }
  }

  // 4. Relaunch the globally installed manager. A legacy service unit may still
  // point at a source checkout's main.js; resolve npm root -g and relaunch the
  // package we just installed rather than jumping back into that stale tree.
  // (No backticks in this string — it is embedded in a template literal.)
  let restartScript = managerScript;
  if (ok || rolledBack) {
    if (root) restartScript = join(root, 'awb-agent-manager', 'dist', 'main.js');
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

  // 5. Best-effort self-cleanup of this temp helper file.
  try { unlinkSync(selfPath); } catch { /* already gone */ }
  process.exit(ok && !rolledBack ? 0 : 1);
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
  const ports = resolvePorts(opts, out);
  out(`Self-update: npm-global mode (current v${current}) — target ${channelSpec}`);

  // 설치 전에 증명을 먼저 본다. dry-run 보다도 앞에 두는 이유: dry-run 의 목적이
  // "이 업데이트가 실제로 진행될지"를 보고하는 것이라, 거부될 업데이트를
  // "would run" 이라고 보고하면 거짓말이 된다.
  const verdict = await ports.verifyProvenance(channel);
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

  // ticket 23753dc7 (정책 G): 이 버전에 대한 설치 실패가 누적돼 있으면 상한과
  // 백오프를 먼저 본다. 카운터는 파일에 있으므로 재기동을 넘어 이어진다 —
  // 메모리에 두면 매번 0부터 다시 세어 상한이 무의미해진다.
  const targetVersion = verdict.version ?? '';
  const nowMs = Date.now();
  // 대상 버전을 특정하지 못하는 경우는 provenance 게이트를 명시적으로 우회한
  // (AWB_SELF_UPDATE_ALLOW_UNVERIFIED) 경로뿐이다. 버전 이름이 없으면 "지금 도는
  // 것이 새 빌드인가"를 다음 부팅에서 판정할 수 없으므로, 있지도 않은 기록을
  // 남기는 대신 부팅 검증 없이 진행한다는 사실을 로그로 밝힌다.
  const trackable = /^\d+\.\d+\.\d+/.test(targetVersion);
  const priorRecord = trackable ? readBootVerificationRecord(opts.stateDir) : null;
  const carried =
    priorRecord && priorRecord.targetVersion === targetVersion ? priorRecord : null;
  if (trackable) {
    const retry = evaluateInstallRetryGate({
      installFailures: carried?.installFailures ?? 0,
      lastFailureAtMs: carried?.lastInstallFailureAtMs ?? null,
      nowMs,
      // 리뷰 지적 2: `?? true` 로 두면 이 분기가 프로덕션에서 영원히 죽은
      // 코드가 된다. 환경변수를 실제로 읽어 판정한다 — 미설정이면 창 없음이라
      // 항상 true 라서 현행 동작은 그대로다.
      withinWindow: opts.withinWindow ?? withinMaintenanceWindowNow(),
    });
    if (retry.summary) out(`Self-update: ${retry.summary}`);
    if (!retry.proceed) {
      return { changed: false, summary: retry.summary!, deferred: retry.stop ? undefined : true };
    }
  } else {
    out(
      'Self-update: install target version is unknown (provenance gate bypassed) — ' +
        'proceeding without boot verification or rollback tracking',
    );
  }

  // 설치 **전에** 현재 버전을 기록한다. 이 한 줄이 복귀 대상을 결정한다 —
  // 설치가 끝난 뒤에는 "직전에 무엇이 돌고 있었는지"를 알 방법이 없다.
  const installRecord = trackable
    ? newInstallRecord({ previousVersion: current, targetVersion, nowMs, carryFrom: carried })
    : null;
  if (installRecord) {
    writeBootVerificationRecord(installRecord, opts.stateDir);
    out(
      `Self-update: recorded rollback target v${current} before installing v${targetVersion} ` +
        `(attempt ${installRecord.installFailures + 1} of ${MAX_INSTALL_ATTEMPTS})`,
    );
  }

  // POSIX can replace the package files while Node has the old modules mapped.
  // Install FIRST and restart only after npm succeeds. 이전의 범용 exit-first
  // 방식은 systemd의 Restart=on-failure와 경합했다: 분리된(detached) 헬퍼가
  // 아직 대기 중이거나 설치 중인데도 systemd가 5초 뒤 예전 패키지를 다시
  // 띄웠고, 그 시점엔 이미 명령이 성공을 보고한 뒤였다.
  if (process.platform !== 'win32') {
    const installed = await ports.install(installSpec);
    if (!installed.ok) {
      // ticket 23753dc7 (정책 G): POSIX 는 설치를 인-프로세스로 돌아 실패를
      // 직접 본다. 그 자리에서 카운터를 올려 영속화한다 — 다음 시도가 다른
      // 프로세스일 수 있으므로 메모리에 남기면 상한이 성립하지 않는다.
      if (installRecord) {
        const failed = withInstallFailure(installRecord, Date.now(), installed.detail);
        writeBootVerificationRecord(failed, opts.stateDir);
        out(`Self-update: ${failed.reason}`);
      }
      const summary = `npm-global update failed: ${installed.detail}`;
      out(`Self-update: ${summary}`);
      return { changed: false, summary };
    }
    // 리뷰 지적 1 — **재기동을 넘기기 전에** 새 진입점을 한 번 띄워 본다.
    // 구문 오류·누락 모듈·최상위 import 예외로 죽는 빌드는 매니저 런타임 안의
    // 어떤 검증에도 도달하지 못하므로, 아직 이전 빌드를 메모리에 들고 살아
    // 있는 지금이 그런 실패를 관측할 수 있는 유일한 지점이다.
    if (installRecord) {
      const probe = await ports.probe({ expectVersion: targetVersion });
      if (!probe.ok) {
        out(
          `Self-update: new build v${targetVersion} failed to start — ${probe.detail}; ` +
            `not restarting into it`,
        );
        // 재기동하지 않는다. 되돌리고 나면 이 프로세스가 그대로 이전 버전이라
        // 재기동할 이유가 없고, 하지 않는 편이 훨씬 안전하다.
        const rolled = await runRollbackInstall(opts, out, installRecord, null, {
          restartAfter: false,
        });
        const summary =
          `npm-global update rolled back: v${targetVersion} failed to start (${probe.detail})`;
        out(`Self-update: ${summary}`);
        return { changed: rolled.kind === 'rollback', summary };
      }
      out(`Self-update: new build v${targetVersion} starts cleanly — ${probe.detail}`);
      // 프로브를 통과했다. 남은 판정은 "재기동 뒤 하트비트 1회 성공"이다.
      writeBootVerificationRecord(withAwaitingBoot(installRecord, Date.now()), opts.stateDir);
    }
    const summary = `npm-global update installed ${installSpec}; restarting manager`;
    out(`Self-update: ${summary}`);
    if (installRecord) {
      out(
        `Self-update: boot verification armed for v${targetVersion} ` +
          `(rollback target v${current} if no heartbeat succeeds)`,
      );
    }
    _lastReExecScheduled = true;
    _pendingRestartReason = 'self_update_restart';
    setTimeout(() => ports.restart(), 1500).unref?.();
    return { changed: true, summary, willReExec: true };
  }

  // Windows cannot replace files in the running package tree. Keep the
  // exit-first helper there, where no systemd restart race exists.
  let helperPath: string;
  try {
    helperPath = writeNpmGlobalUpdater(out);
  } catch (err: any) {
    const summary = `npm-global update failed: could not stage updater helper: ${err?.message ?? err}`;
    // 헬퍼를 못 띄웠으면 설치는 시작조차 못 했다 — 여기서 세고 phase 를
    // install_failed 로 옮겨야 다음 부팅이 같은 실패를 두 번 세지 않는다.
    if (installRecord) {
      writeBootVerificationRecord(
        withInstallFailure(installRecord, Date.now(), `could not stage updater helper: ${err?.message ?? err}`),
        opts.stateDir,
      );
    }
    out(`Self-update: ${summary}`);
    return { changed: false, summary };
  }

  const nodePath = process.execPath;
  const scriptPath = process.argv[1] || '';
  // Strip any pre-existing --force / -f so the helper's appended --force doesn't
  // accumulate across updates (mirrors reExecManager's argv hygiene).
  const baseArgs = (process.argv.slice(2) || []).filter((a) => a !== '--force' && a !== '-f');
  // 헬퍼는 부모가 종료한 뒤에 설치하므로, 프로브·복귀에 필요한 것을 전부 argv 로
  // 넘겨야 한다(리뷰 지적 1). 대상 버전을 특정할 수 없으면(provenance 우회 경로)
  // 빈 문자열을 넘겨 헬퍼가 프로브를 건너뛰고 기존 동작 그대로 돌게 한다.
  // 복귀 대상의 provenance 를 **헬퍼를 띄우기 전에** 검증한다. 검증에 실패하면
  // 빈 spec 이 넘어가고 헬퍼는 복귀를 시도하지 않는다(정책 E fail-closed).
  const rollbackSpec = trackable
    ? await resolveVerifiedRollbackSpec({
        previousVersion: current,
        verifyProvenance: ports.verifyProvenance,
        out,
      })
    : '';
  const helperArgs = [
    helperPath,
    String(process.pid),
    installSpec,
    trackable && rollbackSpec ? targetVersion : '',
    rollbackSpec,
    trackable && rollbackSpec ? updatePinPath(opts.stateDir) : '',
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
    // 위 staging 실패와 같은 이유로 여기서 센다 — 설치는 시작되지 않았다.
    if (installRecord) {
      writeBootVerificationRecord(
        withInstallFailure(installRecord, Date.now(), `could not spawn updater helper: ${err?.message ?? err}`),
        opts.stateDir,
      );
    }
    out(`Self-update: ${summary}`);
    return { changed: false, summary };
  }

  const summary = `npm-global update scheduled: detached helper runs \`npm install -g --ignore-scripts ${installSpec}\` after exit, then restarts`;
  out(`Self-update: ${summary}`);
  // 기록은 'installing' 인 채로 둔다. 부모는 여기서 종료하므로 설치 결과를 볼
  // 수 없고, 판정은 다음 부팅이 "무슨 버전이 실제로 돌고 있는가"로 내린다:
  // 새 버전이면 부팅 검증, 이전 버전이면 설치 실패 1회로 센다.
  out(
    `Self-update: rollback target v${current} recorded; next boot decides install outcome for v${targetVersion}`,
  );

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
 * `npm install -g --ignore-scripts <spec>` 한 번. 정상 업데이트 경로와 복귀
 * 경로가 **같은 설치 명령**을 쓰도록 여기 한 곳에 둔다 — 복귀에만 다른 플래그가
 * 붙으면 "되돌린 버전에도 같은 게이트를 적용한다"는 정책 E 가 조용히 깨진다.
 *
 * `--ignore-scripts` — provenance 게이트는 **우리 tarball 의 출처**만 보증한다.
 * 그 아래 95개 전이 의존성은 `^` 범위로 그 시점 레지스트리에서 해석되므로,
 * 그중 하나가 postinstall 을 달고 들어오면 CVE 없이도 이 호스트에서 매니저
 * 권한으로 임의 코드가 돈다. 발행 트리의 install-script 패키지는 실측 0개이고
 * (scripts/audit-published-deps.mjs 가 매 cron 마다 그 0 을 재확인한다), bin
 * 링크는 lifecycle script 가 아니라 npm 코어 동작이라 이 플래그에 영향받지
 * 않는다 — 실측: `--ignore-scripts` 로 설치해도 bin 심링크·실행 모두 정상.
 */
async function npmGlobalInstall(
  out: (msg: string) => void,
  installSpec: string,
): Promise<{ ok: boolean; detail: string }> {
  out(`Self-update: npm install -g --ignore-scripts ${installSpec}`);
  const installed = await runAsync(
    'npm',
    ['install', '-g', '--ignore-scripts', installSpec],
    tmpdir(),
    BUILD_TIMEOUT_MS,
    (line) => out(`  [npm-global] ${line}`),
  );
  if (installed.ok) return { ok: true, detail: '' };
  const detail =
    (installed.stderr.trim() || installed.stdout.trim())
      .split('\n')
      .filter(Boolean)
      .pop() || `exit=${installed.exitCode}`;
  return { ok: false, detail: detail.slice(0, 240) };
}

/** 새로 설치된 전역 패키지의 진입점 경로. npm 이 안 잡히면 null. */
function resolveInstalledEntrypoint(): string | null {
  const root = detectNpmGlobalRoot();
  return root ? join(root, MANAGER_PACKAGE_NAME, 'dist', 'main.js') : null;
}

/**
 * 방금 설치한 진입점을 **실제로 실행해** 뜨는지 확인한다 (ticket 23753dc7 리뷰 1).
 *
 * 왜 필요한가: 부팅 검증을 매니저 런타임 안에 두면, 정작 대표적인 "설치 성공 후
 * 부팅 실패" — 깨진 구문, 누락 모듈, 최상위 import 예외 — 는 검증 코드까지
 * 도달하지도 못한다. 그런 빌드는 systemd 가 무한 재시작할 뿐 되돌릴 주체가 없다.
 * 그래서 **재기동을 넘기기 전에**, 아직 이전 빌드를 메모리에 들고 살아 있는
 * 지금 프로세스가 새 진입점을 자식으로 한 번 띄워 본다.
 *
 * 프로브는 `--version` 이다. 이 플래그는 main() 의 아주 앞쪽에서 처리되지만 그
 * 시점엔 **모듈 그래프 전체가 이미 로드된 뒤**라(정적 import), 위 실패 클래스가
 * 전부 여기서 드러난다. 런타임은 시작하지 않으므로 부작용도 없다. 오래전부터
 * 있던 플래그라 되돌릴 이전 버전에서도 동작한다 — 새 빌드에 새 플래그를
 * 요구했다면 그 자체가 또 하나의 실패 지점이 됐을 것이다.
 *
 * 출력 버전까지 대조한다: npm 이 성공을 보고했는데 정작 파일이 안 바뀐 경우를
 * (다른 prefix 로 설치되는 등) 여기서 잡는다.
 */
export async function probeInstalledEntrypoint(input: {
  expectVersion: string;
  entrypoint?: string | null;
  timeoutMs?: number;
}): Promise<EntrypointProbeResult> {
  const entrypoint = input.entrypoint ?? resolveInstalledEntrypoint();
  if (!entrypoint) {
    return { ok: false, reportedVersion: null, detail: 'could not resolve `npm root -g`' };
  }
  if (!existsSync(entrypoint)) {
    return { ok: false, reportedVersion: null, detail: `entrypoint missing: ${entrypoint}` };
  }
  const r = await runAsync(
    process.execPath,
    [entrypoint, '--version'],
    tmpdir(),
    input.timeoutMs ?? ENTRYPOINT_PROBE_TIMEOUT_MS,
  );
  if (!r.ok) {
    // npm 설치 로그와 달리 node 크래시는 **첫 줄 쪽**에 원인이 있고 뒤는 스택과
    // 러너 배너다. 운영자 로그에 "Node.js v22.x" 만 남으면 아무 쓸모가 없으므로
    // 에러로 보이는 첫 줄을 고르고, 없을 때만 마지막 줄로 떨어진다.
    const lines = (r.stderr.trim() || r.stdout.trim()).split('\n').map((l) => l.trim()).filter(Boolean);
    const detail =
      lines.find((l) => /(Error|error|Cannot find|SyntaxError|ERR_)/.test(l)) ||
      lines[lines.length - 1] ||
      `exit=${r.exitCode}${r.signal ? ` signal=${r.signal}` : ''}`;
    return { ok: false, reportedVersion: null, detail: detail.slice(0, 240) };
  }
  const reportedVersion = r.stdout.split('\n').map((x) => x.trim()).filter(Boolean).pop() || '';
  if (reportedVersion !== input.expectVersion) {
    return {
      ok: false,
      reportedVersion: reportedVersion || null,
      detail: `entrypoint reports v${reportedVersion || '?'} but v${input.expectVersion} was installed`,
    };
  }
  return { ok: true, reportedVersion, detail: `entrypoint started and reports v${reportedVersion}` };
}

/** 주입된 포트를 실제 구현으로 채운다. 프로덕션 호출부는 ports 를 넘기지 않는다. */
function resolvePorts(opts: SelfUpdateOpts, out: (msg: string) => void): Required<SelfUpdatePorts> {
  const p = opts.ports ?? {};
  return {
    install: p.install ?? ((spec) => npmGlobalInstall(out, spec)),
    verifyProvenance: p.verifyProvenance ?? ((channel) => verifyNpmGlobalProvenance(out, channel)),
    restart: p.restart ?? (() => reExecManager(out)),
    probe: p.probe ?? ((input) => probeInstalledEntrypoint(input)),
  };
}

/**
 * Windows 헬퍼에 넘길 **검증된** 복귀 spec (리뷰 라운드 2 지적).
 *
 * 헬퍼는 부모가 종료한 뒤에 돌기 때문에 스스로 provenance 를 확인할 수 없다 —
 * 확인하려면 SLSA 판정기를 의존성 없는 템플릿 문자열 안에 통째로 복제해야 하고,
 * 그러면 게이트가 두 곳에 생겨 한쪽만 틀어질 수 있다. 그래서 판정은 **부모가
 * 헬퍼를 띄우기 전에** 하고, 검증에 통과한 정확한 버전만 넘긴다.
 *
 * 검증에 실패하면 빈 문자열을 돌려 헬퍼가 복귀를 아예 시도하지 않게 한다 —
 * 정책 E 는 "되돌린 버전이라는 이유로 예외를 두지 않는다"이므로, 증명 없는
 * 이전 버전을 설치하는 것보다 복귀를 포기하는 쪽이 정책에 맞는 실패 방향이다.
 * (그 경우에도 헬퍼의 무조건 재기동은 그대로라 매니저가 사라지지는 않는다.)
 */
export async function resolveVerifiedRollbackSpec(input: {
  previousVersion: string;
  verifyProvenance: (channel: string) => Promise<ProvenanceVerdict>;
  out: (msg: string) => void;
  bypassed?: boolean;
}): Promise<string> {
  const { previousVersion, out } = input;
  if (!/^\d+\.\d+\.\d+/.test(previousVersion)) return '';
  const verdict = await input.verifyProvenance(previousVersion);
  if (verdict.ok) {
    return `${MANAGER_PACKAGE_NAME}@${verdict.version ?? previousVersion}`;
  }
  const bypassed = input.bypassed ?? provenanceGateBypassed();
  if (bypassed) {
    out(
      `Self-update: ${PROVENANCE_BYPASS_ENV} set — allowing unverified rollback target ` +
        `v${previousVersion} (${verdict.reason})`,
    );
    return `${MANAGER_PACKAGE_NAME}@${previousVersion}`;
  }
  out(
    `Self-update: rollback to v${previousVersion} is NOT available for this update — ` +
      `${verdict.reason}. Installing anyway; a bad build will need manual recovery.`,
  );
  return '';
}

export interface BootVerificationOutcome {
  kind: BootDecisionKind;
  /** 하트비트 1회 성공을 기다리는 상태로 들어갔는가 — main.ts 가 이때만
   *  검증 타이머를 건다. */
  armed: boolean;
  /** 복귀 설치를 걸고 재기동을 예약했는가. */
  willReExec: boolean;
  summary: string | null;
}

/**
 * 부팅 직후 판정 (ticket 23753dc7 — 정책 C·G).
 *
 * 이전 프로세스가 남긴 상태 파일과 "지금 실제로 돌고 있는 버전"만으로,
 * 방금 설치한 빌드가 정상 부팅했는지 판정하고 필요하면 복귀를 실행한다.
 * 매니저 부팅 경로에서 **일찍** 불려야 한다 — 나쁜 빌드가 죽기 전에 이 판정이
 * 돌아야 되돌릴 수 있기 때문이다.
 *
 * 안전 실패 방향: 어떤 예외도 부팅을 막지 않는다. 되돌리려던 장치가 매니저를
 * 못 뜨게 만드는 것이 이 티켓이 막으려는 상황보다 나쁘다.
 */
export async function runBootVerification(
  opts: SelfUpdateOpts = {},
): Promise<BootVerificationOutcome> {
  const out = opts.log ?? log;
  const none: BootVerificationOutcome = {
    kind: 'none',
    armed: false,
    willReExec: false,
    summary: null,
  };
  try {
    const current = readBundledVersion();
    const record = readBootVerificationRecord(opts.stateDir);
    const decision = evaluateBootVerification({ record, currentVersion: current });
    if (decision.summary) out(`Self-update: ${decision.summary}`);
    const done = (kind: BootDecisionKind): BootVerificationOutcome => ({
      kind,
      armed: false,
      willReExec: false,
      summary: decision.summary,
    });

    switch (decision.kind) {
      case 'none':
        return { ...none, summary: decision.summary };

      case 'stale':
        clearBootVerificationRecord(opts.stateDir);
        return done('stale');

      case 'arm':
        // 이 부팅을 세어 둔다. 새 빌드가 하트비트 1회 성공 전에 죽으면 다음
        // 부팅이 bootAttempts>=1 을 보고 복귀로 간다 — 부팅 실패에 재시도가
        // 없다는 정책 G 가 이 카운터 하나로 성립한다.
        writeBootVerificationRecord(withBootAttempt(record!, Date.now()), opts.stateDir);
        return { kind: 'arm', armed: true, willReExec: false, summary: decision.summary };

      case 'install_failed': {
        const failed = withInstallFailure(
          record!,
          Date.now(),
          `install of v${record!.targetVersion} did not take effect (previous build came back)`,
        );
        writeBootVerificationRecord(failed, opts.stateDir);
        out(`Self-update: ${failed.reason}`);
        return done('install_failed');
      }

      case 'pin_only':
      case 'rollback_landed':
      case 'rollback_failed':
        pinRolledBackVersion(
          out,
          opts,
          decision.rollbackToVersion!,
          record!.targetVersion,
          decision.kind === 'rollback_failed'
            ? `rollback install failed ${record!.rollbackAttempts} time(s)`
            : `boot verification failed for v${record!.targetVersion}`,
        );
        clearBootVerificationRecord(opts.stateDir);
        return done(decision.kind);

      case 'rollback':
        return await runRollbackInstall(opts, out, record!, decision.summary);

      default:
        return { ...none, summary: decision.summary };
    }
  } catch (err: any) {
    out(`Self-update: boot verification failed to run: ${err?.stack || err?.message || err}`);
    return none;
  }
}

/**
 * 채널을 되돌린 버전으로 핀한다. 핀은 **복귀 설치보다 먼저** 걸어야 한다 —
 * 설치가 실패해도 다음 tick 이 같은 불량 버전을 다시 집으면 안 되기 때문이다
 * (완료 기준 2: 루프 부재).
 */
function pinRolledBackVersion(
  out: (msg: string) => void,
  opts: SelfUpdateOpts,
  version: string,
  badVersion: string,
  reason: string,
): void {
  writeUpdatePin(
    { version, reason: `${reason} (bad build v${badVersion})`, pinnedAtMs: Date.now() },
    opts.stateDir,
  );
  out(
    `Self-update: update channel pinned to v${version} — v${badVersion} will not be reinstalled ` +
      `automatically. Release by deleting ${updatePinPath(opts.stateDir)} (operator only).`,
  );
}

/**
 * 복귀 설치 — 기록해 둔 이전 버전을 다시 설치하고 재기동한다.
 *
 * 정책 E: 되돌린 버전에도 provenance 게이트를 **그대로** 적용한다. 이전 버전은
 * 한 번 설치됐던 것이니 안전하다는 추론은 성립하지 않는다 — 그 사이 레지스트리의
 * 해당 버전이 교체됐을 수 있고, 예외를 한 번 열면 그 경로가 곧 우회로가 된다.
 */
async function runRollbackInstall(
  opts: SelfUpdateOpts,
  out: (msg: string) => void,
  record: BootVerificationRecord,
  summary: string | null,
  /** `restartAfter:false` 는 "이 프로세스가 이미 되돌릴 대상 버전을 돌고 있다"는
   *  뜻이다(재기동 전 프로브가 새 빌드를 거른 경우). 그때 재기동은 얻는 것 없이
   *  위험만 더한다 — 디스크는 방금 이전 버전으로 되돌렸고 메모리도 이미 그것이다. */
  behavior: { restartAfter?: boolean } = {},
): Promise<BootVerificationOutcome> {
  const restartAfter = behavior.restartAfter !== false;
  const ports = resolvePorts(opts, out);
  const target = record.previousVersion;

  // 1. 핀부터. 복귀 설치가 실패하더라도 불량 버전으로 되돌아가지 않는다.
  pinRolledBackVersion(
    out,
    opts,
    target,
    record.targetVersion,
    `boot verification failed for v${record.targetVersion}`,
  );

  // 2. 시도 카운터를 올려 영속화한다(무한 복귀 방지).
  writeBootVerificationRecord(
    withRollbackAttempt(
      record,
      Date.now(),
      `rolling back to v${target} after boot verification failure`,
    ),
    opts.stateDir,
  );

  const stop = (msg: string): BootVerificationOutcome => {
    out(`Self-update: ${msg}`);
    return { kind: 'rollback', armed: false, willReExec: false, summary: msg };
  };

  if (opts.noReExec) {
    return stop(`rollback to v${target}: install + restart skipped (noReExec)`);
  }
  if (classifyInstallMode(detectNpmGlobalRoot()) !== 'npm-global') {
    return stop(
      `rollback to v${target} not possible: npm is not reachable — ` +
        `channel stays pinned, upgrade/downgrade manually`,
    );
  }

  // 3. provenance 게이트 — 정책 E, 이전 버전이라는 이유의 예외는 없다.
  const verdict = await ports.verifyProvenance(target);
  if (!verdict.ok && !provenanceGateBypassed()) {
    return stop(`rollback to v${target} refused: ${verdict.reason}`);
  }
  const installSpec = `${MANAGER_PACKAGE_NAME}@${verdict.ok && verdict.version ? verdict.version : target}`;

  // 4. 설치 + 재기동. 플랫폼 분기는 정상 경로와 같은 이유로 갈린다:
  //    POSIX 는 인-프로세스 설치 후 재기동, Windows 는 종료 후 헬퍼가 설치한다.
  if (process.platform !== 'win32') {
    const installed = await ports.install(installSpec);
    if (!installed.ok) {
      // 매니저는 계속 돌고 있다(완료 기준 7). 핀도 그대로라 자동 경로가 불량
      // 버전으로 되돌아가지 않는다.
      if (!restartAfter) {
        // 프로브가 새 빌드를 걸러 여기까지 왔다면 디스크에는 아직 그 불량
        // 빌드가 있고 메모리에만 멀쩡한 이전 빌드가 있다. 다음 재시작이
        // 진입점부터 죽는다는 뜻이라, 운영자가 손으로 되돌려야 한다.
        out(
          `Self-update: MANUAL ACTION REQUIRED — the installed build v${record.targetVersion} ` +
            `cannot start and rolling back to v${target} failed. This process still runs v${target} ` +
            `from memory, but the next restart will load the broken build. ` +
            `Run: npm install -g ${installSpec}`,
        );
      }
      return stop(`rollback install of ${installSpec} failed: ${installed.detail}`);
    }
    if (!restartAfter) {
      // 디스크와 메모리가 다시 같은 버전이다. 재기동할 이유가 없다.
      const msg = `rolled back to ${installSpec} in place — no restart needed (already running v${target})`;
      out(`Self-update: ${msg}`);
      return { kind: 'rollback', armed: false, willReExec: false, summary: summary ?? msg };
    }
    out(`Self-update: rolled back to ${installSpec}; restarting manager`);
    scheduleRollbackRestart(out, () => ports.restart(), !opts.ports?.restart);
    return {
      kind: 'rollback',
      armed: false,
      willReExec: true,
      summary: summary ?? `rolled back to ${installSpec}`,
    };
  }

  let helperPath: string;
  try {
    helperPath = writeNpmGlobalUpdater(out);
  } catch (err: any) {
    return stop(`rollback to v${target} failed: could not stage updater helper: ${err?.message ?? err}`);
  }
  const baseArgs = (process.argv.slice(2) || []).filter((a) => a !== '--force' && a !== '-f');
  try {
    const child = spawn(
      process.execPath,
      // 이미 복귀 중이므로 헬퍼의 프로브·재복귀는 끄고(빈 문자열) 핀도 위에서
      // 이미 썼다 — 여기서 또 되돌릴 대상은 없다.
      [
        helperPath,
        String(process.pid),
        installSpec,
        '',
        '',
        '',
        process.execPath,
        process.argv[1] || '',
        ...baseArgs,
      ],
      { detached: true, stdio: 'ignore', cwd: tmpdir(), env: process.env, shell: false, windowsHide: true },
    );
    child.unref();
  } catch (err: any) {
    return stop(`rollback to v${target} failed: could not spawn updater helper: ${err?.message ?? err}`);
  }
  out(`Self-update: rollback to ${installSpec} scheduled — detached helper installs it after exit`);
  scheduleRollbackRestart(
    out,
    () => {
      try {
        shutdownForNpmGlobalUpdate(out);
      } catch (err: any) {
        out(`Self-update: shutdown for rollback failed: ${err?.stack || err?.message || err}`);
      }
    },
    // POSIX 분기와 같은 규칙 — 재기동 포트가 주입됐으면 프로세스 수명은 호출부 몫.
    !opts.ports?.restart,
  );
  return {
    kind: 'rollback',
    armed: false,
    willReExec: true,
    summary: summary ?? `rollback to ${installSpec} scheduled`,
  };
}

/**
 * 복귀 뒤 재기동 예약.
 *
 * 정상 업데이트 경로와 달리 타이머를 **unref 하지 않는다.** 복귀는 부팅 직후에
 * 실행될 수 있는데, 그 시점에는 이벤트 루프를 붙잡는 핸들(SSE·세션·하트비트)이
 * 아직 하나도 없다. unref 타이머로 예약하면 재기동이 발화하기도 전에 프로세스가
 * 그냥 끝나고, systemd 는 `Restart=on-failure` 라 정상 종료(exit 0)를 재시작
 * 대상으로 보지 않는다 — 되돌리기는 성공했는데 운영자는 매니저 없는 상태로
 * 남는다(완료 기준 7 위반). reExecManager 안의 SIGTERM 예약도 같은 이유로 unref
 * 이므로 ref 된 최후 보루를 함께 건다.
 */
function scheduleRollbackRestart(
  out: (msg: string) => void,
  restart: () => void,
  /** 재기동 포트가 주입된 호출(테스트)에서는 프로세스 수명을 호출부가 소유하므로
   *  백스톱을 걸지 않는다. 프로덕션 경로는 항상 건다. */
  armBackstop = true,
): void {
  _lastReExecScheduled = true;
  _pendingRestartReason = 'self_update_restart';
  setTimeout(restart, 1500);
  if (!armBackstop) return;
  setTimeout(() => {
    out('Self-update: rollback restart backstop — exiting non-zero so the supervisor respawns');
    process.exit(1);
  }, ROLLBACK_RESTART_BACKSTOP_MS);
}

/**
 * 테스트 전용 탈출구: 실제 npm 설치 없이 복귀 재기동 예약만 구동한다.
 * 검증 대상은 "예약이 이벤트 루프를 붙잡는가" 하나다 — unref 타이머로 돌아가면
 * 부팅 직후 호출에서 콜백이 발화하기 전에 프로세스가 조용히 끝난다.
 */
export function _scheduleRollbackRestartForTests(restart: () => void): void {
  scheduleRollbackRestart(() => {}, restart);
}

/**
 * 하트비트가 1회 성공했다 — 부팅 검증 성공. 상태 기록을 지운다.
 *
 * **핀은 건드리지 않는다.** 성공한 부팅과 이미 걸린 핀은 별개 사실이고, 핀
 * 해제는 사람만 한다(정책 G). 여러 번 불려도 안전하다.
 */
export function markBootVerified(opts: SelfUpdateOpts = {}): boolean {
  const record = readBootVerificationRecord(opts.stateDir);
  if (!record) return false;
  if (record.phase !== 'awaiting_boot' && record.phase !== 'installing') return false;
  const out = opts.log ?? log;
  clearBootVerificationRecord(opts.stateDir);
  out(`Self-update: boot verification passed for v${record.targetVersion} (heartbeat succeeded)`);
  return true;
}

/**
 * 무장된 부팅 검증의 상한 판정 — main.ts 가 건 타이머가 이 함수를 부른다.
 * 하트비트 1회 성공 없이 상한을 넘기면 복귀를 실행한다(evaluateBootProbe 가
 * 순수 판정이고 여기서는 그 결과만 집행한다).
 */
export async function runBootVerificationTimeout(
  opts: SelfUpdateOpts & {
    elapsedMs?: number;
    timeoutMs?: number;
    /** 이 프로세스가 애초에 하트비트를 보낼 수 있는 상태인가. 페어링 전
     *  (agent.json 에 agent_id 없음)이면 InstanceHeartbeat 는 POST 자체를 하지
     *  않으므로, 하트비트 부재를 부팅 실패의 증거로 쓸 수 없다. 생략하면 true. */
    heartbeatEnabled?: boolean;
  } = {},
): Promise<BootVerificationOutcome> {
  const timeoutMs = opts.timeoutMs ?? BOOT_VERIFY_TIMEOUT_MS;
  const elapsedMs = opts.elapsedMs ?? timeoutMs;
  const record = readBootVerificationRecord(opts.stateDir);
  if (opts.heartbeatEnabled === false) {
    // 판정 기준(하트비트 1회 성공)을 적용할 수 없는 호스트다. 멀쩡한 빌드를
    // 되돌리지 않되, 기록도 남기지 않는다 — 남겨두면 나중에 무관한 재시작이
    // 이 기록을 부팅 실패로 읽어 그제서야 복귀가 튀어나온다.
    if (record) {
      (opts.log ?? log)(
        `Self-update: cannot verify boot of v${record.targetVersion} — this manager is not paired, ` +
          `so no heartbeat is ever sent; discarding the record without rolling back`,
      );
      clearBootVerificationRecord(opts.stateDir);
    }
    return { kind: 'none', armed: false, willReExec: false, summary: null };
  }
  const heartbeatOk = !record || (record.phase !== 'awaiting_boot' && record.phase !== 'installing');
  const probe = evaluateBootProbe({ heartbeatOk, elapsedMs, timeoutMs });
  if (probe !== 'failed') {
    return { kind: 'none', armed: probe === 'waiting', willReExec: false, summary: null };
  }
  const out = opts.log ?? log;
  const summary =
    `boot verification timed out for v${record!.targetVersion} after ` +
    `${Math.round(elapsedMs / 60_000)}min with no successful heartbeat — ` +
    `rolling back to v${record!.previousVersion} and pinning it`;
  out(`Self-update: ${summary}`);
  return await runRollbackInstall(opts, out, record!, summary);
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
 * 1. **systemd**(Linux + `.service` 유닛): 부모 프로세스가 exit 1로 종료되면
 *    유닛의 `Restart=on-failure`가 새 프로세스를 띄운다(0이 아닌 exit가 바로
 *    그 트리거 조건이다). 여기서 분리된(detached) 자식 프로세스를 직접
 *    spawn하면 안 된다 — systemd의 기본 `KillMode=control-group`이 부모가
 *    죽을 때 새로 띄운 자식까지 같은 cgroup teardown에 휩쓸어 가버려,
 *    방금 띄운 그 프로세스를 그대로 죽여버리기 때문이다.
 *    Symptom: `update_manager` SSE command lands, build succeeds, parent
 *    exits, child appears for a moment in `ps`, then the entire unit goes
 *    inactive(dead) and the operator's Update button vanishes with no
 *    replacement process.
 *
 * 2. **everything else** (Windows, raw bash, macOS launchd, npm-global
 *    install): spawn a detached child with --force and SIGTERM-self. No
 *    cgroup means the child outlives the parent's exit; the --force lets the
 *    child take over the agent lockfile without a 60s wait.
 */
function reExecManager(out: (msg: string) => void): void {
  if (isManagedBySystemd()) {
    out('Self-update: re-exec via systemd (Restart=on-failure → exit 1)');
    // We trigger the SIGTERM shutdown handler so chat / ticket sessions get
    // cleaned up, but we MUST set _systemdReExecPending first so the handler's
    // final `process.exit(...)` picks exit code 1 instead of 0.
    // Restart=on-failure에서는 정상 exit(0)이면 재기동되지 않는다 — 실제로
    // systemd가 재시작하게 만드는 것은 exit 1이며, 이는 동시에 유닛이 왜
    // 재시작됐는지(크래시나 운영자의 정지가 아니라 재기동을 위한 것이라는
    // 점)를 journald 기록에도 정직하게 남긴다.
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
