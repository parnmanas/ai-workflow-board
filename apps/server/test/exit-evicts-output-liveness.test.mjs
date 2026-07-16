// Behavioural + static regression — ticket ea4adc71 (Review → To Do 이동 직후
// 에이전트 트리거 지연·누락).
//
// Root cause: `recordOutputLiveness` stamps a per-(agent,ticket,role) timestamp
// that, before this fix, had NO clear signal on session end — its only removal
// was the 6h+ TTL sweep. `hasLiveRoleStrand`'s path-2 (ticket e9c8e1d6) treats a
// fresh output-liveness stamp within CURRENT_TASK_STALE_MS (15 min) as a live
// strand. So for up to 15 min AFTER a strand exits, the just-vacated seat still
// looks "live":
//   Review → To Do bounce fires an immediate assignee trigger →
//   TriggerLoopService._emitTrigger (trigger-loop.service.ts:1944) consults
//   hasLiveRoleStrand → sees the lingering output-liveness → drops the trigger
//   (`agent_trigger_dropped_inflight_strand`). The strand already exited, so no
//   future `agent_idle` arrives to replay it (queued_for_replay=false) → only
//   the ~15-min supervisor poll eventually recovers. == the observed delay/miss.
//
// Fix (server-only): clearCurrentTask — the manager's reliable subagent-EXIT
// signal (sole production caller: the `clear_current_task` MCP tool,
// agent-status-tools.ts:70) — now also evicts output-liveness for the exited
// seat, BEFORE its active_tasks early-returns (so it runs even when the entry
// was already swept, never registered, or names a different current ticket).
//
// Non-regression (the tension with e9c8e1d6): the 30s `_sweep` clears a stale
// active_tasks entry INLINE and never routes through clearCurrentTask, so a
// genuinely live-but-quiet strand (producing tokens past the 15-min current_task
// TTL) keeps its output-liveness through a sweep and stays live via path 2. Only
// a real EXIT evicts. Test 7 proves this behaviourally by running the real
// _sweep. hasLiveRoleStrand / recordOutputLiveness / _outputLivenessKey are
// unchanged, so the 11 tests in inflight-strand-output-liveness.test.mjs stay
// green.
//
// No NestJS boot: the service is constructed directly with hand-rolled fakes,
// mirroring inflight-strand-output-liveness.test.mjs (fast + deterministic).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(__dirname, '..', 'src');
const DIST = path.join(__dirname, '..', 'dist');

async function loadDist(relParts) {
  const url = 'file://' + path.join(DIST, ...relParts);
  try {
    return await import(url);
  } catch (err) {
    throw new Error(
      'This test requires the server to be built first. Run `npm run --workspace=apps/server build`. Original error: ' +
        err.message,
    );
  }
}
function readSrc(relParts) {
  return fs.readFileSync(path.join(SRC, ...relParts), 'utf8');
}

const noopLog = { info() {}, warn() {}, error() {}, debug() {}, log() {} };
const STALE_MS = 15 * 60_000; // CURRENT_TASK_STALE_MS mirror
const AGO = (ms) => new Date(Date.now() - ms);

// Build a service with a caller-supplied agent-row list so _sweep (which reads
// agentRepo.find()) actually processes the seeded agent in test 7. Default [] —
// all tests that never call _sweep are unaffected.
async function makeStatus(agentRows = []) {
  const { AgentStatusService } = await loadDist(['modules', 'agents', 'agent-status.service.js']);
  const { MemoryMetricsRegistry } = await loadDist(['services', 'memory-metrics.registry.js']);
  const agentRepo = { async find() { return agentRows; }, async update() {} };
  const dataSource = { getRepository: () => ({ async findOne() { return null; } }) };
  return new AgentStatusService(agentRepo, dataSource, noopLog, new MemoryMetricsRegistry());
}

// Seed a current_task (active_tasks entry) directly — avoids setCurrentTask's
// async DB/emit machinery. Mirrors inflight-strand-output-liveness.test.mjs.
function seedTask(service, agentId, ticketId, role, claimedAt) {
  service.state.set(agentId, {
    agent_id: agentId,
    is_online: true,
    last_seen_at: new Date(),
    active_tasks: new Map([[ticketId, { ticket_id: ticketId, ticket_title: 't', claimed_at: claimedAt, role }]]),
  });
}
const hasOutput = (s, a, t, r) => s.getOutputLivenessAt(a, t, r) !== undefined;

// ── The reported scenario: a Review→To Do bounce trigger onto a just-exited seat

test('FIX: clearCurrentTask evicts output-liveness → the bounce trigger is no longer gated (core repro)', async () => {
  const s = await makeStatus();
  // A live assignee strand: fresh current_task AND actively producing output.
  seedTask(s, 'A', 't1', 'assignee', new Date());
  s.recordOutputLiveness('A', 't1', 'assignee');
  assert.equal(s.hasLiveRoleStrand('A', 't1', 'assignee'), true, 'while running, the gate reports live (sanity)');

  // Strand exits → manager fires clear_current_task(agent, ticket).
  s.clearCurrentTask('A', 't1');

  // The seat is now vacant on BOTH gate paths → an immediate re-trigger (the
  // Review→To Do bounce) passes _emitTrigger's in-flight-strand gate.
  assert.equal(hasOutput(s, 'A', 't1', 'assignee'), false, 'output-liveness evicted on exit');
  assert.equal(
    s.hasLiveRoleStrand('A', 't1', 'assignee'),
    false,
    'a just-exited seat is not live → the bounce trigger is emitted, not dropped',
  );
});

// ── Eviction must run BEFORE clearCurrentTask's active_tasks early-returns ────

test('eviction runs even when active_tasks was already swept (Case A — no future agent_idle to replay)', async () => {
  const s = await makeStatus();
  // The 15-min stale-sweep already dropped the active_tasks entry (state has no
  // record for A), but the strand had produced output → path-2 still fires.
  s.recordOutputLiveness('A', 't1', 'assignee');
  assert.equal(s.hasLiveRoleStrand('A', 't1', 'assignee'), true, 'lingering output-liveness alone reports live');

  // clearCurrentTask hits `if (!status?.active_tasks ...) return` — the eviction
  // is placed ahead of it, so it must still run.
  s.clearCurrentTask('A', 't1');
  assert.equal(s.hasLiveRoleStrand('A', 't1', 'assignee'), false, 'evicted despite the swept-active_tasks early-return');
});

test('eviction runs even when clearCurrentTask names a different current ticket (expectedTicketId mismatch)', async () => {
  const s = await makeStatus();
  // Agent is currently registered on t2; a stale output-liveness lingers on t1.
  seedTask(s, 'A', 't2', 'assignee', new Date());
  s.recordOutputLiveness('A', 't1', 'assignee');

  // tasks.delete('t1') returns false → old code would `return` here; the eviction
  // ahead of it must still clear t1.
  s.clearCurrentTask('A', 't1');
  assert.equal(hasOutput(s, 'A', 't1', 'assignee'), false, "t1's stale output-liveness evicted");
  assert.equal(s.hasLiveRoleStrand('A', 't2', 'assignee'), true, "the agent's live t2 strand is untouched");
});

// ── Prefix correctness — the manager's clear carries no role, and UUIDs have no colons

test('clear with no role evicts EVERY role recorded for that (agent, ticket)', async () => {
  const s = await makeStatus();
  s.recordOutputLiveness('A', 't1', 'assignee');
  s.recordOutputLiveness('A', 't1', 'reviewer');
  s.clearCurrentTask('A', 't1'); // clear_current_task passes no role → prefix `A:t1:`
  assert.equal(hasOutput(s, 'A', 't1', 'assignee'), false);
  assert.equal(hasOutput(s, 'A', 't1', 'reviewer'), false);
});

test('ticket isolation: the trailing colon keeps a clear of t1 from evicting a prefix-extended ticket id', async () => {
  const s = await makeStatus();
  s.recordOutputLiveness('A', 't1', 'assignee');
  s.recordOutputLiveness('A', 't1x', 'assignee'); // 't1' is a string-prefix of 't1x'
  s.clearCurrentTask('A', 't1'); // prefix `A:t1:` must NOT match key `A:t1x:assignee`
  assert.equal(hasOutput(s, 'A', 't1', 'assignee'), false, 't1 evicted');
  assert.equal(hasOutput(s, 'A', 't1x', 'assignee'), true, 't1x survives — trailing colon guards the boundary');
});

test('force-clear (shutdown, no ticket) evicts all of the agent but not siblings whose id extends it', async () => {
  const s = await makeStatus();
  s.recordOutputLiveness('A', 't1', 'assignee');
  s.recordOutputLiveness('A', 't2', 'reviewer');
  s.recordOutputLiveness('A2', 't1', 'assignee'); // 'A' is a string-prefix of 'A2'
  s.recordOutputLiveness('B', 't1', 'assignee');
  s.clearCurrentTask('A'); // expectedTicketId omitted → prefix `A:` → all of agent A
  assert.equal(hasOutput(s, 'A', 't1', 'assignee'), false);
  assert.equal(hasOutput(s, 'A', 't2', 'reviewer'), false);
  assert.equal(hasOutput(s, 'A2', 't1', 'assignee'), true, "agent A2 untouched — 'A:' does not match 'A2:'");
  assert.equal(hasOutput(s, 'B', 't1', 'assignee'), true, 'agent B untouched');
});

// ── e9c8e1d6 non-regression — the sweep must NOT evict a live-but-quiet strand ─

test('NON-REGRESSION: the real _sweep clears stale active_tasks but preserves output-liveness (e9c8e1d6 stays live)', async () => {
  // A live strand that has produced tokens for >15 min without a ticket-write:
  // path-1 (current_task) has aged out, path-2 (output-liveness) is fresh.
  const agentRow = { id: 'A', last_seen_at: new Date(), is_online: 1 };
  const s = await makeStatus([agentRow]);
  s.state.set('A', {
    agent_id: 'A',
    is_online: true,
    last_seen_at: new Date(),
    active_tasks: new Map([['t1', { ticket_id: 't1', ticket_title: 't', claimed_at: AGO(STALE_MS + 60_000), role: 'assignee' }]]),
  });
  s.recordOutputLiveness('A', 't1', 'assignee'); // still emitting → fresh

  await s._sweep(); // the real 30s sweep body

  // The stale active_tasks entry is gone (path 1 dead)…
  assert.equal(s.state.get('A')?.active_tasks, undefined, 'sweep dropped the stale current_task');
  // …but output-liveness survived the sweep (it is NOT routed through clearCurrentTask)…
  assert.equal(hasOutput(s, 'A', 't1', 'assignee'), true, 'sweep did NOT evict output-liveness');
  // …so the producing-but-quiet strand is still recognised as live (e9c8e1d6).
  assert.equal(
    s.hasLiveRoleStrand('A', 't1', 'assignee'),
    true,
    'a live strand swept off path 1 stays live via path 2 — the supervisor nudge is still suppressed',
  );
});

// ── Idempotency ──────────────────────────────────────────────────────────────

test('idempotent: repeated clears and a clear of a seat with no output-liveness are safe no-ops', async () => {
  const s = await makeStatus();
  s.recordOutputLiveness('A', 't1', 'assignee');
  s.clearCurrentTask('A', 't1');
  assert.equal(hasOutput(s, 'A', 't1', 'assignee'), false);
  s.clearCurrentTask('A', 't1'); // second clear — no throw, stays evicted
  assert.equal(hasOutput(s, 'A', 't1', 'assignee'), false);
  s.clearCurrentTask('A', 'tX'); // never had output-liveness — safe no-op
  assert.equal(s.hasLiveRoleStrand('A', 'tX', 'assignee'), false);
});

// ── Static guard — a refactor must not move the eviction after the early-returns

test('static: clearCurrentTask evicts output-liveness BEFORE its active_tasks early-returns', () => {
  const raw = readSrc(['modules', 'agents', 'agent-status.service.ts']);
  const bodyStart = raw.indexOf('clearCurrentTask(agent_id');
  assert.ok(bodyStart > 0, 'clearCurrentTask found');
  const body = raw.slice(bodyStart);
  const evictIdx = body.indexOf('_evictOutputLivenessForExit(agent_id');
  const earlyReturnIdx = body.indexOf('if (!status?.active_tasks');
  assert.ok(evictIdx > 0, 'clearCurrentTask must call _evictOutputLivenessForExit');
  assert.ok(earlyReturnIdx > 0, 'clearCurrentTask has the active_tasks early-return');
  assert.ok(
    evictIdx < earlyReturnIdx,
    'output-liveness eviction must precede the active_tasks early-return so it runs on every exit',
  );
});
