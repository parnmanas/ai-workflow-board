/**
 * 캠페인 입력 정규화 — 순수 함수(DB 없음). REST 와 MCP 가 같은 규칙을 지나도록
 * MarketingCampaignService 가 이것만 쓴다. 실패는 MarketingError(400).
 */
import { randomBytes } from 'node:crypto';
import { isValidCron, nextCronAfter } from '../qa/qa-cron';
import {
  BUDGET_PERIODS,
  CAMPAIGN_STATUSES,
  DEFAULT_MARKETING_DISCLOSURE,
  DEFAULT_MARKETING_LIMITS,
  FEEDBACK_TICKET_STATUSES,
  MARKETING_CAPABILITIES,
  MARKETING_LIMIT_MAX,
  MIN_CYCLE_INTERVAL_MS,
  type CampaignStatus,
  type MarketingCapability,
  type MarketingLimits,
} from '../../common/marketing/marketing-constants';
import { marketingError } from './marketing-errors';

export const MAX_PAYEES = 50;
export const MAX_ALLOWED_DOMAINS = 50;
const MAX_NAME = 120;
const MAX_LONG_TEXT = 20_000;
const MAX_DISCLOSURE = 300;

function text(value: unknown, label: string, max: number): string {
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') throw marketingError(400, `${label} must be a string`);
  const trimmed = value.trim();
  if (trimmed.length > max) throw marketingError(400, `${label} must be at most ${max} characters`);
  return trimmed;
}

export function normalizeName(value: unknown): string {
  const name = text(value, 'name', MAX_NAME);
  if (!name) throw marketingError(400, 'name is required');
  return name;
}

export function normalizeLongText(value: unknown, label: string): string {
  return text(value, label, MAX_LONG_TEXT);
}

/** 이름에서 만든 짧은 식별자 + 4자 난수. 생성 때 한 번 정하고 이름을 바꿔도 유지한다. */
export function makeCampaignSlug(name: string, suffix: string = randomBytes(2).toString('hex')): string {
  const base = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
  return `${base || 'campaign'}-${suffix}`;
}

export function normalizeCapabilities(value: unknown): MarketingCapability[] {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value)) throw marketingError(400, 'capabilities must be an array');
  const known = new Set<string>(MARKETING_CAPABILITIES);
  const out: MarketingCapability[] = [];
  for (const raw of value) {
    const key = typeof raw === 'string' ? raw.trim() : '';
    if (!known.has(key)) {
      throw marketingError(400, `unknown capability "${String(raw)}" (expected one of: ${MARKETING_CAPABILITIES.join(', ')})`);
    }
    if (!out.includes(key as MarketingCapability)) out.push(key as MarketingCapability);
  }
  return out;
}

export function hasCapability(campaign: { capabilities: string[] | null | undefined }, capability: MarketingCapability): boolean {
  return Array.isArray(campaign.capabilities) && campaign.capabilities.includes(capability);
}

export function normalizeStatus(value: unknown): CampaignStatus {
  const status = typeof value === 'string' ? value.trim() : '';
  if (!(CAMPAIGN_STATUSES as readonly string[]).includes(status)) {
    throw marketingError(400, `status must be one of: ${CAMPAIGN_STATUSES.join(', ')}`);
  }
  return status as CampaignStatus;
}

/**
 * 허용 전이. archived 는 끝이 아니다(실수로 보관한 캠페인을 paused 로 되살릴 수 있다) —
 * 단 archived → active 는 한 번에 못 간다. 보관을 푸는 사람이 설정을 한 번 보게 한다.
 */
const TRANSITIONS: Record<CampaignStatus, CampaignStatus[]> = {
  draft: ['active', 'archived'],
  active: ['paused', 'archived'],
  paused: ['active', 'archived'],
  archived: ['paused'],
};

export function assertTransition(from: string, to: CampaignStatus): void {
  const allowed = TRANSITIONS[from as CampaignStatus] || [];
  if (from === to) return;
  if (!allowed.includes(to)) throw marketingError(409, `cannot move a campaign from ${from} to ${to}`);
}

export function normalizeBudgetPeriod(value: unknown): string {
  const period = typeof value === 'string' ? value.trim() : '';
  if (!(BUDGET_PERIODS as readonly string[]).includes(period)) {
    throw marketingError(400, `budget_period must be one of: ${BUDGET_PERIODS.join(', ')}`);
  }
  return period;
}

export function normalizeFeedbackTicketStatus(value: unknown): string {
  const status = typeof value === 'string' ? value.trim() : '';
  if (!(FEEDBACK_TICKET_STATUSES as readonly string[]).includes(status)) {
    throw marketingError(400, `feedback_ticket_status must be one of: ${FEEDBACK_TICKET_STATUSES.join(', ')}`);
  }
  return status;
}

/** 수취인 허용 목록. 이름(대소문자 무시)이 겹치면 거부 — 요청의 payee 는 이 이름으로 맞춘다. */
export function normalizePayees(value: unknown): Array<{ name: string; ref?: string; note?: string }> {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value)) throw marketingError(400, 'payees must be an array');
  if (value.length > MAX_PAYEES) throw marketingError(400, `at most ${MAX_PAYEES} payees`);
  const seen = new Set<string>();
  return value.map((raw, i) => {
    const entry = (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : { name: raw }) as Record<string, unknown>;
    const name = text(entry.name, `payees[${i}].name`, 120);
    if (!name) throw marketingError(400, `payees[${i}].name is required`);
    const key = name.toLowerCase();
    if (seen.has(key)) throw marketingError(400, `duplicate payee "${name}"`);
    seen.add(key);
    const ref = text(entry.ref, `payees[${i}].ref`, 200);
    const note = text(entry.note, `payees[${i}].note`, 500);
    return { name, ...(ref ? { ref } : {}), ...(note ? { note } : {}) };
  });
}

export function findPayee(
  campaign: { payees: Array<{ name: string; ref?: string; note?: string }> | null | undefined },
  name: string,
): { name: string; ref?: string; note?: string } | null {
  const key = name.trim().toLowerCase();
  return (campaign.payees || []).find((p) => p.name.toLowerCase() === key) || null;
}

/** 'example.com', 'https://example.com/path' 둘 다 받아 호스트 이름만 남긴다. */
export function normalizeDomain(raw: unknown, label: string): string {
  let value = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (!value) throw marketingError(400, `${label} is empty`);
  if (/^[a-z][a-z0-9+.-]*:\/\//.test(value)) {
    try {
      value = new URL(value).hostname;
    } catch {
      throw marketingError(400, `${label} is not a valid domain`);
    }
  }
  value = value.replace(/\.$/, '');
  if (!/^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(value)) {
    throw marketingError(400, `${label} "${String(raw)}" is not a valid domain`);
  }
  return value;
}

export function normalizeAllowedDomains(value: unknown): string[] {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value)) throw marketingError(400, 'allowed_domains must be an array');
  if (value.length > MAX_ALLOWED_DOMAINS) throw marketingError(400, `at most ${MAX_ALLOWED_DOMAINS} allowed_domains`);
  const out: string[] = [];
  value.forEach((raw, i) => {
    const domain = normalizeDomain(raw, `allowed_domains[${i}]`);
    if (!out.includes(domain)) out.push(domain);
  });
  return out;
}

/** 호스트가 허용 도메인 자체이거나 그 하위 도메인이면 true. */
export function hostAllowed(host: string, allowedDomains: string[]): boolean {
  const h = host.toLowerCase().replace(/\.$/, '');
  return allowedDomains.some((d) => h === d || h.endsWith(`.${d}`));
}

export function normalizeDisclosure(value: unknown): string {
  const disclosure = text(value, 'disclosure', MAX_DISCLOSURE);
  // 공개 문구는 비울 수 없다 — 비우면 기본 문구로 되돌린다(docs/marketing.md "커뮤니케이션").
  return disclosure || DEFAULT_MARKETING_DISCLOSURE;
}

export function normalizeLimits(value: unknown): Record<string, number> {
  if (value === null || value === undefined) return {};
  if (typeof value !== 'object' || Array.isArray(value)) throw marketingError(400, 'limits must be an object');
  const out: Record<string, number> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!(key in DEFAULT_MARKETING_LIMITS)) {
      throw marketingError(400, `unknown limit "${key}" (expected one of: ${Object.keys(DEFAULT_MARKETING_LIMITS).join(', ')})`);
    }
    if (raw === null || raw === undefined) continue;
    const n = typeof raw === 'number' ? raw : Number(raw);
    if (!Number.isInteger(n) || n < 0 || n > MARKETING_LIMIT_MAX) {
      throw marketingError(400, `limits.${key} must be an integer between 0 and ${MARKETING_LIMIT_MAX}`);
    }
    out[key] = n;
  }
  return out;
}

export function resolveLimits(campaign: { limits?: Record<string, number> | null }): MarketingLimits {
  const merged: MarketingLimits = { ...DEFAULT_MARKETING_LIMITS };
  for (const [key, value] of Object.entries(campaign.limits || {})) {
    if (key in merged && Number.isInteger(value) && value >= 0) (merged as Record<string, number>)[key] = value;
  }
  return merged;
}

/** cadence 는 cron 하나, interval 하나, 또는 둘 다 없음(수동 사이클만)이다. */
export function normalizeCadence(cron: unknown, intervalMs: unknown): { cron: string | null; intervalMs: number | null } {
  const cronText = typeof cron === 'string' ? cron.trim() : '';
  const hasInterval = intervalMs !== null && intervalMs !== undefined && intervalMs !== '';
  if (cronText && hasInterval) throw marketingError(400, 'set at most one of cycle_cron or cycle_interval_ms');
  if (cronText) {
    if (!isValidCron(cronText)) throw marketingError(400, `invalid cycle_cron "${cronText}" (5 UTC fields, e.g. "0 1 * * *")`);
    return { cron: cronText, intervalMs: null };
  }
  if (hasInterval) {
    const n = typeof intervalMs === 'number' ? intervalMs : Number(intervalMs);
    if (!Number.isInteger(n) || n < MIN_CYCLE_INTERVAL_MS) {
      throw marketingError(400, `cycle_interval_ms must be an integer >= ${MIN_CYCLE_INTERVAL_MS} (10 minutes)`);
    }
    if (n > 2_147_000_000) throw marketingError(400, 'cycle_interval_ms is too large');
    return { cron: null, intervalMs: n };
  }
  return { cron: null, intervalMs: null };
}

export function computeNextCycleAt(
  campaign: { status: string; cycle_cron: string | null; cycle_interval_ms: number | null },
  from: Date,
): Date | null {
  if (campaign.status !== 'active') return null;
  if (campaign.cycle_cron) return nextCronAfter(campaign.cycle_cron, from);
  if (campaign.cycle_interval_ms && campaign.cycle_interval_ms > 0) return new Date(from.getTime() + campaign.cycle_interval_ms);
  return null;
}
