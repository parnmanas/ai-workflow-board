#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
  AGENT_MANAGER_HOME,
  CONFIG_PATH,
  MANAGED_AGENTS_DIR,
  OUTBOX_PATH,
  SESSION_DEFER_PATH,
} from './lib/constants.js';
import { loadConfig, resolveAgentId } from './lib/config.js';
import { installCrashHandlers, log } from './lib/logging.js';
import { acquireAgentLock, type LockHandle } from './lib/agent-lockfile.js';
import {
  isSystemdReExecPending,
  markBootVerified,
  pendingRestartReason,
  restartManager,
  runBootVerification,
  runBootVerificationTimeout,
  runSelfUpdate,
  UpdateChecker,
} from './lib/self-update.js';
import { BOOT_VERIFY_TIMEOUT_MS } from './lib/self-update-rollback.js';
import { runSetup, type SetupOptions } from './lib/setup.js';
import { installService, uninstallService, type ServicePlatform } from './lib/service-install.js';
import { PresenceHeartbeat } from './lib/presence-heartbeat.js';
import { InstanceHeartbeat } from './lib/instance-heartbeat.js';
import type { WorktreeStatusEntry, RunWorkspaceStatusEntry } from './lib/instance-heartbeat.js';
import { spawnFailureTracker } from './lib/spawn-failure-tracker.js';
import { EventStream } from './lib/event-stream.js';
import { SubagentManager } from './lib/subagent-manager.js';
import { ChatSessionManager } from './lib/chat-session-manager.js';
import { TicketSessionManager } from './lib/ticket-session-manager.js';
import { CircuitBreaker } from './lib/circuit-breaker.js';
import { InflightDispatchTracker, DispatchBlockTracker } from './lib/dispatch-preflight.js';
import { SessionLimitDeferStore } from './lib/session-limit-defer.js';
import { uploadIfNewErrors } from './lib/error-log-uploader.js';
import { onFlushThreshold } from './lib/event-log-recorder.js';
import {
  cleanupOrphanHermesProcesses,
  cleanupOrphanSubagents,
} from './lib/orphan-cleanup.js';
import { FsBrowser } from './lib/fs-browser.js';
import { SubagentMonitor } from './lib/subagent-monitor.js';
import { KNOWN_ADAPTER_CLI_TYPES, createAdapter } from './lib/cli-adapters/index.js';
import {
  checkAuxiliaryCli,
  discoverRuntimeCapabilities,
  formatCliResolutionSummary,
} from './lib/runtime/runtime-health.js';
import { promptComposer } from './lib/prompts.js';
import { ManagedAgentRegistry } from './lib/managed-agents.js';
import { ManagedAgentContextRegistry } from './lib/managed-agent-context.js';
import { WorktreeManager, worktreeSlug } from './lib/worktree-manager.js';
import { AgentManagerCommandHandler } from './lib/agent-manager-commands.js';
import {
  listManagedAgentDirs,
  readManagedAgentConfig,
  readApiKeyForRehydrate,
  readAgentCredential,
  mcpConfigPathFor,
  subagentLogPathFor,
  cliHomeDirFor,
  ensureCliHomeDir,
} from './lib/managed-agent-store.js';
import type { SessionAwareConfig } from './lib/base-session-manager.js';
import type { SubagentAwareConfig } from './lib/subagent-manager.js';
import { MANAGER_CAPABILITIES, shutdownRuntimeProfiles, validateRuntimeProfile } from './lib/runtime-profiles.js';
import { MessageOutbox } from './lib/outbox.js';
import {
  setRestOutbox,
  postChatRoomMessageRaw,
  postSilentExitSystemCommentRaw,
  postDispatchAckRaw,
  postCommandAckRaw,
  postCliLoginProgressRaw,
} from './lib/rest.js';
import type { RuntimeProfileSpec } from './lib/cli-adapters/base.js';
import { RuntimeSupervisor } from './lib/runtime/runtime-supervisor.js';
import { postRuntimeChildEvent } from './lib/rest.js';
import { CliLoginManager } from './lib/cli-login.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

interface CliFlags {
  config?: string;
  workspace?: string;
  runtimeProfile?: string;
  dryRun: boolean;
  help: boolean;
  version: boolean;
  force: boolean;
}

function readPkgVersion(): string {
  try {
    const pkgPath = resolve(__dirname, '..', 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function parseFlags(argv: string[]): CliFlags {
  let values: Record<string, unknown>;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        config: { type: 'string', short: 'c' },
        workspace: { type: 'string', short: 'w' },
        'runtime-profile': { type: 'string' },
        'dry-run': { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
        version: { type: 'boolean', short: 'v' },
        force: { type: 'boolean', short: 'f' },
      },
      allowPositionals: false,
      strict: true,
    }));
  } catch (err: any) {
    process.stderr.write(`\n  ✗ ${err?.message ?? err}\n\n`);
    process.stderr.write(`  Run \`awb-agent-manager --help\` for usage.\n\n`);
    process.exit(2);
  }

  return {
    config: values.config as string | undefined,
    workspace: values.workspace as string | undefined,
    runtimeProfile: values['runtime-profile'] as string | undefined,
    dryRun: Boolean(values['dry-run']),
    help: Boolean(values.help),
    version: Boolean(values.version),
    force: Boolean(values.force),
  };
}

function printHelp(): void {
  process.stdout.write(`awb-agent-manager — AWB Runtime Host

Usage:
  awb-agent-manager                       start the manager (uses saved config)
  awb-agent-manager setup [opts]          first-run pairing wizard
  awb-agent-manager service install [..]  register as a background service (auto-detects host)
  awb-agent-manager service uninstall     remove the registered service
  awb-agent-manager mcp-host              run the host-tools MCP server over stdio
                                          (spawned by managed agents; not for direct use)
  awb-agent-manager [options]             start with overrides

Options:
  -c, --config <path>     Path to config.json (default: ${CONFIG_PATH})
  -w, --workspace <id>    Override workspace_id from config
      --runtime-profile <path|none>
                            Use a JSON profile for this manager run, without DB changes
  -f, --force             Take over the lockfile from a stale or running owner
      --dry-run           Load config and exit without starting runtime
  -h, --help              Show this help text
  -v, --version           Print version

Setup options (\`awb-agent-manager setup ...\`):
      --url <url>            AWB server base URL (skip prompt)
      --token <token>        Pairing token from AWB Workspace → AI Agents
      --instance-id <id>     Stable id reported on heartbeats (default <hostname>-<rand>)
      --non-interactive      Fail fast on missing fields instead of prompting
      --force                Overwrite an existing config.json

Service options (\`awb-agent-manager service install ...\`):
      --system               Install at system scope (sudo / admin, runs at boot)
                             Default: user scope (no admin, runs at logon)
      --platform <p>         Force a specific service backend instead of auto-detect:
                             auto (default) | systemd | sysvinit | synology | launchd | windows
      --exec-path <path>     Override path to dist/main.js (default: this binary's location)
      --dry-run              Print the unit/plist/script without writing or running registrar
      --unit-only            Write the unit file but skip daemon-reload / load / register

Platform mapping (auto):
  linux + systemd        → ~/.config/systemd/user/ (user) | /etc/systemd/system/ (--system)
  linux + Synology DSM   → /usr/local/etc/rc.d/awb-agent-manager.sh (always system)
  linux without systemd  → /etc/init.d/awb-agent-manager (always system, sysvinit)
  darwin (macOS)         → ~/Library/LaunchAgents/ (user) | /Library/LaunchDaemons/ (--system)
  win32                  → Task Scheduler task 'awb-agent-manager' (logon | --system boot)

Config search order:
  1. --config flag
  2. $AWB_AGENT_MANAGER_HOME/config.json
  3. $XDG_CONFIG_HOME/awb-agent-manager/config.json (or %APPDATA% on Windows)
  4. ~/.config/awb-agent-manager/config.json

Signals:
  SIGTERM/SIGINT  graceful drain + exit
  SIGHUP          re-read config.json (delegation tunables hot-reload)
  SIGUSR1         self-update: install the latest npm package and re-exec its
                  global binary. Git checkout update is fallback-only when npm
                  is unavailable.
  SIGUSR2         unconditional restart: re-exec the running binary in place
                  (no version check, no npm install/build). Use this to pick
                  up on-disk config changes that are only read at startup
                  (e.g. --runtime-profile), where self-update would no-op
                  because the package version hasn't changed.
`);
}

/**
 * Parse `setup` subcommand argv. Distinct from parseFlags so the runtime
 * flag set stays narrow (no setup-only flags polluting -h output).
 */
function parseSetupArgs(argv: string[]): SetupOptions {
  let values: Record<string, unknown>;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        config: { type: 'string', short: 'c' },
        url: { type: 'string' },
        token: { type: 'string' },
        'instance-id': { type: 'string' },
        'non-interactive': { type: 'boolean' },
        force: { type: 'boolean', short: 'f' },
      },
      allowPositionals: false,
      strict: true,
    }));
  } catch (err: any) {
    process.stderr.write(`\n  ✗ setup: ${err?.message ?? err}\n\n`);
    process.stderr.write(`  Run \`awb-agent-manager --help\` for setup options.\n\n`);
    process.exit(2);
  }
  return {
    configPath: (values.config as string | undefined) || undefined,
    url: (values.url as string | undefined) || undefined,
    token: (values.token as string | undefined) || undefined,
    instanceId: (values['instance-id'] as string | undefined) || undefined,
    nonInteractive: Boolean(values['non-interactive']) || !process.stdin.isTTY,
    force: Boolean(values.force),
  };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);

  // ── Subcommand dispatch ───────────────────────────────────────────
  // `awb-agent-manager mcp-host` runs the stdio MCP host-tools server and
  // exits when the parent CLI closes the pipe. Must be FIRST in the
  // dispatch chain because (a) it's the only path that intentionally
  // takes over stdio for JSON-RPC, and (b) it must avoid every heavyweight
  // boot step below (no logging to stdout, no lockfile, no SSE, no config
  // reads). Spawned per-subagent by claude/antigravity via the mcpServers.host
  // entry the manager writes into each managed agent's mcp-config.json.
  if (argv[0] === 'mcp-host') {
    try {
      const { runHostMcpServerOverStdio } = await import('./lib/host-mcp/server.js');
      await runHostMcpServerOverStdio();
      process.exit(0);
    } catch (err: any) {
      process.stderr.write(`\n  ✗ mcp-host failed: ${err?.stack ?? err?.message ?? err}\n\n`);
      process.exit(1);
    }
  }

  // `awb-agent-manager setup [opts]` runs the pairing wizard and exits;
  // never starts the runtime. Skipping help/version checks for setup
  // because runSetup has its own argv parsing (and no `setup --help` UX
  // ambiguity to resolve yet).
  if (argv[0] === 'setup') {
    try {
      await runSetup(parseSetupArgs(argv.slice(1)));
      process.exit(0);
    } catch (err: any) {
      process.stderr.write(`\n  ✗ setup failed: ${err?.message ?? err}\n\n`);
      process.exit(1);
    }
  }

  // ─ service install / uninstall ─────────────────────────────────────
  // `awb-agent-manager service install [--system] [--platform <p>] [--exec-path <p>] [--dry-run]`
  // Auto-detects the host's service manager (systemd/sysvinit/synology/
  // launchd/windows) and dispatches to the matching installer. User mode
  // by default (no sudo/admin). --system requires sudo (Linux/macOS) or
  // an elevated shell (Windows). See lib/service-install.ts.
  if (argv[0] === 'service') {
    const sub = argv[1] || '';
    if (sub !== 'install' && sub !== 'uninstall') {
      process.stderr.write(
        `\n  ✗ service: unknown subcommand '${sub}' (expected: install | uninstall)\n\n` +
          `  Usage: awb-agent-manager service <install|uninstall> [--system] [--platform <p>] [--exec-path <p>] [--dry-run] [--unit-only]\n\n`,
      );
      process.exit(2);
    }
    let serviceValues: Record<string, unknown>;
    try {
      ({ values: serviceValues } = parseArgs({
        args: argv.slice(2),
        options: {
          system: { type: 'boolean' },
          'dry-run': { type: 'boolean' },
          'unit-only': { type: 'boolean' },
          'exec-path': { type: 'string' },
          platform: { type: 'string' },
        },
        allowPositionals: false,
        strict: true,
      }));
    } catch (err: any) {
      process.stderr.write(`\n  ✗ service ${sub}: ${err?.message ?? err}\n\n`);
      process.exit(2);
    }
    const isSystem = Boolean(serviceValues.system);
    const dryRun = Boolean(serviceValues['dry-run']);
    const unitOnly = Boolean(serviceValues['unit-only']);
    const execPath = serviceValues['exec-path'] as string | undefined;
    const platformRaw = serviceValues.platform as string | undefined;
    const validPlatforms = ['auto', 'systemd', 'sysvinit', 'synology', 'launchd', 'windows'] as const;
    if (platformRaw && !(validPlatforms as readonly string[]).includes(platformRaw)) {
      process.stderr.write(
        `\n  ✗ service ${sub}: invalid --platform '${platformRaw}' ` +
          `(expected: ${validPlatforms.join(' | ')})\n\n`,
      );
      process.exit(2);
    }
    const platform = (platformRaw || 'auto') as 'auto' | ServicePlatform;
    try {
      if (sub === 'install') {
        await installService({ system: isSystem, execPath, dryRun, unitOnly, platform });
      } else {
        await uninstallService({ system: isSystem, platform });
      }
      process.exit(0);
    } catch (err: any) {
      process.stderr.write(`\n  ✗ service ${sub} failed: ${err?.message ?? err}\n\n`);
      process.exit(1);
    }
  }

  const flags = parseFlags(argv);

  if (flags.help) {
    printHelp();
    return;
  }
  if (flags.version) {
    process.stdout.write(`${readPkgVersion()}\n`);
    return;
  }

  installCrashHandlers();

  let runtimeProfileOverride: RuntimeProfileSpec | null | undefined;
  if (flags.runtimeProfile === 'none') {
    runtimeProfileOverride = null;
  } else if (flags.runtimeProfile) {
    const path = resolve(flags.runtimeProfile);
    try {
      runtimeProfileOverride = JSON.parse(readFileSync(path, 'utf8')) as RuntimeProfileSpec;
      validateRuntimeProfile(runtimeProfileOverride);
    } catch (err: any) {
      throw new Error(`Invalid --runtime-profile ${path}: ${err?.message ?? err}`);
    }
  }

  const version = readPkgVersion();
  process.stdout.write(`awb-agent-manager v${version}\n`);
  process.stdout.write(`  home:        ${AGENT_MANAGER_HOME}\n`);

  const configPath = flags.config ?? CONFIG_PATH;
  let config = loadConfig(configPath);
  if (!config) {
    process.stdout.write(`  config:      not found at ${configPath}\n`);
    process.stdout.write(
      `\n  No config yet. Run the pairing wizard to set one up:\n\n` +
        `      awb-agent-manager setup\n\n` +
        `  Or non-interactively (CI / Ansible):\n\n` +
        `      awb-agent-manager setup --url <awb-url> --token <pairing-token>\n\n` +
        `  The token comes from AWB Workspace → AI Agents → Agent Manager Runtime → "Pair manager…".\n`,
    );
    if (flags.dryRun) {
      log('--dry-run: exiting after config load (config=missing)');
      return;
    }
    log('No config — exiting. Run `awb-agent-manager setup` first.');
    process.exit(1);
  }

  if (flags.workspace) {
    config.workspace_id = flags.workspace;
  }

  process.stdout.write(`  config:      ${configPath}\n`);
  process.stdout.write(`  url:         ${config.url}\n`);
  process.stdout.write(`  workspace:   ${config.workspace_id ?? '(none)'}\n`);
  // ST-7 cli refactor: the manager no longer pins to a single CLI. Each
  // managed agent picks its own (claude/codex/antigravity), set per-row in
  // AWB Workspace → AI Agents → New Managed Agent. Legacy `cli` field on
  // config.json is now ignored at runtime.

  if (flags.dryRun) {
    log('--dry-run: exiting after config load (config=loaded)');
    return;
  }

  await runRuntime(
    config as SessionAwareConfig & SubagentAwareConfig,
    version,
    flags,
    argv,
    runtimeProfileOverride,
  );
}

async function runRuntime(
  config: SessionAwareConfig & SubagentAwareConfig,
  version: string,
  flags: CliFlags,
  argv: string[],
  runtimeProfileOverride: RuntimeProfileSpec | null | undefined,
): Promise<void> {
  void argv; // reserved for future re-exec hook

  let lock: LockHandle;
  try {
    lock = await acquireAgentLock({ role: 'manager', version, force: flags.force });
  } catch (err: any) {
    if (err?.code === 'EAGENTLOCKED') {
      log(`agent-manager: ${err.message}`);
      process.exit(2);
    }
    throw err;
  }

  log(
    `agent-manager starting (server=${config.url} version=${version})`,
  );
  log(
    `Delegation: maxConcurrent=${config.delegation.maxConcurrent} ttl=${config.delegation.ttlMinutes}min idle=${config.delegation.idleMinutes}min claudeBin=${config.delegation.claudeBin} codexBin=${config.delegation.codexBin}`,
  );

  const agentIdReady = resolveAgentId(config).then((id) => {
    if (id) log(`Agent identity: ${id.slice(0, 8)}…`);
    else
      log(
        'Agent identity: not resolved — presence + error-log upload disabled until pairing writes agent.json',
      );
    return id;
  });

  // ticket 23753dc7 — 자가 업데이트의 부팅 검증. 이전 프로세스가 남긴 상태
  // 파일을 읽어 "방금 설치한 빌드가 정상 부팅했는가"를 판정하고, 실패면 여기서
  // 곧바로 이전 버전으로 되돌린 뒤 재기동한다. 락을 잡은 직후 — 즉 우리가
  // 유일한 매니저임이 확정된 첫 지점 — 에 두는 이유는 나쁜 빌드가 죽기 전에
  // 이 판정이 돌아야 되돌릴 수 있기 때문이다. 복귀가 재기동을 예약하면 아래
  // 부팅 절차는 더 진행하지 않는다.
  const bootVerification = await runBootVerification({ log });
  if (bootVerification.willReExec) {
    log('agent-manager: rolling back to the previous version — boot aborted');
    // 락을 놓고 나간다. 이 시점에는 SIGTERM 핸들러가 아직 걸려 있지 않아
    // 정상 종료 경로의 해제가 돌지 않는다 — 그냥 두면 되돌아온 프로세스가
    // 죽은 pid 의 락 때문에 기다리게 된다.
    lock.release();
    return;
  }
  if (bootVerification.armed) {
    // 하트비트 1회 성공이 오지 않으면 상한에서 복귀한다. unref 로 걸어 이
    // 타이머 자체가 프로세스를 붙잡지 않게 한다.
    setTimeout(() => {
      // 페어링 전이면 InstanceHeartbeat 가 POST 자체를 하지 않는다 — 그 경우
      // 하트비트 부재는 빌드가 나쁘다는 증거가 아니므로 되돌리지 않는다.
      agentIdReady
        .then((id) =>
          runBootVerificationTimeout({
            log,
            elapsedMs: BOOT_VERIFY_TIMEOUT_MS,
            heartbeatEnabled: Boolean(id),
          }),
        )
        .catch((err: any) =>
          log(`Self-update: boot verification timeout handler failed: ${err?.message ?? err}`),
        );
    }, BOOT_VERIFY_TIMEOUT_MS).unref?.();
  }

  const presenceHeartbeat: { _real: PresenceHeartbeat | null } = { _real: null };
  const kickPresencePing = (): void => {
    presenceHeartbeat._real?.pingNow().catch(() => {});
  };
  const instanceHeartbeat: { _real: InstanceHeartbeat | null } = { _real: null };

  // Background remote-version checker. Runs `git fetch` + reads
  // `apps/agent-manager/package.json` from origin/<branch> on a slow
  // (5min) timer, caching the result so InstanceHeartbeat can attach
  // `latest_version` / `update_available` to every payload without
  // paying the network cost on each tick.
  const updateChecker = new UpdateChecker({ log });
  updateChecker.start();

  // SSE를 열기 전에 이전 manager가 남긴 persistent CLI의 종료를 확인한다.
  // 백그라운드 정리와 첫 chat dispatch가 경합하면 동일 Claude session UUID가
  // 잠시 겹쳐 `already in use`가 다시 발생할 수 있다.
  try {
    const r = await cleanupOrphanSubagents(undefined, false);
    if (r.failed) {
      throw new Error(`${r.failed} orphan CLI process(es) could not be terminated`);
    }
    if (r.scanned > 0) {
      log(`Orphan subagent cleanup: scanned=${r.scanned} reaped=${r.reaped} skipped=${r.skipped ?? 0}`);
    }
  } catch (err: any) {
    log(`Orphan subagent cleanup failed: ${err?.message ?? err}`);
    lock.release();
    throw err;
  }
  cleanupOrphanHermesProcesses()
    .then((r) => {
      if (r.scanned > 0) {
        log(`Orphan Hermes cleanup: scanned=${r.scanned} reaped=${r.reaped} skipped=${r.skipped ?? 0}`);
      }
    })
    .catch((err: any) => log(`Orphan Hermes cleanup failed: ${err?.message ?? err}`));

  // Shared circuit-breaker across the one-shot (SubagentManager) and persistent
  // (TicketSessionManager) paths (ticket 27806095). A single (agent,ticket,role)
  // that keeps failing — whichever path spawned it — counts toward one
  // threshold, and restart_agent's resetAgent clears both at once.
  const circuitBreaker = new CircuitBreaker();
  // ticket 3d180f85 — shared provision-spanning single-flight coordinator.
  // Created here (like circuitBreaker) so its suppression-reason metric can ride
  // the instance heartbeat, and injected into the EventDispatcher via deps.
  const inflightDispatchTracker = new InflightDispatchTracker();
  // ticket d34075b5 — cumulative per-reason dispatch-BLOCK counter (worktree /
  // push-credential preflight aborts, incl. shared-pool `pool_exhausted`). Created
  // here (like inflightDispatchTracker) so its counts ride the instance heartbeat
  // as `dispatch_block_counts`, and injected into the EventDispatcher via deps.
  const dispatchBlockTracker = new DispatchBlockTracker();
  // ticket 467f714a — durable harness session-limit defer store. Created here so
  // it is the SAME instance the EventDispatcher gates on and the ticket-session /
  // one-shot exit handlers record into. Disk-backed (SESSION_DEFER_PATH) so a
  // defer window + its coalesced resume intents survive a manager restart. The
  // EventDispatcher wires its resume handler + calls load() (boot rehydrate);
  // main must NOT double-load.
  const sessionLimitDeferStore = new SessionLimitDeferStore({
    persistPath: SESSION_DEFER_PATH,
    log,
  });

  // Durable send outbox — chat replies / silent-exit comments / acks that
  // failed with a retryable transport error while AWB was unreachable are
  // buffered on disk (OUTBOX_PATH) and replayed on SSE (re)connect + a slow
  // periodic backstop. load() BEFORE setRestOutbox so a fresh live failure
  // can never race the boot rehydrate. Senders close over `config`, which is
  // mutated in place on SIGHUP/reload_config — replays always use the
  // current url/apiKey. Replays go through the *Raw senders (no re-enqueue).
  const messageOutbox = new MessageOutbox({ persistPath: OUTBOX_PATH, log });
  messageOutbox.setSenders({
    chat_message: (p) => postChatRoomMessageRaw(config, p.room_id, p.agent_id, p.content, p.opts),
    silent_exit_comment: async (p) =>
      (await postSilentExitSystemCommentRaw(config, p.ticket_id, p.body)).outcome,
    dispatch_ack: (p) => postDispatchAckRaw(config, p.body),
    command_ack: (p) => postCommandAckRaw(config, p.command_id, p.status, p.detail),
    cli_login_progress: (p) => postCliLoginProgressRaw(config, p.body),
  });
  messageOutbox.load();
  setRestOutbox(messageOutbox);

  const subagentManager = new SubagentManager(config, circuitBreaker);
  // Capture the init promise so the boot-time warm-pool lease reclaim can wait
  // for #reconcileOnStart to revive surviving detached subagents into the
  // snapshot BEFORE it decides which leases are orphaned (ticket 4ed77ad5).
  const subagentReady = subagentManager.init().catch((err: any) =>
    log(`SubagentManager init failed: ${err?.message ?? err}`),
  );

  // ST-5b — managed-agent registry hydrated by agent_manager_command SSE
  // events. Reported back to AWB on every InstanceHeartbeat ping so the
  // admin UI's manager detail panel can render `agent_ids` / `working_dirs`.
  const managedAgents = new ManagedAgentRegistry();
  // ST-6 — per-agent runtime context (cwd / apiKey / mcp-config). Filled by
  // spawn_agent, drained by stop_agent, read by EventDispatcher to route
  // managed-agent-targeted events under the right identity.
  const managedAgentContexts = new ManagedAgentContextRegistry();
  const runtimeSupervisor = new RuntimeSupervisor({
    rootDir: MANAGED_AGENTS_DIR,
    awbUrl: config.url,
    onEvent: (context, event) => {
      if (event.type === 'child_started') {
        const input = event.input && typeof event.input === 'object'
          ? event.input as Record<string, unknown>
          : {};
        void postRuntimeChildEvent(config, {
          phase: 'start',
          parent_agent_id: context.agentId,
          parent_run_id: context.runId,
          child_run_id: event.childRunId,
          strategy: context.strategy === 'swarm' ? 'swarm' : 'delegated',
          depth: Number(input.depth ?? input.child_depth ?? 1),
          budget: Number(input.budget ?? 0),
          title: event.title,
          metadata: { kind: event.kind || '' },
        });
      } else if (event.type === 'child_finished') {
        void postRuntimeChildEvent(config, {
          phase: 'finish',
          parent_agent_id: context.agentId,
          parent_run_id: context.runId,
          child_run_id: event.childRunId,
          strategy: context.strategy === 'swarm' ? 'swarm' : 'delegated',
          status: event.status,
          summary: typeof event.output === 'string'
            ? event.output
            : JSON.stringify(event.output ?? ''),
        });
      }
      if (event.type === 'diagnostic') {
        log(
          `[runtime:hermes] diagnostic agent=${context.agentId.slice(0, 8)} ` +
          `run=${context.runId} method=${event.method}`,
        );
      } else if (event.type === 'tool_started' || event.type === 'tool_completed') {
        log(
          `[runtime:hermes] ${event.type} agent=${context.agentId.slice(0, 8)} ` +
          `run=${context.runId} tool=${event.toolCallId}`,
        );
      }
    },
    onStderr: (agentId, line) => {
      log(`[runtime:hermes:${agentId.slice(0, 8)}] ${line}`);
    },
  });
  // Ticket execution always uses an isolated checkout below the storage root.
  const worktreeManager = new WorktreeManager();
  // Construct the session managers BEFORE the command handler so stop_agent /
  // restart_agent can force-kill an agent's live chat / ticket children
  // through them. Without this wiring, a credential rotation only rewrote
  // disk and the still-running child kept dispatching turns under the stale
  // OAuth until idle/maxTurns retired it (10+ minutes).
  const chatSessionManager = new ChatSessionManager(config);
  const ticketSessionManager = new TicketSessionManager(config, circuitBreaker);
  // ticket b831b896: total chat / action / QA / ticket-dispatch sessions
  // currently live, across all three managers. Fed to runSelfUpdate so it can
  // defer a restart while real work is in flight instead of SIGTERMing it
  // moments after it starts.
  const countInFlightSessions = (): number =>
    subagentManager._snapshot().length +
    chatSessionManager._snapshot().length +
    ticketSessionManager._snapshot().length;
  // ticket b831b896 round 2: updateChecker was constructed earlier (before
  // these session managers existed), so it's wired late via the setter
  // instead of a constructor opt — lets its periodic tick retry a
  // self-update that got deferred waiting for sessions to drain.
  updateChecker.setCountInFlightSessions(countInFlightSessions);
  // Late-bound reference to the SSE stream — the EventStream is constructed
  // after this command handler (it depends on commandHandler for dispatch),
  // so the spawn_agent → reconnect hook captures this slot and resolves it
  // at call time. The first spawn always lands after eventStream.start().
  let eventStreamRef: EventStream | null = null;

  // ticket b2e79108 — Codex device-auth login runner. One in-flight session
  // per manager process (enforced by CliLoginManager.isBusy/#startCliLogin).
  const cliLoginManager = new CliLoginManager(config);

  const commandHandler = new AgentManagerCommandHandler(config, {
    registry: managedAgents,
    contextRegistry: managedAgentContexts,
    chatSessionManager,
    ticketSessionManager,
    // Wired so stop_agent / restart_agent also reap the agent's detached
    // one-shot subagents — without this a restart left zombies running on the
    // rotated-away credential (ticket 86683d12).
    subagentManager,
    // Circuit-breaker: restart_agent resets failure counts so re-pushed
    // triggers aren't blocked by stale breaker state from the old credential.
    // Shared instance covers both the persistent and one-shot paths.
    circuitBreaker,
    runtimeSupervisor,
    cliLoginManager,
    // ticket b831b896: lets #updateManager() pass the live session count into
    // runSelfUpdate's drain-wait gate.
    countInFlightSessions,
    getInstanceId: () => instanceHeartbeat._real?.instanceId ?? null,
    requestStreamReconnect: () => eventStreamRef?.reconnect(),
    reloadConfig: async () => {
      const next = loadConfig();
      if (!next?.url || !next?.apiKey) return 'reload skipped: config missing';
      const disruptive =
        next.url !== config.url ||
        next.apiKey !== config.apiKey;
      Object.assign(config, next);
      return disruptive ? 'reloaded (disruptive — server/apiKey need restart)' : 'reloaded';
    },
  });
  // ST-7 follow-up: fs_browser is always-on. Construct with whatever's in
  // config.fs_browser (roots etc.) but the FsBrowser class no longer
  // gates behind an enabled flag — missing/empty roots = unrestricted
  // browsing from $HOME. Loud log line so operators can confirm in
  // proxy.log that the new code is live without grepping dist.
  const fsBrowser = new FsBrowser(config, (config as any).fs_browser || null);
  log('fs_browser: always-on (ST-7) — construction OK, ready to handle fs_request events');

  const subagentMonitor = new SubagentMonitor(config as any, null);
  subagentManager.setMonitor(subagentMonitor);
  chatSessionManager.setMonitor(subagentMonitor);
  ticketSessionManager.setMonitor(subagentMonitor);

  subagentManager.onExit = ({ record, code, signal, durationSec }) => {
    const label = record.kind === 'chat' ? 'Chat Subagent' : 'Subagent';
    let msg: string;
    if (signal === 'SIGTERM' || signal === 'SIGKILL') {
      msg = `[AWB ${label}] ticket=${record.ticket_id || '-'} TIMED OUT after ${durationSec}s`;
    } else if (code === 0) {
      msg = `[AWB ${label}] ticket=${record.ticket_id || '-'} completed (duration=${durationSec}s)`;
    } else {
      msg = `[AWB ${label}] ticket=${record.ticket_id || '-'} FAILED (exit=${code}, duration=${durationSec}s)`;
    }
    log(msg);
  };

  // ST-6 follow-up: rehydrate previously-spawned managed agents from disk.
  // Without this, every manager restart leaves the entire managed-agent
  // population unreachable until an admin re-clicks Spawn on each row.
  // We register the AgentContext + mark the registry running PRE-SSE so the
  // first events after restart already have routes; agents missing either
  // config.json or apikey are skipped silently (a stop_agent erased their
  // secrets, or they were never fully spawned).
  try {
    const dirs = await listManagedAgentDirs();
    let rehydrated = 0;
    let skipped = 0;
    for (const id of dirs) {
      const cfg = await readManagedAgentConfig(id);
      const apiKey = await readApiKeyForRehydrate(id, cfg?.workspace_id);
      if (!cfg || !apiKey || !cfg.working_dir) {
        skipped++;
        continue;
      }
      // ST-7 follow-up: ensure cli-home/ exists before context register so
      // a rehydrated agent's first event-spawn can immediately point its
      // CLI's CLAUDE_CONFIG_DIR / GEMINI_HOME / CODEX_HOME at the dir.
      await ensureCliHomeDir(id);
      // Also re-run the adapter's cli-home prep on every rehydrate. The
      // typical case is claude's credentials symlink: it can go stale when
      // the operator re-auths on the host, and rehydrate is the only
      // post-spawn point we know we'll hit before the next subagent
      // fork. Failures here are logged but non-fatal — the CLI itself
      // will surface a clearer auth error if the symlink is broken. Codex is
      // stricter: native MCP config failures skip rehydration below.
      //
      // Per-agent credential is read from the on-disk snapshot rather
      // than re-fetched from AWB. Restart-time fetch would block boot on
      // network reachability, and the snapshot is refreshed on every
      // spawn_agent / restart_agent anyway.
      const credential = await readAgentCredential(id);
      let extraEnv: Record<string, string> = {};
      if (cfg.cli !== 'hermes') {
      try {
        // Same MCP context as spawn_agent so antigravity's mcp_config.json gets
        // refreshed on rehydrate (operator may have rotated the AWB url
        // between manager runs).
        const prep = await createAdapter(cfg.cli).prepareCliHome(
          cliHomeDirFor(id),
          credential,
          { url: config.url, apiKey },
          // Re-thread the persisted model so deepseek's ANTHROPIC_MODEL is
          // restored on restart (this path recomputes extraEnv rather than
          // reusing the spawn-time snapshot). Other adapters ignore it.
          (cfg as any).model || null,
        );
        extraEnv = prep?.extraEnv ?? {};
      } catch (err: any) {
        const detail = `rehydrate: cli-home prep failed for agent=${id.slice(0, 8)} cli=${cfg.cli}: ${err?.message ?? err}`;
        log(detail);
        if (cfg.cli === 'codex') {
          // Codex loads AWB exclusively from this native config. Do not route
          // events to an agent that cannot satisfy its required MCP contract.
          managedAgents.upsert({ agent_id: id, name: cfg.name, cli: cfg.cli, working_dir: cfg.working_dir });
          managedAgents.markStopped(id, detail);
          skipped++;
          continue;
        }
      }
      }
      // Mirror the spawn-time `credential_kind` mapping (see
      // agent-manager-commands.ts → credentialKind). Rehydrate uses the
      // on-disk credential snapshot rather than a fresh AWB fetch, so the
      // mapping has to be in two places — keep the rules identical.
      const credentialKind: 'subscription' | 'api_key' | 'operator_home' = !credential
        ? 'operator_home'
        : credential.provider.endsWith('_subscription')
          ? 'subscription'
          : credential.provider.endsWith('_api_key')
            ? 'api_key'
            : 'subscription';
      managedAgentContexts.upsert({
        agent_id: id,
        workspace_id: cfg.workspace_id || '',
        name: cfg.name,
        cli: cfg.cli,
        working_dir: cfg.working_dir,
        mcp_config_path: mcpConfigPathFor(id, cfg.workspace_id),
        api_key: apiKey,
        subagent_log_path: subagentLogPathFor(id),
        cli_home_dir: cliHomeDirFor(id),
        // Per-agent default model from the on-disk config snapshot (same value
        // spawn_agent persisted). Restored so post-restart subagents/sessions
        // keep running under the configured model.
        model: (cfg as any).model || null,
        runtime_config: cfg.runtime_config ?? null,
        extra_env: extraEnv,
        // Pulled from the on-disk credential snapshot — same value spawn_agent
        // wrote at last bootstrap. Lets spawn sites strip operator-inherited
        // auth env vars after a manager restart without re-fetching from AWB.
        credential_provider: credential?.provider ?? null,
        credential_id: credential?.credential_id ?? null,
        credential_kind: credentialKind,
        registered_at: new Date().toISOString(),
      });
      managedAgents.upsert({ agent_id: id, name: cfg.name, cli: cfg.cli, working_dir: cfg.working_dir });
      managedAgents.markRunning(id, process.pid);
      rehydrated++;
    }
    if (rehydrated || skipped) {
      log(`Managed-agent rehydrate: rehydrated=${rehydrated} skipped=${skipped} (of ${dirs.length} on-disk dirs)`);
    }
  } catch (err: any) {
    log(`Managed-agent rehydrate failed: ${err?.message ?? err}`);
  }

  // ticket d34075b5 — on-demand warm-pool lease reclaim, invoked by the dispatcher
  // the instant a shared-mode dispatch hits `pool_exhausted` (accelerated
  // reconciliation). Late-bound: reconcilePoolLeasesAll is defined below (it needs
  // the live-session snapshots), so the dispatcher gets a thunk that reads it at
  // call time and no-ops (0 reclaimed) until it is assigned during boot.
  let reconcilePoolLeasesAll: ((trigger: string) => Promise<number>) | undefined;

  const eventStream = new EventStream({
    config,
    deps: {
      subagentManager,
      chatSessionManager,
      ticketSessionManager,
      fsBrowser,
      prompts: promptComposer,
      agentManagerCommandHandler: commandHandler,
      managedAgentContexts,
      worktreeManager,
      inflightDispatchTracker,
      dispatchBlockTracker,
      sessionLimitDeferStore,
      runtimeProfileOverride,
      runtimeSupervisor,
      poolReclaimTrigger: () =>
        reconcilePoolLeasesAll ? reconcilePoolLeasesAll('pool_exhausted') : Promise.resolve(0),
    },
    pluginVersion: version,
    onConnect: () => {
      kickPresencePing();
      // SSE just (re)connected — the server is reachable again, so drain any
      // messages buffered while it wasn't. Also covers boot-after-crash: the
      // first connect after load() replays what a dead manager left behind.
      void messageOutbox.flush('sse_connect');
    },
  });
  eventStreamRef = eventStream;
  eventStream.start();
  log('SSE event stream started');

  // ticket 467f714a: a harness session-limit death (`You've hit your session
  // limit · resets …`) opens the dispatcher's per-agent defer window. The exit
  // handler lives in TicketSessionManager (constructed before the stream), so wire
  // the callback now that the stream → dispatcher exists. Fire-and-forget, never
  // throws into the exit path.
  ticketSessionManager.onHarnessSessionLimit = (info) => {
    try {
      eventStream.recordHarnessSessionLimit(info);
    } catch (err: any) {
      log(`recordHarnessSessionLimit failed: ${err?.message ?? err}`);
    }
  };
  // Same defer store for the one-shot subagent path (persistent sessions off).
  subagentManager.onHarnessSessionLimit = (info) => {
    try {
      eventStream.recordHarnessSessionLimit(info);
    } catch (err: any) {
      log(`recordHarnessSessionLimit (one-shot) failed: ${err?.message ?? err}`);
    }
  };

  let uploadTimer: NodeJS.Timeout | null = null;

  // Outbox backstop — a POST can fail transiently while the SSE stream itself
  // stays up (single dropped request, brief LB hiccup), in which case no
  // reconnect ever fires to trigger the replay. Sweep on a slow timer;
  // flush() itself no-ops instantly when the queue is empty.
  const outboxFlushTimer: NodeJS.Timeout = setInterval(() => {
    if (messageOutbox.size > 0) void messageOutbox.flush('interval');
  }, 60_000);
  outboxFlushTimer.unref?.();

  // ticket 9f26f091 — reclaim idle, clean per-(ticket,role) worktrees so a
  // long-lived manager doesn't accumulate dead trees. Conservative: a worktree
  // is removed only when it has no live session AND no uncommitted work (a
  // dirty tree means a pended ticket still has unsaved changes — kept). The
  // branch ref survives removal, so resume just recreates the worktree.
  let worktreeSweepTimer: NodeJS.Timeout | null = null;
  let poolReclaimTimer: NodeJS.Timeout | null = null;
  const sweepWorktrees = async (): Promise<void> => {
    try {
      // worktree 규약 ②: a worktree dir's slug is now the ticket's <ticket8>
      // (per_ticket) — role is no longer part of the path, and the 'shared'
      // worktree is skipped by sweep() unconditionally. So the active-set holds
      // the per-ticket slug; a live session for a ticket keeps its worktree.
      const activeKeys = new Set<string>();
      for (const s of ticketSessionManager._snapshot()) {
        if (s.ticketId) activeKeys.add(worktreeSlug(s.ticketId));
      }
      for (const s of subagentManager._snapshot()) {
        if (s.ticket_id) activeKeys.add(worktreeSlug(s.ticket_id));
      }
      let total = 0;
      // The worktree root is derived from working_dir (`<working_dir>/.awb/wt`)
      // inside the manager, so agents sharing one working_dir dedupe on it alone.
      const seenDirs = new Set<string>();
      for (const ctx of managedAgentContexts.list()) {
        if (!ctx.working_dir) continue;
        if (seenDirs.has(ctx.working_dir)) continue;
        seenDirs.add(ctx.working_dir);
        total += await worktreeManager.sweep({
          baseWorkingDir: ctx.working_dir,
          activeKeys,
        });
      }
      if (total > 0) log(`[worktree] sweep reclaimed ${total} idle clean worktree(s)`);
    } catch (err: any) {
      log(`[worktree] sweep failed: ${err?.message ?? err}`);
    }
  };
  worktreeSweepTimer = setInterval(() => void sweepWorktrees(), 10 * 60 * 1000);
  worktreeSweepTimer.unref?.();

  // ticket 9fd27487 — idle 상태인 Action-Run / 채팅방 작업폴더(`.awb/act`,
  // `.awb/chat`)를 회수한다 — 그래야 오래 실행되는 매니저가 action 이 돌고
  // 채팅방이 쌓이는 만큼 이 폴더들을 무한정 누적시키지 않는다. 위쪽의
  // ticket-worktree 스윕보다 훨씬 느린 별도 타이머다: 이 폴더들은
  // action-keyed/room-keyed 라서(많은 run/메시지에 걸쳐 재사용된다) idle 기준
  // (RUN_WORKSPACE_IDLE_MS, 7일)을 "지금 당장 idle" 이 아니라 일 단위로 재는
  // 것이 맞다 — 그러니 한 시간마다 도는 tick 이면 충분하고도 남는다.
  let runWorkspaceSweepTimer: NodeJS.Timeout | null = null;
  const sweepRunWorkspaces = async (): Promise<void> => {
    try {
      let total = 0;
      const seenDirs = new Set<string>();
      for (const ctx of managedAgentContexts.list()) {
        if (!ctx.working_dir || seenDirs.has(ctx.working_dir)) continue;
        seenDirs.add(ctx.working_dir);
        total += await worktreeManager.sweepRunWorkspaces(ctx.working_dir);
      }
      if (total > 0) log(`[worktree] run-workspace sweep reclaimed ${total} idle action/chat workspace(s)`);
    } catch (err: any) {
      log(`[worktree] run-workspace sweep failed: ${err?.message ?? err}`);
    }
  };
  runWorkspaceSweepTimer = setInterval(() => void sweepRunWorkspaces(), 60 * 60 * 1000);
  runWorkspaceSweepTimer.unref?.();

  // ticket 4ed77ad5 — crash-tolerant warm-pool lease reclaim. reset-on-acquire
  // cleans a slot's tree, but a worker that dies uncleanly (exit-143) before its
  // ticket reaches terminal/archive never runs the release path, so its slot
  // stays leased forever and the shared pool eventually starves. Reconcile the
  // persisted lease registry against the live-worker view (the SAME session
  // snapshots the sweep reuses) and flip any active-but-ownerless lease back to
  // idle — a pure state flip; the next acquire's reset-on-acquire does the
  // cleanup and the slot dir (warm build) is never touched. Runs on the sweep
  // cadence AND once at boot (the prime leak window: pre-restart workers are
  // gone but their active leases persisted).
  const computeLiveTicketIds = (): Set<string> => {
    const live = new Set<string>();
    for (const s of ticketSessionManager._snapshot()) if (s.ticketId) live.add(s.ticketId);
    for (const s of subagentManager._snapshot()) if (s.ticket_id) live.add(s.ticket_id);
    return live;
  };
  // Assigns the late-bound holder declared above the EventStream so the
  // dispatcher's on-demand `poolReclaimTrigger` thunk resolves to it. Returns the
  // number of orphaned leases reclaimed so the on-demand caller (pool_exhausted
  // fast-path) knows whether to retry provisioning inline.
  reconcilePoolLeasesAll = async (trigger: string): Promise<number> => {
    try {
      const liveTicketIds = computeLiveTicketIds();
      let total = 0;
      const seenDirs = new Set<string>();
      for (const ctx of managedAgentContexts.list()) {
        if (!ctx.working_dir || seenDirs.has(ctx.working_dir)) continue;
        seenDirs.add(ctx.working_dir);
        total += await worktreeManager.reconcilePoolLeases({
          baseWorkingDir: ctx.working_dir,
          liveTicketIds,
        });
      }
      if (total > 0) {
        log(`[worktree] pool reclaim (${trigger}) reclaimed ${total} orphaned lease(s)`);
        // ticket d34075b5 (review follow-up) — a periodic/boot reconcile just freed
        // slot(s); re-drive any queued pool_exhausted retries so a starved dispatch
        // recovers WITHOUT a server re-push ("periodic reconcile succeeded → re-run
        // the pending dispatch"). Skip the on-demand 'pool_exhausted' trigger: that
        // path is the dispatcher's OWN fast-path, which already retries the freed
        // slot inline (and waking here would just re-block on the slot it just took).
        if (trigger !== 'pool_exhausted') {
          eventStream.wakePoolRetries(`reconcile:${trigger}`);
        }
      }
      return total;
    } catch (err: any) {
      log(`[worktree] pool reclaim (${trigger}) failed: ${err?.message ?? err}`);
      return 0;
    }
  };
  // ticket d34075b5 — reconcile cadence tightened 10 → 5 min. Combined with the
  // dispatcher's on-demand reclaim (pool_exhausted fast-path), a leaked lease
  // blocking a dispatch is now reclaimed within seconds rather than up to the
  // 20-min grace + this interval. The 20-min reclaim grace itself is kept: it is
  // load-bearing against false-reclaiming a worker still inside its provision+spawn
  // window (a cold clone can run to the 20-min git timeout, and the /proc belt does
  // not cover a `git clone` that runs from the manager cwd, not the slot).
  poolReclaimTimer = setInterval(() => void reconcilePoolLeasesAll!('tick'), 5 * 60 * 1000);
  poolReclaimTimer.unref?.();
  // Boot reconcile — wait on the subagent reconcile so a detached one-shot that
  // survived the restart is in the snapshot first (else it looks orphaned).
  void subagentReady.then(() => reconcilePoolLeasesAll!('boot'));

  agentIdReady.then(async (agentId) => {
    if (!agentId) return;
    presenceHeartbeat._real = new PresenceHeartbeat(config, agentId);
    presenceHeartbeat._real.start();
    // Enumerate each installed CLI's accepted models once at boot. Best-effort
    // (every adapter's listModels has its own timeout and never throws); run in
    // parallel so a slow binary scan doesn't serialize the others. Shipped on
    // every heartbeat as `available_models` so AWB's per-agent model selector
    // reflects the CLIs actually installed on this host.
    const availableModels: Record<string, string[]> = {};
    const runtimeCapabilities = await discoverRuntimeCapabilities();
    // ticket 49c173c8 — PATH를 명시 고정하는 systemd 드롭인이 두 번째로 어떤
    // 디렉터리(codex용 ~/.npm-global/bin, gh용 ~/.local/bin)를 조용히 빠뜨렸는데도
    // 매니저 쪽엔 아무 신호가 없었다. git/gh는 agent runtime이 아니라서 위
    // discoverRuntimeCapabilities()가 절대 다루지 않는다 — 여기서 따로 확인해
    // 전부 한 줄의 기동 시점 로그로 합쳐, 다음 PATH 사각지대가 세션 안에서만
    // 뒤늦게 드러나지 않고 agent-manager.log에 바로 남게 한다.
    // (리뷰 지적 반영) discoverRuntimeCapabilities()의 결과는 설치 여부/버전만
    // 담고 실제로 어느 실행 파일이 선택됐는지는 버린다 — 이 티켓이 다루는
    // 회귀(702d0ebe, codex가 snap을 npm-global보다 먼저 잡음)는 "설치돼 있는가"가
    // 아니라 "어느 경로가 선택됐는가"의 문제였다. claude/codex도 discoverRuntimeCapabilities
    // 대신 checkAuxiliaryCli로 통일해, 4개 CLI 모두 resolveCliBin이 고른 절대경로로
    // 직접 probe하고 그 경로를 함께 로그에 남긴다.
    const cliResolutionChecks = await Promise.all(
      (['claude', 'codex', 'gh', 'git'] as const).map(
        async (cli) => [cli, await checkAuxiliaryCli(cli)] as const,
      ),
    );
    log(`boot CLI resolution: ${formatCliResolutionSummary(cliResolutionChecks)}`);
    await Promise.all(
      KNOWN_ADAPTER_CLI_TYPES.map(async (cli) => {
        try {
          const models = await createAdapter(cli).listModels();
          if (Array.isArray(models) && models.length) availableModels[cli] = models;
        } catch (err: any) {
          log(`listModels failed for cli=${cli}: ${err?.message ?? err}`);
        }
      }),
    );
    instanceHeartbeat._real = new InstanceHeartbeat(config, agentId, {
      mode: 'manager',
      version,
      // ticket 23753dc7 — 하트비트 1회 성공이 곧 부팅 검증 통과다(정책 C).
      // 여기서 상태 기록을 지워야 다음 재기동이 이 부팅을 실패로 오판하지 않는다.
      onFirstPostSuccess: () => {
        markBootVerified({ log });
      },
      // Manager hosts a mix of per-agent CLIs now (ST-7); the UI cli
      // field is a coarse label and 'mixed' beats picking one arbitrary
      // adapter that may not even be in use.
      cli: 'mixed',
      cliAdapters: Object.entries(runtimeCapabilities)
        .filter(([, status]) => status.installed && status.healthy)
        .map(([runtimeId]) => runtimeId),
      runtimeCapabilities,
      // ticket c3b767c6 — declares this build's dispatch-gated feature set
      // (currently just context_window_clamp) so the server can refuse to
      // dispatch a profile whose clamp an old manager would silently ignore.
      managerCapabilities: MANAGER_CAPABILITIES as string[],
      // Per-CLI model lists gathered just above (cliType → model ids).
      availableModels,
      // ST-5b — pass the registry as a snapshot source so each heartbeat
      // reports the currently-supervised agent_ids and their working dirs.
      managedAgents,
      openBreakerCountProvider: () => circuitBreaker.getOpenBreakers().length,
      // ticket 3d180f85 — per-reason dispatch-suppression counts (provision-
      // spanning twin guard). Rides the heartbeat exactly like open_breaker_count
      // so an operator can see suppressed-twin volume without log access.
      dispatchSuppressionCountsProvider: () => inflightDispatchTracker.suppressionCounts(),
      // ticket d34075b5 — per-reason dispatch-BLOCK counts (worktree / push-
      // credential preflight aborts, incl. shared-pool `pool_exhausted`). Rides the
      // heartbeat like dispatch_suppression_counts so an operator sees a leaking /
      // starved pool — the durable, server-visible signal for a dropped dispatch.
      dispatchBlockCountsProvider: () => dispatchBlockTracker.counts(),
      // ticket e299c6b3 — CLI spawn-failure 요약. 두 spawn 경로가 이 공유 tracker
      // 에 보고하고, heartbeat 이 이를 노출해 CLI 가 5분마다 조용히 ENOENT 나는
      // 대신 관리자 대시보드에 "degraded" 배지를 띄운다(Windows codex `.cmd` shim
      // 회귀).
      spawnFailureProvider: () => spawnFailureTracker.snapshot(),
      // Self-update tracker; lets the heartbeat carry latest_version +
      // update_available so the admin UI can render an Update button.
      updateChecker,
      // Per-agent CLI credential expiry monitor. Reads each context's
      // cli-home `.credentials.json` (or equivalent) every heartbeat
      // and ships the parsed expiry / refresh_token presence to AWB so
      // the admin UI can flag agents whose token is about to silently
      // fail. Never includes the raw token. See AgentCredentialEntry
      // for field semantics; readCredentialMeta on the adapter is the
      // contract.
      agentCredentialMetaProvider: async () => {
        const out: Array<{
          agent_id: string;
          cli: string;
          kind: 'subscription' | 'api_key' | 'operator_home' | 'unknown' | 'missing';
          expires_at_ms: number | null;
          refresh_token_present: boolean;
        }> = [];
        for (const ctx of managedAgentContexts.list()) {
          // api_key auth has no expiry concept — short-circuit so we
          // don't issue a pointless disk read. Stamped at spawn / rehydrate
          // (see ManagedAgentContext.credential_kind).
          if (ctx.credential_kind === 'api_key') {
            out.push({
              agent_id: ctx.agent_id,
              cli: ctx.cli,
              kind: 'api_key',
              expires_at_ms: null,
              refresh_token_present: false,
            });
            continue;
          }
          let meta: { kind: 'subscription' | 'api_key' | 'unknown'; expires_at_ms: number | null; refresh_token_present: boolean } | null = null;
          try {
            meta = await createAdapter(ctx.cli).readCredentialMeta(ctx.cli_home_dir);
          } catch (err: any) {
            log(
              `agentCredentialMetaProvider: read failed for agent=${ctx.agent_id.slice(0, 8)} cli=${ctx.cli}: ${err?.message ?? err}`,
            );
            meta = null;
          }
          if (!meta) {
            // No disk metadata. Resolution depends on the spawn-time kind:
            //   - operator_home → expected for adapters that don't implement
            //     readCredentialMeta (codex/antigravity). The agent IS configured;
            //     the manager just can't introspect the file. Report as
            //     'operator_home' with null expiry so the UI stays consistent
            //     across CLIs instead of falsely flagging this as 'missing'.
            //   - subscription → a real problem: the per-agent OAuth file
            //     this agent was provisioned with is now gone. Report 'missing'
            //     so the UI surfaces it loudly.
            //   - (api_key was already short-circuited above.)
            out.push({
              agent_id: ctx.agent_id,
              cli: ctx.cli,
              kind: ctx.credential_kind === 'operator_home' ? 'operator_home' : 'missing',
              expires_at_ms: null,
              refresh_token_present: false,
            });
            continue;
          }
          // For 'operator_home' contexts, the file we just read came from
          // the operator's HOME (symlinked / copied at spawn time). The
          // expiry data is real but its kind isn't strictly 'subscription'
          // from AWB's perspective — preserve the spawn-time kind so the
          // admin UI can label "operator HOME" rather than "subscription".
          //
          // The adapter contract says readCredentialMeta will not return
          // kind='api_key' (api_key has no on-disk file to read) but
          // narrow defensively in case a future adapter does.
          const kind: 'subscription' | 'api_key' | 'operator_home' | 'unknown' =
            ctx.credential_kind === 'operator_home' && meta.kind === 'subscription'
              ? 'operator_home'
              : meta.kind;
          out.push({
            agent_id: ctx.agent_id,
            cli: ctx.cli,
            kind,
            expires_at_ms: meta.expires_at_ms,
            refresh_token_present: meta.refresh_token_present,
          });
        }
        return out;
      },
      // Live worktrees + pool-lease state across every supervised agent (ticket
      // 72fc244f). Best-effort/async like the credential provider — a git failure
      // or missing pool registry yields []. Reuses the SAME live-ticket view the
      // sweep/reconcile use (computeLiveTicketIds) so an 'orphaned' entry here is
      // the exact lease reconcilePoolLeases would reclaim. Deduped per working_dir.
      worktreeStatusProvider: async (): Promise<WorktreeStatusEntry[]> => {
        const liveTicketIds = computeLiveTicketIds();
        const out: WorktreeStatusEntry[] = [];
        const seenDirs = new Set<string>();
        for (const ctx of managedAgentContexts.list()) {
          if (!ctx.working_dir || seenDirs.has(ctx.working_dir)) continue;
          seenDirs.add(ctx.working_dir);
          const entries = await worktreeManager.snapshotWorktrees({
            baseWorkingDir: ctx.working_dir,
            liveTicketIds,
          });
          for (const e of entries) {
            out.push({
              working_dir: ctx.working_dir,
              path: e.path,
              slot: e.slot,
              mode: e.mode,
              ticket_id: e.ticketId,
              branch: e.branch,
              state: e.state,
              live: e.live,
            });
          }
        }
        return out;
      },
      // 감독 중인 모든 agent 전체에서 살아있는 Action-Run / 채팅방 작업폴더
      // (ticket 9fd27487). 위 worktreeStatusProvider와 동일한 best-effort/async
      // 계약을 따른다. 이 작업폴더들은 평범한 디렉터리라 매니저 자신이 직접
      // `/proc` cross-check 하므로(WorktreeManager.snapshotRunWorkspaces 참고)
      // 티켓 기준 liveness 뷰가 따로 필요 없다.
      runWorkspaceStatusProvider: async (): Promise<RunWorkspaceStatusEntry[]> => {
        const out: RunWorkspaceStatusEntry[] = [];
        const seenDirs = new Set<string>();
        for (const ctx of managedAgentContexts.list()) {
          if (!ctx.working_dir || seenDirs.has(ctx.working_dir)) continue;
          seenDirs.add(ctx.working_dir);
          const entries = await worktreeManager.snapshotRunWorkspaces(ctx.working_dir);
          for (const e of entries) {
            out.push({
              working_dir: ctx.working_dir,
              path: e.path,
              kind: e.kind,
              leaf: e.leaf,
              last_used_at: e.lastUsedAt,
              live: e.live,
            });
          }
        }
        return out;
      },
    });
    instanceHeartbeat._real.start();
    const fireUpload = (): void => {
      uploadIfNewErrors(config, agentId, version).catch(() => {});
    };
    fireUpload();
    uploadTimer = setInterval(fireUpload, 30 * 1000);
    uploadTimer.unref?.();
    onFlushThreshold(fireUpload);
  });

  const shutdown = async (signal: string): Promise<void> => {
    // ticket 6abe2b79 / b831b896: self-update 의 재-exec 경로도 이 함수를
    // SIGTERM 으로 태운다(self-update.ts 의 reExecManager/shutdownForNpmGlobalUpdate
    // 참고) — 그래서 signal 인자만으로는 self-update 재시작과 operator
    // SIGTERM/SIGINT 를 구분할 수 없다. pendingRestartReason() 이 그 구분을
    // 담당한다(오직 self-update 전용 재시작 경로에서만 세팅되고, restart_manager
    // 는 세팅하지 않는다 — 그쪽은 'manager_shutdown' 으로 남는다).
    const stopReason = pendingRestartReason() ?? 'manager_shutdown';
    log(`agent-manager received ${signal} — terminating subagents (reason=${stopReason})`);
    presenceHeartbeat._real?.stop();
    instanceHeartbeat._real?.stop();
    updateChecker.stop();
    if (uploadTimer) {
      clearInterval(uploadTimer);
      uploadTimer = null;
    }
    // Outbox sink stays attached through the drain below on purpose: a
    // silent-exit comment / chat reply that fails while subagents are being
    // terminated is exactly what should persist to outbox.json for the next
    // boot's replay. enqueue() is a synchronous file write — safe at shutdown.
    clearInterval(outboxFlushTimer);
    if (worktreeSweepTimer) {
      clearInterval(worktreeSweepTimer);
      worktreeSweepTimer = null;
    }
    if (runWorkspaceSweepTimer) {
      clearInterval(runWorkspaceSweepTimer);
      runWorkspaceSweepTimer = null;
    }
    if (poolReclaimTimer) {
      clearInterval(poolReclaimTimer);
      poolReclaimTimer = null;
    }
    eventStream.stop();
    try {
      await subagentManager.stop(stopReason);
    } catch (err: any) {
      log(`shutdown: ${err?.message ?? err}`);
    }
    try {
      await chatSessionManager.stop(stopReason);
    } catch (err: any) {
      log(`shutdown (chat): ${err?.message ?? err}`);
    }
    try {
      await ticketSessionManager.stop(stopReason);
    } catch (err: any) {
      log(`shutdown (ticket): ${err?.message ?? err}`);
    }
    try {
      await shutdownRuntimeProfiles();
    } catch (err: any) {
      log(`shutdown (runtime profiles): ${err?.message ?? err}`);
    }
    try {
      await runtimeSupervisor.stopAll();
    } catch (err: any) {
      log(`shutdown (Hermes runtimes): ${err?.message ?? err}`);
    }
    try {
      subagentMonitor.stop();
    } catch (err: any) {
      log(`shutdown (monitor): ${err?.message ?? err}`);
    }
    try {
      lock.release();
    } catch (err: any) {
      log(`shutdown (lockfile): ${err?.message ?? err}`);
    }
    // exit(1) when reExecManager set the flag — systemd's Restart=on-failure
    // needs a non-zero exit code to respawn us into the just-built dist.
    // exit(0) for normal operator-driven stops so `systemctl --user stop` is
    // honored and the unit doesn't bounce forever.
    process.exit(isSystemdReExecPending() ? 1 : 0);
  };
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  process.once('SIGINT', () => void shutdown('SIGINT'));

  // SIGUSR1 → self-update. `runSelfUpdate` owns the in-flight guard now (see
  // self-update.ts), so SIGUSR1 racing with the SSE `update_manager` path
  // shares the same module-level mutex instead of each handler maintaining
  // its own. A contended SIGUSR1 just gets a no-op summary back.
  process.on('SIGUSR1', async () => {
    try {
      // ticket 9408b308: SIGUSR1 은 호스트에 접근 가능한 운영자의 명시적 지시다
      // — `scheduled` 정책에서 이 개시를 승인으로 기록해 다음 창에 다시 묻지 않게 한다.
      const result = await runSelfUpdate({ log, countInFlightSessions, approvalSource: 'sigusr1' });
      log(`Self-update: ${result.summary}`);
    } catch (err: any) {
      log(`Self-update failed: ${err?.stack || err?.message || err}`);
    }
  });

  // SIGUSR2 → unconditional restart (ticket ad5a81da). runSelfUpdate/SIGUSR1
  // only re-execs when the npm registry has a newer version, so it silently
  // no-ops for config-only changes (e.g. editing the on-disk --runtime-profile
  // JSON, which main.ts only reads once at startup — see flags.runtimeProfile
  // above). restartManager() shares self-update's in-flight mutex but skips
  // the version/provenance check entirely, so it always re-execs in place.
  process.on('SIGUSR2', async () => {
    try {
      const result = await restartManager({ log });
      log(`Restart: ${result.summary}`);
    } catch (err: any) {
      log(`Restart failed: ${err?.stack || err?.message || err}`);
    }
  });

  process.on('SIGHUP', () => {
    const next = loadConfig();
    if (!next?.url || !next?.apiKey) {
      log('SIGHUP: config.json missing or unparseable — keeping previous config');
      return;
    }
    const disruptive =
      next.url !== config.url ||
      next.apiKey !== config.apiKey;
    Object.assign(config, next);
    log(
      `SIGHUP: config reloaded (delegation.maxConcurrent=${config.delegation.maxConcurrent} ` +
        `ttl=${config.delegation.ttlMinutes}min idle=${config.delegation.idleMinutes}min)` +
        (disruptive ? ' — server/apiKey changes need a manager restart to take effect' : ''),
    );
  });

  log('agent-manager ready');
}

main().catch((err) => {
  process.stderr.write(`agent-manager: fatal: ${err?.stack ?? err}\n`);
  process.exit(1);
});
