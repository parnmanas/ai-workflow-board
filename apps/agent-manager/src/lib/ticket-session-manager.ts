// Ticket Session Manager — keeps one CLI child alive per (ticket, role)
// so successive events reuse the same KV cache and context. Per-role keying
// keeps assignee / reviewer / reporter scopes from bleeding into one another.

import {
  BaseSessionManager,
  type SessionAwareConfig,
  type SessionRecord,
} from './base-session-manager.js';
import type { ParseResult } from './cli-adapters/base.js';
import { composeTriggerPrompt } from './prompts.js';
import { fireAndForgetTool } from './mcp-client.js';
import { log } from './logging.js';
import type {
  TicketDispatchResult,
  TicketSessionManager as TicketSessionManagerContract,
  TicketTriggerArgs,
} from './event-dispatcher.js';

/** Natural-language cue an assignee/reviewer writes in their comment when
 *  they are about to call `move_ticket` next. Conservative — only matches
 *  the actual phrases observed in prompts and historical broken-LGTM
 *  comments ("Moving to Merging.", "Moving back to In Progress.", "moving
 *  the ticket forward."). Used to detect the "comment said it would move,
 *  but no follow-up move_ticket call arrived" failure mode (ticket
 *  ce6c8d58).
 *
 *  Deliberately does NOT match `move_ticket` token-mentions, since a
 *  comment that quotes the tool name (e.g. "I considered calling
 *  move_ticket but stopped") would false-arm and inject a misleading
 *  follow-up turn. */
const MOVING_CUE_RE = /\bmov(?:e|ing)\s+(?:to|back|the\s+ticket)\b/i;
/** Grace period after a `add_comment` with a moving cue before the
 *  supervisor force-injects a "continue with move_ticket" follow-up. The
 *  prompt template promises the move is the very next call, so 30s is
 *  generous — typical Claude turn round-trip is 5-15s. */
const MOVING_RESUME_GRACE_MS = 30_000;

export class TicketSessionManager
  extends BaseSessionManager
  implements TicketSessionManagerContract
{
  // In-flight reservations are tracked on the base class's `_inflight` map
  // (see comment there). Cap accounting and same-key drop logic below walk
  // that map directly — both ticket and chat session managers share the
  // pattern, but each owns its own instance, so the maps don't cross-pollute.

  /** Per-session state for the "moving cue armed, waiting for move_ticket"
   *  guard. Keyed by pid (unique per child) so a respawn under the same
   *  sessionKey gets a fresh slate and the previous child's stale armed
   *  state can never trigger a follow-up turn on the new child. */
  #movingCue = new Map<
    number,
    { armed: boolean; injected: boolean; timer: NodeJS.Timeout | null }
  >();

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
    // has stamped current_task. Mirror the cap here, counting both:
    //   - _sessions: spawned children (registered at the END of _spawnSession)
    //   - _inflight: reservations placed synchronously on dispatch entry,
    //     covering the spawn-in-flight window where _sessions is still empty
    //
    // Allowed: same agent already has a session OR inflight reservation for
    //   THIS (ticket, role) — new trigger collapses to a follow-up turn or
    //   gets deduped by the inflight guard a few lines down.
    // Dropped: same agentId has reservations/sessions on N OTHER tickets
    //   where N >= maxConcurrentTicketsPerAgent.
    const maxConcurrent = Math.max(
      1,
      Math.floor(spec.maxConcurrentTicketsPerAgent ?? 1),
    );
    // Live-session check uses OS-level pid existence so a stale entry whose
    // child was reaped without exit-handler cleanup never blocks a fresh
    // spawn (and never gets reused — that would dispatch a turn into a
    // broken stdin and stall the AWB trigger loop). Cap accounting below
    // still walks raw `_sessions.values()` so stale entries don't inflate
    // the count before the next dispatch purges them through this path.
    if (spec.agentId && !this._getLiveSession(sessionKey)) {
      // Same (ticket, role) already spawning — drop as duplicate so the
      // first spawn wins. The next trigger for the same key will arrive
      // after _sessions.set and become a follow-up turn naturally.
      if (this._inflight.has(sessionKey)) {
        log(
          `[ticket-session] dispatch dropped (spawn already in-flight for same key): ticket=${spec.ticketId.slice(0, 8)} role=${role}`,
        );
        if (dedupKey) this._forgetDedup(dedupKey);
        return { dispatched: false, reason: 'inflight_spawn' };
      }
      const otherTickets = new Set<string>();
      for (const sess of this._sessions.values()) {
        if (sess.agentId === spec.agentId && sess.ticketId && sess.ticketId !== spec.ticketId) {
          otherTickets.add(sess.ticketId);
        }
      }
      for (const [k, info] of this._inflight) {
        if (k === sessionKey) continue;
        if (info.agentId === spec.agentId && info.ticketId && info.ticketId !== spec.ticketId) {
          otherTickets.add(info.ticketId);
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

    const sess = this._getLiveSession(sessionKey);

    if (sess) {
      // Acceptance criterion: explicit "reused existing pid=…" log so an
      // operator grepping the manager log can distinguish a follow-up turn
      // from a fresh spawn at a glance.
      log(
        `[ticket-session] reused existing pid=${sess.pid} ticket=${spec.ticketId.slice(0, 8)} role=${role} turn=${sess.turnCount + 1}`,
      );
      this._sendFollowUp(sess, this.#composeTriggerTurn(spec));
      if (spec.agentId && !sess.agentId) sess.agentId = spec.agentId;
      return { dispatched: true, pid: sess.pid };
    }

    if (!this._ensureCapacity()) {
      if (dedupKey) this._forgetDedup(dedupKey);
      return { dispatched: false, reason: 'cap_busy' };
    }

    // Reserve synchronously so concurrent dispatches on the same agent see
    // this slot before _spawnSession lands a SessionRecord in _sessions.
    // Cleared after the spawn outcome is known (success or failure) — the
    // session itself takes over the cap accounting from that point.
    this._inflight.set(sessionKey, {
      agentId: spec.agentId || '',
      ticketId: spec.ticketId,
    });

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
    let spawned: SessionRecord | null = null;
    try {
      spawned = await this._spawnSession(
        sessionKey,
        spec.rolePrompt || '',
        firstTurnText,
        { monitorMeta, agentContext: spec.agentContext },
      );
      // Stamp identity fields BEFORE releasing the inflight reservation, so
      // a concurrent dispatch never observes a session with empty
      // ticketId/agentId (which the cap counter skips). _spawnSession lands
      // the record in _sessions before returning, then we fill these in.
      if (spawned) {
        spawned.ticketId = spec.ticketId;
        spawned.role = role;
        spawned.agentId = spec.agentId || '';
      }
    } finally {
      // Spawn outcome resolved and identity stamped — _sessions takes over
      // cap accounting from here.
      this._inflight.delete(sessionKey);
    }
    if (!spawned) {
      if (dedupKey) this._forgetDedup(dedupKey);
      return { dispatched: false, reason: 'spawn_failed' };
    }

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
        // Release any lock the subagent acquired via claim_ticket. Without
        // this, a child that died mid-turn (MCP init fail, SIGKILL, idle
        // timeout, claude CLI crash after a successful claim_ticket call,
        // …) leaves locked_by_agent_id set until the server-side 30-min
        // sweep fires. The WorkflowFocusSelector then keeps picking that
        // (now-stuck) ticket as the agent's focus, cap=1 blocks every
        // other To Do ticket on the board, and nothing moves until an
        // operator manually clears the lock — exactly the GameClient A-5
        // failure we observed on 2026-05-14. Server enforces ownership on
        // release_ticket (lock owner == agent_id), so this is a clean
        // no-op when the child never claimed and only frees the specific
        // ticket lock the agent holds.
        fireAndForgetTool(this._config, 'release_ticket', {
          ticket_id: spec.ticketId,
          agent_id: spawned.agentId,
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

  // -- Post-comment "moving cue" → resume guard ----------------------------
  // Watches the Claude stream-json output for an `add_comment` call whose
  // body promises a `move_ticket` follow-up (e.g. "Moving to Merging."). If
  // the turn ends or 30 seconds pass without the model actually issuing the
  // `move_ticket` toolcall, we inject a short continuation turn so the
  // ticket doesn't stall mid-workflow. Independent of [[A]] sanitization
  // and [[C]] prompt rewrite — even with both in place, a model that drops
  // its toolcall stream after step 1 would still stall without this guard.

  protected _onStdoutParsed(sess: SessionRecord, parsed: ParseResult, _rawLine: string): void {
    if (parsed.raw?.type === 'assistant') {
      const content = parsed.raw?.message?.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block?.type !== 'tool_use' || typeof block.name !== 'string') continue;
          // `block.name` is the canonical MCP tool id, e.g.
          // `mcp__awb__add_comment` / `mcp__awb__move_ticket`. Match by
          // suffix so a future MCP server rename of the prefix doesn't
          // silently disable the guard.
          if (block.name.endsWith('add_comment')) {
            const text = String(block.input?.content || '');
            if (MOVING_CUE_RE.test(text)) {
              this.#armMovingCue(sess);
            }
          } else if (block.name.endsWith('move_ticket')) {
            // The promised follow-up arrived — disarm cleanly.
            this.#disarmMovingCue(sess.pid, 'move_ticket fired');
          }
        }
      }
    }
    if (parsed.isResult) {
      // Turn ended. If we're still armed and haven't already injected, the
      // model decided this was its final answer without calling
      // move_ticket — fire the continuation immediately instead of waiting
      // for the 30s timer (no point making the operator watch the stall).
      const state = this.#movingCue.get(sess.pid);
      if (state && state.armed && !state.injected) {
        this.#injectMovingResume(sess, 'turn ended without move_ticket');
      }
    }
  }

  protected async _onChildExit(
    sess: SessionRecord,
    _code: number | null,
    _signal: NodeJS.Signals | null,
  ): Promise<void> {
    // Clear any pending timer / state for this pid so a long-lived manager
    // doesn't accumulate handles after many session respawns.
    const state = this.#movingCue.get(sess.pid);
    if (state?.timer) clearTimeout(state.timer);
    this.#movingCue.delete(sess.pid);
  }

  #armMovingCue(sess: SessionRecord): void {
    const existing = this.#movingCue.get(sess.pid);
    if (existing && (existing.armed || existing.injected)) return; // already tracking
    const state: { armed: boolean; injected: boolean; timer: NodeJS.Timeout | null } = {
      armed: true,
      injected: false,
      timer: null,
    };
    state.timer = setTimeout(() => {
      const cur = this.#movingCue.get(sess.pid);
      if (!cur || !cur.armed || cur.injected) return;
      this.#injectMovingResume(sess, `${Math.round(MOVING_RESUME_GRACE_MS / 1000)}s elapsed without move_ticket`);
    }, MOVING_RESUME_GRACE_MS);
    state.timer.unref?.();
    this.#movingCue.set(sess.pid, state);
    log(
      `[ticket-session] moving-cue armed ticket=${(sess.ticketId || '').slice(0, 8)} role=${sess.role || '_'} pid=${sess.pid}`,
    );
  }

  #disarmMovingCue(pid: number, reason: string): void {
    const state = this.#movingCue.get(pid);
    if (!state) return;
    if (state.timer) clearTimeout(state.timer);
    this.#movingCue.delete(pid);
    if (state.armed) {
      log(`[ticket-session] moving-cue disarmed pid=${pid} reason=${reason}`);
    }
  }

  #injectMovingResume(sess: SessionRecord, reason: string): void {
    const state = this.#movingCue.get(sess.pid);
    if (!state) return;
    state.injected = true;
    state.armed = false;
    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = null;
    }
    log(
      `[ticket-session] moving-cue resume injected ticket=${(sess.ticketId || '').slice(0, 8)} role=${sess.role || '_'} pid=${sess.pid} reason=${reason}`,
    );
    const text =
      '[Supervisor] Your previous comment announced a ticket move ("Moving to …") but no `mcp__awb__move_ticket` call followed. ' +
      'Issue the `mcp__awb__move_ticket` call now to complete the transition — this is the very next tool call you must make, with no prose in between. ' +
      'If you cannot move the ticket for a real reason (MCP error, you discovered a blocker), add a follow-up comment explaining why instead of staying silent.';
    try {
      this._sendFollowUp(sess, text, { checkMaxTurns: false });
    } catch (err: any) {
      log(`[ticket-session] moving-cue resume injection failed pid=${sess.pid}: ${err?.message ?? err}`);
    }
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
