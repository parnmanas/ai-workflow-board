/**
 * TicketPrerequisitesService — back-end for the M:N "blocked-by" relationship
 * (ticket 48d14fff).
 *
 * Distinct from `Ticket.next_ticket_id` (forward 1:1 push, A finishes → wake B);
 * this is the backward M:N pull, B parks itself until every prereq A lands on
 * a terminal column.
 *
 * Why it exists:
 *   - Validation: same-workspace, no self-reference, no cycle, no archived
 *     prereq. Add-time guard is cheap — a DFS over the prereq graph.
 *   - Mutator surface: `addPrerequisites(ticket, prereqs[], reason, actor)`,
 *     `removePrerequisite(ticket, prereq)`, `listPrerequisites(ticket)`.
 *   - Auto-resume sweep: `evaluatePendingForDependent(ticketId)` re-reads the
 *     row's prereq set and flips `pending_on_tickets` according to whether
 *     any remaining link still points at a non-terminal ticket. Returns
 *     `{ flipped, before, after }` so the caller can decide whether to fire
 *     a dispatch.
 *   - Cascade hooks: `onPrerequisiteReached(prereqTicketId)` walks every
 *     dependent and re-evaluates. `onTicketRemoved(ticketId)` is called by
 *     archive/delete paths so dependents don't sit forever on a stale link.
 *
 * Pure helpers run against a `DataSource | EntityManager` scope so the
 * service works in both NestJS DI and the standalone MCP entry point.
 */

import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import { Ticket } from '../../entities/Ticket';
import { TicketPrerequisite } from '../../entities/TicketPrerequisite';
import { BoardColumn } from '../../entities/BoardColumn';
import { ActivityService } from '../../services/activity.service';

export type RepoScope = DataSource | EntityManager;

export interface PrerequisiteRow {
  ticket_id: string;
  prerequisite_ticket_id: string;
  created_at: Date;
  created_by: string;
  reason: string;
  // Convenience snapshot of the prereq side for the UI: title + column +
  // whether the column is terminal (so the panel can render "satisfied"
  // pills without a second round-trip). Always present in `listFull`
  // results; omitted on the raw row helper.
  prerequisite?: {
    id: string;
    title: string;
    column_id: string | null;
    column_name: string;
    is_terminal: boolean;
    archived_at: Date | null;
  };
}

export interface AddResult {
  added: PrerequisiteRow[];
  pending_on_tickets: boolean;
  ticket: Ticket;
}

@Injectable()
export class TicketPrerequisitesService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly activityService: ActivityService,
  ) {}

  // ── Reads ────────────────────────────────────────────────────────────

  async listFull(ticketId: string): Promise<PrerequisiteRow[]> {
    return listPrerequisitesFull(this.dataSource, ticketId);
  }

  async listDependents(prereqTicketId: string): Promise<string[]> {
    const rows = await this.dataSource
      .getRepository(TicketPrerequisite)
      .find({ where: { prerequisite_ticket_id: prereqTicketId } });
    return rows.map((r) => r.ticket_id);
  }

  // ── Mutators ─────────────────────────────────────────────────────────

  async addPrerequisites(
    ticketId: string,
    prereqIds: string[],
    opts: { reason?: string; actorId?: string; actorName?: string } = {},
  ): Promise<AddResult> {
    const reason = (opts.reason || '').trim();
    const actor = opts.actorName || '';

    const dedup = Array.from(new Set((prereqIds || []).map((s) => String(s).trim()).filter(Boolean)));
    if (dedup.length === 0) {
      throw badRequest('prerequisite_ticket_ids must be a non-empty array');
    }

    const ticket = await this.dataSource.getRepository(Ticket).findOne({ where: { id: ticketId } });
    if (!ticket) throw badRequest('Ticket not found');
    if (ticket.archived_at) throw badRequest('Ticket is archived');

    // Validate every candidate up front so a partial batch failure leaves
    // the row counts unchanged.
    const prereqRepo = this.dataSource.getRepository(Ticket);
    const validated: Array<{ id: string; row: Ticket }> = [];
    for (const pid of dedup) {
      if (pid === ticketId) {
        throw badRequest('A ticket cannot be its own prerequisite');
      }
      const row = await prereqRepo.findOne({ where: { id: pid } });
      if (!row) throw badRequest(`Prerequisite ticket not found: ${pid}`);
      if (row.archived_at) throw badRequest(`Prerequisite ticket is archived: ${pid}`);
      if (ticket.workspace_id && row.workspace_id && row.workspace_id !== ticket.workspace_id) {
        throw badRequest(`Prerequisite must be in the same workspace: ${pid}`);
      }
      validated.push({ id: pid, row });
    }

    // Cycle detection: for each candidate, refuse if `ticketId` is already
    // reachable from the candidate through the existing prereq graph
    // (`prereqOf[ticketId]` reached when walking down from the candidate).
    // DFS bounded by ticket count — every workspace's graph is small.
    for (const { id: pid } of validated) {
      if (await wouldCreateCycle(this.dataSource, ticketId, pid)) {
        throw badRequest(
          `Adding ${pid} as a prerequisite of ${ticketId} would create a cycle`,
        );
      }
    }

    // Insert (idempotent via the composite PK) inside a transaction together
    // with the `pending_on_tickets` flip + activity log so observers see a
    // consistent state.
    const added: TicketPrerequisite[] = [];
    await this.dataSource.transaction(async (manager) => {
      const prRepo = manager.getRepository(TicketPrerequisite);
      for (const { id: pid } of validated) {
        const existing = await prRepo.findOne({
          where: { ticket_id: ticketId, prerequisite_ticket_id: pid },
        });
        if (existing) continue;
        const row = prRepo.create({
          ticket_id: ticketId,
          prerequisite_ticket_id: pid,
          created_by: actor,
          reason,
        });
        added.push(await prRepo.save(row));
      }

      // Re-evaluate the dependent's pending state based on the full link set
      // — the new ones we just added plus anything already there.
      const remaining = await prRepo.find({ where: { ticket_id: ticketId } });
      const anyOpen = await anyPrereqOpen(manager, remaining);
      const tRepo = manager.getRepository(Ticket);
      const next = anyOpen;
      if (ticket.pending_on_tickets !== next) {
        await tRepo.update(ticket.id, { pending_on_tickets: next });
        ticket.pending_on_tickets = next;
      }
      // Persist the most recent reason on the ticket's `pending_reason`
      // when it's currently empty so the User tab / panel can render the
      // intent without joining the prereq rows. Only writes when the user
      // supplied one and the field is empty — never overwrites a hand-
      // authored pend_ticket reason.
      if (reason && !ticket.pending_reason) {
        await tRepo.update(ticket.id, { pending_reason: reason });
        ticket.pending_reason = reason;
      }
    });

    // Activity log — one row per add so the timeline reads naturally.
    for (const row of added) {
      await this.activityService.logActivity({
        entity_type: 'ticket',
        entity_id: ticketId,
        ticket_id: ticketId,
        action: 'updated',
        field_changed: 'prerequisite_added',
        new_value: row.prerequisite_ticket_id,
        actor_id: opts.actorId,
        actor_name: actor,
      });
    }

    const dressed = added.map((r) => projectRow(r));
    return { added: dressed, pending_on_tickets: ticket.pending_on_tickets, ticket };
  }

  async removePrerequisite(
    ticketId: string,
    prereqTicketId: string,
    opts: { actorId?: string; actorName?: string } = {},
  ): Promise<{ removed: boolean; pending_on_tickets: boolean }> {
    const ticket = await this.dataSource.getRepository(Ticket).findOne({ where: { id: ticketId } });
    if (!ticket) throw badRequest('Ticket not found');
    const prRepo = this.dataSource.getRepository(TicketPrerequisite);
    const existing = await prRepo.findOne({
      where: { ticket_id: ticketId, prerequisite_ticket_id: prereqTicketId },
    });
    if (!existing) {
      return { removed: false, pending_on_tickets: ticket.pending_on_tickets };
    }

    await prRepo.delete({ ticket_id: ticketId, prerequisite_ticket_id: prereqTicketId });

    await this.activityService.logActivity({
      entity_type: 'ticket',
      entity_id: ticketId,
      ticket_id: ticketId,
      action: 'updated',
      field_changed: 'prerequisite_removed',
      old_value: prereqTicketId,
      actor_id: opts.actorId,
      actor_name: opts.actorName || '',
    });

    // Re-evaluate; if the last open prereq is gone, flip the flag back.
    const after = await this.evaluatePendingForDependent(ticketId);
    return { removed: true, pending_on_tickets: after.pending_on_tickets };
  }

  // ── Auto-resume sweep ───────────────────────────────────────────────

  /**
   * Re-read the row's prereq set and align `pending_on_tickets` with whether
   * any link still points at a non-terminal ticket. Idempotent — safe to call
   * from any path that mutates the link set or the prereq's column.
   *
   * Returns the post-flip state so callers can decide whether to dispatch:
   * a `was_pending && !pending_on_tickets` transition is the cue for
   * `TriggerLoopService.dispatchCurrentColumn`.
   */
  async evaluatePendingForDependent(
    ticketId: string,
  ): Promise<{ pending_on_tickets: boolean; was_pending: boolean }> {
    return evaluatePendingForDependentScoped(this.dataSource, ticketId);
  }

  /**
   * Callback for archive/delete paths: drop every link pointing at the
   * given ticket (cascade is set on the FK but we want to re-evaluate the
   * dependents AFTER the rows are gone). Returns the list of dependent
   * ticket ids that flipped `pending_on_tickets` to false so the caller
   * can dispatch them.
   */
  async onPrerequisiteRemoved(prereqTicketId: string): Promise<string[]> {
    const prRepo = this.dataSource.getRepository(TicketPrerequisite);
    const dependents = await prRepo.find({ where: { prerequisite_ticket_id: prereqTicketId } });
    const dependentIds = Array.from(new Set(dependents.map((d) => d.ticket_id)));
    if (dependentIds.length === 0) return [];
    await prRepo.delete({ prerequisite_ticket_id: prereqTicketId });
    return this._reevaluateAndCollectFlips(dependentIds);
  }

  /**
   * Callback for terminal-column landings: walk every dependent of the
   * just-landed ticket and re-evaluate. Returns ids of dependents that
   * flipped pending_on_tickets to false so the caller can dispatch.
   */
  async onPrerequisiteReached(prereqTicketId: string): Promise<string[]> {
    const prRepo = this.dataSource.getRepository(TicketPrerequisite);
    const dependents = await prRepo.find({ where: { prerequisite_ticket_id: prereqTicketId } });
    const dependentIds = Array.from(new Set(dependents.map((d) => d.ticket_id)));
    return this._reevaluateAndCollectFlips(dependentIds);
  }

  private async _reevaluateAndCollectFlips(dependentIds: string[]): Promise<string[]> {
    const unblocked: string[] = [];
    for (const id of dependentIds) {
      const before = await this.dataSource.getRepository(Ticket).findOne({ where: { id } });
      if (!before) continue;
      const was = !!before.pending_on_tickets;
      const out = await this.evaluatePendingForDependent(id);
      if (was && !out.pending_on_tickets) unblocked.push(id);
    }
    return unblocked;
  }
}

// ─── Pure helpers — usable from MCP-context (DataSource) and DI ──────────

export async function listPrerequisitesFull(
  scope: RepoScope,
  ticketId: string,
): Promise<PrerequisiteRow[]> {
  const rows = await scope
    .getRepository(TicketPrerequisite)
    .find({ where: { ticket_id: ticketId }, order: { created_at: 'ASC' } });
  if (rows.length === 0) return [];
  const tRepo = scope.getRepository(Ticket);
  const colRepo = scope.getRepository(BoardColumn);
  const dressed: PrerequisiteRow[] = [];
  for (const r of rows) {
    const prereq = await tRepo.findOne({ where: { id: r.prerequisite_ticket_id } });
    if (!prereq) {
      // Stale link — the FK ON DELETE CASCADE should have caught it, but be
      // defensive and surface it as null-shape so the UI can render "(missing)".
      dressed.push({
        ticket_id: r.ticket_id,
        prerequisite_ticket_id: r.prerequisite_ticket_id,
        created_at: r.created_at,
        created_by: r.created_by,
        reason: r.reason,
        prerequisite: undefined,
      });
      continue;
    }
    let columnName = '';
    let isTerminal = false;
    if (prereq.column_id) {
      const col = await colRepo.findOne({ where: { id: prereq.column_id } });
      columnName = col?.name || '';
      isTerminal = !!(col && ((col as any).is_terminal === true || (col as any).kind === 'terminal'));
    }
    dressed.push({
      ticket_id: r.ticket_id,
      prerequisite_ticket_id: r.prerequisite_ticket_id,
      created_at: r.created_at,
      created_by: r.created_by,
      reason: r.reason,
      prerequisite: {
        id: prereq.id,
        title: prereq.title,
        column_id: prereq.column_id || null,
        column_name: columnName,
        is_terminal: isTerminal,
        archived_at: prereq.archived_at,
      },
    });
  }
  return dressed;
}

/**
 * Returns true if any prerequisite ticket in `rows` sits on a non-terminal
 * column (or has no column at all). A prereq that is archived counts as
 * resolved — link should be removed via the cascade, but we treat it as
 * "satisfied" defensively in case the row outlived the cascade.
 */
async function anyPrereqOpen(scope: RepoScope, rows: TicketPrerequisite[]): Promise<boolean> {
  if (rows.length === 0) return false;
  const tRepo = scope.getRepository(Ticket);
  const colRepo = scope.getRepository(BoardColumn);
  for (const r of rows) {
    const prereq = await tRepo.findOne({ where: { id: r.prerequisite_ticket_id } });
    if (!prereq) continue;
    if (prereq.archived_at) continue;
    if (!prereq.column_id) return true;
    const col = await colRepo.findOne({ where: { id: prereq.column_id } });
    const isTerminal = !!(col && ((col as any).is_terminal === true || (col as any).kind === 'terminal'));
    if (!isTerminal) return true;
  }
  return false;
}

async function wouldCreateCycle(
  scope: RepoScope,
  ticketId: string,
  candidatePrereqId: string,
): Promise<boolean> {
  // We're about to write the edge `ticketId → candidatePrereqId` (read as
  // "ticketId is blocked by candidatePrereqId"). A cycle exists iff there's
  // already a path back from `candidatePrereqId` to `ticketId` along the
  // prereq edges. DFS from `candidatePrereqId` following
  // `prereq.prerequisite_ticket_id`s. Bounded by ticket count.
  if (ticketId === candidatePrereqId) return true;
  const prRepo = scope.getRepository(TicketPrerequisite);
  const seen = new Set<string>();
  const stack = [candidatePrereqId];
  while (stack.length) {
    const cur = stack.pop()!;
    if (seen.has(cur)) continue;
    seen.add(cur);
    if (cur === ticketId) return true;
    const next = await prRepo.find({ where: { ticket_id: cur } });
    for (const n of next) {
      if (!seen.has(n.prerequisite_ticket_id)) stack.push(n.prerequisite_ticket_id);
    }
  }
  return false;
}

/**
 * Standalone variant of `evaluatePendingForDependent` so MCP tools (which
 * receive a DataSource via ToolContext) can call it without the DI service.
 */
export async function evaluatePendingForDependentScoped(
  scope: RepoScope,
  ticketId: string,
): Promise<{ pending_on_tickets: boolean; was_pending: boolean }> {
  const tRepo = scope.getRepository(Ticket);
  const ticket = await tRepo.findOne({ where: { id: ticketId } });
  if (!ticket) return { pending_on_tickets: false, was_pending: false };
  const was = !!ticket.pending_on_tickets;
  const rows = await scope
    .getRepository(TicketPrerequisite)
    .find({ where: { ticket_id: ticketId } });
  const next = await anyPrereqOpen(scope, rows);
  if (next !== was) {
    await tRepo.update(ticketId, { pending_on_tickets: next });
  }
  return { pending_on_tickets: next, was_pending: was };
}

function projectRow(r: TicketPrerequisite): PrerequisiteRow {
  return {
    ticket_id: r.ticket_id,
    prerequisite_ticket_id: r.prerequisite_ticket_id,
    created_at: r.created_at,
    created_by: r.created_by,
    reason: r.reason,
  };
}

function badRequest(msg: string): Error {
  const e = new Error(msg) as Error & { status: number };
  e.status = 400;
  return e;
}
