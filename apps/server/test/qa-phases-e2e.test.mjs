// Multi-phase QA model — END-TO-END verification (ticket 454e6bd0).
//
// qa-phases.test.mjs (ticket 90cc22f7 foundation) covers each piece in isolation:
// it pre-sets `current_phase_at` BY HAND and asserts the reaper decision, and
// separately asserts setPhase's bookkeeping. What it does NOT do — and what the
// E2E ticket explicitly calls out as a verification point — is connect the two:
//
//   "phase 전이 시 deadline baseline reset 확인 (이전 phase 경과가 다음 phase 를 죽이지 않음)"
//
// i.e. drive the REAL QaRunService.setPhase transition and THEN the REAL
// QaRunReaperService over a shared run, with a controlled clock, to prove that
// the time already spent in the previous phase does not count against the next
// phase's timeout. This file is that end-to-end stitch — the same code paths the
// MCP tools (start_qa_run initial_phase / set_qa_phase) drive on the live server,
// exercised here deterministically because the feature is on origin/main but not
// yet deployed to production.private (live-MCP E2E is the post-deploy playbook in
// docs/qa-phases.md).
//
// Verification points (mirrors the ticket):
//   (1) Each phase's timeout is applied INDEPENDENTLY — import (short) reaps on
//       its own budget; the long run phase is spared though the run is hours old.
//   (2) A real import→build transition RESETS the deadline baseline — a run that
//       sat 1h in import (long past import's 600s) is spared in build for ~1700s
//       and only reaped past build's OWN 1800s, naming 'Build'.
//   (3) A phase-timeout reap records WHICH phase overran, in the run summary.
//   (4) No regression for a phases-undefined board — it still resolves to
//       zero_progress and reaps on the legacy fuses, untouched by phase logic.
//
// Imports the compiled modules from dist/ (built by `npm run build`).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QaRunReaperService } from '../dist/modules/qa/qa-run-reaper.service.js';
import { QaRunService } from '../dist/modules/qa/qa-run.service.js';
import { serializeQaPhases } from '../dist/modules/qa/qa-phases.js';
import { resolveLivenessPolicy } from '../dist/modules/qa/qa-liveness-policy.js';

const SEC = 1000;
const HOUR = 60 * 60_000;

const PHASES = {
  phases: [
    { id: 'import', label: 'Import', timeout_sec: 600 },  // 10 min
    { id: 'build', label: 'Build', timeout_sec: 1800 },   // 30 min
    { id: 'run', label: 'Run', timeout_sec: 3600 },       // 60 min
  ],
};
const PHASES_JSON = serializeQaPhases(PHASES);

const noopLog = { info() {}, warn() {}, error() {} };
const noopQaRunService = { onRunFinalized: async () => {} };
const listRepo = (rows) => ({ async find() { return rows; } });

// A run repo shared between QaRunService.setPhase (findOne/save) and
// QaRunReaperService.runOnce (find/save) so a transition the service makes is
// visible to the reaper — the whole point of an E2E stitch.
function makeSharedRunRepo(rows) {
  return {
    rows,
    saved: [],
    async find({ where, take }) {
      const statuses = where.status?._value || where.status?._object || ['running', 'pending'];
      return rows.filter((r) => statuses.includes(r.status)).slice(0, take ?? rows.length);
    },
    async findOne({ where }) {
      return rows.find((r) => r.id === where.id && r.workspace_id === where.workspace_id) ?? null;
    },
    async save(row) {
      this.saved.push(row.id);
      return row;
    },
  };
}

function makeRun(id, overrides = {}) {
  const base = new Date('2026-06-28T12:00:00Z');
  return {
    id,
    workspace_id: 'w1',
    scenario_id: 'sc-ph',
    board_id: null,
    status: 'running',
    started_at: base,
    created_at: base,
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

// QaRunService with ONLY the runRepo wired (positional arg #2, matching the
// foundation test's makeSetPhaseService) — setPhase touches nothing else.
const makeRunSvc = (runRepo) => new QaRunService(null, runRepo, null, null, null, null, null, null, null);

const reaper = (runRepo, scenarios) =>
  new QaRunReaperService(runRepo, listRepo(scenarios), listRepo([]), noopLog, noopQaRunService);

const PHASE_SCENARIO = [{ id: 'sc-ph', board_id: null, liveness_policy: null, qa_phases: PHASES_JSON }];

// ── (1) independent per-phase timeouts ───────────────────────────────────────

test('(1) import and run phases are judged on their OWN budgets, not the run age', async () => {
  // A run sitting in the short import phase for 700s (> 600s) is reaped...
  const importHung = makeRun('import-hung', {
    current_phase: 'import',
    current_phase_at: new Date(Date.now() - 700 * SEC),
    started_at: new Date(Date.now() - 700 * SEC),
  });
  // ...while a run 5h old but only 30min into the long run phase (3600s) is spared.
  const runProgressing = makeRun('run-progressing', {
    current_phase: 'run',
    current_phase_at: new Date(Date.now() - 30 * 60_000),
    started_at: new Date(Date.now() - 5 * HOUR),
  });
  const repo = makeSharedRunRepo([importHung, runProgressing]);
  const { reaped } = await reaper(repo, PHASE_SCENARIO).runOnce(new Date());

  assert.deepEqual(reaped, ['import-hung'], 'only the over-budget import phase reaps');
  assert.equal(importHung.status, 'error');
  assert.match(importHung.summary, /phase 'Import'/, 'reap names the import phase');
  assert.equal(runProgressing.status, 'running', 'the hours-old run is spared on its in-budget phase');
});

// ── (2) THE key E2E: real transition resets the deadline baseline ─────────────

test('(2) a real import→build transition resets the deadline — prior phase time does NOT kill the next', async () => {
  // The run has been stuck in import for a full hour — WAY past import's 600s
  // budget. If the prior-phase elapsed leaked into the next phase, build would
  // die immediately. We transition through the REAL service, then reap.
  const run = makeRun('drive-1', {
    current_phase: 'import',
    current_phase_at: new Date(Date.now() - 1 * HOUR),
    started_at: new Date(Date.now() - 1 * HOUR),
    phase_history: [{ phase: 'import', entered_at: new Date(Date.now() - HOUR).toISOString(), left_at: null }],
  });
  const repo = makeSharedRunRepo([run]);
  const runSvc = makeRunSvc(repo);
  const reap = reaper(repo, PHASE_SCENARIO);

  // Sanity: BEFORE the transition, the reaper would reap it (import 1h ≫ 600s).
  const preview = makeRun('drive-preview', { ...run, id: 'drive-preview' });
  const previewRepo = makeSharedRunRepo([preview]);
  const { reaped: pre } = await reaper(previewRepo, PHASE_SCENARIO).runOnce(new Date());
  assert.deepEqual(pre, ['drive-preview'], 'stuck import would have been reaped pre-transition');

  // Real transition import → build.
  await runSvc.setPhase('drive-1', 'w1', 'build');
  const tBuild = run.current_phase_at; // the new deadline baseline (≈ now)
  assert.equal(run.current_phase, 'build');
  assert.ok(tBuild instanceof Date, 'transition stamped a fresh current_phase_at');
  assert.equal(run.phase_history.length, 2);
  assert.ok(run.phase_history[0].left_at, 'import history entry was closed on transition');
  assert.equal(run.phase_history[1].phase, 'build');

  // 1700s into build (< 1800s budget) — SPARED. This is the reset: the hour in
  // import is gone; build is judged from tBuild, not from run start.
  const { reaped: mid } = await reap.runOnce(new Date(tBuild.getTime() + 1700 * SEC));
  assert.deepEqual(mid, [], 'build within its own budget is spared though the run is >1h old');
  assert.equal(run.status, 'running');

  // 1900s into build (> 1800s) — NOW reaped, naming build.
  const { reaped: late } = await reap.runOnce(new Date(tBuild.getTime() + 1900 * SEC));
  assert.deepEqual(late, ['drive-1'], 'build past its OWN timeout reaps');
  assert.equal(run.status, 'error');
  assert.match(run.summary, /phase 'Build'/, '(3) summary records which phase overran');
  assert.match(run.summary, /NOT a tested failure/, 'reaped reason reads as infra death, not a test fail');
});

// ── (4) regression: a phases-undefined board is untouched by phase logic ──────

test('(4) regression — a run with no phases resolves to zero_progress and reaps on the legacy fuse', async () => {
  // Belt-and-suspenders at the resolver: no phases anywhere → zero_progress.
  assert.deepEqual(resolveLivenessPolicy(null, null, null), { type: 'zero_progress' });

  const legacyScenario = [{ id: 'sc-legacy', board_id: null, liveness_policy: null, qa_phases: null }];
  // 0 steps, 50min old (> 40min zero-progress fuse) → reaped, but NOT via phase wording.
  const stale = makeRun('legacy-stale', {
    scenario_id: 'sc-legacy',
    current_phase: null,
    current_phase_at: null,
    started_at: new Date(Date.now() - 50 * 60_000),
  });
  const fresh = makeRun('legacy-fresh', {
    scenario_id: 'sc-legacy',
    current_phase: null,
    current_phase_at: null,
    started_at: new Date(Date.now() - 5 * 60_000),
  });
  const repo = makeSharedRunRepo([stale, fresh]);
  const { reaped } = await reaper(repo, legacyScenario).runOnce(new Date());

  assert.deepEqual(reaped, ['legacy-stale'], 'legacy zero-progress fuse still fires');
  assert.match(stale.summary, /zero-progress/, 'legacy reap reason — not phase wording');
  assert.doesNotMatch(stale.summary, /phase '/, 'phase logic does not touch a phases-undefined run');
  assert.equal(fresh.status, 'running', 'a fresh legacy run is spared');
});
