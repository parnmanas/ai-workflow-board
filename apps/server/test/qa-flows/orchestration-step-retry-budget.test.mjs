// QA flow: 끝난 노드를 **같은 노드로** 다시 돌릴 수 있는가 (운영 요청 2026-09-26).
//
// 고치기 전의 증상: step 이 재시도 예산(`max_attempts`, 생성 시 2)을 다 쓰면 retry 가
// 409 였고, 그 거부 메시지가 "replace it with new steps" 라고 안내했다. 그래서
// orchestrator 가 audit-commit → audit-commit2 → audit-commit3 처럼 **같은 일을 하는
// 노드를 복제**했다. 계획이 지저분해지고 한 작업의 이력(시도·결과·증거·타임라인)이
// 세 조각으로 갈린다.
//
// 이 파일이 고정하는 계약:
//   1. 예산을 올리면 같은 노드가 다시 돈다. `retry` 와 한 번의 호출로 끝난다.
//   2. **done 노드도 재활용된다** — 성공한 뒤 "한 군데만 고쳐" 가 같은 노드로 간다.
//   3. 예산은 이미 쓴 시도 아래로 내려가지 않는다(실행 이력을 소급 무효화하지 않는다).
//      정확히 쓴 만큼으로 내리면 "이번이 마지막"이다.
//   4. 상한이 있다 — 무한 재시도 루프를 agent 스스로 만들 수 없다.
//   5. 거부 메시지가 출구(예산 올리기 + 재활용)를 말하고, 복제를 권하지 않는다.
//   6. 예산 변경은 타임라인에 남는다.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { bootApp, exitAfterTests, step as logStep } from '../helpers/boot.mjs';
import { createWorkspace, createApiKey } from '../helpers/fixtures.mjs';
import { buildTeam } from '../helpers/orchestration-team.mjs';
import { McpClient } from '../helpers/mcp-client.mjs';

process.env.PORT = process.env.ORCHESTRATION_RETRY_BUDGET_PORT || '0';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(__dirname, '..', '..', 'dist');
const HUMAN = { type: 'user', id: 'human-budget', name: 'Operator' };

async function loadServices() {
  const team = await import(pathToFileURL(path.join(DIST, 'modules', 'orchestration', 'orchestration-team.service.js')).href);
  const mission = await import(pathToFileURL(path.join(DIST, 'modules', 'orchestration', 'orchestration-mission.service.js')).href);
  const runner = await import(pathToFileURL(path.join(DIST, 'modules', 'orchestration', 'orchestration-runner.service.js')).href);
  const constants = await import(pathToFileURL(path.join(DIST, 'modules', 'orchestration', 'orchestration.constants.js')).href);
  return {
    OrchestrationTeamService: team.OrchestrationTeamService,
    OrchestrationMissionService: mission.OrchestrationMissionService,
    OrchestrationRunnerService: runner.OrchestrationRunnerService,
    MAX_STEP_ATTEMPTS_CEILING: constants.MAX_STEP_ATTEMPTS_CEILING,
  };
}

const byKey = (d) => Object.fromEntries(d.steps.map((s) => [s.step_key, s]));

// 리스 토큰은 step 행이 들고 있는 그것이 곧 유효한 토큰이다 — 방 메시지에서 긁어오면
// 재시도로 방이 여러 개 생겼을 때 어느 attempt 의 것인지 헷갈린다.
async function leaseOf(ds, stepId) {
  const row = await ds.getRepository('OrchestrationStep').findOne({ where: { id: stepId } });
  return row?.lease_token || null;
}

test('예산을 채워 같은 노드를 다시 돌린다 — 복제 노드를 만들지 않는다', async (t) => {
  const { app, port, modules } = await bootApp({ port: parseInt(process.env.PORT, 10) });
  t.after(() => { void app.close().catch(() => {}); });
  const { getDataSourceToken } = modules;
  const ds = app.get(getDataSourceToken());
  const services = await loadServices();
  const teams = app.get(services.OrchestrationTeamService);
  const missions = app.get(services.OrchestrationMissionService);
  const runner = app.get(services.OrchestrationRunnerService);
  const base = `http://127.0.0.1:${port}`;

  const ws = await createWorkspace(app, getDataSourceToken, 'retry-budget');
  const squad = await buildTeam(app, getDataSourceToken, teams, {
    workspaceId: ws.id,
    name: 'Budget squad',
    team: { max_parallel_steps: 2, created_by: HUMAN.id },
    members: [{ role_label: 'builder' }],
  });
  const lead = squad.orchestrator;
  const worker = squad.member('builder');
  const leadKey = await createApiKey(app, getDataSourceToken, lead.id, { workspaceId: ws.id, label: 'lead' });
  const workerKey = await createApiKey(app, getDataSourceToken, worker.id, { workspaceId: ws.id, label: 'worker' });
  const leadMcp = new McpClient({ baseUrl: base, apiKey: leadKey.raw_key });
  const workerMcp = new McpClient({ baseUrl: base, apiKey: workerKey.raw_key });
  t.after(() => { void leadMcp.close().catch(() => {}); void workerMcp.close().catch(() => {}); });

  const mission = await missions.createMission({
    workspace_id: ws.id, team_id: squad.team.id, title: 'Budget mission',
    objective: 'get it right', created_by: HUMAN.id,
  });
  await runner.startMission(mission.id, ws.id, HUMAN);
  await leadMcp.callTool('submit_orchestration_plan', {
    mission_id: mission.id,
    steps: [{ step_key: 'audit', title: 'Audit the tree', instructions: 'audit', assignee_agent_id: worker.id }],
  });

  logStep('기본 예산 2회를 모두 실패로 소진시킨다');
  for (let i = 0; i < 2; i++) {
    const s = byKey(await missions.getMissionDetail(mission.id, ws.id)).audit;
    const reported = await workerMcp.callTool('report_orchestration_step', {
      step_id: s.id, status: 'failed', summary: `attempt ${i + 1} 실패`, lease_token: await leaseOf(ds, s.id),
    });
    assert.ok(reported && !reported.isError, `실패 보고가 통해야 한다: ${JSON.stringify(reported)}`);
    if (i === 0) {
      const again = await leadMcp.callTool('update_orchestration_step', { step_id: s.id, action: 'retry' });
      assert.ok(again && !again.isError, `예산이 남아 있으면 그냥 재시도된다: ${JSON.stringify(again)}`);
    }
  }
  let audit = byKey(await missions.getMissionDetail(mission.id, ws.id)).audit;
  assert.equal(audit.attempt, 2);
  assert.equal(audit.max_attempts, 2);

  logStep('예산이 바닥나면 거부가 출구를 말한다 — 복제를 권하지 않는다');
  const refused = await leadMcp.callTool('update_orchestration_step', { step_id: audit.id, action: 'retry' });
  assert.ok(refused?.isError, '예산을 다 쓰면 그냥 재시도되지 않는다');
  const msg = JSON.stringify(refused);
  assert.match(msg, /max_attempts/, '무엇을 하면 되는지 이름을 말한다');
  assert.match(msg, /Reuse this step/i, '같은 노드를 다시 쓰라고 안내한다');
  assert.doesNotMatch(msg, /replace it with new steps/i, '복제를 권하던 옛 안내가 남아 있으면 안 된다');

  logStep('예산 + retry 를 한 번의 호출로 — 같은 노드가 다시 디스패치된다');
  const refilled = await leadMcp.callTool('update_orchestration_step', {
    step_id: audit.id, action: 'retry', max_attempts: 4,
    instructions: 'audit again, this time check the lockfile too',
    reason: '운영자가 범위를 넓혀 달라고 했다',
  });
  assert.ok(refilled && !refilled.isError, `예산을 올리면 통과해야 한다: ${JSON.stringify(refilled)}`);
  let detail = await missions.getMissionDetail(mission.id, ws.id);
  audit = byKey(detail).audit;
  assert.equal(detail.steps.length, 1, '복제 노드가 생기지 않는다 — 계획은 여전히 한 노드다');
  assert.equal(audit.max_attempts, 4);
  assert.equal(audit.status, 'dispatched', '같은 노드가 다시 나간다');
  assert.equal(audit.attempt, 3, '시도 횟수는 계속 올라간다 — 이력을 되감지 않는다');
  assert.match(audit.instructions, /lockfile/, '같은 호출에서 지시문도 고쳐진다');
  assert.ok(
    detail.events.some((e) => e.type === 'step_retry_budget_changed' && /2 → 4/.test(e.message)),
    '예산 변경이 타임라인에 남는다',
  );

  logStep('성공한 노드도 같은 노드로 재작업된다');
  await workerMcp.callTool('report_orchestration_step', {
    step_id: audit.id, status: 'done', summary: '감사 완료', lease_token: await leaseOf(ds, audit.id),
  });
  assert.equal(byKey(await missions.getMissionDetail(mission.id, ws.id)).audit.status, 'done');
  const rework = await leadMcp.callTool('update_orchestration_step', {
    step_id: audit.id, action: 'retry', instructions: 'also fix the typo you left',
  });
  assert.ok(rework && !rework.isError, `done 노드도 재활용돼야 한다: ${JSON.stringify(rework)}`);
  detail = await missions.getMissionDetail(mission.id, ws.id);
  audit = byKey(detail).audit;
  assert.equal(audit.status, 'dispatched');
  assert.equal(detail.steps.length, 1, '재작업이 노드를 늘리지 않는다');
  assert.ok(
    detail.events.some((e) => e.type === 'step_retried' && /was done/.test(e.message)),
    '끝난 노드를 다시 돌렸다는 사실이 타임라인에 남는다',
  );

  logStep('예산은 이미 쓴 시도 아래로 내려가지 않는다');
  const used = audit.attempt;
  const tooLow = await leadMcp.callTool('update_orchestration_step', {
    step_id: audit.id, action: 'set_retry_budget', max_attempts: used - 1,
  });
  assert.ok(tooLow?.isError);
  assert.match(JSON.stringify(tooLow), /already used/i, '이미 일어난 실행을 소급 무효화하지 않는다');

  const exact = await leadMcp.callTool('update_orchestration_step', {
    step_id: audit.id, action: 'set_retry_budget', max_attempts: used, reason: '이번이 마지막',
  });
  assert.ok(exact && !exact.isError, '정확히 쓴 만큼으로는 내릴 수 있다 — "이번이 마지막"의 표현');
  assert.equal(byKey(await missions.getMissionDetail(mission.id, ws.id)).audit.max_attempts, used);

  logStep('상한이 있다 — 무한 재시도 루프를 스스로 만들 수 없다');
  const tooHigh = await leadMcp.callTool('update_orchestration_step', {
    step_id: audit.id, action: 'set_retry_budget', max_attempts: services.MAX_STEP_ATTEMPTS_CEILING + 1,
  });
  assert.ok(tooHigh?.isError);
  assert.match(JSON.stringify(tooHigh), /cannot exceed/i);

  logStep('set_retry_budget 은 예산만 바꾼다 — 스스로 디스패치하지 않는다');
  const s2 = byKey(await missions.getMissionDetail(mission.id, ws.id)).audit;
  assert.equal(s2.status, 'dispatched', '위의 retry 로 이미 나가 있는 상태가 유지된다');
  const noArg = await leadMcp.callTool('update_orchestration_step', { step_id: s2.id, action: 'set_retry_budget' });
  assert.ok(noArg?.isError);
  assert.match(JSON.stringify(noArg), /requires max_attempts/i);
});

exitAfterTests();
