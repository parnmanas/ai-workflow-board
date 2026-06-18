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
import { postSilentExitSystemComment } from './rest.js';
import { CircuitBreaker } from './circuit-breaker.js';
import { classifyCliError } from './cli-error-signatures.js';
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

/** Cap on bytes posted in the silent-exit fallback body. 4KB keeps the
 *  comment readable in the board UI and avoids landing a multi-page CLI
 *  log in ticket activity. */
const SILENT_EXIT_TAIL_MAX_CHARS = 4096;

/** MCP tool name suffixes that count as the subagent leaving a real
 *  audit-trail entry. If at least one of these tools fires during the
 *  session, we skip the silent-exit fallback. ALL of them resolve to a
 *  Comment row server-side (add_comment + the four typed variants), so any
 *  of them satisfies the "did the subagent surface anything?" contract. */
const TICKET_COMMENT_TOOL_SUFFIXES = [
  'add_comment',
  'ask_question',
  'answer_question',
  'record_decision',
  'handoff_to_agent',
];

/** Sentinel a running subagent emits in its own output to request that the
 *  NEXT trigger for this (ticket, role) start in a FRESH session instead of
 *  resuming the current one. This is the explicit opt-in escape hatch for the
 *  default "same (ticket,role) → same session" reuse policy — the agent uses
 *  it when it judges the next unit of work should not inherit this session's
 *  accumulated context. Everything after the token on the same line (capped)
 *  is recorded as the human-readable split reason. We match it ONLY against
 *  the model's own text output (assistant text blocks, or raw stdout for
 *  non-JSON adapters) — never tool-result echoes — so a quoted mention of the
 *  token can't false-arm a split. Prompt templates document the token. */
const SESSION_SPLIT_SENTINEL_RE = /\[\[AWB:SESSION_SPLIT\]\][ \t]*([^\r\n]*)/;
/** Cap on the recorded split reason so a runaway line can't bloat the log or
 *  the audit comment. */
const SESSION_SPLIT_REASON_MAX_CHARS = 280;

export class TicketSessionManager
  extends BaseSessionManager
  implements TicketSessionManagerContract
{
  // In-flight reservations are tracked on the base class's `_inflight` map
  // (see comment there). Cap accounting and same-key drop logic below walk
  // that map directly — both ticket and chat session managers share the
  // pattern, but each owns its own instance, so the maps don't cross-pollute.

  /** Circuit-breaker: blocks re-dispatch to agents that repeatedly exit with
   *  non-transient errors (missing auth, config errors). Shared across all
   *  sessions so the threshold counts total attempts, not per-child. Injected
   *  from main.ts so the SAME instance is shared with the one-shot
   *  SubagentManager (ticket 27806095) — a (ticket,role) failing across both
   *  paths counts once and restart_agent's resetAgent clears both. Defaults to
   *  a private instance when constructed without one (unit tests). */
  readonly circuitBreaker: CircuitBreaker;

  /** Per-session state for the "moving cue armed, waiting for move_ticket"
   *  guard. Keyed by pid (unique per child) so a respawn under the same
   *  sessionKey gets a fresh slate and the previous child's stale armed
   *  state can never trigger a follow-up turn on the new child. */
  #movingCue = new Map<
    number,
    { armed: boolean; injected: boolean; timer: NodeJS.Timeout | null }
  >();

  /** PIDs that emitted at least one comment-creating MCP tool_use during
   *  their lifetime. Used by `_onChildExit` to decide whether to post the
   *  silent-exit fallback. Cleared per-pid in the exit hook so a long-lived
   *  manager doesn't leak entries across many session respawns. */
  #commentSent = new Set<number>();
  /** Per-pid record of the latest trigger that drove a new turn into this
   *  session. Threaded into the fallback metadata so an operator looking at
   *  the system comment can correlate it with the AWB trigger that
   *  produced the dead cycle. */
  #lastTriggerId = new Map<number, string>();

  constructor(config: SessionAwareConfig, circuitBreaker?: CircuitBreaker) {
    super(config, {
      keyField: 'sessionKey',
      logTag: '[ticket-session]',
      cfgPrefix: 'cfg-ticket-',
      kindLabel: 'ticket_session',
    });
    this.circuitBreaker = circuitBreaker ?? new CircuitBreaker();
  }

  #makeKey(ticketId: string, role: string): string {
    return `${ticketId}:${role || '_'}`;
  }

  async dispatchTrigger(spec: TicketTriggerArgs): Promise<TicketDispatchResult> {
    if (!spec.ticketId) return { dispatched: false, reason: 'no_ticket' };
    const role = spec.role || '';
    const sessionKey = this.#makeKey(spec.ticketId, role);

    // Circuit-breaker gate: if this (agent, ticket, role) has hit the
    // non-transient failure threshold, drop the trigger so we don't burn
    // respawns on a misconfigured agent indefinitely.
    if (spec.agentId) {
      const cbKey = CircuitBreaker.key(spec.agentId, spec.ticketId, role);
      const blockReason = this.circuitBreaker.shouldBlock(cbKey);
      if (blockReason) {
        log(
          `[ticket-session] dispatch blocked by circuit-breaker: ticket=${spec.ticketId.slice(0, 8)} role=${role} agent=${spec.agentId.slice(0, 8)} — ${blockReason}`,
        );
        return { dispatched: false, reason: 'circuit_breaker_open' };
      }
    }

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
    if (!this._getLiveSession(sessionKey)) {
      // Same (ticket, role) already spawning — drop as duplicate so the
      // first spawn wins. The next trigger for the same key will arrive
      // after _sessions.set and become a follow-up turn naturally.
      //
      // This guard is UNCONDITIONAL on agentId: the `_inflight` map is keyed
      // by sessionKey (`${ticketId}:${role}`), so it is the (ticket,role)
      // fallback the spec asks for when triggerId is empty. A trigger that
      // arrives with an empty field_changed (triggerId='') AND an empty
      // actor_name (agentId='') used to skip this whole block and race past
      // the live-session check, twin-spawning a second child that bypassed
      // the reuse path. Keying the drop on the sessionKey reservation closes
      // that window regardless of whether the trigger carried an agentId.
      // (We deliberately do NOT add sessionKey to the persistent dedup *set*:
      // that set is only forgotten on child exit / drop, never after a
      // successful spawn, so a sessionKey entry there would wrongly reject
      // every later follow-up trigger for a live session as a "duplicate".)
      if (this._inflight.has(sessionKey)) {
        log(
          `[ticket-session] dispatch dropped (spawn already in-flight for same key): ticket=${spec.ticketId.slice(0, 8)} role=${role}`,
        );
        if (dedupKey) this._forgetDedup(dedupKey);
        return { dispatched: false, reason: 'inflight_spawn' };
      }
      // Per-agent cap accounting only applies when we know which agent owns
      // the trigger — an empty agentId can't meaningfully be capped per-agent.
      if (spec.agentId) {
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
    }

    // The post-Done retrospective needs a fresh MCP session so the server can
    // bind X-AWB-Subagent-Trigger-Source=ticket_done_review at initialize
    // time. Reusing a prior reviewer session would keep the old trigger_source
    // and incorrectly block create_remote_improvement_ticket.
    const needsFreshTriggerSession = spec.triggerSource === 'ticket_done_review';
    // Scope ③ escape hatch: the running subagent asked (via the session-split
    // sentinel) for its next trigger to land in a fresh session. Honor it here
    // exactly like a server-side forceRespawn — kill the prior child so the
    // live-session check below misses and we spawn clean. The default remains
    // reuse; this branch only fires when the agent explicitly opted in.
    const prevForSplit = this._getSession(sessionKey);
    const agentRequestedSplit = prevForSplit?.splitRequested === true;
    if (spec.forceRespawn === true || needsFreshTriggerSession || agentRequestedSplit) {
      const prev = this._getSession(sessionKey);
      if (prev) {
        const respawnSource = agentRequestedSplit
          ? `agent_session_split${prev.splitReason ? ` (${prev.splitReason})` : ''}`
          : spec.triggerSource || 'manual';
        log(
          `Ticket session force-respawn requested: ticket=${spec.ticketId} role=${role} pid=${prev.pid} source=${respawnSource}`,
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
      // Update the trigger correlation for the silent-exit fallback before
      // we write the next turn — if the child exits during this cycle,
      // metadata should point at THIS trigger, not the one that started
      // the session.
      if (spec.triggerId) this.#lastTriggerId.set(sess.pid, spec.triggerId);
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
      trigger_source: spec.triggerSource || '',
    };
    let spawned: SessionRecord | null = null;
    try {
      spawned = await this._spawnSession(
        sessionKey,
        spec.rolePrompt || '',
        firstTurnText,
        // Harness applies at session creation only: the CLI flags are fixed
        // at spawn, so the reuse branch above intentionally does NOT
        // re-apply a changed board harness onto a live pid. Changing a
        // board's harness_config takes effect on the next fresh session
        // (new ticket, forceRespawn, or session split). Documented in
        // docs/agent-manager.md.
        {
          monitorMeta,
          agentContext: spec.agentContext,
          harness: spec.harness ?? null,
          // Ticket-level effort preset reaches buildSessionSpawn the same way
          // harness does, so persistent ticket sessions get --effort + the
          // ultracode first-turn keyword at session creation.
          effortPreset: spec.effortPreset ?? null,
        },
      );
      // Stamp identity fields BEFORE releasing the inflight reservation, so
      // a concurrent dispatch never observes a session with empty
      // ticketId/agentId (which the cap counter skips). _spawnSession lands
      // the record in _sessions before returning, then we fill these in.
      if (spawned) {
        spawned.ticketId = spec.ticketId;
        spawned.role = role;
        spawned.agentId = spec.agentId || '';
        // Attribute manager-posted audit comments (silent-exit, session-split)
        // to the managed agent's identity when running for one, else the
        // manager's own key. Mirrors ChatSessionManager.
        spawned._effectiveApiKey = spec.agentContext?.api_key || this._config.apiKey;
        // Stamp the trigger that spawned this session so silent-exit
        // fallback can correlate the dead cycle back to its origin in
        // ticket activity / manager logs.
        if (spec.triggerId) this.#lastTriggerId.set(spawned.pid, spec.triggerId);
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

  protected _onStdoutParsed(sess: SessionRecord, parsed: ParseResult, rawLine: string): void {
    if (parsed.raw?.type === 'assistant') {
      const content = parsed.raw?.message?.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          // Scope ③: assistant text blocks may carry the session-split
          // sentinel. Scan them before the tool_use filter below so a split
          // request emitted as plain text (the common case) is seen.
          if (block?.type === 'text' && typeof block.text === 'string') {
            this.#maybeDetectSessionSplit(sess, block.text);
          }
          if (block?.type !== 'tool_use' || typeof block.name !== 'string') continue;
          // `block.name` is the canonical MCP tool id, e.g.
          // `mcp__awb__add_comment` / `mcp__awb__move_ticket`. Match by
          // suffix so a future MCP server rename of the prefix doesn't
          // silently disable the guard.
          //
          // Two independent observers per block:
          //   1. moving-cue guard (this ticket's pre-existing behavior)
          //   2. silent-exit comment detector — if ANY comment-creating
          //      tool fires, the subagent has left an audit trail and the
          //      `_onChildExit` fallback skips this pid.
          if (this.#isCommentTool(block.name)) {
            this.#commentSent.add(sess.pid);
            // Agent successfully left an audit trail — reset circuit-breaker
            // so future dispatches aren't blocked by stale failure counts.
            if (sess.agentId && sess.ticketId) {
              this.circuitBreaker.reset(
                CircuitBreaker.key(sess.agentId, sess.ticketId, sess.role || ''),
              );
            }
          }
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
    // Non-JSON adapters (codex / antigravity / custom) surface the model's
    // text directly on stdout with no structured envelope — scan the raw line
    // so the session-split sentinel works there too. Guarded on `!parsed.raw`
    // so we never double-scan a structured assistant line (already handled
    // above) or a tool-result echo.
    if (!parsed.raw && rawLine) {
      this.#maybeDetectSessionSplit(sess, rawLine);
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

  /** True when the tool name belongs to the comment-creating MCP surface.
   *  Suffix match is deliberate — adapters rename the `mcp__awb__` prefix
   *  in some setups; the trailing tool id stays stable. */
  #isCommentTool(name: string): boolean {
    for (const suffix of TICKET_COMMENT_TOOL_SUFFIXES) {
      if (name.endsWith(suffix)) return true;
    }
    return false;
  }

  /** Scan one chunk of the subagent's own text output for the session-split
   *  sentinel. First match arms the split for this session; later matches in
   *  the same session are ignored (idempotent — one split request per live
   *  child). */
  #maybeDetectSessionSplit(sess: SessionRecord, text: string): void {
    if (sess.splitRequested) return;
    const m = SESSION_SPLIT_SENTINEL_RE.exec(text);
    if (!m) return;
    const reason = (m[1] || '').trim().slice(0, SESSION_SPLIT_REASON_MAX_CHARS);
    this.#requestSessionSplit(sess, reason);
  }

  /** Arm the agent-driven session split: flag the live session so the next
   *  dispatchTrigger for this (ticket, role) force-respawns a fresh child
   *  instead of reusing this one, and leave an audit trail (log + best-effort
   *  ticket comment) recording the split reason. The current child keeps
   *  running its turn — the split only changes how the NEXT trigger is
   *  routed. */
  #requestSessionSplit(sess: SessionRecord, reason: string): void {
    sess.splitRequested = true;
    sess.splitReason = reason || undefined;
    log(
      `[ticket-session] session-split armed by agent ticket=${(sess.ticketId || '').slice(0, 8)} role=${sess.role || '_'} pid=${sess.pid} reason=${reason || '(none)'}`,
    );
    const ticketId = sess.ticketId || '';
    if (!ticketId) return;
    // Best-effort audit comment, attributed to the session's effective agent
    // identity so the board shows WHO asked to split and WHY. Fire-and-forget:
    // a failed POST must not affect the running child.
    const cfg = { ...this._config, apiKey: sess._effectiveApiKey || this._config.apiKey };
    const body =
      '🔀 Agent requested a **session split** for this (ticket, role). The next ' +
      'trigger will start in a fresh subagent session instead of resuming this one.' +
      (reason ? `\n\n_Reason: ${reason}_` : '');
    fireAndForgetTool(cfg, 'add_comment', {
      ticket_id: ticketId,
      content: body,
      author_role: sess.role || undefined,
    });
  }

  protected async _onChildExit(
    sess: SessionRecord,
    code: number | null,
    _signal: NodeJS.Signals | null,
  ): Promise<void> {
    // Snapshot silent-exit decision inputs BEFORE state cleanup so we can
    // dispatch the fallback after deleting the tracking entries.
    const commented = this.#commentSent.has(sess.pid);
    const triggerId = this.#lastTriggerId.get(sess.pid) || '';
    const ticketId: string = sess.ticketId || '';
    const role: string = sess.role || '';
    const tail = commented && code === 0
      ? ''
      : this._collectOutputTail(sess.pid, SILENT_EXIT_TAIL_MAX_CHARS);

    // Clear all per-pid tracking. The base class clears `_outputRings`
    // after this hook returns, so we don't touch it here.
    const cueState = this.#movingCue.get(sess.pid);
    if (cueState?.timer) clearTimeout(cueState.timer);
    this.#movingCue.delete(sess.pid);
    this.#commentSent.delete(sess.pid);
    this.#lastTriggerId.delete(sess.pid);

    // Silent-exit fallback. Conditions match the ticket acceptance criteria:
    //   - exit code != 0  → spawned but crashed / killed; surface the tail.
    //   - exit code == 0 AND no comment-creating tool fired → "clean" exit
    //     with no audit trail, which is exactly the dead-state operators see
    //     on the board.
    // If a comment-creating tool DID fire during this cycle and the exit was
    // clean, the subagent has already left a real trace and we skip — the
    // fallback is opt-in noise otherwise.
    if (commented && code === 0) {
      // Successful comment → reset circuit-breaker for this key.
      if (sess.agentId && ticketId) {
        this.circuitBreaker.reset(
          CircuitBreaker.key(sess.agentId, ticketId, role),
        );
      }
      return;
    }
    if (!ticketId) return; // sanity — shouldn't happen for a ticket session

    // Circuit-breaker: record non-transient exits. Transient signals
    // (143/SIGTERM, 137/SIGKILL) are the zombie-reap / restart path and
    // must NOT count — the agent will be re-dispatched normally.
    if (sess.agentId && !CircuitBreaker.isTransientExit(code)) {
      const cbKey = CircuitBreaker.key(sess.agentId, ticketId, role);
      const { justOpened, entry } = this.circuitBreaker.record(cbKey, code, tail);
      if (justOpened) {
        // Breaker just opened — pend the ticket so it surfaces for operator
        // attention instead of looping silently.
        const exitDesc = code === 0
          ? 'clean exit with no comment'
          : `exit code ${code}`;
        const reason =
          `Agent failed ${entry.consecutiveFailures} consecutive times (${exitDesc}). ` +
          `Last output: ${entry.lastExitTail || '(none)'}. ` +
          `Check agent CLI config/credentials and unpend when fixed.`;
        fireAndForgetTool(this._config, 'pend_ticket', {
          ticket_id: ticketId,
          reason,
        });
      }
    }

    await this.#postSilentExitFallback(sess, code, triggerId, role, tail);
  }

  /** Post the silent-exit `system` comment via the agent-key REST endpoint.
   *  Best-effort: a failed POST is logged but doesn't propagate — the
   *  child has already exited, so retrying from here only delays cleanup. */
  async #postSilentExitFallback(
    sess: SessionRecord,
    code: number | null,
    triggerId: string,
    role: string,
    tail: string,
  ): Promise<void> {
    const ticketId: string = sess.ticketId || '';
    const exitLabel = code === null ? 'null' : String(code);
    const reasonLabel = code === 0
      ? 'no audit-trail comments + clean exit'
      : `non-zero exit code ${exitLabel}`;
    const header = `⚠️ Subagent exited without leaving a ticket comment (${reasonLabel}).`;
    const meta: string[] = [];
    meta.push(`role=${role || '_'}`);
    meta.push(`exit_code=${exitLabel}`);
    // Structured failure reason (usage_limit / auth_failure / codex_error) when
    // the buffered tail matches a known fatal signature — the "structured
    // failure reason" half of the acceptance criteria (ticket ac958c06).
    const classified = classifyCliError(tail, { exitCode: code });
    if (classified.isFatal && classified.reason) meta.push(`reason=${classified.reason}`);
    if (triggerId) meta.push(`trigger=${triggerId}`);
    const metaLine = `_${meta.join(' · ')}_`;
    const body = tail
      ? `${header}\n\n${metaLine}\n\nLast CLI output:\n\`\`\`\n${tail}\n\`\`\``
      : `${header}\n\n${metaLine}\n\n(no buffered CLI output captured)`;

    log(
      `[ticket-session] silent-exit fallback dispatched ticket=${ticketId.slice(0, 8)} role=${role || '_'} pid=${sess.pid} exit=${exitLabel} trigger=${triggerId.slice(0, 8) || '-'} outputLen=${tail.length}`,
    );

    // Use the managed-agent apiKey when available so the REST endpoint
    // attributes the system comment to the agent that owned this session.
    // Falls back to the manager's own apiKey otherwise.
    const cfg = { ...this._config, apiKey: sess._effectiveApiKey || this._config.apiKey };
    await postSilentExitSystemComment(cfg, ticketId, {
      content: body,
      exit_code: code,
      cycle_trigger_id: triggerId,
      role,
      actor_name: 'agent-manager',
    });
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
