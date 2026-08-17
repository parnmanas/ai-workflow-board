// Run-creation-rate guard — call-site/ordering guard (ticket a51ec6d9).
//
// Mirrors hard-budget-dispatch-gate.test.mjs's structural/static-guard
// technique over the compiled TypeScript source (same "not cheaply
// unit-testable in isolation — too many injected NestJS dependencies"
// tradeoff): asserts `enforceRunBudget` is called EXACTLY ONCE inside each
// run-dispatch chokepoint we've wired so far (QA's startQaRun, Action's
// dispatch), and that the call sits BEFORE that chokepoint's ChatRoom
// creation and run-row save — the "before any side effect" requirement the
// ticket a51ec6d9 plan's work-breakdown item 5 spells out. A refactor that
// drops the guard, duplicates it, or reorders it past either side effect
// fails this test immediately.
//
// The THIRD chokepoint (orchestration-mission.service.ts's createMission) is
// deliberately NOT covered here yet — the plan sequences that wiring after
// ticket b7127aae lands on main (file-conflict avoidance + its temporary
// per-team-mission guard needs to be re-evaluated against the landed code).
// See the ticket a51ec6d9 plan comment's "시퀀싱" section and the follow-up
// ticket it is prerequisite'd on.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}
function code(relPath) {
  return stripComments(fs.readFileSync(path.join(ROOT, 'src', relPath), 'utf8'));
}

const ENFORCE_CALL_RE = /await enforceRunBudget\(/g;

function assertGuardedChokepoint(t, { file, methodOpenRe, roomSaveMarker, runSaveMarker, methodLabel }) {
  const src = code(file);
  const match = src.match(methodOpenRe);
  assert.ok(match, `could not isolate the ${methodLabel} method body`);
  const body = match[0];

  const calls = [...body.matchAll(ENFORCE_CALL_RE)];
  assert.equal(calls.length, 1, `expected exactly 1 enforceRunBudget call site in ${methodLabel}, found ${calls.length}`);

  const roomSaveIdx = body.indexOf(roomSaveMarker);
  const runSaveIdx = body.indexOf(runSaveMarker);
  assert.ok(roomSaveIdx > -1, `${methodLabel} must still create the ChatRoom`);
  assert.ok(runSaveIdx > -1, `${methodLabel} must still save the run row`);

  const callIdx = calls[0].index;
  assert.ok(callIdx < roomSaveIdx, `enforceRunBudget must run before ${methodLabel} creates the ChatRoom`);
  assert.ok(callIdx < runSaveIdx, `enforceRunBudget must run before ${methodLabel} saves the run row`);
}

test('qa-run.service.ts startQaRun calls enforceRunBudget exactly once, before the ChatRoom and QaRun row saves', () => {
  assertGuardedChokepoint(null, {
    file: 'modules/qa/qa-run.service.ts',
    methodOpenRe: /async startQaRun\(args: StartQaRunArgs\): Promise<StartQaRunResult> \{[\s\S]*?\r?\n  \}\r?\n/,
    roomSaveMarker: 'this.roomRepo.save(',
    runSaveMarker: 'this.runRepo.save(',
    methodLabel: 'startQaRun',
  });
});

test('actions.service.ts dispatch calls enforceRunBudget exactly once, before the ChatRoom and ActionRun row saves', () => {
  assertGuardedChokepoint(null, {
    file: 'modules/actions/actions.service.ts',
    methodOpenRe: /async dispatch\(args: DispatchActionArgs\): Promise<DispatchActionResult> \{[\s\S]*?\r?\n  \}\r?\n/,
    roomSaveMarker: 'this.roomRepo.save(',
    runSaveMarker: 'this.runRepo.save(',
    methodLabel: 'dispatch',
  });
});

test('the QA chokepoint passes kind "qa" and the Action chokepoint passes kind "action"', () => {
  const qaSrc = code('modules/qa/qa-run.service.ts');
  assert.match(
    qaSrc, /enforceRunBudget\(\s*\{[\s\S]*?\},\s*'qa',/,
    'qa-run.service.ts must call enforceRunBudget with kind "qa"',
  );

  const actionsSrc = code('modules/actions/actions.service.ts');
  assert.match(
    actionsSrc, /enforceRunBudget\(\s*\{[\s\S]*?\},\s*'action',/,
    'actions.service.ts must call enforceRunBudget with kind "action"',
  );
});

// Regression guard for the ticket a51ec6d9 plan's "정정 2": placing the guard
// INSIDE dispatch() (not around the retry call site in completeRun) means a
// retry that trips the ceiling throws from `this.dispatch(...)`, which
// completeRun already wraps in try/catch and treats as a failed re-dispatch —
// no separate retry-bypass flag needed. This only holds if the retry path
// keeps calling `this.dispatch(` (not some other private helper that skips
// the guard) — pin that call shape.
test('actions.service.ts completeRun\'s bounded retry re-dispatches via this.dispatch(...) — inherits the run-budget guard automatically', () => {
  const src = code('modules/actions/actions.service.ts');
  const match = src.match(/async completeRun\(runId: string, workspaceId: string, args: CompleteRunArgs\): Promise<CompleteRunResult> \{[\s\S]*?\r?\n  \}\r?\n/);
  assert.ok(match, 'could not isolate the completeRun method body');
  assert.match(match[0], /await this\.dispatch\(\{/, 'the bounded retry must call this.dispatch(...) so it inherits the run-budget guard');
});
