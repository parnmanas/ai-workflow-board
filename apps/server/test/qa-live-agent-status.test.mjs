// Behavioural + static regression — ticket 09ed8def (라이브 QA push: 진행 중 QA
// run 을 agent_status SSE 로 실시간 반영).
//
// Before: agent_status SSE fired only on board-ticket task changes; a QA run's
// kind:'qa' entry was merged ONLY at REST assembly time, so on an already-open
// AI Agents page a newly-started QA run didn't appear (and a completed one
// didn't disappear) until the next full refetch. The client's mergeAgentStatus
// papered over blink-out by re-attaching REST-seeded kind:'qa' entries, but that
// APPEND could never let SSE *remove* a QA run.
//
// After: QaRunService fires an internal `qa_task_changed` bus signal on run
// start (active=true) and at the terminal choke point onRunFinalized
// (active=false, covering completeRun + reaper). AgentStatusService owns a QA
// registry (qaTasks) that it MERGES INTO EVERY agent_status emit, so the wire
// active_tasks is always the full authoritative picture (board tickets + QA).
// The client then trusts active_tasks wholesale — QA runs appear/disappear live.
//
// This guard proves: (1) _emit merges qaTasks into the wire active_tasks tagged
// kind:'qa'; (2) qa_task_changed add/remove drives a live agent_status with the
// QA entry gained/dropped; (3) the producer (qa-run.service) + consumer wiring
// (agent-status.service) + client wholesale-trust are all present.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(__dirname, '..', 'src');
const DIST = path.join(__dirname, '..', 'dist');
const CLIENT_SRC = path.join(__dirname, '..', '..', 'client', 'src');

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

const readSrc = (relParts) => fs.readFileSync(path.join(SRC, ...relParts), 'utf8');
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
const noopLog = { info() {}, warn() {}, error() {}, debug() {}, log() {} };

function makeService(StatusClass, RegistryClass, { agentRows = [], qaRuns = [], scenarios = [] } = {}) {
  const agentRepo = {
    async find() { return agentRows.slice(); },
    async findOne({ where }) { return agentRows.find((a) => a.id === where.id) || null; },
    async update() {},
  };
  // dataSource.getRepository routes by entity name — only _seedQaTasks touches it
  // (QaRun then QaScenario), and only when onModuleInit runs.
  const dataSource = {
    getRepository(entity) {
      const name = entity?.name || '';
      if (name === 'QaRun') return { async find() { return qaRuns.slice(); } };
      if (name === 'QaScenario') return { async find() { return scenarios.slice(); } };
      return { async findOne() { return null; }, async find() { return []; } };
    },
  };
  const registry = new RegistryClass();
  // connectivity + instanceRegistry (ticket 1f750878) — inert fakes so
  // isReachable() falls back to status.is_online (unchanged _emit lifecycle for
  // these QA-task assertions, which don't exercise reachability).
  const service = new StatusClass(agentRepo, dataSource, noopLog, registry, { isReachable: () => false }, { list: () => [] });
  return { service, registry };
}

// Capture the next agent_status emitted on the shared bus.
function captureAgentStatus(activityEvents, run) {
  const seen = [];
  const handler = (e) => seen.push(e);
  activityEvents.on('agent_status', handler);
  try {
    run();
  } finally {
    activityEvents.removeListener('agent_status', handler);
  }
  return seen;
}

test('_emit merges QA tasks into the wire active_tasks, tagged kind:qa, after the ticket tasks', async () => {
  const { AgentStatusService } = await loadDist(['modules', 'agents', 'agent-status.service.js']);
  const { MemoryMetricsRegistry } = await loadDist(['services', 'memory-metrics.registry.js']);
  const { activityEvents } = await loadDist(['services', 'activity.service.js']);
  const { service } = makeService(AgentStatusService, MemoryMetricsRegistry);

  const now = new Date();
  // One live board-ticket task in the internal Map …
  const ticketMap = new Map([['t1', { ticket_id: 't1', ticket_title: 'Ticket One', claimed_at: now, role: 'assignee' }]]);
  // … and one QA run in the QA registry for the same agent.
  service.qaTasks.set('agentX', new Map([['run1', { ticket_id: 'run1', ticket_title: 'Scenario A', claimed_at: now, kind: 'qa' }]]));

  // ticket 2de718d3: _emit's ticket-task filter now delegates to
  // hasLiveRoleStrand, which re-derives freshness from `state` rather than
  // trusting the map handed to it — exactly like every real caller (setCurrentTask
  // / clearCurrentTask / _sweep all `state.set` before `_emit`). Seed `state` the
  // same way so this direct _emit() call is representative.
  const status = { agent_id: 'agentX', is_online: true, last_seen_at: now, active_tasks: ticketMap };
  service.state.set('agentX', status);

  const seen = captureAgentStatus(activityEvents, () => service._emit(status));

  assert.equal(seen.length, 1, 'exactly one agent_status emitted');
  const list = seen[0].active_tasks;
  assert.equal(list.length, 2, 'ticket task + QA task both on the wire');
  assert.equal(list[0].ticket_id, 't1', 'board tickets come first');
  assert.ok(!list[0].kind || list[0].kind === 'ticket', 'ticket task is not tagged qa');
  assert.equal(list[1].ticket_id, 'run1', 'QA run appended after tickets');
  assert.equal(list[1].kind, 'qa', 'QA task tagged kind:qa for the client');
  assert.equal(list[1].ticket_title, 'Scenario A', 'QA title is the scenario name');
});

test('qa_task_changed(active=true) adds a live QA entry; (active=false) removes it', async () => {
  const { AgentStatusService } = await loadDist(['modules', 'agents', 'agent-status.service.js']);
  const { MemoryMetricsRegistry } = await loadDist(['services', 'memory-metrics.registry.js']);
  const { activityEvents } = await loadDist(['services', 'activity.service.js']);
  const now = new Date();
  const { service } = makeService(AgentStatusService, MemoryMetricsRegistry, {
    agentRows: [{ id: 'agentX', last_seen_at: now, is_online: 1 }],
  });
  // Seed live in-memory status so _emitAgentById uses it (no DB round-trip) and
  // carries the agent's real is_online — a QA change must never fake it.
  service.state.set('agentX', { agent_id: 'agentX', is_online: true, last_seen_at: now });

  // START → live agent_status gains the kind:'qa' entry.
  const onStart = captureAgentStatus(activityEvents, () =>
    service._onQaTaskChanged({ active: true, run_id: 'run1', agent_id: 'agentX', scenario_name: 'Scenario A', started_at: now.toISOString() }),
  );
  await new Promise((r) => setImmediate(r));
  assert.ok(service.qaTasks.get('agentX')?.has('run1'), 'QA task recorded in registry');
  assert.equal(onStart.length, 1, 'start emits one agent_status');
  const started = onStart[0].active_tasks.filter((t) => t.kind === 'qa');
  assert.equal(started.length, 1, 'QA entry present live on start');
  assert.equal(started[0].ticket_id, 'run1');
  assert.equal(onStart[0].is_online, true, 'carries the agent real online state, not a fabricated one');

  // FINALIZE (agent_id omitted — located by run id) → live entry disappears.
  const onDone = captureAgentStatus(activityEvents, () =>
    service._onQaTaskChanged({ active: false, run_id: 'run1' }),
  );
  await new Promise((r) => setImmediate(r));
  assert.ok(!service.qaTasks.get('agentX'), 'agent QA map emptied + dropped');
  assert.equal(onDone.length, 1, 'finalize emits one agent_status');
  assert.equal(onDone[0].active_tasks.filter((t) => t.kind === 'qa').length, 0, 'QA entry gone live on finalize');
});

test('_seedQaTasks rehydrates running runs at boot (2-step PK, no uuid=varchar join)', async () => {
  const { AgentStatusService } = await loadDist(['modules', 'agents', 'agent-status.service.js']);
  const { MemoryMetricsRegistry } = await loadDist(['services', 'memory-metrics.registry.js']);
  const now = new Date();
  const { service } = makeService(AgentStatusService, MemoryMetricsRegistry, {
    qaRuns: [{ id: 'run9', scenario_id: 'sc9', status: 'running', started_at: now, created_at: now }],
    scenarios: [{ id: 'sc9', name: 'Boot Scenario', target_agent_id: 'agentZ' }],
  });
  await service._seedQaTasks();
  assert.ok(service.qaTasks.get('agentZ')?.has('run9'), 'a running run at boot is surfaced live');
  assert.equal(service.qaTasks.get('agentZ').get('run9').ticket_title, 'Boot Scenario');
});

test('agentStatus.qaTasks gauge tracks the registry size', async () => {
  const { AgentStatusService } = await loadDist(['modules', 'agents', 'agent-status.service.js']);
  const { MemoryMetricsRegistry } = await loadDist(['services', 'memory-metrics.registry.js']);
  const { service, registry } = makeService(AgentStatusService, MemoryMetricsRegistry);
  assert.equal(registry.collect()['agentStatus.qaTasks'], 0, 'gauge registered, starts at 0');
  service.qaTasks.set('a', new Map([['r1', { ticket_id: 'r1', ticket_title: 'x', claimed_at: new Date(), kind: 'qa' }]]));
  service.qaTasks.set('b', new Map([['r2', { ticket_id: 'r2', ticket_title: 'y', claimed_at: new Date(), kind: 'qa' }]]));
  assert.equal(registry.collect()['agentStatus.qaTasks'], 2, 'counts QA tasks across agents');
});

// ── Static guards — a refactor must not silently break the live-QA wire ───────

test('static: QaRunService fires qa_task_changed on start and finalize', () => {
  const code = stripComments(readSrc(['modules', 'qa', 'qa-run.service.ts']));
  assert.match(code, /activityEvents\.emit\(\s*'qa_task_changed'[\s\S]*?active:\s*true/, 'startQaRun must fire qa_task_changed active:true');
  // The finalize signal must sit in onRunFinalized (the shared choke point for
  // completeRun + reaper) so it fires for batch AND non-batch runs.
  const onFinal = code.slice(code.indexOf('async onRunFinalized'));
  assert.match(onFinal.slice(0, 400), /activityEvents\.emit\(\s*'qa_task_changed'[\s\S]*?active:\s*false/, 'onRunFinalized must fire qa_task_changed active:false above its batch-only early return');
});

test('static: AgentStatusService consumes qa_task_changed and merges QA into _emit', () => {
  const code = stripComments(readSrc(['modules', 'agents', 'agent-status.service.ts']));
  assert.match(code, /activityEvents\.on\(\s*'qa_task_changed'/, 'must subscribe to qa_task_changed');
  assert.match(code, /removeListener\(\s*'qa_task_changed'/, 'must detach the listener on destroy');
  assert.match(code, /_qaTaskList\(status\.agent_id\)/, '_emit must merge the QA task list');
  assert.ok(code.includes("register('agentStatus.qaTasks'"), 'must register the qaTasks size gauge');
});

test('static: client trusts SSE active_tasks wholesale (no QA re-attach append)', () => {
  const page = fs.readFileSync(path.join(CLIENT_SRC, 'components', 'AgentsPage.tsx'), 'utf8');
  const modal = fs.readFileSync(path.join(CLIENT_SRC, 'components', 'AgentDetailModal.tsx'), 'utf8');
  // AgentsPage must forward payload.active_tasks (it previously dropped it).
  assert.match(page, /active_tasks:\s*payload\.active_tasks/, 'AgentsPage handler must forward payload.active_tasks');
  // Neither surface may re-append preserved kind:'qa' entries — that append can
  // never let SSE remove a completed QA run.
  assert.doesNotMatch(page, /filter\(\(t\)\s*=>\s*t\.kind === 'qa'\)/, 'AgentsPage must not re-attach kind:qa (wholesale trust)');
  assert.doesNotMatch(modal, /filter\(\(t\)\s*=>\s*t\.kind === 'qa'\)/, 'AgentDetailModal must not re-attach kind:qa (wholesale trust)');
});
