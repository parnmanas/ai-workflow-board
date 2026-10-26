import { getLocaleTag } from '../../i18n/core';
import { t as translate } from '../../i18n/core';
// Marketing 화면의 순수 규칙(docs/marketing.md) — React · DOM 없음. test/marketing-*.test.mjs 가
// 직접 import 한다. 서버가 정본이고(검증 · 집행 · 한도) 여기의 판정은 사람이 보내기 전에 미리
// 알려 주는 용도다. 금액 표기는 서버 `common/marketing/money.ts` 의 formatMinorAmount 와 같은 모양을
// 낸다 — 지시문 · 감사 요약 · 화면이 같은 글자를 보게.

import type { ActivityTone } from '../../activity';
import type {
  Credential,
  MarketingAllocation,
  MarketingCampaign,
  MarketingCampaignInput,
  MarketingCampaignStatus,
  MarketingCapability,
  MarketingChannel,
  MarketingChannelApproval,
  MarketingChannelKind,
  MarketingEmailConfig,
  MarketingDirectPaymentProvider,
  MarketingLimitKey,
  MarketingPayee,
  MarketingPost,
  MarketingSpendInspection,
  MarketingSpendRequest,
} from '../../types';
import { isEmailAddress, normalizeListName } from './marketingContacts.logic';

// ── 금액 ────────────────────────────────────────────────────────────────────

/** 서버 MAX_MINOR_AMOUNT 와 같다 — 원장 수천 행을 더해도 2^53 을 넘지 않는 상한. */
export const MAX_MINOR_AMOUNT = 9_000_000_000_000;

/** ISO 4217 지수가 0 인 통화(최소 단위 = 1 단위). 서버 money.ts 와 같은 목록. */
const ZERO_DECIMAL_CURRENCIES = new Set([
  'BIF', 'CLP', 'DJF', 'GNF', 'ISK', 'JPY', 'KMF', 'KRW', 'PYG', 'RWF', 'UGX', 'UYI', 'VND', 'VUV', 'XAF', 'XOF', 'XPF',
]);
/** ISO 4217 지수가 3 인 통화. */
const THREE_DECIMAL_CURRENCIES = new Set(['BHD', 'IQD', 'JOD', 'KWD', 'LYD', 'OMR', 'TND']);

export function normalizeCurrencyCode(value: string): string {
  return (value || '').trim().toUpperCase();
}

export function isCurrencyCode(value: string): boolean {
  return /^[A-Z]{3}$/.test(normalizeCurrencyCode(value));
}

export function currencyExponent(currency: string): number {
  const code = normalizeCurrencyCode(currency);
  if (ZERO_DECIMAL_CURRENCIES.has(code)) return 0;
  if (THREE_DECIMAL_CURRENCIES.has(code)) return 3;
  return 2;
}

function splitMinor(amount: number, currency: string): { negative: boolean; whole: number; frac: string } {
  const n = Math.round(Number(amount));
  const exp = currencyExponent(currency);
  const abs = Math.abs(n);
  const unit = 10 ** exp;
  return {
    negative: n < 0,
    whole: Math.floor(abs / unit),
    frac: exp > 0 ? String(abs % unit).padStart(exp, '0') : '',
  };
}

/**
 * 정수 최소 단위 → 사람이 읽는 금액. `50000, 'KRW'` → `50,000 KRW`, `1250, 'USD'` → `12.50 USD`.
 * 비율에서 나온 소수(CPC 등)는 반올림한다. 값이 없으면 '—'.
 */
export function formatMinor(amount: number | null | undefined, currency: string): string {
  if (amount === null || amount === undefined || !Number.isFinite(Number(amount))) return '—';
  const { negative, whole, frac } = splitMinor(Number(amount), currency);
  return `${negative ? '-' : ''}${whole.toLocaleString(getLocaleTag())}${frac ? `.${frac}` : ''} ${normalizeCurrencyCode(currency)}`;
}

/** 입력칸을 채울 때 — 구분 쉼표 없는 major 단위 글자(`1250, 'USD'` → `12.50`). */
export function minorToMajorInput(amount: number | null | undefined, currency: string): string {
  if (amount === null || amount === undefined || !Number.isFinite(Number(amount))) return '';
  const { negative, whole, frac } = splitMinor(Number(amount), currency);
  return `${negative ? '-' : ''}${whole}${frac ? `.${frac}` : ''}`;
}

export type MoneyParse = { ok: true; minor: number } | { ok: false; error: string };

/**
 * 사람이 친 major 단위 금액(`12.50`, `12,500`) → 정수 최소 단위. 부동소수 계산을 하지 않는다 —
 * 글자 그대로 자릿수를 이어 붙여 0.1 + 0.2 같은 오차가 한도 비교에 섞이지 않게 한다.
 * 통화가 허용하는 것보다 소수 자리가 많으면 거부한다(반올림해서 다른 금액을 보내지 않는다).
 * 쉼표는 세 자리 구분으로만 받는다 — `12,50` 을 1250 으로 읽는 일이 없게.
 */
export function parseMajorToMinor(
  input: string,
  currency: string,
  opts: { allowZero?: boolean } = {},
): MoneyParse {
  const code = normalizeCurrencyCode(currency);
  const raw = String(input ?? '').trim();
  if (!raw) return { ok: false, error: translate('금액을 입력하세요') };
  if (raw.startsWith('-')) return { ok: false, error: translate('음수 금액은 쓸 수 없습니다') };
  let text = raw;
  if (text.includes(',')) {
    if (!/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(text)) {
      return { ok: false, error: translate('쉼표는 세 자리 구분에만 쓸 수 있습니다 (예: 12,500)') };
    }
    text = text.replace(/,/g, '');
  }
  const m = /^(\d+)(?:\.(\d+))?$/.exec(text);
  if (!m) return { ok: false, error: translate('숫자로 입력하세요 (예: 12500 또는 12.50)') };
  const exp = currencyExponent(code);
  const fraction = m[2] || '';
  if (fraction.length > exp) {
    return {
      ok: false,
      error: exp === 0
        ? translate('{0} 는 소수점 아래 금액이 없습니다', { 0: code })
        : translate('{0} 는 소수점 아래 {1}자리까지만 쓸 수 있습니다', { 0: code, 1: exp }),
    };
  }
  const digits = `${m[1]}${fraction.padEnd(exp, '0')}`.replace(/^0+(?=\d)/, '');
  if (digits.length > 16) return { ok: false, error: translate('금액이 너무 큽니다 (최대 {0})', { 0: formatMinor(MAX_MINOR_AMOUNT, code) }) };
  const minor = Number(digits);
  if (!Number.isSafeInteger(minor) || minor > MAX_MINOR_AMOUNT) {
    return { ok: false, error: translate('금액이 너무 큽니다 (최대 {0})', { 0: formatMinor(MAX_MINOR_AMOUNT, code) }) };
  }
  if (minor === 0 && !opts.allowZero) return { ok: false, error: translate('0보다 큰 금액을 입력하세요') };
  return { ok: true, minor };
}

/** 지출 요청 payload 해시의 앞 12자 — 승인 화면이 "무엇을 승인하는지" 를 짧게 보여 준다. */
export function shortHash(sha: string | null | undefined): string {
  return (sha || '').slice(0, 12);
}

// ── 기능 · 플랫폼 · 라벨 ─────────────────────────────────────────────────────

export const MARKETING_CAPABILITIES: MarketingCapability[] = [
  'channel_discovery',
  'community_post',
  'email',
  'feedback_collect',
  'feedback_to_product',
  'analytics',
  'paid_spend',
];

export const CAPABILITY_LABELS: Record<MarketingCapability, string> = {
  get channel_discovery() { return translate('채널 탐색'); },
  get community_post() { return translate('커뮤니티 게시'); },
  get email() { return translate('메일 발송'); },
  get feedback_collect() { return translate('피드백 수집'); },
  get feedback_to_product() { return translate('피드백 → 제품 개선'); },
  get analytics() { return translate('채널별 성과 분석'); },
  get paid_spend() { return translate('예산 집행 · 결제'); },
};

export const CAPABILITY_DESCRIPTIONS: Record<MarketingCapability, string> = {
  get channel_discovery() { return translate('에이전트가 근거와 함께 채널 후보를 제안합니다. 여는 것은 사람입니다.'); },
  get community_post() { return translate('커뮤니티 게시글 · 댓글 초안을 씁니다. 승인해야 나갑니다.'); },
  get email() { return translate('동의한 연락처에게 보낼 메일 초안을 씁니다. 승인해야 발송됩니다.'); },
  get feedback_collect() { return translate('반응 · 언급을 피드백으로 기록하고, 연결된 채널의 수집 결과를 봅니다.'); },
  get feedback_to_product() { return translate('버그 · 기능 요청 피드백을 제품 Project 의 티켓으로 만듭니다.'); },
  get analytics() { return translate('추적 링크 · 지표 기록 · 채널별 성과 리포트를 씁니다.'); },
  get paid_spend() { return translate('예산 편성을 제안하고 지출을 요청합니다. 돈은 승인자가 정합니다.'); },
};

export function capabilityLabel(key: string): string {
  return (CAPABILITY_LABELS as Record<string, string>)[key] || key;
}

/** 서버 CHANNEL_PLATFORMS 와 같은 순서. */
export const CHANNEL_PLATFORMS = [
  'reddit', 'github', 'hacker_news', 'product_hunt', 'x', 'linkedin', 'discord', 'slack', 'forum',
  'blog', 'newsletter', 'youtube', 'email', 'other',
] as const;

const PLATFORM_LABELS: Record<string, string> = {
  reddit: 'Reddit',
  github: 'GitHub',
  get hacker_news() { return translate('Hacker News'); },
  get product_hunt() { return translate('Product Hunt'); },
  x: 'X',
  linkedin: 'LinkedIn',
  get discord() { return translate('Discord'); },
  get slack() { return translate('Slack'); },
  get forum() { return translate('포럼'); },
  get blog() { return translate('블로그'); },
  get newsletter() { return translate('뉴스레터'); },
  youtube: 'YouTube',
  get email() { return translate('메일'); },
  get other() { return translate('기타'); },
};

export function platformLabel(platform: string): string {
  return PLATFORM_LABELS[platform] || platform;
}

export const CHANNEL_KIND_LABELS: Record<MarketingChannelKind, string> = {
  get outreach() { return translate('자동 게시(Outreach 커넥터)'); },
  get email() { return translate('메일 발송'); },
  get manual() { return translate('수동 게시'); },
};

/**
 * 승인할 때 고를 수 있는 방식 — 서버 MarketingChannelService.configure 와 같은 규칙.
 * reddit · github 만 커넥터가 있고, email · newsletter 만 메일을 보낼 수 있다. 무엇이든 수동은 된다.
 * 첫 항목(미리 골라 두는 것)은 서버 defaultKindFor 와 같다 — newsletter 는 남의 뉴스레터(수동 게재)가 기본이고,
 * 우리 목록으로 보내는 메일은 사람이 골라야 한다.
 */
export function approvalModesFor(platform: string): MarketingChannelKind[] {
  if (platform === 'reddit' || platform === 'github') return ['outreach', 'manual'];
  if (platform === 'email') return ['email', 'manual'];
  if (platform === 'newsletter') return ['manual', 'email'];
  return ['manual'];
}

/** 서버 normalizeChannelTarget 과 같은 키 — OutreachChannel.targets 와 비교할 때. */
export function channelTargetKey(platform: string, target: string): string {
  const t = (target || '').trim();
  if (platform === 'reddit') return t.replace(/^\/?r\//i, '').toLowerCase();
  return t.toLowerCase();
}

// ── 채널 승인 본문 ──────────────────────────────────────────────────────────

/** 메일 채널 설정 입력칸. 서버 normalizeEmailChannelConfig 와 같은 필수 항목(법정 표기)을 미리 본다. */
export interface EmailConfigDraft {
  brand_id: string;
  credential_id: string;
  from_name: string;
  from_address: string;
  reply_to: string;
  postal_address: string;
  contact_email: string;
  list_name: string;
  ad_label: string;
}

export const DEFAULT_EMAIL_AD_LABEL = '(광고)';

export function emailDraftFrom(config: Partial<MarketingEmailConfig> | null | undefined): EmailConfigDraft {
  return {
    brand_id: config?.brand_id || '',
    credential_id: config?.credential_id || '',
    from_name: config?.from_name || '',
    from_address: config?.from_address || '',
    reply_to: config?.reply_to || '',
    postal_address: config?.postal_address || '',
    contact_email: config?.contact_email || '',
    list_name: config?.list_name || '',
    ad_label: config?.ad_label || DEFAULT_EMAIL_AD_LABEL,
  };
}

/** 틀린 첫 항목의 설명, 없으면 null. */
export function validateEmailDraft(d: EmailConfigDraft): string | null {
  if (!d.credential_id) return translate('메일 credential 을 고르세요 (provider = resend | sendgrid, api_key 필드)');
  if (!d.brand_id) return translate('동의를 받은 발신자 브랜드를 고르세요');
  if (!d.from_name.trim()) return translate('발신자 이름은 법정 표기라 비울 수 없습니다');
  if (!isEmailAddress(d.from_address.trim())) return translate('발신 주소가 메일 주소가 아닙니다');
  if (d.reply_to.trim() && !isEmailAddress(d.reply_to.trim())) return translate('회신 주소가 메일 주소가 아닙니다');
  if (d.contact_email.trim() && !isEmailAddress(d.contact_email.trim())) return translate('연락처 메일이 메일 주소가 아닙니다');
  if (!d.postal_address.trim()) return translate('발신자 주소(우편)는 법정 표기라 비울 수 없습니다');
  if (!d.list_name.trim()) return translate('이 채널의 메일을 받을 수신 목록 이름을 적으세요');
  if (!normalizeListName(d.list_name)) return translate('수신 목록 이름은 영문 소문자 · 숫자 · 공백 · _ . - 만 쓸 수 있습니다');
  if (d.ad_label.trim().length > 30) return translate('광고 표기는 30자까지입니다');
  return null;
}

export function emailConfigBody(d: EmailConfigDraft): Partial<MarketingEmailConfig> {
  return {
    brand_id: d.brand_id,
    credential_id: d.credential_id,
    from_name: d.from_name.trim(),
    from_address: d.from_address.trim(),
    reply_to: d.reply_to.trim(),
    postal_address: d.postal_address.trim(),
    contact_email: d.contact_email.trim(),
    list_name: normalizeListName(d.list_name) || d.list_name.trim(),
    ad_label: d.ad_label.trim() || DEFAULT_EMAIL_AD_LABEL,
  };
}

export type OutreachChoice = 'existing' | 'create' | 'later';

export interface ChannelApprovalDraft {
  kind: MarketingChannelKind;
  outreachChoice: OutreachChoice;
  outreachChannelId: string;
  credentialId: string;
  rateLimitPerHour: string;
  collectFeedback: boolean;
  email: EmailConfigDraft;
  note: string;
}

/**
 * 승인(또는 awaiting_credential 의 연결) 본문. `connect` 면 연결할 것이 반드시 있어야 한다 —
 * "나중에 연결" 은 처음 승인할 때만 고를 수 있다.
 */
export function buildChannelApproval(
  draft: ChannelApprovalDraft,
  opts: { connect?: boolean } = {},
): { ok: true; body: MarketingChannelApproval } | { ok: false; error: string } {
  const note = draft.note.trim();
  const withNote = (body: MarketingChannelApproval): MarketingChannelApproval => (note ? { ...body, note } : body);
  if (draft.kind === 'manual') {
    if (opts.connect) return { ok: false, error: translate('연결은 Outreach 채널로만 합니다') };
    return { ok: true, body: withNote({ mode: 'manual' }) };
  }
  if (draft.kind === 'email') {
    if (opts.connect) return { ok: false, error: translate('연결은 Outreach 채널로만 합니다') };
    const error = validateEmailDraft(draft.email);
    if (error) return { ok: false, error };
    return { ok: true, body: withNote({ mode: 'email', email: emailConfigBody(draft.email) }) };
  }
  if (draft.outreachChoice === 'existing') {
    if (!draft.outreachChannelId) return { ok: false, error: translate('연결할 Outreach 채널을 고르세요') };
    return { ok: true, body: withNote({ mode: 'outreach', outreach_channel_id: draft.outreachChannelId }) };
  }
  if (draft.outreachChoice === 'create') {
    if (!draft.credentialId) return { ok: false, error: translate('게시에 쓸 credential 을 고르세요') };
    const rate = draft.rateLimitPerHour.trim();
    if (!/^\d+$/.test(rate) || Number(rate) < 1 || Number(rate) > 1000) {
      return { ok: false, error: translate('시간당 게시 상한은 1 이상의 정수여야 합니다') };
    }
    return {
      ok: true,
      body: withNote({
        mode: 'outreach',
        create_outreach: { credential_id: draft.credentialId, rate_limit_per_hour: Number(rate), collect_feedback: draft.collectFeedback },
      }),
    };
  }
  if (opts.connect) return { ok: false, error: translate('연결할 Outreach 채널이나 credential 을 고르세요') };
  return { ok: true, body: withNote({ mode: 'outreach' }) };
}

export const LIMIT_KEYS: MarketingLimitKey[] = [
  'drafts_per_day',
  'spend_requests_per_day',
  'allocation_proposals_per_day',
  'links_per_day',
  'channel_proposals_per_day',
  'feedback_per_day',
  'metrics_per_day',
  'feedback_tickets_per_day',
  'open_feedback_tickets',
];

export const LIMIT_LABELS: Record<MarketingLimitKey, string> = {
  get drafts_per_day() { return translate('초안 / 24시간'); },
  get spend_requests_per_day() { return translate('지출 요청 / 24시간'); },
  get allocation_proposals_per_day() { return translate('편성 제안 / 24시간'); },
  get links_per_day() { return translate('추적 링크 / 24시간'); },
  get channel_proposals_per_day() { return translate('채널 제안 / 24시간'); },
  get feedback_per_day() { return translate('피드백 기록 / 24시간'); },
  get metrics_per_day() { return translate('지표 기록 / 24시간'); },
  get feedback_tickets_per_day() { return translate('피드백 티켓 / 24시간'); },
  get open_feedback_tickets() { return translate('열린 피드백 티켓 상한'); },
};

/** 서버 DEFAULT_MARKETING_LIMITS — 입력칸의 "기본값" 안내용. 정본은 캠페인 응답의 `limits`. */
export const DEFAULT_LIMITS: Record<MarketingLimitKey, number> = {
  drafts_per_day: 20,
  spend_requests_per_day: 5,
  allocation_proposals_per_day: 3,
  links_per_day: 50,
  channel_proposals_per_day: 10,
  feedback_per_day: 100,
  metrics_per_day: 500,
  feedback_tickets_per_day: 3,
  open_feedback_tickets: 10,
};

/** 사람이 기록할 수 있는 지표 — clicks 는 추적 링크에서만 온다. */
export const RECORDABLE_METRICS = [
  'impressions', 'views', 'engagements', 'replies', 'signups', 'conversions', 'revenue_minor', 'followers', 'subscribers',
] as const;

export const METRIC_LABELS: Record<string, string> = {
  get clicks() { return translate('클릭(raw)'); },
  get impressions() { return translate('노출'); },
  get views() { return translate('조회'); },
  get engagements() { return translate('참여'); },
  get replies() { return translate('답글'); },
  get signups() { return translate('가입'); },
  get conversions() { return translate('전환'); },
  get revenue_minor() { return translate('매출(최소 단위)'); },
  get followers() { return translate('팔로워'); },
  get subscribers() { return translate('구독자'); },
};

export const FEEDBACK_CATEGORIES = ['bug', 'feature_request', 'question', 'praise', 'complaint', 'other'] as const;
export const FEEDBACK_CATEGORY_LABELS: Record<string, string> = {
  get bug() { return translate('버그'); },
  get feature_request() { return translate('기능 요청'); },
  get question() { return translate('질문'); },
  get praise() { return translate('칭찬'); },
  get complaint() { return translate('불만'); },
  get other() { return translate('기타'); },
};
/** 기록하면 제품 티켓이 되는 분류(feedback_to_product 가 켜져 있을 때). */
export const TICKETABLE_CATEGORIES = ['bug', 'feature_request'];

export const FEEDBACK_SENTIMENTS = ['positive', 'neutral', 'negative'] as const;
export const SENTIMENT_LABELS: Record<string, string> = { get positive() { return translate('긍정'); }, get neutral() { return translate('중립'); }, get negative() { return translate('부정'); } };

export const BUDGET_PERIOD_LABELS: Record<string, string> = {
  get none() { return translate('기간 상한 없음'); },
  get week() { return translate('주 단위(UTC, 월요일 시작)'); },
  get month() { return translate('월 단위(UTC)'); },
};

export const PAYMENT_PROVIDER_LABELS: Record<string, string> = {
  get manual() { return translate('수동 — AWB 밖에서 결제하고 결과를 기록'); },
  get webhook() { return translate('웹훅 — 승인하면 서버가 결제 엔드포인트로 보냄'); },
  get meta_ads() { return translate('Meta Ads — 승인하면 서버가 광고 캠페인 지출 한도(spend_cap)를 올림'); },
  get google_ads() { return translate('Google Ads — 승인하면 서버가 캠페인 총예산을 올림'); },
  get stripe_issuing() { return translate('Stripe Issuing — 승인하면 서버가 승인 금액이 한도인 가상 카드를 만듦'); },
};

// ── 직접 결제 공급자(docs/marketing.md "직접 결제 어댑터") ─────────────────────
// 서버 common/marketing/payment-routes.ts 가 정본이다 — 목록 · ref 형식 · credential 필드가 같아야 한다
// (test/marketing-payment-contract.test.mjs 가 두 파일을 대조한다).

export const DIRECT_PAYMENT_PROVIDERS: readonly MarketingDirectPaymentProvider[] = ['meta_ads', 'google_ads', 'stripe_issuing'];

export const DIRECT_PAYMENT_PROVIDER_LABELS: Record<MarketingDirectPaymentProvider, string> = {
  meta_ads: 'Meta Ads',
  google_ads: 'Google Ads',
  stripe_issuing: 'Stripe Issuing',
};

/** 공급자 명세 — 상한(광고 캠페인의 고정 상한을 올린다)과 카드(그 한도의 가상 카드를 만든다). 상한만 대상마다 열린 요청이 하나다. */
export const DIRECT_PROVIDER_SPECS: Readonly<Record<MarketingDirectPaymentProvider, { kind: 'ceiling' | 'card'; exclusive: boolean }>> = {
  meta_ads: { kind: 'ceiling', exclusive: true },
  google_ads: { kind: 'ceiling', exclusive: true },
  stripe_issuing: { kind: 'card', exclusive: false },
};

export const DIRECT_REF_FORMATS: Record<MarketingDirectPaymentProvider, string> = {
  get meta_ads() { return translate('act_<광고 계정 id>/<캠페인 id> (예: act_1234567890/120210000000000)'); },
  get google_ads() { return translate('<고객 id>/<캠페인 id> (예: 123-456-7890/22334455)'); },
  get stripe_issuing() { return translate('카드 소지자 id ich_… (예: ich_1MsKAB2eZvKYlo2C)'); },
};

/** 직접 공급자 credential 의 필드 — Credentials 화면에서 이 공급자를 골라 만든다. */
export const DIRECT_PROVIDER_CREDENTIAL_FIELDS: Record<MarketingDirectPaymentProvider, { required: readonly string[]; optional: readonly string[]; required_one_of?: readonly (readonly string[])[] }> = {
  meta_ads: { required: ['access_token'], optional: ['app_secret'] },
  google_ads: { required: [], optional: ['client_id', 'client_secret', 'refresh_token', 'client_email', 'private_key', 'login_customer_id', 'developer_token'], required_one_of: [['client_id', 'client_secret', 'refresh_token'], ['client_email', 'private_key']] },
  stripe_issuing: { required: ['secret_key'], optional: [] },
};

/** Alternative authentication groups are required as a set, not individually optional. */
export function directCredentialFieldsHint(provider: MarketingDirectPaymentProvider): string {
  const fields = DIRECT_PROVIDER_CREDENTIAL_FIELDS[provider];
  const alternatives = fields.required_one_of || [];
  const conditional = new Set(alternatives.flat());
  return [
    ...fields.required,
    ...(alternatives.length ? [alternatives.map((group) => group.join(' + ')).join(translate(' 또는 ')) + translate('(한 방식 필수)')] : []),
    ...fields.optional.filter((field) => !conditional.has(field)).map((field) => field + translate('(선택)')),
  ].join(', ');
}

/** 수취인 편집기의 결제 경로 고르기 — 무엇을 하는 경로인지 함께. */
export function directRouteOptionLabel(provider: MarketingDirectPaymentProvider): string {
  return `${DIRECT_PAYMENT_PROVIDER_LABELS[provider]} — ${DIRECT_PROVIDER_SPECS[provider].kind === 'card' ? translate('승인 금액 한도의 가상 카드 발급') : translate('광고 캠페인 상한 올리기')}`;
}

/** Stripe 일회용 카드 한 장의 최대(서버 STRIPE_SINGLE_USE_MAX_MINOR 와 같다 — 승인 한 건의 고정 상한). */
export const STRIPE_SINGLE_USE_MAX_MINOR = 1_000_000;

/** 셀프 서비스 Standard 프로그램의 카드당 하루 한도(500.00) — 그 이상인 일회용 카드는 첫 결제가 거절될 수 있다. */
export const STRIPE_STANDARD_CARD_DAILY_MINOR = 50_000;

const CARD_CATEGORY_PATTERN = /^[a-z][a-z0-9_]{1,79}$/;

/**
 * 허용 업종 입력(쉼표로 구분)을 저장 형태로 — 소문자 · 중복 없이 정렬. 서버 normalizeCardCategories 와 같은 규칙이다(서버가 다시 본다).
 * 형식이 틀린 이름이 있으면 problem 에 담는다.
 */
export function parseCardCategories(input: string): { categories: string[]; problem: string } {
  const out = new Set<string>();
  for (const raw of input.split(',')) {
    const name = raw.trim().toLowerCase();
    if (!name) continue;
    if (!CARD_CATEGORY_PATTERN.test(name)) return { categories: [], problem: translate('"{0}" 는 Stripe 업종 이름 형식이 아닙니다(소문자와 _ — 예: advertising_services)', { 0: raw.trim() }) };
    out.add(name);
  }
  if (out.size > 20) return { categories: [], problem: translate('허용 업종은 20개까지입니다') };
  return { categories: [...out].sort(), problem: '' };
}

/** 수취인의 카드 통제 한 줄(목록 표시용). 카드 공급자가 아니면 ''. */
export function cardControlsLabel(payee: MarketingPayee, currency: string): string {
  if (!isDirectPaymentProvider(payee.provider) || DIRECT_PROVIDER_SPECS[payee.provider].kind !== 'card') return '';
  const parts = [payee.card_single_use === false ? translate('여러 번 쓰는 카드') : translate('일회용')];
  if (payee.card_id) parts.push(payee.card_id);
  parts.push(payee.card_categories?.length ? translate('업종 {0}', { 0: payee.card_categories.join(', ') }) : translate('업종 제한 없음'));
  if (typeof payee.card_max_minor === 'number') parts.push(translate('카드당 최대 {0}', { 0: formatMinor(payee.card_max_minor, currency) }));
  return parts.join(' · ');
}

export function isDirectPaymentProvider(value: unknown): value is MarketingDirectPaymentProvider {
  return typeof value === 'string' && (DIRECT_PAYMENT_PROVIDERS as readonly string[]).includes(value);
}

const DIRECT_REF_PATTERNS: Record<MarketingDirectPaymentProvider, RegExp> = {
  meta_ads: /^act_\d{1,30}\s*\/\s*\d{1,30}$/,
  google_ads: /^\d{3}-?\d{3}-?\d{4}\s*\/\s*\d{1,30}$/,
  stripe_issuing: /^ich_[A-Za-z0-9]{1,250}$/,
};

/** 수취인 ref 가 그 공급자의 대상 형식인가 — 저장 전에 화면이 먼저 알려 준다(서버가 다시 본다). 문제 없으면 ''. */
export function directRefProblem(provider: MarketingDirectPaymentProvider, ref: string): string {
  return DIRECT_REF_PATTERNS[provider].test(ref.trim()) ? '' : translate('{0} 대상은 {1} 형식입니다', { 0: DIRECT_PAYMENT_PROVIDER_LABELS[provider], 1: DIRECT_REF_FORMATS[provider] });
}

/**
 * 직접 공급자 수취인이 고를 수 있는 credential — 그 공급자로 만든, 이 계정의 credential 만(전역 · 에이전트 노출 제외).
 * 서버 resolveDirectPaymentCredential 과 같은 기준이다.
 */
export function directPaymentCredentials(credentials: Credential[], provider: MarketingDirectPaymentProvider, accountId: string): Credential[] {
  return credentials.filter((c) => c.provider === provider && !c.agent_env && !!c.account_id && c.account_id === accountId);
}

/** 수취인 목록 한 줄의 결제 경로 — 직접 공급자면 그 이름과 대상, 아니면 ''(캠페인 결제 방식). */
export function payeeRouteLabel(payee: MarketingPayee): string {
  return isDirectPaymentProvider(payee.provider) ? `${DIRECT_PAYMENT_PROVIDER_LABELS[payee.provider]} · ${payee.ref || '?'}` : '';
}

/** 지출 카드의 상태 표시 — 직접 공급자의 paid 는 돈이 나간 것이 아니라 "한도가 올라갔다" · "카드가 발급됐다" 이다. */
export function spendStatusViewFor(spend: Pick<MarketingSpendRequest, 'status' | 'provider'> & Partial<Pick<MarketingSpendRequest, 'payload'>>): StatusView {
  if (isDirectPaymentProvider(spend.provider)) {
    const card = DIRECT_PROVIDER_SPECS[spend.provider].kind === 'card' && !spend.payload?.card_id;
    if (spend.status === 'paid') return { label: card ? translate('카드 발급됨') : translate('한도 반영됨'), tone: 'done' };
    if (spend.status === 'executing') return { label: card ? translate('카드 발급 중') : translate('한도 변경 중'), tone: 'live' };
  }
  return spendStatusView(spend.status);
}

/** 승인 확인 창의 안내 — 이 결제 경로에서 승인하면 무엇이 일어나는가. */
export function spendApproveHint(spend: Pick<MarketingSpendRequest, 'provider'> & Partial<Pick<MarketingSpendRequest, 'payload'>>): string {
  if (spend.provider === 'meta_ads') {
    return translate('승인하면 서버가 곧바로 Meta 광고 캠페인의 지출 한도(spend_cap)를 위 계획대로 바꿉니다. 그 사이 한도가 바뀌었으면 보내지 않습니다. 자동 재시도는 없습니다. 올린 만큼 광고비가 쓰일 수 있습니다.');
  }
  if (spend.provider === 'google_ads') {
    return translate('승인하면 서버가 곧바로 Google Ads 캠페인의 총예산을 위 계획대로 바꿉니다. 그 사이 예산이 바뀌었으면 보내지 않습니다. 자동 재시도는 없습니다. 올린 만큼 광고비가 쓰일 수 있습니다.');
  }
  if (spend.provider === 'stripe_issuing') {
    if (spend.payload?.card_id) return translate('승인하면 같은 Stripe 카드의 누적 한도를 위 계획대로 올립니다. 실행 직전 한도가 달라졌으면 보내지 않습니다. 결과가 불분명하면 결과 불명으로 남습니다. 승인 금액 전체를 사용으로 셉니다.');
    return translate('승인하면 서버가 곧바로 위 계획대로 Stripe Issuing 가상 카드를 만듭니다(비활성으로 만들어 계획과 대조한 뒤 활성화). 카드 번호는 Stripe 대시보드에서 봅니다. 자동 재시도는 없습니다. 이 금액은 사용으로 셉니다.');
  }
  if (spend.provider === 'webhook') return translate('승인하면 서버가 곧바로 결제 엔드포인트로 이 내용을 보냅니다. 자동 재시도는 없습니다.');
  return translate('승인하면 이 금액이 예산에서 보류됩니다. AWB 밖에서 결제한 뒤 거래 id 와 함께 결제 완료를 기록하세요.');
}

/**
 * 승인 전에 알릴 카드 한도 주의 — 일회용 Stripe 카드가 셀프 서비스 Standard 프로그램의 카드당 하루 한도(500.00)를 넘으면 첫 결제가
 * 거절될 수 있고, 그래도 승인 금액 전체가 사용으로 묶인다. 해당 없으면 ''.
 */
export function cardLimitWarning(spend: Pick<MarketingSpendRequest, 'provider' | 'payload' | 'currency'>): string {
  if (spend.provider !== 'stripe_issuing') return '';
  const plan = spend.payload || {};
  if (plan.single_use !== true || typeof plan.limit_minor !== 'number' || plan.limit_minor <= STRIPE_STANDARD_CARD_DAILY_MINOR) return '';
  // Stripe 가 밝힌 한도는 USD 다 — 다른 통화 카드에는 같은 숫자를 근사로 쓴다.
  const daily = spend.currency === 'USD' ? translate('500 USD 라') : translate('500 USD 상당이라');
  return translate('일회용 카드의 한도가 {0} 를 넘습니다 — 셀프 서비스 Standard 프로그램은 카드당 하루 {1} 첫 결제가 거절될 수 있고, 그래도 이 금액 전체가 사용으로 묶입니다. 프로그램 한도를 확인하세요.', { 0: formatMinor(STRIPE_STANDARD_CARD_DAILY_MINOR, spend.currency), 1: daily });
}

/**
 * 직접 결제의 결과 불명은 실행 뒤 이만큼 지나야 "실패" 로 기록할 수 있다 — 공급자 반영이 늦을 수 있어서. 서버
 * common/marketing/payment-routes.ts 의 DIRECT_FAIL_GRACE_MS 가 정본이다(test/marketing-payment-contract.test.mjs 가 대조한다).
 */
export const DIRECT_FAIL_GRACE_MS = 15 * 60_000;

/**
 * 결과 불명을 대조할 곳 — 공급자마다 무엇을 보면 되는지. 금액은 광고 화면이 보여 주는 통화 표기로(공급자 단위 정수는 센트인지
 * 원 단위인지 헷갈린다). 실패 기록은 실행 뒤 DIRECT_FAIL_GRACE_MS 가 지나야 받으므로 그 시각을 함께 알린다.
 */
export function unknownReconcileHint(spend: Pick<MarketingSpendRequest, 'provider' | 'payload' | 'currency' | 'executing_at'>): string {
  const plan = spend.payload || {};
  const money = (minor: unknown) => (typeof minor === 'number' && Number.isFinite(minor) ? formatMinor(minor, spend.currency) : '?');
  const campaignId = plan.target?.campaign_id || '';
  const minutes = DIRECT_FAIL_GRACE_MS / 60_000;
  const executedAt = spend.executing_at ? new Date(spend.executing_at).getTime() : NaN;
  const failAfter = Number.isFinite(executedAt)
    ? translate('실행 뒤 {0}분({1})이 지나야', { 0: minutes, 1: formatDateTime(new Date(executedAt + DIRECT_FAIL_GRACE_MS).toISOString()) })
    : translate('실행 뒤 {0}분이 지나야', { 0: minutes });
  if (spend.provider === 'meta_ads') {
    return translate('Ads Manager 에서 캠페인 {0} 의 지출 한도가 {1}(목표)인지 {2}(이전)인지 확인하세요. 한도 변경은 반영에 최대 15분이 걸려, {3} 실패로 기록할 수 있습니다. "공급자에서 확인" 이 지금 값을 읽어 옵니다.', { 0: campaignId, 1: money(plan.to_minor), 2: money(plan.from_minor), 3: failAfter });
  }
  if (spend.provider === 'google_ads') {
    return translate('Google Ads 에서 캠페인 {0} 의 총예산이 {1}(목표)인지 {2}(이전)인지 확인하세요. 변경 기록은 몇 분 늦게 보이고, {3} 실패로 기록할 수 있습니다. "공급자에서 확인" 이 지금 값을 읽어 옵니다.', { 0: campaignId, 1: money(plan.to_minor), 2: money(plan.from_minor), 3: failAfter });
  }
  if (spend.provider === 'stripe_issuing') {
    if (plan.card_id) return translate('"공급자에서 확인" 으로 카드 {0} 의 누적 한도가 {1}(목표)인지 {2}(이전)인지 확인하세요. 목표 한도가 반영됐으면 그 카드 id 로 결제 완료를 기록하세요. {3} 이전 한도가 확인되고 이번 증액으로 쓴 돈이 없음을 확인한 경우에만 실패로 기록할 수 있습니다.', { 0: plan.card_id, 1: money(plan.limit_minor), 2: money(plan.from_minor), 3: failAfter });
    return translate('"공급자에서 확인" 이 카드 소지자 {0} 의 카드 중 이 요청의 카드를 찾습니다(Stripe 대시보드 Issuing → Cards 의 metadata awb_spend_request_id). 활성(active) 카드면 그 카드 id 로 결제 완료를 기록하세요. 비활성(inactive) 카드는 AWB 가 활성화하지 않은 카드입니다 — 쓰지 않으면 대시보드에서 해지한 뒤 실패로, 쓰려면 대시보드에서 활성화한 뒤 결제 완료로 기록합니다. 카드가 없으면 {1} 실패로 기록할 수 있습니다. 해지된 카드만 있으면 그 카드로 쓴 돈이 없음을 확인해야 합니다.', { 0: plan.target?.cardholder || '', 1: failAfter });
  }
  return translate('결제 시스템에서 실제 결제 여부를 확인하세요.');
}

/** 연결 확인의 열린 요청 표시 — 다른 계정의 것은 id · 상태 없이 온다. 없으면 ''. */
export function openRequestLabel(open: { id: string; status: string } | null): string {
  if (!open) return '';
  return open.id ? translate('열린 요청 {0}', { 0: open.status }) : translate('다른 계정에 열린 요청 있음');
}

/** 공급자 확인 결과 한 줄. */
export function inspectionSummary(insp: MarketingSpendInspection, currency: string): string {
  if (insp.kind === 'card') {
    if (insp.result === 'none') return translate('이 요청의 카드가 없습니다(실행 시각 ±1일) — 발급되지 않은 것으로 보입니다.');
    const cards = insp.cards.map((c) => `${c.id}(${c.status || translate('상태 모름')}${c.limit_minor !== null ? translate(', 한도 {0}', { 0: formatMinor(c.limit_minor, currency) }) : ''})`).join(', ');
    if (insp.result === 'found') {
      if (insp.cards.some((c) => c.status === 'active')) {
        return translate('이 요청의 카드: {0} — 활성 카드의 id 로 결제 완료를 기록하세요(쓰지 않을 카드면 Stripe 대시보드에서 해지한 뒤 실패로).', { 0: cards });
      }
      if (insp.cards.some((c) => c.status !== 'canceled')) {
        return translate('이 요청의 카드: {0} — AWB 가 활성화하지 않은 카드입니다. 쓰지 않으면 Stripe 대시보드에서 해지한 뒤 실패로(쓴 돈 없음 확인), 쓰려면 대시보드에서 활성화한 뒤 결제 완료로 기록하세요.', { 0: cards });
      }
      return translate('이 요청의 카드: {0} — 모두 해지됐습니다. 그 카드로 쓴 돈이 없음을 Stripe 대시보드에서 확인한 뒤 실패로 기록하세요.', { 0: cards });
    }
    return translate('카드 소지자의 카드를 다 보지 못했습니다{0} — Stripe 대시보드에서 확인하세요.', { 0: cards ? translate('(찾은 카드: {0})', { 0: cards }) : '' });
  }
  const now = insp.observed_minor === null ? (insp.observed === null ? translate('한도 없음') : translate('{0}(공급자 단위)', { 0: insp.observed })) : formatMinor(insp.observed_minor, currency);
  const where = insp.position === 'at_target' ? translate('목표값입니다 — 반영된 것으로 보입니다')
    : insp.position === 'at_from' ? translate('이전 값입니다 — 반영되지 않은 것으로 보입니다')
      : insp.position === 'no_ceiling' ? translate('한도가 없습니다 — 누군가 공급자 화면에서 지웠습니다')
        : translate('계획의 이전 값도 목표값도 아닙니다 — 공급자 화면에서 바뀐 이력을 보세요');
  return translate('지금 상한 {0}: {1}. ({2} → {3} 계획)', { 0: now, 1: where, 2: formatMinor(insp.from_minor, currency), 3: formatMinor(insp.to_minor, currency) });
}

/**
 * 요청별 확인이 찾은 활성 카드의 id — 결제 기록 창에 미리 채운다. 비활성 카드는 채우지 않는다: AWB 가 활성화하지 않은 카드라 결제
 * 완료로 기록하면 쓸 수 없는 카드에 예산 전체가 묶인다(쓰려면 사람이 대시보드에서 활성화하고 직접 적는다). 없으면 ''.
 */
export function inspectionCardRef(insp: MarketingSpendInspection | null): string {
  if (!insp || insp.kind !== 'card') return '';
  return insp.cards.find((c) => c.status === 'active')?.id || '';
}

/** 환불 기록 — 상한 공급자는 상한을 낮추기 전에는 기록할 수 없다(서버가 막는다). */
export function canRecordRefund(spend: Pick<MarketingSpendRequest, 'status' | 'provider'>): boolean {
  return spend.status === 'paid' && !isDirectPaymentProvider(spend.provider);
}

/** 결과가 모호한 결제(unknown)에서 사람에게 보여 주는 설명 — 자동 재전송이 없다는 것까지. */
export const UNKNOWN_SPEND_MESSAGE =
  '결제 결과가 불명확합니다 — 결제 시스템에서 실제 결제 여부를 확인한 뒤 결제 완료 또는 실패로 기록하세요. 자동으로 다시 보내지 않습니다.';

/** 2인 규칙의 첫 승인이 기록됐을 때. */
export const SECOND_APPROVAL_MESSAGE = '2인 승인 필요 — 다른 사람의 승인을 기다립니다';

/** 지출 승인의 마지막 확인 문구. */
export const SPEND_CONFIRM_PHRASE = '이 금액의 결제를 승인합니다';

// ── 상태 → 라벨 · tone ──────────────────────────────────────────────────────

export interface StatusView {
  label: string;
  tone: ActivityTone;
}

const CAMPAIGN_STATUS: Record<string, StatusView> = {
  draft: { get label() { return translate('초안'); }, tone: 'idle' },
  active: { get label() { return translate('진행 중'); }, tone: 'live' },
  paused: { get label() { return translate('일시정지'); }, tone: 'stalled' },
  archived: { get label() { return translate('보관됨'); }, tone: 'idle' },
};

const CHANNEL_STATUS: Record<string, StatusView> = {
  proposed: { get label() { return translate('승인 대기'); }, tone: 'attention' },
  awaiting_credential: { get label() { return translate('연결 대기'); }, tone: 'attention' },
  active: { get label() { return translate('활성'); }, tone: 'done' },
  paused: { get label() { return translate('일시정지'); }, tone: 'stalled' },
  rejected: { get label() { return translate('거부됨'); }, tone: 'idle' },
};

const POST_STATUS: Record<string, StatusView> = {
  draft: { get label() { return translate('승인 대기'); }, tone: 'attention' },
  approved: { get label() { return translate('승인됨'); }, tone: 'queued' },
  publishing: { get label() { return translate('게시 중'); }, tone: 'live' },
  sending: { get label() { return translate('발송 중'); }, tone: 'live' },
  published: { get label() { return translate('게시됨'); }, tone: 'done' },
  rejected: { get label() { return translate('거부됨'); }, tone: 'idle' },
  failed: { get label() { return translate('실패'); }, tone: 'failed' },
};

const ALLOCATION_STATUS: Record<string, StatusView> = {
  proposed: { get label() { return translate('승인 대기'); }, tone: 'attention' },
  active: { get label() { return translate('적용 중'); }, tone: 'done' },
  superseded: { get label() { return translate('대체됨'); }, tone: 'idle' },
  rejected: { get label() { return translate('거부됨'); }, tone: 'idle' },
};

const SPEND_STATUS: Record<string, StatusView> = {
  pending: { get label() { return translate('승인 대기'); }, tone: 'attention' },
  approved: { get label() { return translate('승인됨'); }, tone: 'queued' },
  executing: { get label() { return translate('결제 중'); }, tone: 'live' },
  paid: { get label() { return translate('결제 완료'); }, tone: 'done' },
  failed: { get label() { return translate('결제 실패'); }, tone: 'failed' },
  unknown: { get label() { return translate('결과 불명 — 확인 필요'); }, tone: 'failed' },
  denied: { get label() { return translate('거부됨'); }, tone: 'idle' },
  expired: { get label() { return translate('만료됨'); }, tone: 'idle' },
  cancelled: { get label() { return translate('취소됨'); }, tone: 'idle' },
};

const CYCLE_STATUS: Record<string, StatusView> = {
  running: { get label() { return translate('실행 중'); }, tone: 'live' },
  completed: { get label() { return translate('완료'); }, tone: 'done' },
  timed_out: { get label() { return translate('시간 초과'); }, tone: 'failed' },
  cancelled: { get label() { return translate('취소됨'); }, tone: 'idle' },
  failed: { get label() { return translate('실패'); }, tone: 'failed' },
};

const FEEDBACK_STATUS: Record<string, StatusView> = {
  recorded: { get label() { return translate('기록됨'); }, tone: 'idle' },
  ticketed: { get label() { return translate('티켓 생성'); }, tone: 'done' },
  capped: { get label() { return translate('상한 — 티켓 보류'); }, tone: 'stalled' },
};

const CONTACT_STATUS: Record<string, StatusView> = {
  subscribed: { get label() { return translate('수신 동의'); }, tone: 'done' },
  unsubscribed: { get label() { return translate('수신거부'); }, tone: 'idle' },
  bounced: { get label() { return translate('반송(바운스)'); }, tone: 'stalled' },
  complained: { get label() { return translate('스팸 신고'); }, tone: 'failed' },
  erased: { get label() { return translate('삭제됨(억제)'); }, tone: 'idle' },
};

/** 연락처 화면의 상태 필터 — 서버 CONTACT_STATUSES 와 같은 집합(test/marketing-rules.test.mjs). */
export const CONTACT_STATUS_FILTERS = ['subscribed', 'unsubscribed', 'bounced', 'complained', 'erased'] as const;

/** 수신거부 · 억제가 어디서 왔는가 — 연락처의 unsubscribe_source. */
export const UNSUBSCRIBE_SOURCE_LABELS: Record<string, string> = {
  get link() { return translate('수신거부 링크'); },
  get one_click() { return translate('메일 앱 원클릭'); },
  get manual() { return translate('사람이 기록'); },
  get mailto() { return translate('메일 회신(unsubscribe)'); },
  get bounce() { return translate('공급자: 바운스'); },
  get complaint() { return translate('공급자: 스팸 신고'); },
  get provider() { return translate('공급자: 수신거부'); },
};

function lookup(map: Record<string, StatusView>, status: string): StatusView {
  return map[status] || { label: status || '—', tone: 'idle' };
}

export const campaignStatusView = (status: string) => lookup(CAMPAIGN_STATUS, status);
export const channelStatusView = (status: string) => lookup(CHANNEL_STATUS, status);
export const allocationStatusView = (status: string) => lookup(ALLOCATION_STATUS, status);
export const spendStatusView = (status: string) => lookup(SPEND_STATUS, status);
export const cycleStatusView = (status: string) => lookup(CYCLE_STATUS, status);
export const feedbackStatusView = (status: string) => lookup(FEEDBACK_STATUS, status);
export const contactStatusView = (status: string) => lookup(CONTACT_STATUS, status);

/** 발송 현황의 공급자 결과 한 줄(0 인 항목은 뺀다). */
export function sendOutcomeLine(outcomes: { hard: number; soft: number; suppressed: number; complained: number } | null | undefined): string {
  if (!outcomes) return '';
  return [
    outcomes.hard ? `바운스(영구) ${formatCount(outcomes.hard)}` : '',
    outcomes.soft ? `바운스(일시) ${formatCount(outcomes.soft)}` : '',
    outcomes.suppressed ? `공급자 억제 ${formatCount(outcomes.suppressed)}` : '',
    outcomes.complained ? `스팸 신고 ${formatCount(outcomes.complained)}` : '',
  ].filter(Boolean).join(' · ');
}

/** 목록 발송 중지의 수치 요약 — 서버가 멈출 때 기록한 것(stats). */
export function listHoldSummary(hold: { reason?: string; stats?: { hard_bounced?: number; sent?: number; bounced?: number; complained?: number; rate?: number } | null }): string {
  const s = hold.stats || {};
  const delivered = Math.max((s.sent || 0) - (s.bounced || 0), 0);
  const rate = typeof s.rate === 'number' && Number.isFinite(s.rate) ? `${(s.rate * 100).toFixed(2)}%` : '—';
  if (hold.reason === 'hard_bounce_rate') return translate('하드 바운스율 {0} — 영구 실패 {1} / 발송 {2}', { 0: rate, 1: formatCount(s.hard_bounced ?? 0), 2: formatCount(s.sent ?? 0) });
  return translate('스팸 신고율 {0} — 신고 {1} / 닿은 메일 {2}', { 0: rate, 1: formatCount(s.complained ?? 0), 2: formatCount(delivered) });
}

/**
 * 메일 채널의 webhook 설정 안내(docs/marketing.md "공급자 이벤트"). 공급자 화면에 붙여 넣을 주소와, 서명 키를 credential 의
 * 어느 칸에 넣는지를 공급자마다 말한다. 키 값 자체는 화면에 오지 않는다(있는지 여부만).
 */
export function emailWebhookSetup(w: {
  provider: string; events_url: string | null; inbound_url: string | null; events_signing: boolean; inbound_signing: boolean;
}): { items: Array<{ label: string; url: string | null; signing: boolean; keyField: string; events: string }>; missingUrl: boolean } {
  const items = w.provider === 'sendgrid'
    ? [
      { label: translate('Event Webhook'), url: w.events_url, signing: w.events_signing, keyField: 'webhook_public_key',
        events: translate('Bounced · Dropped · Spam Reports · Unsubscribes · Group Unsubscribes, Signed Event Webhook 켬') },
      { label: translate('Inbound Parse(답장)'), url: w.inbound_url, signing: w.inbound_signing, keyField: 'inbound_public_key',
        events: translate('회신 주소의 도메인, 서명 검증 security policy, "POST the raw, full MIME message" 끔') },
    ]
    : [
      { label: translate('Webhook'), url: w.events_url, signing: w.events_signing, keyField: 'webhook_secret',
        events: translate('email.bounced · email.complained · email.suppressed · email.received(받은 메일을 쓰면)') },
    ];
  return { items, missingUrl: !w.events_url };
}

/**
 * 게시물 상태. manual 채널의 approved 는 "사람이 직접 올리고 주소를 기록해야 함" 이라 따로 말한다 —
 * 그냥 "승인됨" 이면 끝난 일처럼 읽힌다.
 */
export function postStatusView(status: string, channelKind?: string | null): StatusView {
  if (status === 'approved' && channelKind === 'manual') return { label: translate('게시 후 링크 기록 필요'), tone: 'attention' };
  return lookup(POST_STATUS, status);
}

// ── 캠페인 상태 전이 ─────────────────────────────────────────────────────────

export interface StatusAction {
  to: MarketingCampaignStatus;
  label: string;
  danger?: boolean;
}

/** 서버 TRANSITIONS 와 같다(archived → active 는 한 번에 못 간다). */
export function campaignStatusActions(status: string): StatusAction[] {
  switch (status) {
    case 'draft':
      return [{ to: 'active', label: translate('시작') }, { to: 'archived', label: translate('보관'), danger: true }];
    case 'active':
      return [{ to: 'paused', label: translate('일시정지') }, { to: 'archived', label: translate('보관'), danger: true }];
    case 'paused':
      return [{ to: 'active', label: translate('재개') }, { to: 'archived', label: translate('보관'), danger: true }];
    case 'archived':
      return [{ to: 'paused', label: translate('보관 해제') }];
    default:
      return [];
  }
}

/** 시작(active)을 막는 이유 — 서버 setStatus 와 같은 두 조건. 없으면 null. */
export function activationBlocker(campaign: Pick<MarketingCampaign, 'agent_runtime' | 'capabilities' | 'project_id'>): string | null {
  if (!campaign.agent_runtime) return translate('캠페인 에이전트를 먼저 지정하세요 (설정 → 캠페인 에이전트).');
  if ((campaign.capabilities || []).includes('feedback_to_product') && !campaign.project_id) {
    return translate('"피드백 → 제품 개선" 에는 제품 Project 가 필요합니다.');
  }
  return null;
}

// ── 주기(cadence) ───────────────────────────────────────────────────────────

/** 서버 MIN_CYCLE_INTERVAL_MS — 에이전트를 몇 분마다 깨우는 실수를 막는 하한. */
export const MIN_CYCLE_INTERVAL_MS = 10 * 60_000;
const MAX_CYCLE_INTERVAL_MS = 2_147_000_000;

export type CadenceKind = 'manual' | 'interval' | 'cron';

export interface CadenceDraft {
  kind: CadenceKind;
  /** interval 일 때 시간 단위(소수 허용 — 0.5 = 30분). */
  hours: string;
  cron: string;
  /**
   * 불러온 간격(ms). 시간 칸을 고치지 않았으면 이 값을 그대로 보낸다 — 600000(10분)을 "0.167" 시간으로 줄였다가
   * 되돌리면 601200 이 되어, 다른 설정만 저장해도 주기가 바뀐 것으로 잡히고 다음 사이클 시각이 다시 계산된다.
   */
  originalMs?: number | null;
}

function trimNumber(n: number): string {
  return String(Math.round(n * 1000) / 1000);
}

export function cadenceDraftFrom(c: { cycle_cron: string | null; cycle_interval_ms: number | null } | null | undefined): CadenceDraft {
  if (c?.cycle_cron) return { kind: 'cron', hours: '24', cron: c.cycle_cron, originalMs: null };
  if (c?.cycle_interval_ms && c.cycle_interval_ms > 0) {
    return { kind: 'interval', hours: trimNumber(c.cycle_interval_ms / 3_600_000), cron: '0 1 * * *', originalMs: c.cycle_interval_ms };
  }
  return { kind: 'manual', hours: '24', cron: '0 1 * * *', originalMs: null };
}

export type CadencePayload =
  | { ok: true; cycle_cron: string | null; cycle_interval_ms: number | null }
  | { ok: false; error: string };

/** 서버는 cron 하나, interval 하나, 또는 둘 다 없음(수동만)을 받는다 — 고르지 않은 쪽은 null 로 지운다. */
export function cadencePayload(draft: CadenceDraft): CadencePayload {
  if (draft.kind === 'manual') return { ok: true, cycle_cron: null, cycle_interval_ms: null };
  if (draft.kind === 'cron') {
    const cron = draft.cron.trim();
    if (cron.split(/\s+/).length !== 5) return { ok: false, error: translate('cron 은 UTC 기준 5개 필드여야 합니다 (예: "0 1 * * *")') };
    return { ok: true, cycle_cron: cron, cycle_interval_ms: null };
  }
  const text = draft.hours.trim();
  if (draft.originalMs && draft.originalMs > 0 && text === trimNumber(draft.originalMs / 3_600_000)) {
    return { ok: true, cycle_cron: null, cycle_interval_ms: draft.originalMs };
  }
  if (!/^\d+(\.\d+)?$/.test(text)) return { ok: false, error: translate('주기는 시간 단위 숫자로 입력하세요 (예: 24 또는 0.5)') };
  const ms = Math.round(Number(text) * 3_600_000);
  if (ms < MIN_CYCLE_INTERVAL_MS) return { ok: false, error: translate('주기는 10분(약 0.17시간) 이상이어야 합니다') };
  if (ms > MAX_CYCLE_INTERVAL_MS) return { ok: false, error: translate('주기가 너무 깁니다 (최대 약 596시간)') };
  return { ok: true, cycle_cron: null, cycle_interval_ms: ms };
}

export function describeCadence(c: { cycle_cron: string | null; cycle_interval_ms: number | null }): string {
  if (c.cycle_cron) return `cron ${c.cycle_cron} (UTC)`;
  const ms = c.cycle_interval_ms || 0;
  if (ms > 0) {
    if (ms % 3_600_000 === 0) return translate('{0}시간마다', { 0: ms / 3_600_000 });
    if (ms % 60_000 === 0) return translate('{0}분마다', { 0: ms / 60_000 });
    return translate('{0}초마다', { 0: Math.round(ms / 1000) });
  }
  return translate('수동 실행만');
}

// ── 승인함(inbox) ───────────────────────────────────────────────────────────

export type InboxSection = 'spend_unknown' | 'spend_pending' | 'allocations' | 'posts' | 'channels' | 'follow_up';

export const INBOX_SECTIONS: InboxSection[] = ['spend_unknown', 'spend_pending', 'allocations', 'posts', 'channels', 'follow_up'];

export const INBOX_SECTION_LABELS: Record<InboxSection, string> = {
  get spend_unknown() { return translate('결제 결과 확인 필요'); },
  get spend_pending() { return translate('지출 승인'); },
  get allocations() { return translate('예산 편성 승인'); },
  get posts() { return translate('발신 승인 — 게시글 · 댓글 · 메일'); },
  get channels() { return translate('채널 승인'); },
  get follow_up() { return translate('사람이 마무리해야 하는 일'); },
};

export type InboxItem =
  | { key: string; section: InboxSection; kind: 'spend'; spend: MarketingSpendRequest; sortAt: string }
  | { key: string; section: InboxSection; kind: 'allocation'; allocation: MarketingAllocation; sortAt: string }
  | { key: string; section: InboxSection; kind: 'post'; post: MarketingPost; sortAt: string }
  | { key: string; section: InboxSection; kind: 'channel'; channel: MarketingChannel; sortAt: string };

export interface InboxInput {
  channels: MarketingChannel[];
  posts: MarketingPost[];
  allocations: MarketingAllocation[];
  spendRequests: MarketingSpendRequest[];
}

export interface InboxSummary {
  items: InboxItem[];
  counts: Record<InboxSection, number>;
  /** 사람의 결정(승인/거부)을 기다리는 수 — 마무리 일(follow_up)은 빼고 센다. */
  decisions: number;
  total: number;
}

function latestById<T extends { id: string; updated_at?: string; created_at?: string }>(rows: T[]): T[] {
  const byId = new Map<string, T>();
  for (const row of rows) {
    const prev = byId.get(row.id);
    const at = row.updated_at || row.created_at || '';
    const prevAt = prev ? prev.updated_at || prev.created_at || '' : '';
    if (!prev || at >= prevAt) byId.set(row.id, row);
  }
  return [...byId.values()];
}

/**
 * 사람을 기다리는 모든 것을 한 목록으로. 같은 행이 여러 조회(상태별)에서 와도 하나로 합치고
 * (가장 최근 updated_at), 섹션 순서 — 결과 불명 결제 → 지출 → 편성 → 발신 → 채널 → 마무리 — 대로,
 * 섹션 안에서는 오래 기다린 것부터(지출은 먼저 만료되는 것부터) 늘어놓는다.
 */
export function buildInbox(input: InboxInput): InboxSummary {
  const items: InboxItem[] = [];
  const channelKind = new Map(input.channels.map((c) => [c.id, c.kind]));

  for (const spend of latestById(input.spendRequests)) {
    if (spend.status === 'unknown') {
      items.push({ key: `spend:${spend.id}`, section: 'spend_unknown', kind: 'spend', spend, sortAt: spend.created_at });
    } else if (spend.status === 'pending') {
      items.push({ key: `spend:${spend.id}`, section: 'spend_pending', kind: 'spend', spend, sortAt: spend.expires_at || spend.created_at });
    } else if (spend.status === 'approved' && spend.provider === 'manual') {
      // 승인된 수동 결제 — 사람이 AWB 밖에서 결제하고 결과를 기록해야 끝난다.
      items.push({ key: `spend:${spend.id}`, section: 'follow_up', kind: 'spend', spend, sortAt: spend.decided_at || spend.created_at });
    }
  }
  for (const allocation of latestById(input.allocations)) {
    if (allocation.status === 'proposed') {
      items.push({ key: `allocation:${allocation.id}`, section: 'allocations', kind: 'allocation', allocation, sortAt: allocation.created_at });
    }
  }
  for (const post of latestById(input.posts)) {
    if (post.status === 'draft') {
      items.push({ key: `post:${post.id}`, section: 'posts', kind: 'post', post, sortAt: post.created_at });
    } else if (post.status === 'approved' && (channelKind.get(post.channel_id) ?? 'manual') === 'manual') {
      items.push({ key: `post:${post.id}`, section: 'follow_up', kind: 'post', post, sortAt: post.decided_at || post.created_at });
    }
  }
  for (const channel of latestById(input.channels)) {
    if (channel.status === 'proposed') {
      items.push({ key: `channel:${channel.id}`, section: 'channels', kind: 'channel', channel, sortAt: channel.created_at });
    } else if (channel.status === 'awaiting_credential') {
      items.push({ key: `channel:${channel.id}`, section: 'follow_up', kind: 'channel', channel, sortAt: channel.decided_at || channel.created_at });
    }
  }

  const order = new Map(INBOX_SECTIONS.map((s, i) => [s, i]));
  items.sort((a, b) => (order.get(a.section)! - order.get(b.section)!) || (a.sortAt < b.sortAt ? -1 : a.sortAt > b.sortAt ? 1 : 0));
  return summarizeInbox(items);
}

export interface InboxViewer {
  canManage: boolean;
  canApproveSpend: boolean;
}

function summarizeInbox(items: InboxItem[]): InboxSummary {
  const counts = Object.fromEntries(INBOX_SECTIONS.map((s) => [s, 0])) as Record<InboxSection, number>;
  for (const item of items) counts[item.section] += 1;
  return { items, counts, decisions: items.length - counts.follow_up, total: items.length };
}

/**
 * 이 사람에게 보여 줄 승인함. 지출 승인 권한만 있는 사람(marketing.manage 없음)에게는 돈 항목(편성 · 지출)만 —
 * 채널 · 게시물은 그 사람이 정할 수 없고, 게시물은 읽을 권한도 없다. 운영 권한만 있는 사람에게는 돈 항목도 읽기
 * 전용으로 남긴다(누가 무엇을 기다리는지 보이게).
 */
export function inboxForViewer(inbox: InboxSummary, viewer: InboxViewer): InboxSummary {
  if (viewer.canManage) return inbox;
  return summarizeInbox(inbox.items.filter((item) => item.kind === 'spend' || item.kind === 'allocation'));
}

/**
 * 이 사람이 **처리할 수 있는** 승인 대기 수 — 서버 GET /api/marketing/inbox 의 `actionable` 과 같은 규칙이라
 * 사이드바 배지 · 목록 · 이 캠페인의 탭이 같은 수를 말한다. manage: 채널 제안 + 초안 · 직접 게시할 승인 글,
 * approve_spend: 편성 제안 + 대기 · 결과 불명 지출 + AWB 밖 결제를 기록할 승인된 수동 지출. 연결 대기 채널은
 * 승인함에 보이지만(마무리할 일) 서버처럼 세지 않는다.
 */
export function actionableInboxCount(inbox: InboxSummary, viewer: InboxViewer): number {
  let n = 0;
  for (const item of inbox.items) {
    if (item.kind === 'channel') {
      if (viewer.canManage && item.section === 'channels') n += 1;
    } else if (item.kind === 'post') {
      if (viewer.canManage) n += 1;
    } else if (viewer.canApproveSpend) {
      n += 1;
    }
  }
  return n;
}

// ── 지출 ────────────────────────────────────────────────────────────────────

export interface SpendApprovalState {
  /** 이 요청이 끝나려면 몇 명이 승인해야 하는가(2인 규칙). */
  required: 1 | 2;
  given: number;
  /** 지금 사용자가 이미 승인했다 — 두 번째 승인은 다른 사람이 해야 한다. */
  mine: boolean;
  /** "2인 승인 필요" · "1/2 승인" 같은 표시. 1인 승인이면 null. */
  label: string | null;
}

/**
 * 2인 규칙. 요청에 찍힌 `dual_required`(요청 시점의 판정 — 나중에 임계값을 올리거나 없애도 내려가지 않는다)가
 * 기준이다. 서버는 승인할 때 그것과 그때의 임계값 중 더 엄격한 쪽을 쓰므로(임계값을 낮춘 경우), 화면도 같은
 * 식으로 둘 중 하나라도 걸리면 2인으로 보여 준다. dual_required 가 없는 구버전 응답은 임계값만 본다.
 */
export function spendApprovalState(
  spend: Pick<MarketingSpendRequest, 'amount_minor' | 'approvals' | 'dual_required'>,
  dualThresholdMinor: number,
  userId: string | null | undefined,
): SpendApprovalState {
  const byThreshold = dualThresholdMinor > 0 && spend.amount_minor >= dualThresholdMinor;
  const required: 1 | 2 = spend.dual_required === true || byThreshold ? 2 : 1;
  const approvals = Array.isArray(spend.approvals) ? spend.approvals : [];
  const given = approvals.length;
  const mine = !!userId && approvals.some((a) => a.user_id === userId);
  const label = required === 2 ? (given === 0 ? translate('2인 승인 필요') : translate('{0}/2 승인', { 0: Math.min(given, 2) })) : null;
  return { required, given, mine, label };
}

/** 대기 중인데 만료 시각이 지났다(서버 sweep 이 아직 expired 로 바꾸기 전). 승인은 거부된다. */
export function isSpendExpired(spend: Pick<MarketingSpendRequest, 'status' | 'expires_at'>, now: Date = new Date()): boolean {
  if (spend.status !== 'pending' || !spend.expires_at) return false;
  const t = new Date(spend.expires_at).getTime();
  return Number.isFinite(t) && t <= now.getTime();
}

/** 사람이 결제 결과를 기록할 수 있는 상태 — 서버 assertReconcilable 과 같다. */
export function canReconcileSpend(spend: Pick<MarketingSpendRequest, 'status' | 'provider'>): boolean {
  return spend.status === 'unknown' || (spend.status === 'approved' && spend.provider === 'manual');
}

/**
 * 취소할 수 있는 상태 — pending(결정 전), 그리고 승인됐지만 아직 보내지 않은 approved(보류한 예산이 풀린다).
 * executing 부터는 이미 나갔을 수 있어 취소가 아니라 대조(결제 완료 · 실패 기록)의 일이다.
 */
export function canCancelSpend(spend: Pick<MarketingSpendRequest, 'status'>): boolean {
  return spend.status === 'pending' || spend.status === 'approved';
}

/** 정렬된 키 · 들여쓰기 2 의 JSON — 승인자가 실행 payload 전체를 읽는다. */
export function prettyJson(value: unknown): string {
  const sort = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sort);
    if (v && typeof v === 'object') {
      return Object.fromEntries(Object.keys(v as Record<string, unknown>).sort().map((k) => [k, sort((v as Record<string, unknown>)[k])]));
    }
    return v;
  };
  return JSON.stringify(sort(value ?? {}), null, 2);
}

/**
 * 사람이 직접 정한 편성을 보낼 순서. 서버는 한 줄씩 차례로 승인하며 매번 "다른 채널의 active 편성 + 이 줄 ≤ 상한"
 * 을 본다 — 늘리는 줄이 먼저 가면 끝 상태가 상한 안인 재배분(상한 100: A 60→70, B 40→30)도 첫 줄에서 409 로 멈추고,
 * 남은 줄이 제안 상태로 승인함에 남는다. 줄이는 것부터(증감이 작은 순서로) 보낸다. 편성이 없던 채널은 0 에서 시작.
 */
export function orderAllocationsForApproval<T extends { channel_id: string; amount_minor: number }>(
  allocations: T[],
  current: Map<string, number | null>,
): T[] {
  const delta = (a: T) => a.amount_minor - (current.get(a.channel_id) ?? 0);
  return allocations
    .map((a, i) => ({ a, i }))
    .sort((x, y) => delta(x.a) - delta(y.a) || x.i - y.i)
    .map(({ a }) => a);
}

// ── 링크 · 게시 미리보기 ────────────────────────────────────────────────────

/** http(s) 만 링크로 만든다 — javascript: · data: 같은 스킴은 화면에서 링크가 되면 안 된다. */
export function safeHttpUrl(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const text = raw.trim();
  if (!text) return null;
  try {
    const url = new URL(text);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}

/**
 * 커뮤니티 글의 실제 본문 — 서버 composeCommunityBody 와 같다(본문 끝에 공개 문구). 승인 전에 고친
 * 내용의 미리보기에만 쓰고, 저장된 초안의 미리보기는 서버의 preview_body 를 그대로 보여 준다.
 */
export function previewCommunityBody(body: string, disclosure: string): string {
  const text = (body || '').replace(/\r\n/g, '\n').trim();
  const d = (disclosure || '').trim();
  return d ? `${text}\n\n${d}` : text;
}

/** 줄바꿈 · 쉼표로 나눈 목록(허용 도메인 · 근거 URL). 빈 칸과 중복은 뺀다. */
export function parseList(text: string): string[] {
  const out: string[] = [];
  for (const part of (text || '').split(/[\n,]+/)) {
    const v = part.trim();
    if (v && !out.includes(v)) out.push(v);
  }
  return out;
}

// ── 실시간 갱신 ─────────────────────────────────────────────────────────────

/** `marketing_update` 가 몰려 올 때(사이클 한 번에 초안 여러 개) 한 번만 다시 읽는다. */
export const MARKETING_REFRESH_DEBOUNCE_MS = 400;

/** `marketing_update` 프레임이 이 캠페인의 것인가. */
export function isCampaignEvent(event: unknown, campaignId: string): boolean {
  return !!event && typeof event === 'object' && !!campaignId && (event as { campaign_id?: unknown }).campaign_id === campaignId;
}

// ── 설정 편집 → PATCH 본문 ──────────────────────────────────────────────────

const PATCH_KEYS: Array<keyof MarketingCampaignInput> = [
  'name', 'project_id', 'product_brief', 'goal', 'target_audience', 'capabilities', 'agent_runtime',
  'cycle_cron', 'cycle_interval_ms', 'currency', 'budget_total_minor', 'budget_period', 'budget_period_minor',
  'max_transaction_minor', 'dual_approval_threshold_minor', 'payees', 'allowed_domains', 'disclosure', 'limits',
  'feedback_ticket_status', 'improvement_assignee', 'payment_provider', 'payment_credential_id',
];

function comparable(key: keyof MarketingCampaignInput, value: unknown): string {
  if (value === undefined) return 'undefined';
  if (key === 'project_id' || key === 'payment_credential_id') return JSON.stringify(value || null);
  if (key === 'limits') {
    const entries = Object.entries((value as Record<string, unknown>) || {}).filter(([, v]) => v !== undefined && v !== null);
    return JSON.stringify(Object.fromEntries(entries.sort(([a], [b]) => (a < b ? -1 : 1))));
  }
  if (key === 'capabilities' || key === 'allowed_domains') return JSON.stringify([...((value as string[]) || [])].sort());
  return JSON.stringify(value ?? null);
}

/**
 * 돈에 관한 설정 — 서버 MONEY_SETTING_KEYS 와 같다. 이 키가 본문에 하나라도 있으면 서버는
 * marketing.approve_spend 가 없는 사람의 요청을 403 으로 거부한다(임계값을 0 으로 내리면 혼자 승인할 수 있고,
 * 수취인을 넣으면 돈이 갈 곳이 생긴다).
 */
export const MONEY_SETTING_KEYS = [
  'currency', 'budget_total_minor', 'budget_period', 'budget_period_minor', 'max_transaction_minor',
  'dual_approval_threshold_minor', 'payees', 'payment_provider', 'payment_credential_id',
] as const satisfies ReadonlyArray<keyof MarketingCampaignInput>;

export function isMoneySettingKey(key: string): boolean {
  return (MONEY_SETTING_KEYS as readonly string[]).includes(key);
}

/** 승인 권한이 없는 사람의 본문에서 돈 설정을 뺀다(생성 · 수정 모두). */
export function withoutMoneySettings<T extends object>(body: T): T {
  return Object.fromEntries(Object.entries(body).filter(([key]) => !isMoneySettingKey(key))) as T;
}

/**
 * 바뀐 키만 담은 PATCH 본문. 그대로인 값을 다시 보내지 않는다 — 돈 설정은 승인 권한이 있어야 받아 주고
 * (assertCanChangeMoneySettings), cadence 를 다시 보내면 다음 사이클 시각이 다시 계산될 수 있다.
 * `canEditMoney` 가 아니면 돈 설정은 바뀌었더라도 싣지 않는다.
 */
export function campaignPatch(
  original: MarketingCampaign,
  draft: MarketingCampaignInput,
  opts: { canEditMoney: boolean } = { canEditMoney: false },
): MarketingCampaignInput {
  const patch: MarketingCampaignInput = {};
  for (const key of PATCH_KEYS) {
    if (!(key in draft)) continue;
    if (!opts.canEditMoney && isMoneySettingKey(key)) continue;
    const next = draft[key];
    const prev = key === 'limits' ? original.limit_overrides : (original as unknown as Record<string, unknown>)[key];
    if (comparable(key, next) !== comparable(key, prev)) (patch as Record<string, unknown>)[key] = next;
  }
  return patch;
}

// ── 분석 ────────────────────────────────────────────────────────────────────

export const REPORT_PERIOD_DAYS = [7, 30, 90] as const;

export function reportRange(days: number, now: Date = new Date()): { since: string; until: string } {
  return { since: new Date(now.getTime() - days * 86_400_000).toISOString(), until: now.toISOString() };
}

export function formatCount(n: number | null | undefined): string {
  return n === null || n === undefined || !Number.isFinite(Number(n)) ? '—' : Number(n).toLocaleString(getLocaleTag());
}

/**
 * 서버가 게시물의 참여를 읽는 채널 — reddit · github outreach 채널(docs/marketing.md "참여 지표 자동 수집"). 서버
 * `common/marketing/engagement.ts` 의 `engagementTracked` 와 같은 판정이다. 이 채널의 CONNECTOR_METRICS 는 사람이
 * 기록하지 않는다(서버가 거부한다 — 두 번 세지 않게).
 */
export function engagementTrackedChannel(channel: { kind?: string; platform?: string } | null | undefined): boolean {
  return !!channel && channel.kind === 'outreach' && (channel.platform === 'reddit' || channel.platform === 'github');
}

/**
 * 서버가 지금 그 채널 글의 참여를 읽는가 — 연결된(active · paused) reddit · github outreach 채널. 서버
 * `engagementCollected` 와 같은 판정이고, 기록 폼이 CONNECTOR_METRICS 를 막는 기준이다(제안 · 연결 대기 채널은 막지 않는다).
 */
export function engagementCollectedChannel(channel: { kind?: string; platform?: string; status?: string } | null | undefined): boolean {
  return engagementTrackedChannel(channel) && (channel?.status === 'active' || channel?.status === 'paused');
}

export const CONNECTOR_METRICS = ['engagements', 'replies'] as const;

/** 게시물의 마지막 참여 — reddit 은 점수, GitHub 은 반응. 답글(댓글)인 글은 댓글 수가 없다. */
export function engagementSummary(
  platform: string | undefined,
  engagement: { engagements: number | null; replies: number | null } | null | undefined,
): string {
  if (!engagement) return '';
  const parts: string[] = [];
  if (engagement.engagements !== null) parts.push(`${platform === 'github' ? translate('반응') : translate('점수')} ${formatCount(engagement.engagements)}`);
  if (engagement.replies !== null) parts.push(translate('댓글 {0}', { 0: formatCount(engagement.replies) }));
  return parts.join(' · ');
}

/** 지표 행의 값 — 자동 수집(source `connector`) 행은 직전에 읽은 값과의 차이라 부호를 붙인다. */
export function metricValueText(metric: { metric: string; value: number; source: string }, currency: string): string {
  if (metric.metric === 'revenue_minor') return formatMinor(metric.value, currency);
  if (metric.source === 'connector' && Number(metric.value) > 0) return `+${formatCount(metric.value)}`;
  return formatCount(metric.value);
}

export function formatRate(v: number | null | undefined): string {
  return v === null || v === undefined || !Number.isFinite(v) ? '—' : `${(v * 100).toFixed(1)}%`;
}

export function formatRoas(v: number | null | undefined): string {
  return v === null || v === undefined || !Number.isFinite(v) ? '—' : `${v.toFixed(2)}x`;
}

// ── 감사 로그 ───────────────────────────────────────────────────────────────

/**
 * 감사 이벤트의 강조. 사람이 대조한 뒤에 늦게 도착한 결제 결과(spend.late_result)는 경고 — 기록과 맞는지 다시
 * 봐야 한다. 결과 불명 · 실패 · 한도 거부는 위험. 나머지는 평범하게.
 */
export function auditEventTone(action: string): 'normal' | 'warning' | 'danger' {
  if (action === 'spend.late_result') return 'warning';
  if (action === 'spend.unknown' || action === 'spend.failed' || action === 'spend.refused' || action === 'post.failed'
    || action === 'cycle.failed' || action === 'cycle.timed_out') return 'danger';
  return 'normal';
}

/**
 * 감사 로그 "더 보기" 의 커서. 서버는 `created_at < before` 로 자르는데, 같은 밀리초(Postgres 는 마이크로초까지
 * 저장하고 JSON 은 밀리초까지만 싣는다)에 기록된 행이 페이지 경계에 걸리면 `before = 마지막 행 시각` 은 그 행들을
 * 건너뛴다. 1ms 뒤를 커서로 써서 경계의 행을 다시 받고, 이미 본 행은 id 로 거른다.
 */
export function auditCursor(lastCreatedAt: string): string {
  const t = Date.parse(lastCreatedAt);
  return Number.isFinite(t) ? new Date(t + 1).toISOString() : lastCreatedAt;
}

export function actorLabel(event: { actor_type: string; actor_name: string }): string {
  if (event.actor_type === 'agent') return translate('에이전트{0}', { 0: event.actor_name ? ` · ${event.actor_name}` : '' });
  if (event.actor_type === 'system') return translate('시스템');
  if (event.actor_type === 'public') return translate('수신자');
  return event.actor_name || translate('사람');
}

/** 날짜 · 시각 — 목록의 짧은 표기(로컬 시간대). */
export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
