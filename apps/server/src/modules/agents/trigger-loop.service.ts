import { Injectable, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { InjectDataSource } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { AgentTrigger } from '../../entities/AgentTrigger';
import { ActivityLog } from '../../entities/ActivityLog';
import { Ticket } from '../../entities/Ticket';
import { BoardColumn } from '../../entities/BoardColumn';
import { Board } from '../../entities/Board';
import { Agent } from '../../entities/Agent';
import { PromptTemplate } from '../../entities/PromptTemplate';
import { LogService } from '../../services/log.service';
import { activityEvents } from '../../services/activity.service';

const COOLDOWN_MS = 60_000;
const TRIGGER_TTL_MS = 24 * 60 * 60 * 1000;
const SWEEP_INTERVAL_MS = 5 * 60 * 1000;

const ROLE_TO_FIELD: Record<string, keyof Pick<Ticket, 'assignee_id' | 'reporter_id' | 'reviewer_id'>> = {
  assignee: 'assignee_id',
  reporter: 'reporter_id',
  reviewer: 'reviewer_id',
};

// For comment-created events, entity_type is 'comment' with action 'created'
const COMMENT_ACTION = 'created';
const COMMENT_ENTITY = 'comment';

// Routing decisions are driven entirely by Board.routing_config — an explicit
// per-board JSON map of { columnName(lowercased) -> role[] }. There is no
// fallback for "conventional" column names: a board that hasn't configured
// routing for a column produces zero triggers for activity in that column.
// This is intentional. Hardcoded English/Korean column-name defaults silently
// activated routing on boards whose owners had never opted in, and broke when
// users renamed columns. Boards that want triggers MUST set routing_config.

@Injectable()
export class TriggerLoopService implements OnModuleInit {
  constructor(
    @InjectRepository(AgentTrigger) private readonly triggerRepo: Repository<AgentTrigger>,
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly logService: LogService,
  ) {}

  onModuleInit() {
    activityEvents.on('activity', (log: ActivityLog) => {
      this._handleActivity(log).catch((e: unknown) => {
        this.logService.error('MCP', 'TriggerLoop error in _handleActivity', { err: e });
      });
    });

    setInterval(async () => {
      const count = await this._sweepExpiredTriggers();
      if (count > 0) {
        this.logService.info('MCP', `Swept ${count} expired trigger(s)`);
      }
    }, SWEEP_INTERVAL_MS);
  }

  /**
   * Handle activity events that should produce triggers.
   * - 'moved': ticket moved to a new column
   * - 'created' with entity_type 'comment': new comment on a ticket
   * - 'updated': ticket field changed
   *
   * All resolve the ticket's current column, look up routing_config for that column,
   * and create triggers for each configured role's agent.
   */
  private async _handleActivity(log: ActivityLog): Promise<void> {
    if (!log.ticket_id) return;

    // Determine trigger source
    let triggerSource: string;
    if (log.action === 'moved') {
      triggerSource = 'column_move';
    } else if (log.entity_type === COMMENT_ENTITY && log.action === COMMENT_ACTION) {
      triggerSource = 'comment';
    } else if (log.action === 'updated') {
      triggerSource = 'ticket_update';
    } else {
      return; // not a triggerable action
    }

    // Skip system-generated activity (e.g. trigger_dispatched) to prevent loops
    if (log.actor_id === 'system') return;

    // Resolve the ticket and its current column
    const ticketRepo = this.dataSource.getRepository(Ticket);
    const ticket = await ticketRepo.findOne({ where: { id: log.ticket_id } });
    if (!ticket) return;

    // For 'moved' events, the destination column name is in new_value.
    // For comment/update events, resolve from ticket's current column_id.
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

    // Resolve routing_config from the board. SQLite doesn't understand the
    // board-scoped subquery cleanly in all cases, so we split: (1) look up the
    // column that matches the lowercased name in the ticket's own board, and
    // (2) fall back to any board that has a column by that name if the ticket
    // has no current column (rare — happens on orphan subtasks). Either way
    // we end up with the routing_config JSON string (or null).
    const colRepo = this.dataSource.getRepository(BoardColumn);
    const colRow = await colRepo
      .createQueryBuilder('col')
      .innerJoin('boards', 'b', 'b.id = col.board_id')
      .addSelect('b.routing_config', 'routing_config')
      .where('LOWER(col.name) = LOWER(:name)', { name: columnName })
      .andWhere('col.board_id IN (SELECT bc.board_id FROM columns bc WHERE bc.id = :colId)', { colId: ticket.column_id || '' })
      .getRawOne();

    let routingConfigStr: string | null = colRow?.routing_config ?? null;
    if (!routingConfigStr && log.action === 'moved') {
      const fallback = await colRepo
        .createQueryBuilder('col')
        .innerJoin('boards', 'b', 'b.id = col.board_id')
        .addSelect('b.routing_config', 'routing_config')
        .where('LOWER(col.name) = LOWER(:name)', { name: columnName })
        .getRawOne();
      routingConfigStr = fallback?.routing_config ?? null;
    }

    // routing_config JSON is keyed by lowercase column name. Absent key OR
    // explicit empty array = no triggers for this column. There is no
    // fallback — the board's config is the single source of truth.
    const routingConfig = safeJsonParse(routingConfigStr, {}) as Record<string, string | string[]>;
    if (!routingConfig || !Object.prototype.hasOwnProperty.call(routingConfig, columnName)) {
      return;
    }
    const rolesRaw = routingConfig[columnName];
    // Normalize to array (backward compat: old format was single string)
    const roles: string[] = Array.isArray(rolesRaw) ? rolesRaw : [rolesRaw];
    if (roles.length === 0) return;

    // Create triggers for each role
    for (const role of roles) {
      const roleField = ROLE_TO_FIELD[role];
      if (!roleField) continue;

      const targetAgentId = ticket[roleField];
      if (!targetAgentId) continue;

      // Don't trigger the actor on their own actions
      if (targetAgentId === log.actor_id) continue;

      await this._createTrigger(ticket, targetAgentId, role, triggerSource, log);
    }
  }

  /**
   * Manually (re-)trigger an agent on a ticket. Bypasses cooldown — the whole
   * point of the feature is letting a human punt the reviewer when the auto
   * trigger fired but the agent didn't respond, or to re-engage an agent on a
   * stale ticket. Still writes a fresh cooldown_until for spam protection on
   * future auto-triggers, and records trigger_source='manual' + the actor on
   * the ActivityLog so audit trails show who kicked it.
   */
  async createManualTrigger(
    ticketId: string,
    targetAgentId: string,
    role: string,
    actor: { id: string; name: string },
  ): Promise<AgentTrigger> {
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

    const agentRepo = this.dataSource.getRepository(Agent);
    const agent = await agentRepo.findOne({ where: { id: targetAgentId } });
    if (!agent) {
      throw Object.assign(new Error(`Target agent ${targetAgentId} not found`), { status: 404 });
    }

    return this._createTriggerCore({
      ticket,
      agentId: targetAgentId,
      role,
      triggerSource: 'manual',
      triggeredBy: actor.id,
      actorName: `manual by ${actor.name}`,
      skipCooldown: true,
    });
  }

  private async _createTrigger(
    ticket: Ticket, agentId: string, role: string,
    triggerSource: string, log: ActivityLog,
  ): Promise<void> {
    await this._createTriggerCore({
      ticket,
      agentId,
      role,
      triggerSource,
      triggeredBy: log.actor_id || '',
      actorName: 'TriggerLoop',
      skipCooldown: false,
    });
  }

  /**
   * Internal core shared by both auto (_createTrigger) and manual
   * (createManualTrigger) paths. Handles cooldown, DB insert, activity log,
   * prompt resolution (role_prompt, ticket_prompt, column_prompt), and SSE
   * emission. Returns the persisted trigger, or null when cooldown suppressed.
   */
  private async _createTriggerCore(opts: {
    ticket: Ticket;
    agentId: string;
    role: string;
    triggerSource: string;
    triggeredBy: string;
    actorName: string;
    skipCooldown: boolean;
  }): Promise<AgentTrigger> {
    const { ticket, agentId, role, triggerSource, triggeredBy, actorName, skipCooldown } = opts;

    // Cooldown check — skipped for manual triggers (explicit user intent).
    if (!skipCooldown) {
      const existing = await this.triggerRepo.findOne({
        where: { ticket_id: ticket.id, agent_id: agentId },
        order: { created_at: 'DESC' },
      });
      const existingNow = new Date();
      if (existing?.cooldown_until && existing.cooldown_until > existingNow) {
        this.logService.info('MCP', 'Trigger suppressed (cooldown)', {
          ticket_id: ticket.id, agent_id: agentId, role,
        });
        // Return the existing trigger so callers have a handle; downstream
        // tolerates the "not pushed" case by checking id equality if needed.
        return existing;
      }
    }

    const now = new Date();

    const trigger = await this.triggerRepo.save(
      this.triggerRepo.create({
        ticket_id: ticket.id,
        role,
        agent_id: agentId,
        triggered_by: triggeredBy,
        expires_at: new Date(now.getTime() + TRIGGER_TTL_MS),
        acknowledged_at: null,
        cooldown_until: new Date(now.getTime() + COOLDOWN_MS),
      }),
    );

    // Activity log
    const activityLogRepo = this.dataSource.getRepository(ActivityLog);
    await activityLogRepo.save(activityLogRepo.create({
      entity_type: 'ticket',
      entity_id: ticket.id,
      ticket_id: ticket.id,
      actor_id: 'system',
      actor_name: actorName,
      action: 'trigger_dispatched',
      new_value: role,
      role,
      trigger_source: triggerSource,
    }));

    // D-20: load role_prompt from the agent and prompt_text from the ticket so the SSE
    // envelope (and therefore proxy.mjs → Claude channel) can carry both on every trigger.
    // These are loaded fresh at dispatch time so any edits to either since the last trigger
    // take effect on the next emission.
    const agentRepo = this.dataSource.getRepository(Agent);
    const agent = await agentRepo.findOne({ where: { id: agentId } });
    const rolePrompt = agent?.role_prompt || '';

    // ticket is already loaded by _handleActivity but may be stale wrt prompt_text edits —
    // re-fetch to be safe, same pattern as agent above.
    const freshTicket = await this.dataSource.getRepository(Ticket).findOne({ where: { id: ticket.id } });
    const ticketPrompt = freshTicket?.prompt_text || '';

    // Column workflow prompt: look up Board.column_prompts[ticket.column_id] → PromptTemplate.
    // Fails open (null column_prompt) on any miss — never blocks a trigger.
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
            // Cross-workspace safety: PromptTemplate.workspace_id must match Board.workspace_id.
            if (tpl && tpl.workspace_id === board!.workspace_id) {
              columnPrompt = { template_id: tpl.id, name: tpl.name, content: tpl.content };
            }
          }
        }
      }
    } catch (e) {
      this.logService.warn('MCP', 'column_prompt lookup failed (continuing without)', { err: String(e), ticket_id: ticket.id });
    }

    // SSE push
    activityEvents.emit('agent_trigger', {
      trigger_id: trigger.id,
      ticket_id: ticket.id,
      agent_id: agentId,
      role,
      trigger_source: triggerSource,
      role_prompt: rolePrompt,        // D-20
      ticket_prompt: ticketPrompt,    // D-20
      column_prompt: columnPrompt,    // phase12: board column → prompt-template content
      timestamp: now.toISOString(),
    });

    this.logService.info('MCP', 'AgentTrigger created + pushed', {
      ticket_id: ticket.id, agent_id: agentId, role, source: triggerSource,
    });

    return trigger;
  }

  private async _sweepExpiredTriggers(): Promise<number> {
    const now = new Date();
    const result = await this.triggerRepo
      .createQueryBuilder()
      .delete()
      .where('expires_at IS NOT NULL AND expires_at < :now', { now })
      .execute();
    return result.affected ?? 0;
  }
}

function safeJsonParse(val: string | null | undefined, fallback: any): any {
  try { return JSON.parse(val || JSON.stringify(fallback)); }
  catch { return fallback; }
}
