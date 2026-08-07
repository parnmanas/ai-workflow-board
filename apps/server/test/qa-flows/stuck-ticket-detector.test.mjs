// QA flow: StuckTicketDetectorService — stale-WAIT alert + dedup + unstuck
// (ticket 8e934802).
//
// What this proves
// ────────────────
//
// `StuckTicketDetectorService.sweep()` is the in-process equivalent of one
// interval tick. The five acceptance bullets from the ticket spec map 1:1
// to subtests below:
//
//   1. (B-5 reproducer) Boot with 5 WAIT-shaped comments → sweep flags the
//      ticket, posts a chat-room message in the workspace's oldest room,
//      and writes a `stuck_alerts` row.
//   2. (kill-switch) `STUCK_DETECTOR_ENABLED=false` → no flag, no DB write.
//   3. (unstuck) Move the alerted ticket to a fresh column → next sweep
//      emits the "ticket_unstuck" message and deletes the row.
//   4. (fast-loop guard) 4 agent comments inside 30 seconds with no time
//      span → not flagged.
//   5. (dedup) Two sweeps inside the cooldown → at most one new chat row
//      per ticket.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootApp, exitAfterTests, step } from '../helpers/boot.mjs';
import {
  createWorkspace,
  createAgent,
  createBoard,
  createColumn,
  createTicket,
} from '../helpers/fixtures.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST_ROOT = path.resolve(__dirname, '..', '..', 'dist');

process.env.PORT = process.env.QA_STUCK_DETECTOR_PORT || '7831';

// ─── helpers ─────────────────────────────────────────────────────────────

/**
 * Backdate a row's timestamp columns (created_at / updated_at) via an
 * UPDATE — TypeORM auto-fills these on save, so the fixture path can't
 * write a historical date directly. We need this because the detector's
 * MIN_AGE_MS / MIN_SPAN_MS guards key off the actual stored timestamps.
 */
async function backdate(repo, id, fields) {
  const updates = {};
  if (fields.created_at) updates.created_at = fields.created_at;
  if (fields.updated_at) updates.updated_at = fields.updated_at;
  if (Object.keys(updates).length > 0) await repo.update(id, updates);
}

async function seedAgentComment(commentRepo, ticketId, workspaceId, agentName, content, createdAt, agentId = 'agent-fixture') {
  const saved = await commentRepo.save(commentRepo.create({
    ticket_id: ticketId,
    workspace_id: workspaceId,
    author_type: 'agent',
    author_id: agentId,
    author: agentName,
    content,
    type: 'note',
  }));
  await backdate(commentRepo, saved.id, { created_at: createdAt });
  // Re-read so the returned row reflects the backdated timestamp.
  return commentRepo.findOne({ where: { id: saved.id } });
}

async function seedDispatch(activityRepo, ticket, agentId, createdAt) {
  const saved = await activityRepo.save(activityRepo.create({
    workspace_id: ticket.workspace_id,
    entity_type: 'ticket',
    entity_id: ticket.id,
    ticket_id: ticket.id,
    actor_id: 'system',
    actor_name: 'qa',
    action: 'trigger_emitted',
    new_value: JSON.stringify({ target_agent_id: agentId }),
  }));
  await backdate(activityRepo, saved.id, { created_at: createdAt });
}

async function seedAssigneeChange(activityRepo, ticket, oldName, newName, createdAt, rootTicketId = ticket.id) {
  const saved = await activityRepo.save(activityRepo.create({
    workspace_id: ticket.workspace_id,
    entity_type: 'ticket',
    entity_id: ticket.id,
    ticket_id: rootTicketId,
    actor_id: 'operator',
    actor_name: 'qa',
    action: 'updated',
    field_changed: 'assignee',
    old_value: oldName,
    new_value: newName,
  }));
  await backdate(activityRepo, saved.id, { created_at: createdAt });
}

async function seedLockChange(activityRepo, ticket, agentId, createdAt, releasing = false) {
  const saved = await activityRepo.save(activityRepo.create({
    workspace_id: ticket.workspace_id,
    entity_type: 'ticket',
    entity_id: ticket.id,
    ticket_id: ticket.id,
    actor_id: agentId,
    actor_name: 'qa',
    action: 'updated',
    field_changed: 'locked_by_agent_id',
    old_value: releasing ? agentId : '',
    new_value: releasing ? '' : agentId,
    trigger_source: releasing ? 'agent_release' : 'agent_claim',
  }));
  await backdate(activityRepo, saved.id, { created_at: createdAt });
}

async function seedChatRoom(roomRepo, workspaceId) {
  return roomRepo.save(roomRepo.create({
    workspace_id: workspaceId,
    type: 'group',
    name: 'qa-alerts',
  }));
}

function countSystemMessages(messages) {
  return messages.filter(m => m.sender_type === 'system').length;
}

test('StuckTicketDetectorService — acceptance bullets 1..5', async (t) => {
  step('Boot NestJS app on test port');
  // Ensure the env defaults are in effect for this run — the detector
  // reads env at construction time, so we set explicit values here
  // BEFORE bootApp so the in-process service instance picks them up.
  process.env.STUCK_DETECTOR_ENABLED = 'true';
  process.env.STUCK_DETECTOR_SWEEP_MS = '60000';
  process.env.STUCK_DETECTOR_WINDOW = '4';
  // 2 hours min span / age so the fast-loop case (30s span) reliably
  // fails the guard, and the stuck-case (4 hours of spacing) passes.
  process.env.STUCK_DETECTOR_MIN_SPAN_MS = String(2 * 60 * 60_000);
  process.env.STUCK_DETECTOR_MIN_AGE_MS  = String(2 * 60 * 60_000);
  process.env.STUCK_DETECTOR_REALERT_MS  = String(24 * 60 * 60_000);

  const { app, modules } = await bootApp({ port: parseInt(process.env.PORT, 10) });
  t.after(() => { void app.close().catch(() => {}); });
  const { getDataSourceToken } = modules;
  const ds = app.get(getDataSourceToken());

  const detectorModule = await import(
    'file://' + path.join(DIST_ROOT, 'modules', 'agents', 'stuck-ticket-detector.service.js')
  );
  const detector = app.get(detectorModule.StuckTicketDetectorService);
  const agentStatusModule = await import(
    'file://' + path.join(DIST_ROOT, 'modules', 'agents', 'agent-status.service.js')
  );
  const agentStatus = app.get(agentStatusModule.AgentStatusService);

  // ── Common workspace + board + columns + chat room ──────────────────
  step('Seed workspace + board + columns + chat alerts room');
  const ws = await createWorkspace(app, getDataSourceToken, 'stuck');
  const aliceAgent = await createAgent(app, getDataSourceToken, ws.id, { name: 'alice' });
  const board = await createBoard(app, getDataSourceToken, ws.id, { name: 'qa-stuck' });

  const intake = await createColumn(app, getDataSourceToken, board.id, {
    name: 'Backlog', position: 0, workspaceId: ws.id, kind: 'intake', roleRouting: [],
  });
  const todoCol = await createColumn(app, getDataSourceToken, board.id, {
    name: 'To Do', position: 1, workspaceId: ws.id, kind: 'active', roleRouting: ['assignee'],
  });
  const inProgress = await createColumn(app, getDataSourceToken, board.id, {
    name: 'In Progress', position: 2, workspaceId: ws.id, kind: 'active', roleRouting: ['assignee'],
  });
  const done = await createColumn(app, getDataSourceToken, board.id, {
    name: 'Done', position: 3, workspaceId: ws.id, isTerminal: true, kind: 'terminal', roleRouting: [],
  });

  // Sanity: silence the unused-binding lint for fixtures we want to
  // keep around in scope for future test extensions.
  void intake; void done;

  const roomRepo = ds.getRepository('ChatRoom');
  const messageRepo = ds.getRepository('ChatRoomMessage');
  const room = await seedChatRoom(roomRepo, ws.id);

  const ticketRepo = ds.getRepository('Ticket');
  const commentRepo = ds.getRepository('Comment');
  const alertRepo = ds.getRepository('StuckTicketAlert');
  const activityRepo = ds.getRepository('ActivityLog');

  const now = new Date();
  const HOUR = 3_600_000;

  // Shared between subtests: AC#1 flags this ticket and AC#3 expects to
  // observe the matching alert row + emit the unstuck message for it.
  let ac1TicketId = null;

  // ── AC#1 — Stuck ticket gets flagged + alert message posted ────────
  await t.test('AC#1: 5 WAIT-shaped comments → flagged + chat alert posted', async () => {
    step('Create B-5-style ticket on To Do, 5 hours old');
    const ticket = await createTicket(app, getDataSourceToken, {
      columnId: todoCol.id,
      workspaceId: ws.id,
      title: 'B-5 stuck reproducer',
      assigneeId: aliceAgent.id,
    });
    ac1TicketId = ticket.id; // hand off to AC#3
    // Backdate to 5h ago so the MIN_AGE_MS=2h grace period passes.
    await backdate(ticketRepo, ticket.id, {
      created_at: new Date(now.getTime() - 5 * HOUR),
      updated_at: new Date(now.getTime() - 5 * HOUR),
    });
    await seedDispatch(activityRepo, ticket, aliceAgent.id, new Date(now.getTime() - 5 * HOUR));

    step('Seed 5 agent WAIT comments, spaced 1h apart over 4h span');
    for (let i = 4; i >= 0; i--) {
      // Latest (i=0) is "now - 0h", oldest (i=4) is "now - 4h".
      await seedAgentComment(commentRepo, ticket.id, ws.id, 'alice',
        `WAIT stands — re-check ${5 - i}`,
        new Date(now.getTime() - i * HOUR), aliceAgent.id);
    }

    step('Run one sweep');
    const stats = await detector.sweep(now);
    assert.equal(stats.scanned >= 1, true, 'sweep must have scanned at least this ticket');
    assert.equal(stats.flagged, 1, 'expected exactly one newly-flagged ticket');

    const alert = await alertRepo.findOne({ where: { ticket_id: ticket.id } });
    assert.ok(alert, 'stuck_alerts row must exist for the flagged ticket');
    assert.equal(alert.last_cycle_count, 4, 'cycle count should equal the configured window (4)');

    const msgs = await messageRepo.find({ where: { room_id: room.id } });
    assert.equal(countSystemMessages(msgs), 1, 'exactly one system chat alert posted');
    const sys = msgs.find(m => m.sender_type === 'system');
    assert.ok(sys.content.includes(ticket.id), 'alert message must include the ticket UUID');
    assert.match(sys.content, /Stale-WAIT detected/, 'alert message must label itself as stale-WAIT');
    assert.match(sys.content, /cycles:\s*4/, 'alert message must include cycle count');
  });

  // ── AC#3 — Unstuck transition emits ticket_unstuck + clears the row ─
  await t.test('AC#3: move alerted ticket forward → unstuck message + row deleted', async () => {
    // Re-use the same room; re-scope the assertion to "messages added
    // by THIS subtest" by comparing counts before/after.
    const before = await messageRepo.find({ where: { room_id: room.id } });
    const beforeSystemCount = countSystemMessages(before);

    assert.ok(ac1TicketId, 'AC#1 must have run first and populated ac1TicketId');
    const stuckRow = await alertRepo.findOne({ where: { ticket_id: ac1TicketId } });
    assert.ok(stuckRow, 'AC#1 must have left a stuck_alerts row in place for its ticket');

    step('Move the stuck ticket to In Progress (column move = lifecycle event)');
    await ticketRepo.update(stuckRow.ticket_id, { column_id: inProgress.id });
    // Mirror the production `move_ticket` path which writes an
    // ActivityLog row alongside the column change. The detector's
    // unstuck check looks at activity history (not just ticket.column_id)
    // because that's the canonical record of "something happened here".
    const ActivityService = (await import('file://' + path.join(DIST_ROOT, 'services', 'activity.service.js')))
      .ActivityService;
    const activityService = app.get(ActivityService);
    await activityService.logActivity({
      entity_type: 'ticket',
      entity_id: stuckRow.ticket_id,
      ticket_id: stuckRow.ticket_id,
      action: 'moved',
      field_changed: 'column',
      old_value: todoCol.id,
      new_value: inProgress.id,
      actor_id: 'qa-driver',
      actor_name: 'qa',
    });

    step('Run the next sweep');
    // Real wall-clock time — the activity row above was inserted with a fresh
    // (real-time) created_at by @CreateDateColumn, which lies AFTER the
    // recorded `now` but before this Date(). Using `now + 1s` here would
    // leave the activity outside the (last_alerted_at, sweep_now) lifecycle
    // window and silently mis-flag the test as a detector bug.
    const stats = await detector.sweep(new Date());
    assert.equal(stats.unstuck >= 1, true, 'sweep must report >=1 unstuck');

    const after = await messageRepo.find({ where: { room_id: room.id } });
    assert.equal(
      countSystemMessages(after) - beforeSystemCount,
      1,
      'exactly one new system chat message (the unstuck notice) must have been posted',
    );
    // SQLite CURRENT_TIMESTAMP is second-precision, so AC#1's stale-WAIT
    // post and AC#3's unstuck post can land in the same second; sorting
    // by created_at to pick "the newest" is undefined in that tie. Find
    // the unstuck row by content shape — only one such row exists for
    // this ticket in this run.
    const unstuckMsg = after.find(m =>
      m.sender_type === 'system' &&
      /ticket_unstuck/.test(m.content) &&
      m.content.includes(stuckRow.ticket_id));
    assert.ok(unstuckMsg, 'unstuck message must reference the ticket and use the ticket_unstuck token');

    const remaining = await alertRepo.findOne({ where: { ticket_id: stuckRow.ticket_id } });
    assert.equal(remaining, null, 'stuck_alerts row must be deleted after unstuck');
  });

  // ── AC#2 — Disabled kill-switch ────────────────────────────────────
  await t.test('AC#2: STUCK_DETECTOR_ENABLED=false → no alerts, no DB writes', async () => {
    step('Seed a fresh stuck ticket with 4 WAIT comments');
    const ticket = await createTicket(app, getDataSourceToken, {
      columnId: todoCol.id, workspaceId: ws.id,
      title: 'disabled-kill-switch ticket', assigneeId: aliceAgent.id,
    });
    await backdate(ticketRepo, ticket.id, {
      created_at: new Date(now.getTime() - 5 * HOUR),
      updated_at: new Date(now.getTime() - 5 * HOUR),
    });
    await seedDispatch(activityRepo, ticket, aliceAgent.id, new Date(now.getTime() - 5 * HOUR));
    for (let i = 3; i >= 0; i--) {
      await seedAgentComment(commentRepo, ticket.id, ws.id, 'alice',
        `WAIT stands — disabled check ${4 - i}`,
        new Date(now.getTime() - i * HOUR), aliceAgent.id);
    }

    // Detector config is loaded at construction; instantiate a fresh
    // one with the kill-switch flipped so we don't have to reboot the
    // app to assert the env path.
    const RoomMessagingService =
      (await import('file://' + path.join(DIST_ROOT, 'modules', 'chat-rooms', 'room-messaging.service.js')))
        .RoomMessagingService;
    const LogService = (await import('file://' + path.join(DIST_ROOT, 'services', 'log.service.js')))
      .LogService;

    const messaging = app.get(RoomMessagingService);
    const logService = app.get(LogService);
    // v0.42 — detector now depends on ColumnRolePolicyService for the
    // policy-violation enrichment branch. Resolve from the live app so
    // the construct call matches the production wiring.
    const ColumnRolePolicyService =
      (await import('file://' + path.join(DIST_ROOT, 'modules', 'column-policies', 'column-role-policy.service.js')))
        .ColumnRolePolicyService;
    const policies = app.get(ColumnRolePolicyService);
    // Construct a disabled detector directly. ds is the shared
    // DataSource — the detector reads its own env via process.env.
    const prev = process.env.STUCK_DETECTOR_ENABLED;
    process.env.STUCK_DETECTOR_ENABLED = 'false';
    const disabled = new detectorModule.StuckTicketDetectorService(ds, logService, messaging, policies);
    process.env.STUCK_DETECTOR_ENABLED = prev;

    const before = await alertRepo.find({ where: { ticket_id: ticket.id } });
    const beforeMsgs = (await messageRepo.find({ where: { room_id: room.id } })).length;

    const stats = await disabled.sweep(now);
    assert.equal(stats.skipped_disabled, true, 'sweep stats must surface the disabled flag');
    assert.equal(stats.flagged, 0, 'disabled sweep must not flag anything');

    const after = await alertRepo.find({ where: { ticket_id: ticket.id } });
    const afterMsgs = (await messageRepo.find({ where: { room_id: room.id } })).length;
    assert.equal(after.length, before.length, 'disabled sweep must not write stuck_alerts rows');
    assert.equal(afterMsgs, beforeMsgs, 'disabled sweep must not post any chat messages');
  });

  // ── AC#4 — Fast-loop guard ─────────────────────────────────────────
  await t.test('AC#4: 4 agent comments inside 30s → NOT flagged (min-span guard)', async () => {
    step('Create a fast-loop ticket with 4 comments inside 30 seconds');
    const ticket = await createTicket(app, getDataSourceToken, {
      columnId: todoCol.id, workspaceId: ws.id,
      title: 'fast-loop guard ticket', assigneeId: aliceAgent.id,
    });
    await backdate(ticketRepo, ticket.id, {
      created_at: new Date(now.getTime() - 5 * HOUR),
      updated_at: new Date(now.getTime() - 5 * HOUR),
    });
    await seedDispatch(activityRepo, ticket, aliceAgent.id, new Date(now.getTime() - 5 * HOUR));
    // All comments in the last 30s — well under the 2h min-span guard.
    for (let i = 3; i >= 0; i--) {
      await seedAgentComment(commentRepo, ticket.id, ws.id, 'alice',
        `fast loop ${4 - i}`,
        new Date(now.getTime() - i * 7_000), aliceAgent.id); // 0s, 7s, 14s, 21s ago
    }

    const beforeAlert = await alertRepo.findOne({ where: { ticket_id: ticket.id } });
    assert.equal(beforeAlert, null, 'no pre-existing alert row for the fresh ticket');

    await detector.sweep(now);

    const afterAlert = await alertRepo.findOne({ where: { ticket_id: ticket.id } });
    assert.equal(afterAlert, null, 'min-span guard must suppress fast-loop comments');
  });

  // ── AC#5 — Dedup: two sweeps inside cooldown → one alert ───────────
  await t.test('AC#5: two sweeps inside cooldown → only one alert chat row', async () => {
    step('Create a fresh stuck ticket with 4 spaced WAIT comments');
    const ticket = await createTicket(app, getDataSourceToken, {
      columnId: todoCol.id, workspaceId: ws.id,
      title: 'dedup probe ticket', assigneeId: aliceAgent.id,
    });
    await backdate(ticketRepo, ticket.id, {
      created_at: new Date(now.getTime() - 5 * HOUR),
      updated_at: new Date(now.getTime() - 5 * HOUR),
    });
    await seedDispatch(activityRepo, ticket, aliceAgent.id, new Date(now.getTime() - 5 * HOUR));
    for (let i = 3; i >= 0; i--) {
      await seedAgentComment(commentRepo, ticket.id, ws.id, 'alice',
        `WAIT stands — dedup check ${4 - i}`,
        new Date(now.getTime() - i * HOUR), aliceAgent.id);
    }

    const beforeMsgs = (await messageRepo.find({ where: { room_id: room.id } })).length;

    step('Two consecutive sweeps inside the realert cooldown');
    await detector.sweep(now);
    await detector.sweep(new Date(now.getTime() + 60_000)); // 1 min later

    const afterMsgs = (await messageRepo.find({ where: { room_id: room.id } })).length;
    assert.equal(afterMsgs - beforeMsgs, 1, 'second sweep must dedup — only one alert row appears');

    const alert = await alertRepo.findOne({ where: { ticket_id: ticket.id } });
    assert.ok(alert, 'first sweep should have created the alert row');
    assert.equal(alert.last_cycle_count, 4, 'cycle count unchanged across dedup');
  });

  await t.test('(A) intake uses promotion_delay and comments do not resolve it', async () => {
    const ticket = await createTicket(app, getDataSourceToken, {
      columnId: intake.id, workspaceId: ws.id, title: 'delayed promotion',
    });
    await backdate(ticketRepo, ticket.id, { created_at: new Date(now.getTime() - 3 * HOUR) });
    await detector.sweep(now);
    let alert = await alertRepo.findOne({ where: { ticket_id: ticket.id } });
    assert.equal(alert?.cause, 'promotion_delay');

    await seedAgentComment(commentRepo, ticket.id, ws.id, 'operator', 'triage only', now);
    await detector.sweep(new Date(now.getTime() + 1_000));
    alert = await alertRepo.findOne({ where: { ticket_id: ticket.id } });
    assert.equal(alert?.cause, 'promotion_delay', 'intake comment must not produce unstuck');

    await ticketRepo.update(ticket.id, { column_id: todoCol.id });
    const move = await activityRepo.save(activityRepo.create({
      workspace_id: ws.id, entity_type: 'ticket', entity_id: ticket.id, ticket_id: ticket.id,
      action: 'moved', field_changed: 'column', old_value: intake.id, new_value: todoCol.id,
    }));
    void move;
    await detector.sweep(new Date());
    assert.equal(await alertRepo.findOne({ where: { ticket_id: ticket.id } }), null);
  });

  await t.test('(A) promotion_delay restarts from a production-shaped intake re-entry', async () => {
    const ticket = await createTicket(app, getDataSourceToken, {
      columnId: intake.id, workspaceId: ws.id, title: 'recent intake re-entry',
    });
    await backdate(ticketRepo, ticket.id, { created_at: new Date(now.getTime() - 5 * HOUR) });

    const enteredAt = new Date(now.getTime() - HOUR);
    const move = await activityRepo.save(activityRepo.create({
      workspace_id: ws.id,
      entity_type: 'ticket',
      entity_id: ticket.id,
      ticket_id: ticket.id,
      action: 'moved',
      field_changed: 'column',
      old_value: todoCol.name,
      new_value: intake.name,
    }));
    await backdate(activityRepo, move.id, { created_at: enteredAt });

    await detector.sweep(now);
    assert.equal(
      await alertRepo.findOne({ where: { ticket_id: ticket.id } }),
      null,
      'old ticket must not alert before the re-entry promotion threshold',
    );

    await detector.sweep(new Date(enteredAt.getTime() + 2 * HOUR + 1));
    const alert = await alertRepo.findOne({ where: { ticket_id: ticket.id } });
    assert.equal(alert?.cause, 'promotion_delay', 're-entry alerts only after its own threshold');
  });

  await t.test('(A) undelivered promotion_delay retries next sweep and only delivery starts cooldown', async () => {
    const noRoomWs = await createWorkspace(app, getDataSourceToken, 'promotion-retry');
    const noRoomBoard = await createBoard(app, getDataSourceToken, noRoomWs.id, { name: 'promotion-retry' });
    const noRoomIntake = await createColumn(app, getDataSourceToken, noRoomBoard.id, {
      name: 'Intake', position: 0, workspaceId: noRoomWs.id, kind: 'intake', roleRouting: [],
    });
    const ticket = await createTicket(app, getDataSourceToken, {
      columnId: noRoomIntake.id, workspaceId: noRoomWs.id, title: 'durable promotion alert',
    });
    await backdate(ticketRepo, ticket.id, { created_at: new Date(now.getTime() - 3 * HOUR) });

    await detector.sweep(now);
    let alert = await alertRepo.findOne({ where: { ticket_id: ticket.id } });
    assert.equal(alert?.delivered_at, null, 'missing alert room leaves delivery owed');
    assert.equal(alert?.delivery_attempts, 1);

    const retryRoom = await seedChatRoom(roomRepo, noRoomWs.id);
    await detector.sweep(new Date(now.getTime() + 1_000));
    alert = await alertRepo.findOne({ where: { ticket_id: ticket.id } });
    assert.ok(alert?.delivered_at, 'next sweep retries and records successful delivery');
    assert.equal(alert?.delivery_attempts, 2);
    assert.equal(
      countSystemMessages(await messageRepo.find({ where: { room_id: retryRoom.id } })),
      1,
      'retry posts exactly one promotion-delay alert',
    );

    await detector.sweep(new Date(now.getTime() + 2_000));
    assert.equal(
      (await alertRepo.findOne({ where: { ticket_id: ticket.id } }))?.delivery_attempts,
      2,
      'successful delivered_at, not the failed attempt, starts cooldown',
    );

    const exceptionTicket = await createTicket(app, getDataSourceToken, {
      columnId: noRoomIntake.id, workspaceId: noRoomWs.id, title: 'promotion send exception',
    });
    await backdate(ticketRepo, exceptionTicket.id, {
      created_at: new Date(now.getTime() - 3 * HOUR),
    });
    const originalSend = detector.messaging.sendSystemMessage.bind(detector.messaging);
    detector.messaging.sendSystemMessage = async () => { throw new Error('qa send failure'); };
    try {
      await detector.sweep(new Date(now.getTime() + 3_000));
    } finally {
      detector.messaging.sendSystemMessage = originalSend;
    }
    let exceptionAlert = await alertRepo.findOne({ where: { ticket_id: exceptionTicket.id } });
    assert.equal(exceptionAlert?.delivered_at, null, 'send exception also leaves delivery owed');

    await detector.sweep(new Date(now.getTime() + 4_000));
    exceptionAlert = await alertRepo.findOne({ where: { ticket_id: exceptionTicket.id } });
    assert.ok(exceptionAlert?.delivered_at, 'send exception is retried successfully next sweep');
    assert.equal(exceptionAlert?.delivery_attempts, 2);
  });

  await t.test('(B) only comments attributed to the current dispatch epoch are progress', async () => {
    const ticket = await createTicket(app, getDataSourceToken, {
      columnId: todoCol.id, workspaceId: ws.id, title: 'operator comment false progress',
      assigneeId: aliceAgent.id,
    });
    await backdate(ticketRepo, ticket.id, { created_at: new Date(now.getTime() - 5 * HOUR) });
    await detector.sweep(now);
    assert.equal((await alertRepo.findOne({ where: { ticket_id: ticket.id } }))?.cause, 'no_progress');

    await seedAgentComment(commentRepo, ticket.id, ws.id, 'operator', 'triage note', now, 'other-agent');
    await detector.sweep(new Date(now.getTime() + 1_000));
    assert.ok(await alertRepo.findOne({ where: { ticket_id: ticket.id } }),
      'non-epoch agent comment must not resolve the alert');

    await seedDispatch(activityRepo, ticket, aliceAgent.id, now);
    await seedAgentComment(commentRepo, ticket.id, ws.id, 'alice', 'work started', now, aliceAgent.id);
    await detector.sweep(new Date(now.getTime() + 2_000));
    assert.equal(await alertRepo.findOne({ where: { ticket_id: ticket.id } }), null);
  });

  await t.test('(B) A→B→A reassignment does not resurrect A dispatch or old comments', async () => {
    const parent = await createTicket(app, getDataSourceToken, {
      columnId: todoCol.id, workspaceId: ws.id, title: 'benchmark run parent',
    });
    const ticket = await createTicket(app, getDataSourceToken, {
      columnId: todoCol.id, workspaceId: ws.id, title: 'reassignment epoch boundary',
      assigneeId: aliceAgent.id,
      parentId: parent.id, depth: 1,
    });
    const fiveHoursAgo = new Date(now.getTime() - 5 * HOUR);
    await backdate(ticketRepo, ticket.id, { created_at: fiveHoursAgo });
    await seedDispatch(activityRepo, ticket, aliceAgent.id, fiveHoursAgo);
    await seedAgentComment(
      commentRepo, ticket.id, ws.id, 'alice', 'progress in original A epoch',
      new Date(now.getTime() - 4 * HOUR), aliceAgent.id,
    );
    await seedAssigneeChange(
      activityRepo, ticket, 'alice', 'bob', new Date(now.getTime() - 2 * HOUR), parent.id,
    );
    await seedAssigneeChange(
      activityRepo, ticket, 'bob', 'alice', new Date(now.getTime() - HOUR), parent.id,
    );
    // More than the dispatch query's bounded window must not hide the
    // separately queried child reassignment boundary.
    for (let i = 0; i < 101; i += 1) {
      await seedDispatch(
        activityRepo, ticket, 'prior-agent',
        new Date(now.getTime() - 3 * HOUR + i),
      );
    }
    await ticketRepo.update(ticket.id, { assignee_id: aliceAgent.id, assignee: 'alice' });

    await detector.sweep(now);
    let alert = await alertRepo.findOne({ where: { ticket_id: ticket.id } });
    assert.equal(alert?.cause, 'no_progress');
    assert.equal(alert?.last_cycle_count, 0, 'returning A has no dispatch epoch yet');
    const firstAlertMessage = (await messageRepo.find({ where: { room_id: room.id } }))
      .find(message => message.content.includes(ticket.id));
    assert.match(
      firstAlertMessage?.content || '',
      /never dispatched/i,
      'A→B→A without a new A dispatch is classified as never dispatched',
    );

    await seedAgentComment(
      commentRepo, ticket.id, ws.id, 'alice', 'comment after return but before dispatch',
      new Date(now.getTime() + 1_000), aliceAgent.id,
    );
    await detector.sweep(new Date(now.getTime() + 2_000));
    alert = await alertRepo.findOne({ where: { ticket_id: ticket.id } });
    assert.ok(alert, 'old or pre-dispatch A comments must not produce unstuck');
  });

  await t.test('(B) post-alert lock lifecycle is attributed to the current epoch', async () => {
    const ticket = await createTicket(app, getDataSourceToken, {
      columnId: todoCol.id, workspaceId: ws.id, title: 'lock attribution',
      assigneeId: aliceAgent.id,
    });
    await backdate(ticketRepo, ticket.id, { created_at: new Date(now.getTime() - 5 * HOUR) });
    await detector.sweep(now);
    assert.ok(await alertRepo.findOne({ where: { ticket_id: ticket.id } }));

    await seedLockChange(activityRepo, ticket, 'wrong-agent', new Date(now.getTime() + 1_000));
    await seedLockChange(activityRepo, ticket, 'wrong-agent', new Date(now.getTime() + 2_000), true);
    await detector.sweep(new Date(now.getTime() + 3_000));
    assert.ok(await alertRepo.findOne({ where: { ticket_id: ticket.id } }),
      'wrong-agent claim/release must leave the alert row in place');

    await seedLockChange(activityRepo, ticket, aliceAgent.id, new Date(now.getTime() + 4_000));
    await detector.sweep(new Date(now.getTime() + 5_000));
    assert.equal(await alertRepo.findOne({ where: { ticket_id: ticket.id } }), null,
      'current-assignee claim starts the current epoch and resolves the alert');
  });

  await t.test('(B) output liveness is scoped to the current dispatch epoch', async () => {
    const ticket = await createTicket(app, getDataSourceToken, {
      columnId: todoCol.id, workspaceId: ws.id, title: 'output attribution',
      assigneeId: aliceAgent.id,
    });
    const fiveHoursAgo = new Date(now.getTime() - 5 * HOUR);
    await backdate(ticketRepo, ticket.id, { created_at: fiveHoursAgo });
    await seedDispatch(activityRepo, ticket, aliceAgent.id, fiveHoursAgo);
    await detector.sweep(now);
    assert.ok(await alertRepo.findOne({ where: { ticket_id: ticket.id } }));

    agentStatus.recordOutputLiveness('wrong-agent', ticket.id, 'reviewer');
    await detector.sweep(new Date(Date.now() + 1_000));
    assert.ok(await alertRepo.findOne({ where: { ticket_id: ticket.id } }),
      'wrong-agent/reviewer output must leave the alert row in place');

    agentStatus.recordOutputLiveness(aliceAgent.id, ticket.id, 'assignee');
    await detector.sweep(new Date(Date.now() + 1_000));
    assert.equal(await alertRepo.findOne({ where: { ticket_id: ticket.id } }), null,
      'current-epoch assignee output resolves the alert');
  });

  await t.test('(C) exact benchmark-run parent with candidate child is excluded', async () => {
    const parent = await createTicket(app, getDataSourceToken, {
      columnId: todoCol.id, workspaceId: ws.id, title: 'benchmark container',
    });
    await ticketRepo.update(parent.id, {
      labels: JSON.stringify(['benchmark-run']),
      created_at: new Date(now.getTime() - 5 * HOUR),
    });
    const child = await createTicket(app, getDataSourceToken, {
      columnId: todoCol.id, workspaceId: ws.id, title: 'candidate',
      parentId: parent.id, depth: 1,
    });
    await ticketRepo.update(child.id, { labels: JSON.stringify(['benchmark-candidate']) });
    await detector.sweep(now);
    assert.equal(await alertRepo.findOne({ where: { ticket_id: parent.id } }), null);
  });

  await t.test('(D) open prerequisite excludes; stale pending flag does not', async () => {
    const blocked = await createTicket(app, getDataSourceToken, {
      columnId: todoCol.id, workspaceId: ws.id, title: 'blocked on prerequisite',
    });
    const dependency = await createTicket(app, getDataSourceToken, {
      columnId: todoCol.id, workspaceId: ws.id, title: 'dependency',
    });
    await ticketRepo.update(blocked.id, {
      pending_on_tickets: true,
      created_at: new Date(now.getTime() - 5 * HOUR),
    });
    const prerequisiteRepo = ds.getRepository('TicketPrerequisite');
    await prerequisiteRepo.save(prerequisiteRepo.create({
      ticket_id: blocked.id, prerequisite_ticket_id: dependency.id,
    }));
    await detector.sweep(now);
    assert.equal(await alertRepo.findOne({ where: { ticket_id: blocked.id } }), null);

    await ticketRepo.update(dependency.id, { column_id: done.id });
    await detector.sweep(new Date(now.getTime() + 1_000));
    assert.equal((await alertRepo.findOne({ where: { ticket_id: blocked.id } }))?.cause, 'no_progress',
      'stale pending flag without open prerequisite must not hide a stall');
  });

  // ── (E) ticket 9df6c348 — promoted_from_intake must not be attributed to
  // a manual rescue. A `promotion_delay` alert's resolution used to be
  // labelled `promoted_from_intake` the instant the ticket left intake, with
  // no check on WHAT moved it — masking exactly the level-triggered-backstop
  // gap that ticket exists to fix (a human always having to manually rescue
  // reads as "auto-promotion eventually succeeded").
  await t.test('(E) manual column move out of intake reports manually_moved_from_intake, not promoted_from_intake', async () => {
    const ticket = await createTicket(app, getDataSourceToken, {
      columnId: intake.id, workspaceId: ws.id, title: 'manual rescue from intake',
    });
    await backdate(ticketRepo, ticket.id, { created_at: new Date(now.getTime() - 3 * HOUR) });
    await detector.sweep(now);
    assert.equal((await alertRepo.findOne({ where: { ticket_id: ticket.id } }))?.cause, 'promotion_delay');

    const before = await messageRepo.find({ where: { room_id: room.id } });
    const beforeSystemCount = countSystemMessages(before);

    // Human/operator moves the ticket directly — no BacklogPromotionService
    // involved, so no `backlog_promoted` audit row exists for this ticket.
    await ticketRepo.update(ticket.id, { column_id: todoCol.id });
    await activityRepo.save(activityRepo.create({
      workspace_id: ws.id, entity_type: 'ticket', entity_id: ticket.id, ticket_id: ticket.id,
      action: 'moved', field_changed: 'column', old_value: intake.id, new_value: todoCol.id,
      actor_id: 'operator', actor_name: 'qa-human',
    }));

    await detector.sweep(new Date());
    assert.equal(await alertRepo.findOne({ where: { ticket_id: ticket.id } }), null);

    const after = await messageRepo.find({ where: { room_id: room.id } });
    assert.equal(countSystemMessages(after) - beforeSystemCount, 1,
      'exactly one unstuck message posted');
    const unstuckMsg = after.find(m =>
      m.sender_type === 'system' && /ticket_unstuck/.test(m.content) && m.content.includes(ticket.id));
    assert.ok(unstuckMsg, 'unstuck message must reference the ticket');
    assert.match(unstuckMsg.content, /reason:\s*manually_moved_from_intake/,
      'a manual column move with no backlog_promoted row must NOT be mislabeled as auto-promotion');
  });

  await t.test('(E) genuine BacklogPromotionService move reports promoted_from_intake', async () => {
    const ticket = await createTicket(app, getDataSourceToken, {
      columnId: intake.id, workspaceId: ws.id, title: 'genuine auto promotion',
    });
    await backdate(ticketRepo, ticket.id, { created_at: new Date(now.getTime() - 3 * HOUR) });
    await detector.sweep(now);
    assert.equal((await alertRepo.findOne({ where: { ticket_id: ticket.id } }))?.cause, 'promotion_delay');

    const before = await messageRepo.find({ where: { room_id: room.id } });
    const beforeSystemCount = countSystemMessages(before);

    // Mirror BacklogPromotionService.tryPromote's own writes: the column
    // move plus the `backlog_promoted` audit row (see backlog-promotion.
    // service.ts).
    await ticketRepo.update(ticket.id, { column_id: todoCol.id });
    await activityRepo.save(activityRepo.create({
      workspace_id: ws.id, entity_type: 'ticket', entity_id: ticket.id, ticket_id: ticket.id,
      action: 'moved', field_changed: 'column', old_value: intake.id, new_value: todoCol.id,
      actor_id: 'system', actor_name: 'BacklogPromotionService', trigger_source: 'backlog_promotion',
    }));
    await activityRepo.save(activityRepo.create({
      workspace_id: ws.id, entity_type: 'ticket', entity_id: ticket.id, ticket_id: ticket.id,
      action: 'backlog_promoted', actor_id: 'system', actor_name: 'BacklogPromotionService',
      new_value:
        `from=${intake.id} to=${todoCol.id} priority_index=2 chain_target=false ` +
        `triggered_by=system:level_tick holders=`,
      trigger_source: 'backlog_promotion',
    }));

    await detector.sweep(new Date());
    assert.equal(await alertRepo.findOne({ where: { ticket_id: ticket.id } }), null);

    const after = await messageRepo.find({ where: { room_id: room.id } });
    assert.equal(countSystemMessages(after) - beforeSystemCount, 1,
      'exactly one unstuck message posted');
    const unstuckMsg = after.find(m =>
      m.sender_type === 'system' && /ticket_unstuck/.test(m.content) && m.content.includes(ticket.id));
    assert.ok(unstuckMsg, 'unstuck message must reference the ticket');
    assert.match(unstuckMsg.content, /reason:\s*promoted_from_intake/,
      'a genuine backlog_promoted row must be labeled as auto-promotion');
  });
});

test.after?.(() => exitAfterTests(0));
process.on('beforeExit', () => exitAfterTests(0));
