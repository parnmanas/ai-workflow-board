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
 * 제안을 소진 처리(executed_at 스탬프) — auto-execute 성공 후 호출해 중복 이동을
 * 막는다. 기존 metadata(author_role 등)를 보존하고 consensus_proposal.executed_at
 * 만 채운다. `nowIso` 를 주입받아 순수하게(테스트 결정성) 유지.
 */
export async function markProposalExecuted(
  dataSource: DataSource,
  proposalCommentId: string,
  nowIso: string,
): Promise<void> {
  const repo = dataSource.getRepository(Comment);
  const comment = await repo.findOne({ where: { id: proposalCommentId } });
  if (!comment) return;
  let meta: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(comment.metadata || '{}');
    if (parsed && typeof parsed === 'object') meta = parsed as Record<string, unknown>;
  } catch {
    meta = {};
  }
  const proposal = (meta.consensus_proposal && typeof meta.consensus_proposal === 'object')
    ? (meta.consensus_proposal as Record<string, unknown>)
    : {};
  proposal.executed_at = nowIso;
  meta.consensus_proposal = proposal;
  await repo.update(proposalCommentId, { metadata: JSON.stringify(meta) });
}
