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
import { WorkspaceRole } from '../../entities/WorkspaceRole';
import { TicketRoleAssignment } from '../../entities/TicketRoleAssignment';
import { LogService } from '../../services/log.service';
import { activityEvents } from '../../services/activity.service';
import { AgentStatusService } from './agent-status.service';

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

@Injectable()
export class TriggerLoopService implements OnModuleInit {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly logService: LogService,
    private readonly agentStatusService: AgentStatusService,
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

    // Resolve the column name:
    //   'moved': destination column is in new_value
    //   other:   ticket's current column
    let columnName: string;
    if (log.action === 'moved' && log.new_value) {
      columnName = log.new_value.toLowerCase();
    } else if (ticket.column_id) {
      const col = await this.dataSource.getRepository(BoardColumn).findOne({ where: { id: ticket.column_id } });
      if (!col) return;
      columnName = col.name.toLowerCase();
    } else {
      return;
    }

    // Resolve routing_config from the ticket's board. Split query to keep SQLite happy.
    const colRepo = this.dataSource.getRepository(BoardColumn);
    const colRow = await colRepo
      .createQueryBuilder('col')
      .innerJoin('boards', 'b', 'b.id = col.board_id')
      .addSelect('b.routing_config', 'routing_config')
      .addSelect('col.is_terminal', 'is_terminal')
      .where('LOWER(col.name) = LOWER(:name)', { name: columnName })
      .andWhere('col.board_id IN (SELECT bc.board_id FROM columns bc WHERE bc.id = :colId)', { colId: ticket.column_id || '' })
      .getRawOne();

    let routingConfigStr: string | null = colRow?.routing_config ?? null;
    let isTerminal: boolean = !!colRow?.is_terminal;
    if (!routingConfigStr && log.action === 'moved') {
      const fallback = await colRepo
        .createQueryBuilder('col')
        .innerJoin('boards', 'b', 'b.id = col.board_id')
        .addSelect('b.routing_config', 'routing_config')
        .addSelect('col.is_terminal', 'is_terminal')
        .where('LOWER(col.name) = LOWER(:name)', { name: columnName })
        .getRawOne();
      routingConfigStr = fallback?.routing_config ?? null;
      isTerminal = !!fallback?.is_terminal;
    }

    // Terminal columns never trigger. Completion is the terminal column's job.
    if (isTerminal) return;

    const routingConfig = safeJsonParse(routingConfigStr, {}) as Record<string, string | string[]>;
    if (!routingConfig || !Object.prototype.hasOwnProperty.call(routingConfig, columnName)) {
      return;
    }
    const rolesRaw = routingConfig[columnName];
    const roles: string[] = Array.isArray(rolesRaw) ? rolesRaw : [rolesRaw];
    if (roles.length === 0) return;

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

    const activeTicketIds = this.agentStatusService.getActiveTicketIds(agentId);
    const alreadyOnTarget = activeTicketIds.includes(ticket.id);
    if (!alreadyOnTarget && activeTicketIds.length >= maxConcurrent) {
      this.logService.info(
        'MCP',
        'agent_trigger skipped (per-board cap reached)',
        {
          ticket_id: ticket.id,
          agent_id: agentId,
          role,
          source: triggerSource,
          max_concurrent: maxConcurrent,
          active_ticket_ids: activeTicketIds,
        },
      );
      // Activity-log the skip so admins can see what was queued/dropped.
      // Mirrors the manual-trigger audit row shape; trigger_source carries
      // the original source so post-mortems aren't blind.
      const activityLogRepo = this.dataSource.getRepository(ActivityLog);
      await activityLogRepo.save(
        activityLogRepo.create({
          entity_type: 'ticket',
          entity_id: ticket.id,
          ticket_id: ticket.id,
          actor_id: 'system',
          actor_name: 'TriggerLoopService',
          action: 'trigger_skipped_cap',
          new_value: `agent=${agentId} max=${maxConcurrent} active=${activeTicketIds.length}`,
          role,
          trigger_source: triggerSource,
        }),
      );
      return '';
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

    return triggerId;
  }
}

function safeJsonParse(val: string | null | undefined, fallback: any): any {
  try { return JSON.parse(val || JSON.stringify(fallback)); }
  catch { return fallback; }
}
