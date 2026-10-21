import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api';
import type {
  Credential,
  MarketingAllocation,
  MarketingChannel,
  MarketingChannelKind,
  MarketingPost,
  MarketingPostSends,
  MarketingSpendRequest,
  OutreachChannelSummary,
} from '../../types';
import { tokens } from '../../tokens';
import { Button, Input, Modal, Select, Textarea } from '../common';
import { relativeTime } from '../../utils/time';
import {
  CHANNEL_KIND_LABELS,
  PAYMENT_PROVIDER_LABELS,
  SECOND_APPROVAL_MESSAGE,
  SPEND_CONFIRM_PHRASE,
  UNKNOWN_SPEND_MESSAGE,
  allocationStatusView,
  approvalModesFor,
  buildChannelApproval,
  canCancelSpend,
  canReconcileSpend,
  channelStatusView,
  channelTargetKey,
  emailConfigBody,
  emailDraftFrom,
  formatCount,
  formatDateTime,
  formatMinor,
  isSpendExpired,
  parseMajorToMinor,
  platformLabel,
  postStatusView,
  previewCommunityBody,
  safeHttpUrl,
  shortHash,
  spendApprovalState,
  spendStatusView,
  validateEmailDraft,
  type EmailConfigDraft,
  type OutreachChoice,
} from './marketing.logic';
import {
  Chip,
  ExternalLink,
  FieldLabel,
  Hint,
  JsonBlock,
  KeyValue,
  Meta,
  NoteModal,
  Panel,
  Prose,
  Quote,
  StatusPill,
  useAction,
  useMarketingCtx,
} from './MarketingUi';

/**
 * 사람이 정하는 것들의 카드 — 승인함과 각 탭이 같은 카드를 쓴다(docs/marketing.md "원칙").
 * 승인 화면은 실제로 나갈 것 · 실제로 실행될 것을 그대로 보여 주고, 그 내용 그대로 서버가 집행한다.
 */

const actorKind = (type: string) => (type === 'agent' ? '에이전트' : type === 'user' ? '사람' : type || '');

/** 연락처 화면 — 캠페인의 소유 계정을 명시해서 연다(계정 선택기는 두지 않는다). */
export function contactsPath(accountId: string, opts: { campaignId?: string; list?: string } = {}): string {
  const params = new URLSearchParams();
  if (accountId) params.set('account', accountId);
  if (opts.campaignId) params.set('campaign', opts.campaignId);
  if (opts.list) params.set('list', opts.list);
  const qs = params.toString();
  return `/marketing/contacts${qs ? `?${qs}` : ''}`;
}

// ── 채널 ────────────────────────────────────────────────────────────────────

export function ChannelCard({ channel }: { channel: MarketingChannel }) {
  const ctx = useMarketingCtx();
  const { busy, run } = useAction();
  const [approveMode, setApproveMode] = useState<'approve' | 'connect' | null>(null);
  const [rejecting, setRejecting] = useState(false);
  const [editing, setEditing] = useState(false);
  const evidence = (channel.evidence_urls || []).filter(Boolean);
  const proposed = channel.status === 'proposed';
  const targetUrl = safeHttpUrl(channel.target);

  const actions = ctx.canManage ? (
    <>
      {(channel.status === 'proposed' || channel.status === 'rejected') && (
        <Button size="sm" variant="primary" disabled={busy} onClick={() => setApproveMode('approve')}>
          {channel.status === 'rejected' ? '다시 승인…' : '승인…'}
        </Button>
      )}
      {channel.status === 'awaiting_credential' && (
        <Button size="sm" variant="primary" disabled={busy} onClick={() => setApproveMode('connect')}>연결…</Button>
      )}
      {proposed && (
        <Button size="sm" variant="danger" disabled={busy} onClick={() => setRejecting(true)}>거부</Button>
      )}
      {channel.status === 'active' && (
        <Button size="sm" variant="secondary" disabled={busy} onClick={() => void run(() => api.pauseMarketingChannel(channel.id), '채널을 일시정지했습니다')}>
          일시정지
        </Button>
      )}
      {channel.status === 'paused' && (
        <Button size="sm" variant="secondary" disabled={busy} onClick={() => void run(() => api.resumeMarketingChannel(channel.id), '채널을 다시 열었습니다')}>
          재개
        </Button>
      )}
      {channel.status !== 'rejected' && (
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => setEditing(true)}>편집</Button>
      )}
    </>
  ) : null;

  return (
    <Panel
      testId={`marketing-channel-${channel.id}`}
      tone={proposed || channel.status === 'awaiting_credential' ? 'attention' : undefined}
      title={(
        <span style={{ display: 'inline-flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <Chip>{platformLabel(channel.platform)}</Chip>
          <span>{channel.name}</span>
          <StatusPill view={channelStatusView(channel.status)} />
        </span>
      )}
      actions={actions}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <Meta>
          <span>대상: {targetUrl ? <ExternalLink href={targetUrl}>{channel.target}</ExternalLink> : <code>{channel.target}</code>}</span>
          {channel.status !== 'proposed' && <span>· {CHANNEL_KIND_LABELS[channel.kind] || channel.kind}</span>}
          <span>· 제안 {actorKind(channel.proposed_by_type)} {channel.proposed_by_name} · {relativeTime(channel.created_at)}</span>
        </Meta>

        {(channel.rules_summary || channel.rules_url) ? (
          <Quote label="홍보 규칙(커뮤니티 원문 인용)" tone="warning">
            {channel.rules_summary || '(인용 없음 — 원문을 확인하세요)'}
            {channel.rules_url && (
              <div style={{ marginTop: 4 }}><ExternalLink href={channel.rules_url}>규칙 원문 열기</ExternalLink></div>
            )}
          </Quote>
        ) : proposed ? (
          <Hint tone="warning">홍보 규칙 인용이 없습니다 — 승인 전에 그 커뮤니티의 규칙을 직접 확인하세요.</Hint>
        ) : null}

        <KeyValue
          items={[
            ['적합 이유', channel.rationale ? <Prose text={channel.rationale} /> : ''],
            ['청중 적합도', channel.audience_fit ? <Prose text={channel.audience_fit} /> : ''],
            ['청중 규모', channel.audience_size !== null && channel.audience_size !== undefined
              ? `${formatCount(channel.audience_size)}${channel.audience_observed_at ? ` (관측 ${formatDateTime(channel.audience_observed_at).slice(0, 10)})` : ''}`
              : ''],
            ['게시 가이드', channel.guidelines ? <Prose text={channel.guidelines} /> : ''],
            ['결정', channel.decided_by_name ? `${channel.decided_by_name} · ${formatDateTime(channel.decided_at)}` : ''],
            ['결정 메모', channel.decision_note],
          ]}
        />

        {evidence.length > 0 && (
          <div>
            <FieldLabel>근거 — 에이전트가 실제로 연 페이지</FieldLabel>
            <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12, lineHeight: 1.6 }}>
              {evidence.map((url) => <li key={url}><ExternalLink href={url} /></li>)}
            </ul>
          </div>
        )}

        {channel.kind === 'email' && channel.email && (
          <div>
            <KeyValue
              items={[
                ['발신자', `${channel.email.from_name} <${channel.email.from_address}>`],
                ['회신 주소', channel.email.reply_to],
                ['연락처', channel.email.contact_email],
                ['발신자 주소', channel.email.postal_address],
                ['수신 목록', channel.email.list_name],
                ['광고 표기', channel.email.ad_label],
              ]}
            />
            <div style={{ marginTop: 6 }}>
              <Link
                data-testid={`marketing-channel-contacts-${channel.id}`}
                to={contactsPath(ctx.accountId, { campaignId: ctx.campaignId, list: channel.email.list_name })}
                style={{ fontSize: 12, color: tokens.colors.accentLight }}
              >
                연락처 관리
              </Link>
            </div>
          </div>
        )}
        {channel.kind === 'outreach' && channel.outreach_channel_id && (
          <Meta><span>Outreach 채널에 연결됨 — 승인한 글은 서버가 커넥터로 게시합니다.</span></Meta>
        )}
      </div>

      {approveMode && <ChannelApproveModal channel={channel} mode={approveMode} onClose={() => setApproveMode(null)} />}
      {editing && <ChannelEditModal channel={channel} onClose={() => setEditing(false)} />}
      <NoteModal
        isOpen={rejecting}
        title="채널 제안 거부"
        message="거부 사유는 다음 사이클 지시문에 실려 에이전트가 배웁니다. 무엇이 맞지 않았는지 적어 주세요."
        label="거부 사유"
        required
        danger
        busy={busy}
        confirmLabel="거부"
        onClose={() => setRejecting(false)}
        onSubmit={async (note) => {
          const done = await run(() => api.rejectMarketingChannel(channel.id, note), '채널 제안을 거부했습니다');
          if (done) setRejecting(false);
        }}
      />
    </Panel>
  );
}

function useAccountCredentials(accountId: string): Credential[] | null {
  const [rows, setRows] = useState<Credential[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    api.listCredentials(accountId || undefined)
      // 에이전트 환경 변수로 나가는 credential 은 받지 않는다 — 서버만 비밀을 쥔다(docs/marketing.md 원칙 1).
      .then((list) => { if (!cancelled) setRows((list || []).filter((c) => !c.agent_env)); })
      .catch(() => { if (!cancelled) setRows([]); });
    return () => { cancelled = true; };
  }, [accountId]);
  return rows;
}

function EmailConfigFields({ value, onChange, credentials }: {
  value: EmailConfigDraft;
  onChange(next: EmailConfigDraft): void;
  credentials: Credential[] | null;
}) {
  const set = (patch: Partial<EmailConfigDraft>) => onChange({ ...value, ...patch });
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 10 }}>
      <Select
        label="메일 credential"
        value={value.credential_id}
        placeholder={credentials === null ? '불러오는 중…' : '— credential 선택 —'}
        options={(credentials || []).map((c) => ({ value: c.id, label: c.name }))}
        onChange={(e) => set({ credential_id: e.target.value })}
      />
      <Input label="발신자 이름" value={value.from_name} onChange={(e) => set({ from_name: e.target.value })} />
      <Input label="발신 주소" value={value.from_address} placeholder="news@example.com" onChange={(e) => set({ from_address: e.target.value })} />
      <Input label="회신 주소 (선택)" value={value.reply_to} onChange={(e) => set({ reply_to: e.target.value })} />
      <Input label="연락처 메일 (선택)" value={value.contact_email} placeholder="비우면 회신/발신 주소" onChange={(e) => set({ contact_email: e.target.value })} />
      <Input label="발신자 주소(우편)" value={value.postal_address} onChange={(e) => set({ postal_address: e.target.value })} />
      <Input label="수신 목록" value={value.list_name} placeholder="newsletter" onChange={(e) => set({ list_name: e.target.value })} />
      <Input label="광고 표기" value={value.ad_label} onChange={(e) => set({ ad_label: e.target.value })} />
      <div style={{ gridColumn: '1 / -1' }}>
        <Hint>
          발신자 이름 · 주소 · 연락처와 수신거부 링크, 제목 앞 광고 표기는 정보통신망법 §50 · CAN-SPAM 이 요구하는 법정 표기라
          서버가 모든 메일에 강제로 붙입니다(한국 수신자에게는 항상 “(광고)”). 수신자는 이 목록의 동의 연락처뿐입니다.
        </Hint>
      </div>
    </div>
  );
}

function ChannelApproveModal({ channel, mode, onClose }: { channel: MarketingChannel; mode: 'approve' | 'connect'; onClose(): void }) {
  const ctx = useMarketingCtx();
  const { busy, run } = useAction();
  const connect = mode === 'connect';
  const modes: MarketingChannelKind[] = connect ? ['outreach'] : approvalModesFor(channel.platform);
  const [kind, setKind] = useState<MarketingChannelKind>(modes[0]);
  const [choice, setChoice] = useState<OutreachChoice>('create');
  const [outreachChannelId, setOutreachChannelId] = useState('');
  const [credentialId, setCredentialId] = useState('');
  const [rate, setRate] = useState('2');
  const [collect, setCollect] = useState(false);
  const [email, setEmail] = useState<EmailConfigDraft>(() => emailDraftFrom(channel.email));
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const credentials = useAccountCredentials(ctx.accountId);
  const [outreach, setOutreach] = useState<OutreachChannelSummary[] | null>(null);
  const [outreachError, setOutreachError] = useState('');

  useEffect(() => {
    if (kind !== 'outreach') return;
    let cancelled = false;
    api.listOutreachChannels(ctx.accountId)
      .then((rows) => { if (!cancelled) setOutreach((rows || []).filter((o) => o.kind === channel.platform)); })
      .catch((err: any) => {
        if (cancelled) return;
        setOutreach([]);
        setOutreachError(err?.status === 403
          ? '기존 Outreach 채널 목록을 볼 권한(admin.resources)이 없습니다 — credential 로 새로 만드세요.'
          : (err?.message || 'Outreach 채널 목록을 불러오지 못했습니다'));
      });
    return () => { cancelled = true; };
  }, [kind, ctx.accountId, channel.platform]);

  const targetKey = channelTargetKey(channel.platform, channel.target);
  const submit = async () => {
    const built = buildChannelApproval(
      { kind, outreachChoice: choice, outreachChannelId, credentialId, rateLimitPerHour: rate, collectFeedback: collect, email, note },
      { connect },
    );
    if (!built.ok) { setError(built.error); return; }
    setError('');
    const saved = await run(
      () => (connect ? api.connectMarketingChannel(channel.id, built.body) : api.approveMarketingChannel(channel.id, built.body)),
      (row) => (row.status === 'awaiting_credential' ? '승인했습니다 — 연결할 credential 을 기다립니다' : '채널을 열었습니다'),
    );
    if (saved) onClose();
  };

  const radio = (name: string, checked: boolean, onSelect: () => void, label: React.ReactNode, testId?: string) => (
    <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 13, color: tokens.colors.textSecondary, cursor: 'pointer' }}>
      <input type="radio" name={name} checked={checked} onChange={onSelect} data-testid={testId} />
      <span>{label}</span>
    </label>
  );

  return (
    <Modal
      isOpen
      onClose={onClose}
      title={connect ? `채널 연결 — ${channel.name}` : `채널 승인 — ${channel.name}`}
      maxWidth={680}
      footer={(
        <>
          <Button variant="secondary" onClick={onClose}>취소</Button>
          <Button variant="primary" disabled={busy} onClick={() => void submit()}>{busy ? '처리 중…' : connect ? '연결' : '승인'}</Button>
        </>
      )}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <Meta><span>{platformLabel(channel.platform)} · {channel.target}</span></Meta>
        {channel.rules_summary && <Quote label="홍보 규칙" tone="warning">{channel.rules_summary}</Quote>}

        {modes.length > 1 && (
          <div>
            <FieldLabel>방식</FieldLabel>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {modes.map((m) => radio('marketing-channel-mode', kind === m, () => setKind(m), CHANNEL_KIND_LABELS[m], `marketing-mode-${m}`))}
            </div>
          </div>
        )}

        {kind === 'manual' && (
          <Hint>사람이 그 채널에 직접 올리고, 올린 글의 주소를 기록합니다. 서버는 아무것도 게시하지 않습니다.</Hint>
        )}

        {kind === 'outreach' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {radio('marketing-outreach', choice === 'existing', () => setChoice('existing'), '기존 Outreach 채널에 연결')}
            {choice === 'existing' && (
              <div style={{ paddingLeft: 22 }}>
                <Select
                  label="Outreach 채널"
                  value={outreachChannelId}
                  placeholder={outreach === null ? '불러오는 중…' : outreach.length ? '— 선택 —' : '연결할 채널이 없습니다'}
                  options={(outreach || []).map((o) => {
                    const listed = (o.targets || []).map((t) => t.trim().toLowerCase()).includes(targetKey);
                    return { value: o.id, label: `${o.name}${listed ? '' : ' — 대상 미등록'}${o.has_credential ? '' : ' — credential 없음'}` };
                  })}
                  onChange={(e) => setOutreachChannelId(e.target.value)}
                />
                <Hint>그 Outreach 채널의 대상(targets)에 {channel.target} 이 등록돼 있어야 합니다.</Hint>
                {outreachError && <Hint tone="warning">{outreachError}</Hint>}
              </div>
            )}
            {radio('marketing-outreach', choice === 'create', () => setChoice('create'), 'credential 로 새 Outreach 채널 만들기')}
            {choice === 'create' && (
              <div style={{ paddingLeft: 22, display: 'flex', flexDirection: 'column', gap: 8 }}>
                <Select
                  label="게시 credential"
                  value={credentialId}
                  placeholder={credentials === null ? '불러오는 중…' : '— credential 선택 —'}
                  options={(credentials || []).map((c) => ({ value: c.id, label: c.name }))}
                  onChange={(e) => setCredentialId(e.target.value)}
                />
                <Input label="시간당 게시 상한" value={rate} inputMode="numeric" onChange={(e) => setRate(e.target.value)} />
                <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 13, color: tokens.colors.textSecondary, cursor: 'pointer' }}>
                  <input type="checkbox" checked={collect} onChange={(e) => setCollect(e.target.checked)} />
                  <span>이 커뮤니티의 글을 수집해 피드백 티켓으로 만들기</span>
                </label>
                <Hint tone="warning">
                  수집을 켜면 이 커뮤니티를 주기적으로 읽어 글을 분류하고 티켓을 만듭니다. 제품 전용 커뮤니티에서만 켜세요 —
                  일반 커뮤니티를 폴링하면 제품과 무관한 글이 티켓이 됩니다.
                </Hint>
              </div>
            )}
            {!connect && radio('marketing-outreach', choice === 'later', () => setChoice('later'), '승인만 하고 연결은 나중에(연결 대기)')}
          </div>
        )}

        {kind === 'email' && <EmailConfigFields value={email} onChange={setEmail} credentials={credentials} />}

        <Textarea label="결정 메모 (선택)" rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
        {error && <div role="alert" style={{ fontSize: 12, color: tokens.colors.dangerLight }}>{error}</div>}
      </div>
    </Modal>
  );
}

function ChannelEditModal({ channel: channelProp, onClose }: { channel: MarketingChannel; onClose(): void }) {
  const ctx = useMarketingCtx();
  // 연 순간의 채널과 비교한다 — 그사이 다른 사람이 고친 칸을 예전 값으로 되돌리지 않게.
  const [channel] = useState(() => channelProp);
  const { busy, run } = useAction();
  const [name, setName] = useState(channel.name);
  const [guidelines, setGuidelines] = useState(channel.guidelines || '');
  const [rules, setRules] = useState(channel.rules_summary || '');
  const [fit, setFit] = useState(channel.audience_fit || '');
  const [rationale, setRationale] = useState(channel.rationale || '');
  const [email, setEmail] = useState<EmailConfigDraft>(() => emailDraftFrom(channel.email));
  const [error, setError] = useState('');
  const credentials = useAccountCredentials(channel.kind === 'email' ? ctx.accountId : '');
  const emailBefore = JSON.stringify(emailConfigBody(emailDraftFrom(channel.email)));

  const submit = async () => {
    const patch: Record<string, unknown> = {};
    if (name.trim() !== channel.name) patch.name = name.trim();
    if (guidelines !== (channel.guidelines || '')) patch.guidelines = guidelines;
    if (rules !== (channel.rules_summary || '')) patch.rules_summary = rules;
    if (fit !== (channel.audience_fit || '')) patch.audience_fit = fit;
    if (rationale !== (channel.rationale || '')) patch.rationale = rationale;
    if (channel.kind === 'email' && JSON.stringify(emailConfigBody(email)) !== emailBefore) {
      const invalid = validateEmailDraft(email);
      if (invalid) { setError(invalid); return; }
      patch.email = emailConfigBody(email);
    }
    if (!name.trim()) { setError('이름을 비울 수 없습니다'); return; }
    if (!Object.keys(patch).length) { onClose(); return; }
    const saved = await run(() => api.updateMarketingChannel(channel.id, patch), '채널을 고쳤습니다');
    if (saved) onClose();
  };

  return (
    <Modal
      isOpen
      onClose={onClose}
      title={`채널 편집 — ${channel.name}`}
      maxWidth={640}
      footer={(
        <>
          <Button variant="secondary" onClick={onClose}>취소</Button>
          <Button variant="primary" disabled={busy} onClick={() => void submit()}>{busy ? '저장 중…' : '저장'}</Button>
        </>
      )}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <Hint>대상({channel.target})은 바꾸지 않습니다 — 다른 채널이 됩니다. 새 대상은 채널을 추가하세요.</Hint>
        <Input label="이름" value={name} onChange={(e) => setName(e.target.value)} />
        <Textarea label="게시 가이드(에이전트가 따른다)" rows={3} value={guidelines} onChange={(e) => setGuidelines(e.target.value)} />
        <Textarea label="홍보 규칙 요약" rows={3} value={rules} onChange={(e) => setRules(e.target.value)} />
        <Textarea label="청중 적합도" rows={2} value={fit} onChange={(e) => setFit(e.target.value)} />
        <Textarea label="적합 이유" rows={2} value={rationale} onChange={(e) => setRationale(e.target.value)} />
        {channel.kind === 'email' && <EmailConfigFields value={email} onChange={setEmail} credentials={credentials} />}
        {error && <div role="alert" style={{ fontSize: 12, color: tokens.colors.dangerLight }}>{error}</div>}
      </div>
    </Modal>
  );
}

// ── 게시물 · 메일 ───────────────────────────────────────────────────────────

const POST_KIND_LABELS: Record<string, string> = { post: '게시글', reply: '댓글', email: '메일' };

/** 답글이 달릴 곳 — reddit 은 r/<subreddit>, github 는 owner/repo 그대로. */
function replyTargetLabel(platform: string | undefined, target: string): string {
  const t = (target || '').trim();
  if (platform === 'reddit') return t.startsWith('r/') ? t : `r/${t}`;
  return t;
}

function approveLabel(channelKind: string | undefined, postKind: string): string {
  if (postKind === 'email' || channelKind === 'email') return '승인하고 발송';
  if (channelKind === 'outreach') return '승인하고 게시';
  return '승인';
}

export function PostCard({ post }: { post: MarketingPost }) {
  const ctx = useMarketingCtx();
  const { busy, run } = useAction();
  const channel = ctx.channels.get(post.channel_id);
  const isEmail = post.kind === 'email';
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(post.title);
  const [body, setBody] = useState(post.body);
  const [confirming, setConfirming] = useState(false);
  const [approveNote, setApproveNote] = useState('');
  const [rejecting, setRejecting] = useState(false);
  const [recording, setRecording] = useState(false);
  const [permalink, setPermalink] = useState('');
  const [retrying, setRetrying] = useState(false);
  const [sends, setSends] = useState<MarketingPostSends | null>(null);

  useEffect(() => {
    if (!editing) {
      setTitle(post.title);
      setBody(post.body);
    }
  }, [post.title, post.body, editing]);

  const titleChanged = editing && title !== post.title;
  const bodyChanged = editing && body.replace(/\r\n/g, '\n').trim() !== post.body.trim();
  const preview = bodyChanged ? (isEmail ? body.replace(/\r\n/g, '\n').trim() : previewCommunityBody(body, ctx.disclosure)) : post.preview_body;
  const draft = post.status === 'draft';
  // 서버가 확인한 답글 대상 — 확인하지 않은 글은 {} 로 온다.
  const replyContext = post.reply_context && post.reply_context.target ? post.reply_context : null;

  const approve = async () => {
    const edits: { title?: string; body?: string; note?: string } = {};
    if (titleChanged) edits.title = title;
    if (bodyChanged) edits.body = body;
    if (approveNote.trim()) edits.note = approveNote.trim();
    const saved = await run(() => api.approveMarketingPost(post.id, edits));
    if (!saved) return;
    setConfirming(false);
    setEditing(false);
    if (saved.status === 'failed') ctx.notify(`승인했지만 보내지 못했습니다: ${saved.error || '알 수 없는 오류'}`, 'error');
    else if (saved.status === 'published') ctx.notify('게시했습니다', 'success');
    else if (saved.status === 'sending') ctx.notify('발송 큐에 넣었습니다 — 동의 연락처에게 차례로 보냅니다', 'success');
    else ctx.notify('승인했습니다 — 직접 게시한 뒤 글 주소를 기록하세요', 'success');
  };

  const loadSends = async () => {
    try {
      setSends(await api.listMarketingPostSends(post.id));
    } catch (err) {
      ctx.notify((err as Error)?.message || '발송 현황을 불러오지 못했습니다', 'error');
    }
  };

  const actions = ctx.canManage ? (
    <>
      {draft && !editing && <Button size="sm" variant="ghost" disabled={busy} onClick={() => setEditing(true)}>수정</Button>}
      {draft && editing && <Button size="sm" variant="ghost" disabled={busy} onClick={() => setEditing(false)}>수정 취소</Button>}
      {draft && (
        <Button size="sm" variant="primary" disabled={busy} onClick={() => { setApproveNote(''); setConfirming(true); }}>
          {approveLabel(channel?.kind, post.kind)}…
        </Button>
      )}
      {draft && <Button size="sm" variant="danger" disabled={busy} onClick={() => setRejecting(true)}>거부</Button>}
      {post.status === 'approved' && channel?.kind !== 'outreach' && channel?.kind !== 'email' && (
        <Button size="sm" variant="primary" disabled={busy} onClick={() => { setPermalink(''); setRecording(true); }}>게시 완료 기록…</Button>
      )}
      {post.status === 'failed' && channel?.kind === 'outreach' && (
        <Button size="sm" variant="secondary" disabled={busy} onClick={() => setRetrying(true)}>다시 시도…</Button>
      )}
      {isEmail && post.status !== 'draft' && post.status !== 'rejected' && (
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => void loadSends()}>발송 현황</Button>
      )}
    </>
  ) : null;

  return (
    <Panel
      testId={`marketing-post-${post.id}`}
      tone={draft ? 'attention' : post.status === 'failed' ? 'danger' : undefined}
      title={(
        <span style={{ display: 'inline-flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <Chip>{POST_KIND_LABELS[post.kind] || post.kind}</Chip>
          <span>{channel ? `${channel.name}` : '(알 수 없는 채널)'}</span>
          <StatusPill view={postStatusView(post.status, channel?.kind)} />
          {post.edited && <Chip muted>사람이 수정함</Chip>}
        </span>
      )}
      actions={actions}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <Meta>
          {channel && <span>{platformLabel(channel.platform)}{channel.target ? ` · ${channel.target}` : ''}</span>}
          <span>· 작성 {actorKind(post.created_by_type)} {post.created_by_name} · {relativeTime(post.created_at)}</span>
          {post.reply_to && !replyContext && <span>· 답글 대상 <code>{post.reply_to}</code></span>}
        </Meta>

        {post.kind === 'reply' && replyContext && (
          <div data-testid={`marketing-post-reply-context-${post.id}`} style={{ fontSize: 12.5, color: tokens.colors.textStrong, lineHeight: 1.5 }}>
            {/* 제목은 외부인이 쓴 글 — 글자로만(링크 · 마크업으로 만들지 않는다). */}
            답글 대상: {replyTargetLabel(channel?.platform, replyContext.target || '')}
            {replyContext.title ? ` — ${replyContext.title}` : ''}
            {replyContext.permalink && (
              <>
                {' '}
                <ExternalLink href={replyContext.permalink}>스레드 열기</ExternalLink>
              </>
            )}
          </div>
        )}
        {post.kind === 'reply' && !replyContext && channel?.kind === 'outreach' && draft && (
          <Hint tone="warning">
            답글이 달릴 스레드가 이 채널 안인지 확인되지 않았습니다 — 승인해도 서버가 게시하지 않습니다. 거부하고 에이전트가 다시 쓰게 하세요.
          </Hint>
        )}

        {editing ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <Input label={isEmail ? '메일 제목' : '제목'} aria-label="게시물 제목" value={title} onChange={(e) => setTitle(e.target.value)} />
            <Textarea label="본문" aria-label="게시물 본문" rows={8} value={body} onChange={(e) => setBody(e.target.value)} />
          </div>
        ) : (
          post.title ? <div style={{ fontSize: 14, fontWeight: 700, color: tokens.colors.textPrimary }}>{post.title}</div> : null
        )}

        <div>
          <FieldLabel>{draft ? '승인하면 실제로 나갈 내용' : '나간 내용'}{bodyChanged ? ' (수정 반영)' : ''}</FieldLabel>
          <div
            data-testid={`marketing-post-preview-${post.id}`}
            style={{
              fontSize: 13,
              whiteSpace: 'pre-wrap',
              lineHeight: 1.55,
              color: tokens.colors.textStrong,
              background: tokens.colors.surface,
              border: `1px solid ${tokens.colors.border}`,
              borderRadius: tokens.radii.sm,
              padding: 10,
              maxHeight: 320,
              overflow: 'auto',
              overflowWrap: 'anywhere',
            }}
          >
            {preview}
          </div>
          {draft && (
            <Hint>
              {isEmail
                ? '제목 앞 광고 표기 · 발신자 이름과 주소 · 연락처 · 수신거부 링크는 서버가 발송할 때 붙입니다(뺄 수 없습니다).'
                : '끝의 공개 문구는 캠페인 설정에 따라 서버가 붙입니다(뺄 수 없습니다). 승인한 글과 나가는 글은 같습니다.'}
            </Hint>
          )}
        </div>

        {draft && channel && (channel.guidelines || channel.rules_summary) && (
          <Quote label="채널 가이드 · 홍보 규칙" tone="warning">
            {[channel.guidelines, channel.rules_summary].filter(Boolean).join('\n\n')}
          </Quote>
        )}

        <KeyValue
          items={[
            ['쓴 이유', post.rationale ? <Prose text={post.rationale} /> : ''],
            ['추적 링크', post.link_codes?.length ? post.link_codes.join(', ') : ''],
            ['결정', post.decided_by_name ? `${post.decided_by_name} · ${formatDateTime(post.decided_at)}` : ''],
            ['결정 메모', post.decision_note],
            ['게시 주소', post.permalink ? <ExternalLink href={post.permalink} /> : ''],
            ['게시 시각', post.published_at ? formatDateTime(post.published_at) : ''],
            ['오류', post.error ? <span style={{ color: tokens.colors.dangerLight }}>{post.error}</span> : ''],
          ]}
        />

        {sends && (
          <div data-testid={`marketing-post-sends-${post.id}`}>
            <FieldLabel>발송 현황</FieldLabel>
            <Meta>
              {Object.keys(sends.counts).length
                ? Object.entries(sends.counts).map(([status, n]) => <span key={status}>{status} {formatCount(n)}</span>)
                : <span>아직 발송 기록이 없습니다</span>}
            </Meta>
          </div>
        )}
      </div>

      <Modal
        isOpen={confirming}
        onClose={() => setConfirming(false)}
        title={isEmail ? '메일 발송 승인' : '게시 승인'}
        maxWidth={600}
        footer={(
          <>
            <Button variant="secondary" onClick={() => setConfirming(false)}>취소</Button>
            <Button variant="primary" disabled={busy} onClick={() => void approve()}>
              {busy ? '처리 중…' : approveLabel(channel?.kind, post.kind)}
            </Button>
          </>
        )}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ fontSize: 13, color: tokens.colors.textSecondary, lineHeight: 1.5 }}>
            {isEmail
              ? `"${channel?.list_name || '수신 목록'}" 목록의 동의 연락처에게 보냅니다. 승인하면 발송 큐가 만들어지고 되돌릴 수 없습니다.`
              : channel?.kind === 'outreach'
                ? `${channel.name} 에 서버가 바로 게시합니다. 회사 이름으로 외부에 나가는 글입니다.`
                : '승인하면 이 글이 확정됩니다. 직접 게시한 뒤 글 주소를 기록하세요.'}
          </div>
          {(titleChanged ? title : post.title) && (
            <div style={{ fontSize: 13, fontWeight: 700, color: tokens.colors.textPrimary }}>{titleChanged ? title : post.title}</div>
          )}
          <div style={{ fontSize: 12.5, whiteSpace: 'pre-wrap', color: tokens.colors.textStrong, maxHeight: 240, overflow: 'auto', border: `1px solid ${tokens.colors.border}`, borderRadius: tokens.radii.sm, padding: 8 }}>
            {preview}
          </div>
          <Textarea label="승인 메모 (선택)" rows={2} value={approveNote} onChange={(e) => setApproveNote(e.target.value)} />
        </div>
      </Modal>

      <NoteModal
        isOpen={rejecting}
        title={isEmail ? '메일 초안 거부' : '게시 초안 거부'}
        message="거부 사유는 다음 사이클 지시문에 실려 에이전트가 배웁니다 — 무엇이 문제였는지(톤 · 사실 · 규칙 위반 …) 적어 주세요."
        label="거부 사유"
        required
        danger
        busy={busy}
        confirmLabel="거부"
        onClose={() => setRejecting(false)}
        onSubmit={async (note) => {
          const done = await run(() => api.rejectMarketingPost(post.id, note), '초안을 거부했습니다');
          if (done) setRejecting(false);
        }}
      />

      <Modal
        isOpen={recording}
        onClose={() => setRecording(false)}
        title="게시 완료 기록"
        maxWidth={520}
        footer={(
          <>
            <Button variant="secondary" onClick={() => setRecording(false)}>취소</Button>
            <Button
              variant="primary"
              disabled={busy || !safeHttpUrl(permalink)}
              onClick={async () => {
                // 검사한 주소를 정규화해서 보낸다(대문자 스킴 · 공백) — 서버는 /^https?:\/\/\S+$/ 로 본다.
                const url = safeHttpUrl(permalink);
                if (!url) return;
                const done = await run(() => api.markMarketingPostPublished(post.id, url), '게시를 기록했습니다');
                if (done) setRecording(false);
              }}
            >
              기록
            </Button>
          </>
        )}
      >
        <Input label="올린 글의 주소(http/https)" value={permalink} placeholder="https://…" onChange={(e) => setPermalink(e.target.value)} />
        <Hint>수동 채널은 사람이 직접 올립니다. 올린 뒤 그 글의 주소를 남기면 성과 리포트가 이 글을 셉니다.</Hint>
      </Modal>

      <Modal
        isOpen={retrying}
        onClose={() => setRetrying(false)}
        title="게시 다시 시도"
        maxWidth={480}
        footer={(
          <>
            <Button variant="secondary" onClick={() => setRetrying(false)}>취소</Button>
            <Button
              variant="primary"
              disabled={busy}
              onClick={async () => {
                const saved = await run(() => api.retryMarketingPost(post.id));
                if (!saved) return;
                setRetrying(false);
                if (saved.status === 'failed') ctx.notify(`다시 실패했습니다: ${saved.error || '알 수 없는 오류'}`, 'error');
                else ctx.notify('게시했습니다', 'success');
              }}
            >
              다시 게시
            </Button>
          </>
        )}
      >
        <div style={{ fontSize: 13, color: tokens.colors.warningLight, lineHeight: 1.5 }}>
          앞의 시도가 실제로는 올라갔을 수 있습니다. {channel?.target ? `${channel.target} 에서 ` : ''}이 글이 이미 있는지 먼저 확인하세요 —
          같은 글이 두 번 올라가면 커뮤니티 규칙 위반이 될 수 있습니다.
        </div>
        {post.error && <Hint tone="danger">지난 오류: {post.error}</Hint>}
      </Modal>
    </Panel>
  );
}

// ── 예산 편성 ───────────────────────────────────────────────────────────────

export function AllocationCard({ allocation, currentMinor }: { allocation: MarketingAllocation; currentMinor?: number | null }) {
  const ctx = useMarketingCtx();
  const { busy, run } = useAction();
  const [approving, setApproving] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const channel = ctx.channels.get(allocation.channel_id);
  const proposed = allocation.status === 'proposed';
  const currency = allocation.currency || ctx.currency;
  return (
    <Panel
      testId={`marketing-allocation-${allocation.id}`}
      tone={proposed ? 'attention' : undefined}
      title={(
        <span style={{ display: 'inline-flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <span>예산 편성 · {channel?.name || '(알 수 없는 채널)'}</span>
          <StatusPill view={allocationStatusView(allocation.status)} />
        </span>
      )}
      actions={proposed && ctx.canApproveSpend ? (
        <>
          <Button size="sm" variant="primary" disabled={busy} onClick={() => setApproving(true)}>승인…</Button>
          <Button size="sm" variant="danger" disabled={busy} onClick={() => setRejecting(true)}>거부</Button>
        </>
      ) : null}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div style={{ fontSize: 18, fontWeight: 700, color: tokens.colors.textPrimary, fontVariantNumeric: 'tabular-nums' }}>
          {formatMinor(allocation.amount_minor, currency)}
          <span style={{ fontSize: 12, fontWeight: 500, color: tokens.colors.textMuted, marginLeft: 8 }}>기간 편성액</span>
        </div>
        <KeyValue
          items={[
            ['현재 편성', proposed ? (currentMinor === null || currentMinor === undefined ? '없음(이 채널에는 아직 지출할 수 없음)' : formatMinor(currentMinor, currency)) : ''],
            ['근거', allocation.rationale ? <Prose text={allocation.rationale} /> : ''],
            ['제안', `${actorKind(allocation.proposed_by_type)} ${allocation.proposed_by_name} · ${relativeTime(allocation.created_at)}`],
            ['결정', allocation.decided_by_name ? `${allocation.decided_by_name} · ${formatDateTime(allocation.decided_at)}` : ''],
            ['결정 메모', allocation.decision_note],
          ]}
        />
        {proposed && !ctx.canApproveSpend && <Hint>예산 편성은 지출 승인 권한(marketing.approve_spend)이 있는 사람이 정합니다.</Hint>}
      </div>
      <NoteModal
        isOpen={approving}
        title="예산 편성 승인"
        message={`${channel?.name || '이 채널'} 의 기간 편성액을 ${formatMinor(allocation.amount_minor, currency)} 로 정합니다. 승인하면 이 채널의 이전 편성을 대체합니다(지출은 따로 승인합니다).`}
        label="승인 메모"
        busy={busy}
        confirmLabel="편성 승인"
        onClose={() => setApproving(false)}
        onSubmit={async (note) => {
          const done = await run(() => api.approveMarketingAllocation(allocation.id, note), '예산 편성을 승인했습니다');
          if (done) setApproving(false);
        }}
      />
      <NoteModal
        isOpen={rejecting}
        title="예산 편성 거부"
        message="거부 사유는 에이전트가 다음 제안에서 배웁니다."
        label="거부 사유"
        required
        danger
        busy={busy}
        confirmLabel="거부"
        onClose={() => setRejecting(false)}
        onSubmit={async (note) => {
          const done = await run(() => api.rejectMarketingAllocation(allocation.id, note), '예산 편성을 거부했습니다');
          if (done) setRejecting(false);
        }}
      />
    </Panel>
  );
}

// ── 지출 요청 ───────────────────────────────────────────────────────────────

type SpendDialog = 'approve' | 'deny' | 'cancel' | 'paid' | 'failed' | 'refund' | null;

export function SpendCard({ spend }: { spend: MarketingSpendRequest }) {
  const ctx = useMarketingCtx();
  const { busy, run } = useAction();
  const [dialog, setDialog] = useState<SpendDialog>(null);
  const channel = ctx.channels.get(spend.channel_id);
  const currency = spend.currency || ctx.currency;
  const approval = spendApprovalState(spend, ctx.dualThresholdMinor, ctx.userId);
  const expired = isSpendExpired(spend);
  const pending = spend.status === 'pending';
  const unknown = spend.status === 'unknown';
  const close = () => setDialog(null);

  const actions = ctx.canApproveSpend ? (
    <>
      {pending && !expired && !approval.mine && (
        <Button size="sm" variant="primary" disabled={busy} onClick={() => setDialog('approve')}>승인…</Button>
      )}
      {pending && <Button size="sm" variant="danger" disabled={busy} onClick={() => setDialog('deny')}>거부</Button>}
      {pending && <Button size="sm" variant="ghost" disabled={busy} onClick={() => setDialog('cancel')}>요청 취소</Button>}
      {spend.status === 'approved' && canCancelSpend(spend) && (
        <Button size="sm" variant="secondary" disabled={busy} onClick={() => setDialog('cancel')}>취소(보내기 전)</Button>
      )}
      {canReconcileSpend(spend) && (
        <Button size="sm" variant="primary" disabled={busy} onClick={() => setDialog('paid')}>결제 완료 기록…</Button>
      )}
      {canReconcileSpend(spend) && (
        <Button size="sm" variant="danger" disabled={busy} onClick={() => setDialog('failed')}>실패로 기록…</Button>
      )}
      {spend.status === 'paid' && <Button size="sm" variant="secondary" disabled={busy} onClick={() => setDialog('refund')}>환불 기록…</Button>}
    </>
  ) : null;

  return (
    <Panel
      testId={`marketing-spend-${spend.id}`}
      tone={unknown ? 'danger' : pending ? 'attention' : undefined}
      title={(
        <span style={{ display: 'inline-flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <span>지출 요청 · {spend.payee}</span>
          <StatusPill view={spendStatusView(spend.status)} />
          {pending && approval.label && <span data-testid={`marketing-spend-dual-${spend.id}`}><StatusPill view={{ label: approval.label, tone: 'queued' }} /></span>}
        </span>
      )}
      actions={actions}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {unknown && (
          <div
            role="alert"
            data-testid={`marketing-spend-unknown-${spend.id}`}
            style={{
              border: `1px solid ${tokens.colors.danger}`,
              background: tokens.colors.dangerBg,
              color: tokens.colors.textInverse,
              borderRadius: tokens.radii.sm,
              padding: '10px 12px',
              fontSize: 13,
              fontWeight: 600,
              lineHeight: 1.5,
            }}
          >
            ⚠ {UNKNOWN_SPEND_MESSAGE}
            {spend.error && <div style={{ fontWeight: 400, marginTop: 4 }}>사유: {spend.error}</div>}
          </div>
        )}

        <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
          <span data-testid={`marketing-spend-amount-${spend.id}`} style={{ fontSize: 22, fontWeight: 800, color: tokens.colors.textPrimary, fontVariantNumeric: 'tabular-nums' }}>
            {formatMinor(spend.amount_minor, currency)}
          </span>
          <span style={{ fontSize: 12, color: tokens.colors.textMuted }}>통화 {currency}</span>
        </div>

        <KeyValue
          items={[
            ['수취인', `${spend.payee}${spend.payee_ref ? ` (${spend.payee_ref})` : ''}`],
            ['채널', channel ? `${channel.name} · ${platformLabel(channel.platform)}` : spend.channel_id],
            ['목적', <Prose key="purpose" text={spend.purpose} />],
            ['기대 효과', <Prose key="outcome" text={spend.expected_outcome} empty="(없음)" />],
            ['결제 방식', PAYMENT_PROVIDER_LABELS[spend.provider] || spend.provider],
            ['요청', `${actorKind(spend.requested_by_type)} ${spend.requested_by_name} · ${formatDateTime(spend.created_at)}`],
            ['만료', pending ? `${formatDateTime(spend.expires_at)}${expired ? ' — 만료됨(승인 불가)' : ''}` : ''],
            ['예산 기간', spend.period_key],
            ['승인', spend.approvals?.length ? spend.approvals.map((a) => `${a.name} · ${formatDateTime(a.at)}`).join(', ') : ''],
            ['결정', spend.decided_by_name ? `${spend.decided_by_name} · ${formatDateTime(spend.decided_at)}` : ''],
            ['결정 메모', spend.decision_note],
            ['결제 시각', spend.paid_at ? formatDateTime(spend.paid_at) : ''],
            ['거래 id', spend.provider_ref],
            ['영수증', spend.receipt_url ? <ExternalLink href={spend.receipt_url} /> : ''],
            ['오류', !unknown && spend.error ? <span style={{ color: tokens.colors.dangerLight }}>{spend.error}</span> : ''],
          ]}
        />

        <div>
          <FieldLabel>실행 payload — 승인하면 이 내용 그대로 실행됩니다</FieldLabel>
          <JsonBlock value={spend.payload} testId={`marketing-spend-payload-${spend.id}`} />
          <Hint>
            payload sha256 <code data-testid={`marketing-spend-hash-${spend.id}`}>{shortHash(spend.payload_sha256)}</code>… — 승인할 때 이 해시를 함께 보내
            서버가 실행 직전에 다시 대조합니다.
          </Hint>
        </div>

        {spend.provider_response && Object.keys(spend.provider_response).length > 0 && (
          <details>
            <summary style={{ fontSize: 12, color: tokens.colors.textSecondary, cursor: 'pointer' }}>결제 시스템 응답</summary>
            <JsonBlock value={spend.provider_response} />
          </details>
        )}

        {pending && approval.mine && <Hint tone="warning">{SECOND_APPROVAL_MESSAGE}</Hint>}
        {pending && approval.required === 2 && !approval.mine && approval.given === 0 && (
          <Hint>2인 승인 대상입니다 — 서로 다른 승인자 두 명이 각각 승인해야 실행됩니다.</Hint>
        )}
        {pending && approval.required === 2 && !approval.mine && approval.given === 1 && (
          <Hint>첫 승인이 기록됐습니다 — 다른 승인자의 두 번째 승인을 기다립니다.</Hint>
        )}
        {!ctx.canApproveSpend && (pending || canReconcileSpend(spend)) && (
          <Hint>지출 승인 · 결제 기록은 marketing.approve_spend 권한이 있는 사람만 할 수 있습니다.</Hint>
        )}
        {spend.status === 'executing' && <Hint>결제 시스템의 응답을 기다리는 중입니다 — 다시 보내지 않습니다.</Hint>}
      </div>

      {dialog === 'approve' && <SpendApproveModal spend={spend} channelName={channel?.name || ''} onClose={close} />}
      <NoteModal
        isOpen={dialog === 'deny'}
        title="지출 거부"
        message="거부 사유는 에이전트에게 전달됩니다. 예산은 묶이지 않습니다."
        label="거부 사유"
        required
        danger
        busy={busy}
        confirmLabel="거부"
        onClose={close}
        onSubmit={async (note) => {
          const done = await run(() => api.denyMarketingSpend(spend.id, note), '지출을 거부했습니다');
          if (done) close();
        }}
      />
      <NoteModal
        isOpen={dialog === 'cancel'}
        title={spend.status === 'approved' ? '승인된 지출 취소(보내기 전)' : '지출 요청 취소'}
        message={spend.status === 'approved'
          ? '승인했지만 아직 보내지 않은 요청을 닫고 보류한 예산을 풉니다. 이미 AWB 밖에서 결제했다면 취소하지 말고 결제 완료를 기록하세요.'
          : '결정과 별개로, 더 이상 필요 없는 요청을 닫습니다.'}
        label="취소 사유"
        busy={busy}
        confirmLabel="요청 취소"
        onClose={close}
        onSubmit={async (note) => {
          const done = await run(() => api.cancelMarketingSpend(spend.id, note), '지출 요청을 취소했습니다');
          if (done) close();
        }}
      />
      <NoteModal
        isOpen={dialog === 'failed'}
        title="결제 실패로 기록"
        message={unknown
          ? '결제 시스템에서 실제로 결제되지 않았음을 확인했을 때만 실패로 기록하세요. 보류한 예산이 풀립니다.'
          : 'AWB 밖 결제가 이루어지지 않았을 때 기록합니다. 보류한 예산이 풀립니다.'}
        label="확인한 내용"
        required
        danger
        busy={busy}
        confirmLabel="실패로 기록"
        onClose={close}
        onSubmit={async (note) => {
          const done = await run(() => api.markMarketingSpendFailed(spend.id, note), '결제 실패를 기록했습니다');
          if (done) close();
        }}
      />
      {dialog === 'paid' && <MarkPaidModal spend={spend} onClose={close} />}
      {dialog === 'refund' && <RefundModal spend={spend} onClose={close} />}
    </Panel>
  );
}

/**
 * 지출 승인의 확인 단계. 금액 · 수취인 · 채널 · 공급자 · 해시를 다시 보여 주고, 사람이 "이 금액의 결제를
 * 승인합니다" 를 직접 체크해야 버튼이 켜진다. 보내는 해시는 이 화면이 보여 준 요청의 것이다.
 */
function SpendApproveModal({ spend, channelName, onClose }: { spend: MarketingSpendRequest; channelName: string; onClose(): void }) {
  const ctx = useMarketingCtx();
  const { busy, run } = useAction();
  const [confirmed, setConfirmed] = useState(false);
  const [note, setNote] = useState('');
  // 이 모달이 열릴 때 보여 준 요청의 해시 — 그사이 목록이 다시 읽혀도 사람이 본 것을 보낸다.
  const [shownHash] = useState(spend.payload_sha256);
  const currency = spend.currency || ctx.currency;
  const approval = spendApprovalState(spend, ctx.dualThresholdMinor, ctx.userId);

  const submit = async () => {
    if (!confirmed) return;
    const result = await run(() => api.approveMarketingSpend(spend.id, shownHash, note.trim()));
    if (!result) return;
    onClose();
    if (!result.final) ctx.notify(SECOND_APPROVAL_MESSAGE, 'info');
    else if (result.status === 'paid') ctx.notify('승인했고 결제 시스템이 결제를 완료했습니다', 'success');
    else if (result.status === 'unknown') ctx.notify(UNKNOWN_SPEND_MESSAGE, 'error');
    else if (result.status === 'failed') ctx.notify(`승인했지만 결제가 거절됐습니다: ${result.error || ''}`, 'error');
    else if (result.provider === 'manual') ctx.notify('승인했습니다 — AWB 밖에서 결제한 뒤 결제 완료를 기록하세요', 'success');
    else ctx.notify('결제를 승인했습니다', 'success');
  };

  return (
    <Modal
      isOpen
      onClose={onClose}
      title="결제 승인 확인"
      maxWidth={620}
      footer={(
        <>
          <Button variant="secondary" onClick={onClose}>취소</Button>
          <Button variant="primary" data-testid="marketing-spend-approve-confirm" disabled={!confirmed || busy} onClick={() => void submit()}>
            {busy ? '처리 중…' : '결제 승인'}
          </Button>
        </>
      )}
    >
      <div data-testid="marketing-spend-approve-dialog" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={{ fontSize: 24, fontWeight: 800, color: tokens.colors.textPrimary, fontVariantNumeric: 'tabular-nums' }}>
          {formatMinor(spend.amount_minor, currency)}
        </div>
        <KeyValue
          items={[
            ['수취인', `${spend.payee}${spend.payee_ref ? ` (${spend.payee_ref})` : ''}`],
            ['채널', channelName || spend.channel_id],
            ['목적', spend.purpose],
            ['기대 효과', spend.expected_outcome],
            ['결제 방식', PAYMENT_PROVIDER_LABELS[spend.provider] || spend.provider],
            ['payload sha256', <code key="hash">{shortHash(shownHash)}…</code>],
          ]}
        />
        <JsonBlock value={spend.payload} maxHeight={180} />
        <Hint tone="warning">
          {spend.provider === 'webhook'
            ? '승인하면 서버가 곧바로 결제 엔드포인트로 이 내용을 보냅니다. 자동 재시도는 없습니다.'
            : '승인하면 이 금액이 예산에서 보류됩니다. AWB 밖에서 결제한 뒤 거래 id 와 함께 결제 완료를 기록하세요.'}
          {approval.required === 2 && ' 2인 승인 대상이라 다른 승인자 한 명이 더 승인해야 실행됩니다.'}
        </Hint>
        <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13, fontWeight: 700, color: tokens.colors.textPrimary, cursor: 'pointer' }}>
          <input
            type="checkbox"
            data-testid="marketing-spend-approve-check"
            checked={confirmed}
            onChange={(e) => setConfirmed(e.target.checked)}
          />
          {SPEND_CONFIRM_PHRASE}
        </label>
        <Textarea label="승인 메모 (선택)" rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
      </div>
    </Modal>
  );
}

function MarkPaidModal({ spend, onClose }: { spend: MarketingSpendRequest; onClose(): void }) {
  const { busy, run } = useAction();
  const [ref, setRef] = useState('');
  const [receipt, setReceipt] = useState('');
  const [note, setNote] = useState('');
  const receiptOk = !receipt.trim() || !!safeHttpUrl(receipt);
  return (
    <Modal
      isOpen
      onClose={onClose}
      title="결제 완료 기록"
      maxWidth={520}
      footer={(
        <>
          <Button variant="secondary" onClick={onClose}>취소</Button>
          <Button
            variant="primary"
            disabled={busy || !ref.trim() || !receiptOk}
            onClick={async () => {
              const done = await run(
                () => {
                  const receiptUrl = receipt.trim() ? safeHttpUrl(receipt) : null;
                  return api.markMarketingSpendPaid(spend.id, {
                    provider_ref: ref.trim(),
                    ...(receiptUrl ? { receipt_url: receiptUrl } : {}),
                    ...(note.trim() ? { note: note.trim() } : {}),
                  });
                },
                '결제 완료를 기록했습니다',
              );
              if (done) onClose();
            }}
          >
            기록
          </Button>
        </>
      )}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={{ fontSize: 13, color: tokens.colors.textSecondary }}>
          {formatMinor(spend.amount_minor, spend.currency)} → {spend.payee}
        </div>
        {spend.status === 'unknown' && <Hint tone="danger">{UNKNOWN_SPEND_MESSAGE}</Hint>}
        <Input label="거래 id (필수)" value={ref} onChange={(e) => setRef(e.target.value)} />
        <Input label="영수증 주소 (선택, http/https)" value={receipt} onChange={(e) => setReceipt(e.target.value)} error={receiptOk ? undefined : 'http(s) 주소여야 합니다'} />
        <Textarea label="메모 (선택)" rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
        <Hint>나중에 대조할 수 없는 “결제 완료” 는 기록이 아닙니다 — 결제 시스템의 거래 id 를 그대로 적으세요.</Hint>
      </div>
    </Modal>
  );
}

function RefundModal({ spend, onClose }: { spend: MarketingSpendRequest; onClose(): void }) {
  const { busy, run } = useAction();
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [ref, setRef] = useState('');
  const [refundable, setRefundable] = useState<number | null>(null);
  useEffect(() => {
    let cancelled = false;
    api.getMarketingSpendRequest(spend.id)
      .then((detail) => {
        if (cancelled) return;
        let captured = 0;
        let refunded = 0;
        for (const row of detail.ledger || []) {
          if (row.kind === 'capture') captured += Number(row.amount_minor) || 0;
          if (row.kind === 'refund') refunded += Number(row.amount_minor) || 0;
        }
        setRefundable(captured - refunded);
      })
      .catch(() => { if (!cancelled) setRefundable(null); });
    return () => { cancelled = true; };
  }, [spend.id]);
  const parsed = amount.trim() ? parseMajorToMinor(amount, spend.currency) : null;
  const over = parsed?.ok && refundable !== null && parsed.minor > refundable;
  return (
    <Modal
      isOpen
      onClose={onClose}
      title="환불 기록"
      maxWidth={520}
      footer={(
        <>
          <Button variant="secondary" onClick={onClose}>취소</Button>
          <Button
            variant="primary"
            disabled={busy || !parsed?.ok || !!over || !note.trim()}
            onClick={async () => {
              if (!parsed?.ok) return;
              const done = await run(
                () => api.refundMarketingSpend(spend.id, { amount_minor: parsed.minor, note: note.trim(), ...(ref.trim() ? { provider_ref: ref.trim() } : {}) }),
                '환불을 기록했습니다',
              );
              if (done) onClose();
            }}
          >
            환불 기록
          </Button>
        </>
      )}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={{ fontSize: 13, color: tokens.colors.textSecondary }}>
          결제 {formatMinor(spend.amount_minor, spend.currency)} → {spend.payee}
          {refundable !== null && ` · 환불 가능 ${formatMinor(refundable, spend.currency)}`}
        </div>
        <Input
          label={`환불 금액 (${spend.currency})`}
          value={amount}
          inputMode="decimal"
          onChange={(e) => setAmount(e.target.value)}
          error={parsed && !parsed.ok ? parsed.error : over ? '환불 가능 금액보다 큽니다' : undefined}
        />
        <Input label="거래 id (선택)" value={ref} onChange={(e) => setRef(e.target.value)} />
        <Textarea label="사유 (필수)" rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
        <Hint>환불은 결제 기록에 묶여 원장에 남고, 요청을 다시 열지 않습니다. 환불액은 원래 결제한 기간의 예산으로 돌아갑니다.</Hint>
      </div>
    </Modal>
  );
}
