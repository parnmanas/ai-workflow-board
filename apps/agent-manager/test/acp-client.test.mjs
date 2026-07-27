import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  AcpClient,
  AcpProtocolError,
} from '../dist/lib/runtime/acp/acp-client.js';

const fixture = fileURLToPath(
  new URL('./fixtures/fake-acp-server.mjs', import.meta.url),
);

async function createClient(options = {}) {
  const events = [];
  const stderr = [];
  const client = await AcpClient.spawn({
    command: process.execPath,
    args: [fixture],
    requestTimeoutMs: 500,
    onEvent: (event) => events.push(event),
    onStderr: (line) => stderr.push(line),
    onPermissionRequest: async (request) => {
      assert.equal(request.sessionId, 'session-1');
      return { outcome: 'selected', optionId: 'allow-once' };
    },
    ...options,
  });
  return { client, events, stderr };
}

test('ACP lifecycle correlates requests and normalizes updates', async (t) => {
  const { client, events, stderr } = await createClient();
  t.after(() => client.close());

  const initialized = await client.initialize({
    clientInfo: { name: 'awb-runtime-host', version: '1.0.0' },
  });
  assert.equal(initialized.protocolVersion, 1);
  assert.equal(initialized.agentInfo.name, 'fake-hermes');

  const session = await client.newSession({ cwd: process.cwd(), mcpServers: [] });
  assert.equal(session.sessionId, 'session-1');
  await client.loadSession({
    sessionId: session.sessionId,
    cwd: process.cwd(),
    mcpServers: [],
  });

  const response = await client.prompt({
    sessionId: session.sessionId,
    prompt: [{ type: 'text', text: 'work' }],
  });
  assert.equal(response.stopReason, 'end_turn');
  assert.deepEqual(
    events.map((event) => event.type),
    ['reasoning_delta', 'message_delta', 'tool_started', 'tool_completed', 'usage'],
  );
  assert.equal(events[1].text, 'hello');
  assert.equal(events[2].toolCallId, 'tool-1');
  assert.equal(events[4].totalTokens, 21);

  await client.cancel(session.sessionId);
  await client.closeSession(session.sessionId);

  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(
    events.some((event) => event.type === 'diagnostic'
      && event.method === 'test/cancelled'),
    true,
  );
  assert.equal(stderr.some((line) => line.includes('super-secret')), false);
  assert.equal(stderr.some((line) => line.includes('[REDACTED]')), true);
});

test('ACP request timeout rejects with a typed protocol error', async (t) => {
  const { client } = await createClient({ requestTimeoutMs: 30 });
  t.after(() => client.close());
  await assert.rejects(
    client.request('test/hang', {}),
    (error) => error instanceof AcpProtocolError && error.code === 'acp_timeout',
  );
});

test('malformed stdout is a fatal protocol error and rejects pending requests', async (t) => {
  const { client } = await createClient();
  t.after(() => client.close());
  await assert.rejects(
    client.request('test/malformed', {}),
    (error) => error instanceof AcpProtocolError
      && error.code === 'acp_malformed_message',
  );
  await assert.rejects(
    client.request('initialize', {}),
    (error) => error instanceof AcpProtocolError
      && error.code === 'acp_malformed_message',
  );
});

test('EOF rejects all pending requests and records process exit', async (t) => {
  const { client } = await createClient();
  t.after(() => client.close());
  await assert.rejects(
    client.request('test/exit', {}),
    (error) => error instanceof AcpProtocolError
      && error.code === 'acp_process_exited'
      && error.exitCode === 17,
  );
});
