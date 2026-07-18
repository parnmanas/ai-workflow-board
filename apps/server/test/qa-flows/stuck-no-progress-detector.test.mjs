// QA flow: StuckTicketDetectorService — cause-agnostic NO-PROGRESS hard stall
// (ticket e7c87517).
//
// Root cause this proves the fix for: a ticket that NEVER got an agent running
// (worktree pool_exhausted / offline agent / focus starvation) has ZERO agent
// comments, so the stale-WAIT heuristic (needs ≥ WINDOW agent comments) is
// structurally blind to it — the real 25h-in-To-Do TerrainSystem stall raised
// NO operator alert. The new no-progress path flags it by symptom (no forward
// progress) regardless of cause, within a bound guaranteed < 24h.
//
// Subtests:
//   1. never-dispatched ticket (0 comments), 5h no progress → flagged + durable
//      StuckTicketAlert row + "No-progress stall detected" chat + stuck_no_progress
//      reason audit (reason=never_dispatched).
//   2. dedup — two sweeps inside the cooldown → one alert.
//   3. output-liveness suppression — a worker actively producing tokens (but
//      not writing the ticket) is NOT flagged (fdc69c13 signal honored).
//   4. pending exclusion — a parked (pending_user_action) ticket is never a stall.
//   5. unstuck — a column move (forward progress) clears the alert.
//   6. 24h guarantee — a 25h-no-progress ticket is ALWAYS flagged (impossible
//      to sit a full day with no alert).
//   7. REVIEW-kind column (blocker B1) — a ticket idle in Review with an offline
//      reviewer is flagged. Previously the candidate query only scanned
//      active/intake, so review/merging stalls raised ZERO alerts.
//   8. MERGING-kind column (blocker B1) — a ticket idle in Merging is flagged.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootApp, exitAfterTests, step } from '../helpers/boot.mjs';
import {
  createWorkspace, createAgent, createBoard, createColumn, createTicket,
} from '../helpers/fixtures.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST_ROOT = path.resolve(__dirname, '..', '..', 'dist');

process.env.PORT = process.env.QA_NO_PROGRESS_PORT || '7834';

async function backdate(repo, id, fields) {
  const updates = {};
  if (fields.created_at) updates.created_at = fields.created_at;
  if (fields.updated_at) updates.updated_at = fields.updated_at;
  if (Object.keys(updates).length > 0) await repo.update(id, updates);
}
function systemMsgs(messages) {
  return messages.filter(m => m.sender_type === 'system');
}

test('StuckTicketDetector — cause-agnostic no-progress hard stall', async (t) => {
  step('Boot NestJS app on test port');
  process.env.STUCK_DETECTOR_ENABLED = 'true';
  process.env.STUCK_DETECTOR_SWEEP_MS = '900000';
  process.env.STUCK_DETECTOR_MIN_AGE_MS = String(2 * 60 * 60_000); // 2h grace
  process.env.STUCK_DETECTOR_NO_PROGRESS_MS = String(3 * 60 * 60_000); // 3h threshold
  process.env.STUCK_DETECTOR_REALERT_MS = String(24 * 60 * 60_000);

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

  step('Seed workspace + board + columns + chat room + agent');
  const ws = await createWorkspace(app, getDataSourceToken, 'noprog');
  const agent = await createAgent(app, getDataSourceToken, ws.id, { name: 'ralf' });
  const board = await createBoard(app, getDataSourceToken, ws.id, { name: 'qa-noprog' });
  const todoCol = await createColumn(app, getDataSourceToken, board.id, {
    name: 'To Do', position: 1, workspaceId: ws.id, kind: 'active', roleRouting: ['assignee'],
  });
  const inProgress = await createColumn(app, getDataSourceToken, board.id, {
    name: 'In Progress', position: 2, workspaceId: ws.id, kind: 'active', roleRouting: ['assignee'],
  });
  // review / merging columns — non-terminal, agent-dispatching, and the exact
  // columns that reviewer blocker B1 (ticket e7c87517) said were being skipped.
  const reviewCol = await createColumn(app, getDataSourceToken, board.id, {
    name: 'Review', position: 3, workspaceId: ws.id, kind: 'review', roleRouting: ['reviewer'],
  });
  const mergingCol = await createColumn(app, getDataSourceToken, board.id, {
    name: 'Merging', position: 4, workspaceId: ws.id, kind: 'merging', roleRouting: ['assignee'],
  });

  const roomRepo = ds.getRepository('ChatRoom');
  const messageRepo = ds.getRepository('ChatRoomMessage');
  const ticketRepo = ds.getRepository('Ticket');
  const alertRepo = ds.getRepository('StuckTicketAlert');
  const activityRepo = ds.getRepository('ActivityLog');
  const room = await roomRepo.save(roomRepo.create({ workspace_id: ws.id, type: 'group', name: 'qa-alerts' }));

  const now = new Date();
  const HOUR = 3_600_000;

  const mkStaleTicket = async (title, ageHours = 5) => {
    const ticket = await createTicket(app, getDataSourceToken, {
      columnId: todoCol.id, workspaceId: ws.id, title, assigneeId: agent.id,
    });
    await backdate(ticketRepo, ticket.id, {
      created_at: new Date(now.getTime() - ageHours * HOUR),
      updated_at: new Date(now.getTime() - ageHours * HOUR),
    });
    return ticket;
  };

  let flaggedTicketId = null;

  await t.test('1: never-dispatched ticket (0 comments), 5h stale → flagged + audit', async () => {
    const ticket = await mkStaleTicket('never-dispatched drainage graph');
    flaggedTicketId = ticket.id;
    const beforeSys = systemMsgs(await messageRepo.find({ where: { room_id: room.id } })).length;

    await detector.sweep(now);

    const alert = await alertRepo.findOne({ where: { ticket_id: ticket.id } });
    assert.ok(alert, 'durable stuck_alerts row created for the no-progress ticket');

    const msgs = systemMsgs(await messageRepo.find({ where: { room_id: room.id } }));
    const mine = msgs.find(m => m.content.includes(ticket.id) && /No-progress stall detected/.test(m.content));
    assert.ok(mine, 'a "No-progress stall detected" chat alert referencing the ticket was posted');
    assert.equal(msgs.length - beforeSys, 1, 'exactly one new system alert for this sweep');

    const audits = await activityRepo.find({ where: { ticket_id: ticket.id, action: 'stuck_no_progress' } });
    assert.equal(audits.length, 1, 'one structured stuck_no_progress reason audit written');
    const payload = JSON.parse(audits[0].new_value);
    assert.equal(payload.reason, 'never_dispatched', 'reason reflects a ticket no agent ever ran');
    assert.equal(payload.has_agent_holder, true, 'an assignee IS on the ticket');
    assert.ok(payload.recovery && payload.recovery.length > 0, 'audit carries an operator recovery pointer');
    assert.equal(audits[0].actor_id, 'system', "audit actor is 'system' (never re-enters the trigger loop)");
  });

  await t.test('2: dedup — two sweeps inside cooldown → one alert', async () => {
    const ticket = await mkStaleTicket('dedup probe');
    const before = systemMsgs(await messageRepo.find({ where: { room_id: room.id } })).length;
    await detector.sweep(now);
    await detector.sweep(new Date(now.getTime() + 60_000));
    const after = systemMsgs(await messageRepo.find({ where: { room_id: room.id } })).length;
    assert.equal(after - before, 1, 'second sweep dedups — only one alert for this ticket');
  });

  await t.test('3: output-liveness suppresses the flag (alive-but-quiet worker)', async () => {
    const ticket = await mkStaleTicket('long build, quiet on ticket');
    // A subagent for this ticket is actively producing tokens right now.
    agentStatus.recordOutputLiveness(agent.id, ticket.id, 'assignee');
    await detector.sweep(new Date());
    const alert = await alertRepo.findOne({ where: { ticket_id: ticket.id } });
    assert.equal(alert, null, 'a worker producing output is NOT flagged as a hard stall');
  });

  await t.test('4: pending ticket is excluded (intentionally parked, not stuck)', async () => {
    const ticket = await mkStaleTicket('parked on a human');
    await ticketRepo.update(ticket.id, { pending_user_action: true });
    await detector.sweep(now);
    const alert = await alertRepo.findOne({ where: { ticket_id: ticket.id } });
    assert.equal(alert, null, 'a pending_user_action ticket is never a no-progress stall');
  });

  await t.test('5: unstuck — forward progress (column move) clears the alert', async () => {
    assert.ok(flaggedTicketId, 'subtest 1 flagged a ticket');
    const before = await alertRepo.findOne({ where: { ticket_id: flaggedTicketId } });
    assert.ok(before, 'ticket is still flagged before the move');

    await ticketRepo.update(flaggedTicketId, { column_id: inProgress.id });
    const ActivityService = (await import('file://' + path.join(DIST_ROOT, 'services', 'activity.service.js'))).ActivityService;
    await app.get(ActivityService).logActivity({
      entity_type: 'ticket', entity_id: flaggedTicketId, ticket_id: flaggedTicketId,
      action: 'moved', field_changed: 'column', old_value: todoCol.id, new_value: inProgress.id,
      actor_id: 'qa-driver', actor_name: 'qa',
    });
    const stats = await detector.sweep(new Date());
    assert.ok(stats.unstuck >= 1, 'sweep reports the ticket unstuck');
    const after = await alertRepo.findOne({ where: { ticket_id: flaggedTicketId } });
    assert.equal(after, null, 'alert row deleted once the ticket makes forward progress');
  });

  await t.test('6: 24h guarantee — a 25h-no-progress ticket is ALWAYS flagged', async () => {
    const ticket = await mkStaleTicket('25h silent stall', 25);
    await detector.sweep(now);
    const alert = await alertRepo.findOne({ where: { ticket_id: ticket.id } });
    assert.ok(alert, 'a ticket idle for 25h can never sit without a durable alert');
  });

  await t.test('7: REVIEW-kind column — idle + reviewer offline → flagged (blocker B1)', async () => {
    // The real sibling incidents (ea4adc71 / 1fcba693) lived in Review. A ticket
    // stalled in a review-kind column because the reviewer went offline (no
    // output-liveness recorded) previously produced ZERO chat alerts because the
    // candidate query only scanned active/intake. It must now flag by symptom.
    const ticket = await createTicket(app, getDataSourceToken, {
      columnId: reviewCol.id, workspaceId: ws.id, title: 'stalled in Review, reviewer offline',
      reviewerId: agent.id,
    });
    await backdate(ticketRepo, ticket.id, {
      created_at: new Date(now.getTime() - 5 * HOUR),
      updated_at: new Date(now.getTime() - 5 * HOUR),
    });
    const beforeSys = systemMsgs(await messageRepo.find({ where: { room_id: room.id } })).length;

    await detector.sweep(now);

    const alert = await alertRepo.findOne({ where: { ticket_id: ticket.id } });
    assert.ok(alert, 'a review-kind ticket idle 5h with an offline reviewer is flagged');
    const msgs = systemMsgs(await messageRepo.find({ where: { room_id: room.id } }));
    const mine = msgs.find(m => m.content.includes(ticket.id) && /No-progress stall detected/.test(m.content));
    assert.ok(mine, 'a no-progress chat alert was posted for the review-column stall');
    assert.equal(msgs.length - beforeSys, 1, 'exactly one new alert for the review ticket');
    const audits = await activityRepo.find({ where: { ticket_id: ticket.id, action: 'stuck_no_progress' } });
    assert.equal(audits.length, 1, 'a structured stuck_no_progress reason audit was written');
    assert.equal(JSON.parse(audits[0].new_value).has_agent_holder, true, 'reviewer holder detected');
  });

  await t.test('8: MERGING-kind column — idle stall → flagged (blocker B1)', async () => {
    const ticket = await createTicket(app, getDataSourceToken, {
      columnId: mergingCol.id, workspaceId: ws.id, title: 'stalled in Merging',
      assigneeId: agent.id,
    });
    await backdate(ticketRepo, ticket.id, {
      created_at: new Date(now.getTime() - 5 * HOUR),
      updated_at: new Date(now.getTime() - 5 * HOUR),
    });
    await detector.sweep(now);
    const alert = await alertRepo.findOne({ where: { ticket_id: ticket.id } });
    assert.ok(alert, 'a merging-kind ticket idle 5h is flagged — merging is non-terminal & dispatches');
  });
});

test.after?.(() => exitAfterTests(0));
process.on('beforeExit', () => exitAfterTests(0));
