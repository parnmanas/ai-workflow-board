import { t as translate } from '../../i18n/core';
import { useLocale } from '../../i18n/react';
import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api';
import type { MarketingChannel } from '../../types';
import { tokens } from '../../tokens';
import { Button, EmptyState, Input, Modal, Select, Textarea } from '../common';
import { CHANNEL_PLATFORMS, channelStatusView, parseList, platformLabel, safeHttpUrl } from './marketing.logic';
import { ChannelCard, contactsPath } from './MarketingCards';
import { Hint, useAction, useMarketingCtx } from './MarketingUi';

const STATUS_ORDER = ['proposed', 'awaiting_credential', 'active', 'paused', 'rejected'];

/** 채널(docs/marketing.md "채널 탐색") — 에이전트가 찾고 사람이 연다. 사람이 직접 추가할 수도 있다. */
export default function MarketingChannelsTab({ channels }: { channels: MarketingChannel[] }) {
  useLocale();
  const ctx = useMarketingCtx();
  const [adding, setAdding] = useState(false);
  const hasEmail = channels.some((c) => c.kind === 'email' || c.platform === 'email' || c.platform === 'newsletter');
  const groups = STATUS_ORDER
    .map((status) => ({ status, rows: channels.filter((c) => c.status === status) }))
    .filter((g) => g.rows.length);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <div style={{ fontSize: 12, color: tokens.colors.textSecondary, flex: '1 1 300px' }}>
          {translate('에이전트는 실제로 열어 본 근거 · 청중 규모 · 홍보 규칙 인용과 함께 채널을 제안합니다. 승인한 채널만 게시 · 메일 · 지출 대상이 됩니다.')}</div>
        {hasEmail && ctx.accountId && (
          <Link to={contactsPath(ctx.accountId, { campaignId: ctx.campaignId })} style={{ fontSize: 12, color: tokens.colors.accentLight }}>{translate('연락처 관리')}</Link>
        )}
        {ctx.canManage && <Button size="sm" variant="primary" onClick={() => setAdding(true)}>{translate('+ 채널 추가')}</Button>}
      </div>
      {groups.length === 0 ? (
        <EmptyState
          title={translate('채널이 없습니다')}
          description={translate('채널 탐색 기능을 켜면 에이전트가 후보를 제안합니다. 알고 있는 채널은 직접 추가하세요.')}
        />
      ) : groups.map((group) => (
        <section key={group.status} aria-label={channelStatusView(group.status).label}>
          <h2 style={{ margin: '0 0 8px', fontSize: 13, fontWeight: 700, color: tokens.colors.textSecondary }}>
            {channelStatusView(group.status).label} · {group.rows.length}
          </h2>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {group.rows.map((c) => <ChannelCard key={c.id} channel={c} />)}
          </div>
        </section>
      ))}
      {adding && <AddChannelModal onClose={() => setAdding(false)} />}
    </div>
  );
}

function AddChannelModal({ onClose }: { onClose(): void }) {
  useLocale();
  const ctx = useMarketingCtx();
  const { busy, run } = useAction();
  const [platform, setPlatform] = useState<string>('reddit');
  const [target, setTarget] = useState('');
  const [name, setName] = useState('');
  const [rationale, setRationale] = useState('');
  const [guidelines, setGuidelines] = useState('');
  const [rules, setRules] = useState('');
  const [rulesUrl, setRulesUrl] = useState('');
  const [evidence, setEvidence] = useState('');
  const [error, setError] = useState('');

  const placeholder = platform === 'reddit' ? translate('selfhosted (또는 r/selfhosted)')
    : platform === 'github' ? 'owner/repo'
      : platform === 'email' || platform === 'newsletter' ? translate('목록 · 뉴스레터 이름')
        : translate('https://… 또는 이름');

  const submit = async () => {
    if (!target.trim()) { setError(translate('대상을 입력하세요')); return; }
    if (rulesUrl.trim() && !safeHttpUrl(rulesUrl)) { setError(translate('규칙 원문 주소는 http(s) 여야 합니다')); return; }
    const urls = parseList(evidence);
    const bad = urls.find((u) => !safeHttpUrl(u));
    if (bad) { setError(translate('근거 URL 은 http(s) 여야 합니다: {0}', { 0: bad })); return; }
    setError('');
    const saved = await run(
      () => api.createMarketingChannel(ctx.campaignId, {
        platform,
        target: target.trim(),
        ...(name.trim() ? { name: name.trim() } : {}),
        ...(rationale.trim() ? { rationale: rationale.trim() } : {}),
        ...(guidelines.trim() ? { guidelines: guidelines.trim() } : {}),
        ...(rules.trim() ? { rules_summary: rules.trim() } : {}),
        ...(rulesUrl.trim() ? { rules_url: safeHttpUrl(rulesUrl) || rulesUrl.trim() } : {}),
        ...(urls.length ? { evidence_urls: urls.map((u) => safeHttpUrl(u) || u) } : {}),
      }),
      (row) => (row.duplicate ? translate('이미 있는 채널입니다 — 그 채널을 보여 줍니다') : translate('채널을 추가했습니다 — 승인하면 열립니다')),
    );
    if (saved) onClose();
  };

  return (
    <Modal
      isOpen
      onClose={onClose}
      title={translate('채널 추가')}
      maxWidth={620}
      footer={(
        <>
          <Button variant="secondary" onClick={onClose}>{translate('취소')}</Button>
          <Button variant="primary" disabled={busy} onClick={() => void submit()}>{busy ? translate('추가 중…') : translate('추가')}</Button>
        </>
      )}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={{ display: 'grid', gridTemplateColumns: '180px 1fr', gap: 10 }}>
          <Select
            label={translate('플랫폼')}
            value={platform}
            options={CHANNEL_PLATFORMS.map((p) => ({ value: p, label: platformLabel(p) }))}
            onChange={(e) => setPlatform(e.target.value)}
          />
          <Input label={translate('대상')} value={target} placeholder={placeholder} onChange={(e) => setTarget(e.target.value)} />
        </div>
        <Input label={translate('표시 이름 (선택)')} value={name} onChange={(e) => setName(e.target.value)} />
        <Textarea label={translate('적합 이유 (선택)')} rows={2} value={rationale} onChange={(e) => setRationale(e.target.value)} />
        <Textarea label={translate('게시 가이드 (선택)')} rows={2} value={guidelines} onChange={(e) => setGuidelines(e.target.value)} placeholder={translate('톤 · 빈도 · 금지 사항 — 에이전트가 이 채널에 글을 쓸 때 따른다')} />
        <Textarea label={translate('홍보 규칙 인용 (선택)')} rows={2} value={rules} onChange={(e) => setRules(e.target.value)} />
        <Input label={translate('규칙 원문 주소 (선택)')} value={rulesUrl} placeholder="https://…" onChange={(e) => setRulesUrl(e.target.value)} />
        <Textarea label={translate('근거 URL (한 줄에 하나, 선택)')} rows={2} value={evidence} onChange={(e) => setEvidence(e.target.value)} />
        <Hint>{translate('추가한 채널은 승인 대기로 들어갑니다. 승인할 때 방식(자동 게시 · 메일 · 수동)을 정합니다.')}</Hint>
        {error && <div role="alert" style={{ fontSize: 12, color: tokens.colors.dangerLight }}>{error}</div>}
      </div>
    </Modal>
  );
}
