import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { EventDispatcher } from '../dist/lib/event-dispatcher.js';
import { RuntimeSupervisor } from '../dist/lib/runtime/runtime-supervisor.js';
import { spawnFailureTracker } from '../dist/lib/spawn-failure-tracker.js';

// ticket 38fba2d3: #dispatchTriggerBody (column-trigger Hermes dispatch, distinct
// from handleCommentMention's mention-dispatch path e8105c84 already fixed) had the
// same unguarded pattern — dispatchHermes() resolving without throwing was ack'd
// 'processed' regardless of result.stopReason, so a non-end_turn stop (refusal,
// max_tokens, a denied tool call, …) silently counted as success: no
// spawnFailureTracker signal, no nack, nothing for the dispatch-intent retry/backoff
// machinery to react to. This mirrors hermes-mention-dispatch-outcome.test.mjs's
// stopReason-driven cases via the same real RuntimeSupervisor + fake-acp-server.mjs
// fixture, but through handleTrigger()/#ackDispatch (the trigger path's existing ack
// channel) instead of a ticket comment (the mention path has no ack channel).
//
// NOTE: 아래 case 1-2 는 agent context 에서 `cli_home_dir` 를 의도적으로
// 생략한다. case 3(ticket 73772059)은 실제 프로덕션 shape 대로 이 값을
// 채운다 — agent-manager-commands.ts 는 cli 타입과 무관하게 cli_home_dir 를
// 항상 채우므로, hermes-cli role 디스패치는 항상 이 값이 설정돼 있다. 그
// 티켓의 수정 이전에는 이 때문에 #dispatchTriggerBody 의 CLI-readiness
// 게이트(~line 2278)가 createAdapter('hermes') 를 호출했고, 이는 무조건
// throw 하여(Hermes 는 파일 기반 CLI trust dialog/credential 파일이 없음)
// #ackDispatch 실행 전에 handleTrigger 를 크래시시켰다 — ack 자체가 없음,
// 'nack'조차 없음.

const fixture = fileURLToPath(new URL('./fixtures/fake-acp-server.mjs', import.meta.url));
const AGENT = 'agent-hermes-trigger-outcome';
const TICKET = 'ticket-hermes-trigger-outcome';

let originalFetch;
let mcpToolCalls;
let dispatchAcks;
let ticketGetCount;
let repositoryCredentialRequests;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  mcpToolCalls = [];
  dispatchAcks = [];
  ticketGetCount = 0;
  repositoryCredentialRequests = [];
  globalThis.fetch = async (url, init) => {
    const target = String(url);
    const method = init?.method || 'GET';
    if (target.endsWith('/mcp')) {
      if (method === 'DELETE') return new Response('{}', { status: 200 });
      const body = init?.body ? JSON.parse(init.body) : {};
      if (body.method === 'initialize') {
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: {} }), {
          status: 200,
          headers: { 'mcp-session-id': 'sid-trigger-outcome', 'content-type': 'application/json' },
        });
      }
      if (body.method === 'tools/call') {
        mcpToolCalls.push(body.params?.name);
        return new Response(
          JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { content: [] } }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response('', { status: 202 });
    }
    if (target.endsWith('/api/agent-manager/dispatch/ack')) {
      dispatchAcks.push(JSON.parse(init?.body || '{}'));
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (target.includes('/git-credential?')) {
      repositoryCredentialRequests.push(target);
      return new Response(JSON.stringify({ username: 'game-token', token: 'secret' }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }
    if (target.includes('/api/agent/tickets/')) {
      ticketGetCount += 1;
      return new Response(
        JSON.stringify({ id: TICKET, comments: [] }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  };
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function context(permissionMode, cliHomeDir) {
  return {
    agent_id: AGENT,
    name: 'Hermes trigger outcome agent',
    cli: 'hermes',
    working_dir: '/workspace',
    mcp_config_path: '/config/mcp.json',
    api_key: 'agent-api-key',
    workspace_id: 'txiv-board-workspace',
    cli_home_dir: cliHomeDir,
    extra_env: {},
    credential_provider: null,
    model: null,
    runtime_config: { strategy: 'single', permission_mode: permissionMode, profile: 'coding' },
  };
}

async function harness(t, permissionMode, cliHomeDir, worktreeOverride) {
  const rootDir = await mkdtemp(join(tmpdir(), 'awb-hermes-trigger-outcome-'));
  const runtimeSupervisor = new RuntimeSupervisor({
    rootDir,
    command: process.execPath,
    args: [fixture],
    awbUrl: 'http://127.0.0.1:0',
  });
  t.after(async () => {
    await runtimeSupervisor.stopAll();
    await rm(rootDir, { recursive: true, force: true });
  });
  const managedAgentContexts = {
    get: (id) => (id === AGENT ? context(permissionMode, cliHomeDir) : null),
    has: (id) => id === AGENT,
    list: () => [context(permissionMode, cliHomeDir)],
  };
  const worktreeManager = worktreeOverride || {
    enabled: true,
    async resolveCwd() {
      return { isWorktree: true, cwd: '/workspace/.awb/wt/ticket', mode: 'per_ticket', reused: false };
    },
    async verifyCheckout() { return { ok: true }; },
    async verifyPushReadiness() { return { ok: true }; },
    async removeTicketWorktrees() { return 0; },
    async removeTicketRunWorkspace() { return false; },
  };
  const dispatcher = new EventDispatcher(
    {
      url: 'http://127.0.0.1:0',
      apiKey: 'test-key',
      delegation: { enabled: true, persistentTicketSessions: false, persistentChatSessions: false },
    },
    { managedAgentContexts, worktreeManager, runtimeSupervisor },
  );
  return { dispatcher };
}

function ticketTrigger() {
  return JSON.stringify({
    event_type: 'agent_trigger',
    ticket_id: TICKET,
    action: 'assignee',
    actor_name: AGENT,
    field_changed: 'trigger-1',
    trigger_source: 'column_move',
    base_repo: { id: 'repo-1', url: 'https://github.com/acme/app.git', default_branch: 'main' },
    base_branch: 'main',
  });
}

async function waitForAck() {
  for (let i = 0; i < 8 && dispatchAcks.length === 0; i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

test('case 1: stop=end_turn → ack processed, degraded signal clears', async (t) => {
  const { dispatcher } = await harness(t, 'trusted');
  // Simulate a still-open degraded badge from an earlier failure — success must clear it.
  spawnFailureTracker.record({ cli: 'hermes', code: 'acp_timeout', message: 'prior failure' });

  await dispatcher.handleTrigger(ticketTrigger());
  await waitForAck();

  assert.deepEqual(
    dispatchAcks.map((ack) => ({ outcome: ack.outcome, reason: ack.reason })),
    [{ outcome: 'processed', reason: '' }],
  );
  assert.ok(ticketGetCount >= 1, 'expected the prompt-composition ticket fetch');

  const snap = spawnFailureTracker.snapshot();
  assert.equal(snap.last_spawn_error_cli, null);
  assert.equal(snap.last_spawn_error, null);
});

test('case 2 (ticket 38fba2d3): stop=refusal (non-end_turn) → ack nack, spawnFailureTracker records failure, no ticket-comment channel used', async (t) => {
  const { dispatcher } = await harness(t, 'strict');

  await dispatcher.handleTrigger(ticketTrigger());
  await waitForAck();

  // Previously: unconditionally ack'd 'processed' regardless of stopReason — this
  // pins the fix down as a regression test.
  assert.deepEqual(
    dispatchAcks.map((ack) => ({ outcome: ack.outcome, reason: ack.reason })),
    [{ outcome: 'nack', reason: 'refusal' }],
  );

  const snap = spawnFailureTracker.snapshot();
  assert.equal(snap.last_spawn_error_cli, 'hermes');
  assert.match(snap.last_spawn_error || '', /refusal/);

  // The trigger path has no chat room / ticket-comment channel wired for this
  // failure (unlike the pre-spawn worktree/CLI-readiness/push-credential blockers) —
  // #ackDispatch('nack', ...) is the whole signal, matching every other in-function
  // failure path's existing convention (e.g. the runtime_protocol_error catch below).
  assert.equal(mcpToolCalls.filter((name) => name === 'add_comment').length, 0);
});

test('case 3 (ticket 73772059): cli_home_dir populated (real production shape) → CLI-readiness gate no longer crashes handleTrigger, dispatch still reaches Hermes branch and acks', async (t) => {
  const { dispatcher } = await harness(t, 'trusted', '/home/agent/.claude');

  // 이전에는: CLI-readiness 게이트(~line 2278)의 createAdapter('hermes') 가
  // cli_home_dir 가 설정되기만 하면(실제 프로덕션 shape — agent-manager-commands.ts
  // 는 cli 타입과 무관하게 항상 채움) 무조건 RuntimeSelectionError 를 던졌다.
  // handleTrigger 가 #ackDispatch 실행 전에 reject 되어 서버는 'processed'도
  // 'nack'도 받지 못했다 — 완전한 침묵. 게이트가 회귀하면 이 `await` 가 reject
  // 되어 아래 assertion 에 도달하기도 전에 테스트가 실패한다.
  await dispatcher.handleTrigger(ticketTrigger());
  await waitForAck();

  assert.deepEqual(
    dispatchAcks.map((ack) => ({ outcome: ack.outcome, reason: ack.reason })),
    [{ outcome: 'processed', reason: '' }],
  );
  assert.ok(ticketGetCount >= 1, 'expected the prompt-composition ticket fetch (proves the Hermes branch ran)');
});

test('TXIV wire consumer: GameClient/master 하나로 worktree·credential·push 경계를 고정한다', async (t) => {
  const calls = { resolve: [], checkout: [], push: [] };
  const gameCwd = '/workspace/.awb/wt/gameclient/txiv-ticket';
  const worktreeManager = {
    enabled: true,
    async resolveCwd(args) {
      calls.resolve.push(structuredClone(args));
      return { isWorktree: true, cwd: gameCwd, mode: 'per_ticket', reused: false };
    },
    async verifyCheckout(cwd, url) {
      calls.checkout.push({ cwd, url });
      return { ok: true };
    },
    async verifyPushReadiness(cwd, url) {
      calls.push.push({ cwd, url });
      return { ok: true };
    },
    async removeTicketWorktrees() { return 0; },
    async removeTicketRunWorkspace() { return false; },
  };
  const { dispatcher } = await harness(t, 'trusted', undefined, worktreeManager);
  const wire = JSON.stringify({
    event_type: 'agent_trigger', ticket_id: TICKET, action: 'assignee',
    actor_name: AGENT, field_changed: 'txiv-trigger', trigger_source: 'column_move',
    workspace_id: 'txiv-board-workspace', worktree_mode: 'per_ticket',
    base_repo: {
      id: 'gameclient-resource', url: 'https://github.com/acme/GameClient.git',
      default_branch: 'master',
    },
    base_branch: 'master',
    environment_config: {
      repositories: [{
        resource_id: 'gameclient-resource', url: 'https://github.com/acme/GameClient.git',
        target_dir: '.', branch: 'master', post_clone_commands: [],
      }],
      env_vars: {}, setup_commands: [], setup_timeout_seconds: 600, version: 1,
    },
  });

  await dispatcher.handleTrigger(wire);
  await waitForAck();

  assert.equal(calls.resolve.length, 1);
  assert.deepEqual(calls.resolve[0].bootstrapRepo, {
    resourceId: 'gameclient-resource',
    url: 'https://github.com/acme/GameClient.git',
    branch: 'master',
    credential: { username: 'game-token', token: 'secret' },
  });
  assert.deepEqual(calls.checkout, [{ cwd: gameCwd, url: 'https://github.com/acme/GameClient.git' }]);
  assert.deepEqual(calls.push, [{ cwd: gameCwd, url: 'https://github.com/acme/GameClient.git' }]);
  assert.equal(repositoryCredentialRequests.length, 1);
  assert.match(repositoryCredentialRequests[0], /resources\/gameclient-resource\/git-credential/);
  assert.match(repositoryCredentialRequests[0], /workspace_id=txiv-board-workspace/);
  assert.deepEqual(dispatchAcks.map((ack) => ack.outcome), ['processed']);
});
