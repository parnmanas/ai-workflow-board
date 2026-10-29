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
import { activityEvents } from '../dist/services/activity.service.js';

test('Business work executes without tickets, persists outcomes and resumes the same work', { timeout: 120000 }, async t => {
  const { app, port, modules } = await bootApp(); t.after(() => closeTestApp(app));
  const ds = app.get(modules.getDataSourceToken());
  const business = app.get(BusinessService); const workflow = app.get(BusinessWorkflowService);
  workflow.onModuleDestroy();
  const owner = await createUser(app, modules.getDataSourceToken, { name: 'Business runner' });
  const other = await createUser(app, modules.getDataSourceToken, { name: 'Other runner' });
  const account = await createAccount(app, modules.getDataSourceToken, 'Business execution', { ownerUserId: owner.id });
  const foreign = await createAccount(app, modules.getDataSourceToken, 'Foreign execution', { ownerUserId: other.id });
  const agent = await createAgent(app, modules.getDataSourceToken, account.id, { name: 'Formation assistant', runtime: true });
  const spec = agent.runtime_spec;
  const actor = { id: owner.id, name: owner.name, type: 'user' };
  const caller = { agentId: spec.manager_agent_id, runtimeKey: runtimeIdentityKey(spec) };
  const company = await business.create(account.id, { name: 'Formation example' }, owner.id, false);
  const token = app.get(modules.AuthService).createSession(owner.id);
  const repo = ds.getRepository('BusinessTaskRun');
  let online = false;
  const registry = app.get(InstanceRegistryService);
  t.mock.method(registry, 'listForAccount', id => online && id === account.id ? [{ mode: 'manager', host_id: spec.manager_agent_id, cli_adapters: [spec.cli] }] : []);
  const events = []; const onMessage = event => events.push(event);
  activityEvents.on('chat_room_message', onMessage); t.after(() => activityEvents.off('chat_room_message', onMessage));
  const request = { request_id: randomUUID(), content: '회사 설립을 조사하고 신청서와 비용 비교를 준비해 주세요.', agent_runtime: spec };
  const response = await fetch(`http://127.0.0.1:${port}/api/business/companies/${company.id}/formation-work`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'X-Account-Id': account.id }, body: JSON.stringify(request),
  });
  assert.equal(response.status, 201); let run = await response.json();
  const taskId = run.task_id;

  await t.test('initial request is atomic, retry-safe and waits for its own Host', async () => {
    assert.equal(run.status, 'queued');
    assert.equal((await business.detail(company.id, account.id)).company.formation_task_id, taskId);
    assert.equal((await workflow.start(company.id, account.id, null, request, actor)).id, run.id);
    await assert.rejects(workflow.start(company.id, account.id, null, { ...request, content: 'Different content' }, actor), /ID/);
    await assert.rejects(workflow.start(company.id, foreign.id, null, { ...request, request_id: randomUUID() }, actor), /회사를/);
    await workflow.tick();
    assert.equal(events.length, 0);
    assert.equal((await repo.findOneByOrFail({ id: run.id })).status, 'queued');
    assert.match((await repo.findOneByOrFail({ id: run.id })).last_error, /연결/);
    assert.equal(await ds.getRepository('Ticket').countBy({ account_id: account.id }), 0);
    const current = await business.taskDetail(company.id, account.id, taskId);
    assert.equal(current.open_requests.length, 1);
    assert.equal(current.open_requests[0].content, request.content);
  });
  await t.test('two dispatchers emit one real execution event, including the runtime and direct-work flag', async () => {
    online = true;
    const second = new BusinessWorkflowService(ds, business, app.get(RoomMessagingService), registry);
    await Promise.all([workflow.tick(), second.tick()]);
    run = await repo.findOneByOrFail({ id: run.id });
    assert.equal(run.status, 'running'); assert.ok(run.room_id); assert.ok(run.dispatch_message_id);
    const sends = events.filter(event => event.room_id === run.room_id && event.sender_type === 'user');
    assert.equal(sends.length, 1);
    assert.equal(sends[0].is_action_room, true);
    assert.equal(sends[0].agent_member_runtimes[caller.runtimeKey].manager_agent_id, spec.manager_agent_id);
    assert.match(sends[0].content, /complete_business_task_run/);
    assert.match(sends[0].content, /티켓을 만들거나 사용자에게 결과를 대신 기록하라고 하지 마세요/);
    assert.equal((await ds.getRepository('ChatRoom').findOneByOrFail({ id: run.room_id })).run_kind, 'business');
  });
  const result = { status: 'needs_input', summary: '설립 방식과 비용 비교 및 신청 초안을 준비했습니다. [근거](https://example.test/source)', question: '등록 대행 서비스의 비용 비교를 확인하고 사용할 서비스를 선택해 주세요.' };
  const followup = { request_id: randomUUID(), content: '추천한 서비스 기준으로 준비해 주세요.' };
  let next;
  await t.test('running follow-up is queued; only the assigned runtime can save the outcome', async () => {
    next = await workflow.start(company.id, account.id, taskId, followup, actor);
    await workflow.tick();
    assert.equal((await repo.findOneByOrFail({ id: next.id })).status, 'queued');
    await assert.rejects(workflow.complete(account.id, run.id, result, { ...caller, agentId: randomUUID() }), /지정된/);
    await assert.rejects(workflow.complete(account.id, run.id, result, { ...caller, runtimeKey: 'rt-0000000000000000' }), /지정된/);
    await assert.rejects(workflow.complete(account.id, run.id, result, { ...caller, subagentTriggerId: randomUUID() }), /지정된/);
    const saved = await workflow.complete(account.id, run.id, result, caller);
    assert.equal(saved.status, 'needs_input');
    assert.equal((await workflow.complete(account.id, run.id, result, caller)).id, saved.id);
    const journal = await business.taskDetail(company.id, account.id, taskId);
    assert.equal(journal.result.content, result.summary);
    assert.equal(journal.task.status, 'waiting');
    assert.equal(journal.open_requests.length, 1);
    assert.equal(journal.open_requests[0].content, followup.content);
    assert.equal(journal.entries.filter(entry => entry.kind === 'result').length, 1);
  });
  await t.test('follow-up resumes the same conversation and cannot report research as legal formation', async () => {
    await workflow.tick(); next = await repo.findOneByOrFail({ id: next.id });
    assert.equal(next.status, 'running'); assert.equal(next.room_id, run.room_id);
    await assert.rejects(workflow.complete(account.id, next.id, { status: 'completed', summary: 'Research done' }, caller), /실제 설립/);
    assert.equal((await repo.findOneByOrFail({ id: next.id })).status, 'running', 'failed completion rolls back its state');
    const secondResult = { ...result, summary: '수정된 신청 초안을 준비했습니다. 기존 비교 자료도 유지합니다.', question: '초안의 이름과 사업 목적을 확인해 주세요.' };
    await workflow.complete(account.id, next.id, secondResult, caller);
    const journal = await business.taskDetail(company.id, account.id, taskId);
    assert.equal(journal.result.content, secondResult.summary);
    assert.equal(journal.entries.filter(entry => entry.kind === 'result').length, 2);
    assert.equal(journal.open_requests.length, 0);
    assert.equal(await ds.getRepository('Ticket').countBy({ account_id: account.id }), 0);
  });
  await t.test('a worker error preserves requests and cannot leave execution falsely running', async () => {
    const retry = await workflow.start(company.id, account.id, taskId, { request_id: randomUUID(), content: '수정 요청 처리' }, actor);
    const send = t.mock.method(app.get(RoomMessagingService), 'sendMessage', async () => { throw new Error('dispatch failed'); });
    try { await workflow.tick(); } finally { send.mock.restore(); }
    const failed = await repo.findOneByOrFail({ id: retry.id });
    assert.equal(failed.status, 'failed'); assert.match(failed.last_error, /시작하지 못/);
    assert.equal((await business.taskDetail(company.id, account.id, taskId)).task.status, 'waiting');
    assert.ok((await business.taskDetail(company.id, account.id, taskId)).open_requests.some(entry => entry.content === '수정 요청 처리'));
  });
  await t.test('permission revocation prevents a queued request from starting', async () => {
    const pending = await workflow.start(company.id, account.id, taskId, { request_id: randomUUID(), content: '권한 확인' }, actor);
    await ds.getRepository('User').update({ id: owner.id }, { status: 'disabled' });
    const count = events.length; await workflow.tick();
    assert.equal(events.length, count);
    assert.equal((await repo.findOneByOrFail({ id: pending.id })).status, 'failed');
  });
});
