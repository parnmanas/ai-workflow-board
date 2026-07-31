import test from 'node:test';
import assert from 'node:assert/strict';
import { SubagentManager } from '../dist/lib/subagent-manager.js';

const config = {
  url: 'http://127.0.0.1:1',
  apiKey: 'test',
  silentExitVerifyDelayMs: 0,
  delegation: { enabled: true, maxConcurrent: 10, ttlMinutes: 15 },
};

function record(attempt = 0) {
  return {
    kind: 'trigger', pid: 123, cli_type: 'claude',
    trigger_id: 'mention:comment-1:agent-1',
    mention_audit_run_token: `run-${attempt}`,
    silent_exit_attempt: attempt,
    chat_request_id: null, ticket_id: 'ticket-1', agent_id: 'agent-1',
    role: 'assignee', room_id: null, started_at: Date.now(),
    expected_completion_at: Date.now() + 1000, config_path: null,
    config_path_is_temp: false, process_handle: null, captureOutput: false,
    outLines: [], tailLines: [], commentSent: false, tap: null, usage: null,
    respawnSpec: {
      kind: 'trigger', taskText: 'task', rolePrompt: 'role',
      triggerId: 'mention:comment-1:agent-1', ticketId: 'ticket-1',
      agentId: 'agent-1', role: 'assignee',
    },
  };
}

test('clean standalone mention retries exactly once before fallback', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const requests = [];
  globalThis.fetch = async (url, init) => {
    requests.push({ url: String(url), body: JSON.parse(init?.body || '{}') });
    if (String(url).includes('/mention-audit-runs/')) {
      return Response.json({ decision: 'retry', attempt: 1 });
    }
    return Response.json({});
  };
  const manager = new SubagentManager(config);
  let spawnArgs;
  manager.spawn = async (args) => {
    spawnArgs = args;
    return { spawned: true, pid: 456 };
  };
  await manager._handleOneshotExit(record(0), 0);
  assert.equal(spawnArgs?._silentExitAttempt, 1);
  assert.equal(requests.filter((r) => r.url.endsWith('/silent-exit-comment')).length, 0);
});

test('second clean silent attempt emits one structured terminal fallback', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const requests = [];
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init?.body || '{}');
    requests.push({ url: String(url), body });
    if (String(url).includes('/mention-audit-runs/')) {
      return Response.json({ decision: 'failed', attempt: 1, reason: 'silent_exit_retry_exhausted' });
    }
    return Response.json({});
  };
  const manager = new SubagentManager(config);
  await manager._handleOneshotExit(record(1), 0);
  const fallback = requests.filter((r) => r.url.endsWith('/silent-exit-comment'));
  assert.equal(fallback.length, 1);
  assert.equal(fallback[0].body.silent_exit_attempt, 1);
  assert.equal(fallback[0].body.terminal_reason, 'silent_exit_retry_exhausted');
});

test('retry spawn failure is terminalized as attempt one before fallback', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const requests = [];
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init?.body || '{}');
    requests.push({ url: String(url), body });
    if (String(url).endsWith('/complete')) {
      return Response.json({ decision: 'retry', attempt: 1 });
    }
    if (String(url).endsWith('/retry-spawn-failed')) {
      return Response.json({
        decision: 'failed', attempt: 1, reason: 'silent_exit_retry_spawn_failed',
        family_key: 'mention:comment-1:agent-1:agent-1',
      });
    }
    return Response.json({});
  };
  const manager = new SubagentManager(config);
  manager.spawn = async () => ({ spawned: false, reason: 'spawn_failed' });
  await manager._handleOneshotExit(record(0), 0);
  assert.equal(requests.filter((r) => r.url.endsWith('/retry-spawn-failed')).length, 1);
  const fallback = requests.filter((r) => r.url.endsWith('/silent-exit-comment'));
  assert.equal(fallback.length, 1);
  assert.equal(fallback[0].body.silent_exit_attempt, 1);
  assert.equal(fallback[0].body.terminal_reason, 'silent_exit_retry_spawn_failed');
  assert.equal(fallback[0].body.silent_exit_retry_count, 1);
  assert.equal(fallback[0].body.silent_exit_family_key, 'mention:comment-1:agent-1:agent-1');
});

test('retry claimant loser does not spawn or post fallback', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const requests = [];
  globalThis.fetch = async (url, init) => {
    requests.push({ url: String(url), body: JSON.parse(init?.body || '{}') });
    return Response.json({ decision: 'retry_claimed', attempt: 1 });
  };
  const manager = new SubagentManager(config);
  let spawnCount = 0;
  manager.spawn = async () => {
    spawnCount += 1;
    return { spawned: true, pid: 456 };
  };
  await manager._handleOneshotExit(record(0), 0);
  assert.equal(spawnCount, 0);
  assert.equal(requests.filter((r) => r.url.endsWith('/silent-exit-comment')).length, 0);
});
