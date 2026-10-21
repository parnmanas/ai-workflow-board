import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../../api';
import type { MarketingCampaign } from '../../types';
import { useAuth } from '../../contexts/AuthContext';
import { useToast } from '../../contexts/ToastContext';
import { useBoardStreamEvent } from '../../contexts/BoardStreamContext';
import { useMarketingInbox } from '../../hooks/useMarketingInbox';
import { tokens } from '../../tokens';
import PageHeader from '../PageHeader';
import { Button, EmptyState, ErrorState, PermissionNotice } from '../common';
import { relativeTime } from '../../utils/time';
import { CAPABILITY_LABELS, MARKETING_REFRESH_DEBOUNCE_MS, campaignStatusView, describeCadence, formatDateTime } from './marketing.logic';
import { CampaignFormModal } from './MarketingCampaignForm';
import { Chip, StatusPill, tableStyles } from './MarketingUi';

/**
 * Marketing — 에이전트가 돌리는 제품 마케팅 캠페인(docs/marketing.md). 목록은 접근 가능한 계정의 캠페인을 합치고,
 * 소유 계정 선택기는 두지 않는다. 사람이 하는 일은 캠페인 안의 승인함에 모인다.
 */
export default function MarketingPage() {
  const { hasPermission } = useAuth();
  const { showToast } = useToast();
  const navigate = useNavigate();
  const canManage = hasPermission('marketing.manage');
  const canApproveSpend = hasPermission('marketing.approve_spend');
  // 목록은 두 권한 모두 읽는다. 만들기 · 연락처는 운영 권한(manage)의 일이다.
  const canView = canManage || canApproveSpend;
  const [campaigns, setCampaigns] = useState<MarketingCampaign[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  // 캠페인마다 "승인 대기 N" — 사이드바 배지와 같은 응답(이 사람이 처리할 수 있는 것만 센다).
  const { summary: inbox } = useMarketingInbox(canView);
  const pendingByCampaign = new Map((inbox?.campaigns || []).map((c) => [c.campaign_id, c.actionable]));

  const load = useCallback(async () => {
    if (!canView) return;
    try {
      setCampaigns(await api.listMarketingCampaigns());
      setError(null);
    } catch (err) {
      setError((err as Error)?.message || '캠페인 목록을 불러오지 못했습니다');
    }
  }, [canView]);

  useEffect(() => { void load(); }, [load]);

  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  useBoardStreamEvent('marketing_update', (event: { kind?: string; action?: string }) => {
    // 목록에 보이는 것(이름 · 상태 · 주기 · 사이클 수)만 바뀌는 이벤트에 다시 읽는다.
    if (event?.kind !== 'campaign' && event?.kind !== 'cycle') return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => { timer.current = null; void load(); }, MARKETING_REFRESH_DEBOUNCE_MS);
  });

  if (!canView) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
        <PageHeader title="Marketing" description="에이전트가 돌리는 제품 마케팅 — 돈 · 외부 발신 · 채널 개설은 사람이 정합니다." />
        <div style={{ padding: 24 }}>
          <PermissionNotice
            title="마케팅 권한이 필요합니다"
            message="캠페인을 보려면 marketing.manage 또는 marketing.approve_spend 권한이 필요합니다."
          />
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <PageHeader
        title="Marketing"
        description="캠페인 에이전트가 주기마다 채널을 찾고 글 · 메일 · 예산을 제안합니다. 돈 · 외부 발신 · 채널 개설은 사람이 승인합니다."
        actions={canManage ? (
          <>
            <Link to="/marketing/contacts" style={{ fontSize: 12, color: tokens.colors.accentLight }}>메일 연락처</Link>
            <Button variant="primary" size="md" onClick={() => setCreating(true)}>+ 새 캠페인</Button>
          </>
        ) : undefined}
      />
      <div style={{ flex: 1, overflow: 'auto', minHeight: 0, padding: 24 }}>
        {campaigns === null && !error ? (
          <div style={{ fontSize: 13, color: tokens.colors.textSecondary }}>불러오는 중…</div>
        ) : error && campaigns === null ? (
          <ErrorState message={error} onRetry={() => void load()} />
        ) : !campaigns || campaigns.length === 0 ? (
          <EmptyState
            title="아직 캠페인이 없습니다"
            description={canManage
              ? '제품 브리프와 목표를 적고, 켤 기능과 캠페인 에이전트를 고르세요. 만든 캠페인은 초안 상태로 시작합니다.'
              : '캠페인은 운영 권한(marketing.manage)이 있는 사람이 만듭니다. 지출 요청이 생기면 여기와 사이드바에 표시됩니다.'}
            action={canManage ? <Button variant="primary" onClick={() => setCreating(true)}>+ 새 캠페인</Button> : undefined}
          />
        ) : (
          <div style={{ border: `1px solid ${tokens.colors.border}`, borderRadius: tokens.radii.md, overflow: 'auto', background: tokens.colors.surfaceCard }}>
            <table style={tableStyles.table} data-testid="marketing-campaign-list">
              <thead>
                <tr>
                  <th style={tableStyles.th}>캠페인</th>
                  <th style={tableStyles.th}>승인 대기</th>
                  <th style={tableStyles.th}>상태</th>
                  <th style={tableStyles.th}>기능</th>
                  <th style={tableStyles.th}>주기</th>
                  <th style={tableStyles.th}>다음 사이클</th>
                  <th style={{ ...tableStyles.th, ...tableStyles.num }}>사이클</th>
                  <th style={tableStyles.th}>수정</th>
                </tr>
              </thead>
              <tbody>
                {campaigns.map((c) => (
                  <tr
                    key={c.id}
                    data-testid={`marketing-campaign-row-${c.id}`}
                    onClick={() => navigate(`/marketing/${encodeURIComponent(c.id)}`)}
                    style={{ cursor: 'pointer' }}
                  >
                    <td style={tableStyles.td}>
                      <Link
                        to={`/marketing/${encodeURIComponent(c.id)}`}
                        onClick={(e) => e.stopPropagation()}
                        style={{ color: tokens.colors.textPrimary, fontWeight: 600, textDecoration: 'none' }}
                      >
                        {c.name}
                      </Link>
                      {c.goal && <div style={{ fontSize: 11, color: tokens.colors.textMuted, marginTop: 2, maxWidth: 360, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.goal}</div>}
                    </td>
                    <td style={tableStyles.td} data-testid={`marketing-campaign-pending-${c.id}`}>
                      {pendingByCampaign.get(c.id)
                        ? <StatusPill view={{ label: `승인 대기 ${pendingByCampaign.get(c.id)}`, tone: 'attention' }} />
                        : <span style={{ color: tokens.colors.textMuted }}>—</span>}
                    </td>
                    <td style={tableStyles.td}><StatusPill view={campaignStatusView(c.status)} /></td>
                    <td style={tableStyles.td}>
                      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', maxWidth: 360 }}>
                        {c.capabilities.length
                          ? c.capabilities.map((cap) => <Chip key={cap}>{CAPABILITY_LABELS[cap] || cap}</Chip>)
                          : <span style={{ color: tokens.colors.textMuted }}>없음</span>}
                      </div>
                    </td>
                    <td style={tableStyles.td}>{describeCadence(c)}</td>
                    <td style={tableStyles.td} title={c.next_cycle_at ? formatDateTime(c.next_cycle_at) : undefined}>
                      {c.status === 'active' && c.next_cycle_at ? formatDateTime(c.next_cycle_at) : '—'}
                    </td>
                    <td style={{ ...tableStyles.td, ...tableStyles.num }}>{c.cycle_count}</td>
                    <td style={tableStyles.td}>{relativeTime(c.updated_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      {creating && canManage && (
        <CampaignFormModal
          mode="create"
          canApproveSpend={canApproveSpend}
          notify={(m, t) => showToast(m, t)}
          onClose={() => setCreating(false)}
          onSaved={(saved) => { setCreating(false); navigate(`/marketing/${encodeURIComponent(saved.id)}`); }}
        />
      )}
    </div>
  );
}
