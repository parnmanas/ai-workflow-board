/**
 * AgentWorkloadService — focus / workflow-load source for the dispatch
 * path (promotion + trigger emission).
 *
 * Why this exists (ticket 4a6cdfd7 — WorkflowFocusSelector):
 *
 *   Earlier iterations stacked caps on top of caps: a per-agent ticket
 *   count compared against `Board.max_concurrent_tickets_per_agent`, an
 *   in-memory `pendingDispatches` race guard, an `alreadyOnTarget`
 *   bypass that let already-parked tickets re-fire, and a separate
 *   dispatch queue. Each layer healed a single race; in combination
 *   they emitted a trigger every supervisor tick for every ticket in
 *   To Do, drowning the agent's turns and never advancing the board
 *   (GameClient 2026-05-12 06:00 dogfooding: 43 To Do tickets all
 *   re-triggered every 5 min).
 *
 *   The replacement is a single ranking function — `getFocusTicket` —
 *   that picks the ONE ticket each agent should be working on right
 *   now, per board and per role slug. Both the promotion gate and the
 *   trigger-emit gate read from it. Non-focus tickets are silently
 *   inert (no trigger row, no emit). Self-healing: if state drifts the
 *   selector still returns exactly one id.
 *
 *   The legacy workflow-state helper (`getWorkflowLoadTicketIds`) is
 *   preserved as the candidate-set building block. Tests that asserted
 *   on its filter semantics (non-terminal & non-intake & role-held)
 *   stay valid; the focus selector just sorts the same set and returns
 *   the head.
 *
 * Selector ranking (descending importance — equal values fall through
 * to the next key):
 *
 *   1. `column.position DESC` — higher columns win. Merging > Review >
 *      In Progress > Plan > To Do for the default preset. Lets a
 *      ticket nearing completion finish before any newer-column
 *      candidates get a slice of attention. Column positions are
 *      board-defined integers; no name compare.
 *   2. `is_chain_target ASC` — a ticket pointed at by some other
 *      ticket's `next_ticket_id` wins the tie. Matches the existing
 *      backlog-promotion chain-prefix semantics (ticket 8b3fa67e) so
 *      a B in a `A.next_ticket_id = B` chain promotes ahead of an
 *      unrelated higher-priority C.
 *   3. `priorityIndex(priority) ASC` — critical < high < medium < low
 *      < unknown. Goes through the shared `priorityIndex` helper —
 *      raw-priority-string compares are banned across the dispatch
 *      path (see priority.ts header).
 *   4. `created_at ASC` — within all of the above, the oldest ticket
 *      wins. Deterministic tiebreaker so fixture / prod runs converge
 *      regardless of insert order.
 *
 * Permitted call sites:
 *   - `TriggerLoopService._emitTrigger` (server-side dispatch gate)
 *   - `BacklogPromotionService.tryPromote` (intake → first-active gate)
 *   - Supervisor backstop (indirectly, via the same `_emitTrigger`)
 *   - Tests of those services.
 *
 * `AgentStatusService.getActiveTicketIds` is process-state (plugin
 * setCurrentTask / clearCurrentTask), not workflow-state. It is allowed
 * by EventsController for the live "subagent process alive" status
 * badge, but the static grep guard
 * (`test/workflow-state-cap-guard.test.mjs`) forbids it on the
 * dispatch path.
 */
import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { Ticket } from '../../entities/Ticket';
import { BoardColumn } from '../../entities/BoardColumn';
import { priorityIndex } from './priority';

@Injectable()
export class AgentWorkloadService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  /**
   * Tickets the agent currently has parked on a non-terminal, non-intake
   * column of the given board, filtered to one role slug if provided.
   *
   * Retained as the candidate-set building block for `getFocusTicket`
   * — same filter, no ranking. Public so existing tests
   * (`workflow-state-cap-guard.test.mjs`,
   * `qa-flows/workflow-state-cap.test.mjs`) and any future direct
   * load-counting caller can still observe the underlying set without
   * paying for the per-ticket sort + chain lookup.
   *
   * Returns a flat string array — duplicates pre-collapsed by SELECT
   * DISTINCT so a ticket that has the same holder on two roles only
   * appears once.
   */
  async getWorkflowLoadTicketIds(
    agent_id: string,
    board_id: string,
    role_slug?: string,
  ): Promise<string[]> {
    if (!agent_id || !board_id) return [];

    // QueryBuilder over the explicit joins avoids the entity-relation
    // metadata path (TicketRoleAssignment has no @ManyToOne onto Ticket
    // because the legacy assignee_id / reporter_id / reviewer_id columns
    // also point at agent_id; entity-level joins would conflate them).
    // sqlite + postgres both speak this SQL verbatim — the IS NULL slug
    // short-circuit keeps the optional filter to a single parameter
    // binding rather than two separate query shapes.
    const qb = this.dataSource
      .createQueryBuilder()
      .select('DISTINCT t.id', 'id')
      .from('tickets', 't')
      .innerJoin(
        'ticket_role_assignments',
        'ra',
        'ra.ticket_id = t.id AND ra.agent_id = :agent_id',
      )
      .innerJoin('workspace_roles', 'wr', 'wr.id = ra.role_id')
      .innerJoin('columns', 'c', 'c.id = t.column_id')
      .where('c.board_id = :board_id')
      .andWhere('c.is_terminal = :falseVal')
      .andWhere("c.kind != 'intake'")
      .setParameter('agent_id', agent_id)
      .setParameter('board_id', board_id)
      // Use a bound parameter for boolean instead of the literal `false`
      // because sqlite stores booleans as 0/1 — TypeORM's parameter
      // binding does the right cast for both drivers.
      .setParameter('falseVal', false);

    if (role_slug) {
      qb.andWhere('wr.slug = :slug').setParameter('slug', role_slug);
    }

    const rows: Array<{ id: string }> = await qb.getRawMany();
    return rows.map((r) => r.id).filter(Boolean);
  }

  /**
   * Pick the single ticket this agent should be working on right now,
   * for the given board and (optionally) role slug. Returns the ticket
   * id or null if the agent currently holds no eligible tickets.
   *
   * Caller contract — non-focus tickets are silently inert in the
   * dispatch path. Emit a trigger for a ticket only when
   * `getFocusTicket(agent, board, role) === ticket.id`. Promotion
   * eligibility is the inverse: an agent with a non-null focus is
   * already occupied and is NOT a valid destination holder for a new
   * intake promotion on that board.
   *
   * Implementation note — sort happens in JS rather than SQL because
   * the 4-key compound order (`column.position DESC`,
   * `is_chain_target ASC`, `priorityIndex ASC`, `created_at ASC`) is
   * awkward to express portably across sqlite + postgres without
   * driver-specific `CASE WHEN` / `DISTINCT ON` clauses. The candidate
   * set is bounded by the agent's parked-ticket count for one board,
   * which is small in practice (cap=1 board → ≤ a few dozen even
   * during a thrash).
   */
  async getFocusTicket(
    agent_id: string,
    board_id: string,
    role_slug?: string,
  ): Promise<string | null> {
    const candidateIds = await this.getWorkflowLoadTicketIds(agent_id, board_id, role_slug);
    if (candidateIds.length === 0) return null;
    if (candidateIds.length === 1) return candidateIds[0];

    const ticketRepo = this.dataSource.getRepository(Ticket);
    const colRepo = this.dataSource.getRepository(BoardColumn);

    const tickets = await ticketRepo
      .createQueryBuilder('t')
      .where('t.id IN (:...ids)', { ids: candidateIds })
      .getMany();
    if (tickets.length === 0) return null;

    const colIds = Array.from(new Set(tickets.map(t => t.column_id).filter(Boolean) as string[]));
    const columns = colIds.length
      ? await colRepo
          .createQueryBuilder('c')
          .where('c.id IN (:...ids)', { ids: colIds })
          .getMany()
      : [];
    const colById = new Map(columns.map(c => [c.id, c]));

    // Chain-target prefix: a ticket that some other ticket's
    // `next_ticket_id` points at wins the tie. One IN query against
    // the full candidate set, matching the trick used in
    // `backlog-promotion.service.ts` so the static grep
    // (`workflow-focus-selector-guard.test.mjs`) sees the same shape
    // in both files.
    const chainParents = await ticketRepo
      .createQueryBuilder('t')
      .where('t.next_ticket_id IN (:...ids)', { ids: candidateIds })
      .getMany();
    const isChainTarget = new Set(
      chainParents.map(p => p.next_ticket_id).filter(Boolean) as string[],
    );

    tickets.sort((a, b) => {
      // 1. Column position DESC. Higher column = closer to done = wins.
      const pa = colById.get(a.column_id || '')?.position ?? -Infinity;
      const pb = colById.get(b.column_id || '')?.position ?? -Infinity;
      if (pa !== pb) return pb - pa;
      // 2. is_chain_target ASC (0 chain, 1 non-chain). Chain wins.
      const ca = isChainTarget.has(a.id) ? 0 : 1;
      const cb = isChainTarget.has(b.id) ? 0 : 1;
      if (ca !== cb) return ca - cb;
      // 3. priority_index ASC. critical(0) < high(1) < medium(2) < low(3).
      const ia = priorityIndex(a.priority);
      const ib = priorityIndex(b.priority);
      if (ia !== ib) return ia - ib;
      // 4. created_at ASC — oldest first. `?.getTime() ?? 0` guards
      //    legacy rows that may have null timestamps; sqlite + postgres
      //    sort null differently, so do the compare in JS.
      const ta = a.created_at ? new Date(a.created_at).getTime() : 0;
      const tb = b.created_at ? new Date(b.created_at).getTime() : 0;
      return ta - tb;
    });

    return tickets[0]?.id ?? null;
  }
}
