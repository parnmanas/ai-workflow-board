// ticket 9408b308 — 매니저의 `scheduled` 승인 요청이 서버까지 도달하는지.
//
// manager-capabilities-heartbeat.test.mjs 와 같은 기법: 내부 객체가 아니라
// **실제 HTTP 엔드포인트**로 하트비트를 POST 하고, InstanceRegistryService 가
// 실제로 저장한 값을 되읽는다. 여기에 더해 완료 기준 4("관리자가 페이지를 열지
// 않아도 확인 가능한 신호가 남는다")를 위해 `activity_logs` 감사행이 실제로
// 쓰였는지, 그리고 같은 요청이 반복될 때 중복으로 쌓이지 않는지 확인한다.

import assert from 'node:assert/strict';
import test from 'node:test';

import { bootApp, exitAfterTests } from './helpers/boot.mjs';
import { createAgent, createApiKey, createWorkspace } from './helpers/fixtures.mjs';
import { InstanceRegistryService } from '../dist/modules/agent-manager/instance-registry.service.js';
import { ActivityLog } from '../dist/entities/ActivityLog.js';

process.env.PORT = process.env.MANAGER_UPDATE_APPROVAL_PORT || '7931';

const APPROVAL_ACTION = 'agent_manager_update_approval_requested';

async function setup(t, port, label) {
  const { app, port: boundPort, modules } = await bootApp({ port });
  t.after(async () => { await app.close(); });
  const { getDataSourceToken } = modules;
  const workspace = await createWorkspace(app, getDataSourceToken, label);
  const manager = await createAgent(app, getDataSourceToken, null, {
    name: `${label}-host`,
    type: 'manager',
  });
  const key = await createApiKey(app, getDataSourceToken, manager.id, {
    workspaceId: workspace.id,
    label,
  });
  const dataSource = app.get(getDataSourceToken());
  return { app, port: boundPort, workspace, manager, key, dataSource };
}

async function heartbeat(port, key, manager, workspace, body) {
  const response = await fetch(`http://127.0.0.1:${port}/api/agent/instance-heartbeat`, {
    method: 'POST',
    headers: { 'X-Agent-Key': key.raw_key, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      agent_id: manager.id,
      workspace_id: workspace.id,
      mode: 'manager',
      hostname: 'approval-test-host',
      plugin_version: '1.6.94',
      cli: 'mixed',
      cli_adapters: [],
      pid: 123,
      started_at: new Date().toISOString(),
      ...body,
    }),
  });
  assert.equal(response.status, 201, await response.text());
  return response;
}

/** 감사행 조회. best-effort 저장이라 잠깐의 지연을 허용한다. */
async function approvalRows(dataSource, agentId, { expect } = {}) {
  const repo = dataSource.getRepository(ActivityLog);
  for (let i = 0; i < 40; i += 1) {
    const rows = await repo.find({ where: { action: APPROVAL_ACTION, entity_id: agentId } });
    if (expect === undefined || rows.length >= expect) return rows;
    await new Promise((r) => setTimeout(r, 25));
  }
  return repo.find({ where: { action: APPROVAL_ACTION, entity_id: agentId } });
}

test('승인 대기 버전을 실은 하트비트가 레지스트리에 저장되고 감사행을 남긴다', async (t) => {
  const { port, manager, workspace, key, dataSource, app } = await setup(
    t, Number.parseInt(process.env.PORT, 10), 'update-approval',
  );

  await heartbeat(port, key, manager, workspace, {
    instance_id: 'update-approval-1',
    latest_version: '1.7.0',
    update_available: true,
    update_channel: 'latest',
    update_approval_pending_version: '1.7.0',
  });

  const record = app.get(InstanceRegistryService).get('update-approval-1');
  assert.ok(record, 'instance record must exist after the heartbeat');
  assert.equal(record.update_approval_pending_version, '1.7.0');

  const rows = await approvalRows(dataSource, manager.id, { expect: 1 });
  assert.equal(rows.length, 1, '승인 요청은 감사행으로 남아야 한다 (완료 기준 4)');
  const payload = JSON.parse(rows[0].new_value);
  assert.equal(payload.target_version, '1.7.0');
  assert.equal(payload.current_version, '1.6.94');
  assert.equal(payload.hostname, 'approval-test-host');
  assert.equal(rows[0].entity_type, 'agent_manager');
  assert.equal(rows[0].field_changed, 'update_approval_pending_version');
});

test('같은 요청이 반복되는 하트비트는 감사행을 새로 쌓지 않고, 새 버전은 새로 남긴다', async (t) => {
  // 고정 포트를 산술로 파생(PORT+n)하지 않고 OS 가 고른 빈 포트를 쓴다 (ticket 5db0964a).
  // 파생 포트는 소스 grep 에도 포트 목록에도 잡히지 않는 데다, bootApp 이 부팅마다
  // process.env.PORT 를 실제 바인딩 포트로 덮어쓰기 때문에 이 파일의 세 번째·네 번째
  // 부팅은 7933·7934 가 아니라 7934·7937 로 밀려 있었다.
  const { port, manager, workspace, key, dataSource } = await setup(t, 0, 'update-approval-dedupe');

  const base = {
    instance_id: 'update-approval-dedupe-1',
    latest_version: '1.7.0',
    update_available: true,
    update_channel: 'latest',
    update_approval_pending_version: '1.7.0',
  };
  // 하트비트는 30초마다 온다 — 같은 값이 이어지는 동안 다시 쓰면 로그가 요청
  // 하나로 뒤덮인다.
  await heartbeat(port, key, manager, workspace, base);
  await heartbeat(port, key, manager, workspace, base);
  await heartbeat(port, key, manager, workspace, base);

  let rows = await approvalRows(dataSource, manager.id, { expect: 1 });
  assert.equal(rows.length, 1, '값이 같은 동안에는 한 번만 기록한다');

  // 승인 없이 더 새 버전이 올라온 경우 — 이건 별개의 요청이므로 새로 남아야 한다.
  await heartbeat(port, key, manager, workspace, {
    ...base,
    latest_version: '1.8.0',
    update_approval_pending_version: '1.8.0',
  });
  rows = await approvalRows(dataSource, manager.id, { expect: 2 });
  assert.equal(rows.length, 2, '대상 버전이 바뀌면 새 요청으로 기록한다');
  assert.deepEqual(
    rows.map((r) => JSON.parse(r.new_value).target_version).sort(),
    ['1.7.0', '1.8.0'],
  );
});

test('매니저 재기동으로 instance_id 가 바뀌어도 같은 요청은 다시 기록하지 않는다', async (t) => {
  const { port, manager, workspace, key, dataSource } = await setup(t, 0, 'update-approval-restart');

  const pending = {
    latest_version: '1.7.0',
    update_available: true,
    update_channel: 'latest',
    update_approval_pending_version: '1.7.0',
  };
  await heartbeat(port, key, manager, workspace, { ...pending, instance_id: 'restart-before' });
  // 재기동 = 새 instance_id. upsert 가 전임자를 supersede 한다.
  await heartbeat(port, key, manager, workspace, { ...pending, instance_id: 'restart-after' });

  const rows = await approvalRows(dataSource, manager.id, { expect: 1 });
  assert.equal(
    rows.length,
    1,
    '승인이 안 된 채 매니저가 재기동될 때마다 같은 요청이 쌓이면 안 된다',
  );
});

test('승인 대기가 아닌 하트비트는 감사행을 남기지 않고, 구버전 매니저는 필드가 undefined 로 남는다', async (t) => {
  const { port, manager, workspace, key, dataSource, app } = await setup(t, 0, 'update-approval-absent');

  // 1) 필드를 아는 매니저지만 대기 없음 → null
  await heartbeat(port, key, manager, workspace, {
    instance_id: 'approval-absent-null',
    latest_version: '1.7.0',
    update_available: true,
    update_approval_pending_version: null,
  });
  const withNull = app.get(InstanceRegistryService).get('approval-absent-null');
  assert.equal(withNull.update_approval_pending_version, null);

  // 2) 필드를 아예 모르는 구버전 매니저 → undefined (null 과 구분되어야 한다)
  await heartbeat(port, key, manager, workspace, {
    instance_id: 'approval-absent-undefined',
    latest_version: '1.7.0',
    update_available: true,
  });
  const withoutField = app.get(InstanceRegistryService).get('approval-absent-undefined');
  assert.equal(
    withoutField.update_approval_pending_version,
    undefined,
    '필드를 안 보내는 매니저는 undefined 로 round-trip 해야 한다 (null 로 접히면 안 된다)',
  );

  const rows = await approvalRows(dataSource, manager.id);
  assert.equal(rows.length, 0, '대기 중이 아니면 감사행이 없어야 한다');
});

exitAfterTests();
