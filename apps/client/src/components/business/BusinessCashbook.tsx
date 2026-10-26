import { t as translate } from '../../i18n/core';
import { useLocale } from '../../i18n/react';
import React, { useEffect, useState } from 'react';
import { api } from '../../api';
import type { BusinessCompany, Cashbook, CashEntry, CashKind } from '../../business.types';
import { Button, Modal } from '../common';
import { BusinessIcon } from './BusinessIcon';
import { CASH_LABELS, cashIncoming, cashMoney, cashbookCsv, parseCashAmount } from './cashbook.logic';

type Action = { kind: 'add' | 'close' | 'reopen' } | { kind: 'reconcile' | 'void'; entry: CashEntry };
export function BusinessCashbook({ company, onChanged, onSetup }: { company: BusinessCompany; onChanged(): Promise<void>; onSetup(): void }) {
  useLocale();
  const [month, setMonth] = useState(new Date().toISOString().slice(0, 7));
  const [book, setBook] = useState<Cashbook | null>(null); const [error, setError] = useState('');
  const [loading, setLoading] = useState(true); const [refresh, setRefresh] = useState(0); const [action, setAction] = useState<Action | null>(null);
  useEffect(() => {
    let active = true; setLoading(true); setBook(null); setError('');
    api.getBusinessCashbook(company.id, month).then(result => { if (active) setBook(result); }).catch(e => { if (active) setError(e.message); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [company.id, company.revision, month, refresh]);
  const selected = company.service_choices?.accounting?.provider === 'self_bookkeeping';
  const canEdit = month <= new Date().toISOString().slice(0, 7) && selected && !!book && !book.period?.closed && !loading;
  const download = () => {
    if (!book) return;
    const url = URL.createObjectURL(new Blob([cashbookCsv(book)], { type: 'text/csv;charset=utf-8' }));
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = `cashbook-${company.id}-${month}.csv`; anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return <section className="business-panel business-cashbook" aria-label={translate('직접 회계 장부')}>
    <div className="business-section-heading"><h3><BusinessIcon name="accounting" size={21} />{translate('USD 입출금 장부')}</h3><Button variant="secondary" onClick={onSetup}>{selected ? translate('사용 조건 · 처리 범위') : translate('직접 회계 선택')}</Button></div>
    <p className="business-guide-note">{translate('단일 회사 USD 계좌 · 실제 입출금 기록 → 증빙·은행 대사 → 내부 월 마감. 복식부기·세금 신고는 별도입니다.')}</p>
    {!selected && <p className="business-stale">{translate('직접 회계를 선택하면 기록·대사를 시작할 수 있습니다. 기존 기록의 조회·CSV 내보내기는 계속 가능합니다.')}</p>}
    <div className="business-cash-toolbar"><label>{translate('장부 월')}<input type="month" min="1900-01" max="9999-12" value={month} onChange={e => { if (e.target.value) { setMonth(e.target.value); setAction(null); } }} /></label><Button variant="ghost" disabled={loading} onClick={() => setRefresh(v => v + 1)}>{translate('새로고침')}</Button><Button variant="secondary" disabled={!book || loading} onClick={download}>{translate('CSV 내보내기')}</Button><Button disabled={!canEdit} onClick={() => setAction({ kind: 'add' })}><BusinessIcon name="plus" size={15} />{translate('입출금 기록')}</Button></div>
    {loading && <p role="status">{translate('장부를 불러오는 중…')}</p>}{error && <p className="business-inline-error" role="alert">{error}</p>}
    {book && <>
      <div className="business-cash-totals"><div><small>{translate('전체 입금')}</small><strong>{cashMoney(book.summary.inflow_minor)}</strong></div><div><small>{translate('전체 출금')}</small><strong>{cashMoney(book.summary.outflow_minor)}</strong></div><div><small>{translate('순입출금')}</small><strong>{cashMoney(book.summary.net_minor)}</strong></div><div><small>{translate('은행 대사')}</small><strong>{book.summary.active_count - book.summary.unreconciled_count} / {book.summary.active_count}</strong></div></div>
      <p className="business-guide-note">{translate('영업 입금')} {cashMoney(book.summary.operating_in_minor)} {translate('· 영업 출금')} {cashMoney(book.summary.operating_out_minor)}{translate('. 출자·대출·이체·환불은 별도 분류됩니다. 이 차이는 이익·과세소득이 아닙니다.')}</p>
      <div className="business-cash-close"><div><span className={`business-pill ${book.period?.closed ? 'connected' : ''}`}>{book.period?.closed ? translate('내부 월 마감 완료') : translate('기록 · 대사 중')}</span><p>{book.period?.closed ? translate('기초 {0} + 순입출금 = 기말 {1}', { 0: cashMoney(book.period.opening_minor), 1: cashMoney(book.period.closing_minor) }) : translate('모든 거래에 증빙과 대사 확인이 필요하며 기초 + 순입출금 = 기말 잔액이어야 합니다.')}</p>{book.period?.statement_reference && <small>{translate('명세서:')} {book.period.statement_reference}</small>}{book.period?.reopen_reason && <small>{translate('재개 사유:')} {book.period.reopen_reason}</small>}</div><Button variant="secondary" disabled={loading || (!book.period?.closed && (!canEdit || !!book.summary.unreconciled_count || month >= new Date().toISOString().slice(0, 7)))} onClick={() => setAction({ kind: book.period?.closed ? 'reopen' : 'close' })}>{book.period?.closed ? translate('마감 재개') : translate('잔액 확인 · 월 마감')}</Button></div>
      <p className="business-guide-note">{translate('월 마감은 지난달까지 가능합니다. 마감 후 정정은 최근 월부터 사유를 남기고 재개하세요.')}</p>
      <div className="business-cash-entries">{book.entries.map(entry => <article key={entry.id} className={entry.voided ? 'is-void' : ''} aria-label={translate('{0} 거래', { 0: entry.description })}><span className={`business-cash-direction ${cashIncoming(entry.kind) ? 'in' : 'out'}`}>{cashIncoming(entry.kind) ? '↓' : '↑'}</span><div className="business-cash-entry-copy"><strong>{entry.description}</strong><small>{entry.date} · {CASH_LABELS[entry.kind]} · {entry.voided ? translate('취소: {0}', { 0: entry.void_reason }) : entry.reconciled ? translate('은행 대사 확인') : translate('대사 전')}</small><small>{translate('증빙:')} {entry.evidence || translate('미등록')}</small></div><strong className="business-cash-amount">{cashMoney(entry.amount_minor)}</strong>{!entry.voided && <div className="business-card-actions"><Button variant="ghost" disabled={!canEdit} onClick={() => setAction({ kind: 'reconcile', entry })}>{translate('증빙 · 대사')}</Button><Button variant="ghost" disabled={!canEdit} onClick={() => setAction({ kind: 'void', entry })}>{translate('취소')}</Button></div>}</article>)}</div>
      {!book.entries.length && <p className="business-small-empty">{translate('이번 달 기록이 없습니다. 첫 입출금을 기록하세요.')}</p>}
    </>}
    {action && book && <CashActionForm key={`${company.id}-${month}-${action.kind}-${'entry' in action ? action.entry.id : ''}`} company={company} book={book} action={action} onClose={() => setAction(null)} onSaved={async () => { setAction(null); setRefresh(v => v + 1); await onChanged(); }} />}
  </section>;
}

function CashActionForm({ company, book, action, onClose, onSaved }: { company: BusinessCompany; book: Cashbook; action: Action; onClose(): void; onSaved(): Promise<void> }) {
  useLocale();
  const [requestId] = useState(() => crypto.randomUUID());
  const today = new Date().toISOString().slice(0, 10);
  const lastDay = new Date(Date.UTC(Number(book.month.slice(0, 4)), Number(book.month.slice(5, 7)), 0)).toISOString().slice(0, 10);
  const maxDate = lastDay < today ? lastDay : today;
  const [date, setDate] = useState(today.startsWith(book.month) ? today : `${book.month}-01`);
  const [kind, setKind] = useState<CashKind>('income'); const [amount, setAmount] = useState(''); const [description, setDescription] = useState('');
  const [evidence, setEvidence] = useState('entry' in action ? action.entry.evidence : '');
  const [reconciled, setReconciled] = useState('entry' in action ? action.entry.reconciled : false);
  const [reason, setReason] = useState(''); const [opening, setOpening] = useState(book.period ? String(book.period.opening_minor / 100) : '');
  const [closing, setClosing] = useState(book.period ? String(book.period.closing_minor / 100) : ''); const [statement, setStatement] = useState(book.period?.statement_reference || ''); const [complete, setComplete] = useState(false);
  const [error, setError] = useState(''); const [busy, setBusy] = useState(false); const revision = book.company_revision;
  const titles = { add: translate('실제 입출금 기록'), reconcile: translate('증빙 · 은행 대사'), void: translate('장부 기록 취소'), close: translate('은행 잔액 확인 · 내부 월 마감'), reopen: translate('내부 월 마감 재개') };
  const submit = async (event: React.FormEvent) => {
    event.preventDefault(); if (busy) return; setBusy(true); setError('');
    try {
      if (action.kind === 'add') await api.addBusinessCashEntry(company.id, { revision, request_id: requestId, date, kind, amount_minor: parseCashAmount(amount), currency: 'USD', description, evidence });
      if (action.kind === 'reconcile') await api.reconcileBusinessCashEntry(company.id, action.entry.id, { revision, evidence, reconciled });
      if (action.kind === 'void') await api.voidBusinessCashEntry(company.id, action.entry.id, { revision, reason });
      if (action.kind === 'close') {
        if (!complete) throw new Error(translate('은행 명세서의 모든 입출금을 기록했는지 확인하세요.'));
        await api.closeBusinessCashMonth(company.id, book.month, { revision, opening_minor: parseCashAmount(opening, true), closing_minor: parseCashAmount(closing, true), statement_reference: statement, confirm_complete: true });
      }
      if (action.kind === 'reopen') await api.reopenBusinessCashMonth(company.id, book.month, { revision, reason });
      await onSaved();
    } catch (e) {
      setError((e as Error).message);
    } finally { setBusy(false); }
  };
  let difference: number | null = null;
  try { difference = parseCashAmount(opening, true) + book.summary.net_minor - parseCashAmount(closing, true); } catch { /* Incomplete amounts. */ }
  return <Modal isOpen title={titles[action.kind]} maxWidth={620} onClose={() => { if (!busy) onClose(); }}>
    <form className="business-cash-form" onSubmit={submit}><fieldset disabled={busy}>
      <p className="business-guide-note">{company.name} · {book.month} {translate('· USD 단일 계좌')}</p>
      {action.kind === 'add' && <><label>{translate('거래일')}<input type="date" required min={`${book.month}-01`} max={maxDate} value={date} onChange={e => setDate(e.target.value)} /></label><label>{translate('거래 구분')}<select value={kind} onChange={e => setKind(e.target.value as CashKind)}>{Object.entries(CASH_LABELS).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label><label>{translate('금액 (USD)')}<input inputMode="decimal" required value={amount} onChange={e => setAmount(e.target.value)} placeholder="100.00" /></label><label>{translate('상대방 · 거래 용도')}<input required maxLength={500} value={description} onChange={e => setDescription(e.target.value)} /></label><p className="business-guide-note">{translate('은행에 실제 반영된 거래를 입력하세요. 은행·결제 커넥터 조회 결과는 자동 전기하지 않습니다. 금액 정정은 취소 후 새 거래로 기록합니다.')}</p></>}
      {(action.kind === 'add' || action.kind === 'reconcile') && <label>{translate('증빙 위치 · 참조')}<input required={action.kind === 'reconcile'} maxLength={1000} value={evidence} onChange={e => setEvidence(e.target.value)} placeholder={translate('영수증 보관 위치 / 청구서 번호 / 명세서 행')} /></label>}
      {action.kind === 'reconcile' && <label className="business-cash-check"><input type="checkbox" checked={reconciled} onChange={e => setReconciled(e.target.checked)} />{translate('은행 명세서와 일자·금액·내역이 일치함을 확인했습니다.')}</label>}
      {(action.kind === 'void' || action.kind === 'reopen') && <label>{translate('처리 사유')}<textarea required maxLength={500} value={reason} onChange={e => setReason(e.target.value)} /></label>}
      {action.kind === 'close' && <><label>{translate('은행 기초 잔액 (USD)')}<input inputMode="decimal" required value={opening} onChange={e => setOpening(e.target.value)} /></label><p>{translate('+ 이번 달 순입출금')} {cashMoney(book.summary.net_minor)}</p><label>{translate('은행 기말 잔액 (USD)')}<input inputMode="decimal" required value={closing} onChange={e => setClosing(e.target.value)} /></label><p role="status">{difference === null ? translate('은행 잔액을 입력하세요.') : difference === 0 ? translate('잔액이 일치합니다.') : translate('잔액 차이 {0} — 누락·중복 거래를 확인하세요.', { 0: cashMoney(difference) })}</p><label>{translate('은행 명세서 위치 · 참조')}<input required maxLength={1000} value={statement} onChange={e => setStatement(e.target.value)} /></label><label className="business-cash-check"><input type="checkbox" checked={complete} onChange={e => setComplete(e.target.checked)} />{translate('명세서의 모든 입출금을 기록·대사했고 증빙을 보관했습니다. 세금 신고는 별도로 진행합니다.')}</label></>}
      {error && <p className="business-inline-error" role="alert">{error}</p>}
      <div className="business-card-actions"><Button variant="ghost" type="button" onClick={onClose}>{translate('닫기')}</Button><Button type="submit" disabled={busy || (action.kind === 'close' && (!complete || difference !== 0))}>{busy ? translate('저장 중…') : translate('확인하고 저장')}</Button></div>
    </fieldset></form>
  </Modal>;
}
