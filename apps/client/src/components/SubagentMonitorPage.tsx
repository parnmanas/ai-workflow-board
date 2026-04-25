import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api } from '../api';
import type { SubagentSummary, SubagentLogLine } from '../types';
import { tokens } from '../tokens';
import PageHeader from './PageHeader';
import { useBoardStreamEvent } from '../contexts/BoardStreamContext';

/**
 * Live monitor for every subagent the workspace's plugins have spawned.
 * The list + transcript both update via SSE — the row disappears the moment
 * the subagent process exits (after a 5-min grace on the server).
 */
export default function SubagentMonitorPage() {
  const { wsId } = useParams<{ wsId: string }>();
  const [subagents, setSubagents] = useState<SubagentSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [transcript, setTranscript] = useState<SubagentLogLine[]>([]);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!wsId) return;
    try {
      const list = await api.listSubagents(wsId);
      setSubagents(list);
    } catch (err: any) {
      setError(err?.message || 'Failed to list subagents');
    }
  }, [wsId]);

  useEffect(() => { refresh(); }, [refresh]);

  // Keep the table in sync via SSE: register adds, ended removes (or marks).
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
        ? { ...s, ended_at: data.ended_at, exit_code: data.exit_code, signal: data.signal, duration_ms: data.duration_ms }
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
        // Match the server-side ringbuffer cap so the in-memory transcript
        // doesn't grow unboundedly when the user keeps the drawer open.
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

  const sortedSubagents = useMemo(() =>
    subagents.slice().sort((a, b) => b.started_at.localeCompare(a.started_at)),
    [subagents],
  );

  const selected = useMemo(() => subagents.find((s) => s.subagent_id === selectedId) || null, [subagents, selectedId]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <PageHeader title="Subagents" description="Live transcripts of every subagent spawned by this workspace's plugins." />
      <div style={{ flex: 1, overflow: 'hidden', display: 'flex', minHeight: 0 }}>
        <div style={{ flex: '0 0 420px', borderRight: `1px solid ${tokens.colors.border}`, overflowY: 'auto' }}>
          {error && (
            <div style={{ padding: 12, color: tokens.colors.danger, fontSize: 12 }}>{error}</div>
          )}
          {sortedSubagents.length === 0 && !error && (
            <div style={{ padding: 16, color: tokens.colors.textMuted, fontSize: 12 }}>
              No subagents are running right now. Trigger a chat or ticket to see them appear here.
            </div>
          )}
          {sortedSubagents.map((s) => {
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
                  padding: '10px 14px',
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
                  agent {s.agent_id.slice(0, 8)}… · started {new Date(s.started_at).toLocaleTimeString()}
                  {isEnded && ` · ended (exit ${s.exit_code ?? '-'}${s.signal ? `/${s.signal}` : ''})`}
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
    </div>
  );
}

function SubagentTranscript({ summary, lines }: { summary: SubagentSummary; lines: SubagentLogLine[] }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <div style={{ padding: '12px 16px', borderBottom: `1px solid ${tokens.colors.border}`, fontFamily: 'monospace', fontSize: 12 }}>
        <div style={{ color: tokens.colors.textPrimary }}>
          {summary.label || summary.session_key} <span style={{ color: tokens.colors.textMuted }}>· {summary.kind} · pid {summary.pid}</span>
        </div>
        <div style={{ color: tokens.colors.textMuted, fontSize: 11, marginTop: 2 }}>
          subagent_id {summary.subagent_id} · agent {summary.agent_id}
        </div>
      </div>
      <div style={{ flex: 1, overflow: 'auto', padding: 12, fontFamily: 'monospace', fontSize: 12 }}>
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

  // Compact view: pull a one-liner summary from common stream-json shapes.
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
