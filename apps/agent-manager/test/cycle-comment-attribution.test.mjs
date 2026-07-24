import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import { PassThrough } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';

import { createAdapter } from '../dist/lib/cli-adapters/index.js';
import { SubagentManager } from '../dist/lib/subagent-manager.js';
import { TicketSessionManager } from '../dist/lib/ticket-session-manager.js';

const root = new URL('../src/lib/', import.meta.url);

const config = {
  url: 'http://127.0.0.1:0',
  apiKey: 'test-key',
  silentExitVerifyDelayMs: 0,
  delegation: {
    enabled: true,
    persistentTicketSessions: true,
    maxConcurrent: 10,
    idleMinutes: 999,
    ttlMinutes: 15,
  },
};

let pid = 91000;
function fakeChild() {
  const child = new EventEmitter();
  child.pid = ++pid;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  return child;
}

function claudeCommentLine(tool = 'mcp__awb__add_comment') {
  return JSON.stringify({
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'tool-1', name: tool, input: {} }],
    },
  });
}

async function waitFor(predicate, timeoutMs = 1000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await delay(5);
  }
  assert.ok(predicate(), 'timed out waiting for lifecycle completion');
}

let originalFetch;
let requests;
beforeEach(() => {
  originalFetch = globalThis.fetch;
  requests = [];
  globalThis.fetch = async (url, init) => {
    requests.push({ url: String(url), method: init?.method || 'GET' });
    return new Response('{}', {
      status: 200,
      headers: { 'content-type': 'application/json', 'mcp-session-id': 'test-sid' },
    });
  };
});
afterEach(() => {
  globalThis.fetch = originalFetch;
});

const silentExitRequests = () =>
  requests.filter((request) => request.url.endsWith('/silent-exit-comment'));

test('persistent: final MCP comment after exit but before close suppresses this cycle silent-exit', async () => {
  const manager = new TicketSessionManager(config);
  const child = fakeChild();
  const sessionKey = 'ticket-race:assignee:agent-race';
  const session = {
    sessionKey,
    pid: child.pid,
    cli_type: 'claude',
    adapter: createAdapter('claude'),
    child,
    configPath: null,
    configPathIsTemp: false,
    pidPath: null,
    ticketId: 'ticket-race',
    agentId: 'agent-race',
    role: 'assignee',
    turnCount: 1,
    startedAt: Date.now(),
    lastTouchedAt: Date.now(),
    idleTimer: null,
    unrespondedTurnCount: 0,
    unrespondedSince: null,
    unhealthyKilled: false,
    tap: null,
  };
  manager._trackSessionForTest(sessionKey, session);

  child.emit('exit', 0, null);
  child.stdout.write(`${claudeCommentLine()}\n`);
  child.stdout.end();
  child.stderr.end();
  child.emit('close', 0, null);

  await waitFor(() => !manager._sessions.has(sessionKey));
  assert.deepEqual(silentExitRequests(), []);
});

test('one-shot: final MCP move after exit but before close suppresses this cycle silent-exit', async () => {
  const manager = new SubagentManager(config);
  let exitHandled;
  const handled = new Promise((resolve) => {
    exitHandled = resolve;
  });
  manager.onExit = exitHandled;
  const child = fakeChild();
  const record = {
    pid: child.pid,
    kind: 'trigger',
    cli_type: 'claude',
    trigger_id: 'trigger-race',
    chat_request_id: null,
    ticket_id: 'ticket-race',
    agent_id: 'agent-race',
    role: 'assignee',
    room_id: null,
    started_at: Date.now(),
    config_path: null,
    config_path_is_temp: false,
    process_handle: child,
    captureOutput: false,
    outLines: [],
    tailLines: [],
    commentSent: false,
    tap: null,
  };
  manager._trackForTest(record);
  manager._wireStdioForTest(record);

  child.emit('exit', 0, null);
  child.stdout.write(`${claudeCommentLine('mcp__awb__move_ticket')}\n`);
  child.stdout.end();
  child.stderr.end();
  child.emit('close', 0, null);

  await handled;
  assert.equal(record.commentSent, true);
  assert.deepEqual(silentExitRequests(), []);
});

test('cycle exit paths do not fall back to ticket-wide time-window attribution', async () => {
  const [persistent, oneshot] = await Promise.all([
    readFile(new URL('ticket-session-manager.ts', root), 'utf8'),
    readFile(new URL('subagent-manager.ts', root), 'utf8'),
  ]);

  assert.doesNotMatch(persistent, /hasAuditTrailSince/);
  assert.doesNotMatch(oneshot, /hasAuditTrailSince/);
});
