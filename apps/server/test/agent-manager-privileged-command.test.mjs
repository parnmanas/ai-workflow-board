// 권한 상승 승인 흐름 — agent 가 요청하고, **운영자가 승인할 때만** 실행된다.
//
// 이 파일이 지키는 것:
//   1. 승인 없이는 아무것도 디스패치되지 않는다. 기본값은 거부다.
//   2. 승인에는 비밀번호가 필요하고, 그 비밀번호는 일회용 티켓이 되어
//      `run_privileged_command` 의 args 에는 **티켓 id 만** 실린다.
//   3. 매니저는 **정본 argv** 를 서버에서 다시 받아 간다 — SSE 페이로드에 명령이
//      실리지 않으므로, 운영자가 읽고 승인한 것과 도는 것이 갈라질 수 없다.
//   4. 남의 인스턴스는 그 정본을 집을 수 없다.
//   5. 한 번 결정된 요청은 다시 결정되지 않는다.

import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { bootApp, exitAfterTests } from './helpers/boot.mjs';
import { createAgent, createApiKey, createUser, createWorkspace } from './helpers/fixtures.mjs';

process.env.PORT = process.env.PRIVILEGED_CMD_PORT || '0';
// 매니저 전용 엔드포인트의 신원 확인을 실제로 태우기 위해 dev 모드를 끈다.
process.env.AGENT_DEV_MODE = 'false';

const DIST = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const { PrivilegedCommandService } = await import(
  'file://' + path.join(DIST, 'modules', 'agent-manager', 'privileged-command.service.js')
);

const INSTANCE_ID = 'privileged-instance';
const PASSWORD = 'operator-typed-this-once';

test('권한 상승은 운영자 승인으로만 실행되고, 매니저는 정본 argv 를 다시 받아 간다', async (t) => {
  const { app, port, modules } = await bootApp({ port: Number.parseInt(process.env.PORT, 10) });
  t.after(async () => {
    await app.close();
  });

  const { AuthService, getDataSourceToken } = modules;
  const workspace = await createWorkspace(app, getDataSourceToken, 'privileged');
  const manager = await createAgent(app, getDataSourceToken, null, {
    name: 'privileged-manager',
    type: 'manager',
  });
  const managerKey = await createApiKey(app, getDataSourceToken, manager.id, {
    workspaceId: workspace.id,
    label: 'privileged-manager-key',
  });
  const stranger = await createAgent(app, getDataSourceToken, null, {
    name: 'privileged-stranger',
    type: 'manager',
  });
  const strangerKey = await createApiKey(app, getDataSourceToken, stranger.id, {
    workspaceId: workspace.id,
    label: 'privileged-stranger-key',
  });
  const admin = await createUser(app, getDataSourceToken, { name: 'privileged-admin', role: 'admin' });
  const token = app.get(AuthService).createSession(admin.id);

  const readJson = async (resp, expectedStatus) => {
    const body = await resp.text();
    assert.equal(resp.status, expectedStatus, body);
    return body ? JSON.parse(body) : null;
  };

  await readJson(
    await fetch(`http://127.0.0.1:${port}/api/agent/instance-heartbeat`, {
      method: 'POST',
      headers: { 'X-Agent-Key': managerKey.raw_key, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        instance_id: INSTANCE_ID,
        agent_id: manager.id,
        mode: 'manager',
        hostname: 'privileged-host',
        plugin_version: 'test',
        cli: 'mixed',
        cli_adapters: ['claude'],
        pid: 4242,
        started_at: new Date().toISOString(),
      }),
    }),
    201,
  );

  const svc = app.get(PrivilegedCommandService);
  const newRequest = (over = {}) => {
    const created = svc.create({
      workspace_id: workspace.id,
      agent_id: 'agent-asking',
      agent_name: 'Runner/Worker',
      instance_id: INSTANCE_ID,
      hostname: 'privileged-host',
      command: 'apt-get',
      args: ['install', '-y', 'ripgrep'],
      cwd: null,
      reason: 'ripgrep is needed to search the repo',
      ...over,
    });
    assert.equal(created.ok, true);
    return created.request;
  };

  const listPending = async () =>
    readJson(
      await fetch(`http://127.0.0.1:${port}/api/admin/agent-manager/privileged-commands`, {
        headers: { Authorization: `Bearer ${token}` },
      }),
      200,
    );
  const approve = (id, body) =>
    fetch(`http://127.0.0.1:${port}/api/admin/agent-manager/privileged-commands/${id}/approve`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    });
  const claim = (id, key, instanceId) =>
    fetch(
      `http://127.0.0.1:${port}/api/agent/privileged-command/${id}?instance_id=${encodeURIComponent(instanceId)}`,
      { headers: { 'X-Agent-Key': key } },
    );

  // ── 승인 대기 목록에 보인다 ─────────────────────────────────────────────
  const req = newRequest();
  const pending = await listPending();
  assert.equal(pending.length, 1);
  assert.equal(pending[0].request_id, req.request_id);
  assert.equal(pending[0].command, 'apt-get', '운영자는 실행될 명령을 그대로 본다');
  assert.deepEqual(pending[0].args, ['install', '-y', 'ripgrep']);

  // ── 승인 전에는 매니저가 정본을 집을 수 없다 ────────────────────────────
  await readJson(await claim(req.request_id, managerKey.raw_key, INSTANCE_ID), 409);

  // ── 비밀번호 없는 승인은 거부된다 ───────────────────────────────────────
  await readJson(await approve(req.request_id, {}), 400);

  // ── 승인하면 디스패치되고, 비밀번호는 응답에 없다 ───────────────────────
  const approved = await readJson(await approve(req.request_id, { password: PASSWORD }), 202);
  assert.ok(approved.command_id);
  assert.equal(
    JSON.stringify(approved).includes(PASSWORD),
    false,
    '승인 응답에 비밀번호가 되돌아오면 안 된다',
  );
  assert.equal((await listPending()).length, 0, '결정된 요청은 대기열에서 빠진다');

  // ── 같은 요청을 두 번 승인할 수 없다 ────────────────────────────────────
  await readJson(await approve(req.request_id, { password: PASSWORD }), 409);

  // ── 남의 인스턴스는 정본을 못 집는다 ────────────────────────────────────
  await readJson(await claim(req.request_id, strangerKey.raw_key, INSTANCE_ID), 403);

  // ── 정당한 매니저는 정본 argv 를 그대로 받아 간다 ───────────────────────
  const canonical = await readJson(await claim(req.request_id, managerKey.raw_key, INSTANCE_ID), 200);
  assert.deepEqual(
    { command: canonical.command, args: canonical.args },
    { command: 'apt-get', args: ['install', '-y', 'ripgrep'] },
    '운영자가 승인한 argv 와 매니저가 받아 가는 argv 는 같은 것이어야 한다',
  );

  // ── 결과를 돌려주면 요청이 끝난다 ───────────────────────────────────────
  await readJson(
    await fetch(`http://127.0.0.1:${port}/api/agent/privileged-command/${req.request_id}/result`, {
      method: 'POST',
      headers: { 'X-Agent-Key': managerKey.raw_key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ instance_id: INSTANCE_ID, ok: true, output: 'Setting up ripgrep' }),
    }),
    201,
  );
  const finished = svc.get(req.request_id);
  assert.equal(finished.status, 'done');
  assert.equal(finished.ok, true);
  assert.match(finished.output, /ripgrep/);

  // ── 거부하면 그걸로 끝이다 ──────────────────────────────────────────────
  const second = newRequest();
  const denied = await readJson(
    await fetch(
      `http://127.0.0.1:${port}/api/admin/agent-manager/privileged-commands/${second.request_id}/deny`,
      { method: 'POST', headers: { Authorization: `Bearer ${token}` } },
    ),
    200,
  );
  assert.equal(denied.status, 'denied');
  await readJson(await approve(second.request_id, { password: PASSWORD }), 409);
  await readJson(await claim(second.request_id, managerKey.raw_key, INSTANCE_ID), 409);

  // ── 한 agent 가 대기열을 무한히 채울 수 없다 ────────────────────────────
  // (위에서 second 가 이미 거부돼 빠졌으므로 여기서 새로 세 건을 쌓는다.)
  newRequest();
  newRequest();
  newRequest();
  const overflow = svc.create({
    workspace_id: workspace.id,
    agent_id: 'agent-asking',
    agent_name: 'Runner/Worker',
    instance_id: INSTANCE_ID,
    hostname: 'privileged-host',
    command: 'apt-get',
    args: ['install', '-y', 'fd'],
    cwd: null,
    reason: 'one too many',
  });
  assert.deepEqual(overflow, { ok: false, reason: 'too_many_pending' });
});

exitAfterTests();
