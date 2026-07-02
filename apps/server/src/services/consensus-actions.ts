/**
 * 다중담당자·합의 (multi-assignee consensus) — 합의 액션 오케스트레이션(T6 노출 계층).
 *
 * `consensus.service`(순수 판정 + 제안 조회/소진) 위에 얹는 **부작용 있는** 액션:
 *   - 제안 열기(openMoveProposal) · 시그널 캐스트(recordConsensusVote) · 합의 성립
 *     auto-execute(autoExecuteConsensusMove) · consensus_update SSE 방출.
 *
 * MCP 툴(`propose_move`/`record_agreement`)이 인라인으로 하던 이 로직을 한 곳으로
 * 모아, (1) 새 REST 브릿지(브라우저 = 웹 UI T6)와 (2) 기존 MCP 핸들러가 **같은**
 * SSE payload/auto-execute 경로를 공유하게 한다 — consensus_update wire 계약과
 * 자동 이동 부작용의 드리프트를 원천 차단(패리티 가드 정신과 동일).
 *
 * 저자 해석(MCP 세션 핀 vs REST 로그인 유저)·author_role 핀·harness 마커 sanitize
 * 같은 **호출측 관심사**는 여기 넣지 않는다 — 호출측이 이미 만든 `by`/`byName` 만
 * 받아 판정·이동·방출의 공통 부분만 담당한다.
 */

import type { DataSource } from 'typeorm';
import { In } from 'typeorm';
import { Ticket } from '../entities/Ticket';
import { BoardColumn } from '../entities/BoardColumn';
import { Comment, CommentType } from '../entities/Comment';
import { Agent } from '../entities/Agent';
import { User } from '../entities/User';
import {
  buildConsensusMetadata,
  buildProposalMetadata,
  type ConsensusParty,
} from '../common/consensus-state';
import type { ConsensusUpdatePayload } from '../common/types/stream-events';
import {
  getConsensusState,
  findOpenProposal,
  markProposalExecuted,
  evaluateConsensusMoveGate,
  type ConsensusResolverDeps,
  type ResolvedConsensusState,
} from './consensus.service';
import { performColumnMove } from '../modules/mcp/shared/ticket-move';
import { activityEvents, type ActivityService } from './activity.service';

/** 판정(consensus.service) + 부작용(활동 로그/이동)을 함께 쓰는 의존성 번들. */
export interface ConsensusActionDeps extends ConsensusResolverDeps {
  activityService: ActivityService;
}

function makeError(status: number, message: string): Error & { status: number } {
  const err = new Error(message) as Error & { status: number };
  err.status = status;
  return err;
}

/** 합의 auto-move 의 `moved` 활동에 찍는 sentinel actor id. trigger-loop 의
 *  auto-advance(AUTO_ADVANCE_ACTOR_ID='auto-advance')와 같은 이유로 **의도적으로
 *  non-'system'** — 'system' actor 의 moved 는 트리거 루프 최상단에서 드랍되어
 *  목적지 컬럼 role 홀더가 영영 디스패치되지 않는다(다음 phase 미진입, T7 E2E 가
 *  검출한 T5 잔존 버그). uuid 가 아니므로 per-holder self-guard 는 아무도 스킵하지
 *  않는다(전 홀더 팬아웃 — 새 phase 의 정상 트리거). */
const CONSENSUS_ACTOR_ID = 'consensus';

const partyKey = (p: ConsensusParty): string => `${p.type}:${p.id}`;

function toIso(d: Date | string | null | undefined): string {
  if (d instanceof Date) return d.toISOString();
  if (typeof d === 'string' && d) return d;
  return new Date().toISOString();
}

/**
 * consensus_update SSE payload 를 만든다(순수). MCP 핸들러와 REST 브릿지가 **동일한**
 * 필드 집합을 방출하도록 단일 소스로 둔다 — event-registry `map()` 이 읽는 12개 flat
 * 필드 + `timestamp`(envelope 로 전달) 를 그대로 채운다. `state` 의 party 배열은
 * `.length` 카운트로 투영(상세 홀더 목록은 UI 가 REST 로 재조회).
 */
export function buildConsensusUpdatePayload(
  ticket: { id: string; workspace_id: string },
  state: Pick<ResolvedConsensusState, 'proposalId' | 'satisfied' | 'required' | 'agreed' | 'objected' | 'pending'>,
  opts: { status: 'agree' | 'object'; override: boolean; actorId: string; actorName: string; timestamp: string },
): ConsensusUpdatePayload & { timestamp: string } {
  return {
    ticket_id: ticket.id,
    workspace_id: ticket.workspace_id,
    proposal_id: state.proposalId,
    satisfied: state.satisfied,
    required: state.required.length,
    agreed: state.agreed.length,
    objected: state.objected.length,
    pending: state.pending.length,
    status: opts.status,
    override: opts.override,
    actor_id: opts.actorId,
    actor_name: opts.actorName,
    timestamp: opts.timestamp,
  };
}

/**
 * party(`{type,id}`) 목록의 표시 이름을 배치 조회해 `"type:id" → name` 맵으로 반환.
 * 합의 패널(T6)이 required/agreed/pending 홀더를 이름으로 렌더할 수 있게 한다 —
 * 클라의 (필터된) agents 목록에 없는 홀더도 서버가 권위 있게 이름을 채워 준다.
 */
export async function resolvePartyNames(
  dataSource: DataSource,
  parties: ConsensusParty[],
): Promise<Record<string, string>> {
  const agentIds = [...new Set(parties.filter((p) => p.type === 'agent').map((p) => p.id))];
  const userIds = [...new Set(parties.filter((p) => p.type === 'user').map((p) => p.id))];
  const [agents, users] = await Promise.all([
    agentIds.length ? dataSource.getRepository(Agent).find({ where: { id: In(agentIds) } }) : Promise.resolve([] as Agent[]),
    userIds.length ? dataSource.getRepository(User).find({ where: { id: In(userIds) } }) : Promise.resolve([] as User[]),
  ]);
  const out: Record<string, string> = {};
  for (const a of agents) out[`agent:${a.id}`] = a.name;
  for (const u of users) out[`user:${u.id}`] = u.name || u.email;
  return out;
}

/**
 * 합의 성립 시 열린 이동 제안을 서버가 **자동 실행**한다(T5, 결정 2). MCP
 * `record_agreement` 의 auto-execute 블록과 동일한 부작용 — REST 투표 경로도 같은
 * 헬퍼를 써서 "마지막 승인 → 자동 이동" 이 두 경로에서 한 번만 정의되게 한다.
 *
 *   - satisfied && 열린 제안 존재 && 판정 앵커(state.proposalId)==그 제안 일 때만 실행.
 *   - **이동 전에** markProposalExecuted 로 원자 클레임(조건부 UPDATE) — 동시에
 *     도착한 두 "마지막 승인"이 각각 satisfied 를 보더라도 클레임 승자 한쪽만
 *     이동한다(이중 이동/이중 팬아웃 방지). 클레임 후 이동이 실패하는 드문 경우
 *     제안은 소진된 채 남는다 — 복구는 재제안(안전 방향: 이동 0회 ≤ 1회).
 *   - moved 활동의 actor 는 CONSENSUS_ACTOR_ID('consensus')/'Consensus' —
 *     non-'system' 이라 트리거 루프가 재진입해 **목적지 컬럼 role 홀더를
 *     디스패치**한다(다음 phase 진입). 감사용 consensus_move 활동은 반대로
 *     actor_id='system' 을 유지해 ticket_update 트리거로 이중 발화되지 않는다.
 *
 * 이동 실패는 호출측 시그널 저장을 깨뜨리지 않도록 호출측이 try/catch 로 감싼다.
 */
export async function autoExecuteConsensusMove(
  deps: ConsensusActionDeps,
  ticket: Ticket,
  state: ResolvedConsensusState,
  nowIso: string,
  lastApproverName?: string,
): Promise<{ proposal_id: string; to_column_id: string; to_column_name: string | null } | null> {
  if (!state.satisfied) return null;
  const open = await findOpenProposal(deps.dataSource, ticket.id);
  if (!open || open.proposalId !== state.proposalId) return null;

  const destCol = await deps.dataSource.getRepository(BoardColumn).findOne({ where: { id: open.targetColumnId } });
  if (!destCol) return null;

  const claimed = await markProposalExecuted(deps.dataSource, open.proposalId, nowIso);
  if (!claimed) return null; // 경쟁 승인 경로가 이미 클레임 — 이중 이동 방지

  await performColumnMove(deps.dataSource, deps.activityService, {
    ticket,
    destColumnId: open.targetColumnId,
    actorId: CONSENSUS_ACTOR_ID,
    actorName: 'Consensus',
    triggerSource: 'consensus_auto',
  });

  // 감사: 어떤 합의가 어디로 이동시켰는지 + 마지막 승인자. actor_id 는 의도적으로
  // 'system' — 이 updated 활동까지 non-system 이면 트리거 루프의 ticket_update
  // 경로로 목적지 홀더가 이중 트리거된다(moved 쪽이 유일한 디스패치 소스).
  await deps.activityService.logActivity({
    entity_type: 'ticket', entity_id: ticket.id, action: 'updated',
    ticket_id: ticket.id, actor_id: 'system', actor_name: 'Consensus',
    field_changed: 'consensus_move',
    new_value: `합의 성립(제안 ${open.proposalId}) → '${destCol.name}' 자동 이동${lastApproverName ? ` · 마지막 승인 ${lastApproverName}` : ''}`,
  });

  return { proposal_id: open.proposalId, to_column_id: destCol.id, to_column_name: destCol.name ?? null };
}

/** 합의 패널(T6 GET)이 소비하는 뷰 — 상태 + 열린 제안 + 홀더 이름 + 게이트 요약. */
export interface ConsensusView {
  state: ResolvedConsensusState;
  proposal: {
    proposal_id: string;
    target_column_id: string;
    target_column_name: string | null;
    by: ConsensusParty;
    at: number;
  } | null;
  /** `"type:id" → 표시 이름`. state/proposal 의 모든 party 이름을 미리 채워 준다. */
  names: Record<string, string>;
  /** 이동 게이트 요약 — 홀더≥2 & 미성립이면 blocked(=직접 이동 대신 제안 필요). */
  gate: { blocked: boolean; holder_count: number };
}

/**
 * 티켓의 현재 합의 상태를 REST 로 노출(브라우저는 MCP 판정 경로에 접근 못 함).
 * 판정은 `evaluateConsensusMoveGate` 를 그대로 재사용한다 — 게이트와 뷰가 같은
 * 열린-제안 앵커를 쓰지 않으면, 소진(executed)된 제안의 표로 뷰만 satisfied 로
 * 보여 UI 가 열어 준 직접 이동이 서버 게이트(409 consensus_required)에 막히는
 * 불일치가 생긴다.
 */
export async function getConsensusView(deps: ConsensusActionDeps, ticket: Ticket): Promise<ConsensusView> {
  const { blocked, state, openProposal: open } = await evaluateConsensusMoveGate(deps, ticket);

  const parties: ConsensusParty[] = [
    ...state.required, ...state.agreed, ...state.objected, ...state.pending,
    ...(state.overriddenBy ? [state.overriddenBy] : []),
    ...(open ? [open.by] : []),
  ];
  const names = await resolvePartyNames(deps.dataSource, parties);

  return {
    state,
    proposal: open
      ? {
          proposal_id: open.proposalId,
          target_column_id: open.targetColumnId,
          target_column_name: open.targetColumnName,
          by: open.by,
          at: open.at,
        }
      : null,
    names,
    // 이탈(현재) 컬럼 라우팅 홀더가 ≥2 & 미성립이면 직접 이동 차단 → 제안 필요.
    gate: { blocked, holder_count: state.required.length },
  };
}

/**
 * 이동 제안 열기(T5). 현재 컬럼 라우팅 홀더가 ≥2 여야 하며(≤1 은 직접 이동), 제안
 * comment 의 id 가 곧 proposalId. 제안엔 vote 마커를 심지 않아 공동 홀더에게 팬아웃돼
 * 투표를 유도한다. 재판정 후 consensus_update SSE 방출.
 */
export async function openMoveProposal(
  deps: ConsensusActionDeps,
  input: { ticket: Ticket; by: ConsensusParty; byName: string; destColumnId: string; content?: string },
): Promise<{ comment: Comment; proposal_id: string; target_column: { id: string; name: string }; consensus: ResolvedConsensusState }> {
  const { ticket, by, byName, destColumnId, content } = input;

  if (destColumnId === ticket.column_id) {
    throw makeError(400, '제안 대상이 현재 컬럼과 동일합니다 — 이동 제안이 아닙니다.');
  }
  const destCol = await deps.dataSource.getRepository(BoardColumn).findOne({ where: { id: destColumnId } });
  if (!destCol) throw makeError(404, 'Target column not found');

  // 현재(이탈) 컬럼 라우팅 홀더 수 확인 — ≤1 이면 ceremony 불필요.
  const preState = await getConsensusState(deps, ticket, {});
  if (preState.required.length < 2) {
    throw makeError(
      400,
      `이 컬럼의 라우팅 역할 홀더가 ${preState.required.length}명입니다(≤1). 합의 ceremony 가 불필요하니 직접 이동하세요.`,
    );
  }

  const currentCol = ticket.column_id
    ? await deps.dataSource.getRepository(BoardColumn).findOne({ where: { id: ticket.column_id } })
    : null;
  const headline = `이동 제안: '${currentCol?.name ?? '—'}' → '${destCol.name}' (by ${byName}). 전 홀더가 동의하면 서버가 자동 이동합니다.`;
  const body = content && content.trim() ? `${headline}\n\n${content.trim()}` : headline;

  const commentRepo = deps.dataSource.getRepository(Comment);
  const comment = await commentRepo.save(commentRepo.create({
    ticket_id: ticket.id,
    author_type: by.type,
    author_id: by.id,
    author: byName,
    content: body,
    type: 'note' as CommentType,
    metadata: JSON.stringify(buildProposalMetadata({ targetColumnId: destCol.id, targetColumnName: destCol.name, by })),
  }));

  // 이 제안을 앵커로 재판정 — pending(아직 투표 안 한 홀더)이 드러난다.
  const state = await getConsensusState(deps, ticket, { proposalId: comment.id });

  await deps.activityService.logActivity({
    entity_type: 'comment', entity_id: comment.id, action: 'created',
    ticket_id: ticket.id, actor_id: by.id, actor_name: byName,
    new_value: JSON.stringify({ target_column_id: destCol.id, target_column_name: destCol.name, proposal_id: comment.id }),
    field_changed: 'consensus_proposal',
  });

  // consensus_update SSE(UI T6) — 제안엔 시그널이 없어 중립값 status='agree'.
  activityEvents.emit('consensus_update', buildConsensusUpdatePayload(ticket, state, {
    status: 'agree', override: false, actorId: by.id, actorName: byName, timestamp: toIso(comment.created_at),
  }));

  return { comment, proposal_id: comment.id, target_column: { id: destCol.id, name: destCol.name }, consensus: state };
}

/**
 * 합의 시그널 캐스트(agree/object) + reporter override. 재판정 후 consensus_update
 * SSE 방출, 합의 성립 시 auto-execute 이동. MCP `record_agreement` 와 동일 부작용.
 * override 는 reporter 홀더에게만 유효(비-reporter override 는 조용히 무시).
 */
export async function recordConsensusVote(
  deps: ConsensusActionDeps,
  input: {
    ticket: Ticket; by: ConsensusParty; byName: string;
    status: 'agree' | 'object'; proposalId?: string | null; override?: boolean; content?: string;
  },
): Promise<{ comment: Comment; consensus: ResolvedConsensusState; moved: { proposal_id: string; to_column_id: string; to_column_name: string | null } | null }> {
  const { ticket, by, byName, status, content } = input;

  let proposalId = input.proposalId && input.proposalId.trim() ? input.proposalId.trim() : null;
  // proposal_id 생략 시 최신 열린 제안을 앵커로 자동 채택 → 홀더는 agree 만 눌러도
  // 현재 제안에 투표된다.
  if (!proposalId) {
    const open = await findOpenProposal(deps.dataSource, ticket.id);
    if (open) proposalId = open.proposalId;
  }

  // override 게이트: reporter 홀더만 강제 통과할 수 있다.
  let effectiveOverride = false;
  if (input.override === true) {
    const grouped = await deps.ticketRoleAssignmentService.resolveGroupedForTicket(ticket.id);
    const reporter = grouped.find((g) => g.role.slug === 'reporter');
    effectiveOverride = !!reporter?.holders.some((h) => h.type === by.type && h.id === by.id);
  }

  const headline = `합의 시그널: ${status}${proposalId ? ` (제안 ${proposalId})` : ''}${effectiveOverride ? ' · reporter override' : ''}`;
  const body = content && content.trim() ? `${headline}\n\n${content.trim()}` : headline;

  const commentRepo = deps.dataSource.getRepository(Comment);
  const comment = await commentRepo.save(commentRepo.create({
    ticket_id: ticket.id,
    author_type: by.type,
    author_id: by.id,
    author: byName,
    content: body,
    type: 'note' as CommentType,
    metadata: JSON.stringify(buildConsensusMetadata({ status, proposalId, by, override: effectiveOverride })),
  }));

  // 이 vote 반영 후 재판정.
  const state = await getConsensusState(deps, ticket, { proposalId });

  const activityValue = JSON.stringify({
    status, proposal_id: proposalId, override: effectiveOverride,
    satisfied: state.satisfied,
    required: state.required.length, agreed: state.agreed.length,
    objected: state.objected.length, pending: state.pending.length,
    proposal_anchor: state.proposalId,
  });
  await deps.activityService.logActivity({
    entity_type: 'comment', entity_id: comment.id, action: 'created',
    ticket_id: ticket.id, actor_id: by.id, actor_name: byName,
    new_value: activityValue, field_changed: 'consensus',
  });

  activityEvents.emit('consensus_update', buildConsensusUpdatePayload(ticket, state, {
    status, override: effectiveOverride, actorId: by.id, actorName: byName, timestamp: toIso(comment.created_at),
  }));

  // reporter override 감사 로그.
  if (effectiveOverride && state.overriddenBy) {
    await deps.activityService.logActivity({
      entity_type: 'ticket', entity_id: ticket.id, action: 'updated',
      ticket_id: ticket.id, actor_id: by.id, actor_name: byName,
      field_changed: 'consensus_override',
      new_value: `reporter ${byName} forced consensus${proposalId ? ` on proposal ${proposalId}` : ''}`,
    });
  }

  // auto-execute — 합의 성립 + 열린 제안 매칭 시 서버가 실제 이동.
  let moved: { proposal_id: string; to_column_id: string; to_column_name: string | null } | null = null;
  try {
    moved = await autoExecuteConsensusMove(deps, ticket, state, toIso(comment.created_at), byName);
  } catch {
    /* best-effort — 이동 실패가 시그널 저장을 깨뜨리지 않게 무시(감사는 로그로 남음) */
  }

  return { comment, consensus: state, moved };
}

// party 중복 제거 유틸(뷰에서 이름 조회 최소화용 — 필요 시 사용).
export function dedupeParties(parties: ConsensusParty[]): ConsensusParty[] {
  const seen = new Set<string>();
  const out: ConsensusParty[] = [];
  for (const p of parties) {
    const k = partyKey(p);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(p);
  }
  return out;
}
