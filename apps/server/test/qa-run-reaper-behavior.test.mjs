// Behavioral test for QaRunReaperService.runOnce() — drives the reaper against
// an in-memory fake QaRun repository (no DB) with a fixed `now`. The default
// (no-policy) `zero_progress` liveness detector keeps the two pre-ticket fuses
// (ticket 40010b25 made the detector pluggable but `zero_progress` is unchanged):
//
//   zero-progress fuse (fast, 0-step runs only):
//     • running, 0 steps, older than the 40m zero-progress window  -> reap (zero-progress)
//     • pending, 0 steps, older than the window                    -> reap (zero-progress)
//     • running, 0 steps, within the window                        -> spare
//     • running, ≥1 step, past the window but under 6h TTL         -> spare (made progress)
//
//   6h-TTL fuse (absolute backstop, any step count):
//     • running, ≥1 step, older than 6h TTL                        -> reap (6h-TTL)
//     • started_at=null falls back to created_at for the age gate  -> reap
//
//   terminal runs (passed/failed) are never selected/touched, finished_at is
//   stamped, the summary carries a fuse-labelled marker, and a second sweep is
//   idempotent.
//
// Imports the compiled service from dist/ (built by `npm run build` in the test
// script) and injects stub repos + a stub logger, exactly the seams the service
// exposes via constructor + the `now` param on runOnce(). These fixtures carry no
// scenario_id/board_id, so they exercise the default zero_progress policy and the
// scenario/board repos are never queried — empty stubs suffice. The
// heartbeat_deadline policy is covered in qa-liveness-policy.test.mjs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QaRunReaperService } from '../dist/modules/qa/qa-run-reaper.service.js';

const HOUR = 60 * 60_000;
const MIN = 60_000;

function makeRepo(rows) {
  return {
    rows,
    saved: [],
    async find({ where, take }) {
      // Service passes In(['running','pending']); emulate by reading the FindOperator's _value.
      const statuses = where.status?._value || where.status?._object || ['running', 'pending'];
      return rows.filter((r) => statuses.includes(r.status)).slice(0, take ?? rows.length);
    },
    async save(row) {
      this.saved.push(row.id);
      return row;
    },
  };
}

const noopLog = { info() {}, warn() {}, error() {} };
// Reaper now advances any sequential batch a reaped run belonged to. These
// fixture runs have no batch_id, so onRunFinalized early-returns — a no-op stub
// matches the real (DI-injected) QaRunService surface the reaper depends on.
const noopQaRunService = { onRunFinalized: async () => {} };
// Scenario/Board repos the reaper bulk-queries to resolve each run's liveness
// policy. These fixtures carry no scenario_id/board_id, so the queries never run;
// an empty stub is enough.
const emptyRepo = { async find() { return []; } };

const NOW = new Date('2026-06-22T21:00:00Z');

// ageMs back from NOW. steps=number of recorded step_results entries.
function makeRun(id, status, ageMs, { startedNull = false, steps = 0 } = {}) {
  const ts = new Date(NOW.getTime() - ageMs);
  return {
    id,
    status,
    started_at: startedNull ? null : ts,
    created_at: ts,
    finished_at: null,
    step_results: steps > 0 ? Array.from({ length: steps }, (_, i) => ({ idx: i, status: 'passed' })) : null,
    summary: '',
  };
}

test('zero-progress fuse: 0-step runs past the 40m window are reaped; fresh / progressing runs spared', async () => {
  const rows = [
    makeRun('zp-running', 'running', 50 * MIN),                 // 0 steps, 50m > 40m -> reap (zero-progress)
    makeRun('zp-pending', 'pending', 45 * MIN),                // 0 steps, 45m       -> reap (zero-progress)
    makeRun('zp-startednull', 'running', 45 * MIN, { startedNull: true }), // created_at fallback -> reap
    makeRun('fresh-0step', 'running', 10 * MIN),               // 0 steps, 10m < 40m -> spare
    makeRun('progressing', 'running', 50 * MIN, { steps: 3 }), // has steps, < 6h    -> spare
    makeRun('done-passed', 'passed', 50 * MIN),                // terminal           -> never selected
    makeRun('done-failed', 'failed', 50 * MIN),               // terminal           -> never selected
  ];
  const repo = makeRepo(rows);
  const svc = new QaRunReaperService(repo, emptyRepo, emptyRepo, noopLog, noopQaRunService);

  const { reaped, details } = await svc.runOnce(NOW);

  assert.deepEqual(
    reaped.sort(),
    ['zp-pending', 'zp-running', 'zp-startednull'].sort(),
    'exactly the stale 0-step runs are reaped',
  );
  for (const d of details) assert.match(d.reason, /fuse: zero-progress/, `${d.id} reaped via zero-progress fuse`);

  const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
  for (const id of reaped) {
    assert.equal(byId[id].status, 'error', `${id} closed with status=error`);
    assert.ok(byId[id].finished_at instanceof Date, `${id} stamps finished_at`);
    assert.match(byId[id].summary, /auto-reaped by QaRunReaperService/, `${id} carries marker`);
    assert.match(byId[id].summary, /fuse: zero-progress/, `${id} marker names the zero-progress fuse`);
    assert.match(byId[id].summary, /NOT a tested failure/, `${id} marker distinguishes from a real failure`);
  }
  assert.equal(byId['fresh-0step'].status, 'running', 'fresh 0-step run within window untouched');
  assert.equal(byId['progressing'].status, 'running', 'run with recorded steps (progressing) untouched');
  assert.equal(byId['done-passed'].status, 'passed', 'passed run untouched');
  assert.equal(byId['done-failed'].status, 'failed', 'failed run untouched');
});

test('6h-TTL fuse: a progressing run that stalls past 6h is reaped via the absolute backstop', async () => {
  const rows = [
    makeRun('stale-progressed', 'running', 8 * HOUR, { steps: 5 }), // has steps but 8h > 6h -> reap (6h-TTL)
    makeRun('stale-0step', 'running', 7 * HOUR),                    // 0 steps, 7h -> reap (TTL trips first)
    makeRun('progressing-5h', 'running', 5 * HOUR, { steps: 5 }),   // has steps, 5h < 6h -> spare
  ];
  const repo = makeRepo(rows);
  const svc = new QaRunReaperService(repo, emptyRepo, emptyRepo, noopLog, noopQaRunService);

  const { reaped, details } = await svc.runOnce(NOW);

  assert.deepEqual(reaped.sort(), ['stale-0step', 'stale-progressed'].sort(), 'both >6h runs reaped');
  const reason = Object.fromEntries(details.map((d) => [d.id, d.reason]));
  assert.match(reason['stale-progressed'], /fuse: 6h-TTL/, 'progressed-then-stalled run reaped via 6h-TTL');
  assert.match(reason['stale-0step'], /fuse: 6h-TTL/, '0-step run past 6h reaped via 6h-TTL (absolute takes precedence)');

  const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
  assert.match(byId['stale-progressed'].summary, /fuse: 6h-TTL/, 'marker names the 6h-TTL fuse');
  assert.equal(byId['progressing-5h'].status, 'running', 'progressing run under 6h untouched');
});

test('runOnce is idempotent — a second sweep reaps nothing', async () => {
  const rows = [
    makeRun('zp-running', 'running', 50 * MIN),       // zero-progress
    makeRun('ttl-running', 'running', 8 * HOUR, { steps: 2 }), // 6h-TTL
  ];
  const repo = makeRepo(rows);
  const svc = new QaRunReaperService(repo, emptyRepo, emptyRepo, noopLog, noopQaRunService);

  const first = await svc.runOnce(NOW);
  assert.deepEqual(first.reaped.sort(), ['ttl-running', 'zp-running'].sort(), 'first sweep reaps both stale runs');

  const second = await svc.runOnce(NOW);
  assert.deepEqual(second.reaped, [], 'second sweep reaps nothing (now terminal)');
});
