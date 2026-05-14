/**
 * BacklogPromotionService — server-owned replacement for the previous
 * prompt-driven backlog scan.
 *
 * Why this exists (v0.41 root-cause fix, layer L1):
 *
 *   The pre-v0.41 `backlog_workflow` template instructed the reporter to
 *   `mcp__awb__get_board` for the entire board state, sort the backlog
 *   by priority + created_at, run busy-checks for every candidate's
 *   role holders, and `move_ticket` one. That scan ran on EVERY reporter
 *   trigger, which was per-activity — so a backlog of N tickets meant
 *   the same scan ran N times, each one writing 2 comments (rationale +
 *   marker) which were themselves new activities re-firing the reporter.
 *   A self-amplifying loop that drowned out high-priority Review
 *   column-moves arriving in parallel.
 *
 *   This service replaces the scan with a single-transaction promotion
 *   driven off capacity events (an agent freeing up, a ticket moving to
 *   terminal, etc.). The reporter prompt's responsibility shrinks to
 *   "narrate the result" once the move has already happened — see the
 *   trimmed default-prompt-templates.ts::backlog_workflow.
 *
 * Invariants (verifiable via the v0.41 acceptance grep):
 *
 *   1. No column-name string compares — we read `BoardColumn.kind` enum
 *      and `BoardColumn.role_routing` JSON, never `name.toLowerCase()`.
 *   2. No role-slug semantic assumptions — promotion uses whatever role
 *      slug list the destination column's `role_routing` contains; it
 *      doesn't assume `'assignee'` is the In Progress driver.
 *   3. No ticket-priority string compares — the candidate sort is on
 *      `priorityIndex(ticket.priority)` only.
 *   4. No agent-name compares — capacity checks are agent-id keyed.
 *
 * Trigger surface:
 *
 *   - 'agent_idle' (activityEvents): emitted by AgentStatusService when
 *     an agent's active_tasks shrinks. We try to promote one ticket on
 *     each board where the freed agent holds a role on the destination
 *     column.
 *   - Direct call: BacklogPromotionService.tryPromote(boardId) for the
 *     terminal-column landing path / explicit operator action.
 *
 * Promotion is best-effort: if no ticket on any intake column has a
 * fully-filled role set with holders whose focus selector returns null
 * (i.e. they aren't already busy on a non-intake / non-terminal
 * ticket), the call is a no-op. The next capacity event will retry.
 * The supervisor 30-min stale check remains as a final eventual-
 * consistency backstop.
 *
 * Promotion gate (ticket 4a6cdfd7, replaces the workflow-load cap):
 *
 *   For each destination role on the promoted ticket, the holder is
 *   eligible iff `AgentWorkloadService.getFocusTicket(holder, board,
 *   slug)` returns null. A non-null return means the holder already
 *   has a focus ticket on this board, so promoting another one onto
 *   them would just stack a non-emittable trigger. The audit trail
 *   records each skip as `backlog_promotion_skipped_focus_held` with
 *   `holder=` and `focus_ticket_id=` in `new_value`.
 */
import { Injectable, OnModuleInit, forwardRef, Inject } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { ActivityLog } from '../../entities/ActivityLog';
import { Agent } from '../../entities/Agent';
import { Board } from '../../entities/Board';
import { BoardColumn } from '../../entities/BoardColumn';
import { Ticket } from '../../entities/Ticket';
import { TicketRoleAssignment } from '../../entities/TicketRoleAssignment';
import { WorkspaceRole } from '../../entities/WorkspaceRole';
import { LogService } from '../../services/log.service';
import { ActivityService, activityEvents } from '../../services/activity.service';
import { AgentWorkloadService } from './agent-workload.service';
import { TriggerLoopService } from './trigger-loop.service';
import { priorityIndex } from './priority';

function safeJsonParse<T>(s: string | null | undefined, fallback: T): T {
  if (!s) return fallback;
  try { return JSON.parse(s) as T; } catch { return fallback; }
}

@Injectable()
export class BacklogPromotionService implements OnModuleInit {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly logService: LogService,
    private readonly activityService: ActivityService,
    private readonly agentWorkload: AgentWorkloadService,
    // forwardRef preserved purely as a defensive measure: BacklogPromotion
    // and TriggerLoop share AgentWorkloadService and don't strictly need
    // a forward edge after the dispatch queue removal, but keeping it
    // here means a future back-edge addition doesn't require module
    // surgery again.
    @Inject(forwardRef(() => TriggerLoopService))
    private readonly triggerLoop: TriggerLoopService,
  ) {}

  onModuleInit(): void {
    // Capacity-event signal — same one TriggerLoopService listens for to
    // dispatch queued items. Promotion only fires for the agent that just
    // freed up; no full board scan and no comment churn.
    activityEvents.on('agent_idle', (payload: { agent_id: string }) => {
      const agentId = payload?.agent_id || '';
      if (!agentId) return;
      this._onAgentIdle(agentId).catch((e: unknown) => {
        this.logService.error('BacklogPromotion', 'agent_idle handler failed', {
          err: String(e), agent_id: agentId,
        });
      });
    });
  }

  /**
   * Attempt one promotion pass on every board the freed agent has any
   * role assignment on. At most one ticket moves per board per call —
   * matches the `One investment per done event` contract from the old
   * prompt and keeps the audit trail readable.
   */
  private async _onAgentIdle(agentId: string): Promise<void> {
    const agentRepo = this.dataSource.getRepository(Agent);
    const agent = await agentRepo.findOne({ where: { id: agentId } });
    if (!agent || !agent.workspace_id) return;

    const boardRepo = this.dataSource.getRepository(Board);
    const boards = await boardRepo.find({ where: { workspace_id: agent.workspace_id } });
    for (const board of boards) {
      try {
        await this.tryPromote(board.id, { triggerAgentId: agentId });
      } catch (e) {
        this.logService.warn('BacklogPromotion', 'board promotion failed (continuing)', {
          err: String(e), board_id: board.id, agent_id: agentId,
        });
      }
    }
  }

  /**
   * Run a single-transaction promotion attempt on the given board.
   *
   * Picks the highest-priority intake-column ticket whose destination
   * (first-active column) has every required role filled with holders
   * who are below the per-board cap, then moves it via the canonical
   * column-move path (DB update + ticket.moved activity log). Returns
   * the promoted ticket id or null if no eligible candidate exists.
   *
   * `opts.triggerAgentId` is informational — used in the activity row
   * audit trail so post-mortems can correlate the promotion against the
   * idle event that caused it. It does NOT gate eligibility (a promotion
   * still requires the *destination*-column holders to be free, not the
   * triggering agent).
   */
  async tryPromote(boardId: string, opts?: { triggerAgentId?: string }): Promise<string | null> {
    const colRepo = this.dataSource.getRepository(BoardColumn);
    const ticketRepo = this.dataSource.getRepository(Ticket);
    const boardRepo = this.dataSource.getRepository(Board);

    const board = await boardRepo.findOne({ where: { id: boardId } });
    if (!board) return null;

    // Board pause gate. Pausing must also block the silent backlog→active
    // move, not just downstream agent triggers — otherwise the moment a
    // capacity event fires we'd shuffle tickets into the "To Do" column on
    // a paused board and the human operator would see queue churn they
    // didn't ask for. Cheap check, early return, no audit row (the
    // promotion just becomes a no-op identical to "no eligible candidate").
    if (board.paused_at) {
      this.logService.info('BacklogPromotion', 'tryPromote skipped (board paused)', {
        board_id: boardId, paused_at: new Date(board.paused_at).toISOString(),
        triggered_by: opts?.triggerAgentId || null,
      });
      return null;
    }

    const columns = await colRepo.find({ where: { board_id: boardId }, order: { position: 'ASC' } });
    if (columns.length === 0) return null;

    // Intake columns — `kind = 'intake'` is the canonical marker. The
    // legacy `name = 'Backlog'` heuristic is forbidden in dispatch code;
    // unmarked columns (kind = '') get treated as 'active' so they don't
    // accidentally turn into intake queues by being at position 0.
    const intakeCols = columns.filter(c => (c as any).kind === 'intake');
    if (intakeCols.length === 0) return null;

    // Destination — lowest-position column that is NOT an intake AND not
    // terminal AND has a non-empty role_routing. This is where the
    // promoted ticket goes; in the default preset that's "To Do" (or
    // "Plan" if Plan is wired earlier). We pick the first eligible
    // column rather than hard-coding a name match.
    const destination = columns.find(c => {
      if ((c as any).is_terminal === true) return false;
      const k = String((c as any).kind || '');
      if (k === 'intake' || k === 'terminal') return false;
      const slugs = safeJsonParse<string[]>((c as any).role_routing, []);
      return Array.isArray(slugs) && slugs.length > 0;
    });
    if (!destination) return null;

    const destSlugs = safeJsonParse<string[]>((destination as any).role_routing, []);
    if (!Array.isArray(destSlugs) || destSlugs.length === 0) return null;

    const intakeColIds = intakeCols.map(c => c.id);
    const candidates = await ticketRepo.createQueryBuilder('t')
      .where('t.column_id IN (:...ids)', { ids: intakeColIds })
      .getMany();
    if (candidates.length === 0) return null;

    // Chain-target prefix: a candidate that some other ticket's
    // `next_ticket_id` points at must win over an unrelated higher-priority
    // candidate. Without this prefix, an `A.next_ticket_id = B` chain where
    // A has already reached terminal but B is still in intake gets bypassed
    // — promotion picks a critical-priority `C` ahead of `B`, and the
    // `_dispatchNextTicket` path (which wakes B's *current* column's
    // role-holders) can't compensate because B is still in an intake column
    // routed to `reporter`, not `assignee`. The prefix is computed against
    // the entire candidate set in one IN-list query, so the cost is one
    // round-trip regardless of board size, and parent location doesn't
    // matter (a candidate is a chain target whether the pointing ticket is
    // terminal, active, or somewhere else).
    const candidateIds = candidates.map(c => c.id);
    const chainParents = candidateIds.length
      ? await ticketRepo
          .createQueryBuilder('t')
          .where('t.next_ticket_id IN (:...ids)', { ids: candidateIds })
          .getMany()
      : [];
    const isChainTarget = new Set(
      chainParents.map(p => p.next_ticket_id).filter(Boolean) as string[],
    );

    // Sort key: chain_target ASC (chain wins), then priority_index ASC,
    // then created_at ASC. priority_index is the SINGLE allowed sort key
    // for priority — see the priority.ts helper. Within the same chain
    // tier and same priority, oldest-created ticket wins. The chain
    // prefix is additive only: ties on chain_target preserve the
    // previous priority/created_at order so the no-chain regression case
    // matches the pre-fix output exactly.
    candidates.sort((a, b) => {
      const ax = isChainTarget.has(a.id) ? 0 : 1;
      const bx = isChainTarget.has(b.id) ? 0 : 1;
      if (ax !== bx) return ax - bx;
      const pa = priorityIndex(a.priority);
      const pb = priorityIndex(b.priority);
      if (pa !== pb) return pa - pb;
      const ca = a.created_at ? new Date(a.created_at).getTime() : 0;
      const cb = b.created_at ? new Date(b.created_at).getTime() : 0;
      return ca - cb;
    });

    // Resolve workspace role rows once per call so the per-ticket loop
    // is a Map lookup. routing role slugs that don't exist as
    // WorkspaceRole rows can't be filled — skip the ticket entirely
    // rather than silently dispatching to a dead role.
    const roleRepo = this.dataSource.getRepository(WorkspaceRole);
    const roles = await roleRepo.find({ where: { workspace_id: board.workspace_id } });
    const roleBySlug = new Map(roles.map(r => [r.slug, r]));
    const requiredRoleIds: string[] = [];
    for (const slug of destSlugs) {
      const role = roleBySlug.get(slug);
      if (!role) {
        // Routing references a slug that doesn't exist on this workspace
        // — promotion impossible until the routing is fixed. Bail rather
        // than silently filter the slug out (which would be the
        // hardcoded-fallback behaviour we banned).
        this.logService.info('BacklogPromotion', 'destination column references unknown role slug', {
          board_id: boardId, dest_column_id: destination.id, slug,
        });
        return null;
      }
      requiredRoleIds.push(role.id);
    }

    const assignRepo = this.dataSource.getRepository(TicketRoleAssignment);

    for (const ticket of candidates) {
      const assignments = await assignRepo.find({ where: { ticket_id: ticket.id } });
      const assignByRoleId = new Map(assignments.map(a => [a.role_id, a]));

      let eligible = true;
      // (role_slug, holder_agent_id) pairs we will emit triggers to once
      // the move commits. Built up alongside the eligibility check so we
      // don't re-walk the role list in the post-save loop.
      const dispatchTargets: Array<{ slug: string; holderId: string }> = [];
      // Audit-trail material for a focus-held skip — captured up here
      // so the activity row can record which holder/slug closed the gate.
      let skipReason: {
        slug: string;
        holderId: string;
        focusTicketId: string;
      } | null = null;
      for (let i = 0; i < requiredRoleIds.length; i++) {
        const roleId = requiredRoleIds[i];
        const slug = destSlugs[i];
        const a = assignByRoleId.get(roleId);
        if (!a || !a.agent_id) {
          // Role unfilled on the candidate — can't promote, the trigger
          // would land on no-one.
          eligible = false;
          break;
        }
        // Focus-selector gate (ticket 4a6cdfd7) — replaces the previous
        // per-candidate workflow-load cap loop. A holder that currently
        // has ANY focus ticket on this board (for this role slug) is
        // ineligible: the focus model says one ticket per agent per
        // board / role, and that ticket is `focusTicketId`. The
        // candidate itself is in an intake column so it can never be
        // its own focus (the selector excludes intake by construction);
        // a non-null return here therefore names a DIFFERENT ticket
        // already occupying the slot.
        const focusTicketId = await this.agentWorkload.getFocusTicket(
          a.agent_id, boardId, slug,
        );
        if (focusTicketId) {
          eligible = false;
          skipReason = { slug, holderId: a.agent_id, focusTicketId };
          break;
        }
        dispatchTargets.push({ slug, holderId: a.agent_id });
      }
      if (!eligible) {
        // Observability: an audit row for every promotion blocked by a
        // focus-held holder. Lets ops correlate "this backlog isn't
        // draining" to the specific (holder, focus_ticket) pair.
        if (skipReason) {
          try {
            const activityLogRepo = this.dataSource.getRepository(ActivityLog);
            await activityLogRepo.save(activityLogRepo.create({
              entity_type: 'ticket',
              entity_id: ticket.id,
              ticket_id: ticket.id,
              actor_id: 'system',
              actor_name: 'BacklogPromotionService',
              action: 'backlog_promotion_skipped_focus_held',
              new_value:
                `board=${boardId} role=${skipReason.slug} ` +
                `holder=${skipReason.holderId} ` +
                `focus_ticket_id=${skipReason.focusTicketId}`,
              role: skipReason.slug,
              trigger_source: 'backlog_promotion',
            }));
          } catch (e) {
            this.logService.warn('BacklogPromotion', 'focus-held skip audit write failed (continuing)', {
              err: String(e), ticket_id: ticket.id,
            });
          }
        }
        continue;
      }

      // Move: ticket.column_id update + audit `moved` activity row.
      //
      // We deliberately do NOT rely on the `moved` activity to wake the
      // destination role holders. The activity is written with
      // `actor_id: 'system'`, which `TriggerLoopService._handleActivity`
      // skips by design (the system-actor filter exists to prevent
      // listener-loops on system-comment-style writes). Instead this
      // service explicitly calls `triggerLoop.emitAgentTrigger()` per
      // (role, holder) below, so promotion has a deterministic dispatch
      // path independent of listener semantics.
      //
      // Status bump is omitted by design — `move_ticket` MCP / REST do
      // not auto-mutate ticket.status either, so promotion mirrors the
      // canonical move semantics rather than re-introducing a hardcoded
      // status string. Workspaces that key on the legacy enum can derive
      // it from `BoardColumn.kind` instead (`'intake' → backlog`,
      // `'active' → todo`, etc.).
      const fromColumnId = ticket.column_id;
      const fromCol = columns.find(c => c.id === fromColumnId) || null;
      ticket.column_id = destination.id;
      ticket.position = 0;
      await ticketRepo.save(ticket);

      try {
        await this.activityService.logActivity({
          entity_type: 'ticket',
          entity_id: ticket.id,
          action: 'moved',
          field_changed: 'column',
          old_value: fromCol ? fromCol.name : '',
          new_value: destination.name,
          actor_id: 'system',
          actor_name: 'BacklogPromotionService',
          ticket_id: ticket.id,
          trigger_source: 'backlog_promotion',
        });
      } catch (e) {
        this.logService.warn('BacklogPromotion', 'activity log write failed (move still committed)', {
          err: String(e), ticket_id: ticket.id,
        });
      }

      // Explicit per-holder dispatch. Going through `emitAgentTrigger`
      // re-applies the focus-selector gate inside `_emitTrigger` for
      // free — so an emit that loses the focus race (e.g. another role
      // already landed a higher-column ticket on the same agent
      // between our eligibility check and this emit) drops silently.
      // The `triggered_by` field is the *causing* idle-event agent (or
      // 'backlog_promotion' for direct calls) so post-mortems can
      // correlate the wake-up to the slot that opened.
      const triggeredBy = opts?.triggerAgentId || 'backlog_promotion';
      for (const target of dispatchTargets) {
        try {
          await this.triggerLoop.emitAgentTrigger(
            ticket,
            target.holderId,
            target.slug,
            'backlog_promotion',
            triggeredBy,
          );
        } catch (e) {
          // A failed emit on one role mustn't block the others or roll
          // back the move; the supervisor stale-allocation re-push is
          // the eventual-consistency backstop for any holder we missed.
          this.logService.warn('BacklogPromotion', 'destination role emit failed (continuing)', {
            err: String(e), ticket_id: ticket.id, role: target.slug, agent_id: target.holderId,
          });
        }
      }
      const checkedHolders = dispatchTargets.map(t => t.holderId);

      // Audit row — separate from the 'moved' activity so dashboards can
      // distinguish a server-owned promotion from a manual / agent move.
      try {
        const activityLogRepo = this.dataSource.getRepository(ActivityLog);
        await activityLogRepo.save(activityLogRepo.create({
          entity_type: 'ticket',
          entity_id: ticket.id,
          ticket_id: ticket.id,
          actor_id: 'system',
          actor_name: 'BacklogPromotionService',
          action: 'backlog_promoted',
          new_value: `from=${fromColumnId} to=${destination.id} priority_index=${priorityIndex(ticket.priority)} ` +
                     `chain_target=${isChainTarget.has(ticket.id)} ` +
                     `triggered_by=${opts?.triggerAgentId || 'manual'} holders=${checkedHolders.join(',')}`,
          trigger_source: 'backlog_promotion',
        }));
      } catch (e) {
        this.logService.warn('BacklogPromotion', 'audit log write failed (move still committed)', {
          err: String(e), ticket_id: ticket.id,
        });
      }

      this.logService.info('BacklogPromotion', 'promoted ticket from intake to first-active', {
        board_id: boardId, ticket_id: ticket.id,
        from_column_id: fromColumnId, to_column_id: destination.id,
        priority_index: priorityIndex(ticket.priority),
        chain_target: isChainTarget.has(ticket.id),
        triggered_by: opts?.triggerAgentId || null,
      });
      return ticket.id;
    }

    return null;
  }
}
