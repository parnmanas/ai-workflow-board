import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, rawResourceUrl, type ApiError } from '../../api';
import type { BusinessConnector, BusinessDetail, BusinessFormation, BusinessTaskEntry, BusinessTaskEntryInput, BusinessTaskJournal } from '../../business.types';
import type { Comment } from '../../types';
import { ticketStatusLabel } from '../../tickets/status';
import { t } from '../../i18n/core';
import { useLocale } from '../../i18n/react';
import { useAuth } from '../../contexts/AuthContext';
import { Button, ErrorState, Textarea } from '../common';
import Markdown from '../common/Markdown';
import { BusinessPageHeader } from './BusinessPageHeader';
import { BusinessFormationForm, FORMATION_STATUS } from './BusinessFormationForm';
import { TaskForm } from './BusinessForms';
import { dateTime, STAGES, TASK_STATUS } from './business.logic';

const entryLabels = { progress: '진행 기록', result: '결과', decision: '결정과 근거', request: '추가·수정 요청', resolution: '요청 처리 결과', change: '업무 변경' };
const fieldLabels: Record<string, string> = { title: '업무 이름', stage: '영역', description: '업무 설명', status: '진행 상태', owner: '담당자', due_on: '기한', notes: '진행 메모 · 확인 근거', depends_on: '선행 업무', ticket_id: '실행 티켓' };

function RecordBody({ content, expanded = false }: { content: string; expanded?: boolean }) {
  if (!expanded && content.length > 700) return <details className="business-record-body"><summary>{content.slice(0, 150)}… <span>{t('전체 내용 보기')}</span></summary><Markdown text={content} /></details>;
  return <div className="business-record-body"><Markdown text={content} /></div>;
}

export function BusinessTaskWorkspace({ detail, taskId, connectors, onBack, onChanged, onOpenTask }: {
  detail: BusinessDetail; taskId: string; connectors: BusinessConnector[]; onBack(): void; onChanged(): Promise<void>; onOpenTask(id: string): void;
}) {
  useLocale();
  const { hasPermission } = useAuth();
  const company = detail.company;
  const [journal, setJournal] = useState<BusinessTaskJournal | null>(null);
  const [entries, setEntries] = useState<BusinessTaskEntry[]>([]);
  const [before, setBefore] = useState<number | null>(null);
  const [comments, setComments] = useState<Comment[]>([]);
  const [moreComments, setMoreComments] = useState(false);
  const [commentBefore, setCommentBefore] = useState<string | undefined>();
  const [ticketError, setTicketError] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [formation, setFormation] = useState<BusinessFormation | null>(null);
  const [kind, setKind] = useState<BusinessTaskEntryInput['kind']>('request');
  const [content, setContent] = useState('');
  const [resolving, setResolving] = useState<BusinessTaskEntry | null>(null);
  const [destination, setDestination] = useState<'business' | 'ticket'>('business');
  const [filter, setFilter] = useState('all');
  const [notice, setNotice] = useState('');
  const composer = useRef<HTMLFormElement>(null);
  const pendingInput = useRef<BusinessTaskEntryInput | null>(null);
  const generation = useRef(0);
  const commentGeneration = useRef(0);
  const loaded = useRef(false);
  const newestEntry = useRef<string | undefined>();
  const newestComment = useRef<string | undefined>();
  const task = journal?.task || detail.tasks.find(item => item.id === taskId);
  const ticketId = task?.ticket?.id;

  const load = useCallback(async (preserveHistory = false) => {
    const version = ++generation.current;
    try {
      const next = await api.getBusinessTask(company.id, taskId);
      if (version !== generation.current) return;
      setJournal(next);
      setEntries(old => preserveHistory ? [...next.entries, ...old.filter(entry => !next.entries.some(row => row.id === entry.id))] : next.entries);
      // Restart paging from the new first page when new records arrive, so an
      // idle tab cannot skip a gap of more than one page. Already read rows stay visible.
      if (!preserveHistory || !loaded.current || newestEntry.current !== next.entries[0]?.id) setBefore(next.next_before);
      newestEntry.current = next.entries[0]?.id;
      loaded.current = true; setError('');
    } catch (e) {
      const status = (e as ApiError).status;
      if (version === generation.current) setError(typeof status === 'number' && status >= 500
        ? t('업무 기록을 불러오지 못했습니다. 서버 오류입니다. 잠시 후 다시 시도해 주세요.') : (e as Error).message);
    }
  }, [company.id, taskId]);
  useEffect(() => { void load(); return () => { generation.current++; }; }, [load, company.revision]);

  const loadComments = useCallback(async (preserveHistory = false) => {
    const version = ++commentGeneration.current;
    if (!ticketId) { setComments([]); setMoreComments(false); setTicketError(''); return; }
    try {
      const rows = await api.getTicketComments(ticketId, { limit: 50 });
      if (version !== commentGeneration.current) return;
      setComments(old => preserveHistory ? [...rows, ...old.filter(comment => !rows.some(row => row.id === comment.id))] : rows);
      if (!preserveHistory || newestComment.current !== rows[0]?.id) {
        setMoreComments(rows.length === 50); setCommentBefore(rows.at(-1)?.id);
      }
      newestComment.current = rows[0]?.id;
      setTicketError('');
    } catch (e) { if (version === commentGeneration.current) setTicketError((e as Error).message); }
  }, [ticketId]);
  useEffect(() => {
    setComments([]); setMoreComments(false); setTicketError('');
    void loadComments();
    return () => { commentGeneration.current++; };
  }, [loadComments]);
  useEffect(() => {
    if (editing || busy || error) return;
    const update = () => { if (!document.hidden) { void load(true); void loadComments(true); } };
    const timer = window.setInterval(update, 15000);
    window.addEventListener('focus', update);
    return () => { window.clearInterval(timer); window.removeEventListener('focus', update); };
  }, [load, loadComments, editing, busy, error]);
  const refresh = async () => { await Promise.all([load(), loadComments()]); };

  const write = async () => {
    if (!content.trim() || busy) return;
    setBusy(true); setError(''); setNotice('');
    try {
      if (destination === 'ticket' && ticketId) {
        await api.addComment(ticketId, content.trim(), [], { type: 'question', metadata: { business_task_id: taskId } });
        setNotice(t('연결 티켓에 댓글을 보냈습니다. 실행 상태는 연결 티켓에서 확인하세요.'));
        setContent(''); await loadComments();
      } else {
        const draft = { kind, content: content.trim(), resolves_entry_id: resolving?.id || null };
        const previous = pendingInput.current;
        const input = previous && previous.kind === draft.kind && previous.content === draft.content && previous.resolves_entry_id === draft.resolves_entry_id
          ? previous : { ...draft, request_id: crypto.randomUUID() };
        pendingInput.current = input;
        await api.addBusinessTaskEntry(company.id, taskId, input);
        pendingInput.current = null; setContent(''); setResolving(null); setKind('request');
        setNotice(t('업무에 기록을 남겼습니다.')); await load(); await onChanged();
      }
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };
  const compose = (type: BusinessTaskEntryInput['kind'], text = '', request: BusinessTaskEntry | null = null) => {
    setDestination('business'); setKind(type); setContent(text); setResolving(request); setNotice('');
    composer.current?.querySelector('textarea')?.focus(); composer.current?.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
  };
  const loadOlder = async () => {
    setBusy(true);
    try {
      if (before !== null) {
        const page = await api.getBusinessTask(company.id, taskId, before);
        setEntries(old => [...old, ...page.entries.filter(row => !old.some(entry => entry.id === row.id))]); setBefore(page.next_before);
      }
      if (moreComments && ticketId && commentBefore) {
        const rows = await api.getTicketComments(ticketId, { limit: 50, before: commentBefore });
        setComments(old => [...old, ...rows.filter(row => !old.some(comment => comment.id === row.id))]); setMoreComments(rows.length === 50);
        setCommentBefore(rows.at(-1)?.id);
      }
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };
  const history = [
    ...entries.map(entry => ({ id: entry.id, date: entry.created_at, entry, comment: null as Comment | null })),
    ...comments.map(comment => ({ id: comment.id, date: comment.created_at, entry: null as BusinessTaskEntry | null, comment })),
  ].sort((a, b) => Date.parse(b.date) - Date.parse(a.date) || (b.entry?.revision || 0) - (a.entry?.revision || 0) || b.id.localeCompare(a.id))
    .filter(row => filter === 'all' || (filter === 'ticket' ? !!row.comment : row.entry?.kind === filter));
  const displayValue = (key: string, value: unknown): string => {
    if (value === null || value === '') return '—';
    if (key === 'status') return TASK_STATUS[value as keyof typeof TASK_STATUS] || String(value);
    if (key === 'stage') return STAGES.find(stage => stage.id === value)?.label || String(value);
    if (key === 'depends_on' && Array.isArray(value)) return value.map(id => detail.tasks.find(t => t.id === id)?.title || id).join(', ') || '—';
    return String(value);
  };
  const openRequests = journal?.open_requests || [];
  const latestReply = comments.find(comment => comment.author_type === 'agent' && comment.type !== 'system');

  return <div className="business-page business-task-workspace">
    <BusinessPageHeader title={task?.title || t('업무 상세')} context={<span className="business-task-company" title={company.name}>{company.name}</span>}
      actions={<Button onClick={() => compose('request')} disabled={busy}>{t('추가·수정 요청')}</Button>}
      moreActions={close => <>
        <Button variant="ghost" onClick={() => { close(); onBack(); }}>{t('업무 목록으로')}</Button>
        <Button variant="ghost" disabled={!journal || busy} onClick={() => { close(); generation.current++; setEditing(true); }}>{t('업무 정보 수정')}</Button>
        <Button variant="ghost" disabled={busy} onClick={() => { close(); void refresh(); }}>{t('새로고침')}</Button>
        {ticketId && <Link to={`/tickets?ticket=${encodeURIComponent(ticketId)}`}>{t('실행 티켓 열기')}</Link>}
      </>} />
    <button className="business-task-back" onClick={onBack}>← {t('업무 목록으로')}</button>
    {error && <ErrorState message={error} onRetry={() => void refresh()} />}
    {!journal && !error && <p role="status">{t('업무 기록을 불러오는 중…')}</p>}
    {task && <>
      <section className="business-panel business-task-context" aria-label={t('업무 개요')}>
        <h2 className="business-work-title">{task.title}</h2>
        <div className="business-task-context-meta"><span className={`business-pill ${task.status}`}>{TASK_STATUS[task.status]}</span><span>{STAGES.find(s => s.id === task.stage)?.label}</span>{task.owner && <span>{task.owner}</span>}{task.due_on && <span>{t('기한')} · {task.due_on}</span>}
          {task.ticket && <span>{t('실행 티켓')} · {ticketStatusLabel(task.ticket.status)}</span>}</div>
        {task.description && <RecordBody content={task.description} expanded />}
        {!!task.blocked_by.length && <p className="business-guide-note">{t('먼저 마칠 업무')}: {task.blocked_by.map(id => <button key={id} className="business-inline-link" onClick={() => onOpenTask(id)}>{detail.tasks.find(t => t.id === id)?.title || id}</button>)}</p>}
      </section>
      <div className="business-task-summary">
        <section className="business-panel" aria-label={t('최신 결과')}><h2>{t('최신 결과')}</h2>{journal?.result ? <><RecordBody content={journal.result.content} expanded /><small>{journal.result.author} · {dateTime(journal.result.created_at)}</small></> : <><p className="business-muted">{t('아직 정리된 결과가 없습니다. 진행 기록을 확인하고 결과를 남겨 주세요.')}</p>{latestReply && <div className="business-latest-reply"><strong>{t('연결 티켓의 최근 답변')}</strong><RecordBody content={latestReply.content} /><small>{latestReply.author} · {dateTime(latestReply.created_at)}</small></div>}</>}<Button variant="ghost" disabled={busy} onClick={() => compose('result', journal?.result?.content || latestReply?.content || '')}>{journal?.result ? t('수정 결과 남기기') : t('결과 남기기')}</Button></section>
        <section className="business-panel" aria-label={t('최근 결정')}><h2>{t('최근 결정')}</h2>{journal?.decision ? <><RecordBody content={journal.decision.content} expanded /><small>{journal.decision.author} · {dateTime(journal.decision.created_at)}</small></> : <p className="business-muted">{t('선택한 방향과 이유를 남기면 다음 작업에서 이어 볼 수 있습니다.')}</p>}<Button variant="ghost" disabled={busy} onClick={() => compose('decision')}>{t('결정과 근거 남기기')}</Button></section>
      </div>
      {task.notes && <details className="business-panel business-task-notes"><summary>{t('진행 메모 · 확인 근거')}</summary><RecordBody content={task.notes} expanded /></details>}
      {task.stage === 'formation' && !!detail.formations?.length && <section className="business-panel"><h2>{t('이 회사의 설립 신청')}</h2><div className="business-formation-history">{detail.formations.map(item => <button key={item.id} onClick={() => setFormation(item)} disabled={!connectors.some(connector => connector.id === item.provider)}><span><strong>{item.summary.name}</strong><small>{item.environment === 'sandbox' ? t('테스트') : t('실제 신청')} · {FORMATION_STATUS[item.status]} · {item.provider_status || item.summary.state}</small></span><span>→</span></button>)}</div></section>}
      <section className="business-panel" aria-label={t('남은 추가·수정 요청')}>
        <div className="business-section-heading"><h2>{t('남은 추가·수정 요청')} <span className="business-count">{openRequests.length}</span></h2></div>
        {openRequests.length ? openRequests.map(request => <div key={request.id} className="business-open-request"><div><RecordBody content={request.content} /><small>{request.author} · {dateTime(request.created_at)}</small></div><Button variant="secondary" disabled={busy} onClick={() => compose('resolution', '', request)}>{t('처리 결과 남기기')}</Button></div>) : <p className="business-muted">{t('처리를 기다리는 업무 요청이 없습니다.')}</p>}
      </section>
      <section className="business-panel business-task-compose" aria-label={t('업무에 이어서 기록')}>
        <h2>{t('업무에 이어서 기록')}</h2>
        <form ref={composer} onSubmit={event => { event.preventDefault(); void write(); }}>
          <div className="business-task-compose-options">
            <label>{t('기록 종류')}<select aria-label={t('기록 종류')} disabled={busy || !!resolving || destination === 'ticket'} value={kind} onChange={event => setKind(event.target.value as typeof kind)}>{(resolving ? ['resolution'] as const : ['request', 'progress', 'result', 'decision'] as const).map(type => <option key={type} value={type}>{t(entryLabels[type])}</option>)}</select></label>
            {ticketId && !resolving && <label>{t('기록 위치')}<select aria-label={t('기록 위치')} value={destination} disabled={busy} onChange={event => { setDestination(event.target.value as typeof destination); setKind('request'); }}><option value="business">{t('이 업무에 기록')}</option><option value="ticket">{t('연결 티켓에 댓글 보내기')}</option></select></label>}
          </div>
          {resolving && <div className="business-guide-note"><strong>{t('처리할 요청')}</strong><RecordBody content={resolving.content} /><Button variant="ghost" disabled={busy} onClick={() => { setResolving(null); setKind('request'); }}>{t('취소')}</Button></div>}
          <Textarea aria-label={t('업무 기록 내용')} value={content} onChange={event => setContent(event.target.value)} rows={5} maxLength={20000} disabled={busy} placeholder={t('무엇을 진행했는지, 결과와 근거, 추가로 바꿀 내용을 적어 주세요. 문서 링크도 함께 남길 수 있습니다.')} />
          <p className="business-muted">{destination === 'ticket' ? t('댓글은 기존 실행 티켓에 전달됩니다. 실행 중인 에이전트는 기존 티켓 규칙에 따라 이어서 처리합니다.') : t('기록은 이 업무에 보관됩니다. 에이전트 실행이나 외부 신청은 시작하지 않습니다.')}</p>
          <Button type="submit" loading={busy} disabled={!content.trim() || !journal}>{destination === 'ticket' ? t('티켓에 댓글 보내기') : t('기록 남기기')}</Button>
          {notice && <p role="status" className="business-guide-note">{notice}</p>}
        </form>
      </section>
      <section className="business-panel" aria-label={t('진행 과정과 변경 내역')}>
        <div className="business-section-heading"><h2>{t('진행 과정과 변경 내역')}</h2><select className="business-filter" aria-label={t('기록 필터')} value={filter} onChange={event => setFilter(event.target.value)}><option value="all">{t('전체 기록')}</option>{Object.entries(entryLabels).map(([value, label]) => <option key={value} value={value}>{t(label)}</option>)}{ticketId && <option value="ticket">{t('연결 티켓 댓글')}</option>}</select></div>
        <p className="business-muted">{t('최신 기록부터 표시합니다. 이전 결과와 결정은 수정 후에도 남습니다.')}</p>
        {ticketError && <ErrorState message={`${t('연결 티켓 댓글')}: ${ticketError}`} onRetry={() => void loadComments()} />}
        <ol className="business-work-history">{history.map(({ id, entry, comment }) => <li key={id} id={`business-entry-${id}`} className={`business-work-entry ${entry?.kind || 'ticket'}`}>
          <div className="business-work-entry-meta"><strong>{entry ? t(entryLabels[entry.kind]) : t('연결 티켓 댓글')}</strong><span>{entry?.author || comment?.author}</span><time>{dateTime(entry?.created_at || comment?.created_at || null)}</time></div>
          {entry?.resolves_entry_id && <details className="business-resolved-request"><summary>{t('추가·수정 요청에 대한 처리 기록')}</summary>{entry.request && <><RecordBody content={entry.request.content} /><small>{entry.request.author} · {dateTime(entry.request.created_at)}</small></>}</details>}
          <RecordBody content={entry?.content || comment?.content || ''} />
          {entry?.changes && <details><summary>{t('변경 전후 보기')}</summary><dl className="business-work-changes">{Object.entries(entry.changes).map(([key, change]) => <div key={key}><dt>{t(fieldLabels[key] || key)}</dt><dd><span>{t('변경 전')}</span><pre>{displayValue(key, change.before)}</pre><span>{t('변경 후')}</span><pre>{displayValue(key, change.after)}</pre></dd></div>)}</dl></details>}
          {entry?.kind === 'request' && <span className="business-pill">{openRequests.some(request => request.id === id) ? t('처리 대기') : t('처리 기록 있음')}</span>}
          {comment?.attachments?.map(file => <a className="business-record-attachment" key={file.id} href={rawResourceUrl(file.id)} target="_blank" rel="noopener noreferrer">{file.file_name}</a>)}
          {comment && comment.author_type === 'agent' && <Button variant="ghost" disabled={busy} onClick={() => compose('result', comment.content)}>{t('이 답변으로 결과 정리')}</Button>}
        </li>)}</ol>
        {!history.length && <p className="business-muted">{t('아직 표시할 진행 기록이 없습니다.')}</p>}
        {(before !== null || moreComments) && <Button variant="secondary" loading={busy} onClick={() => void loadOlder()}>{t('이전 기록 더 보기')}</Button>}
      </section>
      {!task.ticket_id && task.status !== 'done' && hasPermission('tickets.create') && <details className="business-panel"><summary>{t('에이전트 실행 연결')}</summary><p className="business-muted">{t('필요할 때 이 업무의 실행 티켓을 만들 수 있습니다.')}</p><Button disabled={busy || !!task.blocked_by.length || !journal} onClick={async () => {
        setBusy(true); try { await api.createBusinessTaskTicket(company.id, taskId, journal!.company_revision); await load(); await onChanged(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
      }}>{t('티켓 만들기')}</Button></details>}
    </>}
    {editing && journal && <TaskForm company={{ ...company, revision: journal.company_revision }} task={journal.task} tasks={detail.tasks} stage={journal.task.stage} onClose={() => setEditing(false)} onSaved={async deleted => { setEditing(false); if (deleted) { await onChanged(); onBack(); } else { await load(); await onChanged(); } }} />}
    {formation && <BusinessFormationForm key={formation.id} company={{ ...company, revision: journal?.company_revision ?? company.revision }} connector={connectors.find(connector => connector.id === formation.provider)!} formations={[formation]} onClose={() => setFormation(null)} onChanged={async () => { await onChanged(); await load(); }} />}
  </div>;
}
