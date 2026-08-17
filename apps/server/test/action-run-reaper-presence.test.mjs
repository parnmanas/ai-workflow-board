// Regression-grep — ActionRun stale-running reaper (ticket b9c0155c).
//
// An ActionRun stuck `running` forever (target agent died before calling
// complete_action_run) was the reported symptom — action-scheduler.service.ts's
// `_tick()` is cron-dispatch-only and never swept already-dispatched runs.
// ActionRunReaperService closes such runs. This is a cheap static guard that
// the reaper exists, implements the sweep lifecycle, reads its env knobs, only
// touches the 'running' status, reuses ActionsService.completeRun() (not a
// direct status mutation) so the idempotent transition + bounded retry +
// audit-comment machinery are never duplicated, resumes the source ticket via
// TriggerLoopService when completeRun says to, and is wired into the actions
// module's providers + imports (AgentsModule, for TriggerLoopService) — so a
// refactor can't silently delete the wiring and let runs rot `running` again.
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
const REAPER = path.join(SRC_DIR, 'modules', 'actions', 'action-run-reaper.service.ts');
const ACTIONS_MODULE = path.join(SRC_DIR, 'modules', 'actions', 'actions.module.ts');
const ACTIONS_CONTROLLER = path.join(SRC_DIR, 'modules', 'actions', 'actions.controller.ts');

function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

test('ActionRunReaperService source defines the sweep loop, TTL gate, and env config', () => {
  assert.ok(fs.existsSync(REAPER), `expected ${REAPER} to exist`);
  const code = stripComments(fs.readFileSync(REAPER, 'utf8'));
  assert.match(code, /class\s+ActionRunReaperService/, 'must export ActionRunReaperService class');
  assert.match(code, /OnModuleInit/, 'must implement OnModuleInit so the sweep loop boots');
  assert.match(code, /OnModuleDestroy/, 'must implement OnModuleDestroy so the timer is torn down');
  assert.match(code, /setInterval\(/, 'sweep loop must use setInterval');
  assert.match(code, /ACTION_RUN_REAPER_ENABLED/, 'must read ACTION_RUN_REAPER_ENABLED env var');
  assert.match(code, /ACTION_RUN_REAPER_SWEEP_MS/, 'must read ACTION_RUN_REAPER_SWEEP_MS env var');
  assert.match(code, /ACTION_RUN_TTL_MS/, 'must read ACTION_RUN_TTL_MS env var');
  // Only the non-terminal 'running' status may be reaped (ActionRun has no
  // 'pending' stage, unlike QaRun).
  assert.match(code, /status\s*:\s*['"]running['"]/, 'must scope the sweep to running runs');
  // Runs without a source_ticket_id never received the complete_action_run
  // completion contract (actions.service.ts only renders it when a source
  // ticket is present), so their target agent never learned the run_id and
  // 'running' is a permanent, correct state for them — not a zombie. A
  // refactor that drops this gate would mass-mislabel cron/manual/
  // on-ticket-done history as failed.
  assert.match(
    code,
    /if\s*\(\s*!\s*\(\s*run\.source_ticket_id\s*\|\|\s*['"]['"]\s*\)\.trim\(\)\s*\)\s*continue/,
    'runOnce must skip candidates with no source_ticket_id before applying the TTL gate',
  );
  // Age gate: ActionRun has no started_at column, so age is measured from
  // created_at only (not a started_at ?? created_at fallback like QaRun/
  // OrchestrationMission).
  assert.match(code, /now\.getTime\(\)\s*-\s*new Date\(run\.created_at\)\.getTime\(\)/, 'age must be measured from created_at');
  // Reap MUST go through completeRun (idempotent guarded transition + bounded
  // retry + audit comment) rather than a direct status mutation on the row.
  assert.match(code, /actionsService\.completeRun\(/, 'reap must delegate to ActionsService.completeRun (not a direct status mutation)');
  assert.match(code, /status\s*:\s*['"]failed['"]/, "completeRun must be called with status: 'failed'");
  // A concurrent real complete_action_run must not be double-counted as reaped.
  assert.match(code, /previouslyCompleted/, 'must skip runs completeRun reports as previouslyCompleted (raced by a real completion)');
  // ActionRun uniquely carries a "resume the source ticket" contract — the
  // reaper must drive it via TriggerLoopService, gated on shouldResume.
  assert.match(code, /triggerLoopService/, 'must inject TriggerLoopService to resume the source ticket');
  assert.match(code, /shouldResume/, 'must gate the resume dispatch on completeRun\'s shouldResume flag');
  assert.match(code, /dispatchCurrentColumn\(/, 'must call dispatchCurrentColumn to resume the source ticket');
  // No-restart activation: an immediate boot sweep runs runOnce() from onModuleInit
  // so a deploy clears standing phantoms without waiting a full sweep interval.
  const init = code.slice(code.indexOf('onModuleInit'));
  assert.match(init, /runOnce\(/, 'onModuleInit must fire an immediate boot sweep (runOnce) so a deploy activates the reaper without idling a full interval');
});

test('actions.module wires ActionRunReaperService into providers and imports AgentsModule', () => {
  const code = stripComments(fs.readFileSync(ACTIONS_MODULE, 'utf8'));
  assert.match(
    code,
    /import\s+\{\s*ActionRunReaperService\s*\}\s+from\s+['"]\.\/action-run-reaper\.service['"]/,
    'ActionsModule must import ActionRunReaperService from sibling file',
  );
  assert.match(code, /providers\s*:\s*\[[\s\S]*ActionRunReaperService/, 'must register ActionRunReaperService in providers (else the setInterval never boots)');
  assert.match(
    code,
    /import\s+\{\s*AgentsModule\s*\}\s+from\s+['"]\.\.\/agents\/agents\.module['"]/,
    'ActionsModule must import AgentsModule (source of TriggerLoopService)',
  );
  assert.match(code, /imports\s*:\s*\[[\s\S]*AgentsModule/, 'must list AgentsModule in imports so TriggerLoopService resolves via DI');
});

test('actions.controller exposes the operator reaper sweep endpoint', () => {
  const code = stripComments(fs.readFileSync(ACTIONS_CONTROLLER, 'utf8'));
  assert.match(code, /ActionRunReaperService/, 'controller must inject ActionRunReaperService for the manual sweep');
  assert.match(code, /@Post\(\s*['"]runs\/reap['"]\s*\)/, 'must expose POST runs/reap as the operator lever (no-restart on-demand sweep)');
  assert.match(code, /runOnce\(/, 'reap endpoint must drive the reaper via runOnce()');
});
