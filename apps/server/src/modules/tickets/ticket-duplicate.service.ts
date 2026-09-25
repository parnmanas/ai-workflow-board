import { Injectable } from '@nestjs/common';
import { DataSource, EntityManager, In, IsNull } from 'typeorm';
import { Ticket } from '../../entities/Ticket';
import { TicketDuplicateDecision } from '../../entities/TicketDuplicateDecision';
import { Comment } from '../../entities/Comment';
import { DispatchIntent } from '../../entities/DispatchIntent';
import { ActivityLog } from '../../entities/ActivityLog';
import { BoardColumn } from '../../entities/BoardColumn';
import { randomUUID } from 'crypto';
import { dispatchBackoffMs, readReconcilerConfig } from '../agents/dispatch-intent.service';
import { isDuplicateDecisionPending } from './ticket-duplicate-pending';
import { emitFocusReleased, emitPromotionRecheck } from '../agents/focus-eligibility';

export interface DuplicateIntake {
  title: string;
  description?: string;
  labels?: string[];
  // 'chat', or an outreach kind ('reddit' | 'github'); matching only ever
  // compares candidates that share the same kind (see assess()).
  source_kind?: string;
  source_chat_room_id?: string;
  related_ticket_id?: string | null;
}

export interface DuplicateMatch {
  ticket_id: string;
  title: string;
  confidence: number;
  matched_signals: string[];
}

export interface DuplicateAssessment {
  source_kind: string;
  source_chat_room_id: string;
  related_ticket_id: string | null;
  canonical_ticket_id: string | null;
  ambiguous: boolean;
  candidates: DuplicateMatch[];
}

/**
 * 확정 오탐 정정이 재dispatch 를 건너뛴 사유 (ticket 83c5e25c).
 *
 * 링크 해제는 컬럼과 무관한 **데이터 정정**이라 항상 수행된다. 재dispatch 는
 * 그 위에 얹는 편의이고, 지금 컬럼에서 그 role 을 깨울 수 없으면 조용히
 * 건너뛴다 — 빈 문자열이 아니면 "해제만 했다" 는 뜻이다.
 */
export type DuplicateCorrectionDispatchSkip =
  | ''
  | 'no_board_column'
  | 'terminal_column'
  | 'role_not_routed_in_current_column'
  | 'role_has_no_holder'
  | 'ticket_pending';

export interface ConfirmedLinkCorrection {
  ticket: Ticket;
  previousCanonicalId: string;
  /** 건너뛴 경우 빈 문자열 — 새 intent 를 만들지 않았다는 뜻. */
  intentId: string;
  generation: number;
  leaseOwner: string;
  agentId: string;
  dispatchSkippedReason: DuplicateCorrectionDispatchSkip;
}

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';

@Injectable()
export class TicketDuplicateService {
  constructor(private readonly dataSource: DataSource) {}

  normalizeTitle(value: string): string {
    return (value || '')
      .normalize('NFKC')
      .toLocaleLowerCase()
      .replace(/^\s*(?:\[(?:bug|버그|fix|regression)\]|(?:bug|버그|fix|regression)\s*[:\-])\s*/i, '')
      .replace(/[^\p{Letter}\p{Number}]+/gu, ' ')
      .trim()
      .replace(/\s+/g, ' ');
  }

  parseProvenance(input: DuplicateIntake) {
    const description = input.description || '';
    const explicitKind = (input.source_kind || '').trim().toLowerCase();
    const legacyChat = /(?:^|\n)\s*source\s*:\s*chat\b/i.test(description);
    const room = (input.source_chat_room_id || '').trim()
      || description.match(/(?:^|\n)\s*source room\s*:\s*([^\s\n]+)/i)?.[1] || '';
    const relatedRaw = (input.related_ticket_id || '').trim()
      || description.match(new RegExp(`(?:^|\\n)\\s*(?:related|reproduced) ticket\\s*:\\s*(${UUID})`, 'i'))?.[1]
      || null;
    const related = relatedRaw && new RegExp(`^${UUID}$`, 'i').test(relatedRaw) ? relatedRaw : null;
    // An explicit kind (chat, or an outreach kind like 'reddit'/'github') is trusted as-is;
    // only an intake with no explicit kind falls back to the legacy chat heuristic
    // (a bare source room or the old "source: chat" marker implied chat before source_kind existed).
    const kind = explicitKind || (legacyChat || room ? 'chat' : '');
    return { source_kind: kind, source_chat_room_id: room, related_ticket_id: related };
  }

  async assess(workspaceId: string, input: DuplicateIntake): Promise<DuplicateAssessment> {
    const provenance = this.parseProvenance(input);
    if (!workspaceId || !provenance.source_kind) {
      return { ...provenance, canonical_ticket_id: null, ambiguous: false, candidates: [] };
    }
    const tickets = await this.dataSource.getRepository(Ticket).find({
      where: { workspace_id: workspaceId, parent_id: IsNull(), archived_at: IsNull(), canonical_ticket_id: IsNull() },
      order: { created_at: 'ASC' },
    });
    const normalized = this.normalizeTitle(input.title);
    // Outreach-created tickets from the same channel always carry identical
    // provenance labels ('outreach', 'source:<kind>') — counting those toward
    // "corroborating overlap" would auto-link every report from a channel
    // regardless of actual content, so they never enter the signal.
    const isProvenanceLabel = (v: string) => v === 'outreach' || v.startsWith('source:');
    const labels = new Set(
      (input.labels || [])
        .map(v => v.trim().toLowerCase())
        .filter(Boolean)
        .filter(v => !isProvenanceLabel(v)),
    );
    const matches: DuplicateMatch[] = [];
    for (const candidate of tickets) {
      // Same-kind only: a reddit report can match another reddit report but never a
      // github or chat one — cross-kind similarity is a different (unscoped) problem.
      if (candidate.source_kind !== provenance.source_kind) continue;
      const signals: string[] = [];
      const sameRoom = !!provenance.source_chat_room_id && candidate.source_chat_room_id === provenance.source_chat_room_id;
      const sameRelated = !!provenance.related_ticket_id && candidate.related_ticket_id === provenance.related_ticket_id;
      const conflictingRoom = !!provenance.source_chat_room_id
        && !!candidate.source_chat_room_id
        && candidate.source_chat_room_id !== provenance.source_chat_room_id;
      const conflictingRelated = !!provenance.related_ticket_id
        && !!candidate.related_ticket_id
        && candidate.related_ticket_id !== provenance.related_ticket_id;
      const sameTitle = !!normalized && this.normalizeTitle(candidate.title) === normalized;
      let overlap = 0;
      try {
        const candidateLabels: string[] = JSON.parse(candidate.labels || '[]');
        overlap = candidateLabels.filter(v => labels.has(String(v).toLowerCase())).length;
      } catch { /* malformed legacy labels are not a signal */ }
      // 'source_chat_room_id' doubles as a generic source-scope id: for chat it's
      // literally the room, for outreach kinds a producer can reuse it to carry
      // the originating channel id — same anchor mechanics, kind-appropriate label.
      if (sameRoom) signals.push(provenance.source_kind === 'chat' ? 'same_source_room' : 'same_channel');
      if (sameRelated) signals.push('same_related_ticket');
      if (sameTitle) signals.push('normalized_title');
      if (overlap) signals.push('overlapping_scope');
      if (conflictingRoom) signals.push('conflicting_source_room');
      if (conflictingRelated) signals.push('conflicting_related_ticket');
      const anchor = sameRoom || sameRelated;
      const corroborated = sameTitle || overlap > 0;
      const hasStrongConflict = conflictingRoom || conflictingRelated;
      const confidence = anchor && corroborated && !hasStrongConflict
        ? 100
        : anchor || (sameTitle && overlap > 0)
          ? 60
          : 0;
      if (confidence) matches.push({ ticket_id: candidate.id, title: candidate.title, confidence, matched_signals: signals });
    }
    const high = matches.filter(m => m.confidence >= 100);
    return {
      ...provenance,
      canonical_ticket_id: high.length === 1 ? high[0].ticket_id : null,
      ambiguous: high.length > 1 || (high.length === 0 && matches.length > 0),
      candidates: matches.sort((a, b) => b.confidence - a.confidence),
    };
  }

  async record(ticket: Ticket, assessment: DuplicateAssessment, actorName = '', actorId = ''): Promise<void> {
    return this.recordTx(this.dataSource.manager, ticket, assessment, actorName, actorId);
  }

  /**
   * Transaction-scoped write (ticket 7cf4f936 review fix), mirroring
   * ActivityService.logActivityTx. A caller building the report Ticket row
   * itself must persist this audit trail via the SAME manager, in the SAME
   * transaction — otherwise a Decision/Comment write failing after the
   * Ticket already committed leaves a permanently incomplete ticket behind
   * (outreach's operational_dedupe_key makes any retry silently reuse that
   * committed ticket instead of re-running the audit write). Folding both
   * into one transaction means a record() failure rolls the Ticket insert
   * back too, so a retry starts _createTicket() from scratch instead of
   * limping through a partially-done winner.
   */
  async recordTx(manager: EntityManager, ticket: Ticket, assessment: DuplicateAssessment, actorName = '', actorId = ''): Promise<void> {
    if (!assessment.candidates.length) return;
    const repo = manager.getRepository(TicketDuplicateDecision);
    await repo.save(assessment.candidates.map(candidate => repo.create({
      workspace_id: ticket.workspace_id,
      report_ticket_id: ticket.id,
      candidate_ticket_id: candidate.ticket_id,
      outcome: assessment.canonical_ticket_id === candidate.ticket_id ? 'auto_linked' : 'ambiguous_pending',
      confidence: candidate.confidence,
      matched_signals: JSON.stringify(candidate.matched_signals),
      actor_id: actorId,
      actor_name: actorName,
    })));
    if (assessment.canonical_ticket_id) {
      const comments = manager.getRepository(Comment);
      await comments.save([
        comments.create({
          workspace_id: ticket.workspace_id, ticket_id: ticket.id, author_type: 'system', author: 'Duplicate intake',
          content: `Linked to canonical ticket ${assessment.canonical_ticket_id}; independent dispatch is suppressed.`, type: 'system',
        }),
        comments.create({
          workspace_id: ticket.workspace_id, ticket_id: assessment.canonical_ticket_id, author_type: 'system', author: 'Duplicate intake',
          content: `Duplicate report ${ticket.id} was linked to this canonical ticket.`, type: 'system',
        }),
      ]);
    }
  }

  async confirm(reportId: string, candidateId: string | null, actorName: string, actorId: string): Promise<Ticket> {
    const confirmed = await this.dataSource.transaction(async manager => {
      const tickets = manager.getRepository(Ticket);
      const report = await tickets.findOne({ where: { id: reportId } });
      if (!report) throw new Error('Ticket not found');
      const decisions = manager.getRepository(TicketDuplicateDecision);
      const hasAmbiguousCandidate = await decisions.exists({
        where: { report_ticket_id: report.id, outcome: 'ambiguous_pending' },
      });
      if (!isDuplicateDecisionPending(report, hasAmbiguousCandidate)) throw new Error('Ticket has no duplicate decision pending');
      let canonical: Ticket | null = null;
      if (candidateId) {
        const pendingCandidate = await manager.getRepository(TicketDuplicateDecision).findOne({
          where: {
            report_ticket_id: report.id,
            candidate_ticket_id: candidateId,
            outcome: 'ambiguous_pending',
          },
        });
        if (!pendingCandidate) throw new Error('Canonical candidate was not offered for this duplicate decision');
        canonical = await tickets.findOne({ where: { id: candidateId, workspace_id: report.workspace_id, canonical_ticket_id: IsNull() } });
        if (!canonical || canonical.id === report.id) throw new Error('Invalid canonical candidate');
      }
      report.canonical_ticket_id = canonical?.id || null;
      report.pending_user_action = false;
      report.pending_reason = '';
      report.pending_set_at = null;
      report.pending_set_by = '';
      const saved = await tickets.save(report);
      // 후보 행은 감사 기록이면서 동시에 "아직 결정 필요" 상태를 나타낸다.
      // 결정을 별도 행으로 추가하기 전에 모두 종료해, 이후 hard-budget 등
      // 다른 원인으로 pending 되어도 과거 후보가 다시 UI에 노출되지 않게 한다.
      await decisions.update(
        { report_ticket_id: report.id, outcome: 'ambiguous_pending' },
        { outcome: 'rejected', actor_name: actorName, actor_id: actorId },
      );
      await decisions.save(decisions.create({
        workspace_id: report.workspace_id,
        report_ticket_id: report.id,
        candidate_ticket_id: canonical?.id || candidateId || report.id,
        outcome: canonical ? 'confirmed_link' : 'rejected',
        confidence: canonical ? 100 : 0,
        matched_signals: '[]',
        actor_name: actorName,
        actor_id: actorId,
      }));
      const comments = manager.getRepository(Comment);
      if (canonical) {
        await comments.save([
          comments.create({
            workspace_id: report.workspace_id, ticket_id: report.id, author_type: 'system', author: 'Duplicate decision',
            content: `Confirmed duplicate of canonical ticket ${canonical.id}; independent dispatch remains suppressed.`, type: 'system',
          }),
          comments.create({
            workspace_id: report.workspace_id, ticket_id: canonical.id, author_type: 'system', author: 'Duplicate decision',
            content: `Report ${report.id} was confirmed as a duplicate of this ticket.`, type: 'system',
          }),
        ]);
      } else {
        await comments.save(comments.create({
          workspace_id: report.workspace_id, ticket_id: report.id, author_type: 'system', author: 'Duplicate decision',
          content: 'Duplicate suggestion rejected; this ticket will continue independently.', type: 'system',
        }));
      }
      return saved;
    });

    // canonical 연결이 확정된 티켓은 dispatch 경로가 트리거를 전부 버리므로,
    // 이 순간 focus 후보 집합에서도 빠진다 — lease 해제다 (ticket 2cc54fde,
    // 요구사항 2). 위 트랜잭션이 커밋된 뒤에 브로드캐스트해서 canonical
    // 티켓이 방금 열린 슬롯을 즉시 가져가게 한다. 중복이 active 컬럼에 앉은
    // 채 canonical 승격을 무한 차단하던 교착이 여기서 자동으로 풀린다.
    if (confirmed.canonical_ticket_id) {
      await emitFocusReleased(this.dataSource, confirmed, 'duplicate_link');
    }
    return confirmed;
  }

  /**
   * 지금 컬럼에서 이 role 을 재dispatch 할 수 있는지 판정한다. 판정 실패는
   * **거부가 아니라 건너뜀**이다 (ticket 83c5e25c) — 링크 해제 자체는 컬럼과
   * 무관한 정정이므로 여기서 throw 하면 안 된다.
   *
   * pending 4종을 모두 본다: `TriggerLoopService._emitTrigger` 가 그 4종을
   * 모두 게이트하므로, 일부만 보고 intent 를 열면 트리거는 드롭되는데 열린
   * dispatch 채무만 남는 유령 행이 된다.
   */
  private _dispatchSkipReason(
    report: Ticket,
    column: BoardColumn | null,
    role: string,
  ): DuplicateCorrectionDispatchSkip {
    if (report.pending_user_action || report.pending_on_tickets || report.pending_ci_wait || report.pending_merge_lease) return 'ticket_pending';
    if (!column) return 'no_board_column';
    if ((column as any).is_terminal === true || (column as any).kind === 'terminal') return 'terminal_column';
    let routedRoles: string[] = [];
    try { routedRoles = JSON.parse((column as any).role_routing || '[]'); } catch { routedRoles = []; }
    if (!Array.isArray(routedRoles) || !routedRoles.includes(role)) return 'role_not_routed_in_current_column';
    if (role === 'assignee' && !report.assignee_id) return 'role_has_no_holder';
    return '';
  }

  /**
   * 확정된 오탐 연결을 해제하고, 가능하면 해당 역할의 dispatch 채무를 새로
   * 연다. 동일 트랜잭션에서 이전 intent를 종료한 뒤 새 pending intent를
   * 만들므로, 동시 정정 요청 중 하나만 canonical 전이를 소유하고 재dispatch할
   * 수 있다.
   *
   * **해제와 재dispatch 는 분리된다 (ticket 83c5e25c).** 예전에는 "지금 컬럼이
   * 그 role 을 라우팅하지 않는다"·"terminal 컬럼이다"·"assignee 미배정"·
   * "pending 이다" 가 전부 throw 였다. 그런데 duplicate intake 는 report 티켓을
   * **intake 컬럼에 둔 채로** 링크하고 intake 는 assignee 를 라우팅하지
   * 않으므로, 오링크가 가장 흔히 생기는 바로 그 상태에서 교정 도구가 항상
   * 거부됐다 — 잘못 묶인 티켓이 영구히 dispatch 차단된 채 방치됐다. 이제
   * 해제는 항상 수행하고, 재dispatch 는 `_dispatchSkipReason` 이 비었을 때만
   * 하는 best-effort 다.
   *
   * 해제만 한 경우의 재개 경로는 **role dispatch 가 아니라 승격**이다: 링크가
   * 풀리면 티켓은 `BacklogPromotionService` 의 후보 쿼리
   * (`t.canonical_ticket_id IS NULL`)를 다시 통과하고, 승격이 곧 목적지 컬럼
   * role holder 에게 트리거를 발행한다. 그 재평가를 즉시 깨우려고 커밋 뒤
   * `emitPromotionRecheck` 를 쏜다.
   */
  async correctConfirmedLink(
    reportId: string,
    role: string,
    actorName: string,
    actorId: string,
  ): Promise<ConfirmedLinkCorrection> {
    const corrected = await this.dataSource.transaction(async manager => {
      const tickets = manager.getRepository(Ticket);
      const report = await tickets.findOne({ where: { id: reportId } });
      if (!report) throw new Error('Ticket not found');
      if (!report.canonical_ticket_id) throw new Error('Ticket has no confirmed canonical link to correct');
      const previousCanonicalId = report.canonical_ticket_id;
      const canonical = await tickets.findOne({ where: { id: previousCanonicalId } });
      if (!canonical || canonical.workspace_id !== report.workspace_id || canonical.id === report.id) {
        throw new Error('Confirmed canonical link is invalid or outside the ticket workspace');
      }
      const column = report.column_id
        ? await manager.getRepository(BoardColumn).findOne({ where: { id: report.column_id } })
        : null;
      const dispatchSkippedReason = this._dispatchSkipReason(report, column, role);

      // compare-and-swap으로 정정 소유권을 획득한다. PostgreSQL READ COMMITTED에서는
      // 두 호출이 위에서 기존 canonical을 함께 읽을 수 있지만, 그 값을 NULL로 바꾸는
      // 호출은 하나뿐이어야 한다. 실패한 호출은 intent와 감사 행을 건드리기 전에 중단한다.
      const claimed = await tickets.update({
        id: report.id,
        canonical_ticket_id: previousCanonicalId,
      }, { canonical_ticket_id: null });
      if (claimed.affected !== 1) {
        throw new Error('Ticket canonical link was already corrected or changed concurrently');
      }
      const saved = await tickets.findOneByOrFail({ id: report.id });
      const now = new Date();
      const intents = manager.getRepository(DispatchIntent);
      await intents.update({
        ticket_id: report.id,
        role,
        status: In(['pending', 'in_flight']),
      }, {
        status: 'resolved',
        last_reason: 'superseded_by_duplicate_correction',
        resolved_at: now,
        lease_owner: '',
        lease_expires_at: null,
      });
      // 재dispatch 가 가능할 때만 새 채무를 연다. 건너뛴 경우 열린 intent 가
      // 없다는 사실 자체가 "이 정정은 아무도 깨우지 않았다" 는 신호다 —
      // 트리거가 드롭될 것을 알면서 intent 만 남기면 유령 행이 된다.
      const dispatchConfig = readReconcilerConfig();
      const freshIntent = dispatchSkippedReason ? null : await intents.save(intents.create({
        workspace_id: report.workspace_id,
        board_id: column?.board_id || '',
        ticket_id: report.id,
        role,
        agent_id: role === 'assignee' ? (report.assignee_id || '') : '',
        trigger_source: 'duplicate_correction',
        // 이 트랜잭션이 커밋되기 전에 정정 경로가 첫 dispatch 소유권을 획득한다.
        // 실행 가능한 pending 행을 공개하면 MCP emit 전에 reconciler가 lease를
        // 가져가 wire payload가 두 번 생성될 수 있다.
        status: 'in_flight',
        attempts: 1,
        dispatch_generation: 1,
        next_attempt_at: new Date(now.getTime() + dispatchBackoffMs(1, dispatchConfig)),
        lease_owner: `duplicate-correction:${randomUUID()}`,
        lease_expires_at: new Date(now.getTime() + dispatchConfig.leaseMs),
        last_reason: 'duplicate_link_corrected',
      }));
      await manager.getRepository(TicketDuplicateDecision).save({
        workspace_id: report.workspace_id,
        report_ticket_id: report.id,
        candidate_ticket_id: previousCanonicalId,
        outcome: 'corrected_independent',
        confidence: 0,
        matched_signals: '[]',
        actor_name: actorName,
        actor_id: actorId,
      });
      await manager.getRepository(Comment).save({
        workspace_id: report.workspace_id,
        ticket_id: report.id,
        author_type: 'system',
        author: 'Duplicate correction',
        content: dispatchSkippedReason
          ? `Incorrect canonical link ${previousCanonicalId} was removed; ${role} dispatch was not re-issued `
            + `(${dispatchSkippedReason}). The ticket resumes through its normal column workflow.`
          : `Incorrect canonical link ${previousCanonicalId} was removed; ${role} dispatch was re-issued.`,
        type: 'system',
      });
      await manager.getRepository(ActivityLog).save({
        workspace_id: report.workspace_id,
        entity_type: 'ticket',
        entity_id: report.id,
        action: 'duplicate_link_corrected',
        field_changed: 'canonical_ticket_id',
        old_value: previousCanonicalId,
        new_value: '',
        actor_id: actorId,
        actor_name: actorName,
        ticket_id: report.id,
        role,
        trigger_source: 'duplicate_correction',
      });
      return {
        ticket: saved,
        previousCanonicalId,
        intentId: freshIntent?.id || '',
        generation: freshIntent?.dispatch_generation || 0,
        leaseOwner: freshIntent?.lease_owner || '',
        agentId: freshIntent?.agent_id || '',
        dispatchSkippedReason,
      };
    });

    // 해제만 하고 아무도 깨우지 못한 경우 — 이 티켓은 방금 승격 후보 자격을
    // 되찾았다. 이 신호가 없으면 다음 `agent_idle` 이나 5분 level sweep 까지
    // 보드가 그대로 멈춰 있고, intake 컬럼에 잠긴 티켓에는 그 `agent_idle`
    // 조차 이 티켓과 무관하게 올 때까지 기다려야 한다. 트랜잭션이 커밋된
    // 뒤에 쏜다 — sql.js 는 단일 커넥션이라 커밋 전 발행은 리스너의 쓰기가
    // 발행자의 트랜잭션과 겹친다.
    if (corrected.dispatchSkippedReason) {
      await emitPromotionRecheck(this.dataSource, corrected.ticket, 'duplicate_link_corrected');
    }
    return corrected;
  }
}
