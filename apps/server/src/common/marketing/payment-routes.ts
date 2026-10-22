/**
 * 직접 결제 어댑터의 순수 규칙 — docs/marketing.md "직접 결제 어댑터".
 *
 * 직접 어댑터는 돈을 "보내지" 않는다. 두 종류다(DIRECT_PROVIDER_SPECS):
 *   - 상한(ceiling) — Meta Ads(캠페인 `spend_cap`) · Google Ads(`CUSTOM_PERIOD` 총예산): 광고 플랫폼의 **고정 상한**을 올린다.
 *     승인 금액 = 상한이 늘어나는 양. 요청 때 대상을 읽어 계획(`from` → `to`)을 만들고, 실행은 compare-and-set 이다(그때도 `from`
 *     이면 `to` — 절대값이라 다시 써도 같다). 같은 상한을 두 요청이 올리면 서로의 from 을 덮으므로 대상마다 열린 요청은 하나다.
 *   - 카드(card) — Stripe Issuing: 승인 금액이 누적 한도인 가상 카드를 한 장 만든다(비활성으로 만들고 대조한 뒤 활성화). 사람이
 *     그 카드로 결제한다. 카드끼리는 서로 영향이 없어 열린 요청 규칙이 없다.
 * 둘 다 결제 경로는 수취인마다 정하고(사람만 고친다), 서버가 만든 계획이 payload(해시 대상)다.
 * 이 파일은 네트워크 없이 정할 수 있는 것만 둔다: 공급자 명세, 대상 ref, 통화 단위, 계획 검증 · 문장, 카드 통제, 키 규칙, 문자열 정리.
 */
import { currencyExponent, formatMinorAmount } from './money';

export const DIRECT_PAYMENT_PROVIDERS = ['meta_ads', 'google_ads', 'stripe_issuing'] as const;
export type DirectPaymentProvider = typeof DIRECT_PAYMENT_PROVIDERS[number];
export type CeilingProvider = 'meta_ads' | 'google_ads';

export const DIRECT_PAYMENT_PROVIDER_LABELS: Record<DirectPaymentProvider, string> = {
  meta_ads: 'Meta Ads',
  google_ads: 'Google Ads',
  stripe_issuing: 'Stripe Issuing',
};

/**
 * 공급자 명세 — 종류와 배타성. `exclusive` 면 대상마다 열린 요청은 하나다(uq_marketing_spend_open_target · target_key).
 * 공급자를 더하면 아래의 switch(assertNever)가 컴파일 오류로 빠진 곳을 알려 준다 — "Meta 가 아니면 Google" 같은 분기를 쓰지 말 것.
 */
export const DIRECT_PROVIDER_SPECS: Readonly<Record<DirectPaymentProvider, { kind: 'ceiling' | 'card'; exclusive: boolean }>> = {
  meta_ads: { kind: 'ceiling', exclusive: true },
  google_ads: { kind: 'ceiling', exclusive: true },
  stripe_issuing: { kind: 'card', exclusive: false },
};

export function isDirectPaymentProvider(value: unknown): value is DirectPaymentProvider {
  return typeof value === 'string' && (DIRECT_PAYMENT_PROVIDERS as readonly string[]).includes(value);
}

export function isCeilingProvider(value: unknown): value is CeilingProvider {
  return isDirectPaymentProvider(value) && DIRECT_PROVIDER_SPECS[value].kind === 'ceiling';
}

/** 대상마다 열린 요청이 하나여야 하는 공급자인가(상한 공급자). 아니면 target_key 를 남기지 않는다. */
export function isExclusiveTargetProvider(value: unknown): boolean {
  return isDirectPaymentProvider(value) && DIRECT_PROVIDER_SPECS[value].exclusive;
}

function assertNever(value: never): never {
  throw new Error(`unhandled direct payment provider ${String(value)}`);
}

/** 승인되면 서버가 스스로 실행하는 결제 방식 — 사람이 결과를 기록하는 manual 이 아닌 것. */
export function isAutomaticPaymentProvider(value: unknown): boolean {
  return value === 'webhook' || isDirectPaymentProvider(value);
}

/**
 * 직접 공급자의 credential 필드. Credential 의 `provider` 칼럼이 공급자 이름과 같아야 받는다(Credentials 화면의 전용 입력 칸).
 * 화면의 입력 칸은 이 목록과 같아야 한다 — apps/client/test/marketing-payment-contract.test.mjs 가 고정한다.
 */
export const DIRECT_PROVIDER_CREDENTIAL_FIELDS: Record<DirectPaymentProvider, { required: readonly string[]; optional: readonly string[] }> = {
  meta_ads: { required: ['access_token'], optional: ['app_secret'] },
  google_ads: { required: ['client_id', 'client_secret', 'refresh_token'], optional: ['login_customer_id', 'developer_token'] },
  stripe_issuing: { required: ['secret_key'], optional: [] },
};

/**
 * 공급자 API 버전. 공급자가 버전을 1년 남짓 만에 닫으므로(Meta 는 새 버전 뒤 최소 90일, Google 은 약 1년) 코드 수정 없이
 * 환경 변수로 올릴 수 있게 한다. 형식이 틀린 값은 무시하고 기본값을 쓴다. 버전은 해시 대상(계획)에 넣지 않는다 —
 * 승인 대기 중에 버전을 올려도 사람이 본 것(대상 · 값)은 그대로다. 실제로 쓴 버전은 결과 응답 요약에 남는다.
 */
export interface PaymentApiVersionSpec {
  default: string;
  env: string;
  pattern: RegExp;
  sunset: string;
  /** 이보다 오래된 버전(날짜 앞부분 비교)은 무시한다 — 쓰는 기능이 그 버전부터 있다. */
  minimum?: string;
}

export const PAYMENT_API_VERSIONS: Readonly<Record<DirectPaymentProvider, PaymentApiVersionSpec>> = {
  meta_ads: { default: 'v26.0', env: 'MARKETING_META_API_VERSION', pattern: /^v\d{1,3}\.\d{1,2}$/, sunset: '2027-08 무렵(새 버전이 나온 뒤 최소 90일)' },
  google_ads: { default: 'v26', env: 'MARKETING_GOOGLE_ADS_API_VERSION', pattern: /^v\d{1,3}$/, sunset: '2027-11 예정' },
  // Stripe 는 날짜 + 이름(`YYYY-MM-DD.<name>`)이고 계정 기본값에 기대지 않고 매 요청에 고정한다. 일회용 카드(lifecycle_controls)는
  // 2026-03-25.dahlia 부터라 그보다 오래된 버전과 preview 채널은 받지 않는다.
  stripe_issuing: { default: '2026-09-30.endive', env: 'MARKETING_STRIPE_API_VERSION', pattern: /^\d{4}-\d{2}-\d{2}\.[a-z]{1,20}$/, sunset: '—', minimum: '2026-03-25' },
};

export function paymentApiVersion(provider: DirectPaymentProvider, env: Record<string, string | undefined> = process.env): string {
  const spec = PAYMENT_API_VERSIONS[provider];
  const raw = (env[spec.env] || '').trim();
  if (!spec.pattern.test(raw)) return spec.default;
  if (spec.minimum && (raw.slice(0, 10) < spec.minimum || raw.endsWith('.preview'))) return spec.default;
  return raw;
}

/**
 * 직접 결제의 결과 불명은 실행 뒤 이만큼 지나야 "실패" 로 기록할 수 있다. 공급자 반영이 늦을 수 있어서(Meta 상한 변경은 최대 15분,
 * Google 변경 기록은 몇 분) 그 전에 "아직 안 바뀌었다" 를 보고 실패로 닫으면, 나중에 반영된 상한이 원장 밖에 남는다. 화면의 대조
 * 안내도 이 값을 쓴다(apps/client/test/marketing-payment-contract.test.mjs 가 대조한다).
 */
export const DIRECT_FAIL_GRACE_MS = 15 * 60_000;

/** 규칙 위반 — 사람이 설정을 고쳐야 풀린다(같은 요청을 다시 보내도 같은 답). */
export class PaymentRuleError extends Error {
  readonly status: number;
  constructor(message: string, status = 409) {
    super(message);
    this.name = 'PaymentRuleError';
    this.status = status;
  }
}

// ── 대상(ref) ──────────────────────────────────────────────────────────────

export interface MetaTarget { ad_account_id: string; campaign_id: string }
export interface GoogleTarget { customer_id: string; campaign_id: string }
export interface StripeTarget { cardholder: string }
export type DirectTarget = MetaTarget | GoogleTarget | StripeTarget;

export const DIRECT_REF_FORMATS: Record<DirectPaymentProvider, string> = {
  meta_ads: 'act_<광고 계정 id>/<캠페인 id> (예: act_1234567890/120210000000000)',
  google_ads: '<고객 id>/<캠페인 id> (예: 123-456-7890/22334455)',
  stripe_issuing: '카드 소지자 id ich_… (예: ich_1MsKAB2eZvKYlo2C)',
};

const DIGITS = /^\d{1,30}$/;

/** `act_<계정>/<캠페인>` — 정확히 한 캠페인. 계정은 그 캠페인의 `account_id` 와 대조한다. */
export function parseMetaRef(raw: string): MetaTarget {
  const m = String(raw || '').trim().match(/^act_(\d{1,30})\s*\/\s*(\d{1,30})$/);
  if (!m) throw new PaymentRuleError(`Meta Ads payee ref must look like ${DIRECT_REF_FORMATS.meta_ads}`, 400);
  return { ad_account_id: m[1], campaign_id: m[2] };
}

/** `<고객 id>/<캠페인 id>` — 고객 id 는 10자리(대시 허용). */
export function parseGoogleRef(raw: string): GoogleTarget {
  const m = String(raw || '').trim().match(/^(\d{3}-?\d{3}-?\d{4})\s*\/\s*(\d{1,30})$/);
  if (!m) throw new PaymentRuleError(`Google Ads payee ref must look like ${DIRECT_REF_FORMATS.google_ads}`, 400);
  return { customer_id: m[1].replace(/-/g, ''), campaign_id: m[2] };
}

/** Stripe 카드 소지자 id — 카드는 이 사람(또는 회사) 아래에 만들어진다. */
export function parseStripeRef(raw: string): StripeTarget {
  const m = String(raw || '').trim().match(/^(ich_[A-Za-z0-9]{1,250})$/);
  if (!m) throw new PaymentRuleError(`Stripe Issuing payee ref must be a cardholder id — ${DIRECT_REF_FORMATS.stripe_issuing}`, 400);
  return { cardholder: m[1] };
}

export function parseDirectRef(provider: DirectPaymentProvider, raw: string): DirectTarget {
  switch (provider) {
    case 'meta_ads': return parseMetaRef(raw);
    case 'google_ads': return parseGoogleRef(raw);
    case 'stripe_issuing': return parseStripeRef(raw);
    default: return assertNever(provider);
  }
}

/** 저장 형태 — 같은 대상은 언제나 같은 문자열(대상 키 · 대조에 쓴다). */
export function canonicalDirectRef(provider: DirectPaymentProvider, raw: string): string {
  switch (provider) {
    case 'meta_ads': {
      const t = parseMetaRef(raw);
      return `act_${t.ad_account_id}/${t.campaign_id}`;
    }
    case 'google_ads': {
      const t = parseGoogleRef(raw);
      return `${t.customer_id}/${t.campaign_id}`;
    }
    case 'stripe_issuing':
      return parseStripeRef(raw).cardholder;
    default:
      return assertNever(provider);
  }
}

/**
 * 대상 키(`<공급자>:<정규 ref>`) — 요청 백오프의 키이고, 배타적인 공급자(상한)에서는 열린 요청을 대상마다 하나로 묶는 DB 키다
 * (캠페인 · 계정을 넘어서도 — 같은 광고 캠페인을 두 곳에서 올리면 서로의 from 을 덮는다). 카드 공급자는 DB 에 남기지 않는다.
 */
export function directTargetKey(provider: DirectPaymentProvider, raw: string): string {
  return `${provider}:${canonicalDirectRef(provider, raw)}`;
}

// ── 결제 경로 ──────────────────────────────────────────────────────────────

export interface PaymentRoute {
  provider: string;
  credential_id: string | null;
  ref: string;
}

export interface PayeeLike {
  name: string;
  ref?: string;
  note?: string;
  provider?: string;
  credential_id?: string;
  /** 카드 공급자(Stripe Issuing)만: 첫 결제 뒤 자동 해지(기본 true). */
  card_single_use?: boolean;
  /** 카드 공급자만: 허용 업종(Stripe merchant category 이름) — 비면 업종 제한 없음. */
  card_categories?: string[];
  /** 카드 공급자만: 카드 한 장의 최대 금액(최소 단위) — 카드 프로그램 한도(예: Standard 카드당 하루 500 USD)에 맞춘다. */
  card_max_minor?: number;
}

/**
 * 수취인의 결제 경로 — 수취인에 직접 공급자가 있으면 그것, 없으면 캠페인의 결제 방식(manual · webhook).
 * 요청이 이 경로를 스냅샷으로 남기고(provider · provider_credential_id · payee_ref), 승인 · 실행 때 지금 경로와 대조한다 —
 * 사람이 수취인을 다른 대상으로 돌렸거나 결제 방식을 바꿨으면 예전 요청은 실행되지 않는다.
 */
export function payeeRoute(
  campaign: { payment_provider: string; payment_credential_id: string | null },
  payee: PayeeLike,
): PaymentRoute {
  if (isDirectPaymentProvider(payee.provider)) {
    return { provider: payee.provider, credential_id: payee.credential_id || null, ref: payee.ref || '' };
  }
  const provider = campaign.payment_provider || 'manual';
  return { provider, credential_id: provider === 'webhook' ? campaign.payment_credential_id || null : null, ref: payee.ref || '' };
}

export function sameRoute(
  row: { provider: string; provider_credential_id: string | null; payee_ref: string },
  route: PaymentRoute,
): boolean {
  return row.provider === route.provider
    && (row.provider_credential_id || null) === (route.credential_id || null)
    && (row.payee_ref || '') === (route.ref || '');
}

// ── 통화 단위 ─────────────────────────────────────────────────────────────

/**
 * 직접 어댑터가 받는 통화 — ISO 4217 지수(AWB 최소 단위)와 Meta Marketing API 의 offset(공식 표,
 * developers.facebook.com/docs/marketing-api/currencies, 2026-10 확인)을 함께 적은 닫힌 표다. 표에 없는 통화는 거부한다 —
 * 모르는 통화를 기본 지수로 추측하면 상한이 100배로 움직일 수 있다. 지수는 money.ts 와 같아야 한다(테스트가 대조).
 * Meta offset 이 ISO 최소 단위와 다른 통화가 있다: COP · CRC · HUF · IDR · TWD 는 Meta 가 정수 단위(offset 1), BHD · JOD 는
 * 1/100(offset 100) 이다.
 */
export const PAYMENT_CURRENCIES: Readonly<Record<string, { exponent: number; meta_offset: 1 | 100 }>> = {
  AED: { exponent: 2, meta_offset: 100 }, ARS: { exponent: 2, meta_offset: 100 }, AUD: { exponent: 2, meta_offset: 100 },
  BDT: { exponent: 2, meta_offset: 100 }, BGN: { exponent: 2, meta_offset: 100 }, BHD: { exponent: 3, meta_offset: 100 },
  BOB: { exponent: 2, meta_offset: 100 }, BRL: { exponent: 2, meta_offset: 100 }, CAD: { exponent: 2, meta_offset: 100 },
  CHF: { exponent: 2, meta_offset: 100 }, CLP: { exponent: 0, meta_offset: 1 }, CNY: { exponent: 2, meta_offset: 100 },
  COP: { exponent: 2, meta_offset: 1 }, CRC: { exponent: 2, meta_offset: 1 }, CZK: { exponent: 2, meta_offset: 100 },
  DKK: { exponent: 2, meta_offset: 100 }, DZD: { exponent: 2, meta_offset: 100 }, EGP: { exponent: 2, meta_offset: 100 },
  EUR: { exponent: 2, meta_offset: 100 }, GBP: { exponent: 2, meta_offset: 100 }, GTQ: { exponent: 2, meta_offset: 100 },
  HKD: { exponent: 2, meta_offset: 100 }, HNL: { exponent: 2, meta_offset: 100 }, HUF: { exponent: 2, meta_offset: 1 },
  IDR: { exponent: 2, meta_offset: 1 }, ILS: { exponent: 2, meta_offset: 100 }, INR: { exponent: 2, meta_offset: 100 },
  ISK: { exponent: 0, meta_offset: 1 }, JOD: { exponent: 3, meta_offset: 100 }, JPY: { exponent: 0, meta_offset: 1 },
  KES: { exponent: 2, meta_offset: 100 }, KRW: { exponent: 0, meta_offset: 1 }, MOP: { exponent: 2, meta_offset: 100 },
  MXN: { exponent: 2, meta_offset: 100 }, MYR: { exponent: 2, meta_offset: 100 }, NGN: { exponent: 2, meta_offset: 100 },
  NIO: { exponent: 2, meta_offset: 100 }, NOK: { exponent: 2, meta_offset: 100 }, NZD: { exponent: 2, meta_offset: 100 },
  PEN: { exponent: 2, meta_offset: 100 }, PHP: { exponent: 2, meta_offset: 100 }, PKR: { exponent: 2, meta_offset: 100 },
  PLN: { exponent: 2, meta_offset: 100 }, PYG: { exponent: 0, meta_offset: 1 }, QAR: { exponent: 2, meta_offset: 100 },
  RON: { exponent: 2, meta_offset: 100 }, RSD: { exponent: 2, meta_offset: 100 }, RUB: { exponent: 2, meta_offset: 100 },
  SAR: { exponent: 2, meta_offset: 100 }, SEK: { exponent: 2, meta_offset: 100 }, SGD: { exponent: 2, meta_offset: 100 },
  THB: { exponent: 2, meta_offset: 100 }, TRY: { exponent: 2, meta_offset: 100 }, TWD: { exponent: 2, meta_offset: 1 },
  UAH: { exponent: 2, meta_offset: 100 }, USD: { exponent: 2, meta_offset: 100 }, UYU: { exponent: 2, meta_offset: 100 },
  VES: { exponent: 2, meta_offset: 100 }, VND: { exponent: 0, meta_offset: 1 }, ZAR: { exponent: 2, meta_offset: 100 },
};

/** 통화 문제는 금액을 바꿔서는 풀리지 않는다 — 사람이 캠페인 통화나 수취인을 고쳐야 한다(409). */
function currencySpec(currency: string): { exponent: number; meta_offset: 1 | 100 } {
  const spec = PAYMENT_CURRENCIES[String(currency || '').toUpperCase()];
  if (!spec) throw new PaymentRuleError(`currency ${currency} is not supported by the direct payment adapters`, 409);
  // money.ts 가 다른 지수를 쓰면 AWB 화면의 금액과 공급자에 보내는 금액이 어긋난다 — 그런 통화는 받지 않는다.
  if (currencyExponent(currency) !== spec.exponent) throw new PaymentRuleError(`currency ${currency} has an inconsistent minor unit`, 409);
  return spec;
}

export function isPaymentCurrencySupported(currency: string): boolean {
  try { currencySpec(currency); return true; } catch { return false; }
}

// ── 카드(Stripe Issuing) ──────────────────────────────────────────────────

/** Stripe Issuing 카드 통화 — 사업자 지역마다 하나(미국 usd · EU eur · 영국 gbp). 최소 단위는 AWB 와 같다. */
export const STRIPE_CARD_CURRENCIES = ['USD', 'EUR', 'GBP'] as const;

/** 카드 한도(최소 단위) — 통화가 카드 통화가 아니면 409(금액이 아니라 캠페인 통화 · 수취인을 사람이 고친다). */
export function stripeCardAmount(minor: number | bigint, currency: string): bigint {
  const code = String(currency || '').toUpperCase();
  if (!(STRIPE_CARD_CURRENCIES as readonly string[]).includes(code)) {
    throw new PaymentRuleError(`currency ${currency} is not a Stripe Issuing card currency (USD, EUR or GBP by the Stripe account's region)`, 409);
  }
  if (currencyExponent(code) !== 2) throw new PaymentRuleError(`currency ${currency} has an inconsistent minor unit`, 409);
  return BigInt(minor);
}

/**
 * 일회용 카드 한 장이 쓸 수 있는 최대(최소 단위) — 승인 한 건의 고정 상한(10,000 USD 상당). 일회용 카드는 첫 결제 뒤 해지되므로
 * 이보다 큰 한도는 쓰이지 못한 채 원장에 사용으로 묶인다.
 */
export const STRIPE_SINGLE_USE_MAX_MINOR = 1_000_000;

export const CARD_CATEGORY_PATTERN = /^[a-z][a-z0-9_]{1,79}$/;
export const MAX_CARD_CATEGORIES = 20;

/**
 * 허용 업종 목록 — Stripe merchant category 이름(소문자 · 밑줄)만, 중복 없이 정렬해 저장한다(같은 집합은 같은 배열 — 요청 뒤 변경
 * 감지가 집합 비교가 된다). 이름이 실제로 있는지는 Stripe 가 카드를 만들 때 본다(틀리면 거절 — 아무것도 만들어지지 않는다).
 */
export function normalizeCardCategories(value: unknown): string[] {
  if (value === undefined || value === null || value === '') return [];
  const raw = Array.isArray(value) ? value : String(value).split(',');
  const out = new Set<string>();
  for (const item of raw) {
    const name = String(item ?? '').trim().toLowerCase();
    if (!name) continue;
    if (!CARD_CATEGORY_PATTERN.test(name)) {
      throw new PaymentRuleError(`card category "${String(item).trim().slice(0, 40)}" is not a Stripe merchant category name (lowercase words joined by "_", e.g. advertising_services)`, 400);
    }
    out.add(name);
  }
  if (out.size > MAX_CARD_CATEGORIES) throw new PaymentRuleError(`at most ${MAX_CARD_CATEGORIES} card categories`, 400);
  return [...out].sort();
}

/**
 * Stripe 키의 모드 — 운영(live)에서는 제한된 키(rk_live_…)만 받는다. 전체 비밀 키(sk_live_…)는 그 계정의 모든 돈(고객 카드 결제 ·
 * 환불 · 카드 번호 조회)을 움직일 수 있어, AWB DB 와 암호화 키를 쥔 사람에게 너무 큰 권한이 된다. 샌드박스(rk_test_ · sk_test_)는
 * 받는다. 틀리면 PaymentRuleError(400).
 */
export function stripeKeyMode(key: string): 'live' | 'test' {
  const k = String(key || '').trim();
  if (/^rk_live_[A-Za-z0-9]{8,}$/.test(k)) return 'live';
  if (/^(?:rk|sk)_test_[A-Za-z0-9]{8,}$/.test(k)) return 'test';
  if (/^sk_live_/.test(k)) {
    throw new PaymentRuleError('Stripe Issuing needs a restricted key (rk_live_…) in live mode — create one with Issuing Cards: Write and Issuing Cardholders: Read; a full secret key (sk_live_…) is refused', 400);
  }
  throw new PaymentRuleError('Stripe Issuing credential "secret_key" must be a restricted key (rk_live_… or sandbox rk_test_…) or a sandbox secret key (sk_test_…)', 400);
}

/**
 * 공급자가 주는 정수 문자열(int64) — 숫자만, 19자리까지. BigInt('') 가 0 이 되는 함정을 막는다. 받은 값은 오류 문장에 넣지 않는다
 * (이 문장은 에이전트까지 간다).
 */
export function parseProviderInt(value: unknown, label: string): bigint {
  const text = typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? String(value) : value;
  if (typeof text !== 'string' || !/^\d{1,19}$/.test(text)) throw new PaymentRuleError(`${label} is not a non-negative integer`, 502);
  return BigInt(text);
}

/**
 * 공급자가 준 값 중 형식이 정해진 것(상태 · 통화 · id · 리소스 이름 · 추적 id) — 형식에 맞을 때만 그 값, 아니면 ''. 이 값들은 규칙 위반
 * 문장에 들어가 에이전트까지 가므로 자유 글이 섞이지 않게 하고, 형식이 틀린 값은 빈 값으로 읽혀 대조에서 걸린다(닫힌 쪽으로 실패).
 * 사람이 붙인 이름 같은 자유 글은 cleanProviderText 로 정리해 `_untrusted` 로만 싣는다.
 */
export function providerToken(value: unknown, pattern: RegExp): string {
  if (typeof value !== 'string' && typeof value !== 'number') return '';
  const text = String(value).trim();
  return pattern.test(text) ? text : '';
}

/** providerToken 에 쓰는 형식들. */
export const PROVIDER_FORMATS = {
  digits: /^\d{1,30}$/,
  enumName: /^[A-Z][A-Z0-9_]{0,39}$/,
  currency: /^[A-Z]{3}$/,
  /** 공급자의 추적 id(Meta fbtrace_id · Google request-id). */
  traceId: /^[A-Za-z0-9_-]{1,80}$/,
  /** Google 종료 시각("yyyy-MM-dd HH:mm:ss", 고객 시간대). */
  googleDateTime: /^\d{4}-\d{2}-\d{2}(?: \d{2}:\d{2}:\d{2})?$/,
  googleBudget: /^customers\/\d{1,20}\/campaignBudgets\/\d{1,30}$/,
  /** Stripe 객체 id(ic_ · ich_ · req_ …). 접두사는 바뀔 수 있다고 Stripe 가 말하므로 접두사는 보지 않는다. */
  stripeId: /^[A-Za-z0-9_]{1,255}$/,
  /** Stripe 오류 type · code(invalid_request_error · parameter_missing …). */
  stripeCode: /^[a-z][a-z0-9_]{0,59}$/,
} as const;

const INT64_MAX = 9_223_372_036_854_775_807n;

/** AWB 최소 단위 → Meta offset 단위. 나누어떨어지지 않으면 거부(반올림하지 않는다). */
export function minorToMetaUnits(minor: number | bigint, currency: string): bigint {
  const spec = currencySpec(currency);
  const m = BigInt(minor);
  const minorPerUnit = 10n ** BigInt(spec.exponent);
  // Meta 단위 하나 = (10^exponent / offset) 최소 단위. offset 이 더 크면 곱한다.
  if (BigInt(spec.meta_offset) >= minorPerUnit) return m * (BigInt(spec.meta_offset) / minorPerUnit);
  const divisor = minorPerUnit / BigInt(spec.meta_offset);
  if (m % divisor !== 0n) {
    throw new PaymentRuleError(`${formatMinorAmount(Number(m), currency)} cannot be expressed in Meta's ${currency} unit — use a multiple of ${formatMinorAmount(Number(divisor), currency)}`, 400);
  }
  return m / divisor;
}

/** Meta offset 단위 → AWB 최소 단위(정확). */
export function metaUnitsToMinor(units: bigint, currency: string): bigint {
  const spec = currencySpec(currency);
  const minorPerUnit = 10n ** BigInt(spec.exponent);
  if (BigInt(spec.meta_offset) >= minorPerUnit) {
    const per = BigInt(spec.meta_offset) / minorPerUnit;
    if (units % per !== 0n) throw new PaymentRuleError(`Meta amount ${units} ${currency} is finer than the ${currency} minor unit`, 502);
    return units / per;
  }
  return units * (minorPerUnit / BigInt(spec.meta_offset));
}

/** AWB 최소 단위 → Google micros(1 단위 = 1,000,000). */
export function minorToGoogleMicros(minor: number | bigint, currency: string): bigint {
  const spec = currencySpec(currency);
  return BigInt(minor) * 10n ** BigInt(6 - spec.exponent);
}

export function googleMicrosToMinor(micros: bigint, currency: string): bigint {
  const spec = currencySpec(currency);
  const per = 10n ** BigInt(6 - spec.exponent);
  if (micros % per !== 0n) throw new PaymentRuleError(`Google amount ${micros} micros is finer than the ${currency} minor unit`, 502);
  return micros / per;
}

function safeMinor(value: bigint, label: string): number {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 0) throw new PaymentRuleError(`${label} is out of range`, 502);
  return n;
}

// ── 실행 계획 ─────────────────────────────────────────────────────────────

/**
 * 직접 공급자의 실행 계획 — 요청 행의 `payload` 에 그대로 들어가 해시된다. 사람이 승인 화면에서 보는 것이 이것이고,
 * 서버는 이것만 실행한다(대상 · 필드 · from → to). 값은 공급자 단위의 정수 문자열과 AWB 최소 단위를 둘 다 담고,
 * 둘의 변환과 `to − from = 승인 금액` 을 승인 · 실행 때마다 다시 확인한다.
 */
export interface CeilingPlan {
  plan: 'raise_ceiling';
  provider: CeilingProvider;
  target: Record<string, string>;
  /** 공급자 화면에서 사람이 붙인 이름 — 표시용. 에이전트가 볼 때도 데이터일 뿐이다. */
  target_name_untrusted: string;
  field: 'spend_cap' | 'total_amount_micros';
  currency: string;
  from: string;
  to: string;
  from_minor: number;
  to_minor: number;
  /** 요청 때 쓴 credential 내용의 지문(키로 서명한 HMAC) — 그 사이 credential 내용이 바뀌면 실행하지 않는다. */
  credential_fingerprint: string;
  /** Google: 테스트 계정인가(요청 때). 실행 때 다르면 보내지 않는다. */
  test_account?: boolean;
  /** Google: 캠페인 종료 시각(고객 시간대, 표시용). */
  end_date_time?: string;
}

export function buildCeilingPlan(input: {
  provider: CeilingProvider;
  target: Record<string, string>;
  targetName: unknown;
  currency: string;
  fromUnits: bigint;
  amountMinor: number;
  credentialFingerprint: string;
  extra?: Pick<CeilingPlan, 'test_account' | 'end_date_time'>;
}): CeilingPlan {
  const field = input.provider === 'meta_ads' ? 'spend_cap' : 'total_amount_micros';
  const toProvider = (minor: bigint) => (input.provider === 'meta_ads' ? minorToMetaUnits(minor, input.currency) : minorToGoogleMicros(minor, input.currency));
  const fromProvider = (units: bigint) => (input.provider === 'meta_ads' ? metaUnitsToMinor(units, input.currency) : googleMicrosToMinor(units, input.currency));
  const fromMinor = fromProvider(input.fromUnits);
  const toUnits = input.fromUnits + toProvider(BigInt(input.amountMinor));
  if (toUnits > INT64_MAX) throw new PaymentRuleError('the raised ceiling would exceed the provider maximum', 400);
  const toMinor = fromProvider(toUnits);
  const plan: CeilingPlan = {
    plan: 'raise_ceiling',
    provider: input.provider,
    target: { ...input.target },
    target_name_untrusted: cleanProviderText(input.targetName, 120),
    field,
    currency: input.currency,
    from: input.fromUnits.toString(),
    to: toUnits.toString(),
    from_minor: safeMinor(fromMinor, 'current ceiling'),
    to_minor: safeMinor(toMinor, 'new ceiling'),
    credential_fingerprint: input.credentialFingerprint,
    ...(input.extra || {}),
  };
  return plan;
}

/**
 * 카드 공급자의 실행 계획 — 요청 행의 `payload` 에 그대로 들어가 해시된다. 카드 소지자 아래에 누적 한도 `limit_minor` 인 가상 카드를
 * 한 장 만든다. 카드 소지자 이름 같은 개인정보는 넣지 않는다(에이전트도 계획을 읽는다).
 */
export interface CardPlan {
  plan: 'issue_card';
  provider: 'stripe_issuing';
  target: { cardholder: string };
  currency: string;
  /** 누적 한도(최소 단위) = 승인 금액. */
  limit_minor: number;
  interval: 'all_time';
  /** 첫 결제 뒤 자동 해지(lifecycle_controls.cancel_after.payment_count = 1). */
  single_use: boolean;
  /** 허용 업종(정렬) — 비면 업종 제한 없음. */
  allowed_categories: string[];
  /** 운영(true) · 샌드박스(false) — 키와 카드 소지자가 같은 모드여야 한다. */
  livemode: boolean;
  /** 요청 때 쓴 credential 내용의 지문(키로 서명한 HMAC) — 그 사이 credential 내용이 바뀌면 실행하지 않는다. */
  credential_fingerprint: string;
}

export type DirectPlan = CeilingPlan | CardPlan;

export function buildCardPlan(input: {
  target: StripeTarget;
  currency: string;
  amountMinor: number;
  singleUse: boolean;
  categories: string[];
  livemode: boolean;
  credentialFingerprint: string;
}): CardPlan {
  stripeCardAmount(input.amountMinor, input.currency);
  return {
    plan: 'issue_card',
    provider: 'stripe_issuing',
    target: { cardholder: input.target.cardholder },
    currency: input.currency,
    limit_minor: input.amountMinor,
    interval: 'all_time',
    single_use: input.singleUse,
    allowed_categories: normalizeCardCategories(input.categories),
    livemode: input.livemode,
    credential_fingerprint: input.credentialFingerprint,
  };
}

interface PlanRow {
  provider: string;
  payee_ref: string;
  currency: string;
  amount_minor: number;
  payload: unknown;
}

function fingerprintProblem(plan: { credential_fingerprint?: unknown }): string | null {
  return typeof plan.credential_fingerprint !== 'string' || !/^[0-9a-f]{16}$/.test(plan.credential_fingerprint) ? 'plan has no credential fingerprint' : null;
}

function ceilingPlanProblems(row: PlanRow, provider: CeilingProvider): string[] {
  const out: string[] = [];
  const plan = row.payload as Partial<CeilingPlan> | null;
  if (!plan || typeof plan !== 'object' || plan.plan !== 'raise_ceiling') return ['payload is not a ceiling plan built by the server'];
  if (plan.provider !== provider) out.push('plan provider does not match the request');
  if (plan.currency !== row.currency) out.push('plan currency does not match the request');
  let target: DirectTarget | null = null;
  try { target = parseDirectRef(provider, row.payee_ref); } catch (e: any) { out.push(e.message); }
  if (target) {
    for (const [key, value] of Object.entries(target)) {
      if (!plan.target || plan.target[key] !== value) out.push(`plan target ${key} does not match the payee ref`);
    }
  }
  const field = provider === 'meta_ads' ? 'spend_cap' : 'total_amount_micros';
  if (plan.field !== field) out.push(`plan field must be ${field}`);
  const fp = fingerprintProblem(plan);
  if (fp) out.push(fp);
  try {
    const from = parseProviderInt(plan.from, 'plan from');
    const to = parseProviderInt(plan.to, 'plan to');
    const minorOf = (units: bigint) => (provider === 'meta_ads' ? metaUnitsToMinor(units, row.currency) : googleMicrosToMinor(units, row.currency));
    if (to <= from) out.push('plan does not raise the ceiling');
    if (Number(minorOf(from)) !== plan.from_minor || Number(minorOf(to)) !== plan.to_minor) out.push('plan amounts do not convert consistently');
    if (Number(plan.to_minor) - Number(plan.from_minor) !== Number(row.amount_minor)) out.push('plan raise does not equal the requested amount');
  } catch (e: any) {
    out.push(e?.message || 'plan values are invalid');
  }
  return out;
}

function cardPlanProblems(row: PlanRow): string[] {
  const out: string[] = [];
  const plan = row.payload as Partial<CardPlan> | null;
  if (!plan || typeof plan !== 'object' || plan.plan !== 'issue_card') return ['payload is not a card plan built by the server'];
  if (plan.provider !== 'stripe_issuing') out.push('plan provider does not match the request');
  if (plan.currency !== row.currency) out.push('plan currency does not match the request');
  try { stripeCardAmount(row.amount_minor, row.currency); } catch (e: any) { out.push(e.message); }
  let target: StripeTarget | null = null;
  try { target = parseStripeRef(row.payee_ref); } catch (e: any) { out.push(e.message); }
  if (target && plan.target?.cardholder !== target.cardholder) out.push('plan cardholder does not match the payee ref');
  if (!Number.isSafeInteger(plan.limit_minor) || Number(plan.limit_minor) <= 0 || plan.limit_minor !== Number(row.amount_minor)) {
    out.push('plan card limit does not equal the requested amount');
  }
  if (plan.interval !== 'all_time') out.push('plan card limit must be all_time');
  if (typeof plan.single_use !== 'boolean') out.push('plan does not say whether the card is single-use');
  else if (plan.single_use && Number(plan.limit_minor) > STRIPE_SINGLE_USE_MAX_MINOR) out.push('a single-use card cannot carry more than one authorization allows');
  try {
    const categories = Array.isArray(plan.allowed_categories) ? plan.allowed_categories : null;
    if (!categories || normalizeCardCategories(categories).join(',') !== categories.join(',')) out.push('plan card categories are not a sorted list of category names');
  } catch (e: any) {
    out.push(e?.message || 'plan card categories are invalid');
  }
  if (typeof plan.livemode !== 'boolean') out.push('plan does not say live or sandbox');
  const fp = fingerprintProblem(plan);
  if (fp) out.push(fp);
  return out;
}

/**
 * 저장된 계획이 그 요청과 맞는가 — 승인 · 실행 직전에 부른다. 해시가 행 전체를 지키지만, 계획 자체(상한: 단위 변환 · to − from =
 * 금액 · 대상 = 수취인 ref / 카드: 한도 = 금액 · 카드 소지자 = 수취인 ref · 통제의 모양)가 틀린 행은 해시가 맞아도 실행하지 않는다.
 * 문제 목록(비면 통과).
 */
export function directPlanProblems(row: PlanRow): string[] {
  if (!isDirectPaymentProvider(row.provider)) return ['not a direct payment provider'];
  const provider: DirectPaymentProvider = row.provider;
  switch (provider) {
    case 'meta_ads':
    case 'google_ads':
      return ceilingPlanProblems(row, provider);
    case 'stripe_issuing':
      return cardPlanProblems(row);
    default:
      return assertNever(provider);
  }
}

/**
 * 계획이 수취인의 지금 카드 통제와 맞는가 — 승인 · 실행 때. 요청 뒤에 사람이 일회용 · 허용 업종 · 카드당 최대 금액을 바꿨으면 예전
 * 계획은 실행하지 않는다(사람이 바꾼 결정이 이긴다). 상한 공급자는 경로(provider · credential · ref) 대조로 충분하다. 문제가 없으면 null.
 */
export function directPayeeProblem(row: { provider: string; payload: unknown }, payee: PayeeLike): string | null {
  if (row.provider !== 'stripe_issuing') return null;
  const plan = row.payload as Partial<CardPlan> | null;
  if (!plan || plan.plan !== 'issue_card') return null;
  const singleUse = payee.card_single_use !== false;
  let categories: string[];
  try { categories = normalizeCardCategories(payee.card_categories); } catch { return 'the payee\'s card categories are invalid'; }
  if (plan.single_use !== singleUse || (plan.allowed_categories || []).join(',') !== categories.join(',')) {
    return 'the payee\'s card controls (single-use or categories) changed since this request — ask for a new request';
  }
  if (typeof payee.card_max_minor === 'number' && Number(plan.limit_minor) > payee.card_max_minor) {
    return 'the card limit is now above the payee\'s per-card maximum — ask for a new request';
  }
  return null;
}

/**
 * 계획을 사람이 읽는 한 문장으로 — 승인 화면 · 에이전트 응답이 같은 문장을 본다. 공급자 화면의 이름 · 카드 소지자 이름(비신뢰 ·
 * 개인정보)은 넣지 않는다. 직접 공급자가 아니거나 계획이 아니면 ''.
 */
export function describeDirectPlan(row: { provider: string; currency: string; payload: unknown }): string {
  if (!isDirectPaymentProvider(row.provider)) return '';
  const fmt = (n: number) => formatMinorAmount(n, row.currency);
  const provider: DirectPaymentProvider = row.provider;
  switch (provider) {
    case 'meta_ads':
    case 'google_ads': {
      const plan = row.payload as Partial<CeilingPlan> | null;
      if (!plan || plan.plan !== 'raise_ceiling' || !plan.target) return '';
      const from = Number(plan.from_minor);
      const to = Number(plan.to_minor);
      if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to)) return '';
      if (provider === 'meta_ads') {
        return `Meta 광고 계정 act_${plan.target.ad_account_id} 의 캠페인 ${plan.target.campaign_id} 지출 한도(spend_cap)를 ${fmt(from)} → ${fmt(to)} 로 올립니다(+${fmt(to - from)}).`;
      }
      return `Google Ads 고객 ${plan.target.customer_id} 의 캠페인 ${plan.target.campaign_id} 총예산을 ${fmt(from)} → ${fmt(to)} 로 올립니다(+${fmt(to - from)}).`;
    }
    case 'stripe_issuing': {
      const plan = row.payload as Partial<CardPlan> | null;
      if (!plan || plan.plan !== 'issue_card' || !plan.target || !Number.isSafeInteger(plan.limit_minor)) return '';
      const categories = Array.isArray(plan.allowed_categories) && plan.allowed_categories.length
        ? `허용 업종: ${plan.allowed_categories.join(', ')}`
        : '업종 제한 없음';
      const mode = plan.livemode === false ? ' [샌드박스 카드 — 실제 돈은 나가지 않지만 이 예산은 사용으로 셉니다]' : '';
      return `Stripe Issuing 카드 소지자 ${plan.target.cardholder} 에게 누적 한도 ${fmt(Number(plan.limit_minor))} 의 ${plan.single_use ? '일회용(첫 결제 뒤 자동 해지) ' : ''}가상 카드를 발급합니다(${categories}).${mode}`;
    }
    default:
      return assertNever(provider);
  }
}

/**
 * 결제 기록(사람)의 거래 id 자리에 미리 채울 값. 상한 변경에는 거래 id 가 없어 계획에서 만든 기록용 값을, 카드는 실행이 받은 카드 id
 * (`provider_response.card_id`)를 쓴다. 모르면 ''.
 */
export function directSuggestedRef(row: { provider: string; payload: unknown; provider_response?: unknown }): string {
  if (!isDirectPaymentProvider(row.provider)) return '';
  const provider: DirectPaymentProvider = row.provider;
  switch (provider) {
    case 'meta_ads':
    case 'google_ads': {
      const plan = row.payload as Partial<CeilingPlan> | null;
      if (!plan || plan.plan !== 'raise_ceiling' || !plan.target) return '';
      return provider === 'meta_ads'
        ? `meta_ads:act_${plan.target.ad_account_id}/${plan.target.campaign_id}:spend_cap=${plan.to}`
        : `google_ads:${plan.target.budget || `${plan.target.customer_id}/${plan.target.campaign_id}`}:total_amount_micros=${plan.to}`;
    }
    case 'stripe_issuing': {
      const response = row.provider_response && typeof row.provider_response === 'object' ? row.provider_response as Record<string, unknown> : {};
      return providerToken(response.card_id, PROVIDER_FORMATS.stripeId);
    }
    default:
      return assertNever(provider);
  }
}

// ── 문자열 ────────────────────────────────────────────────────────────────

/**
 * 공급자가 준 글(캠페인 이름 · 오류 메시지)을 저장 · 표시하기 전에: 제어 문자 · 방향 바꾸기 문자(U+202A–E, U+2066–9) ·
 * 폭 없는 문자를 지우고, 줄바꿈을 공백으로 접고, 길이를 자른다.
 */
export function cleanProviderText(value: unknown, max = 300): string {
  if (typeof value !== 'string') return '';
  return value
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060-\u2069\ufeff]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

/** 비밀 값(6자 이상)이 글에 섞여 있으면 지운다 — 온전한 값만 찾으므로 글을 자르기 전에 부른다(providerMessage). */
export function scrubSecrets(text: string, secrets: Array<string | undefined | null>): string {
  let out = text;
  for (const secret of secrets) {
    if (typeof secret === 'string' && secret.length >= 6) out = out.split(secret).join('[redacted]');
  }
  return out;
}

/**
 * 공급자가 준 글(오류 메시지)을 저장 · 표시할 수 있게 — 비밀 값을 **먼저** 지우고 정리 · 자른다. 자른 뒤에 지우면 경계에 걸린 비밀
 * 값의 앞부분이 남는다. 이 글은 `*_untrusted` 로 응답 요약 · 감사에 남고, 응답 요약은 에이전트도 읽는다.
 */
export function providerMessage(value: unknown, secrets: Array<string | undefined | null>, max = 300): string {
  if (typeof value !== 'string') return '';
  // 공급자가 가려서 되돌려 주는 키 조각(예: Stripe 의 "sk_live_****1234")도 지운다.
  return cleanProviderText(scrubSecrets(value, secrets).replace(/\b(?:sk|rk|pk)_(?:live|test)_[*A-Za-z0-9]+/g, '[redacted]'), max);
}

