// Agent Session 라이브 상태를 하트비트에 싣는다 — 서버가 유령 busy/awaiting_* 를 30초 안에 되돌리는 근거.
//   1. InstanceHeartbeat 는 agentSessionsProvider 가 배선되면 비어 있어도 `agent_sessions: []` 를 보낸다
//      ("살아 있는 세션 없음" 이 정보다). 배선되지 않으면 필드를 생략한다(구버전 서버/매니저 호환).
//   2. AgentSessionRunner.liveStates() 는 살아 있는 세션과 서버 contract 의 status 를 준다.
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { InstanceHeartbeat } from '../dist/lib/instance-heartbeat.js';
import { AgentSessionRunner } from '../dist/lib/agent-session-runner.js';
import { AgentSessionStore } from '../dist/lib/agent-session-store.js';

const fixture = fileURLToPath(new URL('./fixtures/fake-acp-server.mjs', import.meta.url));

function stubFetch(t, { capture = () => {} } = {}) {
  const originalFetch = globalThis.fetch;
  let resolvePayload;
  const payloadPromise = new Promise((resolve) => { resolvePayload = resolve; });
  globalThis.fetch = async (url, init) => {
    const body = init?.body ? JSON.parse(init.body) : null;
    capture(String(url), body);
    if (String(url).includes('/api/agent/instance-heartbeat')) resolvePayload(body);
    return new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } });
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  return payloadPromise;
}

function heartbeatWith(meta) {
  return new InstanceHeartbeat({ url: 'http://awb.invalid', apiKey: 'secret', workspace_id: 'ws-1' }, 'manager-1', {
    mode: 'manager', version: 'test', cli: 'mixed', cliAdapters: [], ...meta,
  });
}

test('heartbeat carries agent_sessions when a provider is wired — an empty list is sent on purpose', async (t) => {
  const payloadPromise = stubFetch(t);
  const heartbeat = heartbeatWith({ agentSessionsProvider: () => [] });
  t.after(() => heartbeat.stop());
  heartbeat.start();
  const payload = await payloadPromise;
  assert.deepEqual(payload.agent_sessions, [], 'no live sessions is reported as [] so the server can clear ghosts');
});

test('heartbeat omits agent_sessions without a provider, and a throwing provider skips the field for that tick', async (t) => {
  const first = stubFetch(t);
  const plain = heartbeatWith({});
  t.after(() => plain.stop());
  plain.start();
  assert.equal('agent_sessions' in (await first), false);
  plain.stop();

  const second = stubFetch(t);
  const throwing = heartbeatWith({ agentSessionsProvider: () => { throw new Error('boom'); } });
  t.after(() => throwing.stop());
  throwing.start();
  assert.equal('agent_sessions' in (await second), false, 'provider failure never wedges the heartbeat');
});

test('heartbeat forwards the runner live states with their contract status', async (t) => {
  const payloadPromise = stubFetch(t);
  const heartbeat = heartbeatWith({
    agentSessionsProvider: () => [
      { cli: 'claude', session_id: 's-1', status: 'busy' },
      { cli: 'codex', session_id: 's-2', status: 'awaiting_permission' },
      { bogus: true },
    ],
  });
  t.after(() => heartbeat.stop());
  heartbeat.start();
  const payload = await payloadPromise;
  assert.deepEqual(payload.agent_sessions, [
    { cli: 'claude', session_id: 's-1', status: 'busy' },
    { cli: 'codex', session_id: 's-2', status: 'awaiting_permission' },
  ], 'malformed entries are dropped');
});

test('AgentSessionRunner.liveStates lists open sessions with their status and forgets closed ones', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'awb-session-heartbeat-'));
  const cwd = join(root, 'work');
  await mkdir(cwd, { recursive: true });
  const calls = [];
  stubFetch(t, { capture: (url, body) => calls.push({ url, body }) });
  const runner = new AgentSessionRunner(
    { url: 'http://127.0.0.1:0', apiKey: 'manager-key' },
    {
      getManagerId: () => 'manager-1',
      store: new AgentSessionStore({ claudeHome: join(root, 'claude'), codexHome: join(root, 'codex'), indexPath: join(root, 'index.json') }),
      commandResolver: async () => ({ command: process.execPath, args: [fixture] }),
      flushIntervalMs: 10, idleMinutes: 0, permissionTimeoutMs: 5000, requestTimeoutMs: 10_000, promptTimeoutMs: 20_000,
    },
  );
  t.after(async () => { await runner.stopAll('test').catch(() => undefined); await rm(root, { recursive: true, force: true }); });
  assert.deepEqual(runner.liveStates(), []);
  const request = (op, extra) => ({ manager_id: 'manager-1', cli: 'claude', op, driver_user_id: 'user-1', issued_at: new Date().toISOString(), ...extra });
  await runner.handle(request('open', { request_id: 'rpc-open', session_id: null, cwd, title: 'hb' }));
  const opened = calls.find((c) => c.url.endsWith('/api/agent/sessions/rpc/rpc-open')).body;
  const sid = opened.result.session_id;
  assert.deepEqual(runner.liveStates(), [{ cli: 'claude', session_id: sid, status: 'ready' }]);
  const turn = runner.handle(request('prompt', { session_id: sid, turn_id: 't-1', text: 'hello' }));
  const started = Date.now();
  while (runner.liveStates()[0]?.status !== 'awaiting_permission' && Date.now() - started < 8000) await new Promise((r) => setTimeout(r, 20));
  assert.equal(runner.liveStates()[0]?.status, 'awaiting_permission', 'a pending permission shows as awaiting_permission');
  const permission = calls.map((c) => c.body).filter((b) => Array.isArray(b?.events)).flatMap((b) => b.events).find((e) => e.type === 'permission_request');
  await runner.handle(request('permission', { session_id: sid, permission_request_id: permission.payload.request_id, option_id: 'allow-once' }));
  await turn;
  assert.equal(runner.liveStates()[0]?.status, 'ready');
  await runner.handle(request('close', { session_id: sid }));
  assert.deepEqual(runner.liveStates(), [], 'closed sessions are not reported');
});
