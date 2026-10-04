import { Injectable } from '@nestjs/common';
import { DataSource, EntityManager, In, IsNull } from 'typeorm';
import { Ticket } from '../../entities/Ticket';
import { TicketDuplicateDecision } from '../../entities/TicketDuplicateDecision';
import { Comment } from '../../entities/Comment';
import { ActivityLog } from '../../entities/ActivityLog';
import { isDuplicateDecisionPending } from './ticket-duplicate-pending';

export interface DuplicateIntake {
  title: string;
  description?: string;
  tags?: string[];
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

export interface ConfirmedLinkCorrection {
  ticket: Ticket;
  previousCanonicalId: string;
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
    // provenance tags ('outreach', 'source:<kind>') — counting those toward
    // "corroborating overlap" would auto-link every report from a channel
    // regardless of actual content, so they never enter the signal.
    const isProvenanceTag = (v: string) => v === 'outreach' || v.startsWith('source:');
    const tags = new Set(
      (input.tags || [])
        .map(v => v.trim().toLowerCase())
        .filter(Boolean)
        .filter(v => !isProvenanceTag(v)),
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
        const candidateTags: string[] = JSON.parse(candidate.tags || '[]');
        overlap = candidateTags.filter(v => tags.has(String(v).toLowerCase())).length;
      } catch { /* malformed legacy tags are not a signal */ }
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

    return confirmed;
  }

  /**
   * 확정된 오탐 연결을 해제한다. compare-and-swap 으로 정정 소유권을 하나의
   * 호출만 갖게 하고, 감사 기록(decision 행 + system 코멘트 + activity)을 같은
   * 트랜잭션에 남긴다. 담당 agent 를 다시 깨우는 것은 호출자의 일이다
   * (TicketDispatchService.resumeTicket) — 링크가 풀리면 티켓은 다시 평범한
   * 큐/진행 티켓이다.
   */
  async correctConfirmedLink(
    reportId: string,
    actorName: string,
    actorId: string,
  ): Promise<ConfirmedLinkCorrection> {
    return this.dataSource.transaction(async manager => {
      const tickets = manager.getRepository(Ticket);
      const report = await tickets.findOne({ where: { id: reportId } });
      if (!report) throw new Error('Ticket not found');
      if (!report.canonical_ticket_id) throw new Error('Ticket has no confirmed canonical link to correct');
      const previousCanonicalId = report.canonical_ticket_id;
      const canonical = await tickets.findOne({ where: { id: previousCanonicalId } });
      if (!canonical || canonical.workspace_id !== report.workspace_id || canonical.id === report.id) {
        throw new Error('Confirmed canonical link is invalid or outside the ticket workspace');
      }
      // PostgreSQL READ COMMITTED 에서는 두 호출이 기존 canonical 을 함께 읽을 수
      // 있지만, 그 값을 NULL 로 바꾸는 호출은 하나뿐이어야 한다.
      const claimed = await tickets.update({
        id: report.id,
        canonical_ticket_id: previousCanonicalId,
      }, { canonical_ticket_id: null });
      if (claimed.affected !== 1) {
        throw new Error('Ticket canonical link was already corrected or changed concurrently');
      }
      const saved = await tickets.findOneByOrFail({ id: report.id });
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
        content: `Incorrect canonical link ${previousCanonicalId} was removed; the ticket is independent again.`,
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
        trigger_source: 'duplicate_correction',
      });
      return { ticket: saved, previousCanonicalId };
    });
  }
}
