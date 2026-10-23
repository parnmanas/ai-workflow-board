import React, { useEffect, useState } from 'react';
import { api } from '../../api';
import type { BusinessCompany, BusinessTrademark, TrademarkConnectorDefinition, TrademarkIntegration, TrademarkIntegrationAction as Action, TrademarkMailKind, TrademarkMailPayload } from '../../business.types';
import { Button, Input, Modal, Select, Textarea } from '../common';
import { TRADEMARK_MAIL_KINDS, TRADEMARK_MAIL_STATUS } from './trademark.logic';

export function TrademarkIntegrationAction({ company, trademark, connector, connection, action, replyAddress, onClose, onChanged }: {
  company: BusinessCompany; trademark: BusinessTrademark; connector: TrademarkConnectorDefinition; connection: TrademarkIntegration; action?: Action; replyAddress?: string; onClose(): void; onChanged(): Promise<void>;
}) {
  const [review, setReview] = useState<Action | null>(null); const [busy, setBusy] = useState(true); const [error, setError] = useState('');
  const [confirmed, setConfirmed] = useState(false); const [externalId, setExternalId] = useState(''); const [kind, setKind] = useState<TrademarkMailKind>('quote');
  const [mail, setMail] = useState<TrademarkMailPayload>({ from: connection.identity?.email || '', to: trademark.attorney_email, reply_to: replyAddress || connection.identity?.email || '', subject: '', text: '' });
  const [subject, setSubject] = useState(`${trademark.mark} · Engagement agreement`);
  const [roles, setRoles] = useState<Array<{ role: string; name: string; email: string }>>([]);
  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        if (action) { const row = await api.reviewTrademarkAction(company.id, trademark.id, action.id); if (active) setReview(row); }
        else if (connector.action === 'contract') { const options = await api.trademarkIntegrationOptions(company.id, trademark.id, connection.id); if (active) setRoles(options.roles || []); }
        else { const draft = await api.draftTrademarkMail(company.id, trademark.id, 'quote'); if (active) setMail(previous => ({ ...previous, ...draft })); }
      } catch (e) { if (active) setError((e as Error).message); }
      finally { if (active) setBusy(false); }
    };
    void load(); return () => { active = false; };
  }, [company.id, trademark.id, connection.id, connector.action, action?.id]);
  const run = async (work: () => Promise<void>) => { setBusy(true); setError(''); try { await work(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } };
  const prepare = () => run(async () => {
    const result = await api.prepareTrademarkAction(company.id, trademark, connection.id, connector.action === 'contract' ? { subject, roles: roles.map(({ role, name, email }) => ({ role, name, email })) } : mail);
    setReview(result); setConfirmed(false); await onChanged();
  });
  const execute = (reconcile: boolean) => run(async () => {
    if (!review?.review || !confirmed) return;
    try { setReview(reconcile ? await api.reconcileTrademarkAction(company.id, trademark.id, review, externalId) : await api.sendTrademarkAction(company.id, trademark.id, review)); }
    catch (e) {
      // After a lost HTTP response, reload the persisted claim before displaying any further action.
      try { setReview(await api.reviewTrademarkAction(company.id, trademark.id, review.id)); } catch { setReview({ ...review, status: 'uncertain' }); }
      throw e;
    } finally { setConfirmed(false); await onChanged(); }
  });
  const download = (preview?: number) => run(async () => {
    if (!review) return;
    const blob = await api.downloadTrademarkAgreement(company.id, trademark.id, review.id, preview);
    const url = URL.createObjectURL(blob); const link = document.createElement('a'); link.href = url; link.download = preview === undefined ? 'signed-agreement.pdf' : `agreement-review-${preview + 1}.pdf`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  const discard = () => run(async () => { if (!review) return; await api.discardTrademarkAction(company.id, trademark.id, review); await onChanged(); onClose(); });
  const ready = connector.action === 'contract' ? !!subject.trim() && !!roles.length && roles.every(r => r.name.trim() && r.email) : !!mail.subject.trim() && !!mail.text.trim() && !!mail.to && !!mail.from && !!mail.reply_to;
  return <Modal isOpen title={`${connector.name} · ${review ? '검토·발송 기록' : connector.action === 'contract' ? '계약 서명 요청' : '변호사 메일'}`} maxWidth={820} onClose={() => { if (!busy) onClose(); }}
    footer={<><Button variant="secondary" disabled={busy} onClick={onClose}>닫기</Button>{!review && !action && <Button loading={busy} disabled={!ready} onClick={() => void prepare()}>원문 저장 · 발송 전 검토</Button>}{review?.status === 'draft' && <Button loading={busy} disabled={!confirmed || !review.review} onClick={() => void execute(false)}>검토한 요청 실제 발송</Button>}</>}>
    <div className="business-form">
      <p className="business-guide-note">{connector.action === 'contract' ? '합의한 계약 템플릿과 모든 수신자를 확인하세요. 서명 요청을 보내면 당사자는 DocuSign에서 직접 서명합니다. USPTO 출원 서명과는 별도입니다.' : '연결한 메일 계정에서 지정한 변호사에게 보냅니다. 공급자 접수는 수임·계약·출원 완료를 뜻하지 않습니다.'}</p>
      {!review && !action && (connector.action === 'contract' ? <>
        <Input label="서명 요청 메일 제목" aria-label="서명 요청 메일 제목" value={subject} maxLength={100} onChange={e => setSubject(e.target.value)} />
        {roles.map((role, index) => <fieldset className="business-integration-role" key={role.role}><legend>{role.role}</legend><div className="business-form-grid"><Input label="당사자 이름" aria-label={`${role.role} 이름`} value={role.name} onChange={e => setRoles(values => values.map((r, i) => i === index ? { ...r, name: e.target.value } : r))} /><Input label="서명·참조 이메일" aria-label={`${role.role} 이메일`} type="email" value={role.email} onChange={e => setRoles(values => values.map((r, i) => i === index ? { ...r, email: e.target.value } : r))} /></div></fieldset>)}
      </> : <>
        <div className="business-trademark-draft-picker"><Select label="문의 목적" aria-label="문의 목적" value={kind} options={TRADEMARK_MAIL_KINDS} onChange={e => setKind(e.target.value as TrademarkMailKind)} /><Button variant="secondary" disabled={busy} onClick={() => void run(async () => { const draft = await api.draftTrademarkMail(company.id, trademark.id, kind); setMail(previous => ({ ...previous, ...draft })); })}>영문 초안 만들기</Button></div>
        <div className="business-form-grid"><Input label="연결한 발신 계정" value={mail.from} readOnly /><Input label="회신 받을 주소" aria-label="연동 회신 주소" value={mail.reply_to} onChange={e => setMail({ ...mail, reply_to: e.target.value })} /></div>
        <Input label="받는 변호사" value={mail.to} readOnly /><Input label="메일 제목" aria-label="연동 메일 제목" value={mail.subject} maxLength={250} onChange={e => setMail({ ...mail, subject: e.target.value })} />
        <Textarea label="메일 본문" aria-label="연동 메일 본문" value={mail.text} rows={12} maxLength={20000} onChange={e => setMail({ ...mail, text: e.target.value })} />
      </>)}
      {review && <>
        <span className="business-pill">{TRADEMARK_MAIL_STATUS[review.status]}{review.external_status ? ` · ${review.external_status}` : ''}</span>
        <h3>{review.review?.subject}</h3>
        {review.kind === 'contract' ? <><p>{review.review?.template_name}</p><div className="business-integration-recipients">{review.review?.roles?.map(role => <div key={role.role}><strong>{role.role}</strong><span>{role.name}</span><span>{role.email}</span></div>)}</div>
          <div className="business-guide-actions">{review.review?.documents?.map((name, index) => <Button key={index} variant="secondary" disabled={busy} onClick={() => void download(index)}>검토 문서 {index + 1} · {name}</Button>)}</div></> : <>
          <dl className="business-trademark-envelope"><dt>발신</dt><dd>{review.review?.from}</dd><dt>수신</dt><dd>{review.review?.to}</dd><dt>회신</dt><dd>{review.review?.reply_to}</dd></dl><pre className="business-trademark-mail-body">{review.review?.text}</pre></>}
        {review.status !== 'sent' && <label className="business-trademark-consent"><input type="checkbox" checked={confirmed} disabled={busy} onChange={e => setConfirmed(e.target.checked)} /><span>원문·계약 문서와 모든 수신자를 검토했고 이 요청의 실제 발송 또는 기존 결과 대조를 승인합니다.</span></label>}
        {review.status === 'draft' && <Button variant="ghost" disabled={busy} onClick={() => void discard()}>미발송 요청 삭제 · 다시 작성</Button>}
        {['uncertain', 'sending'].includes(review.status) && <div className="business-trademark-email-setup"><p>새 요청을 보내지 않습니다. 기존 요청의 발송 원문을 대조합니다. Microsoft 메일이 아직 초안이면 메일함에서 처리하고 대조하세요.</p><Input label="공급자 메일·계약 ID · 선택" aria-label="연동 발송 ID" value={externalId} onChange={e => setExternalId(e.target.value)} /><Button disabled={busy || !confirmed || !review.review} onClick={() => void execute(true)}>기존 발송 원문 대조</Button></div>}
        {review.status === 'sent' && <p className="business-muted">접수 ID: {review.external_id}</p>}
        {review.status === 'sent' && review.kind === 'contract' && <Button variant="secondary" disabled={busy || review.external_status !== 'completed'} onClick={() => void download()}>완료된 서명본 다운로드</Button>}
        {review.last_error && <div className="business-stale">{review.last_error}</div>}
      </>}
      {error && <div role="alert" className="business-error">{error}</div>}
    </div>
  </Modal>;
}
