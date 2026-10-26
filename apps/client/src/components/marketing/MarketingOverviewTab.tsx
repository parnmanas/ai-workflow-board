import { t as translate } from '../../i18n/core';
import { useLocale } from '../../i18n/react';
import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api';
import type { MarketingCampaign, MarketingCycle, Project } from '../../types';
import { tokens } from '../../tokens';
import { Button } from '../common';
import {
  BUDGET_PERIOD_LABELS,
  CAPABILITY_DESCRIPTIONS,
  CAPABILITY_LABELS,
  LIMIT_KEYS,
  LIMIT_LABELS,
  MARKETING_CAPABILITIES,
  PAYMENT_PROVIDER_LABELS,
  activationBlocker,
  cycleStatusView,
  describeCadence,
  formatDateTime,
  formatMinor,
  type InboxSummary,
} from './marketing.logic';
import { RuntimeSpecLabel } from './MarketingCampaignForm';
import { Chip, Hint, KeyValue, Panel, Prose, StatusPill, useMarketingCtx } from './MarketingUi';

/** 개요 — 브리프 · 기능 · 에이전트 · 주기 · 규칙, 그리고 사이클 기록(각 사이클의 방으로 간다). */
export default function MarketingOverviewTab({
  campaign,
  inbox,
  pending,
  project,
  refreshKey,
  onOpenInbox,
}: {
  campaign: MarketingCampaign;
  inbox: InboxSummary;
  /** 이 사람이 처리할 수 있는 승인 대기 수(사이드바 배지와 같은 규칙). */
  pending: number;
  project: Project | null;
  refreshKey: number;
  onOpenInbox(): void;
}) {
  useLocale();
  const ctx = useMarketingCtx();
  const [cycles, setCycles] = useState<MarketingCycle[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.listMarketingCycles(campaign.id)
      .then((rows) => { if (!cancelled) setCycles(rows || []); })
      .catch(() => { if (!cancelled) setCycles([]); });
    return () => { cancelled = true; };
  }, [campaign.id, refreshKey]);

  // 시작 조건은 캠페인을 운영하는 사람에게만 말한다 — 지출 승인자는 그것을 고칠 수 없다.
  const blocker = ctx.canManage && campaign.status !== 'active' ? activationBlocker(campaign) : null;
  const caps = new Set(campaign.capabilities);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {pending > 0 && (
        <Panel tone="attention" testId="marketing-overview-inbox">
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <div style={{ fontSize: 13, color: tokens.colors.textStrong, flex: '1 1 auto' }}>
              {translate('처리할 승인 대기가')} {pending}{translate('건 있습니다')}{ctx.canApproveSpend && inbox.counts.spend_unknown ? translate(' — 결과 불명 결제 {0}건 포함', { 0: inbox.counts.spend_unknown }) : ''}.
            </div>
            <Button size="sm" variant="primary" onClick={onOpenInbox}>{translate('승인함 열기')}</Button>
          </div>
        </Panel>
      )}
      {blocker && (
        <Panel tone="attention">
          <div style={{ fontSize: 13, color: tokens.colors.warningLight }}>{translate('시작하려면:')} {blocker}</div>
        </Panel>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 14 }}>
        <Panel title={translate('제품')}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <Prose text={campaign.product_brief} empty={translate('(브리프 없음 — 에이전트가 추측해서 홍보하지 않도록 제품 설명을 적으세요)')} />
            <KeyValue
              items={[
                [translate('목표'), campaign.goal ? <Prose text={campaign.goal} /> : ''],
                [translate('대상 청중'), campaign.target_audience ? <Prose text={campaign.target_audience} /> : ''],
                [translate('제품 Project'), project
                  ? <Link to={`/projects?project=${encodeURIComponent(project.id)}`} style={{ color: tokens.colors.accentLight }}>{project.name}</Link>
                  : campaign.project_id ? campaign.project_id.slice(0, 8) : translate('없음')],
              ]}
            />
          </div>
        </Panel>

        <Panel title={translate('실행')}>
          <KeyValue
            items={[
              [translate('캠페인 에이전트'), <RuntimeSpecLabel key="agent" spec={campaign.agent_runtime} empty={translate('지정 안 함')} />],
              [translate('주기'), describeCadence(campaign)],
              [translate('다음 사이클'), campaign.status === 'active' ? formatDateTime(campaign.next_cycle_at) : translate('—(진행 중일 때만)')],
              [translate('마지막 사이클'), formatDateTime(campaign.last_cycle_at)],
              [translate('사이클 수'), String(campaign.cycle_count)],
              [translate('피드백 티켓'), `${campaign.feedback_ticket_status} 상태로`],
              [translate('개선 담당'), <RuntimeSpecLabel key="improvement" spec={campaign.improvement_assignee} empty={translate('Project 기본 담당')} />],
            ]}
          />
        </Panel>
      </div>

      <Panel title={translate('기능')}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {MARKETING_CAPABILITIES.map((cap) => (
            <div key={cap} style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
              <Chip muted={!caps.has(cap)}>{caps.has(cap) ? translate('켜짐') : translate('꺼짐')} · {CAPABILITY_LABELS[cap]}</Chip>
              <span style={{ fontSize: 11.5, color: caps.has(cap) ? tokens.colors.textSecondary : tokens.colors.textMuted }}>{CAPABILITY_DESCRIPTIONS[cap]}</span>
            </div>
          ))}
        </div>
      </Panel>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 14 }}>
        <Panel title={translate('규칙')}>
          <KeyValue
            items={[
              [translate('공개 문구'), campaign.disclosure],
              [translate('추적 링크 도메인'), campaign.allowed_domains.length ? campaign.allowed_domains.join(', ') : translate('없음 — 추적 링크를 만들 수 없습니다')],
              ...LIMIT_KEYS.map((key): [string, React.ReactNode] => [
                LIMIT_LABELS[key],
                `${campaign.limits?.[key] ?? '—'}${campaign.limit_overrides?.[key] !== undefined ? translate(' (캠페인 설정)') : ''}`,
              ]),
            ]}
          />
        </Panel>
        <Panel title={translate('돈')}>
          <KeyValue
            items={[
              [translate('통화'), campaign.currency],
              [translate('총 예산'), campaign.budget_total_minor > 0 ? formatMinor(campaign.budget_total_minor, campaign.currency) : translate('0 — 지출 불가')],
              [translate('예산 기간'), BUDGET_PERIOD_LABELS[campaign.budget_period] || campaign.budget_period],
              [translate('기간 상한'), campaign.budget_period !== 'none' && campaign.budget_period_minor > 0 ? formatMinor(campaign.budget_period_minor, campaign.currency) : translate('없음')],
              [translate('건당 상한'), campaign.max_transaction_minor > 0 ? formatMinor(campaign.max_transaction_minor, campaign.currency) : translate('없음')],
              [translate('2인 승인'), campaign.dual_approval_threshold_minor > 0 ? `${formatMinor(campaign.dual_approval_threshold_minor, campaign.currency)} 이상` : translate('끔')],
              [translate('수취인'), campaign.payees.length ? campaign.payees.map((p) => p.name).join(', ') : translate('없음')],
              [translate('결제 방식'), PAYMENT_PROVIDER_LABELS[campaign.payment_provider] || campaign.payment_provider],
            ]}
          />
          <Hint>
            {ctx.canApproveSpend && ctx.canManage
              ? translate('바꾸려면 예산·결제 탭의 “예산 설정” 을 쓰세요.')
              : ctx.canApproveSpend
                ? translate('돈 설정을 바꾸려면 캠페인 운영 권한(marketing.manage)도 필요합니다.')
                : translate('돈 설정은 marketing.approve_spend 권한이 있는 사람이 바꿉니다.')}
          </Hint>
        </Panel>
      </div>

      <Panel title={translate('사이클 기록')} testId="marketing-cycles">
        {cycles === null ? (
          <div style={{ fontSize: 12, color: tokens.colors.textMuted }}>{translate('불러오는 중…')}</div>
        ) : cycles.length === 0 ? (
          <div style={{ fontSize: 12, color: tokens.colors.textMuted }}>{translate('아직 사이클이 없습니다. 진행 중인 캠페인은 주기마다, 또는 “지금 실행” 으로 돕니다.')}</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {cycles.map((cycle) => (
              <div key={cycle.id} style={{ borderTop: `1px solid ${tokens.colors.border}`, paddingTop: 8 }}>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', fontSize: 12 }}>
                  <strong style={{ color: tokens.colors.textPrimary }}>#{cycle.cycle_no}</strong>
                  <StatusPill view={cycleStatusView(cycle.status)} />
                  <span style={{ color: tokens.colors.textMuted }}>
                    {cycle.trigger === 'manual' ? translate('수동') : translate('예약')} · {formatDateTime(cycle.started_at)}
                    {cycle.completed_at ? ` → ${formatDateTime(cycle.completed_at)}` : ''}
                  </span>
                  {cycle.untrusted_items > 0 && (
                    <span title={translate('지시문에 비신뢰 블록으로 격리돼 실린 외부 글 수')} style={{ color: tokens.colors.textMuted }}>{translate('· 외부 글')} {cycle.untrusted_items}{translate('건(격리)')}</span>
                  )}
                  {cycle.room_id && (
                    <Link to={`/chat/${encodeURIComponent(cycle.room_id)}`} style={{ color: tokens.colors.accentLight, marginLeft: 'auto' }}>{translate('방 열기')}</Link>
                  )}
                </div>
                {cycle.summary && <div style={{ marginTop: 4 }}><Prose text={cycle.summary} /></div>}
                {cycle.next_actions?.length > 0 && (
                  <ul style={{ margin: '4px 0 0', paddingLeft: 18, fontSize: 12, color: tokens.colors.textSecondary, lineHeight: 1.5 }}>
                    {cycle.next_actions.map((a, i) => <li key={i}>{a}</li>)}
                  </ul>
                )}
                {cycle.error && <Hint tone="danger">{cycle.error}</Hint>}
              </div>
            ))}
          </div>
        )}
      </Panel>
    </div>
  );
}
