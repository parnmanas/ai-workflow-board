import React, { useState, useEffect, useRef } from 'react';
import { api } from '../../api';
import { useAuth } from '../../contexts/AuthContext';
import { tokens } from '../../tokens';

interface AgentSessionRow {
  id: string;
  name: string;
  // Phase 3 Plan 03-02: server now returns boolean (bool-coerced from DB int) per
  // the extended dashboard contract. The row's truthy checks work with either.
  is_online: boolean;
  last_seen_at: string | null;
  connected_at: string | null;
  workspace_id: string;
  pending_trigger_count: number;
}

export default function AgentSessionDashboard() {
  const { user } = useAuth();
  const [rows, setRows] = useState<AgentSessionRow[]>([]);
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const workspaceId: string = (user as any)?.workspace_id ?? '';

  const load = async () => {
    if (!workspaceId) return;
    try {
      const data = await api.getAgentDashboard(workspaceId);
      setRows(data);
      setLastRefresh(new Date());
    } catch {
      // silently ignore polling errors — stale data is shown
    }
  };

  useEffect(() => {
    load();
    intervalRef.current = setInterval(load, 5000);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [workspaceId]);

  const formatTime = (iso: string | null): string => {
    if (!iso) return '—';
    const d = new Date(iso);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  };

  return (
    <div>
      {/* Header row */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <h3 style={{ fontSize: '15px', fontWeight: 600, color: tokens.colors.textDisabled }}>
          Agent Sessions ({rows.length})
        </h3>
        {lastRefresh && (
          <span style={{ fontSize: '11px', color: tokens.colors.borderStrong }}>
            Last refresh: {formatTime(lastRefresh.toISOString())}
          </span>
        )}
      </div>

      {rows.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '48px 24px' }}>
          <div style={{ fontSize: 18, fontWeight: 700, color: tokens.colors.textPrimary, marginBottom: 8 }}>No sessions yet</div>
          <div style={{ fontSize: 13, color: tokens.colors.textSecondary }}>Agent sessions will appear here once agents connect.</div>
        </div>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
          <thead>
            <tr>
              {['Agent', 'Status', 'Last Seen', 'Pending Triggers'].map(h => (
                <th key={h} style={{
                  textAlign: 'left', padding: '8px 10px', borderBottom: `1px solid ${tokens.colors.border}`,
                  color: tokens.colors.textMuted, fontSize: '11px', fontWeight: 600, textTransform: 'uppercase',
                }}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map(row => (
              <tr key={row.id} style={{ borderBottom: `1px solid ${tokens.colors.surfaceCard}` }}>
                {/* Agent name */}
                <td style={{ padding: '10px 10px', color: tokens.colors.textStrong, fontWeight: 500 }}>
                  {row.name}
                </td>
                {/* Status */}
                <td style={{ padding: '10px 10px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span style={{
                      width: 8, height: 8, borderRadius: '50%',
                      background: row.is_online ? tokens.colors.success : tokens.colors.borderStrong,
                      flexShrink: 0,
                    }} />
                    <span style={{ color: row.is_online ? tokens.colors.successPale : tokens.colors.textSecondary, fontSize: '12px' }}>
                      {row.is_online ? 'Online' : 'Offline'}
                    </span>
                  </div>
                </td>
                {/* Last seen */}
                <td style={{ padding: '10px 10px', color: tokens.colors.textMuted, fontSize: '12px' }}>
                  {formatTime(row.last_seen_at)}
                </td>
                {/* Pending triggers */}
                <td style={{ padding: '10px 10px' }}>
                  {row.pending_trigger_count > 0 ? (
                    <span style={{
                      background: tokens.colors.danger, color: 'white', fontSize: '11px', fontWeight: 700,
                      borderRadius: 10, padding: '2px 8px', minWidth: 20, display: 'inline-block',
                      textAlign: 'center',
                    }}>
                      {row.pending_trigger_count}
                    </span>
                  ) : (
                    <span style={{ color: tokens.colors.border, fontSize: '12px' }}>—</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
