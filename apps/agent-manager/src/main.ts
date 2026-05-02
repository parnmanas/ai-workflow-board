#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
  AGENT_MANAGER_HOME,
  CONFIG_PATH,
  LEGACY_CONFIG_PATH,
} from './lib/constants.js';
import { loadConfig, resolveAgentId } from './lib/config.js';
import { installCrashHandlers, log } from './lib/logging.js';
import {
  acquireAgentLock,
  inspectLegacyAgentLock,
  type LockHandle,
} from './lib/agent-lockfile.js';
import { importLegacyConfig } from './lib/legacy-import.js';
import { runSelfUpdate } from './lib/self-update.js';
import { runSetup, type SetupOptions } from './lib/setup.js';
import { installService, uninstallService } from './lib/service-install.js';
import { PresenceHeartbeat } from './lib/presence-heartbeat.js';
import { InstanceHeartbeat } from './lib/instance-heartbeat.js';
import { EventStream } from './lib/event-stream.js';
import { SubagentManager } from './lib/subagent-manager.js';
import { ChatSessionManager } from './lib/chat-session-manager.js';
import { TicketSessionManager } from './lib/ticket-session-manager.js';
import { uploadIfNewErrors } from './lib/error-log-uploader.js';
import { onFlushThreshold } from './lib/event-log-recorder.js';
import { cleanupOrphanSubagents } from './lib/orphan-cleanup.js';
import { FsBrowser } from './lib/fs-browser.js';
import { SubagentMonitor } from './lib/subagent-monitor.js';
import { KNOWN_ADAPTER_CLI_TYPES } from './lib/cli-adapters/index.js';
import { promptComposer } from './lib/prompts.js';
import { ManagedAgentRegistry } from './lib/managed-agents.js';
import { ManagedAgentContextRegistry } from './lib/managed-agent-context.js';
import { AgentManagerCommandHandler } from './lib/agent-manager-commands.js';
import {
  listManagedAgentDirs,
  readManagedAgentConfig,
  readApiKey,
  mcpConfigPathFor,
  subagentLogPathFor,
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
  const { values } = parseArgs({
    args: argv,
    options: {
      config: { type: 'string', short: 'c' },
      workspace: { type: 'string', short: 'w' },
      'dry-run': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' },
      force: { type: 'boolean', short: 'f' },
    },
    allowPositionals: true,
    strict: false,
  });

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
  awb-agent-manager service install [..]  register as a systemd service
  awb-agent-manager service uninstall     remove the systemd service
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

      Note: CLI is per-managed-agent now (set in AWB Admin → Agent
      Manager → Managed Agents → Create), not a manager-wide value.

Service options (\`awb-agent-manager service install ...\`):
      --system               Install at /etc/systemd/system/ (sudo, runs at boot pre-login)
                             Default: ~/.config/systemd/user/ (no sudo, needs \`loginctl enable-linger\`)
      --exec-path <path>     Override path to dist/main.js (default: this binary's location)
      --dry-run              Print the unit file without writing or running systemctl
      --unit-only            Write the unit file but skip daemon-reload + enable + restart

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
  SIGUSR1         self-update (currently a stub — install upgrades via npm)
`);
}

/**
 * Parse `setup` subcommand argv. Distinct from parseFlags so the runtime
 * flag set stays narrow (no setup-only flags polluting -h output).
 */
function parseSetupArgs(argv: string[]): SetupOptions {
  const { values } = parseArgs({
    args: argv,
    options: {
      config: { type: 'string', short: 'c' },
      url: { type: 'string' },
      token: { type: 'string' },
      'instance-id': { type: 'string' },
      'non-interactive': { type: 'boolean' },
      force: { type: 'boolean', short: 'f' },
    },
    allowPositionals: true,
    strict: false,
  });
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
  // `awb-agent-manager service install [--system] [--exec-path <p>] [--dry-run]`
  // Generates a systemd unit + enables + starts. User mode by default
  // (no sudo). System mode requires sudo. See lib/service-install.ts.
  if (argv[0] === 'service') {
    const sub = argv[1] || '';
    const subArgs = argv.slice(2);
    const isSystem = subArgs.includes('--system');
    const dryRun = subArgs.includes('--dry-run');
    const unitOnly = subArgs.includes('--unit-only');
    const execIdx = subArgs.indexOf('--exec-path');
    const execPath = execIdx >= 0 ? subArgs[execIdx + 1] : undefined;
    try {
      if (sub === 'install') {
        await installService({ system: isSystem, execPath, dryRun, unitOnly });
        process.exit(0);
      }
      if (sub === 'uninstall') {
        await uninstallService({ system: isSystem });
        process.exit(0);
      }
      process.stderr.write(
        `\n  Usage: awb-agent-manager service <install|uninstall> [--system] [--exec-path <p>] [--dry-run] [--unit-only]\n\n`,
      );
      process.exit(2);
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
          `      awb-agent-manager setup --url <awb-url> --token <pairing-token> [--cli claude]\n\n` +
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
  // managed agent picks its own (claude/codex/gemini), set per-row in
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
    `agent-manager starting (server=${config.url} version=${version} per-agent cli)`,
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

  cleanupOrphanSubagents()
    .then((r) => {
      if (r.scanned > 0)
        log(`Orphan subagent cleanup: scanned=${r.scanned} reaped=${r.reaped} skipped=${r.skipped ?? 0}`);
    })
    .catch((err: any) => log(`Orphan subagent cleanup failed: ${err?.message ?? err}`));

  const subagentManager = new SubagentManager(config);
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
  const commandHandler = new AgentManagerCommandHandler(config, {
    registry: managedAgents,
    contextRegistry: managedAgentContexts,
    getInstanceId: () => instanceHeartbeat._real?.instanceId ?? null,
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

  const chatSessionManager = new ChatSessionManager(config);
  const ticketSessionManager = new TicketSessionManager(config);
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
      managedAgentContexts.upsert({
        agent_id: id,
        name: cfg.name,
        cli: cfg.cli,
        working_dir: cfg.working_dir,
        mcp_config_path: mcpConfigPathFor(id),
        api_key: apiKey,
        subagent_log_path: subagentLogPathFor(id),
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
    },
    pluginVersion: version,
    onConnect: kickPresencePing,
  });
  eventStream.start();
  log('SSE event stream started');

  let uploadTimer: NodeJS.Timeout | null = null;

  agentIdReady.then((agentId) => {
    if (!agentId) return;
    presenceHeartbeat._real = new PresenceHeartbeat(config, agentId);
    presenceHeartbeat._real.start();
    instanceHeartbeat._real = new InstanceHeartbeat(config, agentId, {
      mode: 'manager',
      version,
      // Manager hosts a mix of per-agent CLIs now (ST-7); the UI cli
      // field is a coarse label and 'mixed' beats picking one arbitrary
      // adapter that may not even be in use.
      cli: 'mixed',
      cliAdapters: KNOWN_ADAPTER_CLI_TYPES.slice() as string[],
      // ST-5b — pass the registry as a snapshot source so each heartbeat
      // reports the currently-supervised agent_ids and their working dirs.
      managedAgents,
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
    if (uploadTimer) {
      clearInterval(uploadTimer);
      uploadTimer = null;
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
    process.exit(0);
  };
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  process.once('SIGINT', () => void shutdown('SIGINT'));

  let selfUpdateInFlight = false;
  process.on('SIGUSR1', async () => {
    if (selfUpdateInFlight) {
      log('SIGUSR1: self-update already in flight, ignoring');
      return;
    }
    selfUpdateInFlight = true;
    try {
      const result = await runSelfUpdate({ log });
      log(`Self-update: ${result.summary}`);
    } catch (err: any) {
      log(`Self-update failed: ${err?.stack || err?.message || err}`);
    } finally {
      selfUpdateInFlight = false;
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
      next.apiKey !== config.apiKey ||
      String(next.cli || '') !== String(config.cli || '');
    Object.assign(config, next);
    log(
      `SIGHUP: config reloaded (delegation.maxConcurrent=${config.delegation.maxConcurrent} ` +
        `ttl=${config.delegation.ttlMinutes}min idle=${config.delegation.idleMinutes}min)` +
        (disruptive ? ' — server/apiKey/cli changes need a manager restart to take effect' : ''),
    );
  });

  log('agent-manager ready');
}

main().catch((err) => {
  process.stderr.write(`agent-manager: fatal: ${err?.stack ?? err}\n`);
  process.exit(1);
});
