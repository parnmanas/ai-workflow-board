// Business 업무 실행은 Agent Session 에서 돈다 — 업무 하나가 세션 하나를 이어 쓰고, 결과 제출은 그 세션의
// MCP 연결만 받는다. 세션이 죽어도 화면이 그 세션을 그대로 띄워 상태를 보고 이어 갈 수 있어야 해서다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { bootApp, closeTestApp } from './helpers/boot.mjs';
import { createAccount, createAgent, createUser } from './helpers/fixtures.mjs';
import { BusinessService } from '../dist/modules/business/business.service.js';
import { BusinessWorkflowService } from '../dist/modules/business/business-workflow.service.js';
import { InstanceRegistryService } from '../dist/modules/agent-manager/instance-registry.service.js';
import { RoomMessagingService } from '../dist/modules/chat-rooms/room-messaging.service.js';
import { runtimeIdentityKey } from '../dist/common/runtime-spec.js';

test('Business work runs in one Agent Session per work item', { timeout: 120000 }, async t => {
  const { app, modules } = await bootApp(); t.after(() => closeTestApp(app));
  const ds = app.get(modules.getDataSourceToken());
  const business = app.get(BusinessService); app.get(BusinessWorkflowService).onModuleDestroy();
  const owner = await createUser(app, modules.getDataSourceToken, { name: 'Session business owner' });
  const account = await createAccount(app, modules.getDataSourceToken, 'Business sessions', { ownerUserId: owner.id });
  const agent = await createAgent(app, modules.getDataSourceToken, account.id, { name: 'Formation assistant', runtime: true });
  const spec = agent.runtime_spec; const hostId = spec.manager_agent_id;
  const actor = { id: owner.id, name: owner.name, type: 'user' };
  const company = await business.create(account.id, { name: 'Session example' }, owner.id, false);
  const repo = ds.getRepository('BusinessTaskRun');
  const registry = app.get(InstanceRegistryService);
  t.mock.method(registry, 'listForAccount', id => id === account.id ? [{ mode: 'manager', host_id: hostId, cli_adapters: [spec.cli] }] : []);

  const sessionId = randomUUID();
  const calls = { open: [], prompt: [] };
  let status = 'ready'; let promptError = null;
  const sessions = {
    listHosts: async () => [{ manager_id: hostId, clis: [spec.cli] }],
    liveSnapshot: (manager, cli, id) => (manager === hostId && cli === spec.cli && id === sessionId ? { status } : null),
    openSession: async (accountId, userId, manager, cli, input) => { calls.open.push({ accountId, userId, manager, cli, input }); return { session_id: sessionId }; },
    promptOnBehalf: async (accountId, userId, manager, cli, id, text) => {
      if (promptError) throw promptError;
      calls.prompt.push({ userId, manager, cli, id, text }); return { turn_id: `turn-${calls.prompt.length}` };
    },
    // 새로 만든 세션의 MCP 연결은 id 대신 참조값을 보낸다.
    resolveMcpSessionRef: (manager, ref) => (manager === hostId && ref === 'mcp-ref-1' ? sessionId : null),
  };
  const messaging = app.get(RoomMessagingService);
  const roomSend = t.mock.method(messaging, 'sendMessage', async () => { throw new Error('the room pipeline must not be used'); });
  const workflow = new BusinessWorkflowService(ds, business, messaging, registry, sessions);

  let run = await workflow.start(company.id, account.id, null, { request_id: randomUUID(), content: '설립 방식을 조사해 주세요.', agent_runtime: spec }, actor);
  const taskId = run.task_id;
  const viaSession = { agentId: hostId, agentSessionId: 'mcp-ref-1' };
  const result = { status: 'needs_input', summary: '설립 방식 비교를 준비했습니다.', question: '사용할 서비스를 선택해 주세요.' };

  await t.test('the first request opens a session in the assigned folder and prompts it as the owner', async () => {
    assert.equal((await business.taskDetail(company.id, account.id, taskId)).session, null, 'no session before the first run');
    await workflow.tick();
    run = await repo.findOneByOrFail({ id: run.id });
    assert.equal(run.status, 'running');
    assert.deepEqual([run.session_manager_id, run.session_cli, run.session_id, run.room_id], [hostId, spec.cli, sessionId, '']);
    assert.equal(calls.open.length, 1);
    assert.equal(calls.open[0].userId, owner.id);
    assert.equal(calls.open[0].input.cwd, spec.working_dir);
    assert.match(calls.open[0].input.title, /Session example/);
    assert.equal(calls.prompt.length, 1);
    assert.equal(calls.prompt[0].id, sessionId);
    assert.match(calls.prompt[0].text, /complete_business_task_run/);
    assert.match(calls.prompt[0].text, /이 세션은 Business 업무 화면에 그대로 보이며/);
    assert.equal(roomSend.mock.callCount(), 0);
    assert.deepEqual((await business.taskDetail(company.id, account.id, taskId)).session, { manager_id: hostId, cli: spec.cli, session_id: sessionId });
  });

  await t.test('only that session can submit the result — not the runtime identity, another session or another Host', async () => {
    await assert.rejects(workflow.complete(account.id, run.id, result, { agentId: hostId, runtimeKey: runtimeIdentityKey(spec) }), /지정된/);
    await assert.rejects(workflow.complete(account.id, run.id, result, { agentId: hostId, agentSessionId: randomUUID() }), /지정된/);
    await assert.rejects(workflow.complete(account.id, run.id, result, { agentId: randomUUID(), agentSessionId: sessionId }), /지정된/);
    await assert.rejects(workflow.complete(account.id, run.id, result, { agentId: hostId }), /지정된/);
    // 실행 중인 그 세션은 스스로 새 실행을 요청할 수 없다.
    await assert.rejects(workflow.assertIndependentCaller(account.id, viaSession), /스스로/);
    const saved = await workflow.complete(account.id, run.id, result, viaSession);
    assert.equal(saved.status, 'needs_input');
    // 재개된 세션의 연결은 세션 id 를 그대로 보낸다 — 같은 제출은 멱등이다.
    assert.equal((await workflow.complete(account.id, run.id, result, { agentId: hostId, agentSessionId: sessionId })).id, saved.id);
    const journal = await business.taskDetail(company.id, account.id, taskId);
    assert.equal(journal.result.content, result.summary);
    assert.equal(journal.result.author_type, 'agent');
    await workflow.assertIndependentCaller(account.id, viaSession);
  });

  let next;
  await t.test('a follow-up waits while the user is talking in the session, then continues the same session without reopening it', async () => {
    next = await workflow.start(company.id, account.id, taskId, { request_id: randomUUID(), content: '추천안으로 진행해 주세요.' }, actor);
    status = 'busy';
    await workflow.tick();
    next = await repo.findOneByOrFail({ id: next.id });
    assert.equal(next.status, 'queued');
    assert.match(next.last_error, /다른 대화/);
    assert.equal(calls.prompt.length, 1);
    status = 'ready';
    await workflow.tick();
    next = await repo.findOneByOrFail({ id: next.id });
    assert.equal(next.status, 'running');
    assert.equal(next.session_id, sessionId);
    assert.equal(calls.open.length, 1, 'the existing session is prompted, not reopened');
    assert.equal(calls.prompt.length, 2);
    await workflow.complete(account.id, next.id, { ...result, summary: '추천안 기준 초안을 준비했습니다.', question: '초안을 확인해 주세요.' }, viaSession);
  });

  await t.test('a failed prompt keeps the request, marks it for review and still shows the session', async () => {
    const retry = await workflow.start(company.id, account.id, taskId, { request_id: randomUUID(), content: '수정 요청' }, actor);
    promptError = new Error('This Runtime Host is not connected right now.');
    await workflow.tick(); promptError = null;
    const failed = await repo.findOneByOrFail({ id: retry.id });
    assert.equal(failed.status, 'failed');
    assert.match(failed.last_error, /세션에 요청을 보내지 못했습니다.*not connected/);
    const journal = await business.taskDetail(company.id, account.id, taskId);
    assert.ok(journal.open_requests.some(entry => entry.content === '수정 요청'));
    assert.equal(journal.session.session_id, sessionId, 'the session stays attached so the user can look and continue');
    // 실패한 요청 뒤의 다음 요청도 같은 세션을 이어 쓴다.
    const again = await workflow.start(company.id, account.id, taskId, { request_id: randomUUID(), content: '다시 진행' }, actor);
    await workflow.tick();
    assert.equal((await repo.findOneByOrFail({ id: again.id })).session_id, sessionId);
    assert.equal(calls.open.length, 1);
  });

  await t.test('a Host that cannot open sessions for that CLI falls back to the execution conversation', async () => {
    roomSend.mock.restore();
    const other = await business.create(account.id, { name: 'Room example' }, owner.id, false);
    const roomOnly = new BusinessWorkflowService(ds, business, messaging, registry, { ...sessions, listHosts: async () => [{ manager_id: hostId, clis: [] }] });
    const legacy = await roomOnly.start(other.id, account.id, null, { request_id: randomUUID(), content: '조사해 주세요.', agent_runtime: spec }, actor);
    await roomOnly.tick();
    const row = await repo.findOneByOrFail({ id: legacy.id });
    assert.equal(row.status, 'running'); assert.ok(row.room_id); assert.equal(row.session_id, '');
    assert.equal((await business.taskDetail(other.id, account.id, row.task_id)).session, null);

    // 그 업무가 끝난 뒤 업무 상세에 들어오면: 실행 중에는 만들지 않고, 끝났으면 세션을 열어 현황 요약만 시킨다.
    // 그 실행이 아직 "실행 중" 으로 남아 있어도(죽었는지 알 수 없다) 업무 상세에 들어오면 세션을 연다.
    const opens = calls.open.length; const prompts = calls.prompt.length;
    const [first, second] = await Promise.all([workflow.ensureSession(other.id, account.id, row.task_id), workflow.ensureSession(other.id, account.id, row.task_id)]);
    assert.deepEqual(first, { manager_id: hostId, cli: spec.cli, session_id: sessionId });
    assert.deepEqual(second, first);
    assert.equal(calls.open.length, opens + 1, 'concurrent entries open one session');
    assert.equal(calls.prompt.length, prompts + 1);
    assert.match(calls.prompt.at(-1).text, /지금 새 작업을 시작하지 마세요/);
    assert.match(calls.prompt.at(-1).text, /아직 "실행 중"으로 표시된 요청/);
    // 응답 없는 실행은 사용자가 중단으로 표시한다 — 요청은 남고, 끝난 실행은 다시 중단할 수 없다.
    await assert.rejects(workflow.abandon(company.id, account.id, legacy.id), /찾을 수 없/);
    const stopped = await workflow.abandon(other.id, account.id, legacy.id);
    assert.equal(stopped.status, 'failed'); assert.match(stopped.last_error, /중단으로 표시/);
    await assert.rejects(workflow.abandon(other.id, account.id, legacy.id), /진행 중인 실행이 아닙니다/);
    // 이어서 요청하면 그 세션으로 간다.
    const resumed = await workflow.start(other.id, account.id, row.task_id, { request_id: randomUUID(), content: '이어서 진행' }, actor);
    await workflow.tick();
    assert.equal((await repo.findOneByOrFail({ id: resumed.id })).session_id, sessionId);
    await workflow.complete(account.id, resumed.id, result, viaSession);
    assert.deepEqual((await business.taskDetail(other.id, account.id, row.task_id)).session, first);
    await workflow.ensureSession(other.id, account.id, row.task_id);
    assert.equal(calls.open.length, opens + 1, 'an existing session is returned, not reopened');
    // 맡긴 적 없는 업무에는 만들지 않는다.
    const untouched = (await business.detail(other.id, account.id)).tasks.find(item => item.id !== row.task_id);
    assert.equal(await workflow.ensureSession(other.id, account.id, untouched.id), null);
  });
});
