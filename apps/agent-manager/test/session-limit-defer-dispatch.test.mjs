// Integration test — harness session-limit defer, driven through the REAL
// EventDispatcher (ticket 467f714a).
//
// Proves the completion criteria end-to-end against the real handleTrigger /
// handleCommentMention / handleBoardUpdate paths + the injected durable store:
//   (1) a session-limit exit (recordHarnessSessionLimit — the seam main.ts wires
//       the ticket-session / one-shot exit handlers to) opens a per-agent defer
//       window; every supervisor/mention re-dispatch in the window is COALESCED
//       into a SINGLE pending intent per (ticket, role, agent) — NO spawn, NO twin
//       — with exactly one audit-visible defer comment per deferred ticket-role;
//   (2) at the reset instant each coalesced ticket-role resumes EXACTLY ONCE
//       (replayed through handleTrigger, which re-acquires the twin reservation),
//       the window clears, and nothing is left queued;
//   (3) an explicit operator `manual` trigger BYPASSES the window (escape hatch);
//   (4) a comment_mention is suppressed while deferred (no futile one-shot spawn);
//   (5) a moved ticket cancels its pending resume intent.
//
// Harness mirrors pool-exhausted-recovery.test.mjs: a stateful /mcp mock so the
// audit comment is asserted for real, a faithful single-flight subagentManager
// fake (findDuplicateSpawn) so a twin would be observable, and an injected manual
// scheduler + clock on the defer store so the reset is driven deterministically.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { EventDispatcher } from '../dist/lib/event-dispatcher.js';
import { SessionLimitDeferStore } from '../dist/lib/session-limit-defer.js';
import { findDuplicateSpawn } from '../dist/lib/subagent-manager.js';

const AGENT = 'agent-rolf';
const T0 = Date.UTC(2026, 6, 18, 10, 0, 0);
const settle = () => new Promise((r) => setImmediate(r));

function makeCtx() {
  return {
    agent_id: AGENT,
    name: 'Rolf',
    cli: 'claude',
    working_dir: '/ws',
    mcp_config_path: '/cfg/mcp.json',
    api_key: 'k',
    cli_home_dir: '/cli-home/rolf',
    extra_env: {},
    credential_provider: null,
    model: null,
  };
}

let originalFetch;
let mcpToolCalls;
let ticketState;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  mcpToolCalls = [];
  ticketState = { pending_user_action: false, terminal_entered_at: null };
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    const method = init?.method || 'GET';
    if (u.endsWith('/mcp')) {
      if (method === 'DELETE') return new Response('{}', { status: 200 });
      const body = init?.body ? JSON.parse(init.body) : {};
      if (body.method === 'initialize') {
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }), {
          status: 200,
          headers: { 'mcp-session-id': 'sid-test', 'content-type': 'application/json' },
        });
      }
      if (body.method === 'tools/call') {
        mcpToolCalls.push({ name: body.params?.name, args: body.params?.arguments ?? {} });
        return new Response(
          JSON.stringify({ jsonrpc: '2.0', id: 2, result: { content: [{ type: 'text', text: '{}' }] } }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response('', { status: 202 });
    }
    if (u.includes('/api/agent/tickets/')) {
      return new Response(JSON.stringify(ticketState), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  };
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

// Faithful single-flight subagentManager — a twin would show as a second spawn.
// `liveSet` (optional) models the set of ACTUALLY-alive OS processes: a spawn
// adds its pid, and `state.reapPid(pid)` removes it (a SIGTERM reaping a detached
// survivor). Distinct from `records` (the PROCESS-LOCAL dedup map, which a fresh
// manager boot starts empty) so a crash-surviving detached child can be modelled
// as "alive in the OS but unknown to the rebooted manager's dedup map".
function makeSubagentManager(state, liveSet, pidBase = 4200) {
  const records = new Map();
  let resCounter = 0;
  // Model a session's death: reap its spawn record so a later re-drive for the
  // same ticket does not spuriously dedup against a corpse (in reality the reaper
  // drops the record when the child exits — the very death that opened the defer
  // window). Test-only handle surfaced on `state`.
  state.reapTicket = (ticketId) => {
    for (const [id, rec] of [...records]) {
      if (rec.ticket_id === ticketId) records.delete(id);
    }
  };
  // Reap a crash-surviving detached harness by pid (blocker #3): drop its OS-live
  // handle and any local record. Wired as the store's `reapPid` for the restart.
  state.reapPid = (pid) => {
    let killed = false;
    if (liveSet && liveSet.delete(pid)) killed = true;
    for (const [id, rec] of [...records]) {
      if (rec.pid === pid) records.delete(id);
    }
    state.reaped.push(pid);
    return killed;
  };
  return {
    canSpawn: () => true,
    async spawn(spec) {
      const dup = findDuplicateSpawn(records.values(), spec);
      if (dup) {
        state.dedups.push({ trigger: spec.triggerId, reason: dup });
        return { spawned: false, reason: dup };
      }
      const id = --resCounter;
      const pid = pidBase - id;
      records.set(id, {
        kind: spec.kind,
        trigger_id: spec.triggerId || null,
        chat_request_id: spec.chatRequestId || null,
        ticket_id: spec.ticketId || null,
        role: spec.role || null,
        agent_id: spec.agentId || null,
        pid,
      });
      if (liveSet) liveSet.add(pid); // detached child is now an alive OS process
      state.spawns.push({ ...spec, pid });
      return { spawned: true, pid };
    },
  };
}

function manualScheduler() {
  const timers = new Map();
  let id = 0;
  return {
    api: {
      set(fn, ms) { const h = ++id; timers.set(h, { fn, ms }); return h; },
      clear(h) { timers.delete(h); },
    },
    armed: () => timers.size,
    async fire() {
      const snap = [...timers.values()];
      timers.clear();
      for (const t of snap) t.fn();
      for (let i = 0; i < 8; i++) await settle();
    },
  };
}

function makeHarness(opts = {}) {
  const nowRef = opts.nowRef ?? { v: T0 };
  const sched = opts.sched ?? manualScheduler();
  const liveSet = opts.liveSet ?? null;
  const state = { spawns: [], dedups: [], reaped: [] };
  const store = new SessionLimitDeferStore({
    now: () => nowRef.v,
    scheduler: sched.api,
    persistPath: opts.persistPath ?? null,
    // Reap a crash-surviving detached harness by pid before its intent is
    // re-driven on boot (blocker #3). Injected fake removes it from the OS-live
    // set so a twin would be observable if the reap were skipped.
    reapPid: (pid) => state.reapPid(pid),
  });
  const worktreeManager = {
    enabled: true,
    async resolveCwd() {
      return { isWorktree: true, cwd: '/ws/.awb/wt/t', mode: 'per_ticket', reused: false };
    },
    async verifyCheckout() { return { ok: true }; },
    async verifyPushReadiness() { return { ok: true }; },
    async removeTicketWorktrees() { return 0; },
    async removeTicketRunWorkspace() { return false; },
  };
  const managedAgentContexts = {
    get: (id) => (id === AGENT ? makeCtx() : null),
    has: (id) => id === AGENT,
    list: () => [{ working_dir: '/ws' }],
  };
  const d = new EventDispatcher(
    { url: 'http://127.0.0.1:0', apiKey: 'test-key', delegation: { enabled: true } },
    { worktreeManager, subagentManager: makeSubagentManager(state, liveSet, opts.pidBase), managedAgentContexts, sessionLimitDeferStore: store },
  );
  return { d, store, sched, nowRef, state, liveSet };
}

function trigger(overrides = {}) {
  return JSON.stringify({
    event_type: 'agent_trigger',
    ticket_id: 'T-1',
    action: 'assignee',
    actor_name: AGENT,
    field_changed: 'trig',
    trigger_source: 'supervisor',
    base_repo: { id: 'repo-1', url: 'https://github.com/acme/app.git', default_branch: 'main' },
    base_branch: 'main',
    ...overrides,
  });
}

const RESET_UNTIL = T0 + 60 * 60_000;
function openWindow(d) {
  return d.recordHarnessSessionLimit({
    agentId: AGENT,
    deferUntilMs: RESET_UNTIL,
    reason: 'session_limit',
    resetLabel: '12:30am (Asia/Seoul)',
  });
}
const countTool = (name) => mcpToolCalls.filter((c) => c.name === name).length;
const commentContent = () =>
  mcpToolCalls.filter((c) => c.name === 'add_comment').map((c) => c.args.content).join('\n');

// ── (1) coalesce the supervisor storm into ONE intent, no spawn, one comment ──

test('session-limit window: supervisor re-dispatch storm coalesces to ONE pending intent — no spawn, no twin, one audit comment', async () => {
  const { d, state } = makeHarness();

  assert.deepEqual(openWindow(d), { opened: true }, 'the session-limit exit opened a fresh window');
  assert.equal(d.sessionDeferState(AGENT).deferred, true);

  // Six supervisor force-respawns for the SAME (ticket, role) — the d34075b5 storm.
  for (let i = 0; i < 6; i++) {
    await d.handleTrigger(trigger({ field_changed: `s${i}`, force_respawn: true }));
  }
  assert.equal(state.spawns.length, 0, 'NOTHING spawned while deferred — the doomed sessions are never started');
  assert.equal(state.dedups.length, 0, 'the twin was prevented BEFORE provisioning (no spawn-level dedup needed)');
  assert.equal(d.pendingSessionDeferCount(AGENT), 1, 'the six re-dispatches coalesced into exactly one pending intent');
  // The audit comment is fire-and-forget (a failed POST must never affect
  // dispatch) — let the MCP initialize→tools/call chain drain before asserting.
  for (let i = 0; i < 8; i++) await settle();
  assert.equal(countTool('add_comment'), 1, 'exactly one audit-visible defer comment for the ticket-role');

  const c = commentContent();
  assert.match(c, /세션 한도|session limit/, 'the comment names the session-limit defer reason');
  assert.match(c, /정확히 1회/, 'states the resume-exactly-once contract');
  assert.match(c, /12:30am \(Asia\/Seoul\)/, 'surfaces the parsed reset time');
  assert.match(c, /467f714a/, 'references the ticket');
  assert.equal(countTool('pend_ticket'), 0, 'a session limit is NOT a pend — it is deferred+resumed');
});

// ── (2) reset → each deferred ticket-role resumes EXACTLY once, no twin ──

test('reset instant: each coalesced ticket-role resumes EXACTLY ONCE (no twin), window clears', async () => {
  const { d, sched, nowRef, state } = makeHarness();
  openWindow(d);

  // Two distinct tickets deferred; T-1 hit repeatedly (coalesced), T-2 once.
  for (let i = 0; i < 4; i++) await d.handleTrigger(trigger({ ticket_id: 'T-1', field_changed: `a${i}` }));
  await d.handleTrigger(trigger({ ticket_id: 'T-2', field_changed: 'b0' }));
  assert.equal(state.spawns.length, 0, 'nothing spawned during the window');
  assert.equal(d.pendingSessionDeferCount(AGENT), 2, 'one intent per distinct ticket-role');

  // The reset instant arrives.
  nowRef.v = RESET_UNTIL + 1;
  await sched.fire();

  assert.equal(state.spawns.length, 2, 'exactly one spawn per deferred ticket-role — no twin despite T-1 being triggered 4×');
  assert.equal(state.dedups.length, 0, 'no spawn-level dedup fired — coalescing made each replay unique');
  const spawnedTickets = state.spawns.map((s) => s.ticketId).sort();
  assert.deepEqual(spawnedTickets, ['T-1', 'T-2']);
  assert.equal(d.sessionDeferState(AGENT).deferred, false, 'the window cleared at reset');
  assert.equal(d.pendingSessionDeferCount(AGENT), 0, 'nothing left queued (exactly-once)');

  // A late supervisor re-push after reset is a normal dispatch again (spawns).
  await d.handleTrigger(trigger({ ticket_id: 'T-1', field_changed: 'late' }));
  assert.equal(state.spawns.length, 2, 'post-reset the same-key trigger dedups against the live replay (still no twin)');
});

// ── (3) manual/operator trigger bypasses the window (escape hatch) ──

test('an explicit operator `manual` trigger bypasses the defer window (escape hatch)', async () => {
  const { d, state } = makeHarness();
  openWindow(d);
  assert.equal(d.sessionDeferState(AGENT).deferred, true);

  await d.handleTrigger(trigger({ ticket_id: 'T-op', field_changed: 'op', trigger_source: 'manual' }));
  assert.equal(state.spawns.length, 1, 'a manual trigger spawns despite the window (operator escape hatch)');
  assert.equal(state.spawns[0].ticketId, 'T-op');
  assert.equal(d.pendingSessionDeferCount('T-op'), 0, 'a bypassing trigger is not coalesced into an intent');
});

// ── (4) a comment_mention is coalesced (not dropped) while deferred, no spawn ──

test('a comment_mention is coalesced into one pending intent while deferred (no one-shot spawn)', async () => {
  const { d, state } = makeHarness();
  openWindow(d);

  const mention = (comment) =>
    JSON.stringify({
      event_type: 'comment_mention',
      ticket_id: 'T-1',
      comment_id: comment,
      agent_id: AGENT,
      actor_name: 'reviewer',
      mention_source: 'role',
      role_shortcut: 'assignee',
      content: '@[role:assignee] please proceed',
    });
  // Two mentions for the same (ticket, role) — the storm shape.
  await d.handleCommentMention(mention('c1'));
  await d.handleCommentMention(mention('c2'));
  assert.equal(state.spawns.length, 0, 'the mention did not spawn a doomed one-shot while deferred');
  assert.equal(
    d.pendingSessionDeferCount(AGENT),
    1,
    'the mentions COALESCED into exactly one pending intent (blocker #2 — not dropped)',
  );
});

// ── (5) a moved ticket cancels its pending resume intent ──

test('a moved ticket cancels its pending resume intent (board_update), so it never replays at reset', async () => {
  const { d, sched, nowRef, state } = makeHarness();
  openWindow(d);

  await d.handleTrigger(trigger({ ticket_id: 'T-1', field_changed: 'm1' }));
  await d.handleTrigger(trigger({ ticket_id: 'T-2', field_changed: 'm2' }));
  assert.equal(d.pendingSessionDeferCount(AGENT), 2);

  // T-1 moves (any column) → its stale pre-move intent must not replay.
  d.handleBoardUpdate(JSON.stringify({ entity_type: 'ticket', action: 'moved', ticket_id: 'T-1' }));
  assert.equal(d.pendingSessionDeferCount(AGENT), 1, 'the moved ticket’s intent was cancelled');
  assert.equal(d.sessionDeferState(AGENT).deferred, true, 'the agent window survives (T-2 still deferred)');

  nowRef.v = RESET_UNTIL + 1;
  await sched.fire();
  assert.equal(state.spawns.length, 1, 'only the un-moved ticket resumed');
  assert.equal(state.spawns[0].ticketId, 'T-2');
});

// ── (6) blocker #1: the dead task itself is seeded — it resumes at reset even ──
// with NO intervening supervisor/mention trigger. This is the gap the reviewer
// flagged: recordHarnessSessionLimit used to open the window WITHOUT queuing the
// failed task, so a reset with no further trigger replayed nothing.

test('blocker #1: a session-limit exit seeds the dead task — it resumes EXACTLY once at reset with no intervening trigger', async () => {
  const { d, sched, nowRef, state } = makeHarness();

  // A normal supervisor trigger dispatches (no window yet) → spawns the doomed
  // session and records its raw for the seed.
  await d.handleTrigger(trigger({ ticket_id: 'T-orig', field_changed: 'orig' }));
  assert.equal(state.spawns.length, 1, 'the original task spawned');

  // That session dies of a harness session limit: the exit handler opens the
  // window AND seeds the dead task itself as a durable pending intent. Model the
  // death by reaping its spawn record (the reaper drops it on child exit).
  state.reapTicket('T-orig');
  const opened = d.recordHarnessSessionLimit({
    agentId: AGENT,
    ticketId: 'T-orig',
    role: 'assignee',
    deferUntilMs: RESET_UNTIL,
    reason: 'session_limit',
    resetLabel: '12:30am (Asia/Seoul)',
  });
  assert.deepEqual(opened, { opened: true }, 'the exit opened a fresh window');
  assert.equal(d.pendingSessionDeferCount(AGENT), 1, 'the dead task was seeded as ONE pending intent');
  for (let i = 0; i < 8; i++) await settle();
  assert.equal(countTool('add_comment'), 1, 'one audit-visible defer comment for the seeded ticket-role');
  assert.match(commentContent(), /정확히 1회/, 'the seed comment states the resume-once contract');

  // NO further supervisor/mention trigger arrives. The reset instant alone must
  // re-drive the original ticket-role exactly once.
  nowRef.v = RESET_UNTIL + 1;
  await sched.fire();
  assert.equal(state.spawns.length, 2, 'the seeded original re-drove once at reset (no intervening trigger needed)');
  assert.equal(state.spawns[1].ticketId, 'T-orig');
  assert.equal(state.dedups.length, 0, 'no twin — exactly one live re-drive');
  assert.equal(d.pendingSessionDeferCount(AGENT), 0, 'nothing left queued (exactly-once)');
});

// ── (7) blocker #2 end-to-end: a mention-only window resumes once at reset ──

test('blocker #2: a mention arriving during defer (no trigger) is coalesced and resumes EXACTLY once at reset', async () => {
  const { d, sched, nowRef, state } = makeHarness();
  openWindow(d); // window open, no seed — isolate the mention path

  await d.handleCommentMention(
    JSON.stringify({
      event_type: 'comment_mention',
      ticket_id: 'T-m',
      comment_id: 'c1',
      agent_id: AGENT,
      actor_name: 'reviewer',
      mention_source: 'role',
      role_shortcut: 'assignee',
      content: '@[role:assignee] please proceed',
    }),
  );
  assert.equal(state.spawns.length, 0, 'no doomed one-shot spawned while deferred');
  assert.equal(d.pendingSessionDeferCount(AGENT), 1, 'the mention was coalesced into one durable intent');
  for (let i = 0; i < 8; i++) await settle();
  assert.equal(countTool('add_comment'), 1, 'one audit-visible defer comment for the deferred mention');

  // Reset → the coalesced mention is re-delivered EXACTLY once (via handleCommentMention).
  nowRef.v = RESET_UNTIL + 1;
  await sched.fire();
  assert.equal(state.spawns.length, 1, 'the deferred mention resumed once at reset');
  assert.equal(state.spawns[0].ticketId, 'T-m');
  assert.equal(state.dedups.length, 0, 'no twin');
  assert.equal(d.pendingSessionDeferCount(AGENT), 0, 'nothing left queued (exactly-once)');
});

// ── (8) blocker #3: crash AFTER spawn, before outbox ack → restart reaps the ──
// crash-surviving detached harness BEFORE re-driving, so 0 concurrent live twins
// and exactly 1 valid execution survive. This is the reviewer's option (B): a
// durable lifecycle guarantee (persisted spawnedPid + boot reap), proven with the
// REAL EventDispatcher + spawn fake through a genuine "spawn then die before ack"
// on-disk state and a fresh-manager restart against the same persistPath.

test('blocker #3: crash-after-spawn-before-ack → restart reaps the survivor, re-drives once — 0 live twins, exactly 1 execution', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'awb-session-defer-crash-'));
  const persistPath = join(dir, 'session-defer.json');
  // The OS-alive detached processes, SHARED across the crash/restart boundary:
  // a spawn adds a pid, the reaper removes it. A detached child survives the
  // manager's death → it stays in this set until reaped.
  const liveSet = new Set();
  const nowRef = { v: T0 };

  try {
    // ── pre-crash manager lifetime ──
    const sched1 = manualScheduler();
    const h1 = makeHarness({ persistPath, liveSet, nowRef, sched: sched1 });

    // Override h1's resume to model a CRASH: run the REAL spawn (records the pid
    // durably via onSpawned), then die BEFORE the outbox ack removes the intent.
    h1.store.setResumeHandler(async (intent, onSpawned) => {
      await h1.d.handleTrigger(intent.raw, { onDispatched: (pid) => onSpawned(pid) });
      throw new Error('SIMULATED manager crash: died after spawn, before outbox ack');
    });

    openWindow(h1.d);
    await h1.d.handleTrigger(trigger({ ticket_id: 'T-c', field_changed: 'c0' }));
    assert.equal(h1.state.spawns.length, 0, 'nothing spawned while deferred');
    assert.equal(h1.d.pendingSessionDeferCount(AGENT), 1, 'one coalesced pending intent');

    // Reset fires → replay spawns the harness, then the manager "crashes" before ack.
    nowRef.v = RESET_UNTIL + 1;
    await sched1.fire();

    assert.equal(h1.state.spawns.length, 1, 'the replay spawned exactly one harness before the crash');
    const survivorPid = h1.state.spawns[0].pid;
    assert.equal(liveSet.size, 1, 'the crash-surviving detached harness is still alive');
    assert.ok(liveSet.has(survivorPid), 'the survivor pid is the one the replay spawned');

    // On-disk outbox state at the crash instant: intent still present, `dispatching`,
    // carrying the spawned pid — the durable reapable handle (blocker #3).
    const onDisk = JSON.parse(readFileSync(persistPath, 'utf8'));
    const persistedIntent = Object.values(onDisk.agents[AGENT].intents)[0];
    assert.equal(persistedIntent.status, 'dispatching', 'the intent is persisted un-acked as dispatching');
    assert.equal(persistedIntent.spawnedPid, survivorPid, 'the spawned pid is persisted for the next boot to reap');

    // ── restart: fresh manager (empty dedup map) against the same persistPath ──
    // The process-local single-flight reservation is GONE (fresh boot), so without
    // the durable reap the re-drive would spawn a second live session → twin.
    const sched2 = manualScheduler();
    // Distinct pid range so the re-drive's pid is observably different from the
    // reaped survivor's (a fresh manager's pids don't collide with the dead one's).
    const h2 = makeHarness({ persistPath, liveSet, nowRef, sched: sched2, pidBase: 8800 });
    // h2 uses the DEFAULT resume wiring (clean handleTrigger→ack). Its store.load()
    // ran in the constructor, rehydrating the dispatching+pid intent for boot reap.
    assert.equal(h2.d.pendingSessionDeferCount(AGENT), 1, 'the un-acked intent rehydrated on boot');

    await sched2.fire();

    // The survivor was reaped BEFORE the re-drive; exactly one live session remains.
    assert.deepEqual(h2.state.reaped, [survivorPid], 'boot reaped exactly the crash-surviving pid');
    assert.equal(liveSet.size, 1, '0 concurrent live twins — the survivor was killed, only the re-drive lives');
    assert.equal(h2.state.spawns.length, 1, 'the re-drive spawned exactly one valid session');
    const redrivenPid = h2.state.spawns[0].pid;
    assert.ok(liveSet.has(redrivenPid), 'the surviving live session is the re-drive, not the reaped survivor');
    assert.ok(!liveSet.has(survivorPid), 'the pre-crash survivor is no longer alive');
    assert.equal(h2.state.dedups.length, 0, 'the re-drive was not deduped — it is the sole valid execution');
    assert.equal(h2.d.pendingSessionDeferCount(AGENT), 0, 'the outbox intent is acked and cleared (exactly-once)');

    // The window is fully drained on disk — a further restart replays nothing.
    const finalDisk = JSON.parse(readFileSync(persistPath, 'utf8'));
    assert.ok(!finalDisk.agents[AGENT], 'the drained agent window is removed from disk');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
