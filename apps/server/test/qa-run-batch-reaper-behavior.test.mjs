// Behavioral test for QaRunBatchReaperService.runOnce() — drives the reaper
// against an in-memory fake QaRunBatch repository (no DB) and a spy
// QaRunService.resumeWedgedBatch (ticket 5a0593ae). Covers:
//
//   • wedge signature (status='running', no run recorded at current_index)
//     → resumeWedgedBatch called for that batch id.
//   • a genuinely in-flight/live batch (a run IS recorded at current_index)
//     → spared, resumeWedgedBatch never called for it.
//   • done/aborted batches are never selected (outside the sweep's own scope).
//   • multiple wedged batches in one sweep are all resumed.
//   • an overlapping runOnce() call while a sweep is in progress is dropped
//     (mirrors ActionRunReaperService/OrchestrationReaperService's `sweeping`
//     guard) rather than racing the first sweep.
//
// Imports the compiled service from dist/ (built by `npm run build` in the
// test script) and injects a stub repo + a resumeWedgedBatch spy — the seams
// the service exposes via its constructor.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QaRunBatchReaperService } from '../dist/modules/qa/qa-run-batch-reaper.service.js';

const noopLog = { info() {}, warn() {}, error() {} };

function makeBatchRepo(rows) {
  return {
    rows,
    async find({ where, take }) {
      const status = where?.status;
      return rows.filter((r) => (status ? r.status === status : true)).slice(0, take ?? rows.length);
    },
  };
}

function makeBatch(id, over = {}) {
  return {
    id,
    status: 'running',
    run_ids: [],
    current_index: 0,
    scenario_ids: ['s0', 's1'],
    created_at: new Date('2026-06-22T20:00:00Z'),
    ...over,
  };
}

function makeQaRunService(impl) {
  const calls = [];
  return {
    calls,
    async resumeWedgedBatch(batchId) {
      calls.push(batchId);
      if (impl) await impl(batchId);
    },
  };
}

test('wedged batch (no run at current_index) is resumed via QaRunService.resumeWedgedBatch', async () => {
  const rows = [makeBatch('wedged-1', { current_index: 1, run_ids: ['run-0'] })];
  const repo = makeBatchRepo(rows);
  const qaRunService = makeQaRunService();
  const svc = new QaRunBatchReaperService(repo, noopLog, qaRunService);

  const { resumed } = await svc.runOnce();

  assert.deepEqual(resumed, ['wedged-1']);
  assert.deepEqual(qaRunService.calls, ['wedged-1'], 'resumeWedgedBatch called with the wedged batch id');
});

test('a batch with a live run recorded at current_index is spared (not actually wedged)', async () => {
  const rows = [makeBatch('live-1', { current_index: 1, run_ids: ['run-0', 'run-1'] })];
  const repo = makeBatchRepo(rows);
  const qaRunService = makeQaRunService();
  const svc = new QaRunBatchReaperService(repo, noopLog, qaRunService);

  const { resumed } = await svc.runOnce();

  assert.deepEqual(resumed, [], 'nothing resumed — a live run is already recorded at current_index');
  assert.deepEqual(qaRunService.calls, [], 'resumeWedgedBatch never called for a genuinely in-flight batch');
});

test('done/aborted batches are outside the sweep scope entirely', async () => {
  const rows = [
    makeBatch('done-1', { status: 'done', run_ids: ['run-0', 'run-1'] }),
    makeBatch('aborted-1', { status: 'aborted', current_index: 1, run_ids: ['run-0'] }),
  ];
  const repo = makeBatchRepo(rows);
  const qaRunService = makeQaRunService();
  const svc = new QaRunBatchReaperService(repo, noopLog, qaRunService);

  const { resumed } = await svc.runOnce();

  assert.deepEqual(resumed, [], 'terminal batches are never candidates');
  assert.deepEqual(qaRunService.calls, []);
});

test('multiple wedged batches in one sweep are all resumed, spared ones are skipped', async () => {
  const rows = [
    makeBatch('wedged-a', { current_index: 0, run_ids: [] }),
    makeBatch('live-b', { current_index: 0, run_ids: ['run-0'] }),
    makeBatch('wedged-c', { current_index: 2, run_ids: ['run-0', 'run-1'] }),
  ];
  const repo = makeBatchRepo(rows);
  const qaRunService = makeQaRunService();
  const svc = new QaRunBatchReaperService(repo, noopLog, qaRunService);

  const { resumed } = await svc.runOnce();

  assert.deepEqual(resumed.sort(), ['wedged-a', 'wedged-c'].sort());
  assert.deepEqual(qaRunService.calls.sort(), ['wedged-a', 'wedged-c'].sort());
});

test('an overlapping runOnce() call is dropped while a sweep is already in progress', async () => {
  const rows = [makeBatch('wedged-1', { current_index: 0, run_ids: [] })];
  const repo = makeBatchRepo(rows);
  let release;
  const gate = new Promise((r) => { release = r; });
  const qaRunService = makeQaRunService(async () => { await gate; });
  const svc = new QaRunBatchReaperService(repo, noopLog, qaRunService);

  const first = svc.runOnce(); // starts sweeping, pauses inside resumeWedgedBatch
  await Promise.resolve(); // let the first sweep reach the paused resumeWedgedBatch call
  const second = await svc.runOnce(); // overlapping call — dropped immediately

  assert.deepEqual(second, { resumed: [] }, 'overlapping sweep returns immediately with nothing resumed');
  assert.equal(qaRunService.calls.length, 1, 'the overlapping call did not re-invoke resumeWedgedBatch');

  release();
  const firstResult = await first;
  assert.deepEqual(firstResult.resumed, ['wedged-1'], 'the original sweep completes normally once unblocked');
});

test('an empty batch table sweeps to a no-op', async () => {
  const repo = makeBatchRepo([]);
  const qaRunService = makeQaRunService();
  const svc = new QaRunBatchReaperService(repo, noopLog, qaRunService);

  const { resumed } = await svc.runOnce();
  assert.deepEqual(resumed, []);
});
