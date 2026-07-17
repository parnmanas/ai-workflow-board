// Workspace 어시스턴트 지정 검증 (에픽 bf65ca00 · Phase 1 · S2).
//
// planner 결정 a: workspace.assistant_agent_id 는 관리자 전용이며, 지정 값은 이
// workspace 소속의 활성·비매니저 에이전트여야 한다. Chat-first 랜딩이 이 지정을 DM
// 프리셋으로 연결하므로, 잘못된/권한없는 지정이 서버에서 막히는지 실제
// WorkspacesController.update() (REST 경로)를 구동해 검증한다.
//
// 커버:
//   - 기본값 null (기존 workspace 무변경, 마이그레이션 0)
//   - 관리자(admin.agents)가 활성 in-ws 에이전트 지정 → 200, 영속
//   - 비관리자 → 403, 값 불변 (권한 게이트)
//   - 비활성 / 매니저 / 타-workspace / 존재안함 → 400 (workspace 경계 + 적격성)
//   - null / '' 로 해제 → 200
//   - assistant 미포함 PATCH(name)은 비관리자도 그대로 허용 → 기존 PATCH 권한 회귀 0
//
// 실행:  node --test --test-force-exit test/qa-flows/workspace-assistant-agent.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { bootApp } from '../helpers/boot.mjs';
import { createWorkspace, createAgent } from '../helpers/fixtures.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST_ROOT = path.join(__dirname, '..', '..', 'dist');
const loadDist = (...p) => import('file://' + path.join(DIST_ROOT, ...p));

function fakeRes() {
  return {
    _status: 200,
    _json: undefined,
    status(c) { this._status = c; return this; },
    json(x) { this._json = x; return this; },
  };
}

test('workspace assistant_agent_id: admin 지정/해제 + 경계 검증 + 비관리자 403', async (t) => {
  const { app, modules } = await bootApp({ port: parseInt(process.env.PORT || '7883', 10) });
  t.after(() => { void app.close().catch(() => {}); });
  const ds = app.get(modules.getDataSourceToken());

  const { WorkspacesController } = await loadDist('modules', 'workspaces', 'workspaces.controller.js');
  const controller = app.get(WorkspacesController);
  const wsRepo = ds.getRepository('Workspace');
  const agentRepo = ds.getRepository('Agent');

  const ws = await createWorkspace(app, modules.getDataSourceToken, 'assistant');
  const otherWs = await createWorkspace(app, modules.getDataSourceToken, 'other');

  const active = await createAgent(app, modules.getDataSourceToken, ws.id, { name: 'assistant', type: 'custom' });
  const inactive = await createAgent(app, modules.getDataSourceToken, ws.id, { name: 'inactive', type: 'custom' });
  await agentRepo.update(inactive.id, { is_active: 0 });
  const manager = await createAgent(app, modules.getDataSourceToken, ws.id, { name: 'mgr', type: 'manager' });
  const foreign = await createAgent(app, modules.getDataSourceToken, otherWs.id, { name: 'foreign', type: 'custom' });

  const admin = { id: 'u-admin', name: 'Admin', email: 'a@x', role: 'admin', permissions: [] };
  const nonAdmin = { id: 'u-user', name: 'User', email: 'u@x', role: 'user', permissions: [] };

  const patch = async (body, user) => {
    const res = fakeRes();
    await controller.update(ws.id, body, res, user);
    return res;
  };
  const currentAssistant = async () => (await wsRepo.findOne({ where: { id: ws.id } })).assistant_agent_id;

  // 기본값: null (설정 전)
  assert.equal(await currentAssistant(), null, 'default assistant_agent_id is null');

  // 관리자가 활성 in-ws 에이전트 지정 → 200, 영속
  let res = await patch({ assistant_agent_id: active.id }, admin);
  assert.equal(res._status, 200, 'admin sets active in-ws agent → 200');
  assert.equal(await currentAssistant(), active.id, 'persisted');

  // 비관리자 변경 시도 → 403, 값 불변
  res = await patch({ assistant_agent_id: null }, nonAdmin);
  assert.equal(res._status, 403, 'non-admin cannot change assistant → 403');
  assert.equal(await currentAssistant(), active.id, 'unchanged after 403');

  // 비활성 에이전트 → 400
  res = await patch({ assistant_agent_id: inactive.id }, admin);
  assert.equal(res._status, 400, 'inactive agent → 400');
  assert.equal(await currentAssistant(), active.id, 'unchanged after 400 (inactive)');

  // 매니저 에이전트 → 400 (DM auto-route 대상 아님)
  res = await patch({ assistant_agent_id: manager.id }, admin);
  assert.equal(res._status, 400, 'manager agent → 400');

  // 타 workspace 에이전트 → 400 (경계)
  res = await patch({ assistant_agent_id: foreign.id }, admin);
  assert.equal(res._status, 400, 'other-workspace agent → 400');

  // 존재하지 않는 id → 400
  res = await patch({ assistant_agent_id: 'no-such-agent' }, admin);
  assert.equal(res._status, 400, 'nonexistent agent → 400');

  // 관리자가 null 로 해제 → 200, null
  res = await patch({ assistant_agent_id: null }, admin);
  assert.equal(res._status, 200, 'admin clears with null → 200');
  assert.equal(await currentAssistant(), null, 'cleared');

  // 빈 문자열도 해제로 처리
  await patch({ assistant_agent_id: active.id }, admin);
  res = await patch({ assistant_agent_id: '' }, admin);
  assert.equal(res._status, 200, "empty string clears → 200");
  assert.equal(await currentAssistant(), null, 'cleared via empty string');

  // assistant 미포함 PATCH(name)은 비관리자도 그대로 허용 → 기존 권한 요건 회귀 0
  await patch({ assistant_agent_id: active.id }, admin);
  res = await patch({ name: 'renamed-by-user' }, nonAdmin);
  assert.equal(res._status, 200, 'non-admin can still PATCH name (existing behavior preserved)');
  assert.equal(await currentAssistant(), active.id, 'name PATCH did not disturb assistant');
});
