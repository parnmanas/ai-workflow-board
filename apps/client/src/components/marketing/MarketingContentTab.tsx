import { t as translate } from '../../i18n/core';
import { useLocale } from '../../i18n/react';
import React, { useEffect, useState } from 'react';
import { api } from '../../api';
import type { MarketingPost } from '../../types';
import { tokens } from '../../tokens';
import { EmptyState, Select } from '../common';
import { postStatusView } from './marketing.logic';
import { PostCard } from './MarketingCards';
import { useMarketingCtx } from './MarketingUi';

const FILTERS = ['', 'draft', 'approved', 'publishing', 'sending', 'published', 'failed', 'rejected'];

/** 콘텐츠(docs/marketing.md "커뮤니케이션") — 채널별 게시글 · 댓글 · 메일. 초안은 승인해야 나간다. */
export default function MarketingContentTab({ refreshKey }: { refreshKey: number }) {
  useLocale();
  const ctx = useMarketingCtx();
  const [status, setStatus] = useState('');
  const [posts, setPosts] = useState<MarketingPost[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.listMarketingPosts(ctx.campaignId, { status: status || undefined, limit: 200 })
      .then((rows) => { if (!cancelled) setPosts(rows || []); })
      .catch((err) => { if (!cancelled) { setPosts([]); ctx.notify((err as Error)?.message || translate('콘텐츠를 불러오지 못했습니다'), 'error'); } });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctx.campaignId, status, refreshKey]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <div style={{ fontSize: 12, color: tokens.colors.textSecondary, flex: '1 1 300px' }}>
          {translate('에이전트가 쓴 초안은 승인해야 나갑니다. 자동 게시 정책은 없습니다 — 외부에서 들어온 글이 곧바로 외부 발신이 되는 길을 막기 위해서입니다.')}</div>
        <div style={{ minWidth: 180 }}>
          <Select
            aria-label={translate('콘텐츠 상태')}
            value={status}
            options={FILTERS.map((s) => ({ value: s, label: s ? postStatusView(s).label : translate('전체') }))}
            onChange={(e) => setStatus(e.target.value)}
          />
        </div>
      </div>
      {posts === null ? (
        <div style={{ fontSize: 12, color: tokens.colors.textMuted }}>{translate('불러오는 중…')}</div>
      ) : posts.length === 0 ? (
        <EmptyState title={translate('콘텐츠가 없습니다')} description={translate('커뮤니티 게시 · 메일 기능을 켠 캠페인의 에이전트가 활성 채널마다 초안을 씁니다.')} />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {posts.map((p) => <PostCard key={p.id} post={p} />)}
        </div>
      )}
    </div>
  );
}
