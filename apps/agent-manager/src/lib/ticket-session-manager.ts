// Ticket Session Manager — keeps one CLI child alive per (ticket, role)
// so successive events reuse the same KV cache and context. Per-role keying
// keeps assignee / reviewer / reporter scopes from bleeding into one another.

import {
  BaseSessionManager,
  type SessionAwareConfig,
  type SessionRecord,
} from './base-session-manager.js';
import { composeTriggerPrompt } from './prompts.js';
import { fireAndForgetTool } from './mcp-client.js';
import { log } from './logging.js';
import type {
  TicketDispatchResult,
  TicketSessionManager as TicketSessionManagerContract,
  TicketTriggerArgs,
} from './event-dispatcher.js';

export class TicketSessionManager
  extends BaseSessionManager
  implements TicketSessionManagerContract
{
  constructor(config: SessionAwareConfig) {
    super(config, {
      keyField: 'sessionKey',
      logTag: '[ticket-session]',
      cfgPrefix: 'cfg-ticket-',
      kindLabel: 'ticket_session',
    });
  }

  #makeKey(ticketId: string, role: string): string {
    return `${ticketId}:${role || '_'}`;
  }

  async dispatchTrigger(spec: TicketTriggerArgs): Promise<TicketDispatchResult> {
    if (!spec.ticketId) return { dispatched: false, reason: 'no_ticket' };
    const role = spec.role || '';
    const sessionKey = this.#makeKey(spec.ticketId, role);

    const dedupKey = spec.triggerId ? `trigger:${spec.triggerId}` : null;
    if (dedupKey && !this._rememberDedup(dedupKey)) {
      return { dispatched: false, reason: 'duplicate_trigger' };
    }

    // Defensive per-agent cap. The server's TriggerLoopService already
    // enforces this against AgentStatusService.active_tasks, but
    // set_current_task lags the trigger by the spawn round-trip — two
    // back-to-back triggers can both pass the server gate before either
    // has stamped current_task. Mirror the cap here using the manager's
    // own session map (which flips synchronously on spawn).
    //
    // Allowed: same agent already has a session for THIS ticket (a new
    //   trigger on a live ticket session is a follow-up turn, not a new
    //   ticket). The early-exit at line ~76 handles that case.
    // Dropped: same agentId has active sessions on N OTHER tickets where
    //   N >= maxConcurrentTicketsPerAgent.
    const maxConcurrent = Math.max(
      1,
      Math.floor(spec.maxConcurrentTicketsPerAgent ?? 1),
    );
    if (spec.agentId && !this._getSession(sessionKey)) {
      const otherTickets = new Set<string>();
      for (const sess of this._sessions.values()) {
        if (sess.agentId === spec.agentId && sess.ticketId && sess.ticketId !== spec.ticketId) {
          otherTickets.add(sess.ticketId);
        }
      }
      if (otherTickets.size >= maxConcurrent) {
        log(
          `[ticket-session] dispatch dropped (per-agent cap reached): agent=${spec.agentId.slice(0, 8)} ticket=${spec.ticketId.slice(0, 8)} max=${maxConcurrent} active=${otherTickets.size}`,
        );
        if (dedupKey) this._forgetDedup(dedupKey);
        return { dispatched: false, reason: 'agent_cap_busy' };
      }
    }

    if (spec.forceRespawn === true) {
      const prev = this._getSession(sessionKey);
      if (prev) {
        log(
          `Ticket session force-respawn requested: ticket=${spec.ticketId} role=${role} pid=${prev.pid}`,
        );
        if (prev.idleTimer) {
          clearTimeout(prev.idleTimer);
          prev.idleTimer = null;
        }
        try {
          prev.child.stdin.end();
        } catch {
          /* already closed */
        }
        try {
          process.kill(prev.pid, 'SIGTERM');
        } catch {
          /* already dead */
        }
        this._sessions.delete(sessionKey);
      }
    }

    const sess = this._getSession(sessionKey);

    if (sess) {
      this._sendFollowUp(sess, this.#composeTriggerTurn(spec));
      if (spec.agentId && !sess.agentId) sess.agentId = spec.agentId;
      return { dispatched: true, pid: sess.pid };
    }

    if (!this._ensureCapacity()) {
      if (dedupKey) this._forgetDedup(dedupKey);
      return { dispatched: false, reason: 'cap_busy' };
    }

    const firstTurnText = composeTriggerPrompt(
      spec.ticket,
      spec.rolePrompt || '',
      spec.ticketPrompt || '',
      spec.ticketId,
      spec.columnPrompt || null,
      null,
    );
    const monitorMeta = {
      ticket_id: spec.ticketId,
      ticket_title: spec.ticket?.title || '',
      role,
    };
    const spawned = await this._spawnSession(
      sessionKey,
      spec.rolePrompt || '',
      firstTurnText,
      { monitorMeta, agentContext: spec.agentContext },
    );
    if (!spawned) {
      if (dedupKey) this._forgetDedup(dedupKey);
      return { dispatched: false, reason: 'spawn_failed' };
    }

    spawned.ticketId = spec.ticketId;
    spawned.role = role;
    spawned.agentId = spec.agentId || '';

    if (spawned.agentId) {
      fireAndForgetTool(this._config, 'set_current_task', {
        agent_id: spawned.agentId,
        ticket_id: spec.ticketId,
        role,
      });
    }

    spawned.child.once('exit', () => {
      if (dedupKey) this._forgetDedup(dedupKey);
      if (spawned.agentId) {
        fireAndForgetTool(this._config, 'clear_current_task', {
          agent_id: spawned.agentId,
          ticket_id: spec.ticketId,
        });
      }
    });

    return { dispatched: true, pid: spawned.pid, firstTurn: true };
  }

  #sessionsForTicket(ticketId: string): SessionRecord[] {
    const hits: SessionRecord[] = [];
    for (const sess of this._sessions.values()) {
      if (sess.ticketId === ticketId) hits.push(sess);
    }
    return hits;
  }

  forwardCommentMention(ticketId: string, mention: any): boolean {
    const sessions = this.#sessionsForTicket(ticketId);
    if (sessions.length === 0) return false;

    const lines: string[] = [];
    lines.push(
      '⚠️ [Comment Mention] You were @-mentioned in a comment on this ticket. This is addressed to YOU — respond directly.',
    );
    if (mention.actor_name) lines.push(`  By: ${mention.actor_name}`);
    if (mention.mention_source === 'role' && mention.role_shortcut) {
      lines.push(`  Via role shortcut: @${mention.role_shortcut}`);
    }
    lines.push('');
    lines.push('Comment body:');
    lines.push(mention.content || '');
    lines.push('');
    lines.push(
      'Read the comment and respond to the request directly. Use mcp__awb__get_ticket if you need fresh ticket state, and leave a reply comment addressing the user.',
    );
    const text = lines.join('\n');

    const targetedRole = mention.mention_source === 'role' ? mention.role_shortcut : null;
    const targets = targetedRole
      ? sessions.filter((s) => s.role === targetedRole)
      : sessions;
    const recipients = targets.length > 0 ? targets : sessions;

    for (const sess of recipients) {
      this._sendFollowUp(sess, text, { checkMaxTurns: false });
    }
    return true;
  }

  forwardBoardUpdate(ticketId: string, ev: any): boolean {
    const sessions = this.#sessionsForTicket(ticketId);
    if (sessions.length === 0) return false;

    const lines: string[] = [];
    lines.push('[Board Update] The ticket you are working on was updated:');
    lines.push(`  Event: ${ev.entity_type || 'unknown'}.${ev.action || 'unknown'}`);
    if (ev.field_changed) lines.push(`  Field changed: ${ev.field_changed}`);
    if (ev.actor_name) lines.push(`  By: ${ev.actor_name}`);
    lines.push('');
    lines.push(
      'Review the change and adjust your work if needed. Use mcp__awb__get_ticket to fetch the latest ticket state.',
    );
    const text = lines.join('\n');

    for (const sess of sessions) {
      this._sendFollowUp(sess, text, { checkMaxTurns: false });
    }
    return true;
  }

  #composeTriggerTurn(spec: TicketTriggerArgs): string {
    const lines: string[] = [];
    lines.push('[New Trigger] A new trigger arrived for the ticket you are already working on.');
    if (spec.columnPrompt && (spec.columnPrompt as any).content) {
      lines.push('');
      lines.push(`Column workflow guide (${(spec.columnPrompt as any).name || 'column_prompt'}):`);
      lines.push((spec.columnPrompt as any).content);
    }
    if (spec.ticketPrompt) {
      lines.push('');
      lines.push('Updated instructions:');
      lines.push(spec.ticketPrompt);
    }
    lines.push('');
    lines.push(
      'Use mcp__awb__get_ticket to fetch the latest ticket state and continue your work.',
    );
    return lines.join('\n');
  }

  _snapshot(): Array<{
    sessionKey: string;
    ticketId: string;
    role: string;
    pid: number;
    turnCount: number;
    startedAt: number;
    lastTouchedAt: number;
  }> {
    return Array.from(this._sessions.values()).map((s) => ({
      sessionKey: s.sessionKey,
      ticketId: s.ticketId,
      role: s.role,
      pid: s.pid,
      turnCount: s.turnCount,
      startedAt: s.startedAt,
      lastTouchedAt: s.lastTouchedAt,
    }));
  }
}
