// A planned restart (self-update, restart_manager) no longer waits for running
// work to drain. Right before it leaves, the manager saves what it interrupts;
// the new process hands that to AWB once connected and deletes it
// (restart-resume.ts). These tests pin the save → deliver → delete cycle and
// what counts as interrupted work.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';

import {
  RESTART_RESUME_TTL_MS,
  deliverRestartResume,
  readRestartResume,
  restartResumePath,
  writeRestartResume,
} from '../dist/lib/restart-resume.js';
import { SubagentManager } from '../dist/lib/subagent-manager.js';
import { TicketSessionManager } from '../dist/lib/ticket-session-manager.js';

const config = { url: 'http://awb.test', apiKey: 'manager-key', delegation: { enabled: true } };

let dir;
let originalFetch;
let posted;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'awb-restart-resume-'));
  originalFetch = globalThis.fetch;
  posted = [];
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  rmSync(dir, { recursive: true, force: true });
});

function record(overrides = {}) {
  return {
    version: 1,
    reason: 'self_update_restart',
    saved_at: new Date().toISOString(),
    from_version: '1.6.94',
    sessions: [{ cli: 'claude', session_id: 's-1', cwd: '/repo', title: 'Fix login', state: 'turn', turn_started_at: new Date().toISOString() }],
    tickets: [{ ticket_id: 'ticket-1', role: 'assignee', agent_id: 'rt-0123456789abcdef' }],
    ...overrides,
  };
}

function server(status) {
  globalThis.fetch = async (url, init) => {
    posted.push({ url: String(url), body: JSON.parse(init.body), headers: init.headers });
    if (status === 'down') throw new Error('connect ECONNREFUSED');
    return new Response(JSON.stringify({ ok: true }), { status });
  };
}

test('the saved record round-trips, and a restart with nothing running leaves no file', () => {
  writeRestartResume(record({ sessions: [], tickets: [] }), dir);
  assert.equal(existsSync(restartResumePath(dir)), false, 'nothing interrupted → nothing to hand over');
  writeRestartResume(record(), dir);
  const back = readRestartResume(dir);
  assert.equal(back.reason, 'self_update_restart');
  assert.deepEqual(back.sessions.map((s) => s.session_id), ['s-1']);
  assert.deepEqual(back.tickets.map((t) => t.ticket_id), ['ticket-1']);
});

test('a record not yet delivered survives a second restart (a new build rolling back before it connects)', () => {
  writeRestartResume(record(), dir);
  // The new build boots, fails boot verification and restarts again before it ever connected.
  writeRestartResume(record({ sessions: [], tickets: [] }), dir);
  writeRestartResume(record({
    reason: 'manager_restart',
    sessions: [{ cli: 'codex', session_id: 's-2', cwd: '/b', title: '', state: 'awaiting_input', turn_started_at: null }],
    tickets: [{ ticket_id: 'ticket-1', role: 'assignee', agent_id: 'rt-0123456789abcdef' }],
  }), dir);
  const back = readRestartResume(dir);
  assert.deepEqual(back.sessions.map((s) => s.session_id), ['s-1', 's-2'], 'merged, not replaced');
  assert.deepEqual(back.tickets.map((t) => t.ticket_id), ['ticket-1'], 'the same ticket once');
  assert.equal(back.reason, 'self_update_restart', 'the first restart is the one that interrupted the work');
});

test('an expired or unreadable record is dropped instead of resuming someone else\'s past', () => {
  writeRestartResume(record({ saved_at: new Date(Date.now() - RESTART_RESUME_TTL_MS - 1000).toISOString() }), dir);
  assert.equal(readRestartResume(dir), null);
  assert.equal(existsSync(restartResumePath(dir)), false);
  writeFileSync(restartResumePath(dir), '{ not json');
  assert.equal(readRestartResume(dir), null);
});

test('delivery: AWB took it → deleted; AWB refused it (4xx) → deleted; AWB unreachable or 5xx → kept for the next connect', async () => {
  writeRestartResume(record(), dir);
  server('down');
  assert.equal(await deliverRestartResume(config, readRestartResume(dir), '1.6.95', dir), 'retry');
  server(503);
  assert.equal(await deliverRestartResume(config, readRestartResume(dir), '1.6.95', dir), 'retry');
  assert.ok(existsSync(restartResumePath(dir)), 'kept while AWB cannot take it');

  server(200);
  assert.equal(await deliverRestartResume(config, readRestartResume(dir), '1.6.95', dir), 'delivered');
  assert.equal(existsSync(restartResumePath(dir)), false, 'used, then deleted');
  const sent = posted.at(-1);
  assert.equal(sent.url, 'http://awb.test/api/agent-manager/restart-resume');
  assert.equal(sent.headers['X-Agent-Key'], 'manager-key');
  assert.equal(sent.body.to_version, '1.6.95');
  assert.equal(sent.body.from_version, '1.6.94');
  assert.deepEqual(sent.body.sessions.map((s) => s.session_id), ['s-1']);

  writeRestartResume(record(), dir);
  server(400);
  assert.equal(await deliverRestartResume(config, readRestartResume(dir), '1.6.95', dir), 'rejected');
  assert.equal(existsSync(restartResumePath(dir)), false);
});

function fakeChild(pid) {
  const child = new EventEmitter();
  child.pid = pid;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  return child;
}

test('interrupted ticket work: persistent sessions mid-turn and every running one-shot — not a session idling between turns', () => {
  const sessions = new TicketSessionManager(config);
  sessions._sessions.set('t-busy:assignee:rt-a', { ticketId: 't-busy', role: 'assignee', agentId: 'rt-a', _currentTurn: { startedAt: Date.now() } });
  sessions._sessions.set('t-idle:assignee:rt-a', { ticketId: 't-idle', role: 'assignee', agentId: 'rt-a', _currentTurn: null });
  assert.deepEqual(sessions.inFlightTickets(), [{ ticketId: 't-busy', role: 'assignee', agentId: 'rt-a' }]);

  const oneShots = new SubagentManager(config);
  const child = fakeChild(81_001);
  oneShots._trackForTest({
    pid: child.pid, kind: 'trigger', cli_type: 'claude', ticket_id: 't-oneshot', agent_id: 'rt-b', role: 'assignee',
    room_id: null, started_at: Date.now(), config_path: null, config_path_is_temp: false, process_handle: child,
    captureOutput: false, outLines: [], tailLines: [], commentSent: false, tap: null,
  });
  const chat = fakeChild(81_002);
  oneShots._trackForTest({
    pid: chat.pid, kind: 'chat', cli_type: 'claude', ticket_id: null, agent_id: 'rt-b', role: null,
    room_id: 'room-1', started_at: Date.now(), config_path: null, config_path_is_temp: false, process_handle: chat,
    captureOutput: false, outLines: [], tailLines: [], commentSent: false, tap: null,
  });
  assert.deepEqual(oneShots.inFlightTickets(), [{ ticketId: 't-oneshot', role: 'assignee', agentId: 'rt-b' }]);
});

test('main.ts saves through the planned-restart hook and delivers on connect', () => {
  const src = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
  assert.match(src, /setPlannedRestartHook\(/, 'the restart path saves the interrupted work');
  assert.match(src, /onConnect: \(\) => \{[\s\S]*?deliverPendingRestartResume\(\);/, 'the new process hands it over once connected');
});
