// 작업 제안 — docs/voice-operator.md "작업 제안".
//
// operator 는 다른 세션에 일을 직접 시키지 못하고 제안만 한다. 사용자가 승인해야(화면의 Send, 또는 사용자가
// 시작한 operator 턴에서의 확인) AWB 가 대상 세션에 보낸다. 실제 앱과 가짜 Runtime Host 로 고정한다:
//   1. 보고 프롬프트가 모든 보고에 세션 참조와 제안 도구 안내를 싣는다.
//   2. 보고 턴에서도 제안은 남길 수 있다 — 아무것도 보내지 않고, 승인할 사용자에게 SSE 로 알린다.
//   3. operator 가 아닌 연결 · operator 세션을 대상으로 · 다른 사람이 모는 세션은 거절한다.
//   4. 보고 턴에서 operator 가 스스로 보내는 것은 거절한다(not_user_turn).
//   5. 같은 대상에 새 제안을 남기면 미결인 옛 제안은 바뀐다(superseded).
//   6. 화면 승인: 대상이 턴 중이면 기다렸다가(queued) 그 턴이 끝나면 출처 줄을 단 프롬프트로 보낸다(sent).
//   7. 음성 승인: 사용자가 시작한 operator 턴에서는 보낸다.
//   8. 거둔(withdrawn) · 거절한(dismissed) 제안은 보낼 수 없다. 남의 제안은 보거나 정하지 못한다.
//
// 실행: node --test --test-force-exit test/voice-operator-proposals.test.mjs (dist 필요)

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { bootApp, closeTestApp } from './helpers/boot.mjs';
import { createAgent, createUser, createAccount, runtimeHostKeyForAgent } from './helpers/fixtures.mjs';
import { McpClient } from './helpers/mcp-client.mjs';
import { openSseStream } from './helpers/sse-listener.mjs';
import { OPERATOR_TASK_PREFIX } from '../dist/modules/voice/operator-proposal.js';

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
    const value = await predicate();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 15));
  }
  throw new Error(`timeout waiting for ${label}`);
}

test('an operator proposes work for a session; it reaches the session only after the user approves', async (t) => {
  const { app, port, modules } = await bootApp({ port: parseInt(process.env.PORT, 10) });
  t.after(async () => { await closeTestApp(app); });
  const { getDataSourceToken, AuthService, activityEvents } = modules;
  const base = `http://localhost:${port}`;

  const ws = await createAccount(app, getDataSourceToken, 'voice-proposals');
  const admin = await createUser(app, getDataSourceToken, { name: 'admin', role: 'admin' });
  const other = await createUser(app, getDataSourceToken, { name: 'other-admin', role: 'admin' });
  const headersFor = (user) => ({
    Authorization: `Bearer ${app.get(AuthService).createSession(user.id)}`, 'X-Account-Id': ws.id, 'Content-Type': 'application/json',
  });
  const userHeaders = headersFor(admin);
  const stream = await openSseStream(port, app.get(AuthService).createSession(admin.id), {});
  t.after(() => stream.close());

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
  const finish = (cli, sessionId, turnId, text = '끝났어요.') => relay(cli, sessionId, [
    { type: 'text', payload: { text }, turn_id: turnId },
    { type: 'turn', payload: { phase: 'finished', stop_reason: 'end_turn' }, turn_id: turnId },
  ], { status: 'ready', reason: 'turn_finished' });
  const proposals = (user) => call(`${base}/api/voice/proposals`, { headers: headersFor(user) });
  const decide = (user, id, action) => call(`${base}/api/voice/proposals/${id}/${action}`, { method: 'POST', headers: headersFor(user) });
  const promptsTo = (sessionId) => requests.filter((r) => r.op === 'prompt' && r.session_id === sessionId);

  const registered = await call(`${base}/api/voice/operators`, {
    method: 'POST', headers: userHeaders,
    body: JSON.stringify({ name: 'Jarvis', manager_id: host.id, cli: 'claude', session_id: 'op-1', title: 'Jarvis' }),
  });
  assert.equal(registered.status, 201, registered.text);
  const mcp = (sessionId) => new McpClient({
    baseUrl: base, apiKey: hostKey, clientInfo: { name: 'claude-agent-acp', version: 'test' },
    extraHeaders: { 'X-AWB-Client-Type': 'agent-session', 'X-AWB-Session-Id': sessionId },
  });
  const operator = mcp('op-1');
  const bystander = mcp('sess-other');

  // 사용자가 Codex 세션에 일을 시켰고, 그 턴이 끝났다 → operator 에게 보고.
  const work = await prompt(admin, 'codex', 'sess-work', '빌드 고쳐 줘');
  assert.equal(work.status, 202, work.text);
  await relay('codex', 'sess-work', [{ type: 'turn', payload: { phase: 'started' }, turn_id: work.body.turn_id }], { status: 'busy', reason: 'turn_started' });
  await finish('codex', 'sess-work', work.body.turn_id, '빌드를 고쳤어요. 테스트는 아직 안 돌렸어요.');

  // 1. 보고에 세션 참조와 제안 안내가 실린다.
  const report = await waitFor(() => requests.find((r) => r.op === 'prompt' && r.session_id === 'op-1'), 'report prompt to the operator');
  assert.ok(report.text.includes(`세션: manager_id="${host.id}", cli="codex", session_id="sess-work"`), report.text);
  assert.match(report.text, /propose_session_prompt 로 제안하세요 — 사용자가 승인해야 전달됩니다/);

  // 2. 보고 턴 — 제안은 남는다. 아무것도 보내지 않는다.
  await relay('claude', 'op-1', [{ type: 'turn', payload: { phase: 'started' }, turn_id: report.turn_id }], { status: 'busy', reason: 'turn_started' });
  await new Promise((r) => setTimeout(r, 60));
  const target = { manager_id: host.id, cli: 'codex', session_id: 'sess-work' };
  const first = await operator.callTool('propose_session_prompt', { ...target, text: '테스트 돌려 줘', reason: '빌드는 고쳤지만 테스트를 안 돌렸다' });
  assert.equal(first.isError, undefined, JSON.stringify(first));
  assert.deepEqual([first.proposal.status, first.proposal.origin, first.proposal.operator.name, first.proposal.target.session_id, first.proposal.target.manager_name],
    ['pending', 'report', 'Jarvis', 'sess-work', host.name]);
  const frame = await stream.waitFor('agent_session_proposal', (data) => (typeof data === 'string' ? JSON.parse(data) : data)?.proposal?.id === first.proposal.id, 5000);
  const framed = typeof frame.data === 'string' ? JSON.parse(frame.data) : frame.data;
  assert.equal(framed.reason, 'proposed', 'the approving user hears about it at once');
  assert.equal(promptsTo('sess-work').length, 1, 'nothing reached the session — only the user\'s own prompt so far');

  // 3. 거절되는 제안들 + operator 세션 대상은 허용되되 표시된다(작업 턴으로 Subject 분리).
  assert.equal((await bystander.callTool('propose_session_prompt', { ...target, text: 'x' })).error.code, 'not_an_operator');
  const toOp = await operator.callTool('propose_session_prompt', { manager_id: host.id, cli: 'claude', session_id: 'op-1', text: 'x' });
  assert.equal(toOp.isError, undefined, JSON.stringify(toOp));
  assert.equal(toOp.proposal.status, 'pending');
  assert.equal(toOp.proposal.target_is_operator, true, 'the card knows the target is an operator');
  assert.equal((await operator.callTool('withdraw_session_prompt_proposal', { proposal_id: toOp.proposal.id })).proposal.status, 'withdrawn');
  assert.equal((await operator.callTool('propose_session_prompt', { ...target, session_id: 'never-seen', text: 'x' })).error.code, 'session_unknown');
  const theirs = await prompt(other, 'codex', 'sess-theirs', '다른 사람 일');
  assert.equal(theirs.status, 202, theirs.text);
  assert.equal((await operator.callTool('propose_session_prompt', { ...target, session_id: 'sess-theirs', text: 'x' })).error.code, 'not_this_user');
  assert.equal((await operator.callTool('propose_session_prompt', { ...target, text: '   ' })).error.code, 'text_required');

  // 4. 보고 턴에서 operator 가 스스로 보내지 못한다.
  const selfSend = await operator.callTool('send_session_prompt_proposal', { proposal_id: first.proposal.id });
  assert.equal(selfSend.error.code, 'not_user_turn', JSON.stringify(selfSend));
  assert.equal(promptsTo('sess-work').length, 1);

  // 5. 같은 대상에 다시 제안하면 옛 미결 제안은 바뀐다.
  const second = await operator.callTool('propose_session_prompt', { ...target, text: '전체 테스트를 돌리고 실패를 고쳐 줘' });
  assert.equal(second.proposal.status, 'pending');
  const listed = await proposals(admin);
  assert.equal(listed.status, 200, listed.text);
  assert.deepEqual(listed.body.proposals.map((p) => [p.id, p.status]), [[second.proposal.id, 'pending']], 'only the latest thought is waiting');
  assert.deepEqual((await proposals(other)).body.proposals, [], 'another user does not see it');
  assert.equal((await decide(other, second.proposal.id, 'send')).body.error, 'not_your_proposal');
  await finish('claude', 'op-1', report.turn_id, '롤프 Codex 세션이 빌드를 고쳤어요. 테스트를 돌리자고 제안해 뒀어요.');

  // 6. 화면 승인 — 대상이 턴 중이면 기다렸다가 그 턴이 끝나면 보낸다.
  const busy = await prompt(admin, 'codex', 'sess-work', '잠깐 다른 것 좀');
  assert.equal(busy.status, 202, busy.text);
  await relay('codex', 'sess-work', [{ type: 'turn', payload: { phase: 'started' }, turn_id: busy.body.turn_id }], { status: 'busy', reason: 'turn_started' });
  const approved = await decide(admin, second.proposal.id, 'send');
  assert.equal(approved.status, 200, approved.text);
  assert.equal(approved.body.proposal.status, 'queued', 'approved, waiting for the running turn');
  assert.equal(promptsTo('sess-work').length, 2, 'not sent into a running turn');
  assert.equal((await decide(admin, second.proposal.id, 'send')).body.error, 'proposal_closed', 'one approval');
  await finish('codex', 'sess-work', busy.body.turn_id);
  const delivered = await waitFor(() => promptsTo('sess-work')[2], 'the approved prompt reaches the session');
  assert.equal(delivered.text, `${OPERATOR_TASK_PREFIX} Jarvis — 사용자 승인\n전체 테스트를 돌리고 실패를 고쳐 줘`);
  assert.equal(delivered.driver_user_id, admin.id);
  assert.equal(delivered.account_id, ws.id, 'it opens with the session\'s own pinned account');
  const sent = await waitFor(async () => {
    const mine = await operator.callTool('list_session_prompt_proposals', {});
    return mine.proposals?.find((p) => p.id === second.proposal.id && p.status === 'sent');
  }, 'the operator sees it was sent');
  assert.equal(sent.decided_via, 'screen');
  assert.ok(sent.delivered_turn_id);
  assert.deepEqual((await proposals(admin)).body.proposals, [], 'nothing left to decide');
  await relay('codex', 'sess-work', [{ type: 'turn', payload: { phase: 'started' }, turn_id: delivered.turn_id }], { status: 'busy', reason: 'turn_started' });
  await finish('codex', 'sess-work', delivered.turn_id, '테스트 다 통과해요.');

  // 7. 음성 승인 — 사용자가 시작한 operator 턴에서는 보낸다.
  const third = await operator.callTool('propose_session_prompt', { ...target, text: '변경 내용을 커밋해 줘' });
  assert.equal(third.isError, undefined, JSON.stringify(third));
  // 앞의 작업들이 끝나며 operator 에게 보고가 줄을 섰다 — 보고 턴을 모두 끝내 두고 사용자 턴을 연다.
  const finishedReports = new Set([report.turn_id]);
  const reportTexts = [];
  for (let quiet = 0; quiet < 3;) {
    const open = requests.filter((x) => x.op === 'prompt' && x.session_id === 'op-1' && !finishedReports.has(x.turn_id));
    if (!open.length) { quiet += 1; await new Promise((r) => setTimeout(r, 60)); continue; }
    quiet = 0;
    for (const r of open) {
      finishedReports.add(r.turn_id);
      reportTexts.push(r.text);
      await relay('claude', 'op-1', [{ type: 'turn', payload: { phase: 'started' }, turn_id: r.turn_id }], { status: 'busy', reason: 'turn_started' });
      await finish('claude', 'op-1', r.turn_id, '알겠어요.');
    }
  }
  // 시킨 작업이 끝나자 그 결과가 시킨 operator 에게 "네가 시킨 작업" 으로 보고됐다.
  assert.ok(reportTexts.some((text) => text.includes('네가 시킨 작업(Jarvis, 사용자 승인): "전체 테스트를 돌리고 실패를 고쳐 줘"') && text.includes('테스트 다 통과해요.')),
    reportTexts.join('\n---\n'));
  const spoken = await prompt(admin, 'claude', 'op-1', '응, 커밋하라고 보내');
  assert.equal(spoken.status, 202, spoken.text);
  await relay('claude', 'op-1', [{ type: 'turn', payload: { phase: 'started' }, turn_id: spoken.body.turn_id }], { status: 'busy', reason: 'turn_started' });
  await new Promise((r) => setTimeout(r, 60));
  const byVoice = await operator.callTool('send_session_prompt_proposal', { proposal_id: third.proposal.id });
  assert.equal(byVoice.isError, undefined, JSON.stringify(byVoice));
  assert.equal(byVoice.proposal.status, 'sent');
  assert.equal(byVoice.proposal.decided_via, 'voice');
  assert.equal(promptsTo('sess-work').at(-1).text, `${OPERATOR_TASK_PREFIX} Jarvis — 사용자 승인\n변경 내용을 커밋해 줘`);
  await finish('claude', 'op-1', spoken.body.turn_id, '커밋하라고 보냈어요.');

  // 8. 거둔 것 · 거절한 것은 보낼 수 없다.
  const busy2 = await prompt(admin, 'codex', 'sess-work', '하나 더');
  await relay('codex', 'sess-work', [{ type: 'turn', payload: { phase: 'started' }, turn_id: busy2.body.turn_id }], { status: 'busy', reason: 'turn_started' });
  const fourth = await operator.callTool('propose_session_prompt', { ...target, text: '배포해 줘' });
  const withdrawn = await operator.callTool('withdraw_session_prompt_proposal', { proposal_id: fourth.proposal.id });
  assert.equal(withdrawn.proposal.status, 'withdrawn');
  assert.equal((await decide(admin, fourth.proposal.id, 'send')).body.error, 'proposal_closed');
  const fifth = await operator.callTool('propose_session_prompt', { ...target, text: '로그 정리해 줘' });
  const dismissed = await decide(admin, fifth.proposal.id, 'dismiss');
  assert.equal(dismissed.body.proposal.status, 'dismissed');
  assert.equal((await decide(admin, fifth.proposal.id, 'send')).body.error, 'proposal_closed');
  assert.equal((await bystander.callTool('withdraw_session_prompt_proposal', { proposal_id: fifth.proposal.id })).error.code, 'not_an_operator');
  await finish('codex', 'sess-work', busy2.body.turn_id);
  await new Promise((r) => setTimeout(r, 80));
  assert.ok(!promptsTo('sess-work').some((r) => /배포해 줘|로그 정리해 줘/.test(r.text)), 'withdrawn and dismissed proposals never reach the session');
});

test('the screen recognises the same operator-task prefix the server sends', () => {
  const client = readFileSync(new URL('../../client/src/components/sessions/sessionTranscript.logic.ts', import.meta.url), 'utf8');
  assert.ok(client.includes(`export const OPERATOR_TASK_PREFIX = '${OPERATOR_TASK_PREFIX}';`), 'client labels operator tasks by this exact prefix');
});

test('cross-host proposals: an operator on one host can task an ordinary session on another', async (t) => {
  const { app, port, modules } = await bootApp({ port: parseInt(process.env.PORT, 10) });
  t.after(async () => { await closeTestApp(app); });
  const { getDataSourceToken, AuthService, activityEvents } = modules;
  const base = `http://localhost:${port}`;

  const ws = await createAccount(app, getDataSourceToken, 'voice-proposals-xhost');
  const admin = await createUser(app, getDataSourceToken, { name: 'admin', role: 'admin' });
  const headersFor = (user) => ({
    Authorization: `Bearer ${app.get(AuthService).createSession(user.id)}`, 'X-Account-Id': ws.id, 'Content-Type': 'application/json',
  });
  const userHeaders = headersFor(admin);

  // 호스트 두 대 — operator 는 hostA, 일 시킬 세션은 hostB.
  const hostA = await createAgent(app, getDataSourceToken, ws.id, { name: 'laptop', type: 'manager' });
  const hostB = await createAgent(app, getDataSourceToken, ws.id, { name: 'ragnar', type: 'manager' });
  const keyFor = (host) => runtimeHostKeyForAgent(host.id);
  const beat = (host, hostname) => call(`${base}/api/agent/instance-heartbeat`, {
    method: 'POST', headers: { 'X-Agent-Key': keyFor(host), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      instance_id: `inst-${hostname}`, agent_id: host.id, host_id: host.id, mode: 'manager', hostname, plugin_version: 'test',
      cli: 'claude', cli_adapters: ['claude', 'codex'], acp_session_clis: ['claude', 'codex'], pid: 4242, started_at: new Date().toISOString(),
    }),
  });
  assert.ok((await beat(hostA, 'laptop')).status < 300);
  assert.ok((await beat(hostB, 'ragnar')).status < 300);

  const requests = [];
  const onRequest = (payload) => requests.push(payload);
  activityEvents.on('agent_session_request', onRequest);
  t.after(() => activityEvents.removeListener('agent_session_request', onRequest));
  const relay = (host, cli, sessionId, events, state) => call(`${base}/api/agent/sessions/${host.id}/${cli}/${sessionId}/events`, {
    method: 'POST', headers: { 'X-Agent-Key': keyFor(host), 'Content-Type': 'application/json' },
    body: JSON.stringify({ manager_id: host.id, events, ...(state ? { state } : {}) }),
  });
  const prompt = (host, user, cli, sessionId, text) => call(`${base}/api/agent-sessions/hosts/${host.id}/${cli}/sessions/${sessionId}/prompt`, {
    method: 'POST', headers: headersFor(user), body: JSON.stringify({ text }),
  });
  const finish = (host, cli, sessionId, turnId, text = '끝났어요.') => relay(host, cli, sessionId, [
    { type: 'text', payload: { text }, turn_id: turnId },
    { type: 'turn', payload: { phase: 'finished', stop_reason: 'end_turn' }, turn_id: turnId },
  ], { status: 'ready', reason: 'turn_finished' });
  const promptsTo = (hostId, sessionId) => requests.filter((r) => r.op === 'prompt' && r.manager_id === hostId && r.session_id === sessionId);

  const registered = await call(`${base}/api/voice/operators`, {
    method: 'POST', headers: userHeaders,
    body: JSON.stringify({ name: 'Hal', manager_id: hostA.id, cli: 'claude', session_id: 'op-a', title: 'Hal' }),
  });
  assert.equal(registered.status, 201, registered.text);
  const mcp = (host, sessionId) => new McpClient({
    baseUrl: base, apiKey: keyFor(host), clientInfo: { name: 'claude-agent-acp', version: 'test' },
    extraHeaders: { 'X-AWB-Client-Type': 'agent-session', 'X-AWB-Session-Id': sessionId },
  });
  const operator = mcp(hostA, 'op-a');

  // operator 세션에 운전자(같은 사용자)를 붙인다 — 제안의 승인자를 정할 수 있게.
  // hello 턴은 끝내 둔다(시작만 한 세션에는 보고 프롬프트를 넣지 않는다).
  const hello = await prompt(hostA, admin, 'claude', 'op-a', '안녕');
  assert.equal(hello.status, 202, hello.text);
  await relay(hostA, 'claude', 'op-a', [{ type: 'turn', payload: { phase: 'started' }, turn_id: hello.body.turn_id }], { status: 'busy', reason: 'turn_started' });
  await finish(hostA, 'claude', 'op-a', hello.body.turn_id, '안녕하세요.');
  // hostB 의 일반 세션을 연다(같은 사용자가 모는 세션). 턴을 끝내 ready 로 둔다 —
  // 막 열린 세션(starting)에는 프롬프트를 받지 않는다(바쁜 턴과 같은 취급).
  const work = await prompt(hostB, admin, 'codex', 'sess-remote', 'hostB 에서 빌드해 줘');
  assert.equal(work.status, 202, work.text);
  await relay(hostB, 'codex', 'sess-remote', [{ type: 'turn', payload: { phase: 'started' }, turn_id: work.body.turn_id }], { status: 'busy', reason: 'turn_started' });
  await finish(hostB, 'codex', 'sess-remote', work.body.turn_id, 'hostB 빌드 시작해요.');

  // 첫 턴의 보고가 Hal 에게 와 있다 — 보고 턴을 끝내 비워 둔다. operator 의 보고는 한 번에
  // 하나씩만 나가므로(Inflight), 열어 두면 뒤의 "네가 시킨 작업" 결과가 줄 서서 기다린다.
  const finishedOpA = new Set();
  for (let quiet = 0; quiet < 3;) {
    const open = requests.filter((x) => x.op === 'prompt' && x.manager_id === hostA.id && x.session_id === 'op-a' && !finishedOpA.has(x.turn_id));
    if (!open.length) { quiet += 1; await new Promise((r) => setTimeout(r, 60)); continue; }
    quiet = 0;
    for (const r of open) {
      finishedOpA.add(r.turn_id);
      await relay(hostA, 'claude', 'op-a', [{ type: 'turn', payload: { phase: 'started' }, turn_id: r.turn_id }], { status: 'busy', reason: 'turn_started' });
      await finish(hostA, 'claude', 'op-a', r.turn_id, '알겠어요.');
    }
  }

  // 1. 다른 호스트의 일반 세션에는 제안할 수 있다.
  const target = { manager_id: hostB.id, cli: 'codex', session_id: 'sess-remote' };
  const first = await operator.callTool('propose_session_prompt', { ...target, text: '테스트 돌려 줘', reason: 'hostB 일감' });
  assert.equal(first.isError, undefined, JSON.stringify(first));
  assert.equal(first.proposal.status, 'pending');
  assert.equal(first.proposal.target.manager_id, hostB.id, 'the card names the other host');

  // 2. 다른 호스트의 operator 세션에도 제안·질문할 수 있다 — 답은 시킨 쪽으로 돌아온다.
  //    작업 턴은 "사용자 턴" 으로 세어지지 않으므로, 그 턴에서 말로 승인·전달하는 힘은 생기지 않는다.
  const registeredB = await call(`${base}/api/voice/operators`, {
    method: 'POST', headers: userHeaders,
    body: JSON.stringify({ name: 'Ada', manager_id: hostB.id, cli: 'codex', session_id: 'op-b', title: 'Ada' }),
  });
  assert.equal(registeredB.status, 201, registeredB.text);
  const opB = mcp(hostB, 'op-b');
  // op-b 세션을 열어 둔다(모르는 세션에는 제안하지 않는다 — 같은 규칙).
  // hello 턴은 끝내 ready 로 둔다. 그 보고는 Ada(같은 호스트)에게 간다.
  const helloB = await prompt(hostB, admin, 'codex', 'op-b', '안녕');
  assert.equal(helloB.status, 202, helloB.text);
  await relay(hostB, 'codex', 'op-b', [{ type: 'turn', payload: { phase: 'started' }, turn_id: helloB.body.turn_id }], { status: 'busy', reason: 'turn_started' });
  await finish(hostB, 'codex', 'op-b', helloB.body.turn_id, '안녕하세요.');
  const toOp = await operator.callTool('propose_session_prompt', { manager_id: hostB.id, cli: 'codex', session_id: 'op-b', text: 'ragnar 쪽 상태 알려 줘' });
  assert.equal(toOp.isError, undefined, JSON.stringify(toOp));
  assert.equal(toOp.proposal.status, 'pending');
  assert.equal(toOp.proposal.target_is_operator, true, 'the card knows the target is an operator');
  // 미끼: op-b 가 자기 제안을 하나 남겨 둔다 — 작업 턴 중에 말로 보내려 하면 거절돼야 한다.
  const bait = await opB.callTool('propose_session_prompt', { ...target, text: '나중에 로그 정리해 줘' });
  assert.equal(bait.isError, undefined, JSON.stringify(bait));
  const approvedOp = await call(`${base}/api/voice/proposals/${toOp.proposal.id}/send`, { method: 'POST', headers: userHeaders });
  assert.equal(approvedOp.status, 200, approvedOp.text);
  const deliveredOp = await waitFor(() => promptsTo(hostB.id, 'op-b').find((r) => r.text?.startsWith(OPERATOR_TASK_PREFIX)), 'the approved prompt reaches the other operator');
  assert.equal(deliveredOp.text, `${OPERATOR_TASK_PREFIX} Hal — 사용자 승인\nragnar 쪽 상태 알려 줘`);
  // 작업 턴 진행 중에는 그 operator 의 말로 승인·전달이 막힌다(승인 권한 누수 없음).
  await relay(hostB, 'codex', 'op-b', [{ type: 'turn', payload: { phase: 'started' }, turn_id: deliveredOp.turn_id }], { status: 'busy', reason: 'turn_started' });
  assert.equal((await opB.callTool('send_session_prompt_proposal', { proposal_id: bait.proposal.id })).error.code, 'not_user_turn');
  // 작업 턴이 끝나면 답이 시킨 쪽(Hal)에만 돌아온다 — 받는 쪽(Ada) 사용자에게는 알리지 않는다.
  await finish(hostB, 'codex', 'op-b', deliveredOp.turn_id, 'ragnar 정상이에요.');
  const answerBack = await waitFor(() => promptsTo(hostA.id, 'op-a').find((r) => r.text?.includes('네가 시킨 작업(Hal, 사용자 승인)')), 'the other operator\'s answer returns to the requester');
  assert.ok(answerBack.text.includes('ragnar 정상이에요.'), answerBack.text.slice(0, 500));
  assert.equal(promptsTo(hostB.id, 'op-b').filter((r) => r.text?.startsWith(OPERATOR_TASK_PREFIX)).length, 1, 'only the approved task reached op-b as work');
  await opB.callTool('withdraw_session_prompt_proposal', { proposal_id: bait.proposal.id });
  // Hal 의 보고 턴을 끝내 비워 둔다 — 열어 두면 뒤의 "네가 시킨 작업" 결과가 줄 서서 기다린다.
  await relay(hostA, 'claude', 'op-a', [{ type: 'turn', payload: { phase: 'started' }, turn_id: answerBack.turn_id }], { status: 'busy', reason: 'turn_started' });
  await finish(hostA, 'claude', 'op-a', answerBack.turn_id, '알겠어요.');

  // 3. 화면 승인 → hostB 세션에 출처 줄을 단 프롬프트가 간다.
  const approved = await call(`${base}/api/voice/proposals/${first.proposal.id}/send`, { method: 'POST', headers: userHeaders });
  assert.equal(approved.status, 200, approved.text);
  const delivered = await waitFor(() => promptsTo(hostB.id, 'sess-remote').find((r) => r.text?.startsWith(OPERATOR_TASK_PREFIX)), 'the approved prompt reaches the other host');
  assert.equal(delivered.text, `${OPERATOR_TASK_PREFIX} Hal — 사용자 승인\n테스트 돌려 줘`);
  assert.equal(delivered.manager_id, hostB.id);
  assert.equal(delivered.driver_user_id, admin.id);
  const sent = await waitFor(async () => {
    const mine = await operator.callTool('list_session_prompt_proposals', {});
    return mine.proposals?.find((p) => p.id === first.proposal.id && p.status === 'sent');
  }, 'the operator sees it was sent');
  assert.ok(sent.delivered_turn_id);

  // 4. hostB 턴이 끝나면 결과("네가 시킨 작업")가 hostA 의 operator 에게 돌아온다.
  //    이미 본 보고 턴은 제외한다 — 묵은 보고를 다시 잡으면 안 된다.
  const seenOpA = new Set(promptsTo(hostA.id, 'op-a').map((r) => r.turn_id));
  await relay(hostB, 'codex', 'sess-remote', [{ type: 'turn', payload: { phase: 'started' }, turn_id: delivered.turn_id }], { status: 'busy', reason: 'turn_started' });
  await finish(hostB, 'codex', 'sess-remote', delivered.turn_id, '테스트 다 통과해요.');
  const reportBack = await waitFor(() => promptsTo(hostA.id, 'op-a').find((r) => !seenOpA.has(r.turn_id) && r.text?.includes('네가 시킨 작업(Hal, 사용자 승인)')), 'the delegated result returns to the proposing operator');
  assert.ok(reportBack.text.includes('테스트 다 통과해요.'), reportBack.text.slice(0, 500));
});
