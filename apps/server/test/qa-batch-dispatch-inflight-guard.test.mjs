// Behavioral test for QaRunService's in-flight batch-dispatch guard
// (_inFlightBatchIds, ticket 5a0593ae) — the race a reviewer flagged once a
// schedule-agnostic reaper (QaRunBatchReaperService) becomes a THIRD caller
// into _dispatchBatchIndex, alongside onRunFinalized (agent-driven completion
// / the run reaper) and the schedule-tick resume (both funnel through
// resumeWedgedBatch).
//
// onRunFinalized persists the advanced current_index BEFORE awaiting the
// (slow) dispatch — see its comment in qa-run.service.ts. During that await
// window the batch's DB state (running, no run yet recorded at current_index)
// is indistinguishable from a genuine wedge, so a resume entry point racing
// that window would previously double-dispatch the SAME index.
//
// This test reproduces the race directly instead of hoping real async I/O
// happens to interleave the right way: it kicks off onRunFinalized (without
// awaiting it), waits for a signal that the dispatch is genuinely mid-flight
// (paused inside the fake sendMessage — i.e. AFTER the in-flight guard was
// set), THEN fires a concurrent resumeWedgedBatch for the same batch and
// asserts it is a no-op.
//
// Wiring mirrors qa-dispatch-failfast.test.mjs's makeSvc (same constructor
// positional-arg order); the throwing dataSource stub is the same trick used
// there — it fail-opens the run-budget check and degrades buildRunProvision's
// repo lookups to null, so this test can focus purely on the mutex.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QaRunService } from '../dist/modules/qa/qa-run.service.js';

const noopLog = { info() {}, warn() {}, error() {}, debug() {} };
const identity = (o) => o;

function makeScenario() {
  return {
    id: 'scn-shared',
    name: 'shared scenario',
    workspace_id: 'ws-1',
    board_id: null,
    target_agent_id: 'agent-1',
    enabled: true,
    max_runs: 20,
    steps: [],
    qa_driver: 'http-api',
    on_failure_ticket: null,
    workspace_folder: null,
    repo_ref: null,
    checkout_mode: null,
    target_environment: '',
  };
}

// buildRunProvision degrades repo -> null on any throw; enforceRunBudget
// fail-opens the same way (wraps its config/count resolution in try/catch) —
// exactly the fixture qa-dispatch-failfast.test.mjs already relies on.
const dataSource = { getRepository: () => ({ findOne: async () => { throw new Error('no repo'); } }) };

function makeRunRepo() {
  return {
    saves: [],
    create: identity,
    async save(row) { this.saves.push(row); return row; },
    async find() { return []; }, // _pruneOldRuns -> nothing to prune
  };
}

function makeBatchRepo(initial) {
  const rows = new Map([[initial.id, initial]]);
  return {
    rows,
    saves: [],
    async findOne({ where }) { return rows.get(where.id) ?? null; },
    async save(row) { rows.set(row.id, row); this.saves.push({ ...row }); return row; },
  };
}

function makeSvc({ batch, onSend }) {
  const runRepo = makeRunRepo();
  const batchRepo = makeBatchRepo(batch);
  const captured = { sendCalls: 0 };
  const scenarioRepo = { async findOne() { return makeScenario(); }, async update() {} };
  const agentRepo = { async findOne() { return { id: 'agent-1', name: 'QA-Agent', type: 'agent' }; } };
  const roomRepo = { create: identity, async save(r) { return { ...r, id: `room-${captured.sendCalls}` }; } };
  const participantRepo = { create: identity, async save() {} };
  const empty = {};
  const messaging = {
    async sendMessage(...args) {
      captured.sendCalls += 1;
      if (onSend) await onSend(captured.sendCalls, args);
      return { id: `msg-${captured.sendCalls}` };
    },
  };
  const svc = new QaRunService(
    scenarioRepo,    // scenarioRepo
    runRepo,         // runRepo
    batchRepo,       // batchRepo
    roomRepo,        // roomRepo
    participantRepo, // participantRepo
    empty,           // messageRepo
    empty,           // attachmentRepo
    empty,           // resourceRepo
    agentRepo,       // agentRepo
    dataSource,      // dataSource
    messaging,       // messaging
    noopLog,         // logService
    empty,           // failureTicketService
  );
  return { svc, runRepo, batchRepo, captured };
}

function makeBatch(over = {}) {
  return {
    id: 'batch-1',
    workspace_id: 'ws-1',
    board_id: null,
    scenario_ids: ['s0', 's1'],
    run_ids: ['run-0'],
    current_index: 0,
    status: 'running',
    stop_on_fail: false,
    passed: 0,
    failed: 0,
    errored: 0,
    triggered_by_type: 'user',
    triggered_by_id: '',
    finished_at: null,
    ...over,
  };
}

function makeGate() {
  let release;
  const wait = new Promise((r) => { release = r; });
  return { wait, release };
}

test('a resumeWedgedBatch call concurrent with an in-flight onRunFinalized dispatch is a no-op (no double dispatch)', async () => {
  const batch = makeBatch({ current_index: 0, run_ids: ['run-0'] });
  const paused = makeGate();
  const reachedSend = makeGate();
  const { svc, runRepo, captured } = makeSvc({
    batch,
    onSend: async (n) => {
      if (n === 1) {
        reachedSend.release(); // signal: the dispatch is now mid-flight (past the in-flight add)
        await paused.wait;     // hold it here so the race window stays open
      }
    },
  });

  const finishedRun = { id: 'run-0', batch_id: 'batch-1', batch_index: 0, status: 'passed' };

  // Entry ① — onRunFinalized (agent-driven completeRun / the run reaper).
  // Deliberately not awaited: it saves current_index=1 then awaits the slow
  // dispatch for index 1, which is where it gets paused above.
  const first = svc.onRunFinalized(finishedRun);
  await reachedSend.wait; // wait until the dispatch is genuinely in flight

  // Entry ②/③ — a schedule tick or QaRunBatchReaperService racing the same
  // window. DB state right now is exactly the wedge signature (running, no
  // run recorded at index 1 yet) — the in-flight guard is the only thing
  // that can tell the difference.
  await svc.resumeWedgedBatch('batch-1');

  assert.equal(captured.sendCalls, 1, 'the concurrent resume did not trigger a second dispatch');

  paused.release();
  await first;

  assert.equal(captured.sendCalls, 1, 'still exactly one dispatch once the original onRunFinalized call completes');
  assert.equal(runRepo.saves.length, 1, 'exactly one QaRun row created for index 1');
  assert.equal(runRepo.saves[0].batch_index, 1);
});

test('once the in-flight dispatch completes, a genuinely wedged batch IS resumed on the next call (guard releases cleanly)', async () => {
  const batch = makeBatch({ current_index: 1, run_ids: ['run-0'] }); // wedge signature: no run at index 1
  const { svc, runRepo, captured, batchRepo } = makeSvc({ batch });

  await svc.resumeWedgedBatch('batch-1');

  assert.equal(captured.sendCalls, 1, 'the wedge is resumed');
  const saved = batchRepo.rows.get('batch-1');
  assert.equal(saved.run_ids[1], runRepo.saves[0].id, 'run recorded at the resumed index');

  // The guard must have released after the first call — a second, genuinely
  // fresh wedge (a later index) must not be silently swallowed by a stale guard.
  saved.current_index = 2;
  saved.run_ids = [...saved.run_ids, undefined];
  saved.scenario_ids = ['s0', 's1', 's2'];
  await svc.resumeWedgedBatch('batch-1');
  assert.equal(captured.sendCalls, 2, 'a later, distinct wedge on the same batch is still resumable — the guard is not stuck');
});
