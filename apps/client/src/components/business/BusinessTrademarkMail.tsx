import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api';
import type { BusinessCompany, BusinessTrademark, TrademarkMail, TrademarkMailKind, TrademarkMailPayload, TrademarkMailReview } from '../../business.types';
import { useAuth } from '../../contexts/AuthContext';
import { Button, Input, Modal, Select, Textarea } from '../common';
import { dateTime } from './business.logic';
import { MAIL_DELIVERY, TRADEMARK_MAIL_KINDS, TRADEMARK_MAIL_STATUS, trademarkMailto } from './trademark.logic';

export function BusinessTrademarkMail({ company, trademark, mail, onClose, onChanged }: {
  company: BusinessCompany; trademark: BusinessTrademark; mail?: TrademarkMail; onClose(): void; onChanged(): Promise<void>;
}) {
  const { user, hasPermission } = useAuth();
  const [kind, setKind] = useState<TrademarkMailKind>('quote');
  const [payload, setPayload] = useState<TrademarkMailPayload>({ from: user?.email || '', to: trademark.attorney_email, reply_to: user?.email || '', subject: '', text: '' });
  const [credentials, setCredentials] = useState<Array<{ id: string; name: string }>>([]);
  const [credentialId, setCredentialId] = useState('');
  const [newKey, setNewKey] = useState('');
  const [review, setReview] = useState<TrademarkMailReview | null>(null);
  const [reviewLoaded, setReviewLoaded] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [providerId, setProviderId] = useState('');
  const [error, setError] = useState('');
  const [replyAddress, setReplyAddress] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(true);

  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        if (mail) {
          const value = await api.reviewTrademarkMail(company.id, trademark.id, mail.id);
          if (active) { setReview(value); setReviewLoaded(true); }
        } else {
          const [keys, draft, integrations] = await Promise.all([api.listBusinessCredentials(company.account_id), api.draftTrademarkMail(company.id, trademark.id, 'quote'), api.listTrademarkIntegrations(company.id, trademark.id).catch(() => null)]);
          const address = integrations?.connections.find(row => row.provider === 'resend_inbound' && row.ready)?.reply_address || '';
          if (active) { setCredentials(keys.filter(key => key.provider === 'resend')); setPayload(previous => ({ ...previous, ...draft, ...(address ? { reply_to: address } : {}) })); setReplyAddress(address); }
        }
      } catch (e) { if (active) setError((e as Error).message); }
      finally { if (active) setBusy(false); }
    };
    void load();
    return () => { active = false; };
  }, [company.id, company.account_id, trademark.id, mail?.id]);

  const run = async (action: () => Promise<void>) => {
    setBusy(true); setError(''); setNotice('');
    try { await action(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  const generate = () => run(async () => {
    const draft = await api.draftTrademarkMail(company.id, trademark.id, kind);
    setPayload(previous => ({ ...previous, ...draft }));
  });
  const prepare = () => run(async () => {
    let keyId = credentialId;
    if (keyId === '__new__') {
      const credential = await api.createCredential({ account_id: company.account_id, scope: 'account', provider: 'resend', name: `${company.name} · 상표 메일`, credentials: { api_key: newKey }, agent_env: false });
      keyId = credential.id; setCredentialId(keyId); setCredentials(previous => [...previous, credential]); setNewKey('');
    }
    const row = await api.prepareTrademarkMail(company.id, trademark.id, { provider: 'resend', credential_id: keyId, trademark_revision: trademark.revision, payload });
    // If the review request fails, preserve the saved record locally so the operator can reopen it, never create another draft.
    setReview({ mail: row, payload }); setConfirmed(false); setReviewLoaded(false);
    await onChanged();
    setReview(await api.reviewTrademarkMail(company.id, trademark.id, row.id)); setReviewLoaded(true);
  });
  const send = () => run(async () => {
    if (!review || !confirmed || !reviewLoaded) return;
    const row = await api.sendTrademarkMail(company.id, trademark.id, review.mail);
    setReview({ ...review, mail: row }); setConfirmed(false);
    await onChanged();
  });
  const discard = () => run(async () => {
    if (!review) return;
    await api.discardTrademarkMail(company.id, trademark.id, review.mail);
    await onChanged(); onClose();
  });
  const copy = () => run(async () => {
    const value = review?.payload || payload;
    await navigator.clipboard.writeText(`To: ${value.to}\nSubject: ${value.subject}\n\n${value.text}`);
    setNotice('초안을 복사했습니다. 메일함에서 검토한 후 발송하세요.');
  });
  const delivery = () => run(async () => {
    if (!review) return;
    const row = await api.trademarkMailDelivery(company.id, trademark.id, review.mail.id);
    setReview({ ...review, mail: row }); await onChanged();
  });
  const reconcile = () => run(async () => {
    if (!review || !confirmed || !reviewLoaded) return;
    const row = await api.reconcileTrademarkMail(company.id, trademark.id, review.mail, providerId);
    setReview({ ...review, mail: row }); setConfirmed(false); await onChanged();
  });
  const tooLate = !!review?.mail.first_attempted_at && Date.now() - Date.parse(review.mail.first_attempted_at) >= 23 * 60 * 60_000;
  const sending = review?.mail.status === 'sending' && !!review.mail.attempted_at && Date.now() - Date.parse(review.mail.attempted_at) < 120_000;
  const ready = !!credentialId && (credentialId !== '__new__' || !!newKey.trim()) && !!payload.from && !!payload.reply_to && !!payload.to && !!payload.subject.trim() && !!payload.text.trim();
  const retry = review && ['uncertain', 'sending'].includes(review.mail.status);
  return <Modal isOpen title={review ? '변호사 메일 검토 · 발송 기록' : '변호사에게 보낼 메일'} maxWidth={820} onClose={() => { if (!busy) onClose(); }}
    footer={<><Button variant="secondary" disabled={busy} onClick={onClose}>닫기</Button>{!review && !mail && <Button loading={busy} disabled={!ready} onClick={() => void prepare()}>발송 전 검토</Button>}{review && review.mail.status !== 'sent' && <Button loading={busy} disabled={!reviewLoaded || !confirmed || tooLate || !!sending} onClick={() => void send()}>{retry ? '같은 요청으로 접수 재확인' : '확인한 메일 실제 발송'}</Button>}</>}>
    <div className="business-form business-trademark-mail">
      <p className="business-guide-note">변호사와의 상담·자료 전달용입니다. 메일 접수는 수임·계약·출원 완료를 뜻하지 않습니다. 회신은 Reply-To 주소로 도착합니다. Resend 회신 커넥터의 상표별 주소를 사용하면 AWB에서 자동 수집합니다.</p>
      {!review && !mail && <>
        <div className="business-trademark-draft-picker"><Select label="문의 목적" aria-label="문의 목적" value={kind} options={TRADEMARK_MAIL_KINDS} onChange={e => setKind(e.target.value as TrademarkMailKind)} /><Button variant="secondary" disabled={busy} onClick={() => void generate()}>영문 초안 만들기</Button></div>
        <div className="business-form-grid">
          <Input label="발신 이메일 · 인증한 도메인" aria-label="발신 이메일" type="email" value={payload.from} onChange={e => setPayload({ ...payload, from: e.target.value })} />
          <Input label="회신 받을 이메일 · Reply-To" aria-label="회신 이메일" type="email" value={payload.reply_to} onChange={e => setPayload({ ...payload, reply_to: e.target.value })} />
        </div>
        {replyAddress && <p className="business-muted">자동 수집 주소: {replyAddress}</p>}
        <Input label="받는 변호사 · 상표 기록에서 지정" aria-label="받는 변호사 이메일" value={payload.to} readOnly />
        <Input label="제목" aria-label="메일 제목" maxLength={250} value={payload.subject} onChange={e => setPayload({ ...payload, subject: e.target.value })} />
        <Textarea label="검토할 영문 본문" aria-label="메일 본문" rows={13} maxLength={20000} value={payload.text} onChange={e => setPayload({ ...payload, text: e.target.value })} />
        <div className="business-guide-actions"><Button variant="ghost" disabled={busy || !payload.text} onClick={() => void copy()}>초안 복사</Button>{payload.to && payload.text && <a href={trademarkMailto(payload)}>메일 앱에서 열기 ↗</a>}</div>
        <div className="business-trademark-email-setup"><strong>Resend로 AWB에서 발송</strong><p>발신 도메인을 인증하고 Resend 키를 등록하세요. 전달 조회에는 해당 API 권한도 필요합니다. API를 사용하지 않으면 위 초안을 기존 메일함에서 보내세요.</p>
          <Select label="서버 전용 Resend 키" aria-label="Resend 연결 키" value={credentialId} options={[{ value: '', label: '저장된 키 선택' }, ...credentials.map(key => ({ value: key.id, label: key.name })), ...(hasPermission('admin.credentials') ? [{ value: '__new__', label: '+ 새 Resend 키 등록' }] : [])]} onChange={e => setCredentialId(e.target.value)} />
          {credentialId === '__new__' && <Input label="Resend API 키" aria-label="Resend API 키" type="password" autoComplete="new-password" value={newKey} onChange={e => setNewKey(e.target.value)} />}
          <div className="business-guide-actions"><a href="https://resend.com/docs/dashboard/domains/introduction" target="_blank" rel="noreferrer">발신 도메인 설정 ↗</a>{hasPermission('admin.credentials') && <Link to="/settings/credentials" target="_blank">키 관리 ↗</Link>}</div>
        </div>
      </>}
      {review && <>
        {!reviewLoaded && <div role="alert" className="business-error">저장된 발송 원문을 다시 확인해야 합니다. 창을 닫고 기존 검토 기록을 다시 열어 주세요. 발송은 차단되어 있습니다.</div>}
        <div className="business-section-heading"><span className={`business-pill ${review.mail.status === 'uncertain' ? 'blocked' : ''}`}>{TRADEMARK_MAIL_STATUS[review.mail.status]}</span><span className="business-muted">{dateTime(review.mail.created_at)}</span></div>
        <dl className="business-trademark-envelope"><dt>발신</dt><dd>{review.payload.from}</dd><dt>받는 사람</dt><dd>{review.payload.to}</dd><dt>회신 주소</dt><dd>{review.payload.reply_to}</dd><dt>제목</dt><dd>{review.payload.subject}</dd></dl>
        <pre className="business-trademark-mail-body">{review.payload.text}</pre>
        {review.mail.last_error && <div role="alert" className="business-stale">{review.mail.last_error}</div>}
        {review.mail.status === 'sent' ? <div className="business-trademark-receipt"><strong>{MAIL_DELIVERY[review.mail.delivery_status] || '공급자 상태 확인 필요'}</strong><p>발송 ID: {review.mail.provider_message_id}</p><p>조회 시각: {dateTime(review.mail.checked_at)}</p><Button variant="secondary" disabled={busy} onClick={() => void delivery()}>전달 상태 조회</Button></div> : <>
          <label className="business-trademark-consent"><input type="checkbox" checked={confirmed} disabled={busy} onChange={e => setConfirmed(e.target.checked)} /><span>수신자, 회신 주소와 본문을 검토했으며 이 내용의 실제 발송 또는 기존 발송 대조를 승인합니다.</span></label>
          {review.mail.status === 'draft' && <Button variant="ghost" disabled={busy} onClick={() => void discard()}>미발송 초안 삭제 · 다시 작성</Button>}
          {retry && <div className="business-trademark-email-setup"><strong>Resend 발송 이력과 원문 대조</strong><p>{tooLate ? '23시간이 지나 재발송은 차단했습니다. ' : ''}공급자 대시보드의 발송 ID를 입력하면 수신자·본문 등을 대조해 기존 접수를 확정합니다. 새 메일을 보내지 않습니다.</p><Input label="Resend 발송 ID" aria-label="Resend 발송 ID" value={providerId} onChange={e => setProviderId(e.target.value)} /><Button variant="secondary" disabled={busy || !reviewLoaded || !confirmed || !providerId || !!sending} onClick={() => void reconcile()}>발송 원문 대조</Button><a href="https://resend.com/emails" target="_blank" rel="noreferrer">Resend 발송 기록 ↗</a></div>}
        </>}
      </>}
      {notice && <p role="status">{notice}</p>}{error && <div role="alert" className="business-error">{error}</div>}
    </div>
  </Modal>;
}
