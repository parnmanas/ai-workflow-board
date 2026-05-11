/**
 * AgentWorkloadService — workflow-state cap source for promotion + trigger
 * dispatch.
 *
 * Why this exists (ticket e79eef92):
 *
 *   The pre-fix cap gate inside `BacklogPromotionService.tryPromote` and
 *   `TriggerLoopService._emitTrigger` both read `AgentStatusService
 *   .getActiveTicketIds()`. That helper returns the in-memory
 *   `active_tasks` map maintained by the plugin's `setCurrentTask` /
 *   `clearCurrentTask` signals — i.e. "is a subagent process literally
 *   alive right now". It does NOT reflect whether the agent already owns
 *   a ticket parked on a non-terminal column of the board.
 *
 *   That mismatch made WAIT-only turns starve the cap. Sequence:
 *     1. agent picks up ticket T, decides to WAIT, adds a comment, exits.
 *     2. plugin emits clearCurrentTask → `active_tasks` shrinks → server
 *        emits `agent_idle` → BacklogPromotion promotes the next backlog
 *        item even though T is still parked in To Do with that agent as
 *        assignee. Cap=1 ends up with 13 items in To Do.
 *
 *   The user-stated rule is workflow-level: "while an assignee is still
 *   working on a ticket (i.e. their ticket sits on a non-terminal /
 *   non-intake column), do not assign them another ticket". Process
 *   liveness is not the right signal — committed board state is.
 *
 * What this service returns:
 *
 *   `getWorkflowLoadTicketIds(agent_id, board_id, role_slug?)` — list of
 *   ticket ids on the given board that have a `ticket_role_assignments`
 *   row pointing `agent_id` at one of the (optionally slug-filtered)
 *   workspace roles, AND whose current column is non-terminal AND not an
 *   intake column. Intake exclusion matters because a ticket sitting in
 *   the backlog is NOT being worked on by the assignee — promoting another
 *   ticket onto the same assignee would be correct in that case.
 *
 *   Length of the returned list is the workflow-load count that callers
 *   compare against `Board.max_concurrent_tickets_per_agent`.
 *
 * Composition contract — callers union the workflow-load with
 * `TriggerLoopService.pendingDispatches` (TTL 30s) to cover the in-flight
 * window between emit and the ticket actually landing on a non-terminal
 * column. workflow-load is the persistent "is this agent already busy"
 * fact; pendingDispatches is the short-lived race guard for "we just
 * fired off a trigger that hasn't moved a ticket yet".
 *
 * Permitted callers — backlog-promotion, trigger-loop, and tests of those.
 * `AgentStatusService.getActiveTicketIds` may still be used by
 * EventsController for the live "is the subagent process alive" status
 * badge, but the static grep guard in
 * `test/workflow-state-cap-guard.test.mjs` forbids it on the dispatch
 * path.
 */
import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

@Injectable()
export class AgentWorkloadService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  /**
   * Tickets the agent currently has parked on a non-terminal, non-intake
   * column of the given board, filtered to one role slug if provided.
   *
   * The slug filter is what makes the cap role-aware: a promotion
   * targeting the `assignee` slot doesn't need to skip just because the
   * same agent happens to hold `reporter` on another ticket — those
   * roles can interleave. Pass `undefined` to count every role the
   * agent holds (used by `TriggerLoopService._emitTrigger` to gate any
   * role's trigger emission, since the cap is per-agent globally on
   * the board not per-role-slot).
   *
   * Returns a flat string array — duplicates pre-collapsed by SELECT
   * DISTINCT so a ticket that has the same holder on two roles only
   * counts once toward the cap.
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
}
