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
  type ConsensusParty,
  type ConsensusState,
  type ConsensusVote,
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
