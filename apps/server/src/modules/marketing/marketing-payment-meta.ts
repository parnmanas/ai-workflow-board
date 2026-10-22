/**
 * Meta Ads 직접 결제 어댑터 — 캠페인 `spend_cap` 을 compare-and-set 으로 올린다(docs/marketing.md "직접 결제 어댑터").
 *
 * Meta 가 문서화한 캠페인 단위의 고정 상한은 `spend_cap` 하나다("will not spend more than this cap"). 일 예산은 하루 1.75배 ·
 * 주 7배 · 예산 일정 8배까지 쓰이므로 건드리지 않는다. 한도가 없는 캠페인은 거부한다 — 처음 한도는 사람이 Ads Manager 에서
 * 정하고, AWB 는 있는 한도를 승인 금액만큼 올리기만 한다.
 *
 * Graph API 에는 조건부 쓰기 · 멱등 키가 없다. 그래서 실행 직전에 다시 읽어 요청 때의 값(`from`)일 때만 절대값 `to` 를 쓴다 —
 * 같은 값을 다시 써도 결과가 같다. 토큰은 Authorization 헤더로만 보낸다(주소에 넣으면 로그 · 오류 문자열로 샌다).
 * `app_secret` 이 있으면 appsecret_proof 를 붙인다(앱 설정 "Require App Secret" 을 켜 둔 경우 필요).
 */
import { createHmac } from 'node:crypto';
import {
  PROVIDER_FORMATS,
  PaymentRuleError,
  buildCeilingPlan,
  cleanProviderText,
  isPaymentCurrencySupported,
  metaUnitsToMinor,
  parseProviderInt,
  paymentApiVersion,
  providerMessage,
  providerToken,
  type CeilingPlan,
  type MetaTarget,
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

const GRAPH_HOST = 'https://graph.facebook.com';
const READ_TIMEOUT_MS = 10_000;
const WRITE_TIMEOUT_MS = 20_000;

/** 이 값 이상의 `spend_cap` 은 "한도 없음" 이다(Meta 가 한도를 지우는 특수값). */
export const META_NO_SPEND_CAP = 922_337_203_685_478n;

/** 호출 제한 — 요청을 처리하기 전에 막는다. */
function isMetaThrottleCode(code: number): boolean {
  return [4, 17, 32, 341, 613].includes(code) || (code >= 80000 && code <= 80014);
}

/**
 * 거절이 분명한(아무것도 바뀌지 않은) Graph 오류 코드 — 잘못된 인자 · 토큰 · 권한 · 정책 차단 · 낡은 버전 · 호출 제한.
 * 1 · 2(알 수 없는 오류 · 일시 장애)와 이 밖의 코드는 unknown 이다.
 */
export function isMetaRefusalCode(code: number): boolean {
  return [100, 102, 190, 10, 368, 2635, 801].includes(code) || (code >= 200 && code <= 299) || isMetaThrottleCode(code);
}

export interface MetaCredential {
  access_token: string;
  app_secret: string;
}

export function readMetaCredential(fields: Record<string, string>): MetaCredential {
  const accessToken = fields.access_token || '';
  if (!accessToken) throw marketingError(400, 'Meta Ads credential needs an "access_token" field (a system user token with ads_management)');
  return { access_token: accessToken, app_secret: fields.app_secret || '' };
}

function secretsOf(cred: MetaCredential): string[] {
  return [cred.access_token, cred.app_secret, cred.app_secret ? appSecretProof(cred) : ''];
}

function appSecretProof(cred: MetaCredential): string {
  return createHmac('sha256', cred.app_secret).update(cred.access_token, 'utf8').digest('hex');
}

function graphUrl(version: string, path: string, params: Record<string, string>): string {
  const url = new URL(`${GRAPH_HOST}/${version}/${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return url.toString();
}

/**
 * Graph 오류 — `text` 는 상태 · 오류 코드만(에이전트까지 가는 오류 문장에 쓴다), `message` 는 공급자가 준 글을 정리하고 비밀 값을
 * 지운 것(사람용 요약에 `message_untrusted` 로만 싣는다).
 */
function graphErrorText(reply: ProviderReply, cred: MetaCredential): { text: string; message: string; code: number | null; transient: boolean; fbtrace: string } {
  const err = reply.json && typeof reply.json === 'object' ? reply.json.error : null;
  const code = err && Number.isInteger(err.code) ? Number(err.code) : null;
  const sub = err && Number.isInteger(err.error_subcode) ? `/${err.error_subcode}` : '';
  return {
    text: `HTTP ${reply.status}${code !== null ? `, code ${code}${sub}` : ''}`,
    message: providerMessage(err?.message || reply.text || '', secretsOf(cred), 300),
    code,
    transient: err?.is_transient === true,
    fbtrace: providerToken(err?.fbtrace_id, PROVIDER_FORMATS.traceId),
  };
}

export async function graphGet(path: string, fields: string, cred: MetaCredential, opts: { fetchImpl?: typeof fetch; version: string; params?: Record<string, string> }): Promise<any> {
  const params: Record<string, string> = { fields, ...opts.params };
  if (cred.app_secret) params.appsecret_proof = appSecretProof(cred);
  let reply: ProviderReply;
  try {
    reply = await providerRequest({
      url: graphUrl(opts.version, path, params),
      method: 'GET',
      headers: { authorization: `Bearer ${cred.access_token}`, accept: 'application/json' },
      timeoutMs: READ_TIMEOUT_MS,
      fetchImpl: opts.fetchImpl,
    });
  } catch (e) {
    if (e instanceof ProviderTransportError) throw new PaymentReadError(`could not read Meta ${path}: ${e.message}`, true);
    throw e;
  }
  if (reply.status >= 200 && reply.status < 300 && reply.json && typeof reply.json === 'object' && !reply.json.error) return reply.json;
  const err = graphErrorText(reply, cred);
  const retryable = reply.status >= 500 || err.code === 1 || err.code === 2 || (err.code !== null && isMetaThrottleCode(err.code)) || err.transient;
  throw new PaymentReadError(`could not read Meta ${path} (${err.text})`, retryable, err.message);
}

/** 대상의 지금 상태 — 읽기만 한다(요청 때 · 연결 확인 · 실행 직전 대조가 같은 코드를 쓴다). */
export interface MetaObservation {
  api_version: string;
  campaign: {
    id: string;
    name: string;
    account_id: string;
    status: string;
    effective_status: string;
    buying_type: string;
    /** null = 한도 없음. */
    spend_cap: bigint | null;
  };
  account: {
    currency: string;
    account_status: number | null;
    disable_reason: number | null;
    /** 계정의 캠페인 spend_cap 최솟값(offset 단위), 모르면 null. */
    min_spend_cap: bigint | null;
  };
}

function optionalInt(value: unknown): number | null {
  const n = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  return typeof n === 'number' && Number.isInteger(n) ? n : null;
}

/** `spend_cap` 이 없거나 "", "0", 특수값 이상이면 한도 없음. 숫자가 아닌 값은 오류 — 0 으로 읽으면 안 된다. */
export function parseMetaSpendCap(value: unknown): bigint | null {
  if (value === undefined || value === null || value === '' || value === '0' || value === 0) return null;
  const n = parseProviderInt(value, 'Meta spend_cap');
  return n >= META_NO_SPEND_CAP ? null : n;
}

export async function observeMetaTarget(
  target: MetaTarget,
  cred: MetaCredential,
  opts: { fetchImpl?: typeof fetch; env?: Record<string, string | undefined> } = {},
): Promise<MetaObservation> {
  const version = paymentApiVersion('meta_ads', opts.env);
  const campaign = await graphGet(target.campaign_id, 'id,name,account_id,status,effective_status,buying_type,spend_cap', cred, { ...opts, version });
  const account = await graphGet(`act_${target.ad_account_id}`, 'currency,account_status,disable_reason,min_campaign_group_spend_cap', cred, { ...opts, version });
  let spendCap: bigint | null;
  let minCap: bigint | null;
  try {
    spendCap = parseMetaSpendCap(campaign.spend_cap);
    minCap = account.min_campaign_group_spend_cap === undefined || account.min_campaign_group_spend_cap === null || account.min_campaign_group_spend_cap === ''
      ? null
      : parseProviderInt(account.min_campaign_group_spend_cap, 'Meta min_campaign_group_spend_cap');
  } catch (e: any) {
    throw new PaymentReadError(`Meta answered an unexpected value: ${e?.message || e}`, false);
  }
  // 형식이 정해진 값은 형식에 맞을 때만 받는다(아니면 '' — 계정 · 통화 대조에서 걸린다). 이름만 자유 글이다(비신뢰 표시용).
  return {
    api_version: version,
    campaign: {
      id: providerToken(campaign.id, PROVIDER_FORMATS.digits),
      name: cleanProviderText(campaign.name, 200),
      account_id: providerToken(String(campaign.account_id ?? '').replace(/^act_/, ''), PROVIDER_FORMATS.digits),
      status: providerToken(campaign.status, PROVIDER_FORMATS.enumName),
      effective_status: providerToken(campaign.effective_status, PROVIDER_FORMATS.enumName),
      buying_type: providerToken(campaign.buying_type, PROVIDER_FORMATS.enumName),
      spend_cap: spendCap,
    },
    account: {
      currency: providerToken(typeof account.currency === 'string' ? account.currency.toUpperCase() : '', PROVIDER_FORMATS.currency),
      account_status: optionalInt(account.account_status),
      disable_reason: optionalInt(account.disable_reason),
      min_spend_cap: minCap,
    },
  };
}

/** 한도를 올릴 수 없는 이유(사람이 고쳐야 한다). 비면 통과. 계획 · 연결 확인 · 실행 직전 대조가 같은 규칙을 쓴다. */
export function metaTargetProblems(obs: MetaObservation, target: MetaTarget, currency: string): string[] {
  const out: string[] = [];
  if (obs.campaign.account_id !== target.ad_account_id) {
    out.push(`Meta campaign ${target.campaign_id} belongs to ad account act_${obs.campaign.account_id || '?'}, not act_${target.ad_account_id}`);
  }
  if (!isPaymentCurrencySupported(currency)) out.push(`currency ${currency} is not supported by the Meta adapter`);
  if (obs.account.currency !== currency) out.push(`the ad account's currency is ${obs.account.currency || '?'}, the campaign's is ${currency}`);
  if (obs.account.account_status !== 1) out.push(`the ad account is not active (account_status ${obs.account.account_status ?? '?'})`);
  if (obs.account.disable_reason !== null && obs.account.disable_reason !== 0) out.push(`the ad account is disabled (disable_reason ${obs.account.disable_reason})`);
  if (['DELETED', 'ARCHIVED'].includes(obs.campaign.status)) out.push(`the Meta campaign is ${obs.campaign.status.toLowerCase()}`);
  if (obs.campaign.buying_type && obs.campaign.buying_type !== 'AUCTION') out.push(`spend_cap is only available for auction campaigns (buying_type ${obs.campaign.buying_type})`);
  if (obs.campaign.spend_cap === null) {
    out.push('the Meta campaign has no spend cap — a person sets the first cap in Ads Manager (at least what it has spent); AWB only raises an existing cap');
  }
  return out;
}

export function buildMetaPlan(
  obs: MetaObservation,
  target: MetaTarget,
  amountMinor: number,
  currency: string,
  fingerprint: string,
): CeilingPlan {
  const problems = metaTargetProblems(obs, target, currency);
  if (problems.length) throw new PaymentRuleError(problems.join('; '));
  const plan = buildCeilingPlan({
    provider: 'meta_ads',
    target: { ad_account_id: target.ad_account_id, campaign_id: target.campaign_id },
    targetName: obs.campaign.name,
    currency,
    fromUnits: obs.campaign.spend_cap!,
    amountMinor,
    credentialFingerprint: fingerprint,
  });
  const to = BigInt(plan.to);
  // 금액에 달린 거절은 400 — 금액을 바꿔 다시 물을 수 있다(요청 백오프 대상이 아니다).
  if (to >= META_NO_SPEND_CAP) throw new PaymentRuleError('the raised spend cap would reach Meta\'s "no cap" value', 400);
  if (obs.account.min_spend_cap !== null && to < obs.account.min_spend_cap) {
    const min = formatMinorAmount(Number(metaUnitsToMinor(obs.account.min_spend_cap, currency)), currency);
    // 금액을 키우면 풀린다 — 400(요청 백오프 대상이 아니다).
    throw new PaymentRuleError(`the raised spend cap is below the ad account's minimum campaign spend cap (${min})`, 400);
  }
  return plan;
}

/** 실행 직전 대조 — 요청 때와 같은 대상 · 통화 · 상태이고 값이 from 인가. */
export function metaExecutionCheck(obs: MetaObservation, plan: CeilingPlan): { blocker: string | null; atTarget: boolean } {
  const target = { ad_account_id: plan.target.ad_account_id, campaign_id: plan.target.campaign_id };
  const current = obs.campaign.spend_cap;
  const problems = metaTargetProblems(obs, target, plan.currency).filter((p) => !p.startsWith('the Meta campaign has no spend cap'));
  if (problems.length) return { blocker: `the target changed since the request: ${problems.join('; ')}`, atTarget: false };
  if (current === null) return { blocker: 'the Meta campaign no longer has a spend cap', atTarget: false };
  if (current.toString() === plan.to) return { blocker: null, atTarget: true };
  if (current.toString() !== plan.from) {
    return { blocker: `spend_cap changed since the request (expected ${plan.from}, found ${current.toString()}) — nothing was changed`, atTarget: false };
  }
  return { blocker: null, atTarget: false };
}

/** 쓰기 응답의 분류. 2xx 는 `{"success":true}` 일 때만 확정이다. */
export function classifyMetaWrite(reply: { status: number; json: any }): { outcome: 'ok' | 'failed' | 'unknown'; code: number | null } {
  if (reply.status >= 200 && reply.status < 300) {
    return { outcome: reply.json && reply.json.success === true ? 'ok' : 'unknown', code: null };
  }
  const err = reply.json && typeof reply.json === 'object' ? reply.json.error : null;
  const code = err && Number.isInteger(err.code) ? Number(err.code) : null;
  if (reply.status >= 500 || code === null) return { outcome: 'unknown', code };
  if (!isMetaRefusalCode(code)) return { outcome: 'unknown', code };
  // 일시 오류라고 표시된 것은 처리 중에 끊겼을 수 있다 — 호출 제한(처리 전에 막힘)만 거절로 본다.
  if (err.is_transient === true && !isMetaThrottleCode(code)) return { outcome: 'unknown', code };
  return { outcome: 'failed', code };
}

export function metaReceiptUrl(plan: CeilingPlan): string {
  return `https://adsmanager.facebook.com/adsmanager/manage/campaigns?act=${plan.target.ad_account_id}&selected_campaign_ids=${plan.target.campaign_id}`;
}

/**
 * 실행 — 다시 읽고(from 이 아니면 보내지 않음) → spend_cap 하나만 쓰고 → 분류한다. 쓰기 전의 실패는 PaymentNotSentError,
 * 쓴 뒤의 모호함은 unknown 이다. failed 로 분류돼도 한 번 다시 읽어 이미 to 이면 unknown 으로 둔다(거절이라던 쓰기가 실제로는
 * 반영됐다면 예산을 풀면 안 된다).
 */
export async function executeMetaPlan(
  plan: CeilingPlan,
  cred: MetaCredential,
  opts: { fetchImpl?: typeof fetch; env?: Record<string, string | undefined> } = {},
): Promise<PaymentOutcome> {
  const target = { ad_account_id: plan.target.ad_account_id, campaign_id: plan.target.campaign_id };
  let before: MetaObservation;
  try {
    before = await observeMetaTarget(target, cred, opts);
  } catch (e: any) {
    throw new PaymentNotSentError(e?.message || String(e), e instanceof PaymentReadError ? e.providerMessage : '');
  }
  const base = { api_version: before.api_version, campaign_id: target.campaign_id, field: 'spend_cap', from: plan.from, to: plan.to };
  const check = metaExecutionCheck(before, plan);
  if (check.atTarget) {
    return {
      outcome: 'unknown',
      error: `the Meta campaign's spend_cap is already ${plan.to} (the target) — it was changed outside this request; check Ads Manager and record the result`,
      response: { ...base, observed: plan.to, sent: false },
    };
  }
  if (check.blocker) throw new PaymentNotSentError(check.blocker);

  const form = new URLSearchParams({ spend_cap: plan.to });
  if (cred.app_secret) form.set('appsecret_proof', appSecretProof(cred));
  let reply: ProviderReply;
  try {
    reply = await providerRequest({
      url: `${GRAPH_HOST}/${before.api_version}/${target.campaign_id}`,
      method: 'POST',
      headers: {
        authorization: `Bearer ${cred.access_token}`,
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
      },
      body: form.toString(),
      timeoutMs: WRITE_TIMEOUT_MS,
      fetchImpl: opts.fetchImpl,
    });
  } catch (e: any) {
    return {
      outcome: 'unknown',
      error: `Meta ${e instanceof ProviderTransportError && e.timedOut ? 'did not answer in time' : 'could not be reached'} after the spend_cap change was sent — it may or may not have been applied`,
      response: { ...base, sent: true, network_error: true },
    };
  }
  const verdict = classifyMetaWrite(reply);
  const err = graphErrorText(reply, cred);
  const response = {
    ...base, sent: true, status: reply.status,
    ...(err.code !== null ? { error_code: err.code } : {}),
    ...(err.fbtrace ? { fbtrace_id: err.fbtrace } : {}),
    ...(verdict.outcome !== 'ok' && err.message ? { message_untrusted: err.message } : {}),
  };
  if (verdict.outcome === 'ok') {
    return {
      outcome: 'paid',
      transaction_id: `meta_ads:act_${target.ad_account_id}/${target.campaign_id}:spend_cap=${plan.to}`,
      receipt_url: metaReceiptUrl(plan),
      response,
    };
  }
  if (verdict.outcome === 'failed') {
    // 안전망: 거절이라던 쓰기가 실제로 반영됐는지 한 번 본다.
    try {
      const after = await observeMetaTarget(target, cred, opts);
      if (after.campaign.spend_cap !== null && after.campaign.spend_cap.toString() === plan.to) {
        return { outcome: 'unknown', error: `Meta refused the change (${err.text}) but the spend_cap now reads ${plan.to} — check Ads Manager`, response: { ...response, observed: plan.to } };
      }
    } catch {
      /* 다시 읽지 못해도 거절 응답은 그대로다 */
    }
    return { outcome: 'failed', error: `Meta refused the spend_cap change (${err.text})`, response };
  }
  return { outcome: 'unknown', error: `Meta answered ${err.text} — the spend_cap change may or may not have been applied`, response };
}
