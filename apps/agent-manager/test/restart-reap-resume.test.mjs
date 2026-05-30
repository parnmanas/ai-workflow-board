// Unit test — restart_agent zombie reap + immediate resume (ticket 86683d12).
//
// Covers the two behaviours added for the "OAuth 만료 후 restart 해도 좀비
// one-shot subagent 가 계속 헛돈다" report:
//   (A) stop_agent / restart_agent now also reap the agent's one-shot
//       subagents (SubagentManager.stopForAgent), not just persistent
//       chat/ticket sessions. The ack summary surfaces the subagent count.
//   (B) restart_agent captures the in-flight (ticket, role) work the killed
//       children were holding and POSTs it to the server's resume-triggers
//       endpoint right after the fresh spawn, de-duplicated across all three
//       managers — so the agent resumes on the new credential immediately
//       instead of waiting for the ~30-min supervisor sweep.
//
// MANAGER_HOME is pointed at a throwaway temp dir BEFORE importing the dist
// module (constants.js reads the env at import time) so spawn_agent's on-disk
// writes don't touch the operator's real config. All network calls go through
// a mocked globalThis.fetch.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.AWB_AGENT_MANAGER_HOME = mkdtempSync(join(tmpdir(), 'awb-reap-test-'));

const { AgentManagerCommandHandler } = await import('../dist/lib/agent-manager-commands.js');

function makeConfig() {
  return { url: 'http://127.0.0.1:0', apiKey: 'manager-key', delegation: {} };
}

// Minimal stand-ins for the registries the handler mutates.
function makeRegistry() {
  const calls = { markStopped: [], markRunning: [], upsert: [] };
  return {
    calls,
    upsert(rec) {
      calls.upsert.push(rec);
      return { ...rec, status: 'idle' };
    },
    markRunning(id, pid) {
      calls.markRunning.push({ id, pid });
    },
    markStopped(id, reason) {
      calls.markStopped.push({ id, reason });
      return { agent_id: id };
    },
    get() {
      return undefined;
    },
    setWorkingDir() {},
  };
}

function makeContextRegistry() {
  return {
    delete() {
      return true;
    },
    upsert() {},
    get() {
      return undefined;
    },
  };
}

// Records the agentId each manager was asked to stop and returns a canned
// in-flight set so we can assert the de-dup + re-push aggregation.
function makeStopper(inflight) {
  const seen = [];
  return {
    seen,
    async stopForAgent(agentId) {
      seen.push(agentId);
      return inflight;
    },
  };
}

let originalFetch;
let recorded;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  recorded = [];
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    const body = init?.body ? JSON.parse(init.body) : null;
    recorded.push({ url: u, method: init?.method || 'GET', body });
    // Per-agent credential probe → "none configured".
    if (u.includes('/credential')) {
      return new Response(null, { status: 204 });
    }
    // apiKey provision → fresh key.
    if (u.includes('/apikey/provision')) {
      return new Response(JSON.stringify({ raw_key: 'sk-managed-xyz', key_id: 'k1' }), {
        status: 201,
        headers: { 'content-type': 'application/json' },
      });
    }
    // Canonical managed-agent record fetch (GET .../managed-agents/:id).
    if (/\/managed-agents\/[^/]+$/.test(u) && (init?.method || 'GET') === 'GET') {
      return new Response(
        JSON.stringify({ name: 'Rolf', type: 'claude', working_dir: '/tmp/work' }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    // resume-triggers + command ack + anything else → ok.
    if (u.includes('/resume-triggers')) {
      return new Response(JSON.stringify({ ok: true, emitted: 1, skipped: 0 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  };
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test('stop_agent reaps one-shot subagents and reports the count', async () => {
  const subagent = makeStopper({
    count: 2,
    inflight: [{ ticket_id: 't1', role: 'assignee', room_id: null }],
  });
  const handler = new AgentManagerCommandHandler(makeConfig(), {
    registry: makeRegistry(),
    contextRegistry: makeContextRegistry(),
    chatSessionManager: makeStopper({ count: 0, inflight: [] }),
    ticketSessionManager: makeStopper({ count: 1, inflight: [{ ticketId: 't1', role: 'assignee' }] }),
    subagentManager: subagent,
    getInstanceId: () => 'inst-1',
  });

  await handler.handle(
    JSON.stringify({ command_id: 'c1', command: 'stop_agent', args: { agent_id: 'agent-A' } }),
  );

  assert.deepEqual(subagent.seen, ['agent-A'], 'subagentManager.stopForAgent was called for the target');
  const ack = recorded.find((r) => r.url.endsWith('/command/ack'));
  assert.ok(ack, 'command ack posted');
  assert.equal(ack.body.status, 'ok');
  assert.match(ack.body.detail, /subagents=2/, 'ack surfaces the reaped one-shot count');
});

test('restart_agent re-pushes de-duplicated in-flight work after the fresh spawn', async () => {
  // Same ticket t1 appears in BOTH the ticket session and a one-shot subagent;
  // a second ticket t2 only in the subagent. Expect exactly two re-push items.
  const handler = new AgentManagerCommandHandler(makeConfig(), {
    registry: makeRegistry(),
    contextRegistry: makeContextRegistry(),
    chatSessionManager: makeStopper({ count: 0, inflight: [] }),
    ticketSessionManager: makeStopper({
      count: 1,
      inflight: [{ ticketId: 't1', role: 'assignee' }],
    }),
    subagentManager: makeStopper({
      count: 2,
      inflight: [
        { ticket_id: 't1', role: 'assignee', room_id: null },
        { ticket_id: 't2', role: 'reviewer', room_id: null },
      ],
    }),
    getInstanceId: () => 'inst-1',
    requestStreamReconnect: async () => {},
  });

  await handler.handle(
    JSON.stringify({ command_id: 'c2', command: 'restart_agent', args: { agent_id: 'agent-B' } }),
  );

  const resume = recorded.find((r) => r.url.includes('/resume-triggers'));
  assert.ok(resume, 'resume-triggers endpoint was hit');
  assert.equal(resume.method, 'POST');
  assert.ok(resume.url.includes('/managed-agents/agent-B/resume-triggers'), 'scoped to the target agent');
  const items = resume.body.items;
  assert.equal(items.length, 2, 't1 de-duplicated across ticket-session + subagent');
  const keys = items.map((i) => `${i.ticket_id}:${i.role}`).sort();
  assert.deepEqual(keys, ['t1:assignee', 't2:reviewer']);

  // Ordering guarantee: the spawn (apiKey provision) must land BEFORE the
  // resume re-push, otherwise the server's managedAgentIds snapshot wouldn't
  // include the agent yet and the trigger would be dropped.
  const provisionIdx = recorded.findIndex((r) => r.url.includes('/apikey/provision'));
  const resumeIdx = recorded.findIndex((r) => r.url.includes('/resume-triggers'));
  assert.ok(provisionIdx >= 0 && provisionIdx < resumeIdx, 'spawn precedes resume re-push');

  const ack = recorded.find((r) => r.url.endsWith('/command/ack'));
  assert.equal(ack.body.status, 'ok', 'restart acked ok');
  assert.match(ack.body.detail, /resumed 1\/2 in-flight/, 'ack notes the resume outcome');
});

test('restart_agent with no in-flight work skips the resume re-push', async () => {
  const handler = new AgentManagerCommandHandler(makeConfig(), {
    registry: makeRegistry(),
    contextRegistry: makeContextRegistry(),
    chatSessionManager: makeStopper({ count: 0, inflight: [] }),
    ticketSessionManager: makeStopper({ count: 0, inflight: [] }),
    subagentManager: makeStopper({ count: 0, inflight: [] }),
    getInstanceId: () => 'inst-1',
    requestStreamReconnect: async () => {},
  });

  await handler.handle(
    JSON.stringify({ command_id: 'c3', command: 'restart_agent', args: { agent_id: 'agent-C' } }),
  );

  const resume = recorded.find((r) => r.url.includes('/resume-triggers'));
  assert.equal(resume, undefined, 'no resume POST when nothing was in flight');
  const ack = recorded.find((r) => r.url.endsWith('/command/ack'));
  assert.equal(ack.body.status, 'ok');
});
