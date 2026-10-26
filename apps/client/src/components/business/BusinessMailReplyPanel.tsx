import { t as translate } from '../../i18n/core';
import { useLocale } from '../../i18n/react';
import React, { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api';
import type { BusinessMailMessage, MailConnection, MailReply } from '../../business-mail.types';
import { Button, Input, Textarea } from '../common';

export const MAIL_REPLY_STATUS: Record<MailReply['status'], string> = {
  get queued() { return translate('작성 대기'); }, get drafting() { return translate('에이전트 작성 중'); }, get review() { return translate('승인 대기'); }, get sending() { return translate('발송 중'); }, get sent() { return translate('발송 접수'); },
  get uncertain() { return translate('발신 확인 필요'); }, get skipped() { return translate('답장 생략'); }, get failed() { return translate('작업 확인 필요'); }, get cancelled() { return translate('취소됨'); },
};
export default function BusinessMailReplyPanel({ message, connection, refresh, onChanged }: {
  message: BusinessMailMessage; connection?: MailConnection; refresh: number; onChanged(): void;
}) {
  useLocale();
  const [reply, setReply] = useState<MailReply | null>(null);
  const [draft, setDraft] = useState({ revision: 0, subject: '', text: '' });
  const [loading, setLoading] = useState(true); const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const [dirty, setDirty] = useState(false); const dirtyRef = useRef(false);
  useEffect(() => {
    let active = true;
    void api.getBusinessMailReply(message.id).then(value => {
      if (!active) return;
      setReply(value); setError('');
      if (value && !dirtyRef.current) setDraft({ revision: value.revision, subject: value.subject, text: value.text });
    }).catch(e => { if (active) setError(e.message); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [message.id, refresh]);
  const action = async (work: () => Promise<MailReply>) => {
    setBusy(true); setError('');
    try {
      const value = await work(); setReply(value); setDraft({ revision: value.revision, subject: value.subject, text: value.text });
      setDirty(false); dirtyRef.current = false; onChanged();
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  if (message.direction !== 'inbound') return null;
  const configured = connection?.automation && connection.automation.mode !== 'off';
  return <section className="business-mail-reply" aria-label={translate('답장 자동화')}>
    <div className="business-section-heading"><h3>{translate('답장 자동화')}</h3>{reply && <span className="business-pill">{MAIL_REPLY_STATUS[reply.status]}</span>}</div>
    {error && <p role="alert" className="business-error">{error}</p>}
    {loading ? <p>{translate('답장 상태를 불러오는 중…')}</p> : <>
      {!configured && <p className="business-muted">{translate('연결 관리 → 설정에서 담당 에이전트, 업무 목적과 답장 모드를 선택하세요.')}</p>}
      {reply?.last_error && <p role="status" className="business-error">{reply.last_error}</p>}
      {reply && <p className="business-muted">{reply.mode === 'automatic' ? translate('자동 발송') : reply.mode === 'review' ? translate('사람 승인 후 발송') : translate('자동화 꺼짐')}{reply.objective ? ` · ${reply.objective}` : ''}</p>}
      {reply?.status === 'review' ? <>
        <p>{translate('보내는 주소:')} {reply.from}<br />{translate('받는 주소:')} {reply.to}</p>
        <Input label={translate('답장 제목')} value={draft.subject} disabled={busy} maxLength={500} onChange={e => { setDraft({ ...draft, subject: e.target.value }); setDirty(true); dirtyRef.current = true; }} />
        <Textarea label={translate('답장 초안')} rows={8} value={draft.text} disabled={busy} maxLength={100000} onChange={e => { setDraft({ ...draft, text: e.target.value }); setDirty(true); dirtyRef.current = true; }} />
        <div className="business-card-actions">
          <Button variant="secondary" disabled={busy || !dirty || !draft.text.trim() || !draft.subject.trim()} onClick={() => void action(() => api.editBusinessMailReply(reply.id, { ...draft, decision: 'review', note: reply.note }))}>{translate('초안 저장')}</Button>
          <Button disabled={busy || dirty || !reply.text.trim()} onClick={() => void action(() => api.decideBusinessMailReply(reply.id, { revision: reply.revision, action: 'approve' }))}>{translate('승인하고 발송')}</Button>
          <Button variant="ghost" disabled={busy || dirty} onClick={() => void action(() => api.decideBusinessMailReply(reply.id, { revision: reply.revision, action: 'reject' }))}>{translate('답장 취소')}</Button>
        </div>
        {dirty && <p className="business-muted">{translate('수정한 초안을 저장한 뒤 승인하세요.')}</p>}
      </> : reply?.text ? <pre className="business-mail-body">{reply.text}</pre> : null}
      {reply?.note && <p className="business-muted">{translate('처리 사유:')} {reply.note}</p>}
      <div className="business-card-actions">
        {configured && connection?.enabled && (!reply || ['failed', 'skipped', 'cancelled'].includes(reply.status)) && !reply?.outbound_message_id &&
          <Button variant="secondary" disabled={busy} onClick={() => void action(() => api.startBusinessMailReply(message.id))}>{translate('에이전트에게 답장 작성 요청')}</Button>}
        {reply?.room_id && <Link to={`/chat/${encodeURIComponent(reply.room_id)}`}>{translate('에이전트 처리 기록 ↗')}</Link>}
      </div>
      {['failed', 'sending'].includes(reply?.notification_state || '') && <p className="business-muted">{translate('외부 알림 채널 전달 상태를 확인하세요.')}</p>}
    </>}
  </section>;
}
