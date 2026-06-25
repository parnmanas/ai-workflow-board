// Behavioral test for QaScheduleService.runOnce() — drives the scheduler sweep
// against in-memory fake repos with a fixed `now` (ticket b6bb7efd). Covers the
// three acceptance points from the ticket's 검증 section plus the overlap policy:
//
//   • scope='all' due schedule → kicks startBatch({all:true}) + advances
//     next_run_at + stamps last_run_at/last_batch_id.
//   • Idempotency / overlap — next_run_at is advanced BEFORE dispatch, so a
//     second sweep at the SAME `now` re-dispatches nothing (cursor moved past).
//   • scope='selected' → startBatch({scenarioIds}) with exactly the listed ids.
//   • run-now manual trigger fires regardless of `enabled` and does NOT disturb
//     next_run_at.
//   • disabled schedule is never swept (negative case).
//   • SKIP-if-running — a schedule whose previous batch is still 'running' is
//     skipped (next_run_at still advanced, no overlapping dispatch).
//   • orphan self-heal — an enabled schedule with next_run_at=null gets a cursor
//     computed forward WITHOUT firing on the same sweep.
//
// Imports the compiled service from dist/ (built by `npm run build`) and injects
// stub repos + a startBatch spy — the seams the service exposes via its
// constructor and the `now` param on runOnce()/computeNextRun().

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QaScheduleService } from '../dist/modules/qa/qa-schedule.service.js';

const MIN = 60_000;
const NOW = new Date('2026-06-25T12:00:00Z');

const noopLog = { info() {}, warn() {}, error() {} };

// Stub schedule repo over a plain-object row array. Handles the two find shapes
// runOnce uses: { enabled, next_run_at: IsNull() } and
// { enabled, next_run_at: LessThanOrEqual(now) } (+ order/take). save() is a
// no-op recorder — the service mutates the same row reference it read.
function makeScheduleRepo(rows) {
  return {
    rows,
    saves: [],
    async find(opts = {}) {
      const where = opts.where || {};
      const op = where.next_run_at; // a TypeORM FindOperator or undefined
      let res = rows.filter((r) => {
        if (where.enabled !== undefined && r.enabled !== where.enabled) return false;
        if (op) {
          // IsNull() carries no _value; LessThanOrEqual(now) carries the Date.
          const threshold = op._value;
          if (threshold === undefined || threshold === null) {
            if (r.next_run_at !== null && r.next_run_at !== undefined) return false;
          } else {
            const thresh = new Date(threshold).getTime();
            if (!(r.next_run_at && new Date(r.next_run_at).getTime() <= thresh)) return false;
          }
        }
        return true;
      });
      if (opts.order?.next_run_at) {
        res = res.slice().sort((a, b) => new Date(a.next_run_at) - new Date(b.next_run_at));
      }
      if (opts.take) res = res.slice(0, opts.take);
      return res;
    },
    async findOne({ where }) {
      return rows.find((r) => r.id === where.id) || null;
    },
    async save(row) {
      this.saves.push(row.id);
      return row;
    },
  };
}

function makeBatchRepo(batches = []) {
  return {
    batches,
    async findOne({ where }) {
      return batches.find((b) => b.id === where.id) || null;
    },
  };
}

// startBatch spy — records every call and returns a fake running batch.
function makeQaRunService() {
  const calls = [];
  let seq = 0;
  return {
    calls,
    async startBatch(args) {
      seq += 1;
      const id = `batch-${seq}`;
      calls.push({ id, args });
      return { id, scenario_ids: args.scenarioIds || ['a', 'b'], status: 'running' };
    },
  };
}

function makeSchedule(over = {}) {
  return {
    id: 'sch-1',
    workspace_id: 'ws-1',
    board_id: null,
    name: 'nightly',
    scope: 'all',
    scenario_ids: null,
    cron: null,
    interval_ms: 30 * MIN,
    enabled: true,
    stop_on_fail: false,
    next_run_at: new Date(NOW.getTime() - MIN), // due (1 min ago)
    last_run_at: null,
    last_batch_id: null,
    triggered_by_type: 'user',
    created_by: '',
    ...over,
  };
}

function svcWith(rows, batches = []) {
  const scheduleRepo = makeScheduleRepo(rows);
  const batchRepo = makeBatchRepo(batches);
  const qaRunService = makeQaRunService();
  const svc = new QaScheduleService(scheduleRepo, batchRepo, qaRunService, noopLog);
  return { svc, scheduleRepo, batchRepo, qaRunService };
}

test("scope='all' due schedule dispatches startBatch({all}) and advances next_run_at", async () => {
  const sch = makeSchedule({ scope: 'all', board_id: 'board-9' });
  const { svc, qaRunService } = svcWith([sch]);

  const { dispatched, skipped } = await svc.runOnce(NOW);

  assert.deepEqual(dispatched, ['sch-1'], 'the due schedule is dispatched');
  assert.deepEqual(skipped, [], 'nothing skipped');
  assert.equal(qaRunService.calls.length, 1, 'startBatch called once');
  const { args } = qaRunService.calls[0];
  assert.equal(args.all, true, 'scope=all → all:true');
  assert.equal(args.boardId, 'board-9', 'board scope passed through');
  assert.equal(args.scenarioIds, undefined, 'no explicit id list for scope=all');
  assert.equal(args.triggeredByType, 'system');
  assert.equal(sch.last_batch_id, 'batch-1', 'last_batch_id stamped');
  assert.ok(sch.last_run_at instanceof Date, 'last_run_at stamped');
  // next_run_at advanced to now + interval (30m), i.e. strictly in the future.
  assert.ok(new Date(sch.next_run_at).getTime() > NOW.getTime(), 'next_run_at moved into the future');
  assert.equal(new Date(sch.next_run_at).getTime(), NOW.getTime() + 30 * MIN, 'next_run_at = now + interval');
});

test('idempotency: a second sweep at the same `now` re-dispatches nothing (cursor advanced)', async () => {
  const sch = makeSchedule();
  const { svc, qaRunService } = svcWith([sch]);

  const first = await svc.runOnce(NOW);
  assert.deepEqual(first.dispatched, ['sch-1'], 'first sweep fires');

  const second = await svc.runOnce(NOW);
  assert.deepEqual(second.dispatched, [], 'second sweep at same now fires nothing — next_run_at is past now');
  assert.equal(qaRunService.calls.length, 1, 'startBatch still called exactly once total');
});

test("scope='selected' dispatches startBatch with exactly the listed scenario ids", async () => {
  const sch = makeSchedule({ scope: 'selected', scenario_ids: ['s-a', 's-b'], interval_ms: 10 * MIN });
  const { svc, qaRunService } = svcWith([sch]);

  await svc.runOnce(NOW);
  assert.equal(qaRunService.calls.length, 1);
  const { args } = qaRunService.calls[0];
  assert.deepEqual(args.scenarioIds, ['s-a', 's-b'], 'only the selected ids run');
  assert.notEqual(args.all, true, 'not an all-scope dispatch');
});

test('disabled schedule is never swept even when overdue', async () => {
  const sch = makeSchedule({ enabled: false, next_run_at: new Date(NOW.getTime() - 60 * MIN) });
  const { svc, qaRunService } = svcWith([sch]);

  const { dispatched } = await svc.runOnce(NOW);
  assert.deepEqual(dispatched, [], 'disabled schedule not dispatched');
  assert.equal(qaRunService.calls.length, 0, 'startBatch never called');
});

test('SKIP-if-running: previous batch still running → skipped, next_run_at still advanced', async () => {
  const sch = makeSchedule({ last_batch_id: 'prev-batch' });
  const { svc, qaRunService } = svcWith([sch], [{ id: 'prev-batch', status: 'running' }]);

  const { dispatched, skipped } = await svc.runOnce(NOW);
  assert.deepEqual(dispatched, [], 'no dispatch while previous batch runs');
  assert.deepEqual(skipped, ['sch-1'], 'this occurrence is skipped');
  assert.equal(qaRunService.calls.length, 0, 'startBatch not called');
  assert.ok(new Date(sch.next_run_at).getTime() > NOW.getTime(), 'cursor still advanced so it retries next occurrence');
  assert.equal(sch.last_batch_id, 'prev-batch', 'last_batch_id untouched on skip');
});

test('a finished previous batch does NOT block the next dispatch', async () => {
  const sch = makeSchedule({ last_batch_id: 'prev-batch' });
  const { svc, qaRunService } = svcWith([sch], [{ id: 'prev-batch', status: 'done' }]);

  const { dispatched, skipped } = await svc.runOnce(NOW);
  assert.deepEqual(dispatched, ['sch-1'], 'done previous batch → dispatch proceeds');
  assert.deepEqual(skipped, []);
  assert.equal(qaRunService.calls.length, 1);
  assert.equal(sch.last_batch_id, 'batch-1', 'last_batch_id updated to the new batch');
});

test('orphan self-heal: enabled schedule with next_run_at=null gets a cursor WITHOUT firing', async () => {
  const sch = makeSchedule({ next_run_at: null });
  const { svc, qaRunService } = svcWith([sch]);

  const { dispatched } = await svc.runOnce(NOW);
  assert.deepEqual(dispatched, [], 'orphan is not fired on the heal sweep');
  assert.equal(qaRunService.calls.length, 0, 'startBatch not called');
  assert.ok(sch.next_run_at instanceof Date, 'next_run_at computed forward');
  assert.equal(new Date(sch.next_run_at).getTime(), NOW.getTime() + 30 * MIN, 'cursor = now + interval');
});

test('runNow fires regardless of enabled and does NOT disturb next_run_at', async () => {
  const futureCursor = new Date(NOW.getTime() + 30 * MIN);
  const sch = makeSchedule({ id: 'sch-rn', enabled: false, next_run_at: futureCursor });
  const { svc, qaRunService } = svcWith([sch]);

  const { schedule, batch } = await svc.runNow('sch-rn', 'ws-1', 'tester');
  assert.equal(qaRunService.calls.length, 1, 'startBatch called by run-now even though disabled');
  assert.equal(batch.id, 'batch-1');
  assert.equal(schedule.last_batch_id, 'batch-1', 'last_batch_id stamped');
  assert.ok(schedule.last_run_at instanceof Date, 'last_run_at stamped');
  assert.equal(new Date(schedule.next_run_at).getTime(), futureCursor.getTime(), 'next_run_at NOT moved by a manual run');
});

test('computeNextRun: cron vs interval vs disabled', () => {
  const { svc } = svcWith([]);
  const cronNext = svc.computeNextRun({ enabled: true, cron: '0 3 * * *', interval_ms: null }, new Date('2026-06-25T02:00:00Z'));
  assert.equal(cronNext.toISOString(), '2026-06-25T03:00:00.000Z', 'cron next firing');
  const intNext = svc.computeNextRun({ enabled: true, cron: null, interval_ms: 5 * MIN }, NOW);
  assert.equal(intNext.getTime(), NOW.getTime() + 5 * MIN, 'interval next firing');
  assert.equal(svc.computeNextRun({ enabled: false, cron: '0 3 * * *', interval_ms: null }, NOW), null, 'disabled → null');
});
