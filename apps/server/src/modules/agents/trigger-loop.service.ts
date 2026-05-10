import { Injectable, OnModuleInit, forwardRef, Inject } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { randomUUID } from 'crypto';
import { ActivityLog } from '../../entities/ActivityLog';
import { Ticket } from '../../entities/Ticket';
import { BoardColumn } from '../../entities/BoardColumn';
import { Board } from '../../entities/Board';
import { Agent } from '../../entities/Agent';
import { PromptTemplate } from '../../entities/PromptTemplate';
import { Resource } from '../../entities/Resource';
import { WorkspaceRole } from '../../entities/WorkspaceRole';
import { TicketRoleAssignment } from '../../entities/TicketRoleAssignment';
import { LogService } from '../../services/log.service';
import { activityEvents } from '../../services/activity.service';
import { AgentStatusService } from './agent-status.service';
import { AgentDispatchQueueService, QueueItem } from './agent-dispatch-queue.service';
import { priorityIndex } from './priority';

// Pure SSE emitter. The AgentTrigger DB table was removed in v0.25.0 —
// delivery is fire-and-forget. Backstop for dropped SSE is now
// TicketSupervisorService (server-side), which re-pushes stale allocations.
// No cooldown here (the plugin dedupes in-session by trigger_id), no TTL
// sweep (no persistence).
//
// Activities we convert to agent_trigger events:
//   - 'moved': ticket moved to a new column
//   - 'created' on entity_type 'comment': new comment on a ticket
//   - 'updated': ticket field changed
//
// All resolve the ticket's current column, look up routing_config, and emit
// one agent_trigger per (role, role-holding agent_id) pair.

const COMMENT_ACTION = 'created';
const COMMENT_ENTITY = 'comment';

// Synchronous reservation TTL for in-flight emits whose set_current_task
// hasn't landed yet. Long enough to absorb a normal subagent spawn round-trip
// (sub-second in practice), short enough that a silently-dropped trigger
// (manager restart, network blip) doesn't keep the cap closed forever — the
// supervisor's 30 min stale check will eventually re-push.
const PENDING_DISPATCH_TTL_MS = 30_000;

@Injectable()
export class TriggerLoopService implements OnModuleInit {
  // agent_id → Map<ticket_id, emitted_at_ms>. Counts toward the per-board
  // max_concurrent_tickets_per_agent cap alongside AgentStatusService's
  // active_tasks. Active_tasks is plugin-signal driven and only flips on
  // set_current_task, which lags the SSE emit by the manager spawn round-
  // trip; without this the cap permits a burst of N back-to-back triggers
  // before any of them stamp the active map. Entries here are added
  // synchronously between cap check and emit, so a concurrent _emitTrigger
  // racing on the same agent observes them.
  private readonly pendingDispatches = new Map<string, Map<string, number>>();

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly logService: LogService,
    private readonly agentStatusService: AgentStatusService,
    @Inject(forwardRef(() => AgentDispatchQueueService))
    private readonly dispatchQueue: AgentDispatchQueueService,
  ) {}

  onModuleInit() {
    activityEvents.on('activity', (log: ActivityLog) => {
      this._handleActivity(log).catch((e: unknown) => {
        this.logService.error('MCP', 'TriggerLoop error in _handleActivity', { err: e });
      });
    });

    // v0.41 — close the loop on cap-skip → enqueue → dispatch.
    //
    // AgentStatusService emits 'agent_idle' whenever an agent's active_tasks
    // shrinks (clearCurrentTask path or sweep stale-task cleanup). Use that
    // as the capacity signal: pull the highest-priority queued item for
    // this agent and try to fire it. The dispatch path re-checks the cap
    // and ticket existence so a stale queue entry can't stomp on a busy
    // agent — see _tryDispatchFromQueue for the contract.
    activityEvents.on('agent_idle', (payload: { agent_id: string }) => {
      this._tryDispatchFromQueue(payload?.agent_id || '').catch((e: unknown) => {
        this.logService.error('MCP', 'TriggerLoop error in _tryDispatchFromQueue', { err: e });
      });
    });
  }

  private async _handleActivity(log: ActivityLog): Promise<void> {
    if (!log.ticket_id) return;

    let triggerSource: string;
    if (log.action === 'moved') {
      triggerSource = 'column_move';
    } else if (log.entity_type === COMMENT_ENTITY && log.action === COMMENT_ACTION) {
      triggerSource = 'comment';
    } else if (log.action === 'updated') {
      triggerSource = 'ticket_update';
    } else {
      return;
    }

    // Skip system-generated activity to prevent loops
    if (log.actor_id === 'system') return;

    const ticketRepo = this.dataSource.getRepository(Ticket);
    const ticket = await ticketRepo.findOne({ where: { id: log.ticket_id } });
    if (!ticket) return;

    // v0.41 — column resolution is column-id driven, not name-driven.
    // The ticket's current column_id is the ground truth (the previous
    // code resolved by lowercased column name to look up routing_config,
    // a hardcoded path now banned). For 'moved' activities the ticket
    // already points at the destination column row by the time the
    // ActivityLog is written, so reading ticket.column_id covers both
    // cases without a name match.
    if (!ticket.column_id) return;
    const col = await this.dataSource
      .getRepository(BoardColumn)
      .findOne({ where: { id: ticket.column_id } });
    if (!col) return;

    // Terminal columns never trigger themselves. Completion is the
    // terminal column's job. But a terminal landing can hand off to the
    // next ticket in a chain: if `column_move` lands on a terminal column
    // AND the moved ticket has `next_ticket_id` set, dispatch a
    // `trigger_source: 'next_ticket'` round for the linked ticket's
    // current column. This is the only path where one ticket's activity
    // wakes a different ticket's roles.
    const isTerminal = (col as any).is_terminal === true || (col as any).kind === 'terminal';
    if (isTerminal) {
      // Sweep any stale queued triggers that still target this ticket
      // — they're no longer dispatchable now that the ticket sits on a
      // terminal column. Without this sweep, dead entries would compete
      // with valid items for the bounded queue depth and could evict
      // legitimate high-priority work via the lowest-priority drop
      // policy. Lazy cleanup at dispatch time only handles the head.
      if (log.action === 'moved') {
        const removed = this.dispatchQueue.removeForTicketEverywhere(ticket.id);
        if (removed > 0) {
          this.logService.info('MCP', 'terminal landing swept stale queue entries', {
            ticket_id: ticket.id, column_id: col.id, removed,
          });
        }
      }
      if (log.action === 'moved' && ticket.next_ticket_id) {
        await this._dispatchNextTicket(ticket, log.actor_id || '');
      }
      return;
    }

    // v0.41 — read role slugs straight off the column row. Replaces the
    // old `Board.routing_config[col.name.toLowerCase()]` lookup; column
    // name compares are forbidden in the dispatch path.
    const roles = safeJsonParse<string[]>((col as any).role_routing, []);
    if (!Array.isArray(roles) || roles.length === 0) return;

    // Resolve role slugs against the ticket's workspace roles + assignments.
    // Pre-v0.34 this loop indexed `ROLE_TO_FIELD[role]` and read the agent ID
    // off `ticket.assignee_id` / `reporter_id` / `reviewer_id`. Now slugs are
    // workspace-scoped so we look up the WorkspaceRole row, then the
    // TicketRoleAssignment that pins a holder onto this ticket.
    const roleRepo = this.dataSource.getRepository(WorkspaceRole);
    const assignRepo = this.dataSource.getRepository(TicketRoleAssignment);
    for (const slug of roles) {
      const role = await roleRepo.findOne({
        where: { workspace_id: ticket.workspace_id, slug },
      });
      if (!role) continue;
      const assignment = await assignRepo.findOne({
        where: { ticket_id: ticket.id, role_id: role.id },
      });
      const targetAgentId = assignment?.agent_id || null;
      if (!targetAgentId) continue;
      // Self-trigger guard, action-type aware (v0.34 onward):
      //   - comment / ticket_update: same agent_id implies the actor's own
      //     role context — re-firing on the same (ticket, role) would just
      //     wake the same persistent subagent that just produced the event,
      //     which is a deadlock-shaped feedback loop. Skip.
      //   - column_move: the destination column inherently shifts role
      //     responsibility (e.g. Review → Merging changes owner from
      //     reviewer to assignee). With v0.34's per-(ticket, role) plugin
      //     subagents, the same agent_id holding both source and destination
      //     roles still spawns a *separate* subagent for the new role —
      //     there's no LLM-level self-loop to prevent. Pre-v0.34 the guard
      //     was correct because everything ran in one session; now it
      //     silently deadlocks any same-agent-multi-role workflow.
      if (triggerSource !== 'column_move' && targetAgentId === log.actor_id) continue;

      await this._emitTrigger(ticket, targetAgentId, slug, triggerSource, log.actor_id || '');
    }
  }

  /**
   * Hand off from a finished ticket to its `next_ticket_id`: dispatch a
   * `trigger_source: 'next_ticket'` round for the linked ticket's CURRENT
   * column's routing roles. Mirrors the `column_move` loop body — workspace
   * scope, role-slug → WorkspaceRole → TicketRoleAssignment, one emit per
   * unique (slug, holder agent_id) pair.
   *
   * Skip cases (silent — log only):
   *   - linked ticket missing
   *   - linked ticket has no column (child / orphan)
   *   - linked column itself is terminal (would just dead-end)
   *   - linked column has no routing entry
   *   - role unset on the linked ticket (no holder to wake)
   *
   * `actorId` is the original mover so the activity log audit trail still
   * points at the human/agent who closed the source ticket.
   */
  private async _dispatchNextTicket(sourceTicket: Ticket, actorId: string): Promise<void> {
    const nextId = sourceTicket.next_ticket_id;
    if (!nextId) return;

    const ticketRepo = this.dataSource.getRepository(Ticket);
    const nextTicket = await ticketRepo.findOne({ where: { id: nextId } });
    if (!nextTicket) {
      this.logService.info('MCP', 'next_ticket dispatch skipped (linked ticket missing)', {
        source_ticket_id: sourceTicket.id, next_ticket_id: nextId,
      });
      return;
    }
    if (!nextTicket.column_id) {
      this.logService.info('MCP', 'next_ticket dispatch skipped (linked ticket has no column)', {
        source_ticket_id: sourceTicket.id, next_ticket_id: nextId,
      });
      return;
    }

    // v0.41 — resolve the linked ticket's column row by id. Routing reads
    // `BoardColumn.role_routing` directly; no Board.routing_config /
    // lowercased-name lookup is performed.
    const col = await this.dataSource
      .getRepository(BoardColumn)
      .findOne({ where: { id: nextTicket.column_id } });
    if (!col) return;

    const nextIsTerminal = (col as any).is_terminal === true || (col as any).kind === 'terminal';
    if (nextIsTerminal) {
      // The linked ticket already finished — nothing to do.
      this.logService.info('MCP', 'next_ticket dispatch skipped (linked ticket sits on terminal column)', {
        source_ticket_id: sourceTicket.id, next_ticket_id: nextId,
      });
      return;
    }

    const roles = safeJsonParse<string[]>((col as any).role_routing, []);
    if (!Array.isArray(roles) || roles.length === 0) {
      this.logService.info('MCP', 'next_ticket dispatch skipped (no role_routing on linked column)', {
        source_ticket_id: sourceTicket.id, next_ticket_id: nextId, column_id: col.id,
      });
      return;
    }

    // Resolve role slugs against the linked ticket's workspace + assignments.
    // Dedupe per (slug, holder) so a routing config that lists the same slug
    // twice — or two distinct slugs that happen to share a holder agent_id —
    // emits at most once per unique pair. The cap enforcement inside
    // _emitTrigger is on (agent, ticket); the (slug, holder) dedup here is
    // belt-and-suspenders against double-firing the same role wake-up.
    const roleRepo = this.dataSource.getRepository(WorkspaceRole);
    const assignRepo = this.dataSource.getRepository(TicketRoleAssignment);
    const seen = new Set<string>();
    for (const slug of roles) {
      const role = await roleRepo.findOne({
        where: { workspace_id: nextTicket.workspace_id, slug },
      });
      if (!role) continue;
      const assignment = await assignRepo.findOne({
        where: { ticket_id: nextTicket.id, role_id: role.id },
      });
      const targetAgentId = assignment?.agent_id || null;
      if (!targetAgentId) continue;
      const dedupeKey = `${slug}|${targetAgentId}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      // No self-trigger guard here — by definition the actor that closed the
      // source ticket may also hold a role on the next ticket, and we DO
      // want to wake that subagent now (the chain semantics promise it).
      await this._emitTrigger(nextTicket, targetAgentId, slug, 'next_ticket', actorId);
    }
  }

  /**
   * Manually wake an agent on a ticket — bound to the "Trigger" button on the
   * ticket UI and any other deliberate user-initiated kick. Just emits the SSE
   * event; no DB row, no cooldown, no ack. Returns the ephemeral trigger_id.
   */
  async emitManualTrigger(
    ticketId: string,
    targetAgentId: string,
    role: string,
    actor: { id: string; name: string },
  ): Promise<{ trigger_id: string; ticket_id: string; agent_id: string; role: string }> {
    if (!targetAgentId) {
      throw Object.assign(new Error('No target agent (set ticket role agent or pass agent_id)'), { status: 400 });
    }

    const ticket = await this.dataSource.getRepository(Ticket).findOne({ where: { id: ticketId } });
    if (!ticket) {
      throw Object.assign(new Error('Ticket not found'), { status: 404 });
    }

    // Validate the slug against the ticket's workspace roles. Custom slugs
    // are allowed as long as a row exists; an unknown slug is a 400.
    const roleRow = await this.dataSource.getRepository(WorkspaceRole).findOne({
      where: { workspace_id: ticket.workspace_id, slug: role },
    });
    if (!roleRow) {
      throw Object.assign(new Error(`Invalid role: ${role}`), { status: 400 });
    }

    const agent = await this.dataSource.getRepository(Agent).findOne({ where: { id: targetAgentId } });
    if (!agent) {
      throw Object.assign(new Error(`Target agent ${targetAgentId} not found`), { status: 404 });
    }

    // Audit trail — manual triggers are user-initiated so leaving a trace in
    // ActivityLog is worth the single INSERT.
    const activityLogRepo = this.dataSource.getRepository(ActivityLog);
    await activityLogRepo.save(activityLogRepo.create({
      entity_type: 'ticket',
      entity_id: ticketId,
      ticket_id: ticketId,
      actor_id: 'system',
      actor_name: `manual by ${actor.name}`,
      action: 'trigger_dispatched',
      new_value: role,
      role,
      trigger_source: 'manual',
    }));

    const triggerId = await this._emitTrigger(ticket, targetAgentId, role, 'manual', actor.id);
    return { trigger_id: triggerId, ticket_id: ticketId, agent_id: targetAgentId, role };
  }

  /**
   * Public emitter for server-side schedulers (e.g. TicketSupervisorService).
   * Delegates to the private _emitTrigger with the same payload composition
   * (role_prompt / ticket_prompt / column_prompt loaded fresh). Pass
   * `opts.forceRespawn: true` to tell the plugin to kill any live subagent for
   * this ticket before handling — used when a wedged session hasn't advanced
   * my_last_update_at after an initial re-push.
   */
  async emitAgentTrigger(
    ticket: Ticket,
    agentId: string,
    role: string,
    triggerSource: string,
    triggeredBy: string,
    opts?: { forceRespawn?: boolean },
  ): Promise<string> {
    return this._emitTrigger(ticket, agentId, role, triggerSource, triggeredBy, opts);
  }

  /**
   * Compose the trigger payload (role_prompt / ticket_prompt / column_prompt
   * loaded fresh at dispatch time) and emit via activityEvents so the
   * EventsController SSE listener forwards it to connected agents.
   *
   * Fire-and-forget: no DB row, no ack, no retry. TicketSupervisorService
   * re-pushes stale allocations (my_last_update_at older than 30 min) and
   * escalates to force_respawn after the cooldown if silence persists.
   */
  private async _emitTrigger(
    ticket: Ticket,
    agentId: string,
    role: string,
    triggerSource: string,
    triggeredBy: string,
    opts?: { forceRespawn?: boolean },
  ): Promise<string> {
    const now = new Date();

    // Compose role_prompt = workspace role's prompt + agent's own prompt.
    // Both layers loaded fresh here so any edits since last dispatch propagate
    // (Agent.role_prompt or WorkspaceRole.role_prompt). Empty layers are
    // skipped — neither side is a hard requirement. Plugin sees the joined
    // text in the same `role_prompt` field on the wire, so no plugin change
    // is needed for v0.34's prepend semantics.
    const agent = await this.dataSource.getRepository(Agent).findOne({ where: { id: agentId } });
    const workspaceRole = await this.dataSource.getRepository(WorkspaceRole).findOne({
      where: { workspace_id: ticket.workspace_id, slug: role },
    });
    const rolePrompt = [workspaceRole?.role_prompt, agent?.role_prompt]
      .filter((s): s is string => !!s && s.trim().length > 0)
      .join('\n\n');

    // Re-fetch ticket for fresh prompt_text — the one from _handleActivity may be stale
    const freshTicket = await this.dataSource.getRepository(Ticket).findOne({ where: { id: ticket.id } });
    const ticketPrompt = freshTicket?.prompt_text || '';

    // Resolve the ticket's base repository snapshot (if any). Embedded in the
    // SSE payload so agent-manager doesn't need a second round-trip to render
    // the prompt block — name/url/default_branch come along for free. Failing
    // the lookup is non-fatal; the agent prompt just omits the repo line.
    // Workspace-scoped lookup (defense-in-depth — writes are guarded too):
    // a stale id pointing at another workspace's Resource never gets its
    // url/name shipped out to the assignee here.
    const baseRepoId = freshTicket?.base_repo_resource_id || ticket.base_repo_resource_id || '';
    const baseBranch = freshTicket?.base_branch || ticket.base_branch || '';
    const baseRepoWorkspaceId = freshTicket?.workspace_id || ticket.workspace_id || '';
    let baseRepo: { id: string; name: string; url: string; default_branch: string } | null = null;
    if (baseRepoId && baseRepoWorkspaceId) {
      try {
        const r = await this.dataSource.getRepository(Resource).findOne({
          where: { id: baseRepoId, workspace_id: baseRepoWorkspaceId },
        });
        if (r) {
          baseRepo = {
            id: r.id,
            name: r.name,
            url: r.url || '',
            default_branch: r.default_branch || '',
          };
        }
      } catch (e) {
        this.logService.warn('MCP', 'base_repo lookup failed (continuing without)', {
          err: String(e), ticket_id: ticket.id, base_repo_id: baseRepoId,
        });
      }
    }

    // Column workflow prompt: Board.column_prompts[column_id] → PromptTemplate.content
    let columnPrompt: { template_id: string; name: string; content: string } | null = null;
    try {
      const col = await this.dataSource.getRepository(BoardColumn).findOne({ where: { id: ticket.column_id } });
      if (col) {
        const board = await this.dataSource.getRepository(Board).findOne({ where: { id: col.board_id } });
        const raw = board?.column_prompts;
        if (raw) {
          const map = safeJsonParse(raw, {});
          const tplId: string | undefined = map?.[ticket.column_id];
          if (tplId) {
            const tpl = await this.dataSource.getRepository(PromptTemplate).findOne({ where: { id: tplId } });
            if (tpl && tpl.workspace_id === board!.workspace_id) {
              columnPrompt = { template_id: tpl.id, name: tpl.name, content: tpl.content };
            }
          }
        }
      }
    } catch (e) {
      this.logService.warn('MCP', 'column_prompt lookup failed (continuing without)', { err: String(e), ticket_id: ticket.id });
    }

    // Per-board cap: a board may want to keep one agent on at most N tickets
    // at a time (default 1) so concurrent subagents don't stomp on the same
    // working_dir. Look up the limit, count this agent's active tickets
    // (excluding the target — re-firing on a ticket the agent is already
    // working on is allowed; that's just a new turn on the live session),
    // and skip emission when the cap is reached.
    let maxConcurrent = 1;
    try {
      const col = await this.dataSource
        .getRepository(BoardColumn)
        .findOne({ where: { id: ticket.column_id } });
      if (col) {
        const board = await this.dataSource
          .getRepository(Board)
          .findOne({ where: { id: col.board_id } });
        if (board && Number.isFinite(board.max_concurrent_tickets_per_agent)) {
          maxConcurrent = Math.max(1, Math.floor(board.max_concurrent_tickets_per_agent));
        }
      }
    } catch (e) {
      this.logService.warn('MCP', 'board cap lookup failed (defaulting to 1)', {
        err: String(e), ticket_id: ticket.id,
      });
    }

    // Cap check + reservation MUST be atomic relative to other concurrent
    // _emitTrigger calls — i.e. no `await` between reading the in-flight set
    // and adding our entry to it. Activity events arrive via fire-and-forget
    // listeners, so multiple _handleActivity / supervisor pushes can interleave
    // their awaits and reach this point on the same agent simultaneously.
    // Snapshotting active + pending into a Set, deciding, then mutating
    // pending — all synchronous — closes the race window.
    const activeTicketIds = this.agentStatusService.getActiveTicketIds(agentId);
    const pendingTicketIds = this._getPendingTicketIds(agentId);
    const inflightSet = new Set<string>([...activeTicketIds, ...pendingTicketIds]);
    const alreadyOnTarget = inflightSet.has(ticket.id);
    if (!alreadyOnTarget && inflightSet.size >= maxConcurrent) {
      // v0.41 — cap-exceeded triggers are ENQUEUED, not silently dropped.
      // The dispatch queue resorts by priority_index so a high-priority
      // Review column-move that arrives mid-promotion jumps ahead of any
      // medium / low items already pending for this agent.
      this.logService.info(
        'MCP',
        'agent_trigger queued (per-board cap reached)',
        {
          ticket_id: ticket.id,
          agent_id: agentId,
          role,
          source: triggerSource,
          max_concurrent: maxConcurrent,
          active_ticket_ids: activeTicketIds,
          pending_ticket_ids: pendingTicketIds,
        },
      );
      const triggerId = randomUUID();
      const queueItem: QueueItem = {
        ticket_id: ticket.id,
        role,
        agent_id: agentId,
        workspace_id: ticket.workspace_id,
        priority_index: priorityIndex(ticket.priority),
        trigger_id: triggerId,
        trigger_source: triggerSource,
        enqueued_at: Date.now(),
        triggered_by: triggeredBy,
        force_respawn: opts?.forceRespawn === true,
      };
      const { enqueued } = await this.dispatchQueue.enqueue(queueItem);
      // Return the trigger_id either way — callers can correlate it
      // against the dispatched_from_queue / queue_dropped_low_priority
      // activity rows to see what happened.
      return enqueued ? triggerId : '';
    }

    // Reserve synchronously, before emit. A subsequent _emitTrigger that
    // races past the awaits above will see this entry and either find
    // alreadyOnTarget=true (same ticket re-fire is fine) or hit the cap.
    this._addPendingDispatch(agentId, ticket.id);

    // Ephemeral trigger_id — plugin-side dedup key, no server persistence.
    const triggerId = randomUUID();

    const forceRespawn = opts?.forceRespawn === true;

    activityEvents.emit('agent_trigger', {
      trigger_id: triggerId,
      ticket_id: ticket.id,
      agent_id: agentId,
      role,
      trigger_source: triggerSource,
      role_prompt: rolePrompt,
      ticket_prompt: ticketPrompt,
      column_prompt: columnPrompt,
      base_repo: baseRepo,
      base_branch: baseBranch,
      triggered_by: triggeredBy,
      timestamp: now.toISOString(),
      force_respawn: forceRespawn,
      // Manager keeps a defensive cap as a second line of defense in case
      // two triggers race past this server gate (in-memory active_tasks
      // only flips on set_current_task, which lags the trigger by the
      // subagent spawn round-trip).
      max_concurrent_tickets_per_agent: maxConcurrent,
    });

    this.logService.info('MCP', 'agent_trigger emitted (fire-and-forget)', {
      ticket_id: ticket.id, agent_id: agentId, role, source: triggerSource, force_respawn: forceRespawn,
    });

    // v0.41 — observability hook required by ticket 47a90ea3 acceptance #5.
    // Every successful dispatch leaves a `trigger_emitted` ActivityLog row
    // so admins can correlate against `trigger_enqueued` / `dispatched_from_queue`
    // / `queue_dropped_low_priority` and see the full lifecycle of a trigger.
    try {
      const activityLogRepo = this.dataSource.getRepository(ActivityLog);
      await activityLogRepo.save(activityLogRepo.create({
        entity_type: 'ticket',
        entity_id: ticket.id,
        ticket_id: ticket.id,
        actor_id: 'system',
        actor_name: 'TriggerLoopService',
        action: 'trigger_emitted',
        new_value: `agent=${agentId} priority_index=${priorityIndex(ticket.priority)} force_respawn=${forceRespawn}`,
        role,
        trigger_source: triggerSource,
      }));
    } catch (e) {
      // Never block the emit on observability writes. A missed log row
      // is preferable to a missed trigger.
      this.logService.warn('MCP', 'trigger_emitted activity log write failed (non-fatal)', {
        err: String(e), ticket_id: ticket.id, agent_id: agentId,
      });
    }

    return triggerId;
  }

  /**
   * v0.41 — drain the dispatch queue head for the given agent, if any.
   *
   * Wired to the activityEvents `'agent_idle'` signal: AgentStatusService
   * emits 'agent_idle' on every clearCurrentTask / sweep-driven shrink of
   * active_tasks, and we look for a queued trigger for that agent. If the
   * cap is still closed (race against another trigger that reserved the
   * slot first), the dequeued item is requeued at its priority and the
   * next idle signal retries.
   *
   * Re-fetches the ticket / column at dispatch time so a stale queue
   * entry can't ship out a wrong trigger payload — terminal landings
   * cancel the dispatch and drop the item silently. Same for tickets
   * that disappeared (deleted while queued).
   *
   * Concurrency contract — `_tryDispatchFromQueue` may run twice on the
   * same agent simultaneously (clearCurrentTask + sweep stale-task
   * cleanup interleaved, or two clears within the same tick). The previous
   * peek-then-dequeue layout would let one coroutine peek head A, the
   * other dequeue head A, the first dequeue head B, and the first emit
   * with `ticket=A, role=B.role` — a mismatched payload. The fix below
   * dequeues FIRST and re-resolves ticket/col exclusively from the
   * dequeued `item`, so each coroutine dispatches its own item self-
   * consistently or requeues it without ever crossing references.
   */
  private async _tryDispatchFromQueue(agentId: string): Promise<void> {
    if (!agentId) return;
    // Cheap fast-bail without mutating state — dequeueHead is the
    // authoritative gate. peek() never affects ordering, so a concurrent
    // dequeue racing past this check just means we exit early; correct.
    if (!this.dispatchQueue.peek(agentId)) return;

    // Authoritative pop. Every subsequent read uses `item.ticket_id` /
    // `item.role` — never a separate peek snapshot. `item` is now this
    // coroutine's exclusive responsibility: emit it, drop it, or requeue.
    const item = await this.dispatchQueue.dequeueHead(agentId);
    if (!item) return;

    try {
      const ticket = await this.dataSource
        .getRepository(Ticket)
        .findOne({ where: { id: item.ticket_id } });
      if (!ticket || !ticket.column_id) {
        // Ticket vanished or got detached from any column — drop the
        // stale queue entry, don't dispatch and don't requeue.
        this.logService.info('MCP', 'dispatched_from_queue dropped (ticket missing)', {
          agent_id: agentId, ticket_id: item.ticket_id, role: item.role,
        });
        return;
      }
      const col = await this.dataSource
        .getRepository(BoardColumn)
        .findOne({ where: { id: ticket.column_id } });
      if (!col) {
        this.logService.info('MCP', 'dispatched_from_queue dropped (column missing)', {
          agent_id: agentId, ticket_id: item.ticket_id, role: item.role,
        });
        return;
      }
      // Terminal column landed while the trigger was in the queue — the
      // dispatch is no longer meaningful; drop silently. The terminal
      // landing has its own handlers (next_ticket_id chain, completion
      // comment) that don't need this stale entry.
      const isTerminal = (col as any).is_terminal === true || (col as any).kind === 'terminal';
      if (isTerminal) {
        this.logService.info('MCP', 'dispatched_from_queue dropped (terminal landing)', {
          agent_id: agentId, ticket_id: item.ticket_id, role: item.role,
        });
        return;
      }

      // Cap snapshot is taken HERE — right before dispatch — so a
      // concurrent _emitTrigger that reserved a slot between dequeue
      // and emit is observed and we requeue instead of overcommitting.
      const activeTicketIds = this.agentStatusService.getActiveTicketIds(agentId);
      const pendingTicketIds = this._getPendingTicketIds(agentId);
      const inflight = new Set<string>([...activeTicketIds, ...pendingTicketIds]);
      let maxConcurrent = 1;
      const board = await this.dataSource
        .getRepository(Board)
        .findOne({ where: { id: col.board_id } });
      if (board && Number.isFinite(board.max_concurrent_tickets_per_agent)) {
        maxConcurrent = Math.max(1, Math.floor(board.max_concurrent_tickets_per_agent));
      }
      if (!inflight.has(item.ticket_id) && inflight.size >= maxConcurrent) {
        // Cap closed mid-dispatch — put the item back at its priority
        // (no fresh `trigger_enqueued` row; the original is still on
        // record from the cap-skip emit). The next agent_idle signal
        // will retry.
        this.dispatchQueue.requeueAtPriority(item);
        this.logService.info('MCP', 'dispatch-from-queue requeued (cap closed mid-dispatch)', {
          agent_id: agentId, ticket_id: item.ticket_id, role: item.role,
          inflight_count: inflight.size, max_concurrent: maxConcurrent,
        });
        return;
      }

      await this._emitTrigger(
        ticket,
        item.agent_id,
        item.role,
        item.trigger_source,
        item.triggered_by,
        { forceRespawn: item.force_respawn === true },
      );
    } catch (e) {
      this.logService.error('MCP', 'TriggerLoop dispatch-from-queue failed', {
        err: String(e), agent_id: agentId, item_ticket_id: item.ticket_id, item_role: item.role,
      });
      // Don't requeue on exception — exceptions usually indicate a
      // persistent fault (DB unreachable, schema drift, etc.) that
      // would just loop forever. The supervisor stale-allocation
      // re-push is the eventual-consistency backstop.
    }
  }

  /**
   * Snapshot of pending dispatches for an agent, after TTL eviction.
   * Synchronous — counterpart to AgentStatusService.getActiveTicketIds in
   * the cap calculation. Side-effect: prunes expired entries on read so the
   * map stays bounded.
   */
  private _getPendingTicketIds(agentId: string): string[] {
    const map = this.pendingDispatches.get(agentId);
    if (!map || map.size === 0) return [];
    const cutoff = Date.now() - PENDING_DISPATCH_TTL_MS;
    const out: string[] = [];
    const expired: string[] = [];
    for (const [tid, ts] of map) {
      if (ts >= cutoff) out.push(tid);
      else expired.push(tid);
    }
    for (const tid of expired) map.delete(tid);
    if (map.size === 0) this.pendingDispatches.delete(agentId);
    return out;
  }

  /**
   * Reserve a pending slot for (agent, ticket). Refreshes the timestamp on
   * re-fires so the TTL window resets while triggers keep arriving.
   */
  private _addPendingDispatch(agentId: string, ticketId: string): void {
    let map = this.pendingDispatches.get(agentId);
    if (!map) {
      map = new Map<string, number>();
      this.pendingDispatches.set(agentId, map);
    }
    map.set(ticketId, Date.now());
  }
}

function safeJsonParse<T = any>(val: string | null | undefined, fallback: T): T {
  try { return JSON.parse(val || JSON.stringify(fallback)) as T; }
  catch { return fallback; }
}
