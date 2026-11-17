import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { bootApp, closeTestApp } from './helpers/boot.mjs';
import { createAccount, createAgent, createUser } from './helpers/fixtures.mjs';

test('chat settings use room ownership, preserve history and restart only the selected participant', async t => {
  const { app, port, modules } = await bootApp({ port: 0 });
  t.after(() => closeTestApp(app));
  const { getDataSourceToken, AuthService, activityEvents } = modules;
  const db = app.get(getDataSourceToken());
  const account = await createAccount(app, getDataSourceToken, 'chat-settings');
  const owner = await createUser(app, getDataSourceToken, { name: 'chat-settings-owner', role: 'user' });
  await db.getRepository('User').update(owner.id, { permissions: JSON.stringify(['chat.view', 'chat.send']) });
  const host = await createAgent(app, getDataSourceToken, account.id, { name: 'settings-host', type: 'manager' });
  const foreignOwner = await createUser(app, getDataSourceToken, { name: 'foreign-chat-settings-owner' });
  const foreign = await createAccount(app, getDataSourceToken, 'foreign-settings', { ownerUserId: foreignOwner.id });
  const headers = { Authorization: `Bearer ${app.get(AuthService).createSession(owner.id)}`, 'X-Account-Id': account.id, 'Content-Type': 'application/json' };
  async function call(method, path, body, extra = {}) {
    const response = await fetch(`http://127.0.0.1:${port}/api${path}`, { method, headers: { ...headers, ...extra }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null, text };
  }
  const { AgentManagerCommandService } = await import('../dist/modules/agent-manager/agent-manager-command.service.js');
  const { CommandLedgerService } = await import('../dist/modules/agent-manager/command-ledger.service.js');
  const commands = app.get(AgentManagerCommandService);
  const ledger = app.get(CommandLedgerService);
  const instance = { instance_id: 'chat-settings-instance', agent_id: host.id, host_id: host.id, account_id: account.id, manager_capabilities: ['chat_session_restart'] };
  let online = true;
  t.mock.method(commands, 'resolveLiveManagerInstance', id => online && id === host.id ? instance : null);
  const emitted = [];
  let ackStatus = 'ok';
  let holdAck = false;
  const ack = (command, status = ackStatus) => ledger.recordOutcome(ledger.consume(command.command_id), status,
    status === 'ok' ? JSON.stringify({ application: 'restarted' }) : 'fixture spawn failed');
  const listener = payload => { if (payload.command !== 'restart_chat_session') return; emitted.push(payload); if (!holdAck) ack(payload); };
  activityEvents.on('agent_manager_command', listener);
  t.after(() => activityEvents.off('agent_manager_command', listener));
  const runtime = { manager_agent_id: host.id, cli: 'claude', model: 'model-a', working_dir: '/tmp/chat-settings',
    credential_id: null, label: 'writer', role_prompt: '', runtime_config: { strategy: 'single', permission_mode: 'strict' } };
  const created = await call('POST', '/chat-rooms', { participants: [{ participant_type: 'agent', participant_id: '', runtime }] });
  assert.equal(created.status, 201, created.text);
  const room = created.body.room;
  const participant = room.participants.find(p => p.participant_type === 'agent');
  const route = `/chat-rooms/${room.id}/agents/${participant.id}`;
  const read = () => call('GET', `${route}/settings`);
  const restart = (revision, settings = {}) => call('POST', `${route}/restart`, { expected_revision: revision, settings });
  const credentialRepo = db.getRepository('Credential');
  const credential = await credentialRepo.save(credentialRepo.create({ account_id: account.id, name: 'own', provider: 'claude_api_key', encrypted_data: 'fixture-secret' }));
  const other = await credentialRepo.save(credentialRepo.create({ account_id: foreign.id, name: 'foreign', provider: 'claude_api_key', encrypted_data: 'foreign-secret' }));
  const wrongProvider = await credentialRepo.save(credentialRepo.create({ account_id: account.id, name: 'wrong-cli', provider: 'codex_oauth', encrypted_data: 'wrong-cli-secret' }));
  const global = await credentialRepo.save(credentialRepo.create({ account_id: null, name: 'global', provider: 'claude_api_key', encrypted_data: 'global-secret' }));
  const rows = db.getRepository('ChatRoomParticipant');

  await t.test('read is lazy and read-only; non-members and other accounts cannot edit', async () => {
    const count = await rows.count();
    const initial = await read();
    assert.equal(initial.status, 200, initial.text);
    assert.equal(initial.body.runtime.model, 'model-a');
    assert.equal(initial.body.can_restart, true);
    assert.deepEqual(initial.body.connection_settings.candidates.map(c => c.id).sort(), [credential.id, global.id].sort());
    assert.equal((await call('GET', `/agent-sessions/hosts/${host.id}/claude/settings`)).status, 403, 'chat access does not grant native session access');
    assert.equal(await rows.count(), count);
    assert.equal(emitted.length, 0);
    assert.ok(!JSON.stringify(initial.body).includes('secret'));
    const denied = await call('GET', `${route}/settings`, undefined, { Authorization: `Bearer ${app.get(AuthService).createSession(foreignOwner.id)}` });
    assert.equal(denied.status, 403, denied.text);
    const wrongScope = await call('POST', `${route}/restart`, { expected_revision: initial.body.revision }, {
      'X-Account-Id': foreign.id, Authorization: `Bearer ${app.get(AuthService).createSession(foreignOwner.id)}` });
    assert.ok([403, 404].includes(wrongScope.status), wrongScope.text);
  });

  await t.test('invalid, unsupported and stale changes never write or stop a process', async () => {
    const initial = (await read()).body;
    const before = await rows.findOneBy({ id: participant.id });
    for (const patch of [{ credential_id: other.id }, { credential_id: wrongProvider.id }, { credential_id: 'bad-id' },
      { credential_id: randomUUID() }, { cli_runtime_profile: 'missing-backend' }, { working_dir: '/different' },
      { runtime_config: { strategy: 'bad', permission_mode: 'trusted' } }]) {
      const result = await restart(initial.revision, patch);
      assert.ok(result.status >= 400 && result.status < 500, result.text);
      assert.deepEqual(await rows.findOneBy({ id: participant.id }), before);
      assert.equal(emitted.length, 0);
    }
    online = false;
    assert.equal((await read()).body.can_restart, false);
    assert.equal((await restart(initial.revision, { model: 'model-b' })).status, 409);
    online = true;
    instance.manager_capabilities = [];
    assert.equal((await restart(initial.revision, { model: 'model-b' })).status, 409);
    instance.manager_capabilities = ['chat_session_restart'];
    await rows.update(participant.id, { runtime_spec: { ...before.runtime_spec, role_prompt: 'new role' } });
    assert.equal((await restart(initial.revision, { model: 'model-b' })).status, 409);
    assert.equal(emitted.length, 0);
  });

  await t.test('credential, model and permission apply together; other rooms and old messages retain their state', async () => {
    const otherRoom = await call('POST', '/chat-rooms', { name: 'another room', participants: [{ participant_type: 'agent', participant_id: '', runtime }, { participant_type: 'agent', participant_id: '', runtime: { ...runtime, working_dir: '/tmp/second', label: 'second' } }] });
    const otherRows = await rows.findBy({ room_id: otherRoom.body.room.id });
    const messageRepo = db.getRepository('ChatRoomMessage');
    const message = await messageRepo.save(messageRepo.create({ room_id: room.id, account_id: account.id, sender_type: 'agent', sender_id: participant.participant_id, content: 'existing history', type: 'message' }));
    const initial = (await read()).body;
    const result = await restart(initial.revision, { credential_id: credential.id, model: 'model-b', runtime_config: { strategy: 'single', permission_mode: 'trusted' } });
    assert.equal(result.status, 200, result.text);
    assert.equal(result.body.runtime.credential_id, credential.id);
    assert.equal(result.body.runtime.model, 'model-b');
    assert.equal(result.body.application, 'restarted');
    assert.notEqual(result.body.participant_id, participant.participant_id);
    assert.equal(result.body.participant_row_id, participant.id);
    const command = emitted.at(-1);
    assert.equal(command.args.room_id, room.id);
    assert.equal(command.args.previous_agent_id, participant.participant_id);
    assert.equal(command.args.agent_id, result.body.participant_id);
    assert.equal(command.args.runtime.runtime_config.permission_mode, 'trusted');
    assert.deepEqual(await rows.findBy({ room_id: otherRoom.body.room.id }), otherRows);
    assert.ok(await messageRepo.findOneBy({ id: message.id, content: 'existing history' }));
    const history = await call('GET', `/chat-rooms/${room.id}/messages`);
    assert.equal(history.body.find(m => m.id === message.id).sender_name, `${host.name}/writer`);
    const detail = await call('GET', `/chat-rooms/${room.id}`);
    assert.equal(detail.body.participants.filter(p => p.participant_type === 'agent').length, 1);
    const globalResult = await restart(result.body.revision, { credential_id: global.id });
    assert.equal(globalResult.status, 200, globalResult.text);
    const cleared = await restart(globalResult.body.revision, { credential_id: null, model: null });
    assert.equal(cleared.status, 200, cleared.text);
    assert.equal(cleared.body.runtime.credential_id, null);
    assert.equal(cleared.body.runtime.model, null);
  });

  await t.test('concurrent clicks cannot restart twice; a host failure is visible and retryable', async () => {
    const initial = (await read()).body;
    holdAck = true;
    const count = emitted.length;
    const pending = restart(initial.revision, { model: 'model-c' });
    const deadline = Date.now() + 3000;
    while (emitted.length === count && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(emitted.length, count + 1);
    const duplicate = await restart(initial.revision, { model: 'model-c' });
    assert.equal(duplicate.status, 409, duplicate.text);
    ack(emitted.at(-1));
    assert.equal((await pending).status, 200);
    holdAck = false;
    ackStatus = 'error';
    const current = (await read()).body;
    const failed = await restart(current.revision, { model: 'model-d' });
    assert.equal(failed.status, 502, failed.text);
    assert.match(failed.body.error, /Settings saved.*fixture spawn failed/);
    const saved = (await read()).body;
    assert.equal(saved.runtime.model, 'model-d');
    ackStatus = 'ok';
    assert.equal((await restart(saved.revision)).status, 200);
  });
});
