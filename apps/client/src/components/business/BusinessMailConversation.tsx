import { getLocaleTag } from '../../i18n/core';
import { t as translate } from '../../i18n/core';
import { useLocale } from '../../i18n/react';
import React, { useEffect, useRef, useState } from 'react';
import { api } from '../../api';
import { useToast } from '../../contexts/ToastContext';
import type { BusinessMailMessage, BusinessMailWithThread, MailConnection } from '../../business-mail.types';
import { Button, Input, Textarea } from '../common';
import { BusinessIcon } from './BusinessIcon';
import BusinessMailReplyPanel, { MAIL_REPLY_STATUS } from './BusinessMailReplyPanel';
import {
  composeForwardText, composeFrom, composeRecipients, composeReplyText, composeSubject, defaultExpanded,
  MAX_MAIL_RECIPIENTS, ownMailAddresses, parseRecipients, splitQuoted, type MailComposeMode,
} from './business-mail.logic';

export const MAIL_STATUS: Record<BusinessMailMessage['status'], string> = { get received() { return translate('수신'); }, get sending() { return translate('발신 중'); }, get accepted() { return translate('서버 접수'); }, get uncertain() { return translate('발신 확인 필요'); } };
export const mailWhen = (value: string) => value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString(getLocaleTag()) : '—';

interface Draft { mode: MailComposeMode; source: BusinessMailMessage; requestId: string; from: string; to: string; subject: string; text: string }

/**
 * One conversation, oldest first (docs/business.md → 대화 보기). Mount it with `key={thread.id}` so expanded
 * messages, quotes and an unsent draft never carry over to another conversation.
 */
export default function BusinessMailConversation({ data, connections, focusId, refresh, onChanged }: {
  data: BusinessMailWithThread; connections: MailConnection[]; focusId: string; refresh: number; onChanged(): void;
}) {
  useLocale();
  const { showToast } = useToast();
  const messages = data.thread.messages;
  const own = ownMailAddresses(connections);
  const [opened, setOpened] = useState<Record<string, boolean>>({});
  const [quotes, setQuotes] = useState<Record<string, boolean>>({});
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState('');
  const [draft, setDraft] = useState<Draft | null>(null);
  const [sendError, setSendError] = useState('');
  const initial = defaultExpanded(messages, focusId);
  const root = useRef<HTMLDivElement>(null);
  // Opened from a list row or a notification link: bring that mail into view once.
  useEffect(() => {
    const target = [...(root.current?.querySelectorAll<HTMLElement>('[data-mail-id]') || [])].find(node => node.dataset.mailId === focusId);
    target?.scrollIntoView?.({ block: 'nearest' });
  }, []);
  const expanded = (m: BusinessMailMessage) => opened[m.id] ?? initial.has(m.id);
  const connectionOf = (m: BusinessMailMessage) => connections.find(c => c.id === m.connection_id);
  const who = (address: string) => own.has(address.toLowerCase()) ? translate('나') : address;
  const unconfirmed = messages.filter(m => m.direction === 'inbound' && !m.confirmed);

  const confirm = async (message: BusinessMailMessage, confirmed = !message.confirmed) => {
    await api.confirmBusinessMail(message.id, { revision: message.revision, confirmed, note: notes[message.id] ?? message.note ?? '' });
  };
  const confirmOne = async (message: BusinessMailMessage) => {
    setBusy(message.id);
    try { await confirm(message); onChanged(); } catch (e) { showToast((e as Error).message, 'error'); onChanged(); } finally { setBusy(''); }
  };
  const confirmAll = async () => {
    setBusy('all');
    try { for (const message of unconfirmed) await confirm(message, true); } catch (e) { showToast((e as Error).message, 'error'); } finally { setBusy(''); onChanged(); }
  };
  const compose = (mode: MailComposeMode, source: BusinessMailMessage) => {
    const date = mailWhen(source.date || source.created_at);
    const text = mode === 'forward'
      ? composeForwardText(source, [translate('---------- 전달된 메일 ----------'), translate('보낸 사람: {0}', { 0: source.from }), translate('날짜: {0}', { 0: date }),
        translate('제목: {0}', { 0: source.subject }), translate('받는 사람: {0}', { 0: source.to.join(', ') })])
      : composeReplyText(source, translate('{0}, {1} 님이 작성:', { 0: date, 1: source.from }));
    setSendError('');
    setDraft({ mode, source, requestId: crypto.randomUUID(), from: composeFrom(source, connectionOf(source)),
      to: composeRecipients(source, mode, own).join(', '), subject: composeSubject(source.subject, mode), text });
  };
  const send = async () => {
    if (!draft) return;
    const to = parseRecipients(draft.to);
    if (!to.length) { setSendError(translate('받는 사람을 입력하세요.')); return; }
    if (to.length > MAX_MAIL_RECIPIENTS) { setSendError(translate('받는 사람은 {0}명까지 입력할 수 있습니다.', { 0: MAX_MAIL_RECIPIENTS })); return; }
    setBusy('send'); setSendError('');
    try {
      // The request ID stays with this draft: retrying after a lost response never sends twice.
      const sent = await api.sendBusinessMail(draft.source.connection_id, { request_id: draft.requestId, from: draft.from, to, subject: draft.subject.trim(), text: draft.text,
        ...(draft.mode === 'forward' ? { forward_message_id: draft.source.id } : { reply_to_message_id: draft.source.id }), confirm: true });
      if (sent.status === 'uncertain') showToast(translate('발신 결과를 확정하지 못했습니다. 같은 메일을 다시 보내기 전에 받는 사람의 메일함이나 발신 기록을 확인하세요.'), 'error');
      else showToast(draft.mode === 'forward' ? translate('메일을 전달했습니다.') : translate('답장을 보냈습니다.'), 'success');
      setDraft(null); onChanged();
    } catch (e) { setSendError((e as Error).message); } finally { setBusy(''); }
  };

  const composer = draft && (() => {
    const connection = connectionOf(draft.source);
    const pending = draft.mode !== 'forward' && draft.source.reply && ['queued', 'drafting', 'review'].includes(draft.source.reply.status);
    const title = draft.mode === 'forward' ? translate('전달') : draft.mode === 'reply_all' ? translate('전체 답장') : translate('답장');
    return <section className="business-mail-composer" aria-label={title}>
      <div className="business-section-heading"><h3>{title}</h3><span className="business-muted">{connection?.name}</span></div>
      {(connection?.config.addresses.length || 0) > 1
        ? <label className="business-mail-composer-field"><span>{translate('보내는 주소')}</span><select className="business-filter" aria-label={translate('보내는 주소')} value={draft.from} disabled={busy === 'send'} onChange={e => setDraft({ ...draft, from: e.target.value })}>{connection!.config.addresses.map(a => <option key={a} value={a}>{a}</option>)}</select></label>
        : <p className="business-muted">{translate('보내는 주소:')} {draft.from}</p>}
      <Input aria-label={translate('받는 사람')} label={translate('받는 사람')} value={draft.to} disabled={busy === 'send'} placeholder="name@example.com, …" onChange={e => setDraft({ ...draft, to: e.target.value })} />
      <Input aria-label={translate('메일 제목')} label={translate('메일 제목')} value={draft.subject} maxLength={500} disabled={busy === 'send'} onChange={e => setDraft({ ...draft, subject: e.target.value })} />
      <Textarea aria-label={translate('메일 본문')} label={translate('메일 본문')} rows={10} value={draft.text} maxLength={100000} disabled={busy === 'send'} onChange={e => setDraft({ ...draft, text: e.target.value })} />
      {draft.mode === 'forward' && !!draft.source.attachments.length && <p className="business-muted">{translate('첨부파일은 전달되지 않습니다. 필요하면 원본 메일에서 전달하세요.')}</p>}
      {draft.mode === 'reply_all' && <p className="business-muted">{translate('참조 없이 모든 받는 사람에게 보냅니다.')}</p>}
      {pending && <p className="business-muted">{translate('보내면 이 메일의 자동 답장 작업({0})을 취소합니다.', { 0: MAIL_REPLY_STATUS[draft.source.reply!.status] })}</p>}
      {sendError && <p role="alert" className="business-error">{sendError}</p>}
      <div className="business-card-actions">
        <Button disabled={!!busy || !draft.subject.trim() || !draft.text.trim() || !draft.from} onClick={() => void send()}><BusinessIcon name="arrow" size={16} />{translate('보내기')}</Button>
        <Button variant="ghost" disabled={busy === 'send'} onClick={() => { setDraft(null); setSendError(''); }}>{translate('취소')}</Button>
      </div>
    </section>;
  })();

  return <div className="business-mail-conversation" ref={root}>
    <div className="business-section-heading business-mail-conversation-heading">
      <h2>{messages[0]?.subject || data.subject || translate('(제목 없음)')}</h2>
      <span className="business-pill">{translate('{0}통', { 0: data.thread.total })}</span>
      {unconfirmed.length > 1 && <Button variant="secondary" disabled={!!busy} onClick={() => void confirmAll()}>{translate('대화 모두 확인 완료 ({0})', { 0: unconfirmed.length })}</Button>}
    </div>
    {data.thread.total > messages.length && <p className="business-muted">{translate('최근 {0}통만 표시합니다. 이전 메일은 메일별 보기에서 확인하세요.', { 0: messages.length })}</p>}
    {messages.map(message => {
      const open = expanded(message);
      const { body, quoted } = splitQuoted(message.text || '', message.subject);
      const connection = connectionOf(message);
      const sendable = !!connection?.enabled && (connection.provider === 'jmap' || !!connection.config.smtp);
      const configured = connection?.automation && connection.automation.mode !== 'off';
      const status = message.reply ? MAIL_REPLY_STATUS[message.reply.status] : message.direction === 'outbound' || message.status !== 'received' ? MAIL_STATUS[message.status] : '';
      return <article key={message.id} data-mail-id={message.id} className={`business-mail-message ${open ? 'open' : ''} ${message.direction}`} aria-label={translate('{0}의 메일', { 0: who(message.from) })}>
        <button className="business-mail-message-head" aria-expanded={open} onClick={() => setOpened({ ...opened, [message.id]: !open })}>
          <span className="business-mail-message-from"><strong>{who(message.from)}</strong>{message.direction === 'outbound' && <span className="business-pill">{translate('발신')}</span>}{message.direction === 'inbound' && !message.confirmed && <span className="business-pill waiting">{translate('미확인')}</span>}</span>
          <small>{mailWhen(message.date || message.created_at)}</small>
          {!open && <span className="business-mail-message-snippet">{(body || '').replace(/\s+/g, ' ').slice(0, 160) || translate('(텍스트 본문 없음)')}</span>}
        </button>
        {open && <div className="business-mail-message-body">
          <p className="business-muted">{translate('보낸 사람:')} {message.from}<br />{translate('받는 사람:')} {message.to.join(', ')}{status && <> · {status}</>}</p>
          {message.last_error && <p role="status" className="business-error">{message.last_error}</p>}
          {message.status === 'accepted' && <p className="business-muted">{translate('메일 서버가 발신을 접수했습니다. 수신자에게 최종 전달됐다는 뜻은 아닙니다.')}</p>}
          {message.truncated && <p role="status" className="business-error">{translate('본문이 길거나 크기 제한을 넘었습니다. 전체 내용은 원본 메일에서 확인하세요.')}</p>}
          <pre className="business-mail-body">{body || translate('(텍스트 본문 없음)')}</pre>
          {quoted && <>
            <button className="business-mail-quote-toggle" aria-expanded={!!quotes[message.id]} title={translate('이전 내용 보기')} aria-label={translate('이전 내용 보기')} onClick={() => setQuotes({ ...quotes, [message.id]: !quotes[message.id] })}>···</button>
            {quotes[message.id] && <pre className="business-mail-body business-mail-quoted">{quoted}</pre>}
          </>}
          {!!message.attachments.length && <div className="business-muted">{translate('첨부파일:')} {message.attachments.map(a => a.name).join(', ')}<br />{translate('첨부 내용은 원본 메일에서 확인하세요.')}</div>}
          <div className="business-card-actions business-mail-message-actions">
            <Button variant="secondary" disabled={!sendable || !!busy} onClick={() => compose('reply', message)}>{translate('답장')}</Button>
            <Button variant="ghost" disabled={!sendable || !!busy} onClick={() => compose('reply_all', message)}>{translate('전체 답장')}</Button>
            <Button variant="ghost" disabled={!sendable || !!busy} onClick={() => compose('forward', message)}>{translate('전달')}</Button>
            {!sendable && <span className="business-muted">{translate('발신 서버가 없거나 중지된 연결입니다.')}</span>}
          </div>
          <div className="business-mail-processing">
            <Textarea aria-label={translate('처리 메모')} label={translate('처리 메모')} value={notes[message.id] ?? message.note ?? ''} maxLength={2000} rows={2} onChange={e => setNotes({ ...notes, [message.id]: e.target.value })} />
            <div className="business-card-actions"><Button variant={message.confirmed ? 'ghost' : 'primary'} disabled={!!busy} onClick={() => void confirmOne(message)}>{message.confirmed ? translate('미확인으로 되돌리기') : translate('확인 완료')}</Button>{message.confirmed && <span className="business-muted">{mailWhen(message.confirmed_at)} {translate('확인')}</span>}</div>
          </div>
          {message.direction === 'inbound' && (message.reply || configured) && <BusinessMailReplyPanel message={message} connection={connection} refresh={refresh} onChanged={onChanged} />}
        </div>}
      </article>;
    })}
    {composer}
  </div>;
}
