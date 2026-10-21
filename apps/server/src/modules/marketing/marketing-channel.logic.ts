/**
 * 채널 입력 정규화 — 순수 함수(docs/marketing.md "채널 탐색").
 */
import {
  CHANNEL_PLATFORMS,
  DEFAULT_EMAIL_AD_LABEL,
  OUTREACH_PLATFORMS,
  type ChannelKind,
  type ChannelPlatform,
} from '../../common/marketing/marketing-constants';
import { marketingError } from './marketing-errors';

const MAX_TEXT = 4000;
const MAX_URLS = 10;

function text(value: unknown, label: string, max = MAX_TEXT): string {
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') throw marketingError(400, `${label} must be a string`);
  const trimmed = value.trim();
  if (trimmed.length > max) throw marketingError(400, `${label} must be at most ${max} characters`);
  return trimmed;
}

export function normalizePlatform(value: unknown): ChannelPlatform {
  const platform = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!(CHANNEL_PLATFORMS as readonly string[]).includes(platform)) {
    throw marketingError(400, `platform must be one of: ${CHANNEL_PLATFORMS.join(', ')}`);
  }
  return platform as ChannelPlatform;
}

/** 제안 단계의 기본 kind — 승인하는 사람이 바꿀 수 있다(예: reddit 이지만 토큰이 없어 manual). */
export function defaultKindFor(platform: ChannelPlatform): ChannelKind {
  if (OUTREACH_PLATFORMS[platform]) return 'outreach';
  if (platform === 'email') return 'email';
  return 'manual';
}

/** http(s) URL 만 받는다 — javascript: · data: 같은 스킴은 화면에서 링크가 되면 안 된다. */
export function normalizeHttpUrl(value: unknown, label: string): string {
  const raw = text(value, label, 2000);
  if (!raw) return '';
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw marketingError(400, `${label} must be an http(s) URL`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw marketingError(400, `${label} must be an http(s) URL`);
  return url.toString();
}

/**
 * 플랫폼별 대상 표기를 하나로 맞춘다. reddit 은 OutreachChannel.targets 와 같은 subreddit 이름(r/ 없이),
 * github 는 owner/repo. 그 밖은 사람이 읽는 그대로(URL 이면 URL 검증).
 */
export function normalizeChannelTarget(platform: ChannelPlatform, value: unknown): { target: string; key: string } {
  const raw = text(value, 'target', 500);
  if (!raw) throw marketingError(400, 'target is required');
  if (platform === 'reddit') {
    const m = raw.match(/^(?:https?:\/\/(?:www\.|old\.)?reddit\.com)?\/?(?:r\/)?([A-Za-z0-9_]{2,21})\/?$/);
    if (!m) throw marketingError(400, 'reddit target must be a subreddit name (e.g. "selfhosted" or "r/selfhosted")');
    return { target: m[1], key: m[1].toLowerCase() };
  }
  if (platform === 'github') {
    const m = raw.match(/^(?:https?:\/\/github\.com\/)?([A-Za-z0-9-]{1,39})\/([A-Za-z0-9._-]{1,100}?)(?:\.git)?\/?$/);
    if (!m) throw marketingError(400, 'github target must be "owner/repo"');
    const target = `${m[1]}/${m[2]}`;
    return { target, key: target.toLowerCase() };
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw) && !/^https?:\/\//i.test(raw)) {
    // javascript: · data: · mailto: 같은 스킴은 화면에서 링크가 되면 안 된다.
    throw marketingError(400, 'target URL must be http(s)');
  }
  if (/^https?:\/\//i.test(raw)) {
    const url = normalizeHttpUrl(raw, 'target');
    return { target: url, key: url.toLowerCase().replace(/\/+$/, '') };
  }
  return { target: raw, key: raw.toLowerCase().replace(/\s+/g, ' ') };
}

export interface ChannelProposalInput {
  platform: ChannelPlatform;
  name: string;
  target: string;
  target_key: string;
  rationale: string;
  audience_fit: string;
  audience_size: number | null;
  audience_observed_at: Date | null;
  evidence_urls: string[];
  rules_summary: string;
  rules_url: string;
  guidelines: string;
}

/** 에이전트/사람의 채널 제안 본문. 에이전트 제안은 근거(rationale · evidence_urls)가 필수다. */
export function normalizeChannelProposal(body: Record<string, unknown>, opts: { requireEvidence: boolean }): ChannelProposalInput {
  const platform = normalizePlatform(body.platform);
  const { target, key } = normalizeChannelTarget(platform, body.target);
  const name = text(body.name, 'name', 120) || target;
  const rationale = text(body.rationale, 'rationale');
  const evidenceRaw = body.evidence_urls;
  if (evidenceRaw !== undefined && evidenceRaw !== null && !Array.isArray(evidenceRaw)) {
    throw marketingError(400, 'evidence_urls must be an array of URLs');
  }
  const evidence = ((evidenceRaw as unknown[]) || []).slice(0, MAX_URLS).map((u, i) => normalizeHttpUrl(u, `evidence_urls[${i}]`)).filter(Boolean);
  if (opts.requireEvidence) {
    if (!rationale) throw marketingError(400, 'rationale is required — say why this channel fits the product');
    if (!evidence.length) throw marketingError(400, 'evidence_urls is required — list the pages you actually opened');
  }
  let audienceSize: number | null = null;
  if (body.audience_size !== undefined && body.audience_size !== null && body.audience_size !== '') {
    const n = Number(body.audience_size);
    if (!Number.isInteger(n) || n < 0 || n > 2_000_000_000) throw marketingError(400, 'audience_size must be a non-negative integer');
    audienceSize = n;
  }
  let observedAt: Date | null = null;
  if (body.audience_observed_at) {
    const d = new Date(String(body.audience_observed_at));
    if (Number.isNaN(d.getTime())) throw marketingError(400, 'audience_observed_at must be a date');
    observedAt = d;
  }
  return {
    platform,
    name,
    target,
    target_key: key,
    rationale,
    audience_fit: text(body.audience_fit, 'audience_fit'),
    audience_size: audienceSize,
    audience_observed_at: observedAt,
    evidence_urls: evidence,
    rules_summary: text(body.rules_summary, 'rules_summary'),
    rules_url: normalizeHttpUrl(body.rules_url, 'rules_url'),
    guidelines: text(body.guidelines, 'guidelines'),
  };
}

export interface EmailChannelConfig {
  credential_id: string;
  from_name: string;
  from_address: string;
  reply_to: string;
  postal_address: string;
  contact_email: string;
  ad_label: string;
  list_name: string;
}

const EMAIL_RE = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/;

export function isEmailAddress(value: string): boolean {
  return EMAIL_RE.test(value) && value.length <= 254;
}

/**
 * 메일 채널 설정. 발신자 이름 · 주소 · 우편 주소 · 연락처는 법정 표기(정보통신망법 §50, CAN-SPAM)라
 * 비어 있으면 거부한다. 광고 표기는 비울 수 없다(기본 "(광고)").
 */
export function normalizeEmailChannelConfig(raw: unknown): EmailChannelConfig {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw marketingError(400, 'email config is required');
  const body = raw as Record<string, unknown>;
  const credentialId = text(body.credential_id, 'email.credential_id', 100);
  if (!credentialId) throw marketingError(400, 'email.credential_id is required (a credential with provider resend|sendgrid and api_key)');
  const fromAddress = text(body.from_address, 'email.from_address', 254);
  if (!isEmailAddress(fromAddress)) throw marketingError(400, 'email.from_address must be an email address');
  const replyTo = text(body.reply_to, 'email.reply_to', 254);
  if (replyTo && !isEmailAddress(replyTo)) throw marketingError(400, 'email.reply_to must be an email address');
  const contactEmail = text(body.contact_email, 'email.contact_email', 254) || replyTo || fromAddress;
  if (!isEmailAddress(contactEmail)) throw marketingError(400, 'email.contact_email must be an email address');
  const fromName = text(body.from_name, 'email.from_name', 120);
  if (!fromName) throw marketingError(400, 'email.from_name is required (sender identity is mandatory in marketing email)');
  const postal = text(body.postal_address, 'email.postal_address', 300);
  if (!postal) throw marketingError(400, 'email.postal_address is required (sender address is mandatory in marketing email)');
  if (!text(body.list_name, 'email.list_name', 100)) {
    throw marketingError(400, 'email.list_name is required (which contact list receives this channel\'s mail)');
  }
  const listName = normalizeListName(body.list_name);
  const adLabel = text(body.ad_label, 'email.ad_label', 30) || DEFAULT_EMAIL_AD_LABEL;
  return {
    credential_id: credentialId,
    from_name: fromName,
    from_address: fromAddress,
    reply_to: replyTo,
    postal_address: postal,
    contact_email: contactEmail,
    ad_label: adLabel,
    list_name: listName,
  };
}

/** 수신 목록 이름 정규화 — 연락처의 lists 와 같은 규칙. */
export function normalizeListName(value: unknown): string {
  const name = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!name || name.length > 100 || !/^[a-z0-9][a-z0-9 _.-]*$/.test(name)) {
    throw marketingError(400, 'list name must be letters, digits, space, "_", "." or "-" (max 100)');
  }
  return name;
}
