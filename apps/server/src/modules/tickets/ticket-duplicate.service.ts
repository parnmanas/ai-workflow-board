import { Injectable } from '@nestjs/common';
import { DataSource, IsNull } from 'typeorm';
import { Ticket } from '../../entities/Ticket';
import { TicketDuplicateDecision } from '../../entities/TicketDuplicateDecision';
import { Comment } from '../../entities/Comment';

export interface DuplicateIntake {
  title: string;
  description?: string;
  labels?: string[];
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
    return { source_kind: explicitKind === 'chat' || legacyChat || room ? 'chat' : '', source_chat_room_id: room, related_ticket_id: related };
  }

  async assess(workspaceId: string, input: DuplicateIntake): Promise<DuplicateAssessment> {
    const provenance = this.parseProvenance(input);
    if (!workspaceId || provenance.source_kind !== 'chat') {
      return { ...provenance, canonical_ticket_id: null, ambiguous: false, candidates: [] };
    }
    const tickets = await this.dataSource.getRepository(Ticket).find({
      where: { workspace_id: workspaceId, parent_id: IsNull(), archived_at: IsNull(), canonical_ticket_id: IsNull() },
      order: { created_at: 'ASC' },
    });
    const normalized = this.normalizeTitle(input.title);
    const labels = new Set((input.labels || []).map(v => v.trim().toLowerCase()).filter(Boolean));
    const matches: DuplicateMatch[] = [];
    for (const candidate of tickets) {
      if (candidate.source_kind !== 'chat') continue;
      const signals: string[] = [];
      const sameRoom = !!provenance.source_chat_room_id && candidate.source_chat_room_id === provenance.source_chat_room_id;
      const sameRelated = !!provenance.related_ticket_id && candidate.related_ticket_id === provenance.related_ticket_id;
      const sameTitle = !!normalized && this.normalizeTitle(candidate.title) === normalized;
      let overlap = 0;
      try {
        const candidateLabels: string[] = JSON.parse(candidate.labels || '[]');
        overlap = candidateLabels.filter(v => labels.has(String(v).toLowerCase())).length;
      } catch { /* malformed legacy labels are not a signal */ }
      if (sameRoom) signals.push('same_source_room');
      if (sameRelated) signals.push('same_related_ticket');
      if (sameTitle) signals.push('normalized_title');
      if (overlap) signals.push('overlapping_scope');
      const anchor = sameRoom || sameRelated;
      const corroborated = sameTitle || overlap > 0;
      const confidence = anchor && corroborated ? 100 : anchor || (sameTitle && overlap > 0) ? 60 : 0;
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
    if (!assessment.candidates.length) return;
    const repo = this.dataSource.getRepository(TicketDuplicateDecision);
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
      const comments = this.dataSource.getRepository(Comment);
      await comments.save([
        comments.create({
          workspace_id: ticket.workspace_id, ticket_id: ticket.id, author_type: 'system', author: 'Duplicate intake',
          content: `Linked to canonical ticket ${assessment.canonical_ticket_id}; independent dispatch is suppressed.`, type: 'system',
        }),
        comments.create({
          workspace_id: ticket.workspace_id, ticket_id: assessment.canonical_ticket_id, author_type: 'system', author: 'Duplicate intake',
          content: `Duplicate chat report ${ticket.id} was linked to this canonical ticket.`, type: 'system',
        }),
      ]);
    }
  }

  async confirm(reportId: string, candidateId: string | null, actorName: string, actorId: string): Promise<Ticket> {
    return this.dataSource.transaction(async manager => {
      const tickets = manager.getRepository(Ticket);
      const report = await tickets.findOne({ where: { id: reportId } });
      if (!report) throw new Error('Ticket not found');
      if (!report.pending_user_action) throw new Error('Ticket has no duplicate decision pending');
      let canonical: Ticket | null = null;
      if (candidateId) {
        canonical = await tickets.findOne({ where: { id: candidateId, workspace_id: report.workspace_id, canonical_ticket_id: IsNull() } });
        if (!canonical || canonical.id === report.id) throw new Error('Invalid canonical candidate');
      }
      report.canonical_ticket_id = canonical?.id || null;
      report.pending_user_action = false;
      report.pending_reason = '';
      report.pending_set_at = null;
      report.pending_set_by = '';
      const saved = await tickets.save(report);
      const decisions = manager.getRepository(TicketDuplicateDecision);
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
            content: `Chat report ${report.id} was confirmed as a duplicate of this ticket.`, type: 'system',
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
  }
}
