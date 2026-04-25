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
// After a subagent ends we keep its record around for a short grace window so a
// late-opening transcript drawer still has the tail. Plugin reconnect or the
// next register call from the same plugin clears anything older.
const ENDED_GRACE_MS = 5 * 60_000;

@Injectable()
export class SubagentMonitorService {
  private readonly registry = new Map<string, SubagentRecord>();

  constructor(private readonly logService: LogService) {
    setInterval(() => this._sweepEnded(), 60_000).unref?.();
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
    activityEvents.emit('subagent_ended', {
      subagent_id: rec.subagent_id,
      agent_id: rec.agent_id,
      workspace_id: rec.workspace_id,
      exit_code: rec.exit_code,
      signal: rec.signal,
      duration_ms: rec.duration_ms,
      ended_at,
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
      if (now - new Date(rec.ended_at).getTime() > ENDED_GRACE_MS) {
        this.registry.delete(id);
      }
    }
  }
}
