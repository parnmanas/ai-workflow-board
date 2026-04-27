import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import type { SubagentSummary, SubagentLogLine } from '../types';
import { tokens } from '../tokens';
import { useBoardStreamEvent } from '../contexts/BoardStreamContext';

/**
 * Live subagent monitor view, mountable inside any container that gives it a
 * height. Used by AgentDetailModal's Subagents tab; no standalone page wires
 * it any more — the workspace-wide view was removed in favour of the per-agent
 * tab to keep the navigation surface small.
 *
 * Props:
 *   wsId      — workspace; required so the REST + SSE filters know what scope
 *               to listen for. Without it the component renders an empty state.
 *   agentId   — when provided, list/transcript only includes subagents spawned
 *               by this agent. Omitted (or null) shows the full workspace.
 */
interface AgentSubagentsPanelProps {
  wsId: string | undefined;
  agentId?: string | null;
}

export default function AgentSubagentsPanel({ wsId, agentId }: AgentSubagentsPanelProps) {
  const [subagents, setSubagents] = useState<SubagentSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [transcript, setTranscript] = useState<SubagentLogLine[]>([]);
  const [error, setError] = useState<string | null>(null);

  const visible = useMemo(() => {
    const filtered = agentId ? subagents.filter((s) => s.agent_id === agentId) : subagents;
    return filtered.slice().sort((a, b) => b.started_at.localeCompare(a.started_at));
  }, [subagents, agentId]);

  const refresh = useCallback(async () => {
    if (!wsId) return;
    try {
      const list = await api.listSubagents(wsId);
      setSubagents(list);
    } catch (err: any) {
      setError(err?.message || 'Failed to list subagents');
    }
  }, [wsId]);

  useEffect(() => {
    setSelectedId(null);
    setTranscript([]);
    setError(null);
    refresh();
  }, [wsId, agentId, refresh]);

  useBoardStreamEvent('subagent_registered', (data: any) => {
    if (!wsId || data.workspace_id !== wsId) return;
    setSubagents((prev) => {
      if (prev.some((s) => s.subagent_id === data.subagent_id)) return prev;
      return [{ ...data, line_count: 0 } as SubagentSummary, ...prev];
    });
  });
  useBoardStreamEvent('subagent_ended', (data: any) => {
    if (!wsId || data.workspace_id !== wsId) return;
    setSubagents((prev) => prev.map((s) =>
      s.subagent_id === data.subagent_id
        ? {
            ...s,
            ended_at: data.ended_at,
            exit_code: data.exit_code,
            signal: data.signal,
            duration_ms: data.duration_ms,
            expires_at: data.expires_at,
          }
        : s,
    ));
  });
  useBoardStreamEvent('subagent_log', (data: any) => {
    if (!wsId || data.workspace_id !== wsId) return;
    setSubagents((prev) => prev.map((s) =>
      s.subagent_id === data.subagent_id ? { ...s, line_count: s.line_count + 1 } : s,
    ));
    if (selectedId === data.subagent_id) {
      setTranscript((prev) => {
        const next = prev.concat({ direction: data.direction, line: data.line, ts: data.ts });
        return next.length > 500 ? next.slice(next.length - 500) : next;
      });
    }
  });

  const selectSubagent = useCallback(async (id: string) => {
    if (!wsId) return;
    setSelectedId(id);
    setTranscript([]);
    try {
      const t = await api.getSubagentTranscript(id, wsId);
      setTranscript(t.lines);
    } catch (err: any) {
      setError(err?.message || 'Failed to load transcript');
    }
  }, [wsId]);

  const selected = useMemo(() => subagents.find((s) => s.subagent_id === selectedId) || null, [subagents, selectedId]);

  if (!wsId) {
    return (
      <div style={{ padding: 16, fontSize: 12, color: tokens.colors.textMuted }}>
        Workspace not resolved — open this panel from inside a workspace.
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', height: '100%', minHeight: 0, gap: 12 }}>
      <div style={{
        flex: '0 0 360px',
        borderRight: `1px solid ${tokens.colors.border}`,
        overflowY: 'auto',
        paddingRight: 4,
      }}>
        {error && <div style={{ padding: 12, color: tokens.colors.danger, fontSize: 12 }}>{error}</div>}
        {visible.length === 0 && !error && (
          <div style={{ padding: 16, color: tokens.colors.textMuted, fontSize: 12 }}>
            {agentId
              ? 'This agent has no subagents running. Trigger a chat or ticket to populate the list.'
              : 'No subagents are running in this workspace right now.'}
          </div>
        )}
        {visible.map((s) => {
          const isActive = s.subagent_id === selectedId;
          const isEnded = !!s.ended_at;
          return (
            <button
              key={s.subagent_id}
              onClick={() => selectSubagent(s.subagent_id)}
              style={{
                display: 'block',
                width: '100%',
                textAlign: 'left',
                background: isActive ? `${tokens.colors.accent}20` : 'transparent',
                border: 'none',
                borderBottom: `1px solid ${tokens.colors.border}40`,
                padding: '10px 12px',
                cursor: 'pointer',
                color: tokens.colors.textPrimary,
                fontFamily: 'inherit',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{
                  width: 8, height: 8, borderRadius: '50%',
                  background: isEnded ? tokens.colors.textMuted : tokens.colors.successLight,
                }} />
                <span style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', color: tokens.colors.textMuted }}>{s.kind}</span>
                <span style={{ fontSize: 11, color: tokens.colors.textMuted }}>· pid {s.pid}</span>
                <span style={{ marginLeft: 'auto', fontSize: 10, color: tokens.colors.textMuted }}>
                  {s.line_count} lines
                </span>
              </div>
              <div style={{ fontSize: 12, fontFamily: 'monospace', color: tokens.colors.textPrimary, marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {s.label || s.session_key || '(no label)'}
              </div>
              <div style={{ fontSize: 10, color: tokens.colors.textMuted, marginTop: 2 }}>
                started {new Date(s.started_at).toLocaleTimeString()}
                {isEnded && ` · ended (exit ${s.exit_code ?? '-'}${s.signal ? `/${s.signal}` : ''})`}
                {isEnded && s.expires_at && ` · ${formatExpiresIn(s.expires_at)}`}
              </div>
            </button>
          );
        })}
      </div>
      <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        {selected ? (
          <SubagentTranscript summary={selected} lines={transcript} />
        ) : (
          <div style={{ padding: 24, color: tokens.colors.textMuted, fontSize: 13 }}>
            Pick a subagent on the left to view its live transcript.
          </div>
        )}
      </div>
    </div>
  );
}

function formatExpiresIn(iso: string): string {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return '';
  const ms = t - Date.now();
  if (ms <= 0) return 'expiring';
  const hours = Math.floor(ms / 3_600_000);
  if (hours >= 24) {
    const days = Math.floor(hours / 24);
    const rem = hours - days * 24;
    return `expires in ${days}d${rem ? ` ${rem}h` : ''}`;
  }
  if (hours >= 1) {
    const mins = Math.floor((ms - hours * 3_600_000) / 60_000);
    return `expires in ${hours}h${mins ? ` ${mins}m` : ''}`;
  }
  const mins = Math.max(1, Math.floor(ms / 60_000));
  return `expires in ${mins}m`;
}

function SubagentTranscript({ summary, lines }: { summary: SubagentSummary; lines: SubagentLogLine[] }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <div style={{ padding: '10px 12px', borderBottom: `1px solid ${tokens.colors.border}`, fontFamily: 'monospace', fontSize: 12 }}>
        <div style={{ color: tokens.colors.textPrimary }}>
          {summary.label || summary.session_key} <span style={{ color: tokens.colors.textMuted }}>· {summary.kind} · pid {summary.pid}</span>
        </div>
        <div style={{ color: tokens.colors.textMuted, fontSize: 11, marginTop: 2 }}>
          {summary.subagent_id}
        </div>
      </div>
      <div style={{ flex: 1, overflow: 'auto', padding: 10, fontFamily: 'monospace', fontSize: 12 }}>
        {lines.length === 0 ? (
          <div style={{ color: tokens.colors.textMuted, fontStyle: 'italic' }}>No transcript yet — waiting for subagent output…</div>
        ) : (
          lines.map((l, i) => <TranscriptLine key={i} line={l} />)
        )}
      </div>
    </div>
  );
}

function TranscriptLine({ line }: { line: SubagentLogLine }) {
  const [expanded, setExpanded] = useState(false);
  let parsed: any = null;
  try { parsed = JSON.parse(line.line); } catch { /* non-JSON, render raw */ }

  let summary = '';
  let kind = parsed?.type || 'raw';
  if (parsed?.type === 'user') {
    const text = parsed.message?.content?.[0]?.text || '';
    summary = text.length > 200 ? text.slice(0, 200) + '…' : text;
  } else if (parsed?.type === 'assistant' || parsed?.type === 'message') {
    const blocks = parsed.message?.content || parsed.content || [];
    for (const b of blocks) {
      if (b.type === 'text') summary = (b.text || '').slice(0, 240);
      else if (b.type === 'tool_use') summary = `→ ${b.name}(${b.input ? Object.keys(b.input).join(', ') : ''})`;
      else if (b.type === 'tool_result') summary = `← ${typeof b.content === 'string' ? b.content.slice(0, 120) : '[result]'}`;
      else if (b.type === 'thinking') summary = `(thinking ${(b.thinking || '').length}c)`;
      if (summary) break;
    }
  } else if (parsed?.type === 'result') {
    summary = `result: ${parsed.subtype || ''} ${parsed.is_error ? '(error)' : ''}`;
  } else {
    summary = line.line.slice(0, 200);
  }

  const dirColor = line.direction === 'in' ? tokens.colors.info : tokens.colors.successLight;
  return (
    <div style={{ marginBottom: 4, paddingLeft: 8, borderLeft: `2px solid ${dirColor}` }}>
      <div onClick={() => setExpanded((e) => !e)} style={{ cursor: 'pointer', display: 'flex', gap: 6, alignItems: 'baseline' }}>
        <span style={{ color: dirColor, fontWeight: 600, fontSize: 10, textTransform: 'uppercase' }}>{line.direction}</span>
        <span style={{ color: tokens.colors.textMuted, fontSize: 10 }}>{kind}</span>
        <span style={{ color: tokens.colors.textPrimary, whiteSpace: 'pre-wrap', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis' }}>{summary}</span>
      </div>
      {expanded && (
        <pre style={{ margin: '4px 0 0 0', fontSize: 11, color: tokens.colors.textMuted, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
          {parsed ? JSON.stringify(parsed, null, 2) : line.line}
        </pre>
      )}
    </div>
  );
}
