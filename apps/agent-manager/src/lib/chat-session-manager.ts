// Chat Session Manager — keeps one CLI child alive per (chat room, agent)
// pair so successive messages reuse the same KV cache instead of paying
// cold-start + MCP handshake per turn. The composite key matters when a
// manager hosts multiple managed agents that each participate in the same
// room: each agent gets its own session under its own identity, instead
// of clobbering each other on a shared roomId-only session.

import {
  BaseSessionManager,
  type MonitorMeta,
  type RunSessionBinding,
  type SessionAwareConfig,
  type SessionRecord,
} from './base-session-manager.js';
import { ADAPTER_CAPABILITIES, type ParseResult, type TurnImage } from './cli-adapters/base.js';
import { fetchChatRoomHistory, postChatRoomMessage } from './rest.js';
import { log } from './logging.js';
import { callMcpTool, fireAndForgetTool, unwrapToolResult } from './mcp-client.js';
import {
  trackedTicketTool,
  parseStreamToolResult,
  harvestTicketTitles,
  resolveTicketRef,
  resolveBatchTicketRefs,
  resolveRejectHandoffRefs,
  formatTicketRefsContent,
  chunkTicketRefs,
  trackedArtifactTool,
  resolveArtifactRef,
  chunkArtifactRefs,
  formatArtifactRefsContent,
  type TicketToolContext,
  type TicketRef,
  type ArtifactToolContext,
  type ArtifactRef,
} from './ticket-ref-capture.js';
import { findLiveBackgroundTasks, reapProcessTrees, type ProcNode } from './process-tree.js';
import { composeChatRoomPrompt } from './prompts.js';
import {
  approxBase64Bytes,
  prepareChatAttachments,
  renderAttachmentBlock,
  type PreparedAttachment,
  type RawChatAttachment,
} from './chat-attachment-prep.js';

const { PERSISTENT_SESSION } = ADAPTER_CAPABILITIES;
import type {
  ChatDispatchArgs,
  ChatDispatchResult,
  ChatSessionManager as ChatSessionManagerContract,
} from './event-dispatcher.js';

interface ChatHistoryEntry {
  sender_type?: string;
  sender_id?: string;
  sender_name?: string;
  content?: string;
  created_at?: string;
  type?: string;
  /** Attachment metadata for this message. Stored on the in-memory ring (so
   *  respawn-from-ring keeps it) and carried straight through from the REST
   *  history endpoint. Composed into the spawn prompt by
   *  #prepareHistoryAttachments + composeChatRoomPrompt. */
  attachments?: RawChatAttachment[];
}

/** Max number of history messages (newest-first) whose attachments we even
 *  look at when rebuilding a respawned session's context. Bounds the work and
 *  the prompt size; older attachments fall away with their messages. */
const HISTORY_ATTACHMENT_SCAN = 20;
/** Max number of past images we'll fetch + inline as Claude vision blocks on
 *  a respawn. Beyond this, history images degrade to a metadata note so the
 *  prompt doesn't balloon. */
const HISTORY_IMAGE_MAX_COUNT = 4;
/** Total decoded-byte budget for inlined history images. Roughly two 5 MB
 *  photos; once exhausted, remaining history images degrade to metadata. */
const HISTORY_IMAGE_MAX_BYTES = 10 * 1024 * 1024;

/** Max characters sent in the fallback chat message body. */
const FALLBACK_MAX_CHARS = 1500;
/** Min ms between progress messages emitted to a chat room — coalesces
 *  rapid tool_use bursts so the room isn't flooded. */
const PROGRESS_MIN_INTERVAL_MS = 1500;
/** Hard cap on progress messages per chat-session lifetime. The agent's
 *  final `send_chat_room_message` call is what the user actually waits
 *  for; progress is just a heartbeat. Capping at 30 keeps even a runaway
 *  agent from filling the room. */
const PROGRESS_MAX_PER_SESSION = 30;
/** Truncation for the summary slice rendered alongside the tool name. */
const PROGRESS_SUMMARY_MAX = 80;

/** Ticket refs per emitted card message (F-1 ticket 24694916). Kept in lockstep
 *  with the server's per-message MAX_TICKET_REFS (chat-rooms/room-messaging.service.ts)
 *  so every chunk survives the sanitizer whole. */
const TICKET_REFS_PER_MESSAGE = 20;
/** Bound on the per-manager ticket_id→title cache learned from tool results. */
const TICKET_TITLE_CACHE_MAX = 500;

/** ticket 89716f04 — grace after a run session's result line before the
 *  turn-end orphan sweep runs. Lets any tail-end benign shell-out from the
 *  just-finished turn exit first (avoids false positives), while staying far
 *  under the ~45-min liveness reaper it replaces. A new turn on the session
 *  cancels the pending sweep. */
const ORPHAN_SWEEP_GRACE_MS = 4000;
/** Max orphan pids described inline in the run summary / log (the full pid
 *  list is always included; this only caps the per-pid cmdline detail). */
const ORPHAN_SUMMARY_MAX_DETAIL = 5;

export class ChatSessionManager
  extends BaseSessionManager
  implements ChatSessionManagerContract
{
  #historyRing = new Map<string, ChatHistoryEntry[]>();
  #HISTORY_MAX = 30;
  /** Hard cap on the number of distinct rooms held in `#historyRing`. The
   *  per-room array is capped by #HISTORY_MAX, but the map itself used to
   *  grow one bucket per distinct room ever seen, forever (a room's bucket
   *  survived session respawn / idle-reap / stopForAgent). Two mechanisms
   *  bound it now: `_onChildExit` evicts a room's bucket once no live session
   *  references it, and this LRU cap collapses the long tail of rooms the
   *  manager merely observed messages for without ever spawning a session. */
  #ROOMS_MAX = 200;

  // Per-session tracking for fallback detection.
  // Keyed by session pid (unique per child) to avoid leaking across sessions
  // that reuse the same sessionKey after respawn. Output buffering lives on
  // the base class (`_outputRings` + `_collectOutputTail`) — both ticket and
  // chat managers share that ring, this set just records whether the agent
  // actually called `send_chat_room_message` during this pid's lifetime.
  #chatSent = new Set<number>();
  // Per-session progress emit state. Same pid keying as the others so a
  // respawned child gets a fresh budget without leaking the previous
  // session's last-emit timestamp / count.
  #progressMeta = new Map<number, { lastEmitMs: number; count: number; finalSeen: boolean }>();

  // F-1 (ticket 24694916): mechanical ticket-action card capture. Pending tracked
  // tool_use calls keyed by pid → (tool_use_id → capture ctx), matched against the
  // tool_result carrier that arrives later in the same turn's stream. Pure capture
  // logic lives in ./ticket-ref-capture; these maps are just the per-session glue.
  #pendingTicketTools = new Map<number, Map<string, TicketToolContext>>();
  // Refs accumulated across a turn, flushed as one coalesced structured message on
  // turn end (or child exit). Keyed by pid.
  #capturedTicketRefs = new Map<number, TicketRef[]>();
  // ticket_id → title learned from ANY tool result (create/move/get_ticket/…), so a
  // title-less action result (add_comment/claim) can still label its card. Bounded LRU.
  #ticketTitleCache = new Map<string, string>();
  // F2-4 ⓒ (ticket d21b28fc): 결과물(빌드/배포) 카드 캡처. ticket-ref 와 동일한 pid 키
  // pending/captured 이중 맵 — 티켓 ref 와 독립적으로 누적돼 flush 시 artifact_refs 로 방출.
  #pendingArtifactTools = new Map<number, Map<string, ArtifactToolContext>>();
  #capturedArtifactRefs = new Map<number, ArtifactRef[]>();

  constructor(config: SessionAwareConfig) {
    super(config, {
      keyField: 'sessionKey',
      logTag: '[chat-session]',
      cfgPrefix: 'cfg-chat-',
      kindLabel: 'chat_session',
    });
  }

  /** Stable key for one (room, responder agent) pair. The session-record's
   *  `roomId` and `agentId` fields are stamped separately so consumers
   *  (snapshot, monitor) can still slice by either dimension. */
  #makeKey(roomId: string, agentId: string): string {
    return `${roomId}|${agentId || '_'}`;
  }

  /** Drop oldest (least-recently-touched) room buckets until the map is back
   *  under #ROOMS_MAX. Map iteration order is insertion order, and
   *  recordRoomMessage re-inserts a room on every message, so the first key
   *  is the least-recently-active room — the right LRU eviction victim. */
  #evictRoomsBeyondCap(): void {
    while (this.#historyRing.size > this.#ROOMS_MAX) {
      const oldest = this.#historyRing.keys().next().value;
      if (oldest === undefined) break;
      this.#historyRing.delete(oldest);
    }
  }

  /** Test/diagnostics seam: room ids currently buffered, oldest-first. The
   *  `#historyRing` map itself is private; regression tests assert on its
   *  size + LRU ordering through this snapshot. */
  _historyRooms(): string[] {
    return Array.from(this.#historyRing.keys());
  }

  /** Test/diagnostics seam: the buffered history entries for one room
   *  (oldest-first), or [] when the room has no bucket. Regression tests
   *  assert that `recordRoomMessage` threads `attachments` onto the ring so a
   *  respawn-from-ring can re-render past images. */
  _historyEntries(roomId: string): ChatHistoryEntry[] {
    return (this.#historyRing.get(roomId) || []).slice();
  }

  recordRoomMessage(payload: any): void {
    const rid = payload?.room_id;
    if (!rid) return;
    // Skip progress heartbeats so the in-memory history ring stays clean —
    // the agent-manager emits these itself when the spawned CLI fires a
    // non-`send_chat_room_message` tool, and feeding them back into the
    // model would teach it to talk about its tool calls instead of using
    // them. Mirrors the server-side `excludeProgress` filter on the agent
    // history REST endpoint.
    const msgType = typeof payload?.type === 'string' ? payload.type : 'message';
    if (msgType !== 'message') return;
    let buf = this.#historyRing.get(rid);
    if (buf) {
      // LRU touch: re-insert so the most recently active room sorts last in
      // Map iteration order, making the oldest bucket the eviction victim.
      this.#historyRing.delete(rid);
      this.#historyRing.set(rid, buf);
    } else {
      buf = [];
      this.#historyRing.set(rid, buf);
      this.#evictRoomsBeyondCap();
    }
    buf.push({
      sender_type: payload.sender_type,
      sender_id: payload.sender_id,
      sender_name: payload.sender_name,
      content: payload.content,
      created_at: payload.created_at,
      // Keep attachment metadata on the ring so a respawn that rebuilds from
      // here (dispatch's primary history source) can still re-render / re-inline
      // images the user attached on earlier turns. Bytes are NOT stored — only
      // the lightweight projection; the spawn path re-fetches bytes lazily and
      // capped via #prepareHistoryAttachments.
      attachments: Array.isArray(payload.attachments) ? payload.attachments : undefined,
    });
    while (buf.length > this.#HISTORY_MAX) buf.shift();
  }

  async dispatch(spec: ChatDispatchArgs): Promise<ChatDispatchResult> {
    if (!spec.roomId) return { dispatched: false, reason: 'no_room' };

    // Dedup is per (responder agent, sender, timestamp) so multiple managed
    // agents in the same room each react to the same wire event without
    // colliding on the dedup table. Without agentId in the key, the second
    // matched managed agent would always be skipped as a duplicate.
    const dedupKey = `msg:${spec.agentId || '_'}:${spec.senderId || ''}:${spec.createdAt || ''}`;
    if (!this._rememberDedup(dedupKey)) {
      return { dispatched: false, reason: 'duplicate_chat' };
    }

    const sessionKey = this.#makeKey(spec.roomId, spec.agentId);
    // OS-level liveness check — same single-source-of-truth reconciliation
    // ticket-session does. A stale record (child reaped without exit
    // handler) gets purged here so the next branch falls through to a fresh
    // spawn instead of dispatching a turn into a dead stdin.
    const sess = this._getLiveSession(sessionKey);

    if (sess) {
      // ticket 89716f04 — a follow-up turn means the run is progressing, not
      // stranded: cancel any orphan sweep the previous turn armed, and refresh
      // the run binding in case this dispatch carries updated run identity.
      this.#cancelOrphanSweep(sess);
      if (spec.run) sess._run = spec.run;
      // Acceptance criterion: explicit "reused existing pid=…" log so the
      // log stream clearly distinguishes follow-ups from fresh spawns.
      log(
        `[chat-session] reused existing pid=${sess.pid} room=${spec.roomId.slice(0, 8)} agent=${(spec.agentId || '').slice(0, 8)} turn=${sess.turnCount + 1}`,
      );
      // Prep attachments using the session's adapter capability — only
      // fetch image bytes when the live CLI can actually consume them
      // (PERSISTENT_SESSION + native vision content blocks → Claude).
      const canEmitImages = sess.adapter.has(PERSISTENT_SESSION) && sess.cli_type === 'claude';
      const prepared = await prepareChatAttachments(this._config, spec.roomId, spec.attachments, {
        fetchImages: canEmitImages,
      });
      const followupText = this.#followupTurnText(spec, prepared);
      const images = canEmitImages ? this.#extractTurnImages(prepared) : undefined;
      // ticket e9d0e8bc: a run always gets a fresh room → a fresh session, so this
      // reuse branch is unreachable for runs; attach defensively anyway (guarded
      // by spec.onExit, which ordinary chat turns never set) so a hypothetical
      // reuse can't strand a held lock until the manager restarts.
      if (spec.onExit) sess.releaseRunLock = spec.onExit;
      this._sendFollowUp(sess, followupText, { onProgress: spec.onProgress, images });
      return { dispatched: true, pid: sess.pid };
    }

    // Synchronous race guard: if another dispatch is already past this point
    // for the same (room, agent), drop this one. Without it, two concurrent
    // chat events with the same dedup-evading payload (e.g. different
    // sender ids but same room+agent target) can both pass the live-session
    // check and each spawn a child — exactly the bug ticket
    // 52e581ce flagged. The reservation flips synchronously between the
    // check above and the `_spawnSession` await below.
    if (this._inflight.has(sessionKey)) {
      log(
        `[chat-session] dispatch dropped (spawn already in-flight for same key): room=${spec.roomId.slice(0, 8)} agent=${(spec.agentId || '').slice(0, 8)}`,
      );
      // Roll back the dedup mark so the retried message (when the in-flight
      // spawn finishes and a real follow-up turn becomes possible) isn't
      // silently swallowed as a duplicate.
      this._forgetDedup(dedupKey);
      return { dispatched: false, reason: 'inflight_spawn' };
    }

    if (!this._ensureCapacity()) {
      this._forgetDedup(dedupKey);
      return { dispatched: false, reason: 'cap_busy' };
    }

    // Reserve the in-flight slot SYNCHRONOUSLY here — before any await — so a
    // racing dispatch on the same (room, agent) trips the guard above on
    // its second check. The chat path has at least one async hop (history
    // fetch) before the spawn itself; if we deferred the reservation past
    // that hop, two concurrent calls would both clear the guard during the
    // fetch and each call `_spawnSession`, reproducing the duplicate-pid
    // bug the dedup ticket was opened for.
    this._inflight.set(sessionKey, {
      agentId: spec.agentId || '',
      roomId: spec.roomId,
    });

    let history: ChatHistoryEntry[] = (this.#historyRing.get(spec.roomId) || []).slice();
    if (history.length === 0) {
      try {
        history = await fetchChatRoomHistory(this._config, spec.roomId);
      } catch {
        history = [];
      }
    }
    // First-turn attachment prep. Only Claude (persistent session + native
    // vision) gets image bytes fetched here — other CLIs hand-off through
    // the legacy oneshot path, which prepares attachments without images.
    const cli = String(spec.agentContext?.cli || 'claude').toLowerCase();
    const canEmitImages = cli === 'claude';
    const preparedFirstTurn = await prepareChatAttachments(
      this._config,
      spec.roomId,
      spec.attachments,
      { fetchImages: canEmitImages },
    );
    // Re-hydrate attachments from the replayed history so an image the user
    // sent on an earlier turn survives this respawn. For Claude the recent
    // ones are fetched + inlined as vision blocks (capped); everything else is
    // rendered as metadata. This is the actual fix for the dropped-attachment
    // bug — without it the model only ever saw the current turn's image.
    const historyAttachments = await this.#prepareHistoryAttachments(
      spec.roomId,
      history,
      canEmitImages,
    );
    const firstTurnText = composeChatRoomPrompt(
      spec.roomId,
      history,
      {
        content: spec.content || '',
        sender_name: spec.senderName || '',
        sender_id: spec.senderId || '',
      },
      preparedFirstTurn,
      true,
      historyAttachments,
      spec.roomName || '',
      spec.isActionRoom || false,
    );
    // Vision blocks: history images first (chronological), current turn last
    // so the freshest image is the most salient.
    const firstTurnImages = canEmitImages
      ? this.#mergeImages(
          this.#extractHistoryImages(history, historyAttachments),
          this.#extractTurnImages(preparedFirstTurn),
        )
      : undefined;

    const monitorMeta: MonitorMeta = {};
    let spawned: SessionRecord | null = null;
    try {
      spawned = await this._spawnSession(
        sessionKey,
        spec.rolePrompt || '',
        firstTurnText,
        { onProgress: spec.onProgress, monitorMeta, agentContext: spec.agentContext, firstTurnImages },
      );
      // Stamp roomId / agentId on the record BEFORE clearing the inflight
      // reservation — `_spawnSession` lands the record in `_sessions`
      // before returning, so a racing dispatch that just passed the
      // live-session check would otherwise observe a session with empty
      // identity fields.
      if (spawned) {
        spawned.roomId = spec.roomId;
        spawned.agentId = spec.agentId;
        spawned._effectiveApiKey = spec.agentContext?.api_key || this._config.apiKey;
        // ticket 89716f04 — mark one-shot QA/security run sessions so their
        // turn end is swept for orphaned background tasks.
        if (spec.run) spawned._run = spec.run;
        // ticket e9d0e8bc / 9a28bf53: run-lifetime folder-lock release. Fired
        // from the turn-end orphan sweep once the folder is confirmed idle (fast
        // path) and from _onChildExit on process exit (backstop). Set
        // synchronously here (no await between the spawn and this assignment), so
        // both later-macrotask callers always see it.
        if (spec.onExit) spawned.releaseRunLock = spec.onExit;
      }
    } finally {
      this._inflight.delete(sessionKey);
    }
    if (!spawned) {
      this._forgetDedup(dedupKey);
      return { dispatched: false, reason: 'spawn_failed' };
    }
    return { dispatched: true, pid: spawned.pid, firstTurn: true };
  }

  // -- Fallback detection overrides ------------------------------------------

  protected _onStdoutParsed(sess: SessionRecord, parsed: ParseResult, _rawLine: string): void {
    // Plain-text stdout buffering happens in BaseSessionManager#wireStdio now;
    // this override only watches for tool_use blocks + turn boundaries.
    // Turn boundary — reset progress budget so the next user message on the
    // same persistent CLI child gets a fresh window of progress emits.
    // Without this, `finalSeen=true` from turn 1 would silently suppress all
    // future turns on the same pid.
    if (parsed.isResult) {
      this.#progressMeta.delete(sess.pid);
      // F-1 (ticket 24694916): turn ended — every tool_use + tool_result line for
      // this turn has already been parsed, so flush the captured ticket-action refs
      // as one coalesced structured card message.
      this.#flushTicketRefs(sess);
      // ticket 89716f04 — turn ended: for a one-shot run session, arm the
      // orphan sweep (no-op unless sess._run is set). A follow-up turn or the
      // child exiting cancels it before it fires.
      this.#armOrphanSweep(sess);
    }
    // Detect send_chat_room_message tool use in Claude stream-json output.
    // assistant messages carry content blocks; each tool_use block has a `name`.
    if (parsed.raw?.type === 'assistant') {
      const content = parsed.raw?.message?.content;
      if (Array.isArray(content)) {
        const progressTools: Array<{ name: string; input: any }> = [];
        let sawFinal = false;
        for (const block of content) {
          if (block?.type !== 'tool_use' || typeof block.name !== 'string') continue;
          if (block.name.includes('send_chat_room_message')) {
            this.#chatSent.add(sess.pid);
            sawFinal = true;
            continue;
          }
          progressTools.push({ name: block.name, input: block.input });
          // F-1 (ticket 24694916): if this is a tracked ticket-action tool, record
          // it as pending — matched to its tool_result later this turn.
          this.#trackTicketToolUse(sess.pid, block);
        }
        if (progressTools.length > 0) {
          this.#emitProgress(sess, progressTools);
        }
        if (sawFinal) {
          // Mark the session so any later tool calls (e.g. agent doing a
          // post-answer log) don't fire another progress line on top of
          // the user-visible final answer.
          const meta = this.#progressMeta.get(sess.pid);
          if (meta) meta.finalSeen = true;
          else this.#progressMeta.set(sess.pid, { lastEmitMs: 0, count: 0, finalSeen: true });
        }
      }
    }
    // F-1 (ticket 24694916): tool RESULTS arrive as `user`-role carrier messages
    // (Claude stream-json). Match them to the tracked tool_use calls to capture a
    // ticket-action ref, and harvest any {id,title} pairs into the title cache.
    if (parsed.raw?.type === 'user') {
      const content = parsed.raw?.message?.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block?.type === 'tool_result') this.#consumeTicketToolResult(sess.pid, block);
        }
      }
    }
  }

  protected _onStderrLine(_sess: SessionRecord, _line: string): void {
    // Stderr buffering handled in BaseSessionManager#wireStdio (shared ring).
  }

  protected async _onChildExit(
    sess: SessionRecord,
    _code: number | null,
    _signal: NodeJS.Signals | null,
  ): Promise<void> {
    // ticket 89716f04 — the child is gone; its descendants died or reparented,
    // so a pending turn-end orphan sweep has nothing valid to enumerate.
    this.#cancelOrphanSweep(sess);
    // ticket e9d0e8bc / 9a28bf53: release the run-lifetime folder lock — before
    // any early-return below. This is the BACKSTOP: the turn-end orphan sweep
    // already releases early on a clean turn (folder idle), but this covers every
    // path the sweep does not — the child dying before the grace elapses, kill /
    // reaper, `_run` unset, and the orphan-reap branches. `sess` is captured in
    // the base-class exit closure, so it fires on EVERY exit path (normal reply,
    // idle-reap, unhealthy-kill), even after the record is dropped from
    // `_sessions`. Idempotent, so a double release after the early one is a no-op.
    if (sess.releaseRunLock) {
      try {
        sess.releaseRunLock();
      } catch {
        /* ignore — lock release must never break exit cleanup */
      }
    }
    // F-1 (ticket 24694916): backstop — if the child died mid-turn after doing
    // ticket actions (before the turn-end result line), still emit their card so a
    // crash never drops a "누락 없이" ticket-action card. No-op when already flushed.
    this.#flushTicketRefs(sess);
    const sent = this.#chatSent.has(sess.pid);
    // Snapshot the buffered output BEFORE the base class clears it (the
    // base clears the ring after this hook returns).
    const body = sent ? '' : this._collectOutputTail(sess.pid, FALLBACK_MAX_CHARS);

    // Cleanup tracking state regardless of outcome.
    this.#chatSent.delete(sess.pid);
    this.#progressMeta.delete(sess.pid);

    // Evict this room's in-memory history bucket once no other live session
    // still references it. Without this the map accrued one bucket per
    // distinct room ever seen, forever. Keep the bucket while another agent's
    // session in the same room is still running (the historyRing is keyed by
    // roomId but sessions are keyed by `roomId|agentId`, so two managed agents
    // can share a room) — that sibling re-seeds from REST anyway, but dropping
    // it here would discard warm history mid-conversation. The exiting session
    // is still in `_sessions` at this point (the base class deletes it after
    // this hook returns), so exclude it by identity.
    const exitRoomId: string | undefined = sess.roomId;
    if (exitRoomId) {
      const stillUsed = Array.from(this._sessions.values()).some(
        (s) => s !== sess && s.roomId === exitRoomId,
      );
      if (!stillUsed) this.#historyRing.delete(exitRoomId);
    }

    if (sent) return; // Agent replied normally — nothing to do.

    const roomId: string | undefined = sess.roomId;
    const agentId: string | undefined = sess.agentId;
    if (!roomId || !agentId) return;

    const message = body
      ? `⚠️ Agent가 응답하지 못했습니다. CLI 출력:\n\`\`\`\n${body}\n\`\`\``
      : '⚠️ Agent가 응답하지 못했습니다 (출력 없음).';

    log(`[chat-session] fallback message for room=${roomId} agent=${agentId} pid=${sess.pid} outputLen=${body.length}`);
    const cfg = { ...this._config, apiKey: sess._effectiveApiKey || this._config.apiKey };
    await postChatRoomMessage(cfg, roomId, agentId, message);
  }

  // -- Turn-end orphan sweep (ticket 89716f04) -------------------------------

  #cancelOrphanSweep(sess: SessionRecord): void {
    if (sess._orphanSweepTimer) {
      clearTimeout(sess._orphanSweepTimer);
      sess._orphanSweepTimer = null;
    }
  }

  /** Arm the turn-end orphan sweep for a one-shot run session. No-op for an
   *  ordinary chat session (`sess._run` unset). Cancels any previously-armed
   *  timer so only the latest turn's sweep stays pending. */
  #armOrphanSweep(sess: SessionRecord): void {
    if (!sess._run) return;
    this.#cancelOrphanSweep(sess);
    const timer = setTimeout(() => {
      sess._orphanSweepTimer = null;
      void this._sweepTurnEndOrphans(sess);
    }, ORPHAN_SWEEP_GRACE_MS);
    timer.unref?.();
    sess._orphanSweepTimer = timer;
  }

  /** Fired ORPHAN_SWEEP_GRACE_MS after a run session's result line. Two outcomes:
   *  (1) ticket 9a28bf53 — the common CLEAN turn: no live non-benign descendants,
   *  so the shared run folder is idle → release the run-lifetime folder lock early
   *  (see the `orphans.length === 0` branch) instead of waiting for process exit.
   *  (2) ticket 89716f04 — the still-alive CLI child has live non-benign
   *  descendants: background tasks the session left running with no re-invocation
   *  contract — the CLI's positive-pid teardown would kill them silently and
   *  strand the run in `running` until the ~45-min liveness reaper. So: reap them
   *  visibly and finalize the run as `error`, recording the kill in the summary +
   *  manager log (requirements 1b + 2). Re-reads run status first so a run the
   *  agent already finalized is never clobbered. Every await is guarded — this
   *  runs detached via `void`, so it must never reject.
   *  `protected` (not `#private`) purely so the unit test can drive it directly
   *  without the ORPHAN_SWEEP_GRACE_MS timer; not part of the public contract. */
  protected async _sweepTurnEndOrphans(sess: SessionRecord): Promise<void> {
    const run = sess._run;
    if (!run) return;
    // Child already gone → its descendants died or reparented to init;
    // enumerating from a dead pid is meaningless and _onChildExit owns that
    // path. Also closes the pid-reuse window (sess.pid could now be unrelated).
    if (!this._isPidAlive(sess.pid)) return;

    let orphans: ProcNode[];
    try {
      orphans = await findLiveBackgroundTasks(sess.pid);
    } catch (err: any) {
      log(`[chat-session] orphan sweep enumeration failed pid=${sess.pid}: ${err?.message ?? err}`);
      return;
    }
    if (orphans.length === 0) {
      // ticket 9a28bf53 — TURN-END EARLY RELEASE. The run's CLI child ended its
      // turn with NO live background descendants, so the shared run folder is now
      // idle even though the persistent (claude) session lingers until idle-reap
      // (~idleMinutes). Release the run-lifetime folder lock NOW instead of
      // waiting for process exit: this is the positive folder-idle verification
      // the parent (e9d0e8bc) deferred to a follow-up, and it lets a same-scenario
      // successor run stop waiting up to idleMinutes and provision warm at once.
      // `_onChildExit` still fires the same idempotent release as the backstop.
      if (sess.releaseRunLock) {
        log(
          `[chat-session] run ${run.run_id.slice(0, 8)} clean turn end — releasing run-exec ` +
            `folder lock early (folder idle ${ORPHAN_SWEEP_GRACE_MS}ms after result line; ` +
            `not waiting for process exit)`,
        );
        try {
          sess.releaseRunLock();
        } catch {
          /* ignore — lock release must never break the detached sweep */
        }
      }
      return; // clean one-shot turn — nothing stranded
    }

    const run8 = run.run_id.slice(0, 8);
    const pidList = orphans.map((o) => o.pid).join(',');

    // Never overwrite a run the agent already finalized. Availability-first: an
    // unreadable status is treated as non-terminal so a transient server hiccup
    // doesn't leave the trap uncaught.
    let status: string | null = null;
    try {
      const getTool = run.kind === 'qa' ? 'get_qa_run' : 'get_security_run';
      const resp = await callMcpTool(this._config, getTool, {
        run_id: run.run_id,
        workspace_id: run.workspace_id,
      });
      const rec = unwrapToolResult(resp);
      if (rec && typeof rec.status === 'string') status = rec.status;
    } catch (err: any) {
      log(`[chat-session] orphan sweep status read failed run=${run8}: ${err?.message ?? err}`);
    }
    if (status === 'passed' || status === 'failed' || status === 'error') {
      // Run already finalized — the strays are the agent's own leftovers, not a
      // stranded run. Log for forensics but don't reap (avoid clobbering a
      // benign helper an exclusion gap missed) or overwrite the summary.
      log(
        `[chat-session] run ${run8} already ${status}; ${orphans.length} live background task(s) present ` +
          `at session cleanup [pids=${pidList}] — leaving to normal teardown`,
      );
      return;
    }

    // THE TRAP: one-shot run ended its turn with live non-benign descendants and
    // is still non-terminal. Reap them visibly + finalize the run as error.
    let reaped: number[] = [];
    try {
      reaped = await reapProcessTrees(orphans.map((o) => o.pid));
    } catch (err: any) {
      log(`[chat-session] orphan reap failed run=${run8}: ${err?.message ?? err}`);
    }
    const detail = orphans
      .slice(0, ORPHAN_SUMMARY_MAX_DETAIL)
      .map((o) => `pid=${o.pid} ${o.cmd.slice(0, 80)}`)
      .join('; ');
    const summary =
      `session cleanup killed ${orphans.length} live background task(s) — ` +
      `run 세션이 재호출 계약 없이 살아있는 백그라운드 태스크를 남긴 채 턴을 종료했습니다. ` +
      `reaped pids: ${pidList}. ${detail}`;
    const completeTool = run.kind === 'qa' ? 'complete_qa_run' : 'complete_security_run';
    await fireAndForgetTool(this._config, completeTool, {
      run_id: run.run_id,
      workspace_id: run.workspace_id,
      status: 'error',
      summary,
    });
    sess._run = undefined; // finalized — don't sweep this session again
    log(
      `[chat-session] run ${run8} session cleanup: reaped ${reaped.length}/${orphans.length} ` +
        `live background task(s) [pids=${pidList}] — finalized run as error`,
    );
  }

  /** Fire a single coalesced progress message for a batch of tool_use blocks
   *  observed in one assistant turn. Rate-limited per session and silently
   *  capped; this is a heartbeat, not a transcript. Posts via the existing
   *  REST endpoint as a separate message — no schema change. Fire-and-forget
   *  (we're inside a stdout line handler and must stay non-blocking). */
  #emitProgress(sess: SessionRecord, tools: Array<{ name: string; input: any }>): void {
    if (tools.length === 0) return;
    const roomId: string | undefined = sess.roomId;
    const agentId: string | undefined = sess.agentId;
    // roomId/agentId are stamped on the record by `dispatch` immediately
    // after `_spawnSession` returns, but stdio is wired before that stamp
    // lands. A `system`/`assistant` line that arrives in the gap (very
    // unlikely — first assistant turn takes seconds) would have no place
    // to post to; skip silently rather than guess.
    if (!roomId || !agentId) return;

    const now = Date.now();
    let meta = this.#progressMeta.get(sess.pid);
    if (!meta) {
      meta = { lastEmitMs: 0, count: 0, finalSeen: false };
      this.#progressMeta.set(sess.pid, meta);
    }
    if (meta.finalSeen) return;
    if (meta.count >= PROGRESS_MAX_PER_SESSION) return;
    if (now - meta.lastEmitMs < PROGRESS_MIN_INTERVAL_MS) return;

    const message = this.#formatProgressLine(tools);
    if (!message) return;

    meta.lastEmitMs = now;
    meta.count += 1;

    const cfg = { ...this._config, apiKey: sess._effectiveApiKey || this._config.apiKey };
    // Fire-and-forget — postChatRoomMessage already swallows + logs errors,
    // so a failed progress post never blocks stdout parsing. Tagged
    // type='progress' so the server stamps the discriminator on the row
    // and the agent history replay excludes it.
    void postChatRoomMessage(cfg, roomId, agentId, message, { type: 'progress' });
  }

  #formatProgressLine(tools: Array<{ name: string; input: any }>): string {
    const head = tools[0];
    const headLabel = this.#renderToolLabel(head.name, head.input);
    if (tools.length === 1) return `_${headLabel}_`;
    return `_${headLabel} (+${tools.length - 1} more)_`;
  }

  #renderToolLabel(name: string, input: any): string {
    const icon = this.#iconForTool(name);
    const display = this.#displayToolName(name);
    const summary = this.#summarizeToolInput(name, input);
    return summary ? `${icon} ${display} — ${summary}` : `${icon} ${display}`;
  }

  #displayToolName(name: string): string {
    // mcp__awb__get_ticket → mcp__awb__get_ticket (keep verbatim; operators
    // recognize the AWB MCP surface by these names).
    return name;
  }

  #iconForTool(name: string): string {
    const lower = name.toLowerCase();
    if (lower.startsWith('mcp__')) return '📋';
    if (lower === 'read' || lower === 'glob' || lower === 'grep') return '🔍';
    if (lower === 'edit' || lower === 'write' || lower === 'notebookedit') return '✏️';
    if (lower === 'bash') return '💻';
    if (lower === 'webfetch' || lower === 'websearch') return '🌐';
    if (lower === 'task' || lower === 'agent') return '🤖';
    return '🔧';
  }

  /** Pick the most informative single field from a tool's input and truncate.
   *  Conservative — we render plain text only, so a malformed input collapses
   *  to an empty summary rather than a crash. */
  #summarizeToolInput(name: string, input: any): string {
    if (!input || typeof input !== 'object') return '';
    const lower = name.toLowerCase();
    let raw: unknown = '';
    if (lower === 'read' || lower === 'edit' || lower === 'write' || lower === 'notebookedit') {
      raw = input.file_path ?? input.notebook_path ?? '';
    } else if (lower === 'glob') {
      raw = input.pattern ?? '';
    } else if (lower === 'grep') {
      raw = input.pattern ?? '';
    } else if (lower === 'bash') {
      raw = input.command ?? '';
    } else if (lower === 'webfetch' || lower === 'websearch') {
      raw = input.url ?? input.query ?? '';
    } else if (lower === 'task' || lower === 'agent') {
      raw = input.description ?? input.subagent_type ?? '';
    } else {
      // Generic / MCP tools: prefer a small set of well-known identifier
      // fields, then any short string value as a last resort.
      const preferred = ['ticket_id', 'room_id', 'content', 'query', 'pattern', 'path', 'url'];
      for (const k of preferred) {
        if (typeof (input as any)[k] === 'string' && (input as any)[k]) {
          raw = (input as any)[k];
          break;
        }
      }
      if (!raw) {
        for (const v of Object.values(input)) {
          if (typeof v === 'string' && v) {
            raw = v;
            break;
          }
        }
      }
    }
    let s = typeof raw === 'string' ? raw : String(raw ?? '');
    // Collapse whitespace so multi-line Bash commands / Grep patterns
    // render on one chat line.
    s = s.replace(/\s+/g, ' ').trim();
    if (!s) return '';
    if (s.length > PROGRESS_SUMMARY_MAX) {
      s = s.slice(0, PROGRESS_SUMMARY_MAX - 1) + '…';
    }
    // Escape backticks / underscores so the chat italic wrapper doesn't
    // accidentally close inside the summary.
    return s.replace(/[`_*]/g, (c) => `\\${c}`);
  }

  // -- F-1 ticket-action card capture (ticket 24694916) -----------------------
  // Pure capture logic (tool-name mapping, result parsing, ref resolution) lives
  // in ./ticket-ref-capture and is unit-tested there; these methods are just the
  // stateful per-session glue (pending map, title cache, coalesced flush).

  #cacheTicketTitle(id: string, title: string): void {
    // LRU touch: delete + re-set moves the key to the end; evict oldest over cap.
    this.#ticketTitleCache.delete(id);
    this.#ticketTitleCache.set(id, title);
    if (this.#ticketTitleCache.size > TICKET_TITLE_CACHE_MAX) {
      const oldest = this.#ticketTitleCache.keys().next().value;
      if (oldest !== undefined) this.#ticketTitleCache.delete(oldest);
    }
  }

  #trackTicketToolUse(pid: number, block: any): void {
    if (typeof block?.id !== 'string') return;
    const ctx = trackedTicketTool(block?.name, block?.input);
    if (ctx) {
      let pend = this.#pendingTicketTools.get(pid);
      if (!pend) {
        pend = new Map();
        this.#pendingTicketTools.set(pid, pend);
      }
      pend.set(block.id, ctx);
      return;
    }
    // F2-4 ⓒ: 티켓 tool 이 아니면 결과물(빌드/배포) tool 인지 확인해 별도 추적.
    const actx = trackedArtifactTool(block?.name, block?.input);
    if (!actx) return;
    let apend = this.#pendingArtifactTools.get(pid);
    if (!apend) {
      apend = new Map();
      this.#pendingArtifactTools.set(pid, apend);
    }
    apend.set(block.id, actx);
  }

  #consumeTicketToolResult(pid: number, block: any): void {
    const result = parseStreamToolResult(block?.content);
    // Harvest {id,title} pairs from ANY result (incl. reads) so a later title-less
    // action (add_comment/claim) can still label its card from the cache.
    for (const pair of harvestTicketTitles(result)) this.#cacheTicketTitle(pair.id, pair.title);

    const isError = block?.is_error === true;
    const pend = this.#pendingTicketTools.get(pid);
    const useId = typeof block?.tool_use_id === 'string' ? block.tool_use_id : undefined;
    const ctx = pend && useId ? pend.get(useId) : undefined;
    if (!ctx || !pend || !useId) {
      // Not a tracked ticket action — maybe a tracked artifact result (F2-4 ⓒ).
      this.#consumeArtifactToolResult(pid, useId, result, isError);
      return;
    }
    pend.delete(useId);

    const lookup = (id: string) => this.#ticketTitleCache.get(id);
    // batch_operations and reject_handoff each fan ONE result out to many refs;
    // every other tracked tool resolves to at most one. Push each through the same
    // dedup + per-turn cap so a multi-ref call can't blow the coalesced card past
    // the bound.
    if (ctx.batchOps) {
      for (const ref of resolveBatchTicketRefs(ctx, result, isError, lookup)) this.#pushCapturedRef(pid, ref);
    } else if (ctx.rejectHandoff) {
      for (const ref of resolveRejectHandoffRefs(ctx, result, isError, lookup)) this.#pushCapturedRef(pid, ref);
    } else {
      const ref = resolveTicketRef(ctx, result, isError, lookup);
      if (ref) this.#pushCapturedRef(pid, ref);
    }
  }

  /** Append one captured ref to the turn's coalesced set, collapsing duplicate
   *  (action, ticket_id) pairs to a single card. No volume cap here OR at flush time —
   *  #flushTicketRefs splits the set into ≤TICKET_REFS_PER_MESSAGE-ref chunks and emits
   *  ALL of them, so no successful action is ever dropped before it can be carded. The
   *  old hard cap here silently discarded every ref past 20, which broke "누락 없이". */
  #pushCapturedRef(pid: number, ref: TicketRef): void {
    const refs = this.#capturedTicketRefs.get(pid) ?? [];
    if (refs.some((r) => r.action === ref.action && r.ticket_id === ref.ticket_id)) return;
    refs.push(ref);
    this.#capturedTicketRefs.set(pid, refs);
  }

  /** F2-4 ⓒ: 결과물(빌드/배포) tool_result 를 소비해 ArtifactRef 로 캡처한다.
   *  티켓 tool 이 아닌 tool_result 경로에서만 호출됨 — pending artifact 맵에 매칭될
   *  때만 방출(fail-closed). 티켓 캡처와 동일하게 turn 종료 시 함께 flush 된다. */
  #consumeArtifactToolResult(pid: number, useId: string | undefined, result: any, isError: boolean): void {
    const apend = this.#pendingArtifactTools.get(pid);
    const actx = apend && useId ? apend.get(useId) : undefined;
    if (!actx || !apend || !useId) return; // not a tracked artifact tool
    apend.delete(useId);
    const ref = resolveArtifactRef(actx, result, isError);
    if (ref) this.#pushCapturedArtifactRef(pid, ref);
  }

  /** Append a captured artifact ref, collapsing duplicate (kind, title, commit)
   *  so a re-report of the same build/deploy renders one card. */
  #pushCapturedArtifactRef(pid: number, ref: ArtifactRef): void {
    const refs = this.#capturedArtifactRefs.get(pid) ?? [];
    if (refs.some((r) => r.kind === ref.kind && r.title === ref.title && r.commit === ref.commit)) return;
    refs.push(ref);
    this.#capturedArtifactRefs.set(pid, refs);
  }

  /** Flush the turn's captured ticket-action + artifact refs as structured card
   *  message(s). The server bounds each message's ticket_refs / artifact_refs at
   *  TICKET_REFS_PER_MESSAGE, so a turn with more successful actions than that is split
   *  across MULTIPLE cards (never truncated — acceptance #1 "누락 없이"). Non-empty Korean
   *  content is the fallback for surfaces that don't render metadata (history replay,
   *  notifications, legacy clients); the metadata.{ticket_refs,artifact_refs} drives the
   *  rich card. F2-4 ⓒ: ticket / artifact 는 서로 독립적으로 flush — 한쪽만 있어도 방출.
   *  Fire-and-forget; clears per-pid state so it is idempotent (a second call after
   *  turn-end is a no-op). */
  #flushTicketRefs(sess: SessionRecord): void {
    const refs = this.#capturedTicketRefs.get(sess.pid);
    const artifactRefs = this.#capturedArtifactRefs.get(sess.pid);
    this.#capturedTicketRefs.delete(sess.pid);
    this.#pendingTicketTools.delete(sess.pid);
    this.#capturedArtifactRefs.delete(sess.pid);
    this.#pendingArtifactTools.delete(sess.pid);
    const hasTicket = !!refs && refs.length > 0;
    const hasArtifact = !!artifactRefs && artifactRefs.length > 0;
    if (!hasTicket && !hasArtifact) return;
    const roomId: string | undefined = sess.roomId;
    const agentId: string | undefined = sess.agentId;
    if (!roomId || !agentId) return;

    const cfg = { ...this._config, apiKey: sess._effectiveApiKey || this._config.apiKey };
    // Split into ≤TICKET_REFS_PER_MESSAGE-ref chunks so each survives the server
    // sanitizer whole, then emit EVERY chunk — no message-count ceiling. A hard cap
    // here (even one that logs) would drop successful refs past it, breaking acceptance
    // #1 ("누락 없이"). The turn itself already bounds the volume: refs are deduped and
    // only successful tracked mutations are captured, so the chunk count tracks real
    // actions, not runaway input.
    // Fire-and-forget per chunk — postChatRoomMessage swallows + logs errors, so a
    // failed card post never blocks stdout parsing. type defaults to 'message'
    // (persistent, included in history replay); metadata carries that chunk's refs.
    if (hasTicket) {
      for (const chunk of chunkTicketRefs(refs!, TICKET_REFS_PER_MESSAGE)) {
        const content = formatTicketRefsContent(chunk);
        void postChatRoomMessage(cfg, roomId, agentId, content, { metadata: { ticket_refs: chunk } });
      }
    }
    if (hasArtifact) {
      for (const chunk of chunkArtifactRefs(artifactRefs!, TICKET_REFS_PER_MESSAGE)) {
        const content = formatArtifactRefsContent(chunk);
        void postChatRoomMessage(cfg, roomId, agentId, content, { metadata: { artifact_refs: chunk } });
      }
    }
  }

  // ---------------------------------------------------------------------------

  /** Build the follow-up turn body for a live session. The first turn goes
   *  through the full `composeChatRoomPrompt` because the persistent CLI
   *  needs context (room id, instructions); subsequent turns only need the
   *  new user message + any attachment block, since history is already in
   *  the model's running context. */
  #followupTurnText(
    spec: { content?: string },
    attachments: PreparedAttachment[],
  ): string {
    const text = (spec.content || '').trim();
    if (attachments.length === 0) return text;
    const lines: string[] = [];
    if (text) lines.push(text);
    for (const ln of renderAttachmentBlock(attachments)) {
      lines.push(ln);
    }
    return lines.join('\n');
  }

  /** Fetch + classify attachments for the replayed history messages so a
   *  respawned session re-sees images the user attached on earlier turns.
   *  Returns a map keyed by the history-entry object reference (stable across
   *  the slicing composeChatRoomPrompt does). For Claude (`canEmitImages`)
   *  the most recent images are fetched and inlined as vision blocks, capped
   *  by count + total bytes; over-budget and non-Claude images degrade to a
   *  metadata note. `materialize:false` keeps us from re-writing every past
   *  file to disk on each respawn. */
  async #prepareHistoryAttachments(
    roomId: string,
    history: ChatHistoryEntry[],
    canEmitImages: boolean,
  ): Promise<Map<ChatHistoryEntry, PreparedAttachment[]>> {
    const out = new Map<ChatHistoryEntry, PreparedAttachment[]>();
    const real = (Array.isArray(history) ? history : []).filter(
      (h) => h && (!h.type || h.type === 'message'),
    );
    // Only the messages composeChatRoomPrompt actually renders are worth prep.
    const recent = real.slice(-HISTORY_ATTACHMENT_SCAN);
    let imageCountBudget = canEmitImages ? HISTORY_IMAGE_MAX_COUNT : 0;
    let imageByteBudget = HISTORY_IMAGE_MAX_BYTES;
    // Newest-first so the freshest history images win the inline budget.
    for (let i = recent.length - 1; i >= 0; i--) {
      const entry = recent[i];
      const raws = Array.isArray(entry.attachments) ? entry.attachments : [];
      if (raws.length === 0) continue;
      const wantImages = canEmitImages && imageCountBudget > 0;
      const prepared = await prepareChatAttachments(this._config, roomId, raws, {
        fetchImages: wantImages,
        materialize: false,
      });
      for (const att of prepared) {
        if (att.kind !== 'image_base64') continue;
        const sz = approxBase64Bytes(att.image_base64);
        if (imageCountBudget <= 0 || sz > imageByteBudget) {
          // Over budget — drop the bytes but keep the metadata reference so
          // the agent still knows the image was part of the conversation.
          att.kind = 'metadata_only';
          att.image_base64 = undefined;
          att.note = att.note || 'history image not inlined (vision budget exceeded)';
          continue;
        }
        imageCountBudget -= 1;
        imageByteBudget -= sz;
      }
      out.set(entry, prepared);
    }
    return out;
  }

  /** Collect inlined history images in chronological (oldest-first) order so
   *  the vision blocks line up with the rendered history text. */
  #extractHistoryImages(
    history: ChatHistoryEntry[],
    prepared: Map<ChatHistoryEntry, PreparedAttachment[]>,
  ): TurnImage[] {
    const images: TurnImage[] = [];
    const real = (Array.isArray(history) ? history : []).filter(
      (h) => h && (!h.type || h.type === 'message'),
    );
    for (const entry of real.slice(-HISTORY_ATTACHMENT_SCAN)) {
      const atts = prepared.get(entry);
      if (!atts) continue;
      for (const att of atts) {
        if (att.kind === 'image_base64' && att.image_base64) {
          images.push({ media_type: att.mime_type || 'image/png', data: att.image_base64 });
        }
      }
    }
    return images;
  }

  /** Concatenate image lists, dropping empties, returning undefined when the
   *  result is empty (the adapter treats undefined and [] the same, but
   *  undefined keeps the spawn-opts shape unchanged on the no-image path). */
  #mergeImages(...lists: Array<TurnImage[] | undefined>): TurnImage[] | undefined {
    const merged: TurnImage[] = [];
    for (const l of lists) if (l && l.length) merged.push(...l);
    return merged.length > 0 ? merged : undefined;
  }

  /** Pull base64 image payloads out of the prepared attachment list. Only
   *  attachments classified as `image_base64` survived the prep fetch — the
   *  rest are already represented in the prompt text. */
  #extractTurnImages(attachments: PreparedAttachment[]): TurnImage[] | undefined {
    const images: TurnImage[] = [];
    for (const att of attachments) {
      if (att.kind === 'image_base64' && att.image_base64) {
        images.push({ media_type: att.mime_type || 'image/png', data: att.image_base64 });
      }
    }
    return images.length > 0 ? images : undefined;
  }

  _snapshot(): Array<Pick<SessionRecord, 'pid' | 'turnCount' | 'startedAt' | 'lastTouchedAt'> & {
    roomId: string;
    agentId: string;
  }> {
    return Array.from(this._sessions.values()).map((s) => ({
      roomId: s.roomId,
      agentId: s.agentId,
      pid: s.pid,
      turnCount: s.turnCount,
      startedAt: s.startedAt,
      lastTouchedAt: s.lastTouchedAt,
    }));
  }
}
