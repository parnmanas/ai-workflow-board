import React, { useEffect, useState } from 'react';
import { api } from '../../api';
import type { MarketingBrand } from '../../types';
import { tokens } from '../../tokens';
import { Button } from '../common';
import { formatDateTime } from './marketing.logic';

type Inbox = Awaited<ReturnType<typeof api.listMarketingContactReplies>>;

/** Human-only plain-text replies. Do not render Markdown, links, or HTML from incoming email. */
export function MarketingContactReplies({ accountId, brands, onContact }: {
  accountId: string | null;
  brands: MarketingBrand[];
  onContact(email: string): void;
}) {
  const [offset, setOffset] = useState(0);
  const [reload, setReload] = useState(0);
  const [data, setData] = useState<Inbox | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let cancelled = false;
    setData(null);
    setError('');
    api.listMarketingContactReplies(accountId, offset)
      .then((value) => { if (!cancelled) setData(value); })
      .catch((e) => { if (!cancelled) setError(e.message || '회신을 불러오지 못했습니다'); });
    return () => { cancelled = true; };
  }, [accountId, offset, reload]);

  return (
    <section data-testid="marketing-contact-replies" style={{ border: `1px solid ${tokens.colors.border}`, borderRadius: tokens.radii.md, padding: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <h2 style={{ fontSize: 15 }}>재확인 안내 회신함{data ? ` (${data.total})` : ''}</h2>
        <Button size="sm" variant="secondary" onClick={() => setReload((n) => n + 1)}>새로고침</Button>
      </div>
      <p style={{ fontSize: 12, color: tokens.colors.textSecondary }}>캠페인 메일을 받은 적 없는 연락처의 회신입니다. 자유 회신만으로 동의 상태가 바뀌지는 않습니다. 철회 요청은 연락처를 찾아 수신거부로 기록하세요.</p>
      {error ? <div role="alert">{error}</div> : !data ? <p>불러오는 중…</p> : data.replies.length === 0 ? <p>회신이 없습니다.</p> : data.replies.map((reply) => (
        <article key={reply.id} style={{ borderTop: `1px solid ${tokens.colors.border}`, padding: '12px 0' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', fontSize: 12 }}>
            <b>{reply.contact?.email || '(삭제된 연락처)'}</b>
            <span>{brands.find((b) => b.id === reply.brand_id)?.name || '기존 발신자'}</span>
            <span>{formatDateTime(reply.created_at)}</span>
            {reply.contact?.email && <Button size="sm" variant="ghost" onClick={() => onContact(reply.contact!.email!)}>연락처 찾기</Button>}
          </div>
          <div style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', fontSize: 13, marginTop: 8 }}>{reply.content}</div>
        </article>
      ))}
      {data && data.total > 50 && <div style={{ display: 'flex', gap: 8 }}>
        <Button size="sm" variant="secondary" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 50))}>이전 회신</Button>
        <Button size="sm" variant="secondary" disabled={offset + 50 >= data.total} onClick={() => setOffset(offset + 50)}>다음 회신</Button>
      </div>}
    </section>
  );
}
