import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api } from '../../api';
import type {
  MarketingAllocation,
  MarketingBudgetSummary,
  MarketingCampaign,
  MarketingChannel,
  MarketingPost,
  MarketingSpendRequest,
} from '../../types';
import { useAuth } from '../../contexts/AuthContext';
import { useToast } from '../../contexts/ToastContext';
import { useBoardStreamEvent } from '../../contexts/BoardStreamContext';
import { useProjects } from '../../projects/useProjects';
import { tokens } from '../../tokens';
import { BusinessPageHeader } from '../business/BusinessPageHeader';
import PageTabs from '../PageTabs';
import { Button, ConfirmDialog, ErrorState, PermissionNotice } from '../common';
import {
  activationBlocker,
  buildInbox,
  campaignStatusActions,
  campaignStatusView,
  describeCadence,
  formatDateTime,
  actionableInboxCount,
  inboxForViewer,
  isCampaignEvent,
  MARKETING_REFRESH_DEBOUNCE_MS,
  type StatusAction,
} from './marketing.logic';
import { MarketingCtxProvider, StatusPill, type MarketingChannelRef, type MarketingCtx } from './MarketingUi';
import { CampaignFormModal } from './MarketingCampaignForm';
import { contactsPath } from './MarketingCards';
import MarketingOverviewTab from './MarketingOverviewTab';
import MarketingInboxTab from './MarketingInboxTab';
import MarketingChannelsTab from './MarketingChannelsTab';
import MarketingContentTab from './MarketingContentTab';
import MarketingBudgetTab from './MarketingBudgetTab';
import MarketingAnalyticsTab from './MarketingAnalyticsTab';
import MarketingFeedbackTab from './MarketingFeedbackTab';
import MarketingAuditTab from './MarketingAuditTab';

const TAB_IDS = ['overview', 'inbox', 'channels', 'content', 'budget', 'analytics', 'feedback', 'audit'] as const;
type TabId = (typeof TAB_IDS)[number];
const TAB_LABELS: Record<TabId, string> = {
  overview: '개요',
  inbox: '승인함',
  channels: '채널',
  content: '콘텐츠',
  budget: '예산·결제',
  analytics: '분석',
  feedback: '피드백',
  audit: '감사 로그',
};
/**
 * 지출 승인 권한만 있는 사람(marketing.manage 없음)의 탭 — 돈 항목만 모인 승인함 · 예산 · 결제, 그리고 읽기 전용
 * 개요 · 감사 로그. 게시물 · 분석 · 피드백은 서버가 운영 권한에만 준다(열면 403 이라 탭을 두지 않는다).
 */
const SPEND_ONLY_TABS: TabId[] = ['overview', 'inbox', 'budget', 'audit'];

interface CampaignData {
  loaded: boolean;
  campaign: MarketingCampaign | null;
  campaignError: { status?: number; message: string } | null;
  channels: MarketingChannel[];
  posts: MarketingPost[];
  allocations: MarketingAllocation[];
  spend: MarketingSpendRequest[];
  budget: MarketingBudgetSummary | null;
  /** 일부 조회가 실패했다 — 승인함이 완전하지 않을 수 있으니 숨기지 않고 알린다. */
  partialErrors: string[];
}

const EMPTY: CampaignData = {
  loaded: false,
  campaign: null,
  campaignError: null,
  channels: [],
  posts: [],
  allocations: [],
  spend: [],
  budget: null,
  partialErrors: [],
};

const PART_LABELS = ['캠페인', '채널', '초안', '승인된 글', '예산 편성', '대기 지출', '결과 불명 지출', '승인된 지출', '예산 요약'];

/**
 * 승인함과 탭들이 같이 쓰는 데이터. 승인함은 상태별 조회로 채운다 — 최근 목록(limit)만 보면 오래 기다린
 * 결과 불명 결제나 수동 결제 기록이 목록 밖으로 밀려 사람 눈에서 사라진다. 캠페인 · 채널 · 돈은 두 권한 모두
 * 읽을 수 있고, 게시물은 운영 권한(manage)에만 묻는다 — 그 사람이 부를 수 없는 경로는 아예 부르지 않는다.
 */
function useCampaignData(campaignId: string, canManage: boolean, canViewMoney: boolean, refreshKey: number): CampaignData {
  const [data, setData] = useState<CampaignData>(EMPTY);
  const seq = useRef(0);
  const identity = useRef('');
  useEffect(() => {
    if (!campaignId || !canViewMoney) return;
    // 다른 캠페인 · 다른 권한으로 바뀌면 처음부터(로딩) — 같은 화면의 갱신(refreshKey)은 보이던 것을 둔 채 바꾼다.
    const key = `${campaignId}|${canManage}|${canViewMoney}`;
    if (identity.current !== key) {
      identity.current = key;
      setData(EMPTY);
    }
    const mine = ++seq.current;
    const none = <T,>(value: T) => Promise.resolve(value);
    const posts = (status: string) => api.listMarketingPosts(campaignId, { status, limit: 200 });
    const spend = (status: string) => api.listMarketingSpendRequests(campaignId, { status, limit: 200 });
    void Promise.allSettled([
      api.getMarketingCampaign(campaignId),
      api.listMarketingChannels(campaignId),
      canManage ? posts('draft') : none([] as MarketingPost[]),
      canManage ? posts('approved') : none([] as MarketingPost[]),
      canViewMoney ? api.listMarketingAllocations(campaignId) : none([] as MarketingAllocation[]),
      canViewMoney ? spend('pending') : none([] as MarketingSpendRequest[]),
      canViewMoney ? spend('unknown') : none([] as MarketingSpendRequest[]),
      canViewMoney ? spend('approved') : none([] as MarketingSpendRequest[]),
      canViewMoney ? api.getMarketingBudget(campaignId) : none(null),
    ]).then((results) => {
      if (mine !== seq.current) return;
      const value = <T,>(i: number, fallback: T): T => (results[i].status === 'fulfilled' ? (results[i] as PromiseFulfilledResult<T>).value ?? fallback : fallback);
      const campaignResult = results[0];
      let campaignError: CampaignData['campaignError'] = null;
      if (campaignResult.status === 'rejected') {
        const err = campaignResult.reason as { status?: number; message?: string };
        campaignError = { status: err?.status, message: err?.message || '캠페인을 불러오지 못했습니다' };
      }
      const partialErrors = results
        .map((r, i) => (i > 0 && r.status === 'rejected' ? `${PART_LABELS[i]}: ${(r.reason as Error)?.message || '불러오지 못함'}` : null))
        .filter((m): m is string => !!m);
      setData({
        loaded: true,
        partialErrors,
        campaign: value<MarketingCampaign | null>(0, null),
        campaignError,
        channels: value<MarketingChannel[]>(1, []),
        posts: [...value<MarketingPost[]>(2, []), ...value<MarketingPost[]>(3, [])],
        allocations: value<MarketingAllocation[]>(4, []),
        spend: [...value<MarketingSpendRequest[]>(5, []), ...value<MarketingSpendRequest[]>(6, []), ...value<MarketingSpendRequest[]>(7, [])],
        budget: value<MarketingBudgetSummary | null>(8, null),
      });
    });
  }, [campaignId, canManage, canViewMoney, refreshKey]);
  return data;
}

export default function MarketingCampaignPage() {
  const { campaignId = '' } = useParams<{ campaignId: string }>();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { user, currentAccountId, hasPermission } = useAuth();
  const { showToast } = useToast();
  const canManage = hasPermission('marketing.manage');
  const canApproveSpend = hasPermission('marketing.approve_spend');
  const canViewMoney = canManage || canApproveSpend;
  const spendOnly = !canManage && canApproveSpend;

  const [refreshKey, setRefreshKey] = useState(0);
  const data = useCampaignData(campaignId, canManage, canViewMoney, refreshKey);
  const { campaign, budget } = data;
  const { projects } = useProjects(canViewMoney ? currentAccountId || '' : '');

  const refresh = useCallback(() => setRefreshKey((k) => k + 1), []);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleRefresh = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => { timer.current = null; refresh(); }, MARKETING_REFRESH_DEBOUNCE_MS);
  }, [refresh]);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  useBoardStreamEvent('marketing_update', (event) => {
    if (isCampaignEvent(event, campaignId)) scheduleRefresh();
  });

  const viewer = useMemo(() => ({ canManage, canApproveSpend }), [canManage, canApproveSpend]);
  const inbox = useMemo(
    () => inboxForViewer(
      buildInbox({ channels: data.channels, posts: data.posts, allocations: data.allocations, spendRequests: data.spend }),
      viewer,
    ),
    [data.channels, data.posts, data.allocations, data.spend, viewer],
  );
  // 탭 · 개요의 수는 사이드바 배지와 같은 규칙(이 사람이 처리할 수 있는 것만) — 서버 /marketing/inbox 의 actionable.
  const pendingForMe = actionableInboxCount(inbox, viewer);

  const channelRefs = useMemo(() => {
    const map = new Map<string, MarketingChannelRef>();
    for (const c of budget?.channels || []) map.set(c.channel_id, { id: c.channel_id, name: c.name, platform: c.platform, status: c.status });
    for (const c of data.channels) {
      map.set(c.id, {
        id: c.id,
        name: c.name,
        platform: c.platform,
        kind: c.kind,
        status: c.status,
        target: c.target,
        guidelines: c.guidelines,
        rules_summary: c.rules_summary,
        rules_url: c.rules_url,
        list_name: c.email?.list_name,
      });
    }
    return map;
  }, [data.channels, budget]);

  const ctx: MarketingCtx = useMemo(() => ({
    campaign,
    campaignId,
    accountId: campaign?.account_id || '',
    currency: campaign?.currency || budget?.currency || 'KRW',
    dualThresholdMinor: campaign?.dual_approval_threshold_minor ?? budget?.caps.dual_approval_threshold_minor ?? 0,
    disclosure: campaign?.disclosure || '',
    channels: channelRefs,
    canManage,
    canApproveSpend,
    userId: user?.id || '',
    refresh,
    notify: (message, type = 'success') => showToast(message, type),
  }), [campaign, campaignId, budget, channelRefs, canManage, canApproveSpend, user?.id, refresh, showToast]);

  const [editing, setEditing] = useState(false);
  const [pendingStatus, setPendingStatus] = useState<StatusAction | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [busy, setBusy] = useState(false);

  const requested = (searchParams.get('tab') || '') as TabId;
  const allowedTabs: TabId[] = spendOnly ? SPEND_ONLY_TABS : [...TAB_IDS];
  const tab: TabId = allowedTabs.includes(requested) ? requested : allowedTabs[0];

  if (!canViewMoney) {
    return (
      <div style={{ padding: 24 }}>
        <PermissionNotice title="마케팅 권한이 필요합니다" message="캠페인을 보려면 marketing.manage 또는 marketing.approve_spend 권한이 있어야 합니다." />
      </div>
    );
  }
  if (!data.loaded) {
    return <div style={{ padding: 24, color: tokens.colors.textMuted, fontSize: 13 }}>캠페인을 불러오는 중…</div>;
  }
  if (data.campaignError) {
    return (
      <div style={{ padding: 24 }}>
        <ErrorState
          title={data.campaignError.status === 404 ? '캠페인을 찾을 수 없습니다' : '캠페인을 열 수 없습니다'}
          message={data.campaignError.message}
          onRetry={refresh}
        />
        <div style={{ textAlign: 'center' }}><Link to="/marketing" style={{ color: tokens.colors.accentLight, fontSize: 13 }}>← 캠페인 목록</Link></div>
      </div>
    );
  }

  const runStatus = async (action: StatusAction) => {
    if (!campaign) return;
    setBusy(true);
    try {
      await api.setMarketingCampaignStatus(campaign.id, action.to);
      showToast(`캠페인을 ${campaignStatusView(action.to).label} 상태로 바꿨습니다`, 'success');
      setPendingStatus(null);
      refresh();
    } catch (err) {
      showToast((err as Error)?.message || '상태를 바꾸지 못했습니다', 'error');
    } finally {
      setBusy(false);
    }
  };

  const runNow = async () => {
    if (!campaign) return;
    setBusy(true);
    try {
      const cycle = await api.runMarketingCycle(campaign.id);
      showToast(`사이클 #${cycle.cycle_no} 을 시작했습니다`, 'success');
      refresh();
    } catch (err) {
      showToast((err as Error)?.message || '사이클을 시작하지 못했습니다', 'error');
    } finally {
      setBusy(false);
    }
  };

  const runDelete = async () => {
    if (!campaign) return;
    setBusy(true);
    try {
      await api.deleteMarketingCampaign(campaign.id);
      showToast(`캠페인 "${campaign.name}" 을 삭제했습니다`, 'success');
      navigate('/marketing');
    } catch (err) {
      const e = err as Error & { status?: number };
      setDeleting(false);
      showToast(e.status === 409
        ? `${e.message} — 돈이 오간 캠페인은 지울 수 없습니다. 보관하세요.`
        : e.message || '삭제하지 못했습니다', 'error');
    } finally {
      setBusy(false);
    }
  };

  const statusActions = campaign && canManage ? campaignStatusActions(campaign.status) : [];
  const blocker = campaign ? activationBlocker(campaign) : null;
  const tabs = allowedTabs.map((id) => ({
    id,
    label: id === 'inbox' && pendingForMe ? `${TAB_LABELS[id]} (${pendingForMe})` : TAB_LABELS[id],
    to: `?tab=${id}`,
  }));
  const project = campaign?.project_id ? projects.find((p) => p.id === campaign.project_id) || null : null;
  // 연락처는 운영 권한의 일이다(서버가 manage 에만 준다).
  const hasEmail = canManage && !!campaign && (campaign.capabilities.includes('email') || data.channels.some((c) => c.kind === 'email'));

  const statusConfirmMessage = (action: StatusAction): string => {
    if (action.to === 'paused') return '일시정지하면 사이클이 멈추고, 승인 대기 중인 지출 요청은 취소됩니다. 다시 시작하면 다음 주기부터 돕니다.';
    if (action.to === 'archived') return '보관하면 사이클이 멈추고 승인 대기 중인 지출 요청은 취소됩니다. 기록(원장 · 감사)은 남고, 보관 해제하면 일시정지 상태로 돌아옵니다.';
    if (action.to === 'active') return '시작하면 캠페인 에이전트가 주기마다 깨어나 일합니다. 돈 · 외부 발신 · 채널 개설은 여전히 사람이 승인합니다.';
    return `${action.label} 합니다.`;
  };

  return (
    <MarketingCtxProvider value={ctx}>
      <div className="business-marketing-page">
        <BusinessPageHeader
          title={campaign ? campaign.name : 'Marketing'}
          description={campaign
            ? `${describeCadence(campaign)}${campaign.status === 'active' && campaign.next_cycle_at ? ` · 다음 사이클 ${formatDateTime(campaign.next_cycle_at)}` : ''} · 사이클 ${campaign.cycle_count}회${spendOnly ? ' · 지출 승인 권한으로 열었습니다(돈 항목만)' : ''}`
            : undefined}
          status={campaign && <StatusPill testId="marketing-campaign-status" view={campaignStatusView(campaign.status)} />}
          actions={campaign && canManage && <Button variant="secondary" disabled={busy || campaign.status !== 'active'} title={campaign.status !== 'active' ? '진행 중인 캠페인만 실행할 수 있습니다' : '예약과 같은 경로로 사이클을 지금 시작합니다'} onClick={() => void runNow()}>지금 실행</Button>}
          moreActions={close => (
            <>
              <Link to="/marketing" onClick={close}>← 목록</Link>
              {hasEmail && campaign && (
                <Link to={contactsPath(campaign.account_id, { campaignId: campaign.id })} onClick={close}>연락처</Link>
              )}
              {statusActions.map((action) => {
                const blocked = action.to === 'active' ? blocker : null;
                return (
                  <Button
                    key={action.to}
                    size="sm"
                    variant={action.danger ? 'ghost' : action.to === 'active' ? 'primary' : 'secondary'}
                    disabled={busy || !!blocked}
                    title={blocked || undefined}
                    onClick={() => { close(); setPendingStatus(action); }}
                  >
                    {action.label}
                  </Button>
                );
              })}
              {campaign && canManage && <Button size="sm" variant="secondary" disabled={busy} onClick={() => { close(); setEditing(true); }}>설정</Button>}
              {campaign && canManage && <Button size="sm" variant="danger" disabled={busy} onClick={() => { close(); setDeleting(true); }}>삭제</Button>}
            </>
          )}
        />
        <PageTabs tabs={tabs} activeId={tab} />
        <div role="tabpanel" aria-label={TAB_LABELS[tab]} style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: 24 }}>
          {data.partialErrors.length > 0 && (
            <div role="alert" data-testid="marketing-partial-errors" style={{ marginBottom: 14, fontSize: 12, color: tokens.colors.warningLight, lineHeight: 1.5 }}>
              일부를 불러오지 못해 승인함이 완전하지 않을 수 있습니다 — {data.partialErrors.join(' · ')}
              {' '}<Button size="sm" variant="ghost" onClick={refresh}>다시 시도</Button>
            </div>
          )}
          {tab === 'overview' && campaign && (
            <MarketingOverviewTab
              campaign={campaign}
              inbox={inbox}
              pending={pendingForMe}
              project={project}
              refreshKey={refreshKey}
              onOpenInbox={() => navigate('?tab=inbox')}
            />
          )}
          {tab === 'inbox' && <MarketingInboxTab inbox={inbox} budget={budget} />}
          {tab === 'channels' && <MarketingChannelsTab channels={data.channels} />}
          {tab === 'content' && <MarketingContentTab refreshKey={refreshKey} />}
          {tab === 'budget' && <MarketingBudgetTab budget={budget} allocations={data.allocations} refreshKey={refreshKey} />}
          {tab === 'analytics' && <MarketingAnalyticsTab refreshKey={refreshKey} />}
          {tab === 'feedback' && <MarketingFeedbackTab refreshKey={refreshKey} />}
          {tab === 'audit' && <MarketingAuditTab refreshKey={refreshKey} />}
        </div>
      </div>

      {editing && campaign && (
        <CampaignFormModal
          mode="edit"
          campaign={campaign}
          canApproveSpend={canApproveSpend}
          notify={(m, t) => showToast(m, t)}
          onClose={() => setEditing(false)}
          onSaved={() => { setEditing(false); refresh(); }}
        />
      )}
      <ConfirmDialog
        isOpen={!!pendingStatus}
        title={pendingStatus ? `캠페인 ${pendingStatus.label}` : ''}
        message={pendingStatus ? statusConfirmMessage(pendingStatus) : undefined}
        confirmLabel={busy ? '처리 중…' : pendingStatus?.label || '확인'}
        cancelLabel="취소"
        danger={!!pendingStatus?.danger}
        onConfirm={() => { if (pendingStatus && !busy) void runStatus(pendingStatus); }}
        onCancel={() => setPendingStatus(null)}
      />
      <ConfirmDialog
        isOpen={deleting}
        title="캠페인을 삭제할까요?"
        message={campaign ? `"${campaign.name}" 과 그 채널 · 콘텐츠 · 편성을 지웁니다. 지출 요청이나 원장이 있으면 지울 수 없고 보관해야 합니다. 감사 로그는 남습니다.` : undefined}
        confirmLabel={busy ? '삭제 중…' : '삭제'}
        cancelLabel="취소"
        danger
        onConfirm={() => { if (!busy) void runDelete(); }}
        onCancel={() => setDeleting(false)}
      />
    </MarketingCtxProvider>
  );
}
