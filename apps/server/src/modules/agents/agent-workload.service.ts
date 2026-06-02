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
 *   2. `hasUnresolvedPredecessor ASC` — chain-head wins the tie. A
 *      candidate is "head-ready" iff its predecessor (the ticket whose
 *      `next_ticket_id` points at it) is NOT also in the current
 *      candidate set. If the predecessor IS in the set, the candidate
 *      is "waiting" and gets pushed back so the selector picks the
 *      predecessor first. Reuses the same `next_ticket_id IN (:...ids)`
 *      query shape as `backlog-promotion.service.ts` (ticket 8b3fa67e)
 *      so the static grep guard sees identical shape in both files.
 *
 *      Why predecessor-aware and not just `is_chain_target`: the old
 *      boolean "is anything pointing at me?" can't distinguish two
 *      adjacent chain members. In a `B-3 → B-4 → B-5` chain with the
 *      candidate set `{B-4, B-5}`, both rows are chain-targets, the
 *      tie falls through to priority, and a high-priority B-5 starves
 *      a medium-priority B-4 forever (ticket ee0324ac).
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
import { ActivityLog } from '../../entities/ActivityLog';
import { Ticket } from '../../entities/Ticket';
import { BoardColumn } from '../../entities/BoardColumn';
import { priorityIndex } from './priority';

/**
 * Parse the `Ticket.labels` JSON string defensively. Returns `[]` on any
 * malformed input.
 */
function parseLabels(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((s): s is string => typeof s === 'string' && s.length > 0);
  } catch {
    return [];
  }
}

/**
 * Returns true if at least one label matches the `BLOCKED-*` glob pattern
 * (case-insensitive).
 */
function hasBlockedLabel(labels: string[]): boolean {
  return labels.some(l => l.toLowerCase().startsWith('blocked-'));
}

/**
 * Per-candidate-set ranking inputs: the column lookup that backs the
 * `column.position` key and the head-readiness predicate that backs the
 * chain key. Built once per set inside `rankFocusCandidates` and handed to
 * every `compareFocusCandidates` call.
 */
interface FocusRankContext {
  colById: Map<string, BoardColumn>;
  hasUnresolvedPredecessor: (id: string) => boolean;
}

/**
 * The single focus-ranking comparator (descending importance — equal
 * values fall through to the next key):
 *
 *   1. `column.position DESC` — higher columns win.
 *   2. `hasUnresolvedPredecessor ASC` — chain-head wins the tie.
 *   3. `priorityIndex(priority) ASC` — critical < high < medium < low.
 *   4. `created_at ASC` — oldest first; deterministic tiebreaker.
 *
 * See the class header for the full rationale of each key. Shared by
 * `getFocusTicket` (picks the head) and `rankFocusCandidates` (returns
 * the whole set sorted, for the per-agent top-N collapse on the board
 * focus-badge endpoint) so both order candidates identically.
 */
function compareFocusCandidates(a: Ticket, b: Ticket, ctx: FocusRankContext): number {
  // 1. Column position DESC. Higher column = closer to done = wins.
  const pa = ctx.colById.get(a.column_id || '')?.position ?? -Infinity;
  const pb = ctx.colById.get(b.column_id || '')?.position ?? -Infinity;
  if (pa !== pb) return pb - pa;
  // 2. hasUnresolvedPredecessor ASC. 0 = head-ready, 1 = waiting on
  // a predecessor that's still in the candidate set. Head-ready wins.
  const ca = ctx.hasUnresolvedPredecessor(a.id) ? 1 : 0;
  const cb = ctx.hasUnresolvedPredecessor(b.id) ? 1 : 0;
  if (ca !== cb) return ca - cb;
  // 3. priority_index ASC. critical(0) < high(1) < medium(2) < low(3).
  const ia = priorityIndex(a.priority);
  const ib = priorityIndex(b.priority);
  if (ia !== ib) return ia - ib;
  // 4. created_at ASC — oldest first. `?.getTime() ?? 0` guards legacy
  //    rows that may have null timestamps; sqlite + postgres sort null
  //    differently, so do the compare in JS.
  const ta = a.created_at ? new Date(a.created_at).getTime() : 0;
  const tb = b.created_at ? new Date(b.created_at).getTime() : 0;
  return ta - tb;
}

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
    //
    // Postgres type coercion: tickets.id and workspace_roles.id are uuid
    // PKs (TypeORM @PrimaryGeneratedColumn('uuid')). ticket_role_assignments
    // has plain varchar columns for the FK side (no @ManyToOne to drive
    // the PG driver toward uuid, and pre-sync-postgres casts every
    // non-KEEP_AS_UUID column back to varchar). Joining varchar = uuid
    // raises `operator does not exist: character varying = uuid` on
    // Postgres ("No operator matches the given name and argument types"
    // — pg won't pick a cast direction). Cast the uuid PK to text on the
    // join condition so the comparison runs against a uniform type.
    // SQLite is loose-typed and needs no cast — txt is empty there.
    const isPostgres = this.dataSource.driver.options.type === 'postgres';
    const txt = isPostgres ? '::text' : '';
    const qb = this.dataSource
      .createQueryBuilder()
      .select('DISTINCT t.id', 'id')
      .from('tickets', 't')
      .innerJoin(
        'ticket_role_assignments',
        'ra',
        `ra.ticket_id = t.id${txt} AND ra.agent_id = :agent_id`,
      )
      .innerJoin('workspace_roles', 'wr', `wr.id${txt} = ra.role_id`)
      .innerJoin('columns', 'c', 'c.id = t.column_id')
      .where('c.board_id = :board_id')
      .andWhere('c.is_terminal = :falseVal')
      .andWhere("c.kind != 'intake'")
      // Pending-user-action exclusion (ticket a57517be): tickets parked
      // behind a human decision must not anchor the agent's focus, because
      // the dispatch path drops their triggers anyway and BacklogPromotionService
      // refuses to promote a new ticket while a non-null focus exists. Same
      // bound-parameter pattern as `c.is_terminal` so sqlite (0/1) and
      // postgres (true/false) both bind correctly.
      .andWhere('t.pending_user_action = :falseVal')
      // Blocked-by-ticket exclusion (ticket 48d14fff): a ticket pending on
      // prerequisites must not anchor focus either — its triggers are dropped
      // downstream and it auto-resumes when the prereqs land on terminal. Same
      // bound-parameter pattern as the pending_user_action gate above.
      .andWhere('t.pending_on_tickets = :falseVal')
      // Archived tickets (ticket 9b44526b) are excluded for the same reason:
      // they're no longer actionable workflow items, so they must not anchor
      // focus or block backlog promotion. Trigger emission is also gated
      // separately in `_emitTrigger`, but excluding them here keeps the
      // selector output consistent with what the supervisor / allocation
      // paths already filter out.
      .andWhere('t.archived_at IS NULL')
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
   * `hasUnresolvedPredecessor ASC`, `priorityIndex ASC`,
   * `created_at ASC`) is awkward to express portably across sqlite +
   * postgres without driver-specific `CASE WHEN` / `DISTINCT ON`
   * clauses. The candidate
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
    const ranked = await this.rankFocusCandidates(candidateIds);
    return ranked[0]?.id ?? null;
  }

  /**
   * Per-agent FOCUS collapse (ticket 3fb0005d).
   *
   * `getFocusTicket` ranks one (agent, board, role) slice and returns the
   * single head. The board FOCUS-badge endpoint calls it once per
   * (agent, role) pair, so an agent that holds two roles on a board
   * (e.g. assignee + reviewer — 겸직) gets one badge per role = up to two
   * FOCUS tickets, even though `max_concurrent_tickets_per_agent` caps the
   * agent-manager dispatch at N (default 1) distinct tickets. The badge
   * count and the dispatch cap then disagree ("focus 2개인데 dispatch 1개").
   *
   * This method collapses to the dispatch unit: it ranks the agent's
   * candidates across ALL roles (no `role_slug` filter — the underlying
   * `getWorkflowLoadTicketIds` SELECT DISTINCTs by ticket, so a ticket the
   * agent holds on two roles only appears once) and returns the top `limit`
   * ticket ids. With `limit = max_concurrent_tickets_per_agent` the FOCUS
   * surface matches what the manager will actually dispatch.
   *
   * Non-겸직 is unchanged by construction: an agent holding a single role
   * has the same candidate set with or without the role filter, so the
   * collapsed top-1 equals the old per-role top-1 (verification case b).
   *
   * Ranking, BLOCKED filtering, and the 0/1-candidate fast paths mirror
   * `getFocusTicket` exactly — both delegate to `rankFocusCandidates` —
   * so the collapse never reorders a single agent's tickets differently
   * from the dispatch selector.
   */
  async getAgentFocusTicketIds(
    agent_id: string,
    board_id: string,
    limit: number,
  ): Promise<string[]> {
    if (!Number.isFinite(limit) || limit <= 0) return [];
    const candidateIds = await this.getWorkflowLoadTicketIds(agent_id, board_id);
    if (candidateIds.length === 0) return [];
    // Single candidate: mirror getFocusTicket's fast path (no BLOCKED
    // filter / sort for a lone ticket) so the two entry points agree.
    if (candidateIds.length === 1) return candidateIds.slice(0, limit);
    const ranked = await this.rankFocusCandidates(candidateIds);
    return ranked.slice(0, limit).map((t) => t.id);
  }

  /**
   * Rank a candidate-ticket id set with the focus selector's compound
   * order, after dropping heartbeat-only BLOCKED tickets. Returns the
   * sorted `Ticket[]` (head = the agent's top focus). Shared by
   * `getFocusTicket` (takes the head) and `getAgentFocusTicketIds` (takes
   * the top-N) so both apply identical ranking + BLOCKED semantics.
   *
   * Callers handle the 0/1-candidate fast paths themselves; this method
   * assumes a multi-candidate set but is still correct (returns [] / the
   * lone survivor) for smaller inputs.
   */
  private async rankFocusCandidates(candidateIds: string[]): Promise<Ticket[]> {
    if (candidateIds.length === 0) return [];

    const ticketRepo = this.dataSource.getRepository(Ticket);
    const colRepo = this.dataSource.getRepository(BoardColumn);

    const tickets = await ticketRepo
      .createQueryBuilder('t')
      .where('t.id IN (:...ids)', { ids: candidateIds })
      .getMany();
    if (tickets.length === 0) return [];

    const colIds = Array.from(new Set(tickets.map(t => t.column_id).filter(Boolean) as string[]));
    const columns = colIds.length
      ? await colRepo
          .createQueryBuilder('c')
          .where('c.id IN (:...ids)', { ids: colIds })
          .getMany()
      : [];
    const colById = new Map(columns.map(c => [c.id, c]));

    // Chain-head prefix: a candidate whose predecessor (the ticket
    // whose `next_ticket_id` points at it) is ALSO in the current
    // candidate set is "waiting" and must rank behind a "head-ready"
    // candidate whose predecessor is absent (finished / never existed
    // / parked elsewhere).
    //
    // Single IN-query against the full candidate set, then materialised
    // into a child→parent map so step 2 can ask "is my predecessor
    // still in play?" in O(1). Query shape kept identical to
    // `backlog-promotion.service.ts` so the static grep guard
    // (`workflow-focus-selector-guard.test.mjs`) sees the same line in
    // both files (ticket 8b3fa67e).
    //
    // Why not the older "is_chain_target" boolean (ticket ee0324ac):
    // every middle-of-chain candidate is also a chain-target — so an
    // `A→B→C` chain with the candidate set `{B,C}` ties on step 2 and
    // falls through to priority, where a high-priority C starves a
    // medium-priority B forever. Predecessor-awareness picks B first
    // (its parent A is not in the set, so it's head-ready), advances
    // it through, and only then unlocks C. With no chain at all the
    // map is empty and every candidate is trivially head-ready, so
    // the no-chain regression path is unchanged.
    const chainParents = await ticketRepo
      .createQueryBuilder('t')
      .where('t.next_ticket_id IN (:...ids)', { ids: candidateIds })
      .getMany();
    const parentOfChild = new Map<string, string>();
    for (const p of chainParents) {
      if (p.next_ticket_id) parentOfChild.set(p.next_ticket_id, p.id);
    }
    const candidateSet = new Set(candidateIds);
    const hasUnresolvedPredecessor = (id: string): boolean => {
      const parent = parentOfChild.get(id);
      return parent != null && candidateSet.has(parent);
    };

    // Heartbeat-only BLOCKED filter (ticket b55e4421):
    //
    //   A ticket carrying a BLOCKED-* label whose most recent claim→release
    //   cycle contains ZERO column moves is in a "heartbeat-only" loop —
    //   the subagent checked the gate, found it closed, posted a comment,
    //   and released without advancing the ticket. Treating such a ticket
    //   as focus permanently locks the role queue (the BacklogPromotionService
    //   refuses to promote any new ticket while a focus exists).
    //
    //   Exclude these tickets from focus consideration so the next eligible
    //   ticket can be promoted and dispatched. The BLOCKED ticket stays in
    //   its column and continues to receive heartbeat pings via the
    //   supervisor backstop — it just stops blocking the queue.
    // TODO: batch the activity lookups for all BLOCKED tickets in one query
    // to avoid N+1 sequential queries per candidate (lastRelease, lastClaim, moveCount).
    const activityRepo = this.dataSource.getRepository(ActivityLog);
    const nonBlockedTickets: Ticket[] = [];
    for (const t of tickets) {
      const labels = parseLabels(t.labels);
      if (!hasBlockedLabel(labels)) {
        nonBlockedTickets.push(t);
        continue;
      }
      // Check if the most recent release was heartbeat-only (no column
      // move between the last claim and release).
      const lastRelease = await activityRepo
        .createQueryBuilder('a')
        .where('a.ticket_id = :tid', { tid: t.id })
        .andWhere("a.action = 'updated'")
        .andWhere("a.field_changed = 'locked_by_agent_id'")
        .andWhere("a.trigger_source = 'agent_release'")
        .orderBy('a.created_at', 'DESC')
        .limit(1)
        .getOne();
      if (!lastRelease) {
        // No release record at all — ticket was never claimed/released,
        // keep it in the candidate set.
        nonBlockedTickets.push(t);
        continue;
      }
      const lastClaim = await activityRepo
        .createQueryBuilder('a')
        .where('a.ticket_id = :tid', { tid: t.id })
        .andWhere("a.action = 'updated'")
        .andWhere("a.field_changed = 'locked_by_agent_id'")
        .andWhere("a.trigger_source = 'agent_claim'")
        .andWhere('a.created_at <= :releaseAt', { releaseAt: lastRelease.created_at })
        .orderBy('a.created_at', 'DESC')
        .limit(1)
        .getOne();
      if (!lastClaim) {
        nonBlockedTickets.push(t);
        continue;
      }
      // Count column moves between claim and release.
      const moveCount = await activityRepo
        .createQueryBuilder('a')
        .where('a.ticket_id = :tid', { tid: t.id })
        .andWhere("a.action = 'moved'")
        .andWhere("a.field_changed = 'column'")
        .andWhere('a.created_at >= :claimAt', { claimAt: lastClaim.created_at })
        .andWhere('a.created_at <= :releaseAt', { releaseAt: lastRelease.created_at })
        .getCount();
      if (moveCount > 0) {
        // Last cycle had a real column move — ticket is actively progressing.
        nonBlockedTickets.push(t);
      }
      // else: heartbeat-only BLOCKED ticket — excluded from focus.
    }
    if (nonBlockedTickets.length === 0) return [];
    if (nonBlockedTickets.length === 1) return nonBlockedTickets;

    // Single comparator shared with `getFocusTicket` (via this same method)
    // so the per-agent top-N collapse orders candidates identically to the
    // dispatch selector. See `compareFocusCandidates` for the 4-key order.
    const ctx: FocusRankContext = { colById, hasUnresolvedPredecessor };
    nonBlockedTickets.sort((a, b) => compareFocusCandidates(a, b, ctx));

    return nonBlockedTickets;
  }
}
