import React from 'react';
import type { MarketingBudgetSummary } from '../../types';
import { tokens } from '../../tokens';
import { EmptyState } from '../common';
import { INBOX_SECTIONS, INBOX_SECTION_LABELS, type InboxItem, type InboxSummary } from './marketing.logic';
import { AllocationCard, ChannelCard, PostCard, SpendCard } from './MarketingCards';
import { useMarketingCtx } from './MarketingUi';

const SECTION_HELP: Record<string, string> = {
  spend_unknown: '결제 요청이 나갔지만 결과를 모릅니다. 결제 시스템에서 확인한 뒤 기록하세요 — 서버는 다시 보내지 않습니다.',
  spend_pending: '금액 · 수취인 · 실행 payload 를 보고 승인하면 그 내용 그대로 실행됩니다. 승인 시점에 한도를 다시 검사합니다.',
  allocations: '채널별 기간 편성액입니다. 편성이 있어야 그 채널에 지출을 요청할 수 있습니다.',
  posts: '승인하면 회사 이름으로 나갑니다. 고쳐서 승인할 수 있고, 거부 사유는 에이전트가 배웁니다.',
  channels: '에이전트가 근거와 함께 찾은 채널입니다. 홍보 규칙을 확인하고 여세요.',
  follow_up: '결정은 끝났지만 사람이 마저 해야 하는 일 — 연결, 직접 게시 후 링크 기록, AWB 밖 결제 후 기록.',
};

function renderItem(item: InboxItem, budget: MarketingBudgetSummary | null) {
  switch (item.kind) {
    case 'spend':
      return <SpendCard key={item.key} spend={item.spend} />;
    case 'allocation': {
      const current = budget?.channels.find((c) => c.channel_id === item.allocation.channel_id)?.allocation_minor ?? null;
      return <AllocationCard key={item.key} allocation={item.allocation} currentMinor={current} />;
    }
    case 'post':
      return <PostCard key={item.key} post={item.post} />;
    case 'channel':
      return <ChannelCard key={item.key} channel={item.channel} />;
    default:
      return null;
  }
}

/**
 * 승인함 — 이 캠페인에서 사람을 기다리는 모든 것. 카드는 각 탭과 같은 컴포넌트라 여기서 승인 · 거부해도
 * 같은 경로(같은 확인 단계)를 지난다.
 */
export default function MarketingInboxTab({ inbox, budget }: { inbox: InboxSummary; budget: MarketingBudgetSummary | null }) {
  const ctx = useMarketingCtx();
  if (!inbox.total) {
    return (
      <EmptyState
        title="기다리는 결정이 없습니다"
        description="에이전트가 채널 · 글 · 메일 · 예산 · 지출을 제안하면 여기에 모입니다. 사이클 기록은 개요 탭에서 봅니다."
      />
    );
  }
  return (
    <div data-testid="marketing-inbox" style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      <div style={{ fontSize: 12, color: tokens.colors.textSecondary }}>
        결정 대기 {inbox.decisions}건{inbox.counts.follow_up ? ` · 마무리 ${inbox.counts.follow_up}건` : ''}
        {!ctx.canApproveSpend && (inbox.counts.spend_pending + inbox.counts.spend_unknown + inbox.counts.allocations) > 0
          ? ' — 예산 · 지출은 marketing.approve_spend 권한이 있는 사람이 정합니다'
          : ''}
      </div>
      {INBOX_SECTIONS.filter((section) => inbox.counts[section] > 0).map((section) => (
        <section key={section} data-testid={`marketing-inbox-${section}`} aria-label={INBOX_SECTION_LABELS[section]}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 4 }}>
            <h2 style={{
              margin: 0, fontSize: 14, fontWeight: 700,
              color: section === 'spend_unknown' ? tokens.colors.dangerLight : tokens.colors.textPrimary,
            }}
            >
              {INBOX_SECTION_LABELS[section]}
            </h2>
            <span style={{ fontSize: 12, color: tokens.colors.textMuted }}>{inbox.counts[section]}</span>
          </div>
          <div style={{ fontSize: 11, color: tokens.colors.textMuted, marginBottom: 8, lineHeight: 1.5 }}>{SECTION_HELP[section]}</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {inbox.items.filter((item) => item.section === section).map((item) => renderItem(item, budget))}
          </div>
        </section>
      ))}
    </div>
  );
}
