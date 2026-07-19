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

/** How a coalesced intent is replayed at reset — a full ticket trigger
 *  (re-drives the ticket-role via handleTrigger, re-acquiring the twin
 *  reservation) or a comment mention (re-delivered via handleCommentMention).
 *  A `trigger` is the authoritative full re-drive: a `mention` for the same
 *  (ticket, role, agent) coalesces INTO an existing trigger intent and never
 *  downgrades it. */
export type SessionDeferIntentKind = 'trigger' | 'mention';

/** Durable outbox status of a coalesced intent (ticket 467f714a blocker #3).
 *   - `pending`     — waiting for the reset instant.
 *   - `dispatching` — the window fired and a replay was INITIATED; the store
 *     persists this transition BEFORE the replay runs, so a crash mid-replay
 *     leaves the intent recoverable on disk (re-driven on the next boot) instead
 *     of lost. The intent is REMOVED only after the replay is acknowledged
 *     (handed off to handleTrigger/handleCommentMention without throwing) — that
 *     removal is the terminal `acknowledged` state.
 *
 *     Exactly-once across a crash-AFTER-spawn is NOT guaranteed by the (ticket,
 *     role, agent) `key` alone: the single-flight reservation it re-acquires is
 *     PROCESS-LOCAL, so a spawn that happened just before the crash left a
 *     DETACHED child alive that the rebooted manager's fresh reservation map
 *     knows nothing about → re-driving would twin. The durable fix is the
 *     `spawnedPid` recorded on the intent the instant the replay spawns (see
 *     {@link SessionDeferIntent.spawnedPid}): boot reaps that pid BEFORE
 *     re-driving, so the re-drive is always the only surviving session. */
export type SessionDeferIntentStatus = 'pending' | 'dispatching';

/** One coalesced pending intent — the freshest raw trigger/mention to replay for
 *  a deferred (ticket, role, agent), keyed identically to the twin guard so a
 *  replay re-acquires the same single-flight reservation. */
export interface SessionDeferIntent {
  key: string;
  raw: string;
  ticketId: string;
  role: string;
  agentId: string;
  firstAtMs: number;
  /** Replay vehicle — see {@link SessionDeferIntentKind}. */
  kind: SessionDeferIntentKind;
  /** Durable outbox status — see {@link SessionDeferIntentStatus}. */
  status: SessionDeferIntentStatus;
  /** OS pid of the harness this intent's replay spawned, recorded (and PERSISTED)
   *  the instant the resume handler reports a successful spawn — the durable
   *  handle that makes the outbox exactly-once across a crash-after-spawn (blocker
   *  #3). A detached harness survives the manager's death; on the next boot a
   *  rehydrated `dispatching` intent carrying a `spawnedPid` is REAPED before it is
   *  re-driven, so the re-drive is the only live session (no twin). null/undefined
   *  = the replay had not yet spawned when persisted (crash before spawn — nothing
   *  to reap, the plain re-drive is correct). */
  spawnedPid?: number | null;
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

/** Replay one coalesced intent at reset. Receives the WHOLE intent so the caller
 *  routes by `kind` (trigger → handleTrigger, mention → handleCommentMention).
 *  Resolving = acknowledged (the store then removes the intent + persists);
 *  throwing leaves it `dispatching` for the next-boot re-drive.
 *
 *  The resolved value MAY carry the OS `pid` the replay spawned. The store
 *  records it on the intent the instant the handler reports it (via `onSpawned`,
 *  wired below) so a crash between spawn and ack leaves a REAPABLE pid on disk
 *  (blocker #3). Returning void / no pid means no durable spawn to reap. */
export type SessionDeferResumeResult = { pid?: number | null } | void;
export type SessionDeferResumeHandler = (
  intent: SessionDeferIntent,
  onSpawned: (pid: number | null | undefined) => void,
) => Promise<SessionDeferResumeResult> | SessionDeferResumeResult;

/** Terminate an already-spawned, still-surviving detached harness by pid before
 *  its intent is re-driven on boot (blocker #3). Returns true if the pid was live
 *  and signalled (best-effort — a dead/unknown pid is a no-op true). Injected for
 *  test determinism; defaults to a SIGTERM→SIGKILL reaper. */
export type SessionDeferReapPid = (pid: number) => boolean;

/** Default best-effort reaper: SIGTERM the survivor, then SIGKILL after a short
 *  grace. Swallows ESRCH (already gone) — a missing pid is a successful reap. */
const defaultReapPid: SessionDeferReapPid = (pid) => {
  if (!pid || pid <= 1) return false;
  try {
    process.kill(pid, 'SIGTERM');
  } catch (err: any) {
    if (err?.code === 'ESRCH') return true; // already gone
    return false;
  }
  const t = setTimeout(() => {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* already gone */
    }
  }, 2_000);
  (t as any)?.unref?.();
  return true;
};

export interface SessionLimitDeferStoreOptions {
  /** Absolute path of the JSON persistence file. null → in-memory only (tests). */
  persistPath?: string | null;
  /** Injected clock (test determinism). Defaults to Date.now. */
  now?: () => number;
  /** Injected timer surface (test determinism). Defaults to unref'd setTimeout. */
  scheduler?: RetryScheduler;
  /** Injected reaper for a crash-surviving spawned harness (blocker #3). Defaults
   *  to a SIGTERM→SIGKILL process reaper; overridden in tests with a fake that
   *  records/removes a live-pid handle. */
  reapPid?: SessionDeferReapPid;
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

// v2 (ticket 467f714a blocker #3) adds per-intent `kind` + `status`. load()
// does not gate on the version — a v1 file rehydrates via field defaults
// (kind='trigger', status='pending') — so the bump is purely documentary.
const PERSIST_VERSION = 2;

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
 * ── durability (outbox, ticket 467f714a blocker #3) ──
 * The whole structure (windows + intents + per-intent `status`) is persisted
 * atomically to `persistPath` on every mutation and rehydrated by `load()` at
 * boot, which re-arms the timer from the persisted `deferUntilMs`. A window that
 * elapsed while the manager was down replays on the next tick.
 *
 * Exactly-once across a crash uses a durable outbox instead of remove-before-
 * replay: at reset `#fire` transitions each due intent `pending → dispatching`
 * and PERSISTS that before running the replay, then removes the intent only
 * after the replay is acknowledged (`#resume` resolved). So the on-disk state at
 * ANY crash instant reflects an un-acked intent, and the intent carries the pid
 * of any harness its replay already spawned (`spawnedPid`, persisted the instant
 * the spawn is reported):
 *   - crash after the dispatching-persist, BEFORE the replay spawned → boot finds
 *     it `dispatching` with no `spawnedPid`; nothing was launched, so it is simply
 *     re-driven once (no loss — the old remove-first bug);
 *   - crash AFTER the replay spawned, before the ack-remove → the spawn was
 *     DETACHED and outlived the manager. The `spawnedPid` on disk is that live
 *     survivor. `load()` collects those pids into `#bootDispatching`, and
 *     `#replayOne` REAPS the pid (SIGTERM→SIGKILL) BEFORE re-driving — so the
 *     re-drive is again the only live session (no twin). The process-local
 *     single-flight reservation can't see a cross-restart survivor, which is
 *     exactly why the durable pid + boot reap is required.
 * `#inFlightReplay` (in-memory, NOT persisted) holds the keys whose replay was
 * initiated this lifetime so `#arm`/`#fire` never hot-loop a still-draining intent;
 * it starts empty on boot, which is exactly what lets a rehydrated `dispatching`
 * intent be re-driven once. `#bootDispatching` (also in-memory) marks the subset
 * of those that were rehydrated with a `spawnedPid` needing a one-time boot reap.
 */
export class SessionLimitDeferStore {
  #byAgent = new Map<string, AgentDeferRecord>();
  /** Keys whose replay was INITIATED this lifetime (blocker #3). In-memory only
   *  — deliberately NOT persisted, so a restart re-drives any intent left
   *  `dispatching` on disk. Prevents `#arm`/`#fire` from hot-looping an intent
   *  that is mid-drain within the same lifetime. */
  #inFlightReplay = new Set<string>();
  /** Keys rehydrated at boot as `dispatching` WITH a `spawnedPid` — a crash-
   *  surviving detached harness that must be REAPED once before the intent is
   *  re-driven (blocker #3). In-memory only; drained by `#replayOne`. */
  #bootDispatching = new Set<string>();
  #resume: SessionDeferResumeHandler | null = null;
  #timer: unknown | null = null;
  #timerAtMs: number | null = null;
  #now: () => number;
  #scheduler: RetryScheduler;
  #reapPid: SessionDeferReapPid;
  #persistPath: string | null;
  #log: (msg: string) => void;

  constructor(opts: SessionLimitDeferStoreOptions = {}) {
    this.#now = opts.now ?? (() => Date.now());
    this.#scheduler = opts.scheduler ?? defaultScheduler;
    this.#reapPid = opts.reapPid ?? defaultReapPid;
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
          const status: SessionDeferIntentStatus =
            it.status === 'dispatching' ? 'dispatching' : 'pending';
          const spawnedPid =
            typeof it.spawnedPid === 'number' && it.spawnedPid > 1 ? it.spawnedPid : null;
          intents.set(key, {
            key,
            raw: it.raw,
            ticketId: String(it.ticketId ?? ''),
            role: String(it.role ?? ''),
            agentId: String(it.agentId ?? agentId),
            firstAtMs: Number(it.firstAtMs) || this.#now(),
            // Missing kind/status (pre-blocker-#3 files) default to a pending
            // trigger. A rehydrated `dispatching` intent = a crash mid-drain →
            // re-driven once on the next tick (#inFlightReplay starts empty).
            kind: it.kind === 'mention' ? 'mention' : 'trigger',
            status,
            spawnedPid,
          });
          // A `dispatching` intent that carries a spawned pid = the pre-crash
          // replay launched a detached harness that outlived the manager. Mark it
          // for a one-time boot reap so `#replayOne` terminates that survivor
          // BEFORE re-driving (blocker #3 — durable exactly-once).
          if (status === 'dispatching' && spawnedPid) this.#bootDispatching.add(key);
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

  /** Coalesce a deferred re-dispatch (supervisor trigger, exit-time seed, or
   *  comment mention) into the SINGLE pending intent for its (ticket, role,
   *  agent). A repeat only refreshes the raw payload (freshest context) — it
   *  never stacks a second entry, so exactly one replay fires at reset and no
   *  twin is possible. `kind` selects the replay vehicle; a `trigger` is the
   *  authoritative full re-drive, so it upgrades an existing `mention` intent
   *  (never the reverse) — that is how a supervisor trigger and a role mention
   *  for the same ticket-role collapse into ONE replay. No-op (created:false)
   *  when the agent has no live window. Returns whether a NEW intent was created
   *  — the caller posts its one-time audit comment only then. */
  addPendingIntent(
    agentId: string | undefined,
    meta: InflightDispatchMeta,
    raw: string,
    opts?: { kind?: SessionDeferIntentKind; nowMs?: number },
  ): { created: boolean } {
    if (!agentId) return { created: false };
    const rec = this.#byAgent.get(agentId);
    const now = opts?.nowMs ?? this.#now();
    // A live window is required — while open, every intent is `pending` (the
    // drain in #fire only runs at/after expiry), so no status handling here.
    if (!rec || rec.deferUntilMs <= now) return { created: false };
    const kind = opts?.kind ?? 'trigger';
    const key = InflightDispatchTracker.key(meta.ticketId, meta.role, meta.agentId);
    const existing = rec.intents.get(key);
    if (existing) {
      if (kind === 'trigger') {
        // Trigger is the full re-drive — adopt it and refresh the raw, upgrading
        // a prior mention-only intent.
        existing.kind = 'trigger';
        existing.raw = raw;
      } else if (existing.kind === 'mention') {
        // Mention refreshing a mention → freshest mention wins; never downgrade
        // an existing trigger.
        existing.raw = raw;
      }
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
      kind,
      status: 'pending',
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
          this.#inFlightReplay.delete(key);
          this.#bootDispatching.delete(key);
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
    if (!agentId) return;
    const rec = this.#byAgent.get(agentId);
    if (rec)
      for (const key of rec.intents.keys()) {
        this.#inFlightReplay.delete(key);
        this.#bootDispatching.delete(key);
      }
    if (this.#byAgent.delete(agentId)) {
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

  /** Arm a single timer. A window with a FUTURE reset arms to the nearest such
   *  instant. An ALREADY-EXPIRED window that still holds an intent not yet being
   *  replayed this lifetime (a boot-rehydrated one, or one just left `dispatching`
   *  by a crash) needs an IMMEDIATE drain tick — that wins over any future window.
   *  Idempotent: `#timerAtMs` (0 = the immediate-drain sentinel; deferUntilMs is
   *  always a large epoch, never 0) guards against re-arm churn, and an intent
   *  already in `#inFlightReplay` no longer counts as needing a drain, so #fire
   *  can never hot-loop the intent it just transitioned. */
  #arm(): void {
    const now = this.#now();
    let minFuture: number | null = null;
    let immediate = false;
    for (const rec of this.#byAgent.values()) {
      if (rec.deferUntilMs > now) {
        if (minFuture === null || rec.deferUntilMs < minFuture) minFuture = rec.deferUntilMs;
        continue;
      }
      if (!immediate) {
        for (const it of rec.intents.values()) {
          if (!this.#inFlightReplay.has(it.key)) {
            immediate = true;
            break;
          }
        }
      }
    }
    const target = immediate ? 0 : minFuture;
    if (target === null) {
      if (this.#timer !== null) {
        this.#scheduler.clear(this.#timer);
        this.#timer = null;
        this.#timerAtMs = null;
      }
      return;
    }
    if (this.#timer !== null && this.#timerAtMs === target) return; // already armed for this instant
    if (this.#timer !== null) this.#scheduler.clear(this.#timer);
    this.#timerAtMs = target;
    const delay = immediate ? 0 : Math.max(0, (minFuture as number) - now);
    this.#timer = this.#scheduler.set(() => void this.#fire(), delay);
  }

  /** Timer callback: drain every window whose reset has passed. Each due intent
   *  is transitioned `pending → dispatching` and that transition is PERSISTED
   *  BEFORE any replay runs (blocker #3 — a crash now leaves the intent on disk
   *  as un-acked, re-driven on the next boot, instead of the old remove-first
   *  loss). Intents already in `#inFlightReplay` (mid-drain this lifetime) are
   *  skipped so a re-`#arm` can never double-fire them. */
  #fire(): void {
    this.#timer = null;
    this.#timerAtMs = null;
    const now = this.#now();
    const toReplay: SessionDeferIntent[] = [];
    for (const rec of this.#byAgent.values()) {
      if (rec.deferUntilMs > now) continue; // window still live — not due
      for (const it of rec.intents.values()) {
        if (this.#inFlightReplay.has(it.key)) continue; // already draining this lifetime
        it.status = 'dispatching';
        this.#inFlightReplay.add(it.key);
        toReplay.push(it);
      }
    }
    if (toReplay.length) this.#persist(); // dispatching state persisted BEFORE replay
    this.#arm(); // re-arm for future windows only (drained intents now in-flight)
    for (const it of toReplay) {
      this.#log(
        `[session-defer] window expired agent=${it.agentId.slice(0, 8)} — replaying ${it.kind} intent ${it.key} once`,
      );
      void this.#replayOne(it);
    }
  }

  async #replayOne(intent: SessionDeferIntent): Promise<void> {
    if (!this.#resume) {
      this.#inFlightReplay.delete(intent.key);
      return;
    }
    // Blocker #3 — crash-after-spawn reap. If this intent was rehydrated as
    // `dispatching` with a live spawned pid, a detached harness from the pre-crash
    // replay is still running (the process-local single-flight reservation can't
    // see it across the restart). Reap it BEFORE re-driving so the re-drive is the
    // ONLY surviving session — durable exactly-once, no twin.
    if (this.#bootDispatching.delete(intent.key) && intent.spawnedPid) {
      const pid = intent.spawnedPid;
      this.#log(
        `[session-defer] boot-reaping crash-surviving harness pid=${pid} for ${intent.key} before re-drive`,
      );
      try {
        this.#reapPid(pid);
      } catch (err: any) {
        this.#log(`[session-defer] reap pid=${pid} for ${intent.key} failed: ${err?.message ?? err}`);
      }
      // The survivor is gone; clear the stale pid so a re-persist mid-replay does
      // not mark it reapable a second time.
      intent.spawnedPid = null;
    }
    // Record the freshly-spawned harness pid the instant the replay reports it, so
    // a crash between spawn and ack leaves a reapable pid on disk for the next boot.
    const onSpawned = (pid: number | null | undefined): void => {
      const rec = this.#byAgent.get(intent.agentId);
      const live = rec?.intents.get(intent.key);
      if (!live || live.status !== 'dispatching') return; // acked/cancelled meanwhile
      live.spawnedPid = typeof pid === 'number' && pid > 1 ? pid : null;
      intent.spawnedPid = live.spawnedPid;
      this.#persist();
    };
    try {
      const result = await this.#resume(intent, onSpawned);
      // A resolved result may carry a pid the handler did not surface via onSpawned
      // (e.g. a synchronous spawn). Fold it in before ack so any crash window is
      // covered even without the callback — belt-and-suspenders.
      if (result && typeof result === 'object' && 'pid' in result) onSpawned(result.pid);
      // Acknowledged — the replay was handed off without throwing. Remove the
      // intent (terminal state) and persist so a later restart never replays it.
      this.#ackIntent(intent);
    } catch (err: any) {
      // Replay threw — leave the intent `dispatching` on disk (do NOT ack) so the
      // next boot re-drives it. Keep the key in #inFlightReplay so it is not
      // hot-re-fired THIS lifetime (no live timer exists after expiry; the server
      // supervisor's own post-reset re-push also covers it).
      this.#log(`[session-defer] resume replay threw for ${intent.key}: ${err?.message ?? err}`);
    }
  }

  /** Terminal `acknowledged` transition: drop a replayed intent (and its now-empty
   *  expired window), release its in-flight key, and persist — so the drain is
   *  durable and exactly-once across a restart. */
  #ackIntent(intent: SessionDeferIntent): void {
    this.#inFlightReplay.delete(intent.key);
    this.#bootDispatching.delete(intent.key);
    const rec = this.#byAgent.get(intent.agentId);
    if (rec) {
      rec.intents.delete(intent.key);
      // Drop a fully-drained, expired window; keep one that re-opened (a later
      // session-limit death extended it) so its fresh intents still fire.
      if (rec.intents.size === 0 && rec.deferUntilMs <= this.#now()) {
        this.#byAgent.delete(intent.agentId);
      }
    }
    this.#persist();
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
          kind: it.kind,
          status: it.status,
          // Persist the spawned pid so a crash between spawn and ack leaves a
          // reapable survivor handle for the next boot (blocker #3).
          spawnedPid: it.spawnedPid ?? null,
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
