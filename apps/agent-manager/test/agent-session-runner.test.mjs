// Agent Session(CLI 직접 세션) 러너 — fake-acp-server.mjs 픽스처로 실제 ACP 왕복을
// 돌리며 서버 contract(POST /api/agent/sessions/:id/events, PATCH /api/agent/sessions/:id)
// 로 무엇이 어떤 순서로 나가는지 고정한다(docs/agent-sessions.md).
//
//  1. open  → session/new → 'Session opened' system 행 + patch{status:'ready',
//             native_session_id, resume_supported}
//  2. prompt → 픽스처가 thought/message/tool_call/tool_call_update 를 스트리밍하고
//             session/request_permission 을 던진다 → 러너는 reasoning/text/tool_call/
//             tool_update/permission_request 를 순서대로 append 하고
//             patch{status:'awaiting_permission'} 을 보낸 뒤 결정을 기다린다.
//  3. permission → 픽스처가 usage_update + end_turn 으로 턴을 끝낸다 → usage + turn(finished)
//             + patch{status:'ready'}.
//  4. auto_allow 정책이면 사용자 결정 없이 decided_by:'policy' 로 즉시 진행한다.
//  5. native_session_id 가 있고 어댑터가 loadSession 을 지원하면 session/load 로 복원한다.
//  6. 부트스트랩되지 않은 agent(ctx 없음)면 서버에 status:'error' 를 patch 한다.
//  7. close → 프로세스가 종료되고 'Agent process stopped.' 가 남는다.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { AgentSessionRunner, resolveAcpCommandForRuntime } from '../dist/lib/agent-session-runner.js';

const fixture = fileURLToPath(new URL('./fixtures/fake-acp-server.mjs', import.meta.url));
const AGENT = 'agent-session-test';

function installFakeServer() {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const target = String(url);
    const method = init?.method || 'GET';
    const body = init?.body ? JSON.parse(init.body) : null;
    const apiKey = init?.headers?.['X-Agent-Key'];
    calls.push({ url: target, method, body, apiKey });
    return new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return {
    calls,
    restore: () => { globalThis.fetch = original; },
    events: () => calls
      .filter((c) => c.method === 'POST' && c.url.includes('/api/agent/sessions/'))
      .flatMap((c) => c.body.events.map((e) => ({ ...e, patch: c.body.patch ?? null }))),
  };
}

async function waitFor(predicate, label, timeoutMs = 8000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`timeout waiting for ${label}`);
}

function context(cwd, extra = {}) {
  return {
    agent_id: AGENT,
    workspace_id: 'ws-1',
    api_key: 'agent-api-key',
    cwd,
    cli: 'claude',
    cli_home_dir: join(cwd, 'cli-home'),
    extra_env: { FAKE_EXTRA: '1' },
    runtime_config: { strategy: 'single', permission_mode: 'strict' },
    ...extra,
  };
}

function request(sessionId, op, extra = {}) {
  return {
    session_id: sessionId,
    workspace_id: 'ws-1',
    agent_id: AGENT,
    owner_user_id: 'user-1',
    op,
    runtime: 'claude',
    cwd: '',
    native_session_id: null,
    permission_policy: 'ask',
    issued_at: new Date().toISOString(),
    ...extra,
  };
}

async function harness(t, runnerOptions = {}) {
  const cwd = await mkdtemp(join(tmpdir(), 'awb-agent-session-'));
  const server = installFakeServer();
  const runner = new AgentSessionRunner(
    { url: 'http://127.0.0.1:0', apiKey: 'manager-key' },
    {
      commandResolver: async () => ({ command: process.execPath, args: [fixture] }),
      flushIntervalMs: 10,
      idleMinutes: 0,
      permissionTimeoutMs: 5000,
      requestTimeoutMs: 10_000,
      promptTimeoutMs: 20_000,
      ...runnerOptions,
    },
  );
  t.after(async () => {
    await runner.stopAll('test');
    server.restore();
    await rm(cwd, { recursive: true, force: true });
  });
  return { cwd, server, runner };
}

test('open → prompt → permission relay → turn finished, in stream order', async (t) => {
  const { cwd, server, runner } = await harness(t);
  const sid = 'session-order';

  await runner.handle(request(sid, 'open'), context(cwd));
  await waitFor(() => server.events().some((e) => e.type === 'system' && /Session opened/.test(e.payload.text)), 'open system row');
  const openPatch = server.events().find((e) => e.type === 'system').patch;
  assert.equal(openPatch.status, 'ready');
  assert.equal(openPatch.native_session_id, 'session-1');
  assert.equal(openPatch.resume_supported, true, 'fixture advertises loadSession');
  assert.equal(server.calls[0].apiKey, 'agent-api-key', 'stream is posted under the agent key');
  assert.equal(server.calls[0].body.agent_id, AGENT, 'dev-mode identity fallback is carried in the body');

  // prompt runs until the fixture asks for permission
  const turn = runner.handle(request(sid, 'prompt', { turn_id: 't-1', text: 'hello there' }), context(cwd));
  await waitFor(() => server.events().some((e) => e.type === 'permission_request'), 'permission_request row');
  const permission = server.events().find((e) => e.type === 'permission_request');
  assert.equal(permission.patch?.status, 'awaiting_permission');
  assert.deepEqual(permission.payload.options.map((o) => o.option_id), ['allow-once', 'deny']);
  assert.equal(permission.payload.tool_call_id, 'tool-2');
  assert.equal(permission.turn_id, 't-1');

  const beforeDecision = server.events().map((e) => e.type);
  assert.deepEqual(beforeDecision, ['system', 'turn', 'reasoning', 'text', 'tool_call', 'tool_update', 'permission_request']);
  assert.equal(server.events().find((e) => e.type === 'text').payload.text, 'hello');
  assert.equal(server.events().find((e) => e.type === 'reasoning').payload.text, 'thinking');
  assert.equal(server.events().find((e) => e.type === 'tool_call').payload.title, 'Read file');
  assert.equal(server.events().find((e) => e.type === 'tool_update').payload.status, 'completed');
  assert.equal(server.events().find((e) => e.type === 'turn').payload.phase, 'started');
  assert.equal(server.events().find((e) => e.type === 'turn').patch?.status, 'busy');

  // the user decides → the fixture finishes the turn
  await runner.handle(request(sid, 'permission', { request_id: permission.payload.request_id, option_id: 'allow-once' }), context(cwd));
  await turn;
  // 전송은 세션당 FIFO 체인이라 순서는 보장되지만, 병렬 부하가 큰 러너에서는 handle()
  // 이 돌아온 직후 마지막 POST 가 아직 진행 중일 수 있다 — 행이 보일 때까지 기다린다.
  await waitFor(() => server.events().some((e) => e.type === 'turn' && e.payload.phase === 'finished'), 'turn(finished) row');
  const types = server.events().map((e) => e.type);
  const finished = server.events().filter((e) => e.type === 'turn').at(-1);
  assert.equal(finished.payload.phase, 'finished');
  assert.equal(finished.payload.stop_reason, 'end_turn');
  assert.equal(finished.patch?.status, 'ready');
  assert.ok(types.includes('usage'), 'usage row is relayed');
  assert.equal(types.at(-1), 'turn', 'turn(finished) is the last row of the turn');
  assert.equal(server.events().find((e) => e.type === 'usage').payload.total_tokens, 21);

  // close → process stops
  const pidBefore = runner._snapshot()[0]?.pid;
  assert.ok(pidBefore, 'live session has a pid');
  await runner.handle(request(sid, 'close'), context(cwd));
  assert.equal(runner._snapshot().length, 0);
  assert.ok(server.events().some((e) => e.type === 'system' && /Agent process stopped/.test(e.payload.text)));
});

test('permission_policy=auto_allow answers the request from policy and records decided_by=policy', async (t) => {
  const { cwd, server, runner } = await harness(t);
  const sid = 'session-auto';
  await runner.handle(request(sid, 'prompt', { turn_id: 't-auto', text: 'go', permission_policy: 'auto_allow' }), context(cwd));
  await waitFor(() => server.events().some((e) => e.type === 'turn' && e.payload.phase === 'finished'), 'turn(finished) row');
  const decision = server.events().find((e) => e.type === 'permission_decision');
  assert.ok(decision, 'decision row was written by the runner');
  assert.equal(decision.payload.decided_by, 'policy');
  assert.equal(decision.payload.option_id, 'allow-once');
  const finished = server.events().filter((e) => e.type === 'turn').at(-1);
  assert.equal(finished.payload.stop_reason, 'end_turn');
  assert.ok(!server.events().some((e) => e.patch?.status === 'awaiting_permission'), 'never waited on the user');
});

test('a cancelled permission decision refuses the tool and the turn still finishes', async (t) => {
  const { cwd, server, runner } = await harness(t);
  const sid = 'session-deny';
  const turn = runner.handle(request(sid, 'prompt', { turn_id: 't-deny', text: 'go' }), context(cwd));
  await waitFor(() => server.events().some((e) => e.type === 'permission_request'), 'permission_request row');
  const permission = server.events().find((e) => e.type === 'permission_request');
  await runner.handle(request(sid, 'permission', { request_id: permission.payload.request_id, option_id: null }), context(cwd));
  await turn;
  await waitFor(() => server.events().some((e) => e.type === 'turn' && e.payload.phase === 'finished'), 'turn(finished) row');
  const finished = server.events().filter((e) => e.type === 'turn').at(-1);
  assert.equal(finished.payload.phase, 'finished');
  assert.equal(finished.payload.stop_reason, 'refusal', 'fixture reports refusal when the outcome is cancelled');
});

test('native_session_id + loadSession capability → session/load resume', async (t) => {
  const { cwd, server, runner } = await harness(t);
  const sid = 'session-resume';
  await runner.handle(request(sid, 'open', { native_session_id: 'session-previous' }), context(cwd));
  await waitFor(() => server.events().some((e) => e.type === 'system'), 'system row');
  const opened = server.events().find((e) => e.type === 'system');
  assert.match(opened.payload.text, /Session resumed/);
  assert.equal(opened.patch.native_session_id, 'session-previous');
  assert.equal(opened.patch.reason, 'resumed');
});

test('missing agent context → server session is marked error under the manager key', async (t) => {
  const { server, runner } = await harness(t);
  await runner.handle(request('session-nocx', 'prompt', { turn_id: 't', text: 'x' }), undefined);
  const patch = server.calls.find((c) => c.method === 'PATCH');
  assert.ok(patch, 'PATCH was sent');
  assert.equal(patch.apiKey, 'manager-key');
  assert.equal(patch.body.status, 'error');
  assert.match(patch.body.last_error, /not bootstrapped/);
  assert.equal(runner._snapshot().length, 0);
});

test('a missing working directory fails open with an error row instead of spawning', async (t) => {
  const { server, runner } = await harness(t);
  await runner.handle(request('session-nocwd', 'open', { cwd: '/definitely/not/here' }), context('/definitely/not/here'));
  const error = server.events().find((e) => e.type === 'error');
  assert.ok(error, 'error row posted');
  assert.match(error.payload.message, /does not exist/);
  assert.equal(error.patch?.status, 'error');
  assert.equal(runner._snapshot().length, 0);
});

test('resolveAcpCommandForRuntime honours runtime_config.extra.acp_command and env overrides', async () => {
  const explicit = await resolveAcpCommandForRuntime('custom', { runtime_config: { extra: { acp_command: '/opt/acp/agent', acp_args: ['--flag', 1] } } });
  assert.deepEqual(explicit, { command: '/opt/acp/agent', args: ['--flag', '1'] });
  process.env.AWB_ACP_COMMAND_CODEX = 'node /tmp/codex-acp.js --x';
  try {
    assert.deepEqual(await resolveAcpCommandForRuntime('codex', {}), { command: 'node', args: ['/tmp/codex-acp.js', '--x'] });
  } finally {
    delete process.env.AWB_ACP_COMMAND_CODEX;
  }
  await assert.rejects(() => resolveAcpCommandForRuntime('antigravity', {}), /No ACP adapter/);
  const claude = await resolveAcpCommandForRuntime('claude', {});
  assert.ok(claude.command === 'npx' || /claude-agent-acp/.test(claude.command), 'falls back to npx when the adapter is not on PATH');
});
