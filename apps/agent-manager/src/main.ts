#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join as pathJoin } from 'node:path';
import {
  AGENT_MANAGER_HOME,
  CONFIG_PATH,
  LEGACY_CONFIG_PATH,
  MANAGED_AGENTS_DIR,
} from './lib/constants.js';
import { loadConfig, resolveAgentId } from './lib/config.js';
import { installCrashHandlers, log } from './lib/logging.js';
import {
  acquireAgentLock,
  inspectLegacyAgentLock,
  type LockHandle,
} from './lib/agent-lockfile.js';
import { importLegacyConfig } from './lib/legacy-import.js';
import { isSystemdReExecPending, runSelfUpdate, UpdateChecker } from './lib/self-update.js';
import { runSetup, type SetupOptions } from './lib/setup.js';
import { installService, uninstallService, type ServicePlatform } from './lib/service-install.js';
import { PresenceHeartbeat } from './lib/presence-heartbeat.js';
import { InstanceHeartbeat } from './lib/instance-heartbeat.js';
import { EventStream } from './lib/event-stream.js';
import { SubagentManager } from './lib/subagent-manager.js';
import { ChatSessionManager } from './lib/chat-session-manager.js';
import { TicketSessionManager } from './lib/ticket-session-manager.js';
import { CircuitBreaker } from './lib/circuit-breaker.js';
import { uploadIfNewErrors } from './lib/error-log-uploader.js';
import { onFlushThreshold } from './lib/event-log-recorder.js';
import { cleanupOrphanSubagents } from './lib/orphan-cleanup.js';
import { FsBrowser } from './lib/fs-browser.js';
import { SubagentMonitor } from './lib/subagent-monitor.js';
import { KNOWN_ADAPTER_CLI_TYPES, createAdapter } from './lib/cli-adapters/index.js';
import { promptComposer } from './lib/prompts.js';
import { ManagedAgentRegistry } from './lib/managed-agents.js';
import { ManagedAgentContextRegistry } from './lib/managed-agent-context.js';
import { WorktreeManager, worktreeSlug } from './lib/worktree-manager.js';
import { EnvironmentProvisioner } from './lib/environment-provisioner.js';
import { AgentManagerCommandHandler } from './lib/agent-manager-commands.js';
import {
  listManagedAgentDirs,
  readManagedAgentConfig,
  readApiKey,
  readAgentCredential,
  mcpConfigPathFor,
  subagentLogPathFor,
  cliHomeDirFor,
  ensureCliHomeDir,
} from './lib/managed-agent-store.js';
import type { SessionAwareConfig } from './lib/base-session-manager.js';
import type { SubagentAwareConfig } from './lib/subagent-manager.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

interface CliFlags {
  config?: string;
  workspace?: string;
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
    dryRun: Boolean(values['dry-run']),
    help: Boolean(values.help),
    version: Boolean(values.version),
    force: Boolean(values.force),
  };
}

function printHelp(): void {
  process.stdout.write(`awb-agent-manager — standalone AWB subagent runner

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
  -f, --force             Take over the lockfile from a stale or running owner
      --dry-run           Load config and exit without starting runtime
  -h, --help              Show this help text
  -v, --version           Print version

Setup options (\`awb-agent-manager setup ...\`):
      --url <url>            AWB server base URL (skip prompt)
      --token <token>        Pairing token from AWB Admin → Agent Manager
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

Legacy import:
  On first run, ${LEGACY_CONFIG_PATH} is copied into the new
  config home if no config.json is present yet. A marker file is placed in
  the legacy directory; subsequent runs skip the import. Existing legacy
  files are NEVER deleted — the claude-plugin stdio MCP proxy may still use
  them.

Signals:
  SIGTERM/SIGINT  graceful drain + exit
  SIGHUP          re-read config.json (delegation tunables hot-reload)
  SIGUSR1         self-update: git pull + npm install + npm run build, then
                  re-exec with --force so the new build adopts the lockfile.
                  No-op when the manager is not running from a git checkout.
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

  const version = readPkgVersion();
  process.stdout.write(`awb-agent-manager v${version}\n`);
  process.stdout.write(`  home:        ${AGENT_MANAGER_HOME}\n`);

  // Auto-import claude-plugin daemon config on first run. Idempotent — skipped
  // if the new config is already present or if a previous run left a marker.
  // Only runs when no explicit --config flag was passed.
  if (!flags.config) {
    const importResult = importLegacyConfig();
    if (importResult.imported) {
      process.stdout.write(
        `  imported:    ${importResult.source.config} -> ${importResult.target.config}\n`,
      );
    }
  }

  const configPath = flags.config ?? CONFIG_PATH;
  let config = loadConfig(configPath);
  if (!config) {
    process.stdout.write(`  config:      not found at ${configPath}\n`);
    if (existsSync(LEGACY_CONFIG_PATH)) {
      process.stdout.write(
        `  hint:        legacy plugin config exists at ${LEGACY_CONFIG_PATH} ` +
          `but a previous import already ran. Copy it to ${configPath} manually if you want to re-import.\n`,
      );
    } else {
      process.stdout.write(
        `\n  No config yet. Run the pairing wizard to set one up:\n\n` +
          `      awb-agent-manager setup\n\n` +
          `  Or non-interactively (CI / Ansible):\n\n` +
          `      awb-agent-manager setup --url <awb-url> --token <pairing-token>\n\n` +
          `  The token comes from AWB Admin → Agent Manager → "Pair manager…".\n`,
      );
    }
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
  // AWB Admin → Agent Manager → Managed Agents. Legacy `cli` field on
  // config.json is now ignored at runtime.

  if (flags.dryRun) {
    log('--dry-run: exiting after config load (config=loaded)');
    return;
  }

  await runRuntime(config as SessionAwareConfig & SubagentAwareConfig, version, flags, argv);
}

async function runRuntime(
  config: SessionAwareConfig & SubagentAwareConfig,
  version: string,
  flags: CliFlags,
  argv: string[],
): Promise<void> {
  void argv; // reserved for future re-exec hook

  // Refuse to run alongside a still-alive claude-plugin daemon. They would
  // both subscribe to the same SSE stream and double-process events.
  const legacyLock = inspectLegacyAgentLock();
  if (legacyLock.alive && legacyLock.pid) {
    if (flags.force) {
      log(
        `[legacy-lock] --force: ignoring live plugin daemon at pid=${legacyLock.pid} ` +
          `(role=${legacyLock.role || '?'}, version=${legacyLock.version || '?'}). ` +
          `Stop it manually if you see double-processed events.`,
      );
    } else {
      log(
        `[legacy-lock] claude-plugin daemon is still running ` +
          `(pid=${legacyLock.pid}, role=${legacyLock.role || '?'}, ` +
          `version=${legacyLock.version || '?'}, started_at=${legacyLock.started_at || '?'}). ` +
          `Stop it before launching agent-manager, or pass --force to start anyway.`,
      );
      process.exit(3);
    }
  } else if (legacyLock.present) {
    log(`[legacy-lock] found stale lockfile at ${legacyLock.path} — ignoring.`);
  }

  let lock: LockHandle;
  try {
    lock = acquireAgentLock({ role: 'manager', version, force: flags.force });
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
    `Delegation: maxConcurrent=${config.delegation.maxConcurrent} ttl=${config.delegation.ttlMinutes}min idle=${config.delegation.idleMinutes}min cliBin=${config.delegation.claudeBin}`,
  );

  const agentIdReady = resolveAgentId(config).then((id) => {
    if (id) log(`Agent identity: ${id.slice(0, 8)}…`);
    else
      log(
        'Agent identity: not resolved — presence + error-log upload disabled until pairing writes agent.json',
      );
    return id;
  });

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

  cleanupOrphanSubagents()
    .then((r) => {
      if (r.scanned > 0)
        log(`Orphan subagent cleanup: scanned=${r.scanned} reaped=${r.reaped} skipped=${r.skipped ?? 0}`);
    })
    .catch((err: any) => log(`Orphan subagent cleanup failed: ${err?.message ?? err}`));

  // Shared circuit-breaker across the one-shot (SubagentManager) and persistent
  // (TicketSessionManager) paths (ticket 27806095). A single (agent,ticket,role)
  // that keeps failing — whichever path spawned it — counts toward one
  // threshold, and restart_agent's resetAgent clears both at once.
  const circuitBreaker = new CircuitBreaker();

  const subagentManager = new SubagentManager(config, circuitBreaker);
  subagentManager.init().catch((err: any) =>
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
  // ticket 9f26f091 — per-(ticket,role) git worktree isolation. Gated by
  // delegation.worktreeIsolation (default true); when a managed agent's
  // working_dir is a git repo, each (ticket,role) trigger spawns under its own
  // worktree so focus flips can't cross-contaminate branches.
  const worktreeManager = new WorktreeManager({
    enabled: (config as any)?.delegation?.worktreeIsolation !== false,
  });
  // ticket 354d336b — board environment provisioner. Clones/updates the repos
  // a board's environment_config declares under the agent home and runs its
  // setup commands once per (agent, config-fingerprint) before the spawn.
  const environmentProvisioner = new EnvironmentProvisioner();
  // Construct the session managers BEFORE the command handler so stop_agent /
  // restart_agent can force-kill an agent's live chat / ticket children
  // through them. Without this wiring, a credential rotation only rewrote
  // disk and the still-running child kept dispatching turns under the stale
  // OAuth until idle/maxTurns retired it (10+ minutes).
  const chatSessionManager = new ChatSessionManager(config);
  const ticketSessionManager = new TicketSessionManager(config, circuitBreaker);
  // Late-bound reference to the SSE stream — the EventStream is constructed
  // after this command handler (it depends on commandHandler for dispatch),
  // so the spawn_agent → reconnect hook captures this slot and resolves it
  // at call time. The first spawn always lands after eventStream.start().
  let eventStreamRef: EventStream | null = null;

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
      const apiKey = await readApiKey(id);
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
      // will surface a clearer auth error if the symlink is broken.
      //
      // Per-agent credential is read from the on-disk snapshot rather
      // than re-fetched from AWB. Restart-time fetch would block boot on
      // network reachability, and the snapshot is refreshed on every
      // spawn_agent / restart_agent anyway.
      const credential = await readAgentCredential(id);
      let extraEnv: Record<string, string> = {};
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
        log(`rehydrate: cli-home prep failed for agent=${id.slice(0, 8)} cli=${cfg.cli}: ${err?.message ?? err}`);
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
        name: cfg.name,
        cli: cfg.cli,
        working_dir: cfg.working_dir,
        mcp_config_path: mcpConfigPathFor(id),
        api_key: apiKey,
        subagent_log_path: subagentLogPathFor(id),
        cli_home_dir: cliHomeDirFor(id),
        // Per-agent default model from the on-disk config snapshot (same value
        // spawn_agent persisted). Restored so post-restart subagents/sessions
        // keep running under the configured model.
        model: (cfg as any).model || null,
        extra_env: extraEnv,
        // Pulled from the on-disk credential snapshot — same value spawn_agent
        // wrote at last bootstrap. Lets spawn sites strip operator-inherited
        // auth env vars after a manager restart without re-fetching from AWB.
        credential_provider: credential?.provider ?? null,
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
      environmentProvisioner,
    },
    pluginVersion: version,
    onConnect: kickPresencePing,
  });
  eventStreamRef = eventStream;
  eventStream.start();
  log('SSE event stream started');

  let uploadTimer: NodeJS.Timeout | null = null;

  // ticket 9f26f091 — reclaim idle, clean per-(ticket,role) worktrees so a
  // long-lived manager doesn't accumulate dead trees. Conservative: a worktree
  // is removed only when it has no live session AND no uncommitted work (a
  // dirty tree means a pended ticket still has unsaved changes — kept). The
  // branch ref survives removal, so resume just recreates the worktree.
  let worktreeSweepTimer: NodeJS.Timeout | null = null;
  const sweepWorktrees = async (): Promise<void> => {
    if (!worktreeManager.enabled) return;
    try {
      const activeKeys = new Set<string>();
      for (const s of ticketSessionManager._snapshot()) {
        if (s.ticketId && s.role) activeKeys.add(worktreeSlug(s.ticketId, s.role));
      }
      for (const s of subagentManager._snapshot()) {
        if (s.ticket_id && s.role) activeKeys.add(worktreeSlug(s.ticket_id, s.role));
      }
      let total = 0;
      const seenRoots = new Set<string>();
      for (const ctx of managedAgentContexts.list()) {
        if (!ctx.working_dir) continue;
        const worktreesRoot = pathJoin(MANAGED_AGENTS_DIR, ctx.agent_id, 'worktrees');
        const dedupeKey = `${ctx.working_dir} ${worktreesRoot}`;
        if (seenRoots.has(dedupeKey)) continue;
        seenRoots.add(dedupeKey);
        total += await worktreeManager.sweep({
          baseWorkingDir: ctx.working_dir,
          worktreesRoot,
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
      // Manager hosts a mix of per-agent CLIs now (ST-7); the UI cli
      // field is a coarse label and 'mixed' beats picking one arbitrary
      // adapter that may not even be in use.
      cli: 'mixed',
      cliAdapters: KNOWN_ADAPTER_CLI_TYPES.slice() as string[],
      // Per-CLI model lists gathered just above (cliType → model ids).
      availableModels,
      // ST-5b — pass the registry as a snapshot source so each heartbeat
      // reports the currently-supervised agent_ids and their working dirs.
      managedAgents,
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
    log(`agent-manager received ${signal} — terminating subagents`);
    presenceHeartbeat._real?.stop();
    instanceHeartbeat._real?.stop();
    updateChecker.stop();
    if (uploadTimer) {
      clearInterval(uploadTimer);
      uploadTimer = null;
    }
    if (worktreeSweepTimer) {
      clearInterval(worktreeSweepTimer);
      worktreeSweepTimer = null;
    }
    eventStream.stop();
    try {
      await subagentManager.stop();
    } catch (err: any) {
      log(`shutdown: ${err?.message ?? err}`);
    }
    try {
      await chatSessionManager.stop();
    } catch (err: any) {
      log(`shutdown (chat): ${err?.message ?? err}`);
    }
    try {
      await ticketSessionManager.stop();
    } catch (err: any) {
      log(`shutdown (ticket): ${err?.message ?? err}`);
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
      const result = await runSelfUpdate({ log });
      log(`Self-update: ${result.summary}`);
    } catch (err: any) {
      log(`Self-update failed: ${err?.stack || err?.message || err}`);
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
