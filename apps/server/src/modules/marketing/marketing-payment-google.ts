/**
 * Google Ads 직접 결제 어댑터 — 캠페인 총예산(`CUSTOM_PERIOD` · `total_amount_micros`)을 compare-and-set 으로 올린다
 * (docs/marketing.md "직접 결제 어댑터").
 *
 * Google 이 고정 상한이라고 명시한 것은 캠페인 총예산뿐이다("acts as a hard cap … you will never be charged more than your
 * total budget"). 일 예산(하루 2배 · 월 30.4배, 기간 끝이 없음)과 계정 예산(월 청구서 결제 계정 전용, 비동기 심사)은 거부한다.
 * 일 예산 캠페인은 총예산으로 바꿀 수 없으므로, 이 경로를 쓰려면 사람이 캠페인을 처음부터 총예산 + 종료일로 만든다.
 * 공유 예산은 여러 캠페인에 퍼지므로 거부한다(공유하지 않고 이 캠페인에만 붙은 예산).
 *
 * mutate 에는 멱등 키가 없지만 partialFailure=false 이면 원자적이고, 절대값 `to` 를 쓰므로 다시 써도 결과가 같다.
 * 응답에 바뀐 값이 오도록 responseContentType=MUTABLE_RESOURCE 를 보낸다 — 이게 없으면 리소스 이름만 와서 확정할 수 없다.
 * 인증은 OAuth refresh token → access token(메모리 캐시, credential 지문을 키로). developer token 은 2026-09-09 에 폐지돼
 * Google 이 무시한다 — credential 에 있으면만 보낸다.
 */
import {
  PROVIDER_FORMATS,
  PaymentRuleError,
  buildCeilingPlan,
  cleanProviderText,
  googleMicrosToMinor,
  isPaymentCurrencySupported,
  minorToGoogleMicros,
  parseProviderInt,
  paymentApiVersion,
  providerToken,
  scrubSecrets,
  type CeilingPlan,
  type GoogleTarget,
} from '../../common/marketing/payment-routes';
import { formatMinorAmount } from '../../common/marketing/money';
import { marketingError } from './marketing-errors';
import {
  PaymentNotSentError,
  PaymentReadError,
  ProviderTransportError,
  providerRequest,
  type PaymentOutcome,
  type ProviderReply,
} from './marketing-payments';

const ADS_HOST = 'https://googleads.googleapis.com';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const READ_TIMEOUT_MS = 10_000;
const WRITE_TIMEOUT_MS = 20_000;

export interface GoogleCredential {
  client_id: string;
  client_secret: string;
  refresh_token: string;
  /** 관리자(MCC) 계정을 거쳐 접근할 때 그 계정 id(숫자만). */
  login_customer_id: string;
  developer_token: string;
}

export function readGoogleCredential(fields: Record<string, string>): GoogleCredential {
  const missing = ['client_id', 'client_secret', 'refresh_token'].filter((k) => !fields[k]);
  if (missing.length) throw marketingError(400, `Google Ads credential needs ${missing.map((k) => `"${k}"`).join(', ')} (an OAuth client and a refresh token with the adwords scope)`);
  const login = (fields.login_customer_id || '').replace(/-/g, '');
  if (login && !/^\d{10}$/.test(login)) throw marketingError(400, 'Google Ads credential "login_customer_id" must be a 10-digit manager account id');
  return {
    client_id: fields.client_id,
    client_secret: fields.client_secret,
    refresh_token: fields.refresh_token,
    login_customer_id: login,
    developer_token: fields.developer_token || '',
  };
}

function secretsOf(cred: GoogleCredential, token = ''): string[] {
  return [cred.client_secret, cred.refresh_token, cred.developer_token, token];
}

// ── access token ──────────────────────────────────────────────────────────

const tokenCache = new Map<string, { token: string; expiresAt: number }>();
const tokenInFlight = new Map<string, Promise<string>>();

/** 테스트용 — 캐시를 비운다. */
export function resetGoogleTokenCache(): void {
  tokenCache.clear();
  tokenInFlight.clear();
}

/**
 * refresh token 으로 access token 을 받는다(만료 1분 전까지 캐시). 키는 credential 지문이다 — credential 을 다시 저장하면
 * 지문이 바뀌어 새 토큰을 받는다. 실패는 PaymentReadError(쓰기 전이므로 아무것도 나가지 않았다).
 */
export async function googleAccessToken(cred: GoogleCredential, fingerprint: string, fetchImpl?: typeof fetch, now: () => number = Date.now): Promise<string> {
  const cached = tokenCache.get(fingerprint);
  if (cached && cached.expiresAt > now()) return cached.token;
  const pending = tokenInFlight.get(fingerprint);
  if (pending) return pending;
  const run = (async () => {
    let reply: ProviderReply;
    try {
      reply = await providerRequest({
        url: TOKEN_URL,
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: new URLSearchParams({
          client_id: cred.client_id,
          client_secret: cred.client_secret,
          refresh_token: cred.refresh_token,
          grant_type: 'refresh_token',
        }).toString(),
        timeoutMs: READ_TIMEOUT_MS,
        fetchImpl,
      });
    } catch (e: any) {
      throw new PaymentReadError(`could not get a Google access token: ${e?.message || e}`, true);
    }
    const token = reply.json && typeof reply.json.access_token === 'string' ? reply.json.access_token : '';
    if (reply.status !== 200 || !token) {
      const code = /^[a-z_]{1,40}$/.test(String(reply.json?.error || '')) ? String(reply.json.error) : '';
      const detail = scrubSecrets(cleanProviderText(reply.json?.error_description || '', 200), secretsOf(cred));
      const hint = code === 'invalid_grant'
        ? ' — the refresh token was revoked or expired (apps in "Testing" get 7-day tokens); issue a new one'
        : '';
      throw new PaymentReadError(`Google refused the OAuth refresh (HTTP ${reply.status}${code ? `, ${code}` : ''})${hint}`, reply.status >= 500, detail);
    }
    const seconds = Number(reply.json.expires_in);
    const ttl = Number.isFinite(seconds) && seconds > 120 ? (seconds - 60) * 1000 : 60_000;
    tokenCache.set(fingerprint, { token, expiresAt: now() + ttl });
    return token;
  })();
  tokenInFlight.set(fingerprint, run);
  try {
    return await run;
  } finally {
    tokenInFlight.delete(fingerprint);
  }
}

function adsHeaders(cred: GoogleCredential, token: string): Record<string, string> {
  return {
    authorization: `Bearer ${token}`,
    'content-type': 'application/json',
    accept: 'application/json',
    ...(cred.login_customer_id ? { 'login-customer-id': cred.login_customer_id } : {}),
    ...(cred.developer_token ? { 'developer-token': cred.developer_token } : {}),
  };
}

/**
 * Google API 오류 본문 — `{error:{code,status,message,details:[GoogleAdsFailure]}}` 또는 래퍼 없이. `text` 는 상태 · 오류 코드만(에이전트까지
 * 가는 오류 문장), `message` 는 공급자 글을 정리하고 비밀 값을 지운 것(사람용 요약에 `message_untrusted` 로만).
 */
function googleError(reply: ProviderReply, cred: GoogleCredential, token: string): { text: string; message: string; status: string; adsFailure: boolean; requestId: string } {
  const body = reply.json && typeof reply.json === 'object' ? (reply.json.error && typeof reply.json.error === 'object' ? reply.json.error : reply.json) : null;
  const details: any[] = Array.isArray(body?.details) ? body.details : [];
  const failure = details.find((d) => typeof d?.['@type'] === 'string' && d['@type'].includes('GoogleAdsFailure'));
  const first = failure && Array.isArray(failure.errors) ? failure.errors[0] : null;
  const errorCode = first && first.errorCode && typeof first.errorCode === 'object'
    ? Object.entries(first.errorCode).map(([k, v]) => `${k}=${String(v)}`).join(',')
    : '';
  const message = scrubSecrets(cleanProviderText(first?.message || body?.message || reply.text || '', 300), secretsOf(cred, token));
  const status = providerToken(body?.status, PROVIDER_FORMATS.enumName);
  const codeText = /^[A-Za-z]{1,60}=[A-Z_]{1,80}(,[A-Za-z]{1,60}=[A-Z_]{1,80})*$/.test(errorCode) ? errorCode : '';
  return {
    text: `HTTP ${reply.status}${status ? ` ${status}` : ''}${codeText ? ` (${codeText})` : ''}`,
    message,
    status,
    adsFailure: !!failure,
    requestId: providerToken(reply.header('request-id') || failure?.requestId, PROVIDER_FORMATS.traceId),
  };
}

async function googleSearch(
  customerId: string,
  query: string,
  cred: GoogleCredential,
  token: string,
  opts: { fetchImpl?: typeof fetch; version: string; fingerprint: string },
): Promise<any[]> {
  let reply: ProviderReply;
  try {
    reply = await providerRequest({
      url: `${ADS_HOST}/${opts.version}/customers/${customerId}/googleAds:search`,
      method: 'POST',
      headers: adsHeaders(cred, token),
      body: JSON.stringify({ query }),
      timeoutMs: READ_TIMEOUT_MS,
      fetchImpl: opts.fetchImpl,
    });
  } catch (e: any) {
    throw new PaymentReadError(`could not read Google Ads customer ${customerId}: ${e?.message || e}`, true);
  }
  if (reply.status === 200 && reply.json && typeof reply.json === 'object') {
    return Array.isArray(reply.json.results) ? reply.json.results : [];
  }
  const err = googleError(reply, cred, token);
  // 거부된 access token 은 캐시에서 지운다 — 남겨 두면 만료(최대 한 시간)까지 같은 401 이 이어진다.
  if (reply.status === 401) tokenCache.delete(opts.fingerprint);
  const retryable = reply.status >= 500 || reply.status === 429 || reply.status === 409;
  throw new PaymentReadError(`could not read Google Ads customer ${customerId} (${err.text})`, retryable, err.message);
}

export interface GoogleObservation {
  api_version: string;
  found: boolean;
  customer: { currency: string; test_account: boolean };
  campaign: { id: string; name: string; status: string; end_date_time: string; budget: string };
  budget: {
    resource_name: string;
    period: string;
    status: string;
    explicitly_shared: boolean;
    reference_count: number;
    /** null = 총예산 없음(일 예산). */
    total_micros: bigint | null;
  };
  /** 이 통화의 청구 최소 단위(micros), 모르면 null. */
  billable_unit_micros: bigint | null;
}

const billableUnits = new Map<string, bigint>();

function campaignQuery(campaignId: string): string {
  return [
    'SELECT customer.currency_code, customer.test_account, campaign.id, campaign.name, campaign.status,',
    'campaign.end_date_time, campaign.campaign_budget, campaign_budget.resource_name, campaign_budget.period,',
    'campaign_budget.total_amount_micros, campaign_budget.explicitly_shared, campaign_budget.reference_count,',
    'campaign_budget.status',
    `FROM campaign WHERE campaign.id = ${campaignId}`,
  ].join(' ');
}

export async function observeGoogleTarget(
  target: GoogleTarget,
  cred: GoogleCredential,
  fingerprint: string,
  opts: { fetchImpl?: typeof fetch; env?: Record<string, string | undefined>; currency?: string } = {},
): Promise<GoogleObservation> {
  const version = paymentApiVersion('google_ads', opts.env);
  const token = await googleAccessToken(cred, fingerprint, opts.fetchImpl);
  const rows = await googleSearch(target.customer_id, campaignQuery(target.campaign_id), cred, token, { fetchImpl: opts.fetchImpl, version, fingerprint });
  const row = rows[0] || null;
  // proto3 JSON 은 기본값(false · 0)을 빼고 보낸다 — 빠진 값은 기본값으로 읽는다.
  const budget = row?.campaignBudget || {};
  const campaign = row?.campaign || {};
  const customer = row?.customer || {};
  let total: bigint | null = null;
  let refCount = 0;
  try {
    total = budget.totalAmountMicros === undefined || budget.totalAmountMicros === null || budget.totalAmountMicros === ''
      ? null
      : parseProviderInt(budget.totalAmountMicros, 'Google total_amount_micros');
    if (total === 0n) total = null;
    refCount = budget.referenceCount === undefined ? 0 : Number(parseProviderInt(budget.referenceCount, 'Google reference_count'));
  } catch (e: any) {
    throw new PaymentReadError(`Google Ads answered an unexpected value: ${e?.message || e}`, false);
  }
  // 형식이 정해진 값은 형식에 맞을 때만 받는다(아니면 '' — 통화 · 예산 · 종료일 대조에서 걸린다). 이름만 자유 글이다(비신뢰 표시용).
  const currency = providerToken(typeof customer.currencyCode === 'string' ? customer.currencyCode.toUpperCase() : '', PROVIDER_FORMATS.currency);
  let billable: bigint | null = null;
  if (row && currency) {
    billable = billableUnits.get(currency) ?? null;
    if (billable === null) {
      try {
        const units = await googleSearch(
          target.customer_id,
          `SELECT currency_constant.code, currency_constant.billable_unit_micros FROM currency_constant WHERE currency_constant.code = '${currency}'`,
          cred, token, { fetchImpl: opts.fetchImpl, version, fingerprint },
        );
        const raw = units[0]?.currencyConstant?.billableUnitMicros;
        if (raw !== undefined) {
          billable = parseProviderInt(raw, 'Google billable_unit_micros');
          if (billable > 0n) billableUnits.set(currency, billable);
          else billable = null;
        }
      } catch {
        billable = null; // 모르면 확인을 건너뛴다 — 배수가 아니면 mutate 가 거절한다(failed, 아무것도 바뀌지 않음).
      }
    }
  }
  return {
    api_version: version,
    found: !!row,
    customer: { currency, test_account: customer.testAccount === true },
    campaign: {
      id: providerToken(campaign.id, PROVIDER_FORMATS.digits),
      name: cleanProviderText(campaign.name, 200),
      status: providerToken(campaign.status, PROVIDER_FORMATS.enumName),
      end_date_time: providerToken(campaign.endDateTime, PROVIDER_FORMATS.googleDateTime),
      budget: providerToken(campaign.campaignBudget, PROVIDER_FORMATS.googleBudget),
    },
    budget: {
      resource_name: providerToken(budget.resourceName, PROVIDER_FORMATS.googleBudget),
      period: providerToken(budget.period, PROVIDER_FORMATS.enumName),
      status: providerToken(budget.status, PROVIDER_FORMATS.enumName),
      explicitly_shared: budget.explicitlyShared === true,
      reference_count: refCount,
      total_micros: total,
    },
    billable_unit_micros: billable,
  };
}

/** 종료 시각("yyyy-MM-dd HH:mm:ss", 고객 시간대)이 이미 하루 넘게 지났는가 — 시간대를 몰라 하루 여유를 둔다. */
function endedBefore(endDateTime: string, now: Date): boolean {
  const m = endDateTime.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return false;
  const end = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + 2);
  return end < now.getTime();
}

export function googleTargetProblems(obs: GoogleObservation, target: GoogleTarget, currency: string, now: Date = new Date()): string[] {
  if (!obs.found) return [`Google Ads campaign ${target.campaign_id} was not found in customer ${target.customer_id}`];
  const out: string[] = [];
  if (!isPaymentCurrencySupported(currency)) out.push(`currency ${currency} is not supported by the Google Ads adapter`);
  if (obs.customer.currency !== currency) out.push(`the Google Ads account's currency is ${obs.customer.currency || '?'}, the campaign's is ${currency}`);
  if (obs.campaign.status === 'REMOVED') out.push('the Google Ads campaign is removed');
  // 고치는 예산은 그 고객 계정 아래의 것이어야 한다(mutate 주소의 고객과 같은 곳).
  if (!obs.budget.resource_name || obs.campaign.budget !== obs.budget.resource_name || !obs.budget.resource_name.startsWith(`customers/${target.customer_id}/`)) {
    out.push('could not resolve the campaign\'s own budget');
  }
  if (obs.budget.status === 'REMOVED') out.push('the campaign budget is removed');
  if (obs.budget.period !== 'CUSTOM_PERIOD' || obs.budget.total_micros === null) {
    out.push('the campaign uses a daily budget — only a campaign total budget (CUSTOM_PERIOD) is a hard cap; a daily-budget campaign cannot be converted, so create the campaign with a total budget and an end date');
  }
  if (obs.budget.explicitly_shared) out.push('the budget is shared with other campaigns — raising it would fund them too');
  if (obs.budget.reference_count !== 1) out.push(`the budget is attached to ${obs.budget.reference_count} campaigns (must be exactly this one)`);
  if (!obs.campaign.end_date_time) out.push('the campaign has no end date (a total budget needs one)');
  else if (endedBefore(obs.campaign.end_date_time, now)) out.push(`the campaign ended (${obs.campaign.end_date_time})`);
  return out;
}

export function buildGooglePlan(
  obs: GoogleObservation,
  target: GoogleTarget,
  amountMinor: number,
  currency: string,
  fingerprint: string,
  now: Date = new Date(),
): CeilingPlan {
  const problems = googleTargetProblems(obs, target, currency, now);
  if (problems.length) throw new PaymentRuleError(problems.join('; '));
  const unit = obs.billable_unit_micros;
  if (unit !== null && minorToGoogleMicros(amountMinor, currency) % unit !== 0n) {
    throw new PaymentRuleError(`Google Ads bills ${currency} in steps of ${microsText(unit, currency)} — the amount must be a multiple of that`, 400);
  }
  return buildCeilingPlan({
    provider: 'google_ads',
    target: { customer_id: target.customer_id, campaign_id: target.campaign_id, budget: obs.budget.resource_name },
    targetName: obs.campaign.name,
    currency,
    fromUnits: obs.budget.total_micros!,
    amountMinor,
    credentialFingerprint: fingerprint,
    extra: { test_account: obs.customer.test_account, end_date_time: obs.campaign.end_date_time },
  });
}

export function googleExecutionCheck(obs: GoogleObservation, plan: CeilingPlan, now: Date = new Date()): { blocker: string | null; atTarget: boolean } {
  const target = { customer_id: plan.target.customer_id, campaign_id: plan.target.campaign_id };
  const problems = googleTargetProblems(obs, target, plan.currency, now);
  if (problems.length) return { blocker: `the target changed since the request: ${problems.join('; ')}`, atTarget: false };
  if (obs.budget.resource_name !== plan.target.budget) return { blocker: 'the campaign now uses a different budget', atTarget: false };
  if (obs.customer.test_account !== (plan.test_account === true)) return { blocker: 'the Google Ads account switched between test and production', atTarget: false };
  const current = obs.budget.total_micros!;
  if (current.toString() === plan.to) return { blocker: null, atTarget: true };
  if (current.toString() !== plan.from) {
    return { blocker: `the total budget changed since the request (expected ${plan.from} micros, found ${current.toString()}) — nothing was changed`, atTarget: false };
  }
  return { blocker: null, atTarget: false };
}

/**
 * mutate 응답의 분류. 200 은 결과가 정확히 하나이고 그 리소스 · 값이 계획과 같을 때만 확정이다. 400 · 401 · 403 · 404 는
 * 원자적 mutate 의 거절, 409 · 429 는 GoogleAdsFailure 본문(동시 수정 · 할당량)일 때만 거절이다. 그 밖(499 · 5xx · 본문 없는 4xx)은 모호하다.
 */
export function classifyGoogleWrite(reply: { status: number; json: any }, plan: CeilingPlan, adsFailure: boolean): 'ok' | 'failed' | 'unknown' {
  if (reply.status === 200) {
    const results = Array.isArray(reply.json?.results) ? reply.json.results : [];
    const only = results.length === 1 ? results[0] : null;
    if (!only || only.resourceName !== plan.target.budget) return 'unknown';
    const returned = only.campaignBudget?.totalAmountMicros;
    return returned !== undefined && String(returned) === plan.to ? 'ok' : 'unknown';
  }
  if ([400, 401, 403, 404].includes(reply.status)) return 'failed';
  if ((reply.status === 409 || reply.status === 429) && adsFailure) return 'failed';
  return 'unknown';
}

export async function executeGooglePlan(
  plan: CeilingPlan,
  cred: GoogleCredential,
  fingerprint: string,
  opts: { fetchImpl?: typeof fetch; env?: Record<string, string | undefined>; now?: () => Date } = {},
): Promise<PaymentOutcome> {
  const target = { customer_id: plan.target.customer_id, campaign_id: plan.target.campaign_id };
  const now = opts.now ? opts.now() : new Date();
  let before: GoogleObservation;
  let token: string;
  try {
    before = await observeGoogleTarget(target, cred, fingerprint, opts);
    token = await googleAccessToken(cred, fingerprint, opts.fetchImpl);
  } catch (e: any) {
    throw new PaymentNotSentError(e?.message || String(e), e instanceof PaymentReadError ? e.providerMessage : '');
  }
  const base = { api_version: before.api_version, budget: plan.target.budget, field: 'total_amount_micros', from: plan.from, to: plan.to };
  const check = googleExecutionCheck(before, plan, now);
  if (check.atTarget) {
    return {
      outcome: 'unknown',
      error: `the campaign's total budget is already ${plan.to} micros (the target) — it was changed outside this request; check Google Ads and record the result`,
      response: { ...base, observed: plan.to, sent: false },
    };
  }
  if (check.blocker) throw new PaymentNotSentError(check.blocker);

  let reply: ProviderReply;
  try {
    reply = await providerRequest({
      url: `${ADS_HOST}/${before.api_version}/customers/${target.customer_id}/campaignBudgets:mutate`,
      method: 'POST',
      headers: adsHeaders(cred, token),
      body: JSON.stringify({
        operations: [{ update: { resourceName: plan.target.budget, totalAmountMicros: plan.to }, updateMask: 'totalAmountMicros' }],
        partialFailure: false,
        validateOnly: false,
        responseContentType: 'MUTABLE_RESOURCE',
      }),
      timeoutMs: WRITE_TIMEOUT_MS,
      fetchImpl: opts.fetchImpl,
    });
  } catch (e: any) {
    return {
      outcome: 'unknown',
      error: `Google Ads ${e instanceof ProviderTransportError && e.timedOut ? 'did not answer in time' : 'could not be reached'} after the budget change was sent — it may or may not have been applied (change history can take ~3 minutes to show it)`,
      response: { ...base, sent: true, network_error: true },
    };
  }
  const err = googleError(reply, cred, token);
  if (reply.status === 401) tokenCache.delete(fingerprint);
  const verdict = classifyGoogleWrite(reply, plan, err.adsFailure);
  const response = {
    ...base, sent: true, status: reply.status,
    ...(err.requestId ? { request_id: err.requestId } : {}),
    ...(verdict !== 'ok' && err.message ? { message_untrusted: err.message } : {}),
  };
  if (verdict === 'ok') {
    return {
      outcome: 'paid',
      transaction_id: `google_ads:${plan.target.budget}:total_amount_micros=${plan.to}${err.requestId ? ` (request ${err.requestId})` : ''}`.slice(0, 200),
      receipt_url: '',
      response,
    };
  }
  if (verdict === 'failed') {
    try {
      const after = await observeGoogleTarget(target, cred, fingerprint, opts);
      if (after.budget.total_micros !== null && after.budget.total_micros.toString() === plan.to) {
        return { outcome: 'unknown', error: `Google Ads refused the change (${err.text}) but the total budget now reads ${plan.to} micros — check Google Ads`, response: { ...response, observed: plan.to } };
      }
    } catch {
      /* 다시 읽지 못해도 거절 응답은 그대로다 */
    }
    return { outcome: 'failed', error: `Google Ads refused the budget change (${err.text})`, response };
  }
  return { outcome: 'unknown', error: `Google Ads answered ${err.text} — the budget change may or may not have been applied`, response };
}

/** micros 를 사람이 읽는 금액으로 — 최소 단위로 떨어지지 않으면 micros 그대로. */
export function microsText(micros: bigint, currency: string): string {
  try {
    return formatMinorAmount(Number(googleMicrosToMinor(micros, currency)), currency);
  } catch {
    return `${micros.toString()} micros`;
  }
}
