import React, { useState, useEffect, useRef, useCallback } from 'react';
import { api } from '../../api';
import { tokens } from '../../tokens';

interface LogEntry {
  id?: string;
  timestamp: string;
  level: string;
  category: string;
  message: string;
  meta?: any;
}

interface LogStats {
  info?: number;
  warn?: number;
  error?: number;
  debug?: number;
  [key: string]: number | undefined;
}

const LEVEL_COLORS: Record<string, string> = {
  info: tokens.colors.successLight,
  warn: tokens.colors.warningLight,
  error: tokens.colors.danger,
  debug: tokens.colors.textSecondary,
};

const POLL_INTERVAL = 3000;

export default function LogViewer() {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [categories, setCategories] = useState<string[]>([]);
  const [stats, setStats] = useState<LogStats>({});
  const [loading, setLoading] = useState(true);

  // Filters
  const [levelFilter, setLevelFilter] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('');
  const [searchFilter, setSearchFilter] = useState('');

  // Auto-refresh
  const [autoRefresh, setAutoRefresh] = useState(true);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const lastTimestampRef = useRef<string | null>(null);

  // Expanded meta rows
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

  const fetchLogs = useCallback(async (since?: string) => {
    try {
      const params: any = { limit: 200 };
      if (levelFilter) params.level = levelFilter;
      if (categoryFilter) params.category = categoryFilter;
      if (searchFilter) params.search = searchFilter;
      if (since) params.since = since;

      const data = await api.getLogs(params);

      if (since && data.length > 0) {
        // Append new logs, avoid duplicates
        setLogs(prev => {
          const existingTimestamps = new Set(prev.map(l => l.timestamp + l.message));
          const newLogs = data.filter(l => !existingTimestamps.has(l.timestamp + l.message));
          return [...newLogs, ...prev];
        });
      } else if (!since) {
        setLogs(data);
      }

      if (data.length > 0) {
        lastTimestampRef.current = data[0]?.timestamp || null;
      }
    } catch (err) {
      console.error('Failed to fetch logs:', err);
    }
  }, [levelFilter, categoryFilter, searchFilter]);

  const fetchMeta = useCallback(async () => {
    try {
      const [cats, st] = await Promise.all([
        api.getLogCategories(),
        api.getLogStats(),
      ]);
      setCategories(cats);
      setStats(st);
    } catch (err) {
      console.error('Failed to fetch log metadata:', err);
    }
  }, []);

  // Initial load
  useEffect(() => {
    setLoading(true);
    Promise.all([fetchLogs(), fetchMeta()]).finally(() => setLoading(false));
  }, [levelFilter, categoryFilter, searchFilter]); // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-refresh polling
  useEffect(() => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }

    if (autoRefresh) {
      intervalRef.current = setInterval(() => {
        if (lastTimestampRef.current) {
          fetchLogs(lastTimestampRef.current);
        } else {
          fetchLogs();
        }
        fetchMeta();
      }, POLL_INTERVAL);
    }

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
      }
    };
  }, [autoRefresh, fetchLogs, fetchMeta]);

  const handleRefresh = () => {
    setLoading(true);
    lastTimestampRef.current = null;
    Promise.all([fetchLogs(), fetchMeta()]).finally(() => setLoading(false));
  };

  const formatTime = (ts: string) => {
    try {
      const d = new Date(ts);
      const h = String(d.getHours()).padStart(2, '0');
      const m = String(d.getMinutes()).padStart(2, '0');
      const s = String(d.getSeconds()).padStart(2, '0');
      const ms = String(d.getMilliseconds()).padStart(3, '0');
      return `${h}:${m}:${s}.${ms}`;
    } catch {
      return ts;
    }
  };

  return (
    <div>
      {/* Header */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        marginBottom: 16,
      }}>
        <h2 style={{ fontSize: '18px', fontWeight: 700, color: tokens.colors.textPrimary, margin: 0 }}>
          Server Logs
        </h2>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <label style={{
            display: 'flex', alignItems: 'center', gap: 6,
            fontSize: '12px', color: tokens.colors.textSecondary, cursor: 'pointer',
          }}>
            <input
              type="checkbox"
              checked={autoRefresh}
              onChange={e => setAutoRefresh(e.target.checked)}
              style={{ accentColor: tokens.colors.accent }}
            />
            Auto-refresh
          </label>
          <button
            onClick={handleRefresh}
            disabled={loading}
            style={{
              padding: '6px 14px', borderRadius: tokens.radii.md,
              background: tokens.colors.border, border: 'none',
              color: tokens.colors.textStrong, fontSize: '12px', fontWeight: 500,
              cursor: loading ? 'default' : 'pointer',
              opacity: loading ? 0.6 : 1,
            }}
          >
            {loading ? 'Loading...' : 'Refresh'}
          </button>
        </div>
      </div>

      {/* Filters */}
      <div style={{
        display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap',
      }}>
        <select
          value={categoryFilter}
          onChange={e => setCategoryFilter(e.target.value)}
          style={{
            padding: '6px 10px', borderRadius: tokens.radii.md,
            background: tokens.colors.surfaceCard, border: `1px solid ${tokens.colors.border}`,
            color: tokens.colors.textStrong, fontSize: '12px',
            minWidth: 140,
          }}
        >
          <option value="">All Categories</option>
          {categories.map(cat => (
            <option key={cat} value={cat}>{cat}</option>
          ))}
        </select>

        <select
          value={levelFilter}
          onChange={e => setLevelFilter(e.target.value)}
          style={{
            padding: '6px 10px', borderRadius: tokens.radii.md,
            background: tokens.colors.surfaceCard, border: `1px solid ${tokens.colors.border}`,
            color: tokens.colors.textStrong, fontSize: '12px',
            minWidth: 100,
          }}
        >
          <option value="">All Levels</option>
          <option value="info">info</option>
          <option value="warn">warn</option>
          <option value="error">error</option>
          <option value="debug">debug</option>
        </select>

        <input
          type="text"
          placeholder="Search logs..."
          value={searchFilter}
          onChange={e => setSearchFilter(e.target.value)}
          style={{
            padding: '6px 10px', borderRadius: tokens.radii.md,
            background: tokens.colors.surfaceCard, border: `1px solid ${tokens.colors.border}`,
            color: tokens.colors.textStrong, fontSize: '12px',
            flex: 1, minWidth: 180,
          }}
        />
      </div>

      {/* Stats Bar */}
      <div style={{
        display: 'flex', gap: 12, marginBottom: 16, flexWrap: 'wrap',
      }}>
        {(['info', 'warn', 'error', 'debug'] as const).map(level => (
          <div key={level} style={{
            display: 'flex', alignItems: 'center', gap: 6,
            padding: '4px 10px', borderRadius: tokens.radii.md,
            background: tokens.colors.surfaceCard, border: `1px solid ${tokens.colors.border}`,
            fontSize: '12px',
          }}>
            <span style={{
              width: 8, height: 8, borderRadius: '50%',
              background: LEVEL_COLORS[level],
              display: 'inline-block',
            }} />
            <span style={{ color: tokens.colors.textSecondary }}>{level}:</span>
            <span style={{ color: tokens.colors.textStrong, fontWeight: 600 }}>{stats[level] ?? 0}</span>
          </div>
        ))}
      </div>

      {/* Log List */}
      <div style={{
        background: tokens.colors.surfaceCard, borderRadius: tokens.radii.lg,
        border: `1px solid ${tokens.colors.border}`,
        overflow: 'hidden',
      }}>
        {logs.length === 0 && !loading ? (
          <div style={{ textAlign: 'center', padding: '48px 24px' }}>
            <div style={{ fontSize: 18, fontWeight: 700, color: tokens.colors.textPrimary, marginBottom: 8 }}>No logs found</div>
            <div style={{ fontSize: 13, color: tokens.colors.textSecondary }}>Logs will appear here as the system processes requests.</div>
          </div>
        ) : (
          <div style={{ maxHeight: 'calc(100vh - 280px)', overflowY: 'auto' }}>
            {logs.map((log, index) => {
              const bgColor = index % 2 === 0 ? tokens.colors.surfaceCard : tokens.colors.surfaceSubtle;
              const levelColor = LEVEL_COLORS[log.level] || tokens.colors.textSecondary;
              const hasMeta = log.meta && Object.keys(log.meta).length > 0;
              const isExpanded = expandedRows.has(index);

              return (
                <div key={index}>
                  <div
                    style={{
                      display: 'flex', alignItems: 'flex-start', gap: 8,
                      padding: '6px 12px',
                      background: bgColor,
                      cursor: hasMeta ? 'pointer' : 'default',
                      borderLeft: `2px solid ${levelColor}20`,
                    }}
                    onClick={() => hasMeta && toggleRow(index)}
                  >
                    {/* Timestamp */}
                    <span style={{
                      fontFamily: 'monospace', fontSize: '11px',
                      color: tokens.colors.textMuted, flexShrink: 0, minWidth: 85,
                      lineHeight: '20px',
                    }}>
                      {formatTime(log.timestamp)}
                    </span>

                    {/* Level Badge */}
                    <span style={{
                      fontSize: '10px', fontWeight: 700,
                      padding: '2px 6px', borderRadius: tokens.radii.sm,
                      background: `${levelColor}20`,
                      color: levelColor,
                      textTransform: 'uppercase',
                      flexShrink: 0, minWidth: 40, textAlign: 'center',
                      lineHeight: '16px',
                    }}>
                      {log.level}
                    </span>

                    {/* Category Badge */}
                    <span style={{
                      fontSize: '10px', fontWeight: 600,
                      padding: '2px 6px', borderRadius: tokens.radii.sm,
                      background: `${tokens.colors.accent}15`,
                      color: tokens.colors.accentMid,
                      flexShrink: 0, maxWidth: 100,
                      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                      lineHeight: '16px',
                    }}>
                      {log.category}
                    </span>

                    {/* Message */}
                    <span style={{
                      fontFamily: 'monospace', fontSize: '12px',
                      color: tokens.colors.textDisabled, flex: 1,
                      lineHeight: '20px',
                      wordBreak: 'break-word',
                    }}>
                      {log.message}
                    </span>

                    {/* Meta indicator */}
                    {hasMeta && (
                      <span style={{
                        fontSize: '10px', color: tokens.colors.borderStrong,
                        flexShrink: 0, lineHeight: '20px',
                      }}>
                        {isExpanded ? '\u25BC' : '\u25B6'}
                      </span>
                    )}
                  </div>

                  {/* Expanded Meta */}
                  {hasMeta && isExpanded && (
                    <div style={{
                      padding: '8px 12px 8px 107px',
                      background: tokens.colors.surface,
                      borderLeft: `2px solid ${levelColor}20`,
                    }}>
                      <pre style={{
                        fontFamily: 'monospace', fontSize: '11px',
                        color: tokens.colors.textSecondary, margin: 0,
                        whiteSpace: 'pre-wrap', wordBreak: 'break-all',
                      }}>
                        {JSON.stringify(log.meta, null, 2)}
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
