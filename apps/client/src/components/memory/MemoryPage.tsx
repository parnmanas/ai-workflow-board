import React, { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import { ProjectMemoryPanel, SharedMemoryPanel } from '../knowledge/KnowledgeMemoryPanels';
import { api } from '../../api';
import { tokens } from '../../tokens';
import type { MemoryHostInfo } from '../../types';
import { EmptyState, ErrorState } from '../common';
import PageHeader from '../PageHeader';
import MemoryHostView from './MemoryHostView';
import { relativeTime } from './memoryState.logic';

type MemoryTab = 'shared' | 'projects' | 'hosts';

/**
 * Memory — Agent 가 아는 것(Knowledge). 범위로 정리한다:
 *   /memory?tab=shared     공용 메모리 — 계정의 모든 Agent(docs/skills.md "Knowledge")
 *   /memory?tab=projects   프로젝트 메모리 — 그 프로젝트의 작업(Project.instructions)
 *   /memory?tab=hosts      호스트 파일 — Runtime Host 의 LLM CLI 메모리 파일(docs/cli-memory.md)
 *   /memory/:managerId     그 장비의 CLI 별 메모리 — 분석 · 편집 · 다른 CLI 에 적용 · import/export
 */
export default function MemoryPage() {
  const { managerId = '' } = useParams();
  const navigate = useNavigate();
  const { hasPermission } = useAuth();
  const canHostFiles = hasPermission('cli_memory.use');
  const [searchParams, setSearchParams] = useSearchParams();
  const requested = searchParams.get('tab') as MemoryTab | null;
  const tab: MemoryTab = requested === 'projects' || (requested === 'hosts' && canHostFiles) ? requested : 'shared';
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

  useEffect(() => { if (canHostFiles) void load(); else setLoading(false); }, [load, canHostFiles]);

  // 호스트 파일 탭에서 호스트가 하나뿐이면 목록을 건너뛴다.
  useEffect(() => {
    if (!managerId && tab === 'hosts' && !loading && hosts.length === 1 && hosts[0].supported) navigate(`/memory/${encodeURIComponent(hosts[0].manager_id)}`, { replace: true });
  }, [managerId, tab, loading, hosts, navigate]);

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
        description="What agents know — shared by every agent, per project, and the memory files each LLM CLI keeps on your Runtime Hosts."
      />
      <div style={{ display: 'flex', gap: 4, padding: '8px 20px', borderBottom: `1px solid ${tokens.colors.border}` }}>
        {([
          ['shared', 'Shared'],
          ['projects', 'Projects'],
          ...(canHostFiles ? [['hosts', 'Host files']] : []),
        ] as Array<[MemoryTab, string]>).map(([key, label]) => (
          <button
            key={key}
            type="button"
            onClick={() => { const next = new URLSearchParams(searchParams); next.set('tab', key); setSearchParams(next, { replace: true }); }}
            style={{
              padding: '5px 14px', borderRadius: tokens.radii.md, cursor: 'pointer', fontFamily: 'inherit', fontSize: 12.5, fontWeight: 600,
              border: `1px solid ${tab === key ? tokens.colors.accent : tokens.colors.border}`,
              background: tab === key ? tokens.colors.badgeAgentBg : 'transparent',
              color: tab === key ? tokens.colors.accentSubtle : tokens.colors.textSecondary,
            }}
          >
            {label}
          </button>
        ))}
      </div>
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 20 }}>
        {tab === 'shared' ? (
          <SharedMemoryPanel />
        ) : tab === 'projects' ? (
          <ProjectMemoryPanel />
        ) : error ? (
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
