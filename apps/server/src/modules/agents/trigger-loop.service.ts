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
import { LogService } from '../../services/log.service';
import { activityEvents } from '../../services/activity.service';

// v0.25.0: pure SSE emitter. The AgentTrigger DB table has been removed —
// delivery is fire-and-forget; the plugin's 5-minute allocated-ticket poll
// reconciles any missed events. No cooldown (the plugin dedupes in-session
// by trigger_id), no TTL sweep (no persistence), no manual trigger path.
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

const ROLE_TO_FIELD: Record<string, keyof Pick<Ticket, 'assignee_id' | 'reporter_id' | 'reviewer_id'>> = {
  assignee: 'assignee_id',
  reporter: 'reporter_id',
  reviewer: 'reviewer_id',
};

@Injectable()
export class TriggerLoopService implements OnModuleInit {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly logService: LogService,
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

    for (const role of roles) {
      const roleField = ROLE_TO_FIELD[role];
      if (!roleField) continue;
      const targetAgentId = ticket[roleField];
      if (!targetAgentId) continue;
      // Don't trigger the actor on their own actions
      if (targetAgentId === log.actor_id) continue;

      await this._emitTrigger(ticket, targetAgentId, role, triggerSource, log.actor_id || '');
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
    if (!ROLE_TO_FIELD[role]) {
      throw Object.assign(new Error(`Invalid role: ${role}`), { status: 400 });
    }
    if (!targetAgentId) {
      throw Object.assign(new Error('No target agent (set ticket role agent or pass agent_id)'), { status: 400 });
    }

    const ticket = await this.dataSource.getRepository(Ticket).findOne({ where: { id: ticketId } });
    if (!ticket) {
      throw Object.assign(new Error('Ticket not found'), { status: 404 });
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
   * Compose the trigger payload (role_prompt / ticket_prompt / column_prompt
   * loaded fresh at dispatch time) and emit via activityEvents so the
   * EventsController SSE listener forwards it to connected agents.
   *
   * Fire-and-forget: no DB row, no ack, no retry. The plugin's 5-minute
   * allocated-ticket poll is the backstop for dropped SSE deliveries.
   */
  private async _emitTrigger(
    ticket: Ticket,
    agentId: string,
    role: string,
    triggerSource: string,
    triggeredBy: string,
  ): Promise<string> {
    const now = new Date();

    // Load role_prompt fresh (agent.role_prompt may have been edited since last dispatch)
    const agent = await this.dataSource.getRepository(Agent).findOne({ where: { id: agentId } });
    const rolePrompt = agent?.role_prompt || '';

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

    // Ephemeral trigger_id — plugin-side dedup key, no server persistence.
    const triggerId = randomUUID();

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
    });

    this.logService.info('MCP', 'agent_trigger emitted (fire-and-forget)', {
      ticket_id: ticket.id, agent_id: agentId, role, source: triggerSource,
    });

    return triggerId;
  }
}

function safeJsonParse(val: string | null | undefined, fallback: any): any {
  try { return JSON.parse(val || JSON.stringify(fallback)); }
  catch { return fallback; }
}
