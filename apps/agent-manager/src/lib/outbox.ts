// Durable send outbox — offline message buffering for manager → AWB REST.
//
// Background: the manager posts chat replies, silent-exit audit comments and
// dispatch/command acks to AWB over plain REST. When the server is unreachable
// (network partition, AWB restart, laptop resume) those POSTs were
// fire-and-log: the message was simply LOST. A chat reply the subagent already
// produced never reached the room, and a silent-exit comment never landed on
// the ticket's audit trail.
//
// This module buffers RETRYABLE send failures (network error / timeout / 5xx —
// see rest.ts classifySendFailure) into a FIFO queue persisted under
// AGENT_MANAGER_HOME (`outbox.json`), and replays them:
//   (1) the moment the SSE stream (re)connects — the strongest "server is back"
//       signal the manager has, which also covers boot-after-crash: a manager
//       that died with unsent messages rehydrates the file and flushes on its
//       first SSE connect; and
//   (2) on a slow periodic backstop, for a POST that failed transiently while
//       the SSE stream itself stayed up.
//
// Non-goals: HTTP 4xx failures are PERMANENT (a replay would fail identically)
// and are never buffered. Time-sensitive traffic (output-liveness heartbeats,
// fs_request responses, progress-type chat heartbeats) is never buffered
// either — replaying a stale heartbeat is wrong, and the server already has
// its own timeout fallbacks for those. Acks ARE buffered but with short TTLs:
// past the server's own reconcile window a late ack is just noise.
//
// Delivery semantics: at-least-once. The entry is removed only after a
// successful (or permanently-failed) replay, and the file is re-persisted on
// every queue mutation — so a crash mid-flush can re-send a message that
// already landed, but never silently drops one. FIFO order is preserved and a
// flush stops at the first still-retryable entry (the server is presumed still
// down; later entries would fail the same way).

import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

/** Message classes the outbox knows how to replay. Each maps to one rest.ts
 *  raw sender wired in main.ts (setSenders). */
export type OutboxKind =
  | 'chat_message'
  | 'silent_exit_comment'
  | 'dispatch_ack'
  | 'command_ack'
  | 'cli_login_progress';

/** Replay verdict for one entry — same trichotomy rest.ts classifies live
 *  sends into. `retryable` keeps the entry and aborts the flush pass. */
export type OutboxSendOutcome = 'ok' | 'retryable' | 'permanent';

export type OutboxSender = (payload: any) => Promise<OutboxSendOutcome>;

export interface OutboxEntry {
  id: string;
  kind: OutboxKind;
  /** Epoch ms of the ORIGINAL failed send — TTL expiry keys off this, so an
   *  entry that keeps failing replays does not get its lifetime extended. */
  enqueued_at_ms: number;
  /** Replay attempts so far (the original failed live send is not counted). */
  attempts: number;
  payload: any;
}

/** Per-kind maximum age. Chat replies and audit comments stay meaningful for
 *  a long outage; acks only matter within the server's own reconcile windows
 *  (a dispatch ack past the processing-grace timeout is already superseded by
 *  the server's re-dispatch decision). */
export const OUTBOX_MAX_AGE_MS: Record<OutboxKind, number> = {
  chat_message: 24 * 60 * 60_000,
  silent_exit_comment: 24 * 60 * 60_000,
  dispatch_ack: 15 * 60_000,
  command_ack: 60 * 60_000,
  // A cli-login session (starting/awaiting_user/completing) is reaped
  // server-side ~12 minutes after its own last progress update — no point
  // replaying a report past that, the session will already be timed_out.
  cli_login_progress: 20 * 60_000,
};

/** Queue depth cap — a multi-hour outage on a busy manager should fit, but a
 *  wedged server must never grow the file without bound. Overflow drops the
 *  OLDEST entry (the newest message is the one the user is waiting on). */
export const OUTBOX_MAX_ENTRIES = 500;

/** Replay-attempt backstop per entry. TTL is the primary reaper; this guards
 *  against a payload the server persistently 5xxes on (e.g. an oversized
 *  body) camping at the queue head inside its TTL window. */
export const OUTBOX_MAX_ATTEMPTS = 50;

const PERSIST_VERSION = 1;

const KNOWN_KINDS: ReadonlySet<string> = new Set<OutboxKind>([
  'chat_message',
  'silent_exit_comment',
  'dispatch_ack',
  'command_ack',
  'cli_login_progress',
]);

export interface MessageOutboxOptions {
  /** Absolute path of the JSON persistence file. null → in-memory only (tests). */
  persistPath?: string | null;
  /** Injected clock (test determinism). Defaults to Date.now. */
  now?: () => number;
  log?: (msg: string) => void;
}

export class MessageOutbox {
  #entries: OutboxEntry[] = [];
  #senders = new Map<OutboxKind, OutboxSender>();
  #persistPath: string | null;
  #now: () => number;
  #log: (msg: string) => void;
  #flushing = false;
  /** A flush requested while one was running — re-run once after it drains so
   *  an entry enqueued mid-flush is not stranded until the next trigger. */
  #flushAgain: string | null = null;

  constructor(opts: MessageOutboxOptions = {}) {
    this.#persistPath = opts.persistPath ?? null;
    this.#now = opts.now ?? (() => Date.now());
    this.#log = opts.log ?? (() => {});
  }

  /** Wire the per-kind replay senders (main.ts → rest.ts raw functions). */
  setSenders(senders: Partial<Record<OutboxKind, OutboxSender>>): void {
    for (const [kind, fn] of Object.entries(senders)) {
      if (fn) this.#senders.set(kind as OutboxKind, fn);
    }
  }

  get size(): number {
    return this.#entries.length;
  }

  /** Test/observability snapshot — defensive copy, FIFO order. */
  snapshot(): OutboxEntry[] {
    return this.#entries.map((e) => ({ ...e }));
  }

  /** Rehydrate the persisted queue. Tolerant of a missing / malformed file
   *  (starts empty — losing a corrupt outbox beats refusing to boot). */
  load(): void {
    if (!this.#persistPath || !existsSync(this.#persistPath)) return;
    try {
      const raw = JSON.parse(readFileSync(this.#persistPath, 'utf8'));
      const list = Array.isArray(raw?.entries) ? raw.entries : [];
      const entries: OutboxEntry[] = [];
      for (const e of list) {
        if (!e || typeof e !== 'object') continue;
        if (!KNOWN_KINDS.has(e.kind)) continue;
        entries.push({
          id: typeof e.id === 'string' && e.id ? e.id : randomUUID(),
          kind: e.kind,
          enqueued_at_ms: Number(e.enqueued_at_ms) || this.#now(),
          attempts: Number(e.attempts) || 0,
          payload: e.payload,
        });
      }
      this.#entries = entries;
      if (entries.length) {
        this.#log(`[outbox] rehydrated ${entries.length} unsent message(s) from ${this.#persistPath}`);
      }
    } catch (err: any) {
      this.#log(`[outbox] load failed (${this.#persistPath}): ${err?.message ?? err} — starting empty`);
      this.#entries = [];
    }
  }

  /** Buffer a message whose live send just failed retryably. Caller (rest.ts
   *  wrapper) has already classified the failure — this never re-sends inline. */
  enqueue(kind: OutboxKind, payload: unknown): void {
    this.#entries.push({
      id: randomUUID(),
      kind,
      enqueued_at_ms: this.#now(),
      attempts: 0,
      payload,
    });
    let dropped = 0;
    while (this.#entries.length > OUTBOX_MAX_ENTRIES) {
      this.#entries.shift();
      dropped++;
    }
    if (dropped) this.#log(`[outbox] overflow — dropped ${dropped} oldest entr(y/ies) (cap=${OUTBOX_MAX_ENTRIES})`);
    this.#persist();
    this.#log(`[outbox] buffered ${kind} for replay (pending=${this.#entries.length})`);
  }

  /**
   * Replay the queue FIFO. Single-flight: a call while a flush is running just
   * schedules one follow-up pass. Expired / attempt-capped entries are dropped;
   * `ok` and `permanent` outcomes remove the entry; the first `retryable`
   * outcome stops the pass (server presumed still unreachable). The file is
   * re-persisted after every queue mutation so a crash mid-flush re-sends (at
   * -least-once) instead of dropping.
   */
  async flush(reason: string): Promise<void> {
    if (this.#flushing) {
      this.#flushAgain = reason;
      return;
    }
    if (this.#entries.length === 0) return;
    this.#flushing = true;
    try {
      this.#log(`[outbox] flush start (${reason}) — ${this.#entries.length} pending`);
      let sent = 0;
      let droppedExpired = 0;
      let droppedPermanent = 0;
      while (this.#entries.length > 0) {
        const entry = this.#entries[0];
        const maxAge = OUTBOX_MAX_AGE_MS[entry.kind];
        if (this.#now() - entry.enqueued_at_ms > maxAge || entry.attempts >= OUTBOX_MAX_ATTEMPTS) {
          this.#entries.shift();
          droppedExpired++;
          this.#persist();
          continue;
        }
        const sender = this.#senders.get(entry.kind);
        if (!sender) {
          // No sender wired for this kind (shouldn't happen in production —
          // main.ts wires all kinds before load). Drop rather than wedge the
          // queue head forever.
          this.#entries.shift();
          this.#persist();
          this.#log(`[outbox] no sender for kind=${entry.kind} — dropped entry ${entry.id}`);
          continue;
        }
        let outcome: OutboxSendOutcome;
        try {
          outcome = await sender(entry.payload);
        } catch (err: any) {
          // A sender never intentionally throws (rest.ts raw senders catch
          // internally) — treat an unexpected throw as retryable so a bug here
          // degrades to "retry later", not message loss.
          this.#log(`[outbox] sender threw for ${entry.kind}: ${err?.message ?? err}`);
          outcome = 'retryable';
        }
        if (outcome === 'retryable') {
          entry.attempts++;
          this.#persist();
          this.#log(
            `[outbox] flush paused (${reason}) — ${entry.kind} still unsendable ` +
              `(attempts=${entry.attempts}, pending=${this.#entries.length})`,
          );
          return;
        }
        this.#entries.shift();
        this.#persist();
        if (outcome === 'ok') sent++;
        else droppedPermanent++;
      }
      this.#log(
        `[outbox] flush done (${reason}) — sent=${sent} dropped_expired=${droppedExpired} dropped_permanent=${droppedPermanent}`,
      );
    } finally {
      this.#flushing = false;
      if (this.#flushAgain) {
        const again = this.#flushAgain;
        this.#flushAgain = null;
        void this.flush(again);
      }
    }
  }

  #persist(): void {
    if (!this.#persistPath) return;
    const body = JSON.stringify({ version: PERSIST_VERSION, entries: this.#entries }, null, 2);
    try {
      const tmp = `${this.#persistPath}.tmp`;
      mkdirSync(dirname(this.#persistPath), { recursive: true });
      writeFileSync(tmp, body, 'utf8');
      renameSync(tmp, this.#persistPath); // atomic replace
    } catch (err: any) {
      this.#log(`[outbox] persist failed (${this.#persistPath}): ${err?.message ?? err}`);
    }
  }
}
