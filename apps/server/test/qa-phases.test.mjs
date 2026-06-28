// Multi-phase QA model (ticket 90cc22f7).
//
// Covers the server foundation: the qa_phases parse/resolve contract, the
// auto-selection of the `phase_timeouts` liveness policy, the reaper's per-phase
// timeout reap decision, and the setPhase transition bookkeeping.
//
//   (a) parseQaPhases validates + normalizes + fails safe to null
//   (b) resolveQaPhases precedence: scenario ?? board ?? null
//   (c) resolveLivenessPolicy auto-selects phase_timeouts when phases exist and
//       no explicit policy is set; an explicit policy still wins
//   (d) reaper: an active phase within its timeout is spared; past it, reaped
//       with a reason naming the phase
//   (e) reaper: an unset/unmatched current_phase falls back (first phase timeout)
//   (f) a board WITH phases but a long-not-overdue phase is not reaped on age
//   (g) setPhase stamps current_phase/at + appends history + closes prev left_at;
//       rejects a terminal run
//
// Imports the compiled modules from dist/ (built by `npm run build`).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QaRunReaperService } from '../dist/modules/qa/qa-run-reaper.service.js';
import { QaRunService } from '../dist/modules/qa/qa-run.service.js';
import {
  parseQaPhases,
  resolveQaPhases,
  serializeQaPhases,
  findPhase,
} from '../dist/modules/qa/qa-phases.js';
import { resolveLivenessPolicy } from '../dist/modules/qa/qa-liveness-policy.js';

const SEC = 1000;
const HOUR = 60 * 60_000;
const NOW = new Date('2026-06-28T12:00:00Z');

const PHASES = {
  phases: [
    { id: 'import', label: 'Import', timeout_sec: 600 },
    { id: 'build', label: 'Build', timeout_sec: 1800 },
    { id: 'run', label: 'Run', timeout_sec: 3600 },
  ],
};

function makeRunRepo(rows) {
  return {
    rows,
    saved: [],
    async find({ where, take }) {
      const statuses = where.status?._value || where.status?._object || ['running', 'pending'];
      return rows.filter((r) => statuses.includes(r.status)).slice(0, take ?? rows.length);
    },
    async save(row) {
      this.saved.push(row.id);
      return row;
    },
  };
}

const listRepo = (rows) => ({ async find() { return rows; } });

function makeRun(id, overrides = {}) {
  return {
    id,
    scenario_id: 'sc-ph',
    board_id: null,
    status: 'running',
    started_at: new Date(NOW.getTime() - 2 * HOUR),
    created_at: new Date(NOW.getTime() - 2 * HOUR),
    finished_at: null,
    step_results: [],
    liveness_token: null,
    liveness_token_at: null,
    current_phase: null,
    current_phase_at: null,
    phase_history: null,
    summary: '',
    ...overrides,
  };
}

const noopLog = { info() {}, warn() {}, error() {} };
const noopQaRunService = { onRunFinalized: async () => {} };

// ── (a) parse ────────────────────────────────────────────────────────────────

test('(a) parseQaPhases validates, normalizes, fails safe to null', () => {
  assert.equal(parseQaPhases(null), null, 'null → null');
  assert.equal(parseQaPhases(''), null, 'empty → null');
  assert.equal(parseQaPhases('{not json'), null, 'bad JSON → null (never throws)');
  assert.equal(parseQaPhases('{"phases":[]}'), null, 'empty phases → null');
  assert.equal(parseQaPhases('{"phases":"x"}'), null, 'non-array phases → null');
  assert.equal(parseQaPhases('{"phases":[{"id":"a"}]}'), null, 'phase without timeout → dropped → null');

  // Drops a malformed entry (no timeout) but keeps the valid one.
  assert.deepEqual(
    parseQaPhases('{"phases":[{"id":"import","timeout_sec":600},{"id":"bad"}]}'),
    { phases: [{ id: 'import', timeout_sec: 600 }] },
  );
  // Duplicate id collapses to the first occurrence.
  assert.deepEqual(
    parseQaPhases('{"phases":[{"id":"x","timeout_sec":10},{"id":"x","timeout_sec":99}]}'),
    { phases: [{ id: 'x', timeout_sec: 10 }] },
  );
  // Label preserved; timeout floored.
  assert.deepEqual(
    parseQaPhases(serializeQaPhases(PHASES)),
    PHASES,
  );
  assert.equal(findPhase(PHASES, 'build')?.timeout_sec, 1800);
  assert.equal(findPhase(PHASES, 'nope'), null);
  assert.equal(findPhase(null, 'build'), null);
});

// ── (b) resolve precedence ───────────────────────────────────────────────────

test('(b) resolveQaPhases: scenario ?? board ?? null', () => {
  const board = serializeQaPhases(PHASES);
  const scenario = serializeQaPhases({ phases: [{ id: 'only', timeout_sec: 5 }] });

  assert.deepEqual(resolveQaPhases(scenario, board).phases[0].id, 'only', 'scenario wins');
  assert.deepEqual(resolveQaPhases(null, board), PHASES, 'board used when no scenario');
  assert.equal(resolveQaPhases(null, null), null, 'null when neither set');
  // Malformed scenario falls through to the board.
  assert.deepEqual(resolveQaPhases('{bogus', board), PHASES);
});

// ── (c) auto-selection ───────────────────────────────────────────────────────

test('(c) resolveLivenessPolicy auto-selects phase_timeouts when phases exist; explicit wins', () => {
  assert.deepEqual(
    resolveLivenessPolicy(null, null, PHASES),
    { type: 'phase_timeouts' },
    'phases present + no explicit policy → phase_timeouts',
  );
  assert.deepEqual(
    resolveLivenessPolicy(null, null, null),
    { type: 'zero_progress' },
    'no phases, no policy → default zero_progress',
  );
  // An explicit policy still wins over the phase model.
  const explicit = JSON.stringify({ type: 'heartbeat_deadline', deadline_sec: 60 });
  assert.deepEqual(
    resolveLivenessPolicy(explicit, null, PHASES),
    { type: 'heartbeat_deadline', deadline_sec: 60 },
    'explicit scenario policy wins over phases',
  );
});

// ── (d)+(f) reaper: active-phase timeout ─────────────────────────────────────

test('(d) active phase past its timeout is reaped, reason names the phase', async () => {
  const scenarios = [{ id: 'sc-ph', board_id: null, liveness_policy: null, qa_phases: serializeQaPhases(PHASES) }];
  const run = makeRun('build-hung', {
    current_phase: 'build',
    current_phase_at: new Date(NOW.getTime() - 2000 * SEC), // 2000s > 1800s build timeout
  });
  const repo = makeRunRepo([run]);
  const svc = new QaRunReaperService(repo, listRepo(scenarios), listRepo([]), noopLog, noopQaRunService);

  const { reaped } = await svc.runOnce(NOW);
  assert.deepEqual(reaped, ['build-hung'], 'build phase past timeout reaped');
  assert.equal(run.status, 'error');
  assert.match(run.summary, /auto-reaped by QaRunReaperService/);
  assert.match(run.summary, /phase 'Build'/, 'reason names the overdue phase by label');
  assert.match(run.summary, /NOT a tested failure/);
});

test('(f) active phase still WITHIN its timeout is spared even when the run is hours old', async () => {
  // The run started 2h ago, which would die under the 6h... but more importantly
  // the long 'run' phase (3600s) entered 30min ago is fine — per-phase, not per-run.
  const scenarios = [{ id: 'sc-ph', board_id: null, liveness_policy: null, qa_phases: serializeQaPhases(PHASES) }];
  const run = makeRun('run-progressing', {
    current_phase: 'run',
    current_phase_at: new Date(NOW.getTime() - 30 * 60_000), // 30min < 3600s run timeout
    started_at: new Date(NOW.getTime() - 5 * HOUR),
  });
  const repo = makeRunRepo([run]);
  const svc = new QaRunReaperService(repo, listRepo(scenarios), listRepo([]), noopLog, noopQaRunService);

  const { reaped } = await svc.runOnce(NOW);
  assert.deepEqual(reaped, [], 'an in-budget phase is spared regardless of overall run age');
  assert.equal(run.status, 'running');
});

// ── (e) reaper: fallback for unset/unmatched phase ───────────────────────────

test('(e) unset current_phase falls back to the first phase timeout from run start', async () => {
  const scenarios = [{ id: 'sc-ph', board_id: null, liveness_policy: null, qa_phases: serializeQaPhases(PHASES) }];
  // No current_phase → fallback = first phase (import, 600s) measured from start.
  const stale = makeRun('no-phase-stale', {
    current_phase: null,
    current_phase_at: null,
    started_at: new Date(NOW.getTime() - 700 * SEC), // 700s > 600s import fallback → reap
  });
  const fresh = makeRun('no-phase-fresh', {
    current_phase: null,
    current_phase_at: null,
    started_at: new Date(NOW.getTime() - 120 * SEC), // 120s < 600s → spare
  });
  const repo = makeRunRepo([stale, fresh]);
  const svc = new QaRunReaperService(repo, listRepo(scenarios), listRepo([]), noopLog, noopQaRunService);

  const { reaped } = await svc.runOnce(NOW);
  assert.deepEqual(reaped, ['no-phase-stale'], 'fallback uses the first phase timeout from start');
  assert.match(stale.summary, /no phase set/);
  assert.equal(fresh.status, 'running');
});

test('(e2) an unmatched current_phase also falls back (stale/renamed phase id)', async () => {
  const scenarios = [{ id: 'sc-ph', board_id: null, liveness_policy: null, qa_phases: serializeQaPhases(PHASES) }];
  const run = makeRun('ghost-phase', {
    current_phase: 'deploy', // not in the model
    current_phase_at: new Date(NOW.getTime() - 700 * SEC),
    started_at: new Date(NOW.getTime() - 700 * SEC),
  });
  const repo = makeRunRepo([run]);
  const svc = new QaRunReaperService(repo, listRepo(scenarios), listRepo([]), noopLog, noopQaRunService);

  const { reaped } = await svc.runOnce(NOW);
  assert.deepEqual(reaped, ['ghost-phase'], 'unmatched phase falls back to the first phase timeout');
  assert.match(run.summary, /unmatched phase 'deploy'/);
});

// ── (g) setPhase bookkeeping ─────────────────────────────────────────────────

function makeSetPhaseService(run) {
  const runRepo = {
    async findOne() { return run; },
    async save(r) { return r; },
  };
  return new QaRunService(null, runRepo, null, null, null, null, null, null, null);
}

test('(g) setPhase stamps current phase, appends history, closes the prior left_at', async () => {
  const run = {
    id: 'r1', workspace_id: 'w1', status: 'running',
    current_phase: null, current_phase_at: null, phase_history: null,
  };
  const svc = makeSetPhaseService(run);

  await svc.setPhase('r1', 'w1', 'import');
  assert.equal(run.current_phase, 'import');
  assert.ok(run.current_phase_at instanceof Date, 'current_phase_at stamped');
  assert.equal(run.phase_history.length, 1);
  assert.equal(run.phase_history[0].phase, 'import');
  assert.equal(run.phase_history[0].left_at, null, 'active phase has open left_at');

  await svc.setPhase('r1', 'w1', 'build');
  assert.equal(run.current_phase, 'build');
  assert.equal(run.phase_history.length, 2);
  assert.ok(run.phase_history[0].left_at, 'prior phase left_at closed on transition');
  assert.equal(run.phase_history[1].phase, 'build');
  assert.equal(run.phase_history[1].left_at, null);
});

test('(g2) setPhase rejects a terminal run and an empty phase', async () => {
  const terminal = { id: 'r2', workspace_id: 'w1', status: 'passed', phase_history: null };
  await assert.rejects(
    () => makeSetPhaseService(terminal).setPhase('r2', 'w1', 'build'),
    /already 'passed'/,
  );
  const live = { id: 'r3', workspace_id: 'w1', status: 'running', phase_history: null };
  await assert.rejects(
    () => makeSetPhaseService(live).setPhase('r3', 'w1', '  '),
    /phase is required/,
  );
});
