/**
 * 마케팅 예산 계산 — 순수 함수(docs/marketing.md "예산 편성 · 집행 · 결제").
 *
 * 잔액은 저장하지 않는다. append-only 원장 행의 합이 곧 상태다:
 *   held  = Σreserve − Σrelease   (승인됐지만 아직 결제되지 않은 금액)
 *   spent = Σcapture − Σrefund
 * 원장 행은 그 지출 요청이 **승인된 기간**(period_key)에 묶인다 — 10월에 승인하고 11월에 결제돼도
 * 10월 예산을 쓴 것이다(release · capture · refund 가 reserve 의 period_key 를 그대로 물려받는다).
 * 그래서 다음 달로 넘어가도 이미 승인한 지출이 새 달의 한도를 갉아먹지 않고, 환불이 다른 달의 예산을
 * 늘리지도 않는다.
 *
 * 한도 검사(spendViolations)는 요청 시점(사람에게 의미 없는 요청을 올리지 않으려고)과 승인 시점(진짜 관문)
 * 두 번 같은 함수로 한다.
 */
import { createHash } from 'node:crypto';
import { formatMinorAmount } from './money';

export type LedgerKind = 'reserve' | 'release' | 'capture' | 'refund';

export interface LedgerRow {
  kind: string;
  amount_minor: number;
  channel_id: string;
  spend_request_id: string;
  period_key: string;
}

export interface BudgetCaps {
  currency: string;
  budget_total_minor: number;
  budget_period: string;
  budget_period_minor: number;
  max_transaction_minor: number;
}

export interface Usage {
  held: number;
  spent: number;
}

/** UTC 기준 예산 기간 키. month = 2026-10, week = ISO 주(2026-W43), none = all. */
export function periodKey(period: string, at: Date): string {
  if (period === 'month') {
    return `${at.getUTCFullYear()}-${String(at.getUTCMonth() + 1).padStart(2, '0')}`;
  }
  if (period === 'week') {
    const { year, week } = isoWeek(at);
    return `${year}-W${String(week).padStart(2, '0')}`;
  }
  return 'all';
}

/** 그 기간의 [start, end) — 화면 표기용. none 이면 null. */
export function periodBounds(period: string, at: Date): { start: Date; end: Date } | null {
  if (period === 'month') {
    const start = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1));
    const end = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 1));
    return { start, end };
  }
  if (period === 'week') {
    const day = (at.getUTCDay() + 6) % 7; // 월요일 = 0
    const start = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate() - day));
    const end = new Date(start.getTime() + 7 * 24 * 60 * 60_000);
    return { start, end };
  }
  return null;
}

function isoWeek(date: Date): { year: number; week: number } {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return { year: d.getUTCFullYear(), week };
}

export function usageOf(rows: LedgerRow[], filter: (row: LedgerRow) => boolean = () => true): Usage {
  let reserve = 0;
  let release = 0;
  let capture = 0;
  let refund = 0;
  for (const row of rows) {
    if (!filter(row)) continue;
    const amount = Number(row.amount_minor) || 0;
    if (row.kind === 'reserve') reserve += amount;
    else if (row.kind === 'release') release += amount;
    else if (row.kind === 'capture') capture += amount;
    else if (row.kind === 'refund') refund += amount;
  }
  return { held: reserve - release, spent: capture - refund };
}

/** 한 지출 요청의 원장 합 — release ≤ reserve, refund ≤ capture 를 강제하는 데 쓴다. */
export function requestTotals(rows: LedgerRow[], spendRequestId: string) {
  const t = { reserve: 0, release: 0, capture: 0, refund: 0 };
  for (const row of rows) {
    if (row.spend_request_id !== spendRequestId) continue;
    const k = row.kind as LedgerKind;
    if (k in t) t[k] += Number(row.amount_minor) || 0;
  }
  return t;
}

export interface BudgetSnapshot {
  period_key: string;
  total: Usage & { cap: number; available: number };
  period: (Usage & { cap: number | null; available: number | null });
  channel: (Usage & { allocation: number | null; available: number | null }) | null;
}

/**
 * 지금의 예산 상태. `channel` 을 주면 그 채널의 기간 사용량과 편성 대비 가용액도 계산한다.
 * cap 0 은 "상한 없음" 이 아니라 의미가 칸마다 다르다:
 *   - budget_total_minor 0 → 지출 불가(총 가용 0)
 *   - budget_period_minor 0 또는 period none → 기간 상한 없음(null)
 */
export function budgetSnapshot(
  caps: BudgetCaps,
  rows: LedgerRow[],
  now: Date,
  channel?: { id: string; allocation_minor: number | null },
): BudgetSnapshot {
  const key = periodKey(caps.budget_period, now);
  const total = usageOf(rows);
  const totalAvailable = Math.max(0, caps.budget_total_minor - total.held - total.spent);
  const hasPeriodCap = caps.budget_period !== 'none' && caps.budget_period_minor > 0;
  const period = usageOf(rows, (r) => r.period_key === key);
  let channelSnap: BudgetSnapshot['channel'] = null;
  if (channel) {
    const used = usageOf(rows, (r) => r.channel_id === channel.id && r.period_key === key);
    channelSnap = {
      ...used,
      allocation: channel.allocation_minor,
      available: channel.allocation_minor === null ? null : Math.max(0, channel.allocation_minor - used.held - used.spent),
    };
  }
  return {
    period_key: key,
    total: { ...total, cap: caps.budget_total_minor, available: totalAvailable },
    period: {
      ...period,
      cap: hasPeriodCap ? caps.budget_period_minor : null,
      available: hasPeriodCap ? Math.max(0, caps.budget_period_minor - period.held - period.spent) : null,
    },
    channel: channelSnap,
  };
}

/**
 * 이 금액을 지금 승인할 수 있는가 — 어긋나는 이유 목록(비면 통과). 금액 표기는 사람이 읽는 형태라
 * 거부 사유가 그대로 에이전트 · 승인자에게 보인다.
 */
export function spendViolations(
  caps: BudgetCaps,
  rows: LedgerRow[],
  now: Date,
  request: { amount_minor: number; currency: string; channel_id: string },
  allocationMinor: number | null,
): string[] {
  const out: string[] = [];
  const fmt = (n: number) => formatMinorAmount(n, caps.currency);
  if (request.currency !== caps.currency) out.push(`currency ${request.currency} does not match the campaign currency ${caps.currency}`);
  if (caps.budget_total_minor <= 0) out.push('the campaign has no budget (budget_total_minor is 0)');
  if (caps.max_transaction_minor > 0 && request.amount_minor > caps.max_transaction_minor) {
    out.push(`amount ${fmt(request.amount_minor)} exceeds the per-transaction cap ${fmt(caps.max_transaction_minor)}`);
  }
  const snap = budgetSnapshot(caps, rows, now, { id: request.channel_id, allocation_minor: allocationMinor });
  if (caps.budget_total_minor > 0 && request.amount_minor > snap.total.available) {
    out.push(`amount ${fmt(request.amount_minor)} exceeds the campaign's remaining budget ${fmt(snap.total.available)}`);
  }
  if (snap.period.available !== null && request.amount_minor > snap.period.available) {
    out.push(`amount ${fmt(request.amount_minor)} exceeds the remaining ${caps.budget_period} budget ${fmt(snap.period.available)} (${snap.period_key})`);
  }
  if (allocationMinor === null) {
    out.push('the channel has no approved budget allocation — propose one first (propose_marketing_budget_allocation)');
  } else if (snap.channel && snap.channel.available !== null && request.amount_minor > snap.channel.available) {
    out.push(`amount ${fmt(request.amount_minor)} exceeds the channel's remaining allocation ${fmt(snap.channel.available)} (${snap.period_key})`);
  }
  return out;
}

/** 키를 정렬한 JSON — 같은 내용은 언제나 같은 바이트(해시 · 서명 대상). */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

/** 사람이 승인 화면에서 본 것 = 서버가 실행하는 것. 실행 직전에 다시 계산해 비교한다. */
export function spendPayloadHash(request: {
  campaign_id: string;
  channel_id: string;
  amount_minor: number;
  currency: string;
  payee: string;
  payee_ref: string;
  purpose: string;
  provider: string;
  provider_credential_id: string | null;
  payload: unknown;
}): string {
  return createHash('sha256').update(canonicalJson({
    campaign_id: request.campaign_id,
    channel_id: request.channel_id,
    amount_minor: Number(request.amount_minor),
    currency: request.currency,
    payee: request.payee,
    payee_ref: request.payee_ref || '',
    purpose: request.purpose,
    provider: request.provider,
    provider_credential_id: request.provider_credential_id || null,
    payload: request.payload ?? {},
  }), 'utf8').digest('hex');
}
