// Chat Session Manager — keeps one CLI child alive per (chat room, agent)
// pair so successive messages reuse the same KV cache instead of paying
// cold-start + MCP handshake per turn. The composite key matters when a
// manager hosts multiple managed agents that each participate in the same
// room: each agent gets its own session under its own identity, instead
// of clobbering each other on a shared roomId-only session.

import {
  BaseSessionManager,
  type MonitorMeta,
  type SessionAwareConfig,
  type SessionRecord,
} from './base-session-manager.js';
import { ADAPTER_CAPABILITIES, type ParseResult, type TurnImage } from './cli-adapters/base.js';
import { fetchChatRoomHistory, postChatRoomMessage } from './rest.js';
import { log } from './logging.js';
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
  }

  protected _onStderrLine(_sess: SessionRecord, _line: string): void {
    // Stderr buffering handled in BaseSessionManager#wireStdio (shared ring).
  }

  protected async _onChildExit(
    sess: SessionRecord,
    _code: number | null,
    _signal: NodeJS.Signals | null,
  ): Promise<void> {
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
