import React, { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api } from '../../api';
import { tokens } from '../../tokens';
import type { MemoryHostInfo } from '../../types';
import { EmptyState, ErrorState } from '../common';
import PageHeader from '../PageHeader';
import MemoryHostView from './MemoryHostView';
import { relativeTime } from './memoryState.logic';

/**
 * Memory — Runtime Host 장비에 있는 LLM CLI 의 메모리 파일(docs/cli-memory.md).
 *   /memory               메모리를 볼 수 있는 Runtime Host
 *   /memory/:managerId    그 장비의 CLI 별 메모리 — 분석 · 편집 · 다른 CLI 에 적용 · import/export
 */
export default function MemoryPage() {
  const { managerId = '' } = useParams();
  const navigate = useNavigate();
  const [hosts, setHosts] = useState<MemoryHostInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setHosts(await api.listMemoryHosts());
    } catch (err: any) {
      setError(err?.message || 'Failed to list Runtime Hosts.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  // 호스트가 하나뿐이면 목록을 건너뛴다.
  useEffect(() => {
    if (!managerId && !loading && hosts.length === 1 && hosts[0].supported) navigate(`/memory/${encodeURIComponent(hosts[0].manager_id)}`, { replace: true });
  }, [managerId, loading, hosts, navigate]);

  if (managerId) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
        <MemoryHostView key={managerId} managerId={managerId} hosts={hosts} />
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <PageHeader
        title="Memory"
        description="What each LLM CLI remembers on your Runtime Hosts — CLAUDE.md, AGENTS.md, auto memory, Hermes notes. Analyze, edit, sync across CLIs, import and export."
      />
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 20 }}>
        {error ? (
          <ErrorState message={error} onRetry={() => void load()} />
        ) : loading && hosts.length === 0 ? (
          <div style={{ color: tokens.colors.textMuted, fontSize: 13 }}>Loading Runtime Hosts…</div>
        ) : hosts.length === 0 ? (
          <EmptyState title="No Runtime Host is connected" description="Memory lives on machines running awb-agent-manager. Pair one from Runtime Hosts." />
        ) : (
          <div style={{ display: 'grid', gap: 10, gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))' }}>
            {hosts.map((host) => (
              <div
                key={host.manager_id}
                style={{ border: `1px solid ${tokens.colors.border}`, borderRadius: tokens.radii.lg, background: tokens.colors.surfaceCard, padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 8, opacity: host.supported ? 1 : 0.7 }}
              >
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                  <span style={{ fontSize: 14, fontWeight: 600, color: tokens.colors.textPrimary }}>{host.name}</span>
                  <span style={{ fontSize: 11, color: tokens.colors.textMuted }}>{host.hostname}{host.platform ? ` · ${host.platform}` : ''}</span>
                  <span style={{ marginLeft: 'auto', fontSize: 10.5, color: tokens.colors.textMuted }}>seen {relativeTime(host.last_seen_at)}</span>
                </div>
                <div style={{ fontSize: 12, color: tokens.colors.textSecondary }}>
                  {host.supported
                    ? `${host.project_count} project folder${host.project_count === 1 ? '' : 's'} on this host`
                    : `agent-manager ${host.plugin_version} has no memory support — update it from Runtime Hosts.`}
                </div>
                {host.supported && (
                  <div>
                    <button
                      type="button"
                      onClick={() => navigate(`/memory/${encodeURIComponent(host.manager_id)}`)}
                      style={{
                        border: `1px solid ${tokens.colors.accent}66`, background: 'transparent', color: tokens.colors.accentSubtle,
                        borderRadius: tokens.radii.md, padding: '5px 14px', fontSize: 12, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit',
                      }}
                    >
                      Open memory →
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
