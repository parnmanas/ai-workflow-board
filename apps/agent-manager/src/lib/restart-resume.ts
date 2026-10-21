/**
 * Work a planned restart interrupted — saved right before the restart, handed
 * to AWB once the new process is connected, then deleted (docs/agent-manager.md
 * → "Self-update policy").
 *
 * A manager update used to wait (up to 10 min) for in-flight work to drain, and
 * busy hosts deferred every update. Now the update goes ahead at once; what was
 * running is written here first, and after the restart AWB re-sends the
 * interrupted tickets and asks the host's operator to continue the interrupted
 * Agent Sessions.
 *
 * Written synchronously from the restart path itself (self-update.ts
 * `setPlannedRestartHook`), not from the SIGTERM handler: on Windows a
 * self-SIGTERM ends the process without running any handler.
 */

import { readFileSync, renameSync, unlinkSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { AGENT_MANAGER_HOME } from './constants.js';
import { log } from './logging.js';
import { postRestartResume, type AwbConfig } from './rest.js';

export const RESTART_RESUME_FILENAME = 'restart-resume.json';
/** Older than this, the interrupted work is someone else's past — dropped unsent. */
export const RESTART_RESUME_TTL_MS = 6 * 60 * 60_000;

/** An Agent Session whose turn (or the decision it waited on) the restart cut off. */
export interface InterruptedAgentSession {
  cli: string;
  session_id: string;
  cwd: string;
  title: string;
  /** What it was doing: running a turn, or waiting for the user's permission / answer inside one. */
  state: 'turn' | 'awaiting_permission' | 'awaiting_input';
  turn_started_at: string | null;
}

/** A ticket whose agent was mid-turn (persistent session) or running (one-shot). */
export interface InterruptedTicket {
  ticket_id: string;
  role: string;
  agent_id: string;
}

export interface RestartResumeRecord {
  version: 1;
  /** `self_update_restart` | `manager_restart`. */
  reason: string;
  saved_at: string;
  from_version: string;
  sessions: InterruptedAgentSession[];
  tickets: InterruptedTicket[];
}

export function restartResumePath(dir: string = AGENT_MANAGER_HOME): string {
  return join(dir, RESTART_RESUME_FILENAME);
}

/**
 * Save what the restart is about to interrupt. Synchronous on purpose — see the
 * module note. A record not yet delivered is merged, never replaced: a new build
 * that fails boot verification restarts (rolls back) before it ever connects,
 * and the work the previous process saved must survive that second restart.
 */
export function writeRestartResume(record: RestartResumeRecord, dir: string = AGENT_MANAGER_HOME): void {
  const pending = readRestartResume(dir);
  const merged: RestartResumeRecord = pending
    ? {
        ...pending,
        sessions: uniqueBy([...pending.sessions, ...record.sessions], (s) => `${s.cli}\0${s.session_id}`),
        tickets: uniqueBy([...pending.tickets, ...record.tickets], (t) => `${t.ticket_id}\0${t.role}`),
      }
    : record;
  if (merged.sessions.length === 0 && merged.tickets.length === 0) return;
  mkdirSync(dir, { recursive: true });
  const path = restartResumePath(dir);
  writeFileSync(`${path}.tmp`, JSON.stringify(merged), 'utf8');
  renameSync(`${path}.tmp`, path);
}

function uniqueBy<T>(items: T[], key: (item: T) => string): T[] {
  const seen = new Map<string, T>();
  for (const item of items) if (!seen.has(key(item))) seen.set(key(item), item);
  return [...seen.values()];
}

export function clearRestartResume(dir: string = AGENT_MANAGER_HOME): void {
  try {
    unlinkSync(restartResumePath(dir));
  } catch {
    /* none */
  }
}

const str = (v: unknown, max = 1024): string => (typeof v === 'string' ? v.slice(0, max) : '');

/** The saved record, or null when there is none, it is unreadable, or it expired (then it is removed). */
export function readRestartResume(dir: string = AGENT_MANAGER_HOME, nowMs = Date.now()): RestartResumeRecord | null {
  let raw: any;
  try {
    raw = JSON.parse(readFileSync(restartResumePath(dir), 'utf8'));
  } catch {
    return null;
  }
  const savedAt = Date.parse(str(raw?.saved_at, 64));
  if (raw?.version !== 1 || !Number.isFinite(savedAt) || nowMs - savedAt > RESTART_RESUME_TTL_MS) {
    log(`Restart resume: dropping ${Number.isFinite(savedAt) ? 'expired' : 'unreadable'} record (saved ${str(raw?.saved_at, 64) || '?'})`);
    clearRestartResume(dir);
    return null;
  }
  const states = new Set(['turn', 'awaiting_permission', 'awaiting_input']);
  const sessions: InterruptedAgentSession[] = (Array.isArray(raw.sessions) ? raw.sessions : [])
    .filter((s: any) => str(s?.cli) && str(s?.session_id))
    .map((s: any) => ({
      cli: str(s.cli, 64),
      session_id: str(s.session_id, 256),
      cwd: str(s.cwd),
      title: str(s.title, 256),
      state: states.has(s.state) ? s.state : 'turn',
      turn_started_at: str(s.turn_started_at, 64) || null,
    }));
  const tickets: InterruptedTicket[] = (Array.isArray(raw.tickets) ? raw.tickets : [])
    .filter((t: any) => str(t?.ticket_id))
    .map((t: any) => ({ ticket_id: str(t.ticket_id, 64), role: str(t.role, 64), agent_id: str(t.agent_id, 128) }));
  return { version: 1, reason: str(raw.reason, 64) || 'manager_restart', saved_at: str(raw.saved_at, 64), from_version: str(raw.from_version, 64), sessions, tickets };
}

/**
 * Hand the record to AWB. Removed once AWB took it, or when AWB refused it for
 * good (4xx — sending it again cannot help); kept for the next connect when AWB
 * could not be reached.
 */
export async function deliverRestartResume(
  config: AwbConfig,
  record: RestartResumeRecord,
  toVersion: string,
  dir: string = AGENT_MANAGER_HOME,
): Promise<'delivered' | 'rejected' | 'retry'> {
  const sent = await postRestartResume(config, { ...record, to_version: toVersion });
  if (sent.status === 'retry') {
    log(`Restart resume: AWB unreachable (${sent.detail}) — will retry on the next connect`);
    return 'retry';
  }
  clearRestartResume(dir);
  if (sent.status === 'rejected') {
    log(`Restart resume: AWB refused the record (${sent.detail}) — dropped`);
    return 'rejected';
  }
  log(
    `Restart resume: handed over ${record.sessions.length} session(s) and ${record.tickets.length} ticket(s) ` +
      `interrupted by ${record.reason} (v${record.from_version || '?'} → v${toVersion}) — ${sent.detail}`,
  );
  return 'delivered';
}
