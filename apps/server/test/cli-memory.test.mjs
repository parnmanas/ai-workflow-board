// CLI Memory 서버 contract — docs/cli-memory.md.
//
// 서버는 상태 없는 중계자다. 가짜 Runtime Host(매니저 키 + 하트비트)를 세우고 고정한다:
//   1. hosts — `cli_memory.use` 는 기본 admin 전용이고, `manager_capabilities` 에 `cli_memory` 가 없는
//      매니저는 `supported: false`(열면 409 memory_unsupported).
//   2. snapshot — project 범위 파일을 찾을 폴더는 **서버가** 정한다(그 장비에 등록된, 사용자가 접근할 수
//      있는 프로젝트 폴더). 세션 홈의 credential id 에는 credential 이름이 붙는다.
//   3. write — base_hash 형식 검사는 RPC 전에, 매니저의 conflict 는 409 + 현재 해시로 돌아온다.
//   4. 다른 매니저 키는 남의 RPC 를 풀 수 없다.
//   5. batch — op 검사와 결과 전달.
//
// 실행: node --test --test-force-exit test/cli-memory.test.mjs (dist 필요)

import test from 'node:test';
import assert from 'node:assert/strict';
import { bootApp, closeTestApp } from './helpers/boot.mjs';
import { createAgent, createUser, createAccount, runtimeHostKeyForAgent } from './helpers/fixtures.mjs';

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

test('cli memory relay: hosts → snapshot(project dirs, credential names) → write/conflict → batch → ownership', async (t) => {
  const { app, port, modules } = await bootApp({ port: parseInt(process.env.PORT, 10) });
  t.after(async () => { await closeTestApp(app); });
  const { getDataSourceToken, AuthService, activityEvents } = modules;
  const ds = app.get(getDataSourceToken());
  const base = `http://localhost:${port}`;

  const ws = await createAccount(app, getDataSourceToken, 'memory');
  const owner = await createUser(app, getDataSourceToken, { name: 'owner', role: 'admin' });
  const plainUser = await createUser(app, getDataSourceToken, { name: 'plain', role: 'user' });
  const ownerToken = app.get(AuthService).createSession(owner.id);
  const plainToken = app.get(AuthService).createSession(plainUser.id);
  const ownerHeaders = { Authorization: `Bearer ${ownerToken}`, 'X-Account-Id': ws.id, 'Content-Type': 'application/json' };

  const agent = await createAgent(app, getDataSourceToken, ws.id, { name: 'coder', type: 'claude' });
  const managerId = agent.manager_agent_id;
  const managerKey = runtimeHostKeyForAgent(agent.id);
  await ds.getRepository('RuntimeHost').update({ id: managerId }, { name: 'rolf' });
  const managerHeaders = { 'X-Agent-Key': managerKey, 'Content-Type': 'application/json' };
  const heartbeat = (key, id, hostname, capabilities) => call(`${base}/api/agent/instance-heartbeat`, {
    method: 'POST', headers: { 'X-Agent-Key': key, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      instance_id: `inst-${hostname}`, agent_id: id, host_id: id, mode: 'manager', hostname, plugin_version: 'test',
      cli: 'claude', cli_adapters: ['claude'], pid: 1, started_at: new Date().toISOString(), platform: 'linux',
      ...(capabilities ? { manager_capabilities: capabilities } : {}),
    }),
  });
  const hb = await heartbeat(managerKey, managerId, 'rolf', ['cli_memory']);
  assert.ok(hb.status < 300, hb.text);

  // 메모리를 모르는 구버전 매니저.
  const old = await createAgent(app, getDataSourceToken, ws.id, { name: 'old', type: 'claude' });
  await heartbeat(runtimeHostKeyForAgent(old.id), old.manager_agent_id, 'ralf', null);

  // 이 장비에 폴더가 있는 프로젝트 + 다른 계정의 프로젝트(일반 사용자는 못 본다) + 세션 홈 credential.
  const project = await ds.getRepository('Project').save({ account_id: ws.id, name: 'awb' });
  await ds.getRepository('ProjectHostFolder').save({ project_id: project.id, host_id: managerId, path: '/repo/awb' });
  const credential = await ds.getRepository('Credential').save({ account_id: ws.id, name: 'Team Max', provider: 'claude_subscription', encrypted_data: 'x' });

  const requests = [];
  const onRequest = (payload) => requests.push(payload);
  activityEvents.on('cli_memory_request', onRequest);
  t.after(() => activityEvents.removeListener('cli_memory_request', onRequest));
  const respond = async (op, body, headers = managerHeaders, manager = managerId) => {
    await waitFor(() => requests.some((r) => r.op === op && !r.answered), `${op} rpc`);
    const req = requests.find((r) => r.op === op && !r.answered);
    req.answered = true;
    return call(`${base}/api/agent/cli-memory/rpc/${req.request_id}`, {
      method: 'POST', headers, body: JSON.stringify({ manager_id: manager, ...body }),
    });
  };

  // 1. hosts
  const forbidden = await call(`${base}/api/cli-memory/hosts`, { headers: { ...ownerHeaders, Authorization: `Bearer ${plainToken}` } });
  assert.equal(forbidden.status, 403, 'cli_memory.use is admin-only by default');
  const hosts = await call(`${base}/api/cli-memory/hosts`, { headers: ownerHeaders });
  assert.equal(hosts.status, 200, hosts.text);
  const rolf = hosts.body.find((h) => h.manager_id === managerId);
  assert.equal(rolf.supported, true);
  assert.equal(rolf.name, 'rolf');
  assert.equal(rolf.project_count, 1);
  assert.equal(hosts.body.find((h) => h.manager_id === old.manager_agent_id).supported, false, 'an old manager is listed but not openable');
  const unsupported = await call(`${base}/api/cli-memory/hosts/${old.manager_agent_id}/snapshot`, { headers: ownerHeaders });
  assert.equal(unsupported.status, 409);
  assert.equal(unsupported.body.error, 'memory_unsupported');

  // 2. snapshot — 프로젝트 폴더는 서버가 싣고, credential 이름이 붙는다.
  const snapCall = call(`${base}/api/cli-memory/hosts/${managerId}/snapshot?check_paths=1`, { headers: ownerHeaders });
  const ack = await respond('scan', {
    ok: true,
    result: {
      platform: 'linux',
      content_budget_exhausted: false,
      clis: [{
        cli: 'claude', label: 'Claude Code', summary: 's', detected: true, settings: {}, dirs: [], files: [],
        homes: [
          { id: 'operator', kind: 'operator', path: '/home/u/.claude', display_path: '~/.claude', credential_id: null, profile: null, exists: true },
          { id: `session:${credential.id}`, kind: 'session', path: `/x/${credential.id}`, display_path: '', credential_id: credential.id, profile: null, exists: true },
        ],
      }],
    },
  });
  assert.equal(ack.status, 200, ack.text);
  const snap = await snapCall;
  assert.equal(snap.status, 200, snap.text);
  const scanReq = requests.find((r) => r.op === 'scan');
  assert.deepEqual(scanReq.project_dirs, ['/repo/awb']);
  assert.equal(scanReq.check_paths, true);
  assert.deepEqual(snap.body.project_dirs, [{ path: '/repo/awb', project_id: project.id, project_name: 'awb' }]);
  assert.equal(snap.body.manager_name, 'rolf');
  assert.equal(snap.body.clis[0].homes[1].credential_name, 'Team Max');

  // 3. write — 형식 검사는 RPC 전에.
  const before = requests.length;
  const badHash = await call(`${base}/api/cli-memory/hosts/${managerId}/file`, {
    method: 'PUT', headers: ownerHeaders, body: JSON.stringify({ cli: 'claude', path: '/home/u/.claude/CLAUDE.md', content: 'x', base_hash: 'nope' }),
  });
  assert.equal(badHash.status, 400);
  assert.equal(badHash.body.error, 'base_hash_invalid');
  const badCli = await call(`${base}/api/cli-memory/hosts/${managerId}/file`, {
    method: 'PUT', headers: ownerHeaders, body: JSON.stringify({ cli: '../x', path: '/a', content: 'x' }),
  });
  assert.equal(badCli.status, 400);
  assert.equal(requests.length, before, 'invalid input never reaches the Runtime Host');

  const writeCall = call(`${base}/api/cli-memory/hosts/${managerId}/file`, {
    method: 'PUT', headers: ownerHeaders, body: JSON.stringify({ cli: 'claude', path: '/home/u/.claude/CLAUDE.md', content: 'new', base_hash: '0123456789abcdef' }),
  });
  // 다른 매니저 키로는 풀 수 없다.
  await waitFor(() => requests.some((r) => r.op === 'write'), 'write rpc');
  const writeReq = requests.find((r) => r.op === 'write');
  const stolen = await call(`${base}/api/agent/cli-memory/rpc/${writeReq.request_id}`, {
    method: 'POST', headers: { 'X-Agent-Key': runtimeHostKeyForAgent(old.id), 'Content-Type': 'application/json' },
    body: JSON.stringify({ manager_id: old.manager_agent_id, ok: true, result: { file: {} } }),
  });
  assert.equal(stolen.status, 404, 'a different Runtime Host cannot answer this RPC');
  assert.equal(writeReq.base_hash, '0123456789abcdef');
  assert.deepEqual(writeReq.project_dirs, ['/repo/awb'], 'every write carries the server-chosen project folders');
  await respond('write', { ok: false, code: 'conflict', error: 'changed on the host', result: { current_hash: 'fedcba9876543210' } });
  const conflict = await writeCall;
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.error, 'conflict');
  assert.equal(conflict.body.detail.current_hash, 'fedcba9876543210');

  // 경로 거부는 403 으로.
  const deniedCall = call(`${base}/api/cli-memory/hosts/${managerId}/file`, {
    method: 'PUT', headers: ownerHeaders, body: JSON.stringify({ cli: 'claude', path: '/etc/passwd', content: 'x' }),
  });
  await respond('write', { ok: false, code: 'path_not_allowed', error: 'not a memory location' });
  assert.equal((await deniedCall).status, 403);

  // 4. batch
  const badBatch = await call(`${base}/api/cli-memory/hosts/${managerId}/batch`, {
    method: 'POST', headers: ownerHeaders, body: JSON.stringify({ ops: [{ op: 'chmod', cli: 'claude', path: '/a' }] }),
  });
  assert.equal(badBatch.status, 400);
  const batchCall = call(`${base}/api/cli-memory/hosts/${managerId}/batch`, {
    method: 'POST', headers: ownerHeaders,
    body: JSON.stringify({ ops: [
      { op: 'write', cli: 'codex', path: '/home/u/.codex/AGENTS.md', content: 'x', base_hash: null, reason: 'import' },
      { op: 'link', cli: 'claude', path: '/x/CLAUDE.md', target: '/home/u/.claude/CLAUDE.md' },
    ] }),
  });
  await respond('batch', { ok: true, result: { results: [{ ok: true, op: 'write', path: '/home/u/.codex/AGENTS.md' }, { ok: false, op: 'link', path: '/x/CLAUDE.md', code: 'link_invalid', error: 'no' }] } });
  const batch = await batchCall;
  assert.equal(batch.status, 200, batch.text);
  assert.deepEqual(batch.body.results.map((r) => r.ok), [true, false]);
  const batchReq = requests.find((r) => r.op === 'batch');
  assert.equal(batchReq.ops[0].base_hash, null, 'null (must not exist) survives the relay');
  assert.equal(batchReq.ops[0].reason, 'import');
  assert.equal(batchReq.ops[1].target, '/home/u/.claude/CLAUDE.md');

  // history 는 매니저의 버전 목록을 그대로 돌려준다.
  const histCall = call(`${base}/api/cli-memory/hosts/${managerId}/history?cli=claude&path=${encodeURIComponent('/home/u/.claude/CLAUDE.md')}`, { headers: ownerHeaders });
  const hist = await respond('history', { ok: true, result: { versions: [{ version_id: '1760000000000-abcdef01', created_at: 'x', size: 1, hash: 'h', reason: 'write' }] } });
  assert.equal(hist.status, 200);
  assert.equal((await histCall).body.length, 1);
});
