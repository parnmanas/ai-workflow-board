/**
 * Stripe Issuing 직접 결제 어댑터 — 승인 금액이 누적 한도인 가상 카드를 한 장 만든다(docs/marketing.md "직접 결제 어댑터" → "카드").
 *
 * 2단계 발급: 카드를 **비활성**으로 만들고(한도 · 업종 · 일회용 · metadata 는 만들 때 정한다) 계획과 대조한 뒤 활성화한다. 그래서
 *   - 만든 카드가 계획과 다르거나 활성화가 거절되면, 쓰이기 전에 해지하고 failed 로 둔다(한 번도 쓸 수 없었던 카드다).
 *   - 결과가 모호한 생성(5xx · 시간 초과)으로 생겼을지 모르는 카드, Stripe 장애 복구로 나중에 생긴 카드도 비활성이라 쓸 수 없다.
 * 멱등 키는 요청마다 고정이다(`awb-spend-<id>`, `-activate`, `-cancel`) — Stripe 는 최소 24시간 보관하고 같은 키에는 첫 응답을
 * 돌려준다. 자동으로 다시 보내지 않는다(실행은 executing CAS 한 번).
 *
 * 카드 번호 · CVC 는 절대 가져오지 않는다(expand[]=number 를 쓰지 않는다 — PCI). 사람은 Stripe 대시보드에서 본다. Stripe 응답에 박혀
 * 오는 카드 소지자(이름 · 주소 · 연락처)는 읽지 않는다 — id 만. 공급자 글은 Stripe 오류 객체의 `error.message` 만, 비밀을 지워
 * `message_untrusted` 로 남긴다(응답 본문 전체는 어디에도 저장하지 않는다).
 */
import {
  PROVIDER_FORMATS,
  PaymentRuleError,
  STRIPE_SINGLE_USE_MAX_MINOR,
  buildCardPlan,
  cleanProviderText,
  normalizeCardCategories,
  paymentApiVersion,
  providerMessage,
  providerToken,
  stripeCardAmount,
  stripeKeyMode,
  type CardPlan,
  type PayeeLike,
  type StripeTarget,
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

const API_HOST = 'https://api.stripe.com';
const READ_TIMEOUT_MS = 10_000;
const WRITE_TIMEOUT_MS = 20_000;
/** 요청의 카드는 실행 시각 ±1일 안에서 찾는다(카드 목록에는 metadata 검색이 없다). */
const SCAN_WINDOW_MS = 24 * 60 * 60_000;
/** 그 범위를 100장씩 이만큼 넘겨 본다 — 넘으면 "못 다 봄"(없음으로 읽지 않는다). */
const SCAN_MAX_PAGES = 10;
/** 카드에 붙이는 metadata 키 — 요청과 카드를 잇는 유일한 표시다(개인정보는 넣지 않는다). */
export const STRIPE_REQUEST_METADATA_KEY = 'awb_spend_request_id';
/**
 * 실행 시작에서 이만큼 지나면 카드를 만들지도 활성화하지도 않는다(만든 카드는 해지한다). 멈췄다 깨어난 실행이 늦게 카드를 살리면, 그 사이
 * 요청은 결과 불명(10분)이 되고 사람이 "카드 없음" 을 보고 실패로 닫았을 수 있다(유예 15분) — 예산 밖의 카드가 된다.
 */
export const STRIPE_ACTIVATE_WITHIN_MS = 5 * 60_000;

export interface StripeCredential {
  secret_key: string;
  mode: 'live' | 'test';
}

export function readStripeCredential(fields: Record<string, string>): StripeCredential {
  const key = fields.secret_key || '';
  if (!key) throw marketingError(400, 'Stripe Issuing credential needs a "secret_key" field (a restricted key with Issuing Cards: Write and Issuing Cardholders: Read)');
  try {
    return { secret_key: key, mode: stripeKeyMode(key) };
  } catch (e) {
    if (e instanceof PaymentRuleError) throw marketingError(400, e.message);
    throw e;
  }
}

function headers(cred: StripeCredential, version: string, extra: Record<string, string> = {}): Record<string, string> {
  return { authorization: `Bearer ${cred.secret_key}`, 'stripe-version': version, accept: 'application/json', ...extra };
}

export function stripeDashboardCardUrl(cardId: string, livemode: boolean): string {
  return `https://dashboard.stripe.com/${livemode ? '' : 'test/'}issuing/cards/${encodeURIComponent(cardId)}`;
}

/**
 * Stripe 오류 — `text` 는 상태 · type · code 만(에이전트까지 가는 문장에 쓴다), `message` 는 Stripe 오류 객체의 글만 비밀을 지운 것.
 * 오류 객체가 아닌 본문(프록시 · HTML)은 읽지 않는다 — 그런 응답은 Stripe 의 답이 아니다(`isStripeError` false).
 */
function stripeError(reply: ProviderReply, cred: StripeCredential): {
  text: string; message: string; type: string; code: string; isStripeError: boolean; requestId: string;
} {
  const err = reply.json && typeof reply.json === 'object' && reply.json.error && typeof reply.json.error === 'object' ? reply.json.error : null;
  const type = providerToken(err?.type, PROVIDER_FORMATS.stripeCode);
  const code = providerToken(err?.code, PROVIDER_FORMATS.stripeCode);
  return {
    text: `HTTP ${reply.status}${type ? ` ${type}` : ''}${code ? ` (${code})` : ''}`,
    message: err ? providerMessage(err.message, [cred.secret_key], 300) : '',
    type,
    code,
    isStripeError: !!type,
    requestId: providerToken(reply.header('request-id'), PROVIDER_FORMATS.traceId),
  };
}

/** 아무것도 하지 않았음이 분명한 거절 — Stripe 오류 객체가 붙은 400 · 401 · 402 · 403 · 404 · 429(멱등 키 충돌은 제외). */
export function isDefiniteStripeRefusal(status: number, err: { isStripeError: boolean; type: string }): boolean {
  return err.isStripeError && err.type !== 'idempotency_error' && [400, 401, 402, 403, 404, 429].includes(status);
}

/** 읽기. `missingIsNull` 이면 Stripe 가 "없음"(404 resource_missing 오류 객체)으로 답할 때 null — 그 밖의 실패는 PaymentReadError. */
async function stripeGet(
  path: string,
  query: Record<string, string>,
  label: string,
  cred: StripeCredential,
  opts: { fetchImpl?: typeof fetch; version: string; missingIsNull?: boolean },
): Promise<any> {
  const url = new URL(`${API_HOST}${path}`);
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  let reply: ProviderReply;
  try {
    reply = await providerRequest({ url: url.toString(), method: 'GET', headers: headers(cred, opts.version), timeoutMs: READ_TIMEOUT_MS, fetchImpl: opts.fetchImpl });
  } catch (e) {
    if (e instanceof ProviderTransportError) throw new PaymentReadError(`could not read Stripe ${label}: ${e.message}`, true);
    throw e;
  }
  if (reply.status === 200 && reply.json && typeof reply.json === 'object' && !reply.json.error) return reply.json;
  const err = stripeError(reply, cred);
  if (opts.missingIsNull && reply.status === 404 && err.isStripeError && err.code === 'resource_missing') return null;
  const retryable = reply.status >= 500 || reply.status === 429 || reply.status === 409;
  throw new PaymentReadError(`could not read Stripe ${label} (${err.text})`, retryable, err.message);
}

type PostResult = { kind: 'reply'; reply: ProviderReply } | { kind: 'transport'; timedOut: boolean };

async function stripePost(path: string, form: URLSearchParams, idempotencyKey: string, cred: StripeCredential, opts: { fetchImpl?: typeof fetch; version: string }): Promise<PostResult> {
  try {
    const reply = await providerRequest({
      url: `${API_HOST}${path}`,
      method: 'POST',
      headers: headers(cred, opts.version, { 'content-type': 'application/x-www-form-urlencoded', 'idempotency-key': idempotencyKey }),
      body: form.toString(),
      timeoutMs: WRITE_TIMEOUT_MS,
      fetchImpl: opts.fetchImpl,
    });
    return { kind: 'reply', reply };
  } catch (e) {
    if (e instanceof ProviderTransportError) return { kind: 'transport', timedOut: e.timedOut };
    // 보내는 도중의 예외는 나갔는지 모른다 — 호출한 쪽이 unknown 으로 둔다.
    return { kind: 'transport', timedOut: false };
  }
}

// ── 카드 소지자 ───────────────────────────────────────────────────────────

/** 카드 소지자의 지금 상태 — 읽기만 한다(요청 때 · 연결 확인 · 실행 직전이 같은 코드를 쓴다). 이름은 사람만 보는 연결 확인용이다. */
export interface StripeCardholderObservation {
  api_version: string;
  id: string;
  status: string;
  type: string;
  livemode: boolean | null;
  disabled_reason: string;
  past_due: number;
  name_untrusted: string;
}

export async function observeStripeCardholder(
  target: StripeTarget,
  cred: StripeCredential,
  opts: { fetchImpl?: typeof fetch; env?: Record<string, string | undefined> } = {},
): Promise<StripeCardholderObservation> {
  const version = paymentApiVersion('stripe_issuing', opts.env);
  const body = await stripeGet(`/v1/issuing/cardholders/${encodeURIComponent(target.cardholder)}`, {}, `cardholder ${target.cardholder}`, cred, { fetchImpl: opts.fetchImpl, version });
  const req = body.requirements && typeof body.requirements === 'object' ? body.requirements : {};
  return {
    api_version: version,
    id: providerToken(body.id, PROVIDER_FORMATS.stripeId),
    status: providerToken(body.status, PROVIDER_FORMATS.stripeCode),
    type: providerToken(body.type, PROVIDER_FORMATS.stripeCode),
    livemode: typeof body.livemode === 'boolean' ? body.livemode : null,
    disabled_reason: req.disabled_reason === null || req.disabled_reason === undefined || req.disabled_reason === ''
      ? ''
      : providerToken(req.disabled_reason, /^[a-z][a-z0-9_.]{0,59}$/) || 'unrecognized',
    past_due: Array.isArray(req.past_due) ? req.past_due.length : 0,
    name_untrusted: cleanProviderText(body.name, 80),
  };
}

/** 카드를 만들 수 없는 이유(사람이 고쳐야 한다). 비면 통과. */
export function stripeCardholderProblems(obs: StripeCardholderObservation, target: StripeTarget, cred: StripeCredential): string[] {
  const out: string[] = [];
  if (obs.id !== target.cardholder) out.push('Stripe answered for a different cardholder');
  if (obs.status !== 'active') out.push(`the cardholder is ${obs.status || 'not active'} — a person activates it in the Stripe Dashboard`);
  if (obs.disabled_reason) out.push(`the cardholder is disabled (${obs.disabled_reason})`);
  if (obs.past_due > 0) out.push(`the cardholder has ${obs.past_due} past-due requirement(s) — a person completes them in the Stripe Dashboard`);
  const keyLive = cred.mode === 'live';
  if (obs.livemode !== keyLive) {
    out.push(`the key is a ${keyLive ? 'live' : 'sandbox'} key but the cardholder is ${obs.livemode === null ? 'of unknown mode' : obs.livemode ? 'a live cardholder' : 'a sandbox cardholder'}`);
  }
  return out;
}

/** 요청 때 금액 확인(네트워크 없음): 통화는 카드 통화(409), 일회용 카드는 승인 한 건 최대 이하, 수취인의 카드당 최대 이하(400). */
export function checkStripeAmount(amountMinor: number, currency: string, payee: PayeeLike | undefined): void {
  stripeCardAmount(amountMinor, currency);
  payee = payee || { name: '' };
  if (payee.card_single_use !== false && amountMinor > STRIPE_SINGLE_USE_MAX_MINOR) {
    throw new PaymentRuleError(`a single-use card can carry at most ${formatMinorAmount(STRIPE_SINGLE_USE_MAX_MINOR, currency)} (one authorization) — ask for a smaller amount`, 400);
  }
  if (typeof payee.card_max_minor === 'number' && amountMinor > payee.card_max_minor) {
    throw new PaymentRuleError(`the payee's per-card maximum is ${formatMinorAmount(payee.card_max_minor, currency)} — ask for at most that`, 400);
  }
}

export function buildStripePlan(
  obs: StripeCardholderObservation,
  target: StripeTarget,
  payee: PayeeLike,
  amountMinor: number,
  currency: string,
  fingerprint: string,
  cred: StripeCredential,
): CardPlan {
  const problems = stripeCardholderProblems(obs, target, cred);
  if (problems.length) throw new PaymentRuleError(problems.join('; '));
  return buildCardPlan({
    target,
    currency,
    amountMinor,
    singleUse: payee.card_single_use !== false,
    categories: normalizeCardCategories(payee.card_categories),
    livemode: cred.mode === 'live',
    credentialFingerprint: fingerprint,
  });
}

// ── 카드 ──────────────────────────────────────────────────────────────────

/** 카드 한 장의 사람용 요약 — 번호 · 소지자 정보는 담지 않는다. */
export interface IssuedCardView {
  id: string;
  status: string;
  currency: string;
  /** 누적(all_time) 한도, 없으면 null. */
  limit_minor: number | null;
  single_use: boolean;
  livemode: boolean | null;
  created: number | null;
}

function readCard(card: any): IssuedCardView {
  const limits = Array.isArray(card?.spending_controls?.spending_limits) ? card.spending_controls.spending_limits : [];
  const allTime = limits.find((l: any) => l && l.interval === 'all_time' && (!l.categories || (Array.isArray(l.categories) && !l.categories.length)));
  const amount = allTime ? Number(allTime.amount) : NaN;
  return {
    id: providerToken(card?.id, PROVIDER_FORMATS.stripeId),
    status: providerToken(card?.status, PROVIDER_FORMATS.stripeCode),
    currency: providerToken(typeof card?.currency === 'string' ? card.currency.toUpperCase() : '', PROVIDER_FORMATS.currency),
    limit_minor: Number.isSafeInteger(amount) && amount >= 0 ? amount : null,
    single_use: card?.lifecycle_controls?.cancel_after?.payment_count === 1,
    livemode: typeof card?.livemode === 'boolean' ? card.livemode : null,
    created: Number.isSafeInteger(card?.created) ? card.created : null,
  };
}

/**
 * Stripe 가 돌려준 카드가 계획과 같은가 — 다른 항목 이름 목록(비면 같다). 우리 누적 한도가 있으면 다른 한도는 더 좁힐 뿐이라
 * (한도는 모두 함께 걸린다) 받는다. 업종은 집합으로 비교한다. `expectId` 를 주면 그 카드여야 한다(활성화 응답).
 */
export function cardMismatches(card: any, plan: CardPlan, requestId: string, expectStatus: 'inactive' | 'active', expectId?: string): string[] {
  if (!card || typeof card !== 'object' || card.object !== 'issuing.card') return ['object'];
  const out: string[] = [];
  const id = providerToken(card.id, PROVIDER_FORMATS.stripeId);
  if (!id || (expectId !== undefined && id !== expectId)) out.push('id');
  const cardholderId = typeof card.cardholder === 'string' ? card.cardholder : card.cardholder?.id;
  if (cardholderId !== plan.target.cardholder) out.push('cardholder');
  if (typeof card.currency !== 'string' || card.currency.toUpperCase() !== plan.currency) out.push('currency');
  if (card.type !== 'virtual') out.push('type');
  if (card.status !== expectStatus) out.push('status');
  if (card.livemode !== plan.livemode) out.push('livemode');
  if (card.metadata?.[STRIPE_REQUEST_METADATA_KEY] !== requestId) out.push('metadata');
  const controls = card.spending_controls && typeof card.spending_controls === 'object' ? card.spending_controls : {};
  const limits = Array.isArray(controls.spending_limits) ? controls.spending_limits : [];
  const ours = limits.some((l: any) => l && l.interval === 'all_time' && Number(l.amount) === plan.limit_minor
    && (!l.categories || (Array.isArray(l.categories) && !l.categories.length)));
  if (!ours) out.push('spending_limits');
  const limitsCurrency = controls.spending_limits_currency;
  if (limitsCurrency !== null && limitsCurrency !== undefined && String(limitsCurrency).toUpperCase() !== plan.currency) out.push('spending_limits_currency');
  const allowed = Array.isArray(controls.allowed_categories) ? controls.allowed_categories.map((c: unknown) => String(c)).sort() : [];
  if (allowed.join(',') !== plan.allowed_categories.join(',')) out.push('allowed_categories');
  if (Array.isArray(controls.blocked_categories) && controls.blocked_categories.length) out.push('blocked_categories');
  const paymentCount = card.lifecycle_controls?.cancel_after?.payment_count;
  if (plan.single_use ? paymentCount !== 1 : paymentCount !== undefined && paymentCount !== null) out.push('lifecycle_controls');
  return out;
}

export interface CardScan {
  /** found: 이 요청의 카드가 있다 · none: 범위를 다 봤고 없다 · incomplete: 범위를 다 보지 못했다(없음으로 읽지 않는다). */
  result: 'found' | 'none' | 'incomplete';
  cards: IssuedCardView[];
  api_version: string;
}

/**
 * 이 요청의 카드 찾기(읽기만) — 카드 목록에는 metadata 검색이 없어, 그 카드 소지자의 가상 카드를 `around` ±1일 범위에서 넘겨 보며
 * metadata 의 요청 id 를 찾는다(목록은 바로 일관). `knownCardId`(실행이 받아 둔 카드 id)는 목록에 안 보여도 직접 읽는다 — 이 요청이
 * 만든 카드다(metadata 가 다르게 돌아왔어도).
 *
 * "없음" 은 범위를 끝까지, 모든 항목을 읽었을 때만이다 — 목록 모양이 아닌 답은 PaymentReadError, 읽지 못한 항목이 있거나 더 있다는데
 * 넘길 곳이 없거나 쪽 수를 넘기면 incomplete 다. 없음은 사람의 확인 없이 실패 기록(예산 해제)을 허락하기 때문이다.
 */
export async function findCardsForRequest(
  target: StripeTarget,
  cred: StripeCredential,
  requestId: string,
  around: Date,
  opts: { fetchImpl?: typeof fetch; env?: Record<string, string | undefined>; knownCardId?: string } = {},
): Promise<CardScan> {
  const version = paymentApiVersion('stripe_issuing', opts.env);
  const io = { fetchImpl: opts.fetchImpl, version };
  const label = `cards of ${target.cardholder}`;
  const gte = Math.floor((around.getTime() - SCAN_WINDOW_MS) / 1000);
  const lte = Math.ceil((around.getTime() + SCAN_WINDOW_MS) / 1000);
  const cards: IssuedCardView[] = [];
  let complete = false;
  let unreadable = false;
  let startingAfter = '';
  for (let page = 0; page < SCAN_MAX_PAGES; page++) {
    const body = await stripeGet('/v1/issuing/cards', {
      cardholder: target.cardholder,
      type: 'virtual',
      'created[gte]': String(gte),
      'created[lte]': String(lte),
      limit: '100',
      ...(startingAfter ? { starting_after: startingAfter } : {}),
    }, label, cred, io);
    if (body.object !== 'list' || !Array.isArray(body.data) || typeof body.has_more !== 'boolean') {
      throw new PaymentReadError(`could not read Stripe ${label} (the answer is not a card list)`, true);
    }
    for (const card of body.data) {
      if (!card || typeof card !== 'object' || card.object !== 'issuing.card' || !providerToken(card.id, PROVIDER_FORMATS.stripeId)) {
        unreadable = true;
        continue;
      }
      if (card.metadata?.[STRIPE_REQUEST_METADATA_KEY] === requestId) cards.push(readCard(card));
    }
    if (!body.has_more) {
      complete = true;
      break;
    }
    const last = providerToken(body.data[body.data.length - 1]?.id, PROVIDER_FORMATS.stripeId);
    if (!last) break;
    startingAfter = last;
  }
  if (opts.knownCardId && !cards.some((c) => c.id === opts.knownCardId)) {
    const known = await stripeGet(`/v1/issuing/cards/${encodeURIComponent(opts.knownCardId)}`, {}, `card ${opts.knownCardId}`, cred, { ...io, missingIsNull: true });
    if (known !== null) {
      if (known.object !== 'issuing.card' || providerToken(known.id, PROVIDER_FORMATS.stripeId) !== opts.knownCardId) {
        throw new PaymentReadError(`could not read Stripe card ${opts.knownCardId} (the answer is not that card)`, true);
      }
      cards.push(readCard(known));
    }
  }
  const result = cards.length ? 'found' : complete && !unreadable ? 'none' : 'incomplete';
  return { result, cards, api_version: version };
}

/** 쓰이기 전의 카드를 해지한다(돌이킬 수 없다). 해지됐음을 확인하면 true. */
async function cancelCard(cardId: string, idem: string, cred: StripeCredential, opts: { fetchImpl?: typeof fetch; version: string }): Promise<boolean> {
  const result = await stripePost(`/v1/issuing/cards/${encodeURIComponent(cardId)}`, new URLSearchParams({ status: 'canceled' }), `${idem}-cancel`, cred, opts);
  return result.kind === 'reply' && result.reply.status === 200 && result.reply.json?.status === 'canceled';
}

/**
 * 실행 — 카드 소지자를 다시 확인하고(보내기 전 — 실패는 PaymentNotSentError) → 비활성 카드를 만들고 → 계획과 대조하고 → 활성화한다.
 * 만든 카드가 계획과 다르거나, 활성화가 거절되거나, 활성화된 카드가 계획과 다르거나, 실행 시작에서 STRIPE_ACTIVATE_WITHIN_MS 가 지났으면
 * 해지하고 failed, 해지하지 못하면 unknown 이다. 그 밖의 모호함은 unknown 이다. `startedAt` 은 요청이 executing 이 된 시각이다.
 */
export async function executeStripePlan(
  plan: CardPlan,
  cred: StripeCredential,
  requestId: string,
  opts: { fetchImpl?: typeof fetch; env?: Record<string, string | undefined>; startedAt?: Date; now?: () => Date } = {},
): Promise<PaymentOutcome> {
  const target = { cardholder: plan.target.cardholder };
  const version = paymentApiVersion('stripe_issuing', opts.env);
  const io = { fetchImpl: opts.fetchImpl, version };
  const base = { api_version: version, cardholder: target.cardholder, limit_minor: plan.limit_minor, single_use: plan.single_use, livemode: plan.livemode };
  const tooLate = () => !!opts.startedAt && (opts.now ? opts.now() : new Date()).getTime() - opts.startedAt.getTime() > STRIPE_ACTIVATE_WITHIN_MS;
  const lateText = `more than ${STRIPE_ACTIVATE_WITHIN_MS / 60_000} minutes passed since the execution started`;

  let holder: StripeCardholderObservation;
  try {
    holder = await observeStripeCardholder(target, cred, opts);
  } catch (e: any) {
    throw new PaymentNotSentError(e?.message || String(e), e instanceof PaymentReadError ? e.providerMessage : '');
  }
  const problems = stripeCardholderProblems(holder, target, cred);
  if (holder.livemode !== plan.livemode) problems.push('the live/sandbox mode changed since the request');
  if (problems.length) throw new PaymentNotSentError(`the cardholder changed since the request: ${problems.join('; ')}`);
  if (tooLate()) throw new PaymentNotSentError(`${lateText} — no card is created for a stalled execution`);

  const idem = `awb-spend-${requestId}`;
  const form = new URLSearchParams();
  form.set('cardholder', target.cardholder);
  form.set('currency', plan.currency.toLowerCase());
  form.set('type', 'virtual');
  form.set('status', 'inactive');
  form.set('spending_controls[spending_limits][0][amount]', String(plan.limit_minor));
  form.set('spending_controls[spending_limits][0][interval]', 'all_time');
  plan.allowed_categories.forEach((c, i) => form.set(`spending_controls[allowed_categories][${i}]`, c));
  if (plan.single_use) form.set('lifecycle_controls[cancel_after][payment_count]', '1');
  form.set(`metadata[${STRIPE_REQUEST_METADATA_KEY}]`, requestId);

  const summary = (reply: ProviderReply, step: string, extra: Record<string, unknown> = {}) => {
    const err = reply.status === 200 ? null : stripeError(reply, cred);
    const replayed = reply.header('idempotent-replayed');
    return {
      ...base, sent: true, step, status: reply.status,
      ...(err?.type ? { error_type: err.type } : {}),
      ...(err?.code ? { error_code: err.code } : {}),
      ...(err?.message ? { message_untrusted: err.message } : {}),
      ...(providerToken(reply.header('request-id'), PROVIDER_FORMATS.traceId) ? { request_id: providerToken(reply.header('request-id'), PROVIDER_FORMATS.traceId) } : {}),
      ...(replayed === 'true' ? { idempotent_replayed: true } : {}),
      ...extra,
    };
  };

  // 1. 비활성 카드 만들기
  const created = await stripePost('/v1/issuing/cards', form, idem, cred, io);
  if (created.kind === 'transport') {
    return {
      outcome: 'unknown',
      error: `Stripe ${created.timedOut ? 'did not answer in time' : 'could not be reached'} after the card was requested — a card may exist (inactive, so it cannot be used); check this request's card`,
      response: { ...base, sent: true, step: 'create', network_error: true },
    };
  }
  if (created.reply.status !== 200) {
    const err = stripeError(created.reply, cred);
    const response = summary(created.reply, 'create');
    if (isDefiniteStripeRefusal(created.reply.status, err)) return { outcome: 'failed', error: `Stripe refused to create the card (${err.text})`, response };
    return {
      outcome: 'unknown',
      error: `Stripe answered ${err.text} when the card was requested — a card may exist (inactive, so it cannot be used); check this request's card`,
      response,
    };
  }
  const card = created.reply.json;
  const cardId = providerToken(card?.id, PROVIDER_FORMATS.stripeId);
  const createMismatch = cardMismatches(card, plan, requestId, 'inactive');
  if (createMismatch.length) {
    const response = summary(created.reply, 'create', { ...(cardId ? { card_id: cardId } : {}), mismatched: createMismatch });
    if (!cardId) {
      return { outcome: 'unknown', error: `Stripe answered the card request without a usable card (${createMismatch.join(', ')}) — check this request's card`, response };
    }
    if (await cancelCard(cardId, idem, cred, io)) {
      return { outcome: 'failed', error: `the card Stripe created did not match the plan (${createMismatch.join(', ')}) and was canceled before it could be used`, response: { ...response, canceled: true } };
    }
    return {
      outcome: 'unknown',
      error: `the card Stripe created did not match the plan (${createMismatch.join(', ')}) and could not be canceled — cancel card ${cardId} in the Stripe Dashboard, then record the result`,
      response,
    };
  }

  // 2. 활성화 — 만드는 사이 실행이 오래 멈췄으면 살리지 않고 해지한다(STRIPE_ACTIVATE_WITHIN_MS).
  if (tooLate()) {
    const response = { ...base, sent: true, step: 'create', card_id: cardId, activation_skipped: true };
    if (await cancelCard(cardId, idem, cred, io)) {
      return { outcome: 'failed', error: `${lateText}, so card ${cardId} was canceled instead of activated`, response: { ...response, canceled: true } };
    }
    return {
      outcome: 'unknown',
      error: `${lateText} and inactive card ${cardId} could not be canceled — cancel it in the Stripe Dashboard, then record the result`,
      response,
    };
  }
  const activated = await stripePost(`/v1/issuing/cards/${encodeURIComponent(cardId)}`, new URLSearchParams({ status: 'active' }), `${idem}-activate`, cred, io);
  if (activated.kind === 'transport') {
    return {
      outcome: 'unknown',
      error: `Stripe ${activated.timedOut ? 'did not answer in time' : 'could not be reached'} while card ${cardId} was being activated — it may be active; check it in the Stripe Dashboard`,
      response: { ...base, sent: true, step: 'activate', card_id: cardId, network_error: true },
    };
  }
  if (activated.reply.status === 200) {
    const mismatch = cardMismatches(activated.reply.json, plan, requestId, 'active', cardId);
    const response = summary(activated.reply, 'activate', { card_id: cardId, ...(mismatch.length ? { mismatched: mismatch } : {}) });
    if (!mismatch.length) {
      return { outcome: 'paid', transaction_id: cardId, receipt_url: stripeDashboardCardUrl(cardId, plan.livemode), response };
    }
    // 다른 카드로 답했다 — 그 카드는 무엇인지 모르니 건드리지 않는다. 이 요청이 만든 카드만 해지해 두고 사람이 본다.
    if (mismatch.includes('id')) {
      const canceled = await cancelCard(cardId, idem, cred, io);
      return {
        outcome: 'unknown',
        error: `Stripe answered the activation of card ${cardId} with a different card${canceled ? ` (card ${cardId} was canceled)` : ''} — check this request's cards in the Stripe Dashboard`,
        response: canceled ? { ...response, canceled: true } : response,
      };
    }
    // 승인한 계획과 다른 카드가 살아 있으면 안 된다 — 해지한다.
    if (await cancelCard(cardId, idem, cred, io)) {
      return { outcome: 'failed', error: `card ${cardId} did not match the plan after activation (${mismatch.join(', ')}) and was canceled`, response: { ...response, canceled: true } };
    }
    return {
      outcome: 'unknown',
      error: `card ${cardId} does not match the plan after activation (${mismatch.join(', ')}) and could not be canceled — cancel it in the Stripe Dashboard, then record the result`,
      response,
    };
  }
  const err = stripeError(activated.reply, cred);
  const response = summary(activated.reply, 'activate', { card_id: cardId });
  if (isDefiniteStripeRefusal(activated.reply.status, err)) {
    if (await cancelCard(cardId, idem, cred, io)) {
      return { outcome: 'failed', error: `Stripe refused to activate the card (${err.text}); the inactive card was canceled`, response: { ...response, canceled: true } };
    }
    return {
      outcome: 'unknown',
      error: `Stripe refused to activate card ${cardId} (${err.text}) and it could not be canceled — cancel it in the Stripe Dashboard, then record the result`,
      response,
    };
  }
  return { outcome: 'unknown', error: `Stripe answered ${err.text} while card ${cardId} was being activated — it may be active; check it in the Stripe Dashboard`, response };
}

/** 연결 확인용 — 카드 읽기 권한(대조에 필요)을 카드 한 장 읽기로 본다. 실패하면 문제 문장. */
export async function stripeCardReadProblem(target: StripeTarget, cred: StripeCredential, opts: { fetchImpl?: typeof fetch; env?: Record<string, string | undefined> } = {}): Promise<string | null> {
  const version = paymentApiVersion('stripe_issuing', opts.env);
  try {
    await stripeGet('/v1/issuing/cards', { cardholder: target.cardholder, limit: '1' }, `cards of ${target.cardholder}`, cred, { fetchImpl: opts.fetchImpl, version });
    return null;
  } catch (e: any) {
    return `${e?.message || e} — the key needs Issuing Cards: Write (it includes reading cards, which reconciling needs)`;
  }
}
