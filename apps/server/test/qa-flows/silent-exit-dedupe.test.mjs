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
import { setupKanbanScene, createAgent, createApiKey, createTicket } from '../helpers/fixtures.mjs';
import { McpClient } from '../helpers/mcp-client.mjs';

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

  step('A persisted exact-trigger agent comment suppresses the conditional warning');
  const raceTicket = await createTicket(app, getDataSourceToken, {
    columnId: columns.inProgress.id,
    workspaceId: ws.id,
    title: 'silent-exit grace race test',
  });
  const cycleStartedAt = new Date(Date.now() - 1_000);
  const agentComment = {
    ticket_id: raceTicket.id,
    author_type: 'agent',
    author_id: 'agent-race',
    author: 'Race Agent',
    content: 'work persisted immediately before exit',
    type: 'note',
    metadata: JSON.stringify({
      author_role: 'assignee',
      cycle_trigger_id: 'trigger-race',
      subagent_session_id: 'session-race',
    }),
  };
  const auditBody = {
    content: 'must not be created',
    exit_code: 0,
    role: 'assignee',
    cycle_trigger_id: 'trigger-race',
    agent_id: 'agent-race',
    subagent_session_id: 'session-race',
    cycle_started_at: cycleStartedAt.toISOString(),
  };

  let suppressed;
  if ((process.env.DB_TYPE || 'sqlite') === 'postgres') {
    // Hold the shared ticket-row lock on the comment writer's connection,
    // start the exit audit on another pooled connection, then commit the
    // comment. Before the fix the audit's SELECT could finish and later insert
    // a warning alongside this comment. Now the audit cannot cross the lock:
    // after the writer commits, its in-transaction recheck sees the row.
    let writerLocked;
    let releaseWriter;
    const locked = new Promise((resolve) => { writerLocked = resolve; });
    const release = new Promise((resolve) => { releaseWriter = resolve; });
    const writer = ds.transaction(async (manager) => {
      await manager.getRepository('Ticket').findOne({
        where: { id: raceTicket.id },
        lock: { mode: 'pessimistic_write' },
      });
      writerLocked();
      await release;
      await manager.getRepository('Comment').save(
        manager.getRepository('Comment').create(agentComment),
      );
    });
    await locked;
    const audit = postSilentExit(port, raceTicket.id, auditBody);
    let auditSettled = false;
    void audit.finally(() => { auditSettled = true; });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(auditSettled, false, 'audit waits behind the concurrent comment writer');
    releaseWriter();
    await writer;
    suppressed = await audit;
  } else {
    // sql.js owns one connection and cannot model two independently committing
    // transactions; keep the authoritative persisted-row assertion here while
    // the Postgres matrix exercises the real cross-connection interleaving.
    await commentRepo.save(commentRepo.create(agentComment));
    suppressed = await postSilentExit(port, raceTicket.id, auditBody);
  }
  assert.equal(suppressed.status, 200);
  assert.equal(suppressed.body.suppressed, true);
  assert.equal(
    (await commentRepo.find({ where: { ticket_id: raceTicket.id } })).length,
    1,
    'no silent-exit row is added after the persisted cycle comment',
  );

  step('The typed ask_question writer shares the same Postgres serialization boundary');
  const typedTicket = await createTicket(app, getDataSourceToken, {
    columnId: columns.inProgress.id,
    workspaceId: ws.id,
    title: 'typed comment silent-exit race test',
  });
  const typedAgent = await createAgent(app, getDataSourceToken, ws.id, { name: 'typed-race-agent' });
  const typedKey = await createApiKey(app, getDataSourceToken, typedAgent.id, {
    workspaceId: ws.id,
    label: 'typed-race-agent',
  });
  const typedTrigger = 'trigger-typed-race';
  const typedSession = 'session-typed-race';
  const mcp = new McpClient({
    baseUrl: `http://127.0.0.1:${port}`,
    apiKey: typedKey.raw_key,
    extraHeaders: {
      'x-awb-subagent-role': 'assignee',
      'x-awb-subagent-ticket-id': typedTicket.id,
      'x-awb-subagent-trigger-id': typedTrigger,
      'x-awb-subagent-session-id': typedSession,
    },
  });
  await mcp.initialize();
  t.after(() => { void mcp.close().catch(() => {}); });

  const typedAuditBody = {
    content: 'must not be created for typed writer',
    exit_code: 0,
    role: 'assignee',
    cycle_trigger_id: typedTrigger,
    agent_id: typedAgent.id,
    subagent_session_id: typedSession,
    cycle_started_at: cycleStartedAt.toISOString(),
  };
  let typedAudit;
  if ((process.env.DB_TYPE || 'sqlite') === 'postgres') {
    let releaseBarrier;
    const release = new Promise((resolve) => { releaseBarrier = resolve; });
    let barrierLocked;
    const locked = new Promise((resolve) => { barrierLocked = resolve; });
    const barrier = ds.transaction(async (manager) => {
      await manager.getRepository('Ticket').findOne({
        where: { id: typedTicket.id },
        lock: { mode: 'pessimistic_write' },
      });
      barrierLocked();
      await release;
    });
    await locked;

    // Queue the real typed writer first. Its implementation must acquire the
    // ticket-row lock before saving; the audit queued behind it must therefore
    // recheck after the question commits.
    const writer = mcp.callTool('ask_question', {
      ticket_id: typedTicket.id,
      content: 'typed work persisted immediately before exit',
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const audit = postSilentExit(port, typedTicket.id, typedAuditBody);
    await new Promise((resolve) => setTimeout(resolve, 50));
    releaseBarrier();
    await barrier;
    await writer;
    typedAudit = await audit;
  } else {
    await mcp.callTool('ask_question', {
      ticket_id: typedTicket.id,
      content: 'typed work persisted immediately before exit',
    });
    typedAudit = await postSilentExit(port, typedTicket.id, typedAuditBody);
  }
  assert.equal(typedAudit.status, 200);
  assert.equal(typedAudit.body.suppressed, true);
  const typedRows = await commentRepo.find({ where: { ticket_id: typedTicket.id } });
  assert.equal(typedRows.length, 1, 'typed writer leaves no false silent-exit warning');
  assert.equal(typedRows[0].type, 'question');

  step('A different trigger does not hide a genuinely silent exit');
  const genuine = await postSilentExit(port, raceTicket.id, {
    content: 'genuine silent exit',
    exit_code: 0,
    role: 'assignee',
    cycle_trigger_id: 'trigger-genuine-silent',
    agent_id: 'agent-race',
    subagent_session_id: 'different-session',
    cycle_started_at: cycleStartedAt.toISOString(),
  });
  assert.equal(genuine.status, 201);
  assert.equal(JSON.parse(genuine.body.metadata).reason, 'silent_exit');

  exitAfterTests(0);
});
