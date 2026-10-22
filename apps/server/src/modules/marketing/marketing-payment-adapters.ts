/**
 * 직접 결제 어댑터 등록부 — 지출 서비스가 공급자 이름으로 분기하지 않도록 같은 모양으로 감싼다
 * (docs/marketing.md "직접 결제 어댑터").
 *
 *   checkCredential 저장 · 요청 때: credential 필드 모양(네트워크 없음). 틀리면 400.
 *   checkAmount 요청 때 맨 먼저: 금액 · 통화 · 수취인 한도를 그 공급자 단위로 볼 수 있는가(네트워크 없음). 안 되면 PaymentRuleError.
 *   plan    요청 때: 대상을 읽어 실행 계획을 만든다(쓰기 없음). 규칙 위반은 PaymentRuleError, 읽기 실패는 PaymentReadError.
 *   report  연결 확인: 같은 읽기 코드로 지금 상태를 보고한다(쓰기 없음).
 *   inspect 요청별 확인: 이 요청이 공급자에 무엇을 남겼는가(쓰기 없음) — 상한은 지금 값의 위치, 카드는 이 요청의 카드.
 *   execute 실행: 다시 읽어 대조하고 보낸다. 보내기 전의 실패는 PaymentNotSentError, 보낸 뒤의 모호함은 unknown.
 */
import {
  PROVIDER_FORMATS,
  PaymentRuleError,
  googleMicrosToMinor,
  metaUnitsToMinor,
  minorToGoogleMicros,
  minorToMetaUnits,
  parseGoogleRef,
  parseMetaRef,
  parseStripeRef,
  providerToken,
  stripeCardAmount,
  type CardPlan,
  type CeilingPlan,
  type DirectPaymentProvider,
  type DirectPlan,
  type PayeeLike,
} from '../../common/marketing/payment-routes';
import { formatMinorAmount } from '../../common/marketing/money';
import { PaymentNotSentError, type PaymentOutcome } from './marketing-payments';
import {
  buildMetaPlan,
  executeMetaPlan,
  metaTargetProblems,
  observeMetaTarget,
  readMetaCredential,
} from './marketing-payment-meta';
import {
  buildGooglePlan,
  executeGooglePlan,
  googleTargetProblems,
  observeGoogleTarget,
  readGoogleCredential,
} from './marketing-payment-google';
import {
  buildStripePlan,
  checkStripeAmount,
  executeStripePlan,
  findCardsForRequest,
  observeStripeCardholder,
  readStripeCredential,
  stripeCardReadProblem,
  stripeCardholderProblems,
  type IssuedCardView,
} from './marketing-payment-stripe';

export interface DirectAdapterContext {
  fetchImpl?: typeof fetch;
  env?: Record<string, string | undefined>;
  now?: () => Date;
}

/** 연결 확인의 한 대상 결과. 공급자가 준 글은 정리된 것만, 이름은 비신뢰로 표시한다(사람만 보는 화면). */
export interface TargetReport {
  ok: boolean;
  problems: string[];
  /** 지금 상한 — AWB 최소 단위와 공급자 단위. 상한 공급자가 아니거나 상한이 없으면 null. */
  ceiling_minor: number | null;
  ceiling_text: string;
  ceiling_units: string | null;
  target_name_untrusted: string;
  facts: Record<string, string | number | boolean | null>;
  api_version: string;
}

/** 요청별 확인의 공급자 쪽 결과 — 판정이 아니라 대조를 돕는 표시다. */
export type DirectInspection =
  | {
    kind: 'ceiling';
    /** 지금 상한(공급자 단위), 없으면 null. */
    observed: string | null;
    observed_minor: number | null;
    /** 지금 상한이 계획의 어디에 있나. */
    position: 'at_target' | 'at_from' | 'other' | 'no_ceiling';
    report: TargetReport;
  }
  | {
    kind: 'card';
    /** found: 이 요청의 카드가 있다 · none: 실행 시각 ±1일 범위를 다 봤고 없다 · incomplete: 다 보지 못했다. */
    result: 'found' | 'none' | 'incomplete';
    cards: IssuedCardView[];
    api_version: string;
  };

export interface DirectPaymentAdapter {
  provider: DirectPaymentProvider;
  checkCredential(fields: Record<string, string>): void;
  checkAmount(amountMinor: number, currency: string, payee: PayeeLike): void;
  plan(input: { ref: string; fields: Record<string, string>; fingerprint: string; amountMinor: number; currency: string; payee: PayeeLike; ctx: DirectAdapterContext }): Promise<DirectPlan>;
  report(input: { ref: string; fields: Record<string, string>; fingerprint: string; currency: string; ctx: DirectAdapterContext }): Promise<TargetReport>;
  /** `response` 는 실행이 남긴 공급자 응답 요약(provider_response) — 카드 공급자는 거기 적힌 카드 id 도 직접 읽는다. */
  inspect(input: { plan: DirectPlan; ref: string; fields: Record<string, string>; fingerprint: string; currency: string; requestId: string; around: Date; response: unknown; ctx: DirectAdapterContext }): Promise<DirectInspection>;
  /** `startedAt` 은 요청이 executing 이 된 시각이다. */
  execute(input: { plan: DirectPlan; fields: Record<string, string>; fingerprint: string; requestId: string; startedAt: Date; ctx: DirectAdapterContext }): Promise<PaymentOutcome>;
}

/** 실행 직전에 credential 모양이 틀렸다 — 아무것도 보내기 전이다. */
function notSentIfUnreadable<T>(read: () => T): T {
  try {
    return read();
  } catch (e: any) {
    throw new PaymentNotSentError(e?.message || String(e));
  }
}

function ceilingPlanOf(plan: DirectPlan): CeilingPlan {
  if (plan.plan !== 'raise_ceiling') throw new PaymentNotSentError('the stored plan is not a ceiling plan');
  return plan;
}

function cardPlanOf(plan: DirectPlan): CardPlan {
  if (plan.plan !== 'issue_card') throw new PaymentNotSentError('the stored plan is not a card plan');
  return plan;
}

function minorText(minor: bigint | null, currency: string): { minor: number | null; text: string } {
  if (minor === null) return { minor: null, text: '' };
  const n = Number(minor);
  return Number.isSafeInteger(n) ? { minor: n, text: formatMinorAmount(n, currency) } : { minor: null, text: '' };
}

/** 상한 공급자의 요청별 확인 — 연결 확인과 같은 읽기로 지금 상한을 보고, 계획의 from · to 와 견준다. */
function ceilingInspection(plan: CeilingPlan, report: TargetReport): DirectInspection {
  const observed = report.ceiling_units;
  const position = observed === null ? 'no_ceiling' : observed === plan.to ? 'at_target' : observed === plan.from ? 'at_from' : 'other';
  return { kind: 'ceiling', observed, observed_minor: report.ceiling_minor, position, report };
}

const metaAdapter: DirectPaymentAdapter = {
  provider: 'meta_ads',
  checkCredential(fields) { readMetaCredential(fields); },
  checkAmount(amountMinor, currency) { minorToMetaUnits(amountMinor, currency); },
  async plan({ ref, fields, fingerprint, amountMinor, currency, ctx }) {
    const target = parseMetaRef(ref);
    // 통화 · 단위(나누어떨어짐)는 공급자를 읽기 전에 — 금액 문제로 공급자 호출을 쓰지 않게.
    minorToMetaUnits(amountMinor, currency);
    const obs = await observeMetaTarget(target, readMetaCredential(fields), ctx);
    return buildMetaPlan(obs, target, amountMinor, currency, fingerprint);
  },
  async report({ ref, fields, currency, ctx }) {
    const target = parseMetaRef(ref);
    const obs = await observeMetaTarget(target, readMetaCredential(fields), ctx);
    const problems = metaTargetProblems(obs, target, currency);
    let ceiling: { minor: number | null; text: string } = { minor: null, text: '' };
    try { ceiling = minorText(obs.campaign.spend_cap === null ? null : metaUnitsToMinor(obs.campaign.spend_cap, obs.account.currency || currency), obs.account.currency || currency); } catch { /* 표에 없는 통화 — problems 에 이미 있다 */ }
    return {
      ok: problems.length === 0,
      problems,
      ceiling_minor: ceiling.minor,
      ceiling_text: ceiling.text,
      ceiling_units: obs.campaign.spend_cap === null ? null : obs.campaign.spend_cap.toString(),
      target_name_untrusted: obs.campaign.name,
      facts: {
        field: 'spend_cap',
        account_currency: obs.account.currency,
        account_status: obs.account.account_status,
        campaign_status: obs.campaign.status,
        effective_status: obs.campaign.effective_status,
        buying_type: obs.campaign.buying_type,
      },
      api_version: obs.api_version,
    };
  },
  async inspect({ plan, ref, fields, fingerprint, currency, ctx }) {
    return ceilingInspection(ceilingPlanOf(plan), await metaAdapter.report({ ref, fields, fingerprint, currency, ctx }));
  },
  async execute({ plan, fields, ctx }) {
    return executeMetaPlan(ceilingPlanOf(plan), notSentIfUnreadable(() => readMetaCredential(fields)), ctx);
  },
};

const googleAdapter: DirectPaymentAdapter = {
  provider: 'google_ads',
  checkCredential(fields) { readGoogleCredential(fields); },
  checkAmount(amountMinor, currency) { minorToGoogleMicros(amountMinor, currency); },
  async plan({ ref, fields, fingerprint, amountMinor, currency, ctx }) {
    const target = parseGoogleRef(ref);
    minorToGoogleMicros(amountMinor, currency);
    const obs = await observeGoogleTarget(target, readGoogleCredential(fields), fingerprint, ctx);
    return buildGooglePlan(obs, target, amountMinor, currency, fingerprint, ctx.now ? ctx.now() : new Date());
  },
  async report({ ref, fields, fingerprint, currency, ctx }) {
    const target = parseGoogleRef(ref);
    const obs = await observeGoogleTarget(target, readGoogleCredential(fields), fingerprint, ctx);
    const problems = googleTargetProblems(obs, target, currency, ctx.now ? ctx.now() : new Date());
    let ceiling: { minor: number | null; text: string } = { minor: null, text: '' };
    try { ceiling = minorText(obs.budget.total_micros === null ? null : googleMicrosToMinor(obs.budget.total_micros, obs.customer.currency || currency), obs.customer.currency || currency); } catch { /* problems 에 있다 */ }
    return {
      ok: problems.length === 0,
      problems,
      ceiling_minor: ceiling.minor,
      ceiling_text: ceiling.text,
      ceiling_units: obs.budget.total_micros === null ? null : obs.budget.total_micros.toString(),
      target_name_untrusted: obs.campaign.name,
      facts: {
        field: 'total_amount_micros',
        account_currency: obs.customer.currency,
        test_account: obs.customer.test_account,
        campaign_status: obs.campaign.status,
        budget_period: obs.budget.period,
        end_date_time: obs.campaign.end_date_time,
      },
      api_version: obs.api_version,
    };
  },
  async inspect({ plan, ref, fields, fingerprint, currency, ctx }) {
    return ceilingInspection(ceilingPlanOf(plan), await googleAdapter.report({ ref, fields, fingerprint, currency, ctx }));
  },
  async execute({ plan, fields, fingerprint, ctx }) {
    return executeGooglePlan(ceilingPlanOf(plan), notSentIfUnreadable(() => readGoogleCredential(fields)), fingerprint, ctx);
  },
};

const stripeAdapter: DirectPaymentAdapter = {
  provider: 'stripe_issuing',
  checkCredential(fields) { readStripeCredential(fields); },
  checkAmount(amountMinor, currency, payee) { checkStripeAmount(amountMinor, currency, payee); },
  async plan({ ref, fields, fingerprint, amountMinor, currency, payee, ctx }) {
    const target = parseStripeRef(ref);
    checkStripeAmount(amountMinor, currency, payee);
    const cred = readStripeCredential(fields);
    const obs = await observeStripeCardholder(target, cred, ctx);
    return buildStripePlan(obs, target, payee, amountMinor, currency, fingerprint, cred);
  },
  async report({ ref, fields, currency, ctx }) {
    const target = parseStripeRef(ref);
    const cred = readStripeCredential(fields);
    const obs = await observeStripeCardholder(target, cred, ctx);
    const problems = stripeCardholderProblems(obs, target, cred);
    try { stripeCardAmount(1, currency); } catch (e: any) { problems.push(e.message); }
    const readProblem = await stripeCardReadProblem(target, cred, ctx);
    if (readProblem) problems.push(readProblem);
    return {
      ok: problems.length === 0,
      problems,
      ceiling_minor: null,
      ceiling_text: '',
      ceiling_units: null,
      // 사람만 보는 연결 확인에만 싣는다(계획 · 지출 요청에는 넣지 않는다 — 실제 사람의 이름일 수 있다).
      target_name_untrusted: obs.name_untrusted,
      facts: {
        kind: 'card',
        cardholder_status: obs.status,
        cardholder_type: obs.type,
        livemode: obs.livemode,
        key_mode: cred.mode,
      },
      api_version: obs.api_version,
    };
  },
  async inspect({ plan, ref, fields, fingerprint, requestId, around, response, ctx }) {
    // 다른 키(다른 Stripe 계정일 수 있다)로 찾은 "없음" 은 이 요청의 답이 아니다 — 카드 소지자 id 는 계정마다다.
    if (fingerprint !== cardPlanOf(plan).credential_fingerprint) {
      throw new PaymentRuleError('the Stripe key changed since this request — its card can only be looked up with the key that issued it; check the Stripe Dashboard of that account');
    }
    const recorded = response && typeof response === 'object' ? (response as Record<string, unknown>).card_id : undefined;
    const knownCardId = providerToken(recorded, PROVIDER_FORMATS.stripeId);
    const scan = await findCardsForRequest(parseStripeRef(ref), readStripeCredential(fields), requestId, around, { ...ctx, ...(knownCardId ? { knownCardId } : {}) });
    return { kind: 'card', result: scan.result, cards: scan.cards, api_version: scan.api_version };
  },
  async execute({ plan, fields, requestId, startedAt, ctx }) {
    return executeStripePlan(cardPlanOf(plan), notSentIfUnreadable(() => readStripeCredential(fields)), requestId, { ...ctx, startedAt });
  },
};

export const DIRECT_PAYMENT_ADAPTERS: Readonly<Record<DirectPaymentProvider, DirectPaymentAdapter>> = {
  meta_ads: metaAdapter,
  google_ads: googleAdapter,
  stripe_issuing: stripeAdapter,
};
