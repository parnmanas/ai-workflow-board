// Behavioural + static regression — ticket 2de718d3 ([Bug] AI Agents current
// task 가 실제 동시 세션 수를 과소 표시 — 15분 stale cutoff 로 장수명 세션이
// 목록에서 사라짐).
//
// Root cause: the UI-facing active_tasks projection (getActiveTasks /
// _nonStaleTaskList, and the physical eviction inside _sweep) filtered purely
// on ActiveTask.claimed_at (stamped ONCE at spawn, never refreshed). The
// in-flight dispatch gate (hasLiveRoleStrand, ticket e9c8e1d6) additionally
// honors a fresh per-(agent,ticket,role) output-liveness timestamp within the
// same CURRENT_TASK_STALE_MS horizon — so a session producing tokens past 15
// min without a ticket-write was still correctly treated as in-flight by the
// dispatch gate (TriggerLoopService dropped its re-triggers as
// agent_trigger_dropped_inflight_strand) while simultaneously vanishing from
// the AI Agents dashboard's current-task list. Two different liveness
// definitions for the same underlying strand.
//
// Fix (server-only, agent-status.service.ts): _nonStaleTaskList and _sweep's
// active_tasks retention now both delegate to hasLiveRoleStrand per task, so
// the UI projection and the in-flight gate can never again disagree on which
// tickets are live. No new store — output-liveness already existed
// (ticket fdc69c13/e9c8e1d6); this just makes the UI consult it too.
//
// No NestJS boot: hand-rolled fakes, mirroring agent-status-supervisor-
// eviction.test.mjs / inflight-strand-output-liveness.test.mjs.

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

async function makeStatus(agentRows = []) {
  const { AgentStatusService } = await loadDist(['modules', 'agents', 'agent-status.service.js']);
  const { MemoryMetricsRegistry } = await loadDist(['services', 'memory-metrics.registry.js']);
  const agentRepo = {
    async find() { return agentRows.slice(); },
    async update() {},
  };
  const dataSource = { getRepository: () => ({ async findOne() { return null; } }) };
  // connectivity + instanceRegistry (ticket 1f750878) — inert fakes, same as
  // the other AgentStatusService unit tests.
  return new AgentStatusService(agentRepo, dataSource, noopLog, new MemoryMetricsRegistry(), { isReachable: () => false }, { list: () => [] });
}

function seedTask(service, agentId, ticketId, role, claimedAt, isOnline = true) {
  service.state.set(agentId, {
    agent_id: agentId,
    is_online: isOnline,
    last_seen_at: new Date(),
    active_tasks: new Map([[ticketId, { ticket_id: ticketId, ticket_title: 't', claimed_at: claimedAt, role }]]),
  });
}

// ── getActiveTasks (the UI-facing read path) ────────────────────────────────

test('getActiveTasks: a session past the claimed_at TTL with fresh output-liveness stays visible (the reported bug)', async () => {
  const s = await makeStatus();
  seedTask(s, 'A', 't1', 'assignee', AGO(STALE_MS + 5 * 60_000)); // spawned 20 min ago
  s.recordOutputLiveness('A', 't1', 'assignee'); // still producing tokens
  const tasks = s.getActiveTasks('A');
  assert.equal(tasks.length, 1, 'task remains on the dashboard past the 15-min claimed_at cutoff');
  assert.equal(tasks[0].ticket_id, 't1');
});

test('getActiveTasks: stale claimed_at + no output-liveness disappears (crash recovery unaffected)', async () => {
  const s = await makeStatus();
  seedTask(s, 'A', 't1', 'assignee', AGO(STALE_MS + 60_000));
  assert.equal(s.getActiveTasks('A').length, 0, 'a genuinely dead strand is not shown');
});

test('getActiveTasks: fresh claimed_at (well within the window) still shows with no output-liveness needed (no regression)', async () => {
  const s = await makeStatus();
  seedTask(s, 'A', 't1', 'assignee', new Date());
  const tasks = s.getActiveTasks('A');
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].ticket_id, 't1');
});

test('getActiveTasks and hasLiveRoleStrand agree on the same ticket (in-flight gate parity, DoD#3)', async () => {
  const s = await makeStatus();
  seedTask(s, 'A', 't1', 'assignee', AGO(STALE_MS + 5 * 60_000));
  s.recordOutputLiveness('A', 't1', 'assignee');
  const shown = s.getActiveTasks('A').some((t) => t.ticket_id === 't1');
  assert.equal(shown, true);
  assert.equal(shown, s.hasLiveRoleStrand('A', 't1', 'assignee'), 'UI visibility must match the in-flight gate verdict exactly');
});

test('getActiveTasks: a mixed fleet resolves each ticket independently (mirrors the 5-concurrent-ticket report)', async () => {
  const s = await makeStatus();
  s.state.set('A', {
    agent_id: 'A',
    is_online: true,
    last_seen_at: new Date(),
    active_tasks: new Map([
      ['fresh', { ticket_id: 'fresh', ticket_title: 'fresh', claimed_at: new Date(), role: 'assignee' }],
      ['stale-but-live', { ticket_id: 'stale-but-live', ticket_title: 'stale-but-live', claimed_at: AGO(STALE_MS + 60_000), role: 'assignee' }],
      ['dead', { ticket_id: 'dead', ticket_title: 'dead', claimed_at: AGO(STALE_MS + 60_000), role: 'reviewer' }],
    ]),
  });
  s.recordOutputLiveness('A', 'stale-but-live', 'assignee');
  const ids = s.getActiveTasks('A').map((t) => t.ticket_id).sort();
  assert.deepEqual(ids, ['fresh', 'stale-but-live'], 'only genuinely dead tickets drop out; the rest — regardless of which signal keeps them alive — stay');
});

test('getActiveTasks: output-liveness is role-keyed — a live ASSIGNEE seat does not resurrect a stale REVIEWER seat on the same ticket', async () => {
  const s = await makeStatus();
  seedTask(s, 'A', 't1', 'reviewer', AGO(STALE_MS + 60_000));
  s.recordOutputLiveness('A', 't1', 'assignee'); // different role, same ticket
  assert.equal(s.getActiveTasks('A').length, 0, 'role isolation preserved — matches hasLiveRoleStrand');
});

// ── _sweep (the physical eviction path — must not outrun the read-side fix) ─

test('_sweep does not physically delete a stale-claimed_at task whose output-liveness is fresh', async () => {
  const recent = new Date();
  const s = await makeStatus([{ id: 'A', last_seen_at: recent, is_online: 1 }]);
  seedTask(s, 'A', 't1', 'assignee', AGO(STALE_MS + 60_000));
  s.recordOutputLiveness('A', 't1', 'assignee');

  await s._sweep();

  const kept = s.state.get('A')?.active_tasks;
  assert.ok(kept && kept.has('t1'), 'sweep must retain the entry — a read-side-only fix would be moot once sweep erases it');
  assert.equal(s.getActiveTasks('A').length, 1, 'still visible on the dashboard after a sweep tick');
});

test('_sweep still evicts a task once BOTH claimed_at and output-liveness are stale (recovery preserved)', async () => {
  const recent = new Date();
  const s = await makeStatus([{ id: 'A', last_seen_at: recent, is_online: 1 }]);
  seedTask(s, 'A', 't1', 'assignee', AGO(STALE_MS + 60_000));
  // no recordOutputLiveness at all — genuinely silent strand

  await s._sweep();

  const kept = s.state.get('A')?.active_tasks;
  assert.ok(!kept || !kept.has('t1'), 'a genuinely dead strand is still swept away (no regression on the crash-recovery path)');
});

test('_sweep: an offline agent still drops every task regardless of output-liveness', async () => {
  const longAgo = AGO(10 * 60_000); // > OFFLINE_THRESHOLD_MS (90s)
  const s = await makeStatus([{ id: 'A', last_seen_at: longAgo, is_online: 1 }]);
  seedTask(s, 'A', 't1', 'assignee', new Date()); // fresh claimed_at
  s.recordOutputLiveness('A', 't1', 'assignee'); // fresh output too

  await s._sweep();

  const kept = s.state.get('A')?.active_tasks;
  assert.ok(!kept || !kept.has('t1'), 'an unreachable agent is not trusted to still be producing output');
});

// ── Static guards — a refactor must not silently re-narrow the UI's liveness ─

test('static: _nonStaleTaskList filters via hasLiveRoleStrand, not a bare claimed_at compare', () => {
  const raw = readSrc(['modules', 'agents', 'agent-status.service.ts']);
  assert.match(
    raw,
    /_nonStaleTaskList\(agent_id: string, tasks\?: Map<string, ActiveTask>\): ActiveTask\[\][\s\S]*?hasLiveRoleStrand\(agent_id, t\.ticket_id, t\.role \|\| ''\)/,
    '_nonStaleTaskList must delegate the per-task liveness check to hasLiveRoleStrand',
  );
});

test('static: _sweep retains active_tasks entries via hasLiveRoleStrand, not a bare claimed_at compare', () => {
  const raw = readSrc(['modules', 'agents', 'agent-status.service.ts']);
  assert.match(
    raw,
    /for \(const \[tid, t\] of prev\.active_tasks\)\s*\{\s*if \(this\.hasLiveRoleStrand\(a\.id, tid, t\.role \|\| ''\)\) kept\.set\(tid, t\);/,
    '_sweep must keep a task iff hasLiveRoleStrand still calls it live',
  );
});

test('static: getActiveTasks and the SSE _emit path both route through _nonStaleTaskList with an agent_id', () => {
  const raw = readSrc(['modules', 'agents', 'agent-status.service.ts']);
  assert.match(
    raw,
    /getActiveTasks\(agent_id: string\): ActiveTask\[\] \{\s*return this\._nonStaleTaskList\(agent_id, this\.state\.get\(agent_id\)\?\.active_tasks\);/,
    'getActiveTasks must pass agent_id through to _nonStaleTaskList',
  );
  assert.match(
    raw,
    /this\._nonStaleTaskList\(status\.agent_id, status\.active_tasks\)/,
    '_emit must pass status.agent_id through to _nonStaleTaskList so the SSE payload uses the same liveness definition',
  );
});
