/** Provider reports are target-wide, not attributed to a particular AWB approval. */
import { currencyExponent } from '../../common/marketing/money';
import { PaymentRuleError, parseProviderInt, parseMetaRef, parseGoogleRef, paymentApiVersion, minorToMetaUnits, minorToGoogleMicros, metaUnitsToMinor, googleMicrosToMinor, type DirectPlan } from '../../common/marketing/payment-routes';
import { PaymentReadError, PaymentNotSentError, type PaymentOutcome } from './marketing-payments';
import { graphGet, observeMetaTarget, readMetaCredential, executeMetaPlan } from './marketing-payment-meta';
import { googleSearch, googleAccessToken, observeGoogleTarget, readGoogleCredential, executeGooglePlan } from './marketing-payment-google';
import { stripeGet, observeStripeCard, readStripeCredential, cardMismatches, cancelCard } from './marketing-payment-stripe';
import type { DirectAdapterContext } from './marketing-payment-adapters';

export interface DirectSpendReport {
  ceiling_minor: number;
  ceiling_units: string;
  spend_minor: number;
  spend_exact: string;
  pending_minor: number;
  stopped: boolean;
  complete: boolean;
  card_id?: string;
  notes: string[];
  status: string;
  observed_at: string;
}
export interface DirectReconcileInput {
  plan: DirectPlan;
  ref: string;
  fields: Record<string, string>;
  fingerprint: string;
  currency: string;
  requestId: string;
  response: unknown;
  ctx: DirectAdapterContext;
}
export function safeReportInteger(n: bigint): number {
  if (n < 0n || n > BigInt(Number.MAX_SAFE_INTEGER)) throw new PaymentReadError('provider amount exceeds supported safe integer range', false);
  return Number(n);
}
/** Round upward only after exact decimal arithmetic; never parseFloat monetary values. */
export function decimalSpendMinor(value: unknown, currency: string): number {
  if (typeof value !== 'string' || !/^\d+(\.\d+)?$/.test(value) || value.length > 100) throw new PaymentReadError('invalid decimal spend', false);
  const [whole, fraction = ''] = value.split('.');
  const scale = 10n ** BigInt(fraction.length);
  const numerator = (BigInt(whole) * scale + BigInt(fraction || '0')) * 10n ** BigInt(currencyExponent(currency));
  return safeReportInteger((numerator + scale - 1n) / scale);
}
function checkInput(input: DirectReconcileInput): void {
  if (input.plan.credential_fingerprint !== input.fingerprint || input.plan.currency !== input.currency) throw new PaymentRuleError('credential or currency changed since approval');
}
function objectId(value: any): unknown { return typeof value === 'string' ? value : value?.id; }
async function stripeRows(kind: 'transactions' | 'authorizations', cardId: string, input: DirectReconcileInput): Promise<any[]> {
  const cred = readStripeCredential(input.fields);
  const rows: any[] = [];
  const seen = new Set<string>();
  let after = '';
  for (let page = 0; page < 100; page++) {
    const body = await stripeGet(`/v1/issuing/${kind}`, { card: cardId, limit: '100', ...(after ? { starting_after: after } : {}) }, kind, cred, { ...input.ctx, version: paymentApiVersion('stripe_issuing', input.ctx.env) });
    if (!Array.isArray(body.data) || typeof body.has_more !== 'boolean') throw new PaymentReadError('malformed Stripe list', false);
    for (const row of body.data) {
      if (typeof row.id !== 'string' || seen.has(row.id) || objectId(row.card) !== cardId || row.currency?.toUpperCase() !== input.currency || row.livemode !== (input.plan as any).livemode) throw new PaymentReadError('Stripe report identity, currency, mode or pagination mismatch', false);
      seen.add(row.id); rows.push(row);
    }
    if (!body.has_more) return rows;
    if (!body.data.length) break;
    after = body.data[body.data.length - 1].id;
  }
  throw new PaymentReadError('Stripe report pagination is incomplete', false);
}

export async function reconcileDirect(input: DirectReconcileInput): Promise<DirectSpendReport> {
  checkInput(input);
  const { plan, ctx, currency } = input;
  const base = { pending_minor: 0, complete: true, observed_at: (ctx.now?.() || new Date()).toISOString() };
  if (plan.provider === 'meta_ads') {
    const target = parseMetaRef(input.ref), cred = readMetaCredential(input.fields);
    if (target.campaign_id !== plan.target.campaign_id || target.ad_account_id !== plan.target.ad_account_id) throw new PaymentRuleError('Meta target changed since approval');
    const obs = await observeMetaTarget(target, cred, ctx);
    if (obs.campaign.id !== target.campaign_id || obs.campaign.account_id !== target.ad_account_id || obs.account.currency !== currency || obs.campaign.spend_cap === null) throw new PaymentReadError('Meta report identity, currency or ceiling mismatch', false);
    const body = await graphGet(`${target.campaign_id}/insights`, 'spend,date_start,date_stop', cred, { ...ctx, version: obs.api_version, params: { date_preset: 'maximum', limit: '1' } });
    // Never interpret an empty/malformed or truncated result as zero spend.
    if (!Array.isArray(body.data) || body.data.length !== 1 || body.paging?.next) throw new PaymentReadError('Meta lifetime report is empty or incomplete', false);
    const row = body.data[0];
    const campaign = await graphGet(target.campaign_id, 'created_time,stop_time', cred, { ...ctx, version: obs.api_version });
    const created = typeof campaign.created_time === 'string' ? campaign.created_time.slice(0, 10) : '';
    const complete = /^\d{4}-\d{2}-\d{2}$/.test(created) && typeof row.date_start === 'string' && row.date_start <= created;
    const stopped = ['PAUSED', 'ARCHIVED', 'DELETED'].includes(obs.campaign.status) || ['PAUSED', 'CAMPAIGN_PAUSED', 'ARCHIVED', 'DELETED'].includes(obs.campaign.effective_status)
      || (typeof campaign.stop_time === 'string' && Number.isFinite(Date.parse(campaign.stop_time)) && Date.parse(campaign.stop_time) < Date.parse(base.observed_at));
    return { ...base, complete, ceiling_minor: safeReportInteger(metaUnitsToMinor(obs.campaign.spend_cap, currency)), ceiling_units: String(obs.campaign.spend_cap), spend_minor: decimalSpendMinor(row.spend, currency), spend_exact: row.spend, stopped, status: obs.campaign.effective_status || obs.campaign.status, notes: ['Meta Insights spend is estimated and can change.', ...(!complete ? ['Insights retention does not cover campaign creation; return blocked.'] : [])] };
  }
  if (plan.provider === 'google_ads') {
    const target = parseGoogleRef(input.ref), cred = readGoogleCredential(input.fields);
    if (target.campaign_id !== plan.target.campaign_id || target.customer_id !== plan.target.customer_id) throw new PaymentRuleError('Google target changed since approval');
    const obs = await observeGoogleTarget(target, cred, input.fingerprint, ctx);
    if (!obs.found || obs.campaign.id !== target.campaign_id || obs.customer.currency !== currency || obs.budget.total_micros === null || obs.budget.resource_name !== plan.target.budget || obs.budget.reference_count !== 1 || obs.budget.explicitly_shared) throw new PaymentReadError('Google report identity, currency or budget mismatch', false);
    const token = await googleAccessToken(cred, input.fingerprint, ctx.fetchImpl);
    const rows = await googleSearch(target.customer_id, `SELECT campaign.id, metrics.cost_micros FROM campaign WHERE campaign.id = ${target.campaign_id}`, cred, token, { ...ctx, version: obs.api_version, fingerprint: input.fingerprint });
    if (rows.length !== 1 || String(rows[0].campaign?.id) !== target.campaign_id || !rows[0].metrics || typeof rows[0].metrics !== 'object') throw new PaymentReadError('Google lifetime report is empty or ambiguous', false);
    const micros = parseProviderInt(rows[0].metrics?.costMicros ?? '0', 'Google cost_micros');
    const divisor = minorToGoogleMicros(1, currency);
    const stopped = obs.campaign.status === 'PAUSED' || obs.campaign.status === 'REMOVED' || (!!obs.campaign.end_date_time && Date.parse(obs.campaign.end_date_time.slice(0, 10) + 'T00:00:00Z') + 2 * 86400000 < Date.parse(base.observed_at));
    return { ...base, ceiling_minor: safeReportInteger(googleMicrosToMinor(obs.budget.total_micros, currency)), ceiling_units: String(obs.budget.total_micros), spend_minor: safeReportInteger((micros + divisor - 1n) / divisor), spend_exact: `${micros} micros`, stopped, status: obs.campaign.status, notes: ['Google metrics.cost_micros is service cost and may differ from billed cost.'] };
  }
  if (plan.plan !== 'issue_card') throw new PaymentReadError('unexpected provider plan', false);
  const recorded = input.response && typeof input.response === 'object' ? (input.response as any).card_id : undefined;
  const cardId = plan.card_id || recorded;
  if (typeof cardId !== 'string' || !/^ic_[A-Za-z0-9]+$/.test(cardId)) throw new PaymentReadError('request has no verified card id', false);
  const card = await observeStripeCard(cardId, readStripeCredential(input.fields), ctx);
  const limits = card?.spending_controls?.spending_limits;
  const global = Array.isArray(limits) ? limits.filter((l: any) => l.interval === 'all_time' && (!l.categories || Array.isArray(l.categories) && !l.categories.length)) : [];
  if (global.length !== 1 || !Number.isSafeInteger(global[0].amount) || global[0].amount < 0) throw new PaymentReadError('card has no finite unique all_time limit', false);
  const problems = cardMismatches(card, { ...plan, limit_minor: global[0].amount }, input.requestId, 'active', cardId).filter(p => p !== 'status' && !(plan.card_id && p === 'metadata'));
  if (problems.length || !['active', 'inactive', 'canceled'].includes(card.status)) throw new PaymentReadError('card identity or controls changed', false);
  // Read authorizations first, then transactions: captures between reads are conservatively counted twice, never omitted.
  const authorizations = await stripeRows('authorizations', cardId, input);
  const transactions = await stripeRows('transactions', cardId, input);
  let spent = 0n, pending = 0n;
  for (const row of transactions) {
    if (!Number.isSafeInteger(row.amount) || !['capture', 'refund'].includes(row.type)) throw new PaymentReadError('invalid Stripe transaction amount/type', false);
    spent -= BigInt(row.amount); // captures are negative; refunds positive, refund reversals negative.
  }
  for (const row of authorizations) {
    if (!Number.isSafeInteger(row.amount) || row.amount < 0 || typeof row.approved !== 'boolean' || !['pending', 'closed', 'reversed', 'expired'].includes(row.status)) throw new PaymentReadError('invalid Stripe authorization', false);
    if (row.approved && row.status !== 'closed') pending += BigInt(row.amount);
  }
  return { ...base, card_id: cardId, ceiling_minor: global[0].amount, ceiling_units: String(global[0].amount), spend_minor: safeReportInteger(spent < 0n ? 0n : spent), spend_exact: `${spent} minor units (net transactions)`, pending_minor: safeReportInteger(pending), stopped: card.status === 'canceled', status: card.status, notes: ['Cancellation does not prevent late/forced captures, tips or over-capture. Pending and expired authorization exposure remains reserved.', 'Report covers the whole card, including earlier approvals.'] };
}

export async function returnDirect(input: DirectReconcileInput & { expectedCeiling: string; amountMinor: number; operationId: string }): Promise<PaymentOutcome> {
  checkInput(input);
  if (!Number.isSafeInteger(input.amountMinor) || input.amountMinor <= 0) throw new PaymentNotSentError('return amount must be a positive safe integer');
  let report = await reconcileDirect(input);
  if (!report.complete || report.ceiling_units !== input.expectedCeiling) throw new PaymentNotSentError('report incomplete or ceiling changed since human approval');
  if (input.amountMinor > report.ceiling_minor - report.spend_minor - report.pending_minor) throw new PaymentNotSentError('return exceeds current unused ceiling');
  const plan = input.plan;
  if (plan.provider === 'stripe_issuing') {
    if (!report.stopped) {
      const canceled = await cancelCard(report.card_id!, `awb-return-${input.operationId}`, readStripeCredential(input.fields), { ...input.ctx, version: paymentApiVersion('stripe_issuing', input.ctx.env) });
      if (!canceled) return { outcome: 'unknown', error: 'card cancellation result is uncertain; no refund recorded', response: { card_id: report.card_id, sent: true } };
    }
    try { report = await reconcileDirect(input); } catch { return { outcome: 'unknown', error: 'card canceled but post-cancellation report failed; no refund recorded', response: { card_id: report.card_id, sent: true } }; }
    if (!report.stopped || report.ceiling_units !== input.expectedCeiling || input.amountMinor > report.ceiling_minor - report.spend_minor - report.pending_minor) return { outcome: 'unknown', error: 'card canceled but spend/limit changed; review latest report before refund', response: { card_id: report.card_id, report, sent: true } };
    return { outcome: 'paid', transaction_id: `stripe-return:${input.operationId}`, receipt_url: '', response: { card_id: report.card_id, report, refund_minor: input.amountMinor, sent: true } };
  }
  const toMinor = report.ceiling_minor - input.amountMinor;
  if (toMinor <= 0) throw new PaymentNotSentError('zero removes or invalidates the platform ceiling; retain a positive ceiling');
  const to = plan.provider === 'meta_ads' ? minorToMetaUnits(toMinor, input.currency) : minorToGoogleMicros(toMinor, input.currency);
  const lowered = { ...plan, from: input.expectedCeiling, from_minor: report.ceiling_minor, to: String(to), to_minor: toMinor };
  const result = plan.provider === 'meta_ads' ? await executeMetaPlan(lowered, readMetaCredential(input.fields), input.ctx) : await executeGooglePlan(lowered, readGoogleCredential(input.fields), input.fingerprint, { ...input.ctx, lowering: true });
  if (result.outcome === 'paid') result.response = { ...result.response, report, refund_minor: input.amountMinor };
  return result;
}
