/**
 * 마케팅 금액 규칙 — docs/marketing.md "예산 편성 · 집행 · 결제".
 *
 * 금액은 전부 정수 최소 단위(minor units)다. 부동소수 금액은 받지 않는다 — 0.1 + 0.2 같은
 * 오차가 한도 비교에 섞이면 "한도 안" 과 "한도 밖" 이 입력 표기에 따라 갈린다.
 * 저장은 `bigint` 칼럼이고(Postgres 는 문자열로, sql.js 는 숫자로 돌아온다) 읽을 때
 * `MINOR_AMOUNT_TRANSFORMER` 가 숫자로 맞춘다. 상한 `MAX_MINOR_AMOUNT` 는 원장 수천 행을
 * 더해도 2^53 을 넘지 않게 잡았다.
 */

export const MAX_MINOR_AMOUNT = 9_000_000_000_000;

/** ISO 4217 지수가 0 인 통화(최소 단위 = 1 단위). */
const ZERO_DECIMAL_CURRENCIES = new Set([
  'BIF', 'CLP', 'DJF', 'GNF', 'ISK', 'JPY', 'KMF', 'KRW', 'PYG', 'RWF', 'UGX', 'UYI', 'VND', 'VUV', 'XAF', 'XOF', 'XPF',
]);
/** ISO 4217 지수가 3 인 통화. */
const THREE_DECIMAL_CURRENCIES = new Set(['BHD', 'IQD', 'JOD', 'KWD', 'LYD', 'OMR', 'TND']);

export class MarketingMoneyError extends Error {
  readonly status = 400;
  constructor(message: string) {
    super(message);
    this.name = 'MarketingMoneyError';
  }
}

export function normalizeCurrency(value: unknown, label = 'currency'): string {
  const code = typeof value === 'string' ? value.trim().toUpperCase() : '';
  if (!/^[A-Z]{3}$/.test(code)) throw new MarketingMoneyError(`${label} must be a 3-letter ISO 4217 code (e.g. KRW, USD)`);
  return code;
}

export function currencyExponent(currency: string): number {
  const code = currency.toUpperCase();
  if (ZERO_DECIMAL_CURRENCIES.has(code)) return 0;
  if (THREE_DECIMAL_CURRENCIES.has(code)) return 3;
  return 2;
}

/**
 * 정수 최소 단위 금액을 읽는다. 숫자(정수)나 숫자만으로 된 문자열만 받는다 — "12.5" · "1e3" ·
 * 음수 · 안전 정수 밖은 거부. `allowZero` 가 아니면 0 도 거부한다(0원 지출 요청은 의미가 없다).
 */
export function parseMinorAmount(value: unknown, label: string, opts: { allowZero?: boolean } = {}): number {
  let n: number;
  if (typeof value === 'number') {
    n = value;
  } else if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
    n = Number(value.trim());
  } else {
    throw new MarketingMoneyError(`${label} must be an integer amount in minor units (e.g. 50000 for 50,000 KRW, 1250 for 12.50 USD)`);
  }
  if (!Number.isSafeInteger(n) || n < 0) {
    throw new MarketingMoneyError(`${label} must be a non-negative integer amount in minor units`);
  }
  if (n === 0 && !opts.allowZero) throw new MarketingMoneyError(`${label} must be greater than 0`);
  if (n > MAX_MINOR_AMOUNT) throw new MarketingMoneyError(`${label} exceeds the maximum supported amount (${MAX_MINOR_AMOUNT})`);
  return n;
}

/** 사람이 읽는 금액 표기 — 지시문 · 감사 요약 · 화면이 같은 표기를 쓴다. */
export function formatMinorAmount(amount: number, currency: string): string {
  const exp = currencyExponent(currency);
  const negative = amount < 0;
  const abs = Math.abs(Math.trunc(amount));
  const whole = Math.floor(abs / 10 ** exp);
  const frac = exp > 0 ? String(abs % 10 ** exp).padStart(exp, '0') : '';
  const wholeText = whole.toLocaleString('en-US');
  return `${negative ? '-' : ''}${wholeText}${frac ? `.${frac}` : ''} ${currency}`;
}

/** bigint 칼럼을 숫자로 맞춘다(Postgres 는 문자열로 돌려준다). */
export const MINOR_AMOUNT_TRANSFORMER = {
  to: (value: number | null | undefined) => value,
  from: (value: unknown) => {
    if (value === null || value === undefined) return value as null | undefined;
    const n = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(n) ? n : 0;
  },
};
