import { t as translate } from '../../i18n/core';
import { useLocale } from '../../i18n/react';
import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api';
import type { MarketingFeedback, MarketingFeedbackCategory, MarketingFeedbackList, MarketingFeedbackSentiment } from '../../types';
import { tokens } from '../../tokens';
import { Button, EmptyState, Input, Modal, Select, Textarea } from '../common';
import { ticketPath } from '../../utils/ticketPath';
import {
  FEEDBACK_CATEGORIES,
  FEEDBACK_CATEGORY_LABELS,
  FEEDBACK_SENTIMENTS,
  SENTIMENT_LABELS,
  TICKETABLE_CATEGORIES,
  feedbackStatusView,
  formatDateTime,
  safeHttpUrl,
} from './marketing.logic';
import { Chip, ExternalLink, Hint, Meta, Panel, Quote, StatusPill, tableStyles, useAction, useMarketingCtx } from './MarketingUi';

/**
 * 피드백 → 제품(docs/marketing.md). 외부인이 쓴 글은 데이터로만 보여 준다 — 인용 블록 안의 글자이고
 * 링크 · 마크업으로 바꾸지 않는다. bug · 기능 요청은 캠페인 제품 Project 의 티켓이 된다(상한 안에서).
 */
export default function MarketingFeedbackTab({ refreshKey }: { refreshKey: number }) {
  useLocale();
  const ctx = useMarketingCtx();
  const [data, setData] = useState<MarketingFeedbackList | null>(null);
  const [recording, setRecording] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api.listMarketingFeedback(ctx.campaignId)
      .then((d) => { if (!cancelled) setData(d); })
      .catch((err) => { if (!cancelled) { setData({ recorded: [], collected: [] }); ctx.notify((err as Error)?.message || translate('피드백을 불러오지 못했습니다'), 'error'); } });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctx.campaignId, refreshKey]);

  const productLinked = !!ctx.campaign?.project_id;
  const toProduct = !!ctx.campaign?.capabilities.includes('feedback_to_product');

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <div style={{ fontSize: 12, color: tokens.colors.textSecondary, flex: '1 1 300px' }}>
          {toProduct
            ? translate('버그 · 기능 요청은 기록하면 제품 Project 의 티켓이 됩니다. 상한(24시간 · 열린 티켓 수)에 걸리면 기록만 하고, 여기서 직접 티켓을 만들 수 있습니다.')
            : translate('“피드백 → 제품 개선” 기능이 꺼져 있어 자동으로 티켓을 만들지 않습니다. 필요하면 기록마다 직접 티켓을 만드세요.')}
        </div>
        {ctx.canManage && <Button size="sm" variant="primary" onClick={() => setRecording(true)}>{translate('+ 피드백 기록')}</Button>}
      </div>

      {data === null ? (
        <div style={{ fontSize: 12, color: tokens.colors.textMuted }}>{translate('불러오는 중…')}</div>
      ) : (
        <>
          {data.recorded.length === 0 ? (
            <EmptyState title={translate('기록된 피드백이 없습니다')} description={translate('에이전트가 반응 · 언급을 읽고 출처와 함께 기록합니다. 메일 답장은 메일 채널의 공급자 webhook 을 연결하면 자동으로 들어오고, 그 밖에 사람이 받은 것은 직접 기록하세요.')} />
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {data.recorded.map((f) => <FeedbackCard key={f.id} feedback={f} canTicket={productLinked} />)}
            </div>
          )}
          {data.collected.length > 0 && (
            <Panel title={translate('연결된 채널이 수집한 글')}>
              <div style={{ overflowX: 'auto' }}>
                <table style={tableStyles.table}>
                  <thead>
                    <tr>
                      <th style={tableStyles.th}>{translate('수집')}</th>
                      <th style={tableStyles.th}>{translate('채널')}</th>
                      <th style={tableStyles.th}>{translate('작성자')}</th>
                      <th style={tableStyles.th}>{translate('분류')}</th>
                      <th style={tableStyles.th}>{translate('상태')}</th>
                      <th style={tableStyles.th}>{translate('원문')}</th>
                      <th style={tableStyles.th}>{translate('티켓')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.collected.map((c) => (
                      <tr key={c.id}>
                        <td style={tableStyles.td}>{formatDateTime(c.collected_at)}</td>
                        <td style={tableStyles.td}>{c.channel_name}</td>
                        <td style={tableStyles.td}>{c.author}</td>
                        <td style={tableStyles.td}>{c.classification ? FEEDBACK_CATEGORY_LABELS[c.classification] || c.classification : '—'}</td>
                        <td style={tableStyles.td}>{c.status}</td>
                        <td style={tableStyles.td}>{c.permalink ? <ExternalLink href={c.permalink}>{translate('열기')}</ExternalLink> : '—'}</td>
                        <td style={tableStyles.td}>{c.ticket_id ? <Link to={ticketPath(ctx.accountId, c.ticket_id)} style={{ color: tokens.colors.accentLight }}>{translate('티켓')}</Link> : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <Hint>{translate('outreach 수집(분류 · 중복 제거 · 티켓)은 Outreach 채널이 하고, 여기서는 그 결과만 봅니다.')}</Hint>
            </Panel>
          )}
        </>
      )}
      {recording && <RecordFeedbackModal onClose={() => setRecording(false)} />}
    </div>
  );
}

function FeedbackCard({ feedback, canTicket }: { feedback: MarketingFeedback; canTicket: boolean }) {
  useLocale();
  const ctx = useMarketingCtx();
  const { busy, run } = useAction();
  const channel = feedback.channel_id ? ctx.channels.get(feedback.channel_id) : null;
  return (
    <Panel
      testId={`marketing-feedback-${feedback.id}`}
      title={(
        <span style={{ display: 'inline-flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <Chip>{FEEDBACK_CATEGORY_LABELS[feedback.category] || feedback.category}</Chip>
          <span>{feedback.summary || translate('(요약 없음)')}</span>
          <StatusPill view={feedbackStatusView(feedback.status)} />
        </span>
      )}
      actions={!feedback.ticket_id && ctx.canManage ? (
        <Button
          size="sm"
          variant="secondary"
          disabled={busy || !canTicket}
          title={canTicket ? undefined : translate('캠페인에 제품 Project 가 없습니다')}
          onClick={() => void run(() => api.fileMarketingFeedbackTicket(feedback.id), (t) => translate('티켓을 만들었습니다: {0}', { 0: t.title }))}
        >
          {translate('티켓 만들기')}</Button>
      ) : null}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <Quote
          label={feedback.contact_id
            ? translate('메일 답장 — {0} · 인용 원문 · 서명 · 메일 주소는 지우고 남김', { 0: feedback.contact?.email || translate('(삭제된 연락처)') })
            : translate('외부인이 쓴 글{0}', { 0: feedback.author ? ` — ${feedback.author}` : '' })}
          tone="muted"
        >
          {feedback.content}
        </Quote>
        <Meta>
          {feedback.contact_id && <span><Chip muted>{translate('메일 답장')}</Chip></span>}
          <span>{SENTIMENT_LABELS[feedback.sentiment] || feedback.sentiment}</span>
          {channel && <span>· {channel.name}</span>}
          {feedback.source_url && <span>· <ExternalLink href={feedback.source_url}>{translate('출처')}</ExternalLink></span>}
          <span>{translate('· 기록')} {feedback.recorded_by_name || feedback.recorded_by_type} · {formatDateTime(feedback.created_at)}</span>
          {feedback.ticket_id && (
            <span>· <Link to={ticketPath(ctx.accountId, feedback.ticket_id)} style={{ color: tokens.colors.accentLight }}>{translate('연결된 티켓')}</Link></span>
          )}
        </Meta>
        {feedback.status === 'capped' && <Hint tone="warning">{translate('상한에 걸려 티켓을 만들지 않았습니다 — 필요하면 직접 만드세요.')}</Hint>}
      </div>
    </Panel>
  );
}

function RecordFeedbackModal({ onClose }: { onClose(): void }) {
  useLocale();
  const ctx = useMarketingCtx();
  const { busy, run } = useAction();
  const [category, setCategory] = useState<MarketingFeedbackCategory>('feature_request');
  const [sentiment, setSentiment] = useState<MarketingFeedbackSentiment>('neutral');
  const [content, setContent] = useState('');
  const [summary, setSummary] = useState('');
  const [sourceUrl, setSourceUrl] = useState('');
  const [author, setAuthor] = useState('');
  const [channelId, setChannelId] = useState('');
  const [error, setError] = useState('');
  const ticketable = TICKETABLE_CATEGORIES.includes(category);

  const submit = async () => {
    if (!content.trim()) { setError(translate('내용(인용)을 입력하세요')); return; }
    if (ticketable && !summary.trim()) { setError(translate('버그 · 기능 요청은 요약이 필요합니다(티켓 제목이 됩니다)')); return; }
    if (sourceUrl.trim() && !safeHttpUrl(sourceUrl)) { setError(translate('출처는 http(s) 주소여야 합니다')); return; }
    setError('');
    const saved = await run(
      () => api.recordMarketingFeedback(ctx.campaignId, {
        category,
        sentiment,
        content: content.trim(),
        source_url: sourceUrl.trim() ? safeHttpUrl(sourceUrl) || sourceUrl.trim() : '',
        ...(summary.trim() ? { summary: summary.trim() } : {}),
        ...(author.trim() ? { author: author.trim() } : {}),
        ...(channelId ? { channel_id: channelId } : {}),
      }),
      (r) => (r.duplicate
        ? translate('같은 출처의 피드백이 이미 있습니다')
        : r.ticket_id
          ? translate('기록하고 제품 티켓을 만들었습니다')
          : r.feedback?.status === 'capped'
            ? translate('기록했지만 상한 때문에 티켓은 만들지 않았습니다 — {0}', { 0: r.note || '' })
            : translate('피드백을 기록했습니다')),
    );
    if (saved) onClose();
  };

  return (
    <Modal
      isOpen
      onClose={onClose}
      title={translate('피드백 기록')}
      maxWidth={600}
      footer={(
        <>
          <Button variant="secondary" onClick={onClose}>{translate('취소')}</Button>
          <Button variant="primary" disabled={busy} onClick={() => void submit()}>{busy ? translate('기록 중…') : translate('기록')}</Button>
        </>
      )}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8 }}>
          <Select label={translate('분류')} value={category} options={FEEDBACK_CATEGORIES.map((c) => ({ value: c, label: FEEDBACK_CATEGORY_LABELS[c] }))}
            onChange={(e) => setCategory(e.target.value as MarketingFeedbackCategory)} />
          <Select label={translate('분위기')} value={sentiment} options={FEEDBACK_SENTIMENTS.map((s) => ({ value: s, label: SENTIMENT_LABELS[s] }))}
            onChange={(e) => setSentiment(e.target.value as MarketingFeedbackSentiment)} />
          <Select label={translate('채널 (선택)')} value={channelId}
            options={[{ value: '', label: '—' }, ...[...ctx.channels.values()].map((c) => ({ value: c.id, label: c.name }))]}
            onChange={(e) => setChannelId(e.target.value)} />
        </div>
        <Textarea label={translate('내용 — 받은 글을 그대로 인용')} rows={4} value={content} onChange={(e) => setContent(e.target.value)} />
        <Input label={ticketable ? translate('요약 (티켓 제목)') : translate('요약 (선택)')} value={summary} onChange={(e) => setSummary(e.target.value)} />
        <Input label={translate('출처 주소 (선택)')} value={sourceUrl} placeholder="https://…" onChange={(e) => setSourceUrl(e.target.value)} />
        <Input label={translate('작성자 (선택)')} value={author} onChange={(e) => setAuthor(e.target.value)} />
        <Hint>{translate('같은 출처 주소는 한 번만 기록됩니다.')}</Hint>
        {error && <div role="alert" style={{ fontSize: 12, color: tokens.colors.dangerLight }}>{error}</div>}
      </div>
    </Modal>
  );
}
