// Behavioral test for ActionRunReaperService.runOnce() — drives the reaper
// against an in-memory fake ActionRun repository (no DB) plus fake
// ActionsService / TriggerLoopService collaborators, with a fixed `now`.
//
// The reaper's OWN job is narrow: select stale 'running' rows (age gate off
// created_at, ActionRun has no started_at) and delegate the actual completion
// to ActionsService.completeRun() — reusing its idempotent guarded transition,
// bounded retry, and audit-comment logic rather than duplicating any of it.
// completeRun's own retry/high-impact/idempotency behavior is ActionsService's
// responsibility and is exercised by its own tests; this file fakes that
// collaborator and asserts only how the reaper WIRES to it:
//
//   - age < TTL                                    -> spared, completeRun not called
//   - terminal status (never 'running')             -> never selected
//   - age >= TTL, has source ticket, retries exhausted (shouldResume=true)
//                                                    -> reaped AND source ticket resumed
//   - age >= TTL, has source ticket, mid-retry (shouldResume=false)
//                                                    -> reaped, ticket NOT resumed (retry run owns it)
//   - no source ticket (cron/manual/on-ticket-done run) -> preserved regardless
//     of age; those runs never received the completion contract, so 'running'
//     is a permanent, correct state, not a zombie
//   - age >= TTL, but completeRun reports previouslyCompleted (a real
//     complete_action_run raced the sweep)           -> NOT counted as reaped, no resume
//   - a second sweep after a reap is idempotent (row already terminal)
//
// Imports the compiled service from dist/ (built by `npm run build` in the
// test script), matching the qa-run-reaper-behavior.test.mjs precedent.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ActionRunReaperService } from '../dist/modules/actions/action-run-reaper.service.js';

const HOUR = 60 * 60_000;
const MIN = 60_000;
const NOW = new Date('2026-08-18T12:00:00Z');

function makeRunRepo(rows) {
  return {
    rows,
    async find({ where, take }) {
      const status = where?.status;
      return rows.filter((r) => r.status === status).slice(0, take ?? rows.length);
    },
  };
}

// Fake ActionsService.completeRun — mutates the row (mirroring the real
// guarded status='running' -> terminal transition) and returns exactly the
// fields the reaper reads, driven by per-row test fixtures rather than
// re-implementing the real retry/high-impact decision tree.
function makeActionsService(rows) {
  const calls = [];
  return {
    calls,
    async completeRun(runId, workspaceId, args) {
      calls.push({ runId, workspaceId, args });
      const row = rows.find((r) => r.id === runId);
      if (!row) throw new Error(`no such run ${runId}`);
      if (row.status !== 'running') {
        return {
          run: row, sourceTicketId: row.source_ticket_id || '', status: row.status,
          previouslyCompleted: true, retried: false, retryRunId: '', exhausted: false, shouldResume: false,
        };
      }
      row.status = args.status;
      row.result_summary = args.summary;
      row.completed_at = NOW;
      const sourceTicketId = row.source_ticket_id || '';
      const shouldResume = sourceTicketId ? !!row._shouldResume : false;
      return {
        run: row, sourceTicketId, status: args.status,
        previouslyCompleted: false, retried: !shouldResume && !!sourceTicketId, retryRunId: '',
        exhausted: shouldResume, shouldResume,
      };
    },
  };
}

function makeTriggerLoopService() {
  const calls = [];
  return {
    calls,
    async dispatchCurrentColumn(ticketId, triggerSource, triggeredBy) {
      calls.push({ ticketId, triggerSource, triggeredBy });
      return { emitted: 1 };
    },
  };
}

const noopLog = { info() {}, warn() {}, error() {} };

// ageMs back from NOW.
function makeRun(id, { ageMs, status = 'running', sourceTicketId = '', shouldResume = false, workspaceId = 'ws1' } = {}) {
  return {
    id,
    status,
    workspace_id: workspaceId,
    source_ticket_id: sourceTicketId,
    created_at: new Date(NOW.getTime() - ageMs),
    completed_at: null,
    result_summary: '',
    _shouldResume: shouldResume,
  };
}

test('zombie round-trip: a stuck ticket-driven run past the TTL is reaped and its source ticket is resumed', async () => {
  const rows = [
    makeRun('zombie-1', { ageMs: 3 * HOUR, sourceTicketId: 'tkt-1', shouldResume: true }), // 2h default TTL exceeded, retries exhausted
  ];
  const runRepo = makeRunRepo(rows);
  const actionsService = makeActionsService(rows);
  const triggerLoop = makeTriggerLoopService();
  const svc = new ActionRunReaperService(runRepo, actionsService, triggerLoop, noopLog);

  const { reaped, details } = await svc.runOnce(NOW);

  assert.deepEqual(reaped, ['zombie-1'], 'the stuck run escapes running via the reaper sweep');
  assert.equal(details[0].id, 'zombie-1');
  assert.ok(details[0].age_min >= 179, 'age_min reflects the ~3h staleness');
  assert.equal(rows[0].status, 'failed', 'completeRun closed the run as failed (not a direct status mutation)');
  assert.equal(actionsService.calls.length, 1);
  assert.equal(actionsService.calls[0].args.status, 'failed');
  assert.match(actionsService.calls[0].args.summary, /auto-reaped by ActionRunReaperService/);
  assert.deepEqual(
    triggerLoop.calls,
    [{ ticketId: 'tkt-1', triggerSource: 'action_run_reaped', triggeredBy: '' }],
    'source ticket is resumed via dispatchCurrentColumn exactly once',
  );
});

test('fresh run under the TTL is spared — completeRun is never called', async () => {
  const rows = [makeRun('fresh', { ageMs: 10 * MIN, sourceTicketId: 'tkt-2', shouldResume: true })];
  const runRepo = makeRunRepo(rows);
  const actionsService = makeActionsService(rows);
  const triggerLoop = makeTriggerLoopService();
  const svc = new ActionRunReaperService(runRepo, actionsService, triggerLoop, noopLog);

  const { reaped } = await svc.runOnce(NOW);

  assert.deepEqual(reaped, []);
  assert.equal(actionsService.calls.length, 0, 'completeRun must not be called for a run within the TTL window');
  assert.equal(triggerLoop.calls.length, 0);
  assert.equal(rows[0].status, 'running', 'untouched');
});

test('terminal runs are never selected regardless of age', async () => {
  const rows = [
    makeRun('done-ok', { ageMs: 8 * HOUR, status: 'succeeded' }),
    makeRun('done-fail', { ageMs: 8 * HOUR, status: 'failed' }),
  ];
  const runRepo = makeRunRepo(rows);
  const actionsService = makeActionsService(rows);
  const triggerLoop = makeTriggerLoopService();
  const svc = new ActionRunReaperService(runRepo, actionsService, triggerLoop, noopLog);

  const { reaped } = await svc.runOnce(NOW);

  assert.deepEqual(reaped, []);
  assert.equal(actionsService.calls.length, 0, 'find() only ever asks for status=running, so terminal rows are never fetched');
});

test('stuck run mid-retry (shouldResume=false) is reaped but its ticket is NOT resumed — the retry run owns it', async () => {
  const rows = [makeRun('mid-retry', { ageMs: 3 * HOUR, sourceTicketId: 'tkt-3', shouldResume: false })];
  const runRepo = makeRunRepo(rows);
  const actionsService = makeActionsService(rows);
  const triggerLoop = makeTriggerLoopService();
  const svc = new ActionRunReaperService(runRepo, actionsService, triggerLoop, noopLog);

  const { reaped } = await svc.runOnce(NOW);

  assert.deepEqual(reaped, ['mid-retry'], 'this row is closed (completeRun already dispatched the retry run internally)');
  assert.equal(rows[0].status, 'failed');
  assert.equal(triggerLoop.calls.length, 0, 'no resume dispatch — completeRun said shouldResume=false');
});

test('run with no source ticket (cron/manual/on-ticket-done dispatch) is preserved even past the TTL — its target agent never received the completion contract, so running is a permanent, correct state, not a zombie', async () => {
  const rows = [makeRun('cron-stuck', { ageMs: 3 * HOUR, sourceTicketId: '' })];
  const runRepo = makeRunRepo(rows);
  const actionsService = makeActionsService(rows);
  const triggerLoop = makeTriggerLoopService();
  const svc = new ActionRunReaperService(runRepo, actionsService, triggerLoop, noopLog);

  const { reaped } = await svc.runOnce(NOW);

  assert.deepEqual(reaped, [], 'no source ticket -> not a reap candidate, regardless of age');
  assert.equal(actionsService.calls.length, 0, 'completeRun must never be called for a run without a source ticket');
  assert.equal(triggerLoop.calls.length, 0, 'no source ticket to resume');
  assert.equal(rows[0].status, 'running', 'untouched');
});

test('a run completed by a real concurrent complete_action_run between SELECT and reap is not double-counted', async () => {
  const rows = [makeRun('raced', { ageMs: 3 * HOUR, sourceTicketId: 'tkt-4', shouldResume: true })];
  // Simulate the race: by the time completeRun runs, the row is already terminal.
  rows[0].status = 'succeeded';
  const runRepo = {
    // find() still returns it (it was 'running' at SELECT time in the real DB
    // race window) — the guard lives in completeRun's previouslyCompleted path.
    async find() { return rows; },
  };
  const actionsService = makeActionsService(rows);
  const triggerLoop = makeTriggerLoopService();
  const svc = new ActionRunReaperService(runRepo, actionsService, triggerLoop, noopLog);

  const { reaped } = await svc.runOnce(NOW);

  assert.deepEqual(reaped, [], 'previouslyCompleted runs are not counted as reaped by us');
  assert.equal(triggerLoop.calls.length, 0, 'the real completion already owns any resume decision');
});

test('runOnce is idempotent — a second sweep reaps nothing once the row is terminal', async () => {
  const rows = [makeRun('zombie-2', { ageMs: 3 * HOUR, sourceTicketId: 'tkt-5', shouldResume: true })];
  const runRepo = makeRunRepo(rows);
  const actionsService = makeActionsService(rows);
  const triggerLoop = makeTriggerLoopService();
  const svc = new ActionRunReaperService(runRepo, actionsService, triggerLoop, noopLog);

  const first = await svc.runOnce(NOW);
  assert.deepEqual(first.reaped, ['zombie-2']);

  const second = await svc.runOnce(NOW);
  assert.deepEqual(second.reaped, [], 'row is now status=failed, so find({status:running}) no longer selects it');
  assert.equal(triggerLoop.calls.length, 1, 'no duplicate resume on the second, no-op sweep');
});
