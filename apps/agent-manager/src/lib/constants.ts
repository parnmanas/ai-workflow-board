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
// Durable send outbox — REST messages (chat replies, silent-exit comments,
// acks) that failed with a RETRYABLE transport error while the server was
// unreachable. Persisted so a manager that dies mid-outage still replays the
// buffered messages on its next boot. See lib/outbox.ts.
export const OUTBOX_PATH = join(AGENT_MANAGER_HOME, 'outbox.json');
export const INSTANCES_DIR = join(AGENT_MANAGER_HOME, 'instances');
// ST-6: per-managed-agent state lives under <home>/agents/<agent_id>/. Each
// directory holds its own apiKey (issued by the server's provisioning
// endpoint), an mcp-config.json that wraps that apiKey for `claude
// --mcp-config`, a cached settings JSON, and a per-agent subagent log.
export const MANAGED_AGENTS_DIR = join(AGENT_MANAGER_HOME, 'agents');
export const LOG_DIR = AGENT_MANAGER_HOME;
export const LOG_PATH = join(LOG_DIR, 'agent-manager.log');

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
  // ticket ce65cf25: codex 전용 bin override. 기본값은 CLI 타입 이름 그 자체
  // (claudeBin 과 동일한 sentinel 관례) — cli-resolver 의 `configured !== ct`
  // 체크가 이 값을 "override 없음"으로 취급해 정상 PATH/well-known 해석으로
  // 빠진다. 오퍼레이터가 절대경로로 덮어쓰면 그 경로가 그대로 쓰인다.
  codexBin: 'codex',
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
  // ticket b972b28c: mirrors BaseSessionManager's progressEscalationHours
  // (ticket 6ff827cb) for the one-shot #sweep TTL-slide gate — past this
  // age, a one-shot that's still sliding its TTL on live background-task
  // evidence gets ONE log-line escalation, never a kill (same governing
  // principle: real progress evidence is never grounds to reap).
  subagentProgressEscalationHours: 4,
});

/** A new shared slot has no warm build cache yet. Unity's initial Asset Import
 * can legitimately take hours, so only that first slot run gets a 10-hour
 * one-shot lifetime. Reused slots keep the normal delegation TTL. */
export const SHARED_WORKTREE_COLD_IMPORT_TTL_MINUTES = 10 * 60;

export const TTL_SWEEP_INTERVAL_MS = 60_000;
export const SIGTERM_GRACE_MS = 5_000;
export const STOP_GRACE_MS = 2_000;

export const KNOWN_CLI_TYPES = ['claude', 'deepseek', 'codex', 'antigravity', 'pi'] as const;
export type CliType = (typeof KNOWN_CLI_TYPES)[number];
