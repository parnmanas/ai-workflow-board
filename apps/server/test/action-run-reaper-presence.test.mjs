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
  // source_ticket_id도 completion_contract_injected도 없는 run은 의도적으로
  // 스윕에서 제외한다(티켓 2fa5312b, b273d603 후속): 이런 run은 b273d603
  // 이전에 생성돼(컬럼 자체가 없던 시절이라 기본값 false) 프롬프트에 완료
  // 계약을 받은 적도 없으므로 complete_action_run을 호출할 방법이 아예
  // 없다 — TTL로 reap하면 정상일 수도 있는 run을 거짓 'failed'로 만들어
  // 버린다. b273d603 이후에 디스패치된 source_ticket_id 없는 run은 생성
  // 시점(actions.service.ts dispatch())에 completion_contract_injected=true를
  // 받으므로 이제 유효한 후보다. 이 제외는 candidate QUERY 단계에서
  // 이뤄져야 한다(사후 JS 루프 skip 아님) — 루프 skip은 계약 없는 row에도
  // take(ACTION_RUN_REAPER_BATCH) 예산을 그대로 쓰므로, 그런 row가 batch
  // 크기를 넘어서면 진짜 새로운 좀비가 조용히 영원히 도달되지 않는다(티켓
  // 23dfc38a). IS NOT NULL은 반드시 != '' 와 함께 있어야 한다 — 단순
  // != '' 만으로는 Postgres의 3진 NULL 비교 때문에 legacy NULL row가
  // 조용히 빠질 수 있다.
  assert.match(code, /createQueryBuilder\(/, 'candidate selection must use createQueryBuilder, not repo.find(), so the source_ticket_id / completion_contract_injected gate can live in SQL before take()');
  assert.match(
    code,
    /source_ticket_id\s+IS\s+NOT\s+NULL\s+AND\s+r?\.?source_ticket_id\s*!=\s*['"]{2}/,
    'candidate query must still admit ticket-driven runs (source_ticket_id IS NOT NULL AND != \'\') before take(), not inside the reap loop',
  );
  assert.match(
    code,
    /completion_contract_injected/,
    'candidate query must also admit source_ticket_id-less runs that received a completion contract (ticket 2fa5312b)',
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
