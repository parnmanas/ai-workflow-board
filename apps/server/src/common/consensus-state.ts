/**
 * 다중담당자·합의 (multi-assignee consensus) — T4 판정 모델 (pure logic).
 *
 * "누가 동의/이의했는가" 와 "지금 합의 상태인가" 를 결정하는 DB-free 순수 로직.
 * `consensus-meta.ts`(마커) 와 `author-role.ts`(역할 판정) 처럼 서비스/DB 없이
 * 단위 테스트할 수 있도록 분리했다. 규칙 4종:
 *
 *   1. 명시적 승인 — 홀더는 특정 **이동 제안**(T5)에 대해 `agree`/`object` 시그널을
 *      남긴다. 한 홀더의 **최신 시그널만** 유효(갱신 가능).
 *   2. 전원 만장일치 — 라우팅 역할의 **전 홀더**가 현재 제안에 `agree` → 합의 성립.
 *   3. stale 무효화 — 새 실질 변경(=새 제안)이 생기면 이전 제안에 대한 승인은
 *      현재 제안과 `proposalId` 가 달라 무효(pending) 처리된다.
 *   4. reporter override — reporter 가 tie-break/강제 통과할 수 있다(감사 로그 대상).
 *
 * 홀더 1명이면 그의 단일 `agree` 로 즉시 satisfied(부분/이의 없음). 시그널 자체는
 * Comment(metadata.consensus_vote === true, {@link ./consensus-meta})에 실린다 —
 * 이 모듈은 **파싱된 vote 만** 해석한다. DB 수집(votes + 라우팅 홀더)은
 * `ConsensusService` 가, 결과 `ConsensusState` 소비는 T5 게이트·T6 UI 가 맡는다.
 */

import {
  CONSENSUS_VOTE_META_KEY,
  CONSENSUS_PROPOSAL_META_KEY,
  isConsensusVoteComment,
  isConsensusProposalComment,
} from './consensus-meta';

export type ConsensusStatus = 'agree' | 'object';

/** 홀더/투표자 신원 — 코드 전반의 (type,id) 형태와 동일. */
export interface ConsensusParty {
  type: 'agent' | 'user';
  id: string;
}

/**
 * Comment.metadata 에서 이미 파싱된 하나의 합의 시그널.
 *
 *   - `proposalId` — vote 를 특정 이동 제안(T5)에 고정. 판정 중인 제안과 다르면
 *     STALE(더 최근의 실질 변경이 이전 승인을 대체) → pending 처리.
 *   - `at` — 코멘트 created_at(epoch ms). 홀더별 **최신** 시그널 선택에 사용.
 *   - `override` — reporter 강제 통과 마커(결정 3).
 */
export interface ConsensusVote {
  by: ConsensusParty;
  status: ConsensusStatus;
  proposalId: string | null;
  at: number;
  override?: boolean;
}

export interface ConsensusStateInput {
  /** 현재 컬럼 라우팅 역할의 **전 홀더** — 합의에 필요한 투표자 집합. */
  requiredHolders: ConsensusParty[];
  /** reporter 홀더 — pending/이의가 있어도 강제 통과(override)할 수 있다. */
  reporterHolders?: ConsensusParty[];
  /** 티켓의 모든 합의 vote(제안 무관). 홀더별 최신 vote 만 유효. */
  votes: ConsensusVote[];
  /**
   * 판정 대상 제안. vote 는 `proposalId` 가 이 값과 같을 때만 현재 유효로 센다
   * (`null` 은 null vote 와 매칭 — 아직 T5 정식 제안이 없는 홀더 1명 즉시-합의 등).
   * 생략하면 앵커는 **가장 최근 vote 가 참조한 non-null proposalId** 로 결정된다
   * (서비스가 T5 상태를 몰라도 "최신 제안이 합의됐나?" 를 물을 수 있게).
   */
  proposalId?: string | null;
}

export interface ConsensusState {
  /** 판정이 고정된 제안(해석된 앵커). */
  proposalId: string | null;
  required: ConsensusParty[];
  agreed: ConsensusParty[];
  objected: ConsensusParty[];
  /** 현재 제안에 대한 유효 vote 가 없는(=미투표 또는 stale) 필수 홀더. */
  pending: ConsensusParty[];
  satisfied: boolean;
  /** reporter override 로 satisfied 가 강제된 경우 그 reporter. */
  overriddenBy?: ConsensusParty;
}

const partyKey = (p: ConsensusParty): string => `${p.type}:${p.id}`;

/** 두 proposalId 가 같은 제안인지(null===null 포함). */
const sameProposal = (a: string | null, b: string | null): boolean => a === b;

/** 홀더별 최신 vote 맵 — 동률(at)이면 배열 뒤쪽(나중 인코딩)이 이긴다. */
function latestVotesByHolder(votes: ConsensusVote[]): Map<string, ConsensusVote> {
  const out = new Map<string, ConsensusVote>();
  for (const v of votes) {
    const key = partyKey(v.by);
    const prev = out.get(key);
    if (!prev || v.at >= prev.at) out.set(key, v);
  }
  return out;
}

/**
 * 합의 상태 판정. 순수 함수 — 입력(필수 홀더 + votes + 앵커 + reporter)만으로
 * `{required, agreed, pending, objected, satisfied, overriddenBy?}` 를 낸다.
 */
export function computeConsensusState(input: ConsensusStateInput): ConsensusState {
  const votes = Array.isArray(input.votes) ? input.votes : [];
  const latest = latestVotesByHolder(votes);

  // 1. 앵커 해석: 명시 제안 우선, 없으면 최신 vote 가 참조한 non-null proposalId.
  let anchor: string | null;
  if (input.proposalId !== undefined) {
    anchor = input.proposalId;
  } else {
    let newest: ConsensusVote | null = null;
    for (const v of votes) {
      if (v.proposalId === null) continue;
      if (!newest || v.at > newest.at) newest = v;
    }
    anchor = newest ? newest.proposalId : null;
  }

  // 2. 필수 홀더 정규화(중복 역할 겸직 홀더는 1회만).
  const required: ConsensusParty[] = [];
  const seenRequired = new Set<string>();
  for (const h of input.requiredHolders || []) {
    const key = partyKey(h);
    if (seenRequired.has(key)) continue;
    seenRequired.add(key);
    required.push({ type: h.type, id: h.id });
  }

  // 3. reporter override: reporter 홀더의 최신 vote 가 현재 앵커에 대한
  //    override 승인이면 강제 통과. (stale override 는 새 제안을 통과시키지 못함.)
  let overriddenBy: ConsensusParty | undefined;
  for (const rep of input.reporterHolders || []) {
    const v = latest.get(partyKey(rep));
    if (v && v.override === true && v.status === 'agree' && sameProposal(v.proposalId, anchor)) {
      overriddenBy = { type: rep.type, id: rep.id };
      break;
    }
  }

  // 4. 필수 홀더 분류.
  const agreed: ConsensusParty[] = [];
  const objected: ConsensusParty[] = [];
  const pending: ConsensusParty[] = [];
  for (const h of required) {
    const v = latest.get(partyKey(h));
    const current = v && sameProposal(v.proposalId, anchor);
    if (!current) {
      pending.push(h); // 미투표 또는 stale(이전 제안에 대한 승인)
    } else if (v!.status === 'agree') {
      agreed.push(h);
    } else {
      objected.push(h);
    }
  }

  // 5. satisfied: (이의 0 && pending 0 && 전원 agree) 또는 reporter override.
  const unanimous =
    required.length > 0 &&
    objected.length === 0 &&
    pending.length === 0 &&
    agreed.length === required.length;
  const satisfied = !!overriddenBy || unanimous || (required.length === 0);

  const state: ConsensusState = { proposalId: anchor, required, agreed, objected, pending, satisfied };
  if (overriddenBy) state.overriddenBy = overriddenBy;
  return state;
}

// ─── Comment.metadata ↔ ConsensusVote 브릿지 ──────────────────────────────
// 툴(record_agreement, 시그널 저장)과 서비스(vote 수집)가 payload 모양 하나를
// 공유하도록 여기 둔다. 마커 키는 `consensus-meta` 가 단일 정의.

/** metadata.consensus 하위 payload 모양. `at` 은 comment.created_at 이 권위. */
export interface ConsensusVoteMeta {
  status: ConsensusStatus;
  proposal_id: string | null;
  by: ConsensusParty;
  override?: boolean;
}

/**
 * 합의 vote 코멘트의 metadata 를 만든다. `consensus_vote: true`(T2 재디스패치
 * 억제 + `isConsensusVoteComment`) + 구조화된 `consensus` payload.
 */
export function buildConsensusMetadata(vote: {
  status: ConsensusStatus;
  proposalId: string | null;
  by: ConsensusParty;
  override?: boolean;
}): Record<string, unknown> {
  const consensus: ConsensusVoteMeta = {
    status: vote.status,
    proposal_id: vote.proposalId ?? null,
    by: { type: vote.by.type, id: vote.by.id },
  };
  if (vote.override) consensus.override = true;
  return { [CONSENSUS_VOTE_META_KEY]: true, consensus };
}

/**
 * 파싱된 metadata 에서 `ConsensusVote` 를 복원. 마커가 없거나 payload 가 손상되면
 * null(무시 = 일반 코멘트). `atMs` 는 코멘트 created_at(epoch ms).
 */
export function parseConsensusVote(
  metadata: Record<string, unknown> | null | undefined,
  atMs: number,
): ConsensusVote | null {
  if (!isConsensusVoteComment(metadata)) return null;
  const raw = (metadata as Record<string, unknown>).consensus;
  if (!raw || typeof raw !== 'object') return null;
  const c = raw as Record<string, unknown>;
  const status = c.status;
  if (status !== 'agree' && status !== 'object') return null;
  const by = c.by as Record<string, unknown> | undefined;
  const byType = by?.type;
  const byId = by?.id;
  if ((byType !== 'agent' && byType !== 'user') || typeof byId !== 'string' || !byId) return null;
  const proposalId = typeof c.proposal_id === 'string' && c.proposal_id ? c.proposal_id : null;
  const vote: ConsensusVote = {
    by: { type: byType, id: byId },
    status,
    proposalId,
    at: atMs,
  };
  if (c.override === true) vote.override = true;
  return vote;
}

// ─── Comment.metadata ↔ 이동 제안(T5) 브릿지 ──────────────────────────────
// 투표 브릿지와 같은 위치에 둬서 마커/payload 모양이 한 곳에 모이게 한다.
// 제안 comment 의 **id 자체가 proposalId** — 투표는 그 id 를 참조하고, 게이트는
// 최신 미실행 제안을 읽어 "합의 성립 시 어디로 이동할지" 를 안다.

/** metadata.consensus_proposal 하위 payload 모양. */
export interface ConsensusProposalMeta {
  /** 합의 성립 시 이동할 대상 컬럼. */
  target_column_id: string;
  /** 감사/표시용 대상 컬럼 이름(선택). */
  target_column_name?: string;
  /** 제안자. */
  by: ConsensusParty;
  /** auto-execute 가 실행된 시각(ISO). 있으면 그 제안은 소진됨(재실행 금지). */
  executed_at?: string;
}

/** 파싱된 제안 payload(런타임 read 편의 형태). */
export interface ParsedConsensusProposal {
  targetColumnId: string;
  targetColumnName: string | null;
  by: ConsensusParty;
  executedAt: string | null;
}

/**
 * 이동 제안 comment 의 metadata 를 만든다. `consensus_proposal: true` 마커(팬아웃
 * 억제 안 함 — 공동 홀더를 깨워 투표하게) + 구조화된 `consensus_proposal` payload.
 * **투표 마커(consensus_vote)는 심지 않는다** — 제안은 투표가 아니다.
 */
export function buildProposalMetadata(proposal: {
  targetColumnId: string;
  targetColumnName?: string | null;
  by: ConsensusParty;
  executedAt?: string | null;
}): Record<string, unknown> {
  const payload: ConsensusProposalMeta = {
    target_column_id: proposal.targetColumnId,
    by: { type: proposal.by.type, id: proposal.by.id },
  };
  if (proposal.targetColumnName) payload.target_column_name = proposal.targetColumnName;
  if (proposal.executedAt) payload.executed_at = proposal.executedAt;
  return { [CONSENSUS_PROPOSAL_META_KEY]: true, consensus_proposal: payload };
}

/**
 * 파싱된 metadata 에서 이동 제안을 복원. 마커가 없거나 payload 가 손상되면 null.
 * `target_column_id` 는 필수 — 없으면 무효 제안으로 무시.
 */
export function parseConsensusProposal(
  metadata: Record<string, unknown> | null | undefined,
): ParsedConsensusProposal | null {
  if (!isConsensusProposalComment(metadata)) return null;
  const raw = (metadata as Record<string, unknown>).consensus_proposal;
  if (!raw || typeof raw !== 'object') return null;
  const p = raw as Record<string, unknown>;
  const targetColumnId = typeof p.target_column_id === 'string' && p.target_column_id ? p.target_column_id : null;
  if (!targetColumnId) return null;
  const by = p.by as Record<string, unknown> | undefined;
  const byType = by?.type;
  const byId = by?.id;
  if ((byType !== 'agent' && byType !== 'user') || typeof byId !== 'string' || !byId) return null;
  return {
    targetColumnId,
    targetColumnName: typeof p.target_column_name === 'string' && p.target_column_name ? p.target_column_name : null,
    by: { type: byType, id: byId },
    executedAt: typeof p.executed_at === 'string' && p.executed_at ? p.executed_at : null,
  };
}
