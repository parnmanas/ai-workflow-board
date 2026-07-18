// Harness session-limit defer (ticket 467f714a).
//
// Background: a Claude harness one-shot / persistent session can die on turn 1
// with `You've hit your session limit · resets 12:30am (Asia/Seoul)` (observed
// on ticket d34075b5: exit_code=1, repeat_count=6). The CLI account's rolling
// session cap is exhausted — every spawn until the reset time hits the SAME wall
// and dies again. The server supervisor, seeing no forward progress, keeps
// force-respawning the ticket-role every few minutes → each respawn burns a
// fresh (doomed) CLI session, and the accumulated concurrent provisioning
// windows produced same-ticket-role twin detection + duplicate rebase strands.
//
// A session limit is NOT an agent fault and NOT a provisioning blocker: it heals
// by TIME, at a reset instant the CLI itself tells us. So instead of counting it
// toward the circuit breaker (→ spurious pend) or re-probing per cooldown window
// (RoleSpawnSuppressor's model, for durable env blockers), this module:
//   (1) parses the structured reset instant out of the exit tail, and
//   (2) defers the whole AGENT's dispatch until that instant, coalescing every
//       re-dispatch that arrives in the window into a SINGLE pending intent per
//       (ticket, role, agent) — no spawn, no twin — then replays each intent
//       EXACTLY ONCE at reset.
//
// The defer state is DURABLE (persisted under AGENT_MANAGER_HOME): unlike the
// in-memory dispatch trackers, a session-limit window can outlive a manager
// restart (the reset is minutes-to-hours away), so the pending intents + reset
// instant survive a restart and the resume still fires exactly once. On restart
// the store re-arms its timer from the persisted `deferUntilMs`; a window that
// already elapsed while the manager was down replays on the next tick.

import { existsSync, readFileSync } from 'node:fs';
import { writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { InflightDispatchTracker } from './dispatch-preflight.js';
import type { InflightDispatchMeta, RetryScheduler } from './dispatch-preflight.js';
import { classifyCliError } from './cli-error-signatures.js';

/** Machine reason label stored on a defer window. Kept a stable string so the
 *  audit comment / log / test can key on it. */
export const SESSION_LIMIT_REASON = 'session_limit';

/** Conservative defer applied when a session-limit exit is recognized but its
 *  reset time can't be parsed out of the tail. Long enough to break the
 *  supervisor's ~5-min force-respawn storm, short enough not to strand a ticket
 *  if our detection was a false positive — the post-window re-dispatch just
 *  re-detects and re-defers, or (limit lifted) recovers. */
export const DEFAULT_SESSION_DEFER_MS = 30 * 60_000;

/** Upper bound on any single defer window. A parsed reset should be < ~5h out
 *  (Claude's rolling session window); anything beyond this is treated as a parse
 *  artifact and clamped so a bad parse can never strand a ticket for a day. */
export const MAX_SESSION_DEFER_MS = 6 * 60 * 60_000;

// ── reset-time parsing ───────────────────────────────────────────────────────

/** Recognize the harness session-limit reset phrase and pull out the wall-clock
 *  time + optional IANA timezone. Matches the observed
 *  `… resets 12:30am (Asia/Seoul)` and lenient variants (`resets at 3pm`,
 *  `resets 12 am`). Capture groups: 1=hour, 2=minute?, 3=a|p (meridiem),
 *  4=timezone?. */
const RESET_RE =
  /resets?\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*([ap])\.?\s*m\.?\s*(?:\(([^)]+)\))?/i;

/** The runtime's own IANA timezone, used when the reset phrase omits one. */
function localTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

/** Wall-clock components of `atMs` as observed in `tz`. Returns null when the tz
 *  is not a valid IANA zone (Intl throws). */
function tzParts(
  tz: string,
  atMs: number,
): { y: number; mo: number; d: number; h: number; mi: number; s: number } | null {
  try {
    const dtf = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    const map: Record<string, number> = {};
    for (const p of dtf.formatToParts(new Date(atMs))) {
      if (p.type !== 'literal') map[p.type] = Number(p.value);
    }
    // Intl renders midnight as hour '24' in some engines — normalize to 0.
    const h = map.hour === 24 ? 0 : map.hour;
    if ([map.year, map.month, map.day, h, map.minute, map.second].some((n) => Number.isNaN(n))) {
      return null;
    }
    return { y: map.year, mo: map.month, d: map.day, h, mi: map.minute, s: map.second };
  } catch {
    return null;
  }
}

/** Offset (ms) such that `localWallClock = utcInstant + offset` for `tz` at the
 *  given instant. Positive east of UTC (Asia/Seoul = +9h). */
function tzOffsetMs(tz: string, atMs: number): number | null {
  const p = tzParts(tz, atMs);
  if (!p) return null;
  const asUtc = Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s);
  // atMs may carry sub-second; compare on whole seconds to match formatted parts.
  return asUtc - Math.floor(atMs / 1000) * 1000;
}

/** Convert a wall-clock (y,mo,d,h,mi) in `tz` to the UTC epoch ms it denotes.
 *  Two-pass to settle a DST boundary where the naive offset guess straddles a
 *  transition (Asia/Seoul has no DST, so pass 1 is already exact there). */
function wallClockToUtc(
  tz: string,
  y: number,
  mo: number,
  d: number,
  h: number,
  mi: number,
): number | null {
  const guess = Date.UTC(y, mo - 1, d, h, mi, 0);
  const off1 = tzOffsetMs(tz, guess);
  if (off1 === null) return null;
  let utc = guess - off1;
  const off2 = tzOffsetMs(tz, utc);
  if (off2 !== null && off2 !== off1) utc = guess - off2;
  return utc;
}

export interface HarnessResetParse {
  /** Human-readable reset label as the harness phrased it (e.g.
   *  `12:30am (Asia/Seoul)`) — surfaced verbatim in the audit comment. */
  resetLabel: string;
  /** Absolute epoch ms of the next reset instant, strictly after `nowMs`. */
  resetAtMs: number;
}

/**
 * Parse a harness session-limit reset out of a CLI exit tail. Pure +
 * side-effect-free (clock injected via `nowMs`) so it is unit-testable without a
 * real clock. Returns null when no reset phrase is present or the time can't be
 * resolved to an absolute instant — the caller then applies a conservative
 * default window.
 *
 * The reset is a TIME-OF-DAY in a timezone, so we compute the NEXT occurrence of
 * that wall-clock strictly after `nowMs` (a reset "12:30am" seen at 11pm is
 * tonight; seen at 1am it is the coming midnight — always forward).
 */
export function parseHarnessResetTime(
  text: string | null | undefined,
  nowMs: number,
): HarnessResetParse | null {
  const s = String(text ?? '');
  if (!s.trim()) return null;
  const m = RESET_RE.exec(s);
  if (!m) return null;

  let hour = Number(m[1]);
  const minute = m[2] ? Number(m[2]) : 0;
  const meridiem = m[3].toLowerCase();
  if (Number.isNaN(hour) || hour < 1 || hour > 12 || minute > 59) return null;
  // 12-hour → 24-hour: 12am = 00, 12pm = 12, 1–11 pm = +12.
  if (meridiem === 'a') hour = hour === 12 ? 0 : hour;
  else hour = hour === 12 ? 12 : hour + 12;

  const tz = (m[4] || '').trim() || localTimeZone();
  const nowParts = tzParts(tz, nowMs);
  if (!nowParts) return null;

  // Candidate = target time-of-day on TODAY's local date; roll to tomorrow when
  // that instant is already at/behind now.
  let resetAtMs = wallClockToUtc(tz, nowParts.y, nowParts.mo, nowParts.d, hour, minute);
  if (resetAtMs === null) return null;
  if (resetAtMs <= nowMs) {
    const next = new Date(resetAtMs + 24 * 60 * 60_000);
    const np = tzParts(tz, next.getTime());
    if (!np) return null;
    resetAtMs = wallClockToUtc(tz, np.y, np.mo, np.d, hour, minute);
    if (resetAtMs === null || resetAtMs <= nowMs) return null;
  }

  // Human label = the matched phrase minus the leading "resets"/"resets at"
  // (e.g. `12:30am (Asia/Seoul)`), surfaced verbatim in the audit comment.
  const label = m[0].replace(/^resets?\s+(?:at\s+)?/i, '').trim();
  return { resetLabel: label || 'session reset', resetAtMs };
}

/** Resolve the effective defer-until instant for a recorded session limit: the
 *  parsed reset when present and sane, else `now + DEFAULT_SESSION_DEFER_MS`;
 *  clamped to `[now, now + MAX_SESSION_DEFER_MS]`. Exported for the exit-side
 *  caller and unit tests. */
export function resolveDeferUntil(
  nowMs: number,
  parsedResetAtMs: number | null | undefined,
): number {
  const floor = nowMs + 60_000; // never a zero/negative window
  const ceil = nowMs + MAX_SESSION_DEFER_MS;
  const target =
    typeof parsedResetAtMs === 'number' && parsedResetAtMs > nowMs
      ? parsedResetAtMs
      : nowMs + DEFAULT_SESSION_DEFER_MS;
  return Math.max(floor, Math.min(target, ceil));
}

/** A session-limit exit recognized on a dead subagent, resolved to a concrete
 *  defer window. `resetLabel` is '' when the reset time couldn't be parsed (a
 *  conservative default window is used then). */
export interface HarnessSessionLimitDetection {
  reason: string;
  resetLabel: string;
  deferUntilMs: number;
}

/**
 * Detect a harness session-limit death from a CLI exit tail + code, resolved to
 * a defer window. Returns null when the tail is not a session-limit signature
 * (the caller then falls through to its normal breaker / silent-exit path).
 * Shared by the persistent ticket-session and one-shot subagent exit handlers so
 * both classify + parse identically. Pure aside from the injected `nowMs`.
 */
export function detectHarnessSessionLimit(
  tail: string | null | undefined,
  code: number | null,
  nowMs: number,
): HarnessSessionLimitDetection | null {
  const cls = classifyCliError(tail, { exitCode: code });
  if (cls.reason !== SESSION_LIMIT_REASON) return null;
  const parsed = parseHarnessResetTime(tail, nowMs);
  return {
    reason: cls.reason,
    resetLabel: parsed?.resetLabel ?? '',
    deferUntilMs: resolveDeferUntil(nowMs, parsed?.resetAtMs ?? null),
  };
}

// ── durable defer store ──────────────────────────────────────────────────────

/** One coalesced pending intent — the freshest raw trigger to replay for a
 *  deferred (ticket, role, agent), keyed identically to the twin guard so a
 *  replay re-acquires the same single-flight reservation. */
export interface SessionDeferIntent {
  key: string;
  raw: string;
  ticketId: string;
  role: string;
  agentId: string;
  firstAtMs: number;
}

interface AgentDeferRecord {
  agentId: string;
  deferUntilMs: number;
  reason: string;
  resetLabel: string;
  sinceMs: number;
  intents: Map<string, SessionDeferIntent>;
}

export interface SessionDeferState {
  deferred: boolean;
  deferUntilMs?: number;
  reason?: string;
  resetLabel?: string;
}

export type SessionDeferResumeHandler = (raw: string) => Promise<void> | void;

export interface SessionLimitDeferStoreOptions {
  /** Absolute path of the JSON persistence file. null → in-memory only (tests). */
  persistPath?: string | null;
  /** Injected clock (test determinism). Defaults to Date.now. */
  now?: () => number;
  /** Injected timer surface (test determinism). Defaults to unref'd setTimeout. */
  scheduler?: RetryScheduler;
  log?: (msg: string) => void;
}

const defaultScheduler: RetryScheduler = {
  set(fn, ms) {
    const t = setTimeout(fn, ms);
    (t as any)?.unref?.();
    return t;
  },
  clear(handle) {
    clearTimeout(handle as any);
  },
};

const PERSIST_VERSION = 1;

/**
 * Restart-durable, agent-scoped session-limit defer store (ticket 467f714a).
 *
 * ── model ──
 * `recordSessionLimit(agentId, …)` opens (or extends) a defer WINDOW for the
 * agent — the reset instant the harness reported. While the window is open,
 * `deferState(agentId)` reports deferred and the dispatcher coalesces every
 * re-dispatch into `addPendingIntent` — one entry per (ticket, role, agent),
 * refreshed (never stacked) on repeats. At the reset instant a single timer
 * fires, the window is cleared, and each pending intent is replayed EXACTLY
 * ONCE through the injected resume handler (wired to
 * EventDispatcher.handleTrigger, which re-acquires the twin reservation — so the
 * replay can never spawn a twin).
 *
 * ── durability ──
 * The whole structure (windows + intents) is persisted atomically to
 * `persistPath` on every mutation and rehydrated by `load()` at boot, which
 * re-arms the timer from the persisted `deferUntilMs`. A window that elapsed
 * while the manager was down replays on the next tick. Exactly-once survives a
 * restart because an intent is REMOVED (and the removal persisted) before its
 * replay is dispatched — a crash mid-replay loses at most that one resume, which
 * the server supervisor's own post-reset re-push then covers.
 */
export class SessionLimitDeferStore {
  #byAgent = new Map<string, AgentDeferRecord>();
  #resume: SessionDeferResumeHandler | null = null;
  #timer: unknown | null = null;
  #timerAtMs: number | null = null;
  #now: () => number;
  #scheduler: RetryScheduler;
  #persistPath: string | null;
  #log: (msg: string) => void;

  constructor(opts: SessionLimitDeferStoreOptions = {}) {
    this.#now = opts.now ?? (() => Date.now());
    this.#scheduler = opts.scheduler ?? defaultScheduler;
    this.#persistPath = opts.persistPath ?? null;
    this.#log = opts.log ?? (() => {});
  }

  /** Wire the replay callback (EventDispatcher.handleTrigger). Set once at
   *  construction, before load(). */
  setResumeHandler(fn: SessionDeferResumeHandler): void {
    this.#resume = fn;
  }

  /** Rehydrate persisted windows + intents and re-arm the expiry timer. Safe to
   *  call once at boot; tolerant of a missing / malformed file (starts empty). */
  load(): void {
    if (!this.#persistPath || !existsSync(this.#persistPath)) {
      this.#arm();
      return;
    }
    try {
      const raw = JSON.parse(readFileSync(this.#persistPath, 'utf8'));
      const agents = raw?.agents && typeof raw.agents === 'object' ? raw.agents : {};
      for (const [agentId, rec] of Object.entries<any>(agents)) {
        if (!agentId || !rec || typeof rec.deferUntilMs !== 'number') continue;
        const intents = new Map<string, SessionDeferIntent>();
        const rawIntents = rec.intents && typeof rec.intents === 'object' ? rec.intents : {};
        for (const [key, it] of Object.entries<any>(rawIntents)) {
          if (!it || typeof it.raw !== 'string') continue;
          intents.set(key, {
            key,
            raw: it.raw,
            ticketId: String(it.ticketId ?? ''),
            role: String(it.role ?? ''),
            agentId: String(it.agentId ?? agentId),
            firstAtMs: Number(it.firstAtMs) || this.#now(),
          });
        }
        this.#byAgent.set(agentId, {
          agentId,
          deferUntilMs: rec.deferUntilMs,
          reason: String(rec.reason ?? SESSION_LIMIT_REASON),
          resetLabel: String(rec.resetLabel ?? ''),
          sinceMs: Number(rec.sinceMs) || this.#now(),
          intents,
        });
      }
      this.#log(
        `[session-defer] rehydrated ${this.#byAgent.size} deferred agent(s) from ${this.#persistPath}`,
      );
    } catch (err: any) {
      this.#log(`[session-defer] load failed (${this.#persistPath}): ${err?.message ?? err}`);
      this.#byAgent.clear();
    }
    this.#arm();
  }

  /** Open (or extend) an agent's defer window from a recognized session-limit
   *  exit. `deferUntilMs` is the resolved reset instant (see
   *  {@link resolveDeferUntil}); a later reset extends the window, an earlier one
   *  is ignored (never shortens a live defer). Returns whether this OPENED a
   *  fresh window (the caller may log/audit once). */
  recordSessionLimit(
    agentId: string,
    args: { deferUntilMs: number; reason?: string; resetLabel?: string; nowMs?: number },
  ): { opened: boolean } {
    if (!agentId) return { opened: false };
    const now = args.nowMs ?? this.#now();
    if (args.deferUntilMs <= now) return { opened: false };
    const existing = this.#byAgent.get(agentId);
    if (existing) {
      // Extend to the later reset; keep coalesced intents. Never shorten.
      if (args.deferUntilMs > existing.deferUntilMs) {
        existing.deferUntilMs = args.deferUntilMs;
        existing.reason = args.reason ?? existing.reason;
        existing.resetLabel = args.resetLabel ?? existing.resetLabel;
        this.#persist();
        this.#arm();
      }
      return { opened: false };
    }
    this.#byAgent.set(agentId, {
      agentId,
      deferUntilMs: args.deferUntilMs,
      reason: args.reason ?? SESSION_LIMIT_REASON,
      resetLabel: args.resetLabel ?? '',
      sinceMs: now,
      intents: new Map(),
    });
    this.#log(
      `[session-defer] window opened agent=${agentId.slice(0, 8)} reason=${args.reason ?? SESSION_LIMIT_REASON} ` +
        `until=${new Date(args.deferUntilMs).toISOString()} label="${args.resetLabel ?? ''}"`,
    );
    this.#persist();
    this.#arm();
    return { opened: true };
  }

  /** Is this agent currently within a live defer window? */
  deferState(agentId: string | undefined, nowMs?: number): SessionDeferState {
    if (!agentId) return { deferred: false };
    const rec = this.#byAgent.get(agentId);
    if (!rec) return { deferred: false };
    const now = nowMs ?? this.#now();
    if (rec.deferUntilMs <= now) return { deferred: false };
    return {
      deferred: true,
      deferUntilMs: rec.deferUntilMs,
      reason: rec.reason,
      resetLabel: rec.resetLabel,
    };
  }

  /** Coalesce a deferred re-dispatch into the SINGLE pending intent for its
   *  (ticket, role, agent). A repeat only refreshes the raw payload (freshest
   *  trigger context) — it never stacks a second entry, so exactly one replay
   *  fires at reset and no twin is possible. No-op (created:false) when the agent
   *  has no live window. Returns whether a NEW intent was created — the caller
   *  posts its one-time audit comment only then. */
  addPendingIntent(
    agentId: string | undefined,
    meta: InflightDispatchMeta,
    raw: string,
    nowMs?: number,
  ): { created: boolean } {
    if (!agentId) return { created: false };
    const rec = this.#byAgent.get(agentId);
    const now = nowMs ?? this.#now();
    if (!rec || rec.deferUntilMs <= now) return { created: false };
    const key = InflightDispatchTracker.key(meta.ticketId, meta.role, meta.agentId);
    const existing = rec.intents.get(key);
    if (existing) {
      existing.raw = raw;
      this.#persist();
      return { created: false };
    }
    rec.intents.set(key, {
      key,
      raw,
      ticketId: meta.ticketId,
      role: meta.role,
      agentId: meta.agentId,
      firstAtMs: now,
    });
    this.#persist();
    return { created: true };
  }

  /** Drop every pending intent for a ticket (any role/agent) — the ticket left
   *  the active flow (moved / archived / terminal), so its deferred re-dispatch
   *  must not replay at reset. The agent's window itself stays (other tickets may
   *  still be deferred). Returns how many intents were cancelled. */
  cancelByTicket(ticketId: string | undefined, reason = 'ticket left active flow'): number {
    if (!ticketId) return 0;
    let removed = 0;
    for (const rec of this.#byAgent.values()) {
      for (const [key, it] of [...rec.intents]) {
        if (it.ticketId === ticketId) {
          rec.intents.delete(key);
          removed++;
        }
      }
    }
    if (removed) {
      this.#log(`[session-defer] cancelled ${removed} intent(s) for ticket=${ticketId.slice(0, 8)}: ${reason}`);
      this.#persist();
    }
    return removed;
  }

  /** Clear an agent's window + intents outright (test / manual recovery). */
  clear(agentId: string | undefined): void {
    if (agentId && this.#byAgent.delete(agentId)) {
      this.#persist();
      this.#arm();
    }
  }

  // ── test / observability ──
  isDeferred(agentId: string | undefined, nowMs?: number): boolean {
    return this.deferState(agentId, nowMs).deferred;
  }
  deferUntil(agentId: string | undefined): number | null {
    return (agentId && this.#byAgent.get(agentId)?.deferUntilMs) || null;
  }
  pendingIntentCount(agentId?: string): number {
    if (agentId) return this.#byAgent.get(agentId)?.intents.size ?? 0;
    let total = 0;
    for (const rec of this.#byAgent.values()) total += rec.intents.size;
    return total;
  }
  deferredAgentIds(): string[] {
    const now = this.#now();
    return [...this.#byAgent.values()].filter((r) => r.deferUntilMs > now).map((r) => r.agentId);
  }

  // ── internals ──

  /** Arm a single timer to the nearest live `deferUntilMs`. Idempotent: a
   *  clear/record that changes the minimum re-arms; nothing to defer disarms. */
  #arm(): void {
    let min: number | null = null;
    for (const rec of this.#byAgent.values()) {
      if (min === null || rec.deferUntilMs < min) min = rec.deferUntilMs;
    }
    if (min === null) {
      if (this.#timer !== null) {
        this.#scheduler.clear(this.#timer);
        this.#timer = null;
        this.#timerAtMs = null;
      }
      return;
    }
    if (this.#timer !== null && this.#timerAtMs === min) return; // already armed for this instant
    if (this.#timer !== null) this.#scheduler.clear(this.#timer);
    this.#timerAtMs = min;
    const delay = Math.max(0, min - this.#now());
    this.#timer = this.#scheduler.set(() => void this.#fire(), delay);
  }

  /** Timer callback: drain every window whose reset has passed, replaying each
   *  coalesced intent exactly once, then re-arm for the next window. */
  #fire(): void {
    this.#timer = null;
    this.#timerAtMs = null;
    const now = this.#now();
    const due: AgentDeferRecord[] = [];
    for (const rec of this.#byAgent.values()) {
      if (rec.deferUntilMs <= now) due.push(rec);
    }
    for (const rec of due) this.#byAgent.delete(rec.agentId);
    if (due.length) this.#persist(); // removal persisted BEFORE replay → at-most-once
    this.#arm(); // re-arm for any still-future window
    for (const rec of due) {
      const intents = [...rec.intents.values()];
      this.#log(
        `[session-defer] window expired agent=${rec.agentId.slice(0, 8)} — replaying ${intents.length} pending intent(s) once`,
      );
      for (const it of intents) void this.#replayOne(it);
    }
  }

  async #replayOne(intent: SessionDeferIntent): Promise<void> {
    if (!this.#resume) return;
    try {
      await this.#resume(intent.raw);
    } catch (err: any) {
      this.#log(`[session-defer] resume replay threw for ${intent.key}: ${err?.message ?? err}`);
    }
  }

  #persist(): void {
    if (!this.#persistPath) return;
    const agents: Record<string, any> = {};
    for (const rec of this.#byAgent.values()) {
      const intents: Record<string, any> = {};
      for (const it of rec.intents.values()) {
        intents[it.key] = {
          raw: it.raw,
          ticketId: it.ticketId,
          role: it.role,
          agentId: it.agentId,
          firstAtMs: it.firstAtMs,
        };
      }
      agents[rec.agentId] = {
        deferUntilMs: rec.deferUntilMs,
        reason: rec.reason,
        resetLabel: rec.resetLabel,
        sinceMs: rec.sinceMs,
        intents,
      };
    }
    const body = JSON.stringify({ version: PERSIST_VERSION, agents }, null, 2);
    try {
      const tmp = `${this.#persistPath}.tmp`;
      mkdirSync(dirname(this.#persistPath), { recursive: true });
      writeFileSync(tmp, body, 'utf8');
      renameSync(tmp, this.#persistPath); // atomic replace
    } catch (err: any) {
      this.#log(`[session-defer] persist failed (${this.#persistPath}): ${err?.message ?? err}`);
    }
  }
}
