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
import {
  ADAPTER_CAPABILITIES,
  KNOWN_ADAPTER_CLI_TYPES,
  createAdapter,
} from './lib/cli-adapters/index.js';
import { promptComposer } from './lib/prompts.js';
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
  awb-agent-manager [options]

Options:
  -c, --config <path>     Path to config.json (default: ${CONFIG_PATH})
  -w, --workspace <id>    Override workspace_id from config
  -f, --force             Take over the lockfile from a stale or running owner
      --dry-run           Load config and exit without starting runtime
  -h, --help              Show this help text
  -v, --version           Print version

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

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
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
        `  hint:        no legacy plugin config at ${LEGACY_CONFIG_PATH} either — run pairing.\n`,
      );
    }
    if (flags.dryRun) {
      log('--dry-run: exiting after config load (config=missing)');
      return;
    }
    log('No config — exiting. Run pairing first or pass --config <path>.');
    process.exit(1);
  }

  if (flags.workspace) {
    config.workspace_id = flags.workspace;
  }

  process.stdout.write(`  config:      ${configPath}\n`);
  process.stdout.write(`  url:         ${config.url}\n`);
  process.stdout.write(`  workspace:   ${config.workspace_id ?? '(none)'}\n`);
  process.stdout.write(`  cli:         ${config.cli ?? 'claude'}\n`);

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

  const adapter = createAdapter(config.cli);
  const persistent = adapter.has(ADAPTER_CAPABILITIES.PERSISTENT_SESSION);
  log(
    `agent-manager starting (server=${config.url} version=${version} cli=${adapter.cliType} persistent_sessions=${persistent})`,
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

  const subagentManager = new SubagentManager(config, adapter);
  subagentManager.init().catch((err: any) =>
    log(`SubagentManager init failed: ${err?.message ?? err}`),
  );

  const chatSessionManager = new ChatSessionManager(config, adapter);
  const ticketSessionManager = new TicketSessionManager(config, adapter);
  const fsBrowser = new FsBrowser(config, (config as any).fs_browser || {});

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

  const eventStream = new EventStream({
    config,
    deps: {
      subagentManager,
      chatSessionManager,
      ticketSessionManager,
      fsBrowser,
      prompts: promptComposer,
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
      cli: adapter.cliType,
      cliAdapters: KNOWN_ADAPTER_CLI_TYPES.slice() as string[],
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
