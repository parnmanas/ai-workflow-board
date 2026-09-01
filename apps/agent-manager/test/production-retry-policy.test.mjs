import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';

import { SubagentManager } from '../dist/lib/subagent-manager.js';
import { TicketSessionManager } from '../dist/lib/ticket-session-manager.js';

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

function resolver(decision, calls) {
  return {
    resolve(runtimeId) {
      return {
        cliType: runtimeId,
        capabilities: 0,
        collectOneshotResult: () => "[codex error] You've hit your usage limit",
      };
    },
    shouldRetry(runtimeId, error, attempt) {
      calls.push({ runtimeId, error, attempt });
      return decision;
    },
  };
}

function config() {
  return {
    url: 'http://127.0.0.1:0',
    apiKey: 'test-key',
    silentExitVerifyDelayMs: 0,
    delegation: { enabled: true, maxConcurrent: 10, ttlMinutes: 15 },
  };
}

function oneshotRecord(chainAttempt = 1) {
  return {
    pid: 41001,
    kind: 'trigger',
    cli_type: 'codex',
    trigger_id: 'trigger-1',
    chat_request_id: null,
    ticket_id: 'ticket-1',
    agent_id: 'agent-1',
    role: 'assignee',
    room_id: null,
    started_at: Date.now(),
    config_path: null,
    config_path_is_temp: false,
    captureOutput: true,
    outLines: [],
    tailLines: ["[codex error] You've hit your usage limit"],
    commentSent: false,
    tap: null,
    chainAttempt,
    modelChain: ['primary', 'fallback-1', 'fallback-2'],
    respawnSpec: { kind: 'trigger', taskText: '작업', rolePrompt: '' },
  };
}

function persistentSession(chainAttempt = 1) {
  return {
    pid: 42001,
    sessionKey: 'ticket-1:assignee:agent-1',
    ticketId: 'ticket-1',
    role: 'assignee',
    agentId: 'agent-1',
    cli_type: 'claude',
    child: { pid: 42001 },
    startedAt: Date.now(),
    chainAttempt,
    modelChain: ['primary', 'fallback-1', 'fallback-2'],
    _fallbackRespawn: async () => null,
  };
}

test('one-shot production fallback은 실제 chainAttempt를 정책에 전달하고 승인 시 두 번째 spawn을 실행한다', async () => {
  const policyCalls = [];
  const manager = new SubagentManager(config(), undefined, resolver(true, policyCalls));
  const spawnCalls = [];
  manager.spawn = async (spec) => { spawnCalls.push(spec); return { spawned: true, pid: 41002 }; };

  await manager._handleOneshotExit(oneshotRecord(1), 1);

  assert.equal(policyCalls.length, 1);
  assert.equal(policyCalls[0].attempt, 1);
  assert.equal(policyCalls[0].error.retryable, true);
  assert.equal(spawnCalls.length, 1);
  assert.equal(spawnCalls[0]._chainAttempt, 2);
});

test('one-shot production fallback은 정책이 거부하면 respawn하지 않는다', async () => {
  globalThis.fetch = async () => new Response(JSON.stringify({ commented: false }), { status: 200, headers: { 'content-type': 'application/json' } });
  const policyCalls = [];
  const manager = new SubagentManager(config(), undefined, resolver(false, policyCalls));
  let spawnCount = 0;
  manager.spawn = async () => { spawnCount += 1; return { spawned: true }; };

  await manager._handleOneshotExit(oneshotRecord(1), 1);

  assert.equal(policyCalls[0].attempt, 1);
  assert.equal(spawnCount, 0);
});

test('persistent production fallback은 실제 chainAttempt를 정책에 전달하고 승인 시 두 번째 spawn을 실행한다', async () => {
  const policyCalls = [];
  const manager = new TicketSessionManager(config(), undefined, resolver(true, policyCalls));
  const session = persistentSession(1);
  const respawnAttempts = [];
  session._fallbackRespawn = async (attempt) => { respawnAttempts.push(attempt); return { pid: 42002 }; };
  manager._outputRings.set(session.pid, ['usage limit']);

  await manager._onChildExit(session, 1, null);

  assert.equal(policyCalls.length, 1);
  assert.equal(policyCalls[0].attempt, 1);
  assert.equal(policyCalls[0].error.retryable, true);
  assert.deepEqual(respawnAttempts, [2]);
});

test('persistent production fallback은 정책이 거부하면 respawn하지 않는다', async () => {
  globalThis.fetch = async () => new Response(JSON.stringify({ commented: false }), { status: 200, headers: { 'content-type': 'application/json' } });
  const policyCalls = [];
  const manager = new TicketSessionManager(config(), undefined, resolver(false, policyCalls));
  const session = persistentSession(1);
  let respawnCount = 0;
  session._fallbackRespawn = async () => { respawnCount += 1; return { pid: 42002 }; };
  manager._outputRings.set(session.pid, ['usage limit']);

  await manager._onChildExit(session, 1, null);

  assert.equal(policyCalls[0].attempt, 1);
  assert.equal(respawnCount, 0);
});
