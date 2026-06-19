// QA flow: silent-exit comment dedupe.
//
// The agent-manager posts a `system`-type comment via
// `/api/agent/tickets/:id/silent-exit-comment` whenever a subagent exits
// without leaving a real audit-trail row (silent-exit fallback). When the
// same retry-loop fires N times in a row the controller must collapse the
// repeats into a single comment row with `repeat_count` + `last_repeated_at`
// bumped in place — otherwise the timeline drowns under identical error
// rows (see ticket 9450068e).
//
// This flow drives the REST endpoint directly with `fetch` (AGENT_DEV_MODE
// auth skip) and asserts:
//   1. First POST → fresh row, repeat_count NULL (== 1).
//   2. Second POST with identical fingerprint → SAME row id, repeat_count=2.
//   3. Third POST → repeat_count=3 + content/metadata reflect latest payload.
//   4. POST with DIFFERENT exit_code → new row (different fingerprint).
//   5. After an unrelated comment lands, even a same-fingerprint POST starts
//      a new row so the dedupe never erases timeline progression.

import test from 'node:test';
import assert from 'node:assert/strict';
import { bootApp, exitAfterTests, step } from '../helpers/boot.mjs';
import { setupKanbanScene, createTicket } from '../helpers/fixtures.mjs';

process.env.PORT = process.env.QA_SILENT_EXIT_PORT || '7822';

async function postSilentExit(port, ticketId, body) {
  const resp = await fetch(
    `http://127.0.0.1:${port}/api/agent/tickets/${encodeURIComponent(ticketId)}/silent-exit-comment`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
  );
  const json = await resp.json().catch(() => null);
  return { status: resp.status, body: json };
}

test('silent-exit dedupe collapses identical retries into one row', async (t) => {
  const { app, port, modules } = await bootApp({ port: parseInt(process.env.PORT, 10) });
  t.after(() => { void app.close().catch(() => {}); });
  const { getDataSourceToken } = modules;

  const { ws, columns } = await setupKanbanScene(app, getDataSourceToken, {
    workspaceName: 'silent-exit-dedupe',
  });
  const ticket = await createTicket(app, getDataSourceToken, {
    columnId: columns.inProgress.id,
    workspaceId: ws.id,
    title: 'silent-exit dedupe test',
  });

  const ds = app.get(getDataSourceToken());
  const commentRepo = ds.getRepository('Comment');

  step('First silent-exit POST creates a new system comment');
  const first = await postSilentExit(port, ticket.id, {
    content: 'Subagent exited (cycle 1) — exit 143',
    exit_code: 143,
    role: 'assignee',
    cycle_trigger_id: 'trigger-1',
    actor_name: 'agent-manager',
  });
  assert.equal(first.status, 201, 'first call returns 201 Created');
  assert.ok(first.body?.id, 'response carries comment id');
  const firstId = first.body.id;
  assert.equal(first.body.type, 'system');
  // NULL repeat_count is treated as "occurred once" by the client.
  assert.ok(first.body.repeat_count === null || first.body.repeat_count === undefined || first.body.repeat_count === 1,
    `first row repeat_count should be NULL/1, got ${first.body.repeat_count}`);

  step('Second identical-fingerprint POST bumps repeat_count in place');
  const second = await postSilentExit(port, ticket.id, {
    content: 'Subagent exited (cycle 2) — exit 143',
    exit_code: 143,
    role: 'assignee',
    cycle_trigger_id: 'trigger-2',
    actor_name: 'agent-manager',
  });
  assert.equal(second.status, 200, 'dedupe returns 200 OK (not 201)');
  assert.equal(second.body.id, firstId, 'same row id is reused');
  assert.equal(second.body.repeat_count, 2, 'repeat_count bumped to 2');
  assert.ok(second.body.last_repeated_at, 'last_repeated_at populated');
  assert.match(second.body.content, /cycle 2/, 'content refreshed to latest payload');

  step('Third identical POST keeps bumping');
  const third = await postSilentExit(port, ticket.id, {
    content: 'Subagent exited (cycle 3) — exit 143',
    exit_code: 143,
    role: 'assignee',
    cycle_trigger_id: 'trigger-3',
    actor_name: 'agent-manager',
  });
  assert.equal(third.body.id, firstId);
  assert.equal(third.body.repeat_count, 3);

  // Only one row should exist on the ticket so far.
  const rowsAfterDedupe = await commentRepo.find({ where: { ticket_id: ticket.id } });
  assert.equal(rowsAfterDedupe.length, 1, 'three retries collapse into one row');

  step('Different exit_code fingerprints into a new row');
  const fourth = await postSilentExit(port, ticket.id, {
    content: 'Subagent exited (cycle 4) — exit 137',
    exit_code: 137,
    role: 'assignee',
    cycle_trigger_id: 'trigger-4',
    actor_name: 'agent-manager',
  });
  assert.equal(fourth.status, 201, 'different fingerprint creates a new row');
  assert.notEqual(fourth.body.id, firstId, 'new comment id');
  const rowsAfterMixed = await commentRepo.find({ where: { ticket_id: ticket.id } });
  assert.equal(rowsAfterMixed.length, 2, 'now two distinct system rows');

  step('User comment in between breaks the dedupe chain');
  // Drop a non-system comment so the next silent-exit can no longer collapse
  // against the previous fingerprint match.
  await commentRepo.save(commentRepo.create({
    ticket_id: ticket.id,
    author_type: 'user',
    author_id: '',
    author: 'Operator',
    content: 'please investigate',
    type: 'note',
  }));
  const fifth = await postSilentExit(port, ticket.id, {
    content: 'Subagent exited (cycle 5) — exit 137',
    exit_code: 137,
    role: 'assignee',
    cycle_trigger_id: 'trigger-5',
    actor_name: 'agent-manager',
  });
  assert.equal(fifth.status, 201, 'reply in between starts a fresh occurrence row');
  assert.notEqual(fifth.body.id, fourth.body.id, 'new id, not folded into the cycle-4 row');

  exitAfterTests(0);
});
