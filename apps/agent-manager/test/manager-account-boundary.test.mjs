import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('manager refuses missing, foreign and contradictory account stamps before invoking a runner', async t => {
  const previousHome = process.env.AWB_AGENT_MANAGER_HOME;
  const managerHome = mkdtempSync(join(tmpdir(), 'awb-account-boundary-'));
  process.env.AWB_AGENT_MANAGER_HOME = managerHome;
  t.after(() => {
    if (previousHome === undefined) delete process.env.AWB_AGENT_MANAGER_HOME;
    else process.env.AWB_AGENT_MANAGER_HOME = previousHome;
    rmSync(managerHome, { recursive: true, force: true });
  });
  const { EventDispatcher } = await import('../dist/lib/event-dispatcher.js');
  const received = [];
  const dispatcher = new EventDispatcher({ url: 'http://127.0.0.1:1', apiKey: 'unused', account_id: 'account-a' }, {
    agentManagerCommandHandler: { handle: async raw => { received.push(raw); } },
  });
  const routes = {
    agent_trigger: 'handleTrigger', board_update: 'handleBoardUpdate', chat_request: 'handleChatRequest',
    chat_room_message: 'handleChatRoomMessage', comment_mention: 'handleCommentMention', fs_request: 'handleFsRequest',
    agent_session_request: 'handleAgentSessionRequest', terminal_request: 'handleTerminalRequest', cli_memory_request: 'handleMemoryRequest',
  };
  for (const method of Object.values(routes)) dispatcher[method] = async raw => { received.push(raw); };
  for (const type of [...Object.keys(routes), 'agent_manager_command']) {
    for (const event of [{}, { account_id: 'account-b' }, { account_id: 'account-a', payload: { account_id: 'account-b' } }]) {
      await dispatcher.dispatch(type, JSON.stringify(event));
    }
    assert.equal(received.length, 0, `${type} must not reach a runner outside its owner`);
    for (const event of [{ account_id: 'account-a' }, { scope: { account_id: 'account-a' }, payload: {} }]) {
      await dispatcher.dispatch(type, JSON.stringify(event));
    }
    assert.equal(received.length, 2, `${type} still reaches its own account`);
    received.length = 0;
  }
  const unassigned = new EventDispatcher({ url: 'http://127.0.0.1:1', apiKey: 'unused' });
  unassigned.handleTrigger = async () => { received.push('unassigned'); };
  await unassigned.dispatch('agent_trigger', JSON.stringify({ account_id: 'account-a' }));
  assert.deepEqual(received, []);

  await t.test('durable retries cannot replay a different account after rebinding', async () => {
    let replay;
    const retried = [];
    const dispatcher = new EventDispatcher({ url: 'http://127.0.0.1:1', apiKey: 'unused', account_id: 'account-a' }, {
      sessionLimitDeferStore: { setResumeHandler(handler) { replay = handler; }, load() {} },
    });
    dispatcher.handleTrigger = async raw => retried.push(JSON.parse(raw));
    dispatcher.handleCommentMention = async raw => retried.push(JSON.parse(raw));
    for (const kind of ['trigger', 'mention']) {
      for (const event of [{}, { account_id: 'account-b' }]) await replay({ kind, raw: JSON.stringify(event) }, () => {});
    }
    assert.deepEqual(retried, []);
    await replay({ kind: 'trigger', raw: '{"account_id":"account-a"}' }, () => {});
    assert.equal(retried.length, 1);
  });

  await t.test('the authenticated stream binds a saved legacy account before dispatching work', async () => {
    const { EventStream } = await import('../dist/lib/event-stream.js');
    const originalFetch = globalThis.fetch;
    const config = { url: 'http://127.0.0.1:1', apiKey: 'unused', account_id: 'old-account' };
    const connectedOwners = [];
    let receivedCommand;
    const received = new Promise(resolve => { receivedCommand = resolve; });
    globalThis.fetch = async (_url, options) => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(
          'event: agent_manager_command\ndata: {"account_id":"old-account","command":"must-not-run"}\n\n' +
          'event: server_meta\ndata: {"chat_protocol_version":2,"account_id":"account-a"}\n\n' +
          'event: agent_manager_command\ndata: {"account_id":"account-a","command":"reload_config"}\n\n',
        ));
        options.signal.addEventListener('abort', () => controller.close(), { once: true });
      },
    }), { status: 200 });
    const stream = new EventStream({ config, onConnect: () => connectedOwners.push(config.account_id),
      deps: { agentManagerCommandHandler: { handle: async raw => receivedCommand(JSON.parse(raw)) } } });
    let timer;
    try {
      stream.start();
      const command = await Promise.race([received, new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new Error('command was not dispatched')), 1500); })]);
      assert.equal(config.account_id, 'account-a');
      assert.equal(command.command, 'reload_config');
      assert.deepEqual(connectedOwners, ['account-a']);
    } finally {
      clearTimeout(timer);
      stream.stop();
      globalThis.fetch = originalFetch;
    }
  });
});
