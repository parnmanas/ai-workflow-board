import React, { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api';
import type { BusinessMailMessage, MailConnection, MailReply } from '../../business-mail.types';
import { Button, Input, Textarea } from '../common';

export const MAIL_REPLY_STATUS: Record<MailReply['status'], string> = {
  queued: '작성 대기', drafting: '에이전트 작성 중', review: '승인 대기', sending: '발송 중', sent: '발송 접수',
  uncertain: '발신 확인 필요', skipped: '답장 생략', failed: '작업 확인 필요', cancelled: '취소됨',
};
export default function BusinessMailReplyPanel({ message, connection, refresh, onChanged }: {
  message: BusinessMailMessage; connection?: MailConnection; refresh: number; onChanged(): void;
}) {
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
  return <section className="business-mail-reply" aria-label="답장 자동화">
    <div className="business-section-heading"><h3>답장 자동화</h3>{reply && <span className="business-pill">{MAIL_REPLY_STATUS[reply.status]}</span>}</div>
    {error && <p role="alert" className="business-error">{error}</p>}
    {loading ? <p>답장 상태를 불러오는 중…</p> : <>
      {!configured && <p className="business-muted">연결 관리 → 설정에서 담당 에이전트, 업무 목적과 답장 모드를 선택하세요.</p>}
      {reply?.last_error && <p role="status" className="business-error">{reply.last_error}</p>}
      {reply && <p className="business-muted">{reply.mode === 'automatic' ? '자동 발송' : reply.mode === 'review' ? '사람 승인 후 발송' : '자동화 꺼짐'}{reply.objective ? ` · ${reply.objective}` : ''}</p>}
      {reply?.status === 'review' ? <>
        <p>보내는 주소: {reply.from}<br />받는 주소: {reply.to}</p>
        <Input label="답장 제목" value={draft.subject} disabled={busy} maxLength={500} onChange={e => { setDraft({ ...draft, subject: e.target.value }); setDirty(true); dirtyRef.current = true; }} />
        <Textarea label="답장 초안" rows={8} value={draft.text} disabled={busy} maxLength={100000} onChange={e => { setDraft({ ...draft, text: e.target.value }); setDirty(true); dirtyRef.current = true; }} />
        <div className="business-card-actions">
          <Button variant="secondary" disabled={busy || !dirty || !draft.text.trim() || !draft.subject.trim()} onClick={() => void action(() => api.editBusinessMailReply(reply.id, { ...draft, decision: 'review', note: reply.note }))}>초안 저장</Button>
          <Button disabled={busy || dirty || !reply.text.trim()} onClick={() => void action(() => api.decideBusinessMailReply(reply.id, { revision: reply.revision, action: 'approve' }))}>승인하고 발송</Button>
          <Button variant="ghost" disabled={busy || dirty} onClick={() => void action(() => api.decideBusinessMailReply(reply.id, { revision: reply.revision, action: 'reject' }))}>답장 취소</Button>
        </div>
        {dirty && <p className="business-muted">수정한 초안을 저장한 뒤 승인하세요.</p>}
      </> : reply?.text ? <pre className="business-mail-body">{reply.text}</pre> : null}
      {reply?.note && <p className="business-muted">처리 사유: {reply.note}</p>}
      <div className="business-card-actions">
        {configured && connection?.enabled && (!reply || ['failed', 'skipped', 'cancelled'].includes(reply.status)) && !reply?.outbound_message_id &&
          <Button variant="secondary" disabled={busy} onClick={() => void action(() => api.startBusinessMailReply(message.id))}>에이전트에게 답장 작성 요청</Button>}
        {reply?.room_id && <Link to={`/chat/${encodeURIComponent(reply.room_id)}`}>에이전트 처리 기록 ↗</Link>}
      </div>
      {['failed', 'sending'].includes(reply?.notification_state || '') && <p className="business-muted">외부 알림 채널 전달 상태를 확인하세요.</p>}
    </>}
  </section>;
}
