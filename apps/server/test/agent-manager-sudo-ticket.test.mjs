// 일회용 sudo 티켓 — 운영자가 방금 입력한 비밀번호를 저장하지 않고 매니저에게
// 한 번만 건네는 경로. 이 파일이 지키는 것은 전부 "새지 않는가" 다.
//
//   1. 발급 응답에 비밀번호가 되돌아오지 않는다.
//   2. 1회용이다 — 두 번째 소비는 실패한다.
//   3. 발급 대상이 아닌 매니저는 못 집는다. 그 시도 자체가 티켓을 태운다
//      (그 시점에 이미 id 가 샜다는 뜻이므로 남겨 두는 쪽이 더 나쁘다).
//   4. scope 없이는 발급되지 않는다 — "무엇에 쓸지 모르는 티켓" 은 곧 "무엇에든
//      쓸 수 있는 티켓" 이다.
//   5. 운영자가 취소하면 즉시 죽는다.

import assert from 'node:assert/strict';
import test from 'node:test';

import { bootApp, exitAfterTests } from './helpers/boot.mjs';
import { createAgent, createApiKey, createUser, createWorkspace } from './helpers/fixtures.mjs';

process.env.PORT = process.env.SUDO_TICKET_PORT || '0';
// 이 파일은 **실제 인증 경로**를 타야 한다. 부팅 헬퍼 기본값(AGENT_DEV_MODE=true)은
// AgentAuthGuard 가 신원을 아예 붙이지 않게 만들어, "발급 대상 매니저만 집을 수
// 있다" 는 이 기능의 핵심 단언을 검사할 수 없게 한다.
process.env.AGENT_DEV_MODE = 'false';

const INSTANCE_ID = 'sudo-ticket-instance';
const PASSWORD = 'correct horse battery staple';

test('sudo 티켓은 1회용이고, 발급 대상 매니저만 집을 수 있으며, 비밀번호는 발급 응답에 없다', async (t) => {
  const { app, port, modules } = await bootApp({ port: Number.parseInt(process.env.PORT, 10) });
  t.after(async () => {
    await app.close();
  });

  const { AuthService, getDataSourceToken } = modules;
  const workspace = await createWorkspace(app, getDataSourceToken, 'sudo-ticket');
  const manager = await createAgent(app, getDataSourceToken, null, {
    name: 'sudo-ticket-manager',
    type: 'manager',
  });
  const managerKey = await createApiKey(app, getDataSourceToken, manager.id, {
    workspaceId: workspace.id,
    label: 'sudo-ticket-manager-key',
  });
  // 같은 워크스페이스의 **다른** 매니저 — 남의 티켓을 집으려 시도하는 쪽.
  const other = await createAgent(app, getDataSourceToken, null, {
    name: 'sudo-ticket-other',
    type: 'manager',
  });
  const otherKey = await createApiKey(app, getDataSourceToken, other.id, {
    workspaceId: workspace.id,
    label: 'sudo-ticket-other-key',
  });
  const admin = await createUser(app, getDataSourceToken, { name: 'sudo-ticket-admin', role: 'admin' });
  const token = app.get(AuthService).createSession(admin.id);

  const readJson = async (resp, expectedStatus) => {
    const body = await resp.text();
    assert.equal(resp.status, expectedStatus, body);
    return body ? JSON.parse(body) : null;
  };

  // 매니저 인스턴스를 등록한다 — 티켓은 살아 있는 인스턴스에만 발급된다.
  await readJson(
    await fetch(`http://127.0.0.1:${port}/api/agent/instance-heartbeat`, {
      method: 'POST',
      headers: { 'X-Agent-Key': managerKey.raw_key, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        instance_id: INSTANCE_ID,
        agent_id: manager.id,
        mode: 'manager',
        hostname: 'sudo-host',
        plugin_version: 'test',
        cli: 'mixed',
        cli_adapters: ['claude'],
        pid: 909,
        started_at: new Date().toISOString(),
      }),
    }),
    201,
  );

  const mint = (body) =>
    fetch(`http://127.0.0.1:${port}/api/admin/agent-manager/instances/${INSTANCE_ID}/sudo-ticket`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  const consume = (ticketId, key) =>
    fetch(`http://127.0.0.1:${port}/api/agent/sudo-ticket/${encodeURIComponent(ticketId)}`, {
      headers: { 'X-Agent-Key': key },
    });

  const scope = { kind: 'cli_update', cli: 'claude', bin: '/usr/local/bin/claude' };

  // ── 발급 응답에는 티켓 id 만 있다 ────────────────────────────────────────
  const minted = await readJson(await mint({ password: PASSWORD, scope }), 201);
  assert.ok(minted.ticket_id, '티켓 id 가 있어야 한다');
  assert.ok(minted.expires_at, '만료 시각을 알려줘야 화면이 창을 닫을 수 있다');
  assert.equal(
    JSON.stringify(minted).includes(PASSWORD),
    false,
    '발급 응답에 비밀번호가 되돌아오면 브라우저 히스토리·프록시 로그에 남는다',
  );

  // ── 발급 대상 매니저가 1회 집는다 ───────────────────────────────────────
  const pulled = await readJson(await consume(minted.ticket_id, managerKey.raw_key), 200);
  assert.equal(pulled.password, PASSWORD);
  assert.deepEqual(pulled.scope, scope, '무엇에 써도 되는지가 함께 와야 매니저가 대조할 수 있다');

  // ── 두 번째는 없다 ──────────────────────────────────────────────────────
  await readJson(await consume(minted.ticket_id, managerKey.raw_key), 404);

  // ── 남의 티켓은 못 집고, 그 시도가 티켓을 태운다 ────────────────────────
  const second = await readJson(await mint({ password: PASSWORD, scope }), 201);
  await readJson(await consume(second.ticket_id, otherKey.raw_key), 403);
  await readJson(
    await consume(second.ticket_id, managerKey.raw_key),
    404,
    // 정당한 매니저에게도 더는 안 준다 — id 가 샜다는 신호이므로 태우는 쪽이 맞다.
  );

  // ── 운영자가 취소하면 즉시 죽는다 ───────────────────────────────────────
  const third = await readJson(await mint({ password: PASSWORD, scope }), 201);
  await readJson(
    await fetch(`http://127.0.0.1:${port}/api/admin/agent-manager/sudo-ticket/${third.ticket_id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    }),
    200,
  );
  await readJson(await consume(third.ticket_id, managerKey.raw_key), 404);

  // ── 모양이 어긋난 발급 요청은 거부 ──────────────────────────────────────
  await readJson(await mint({ scope }), 400);
  await readJson(await mint({ password: PASSWORD }), 400);
  await readJson(await mint({ password: PASSWORD, scope: { kind: 'whatever' } }), 400);
  await readJson(await mint({ password: PASSWORD, scope: { kind: 'cli_update', cli: 'claude' } }), 400);

  // ── 살아 있지 않은 인스턴스에는 발급하지 않는다 ─────────────────────────
  await readJson(
    await fetch(`http://127.0.0.1:${port}/api/admin/agent-manager/instances/nope/sudo-ticket`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: PASSWORD, scope }),
    }),
    404,
  );

  // ── 모르는 티켓 id 는 404 ───────────────────────────────────────────────
  await readJson(await consume('deadbeef', managerKey.raw_key), 404);
});

exitAfterTests();
