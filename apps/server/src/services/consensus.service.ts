/**
 * 다중담당자·합의 (multi-assignee consensus) — T4 판정 서비스(DB 오케스트레이션).
 *
 * `common/consensus-state` 의 순수 로직에 실제 데이터를 물려주는 얇은 계층:
 *   1. 현재 컬럼의 `role_routing` → 라우팅 역할 슬러그(= columnRoles).
 *   2. 그 슬러그들의 **전 홀더**(agent/user) = 합의 필수 투표자. reporter 홀더는
 *      override 후보로 따로.
 *   3. 티켓 코멘트 중 합의 vote(metadata.consensus_vote)를 파싱해 모은다.
 *   4. `computeConsensusState` 로 판정.
 *
 * Nest DI 데코레이터 없이 `deps`(dataSource + role-assignment 서비스)만 받는 순수
 * 오케스트레이션 함수로 둬서, MCP 툴(record_agreement)과 미래 T5 이동 게이트가
 * 같은 판정 경로를 공유하고 모듈 배선 추가 없이 재사용한다.
 */

import type { DataSource } from 'typeorm';
import { Comment } from '../entities/Comment';
import { BoardColumn } from '../entities/BoardColumn';
import { Ticket } from '../entities/Ticket';
import {
  computeConsensusState,
  parseConsensusVote,
  parseConsensusProposal,
  type ConsensusParty,
  type ConsensusState,
  type ConsensusVote,
  type ParsedConsensusProposal,
} from '../common/consensus-state';
import type { TicketRoleAssignmentService } from '../modules/workspace-roles/ticket-role-assignment.service';

/** role-assignment 서비스에서 실제로 쓰는 최소 표면(테스트 스텁 용이). */
export type GroupedHolderResolver = Pick<
  TicketRoleAssignmentService,
  'resolveGroupedForTicket'
>;

export interface ConsensusResolverDeps {
  dataSource: DataSource;
  ticketRoleAssignmentService: GroupedHolderResolver;
}

export interface GetConsensusStateOpts {
  /** 컬럼 라우팅 역할 오버라이드. 생략 시 티켓의 현재 컬럼 role_routing 에서 도출. */
  routingRoleSlugs?: string[];
  /** 판정 대상 이동 제안(T5). 생략 시 최신 vote 가 참조한 제안이 앵커. */
  proposalId?: string | null;
}

export interface ResolvedConsensusState extends ConsensusState {
  /** 판정에 쓰인 라우팅 역할 슬러그(도출 결과 노출 — T5 게이트/디버깅). */
  routingRoleSlugs: string[];
}

function parseSlugArray(raw: unknown): string[] {
  if (typeof raw !== 'string' || !raw) return [];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.filter((s): s is string => typeof s === 'string' && !!s) : [];
  } catch {
    return [];
  }
}

function toEpochMs(d: Date | string | null | undefined): number {
  if (d instanceof Date) return d.getTime();
  if (typeof d === 'string') {
    const n = Date.parse(d);
    return Number.isNaN(n) ? 0 : n;
  }
  return 0;
}

/** 티켓의 현재 컬럼 role_routing 슬러그. 컬럼 없음(child)/드리프트 → []. */
async function deriveRoutingSlugs(dataSource: DataSource, ticket: Ticket): Promise<string[]> {
  if (!ticket.column_id) return [];
  const col = await dataSource.getRepository(BoardColumn).findOne({ where: { id: ticket.column_id } });
  if (!col) return [];
  return parseSlugArray((col as unknown as { role_routing?: string }).role_routing);
}

/** 티켓의 합의 vote(최신-per-holder 는 순수 로직이 처리)를 코멘트에서 수집. */
async function collectVotes(dataSource: DataSource, ticketId: string) {
  const comments = await dataSource.getRepository(Comment).find({ where: { ticket_id: ticketId } });
  const votes: ConsensusVote[] = [];
  for (const c of comments) {
    let meta: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(c.metadata || '{}');
      if (parsed && typeof parsed === 'object') meta = parsed as Record<string, unknown>;
    } catch {
      /* 손상 metadata → 무시 */
    }
    const v = parseConsensusVote(meta, toEpochMs(c.created_at));
    if (v) votes.push(v);
  }
  return votes;
}

/**
 * 합의 상태 판정. `deps`(dataSource + grouped-holder resolver)로 라우팅 홀더 +
 * reporter 홀더 + 저장된 vote 를 모아 `computeConsensusState` 를 호출한다.
 * columnRoles 는 opts.routingRoleSlugs 로 명시하거나 현재 컬럼에서 도출.
 */
export async function getConsensusState(
  deps: ConsensusResolverDeps,
  ticket: Ticket,
  opts: GetConsensusStateOpts = {},
): Promise<ResolvedConsensusState> {
  const routingRoleSlugs = opts.routingRoleSlugs
    ? opts.routingRoleSlugs.filter((s) => typeof s === 'string' && !!s)
    : await deriveRoutingSlugs(deps.dataSource, ticket);

  const grouped = await deps.ticketRoleAssignmentService.resolveGroupedForTicket(ticket.id);
  const holdersBySlug = new Map<string, ConsensusParty[]>();
  for (const g of grouped) {
    holdersBySlug.set(
      g.role.slug,
      g.holders.map((h) => ({ type: h.type, id: h.id })),
    );
  }

  const requiredHolders: ConsensusParty[] = [];
  for (const slug of routingRoleSlugs) {
    for (const h of holdersBySlug.get(slug) || []) requiredHolders.push(h);
  }
  const reporterHolders = holdersBySlug.get('reporter') || [];

  const votes = await collectVotes(deps.dataSource, ticket.id);

  const state = computeConsensusState({
    requiredHolders,
    reporterHolders,
    votes,
    proposalId: opts.proposalId,
  });

  return { ...state, routingRoleSlugs };
}

// ─── 이동 제안(T5) 조회/소진 ───────────────────────────────────────────────
// `propose_move` 가 만든 제안 comment(marker consensus_proposal, id === proposalId)
// 를 조회하고, auto-execute 후 executed_at 을 찍어 재실행을 막는다.

export interface OpenConsensusProposal extends ParsedConsensusProposal {
  /** 제안 comment 의 id — 이것이 곧 proposalId(투표가 참조하는 값). */
  proposalId: string;
  /** 제안 comment created_at(epoch ms) — 최신 제안 선택용. */
  at: number;
}

/**
 * 티켓의 **최신 미실행 이동 제안**을 반환. 실행됨(executed_at) 제안은 제외.
 * 없으면 null. proposalId 는 제안 comment 의 id.
 */
export async function findOpenProposal(
  dataSource: DataSource,
  ticketId: string,
): Promise<OpenConsensusProposal | null> {
  const comments = await dataSource.getRepository(Comment).find({ where: { ticket_id: ticketId } });
  let best: OpenConsensusProposal | null = null;
  for (const c of comments) {
    let meta: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(c.metadata || '{}');
      if (parsed && typeof parsed === 'object') meta = parsed as Record<string, unknown>;
    } catch {
      continue;
    }
    const proposal = parseConsensusProposal(meta);
    if (!proposal || proposal.executedAt) continue; // 미실행 제안만
    const at = toEpochMs(c.created_at);
    if (!best || at >= best.at) best = { ...proposal, proposalId: c.id, at };
  }
  return best;
}

/**
 * 제안을 소진 처리(executed_at 스탬프)하고 **원자적으로 클레임**한다 — 동시에
 * 도착한 두 "마지막 승인"이 각각 satisfied 판정을 받아도 실제 이동은 한 번만
 * 실행되도록, 호출측(auto-execute)은 클레임 성공(true) 시에만 이동한다.
 * 조건부 UPDATE(compare-and-swap: 읽어 둔 metadata 원문과 일치할 때만 갱신)라
 * 경쟁자가 먼저 스탬프하면 affected=0 → false. 기존 metadata(author_role ·
 * consensus_proposal 마커 등)는 보존하고 proposal.executed_at 만 채운다.
 * `nowIso` 를 주입받아 순수하게(테스트 결정성) 유지.
 */
export async function markProposalExecuted(
  dataSource: DataSource,
  proposalCommentId: string,
  nowIso: string,
): Promise<boolean> {
  const repo = dataSource.getRepository(Comment);
  const comment = await repo.findOne({ where: { id: proposalCommentId } });
  if (!comment) return false;
  const prevRaw = comment.metadata || '';
  let meta: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(prevRaw || '{}');
    if (parsed && typeof parsed === 'object') meta = parsed as Record<string, unknown>;
  } catch {
    meta = {};
  }
  const proposal = (meta.proposal && typeof meta.proposal === 'object')
    ? (meta.proposal as Record<string, unknown>)
    : {};
  if (typeof proposal.executed_at === 'string' && proposal.executed_at) return false; // 이미 소진
  proposal.executed_at = nowIso;
  meta.proposal = proposal;
  const result = await repo
    .createQueryBuilder()
    .update(Comment)
    .set({ metadata: JSON.stringify(meta) })
    .where('id = :id AND metadata = :prev', { id: proposalCommentId, prev: prevRaw })
    .execute();
  return (result.affected ?? 0) > 0;
}

// ─── 이동 게이트 판정(T5, 결정 4) ────────────────────────────────────────────
// 홀더 수 기반 자동 게이트: 현재(이탈) 컬럼 라우팅 역할의 **전 홀더**가 ≥2 이고
// 합의 미성립이면 직접 이동을 차단한다. 홀더 ≤1 이면 절대 차단하지 않는다
// (하위호환 — 기존 단일홀더 보드/티켓은 게이트 없이 그대로 move_ticket 작동).

export interface ConsensusMoveGate {
  /** 게이트가 이동을 차단하는가(홀더 ≥2 & 미성립). */
  blocked: boolean;
  /** 판정 상태 — 차단 메시지(누가 pending)와 디버깅에 사용. */
  state: ResolvedConsensusState;
  /** 판정 앵커로 쓰인 열린(미실행) 제안 — 없으면 null. 뷰(T6)가 재조회 없이 재사용. */
  openProposal: OpenConsensusProposal | null;
}

/**
 * T5 이동 게이트 판정. 현재 컬럼 라우팅 홀더가 ≥2 이고 미성립이면 `blocked=true`.
 * 홀더 ≤1 이면 항상 `blocked=false`(제안 ceremony 불필요). `force`/reporter override
 * 우회는 **호출측**(move_ticket)이 판단한다 — 이 함수는 순수 판정만.
 *
 * 앵커는 **열린(미실행) 제안**으로 고정한다. 앵커를 생략(=최신 vote 가 참조한
 * proposalId)하면 auto-execute 로 이미 소진된 제안의 표가 다음 컬럼의 게이트를
 * 다시 만족시켜 — 합의가 티켓당 사실상 1회로 붕괴한다(실행 경로는 findOpenProposal
 * 로 소진을 방어하는데 게이트만 무방비인 비대칭). 열린 제안이 없으면 null 앵커 —
 * 소진된 제안을 참조하는 표는 전부 stale(pending) 처리된다.
 *
 * **게이트는 열린 제안이 있을 때만 통과시킨다(ticket bd6d58db).** 열린 제안이
 * 없으면(null 앵커) `state.satisfied` 여도 `blocked=true` 를 유지한다. null 앵커로
 * satisfied 가 되는 두 경로 — (1) 열린 제안 없이 던진 null-agree 표, (2) null-앵커
 * reporter override — 는 제안(executed_at 소진)과 달리 **소진 메커니즘이 없어**, 한
 * 번 게이트를 통과하면 앵커가 null 인 동안 다음 컬럼에서도 같은 표가 계속 게이트를
 * 연다(컬럼마다 재게이트되지 않는 지속성 우회). 정상 ceremony(propose_move)는 늘
 * 열린 제안을 앵커로 satisfied 되므로 무영향이고, 단일홀더(required<2)는 애초에
 * 차단되지 않는다. reporter 의 무제안 강제 통과는 `move_ticket(force=true)` 또는
 * propose_move 후 record_agreement(override)(열린 제안 auto-execute) 로 대체된다 —
 * 둘 다 소진/1회성이라 지속성이 없다.
 */
export async function evaluateConsensusMoveGate(
  deps: ConsensusResolverDeps,
  ticket: Ticket,
): Promise<ConsensusMoveGate> {
  const open = await findOpenProposal(deps.dataSource, ticket.id);
  const state = await getConsensusState(deps, ticket, { proposalId: open ? open.proposalId : null });
  // 게이트 통과는 **열린 제안** 앵커의 합의로만 인정한다(null 앵커 satisfied 는
  // 소진되지 않아 컬럼 간 지속 우회를 만든다). openProposal 은 마지막 승인 순간
  // auto-execute 가 executed_at 으로 소진하므로, 이동 후 다음 컬럼에선 다시 null → 재게이트.
  const satisfiedForGate = state.satisfied && open !== null;
  const blocked = state.required.length >= 2 && !satisfiedForGate;
  return { blocked, state, openProposal: open };
}
