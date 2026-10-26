import { getLocaleTag } from '../../i18n/core';
import { t as translate } from '../../i18n/core';
import type { Cashbook, CashKind } from '../../business.types';

export const CASH_LABELS: Record<CashKind, string> = { get income() { return translate('영업 입금'); }, get expense() { return translate('영업 출금'); }, get capital_in() { return translate('출자 입금'); }, get capital_out() { return translate('소유자 인출'); }, get loan_in() { return translate('대출 입금'); }, get loan_out() { return translate('대출 원금 상환'); }, get transfer_in() { return translate('계좌 이체 입금'); }, get transfer_out() { return translate('계좌 이체 출금'); }, get refund_in() { return translate('환불 입금'); }, get refund_out() { return translate('환불 출금'); } };
export const cashIncoming = (kind: CashKind) => kind === 'income' || kind.endsWith('_in');
export const cashMoney = (minor: number) => new Intl.NumberFormat(getLocaleTag(), { style: 'currency', currency: 'USD' }).format(minor / 100);
export function parseCashAmount(value: string, signed = false): number {
  const text = value.trim();
  if (!(signed ? /^-?\d+(\.\d{1,2})?$/ : /^\d+(\.\d{1,2})?$/).test(text)) throw new Error(translate('금액은 USD 소수 둘째 자리까지 입력하세요.'));
  const [whole, decimal = ''] = text.replace(/^-/, '').split('.');
  const minor = (Number(whole) * 100 + Number(decimal.padEnd(2, '0'))) * (text.startsWith('-') ? -1 : 1);
  if (!Number.isSafeInteger(minor) || Math.abs(minor) > 2_000_000_000 || (!signed && minor <= 0)) throw new Error(translate('거래 금액은 $0 초과 $20,000,000 이하로 입력하세요. 잔액은 ±$20,000,000 범위입니다.'));
  return minor;
}
export function cashbookCsv(book: Cashbook): string {
  const quote = (value: unknown) => {
    let text = String(value ?? '');
    if (/^[\s]*[=+\-@\t\r\n]/.test(text)) text = `'${text}`;
    return `"${text.replaceAll('"', '""')}"`;
  };
  const rows: unknown[][] = [['id', 'date', 'kind', 'direction', 'amount_minor', 'currency', 'description', 'evidence', 'reconciled', 'voided', 'void_reason']];
  for (const e of book.entries) rows.push([e.id, e.date, e.kind, cashIncoming(e.kind) ? 'in' : 'out', e.amount_minor, e.currency, e.description, e.evidence, e.reconciled, e.voided, e.void_reason]);
  return '\uFEFF' + rows.map(row => row.map(quote).join(',')).join('\r\n');
}
