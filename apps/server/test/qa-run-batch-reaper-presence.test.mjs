// Regression-grep — QaRunBatch schedule-agnostic wedge reaper (ticket 5a0593ae).
//
// QaRunService.resumeWedgedBatch (a51ec6d9 round 2) only ever fires from a
// QaSchedule's due tick via last_batch_id, so an ad-hoc batch (no schedule),
// an orphaned last_batch_id, or a batch owned by a disabled schedule stays
// `running` forever with no recovery path. QaRunBatchReaperService closes
// that gap. This is a cheap static guard that the reaper exists, implements
// the sweep lifecycle, reads its env knobs, only touches `running` batches,
// drives the shared resumeWedgedBatch entry point (rather than reimplementing
// the wedge/dispatch logic), and is wired into the QA module's providers AND
// exports AND the operator REST endpoint — so a refactor can't silently
// delete the wiring and let ad-hoc batches rot `running` again.
//
// Also pins the in-flight dispatch guard in qa-run.service.ts (the race a
// reviewer flagged once a schedule-agnostic reaper adds a THIRD entry point
// into _dispatchBatchIndex, alongside onRunFinalized and the schedule-tick
// resume) — a plain regression grep is cheap insurance that a future edit
// can't silently drop the guard.
//
// Comments are stripped before grepping so prose in the module/header that
// legitimately names tokens doesn't false-positive the call-site grep.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC_DIR = path.resolve(__dirname, '..', 'src');
const BATCH_REAPER = path.join(SRC_DIR, 'modules', 'qa', 'qa-run-batch-reaper.service.ts');
const QA_RUN_SERVICE = path.join(SRC_DIR, 'modules', 'qa', 'qa-run.service.ts');
const QA_MODULE = path.join(SRC_DIR, 'modules', 'qa', 'qa-scenario.module.ts');
const QA_CONTROLLER = path.join(SRC_DIR, 'modules', 'qa', 'qa-scenario.controller.ts');

function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

test('QaRunBatchReaperService source defines the sweep loop, env config, and the running-only scope', () => {
  assert.ok(fs.existsSync(BATCH_REAPER), `expected ${BATCH_REAPER} to exist`);
  const code = stripComments(fs.readFileSync(BATCH_REAPER, 'utf8'));
  assert.match(code, /class\s+QaRunBatchReaperService/, 'must export QaRunBatchReaperService class');
  assert.match(code, /OnModuleInit/, 'must implement OnModuleInit so the sweep loop boots');
  assert.match(code, /OnModuleDestroy/, 'must implement OnModuleDestroy so the timer is torn down');
  assert.match(code, /setInterval\(/, 'sweep loop must use setInterval');
  assert.match(code, /QA_BATCH_REAPER_ENABLED/, 'must read QA_BATCH_REAPER_ENABLED env var');
  assert.match(code, /QA_BATCH_REAPER_SWEEP_MS/, 'must read QA_BATCH_REAPER_SWEEP_MS env var');
  // Schedule-agnostic: scope is purely status='running', no join/filter on any
  // QaSchedule table — that is exactly what makes this reaper catch ad-hoc /
  // orphaned / disabled-schedule batches the schedule tick cannot reach.
  assert.match(code, /status\s*:\s*['"]running['"]/, "sweep must query QaRunBatch rows with status:'running'");
  assert.doesNotMatch(code, /QaSchedule/, 'must stay schedule-agnostic — no QaSchedule reference');
  // Must funnel through the SAME resume entry point resumeWedgedBatch owns,
  // not reimplement the wedge/dispatch decision here.
  assert.match(code, /resumeWedgedBatch\(/, 'must resume a wedged batch via QaRunService.resumeWedgedBatch');
  assert.doesNotMatch(code, /_dispatchBatchIndex/, 'must not reach into the private dispatch method directly');
  // Overlap guard: an overlapping tick must not double-sweep.
  assert.match(code, /sweeping/, 'must guard against an overlapping sweep (mirrors Action/Orchestration reapers)');
  // No-restart activation: an immediate boot sweep runs runOnce() from onModuleInit.
  const init = code.slice(code.indexOf('onModuleInit'));
  assert.match(init, /runOnce\(/, 'onModuleInit must fire an immediate boot sweep (runOnce)');
});

test('qa-scenario.controller exposes the operator batch-reaper sweep endpoint', () => {
  const code = stripComments(fs.readFileSync(QA_CONTROLLER, 'utf8'));
  assert.match(code, /QaRunBatchReaperService/, 'controller must inject QaRunBatchReaperService for the manual sweep');
  assert.match(code, /@Post\(\s*['"]batches\/reap['"]\s*\)/, 'must expose POST batches/reap as the operator lever');
  assert.match(code, /qaRunBatchReaperService\.runOnce\(/, 'reap endpoint must drive the batch reaper via runOnce()');
});

test('qa-scenario.module wires QaRunBatchReaperService into providers AND exports', () => {
  const code = stripComments(fs.readFileSync(QA_MODULE, 'utf8'));
  assert.match(
    code,
    /import\s+\{\s*QaRunBatchReaperService\s*\}\s+from\s+['"]\.\/qa-run-batch-reaper\.service['"]/,
    'QaScenarioModule must import QaRunBatchReaperService from sibling file',
  );
  assert.match(code, /providers\s*:\s*\[[\s\S]*QaRunBatchReaperService/, 'must register QaRunBatchReaperService in providers (else the setInterval never boots)');
  assert.match(code, /exports\s*:\s*\[[\s\S]*QaRunBatchReaperService/, 'must export QaRunBatchReaperService (controller DI resolves through the module boundary)');
});

test('qa-run.service guards batch dispatch with a shared in-flight Set across all resume entry points', () => {
  const code = stripComments(fs.readFileSync(QA_RUN_SERVICE, 'utf8'));
  assert.match(code, /_inFlightBatchIds/, 'must declare the in-flight batch id guard');
  assert.match(code, /_inFlightBatchIds\s*=\s*new Set/, 'guard must be a Set keyed by batch id');

  // resumeWedgedBatch must check the guard BEFORE doing any DB read (fast-path
  // early return), so a concurrent schedule-tick/reaper resume never races
  // onRunFinalized's dispatch-in-progress window.
  const resumeStart = code.indexOf('async resumeWedgedBatch');
  assert.ok(resumeStart >= 0, 'resumeWedgedBatch must exist');
  const resumeBody = code.slice(resumeStart, code.indexOf('\n  }', resumeStart));
  assert.match(resumeBody, /_inFlightBatchIds\.has\(/, 'resumeWedgedBatch must check the in-flight guard');
  assert.match(resumeBody, /_dispatchBatchIndex/, 'resumeWedgedBatch must still funnel into _dispatchBatchIndex when not wedged/in-flight');

  // _dispatchBatchIndex must add-on-entry / delete-on-exit (finally), so the
  // guard clears even when a dispatch throws. Anchor on the method
  // DEFINITION (not the earlier startBatch call site that also contains the
  // substring "_dispatchBatchIndex(batch").
  const dispatchStart = code.indexOf('private async _dispatchBatchIndex(batch');
  assert.ok(dispatchStart >= 0, '_dispatchBatchIndex must exist');
  const dispatchBody = code.slice(dispatchStart, code.indexOf('\n  }', dispatchStart));
  assert.match(dispatchBody, /_inFlightBatchIds\.has\(batch\.id\)/, '_dispatchBatchIndex must check the guard on entry');
  assert.match(dispatchBody, /_inFlightBatchIds\.add\(batch\.id\)/, '_dispatchBatchIndex must add itself to the guard on entry');
  assert.match(dispatchBody, /finally\s*\{[\s\S]*_inFlightBatchIds\.delete\(batch\.id\)/, '_dispatchBatchIndex must remove itself from the guard in a finally block (cleared even on throw)');
});
