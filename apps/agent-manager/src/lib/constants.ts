import { join } from 'node:path';
import { homedir, platform } from 'node:os';

function configBaseDir(): string {
  if (process.env.AWB_AGENT_MANAGER_HOME) return process.env.AWB_AGENT_MANAGER_HOME;
  if (platform() === 'win32') {
    const appdata = process.env.APPDATA;
    if (appdata) return join(appdata, 'awb-agent-manager');
  }
  const xdg = process.env.XDG_CONFIG_HOME;
  if (xdg) return join(xdg, 'awb-agent-manager');
  return join(homedir(), '.config', 'awb-agent-manager');
}

export const AGENT_MANAGER_HOME = configBaseDir();
export const CONFIG_PATH = join(AGENT_MANAGER_HOME, 'config.json');
export const AGENT_PATH = join(AGENT_MANAGER_HOME, 'agent.json');
export const SUBAGENTS_BASE_DIR = join(AGENT_MANAGER_HOME, 'subagents');
export const SUBAGENTS_PERSIST_PATH = join(AGENT_MANAGER_HOME, 'subagents.json');
// ticket 467f714a: durable harness session-limit defer state — the per-agent
// reset instant + coalesced pending resume intents. Persisted so a defer window
// (minutes-to-hours until the CLI session cap resets) survives a manager restart
// and the resume still fires exactly once.
export const SESSION_DEFER_PATH = join(AGENT_MANAGER_HOME, 'session-defer.json');
export const INSTANCES_DIR = join(AGENT_MANAGER_HOME, 'instances');
// ST-6: per-managed-agent state lives under <home>/agents/<agent_id>/. Each
// directory holds its own apiKey (issued by the server's provisioning
// endpoint), an mcp-config.json that wraps that apiKey for `claude
// --mcp-config`, a cached settings JSON, and a per-agent subagent log.
export const MANAGED_AGENTS_DIR = join(AGENT_MANAGER_HOME, 'agents');
export const LOG_DIR = AGENT_MANAGER_HOME;
export const LOG_PATH = join(LOG_DIR, 'agent-manager.log');

export const LEGACY_PLUGIN_HOME = join(
  process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'),
  'channels',
  'awb',
);
export const LEGACY_CONFIG_PATH = join(LEGACY_PLUGIN_HOME, 'config.json');
export const LEGACY_AGENT_PATH = join(LEGACY_PLUGIN_HOME, 'agent.json');
export const LEGACY_LOCK_PATH = join(LEGACY_PLUGIN_HOME, 'agent.lock');
export const LEGACY_MIGRATION_MARKER = join(LEGACY_PLUGIN_HOME, 'MIGRATED-TO-AGENT-MANAGER.txt');

export const RECONNECT_INITIAL_MS = 2000;
export const RECONNECT_MAX_MS = 30000;
export const REQUEST_TIMEOUT_MS = 30000;
export const HEARTBEAT_INTERVAL_MS = 30_000;
// Output-liveness heartbeat throttle (ticket fdc69c13). A ticket subagent emits
// output constantly during a turn; the manager reports per-(agent,ticket,role)
// liveness to the server at most once per this interval so the TicketSupervisor
// can distinguish a live worker from a wedged one without POST spam. Well under
// the server's force-gate window (default supervisor_stale_ms = 30 min).
export const OUTPUT_LIVENESS_MIN_INTERVAL_MS = 15_000;

export const DELEGATION_DEFAULTS = Object.freeze({
  enabled: true,
  maxConcurrent: 15,
  ttlMinutes: 15,
  claudeBin: 'claude',
  appendSystemPromptMode: 'role_only',
  persistentChatSessions: true,
  persistentTicketSessions: true,
  idleMinutes: 10,
  maxTurnsPerSession: 30,
  // ticket e9d0e8bc: hold a folder-keyed lock across a QA/security run's whole
  // provision→execute lifetime so two runs of the SAME scenario never execute
  // concurrently in the shared `.awb/qa/<scenario>` folder and clobber each
  // other's checkout/build artifacts. Same folder serializes; different
  // scenarios stay parallel. Set false to revert to provisioning-only locking.
  runExecutionLock: true,
});

export const TTL_SWEEP_INTERVAL_MS = 60_000;
export const SIGTERM_GRACE_MS = 5_000;
export const STOP_GRACE_MS = 2_000;

export const KNOWN_CLI_TYPES = ['claude', 'deepseek', 'codex', 'antigravity'] as const;
export type CliType = (typeof KNOWN_CLI_TYPES)[number];
