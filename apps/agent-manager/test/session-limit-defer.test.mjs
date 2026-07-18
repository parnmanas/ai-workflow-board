// Unit test — harness session-limit reset parser + durable defer store (ticket 467f714a).
//
// Covers the pure pieces that back the dispatcher gate:
//   - parseHarnessResetTime: `resets 12:30am (Asia/Seoul)` → the NEXT absolute
//     instant of that wall-clock in that tz (same-day vs roll-forward, midnight,
//     tz-less fallback), independent of the runtime's own timezone;
//   - resolveDeferUntil: parsed reset, or a conservative default, clamped;
//   - detectHarnessSessionLimit: classify + parse off an exit tail (error context
//     required — a clean exit-0 answer mentioning the words is not a limit);
//   - SessionLimitDeferStore: coalesce-to-one intent, expiry replays exactly
//     once, cancelByTicket, extend-not-shorten, and RESTART DURABILITY (persist
//     to disk → a fresh store rehydrates the window + intents and still resumes
//     exactly once).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  parseHarnessResetTime,
  resolveDeferUntil,
  detectHarnessSessionLimit,
  SessionLimitDeferStore,
  DEFAULT_SESSION_DEFER_MS,
  MAX_SESSION_DEFER_MS,
} from '../dist/lib/session-limit-defer.js';

// 2026-07-18T10:00:00Z == 2026-07-18 19:00 in Asia/Seoul (+9, no DST).
const T0 = Date.UTC(2026, 6, 18, 10, 0, 0);

// ── parseHarnessResetTime ────────────────────────────────────────────────────

test('parse: 12:30am (Asia/Seoul) at 19:00 KST → the coming midnight (rolls a day)', () => {
  const r = parseHarnessResetTime("You've hit your session limit · resets 12:30am (Asia/Seoul)", T0);
  assert.ok(r, 'parsed');
  assert.equal(r.resetLabel, '12:30am (Asia/Seoul)');
  // 00:30 KST on 2026-07-19 == 15:30 UTC on 2026-07-18.
  assert.equal(r.resetAtMs, Date.UTC(2026, 6, 18, 15, 30, 0));
  assert.ok(r.resetAtMs > T0, 'strictly in the future');
});

test('parse: 11pm (Asia/Seoul) at 19:00 KST → tonight (same local day)', () => {
  const r = parseHarnessResetTime('resets 11pm (Asia/Seoul)', T0);
  assert.ok(r);
  // 23:00 KST on 2026-07-18 == 14:00 UTC on 2026-07-18.
  assert.equal(r.resetAtMs, Date.UTC(2026, 6, 18, 14, 0, 0));
});

test('parse: 6pm (Asia/Seoul) already passed at 19:00 KST → rolls to tomorrow', () => {
  const r = parseHarnessResetTime('resets 6pm (Asia/Seoul)', T0);
  assert.ok(r);
  // 18:00 KST on 2026-07-19 == 09:00 UTC on 2026-07-19.
  assert.equal(r.resetAtMs, Date.UTC(2026, 6, 19, 9, 0, 0));
});

test('parse: a different tz resolves against THAT tz, not the runtime local', () => {
  // 3pm America/New_York (EDT, -4) on 2026-07-18 == 19:00 UTC. now is 10:00 UTC → future.
  const r = parseHarnessResetTime('resets 3pm (America/New_York)', T0);
  assert.ok(r);
  assert.equal(r.resetAtMs, Date.UTC(2026, 6, 18, 19, 0, 0));
});

test('parse: no timezone → a future instant within 24h (runtime-local, no exact assert)', () => {
  const r = parseHarnessResetTime('resets 12:30am', T0);
  assert.ok(r, 'still parses without a tz');
  assert.ok(r.resetAtMs > T0);
  assert.ok(r.resetAtMs <= T0 + 24 * 60 * 60_000);
});

test('parse: no reset phrase → null', () => {
  assert.equal(parseHarnessResetTime('some normal agent output', T0), null);
  assert.equal(parseHarnessResetTime('', T0), null);
  assert.equal(parseHarnessResetTime(null, T0), null);
});

// ── resolveDeferUntil ────────────────────────────────────────────────────────

test('resolveDeferUntil: parsed reset passes through; null → default window; clamped to max', () => {
  const parsed = T0 + 2 * 60 * 60_000;
  assert.equal(resolveDeferUntil(T0, parsed), parsed, 'a sane parsed reset is used verbatim');
  assert.equal(resolveDeferUntil(T0, null), T0 + DEFAULT_SESSION_DEFER_MS, 'null → conservative default');
  assert.equal(resolveDeferUntil(T0, T0 - 5000), T0 + DEFAULT_SESSION_DEFER_MS, 'a past reset → default (never a zero/negative window)');
  assert.equal(resolveDeferUntil(T0, T0 + 24 * 60 * 60_000), T0 + MAX_SESSION_DEFER_MS, 'an absurd reset is clamped to the max window');
});

// ── detectHarnessSessionLimit ────────────────────────────────────────────────

test('detect: the incident tail (exit 1) → session_limit with parsed reset', () => {
  const tail =
    "assistant: You've hit your session limit · resets 12:30am (Asia/Seoul)\n" +
    'result: subtype=success is_error=true turns=1 — ' +
    "You've hit your session limit · resets 12:30am (Asia/Seoul)";
  const d = detectHarnessSessionLimit(tail, 1, T0);
  assert.ok(d);
  assert.equal(d.reason, 'session_limit');
  assert.equal(d.resetLabel, '12:30am (Asia/Seoul)');
  assert.equal(d.deferUntilMs, Date.UTC(2026, 6, 18, 15, 30, 0));
});

test('detect: session-limit signature but no reset time → default window', () => {
  const d = detectHarnessSessionLimit('session limit reached, try again later', 1, T0);
  assert.ok(d);
  assert.equal(d.resetLabel, '');
  assert.equal(d.deferUntilMs, T0 + DEFAULT_SESSION_DEFER_MS);
});

test('detect: non-session output, or a clean exit-0 mention → null', () => {
  assert.equal(detectHarnessSessionLimit('normal work, all done', 1, T0), null);
  assert.equal(
    detectHarnessSessionLimit('Added a session limit banner to settings.', 0, T0),
    null,
    'exit 0 with no error context is not a limit',
  );
});

// ── SessionLimitDeferStore: coalesce + expiry ────────────────────────────────

function manualScheduler() {
  const timers = new Map();
  let id = 0;
  return {
    api: {
      set(fn, ms) {
        const h = ++id;
        timers.set(h, { fn, ms });
        return h;
      },
      clear(h) {
        timers.delete(h);
      },
    },
    armed: () => timers.size,
    fire() {
      const snap = [...timers.values()];
      timers.clear();
      for (const t of snap) t.fn();
    },
  };
}

const AGENT = 'agent-rolf';
const meta = (ticketId, role = 'assignee') => ({ ticketId, role, agentId: AGENT });

const settle = () => new Promise((r) => setImmediate(r));

test('store: coalesce many re-dispatches of one ticket-role into a SINGLE intent, replay once at reset', async () => {
  const nowRef = { v: T0 };
  const sched = manualScheduler();
  const replays = [];
  const store = new SessionLimitDeferStore({
    now: () => nowRef.v,
    scheduler: sched.api,
    persistPath: null,
  });
  store.setResumeHandler((intent) => replays.push(intent.raw));

  const until = T0 + 60 * 60_000;
  assert.deepEqual(store.recordSessionLimit(AGENT, { deferUntilMs: until, resetLabel: '11am (X)' }), {
    opened: true,
  });
  assert.equal(store.isDeferred(AGENT), true);
  assert.equal(sched.armed(), 1, 'an expiry timer is armed');

  // Six re-dispatches for the SAME (ticket, role) — the d34075b5 storm shape.
  let created = 0;
  for (let i = 0; i < 6; i++) {
    const { created: c } = store.addPendingIntent(AGENT, meta('T-1'), `raw-${i}`);
    if (c) created++;
  }
  assert.equal(created, 1, 'only the FIRST coalesced into a new intent (audit comment fires once)');
  assert.equal(store.pendingIntentCount(AGENT), 1, 'exactly one pending intent — no twin at reset');

  // A DIFFERENT ticket deferred too → its own intent.
  store.addPendingIntent(AGENT, meta('T-2'), 'raw-t2');
  assert.equal(store.pendingIntentCount(AGENT), 2);

  // Reset fires: replay each intent EXACTLY once, window clears. The replay is
  // dispatched synchronously (freshest raw pushed), but the durable-outbox ACK
  // that removes the intent lands on the next microtask (blocker #3: remove AFTER
  // acknowledged), so drain the microtask queue before asserting the drained count.
  nowRef.v = until + 1;
  sched.fire();
  assert.equal(replays.length, 2, 'exactly one replay per deferred ticket-role');
  assert.equal(replays[0], 'raw-5', 'the freshest coalesced raw is replayed (not a stale one)');
  assert.ok(replays.includes('raw-t2'));
  assert.equal(store.isDeferred(AGENT), false, 'window cleared after reset');
  await settle();
  assert.equal(store.pendingIntentCount(AGENT), 0, 'intents drained (acknowledged)');
});

test('store: a non-deferred agent never coalesces (gate no-op)', () => {
  const store = new SessionLimitDeferStore({ now: () => T0, persistPath: null });
  assert.equal(store.isDeferred(AGENT), false);
  assert.deepEqual(store.addPendingIntent(AGENT, meta('T-1'), 'raw'), { created: false });
  assert.equal(store.pendingIntentCount(AGENT), 0);
});

test('store: cancelByTicket drops that ticket’s intents but keeps the window + other tickets', () => {
  const nowRef = { v: T0 };
  const sched = manualScheduler();
  const replays = [];
  const store = new SessionLimitDeferStore({ now: () => nowRef.v, scheduler: sched.api, persistPath: null });
  store.setResumeHandler((intent) => replays.push(intent.raw));

  const until = T0 + 60 * 60_000;
  store.recordSessionLimit(AGENT, { deferUntilMs: until });
  store.addPendingIntent(AGENT, meta('T-1'), 'raw-1');
  store.addPendingIntent(AGENT, meta('T-2'), 'raw-2');
  assert.equal(store.pendingIntentCount(AGENT), 2);

  assert.equal(store.cancelByTicket('T-1'), 1, 'one intent cancelled');
  assert.equal(store.pendingIntentCount(AGENT), 1);
  assert.equal(store.isDeferred(AGENT), true, 'the window itself survives (other tickets still deferred)');

  nowRef.v = until + 1;
  sched.fire();
  assert.deepEqual(replays, ['raw-2'], 'the cancelled ticket never replays; the other does, once');
});

test('store: recordSessionLimit extends to a LATER reset but never shortens', () => {
  const nowRef = { v: T0 };
  const store = new SessionLimitDeferStore({ now: () => nowRef.v, scheduler: manualScheduler().api, persistPath: null });
  store.recordSessionLimit(AGENT, { deferUntilMs: T0 + 60 * 60_000, resetLabel: 'early' });
  // A later reset extends.
  store.recordSessionLimit(AGENT, { deferUntilMs: T0 + 120 * 60_000, resetLabel: 'late' });
  assert.equal(store.deferUntil(AGENT), T0 + 120 * 60_000);
  assert.equal(store.deferState(AGENT).resetLabel, 'late', 'the later reset label is adopted');
  // An earlier reset is ignored (never shortens a live defer).
  store.recordSessionLimit(AGENT, { deferUntilMs: T0 + 30 * 60_000, resetLabel: 'earlier' });
  assert.equal(store.deferUntil(AGENT), T0 + 120 * 60_000, 'window not shortened');
});

// ── SessionLimitDeferStore: RESTART DURABILITY ───────────────────────────────

test('store: persists + rehydrates across a "restart" and still resumes exactly once', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'awb-session-defer-'));
  const persistPath = join(dir, 'session-defer.json');
  try {
    const nowRef = { v: T0 };
    const until = T0 + 90 * 60_000;

    // ── manager instance A: opens a window + coalesces two intents, then "dies". ──
    const schedA = manualScheduler();
    const a = new SessionLimitDeferStore({ now: () => nowRef.v, scheduler: schedA.api, persistPath });
    a.setResumeHandler(() => assert.fail('A must not replay — it dies before reset'));
    a.load();
    a.recordSessionLimit(AGENT, { deferUntilMs: until, resetLabel: '12:30am (Asia/Seoul)' });
    a.addPendingIntent(AGENT, meta('T-1'), 'raw-A1');
    a.addPendingIntent(AGENT, meta('T-2'), 'raw-A2');
    assert.ok(existsSync(persistPath), 'the defer state was written to disk');
    const onDisk = JSON.parse(readFileSync(persistPath, 'utf8'));
    assert.equal(onDisk.agents[AGENT].deferUntilMs, until);
    assert.equal(Object.keys(onDisk.agents[AGENT].intents).length, 2);

    // ── manager instance B: fresh store, same disk file, still BEFORE reset. ──
    const schedB = manualScheduler();
    const replays = [];
    const b = new SessionLimitDeferStore({ now: () => nowRef.v, scheduler: schedB.api, persistPath });
    b.setResumeHandler((intent) => replays.push(intent.raw));
    b.load();
    assert.equal(b.isDeferred(AGENT), true, 'the window survived the restart');
    assert.equal(b.pendingIntentCount(AGENT), 2, 'both coalesced intents survived the restart');
    assert.equal(schedB.armed(), 1, 're-armed the expiry timer from the persisted reset');

    // Reset instant arrives → B replays each intent EXACTLY once.
    nowRef.v = until + 1;
    schedB.fire();
    assert.equal(replays.length, 2, 'restart-persisted intents resume exactly once');
    assert.deepEqual(replays.sort(), ['raw-A1', 'raw-A2']);
    assert.equal(b.isDeferred(AGENT), false);
    // Outbox (blocker #3): the `dispatching` transition is persisted BEFORE the
    // replay's ACK removes the intent, so at THIS instant (ack still pending on the
    // microtask queue) the intents are on disk as 'dispatching' — a crash here loses
    // nothing.
    const mid = JSON.parse(readFileSync(persistPath, 'utf8'));
    assert.equal(Object.keys(mid.agents[AGENT].intents).length, 2, 'intents still on disk mid-drain');
    for (const it of Object.values(mid.agents[AGENT].intents)) {
      assert.equal(it.status, 'dispatching', 'persisted as dispatching before ack');
    }
    // Let the ACKs settle → a SECOND restart replays nothing (exactly-once).
    await new Promise((r) => setImmediate(r));
    const after = JSON.parse(readFileSync(persistPath, 'utf8'));
    assert.equal(Object.keys(after.agents).length, 0, 'the acknowledged window was removed from disk');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('store: a window that ALREADY expired while the manager was down replays on the next tick', () => {
  const dir = mkdtempSync(join(tmpdir(), 'awb-session-defer-'));
  const persistPath = join(dir, 'session-defer.json');
  try {
    const nowRef = { v: T0 };
    const until = T0 + 30 * 60_000;
    const schedA = manualScheduler();
    const a = new SessionLimitDeferStore({ now: () => nowRef.v, scheduler: schedA.api, persistPath });
    a.setResumeHandler(() => {});
    a.load();
    a.recordSessionLimit(AGENT, { deferUntilMs: until });
    a.addPendingIntent(AGENT, meta('T-1'), 'raw-late');

    // Manager was down PAST the reset — B boots with now already beyond deferUntil.
    nowRef.v = until + 5 * 60_000;
    const schedB = manualScheduler();
    const replays = [];
    const b = new SessionLimitDeferStore({ now: () => nowRef.v, scheduler: schedB.api, persistPath });
    b.setResumeHandler((intent) => replays.push(intent.raw));
    b.load();
    // load() arms a (delay 0) timer for the already-past window; firing it replays.
    assert.equal(schedB.armed(), 1, 'an immediate timer is armed for the past-due window');
    schedB.fire();
    assert.deepEqual(replays, ['raw-late'], 'the missed resume fires once on boot');
    assert.equal(b.isDeferred(AGENT), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── blocker #3: crash BETWEEN the drain-persist and the replay ack ────────────
// The old code deleted+persisted the intent BEFORE dispatching the replay, so a
// crash in that window lost the resume forever (at-most-once). The durable outbox
// persists a `dispatching` state before the replay and removes only after the ack,
// so a crash mid-replay leaves the intent recoverable → re-driven EXACTLY once on
// restart, with the ack making a further restart a no-op (no twin / no repeat).
test('store: crash right after the drain-persist (before replay ack) → restart re-drives EXACTLY once, no loss/twin', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'awb-session-defer-'));
  const persistPath = join(dir, 'session-defer.json');
  try {
    const nowRef = { v: T0 };
    const until = T0 + 45 * 60_000;

    // ── instance A: at reset #fire persists 'dispatching', then the replay HANGS
    //    (never acks) — models a crash between the persist and the ack. ──
    const schedA = manualScheduler();
    const aReplays = [];
    const a = new SessionLimitDeferStore({ now: () => nowRef.v, scheduler: schedA.api, persistPath });
    a.setResumeHandler((intent) => {
      aReplays.push(intent.raw);
      return new Promise(() => {}); // never resolves → the ack never runs (crash)
    });
    a.load();
    a.recordSessionLimit(AGENT, { deferUntilMs: until, resetLabel: '3am (X)' });
    a.addPendingIntent(AGENT, meta('T-crash'), 'raw-crash');

    nowRef.v = until + 1;
    schedA.fire(); // transition→dispatching + PERSIST, then the replay hangs
    assert.equal(aReplays.length, 1, 'A initiated the replay');
    // Old behavior would have deleted the intent here → total loss. The outbox keeps
    // it on disk as 'dispatching'.
    const mid = JSON.parse(readFileSync(persistPath, 'utf8'));
    assert.equal(Object.keys(mid.agents[AGENT].intents).length, 1, 'intent survived on disk (not deleted pre-replay)');
    assert.equal(Object.values(mid.agents[AGENT].intents)[0].status, 'dispatching');

    // ── instance B: fresh store, same disk, still past reset. A's hung replay left
    //    the intent un-acked → B re-drives it exactly once (fresh #inFlightReplay). ──
    const schedB = manualScheduler();
    const bReplays = [];
    const b = new SessionLimitDeferStore({ now: () => nowRef.v, scheduler: schedB.api, persistPath });
    b.setResumeHandler((intent) => bReplays.push(intent.raw));
    b.load();
    assert.equal(schedB.armed(), 1, 'boot armed an immediate drain for the un-acked dispatching intent');
    schedB.fire();
    assert.deepEqual(bReplays, ['raw-crash'], 're-driven exactly once (no loss)');
    await settle();
    const after = JSON.parse(readFileSync(persistPath, 'utf8'));
    assert.equal(Object.keys(after.agents).length, 0, 'acknowledged + removed after the successful re-drive');

    // ── instance C boots clean → nothing to replay (proves no duplicate / no twin). ──
    const schedC = manualScheduler();
    const cReplays = [];
    const c = new SessionLimitDeferStore({ now: () => nowRef.v, scheduler: schedC.api, persistPath });
    c.setResumeHandler((intent) => cReplays.push(intent.raw));
    c.load();
    if (schedC.armed()) schedC.fire();
    assert.deepEqual(cReplays, [], 'no duplicate re-drive after acknowledgement (exactly-once across restarts)');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
