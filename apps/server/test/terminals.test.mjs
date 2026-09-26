// Terminal(Runtime Host 셸) 서버 contract — docs/terminals.md.
//
// 서버는 상태 없는 중계자다. 이 테스트는 가짜 Runtime Host(매니저 키 + 하트비트)를 세우고
//   1. GET hosts 가 **셸을 보고한 장비만** 보여주고(PTY 없는 장비는 목록에 없다),
//   2. list / open / attach 가 `terminal_request{request_id}` reverse RPC 로 매니저에 가서
//      `POST /api/agent/terminals/rpc/:id` 응답으로 풀리고(소유권 포함),
//   3. input / resize / close 가 올바른 op 으로 나가며,
//   4. 매니저가 중계한 출력이 driver 의 SSE 로만 흐르고(저장 없음),
//   5. 하트비트가 "이 터미널은 없다" 고 하면 살아 있던 행이 exited 로 정리되고 목록에서 빠지는
//   것을 고정한다. 터미널은 기록이 없으므로 **살아 있는 것만** 존재한다는 것이 핵심 불변식이다.
//
// 실행: node --test --test-force-exit test/terminals.test.mjs (dist 필요)

import test from 'node:test';
import assert from 'node:assert/strict';
import { bootApp, closeTestApp } from './helpers/boot.mjs';
import { createAgent, createUser, createWorkspace, runtimeHostKeyForAgent } from './helpers/fixtures.mjs';
import { openSseStream } from './helpers/sse-listener.mjs';

process.env.PORT = process.env.TEST_SERVER_PORT || '0';
process.env.AGENT_DEV_MODE = 'false';

async function call(url, init) {
  const res = await fetch(url, init);
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = null; }
  return { status: res.status, body, text };
}

async function waitFor(predicate, label, timeoutMs = 5000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 15));
  }
  throw new Error(`timeout waiting for ${label}`);
}

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');

test('terminals relay: hosts → RPC list/open/attach → input/resize → output stream → close → heartbeat reconcile', async (t) => {
  const { app, port, modules } = await bootApp({ port: parseInt(process.env.PORT, 10) });
  t.after(async () => { await closeTestApp(app); });
  const { getDataSourceToken, AuthService, activityEvents } = modules;
  const ds = app.get(getDataSourceToken());
  const base = `http://localhost:${port}`;

  const ws = await createWorkspace(app, getDataSourceToken, 'terminals');
  const owner = await createUser(app, getDataSourceToken, { name: 'owner', role: 'admin' });
  const plainUser = await createUser(app, getDataSourceToken, { name: 'plain', role: 'user' });
  const ownerToken = app.get(AuthService).createSession(owner.id);
  const plainToken = app.get(AuthService).createSession(plainUser.id);
  const ownerHeaders = { Authorization: `Bearer ${ownerToken}`, 'X-Workspace-Id': ws.id, 'Content-Type': 'application/json' };

  const agent = await createAgent(app, getDataSourceToken, ws.id, { name: 'coder', type: 'claude' });
  const managerId = agent.manager_agent_id;
  const managerKey = runtimeHostKeyForAgent(agent.id);
  await ds.getRepository('Agent').update({ id: managerId }, { name: 'rolf' });
  const managerHeaders = { 'X-Agent-Key': managerKey, 'Content-Type': 'application/json' };

  const sendHeartbeat = (extra) => call(`${base}/api/agent/instance-heartbeat`, {
    method: 'POST', headers: managerHeaders,
    body: JSON.stringify({
      instance_id: 'inst-rolf-1', agent_id: managerId, mode: 'manager', hostname: 'rolf', plugin_version: 'test',
      cli: 'claude', cli_adapters: ['claude'], pid: 4242, started_at: new Date().toISOString(),
      platform: 'linux',
      terminal_shells: [
        { id: 'bash', label: 'bash', path: '/bin/bash', default: true },
        { id: 'sh', label: 'sh', path: '/bin/sh' },
      ],
      ...extra,
    }),
  });
  const heartbeat = await sendHeartbeat({ terminals: [] });
  assert.ok(heartbeat.status < 300, `heartbeat accepted: ${heartbeat.status} ${heartbeat.text}`);

  // 셸을 하나도 보고하지 않는 두 번째 장비 — PTY 모듈이 없는 매니저를 흉내 낸다.
  const noPty = await createAgent(app, getDataSourceToken, ws.id, { name: 'nopty', type: 'claude' });
  const noPtyKey = runtimeHostKeyForAgent(noPty.id);
  await call(`${base}/api/agent/instance-heartbeat`, {
    method: 'POST', headers: { 'X-Agent-Key': noPtyKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      instance_id: 'inst-nopty-1', agent_id: noPty.manager_agent_id, mode: 'manager', hostname: 'ralf',
      plugin_version: 'test', cli: 'claude', cli_adapters: ['claude'], pid: 1, started_at: new Date().toISOString(),
    }),
  });

  const requests = [];
  const onRequest = (payload) => requests.push(payload);
  activityEvents.on('terminal_request', onRequest);
  t.after(() => activityEvents.removeListener('terminal_request', onRequest));
  const rpcRespond = (predicate, body) => waitFor(() => requests.some(predicate), 'rpc request').then(() => {
    const req = requests.find(predicate);
    return call(`${base}/api/agent/terminals/rpc/${req.request_id}`, {
      method: 'POST', headers: managerHeaders, body: JSON.stringify({ manager_id: managerId, ...body }),
    });
  });

  const stream = await openSseStream(port, ownerToken, {});
  t.after(() => stream.close());

  // 1. hosts — terminals.use 는 기본 admin 전용이고, 셸을 보고한 장비만 나온다.
  const forbidden = await call(`${base}/api/terminals/hosts`, { headers: { ...ownerHeaders, Authorization: `Bearer ${plainToken}` } });
  assert.equal(forbidden.status, 403, 'terminals.use is admin-only by default');
  const hosts = await call(`${base}/api/terminals/hosts`, { headers: ownerHeaders });
  assert.equal(hosts.status, 200, hosts.text);
  const host = hosts.body.find((h) => h.manager_id === managerId);
  assert.ok(host, 'a manager that reports shells is a terminal host');
  assert.equal(host.name, 'rolf');
  assert.equal(host.platform, 'linux');
  assert.deepEqual(host.shells.map((s) => s.id), ['bash', 'sh']);
  assert.equal(
    hosts.body.some((h) => h.manager_id === noPty.manager_agent_id),
    false,
    'a manager without PTY support is not listed — a row you cannot open is worse than no row',
  );
  const unsupported = await call(`${base}/api/terminals/hosts/${noPty.manager_agent_id}/terminals`, { headers: ownerHeaders });
  assert.equal(unsupported.status, 409);
  assert.equal(unsupported.body.error, 'terminal_unsupported');

  // 2. open — RPC 로 매니저가 terminal id 를 발급한다
  const openCall = call(`${base}/api/terminals/hosts/${managerId}/terminals`, {
    method: 'POST', headers: ownerHeaders,
    body: JSON.stringify({ shell: 'bash', cwd: '/home/parn/repo', title: 'build', cols: 120, rows: 40 }),
  });
  await rpcRespond((r) => r.op === 'open', {
    ok: true,
    result: {
      terminal_id: 'term-1111',
      terminal: { terminal_id: 'term-1111', shell: 'bash', shell_label: 'bash', cwd: '/home/parn/repo', title: 'build', cols: 120, rows: 40, pid: 7777, status: 'live' },
    },
  });
  const opened = await openCall;
  assert.equal(opened.status, 201, opened.text);
  assert.equal(opened.body.terminal_id, 'term-1111');
  assert.equal(opened.body.status, 'live');
  assert.equal(opened.body.pid, 7777);
  assert.equal(opened.body.driver_user_id, owner.id);
  const openReq = requests.find((r) => r.op === 'open');
  assert.equal(openReq.terminal_id, null);
  assert.equal(openReq.shell, 'bash');
  assert.equal(openReq.cols, 120);
  assert.equal(openReq.driver_user_id, owner.id);

  // 2b. 장비가 모르는 셸은 RPC 없이 400
  const before = requests.length;
  const badShell = await call(`${base}/api/terminals/hosts/${managerId}/terminals`, {
    method: 'POST', headers: ownerHeaders, body: JSON.stringify({ shell: 'fish' }),
  });
  assert.equal(badShell.status, 400);
  assert.equal(badShell.body.error, 'shell_unknown');
  assert.equal(requests.length, before, 'an unknown shell never reaches the Runtime Host');

  // 3. list — 매니저의 라이브 테이블이 원천. 죽은 행은 답에 실려도 목록에 넣지 않는다.
  const listCall = call(`${base}/api/terminals/hosts/${managerId}/terminals`, { headers: ownerHeaders });
  await rpcRespond((r) => r.op === 'list', {
    ok: true,
    result: { terminals: [
      { terminal_id: 'term-1111', shell: 'bash', shell_label: 'bash', cwd: '/home/parn/repo', title: 'build', cols: 120, rows: 40, pid: 7777, status: 'live', created_at: '2026-09-26T00:00:00.000Z' },
      { terminal_id: 'term-dead', shell: 'bash', shell_label: 'bash', cwd: '/tmp', title: '', status: 'exited', exit_code: 0, created_at: '2026-09-26T00:00:01.000Z' },
      { terminal_id: 'bad id with spaces', status: 'live' },
    ] },
  });
  const list = await listCall;
  assert.equal(list.status, 200, list.text);
  assert.deepEqual(
    list.body.map((tm) => tm.terminal_id),
    ['term-1111'],
    'only live terminals are listed; malformed ids are dropped',
  );

  // 4. attach — 스크롤백 스냅샷을 받고 driver 가 된다
  const attachCall = call(`${base}/api/terminals/hosts/${managerId}/terminals/term-1111?cols=100&rows=30`, { headers: ownerHeaders });
  await rpcRespond((r) => r.op === 'attach', {
    ok: true,
    result: {
      terminal: { terminal_id: 'term-1111', shell: 'bash', shell_label: 'bash', cwd: '/home/parn/repo', title: 'build', cols: 100, rows: 30, pid: 7777, status: 'live' },
      data: b64('$ echo hi\r\nhi\r\n'),
      seq: 12,
      truncated: false,
    },
  });
  const attached = await attachCall;
  assert.equal(attached.status, 200, attached.text);
  assert.equal(Buffer.from(attached.body.data, 'base64').toString('utf8'), '$ echo hi\r\nhi\r\n');
  assert.equal(attached.body.seq, 12);
  assert.equal(attached.body.terminal.cols, 100);
  const attachReq = requests.find((r) => r.op === 'attach');
  assert.equal(attachReq.cols, 100);
  assert.equal(attachReq.rows, 30);

  // 5. input / resize — fire-and-forget op
  const input = await call(`${base}/api/terminals/hosts/${managerId}/terminals/term-1111/input`, {
    method: 'POST', headers: ownerHeaders, body: JSON.stringify({ data: 'ls -la\r' }),
  });
  assert.equal(input.status, 202, input.text);
  assert.equal(requests.find((r) => r.op === 'input')?.data, 'ls -la\r');
  const resize = await call(`${base}/api/terminals/hosts/${managerId}/terminals/term-1111/resize`, {
    method: 'POST', headers: ownerHeaders, body: JSON.stringify({ cols: 90, rows: 25 }),
  });
  assert.equal(resize.status, 200, resize.text);
  assert.equal(resize.body.cols, 90);
  const resizeReq = requests.find((r) => r.op === 'resize');
  assert.equal(resizeReq.cols, 90);
  assert.equal(resizeReq.rows, 25);

  // 6. 출력 중계 — driver 의 SSE 로만 흐르고 서버는 저장하지 않는다
  const relay = await call(`${base}/api/agent/terminals/${managerId}/term-1111/output`, {
    method: 'POST', headers: managerHeaders,
    body: JSON.stringify({
      manager_id: managerId,
      chunks: [
        { seq: 13, data: b64('total 0\r\n'), created_at: new Date().toISOString() },
        { seq: 14, data: b64('$ '), created_at: new Date().toISOString() },
      ],
    }),
  });
  assert.equal(relay.status, 200, relay.text);
  assert.equal(relay.body.relayed, 2);
  await stream.waitFor('terminal_output', (d) => d?.terminal_id === 'term-1111' && d.chunk?.seq === 14, 4000);

  const foreignAgent = await createAgent(app, getDataSourceToken, ws.id, { name: 'foreign', type: 'claude' });
  const foreignKey = runtimeHostKeyForAgent(foreignAgent.id);
  const foreignRelay = await call(`${base}/api/agent/terminals/${managerId}/term-1111/output`, {
    method: 'POST', headers: { 'X-Agent-Key': foreignKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ manager_id: managerId, chunks: [] }),
  });
  assert.equal(foreignRelay.status, 403, 'another manager cannot relay into this host');

  // 7. 매니저 상태 패치 → driver 의 SSE
  const patch = await call(`${base}/api/agent/terminals/${managerId}/term-1111`, {
    method: 'PATCH', headers: managerHeaders,
    body: JSON.stringify({ manager_id: managerId, title: 'build (running)', reason: 'title' }),
  });
  assert.equal(patch.status, 200, patch.text);
  await stream.waitFor('terminal_update', (d) => d?.terminal?.terminal_id === 'term-1111' && d.terminal.title === 'build (running)', 4000);

  // 8. close → op + 상태 정리
  const close = await call(`${base}/api/terminals/hosts/${managerId}/terminals/term-1111/close`, { method: 'POST', headers: ownerHeaders });
  assert.equal(close.status, 200, close.text);
  assert.equal(close.body.status, 'exited');
  assert.ok(requests.some((r) => r.op === 'close' && r.terminal_id === 'term-1111'));
  const writeDead = await call(`${base}/api/terminals/hosts/${managerId}/terminals/term-1111/input`, {
    method: 'POST', headers: ownerHeaders, body: JSON.stringify({ data: 'x' }),
  });
  assert.equal(writeDead.status, 409);
  assert.equal(writeDead.body.error, 'terminal_closed');

  stream.close();
});

// ─── 하트비트가 유령 행을 정리한다 ──────────────────────────────────────────
// 매니저가 재시작하거나 PTY 가 죽으면 마지막 상태 패치가 오지 못한다. 터미널은
// 살아 있는 것만 존재하므로, 하트비트에 없는 행은 그 자리에서 exited 다.
test('terminals: a live row the heartbeat no longer reports is retired', async (t) => {
  const { app, port, modules } = await bootApp({ port: parseInt(process.env.PORT, 10) });
  t.after(async () => { await closeTestApp(app); });
  const { getDataSourceToken, AuthService, activityEvents } = modules;
  const base = `http://localhost:${port}`;

  const ws = await createWorkspace(app, getDataSourceToken, 'terminals-ghost');
  const owner = await createUser(app, getDataSourceToken, { name: 'owner', role: 'admin' });
  const ownerToken = app.get(AuthService).createSession(owner.id);
  const ownerHeaders = { Authorization: `Bearer ${ownerToken}`, 'X-Workspace-Id': ws.id, 'Content-Type': 'application/json' };

  const agent = await createAgent(app, getDataSourceToken, ws.id, { name: 'coder', type: 'claude' });
  const managerId = agent.manager_agent_id;
  const managerHeaders = { 'X-Agent-Key': runtimeHostKeyForAgent(agent.id), 'Content-Type': 'application/json' };
  const beat = (terminals) => call(`${base}/api/agent/instance-heartbeat`, {
    method: 'POST', headers: managerHeaders,
    body: JSON.stringify({
      instance_id: 'inst-1', agent_id: managerId, mode: 'manager', hostname: 'rolf', plugin_version: 'test',
      cli: 'claude', cli_adapters: ['claude'], pid: 1, started_at: new Date().toISOString(),
      terminal_shells: [{ id: 'bash', label: 'bash', path: '/bin/bash', default: true }],
      terminals,
    }),
  });
  await beat([]);

  const requests = [];
  const onRequest = (payload) => requests.push(payload);
  activityEvents.on('terminal_request', onRequest);
  t.after(() => activityEvents.removeListener('terminal_request', onRequest));

  // 매니저가 먼저 출력을 보내 서버 메모리에 행이 생기게 한다(서버 재시작 뒤 상황).
  await call(`${base}/api/agent/terminals/${managerId}/term-ghost/output`, {
    method: 'POST', headers: managerHeaders,
    body: JSON.stringify({ manager_id: managerId, chunks: [{ seq: 1, data: Buffer.from('hi').toString('base64') }], state: { status: 'live' } }),
  });

  const listOnce = async (reported) => {
    // 이전 회차의 list 요청이 배열에 남아 있으므로 **개수 증가**를 기다린다 — 존재만 보면
    // 방금 보낸 요청 대신 이미 풀린 옛 요청을 집어 새 요청이 타임아웃난다.
    const seen = requests.filter((r) => r.op === 'list').length;
    const p = call(`${base}/api/terminals/hosts/${managerId}/terminals`, { headers: ownerHeaders });
    await waitFor(() => requests.filter((r) => r.op === 'list').length > seen, 'list rpc');
    const req = requests.filter((r) => r.op === 'list').pop();
    await call(`${base}/api/agent/terminals/rpc/${req.request_id}`, {
      method: 'POST', headers: managerHeaders, body: JSON.stringify({ manager_id: managerId, ok: true, result: { terminals: reported } }),
    });
    return p;
  };

  const withGhost = await listOnce([{ terminal_id: 'term-ghost', shell: 'bash', shell_label: 'bash', cwd: '/tmp', status: 'live', created_at: '2026-09-26T00:00:00.000Z' }]);
  assert.deepEqual(withGhost.body.map((t2) => t2.terminal_id), ['term-ghost']);

  // 하트비트가 "살아 있는 터미널 없음" 이라고 하면 그 행은 사라진다.
  await beat([]);
  const afterBeat = await listOnce([]);
  assert.equal(afterBeat.status, 200, afterBeat.text);
  assert.deepEqual(afterBeat.body, [], 'the manager is the only source of truth for existence');
});
