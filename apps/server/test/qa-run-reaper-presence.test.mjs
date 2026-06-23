// Regression-grep — QaRun stale-running reaper.
//
// A QaRun stuck `running` for two days (driver died before complete_qa_run)
// was the user-visible symptom. QaRunReaperService closes such runs. This is a
// cheap static guard that the reaper exists, implements the sweep lifecycle,
// reads its env knobs, only touches non-terminal runs, and is wired into the
// QA module's providers AND exports — so a refactor can't silently delete the
// wiring and let runs rot `running` again.
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
const REAPER = path.join(SRC_DIR, 'modules', 'qa', 'qa-run-reaper.service.ts');
const QA_MODULE = path.join(SRC_DIR, 'modules', 'qa', 'qa-scenario.module.ts');
const QA_CONTROLLER = path.join(SRC_DIR, 'modules', 'qa', 'qa-scenario.controller.ts');

function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

test('QaRunReaperService source defines the sweep loop, TTL gate, and env config', () => {
  assert.ok(fs.existsSync(REAPER), `expected ${REAPER} to exist`);
  const code = stripComments(fs.readFileSync(REAPER, 'utf8'));
  assert.match(code, /class\s+QaRunReaperService/, 'must export QaRunReaperService class');
  assert.match(code, /OnModuleInit/, 'must implement OnModuleInit so the sweep loop boots');
  assert.match(code, /OnModuleDestroy/, 'must implement OnModuleDestroy so the timer is torn down');
  assert.match(code, /setInterval\(/, 'sweep loop must use setInterval');
  assert.match(code, /QA_RUN_REAPER_ENABLED/, 'must read QA_RUN_REAPER_ENABLED env var');
  assert.match(code, /QA_RUN_REAPER_SWEEP_MS/, 'must read QA_RUN_REAPER_SWEEP_MS env var');
  assert.match(code, /QA_RUN_TTL_MS/, 'must read QA_RUN_TTL_MS env var (6h absolute backstop)');
  assert.match(code, /QA_RUN_ZERO_PROGRESS_MS/, 'must read QA_RUN_ZERO_PROGRESS_MS env var (fast zero-progress fuse)');
  // The zero-progress fuse must key off the recorded step count — a run with no
  // steps past the window is reaped; a run with ≥1 step waits for the absolute TTL.
  assert.match(code, /step_results/, 'zero-progress fuse must inspect step_results to detect 0-step runs');
  // Only non-terminal runs may be reaped, and they must be closed to a terminal
  // status with finished_at stamped — never reopen or touch a passed/failed run.
  assert.match(code, /['"]running['"]/, 'must scope the sweep to running runs');
  assert.match(code, /['"]pending['"]/, 'must scope the sweep to pending runs');
  assert.match(code, /status\s*=\s*['"]error['"]/, "reaped runs must be closed with status='error'");
  assert.match(code, /finished_at\s*=/, 'reaped runs must stamp finished_at');
  // started_at ?? created_at age gate (the freshness check, shared by both fuses).
  assert.match(code, /started_at\s*\?\?\s*[\w.]*created_at/, 'age must be measured from started_at falling back to created_at');
  // No-restart activation: an immediate boot sweep runs runOnce() from onModuleInit
  // so a deploy clears standing phantoms without waiting a full sweep interval.
  const init = code.slice(code.indexOf('onModuleInit'));
  assert.match(init, /runOnce\(/, 'onModuleInit must fire an immediate boot sweep (runOnce) so a deploy activates the reaper without idling a full interval');
});

test('qa-scenario.controller exposes the operator reaper sweep endpoint', () => {
  const code = stripComments(fs.readFileSync(QA_CONTROLLER, 'utf8'));
  assert.match(code, /QaRunReaperService/, 'controller must inject QaRunReaperService for the manual sweep');
  assert.match(code, /@Post\(\s*['"]runs\/reap['"]\s*\)/, 'must expose POST runs/reap as the operator lever (no-restart on-demand sweep)');
  assert.match(code, /runOnce\(/, 'reap endpoint must drive the reaper via runOnce()');
});

test('qa-scenario.module wires QaRunReaperService into providers AND exports', () => {
  const code = stripComments(fs.readFileSync(QA_MODULE, 'utf8'));
  assert.match(
    code,
    /import\s+\{\s*QaRunReaperService\s*\}\s+from\s+['"]\.\/qa-run-reaper\.service['"]/,
    'QaScenarioModule must import QaRunReaperService from sibling file',
  );
  assert.match(code, /providers\s*:\s*\[[\s\S]*QaRunReaperService/, 'must register QaRunReaperService in providers (else the setInterval never boots)');
  assert.match(code, /QaRun\b/, 'forFeature must include QaRun so the reaper repo injection resolves');
});
