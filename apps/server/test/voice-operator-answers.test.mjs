// 말로 답하기 — docs/voice-operator.md "말로 답하기".
//
// 세션이 승인·질문을 기다리면 AWB 가 operator 에게 보고하고(선택지와 답을 전할 도구 호출을 싣는다), 사용자가
// 말로 고르면 operator 가 MCP 도구로 그 세션에 답을 전한다. 실제 앱을 띄워 가짜 Runtime Host 로 고정한다:
//   1. 보고 프롬프트에 번호 붙은 선택지와 answer_session_permission 호출 값(요청 id · option id)이 실린다.
//   2. operator 는 미결 요청을 볼 수 있다(list_pending_session_requests) — 자기 자신은 빼고.
//   3. 보고 턴(사람이 말하지 않은 턴)에서는 답을 전하지 못한다. 사용자가 시작한 턴에서는 전한다 → 매니저로
//      `op:'permission'` 이 그 선택지로 나간다. 같은 요청에 두 번은 못 답한다.
//   4. operator 가 아닌 연결, 그 요청에 없는 선택지, 다른 사람의 세션은 거절한다.
//   5. 질문(form): 정해진 값만 받고, 맞으면 `op:'elicitation'` 으로 답이 나간다.
//   6. operator 의 요약은 SSE `voice_announcement` 로 operator 이름과 "결정 필요" 표시를 싣고 간다(화면이 다 읽은
//      뒤 이름 없이 답을 듣는 창을 연다).
//   7. AWB 에서 새로 만든 operator 세션의 MCP 연결은 세션 id 대신 매니저가 정한 참조값(`pending-…`)을 보낸다 —
//      하트비트가 그 대응을 알려 주기 전에는 이유와 함께 거절하고, 알려 준 뒤에는 operator 로 알아본다(실측: 운영의
//      operator 가 'new' 로 붙어 도구를 못 썼다).
//
//
// 실행: node --test --test-force-exit test/voice-operator-answers.test.mjs (dist 필요)

import test from 'node:test';
import assert from 'node:assert/strict';
import { bootApp, closeTestApp } from './helpers/boot.mjs';
import { createAgent, createUser, createAccount, runtimeHostKeyForAgent } from './helpers/fixtures.mjs';
import { McpClient } from './helpers/mcp-client.mjs';
import { openSseStream } from './helpers/sse-listener.mjs';

process.env.PORT = process.env.TEST_SERVER_PORT || '0';

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
    const value = predicate();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 15));
  }
  throw new Error(`timeout waiting for ${label}`);
}

test('a spoken choice reaches the waiting session only from a turn the user started', async (t) => {
  const { app, port, modules } = await bootApp({ port: parseInt(process.env.PORT, 10) });
  t.after(async () => { await closeTestApp(app); });
  const { getDataSourceToken, AuthService, activityEvents } = modules;
  const base = `http://localhost:${port}`;

  const ws = await createAccount(app, getDataSourceToken, 'voice-answers');
  const admin = await createUser(app, getDataSourceToken, { name: 'admin', role: 'admin' });
  const other = await createUser(app, getDataSourceToken, { name: 'other-admin', role: 'admin' });
  const headersFor = (user) => ({
    Authorization: `Bearer ${app.get(AuthService).createSession(user.id)}`, 'X-Account-Id': ws.id, 'Content-Type': 'application/json',
  });
  const userHeaders = headersFor(admin);
  // 소리를 낼 수 있어야 요약이 알림으로 간다(엔진에 닿을 필요는 없다 — 소리는 화면이 요청할 때 합성한다).
  const configured = await call(`${base}/api/admin/settings`, {
    method: 'PATCH', headers: userHeaders,
    body: JSON.stringify({ settings: { 'voice.tts.provider': 'openai', 'voice.openai.api_key': 'sk-test', 'voice.tts.voice': 'alloy' } }),
  });
  assert.equal(configured.status, 200, configured.text);
  const stream = await openSseStream(port, app.get(AuthService).createSession(admin.id), {});
  t.after(() => stream.close());

  // 가짜 Runtime Host — Claude(operator)와 Codex(일하는 세션) ACP 세션을 돌릴 수 있다.
  const host = await createAgent(app, getDataSourceToken, ws.id, { name: 'rolf', type: 'manager' });
  const hostKey = runtimeHostKeyForAgent(host.id);
  const managerHeaders = { 'X-Agent-Key': hostKey, 'Content-Type': 'application/json' };
  const heartbeat = await call(`${base}/api/agent/instance-heartbeat`, {
    method: 'POST', headers: managerHeaders,
    body: JSON.stringify({
      instance_id: 'inst-rolf', agent_id: host.id, host_id: host.id, mode: 'manager', hostname: 'rolf', plugin_version: 'test',
      cli: 'claude', cli_adapters: ['claude', 'codex'], acp_session_clis: ['claude', 'codex'], pid: 4242, started_at: new Date().toISOString(),
    }),
  });
  assert.ok(heartbeat.status < 300, heartbeat.text);

  const requests = [];
  const onRequest = (payload) => requests.push(payload);
  activityEvents.on('agent_session_request', onRequest);
  t.after(() => activityEvents.removeListener('agent_session_request', onRequest));
  const relay = (cli, sessionId, events, state) => call(`${base}/api/agent/sessions/${host.id}/${cli}/${sessionId}/events`, {
    method: 'POST', headers: managerHeaders, body: JSON.stringify({ manager_id: host.id, events, ...(state ? { state } : {}) }),
  });
  const prompt = (user, cli, sessionId, text) => call(`${base}/api/agent-sessions/hosts/${host.id}/${cli}/sessions/${sessionId}/prompt`, {
    method: 'POST', headers: headersFor(user), body: JSON.stringify({ text }),
  });

  // operator "Jarvis" = 이 Host 의 Claude 세션 op-1.
  const registered = await call(`${base}/api/voice/operators`, {
    method: 'POST', headers: userHeaders,
    body: JSON.stringify({ name: 'Jarvis', manager_id: host.id, cli: 'claude', session_id: 'op-1', title: 'Jarvis' }),
  });
  assert.equal(registered.status, 201, registered.text);
  assert.equal(registered.body.operator.account_id, ws.id, 'the workspace the operator was registered from is kept');

  const mcp = (sessionId) => new McpClient({
    baseUrl: base, apiKey: hostKey, clientInfo: { name: 'claude-agent-acp', version: 'test' },
    extraHeaders: { 'X-AWB-Client-Type': 'agent-session', 'X-AWB-Session-Id': sessionId },
  });
  const operator = mcp('op-1');
  const bystander = mcp('sess-other');

  // 사용자가 Codex 세션에 일을 시켰고, 그 세션이 npm publish 허락을 기다린다.
  const work = await prompt(admin, 'codex', 'sess-work', '배포해 줘');
  assert.equal(work.status, 202, work.text);
  const workTurn = work.body.turn_id;
  await relay('codex', 'sess-work', [
    { type: 'turn', payload: { phase: 'started' }, turn_id: workTurn },
    {
      type: 'permission_request', turn_id: workTurn,
      payload: {
        request_id: 'r1', title: 'Run npm publish', kind: 'execute',
        options: [{ option_id: 'allow_once', name: 'Allow once', kind: 'allow_once' }, { option_id: 'reject', name: 'Reject', kind: 'reject_once' }],
      },
    },
  ], { status: 'awaiting_permission', reason: 'permission' });

  // 1. AWB 가 operator 에게 보고한다 — 대신 보낸 프롬프트에 선택지와 답을 전할 호출 값이 실린다.
  const report = await waitFor(() => requests.find((r) => r.op === 'prompt' && r.session_id === 'op-1'), 'report prompt to the operator');
  assert.match(report.text, /^\[AWB 작업 보고\]/);
  assert.match(report.text, /1\. 승인 필요 — rolf/);
  assert.match(report.text, /요청: Run npm publish/);
  assert.match(report.text, /선택지: 1\) Allow once {2}2\) Reject/);
  assert.ok(report.text.includes(`answer_session_permission(manager_id="${host.id}", cli="codex", session_id="sess-work", request_id="r1", option_id=1)"allow_once" 2)"reject")`), report.text);
  assert.equal(report.account_id, ws.id, 'the operator session opens with the workspace it was registered from');

  // 2. operator 는 미결 요청을 본다.
  const listed = await operator.callTool('list_pending_session_requests', {});
  assert.equal(listed.sessions.length, 1, JSON.stringify(listed));
  assert.deepEqual(
    [listed.sessions[0].session_id, listed.sessions[0].cli_label, listed.sessions[0].requests[0].id, listed.sessions[0].requests[0].options.map((o) => o.option_id)],
    ['sess-work', 'Codex', 'r1', ['allow_once', 'reject']],
  );

  // 3. 보고 턴 — 사람이 말하지 않았으니 답을 전하지 못한다.
  await relay('claude', 'op-1', [{ type: 'turn', payload: { phase: 'started' }, turn_id: report.turn_id }], { status: 'busy', reason: 'turn_started' });
  const answer = { manager_id: host.id, cli: 'codex', session_id: 'sess-work', request_id: 'r1', option_id: 'allow_once' };
  await new Promise((r) => setTimeout(r, 60)); // 서버가 턴 시작 행을 처리할 틈
  const inReportTurn = await operator.callTool('answer_session_permission', answer);
  assert.equal(inReportTurn.isError, true);
  assert.equal(inReportTurn.error.code, 'not_user_turn', JSON.stringify(inReportTurn));
  assert.ok(!requests.some((r) => r.op === 'permission'), 'nothing reached the session');
  await relay('claude', 'op-1', [
    { type: 'text', payload: { text: '롤프의 Codex 세션이 npm publish 실행 허락을 기다려요. 1번 이번만 허용, 2번 거부 중에 골라 주세요.' }, turn_id: report.turn_id },
    { type: 'turn', payload: { phase: 'finished', stop_reason: 'end_turn' }, turn_id: report.turn_id },
  ], { status: 'ready', reason: 'turn_finished' });
  const frame = await stream.waitFor('voice_announcement', () => true, 5000);
  const announced = typeof frame.data === 'string' ? JSON.parse(frame.data) : frame.data;
  assert.equal(announced.kind, 'operator_report');
  assert.deepEqual(announced.operator, { id: registered.body.operator.id, name: 'Jarvis' }, 'the SSE frame says who is speaking');
  assert.equal(announced.needs_decision, true, 'and that an answer is awaited');
  assert.deepEqual(announced.target, { type: 'session', manager_id: host.id, cli: 'codex', session_id: 'sess-work' });

  // 사용자가 말로 고른다 → operator 의 턴(사람이 시작했다) 안에서는 전해진다.
  const spoken = await prompt(admin, 'claude', 'op-1', '1번으로 해 줘');
  assert.equal(spoken.status, 202, spoken.text);
  await relay('claude', 'op-1', [{ type: 'turn', payload: { phase: 'started' }, turn_id: spoken.body.turn_id }], { status: 'busy', reason: 'turn_started' });
  await new Promise((r) => setTimeout(r, 60));
  const wrongOption = await operator.callTool('answer_session_permission', { ...answer, option_id: 'allow_always' });
  assert.equal(wrongOption.error.code, 'option_unknown');
  assert.match(wrongOption.error.error, /allow_once \(Allow once\), reject \(Reject\)/);
  const passed = await operator.callTool('answer_session_permission', answer);
  assert.equal(passed.isError, undefined, JSON.stringify(passed));
  assert.deepEqual(passed.passed_on, { session: `${host.name} / Codex`, request: 'Run npm publish', chose: 'Allow once' });
  const decided = requests.find((r) => r.op === 'permission');
  assert.deepEqual([decided.session_id, decided.permission_request_id, decided.option_id, decided.driver_user_id], ['sess-work', 'r1', 'allow_once', admin.id]);
  const again = await operator.callTool('answer_session_permission', answer);
  assert.equal(again.error.code, 'request_gone', 'one request, one answer');

  // 4. operator 가 아닌 연결은 아무것도 못 한다.
  assert.equal((await bystander.callTool('list_pending_session_requests', {})).error.code, 'not_an_operator');
  assert.equal((await bystander.callTool('answer_session_permission', answer)).error.code, 'not_an_operator');

  // 다른 사람의 세션 — 그 사람이 띄운 질문에는 대신 답하지 않는다.
  const theirs = await prompt(other, 'codex', 'sess-theirs', '질문 있어?');
  await relay('codex', 'sess-theirs', [
    { type: 'turn', payload: { phase: 'started' }, turn_id: theirs.body.turn_id },
    { type: 'elicitation_request', turn_id: theirs.body.turn_id, payload: { elicitation_id: 'q-theirs', mode: 'form', message: '어느 쪽?', schema: { type: 'object', properties: { pick: { type: 'string', enum: ['a', 'b'] } } } } },
  ], { status: 'awaiting_input', reason: 'elicitation' });
  const notMine = await operator.callTool('answer_session_question', {
    manager_id: host.id, cli: 'codex', session_id: 'sess-theirs', elicitation_id: 'q-theirs', action: 'accept', content: { pick: 'a' },
  });
  assert.equal(notMine.error.code, 'not_this_user');
  const visible = await operator.callTool('list_pending_session_requests', {});
  assert.ok(!visible.sessions.some((s) => s.session_id === 'sess-theirs'), "another user's waiting session is not listed");

  // 5. 질문 — 정해진 값만 받는다.
  const asked = await prompt(admin, 'codex', 'sess-ask', '어떻게 배포할지 물어봐');
  await relay('codex', 'sess-ask', [
    { type: 'turn', payload: { phase: 'started' }, turn_id: asked.body.turn_id },
    {
      type: 'elicitation_request', turn_id: asked.body.turn_id,
      payload: {
        elicitation_id: 'q1', mode: 'form', message: '어떤 방식으로 배포할까요?',
        schema: {
          type: 'object', required: ['mode'],
          properties: {
            mode: { type: 'string', title: '배포 방식', oneOf: [{ const: 'blue_green', title: 'Blue-green' }, { const: 'rolling', title: 'Rolling' }] },
            note: { type: 'string', title: '메모' },
          },
        },
      },
    },
  ], { status: 'awaiting_input', reason: 'elicitation' });
  const q = { manager_id: host.id, cli: 'codex', session_id: 'sess-ask', elicitation_id: 'q1', action: 'accept' };
  const badChoice = await operator.callTool('answer_session_question', { ...q, content: { mode: 'canary' } });
  assert.equal(badChoice.error.code, 'choice_unknown');
  assert.match(badChoice.error.error, /blue_green \(Blue-green\), rolling \(Rolling\)/);
  assert.equal((await operator.callTool('answer_session_question', { ...q, content: {} })).error.code, 'field_missing');
  const answered = await operator.callTool('answer_session_question', { ...q, content: { mode: 'rolling', note: '천천히' } });
  assert.equal(answered.isError, undefined, JSON.stringify(answered));
  const elicited = requests.find((r) => r.op === 'elicitation' && r.session_id === 'sess-ask');
  assert.deepEqual([elicited.elicitation_id, elicited.elicitation_action, elicited.elicitation_content], ['q1', 'accept', { mode: 'rolling', note: '천천히' }]);

  // 사용자 턴이 끝나면 다시 막힌다.
  await relay('claude', 'op-1', [{ type: 'turn', payload: { phase: 'finished', stop_reason: 'end_turn' }, turn_id: spoken.body.turn_id }], { status: 'ready', reason: 'turn_finished' });
  await new Promise((r) => setTimeout(r, 50));
  const after = await operator.callTool('answer_session_question', { ...q, action: 'cancel' });
  assert.ok(['not_user_turn', 'request_gone'].includes(after.error.code), JSON.stringify(after));
  assert.equal(after.error.code, 'not_user_turn', 'the gate closes with the user turn');

  // 8. 서버가 처음 보는 세션(재시작 뒤 매니저가 먼저 중계) — 보고에 id 앞부분이 아니라 Host 이름이 실린다.
  //    (앞 단계의 보고 턴이 끝나야 다음 보고가 나간다 — 아직 열린 보고 턴을 끝내 둔다.)
  // 보고 턴을 하나씩 끝내면 줄 선 다음 보고가 나간다 — 원하는 보고가 나올 때까지 계속 끝낸다.
  const finished = new Set();
  const drainReports = async (match, label) => {
    for (let i = 0; i < 20; i++) {
      const hit = requests.find((r) => r.op === 'prompt' && r.session_id === 'op-1' && match(r));
      if (hit) return hit;
      for (const r of requests.filter((x) => x.op === 'prompt' && x.session_id === 'op-1' && (x.text || '').startsWith('[AWB 작업 보고]') && !finished.has(x.turn_id))) {
        finished.add(r.turn_id);
        await relay('claude', 'op-1', [{ type: 'turn', payload: { phase: 'finished', stop_reason: 'end_turn' }, turn_id: r.turn_id }], { status: 'ready', reason: 'turn_finished' });
      }
      await new Promise((resolve) => setTimeout(resolve, 60));
    }
    throw new Error(`timeout waiting for ${label}`);
  };
  await relay('codex', 'sess-orphan', [
    { type: 'turn', payload: { phase: 'started' }, turn_id: 'orphan-turn' },
    { type: 'text', payload: { text: '정리 끝.' }, turn_id: 'orphan-turn' },
    { type: 'turn', payload: { phase: 'finished', stop_reason: 'end_turn' }, turn_id: 'orphan-turn' },
  ], { status: 'ready', reason: 'turn_finished' });
  const orphanReport = await drainReports((r) => (r.text || '').includes('정리 끝.'), 'report about a session first seen through a relay');
  assert.ok(orphanReport.text.includes(`완료 — ${host.name} / Codex`), orphanReport.text.slice(0, 400));
  assert.equal(orphanReport.driver_user_id, admin.id, 'no driver known — the report goes to whoever registered the operator');

  // 7. 새로 만든 세션의 연결 — 참조값으로 붙는다.
  const fresh = mcp('pending-7f3a9c2e-0000-4000-8000-000000000001');
  const unknown = await fresh.callTool('list_pending_session_requests', {});
  assert.equal(unknown.error.code, 'session_unidentified', JSON.stringify(unknown));
  assert.match(unknown.error.error, /⟳ Restart process/);
  const mapped = await call(`${base}/api/agent/instance-heartbeat`, {
    method: 'POST', headers: managerHeaders,
    body: JSON.stringify({
      instance_id: 'inst-rolf', agent_id: host.id, host_id: host.id, mode: 'manager', hostname: 'rolf', plugin_version: 'test',
      cli: 'claude', cli_adapters: ['claude', 'codex'], acp_session_clis: ['claude', 'codex'], pid: 4242, started_at: new Date().toISOString(),
      agent_sessions: [{ cli: 'claude', session_id: 'op-1', status: 'ready', mcp_session_ref: 'pending-7f3a9c2e-0000-4000-8000-000000000001' }],
    }),
  });
  assert.ok(mapped.status < 300, mapped.text);
  await new Promise((r) => setTimeout(r, 50));
  const known = await fresh.callTool('list_pending_session_requests', {});
  assert.ok(Array.isArray(known.sessions), `the ref now resolves to the operator session: ${JSON.stringify(known)}`);
  const legacy = mcp('new');
  assert.equal((await legacy.callTool('list_pending_session_requests', {})).error.code, 'session_unidentified',
    'an older manager sends the literal "new" — AWB says why and how to fix it');

  await operator.close();
  await bystander.close();
  await fresh.close();
  await legacy.close();
});
