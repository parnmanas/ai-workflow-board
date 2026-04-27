import { Injectable } from '@nestjs/common';
import { activityEvents } from './activity.service';
import { LogService } from './log.service';

/**
 * Live transcript bus + in-memory registry for plugin-spawned subagents.
 *
 * The plugin posts (a) a registration when it spawns a Claude CLI subagent,
 * (b) every stream-json line in/out, and (c) an end record when the process
 * exits. This service stashes the lifecycle + a bounded ring of recent lines
 * so the web UI can show a live transcript without round-tripping every event
 * through the database. When the subagent ends — or the plugin reconnects —
 * the record is dropped, so the dataset stays bounded without explicit pruning.
 */

export type SubagentKind = 'chat' | 'ticket' | 'oneshot';

export interface SubagentSummary {
  subagent_id: string;
  agent_id: string;
  workspace_id: string;
  kind: SubagentKind;
  session_key: string;
  pid: number;
  started_at: string;
  label?: string;
  ended_at?: string;
  exit_code?: number | null;
  signal?: string | null;
  duration_ms?: number;
  line_count: number;
  // ISO-8601 timestamp at which the ended record will be purged from the
  // in-memory registry. Only set once `ended_at` is set; undefined while live.
  expires_at?: string;
}

export interface SubagentLogLine {
  direction: 'in' | 'out';
  line: string;
  ts: string;
}

interface SubagentRecord extends SubagentSummary {
  lines: SubagentLogLine[];
}

const RING_PER_SUBAGENT = 500;
// Ended subagents stick around for 48h by default so users can still pull up
// the transcript long after the process exits. Override via
// SUBAGENT_ENDED_RETENTION_HOURS (float ok, e.g. 0.5 for 30 minutes).
const DEFAULT_ENDED_RETENTION_HOURS = 48;
function endedRetentionMs(): number {
  const raw = process.env.SUBAGENT_ENDED_RETENTION_HOURS;
  const hours = raw ? Number(raw) : DEFAULT_ENDED_RETENTION_HOURS;
  if (!Number.isFinite(hours) || hours < 0) return DEFAULT_ENDED_RETENTION_HOURS * 3_600_000;
  return hours * 3_600_000;
}

@Injectable()
export class SubagentMonitorService {
  private readonly registry = new Map<string, SubagentRecord>();
  private readonly retentionMs = endedRetentionMs();

  constructor(private readonly logService: LogService) {
    // Sweep every 5 min; ended records can sit for up to 48h so a 60s tick is
    // wasted work.
    setInterval(() => this._sweepEnded(), 5 * 60_000).unref?.();
  }

  register(input: {
    subagent_id: string;
    agent_id: string;
    workspace_id: string;
    kind: SubagentKind;
    session_key: string;
    pid: number;
    started_at?: string;
    label?: string;
  }): SubagentRecord {
    const started_at = input.started_at || new Date().toISOString();
    const rec: SubagentRecord = {
      subagent_id: input.subagent_id,
      agent_id: input.agent_id,
      workspace_id: input.workspace_id,
      kind: input.kind,
      session_key: input.session_key,
      pid: input.pid,
      started_at,
      label: input.label,
      line_count: 0,
      lines: [],
    };
    this.registry.set(rec.subagent_id, rec);
    activityEvents.emit('subagent_registered', { ...rec });
    this.logService.info(
      'SubagentMonitor',
      `registered ${rec.kind} subagent ${rec.subagent_id} for agent ${rec.agent_id} (${rec.session_key})`,
    );
    return rec;
  }

  appendLines(
    subagentId: string,
    expectedAgentId: string,
    lines: Array<{ direction: 'in' | 'out'; line: string; ts?: string }>,
  ): { ok: boolean; reason?: string } {
    const rec = this.registry.get(subagentId);
    if (!rec) return { ok: false, reason: 'unknown subagent_id' };
    if (rec.agent_id !== expectedAgentId) return { ok: false, reason: 'agent mismatch' };

    for (const entry of lines) {
      const ts = entry.ts || new Date().toISOString();
      rec.lines.push({ direction: entry.direction, line: entry.line, ts });
      while (rec.lines.length > RING_PER_SUBAGENT) rec.lines.shift();
      rec.line_count += 1;
      activityEvents.emit('subagent_log', {
        subagent_id: rec.subagent_id,
        agent_id: rec.agent_id,
        workspace_id: rec.workspace_id,
        direction: entry.direction,
        line: entry.line,
        ts,
      });
    }
    return { ok: true };
  }

  end(input: {
    subagent_id: string;
    agent_id: string;
    exit_code?: number | null;
    signal?: string | null;
  }): { ok: boolean; reason?: string } {
    const rec = this.registry.get(input.subagent_id);
    if (!rec) return { ok: false, reason: 'unknown subagent_id' };
    if (rec.agent_id !== input.agent_id) return { ok: false, reason: 'agent mismatch' };

    const ended_at = new Date().toISOString();
    rec.ended_at = ended_at;
    rec.exit_code = input.exit_code ?? null;
    rec.signal = input.signal ?? null;
    rec.duration_ms = Date.now() - new Date(rec.started_at).getTime();
    rec.expires_at = new Date(Date.now() + this.retentionMs).toISOString();
    activityEvents.emit('subagent_ended', {
      subagent_id: rec.subagent_id,
      agent_id: rec.agent_id,
      workspace_id: rec.workspace_id,
      exit_code: rec.exit_code,
      signal: rec.signal,
      duration_ms: rec.duration_ms,
      ended_at,
      expires_at: rec.expires_at,
    });
    return { ok: true };
  }

  /** All current records (active + recently-ended) for a workspace. */
  listForWorkspace(workspaceId: string): SubagentSummary[] {
    const out: SubagentSummary[] = [];
    for (const rec of this.registry.values()) {
      if (rec.workspace_id !== workspaceId) continue;
      const { lines, ...summary } = rec;
      out.push({ ...summary, line_count: rec.line_count });
    }
    out.sort((a, b) => b.started_at.localeCompare(a.started_at));
    return out;
  }

  getTranscript(subagentId: string, workspaceId: string): { summary: SubagentSummary; lines: SubagentLogLine[] } | null {
    const rec = this.registry.get(subagentId);
    if (!rec || rec.workspace_id !== workspaceId) return null;
    const { lines, ...summary } = rec;
    return { summary: { ...summary, line_count: rec.line_count }, lines: lines.slice() };
  }

  private _sweepEnded() {
    const now = Date.now();
    for (const [id, rec] of this.registry) {
      if (!rec.ended_at) continue;
      // Prefer the explicit expires_at (set when the subagent ended) so a
      // mid-flight retention bump still respects records frozen by the older
      // setting. Fall back to ended_at + current retentionMs for old records.
      const expiresAt = rec.expires_at
        ? new Date(rec.expires_at).getTime()
        : new Date(rec.ended_at).getTime() + this.retentionMs;
      if (now > expiresAt) {
        this.registry.delete(id);
      }
    }
  }
}
