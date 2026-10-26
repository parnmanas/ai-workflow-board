import { t as translate } from '../../i18n/core';
import { useLocale } from '../../i18n/react';
import React, { useState } from 'react';
import { api } from '../../api';
import type { MarketingSpendRequest, MarketingSpendingReconciliation } from '../../types';
import { Button, Input, Modal, Textarea } from '../common';
import { formatDateTime, formatMinor, minorToMajorInput, parseMajorToMinor } from './marketing.logic';
import { Hint, KeyValue, useAction, useMarketingCtx } from './MarketingUi';

/** Provider reports are observations; only the server can settle a confirmed reduction. */
export function MarketingSpendReconciliation({ spend }: { spend: MarketingSpendRequest }) {
  useLocale();
  const ctx = useMarketingCtx();
  const { busy, run } = useAction();
  const [report, setReport] = useState<MarketingSpendingReconciliation | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [noChange, setNoChange] = useState(false);
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const card = spend.provider === 'stripe_issuing';
  const status = report?.return_status || spend.return_status;
  const uncertain = status === 'unknown' || status === 'executing';
  const operation = report?.return_operation || spend.return_operation;
  const operationAmount = typeof operation?.amount_minor === 'number' ? formatMinor(operation.amount_minor, spend.currency) : '';
  const operationError = typeof operation?.error === 'string' ? operation.error : '';
  const statusLabel = status === 'completed' ? translate('완료') : status === 'failed' ? translate('실패') : status === 'unknown' ? translate('결과 불명') : translate('처리 중');
  const parsed = parseMajorToMinor(amount, spend.currency);
  const valid = parsed.ok && parsed.minor > 0 && !!report && parsed.minor <= report.refundable_minor;
  const read = async () => {
    const result = await run(() => api.reconcileMarketingSpending(spend.id));
    if (result) setReport(result);
  };
  const open = () => {
    if (!report) return;
    setAmount(minorToMajorInput(report.refundable_minor, spend.currency));
    setConfirmed(false);
    setNoChange(false);
    setNote('');
    setConfirming(true);
  };
  const submit = async () => {
    if (!confirmed || !note.trim()) return;
    if (!uncertain && (!valid || !parsed.ok || report?.ceiling_units == null)) return;
    const result = await run(() => uncertain
      ? api.reconcileMarketingReturn(spend.id, { note: note.trim(), confirm: true, ...(noChange ? { outcome: 'failed' as const, confirm_no_change: true as const } : {}) })
      : api.returnUnusedMarketingSpend(spend.id, {
        amount_minor: parsed.ok ? parsed.minor : 0, expected_ceiling: report!.ceiling_units!, expected_net_capture_minor: report!.net_capture_minor, note: note.trim(), confirm: true,
      }));
    if (!result) return;
    setConfirming(false);
    setReport(null);
    if (result.return_status === 'unknown' || result.return_status === 'executing') {
      ctx.notify(translate('반납 결과를 아직 확정할 수 없습니다. 공급자 결과 대조로 확인하세요.'), 'info');
    } else if (result.return_status === 'failed' && uncertain && noChange) {
      ctx.notify(translate('공급자 변경이 없음을 확인해 반납을 환불 없이 닫았습니다.'), 'success');
    } else if (result.return_status === 'failed') {
      ctx.notify(translate('반납이 완료되지 않았습니다. 지출 대조를 새로 읽어 확인하세요.'), 'error');
    } else ctx.notify(translate('반납 결과를 기록했습니다.'), 'success');
  };

  if (!ctx.canApproveSpend) return <Hint>{translate('플랫폼 지출 대조 · 미사용 상한 반납은 지출 승인 권한이 있는 사람이 확인합니다.')}</Hint>;
  return (
    <div data-testid={`marketing-spending-reconciliation-${spend.id}`} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div><Button size="sm" variant="secondary" disabled={busy} onClick={() => void read()}>{translate('플랫폼 지출 대조')}</Button></div>
      {status && <Hint tone={status === 'failed' ? 'danger' : undefined}>{translate('최근 반납:')} {statusLabel}{operationAmount && ` · ${operationAmount}`}{operationError && ` · ${operationError}`}</Hint>}
      {uncertain && <Hint tone="warning">{translate('미사용 상한 반납 결과 불명 또는 처리 중입니다. 새 반납을 보내지 말고 공급자 결과를 대조하세요.')}</Hint>}
      {report && <>
        <KeyValue items={[
          [translate('조회 시각'), formatDateTime(report.observed_at)],
          [translate('대상 상태'), `${report.status}${report.stopped ? translate(' · 종료·중지 대상') : ''}`],
          [translate('현재 상한'), report.ceiling_minor == null ? translate('확인 불가') : formatMinor(report.ceiling_minor, spend.currency)],
          [translate('대상 전체 플랫폼 지출'), formatMinor(report.spend_minor, spend.currency)],
          [translate('원본 지출 값'), report.spend_exact],
          [translate('미확정 승인'), formatMinor(report.pending_minor, spend.currency)],
          [translate('이 요청의 원장 순사용'), formatMinor(report.net_capture_minor, spend.currency)],
          [report.stopped ? translate('종료·중지 대상의 반납 가능 상한') : translate('반납 가능 상한'), formatMinor(report.refundable_minor, spend.currency)],
        ]} />
        <Hint>{spend.provider === 'meta_ads'
          ? translate('Meta Insights spend는 추정치입니다. 나중에 정정될 수 있습니다.')
          : spend.provider === 'google_ads'
            ? translate('Google metrics.cost_micros는 서비스 비용으로, 실제 청구액과 다를 수 있습니다.')
            : translate('Stripe Issuing 거래와 미확정 승인을 대조합니다. 팁·나중 매입·강제 매입으로 해지 뒤에도 금액이 달라질 수 있습니다.')}</Hint>
        {report.overrun_minor > 0 && <Hint tone="danger">{translate('플랫폼 상한 초과 지출:')} {formatMinor(report.overrun_minor, spend.currency)}{translate('. 원장 환불로 숨기지 않으므로 사람이 확인해야 합니다.')}</Hint>}
        {(report.ledger_shortfall_minor || 0) > 0 && <Hint tone="danger">{translate('카드 지출·미확정 승인이 이 계정의 카드 원장 순사용 합계를 초과:')} {formatMinor(report.ledger_shortfall_minor, spend.currency)}{translate('. 반납 뒤 늦게 매입된 금액 등을 확인하세요. 플랫폼 상한 초과와는 별도입니다.')}</Hint>}
        {report.notes.map((text, index) => <Hint key={index}>{text}</Hint>)}
        {!report.complete && <Hint tone="warning">{translate('지출 보고서를 완전히 확인하지 못해 반납할 수 없습니다.')}</Hint>}
        {!uncertain && report.complete && report.refundable_minor > 0 && report.ceiling_units != null &&
          <div><Button size="sm" variant="secondary" disabled={busy} onClick={open}>{card ? translate('카드 해지 후 미사용분 반납…') : translate('미사용 상한 반납…')}</Button></div>}
      </>}
      {uncertain && <div><Button size="sm" variant="secondary" disabled={busy || !report} onClick={open}>{translate('반납 결과 대조…')}</Button>{!report && <Hint>{translate('먼저 플랫폼 지출 대조를 읽으세요.')}</Hint>}</div>}
      {confirming && report && <Modal isOpen onClose={() => { if (!busy) setConfirming(false); }} title={uncertain ? translate('반납 결과 대조 확인') : translate('미사용 상한 반납 승인')} maxWidth={600} footer={<>
        <Button variant="secondary" disabled={busy} onClick={() => setConfirming(false)}>{translate('취소')}</Button>
        <Button variant="primary" disabled={busy || !confirmed || !note.trim() || (!uncertain && !valid)} onClick={() => void submit()}>{busy ? translate('처리 중…') : uncertain ? translate('결과 대조') : translate('반납 승인')}</Button>
      </>}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div>{spend.payee} · {spend.payee_ref}</div>
          {uncertain ? <Hint>{translate('이미 보낸 반납')}{operationAmount && ` ${operationAmount}`}{translate('의 공급자 결과를 읽고 확인된 금액만 기록합니다. 상한 변경이나 카드 해지를 다시 보내지 않습니다.')}</Hint> : <>
            <Input label={translate('반납 금액 ({0})', { 0: spend.currency })} value={amount} onChange={(e) => { setAmount(e.target.value); setConfirmed(false); }} />
            <Hint>{translate('최대')} {formatMinor(report.refundable_minor, spend.currency)} {translate('· 현재 상한')} {formatMinor(report.ceiling_minor, spend.currency)} {translate('· 승인 금액')} {parsed.ok ? formatMinor(parsed.minor, spend.currency) : translate('금액을 확인하세요')}</Hint>
            {card ? <Hint tone="warning">{translate('카드를 먼저 해지합니다. 해지는 되돌릴 수 없고 이 카드를 쓰는 다른 결제도 중단됩니다. 해지 후 거래와 미확정 승인을 다시 읽어 확인된 미사용분만 반납합니다.')}</Hint>
              : <Hint>{translate('변경 후 상한')} {parsed.ok && report.ceiling_minor != null ? formatMinor(report.ceiling_minor - parsed.minor, spend.currency) : translate('금액을 확인하세요')}{translate('. 서버가 현재 상한이 이 화면의 값과 같은지 확인한 뒤 승인 금액만큼 낮추고, 그만큼만 원장에 환불을 기록합니다.')}</Hint>}
          </>}
          {uncertain && <>
            <label><input type="checkbox" checked={noChange} onChange={(e) => { setNoChange(e.target.checked); setConfirmed(false); }} />{translate('공급자에서 상한 변경·카드 해지가 반영되지 않았음을 확인했습니다 — 환불 없이 실패로 닫기')}</label>
            {noChange && <Hint tone="warning">{translate('요청 후 15분이 지나고 서버도 공급자 상태가 바뀌지 않았음을 확인해야 실패로 닫습니다. 대기 중인 작업이 뒤늦게 반영될 가능성까지 공급자에서 확인하세요.')}</Hint>}
          </>}
          <Textarea label={translate('확인한 내용')} value={note} onChange={(e) => setNote(e.target.value)} rows={2} />
          <label><input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />{uncertain ? noChange ? translate('반영되지 않은 반납을 환불 없이 실패로 닫는 것을 승인합니다') : translate('기존 반납의 결과 대조를 승인합니다') : card ? translate('카드 해지와 위 금액의 반납을 승인합니다') : translate('위 금액만큼 상한을 낮추고 반납하는 것을 승인합니다')}</label>
        </div>
      </Modal>}
    </div>
  );
}
