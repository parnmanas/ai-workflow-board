// Agent Session(CLI 직접 세션) 서버 계약 — docs/agent-sessions.md.
//
// 사용자 표면(/api/agent-sessions)과 agent-manager 표면(/api/agent/sessions)을
// 실제 앱 부팅으로 왕복하며 다음을 고정한다:
//   1. create → `agent_session_request{op:'open'}` 이 emit 되고 소유자 SSE 에
//      `agent_session_update{reason:'created'}` 가 도착한다.
//   2. prompt → user_prompt 행(seq 1) + `agent_session_request{op:'prompt'}`(turn_id/text/cwd 동반),
//      진행 중이면 두 번째 prompt 는 409.
//   3. 매니저가 X-Agent-Key 로 이벤트 배치 + patch 를 append 하면 seq 가 이어 붙고
//      소유자 SSE 에 `agent_session_event` / `agent_session_update` 가 흐른다.
//   4. permission 결정은 request 로 릴레이되고 중복 결정은 409.
//   5. 소유자가 아니면 404, 세션 agent 도 그 Runtime Host 도 아닌 키는 403,
//      Runtime Host(manager) 키는 200.
//   6. close 뒤 prompt 는 409, delete 뒤 GET 은 404.
//   7. ACP 어댑터가 없는 타입(custom/antigravity)은 409 runtime_unsupported,
//      runtime_config.extra.acp_command 가 있으면 열린다.
//
// 실행: node --test --test-force-exit test/agent-sessions.test.mjs (dist 필요)

import test from 'node:test';
import assert from 'node:assert/strict';
import { bootApp, closeTestApp } from './helpers/boot.mjs';
import { createAgent, createApiKey, createUser, createWorkspace, runtimeHostKeyForAgent } from './helpers/fixtures.mjs';
import { openSseStream } from './helpers/sse-listener.mjs';

process.env.PORT = process.env.TEST_SERVER_PORT || '0';
// 키 경계(403/200) 단언이 의미를 가지려면 AgentAuthGuard 가 실제로 키를 검증해야 한다.
// bootApp 은 AGENT_DEV_MODE 를 'true' 로 기본 설정하므로 부팅 전에 끈다.
process.env.AGENT_DEV_MODE = 'false';

/** 응답 본문을 한 번만 읽어 { status, body, text } 로 돌려준다 — assert 메시지에
 *  `res.text` 를 넣으면 본문이 소비돼 이후 json() 이 터진다. */
async function call(url, init) {
  const res = await fetch(url, init);
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = null; }
  return { status: res.status, body, text };
}

test('agent session lifecycle: create → prompt → manager stream → permission → close → delete', async (t) => {
  const { app, port, modules } = await bootApp({ port: parseInt(process.env.PORT, 10) });
  t.after(async () => { await closeTestApp(app); });
  const { getDataSourceToken, AuthService, activityEvents } = modules;
  const base = `http://localhost:${port}`;

  const ws = await createWorkspace(app, getDataSourceToken, 'agent-sessions');
  const owner = await createUser(app, getDataSourceToken, { name: 'owner', role: 'user' });
  const stranger = await createUser(app, getDataSourceToken, { name: 'stranger', role: 'user' });
  const ownerToken = app.get(AuthService).createSession(owner.id);
  const strangerToken = app.get(AuthService).createSession(stranger.id);
  const agent = await createAgent(app, getDataSourceToken, ws.id, { name: 'coder', type: 'claude' });
  const agentKey = await createApiKey(app, getDataSourceToken, agent.id, { workspaceId: ws.id, label: 'session-agent' });
  const ownerHeaders = { Authorization: `Bearer ${ownerToken}`, 'X-Workspace-Id': ws.id, 'Content-Type': 'application/json' };
  const agentHeaders = { 'X-Agent-Key': agentKey.raw_key, 'Content-Type': 'application/json' };

  const requests = [];
  const onRequest = (payload) => requests.push(payload);
  activityEvents.on('agent_session_request', onRequest);
  t.after(() => activityEvents.removeListener('agent_session_request', onRequest));

  // SSE 스트림은 앱보다 먼저 닫는다 — 열린 keep-alive 연결이 app.close() 를 수 초간 붙든다.
  const stream = await openSseStream(port, ownerToken, {});
  t.after(() => stream.close());

  // 1. 후보 에이전트 + 생성
  const agentsRes = await call(`${base}/api/agent-sessions/agents`, { headers: ownerHeaders });
  assert.equal(agentsRes.status, 200);
  const option = agentsRes.body.find((a) => a.id === agent.id);
  assert.ok(option, 'agent appears in the session picker');
  assert.equal(option.supported, true);
  assert.equal(option.type, 'claude');

  const createRes = await call(`${base}/api/agent-sessions`, {
    method: 'POST', headers: ownerHeaders,
    body: JSON.stringify({ agent_id: agent.id, cwd: '/tmp/work', permission_policy: 'ask' }),
  });
  assert.equal(createRes.status, 201, createRes.text);
  const session = createRes.body;
  assert.equal(session.status, 'starting');
  assert.equal(session.runtime, 'claude');
  assert.equal(session.cwd, '/tmp/work');
  assert.equal(session.owner_user_id, owner.id);
  assert.equal(requests.at(-1)?.op, 'open');
  assert.equal(requests.at(-1)?.agent_id, agent.id);
  await stream.waitFor('agent_session_update', (d) => d?.session?.id === session.id && d.reason === 'created', 4000);

  // 5a. 소유자 격리 — 남의 세션은 존재 자체가 404
  const strangerRes = await call(`${base}/api/agent-sessions/${session.id}`, {
    headers: { ...ownerHeaders, Authorization: `Bearer ${strangerToken}` },
  });
  assert.equal(strangerRes.status, 404);

  // 2. prompt
  const promptRes = await call(`${base}/api/agent-sessions/${session.id}/prompt`, {
    method: 'POST', headers: ownerHeaders, body: JSON.stringify({ text: 'run the tests' }),
  });
  assert.equal(promptRes.status, 202, promptRes.text);
  const promptBody = promptRes.body;
  assert.equal(promptBody.session.status, 'busy');
  assert.equal(promptBody.session.title, 'run the tests', 'first prompt excerpt becomes the title');
  const promptReq = requests.at(-1);
  assert.equal(promptReq.op, 'prompt');
  assert.equal(promptReq.text, 'run the tests');
  assert.equal(promptReq.turn_id, promptBody.turn_id);
  assert.equal(promptReq.cwd, '/tmp/work');
  assert.equal(promptReq.runtime, 'claude');
  const promptFrame = await stream.waitFor('agent_session_event', (d) => d?.session_id === session.id && d.event?.type === 'user_prompt', 4000);
  assert.equal(promptFrame.data.event.seq, 1);
  assert.equal(promptFrame.data.event.payload.text, 'run the tests');

  const busyRes = await call(`${base}/api/agent-sessions/${session.id}/prompt`, {
    method: 'POST', headers: ownerHeaders, body: JSON.stringify({ text: 'again' }),
  });
  assert.equal(busyRes.status, 409);
  assert.equal(busyRes.body.error, 'session_busy');

  // 3. 매니저 스트림 append + patch
  const turnId = promptBody.turn_id;
  const appendRes = await call(`${base}/api/agent/sessions/${session.id}/events`, {
    method: 'POST', headers: agentHeaders,
    body: JSON.stringify({
      events: [
        { type: 'turn', payload: { phase: 'started' }, turn_id: turnId },
        { type: 'text', payload: { text: 'Running' }, turn_id: turnId },
        { type: 'tool_call', payload: { tool_call_id: 't1', title: 'Bash', kind: 'execute', input: { cmd: 'npm test' } }, turn_id: turnId },
        {
          type: 'permission_request',
          payload: {
            request_id: 'perm-1', tool_call_id: 't1', title: 'Run npm test', kind: 'execute',
            options: [{ option_id: 'allow', name: 'Allow', kind: 'allow_once' }, { option_id: 'deny', name: 'Deny', kind: 'reject_once' }],
          },
          turn_id: turnId,
        },
      ],
      patch: {
        status: 'awaiting_permission', native_session_id: 'acp-1', resume_supported: true,
        available_modes: [{ id: 'default', name: 'Default' }, { id: 'acceptEdits', name: 'Accept edits' }],
        current_mode: 'default', reason: 'permission',
      },
    }),
  });
  assert.equal(appendRes.status, 200, appendRes.text);
  const appended = appendRes.body;
  assert.deepEqual(appended.events.map((e) => e.seq), [2, 3, 4, 5]);
  assert.equal(appended.session.status, 'awaiting_permission');
  assert.equal(appended.session.native_session_id, 'acp-1');
  assert.equal(appended.session.resume_supported, true);
  assert.deepEqual(appended.session.available_modes.map((m) => m.id), ['default', 'acceptEdits']);
  await stream.waitFor('agent_session_event', (d) => d?.session_id === session.id && d.event?.type === 'permission_request' && d.event.payload.request_id === 'perm-1', 4000);
  await stream.waitFor('agent_session_update', (d) => d?.session?.id === session.id && d.session.status === 'awaiting_permission', 4000);

  const badTypeRes = await call(`${base}/api/agent/sessions/${session.id}/events`, {
    method: 'POST', headers: agentHeaders, body: JSON.stringify({ events: [{ type: 'bogus', payload: {} }] }),
  });
  assert.equal(badTypeRes.status, 400);
  const reservedRes = await call(`${base}/api/agent/sessions/${session.id}/events`, {
    method: 'POST', headers: agentHeaders, body: JSON.stringify({ events: [{ type: 'user_prompt', payload: { text: 'x' } }] }),
  });
  assert.equal(reservedRes.status, 400);

  const listEvRes = await call(`${base}/api/agent-sessions/${session.id}/events?after_seq=0`, { headers: ownerHeaders });
  assert.equal(listEvRes.status, 200);
  const evs = listEvRes.body;
  assert.deepEqual(evs.map((e) => e.type), ['user_prompt', 'turn', 'text', 'tool_call', 'permission_request']);
  assert.deepEqual(evs.map((e) => e.seq), [1, 2, 3, 4, 5]);
  assert.equal(evs[3].payload.input.cmd, 'npm test');
  const afterRes = await call(`${base}/api/agent-sessions/${session.id}/events?after_seq=3`, { headers: ownerHeaders });
  assert.deepEqual(afterRes.body.map((e) => e.seq), [4, 5]);

  // 4. permission 결정
  const permRes = await call(`${base}/api/agent-sessions/${session.id}/permission`, {
    method: 'POST', headers: ownerHeaders, body: JSON.stringify({ request_id: 'perm-1', option_id: 'allow' }),
  });
  assert.equal(permRes.status, 200, permRes.text);
  const permReq = requests.at(-1);
  assert.equal(permReq.op, 'permission');
  assert.equal(permReq.request_id, 'perm-1');
  assert.equal(permReq.option_id, 'allow');
  assert.equal(permReq.native_session_id, 'acp-1', 'request carries the ACP session id the manager patched in');
  await stream.waitFor('agent_session_event', (d) => d?.session_id === session.id && d.event?.type === 'permission_decision' && d.event.payload.option_id === 'allow', 4000);
  const permAgain = await call(`${base}/api/agent-sessions/${session.id}/permission`, {
    method: 'POST', headers: ownerHeaders, body: JSON.stringify({ request_id: 'perm-1', option_id: 'deny' }),
  });
  assert.equal(permAgain.status, 409);

  const finishRes = await call(`${base}/api/agent/sessions/${session.id}/events`, {
    method: 'POST', headers: agentHeaders,
    body: JSON.stringify({
      events: [
        { type: 'tool_update', payload: { tool_call_id: 't1', status: 'completed', output: 'ok' }, turn_id: turnId },
        { type: 'text', payload: { text: ' done' }, turn_id: turnId },
        { type: 'usage', payload: { input_tokens: 10, output_tokens: 5, total_tokens: 15 }, turn_id: turnId },
        { type: 'turn', payload: { phase: 'finished', stop_reason: 'end_turn' }, turn_id: turnId },
      ],
      patch: { status: 'ready', reason: 'turn_finished' },
    }),
  });
  assert.equal(finishRes.status, 200);
  await stream.waitFor('agent_session_update', (d) => d?.session?.id === session.id && d.session.status === 'ready', 4000);

  const listRes = await call(`${base}/api/agent-sessions`, { headers: ownerHeaders });
  assert.equal(listRes.status, 200);
  const sessions = listRes.body;
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].id, session.id);
  assert.equal(sessions[0].last_event_seq, 10);
  assert.equal(sessions[0].agent_name.includes('/'), true, 'agent_name follows the <Manager>/<Agent> contract');

  // 5b. 키 경계 — 무관한 agent 키는 403, Runtime Host 키는 200
  const intruder = await createAgent(app, getDataSourceToken, ws.id, { name: 'intruder', type: 'claude' });
  const intruderKey = await createApiKey(app, getDataSourceToken, intruder.id, { workspaceId: ws.id, label: 'intruder' });
  const intruderRes = await call(`${base}/api/agent/sessions/${session.id}/events`, {
    method: 'POST', headers: { 'X-Agent-Key': intruderKey.raw_key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ events: [{ type: 'system', payload: { text: 'nope' } }] }),
  });
  assert.equal(intruderRes.status, 403);
  const hostKey = runtimeHostKeyForAgent(agent.id);
  assert.ok(hostKey, 'fixture minted a Runtime Host key');
  const hostRes = await call(`${base}/api/agent/sessions/${session.id}`, {
    method: 'PATCH', headers: { 'X-Agent-Key': hostKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'suspended', reason: 'idle_reap' }),
  });
  assert.equal(hostRes.status, 200, hostRes.text);
  assert.equal(hostRes.body.session.status, 'suspended');

  // rename
  const renameRes = await call(`${base}/api/agent-sessions/${session.id}`, {
    method: 'PATCH', headers: ownerHeaders, body: JSON.stringify({ title: 'Test run' }),
  });
  assert.equal(renameRes.status, 200);
  assert.equal(renameRes.body.title, 'Test run');

  // 6. close → prompt 409 → delete → 404
  const closeRes = await call(`${base}/api/agent-sessions/${session.id}/close`, { method: 'POST', headers: ownerHeaders });
  assert.equal(closeRes.status, 200);
  assert.equal(closeRes.body.status, 'closed');
  assert.equal(requests.at(-1)?.op, 'close');
  const closedPrompt = await call(`${base}/api/agent-sessions/${session.id}/prompt`, {
    method: 'POST', headers: ownerHeaders, body: JSON.stringify({ text: 'still there?' }),
  });
  assert.equal(closedPrompt.status, 409);
  assert.equal(closedPrompt.body.error, 'session_closed');
  const delRes = await call(`${base}/api/agent-sessions/${session.id}`, { method: 'DELETE', headers: ownerHeaders });
  assert.equal(delRes.status, 200);
  assert.equal(delRes.body.ok, true);
  const goneRes = await call(`${base}/api/agent-sessions/${session.id}`, { headers: ownerHeaders });
  assert.equal(goneRes.status, 404);
  stream.close();
});

test('agent session create refuses agents without an ACP adapter unless runtime_config.extra.acp_command is set', async (t) => {
  const { app, port, modules } = await bootApp({ port: parseInt(process.env.PORT, 10) });
  t.after(async () => { await closeTestApp(app); });
  const { getDataSourceToken, AuthService } = modules;
  const base = `http://localhost:${port}`;
  const ds = app.get(getDataSourceToken());

  const ws = await createWorkspace(app, getDataSourceToken, 'agent-sessions-runtime');
  const owner = await createUser(app, getDataSourceToken, { name: 'owner' });
  const headers = { Authorization: `Bearer ${app.get(AuthService).createSession(owner.id)}`, 'X-Workspace-Id': ws.id, 'Content-Type': 'application/json' };

  const custom = await createAgent(app, getDataSourceToken, ws.id, { name: 'custom', type: 'custom' });
  const antigravity = await createAgent(app, getDataSourceToken, ws.id, { name: 'agy', type: 'antigravity' });
  for (const a of [custom, antigravity]) {
    const res = await call(`${base}/api/agent-sessions`, { method: 'POST', headers, body: JSON.stringify({ agent_id: a.id }) });
    assert.equal(res.status, 409);
    assert.equal(res.body.error, 'runtime_unsupported');
  }

  const picker = (await call(`${base}/api/agent-sessions/agents`, { headers })).body;
  assert.equal(picker.find((a) => a.id === custom.id)?.supported, false);
  assert.equal(picker.find((a) => a.id === custom.id)?.reason, 'no_acp_adapter');

  // explicit ACP command override unlocks the runtime
  const repo = ds.getRepository('Agent');
  await repo.update({ id: custom.id }, { runtime_config: { strategy: 'single', permission_mode: 'strict', extra: { acp_command: '/opt/acp/my-agent' } } });
  const okRes = await call(`${base}/api/agent-sessions`, { method: 'POST', headers, body: JSON.stringify({ agent_id: custom.id }) });
  assert.equal(okRes.status, 201, okRes.text);
  assert.equal(okRes.body.runtime, 'custom');

  // hosted:false → Runtime Host 없음 → 409
  const orphan = await createAgent(app, getDataSourceToken, ws.id, { name: 'orphan', type: 'claude', hosted: false });
  const orphanRes = await call(`${base}/api/agent-sessions`, { method: 'POST', headers, body: JSON.stringify({ agent_id: orphan.id }) });
  assert.equal(orphanRes.status, 409);
  assert.equal(orphanRes.body.error, 'agent_has_no_runtime_host');
});
