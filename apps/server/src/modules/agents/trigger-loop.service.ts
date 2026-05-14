import { Injectable, OnModuleInit } from '@nestjs/common';
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
import { AgentWorkloadService } from './agent-workload.service';
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
// one agent_trigger per (role, role-holding agent_id) pair — but ONLY if
// the (agent, board, role) focus selector picks THIS ticket. Non-focus
// triggers are silently dropped (no DB row, no SSE emit) so a board with
// N parked tickets doesn't thrash the agent.
//
// Focus gate (ticket 4a6cdfd7):
//   - `AgentWorkloadService.getFocusTicket(agent, board, role)` returns
//     the single ticket id that the agent should be working on for this
//     (board, role) right now. Trigger emits iff the candidate ticket is
//     that focus ticket.
//   - Manual triggers (`emitManualTrigger`) explicitly opt out of the
//     gate via `opts.bypassFocus = true` — they're deliberate user
//     overrides and the audit trail already records the human / agent
//     actor on the `trigger_dispatched` row.

const COMMENT_ACTION = 'created';
const COMMENT_ENTITY = 'comment';

@Injectable()
export class TriggerLoopService implements OnModuleInit {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly logService: LogService,
    private readonly agentWorkload: AgentWorkloadService,
  ) {}

  onModuleInit() {
    activityEvents.on('activity', (log: ActivityLog) => {
      this._handleActivity(log).catch((e: unknown) => {
        this.logService.error('MCP', 'TriggerLoop error in _handleActivity', { err: e });
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
      // Self-trigger guard, action-type aware (v0.34 onward, refined v0.41):
      //
      //   - comment / ticket_update: same agent_id implies the actor's own
      //     role context — re-firing on the same (ticket, role) would just
      //     wake the same persistent subagent that just produced the event,
      //     which is a deadlock-shaped feedback loop. Always skip.
      //
      //   - column_move: the destination column may shift role responsibility
      //     (e.g. Review → Merging changes owner from reviewer → assignee).
      //     With v0.34's per-(ticket, role) plugin subagents, a SAME-agent
      //     DIFFERENT-role transition spawns a separate subagent for the new
      //     role — there's no LLM-level loop to prevent and dropping the
      //     trigger would silently deadlock single-agent multi-role workflows
      //     (a single AWB agent holding assignee+reviewer+merger on the same
      //     ticket is the production default).
      //
      //     But a SAME-agent SAME-role transition (e.g. assignee moves their
      //     own ticket To Do → In Progress, both columns route to assignee)
      //     IS a self-loop: the actor just performed the move that would
      //     have triggered them, and re-emitting just spawns a redundant
      //     subagent. Pre-v0.41 (and the bypass that lived here from v0.34
      //     onward) the column_move case was unguarded entirely — it
      //     happened to be safe in production only because fixtures /
      //     prod tickets typically had no TicketRoleAssignment row, so
      //     `targetAgentId` was null and the loop short-circuited above.
      //     Once role assignments are reliably seeded the bypass becomes
      //     a live self-loop, exercised by self-trigger-guard.test.mjs.
      //
      //     Discriminator: the actor is in role-shift (don't skip) iff the
      //     actor holds at least one role on THIS ticket that is NOT the
      //     target role. Otherwise the actor's only role is the target
      //     role, the move is a same-role self-action, and we skip.
      if (targetAgentId === log.actor_id) {
        if (triggerSource !== 'column_move') continue;
        const actorAssignments = await assignRepo.find({
          where: { ticket_id: ticket.id, agent_id: log.actor_id || '' },
        });
        const hasOtherRole = actorAssignments.some(
          (a) => a.role_id && a.role_id !== role.id,
        );
        if (!hasOtherRole) continue;
      }

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
    // emits at most once per unique pair. The focus selector inside
    // _emitTrigger gates whether the emit actually lands.
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
   * event; no DB row beyond the explicit `trigger_dispatched` audit, no
   * cooldown, no ack. Returns the ephemeral trigger_id.
   *
   * Manual triggers BYPASS the focus selector gate (opts.bypassFocus = true).
   * The button is a deliberate user override — clicking it on five
   * different tickets is a documented way to wake five separate subagents.
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

    const triggerId = await this._emitTrigger(
      ticket, targetAgentId, role, 'manual', actor.id, { bypassFocus: true },
    );
    return { trigger_id: triggerId, ticket_id: ticketId, agent_id: targetAgentId, role };
  }

  /**
   * Public emitter for server-side schedulers (e.g. TicketSupervisorService).
   * Delegates to the private _emitTrigger with the same payload composition
   * (role_prompt / ticket_prompt / column_prompt loaded fresh). Pass
   * `opts.forceRespawn: true` to tell the plugin to kill any live subagent for
   * this ticket before handling — used when a wedged session hasn't advanced
   * my_last_update_at after an initial re-push.
   *
   * Note: supervisor / backlog-promotion / activity-driven emits ALL pass
   * through the focus selector gate inside `_emitTrigger`. Only
   * `emitManualTrigger` bypasses it. This is intentional: even a
   * supervisor 30-min stale re-push for a non-focus ticket should stay
   * silent — the focus ticket is what wakes the agent each cycle.
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
   * Focus selector gate (ticket 4a6cdfd7):
   *   Unless `opts.bypassFocus` is true, the emit only lands if the
   *   focus selector picks THIS ticket as the agent's focus for
   *   (board, role). Otherwise the call returns '' and writes no
   *   DB rows — non-focus triggers are silent (AC #8).
   *
   * Fire-and-forget after the gate: no DB row, no ack, no retry.
   * TicketSupervisorService re-pushes stale allocations
   * (my_last_update_at older than 30 min) and escalates to
   * force_respawn after the cooldown if silence persists.
   */
  private async _emitTrigger(
    ticket: Ticket,
    agentId: string,
    role: string,
    triggerSource: string,
    triggeredBy: string,
    opts?: { forceRespawn?: boolean; bypassFocus?: boolean },
  ): Promise<string> {
    const now = new Date();

    // Resolve the ticket's column ONCE up front — needed for board_id
    // (focus selector), the audit-row ranking summary, and any
    // downstream lookup. Cheap, single repo hit, avoids the three
    // separate findOne calls the pre-fix code did.
    const col = ticket.column_id
      ? await this.dataSource.getRepository(BoardColumn).findOne({ where: { id: ticket.column_id } })
      : null;
    const boardId = col?.board_id ?? '';

    // Board pause gate. _emitTrigger is the SINGLE chokepoint every dispatch
    // path funnels through (activity-driven column_move / comment /
    // ticket_update, supervisor stale-re-push, backlog_promotion, and even
    // emitManualTrigger which bypasses the focus gate but not this one). So
    // a non-null Board.paused_at here drops the trigger regardless of source.
    //
    // Drop semantics mirror the focus-selector drop: silent on the wire (no
    // SSE emit), one info-level log line, and an ActivityLog row so an
    // operator can grep "why did my agent never wake up" → "board paused".
    // The audit row uses action='agent_trigger_dropped_board_paused' to
    // distinguish it from the focus-selector silent drop (which logs only).
    if (boardId) {
      const board = await this.dataSource.getRepository(Board).findOne({ where: { id: boardId } });
      if (board?.paused_at) {
        this.logService.info('MCP', 'agent_trigger dropped (board paused)', {
          ticket_id: ticket.id, agent_id: agentId, role,
          source: triggerSource, board_id: boardId,
          paused_at: new Date(board.paused_at).toISOString(),
        });
        try {
          const activityLogRepo = this.dataSource.getRepository(ActivityLog);
          await activityLogRepo.save(activityLogRepo.create({
            entity_type: 'ticket',
            entity_id: ticket.id,
            ticket_id: ticket.id,
            actor_id: 'system',
            actor_name: 'TriggerLoopService',
            action: 'agent_trigger_dropped_board_paused',
            new_value: `agent=${agentId} board=${boardId} paused_at=${new Date(board.paused_at).toISOString()}`,
            role,
            trigger_source: triggerSource,
          }));
        } catch (e) {
          // Audit failure must not gate the drop itself — pause is already
          // in effect, the missed row is the only collateral.
          this.logService.warn('MCP', 'paused-drop audit write failed (drop still applied)', {
            err: String(e), ticket_id: ticket.id, board_id: boardId,
          });
        }
        return '';
      }
    }

    // Focus selector gate. The selector returns the single ticket id
    // this agent should be working on for (board, role) right now —
    // ranked by column.position DESC, is_chain_target ASC, priority
    // ASC, created_at ASC. Manual triggers bypass via opts.bypassFocus.
    //
    // Drops are SILENT: no SSE emit, no DB row, no audit. Per AC #8 of
    // ticket 4a6cdfd7 we want zero queue churn on drops. The selector
    // result is logged at info level so an operator running the server
    // log tail can still see why a particular emit dropped.
    if (!opts?.bypassFocus && boardId) {
      const focusTicketId = await this.agentWorkload.getFocusTicket(agentId, boardId, role);
      if (focusTicketId !== ticket.id) {
        this.logService.info('MCP', 'agent_trigger dropped (not focus)', {
          ticket_id: ticket.id, agent_id: agentId, role,
          source: triggerSource, focus_ticket_id: focusTicketId,
        });
        return '';
      }
    }

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

    // Manager-side defensive cap hint, kept on the wire for backward
    // compat with plugin / agent-manager versions that read this field
    // as a second line of defense. Server-side enforcement is now the
    // focus selector above, NOT this cap. After plugin / manager bumps
    // can drop the field, this `findOne` goes too.
    let maxConcurrent = 1;
    if (boardId) {
      try {
        const board = await this.dataSource
          .getRepository(Board)
          .findOne({ where: { id: boardId } });
        if (board && Number.isFinite(board.max_concurrent_tickets_per_agent)) {
          maxConcurrent = Math.max(1, Math.floor(board.max_concurrent_tickets_per_agent));
        }
      } catch (e) {
        this.logService.warn('MCP', 'board cap lookup failed (defaulting to 1)', {
          err: String(e), ticket_id: ticket.id,
        });
      }
    }

    // Chain-target flag for the audit row — one IN query scoped to this
    // single ticket id. Trivial cost; surfaces the selector's ranking
    // input on every emit so post-mortems can reconstruct "why did the
    // selector pick this?" from ActivityLog alone (AC #8).
    let chainTarget = false;
    try {
      const parents = await this.dataSource
        .getRepository(Ticket)
        .createQueryBuilder('t')
        .where('t.next_ticket_id = :id', { id: ticket.id })
        .limit(1)
        .getMany();
      chainTarget = parents.length > 0;
    } catch (e) {
      this.logService.warn('MCP', 'chain_target lookup failed (audit row will say false)', {
        err: String(e), ticket_id: ticket.id,
      });
    }

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
      // Manager-side legacy hint — read above as a defensive cap for
      // plugin / agent-manager versions that haven't been bumped past
      // the focus-selector cutover. Server-side dispatch is gated by
      // the focus selector, not this field.
      max_concurrent_tickets_per_agent: maxConcurrent,
    });

    this.logService.info('MCP', 'agent_trigger emitted (fire-and-forget)', {
      ticket_id: ticket.id, agent_id: agentId, role, source: triggerSource, force_respawn: forceRespawn,
    });

    // Observability hook required by ticket 4a6cdfd7 acceptance #8.
    // Every successful dispatch leaves a `trigger_emitted` ActivityLog
    // row with the selector ranking inputs in `new_value` so admins
    // can correlate the chosen-focus decision against the parked tickets.
    try {
      const activityLogRepo = this.dataSource.getRepository(ActivityLog);
      const createdAtIso = ticket.created_at
        ? new Date(ticket.created_at).toISOString()
        : '';
      await activityLogRepo.save(activityLogRepo.create({
        entity_type: 'ticket',
        entity_id: ticket.id,
        ticket_id: ticket.id,
        actor_id: 'system',
        actor_name: 'TriggerLoopService',
        action: 'trigger_emitted',
        new_value:
          `agent=${agentId} ` +
          `column_position=${col?.position ?? -1} ` +
          `chain_target=${chainTarget} ` +
          `priority_index=${priorityIndex(ticket.priority)} ` +
          `created_at=${createdAtIso} ` +
          `force_respawn=${forceRespawn}`,
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
}

function safeJsonParse<T = any>(val: string | null | undefined, fallback: T): T {
  try { return JSON.parse(val || JSON.stringify(fallback)) as T; }
  catch { return fallback; }
}
