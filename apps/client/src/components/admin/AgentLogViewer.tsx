import React, { useState, useEffect, useRef, useCallback } from 'react';
import { api } from '../../api';
import { tokens } from '../../tokens';
import type { AgentErrorLog, AgentErrorLogAgentSummary } from '../../types';
import { useNotifications } from '../../contexts/NotificationContext';

const LEVEL_COLORS: Record<string, string> = {
  fatal: tokens.colors.danger,
  error: tokens.colors.warning,
  warn: tokens.colors.warningLight,
  info: tokens.colors.successLight,
};

const CATEGORIES = [
  'crash',
  'sse',
  'presence',
  'subagent',
  'ipc',
  'misc',
  'agent_trigger',
  'board_update',
  'chat_request',
  'chat_room_message',
  'comment_mention',
] as const;
const LEVELS = ['fatal', 'error', 'warn', 'info'] as const;

const POLL_INTERVAL = 15000;
const DEFAULT_SINCE_HOURS = 24;

function isoHoursAgo(hours: number): string {
  return new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
}

function formatRelative(ts: string): string {
  try {
    const then = new Date(ts).getTime();
    const now = Date.now();
    const diffSec = Math.max(0, Math.round((now - then) / 1000));
    if (diffSec < 60) return `${diffSec}s ago`;
    const diffMin = Math.floor(diffSec / 60);
    if (diffMin < 60) return `${diffMin}m ago`;
    const diffHr = Math.floor(diffMin / 60);
    if (diffHr < 24) return `${diffHr}h ago`;
    const diffDay = Math.floor(diffHr / 24);
    if (diffDay < 7) return `${diffDay}d ago`;
    const d = new Date(ts);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  } catch {
    return ts;
  }
}

export default function AgentLogViewer() {
  const [logs, setLogs] = useState<AgentErrorLog[]>([]);
  const [agents, setAgents] = useState<AgentErrorLogAgentSummary[]>([]);
  const [loading, setLoading] = useState(true);

  // Filters
  const [agentFilter, setAgentFilter] = useState('');
  const [levelFilter, setLevelFilter] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('');
  const [sinceFilter, setSinceFilter] = useState<string>(() => isoHoursAgo(DEFAULT_SINCE_HOURS));

  // Auto-refresh
  const [autoRefresh, setAutoRefresh] = useState(true);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Opening this page stamps "last seen" for the agent-errors badge so
  // the sidebar dot clears until the next new error arrives. The server
  // does no per-user tracking here — the stamp is pure localStorage,
  // persisted across reloads via the NotificationContext helper.
  const { markAgentErrorsSeen } = useNotifications();
  useEffect(() => {
    markAgentErrorsSeen();
  }, [markAgentErrorsSeen]);

  // Expanded raw_line rows
  const [expandedRows, setExpandedRows] = useState<Set<number>>(new Set());

  const toggleRow = (index: number) => {
    setExpandedRows(prev => {
      const next = new Set(prev);
      if (next.has(index)) {
        next.delete(index);
      } else {
        next.add(index);
      }
      return next;
    });
  };

  const fetchLogs = useCallback(async () => {
    try {
      const params: {
        agent_id?: string;
        level?: string;
        category?: string;
        since?: string;
        limit?: number;
      } = { limit: 200 };
      if (agentFilter) params.agent_id = agentFilter;
      if (levelFilter) params.level = levelFilter;
      if (categoryFilter) params.category = categoryFilter;
      if (sinceFilter) params.since = sinceFilter;

      const data = await api.listAgentLogs(params);
      setLogs(data);
    } catch (err) {
      console.error('Failed to fetch agent logs:', err);
    }
  }, [agentFilter, levelFilter, categoryFilter, sinceFilter]);

  const fetchAgents = useCallback(async () => {
    try {
      const data = await api.listAgentLogAgents();
      setAgents(data);
    } catch (err) {
      console.error('Failed to fetch agent log agents:', err);
    }
  }, []);

  // Initial load + refetch on filter change
  useEffect(() => {
    setLoading(true);
    Promise.all([fetchLogs(), fetchAgents()]).finally(() => setLoading(false));
  }, [agentFilter, levelFilter, categoryFilter, sinceFilter]); // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-refresh polling (15s, matches task spec)
  useEffect(() => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    if (autoRefresh) {
      intervalRef.current = setInterval(() => {
        fetchLogs();
        fetchAgents();
      }, POLL_INTERVAL);
    }
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [autoRefresh, fetchLogs, fetchAgents]);

  const handleRefresh = () => {
    setLoading(true);
    Promise.all([fetchLogs(), fetchAgents()]).finally(() => setLoading(false));
  };

  // Resolve agent name for a log row: prefer joined agent_name, otherwise
  // fall back to the summary list (in case server didn't populate).
  const agentNameFor = (log: AgentErrorLog): string => {
    if (log.agent_name && log.agent_name.length > 0) return log.agent_name;
    const match = agents.find(a => a.agent_id === log.agent_id);
    return match?.agent_name || log.agent_id.slice(0, 8);
  };

  const selectStyle: React.CSSProperties = {
    padding: '6px 10px',
    borderRadius: tokens.radii.md,
    background: tokens.colors.surfaceCard,
    border: `1px solid ${tokens.colors.border}`,
    color: tokens.colors.textStrong,
    fontSize: '12px',
    minWidth: 140,
  };

  return (
    <div>
      {/* Header */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: 16,
        }}
      >
        <h2
          style={{
            fontSize: '18px',
            fontWeight: 700,
            color: tokens.colors.textPrimary,
            margin: 0,
          }}
        >
          Agent Logs
        </h2>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <label
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              fontSize: '12px',
              color: tokens.colors.textSecondary,
              cursor: 'pointer',
            }}
          >
            <input
              type="checkbox"
              checked={autoRefresh}
              onChange={e => setAutoRefresh(e.target.checked)}
              style={{ accentColor: tokens.colors.accent }}
            />
            Auto-refresh (15s)
          </label>
          <button
            onClick={handleRefresh}
            disabled={loading}
            style={{
              padding: '6px 14px',
              borderRadius: tokens.radii.md,
              background: tokens.colors.border,
              border: 'none',
              color: tokens.colors.textStrong,
              fontSize: '12px',
              fontWeight: 500,
              cursor: loading ? 'default' : 'pointer',
              opacity: loading ? 0.6 : 1,
            }}
          >
            {loading ? 'Loading...' : 'Refresh'}
          </button>
        </div>
      </div>

      {/* Filters */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
        <select
          value={agentFilter}
          onChange={e => setAgentFilter(e.target.value)}
          style={{ ...selectStyle, minWidth: 200 }}
        >
          <option value="">(all agents)</option>
          {agents.map(a => (
            <option key={a.agent_id} value={a.agent_id}>
              {a.agent_name} ({a.error_count})
            </option>
          ))}
        </select>

        <select
          value={levelFilter}
          onChange={e => setLevelFilter(e.target.value)}
          style={{ ...selectStyle, minWidth: 100 }}
        >
          <option value="">(all levels)</option>
          {LEVELS.map(l => (
            <option key={l} value={l}>
              {l}
            </option>
          ))}
        </select>

        <select
          value={categoryFilter}
          onChange={e => setCategoryFilter(e.target.value)}
          style={{ ...selectStyle, minWidth: 140 }}
        >
          <option value="">(all categories)</option>
          {CATEGORIES.map(c => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>

        <select
          value={sinceFilter}
          onChange={e => setSinceFilter(e.target.value)}
          style={{ ...selectStyle, minWidth: 140 }}
        >
          <option value={isoHoursAgo(1)}>Last 1h</option>
          <option value={isoHoursAgo(6)}>Last 6h</option>
          <option value={isoHoursAgo(24)}>Last 24h</option>
          <option value={isoHoursAgo(24 * 7)}>Last 7d</option>
          <option value="">All time</option>
        </select>
      </div>

      {/* Log List */}
      <div
        style={{
          background: tokens.colors.surfaceCard,
          borderRadius: tokens.radii.lg,
          border: `1px solid ${tokens.colors.border}`,
          overflow: 'hidden',
        }}
      >
        {logs.length === 0 && !loading ? (
          <div style={{ textAlign: 'center', padding: '48px 24px' }}>
            <div
              style={{
                fontSize: 18,
                fontWeight: 700,
                color: tokens.colors.textPrimary,
                marginBottom: 8,
              }}
            >
              No logs recorded
            </div>
            <div style={{ fontSize: 13, color: tokens.colors.textSecondary }}>
              Agent plugins upload proxy.log errors and received SSE events here.
            </div>
          </div>
        ) : (
          <div style={{ maxHeight: 'calc(100vh - 280px)', overflowY: 'auto' }}>
            {/* Column header */}
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '8px 12px',
                background: tokens.colors.surfaceSubtle,
                borderBottom: `1px solid ${tokens.colors.border}`,
                fontSize: '11px',
                fontWeight: 700,
                color: tokens.colors.textSecondary,
                textTransform: 'uppercase',
                letterSpacing: '0.05em',
              }}
            >
              <span style={{ minWidth: 90, flexShrink: 0 }}>Time</span>
              <span style={{ minWidth: 120, flexShrink: 0 }}>Agent</span>
              <span style={{ minWidth: 50, flexShrink: 0 }}>Level</span>
              <span style={{ minWidth: 90, flexShrink: 0 }}>Category</span>
              <span style={{ flex: 1 }}>Message</span>
            </div>

            {logs.map((log, index) => {
              const bgColor =
                index % 2 === 0 ? tokens.colors.surfaceCard : tokens.colors.surfaceSubtle;
              const levelColor = LEVEL_COLORS[log.level] || tokens.colors.textSecondary;
              const hasRaw = !!log.raw_line && log.raw_line.length > 0;
              const isExpanded = expandedRows.has(index);

              return (
                <div key={log.id || index}>
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'flex-start',
                      gap: 8,
                      padding: '6px 12px',
                      background: bgColor,
                      cursor: hasRaw ? 'pointer' : 'default',
                      borderLeft: `2px solid ${levelColor}40`,
                    }}
                    onClick={() => hasRaw && toggleRow(index)}
                  >
                    {/* Relative time */}
                    <span
                      style={{
                        fontFamily: 'monospace',
                        fontSize: '11px',
                        color: tokens.colors.textMuted,
                        flexShrink: 0,
                        minWidth: 90,
                        lineHeight: '20px',
                      }}
                      title={log.occurred_at}
                    >
                      {formatRelative(log.occurred_at)}
                    </span>

                    {/* Agent name */}
                    <span
                      style={{
                        fontSize: '12px',
                        color: tokens.colors.textStrong,
                        flexShrink: 0,
                        minWidth: 120,
                        maxWidth: 120,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                        lineHeight: '20px',
                      }}
                      title={agentNameFor(log)}
                    >
                      {agentNameFor(log)}
                    </span>

                    {/* Level badge */}
                    <span
                      style={{
                        fontSize: '10px',
                        fontWeight: 700,
                        padding: '2px 6px',
                        borderRadius: tokens.radii.sm,
                        background: `${levelColor}20`,
                        color: levelColor,
                        textTransform: 'uppercase',
                        flexShrink: 0,
                        minWidth: 50,
                        textAlign: 'center',
                        lineHeight: '16px',
                      }}
                    >
                      {log.level}
                    </span>

                    {/* Category badge */}
                    <span
                      style={{
                        fontSize: '10px',
                        fontWeight: 600,
                        padding: '2px 6px',
                        borderRadius: tokens.radii.sm,
                        background: `${tokens.colors.accent}15`,
                        color: tokens.colors.accentMid,
                        flexShrink: 0,
                        minWidth: 90,
                        maxWidth: 90,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                        textAlign: 'center',
                        lineHeight: '16px',
                      }}
                    >
                      {log.category}
                    </span>

                    {/* Message */}
                    <span
                      style={{
                        fontFamily: 'monospace',
                        fontSize: '12px',
                        color: tokens.colors.textDisabled,
                        flex: 1,
                        lineHeight: '20px',
                        wordBreak: 'break-word',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        display: '-webkit-box',
                        WebkitLineClamp: 2,
                        WebkitBoxOrient: 'vertical',
                      }}
                    >
                      {log.message}
                    </span>

                    {/* Expand indicator */}
                    {hasRaw && (
                      <span
                        style={{
                          fontSize: '10px',
                          color: tokens.colors.borderStrong,
                          flexShrink: 0,
                          lineHeight: '20px',
                        }}
                      >
                        {isExpanded ? '\u25BC' : '\u25B6'}
                      </span>
                    )}
                  </div>

                  {/* Expanded raw_line */}
                  {hasRaw && isExpanded && (
                    <div
                      style={{
                        padding: '8px 12px 8px 108px',
                        background: tokens.colors.surface,
                        borderLeft: `2px solid ${levelColor}40`,
                      }}
                    >
                      <div
                        style={{
                          display: 'flex',
                          gap: 12,
                          fontSize: '10px',
                          color: tokens.colors.textMuted,
                          marginBottom: 6,
                        }}
                      >
                        <span>pid: {log.pid ?? '—'}</span>
                        <span>plugin: {log.plugin_version ?? '—'}</span>
                        <span>occurred_at: {log.occurred_at}</span>
                      </div>
                      <pre
                        style={{
                          fontFamily: 'monospace',
                          fontSize: '11px',
                          color: tokens.colors.textSecondary,
                          margin: 0,
                          whiteSpace: 'pre-wrap',
                          wordBreak: 'break-all',
                        }}
                      >
                        {log.raw_line}
                      </pre>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
