/**
 * 승인 대기 알림 — 순수 규칙(docs/marketing.md "승인 대기 알림").
 *
 * 무엇이 사람의 결정을 기다리는지는 언제나 원래 행의 **지금 상태**가 정한다(승인함 `GET /inbox` 와 같은 기준).
 * 여기서는 그 행들을 알림 후보로 바꾸고, 언제 묶어 보낼지 정하고, 누가 무엇을 받는지 거르고, 본문을 만든다.
 * 선점(한 번만 보내기)과 발송은 MarketingApprovalNotifyService 가 한다.
 *
 * 승인함이 세지만 여기서 알리지 않는 것이 있다. 사람이 방금 스스로 시작한 대기라서 알릴 필요가 없다.
 *   - manual 결제의 결제 기록
 *   - manual 채널 게시물의 링크 기록
 *   - credential 연결 대기 채널
 */
import { PERMISSIONS, hasPermission } from '../types/permissions';
import { formatMinorAmount } from './money';

/** 알림 종류. 이 순서가 본문 순서다 — 급한 것부터, 돈이 나갔는지 모르는 것이 맨 앞. */
export const APPROVAL_NOTICE_KINDS = [
  'spend_unknown',
  'list_hold',
  'spend_second_approval',
  'spend_pending',
  'allocation_proposed',
  'channel_proposed',
  'post_draft',
] as const;
export type ApprovalNoticeKind = typeof APPROVAL_NOTICE_KINDS[number];

interface ApprovalNoticeRule {
  /** 이 결정을 내리는 권한. 승인함의 actionable 과 같은 나눔이다. */
  permission: string;
  label: string;
  /** 무엇을 해야 하는지(건수 뒤에 붙는다). */
  hint?: string;
  /**
   * 에이전트 사이클이 한꺼번에 만들어 내는 종류다. 그 캠페인의 사이클이 아직 돌면 끝날 때까지 기다려 한 통에 묶는다.
   * 결과 불명 · 두 번째 승인은 사이클과 무관하게 생기므로 기다리지 않는다.
   */
  burst: boolean;
}

export const APPROVAL_NOTICE_RULES: Record<ApprovalNoticeKind, ApprovalNoticeRule> = {
  spend_unknown: {
    permission: PERMISSIONS.APPROVE_MARKETING_SPEND,
    label: '결제 결과 불명',
    hint: '결제됐는지 확인해 결과를 기록하세요',
    burst: false,
  },
  list_hold: {
    permission: PERMISSIONS.MANAGE_MARKETING,
    label: '목록 발송 중지',
    hint: '메일 채널에서 목록을 확인하고 중지를 해제하세요',
    burst: false,
  },
  spend_second_approval: {
    permission: PERMISSIONS.APPROVE_MARKETING_SPEND,
    label: '두 번째 승인 대기',
    hint: '2인 승인 대상이라 다른 승인자가 필요합니다',
    burst: false,
  },
  spend_pending: { permission: PERMISSIONS.APPROVE_MARKETING_SPEND, label: '지출 요청', burst: true },
  allocation_proposed: { permission: PERMISSIONS.APPROVE_MARKETING_SPEND, label: '예산 편성 제안', burst: true },
  channel_proposed: { permission: PERMISSIONS.MANAGE_MARKETING, label: '채널 제안', burst: true },
  post_draft: { permission: PERMISSIONS.MANAGE_MARKETING, label: '게시물 초안', burst: true },
};

/** 계정에 새 항목이 이만큼 더 없으면 한 묶음이 끝났다고 본다. */
export const APPROVAL_NOTICE_QUIET_MS = 2 * 60_000;
/** 어떤 항목도 이보다 오래 묶어 두지 않는다(사이클이 길어도). */
export const APPROVAL_NOTICE_MAX_WAIT_MS = 15 * 60_000;

/** 본문에 다 싣지 않는다. 나머지는 "외 n" 으로 줄이고 화면 링크로 보낸다. */
const MAX_CAMPAIGNS = 5;
const MAX_SPEND_LINES = 3;
const MAX_PLATFORMS = 5;
/** Discord provider 가 메시지 전체를 1900자에서 자른다 — 제목 · 링크 자리를 남긴다. */
const MAX_BODY_CHARS = 1500;

export interface ApprovalNoticeCandidate {
  kind: ApprovalNoticeKind;
  entity_id: string;
  account_id: string;
  campaign_id: string;
  /** 이 상태에 들어온 시각. 묶음 판단의 기준이다. */
  at: Date;
  /** 이 항목으로 알리지 않을 사람: 스스로 만든 사람, 이미 승인한 사람. */
  exclude_user_ids: string[];
  /** 지출 종류의 본문 정보. 수취인은 사람이 관리하는 허용 목록의 이름이다. */
  spend?: { amount_minor: number; currency: string; payee: string; expires_at: Date | null };
  /** 채널 제안의 플랫폼(고정 목록 값). */
  platform?: string;
  list_hold?: { name: string; rate: number };
}

export interface NoticeSpendRow {
  id: string;
  account_id: string;
  campaign_id: string;
  status: string;
  amount_minor: number;
  currency: string;
  payee: string;
  expires_at: Date;
  approvals: Array<{ user_id: string; at: string }> | null;
  requested_by_type: string;
  requested_by_id: string;
  created_at: Date;
  updated_at: Date;
}

/** 채널 제안 · 게시물 초안 · 편성 제안 — 만든 사람(`by_*`)과 만든 시각이면 된다. */
export interface NoticeProposalRow {
  id: string;
  account_id: string;
  campaign_id: string;
  created_at: Date;
  by_type: string;
  by_id: string;
  platform?: string;
}

function toDate(value: unknown, fallback: Date): Date {
  const t = value instanceof Date ? value.getTime() : Date.parse(String(value ?? ''));
  return Number.isFinite(t) ? new Date(t) : fallback;
}

function userIdIf(type: string, id: string): string[] {
  return type === 'user' && id ? [id] : [];
}

export function proposalNoticeCandidate(
  kind: 'allocation_proposed' | 'channel_proposed' | 'post_draft',
  row: NoticeProposalRow,
  now: Date,
): ApprovalNoticeCandidate {
  return {
    kind,
    entity_id: row.id,
    account_id: row.account_id,
    campaign_id: row.campaign_id,
    at: toDate(row.created_at, now),
    exclude_user_ids: userIdIf(row.by_type, row.by_id),
    ...(row.platform ? { platform: row.platform } : {}),
  };
}

/**
 * 지출 요청 하나의 지금 알림 종류.
 *   - `unknown` 이면 결과 불명이다. 승인한 사람을 포함해 승인자 모두가 대조할 수 있다.
 *   - `pending` 인데 승인이 없으면 새 요청이다. 요청한 사람은 승인할 수 없으니 뺀다.
 *   - `pending` 인데 승인이 있으면 2인 규칙의 두 번째 승인 대기다. 이미 승인한 사람과 요청한 사람을 뺀다.
 * 만료 시각이 지난 `pending` 은 곧 sweep 이 닫으므로 알리지 않는다.
 */
export function spendNoticeCandidate(row: NoticeSpendRow, now: Date): ApprovalNoticeCandidate | null {
  const base = { entity_id: row.id, account_id: row.account_id, campaign_id: row.campaign_id };
  const created = toDate(row.created_at, now);
  const updated = toDate(row.updated_at, created);
  const spend = { amount_minor: Number(row.amount_minor), currency: row.currency, payee: row.payee };
  if (row.status === 'unknown') {
    return { ...base, kind: 'spend_unknown', at: updated, exclude_user_ids: [], spend: { ...spend, expires_at: null } };
  }
  if (row.status !== 'pending') return null;
  const expires = toDate(row.expires_at, now);
  if (expires.getTime() <= now.getTime()) return null;
  const requester = userIdIf(row.requested_by_type, row.requested_by_id);
  const approvals = Array.isArray(row.approvals) ? row.approvals : [];
  if (!approvals.length) {
    return { ...base, kind: 'spend_pending', at: created, exclude_user_ids: requester, spend: { ...spend, expires_at: expires } };
  }
  return {
    ...base,
    kind: 'spend_second_approval',
    at: toDate(approvals[approvals.length - 1]?.at, updated),
    exclude_user_ids: [...requester, ...approvals.map((a) => a.user_id).filter(Boolean)],
    spend: { ...spend, expires_at: expires },
  };
}

/**
 * 이 계정의 대기 알림을 지금 보낼지 정한다. 때가 된 항목이 하나라도 있으면 보낸다. 보낼 때는 그 계정의 미알림 항목을
 * 전부 싣는다 — 기다리던 것이 같이 가는 편이 한 통 더 보내는 것보다 낫다.
 *   - 목록 발송 중지는 묶음 대기 없이 다음 sweep에서 즉시 보낸다.
 *   - 어떤 항목도 APPROVAL_NOTICE_MAX_WAIT_MS 를 넘겨 기다리지 않는다.
 *   - 결과 불명 · 두 번째 승인은 다른 항목을 기다리지 않는다. 생긴 지 APPROVAL_NOTICE_QUIET_MS 면 보낸다(잇달아 생긴
 *     것만 묶는다). 다른 캠페인의 사이클이 초안을 쏟아내는 중이어도 마찬가지다.
 *   - burst 종류는 계정의 가장 새 항목 뒤로 APPROVAL_NOTICE_QUIET_MS 동안 조용해야 한다. 한꺼번에 생기는 것을 묶는다.
 *     조용해졌어도 그 캠페인의 사이클이 아직 돌면 기다린다. 사이클 하나의 결과를 한 통으로 보낸다.
 */
export function approvalDigestDue(
  items: ApprovalNoticeCandidate[],
  now: Date,
  runningCampaignIds: ReadonlySet<string>,
): boolean {
  if (!items.length) return false;
  if (items.some((i) => i.kind === 'list_hold')) return true;
  const nowMs = now.getTime();
  let oldest = Infinity;
  let newest = -Infinity;
  for (const item of items) {
    oldest = Math.min(oldest, item.at.getTime());
    newest = Math.max(newest, item.at.getTime());
  }
  if (nowMs - oldest >= APPROVAL_NOTICE_MAX_WAIT_MS) return true;
  if (items.some((i) => !APPROVAL_NOTICE_RULES[i.kind].burst && nowMs - i.at.getTime() >= APPROVAL_NOTICE_QUIET_MS)) return true;
  if (nowMs - newest < APPROVAL_NOTICE_QUIET_MS) return false;
  return items.some((i) => !runningCampaignIds.has(i.campaign_id));
}

export interface ApprovalNoticeRecipient {
  id: string;
  role: string;
  permissions: string[];
}

/** 이 사람이 받을 항목: 그 결정을 내릴 권한이 있고, 스스로 만들거나 이미 승인한 항목이 아니어야 한다. */
export function approvalNoticesFor(
  user: ApprovalNoticeRecipient,
  items: ApprovalNoticeCandidate[],
): ApprovalNoticeCandidate[] {
  return items.filter((i) => hasPermission(user.role, user.permissions, APPROVAL_NOTICE_RULES[i.kind].permission)
    && !i.exclude_user_ids.includes(user.id));
}

export interface ApprovalDigest {
  title: string;
  body: string;
  url?: string;
}

function oneLine(text: string, max: number): string {
  const flat = String(text || '').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function expiresIn(expiresAt: Date | null, now: Date): string {
  if (!expiresAt) return '';
  const hours = Math.floor((expiresAt.getTime() - now.getTime()) / 3_600_000);
  return hours >= 1 ? ` (만료까지 ${hours}시간)` : ' (1시간 안에 만료)';
}

function kindLine(kind: ApprovalNoticeKind, items: ApprovalNoticeCandidate[], now: Date): string {
  const rule = APPROVAL_NOTICE_RULES[kind];
  const spends = items.filter((i) => i.spend);
  const platforms = [...new Set(items.map((i) => i.platform).filter((p): p is string => !!p))];
  let detail = '';
  if (kind === 'list_hold') {
    const shown = items.slice(0, MAX_SPEND_LINES).map((i) => {
      const hold = i.list_hold!;
      const rate = Number.isFinite(hold.rate) ? `${(hold.rate * 100).toFixed(2)}%` : '확인 필요';
      return `${oneLine(hold.name, 60)} (신고율 ${rate})`;
    });
    const rest = items.length - shown.length;
    detail = `: ${shown.join(', ')}${rest > 0 ? ` 외 ${rest}건` : ''}`;
  } else if (spends.length) {
    const shown = spends.slice(0, MAX_SPEND_LINES).map((i) => {
      const s = i.spend!;
      return `${formatMinorAmount(s.amount_minor, s.currency)} → ${oneLine(s.payee, 60)}${expiresIn(s.expires_at, now)}`;
    });
    const rest = spends.length - shown.length;
    detail = `: ${shown.join(', ')}${rest > 0 ? ` 외 ${rest}건` : ''}`;
  } else if (platforms.length) {
    const rest = platforms.length - MAX_PLATFORMS;
    detail = ` (${platforms.slice(0, MAX_PLATFORMS).join(', ')}${rest > 0 ? ` 외 ${rest}` : ''})`;
  }
  return `• ${rule.label} ${items.length}건${detail}${rule.hint ? ` — ${rule.hint}` : ''}`;
}

/**
 * 한 사람에게 보내는 한 통. 캠페인별로 종류 · 건수를 싣고, 지출은 금액 · 수취인 · 만료까지 남은 시간을 싣는다.
 *
 * **에이전트가 쓴 글은 싣지 않는다** — 지출 목적 · 게시물 제목 · 채널 이름 · 근거가 그렇다. 에이전트가 읽는 외부 글에
 * 프롬프트 주입이 섞이면 그 문구(가짜 링크 · @everyone 등)가 AWB 이름으로 사람의 Discord/Slack/Telegram 에 가기
 * 때문이다. 실리는 것은 사람이 정했거나 서버가 계산한 값뿐이다: 캠페인 이름, 허용 목록의 수취인, 금액, 플랫폼, 건수, 시간.
 */
export function composeApprovalDigest(
  items: ApprovalNoticeCandidate[],
  campaigns: ReadonlyMap<string, { name: string }>,
  opts: { now: Date; baseUrl?: string },
): ApprovalDigest {
  const byCampaign = new Map<string, ApprovalNoticeCandidate[]>();
  for (const item of items) {
    const list = byCampaign.get(item.campaign_id);
    if (list) list.push(item);
    else byCampaign.set(item.campaign_id, [item]);
  }
  const nameOf = (id: string) => oneLine(campaigns.get(id)?.name || '', 80) || '(이름 없는 캠페인)';
  const urgency = (list: ApprovalNoticeCandidate[]) =>
    list.reduce((best, i) => Math.min(best, APPROVAL_NOTICE_KINDS.indexOf(i.kind)), APPROVAL_NOTICE_KINDS.length);
  const ordered = [...byCampaign.entries()].sort(([a, ai], [b, bi]) =>
    urgency(ai) - urgency(bi) || nameOf(a).localeCompare(nameOf(b)));

  const blocks: string[] = [];
  for (const [campaignId, list] of ordered.slice(0, MAX_CAMPAIGNS)) {
    const lines = [nameOf(campaignId)];
    for (const kind of APPROVAL_NOTICE_KINDS) {
      const ofKind = list.filter((i) => i.kind === kind);
      if (ofKind.length) lines.push(kindLine(kind, ofKind, opts.now));
    }
    blocks.push(lines.join('\n'));
  }
  if (ordered.length > MAX_CAMPAIGNS) blocks.push(`외 캠페인 ${ordered.length - MAX_CAMPAIGNS}개`);

  let body = '';
  for (const line of blocks.join('\n\n').split('\n')) {
    const next = body ? `${body}\n${line}` : line;
    if (next.length > MAX_BODY_CHARS) {
      body = `${body}\n…`;
      break;
    }
    body = next;
  }

  const single = ordered.length === 1 ? ordered[0][0] : null;
  const title = `마케팅 결정 대기 ${items.length}건${single ? ` — ${nameOf(single)}` : ` (캠페인 ${ordered.length}개)`}`;
  const base = (opts.baseUrl || '').replace(/\/$/, '');
  const url = base ? `${base}/marketing${single ? `/${single}` : ''}` : undefined;
  return { title, body, ...(url ? { url } : {}) };
}
