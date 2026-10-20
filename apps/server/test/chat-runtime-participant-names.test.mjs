// Spec-direct (rt-) chat participants display as `<Host>/<label>` on every chat
// surface (docs/runbooks/agent-display-name.md).
//
// A room created with inline RuntimeSpecs seats each agent under an `rt-` key —
// an execution address, not a name. Every name lookup used to key on the id
// alone, so a multi-agent room rendered as "human, Unknown, Unknown": the auto
// group name, the room detail roster, the room list, history sender names, and
// the live SSE frame (agent-api passes 'Agent', MCP the bare Host name) all lost
// which agent was which. The name's source is the participant row's spec
// snapshot; this drives the real REST + agent-api surfaces end to end.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { bootApp } from './helpers/boot.mjs';
import { createAccount, createAgent, createApiKey, createUser } from './helpers/fixtures.mjs';
import { openSseStream } from './helpers/sse-listener.mjs';

process.env.PORT = process.env.TEST_SERVER_PORT || '0';

const { app, port, modules } = await bootApp({ port: parseInt(process.env.PORT, 10) });
after(() => { void app.close().catch(() => {}); });
const { getDataSourceToken, AuthService } = modules;
const ds = app.get(getDataSourceToken());
const base = `http://localhost:${port}`;

const ws = await createAccount(app, getDataSourceToken, 'chat-rt-names');
const user = await createUser(app, getDataSourceToken, { name: 'human' });
const userToken = app.get(AuthService).createSession(user.id);
// One Runtime Host carrying two runtimes — the case a bare Host name cannot tell apart.
const host = await createAgent(app, getDataSourceToken, ws.id, { name: 'box', type: 'manager' });
const hostKey = await createApiKey(app, getDataSourceToken, host.id, { accountId: ws.id, label: 'rt-names-host' });

const runtime = (label) => ({
  manager_agent_id: host.id,
  cli: 'claude',
  model: null,
  working_dir: `/tmp/qa/rt-names/${label}`,
  credential_id: null,
  label,
  runtime_config: { strategy: 'single', permission_mode: 'strict' },
});
const REVIEWER = `${host.name}/reviewer`;
const WRITER = `${host.name}/writer`;

const userHeaders = {
  'Content-Type': 'application/json',
  Authorization: `Bearer ${userToken}`,
  'X-Account-Id': ws.id,
};

async function api(method, path, body) {
  const res = await fetch(`${base}/api${path}`, {
    method,
    headers: userHeaders,
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  assert.ok(res.ok, `${method} ${path} → ${res.status}: ${text}`);
  return text ? JSON.parse(text) : null;
}

function agentIdNamed(participants, name) {
  const found = participants.find((p) => (p.participant_type ?? p.type) === 'agent' && p.name === name);
  assert.ok(found, `no agent participant named "${name}" in ${JSON.stringify(participants)}`);
  return found.participant_id ?? found.id;
}

test('group room: auto name, detail, room list and observer list name each runtime', async () => {
  const { room } = await api('POST', '/chat-rooms', {
    participants: [
      { participant_type: 'agent', participant_id: '', runtime: runtime('reviewer') },
      { participant_type: 'agent', participant_id: '', runtime: runtime('writer') },
    ],
  });

  assert.equal(room.type, 'group');
  assert.equal(room.name, `${user.name}, ${REVIEWER}, ${WRITER}`, 'auto group name');
  const detailNames = room.participants.map((p) => p.name).sort();
  assert.deepEqual(detailNames, [REVIEWER, user.name, WRITER].sort(), 'room detail roster');

  const listed = (await api('GET', '/chat-rooms')).find((r) => r.id === room.id);
  assert.ok(listed, 'room is in the caller list');
  assert.deepEqual(listed.participants.map((p) => p.name).sort(), detailNames, 'room list projection');

  const observed = (await api('GET', '/chat-rooms?scope=account')).find((r) => r.id === room.id);
  assert.ok(observed, 'room is in the observer list');
  assert.deepEqual(observed.participants.map((p) => p.name).sort(), detailNames, 'observer list projection');
});

test('agent messages and typing carry the sending runtime name, live and in history', async () => {
  const { room } = await api('POST', '/chat-rooms', {
    participants: [
      { participant_type: 'agent', participant_id: '', runtime: runtime('reviewer') },
      { participant_type: 'agent', participant_id: '', runtime: runtime('writer') },
    ],
  });
  const writerId = agentIdNamed(room.participants, WRITER);
  assert.match(writerId, /^rt-[0-9a-f]{16}$/);

  const stream = await openSseStream(port, userToken);
  after(() => stream.close());
  await new Promise((r) => setTimeout(r, 250));

  const agentPost = (path, body) => fetch(`${base}/api/agent/chat-rooms/${room.id}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Agent-Key': hostKey.raw_key },
    body: JSON.stringify({ agent_id: writerId, ...body }),
  });

  const typingRes = await agentPost('/typing', { agent_name: 'writer', is_typing: true });
  assert.ok(typingRes.ok, `typing → ${typingRes.status}: ${await typingRes.text()}`);
  const typing = await stream.waitFor('chat_room_typing', (d) => d.room_id === room.id, 4000);
  assert.equal(typing.data.agent_name, WRITER, 'typing indicator names the runtime');

  const sendRes = await agentPost('/messages', { content: 'draft is ready' });
  const sendText = await sendRes.text();
  assert.ok(sendRes.ok, `agent message → ${sendRes.status}: ${sendText}`);
  assert.equal(JSON.parse(sendText).sender_name, WRITER, 'send response sender_name');
  const live = await stream.waitFor(
    'chat_room_message',
    (d) => d.room_id === room.id && d.content === 'draft is ready',
    4000,
  );
  assert.equal(live.data.sender_name, WRITER, 'live SSE sender_name');

  const history = await api('GET', `/chat-rooms/${room.id}/messages`);
  const fromWriter = history.find((m) => m.content === 'draft is ready');
  assert.ok(fromWriter, 'agent message is in history');
  assert.equal(fromWriter.sender_name, WRITER, 'history sender_name');
});

test('DM promoted to group by inviting a runtime names both runtimes', async () => {
  const { room } = await api('POST', '/chat-rooms', {
    participants: [{ participant_type: 'agent', participant_id: '', runtime: runtime('reviewer') }],
  });
  assert.equal(room.type, 'dm');
  assert.equal(room.dm_partner_name, REVIEWER, 'DM partner name');

  await api('POST', `/chat-rooms/${room.id}/participants`, {
    participants: [{ participant_type: 'agent', participant_id: '', runtime: runtime('writer') }],
  });
  const promoted = await api('GET', `/chat-rooms/${room.id}`);
  assert.equal(promoted.type, 'group');
  const expected = [user.name, REVIEWER, WRITER];
  assert.deepEqual(promoted.name.split(', ').sort(), expected.sort(), 'promoted auto name');
  assert.deepEqual(promoted.participants.map((p) => p.name).sort(), expected.sort());
  const stored = await ds.getRepository('ChatRoom').findOneByOrFail({ id: room.id });
  assert.ok(!/Unknown/.test(stored.name), `stored name must not contain Unknown: ${stored.name}`);
});
