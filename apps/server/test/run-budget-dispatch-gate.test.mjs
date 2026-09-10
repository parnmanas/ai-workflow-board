// Run-creation-rate guard — call-site/ordering guard (ticket a51ec6d9).
//
// Mirrors hard-budget-dispatch-gate.test.mjs's structural/static-guard
// technique over the compiled TypeScript source (same "not cheaply
// unit-testable in isolation — too many injected NestJS dependencies"
// tradeoff): asserts `enforceRunBudget` is called EXACTLY ONCE inside each of
// the three run-dispatch chokepoints (QA's startQaRun, Action's dispatch,
// Orchestration's createMission), and that the call sits BEFORE that
// chokepoint's own side effects (ChatRoom creation / run-row / mission-row
// save) — the "before any side effect" requirement the ticket a51ec6d9
// plan's work-breakdown item 5 spells out. A refactor that drops the guard,
// duplicates it, or reorders it past a side effect fails this test
// immediately.

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

function assertGuardedChokepoint({ file, methodOpenRe, sideEffectMarkers, methodLabel }) {
  const src = code(file);
  const match = src.match(methodOpenRe);
  assert.ok(match, `could not isolate the ${methodLabel} method body`);
  const body = match[0];

  const calls = [...body.matchAll(ENFORCE_CALL_RE)];
  assert.equal(calls.length, 1, `expected exactly 1 enforceRunBudget call site in ${methodLabel}, found ${calls.length}`);
  const callIdx = calls[0].index;

  for (const marker of sideEffectMarkers) {
    const idx = body.indexOf(marker);
    assert.ok(idx > -1, `${methodLabel} must still contain the side effect: ${marker}`);
    assert.ok(callIdx < idx, `enforceRunBudget must run before ${methodLabel}'s side effect: ${marker}`);
  }
}

test('qa-run.service.ts startQaRun calls enforceRunBudget exactly once, before the ChatRoom and QaRun row saves', () => {
  assertGuardedChokepoint({
    file: 'modules/qa/qa-run.service.ts',
    methodOpenRe: /async startQaRun\(args: StartQaRunArgs\): Promise<StartQaRunResult> \{[\s\S]*?\r?\n  \}\r?\n/,
    sideEffectMarkers: ['this.roomRepo.save(', 'this.runRepo.save('],
    methodLabel: 'startQaRun',
  });
});

// fan-out (티켓 fc3906c5) 이후 run 생성 초크포인트는 대상 **한 명**을 처리하는
// `_dispatchOne`이다 — 방/run 행 저장이 거기로 내려갔다. run 하나당 예산 한 번을
// 세는 것이 이 가드의 원래 의도(트리거 빈도가 아니라 실제 run 생성량 상한)를
// fan-out에서도 유지하는 유일한 방법이다: 대상 N개는 방 N개 + 에이전트 spawn
// N회라 자원을 실제로 N배 쓴다.
test('actions.service.ts _dispatchOne calls enforceRunBudget exactly once, before the ChatRoom and ActionRun row saves', () => {
  assertGuardedChokepoint({
    file: 'modules/actions/actions.service.ts',
    methodOpenRe: /private async _dispatchOne\(input: \{[\s\S]*?\r?\n  \}\r?\n/,
    sideEffectMarkers: ['this.roomRepo.save(', 'this.runRepo.save('],
    methodLabel: '_dispatchOne',
  });
});

// `dispatch()`는 배치 진입점으로서 별도의 헤드 체크를 하나 더 갖는다. 계수용이
// 아니라 **승인 grant를 소모하기 전 fail-fast** 용이다: 이미 상한을 넘긴 상태로
// 승인 게이트를 통과시키면 일회용 grant만 태우고 run은 한 건도 못 만든 채 끝나,
// 사람이 승인을 다시 발급해야 하는 상태로 빠진다. 그래서 이 호출은 승인 소모
// (`_consumeApproval`)보다 앞에 있어야 한다.
test('actions.service.ts dispatch head-checks the run budget before consuming a high-impact approval grant', () => {
  const src = code('modules/actions/actions.service.ts');
  const match = src.match(/async dispatch\(args: DispatchActionArgs\): Promise<DispatchActionResult> \{[\s\S]*?\r?\n  \}\r?\n/);
  assert.ok(match, 'could not isolate the dispatch method body');
  const body = match[0];

  const calls = [...body.matchAll(ENFORCE_CALL_RE)];
  assert.equal(calls.length, 1, `expected exactly 1 enforceRunBudget call site in dispatch, found ${calls.length}`);

  const consumeIdx = body.indexOf('this._consumeApproval(');
  assert.ok(consumeIdx > -1, 'dispatch must still consume the approval grant');
  assert.ok(
    calls[0].index < consumeIdx,
    'enforceRunBudget must run before dispatch consumes the one-time approval grant',
  );

  // 그리고 배치 루프는 반드시 _dispatchOne을 거쳐야 한다 — 방/run 저장을
  // 되돌려 넣어 per-run 가드를 우회하는 리팩터를 잡는다.
  assert.match(body, /await this\._dispatchOne\(\{/, 'dispatch must create runs through _dispatchOne');
  assert.doesNotMatch(body, /this\.roomRepo\.save\(/, 'dispatch must not create rooms directly — that side effect belongs behind the per-run guard');
  assert.doesNotMatch(body, /this\.runRepo\.save\(/, 'dispatch must not save run rows directly — that side effect belongs behind the per-run guard');
});

test('orchestration-mission.service.ts createMission calls enforceRunBudget exactly once, before the mission row save', () => {
  assertGuardedChokepoint({
    file: 'modules/orchestration/orchestration-mission.service.ts',
    methodOpenRe: /async createMission\(input: \{[\s\S]*?\r?\n  \}\r?\n/,
    sideEffectMarkers: ['this.missionRepo.save('],
    methodLabel: 'createMission',
  });
});

test('each chokepoint passes its own kind: "qa" / "action" / "orchestration"', () => {
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

  const orchestrationSrc = code('modules/orchestration/orchestration-mission.service.ts');
  assert.match(
    orchestrationSrc, /enforceRunBudget\(\s*\{[\s\S]*?\},\s*'orchestration',/,
    'orchestration-mission.service.ts must call enforceRunBudget with kind "orchestration"',
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
