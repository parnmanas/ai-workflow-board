/**
 * 직접 결제 어댑터 등록부 — 지출 서비스가 공급자 이름으로 분기하지 않도록 같은 모양으로 감싼다
 * (docs/marketing.md "직접 결제 어댑터").
 *
 *   plan    요청 때: 대상을 읽어 실행 계획을 만든다(쓰기 없음). 규칙 위반은 PaymentRuleError, 읽기 실패는 PaymentReadError.
 *   report  연결 확인 · 요청별 확인: 같은 읽기 코드로 지금 상태를 보고한다(쓰기 없음).
 *   execute 실행: 다시 읽어 대조하고 한 번 쓴다. 쓰기 전의 실패는 PaymentNotSentError, 쓴 뒤의 모호함은 unknown.
 */
import {
  googleMicrosToMinor,
  metaUnitsToMinor,
  parseGoogleRef,
  parseMetaRef,
  type CeilingPlan,
  type DirectPaymentProvider,
} from '../../common/marketing/payment-routes';
import { formatMinorAmount } from '../../common/marketing/money';
import type { PaymentOutcome } from './marketing-payments';
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

export interface DirectAdapterContext {
  fetchImpl?: typeof fetch;
  env?: Record<string, string | undefined>;
  now?: () => Date;
}

/** 연결 확인 · 요청별 확인의 한 대상 결과. 공급자가 준 글은 정리된 것만, 이름은 비신뢰로 표시한다. */
export interface TargetReport {
  ok: boolean;
  problems: string[];
  /** 지금 상한 — AWB 최소 단위와 공급자 단위. 상한이 없으면 null. */
  ceiling_minor: number | null;
  ceiling_text: string;
  ceiling_units: string | null;
  target_name_untrusted: string;
  facts: Record<string, string | number | boolean | null>;
  api_version: string;
}

export interface DirectPaymentAdapter {
  provider: DirectPaymentProvider;
  /** credential 필드 모양만 본다(저장 시점) — 네트워크 없음. 틀리면 400. */
  checkCredential(fields: Record<string, string>): void;
  plan(input: { ref: string; fields: Record<string, string>; fingerprint: string; amountMinor: number; currency: string; ctx: DirectAdapterContext }): Promise<CeilingPlan>;
  report(input: { ref: string; fields: Record<string, string>; fingerprint: string; currency: string; ctx: DirectAdapterContext }): Promise<TargetReport>;
  execute(input: { plan: CeilingPlan; fields: Record<string, string>; fingerprint: string; ctx: DirectAdapterContext }): Promise<PaymentOutcome>;
}

function minorText(minor: bigint | null, currency: string): { minor: number | null; text: string } {
  if (minor === null) return { minor: null, text: '' };
  const n = Number(minor);
  return Number.isSafeInteger(n) ? { minor: n, text: formatMinorAmount(n, currency) } : { minor: null, text: '' };
}

const metaAdapter: DirectPaymentAdapter = {
  provider: 'meta_ads',
  checkCredential(fields) { readMetaCredential(fields); },
  async plan({ ref, fields, fingerprint, amountMinor, currency, ctx }) {
    const target = parseMetaRef(ref);
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
  async execute({ plan, fields, ctx }) {
    return executeMetaPlan(plan, readMetaCredential(fields), ctx);
  },
};

const googleAdapter: DirectPaymentAdapter = {
  provider: 'google_ads',
  checkCredential(fields) { readGoogleCredential(fields); },
  async plan({ ref, fields, fingerprint, amountMinor, currency, ctx }) {
    const target = parseGoogleRef(ref);
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
  async execute({ plan, fields, fingerprint, ctx }) {
    return executeGooglePlan(plan, readGoogleCredential(fields), fingerprint, ctx);
  },
};

export const DIRECT_PAYMENT_ADAPTERS: Readonly<Record<DirectPaymentProvider, DirectPaymentAdapter>> = {
  meta_ads: metaAdapter,
  google_ads: googleAdapter,
};
