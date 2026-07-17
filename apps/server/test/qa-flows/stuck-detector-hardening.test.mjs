// QA flow: StuckTicketDetectorService hardening (ticket e7c87517, reviewer
// blockers #2/#3/#5).
//
//   #2 stale/leaked claim: a lock only buys immunity while it is LIVE (locked_at
//      within the lock TTL). A stale leaked lock (owner crashed) no longer hides
//      a no-progress stall, and does not count as an "unstuck" signal.
//   #3 durable alert delivery: the re-alert cooldown keys off a successful
//      delivery, so a first delivery that fails (no alerts room) is retried the
//      next sweep instead of being silenced for a full 24h REALERT window.
//   #5 progress definition: forward progress excludes ticket.updated_at, and the
//      candidate gate keys off the immutable created_at, so a non-progress field
//      write (label / assignee edit) neither resets the hard-stall clock nor
//      hides the ticket from detection.

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
const HOUR = 3_600_000;
const MIN = 60_000;

process.env.PORT = process.env.QA_STUCK_HARDENING_PORT || '7836';
process.env.STUCK_DETECTOR_ENABLED = 'true';
process.env.STUCK_DETECTOR_SWEEP_MS = '900000';
process.env.STUCK_DETECTOR_MIN_AGE_MS = String(2 * HOUR);
process.env.STUCK_DETECTOR_NO_PROGRESS_MS = String(3 * HOUR);
process.env.STUCK_DETECTOR_REALERT_MS = String(24 * HOUR);
process.env.STUCK_DETECTOR_STALE_LOCK_MS = String(30 * MIN);
process.env.DISPATCH_RECONCILER_ENABLED = 'false'; // isolate the detector

function systemMsgs(messages) {
  return messages.filter(m => m.sender_type === 'system');
}

test('StuckTicketDetector hardening — stale claim / durable delivery / progress def', async (t) => {
  step('Boot NestJS app on test port');
  const port = parseInt(process.env.PORT, 10);
  const { app, modules } = await bootApp({ port });
  t.after(() => { void app.close().catch(() => {}); });
  const { getDataSourceToken } = modules;
  const ds = app.get(getDataSourceToken());

  const detector = app.get(
    (await import('file://' + path.join(DIST_ROOT, 'modules', 'agents', 'stuck-ticket-detector.service.js'))).StuckTicketDetectorService,
  );

  const ticketRepo = ds.getRepository('Ticket');
  const alertRepo = ds.getRepository('StuckTicketAlert');
  const roomRepo = ds.getRepository('ChatRoom');
  const messageRepo = ds.getRepository('ChatRoomMessage');

  step('Seed a workspace + board + columns + alerts room + agent');
  const ws = await createWorkspace(app, getDataSourceToken, 'hard');
  const agent = await createAgent(app, getDataSourceToken, ws.id, { name: 'ralf' });
  const board = await createBoard(app, getDataSourceToken, ws.id, { name: 'qa-hard' });
  const todoCol = await createColumn(app, getDataSourceToken, board.id, {
    name: 'To Do', position: 1, workspaceId: ws.id, kind: 'active', roleRouting: ['assignee'],
  });
  const inProgress = await createColumn(app, getDataSourceToken, board.id, {
    name: 'In Progress', position: 2, workspaceId: ws.id, kind: 'active', roleRouting: ['assignee'],
  });
  const room = await roomRepo.save(roomRepo.create({ workspace_id: ws.id, type: 'group', name: 'qa-alerts' }));

  const now = new Date();
  const mkStale = async (title, ageHours = 5) => {
    const ticket = await createTicket(app, getDataSourceToken, {
      columnId: todoCol.id, workspaceId: ws.id, title, assigneeId: agent.id,
    });
    await ticketRepo.update(ticket.id, {
      created_at: new Date(now.getTime() - ageHours * HOUR),
      updated_at: new Date(now.getTime() - ageHours * HOUR),
    });
    return ticket;
  };

  await t.test('#2a: a LIVE lock skips the no-progress flag; a STALE lock does not', async () => {
    // Live lock — an agent is genuinely working; skip.
    const live = await mkStale('live-locked build', 5);
    await ticketRepo.update(live.id, { locked_by_agent_id: agent.id, locked_at: new Date() });
    await detector.sweep(new Date());
    assert.equal(await alertRepo.findOne({ where: { ticket_id: live.id } }), null,
      'a ticket under a LIVE lock is not flagged (someone is working it)');

    // Stale/leaked lock — owner crashed 40 min ago (> 30 min TTL); must be flagged.
    const stale = await mkStale('stale-locked, agent crashed', 25);
    await ticketRepo.update(stale.id, { locked_by_agent_id: agent.id, locked_at: new Date(now.getTime() - 40 * MIN) });
    await detector.sweep(new Date());
    assert.ok(await alertRepo.findOne({ where: { ticket_id: stale.id } }),
      'a STALE leaked lock buys NO immunity — the 25h no-progress ticket IS flagged');
  });

  await t.test('#2b: a stale lock is NOT an unstuck signal (a live one is)', async () => {
    const ticket = await mkStale('flag then stale-lock', 25);
    await detector.sweep(new Date());
    assert.ok(await alertRepo.findOne({ where: { ticket_id: ticket.id } }), 'ticket flagged first');

    // A STALE lock lands (owner crashed). It must NOT resolve the alert.
    await ticketRepo.update(ticket.id, { locked_by_agent_id: agent.id, locked_at: new Date(now.getTime() - 40 * MIN) });
    await detector.sweep(new Date());
    assert.ok(await alertRepo.findOne({ where: { ticket_id: ticket.id } }),
      'a stale leaked lock does not silently resolve the no-progress alert');

    // A LIVE lock (someone actually picked it up) IS the unstuck signal.
    await ticketRepo.update(ticket.id, { locked_by_agent_id: agent.id, locked_at: new Date() });
    const stats = await detector.sweep(new Date());
    assert.ok(stats.unstuck >= 1, 'a fresh live lock reports the ticket unstuck');
    assert.equal(await alertRepo.findOne({ where: { ticket_id: ticket.id } }), null,
      'a live claim clears the alert (real pickup)');
  });

  await t.test('#5: a non-progress updated_at edit neither resets the clock nor hides the ticket', async () => {
    const ticket = await createTicket(app, getDataSourceToken, {
      columnId: todoCol.id, workspaceId: ws.id, title: 'label-edited but stalled', assigneeId: agent.id,
    });
    // created 5h ago (stalled), but a label edit just bumped updated_at to NOW.
    await ticketRepo.update(ticket.id, {
      created_at: new Date(now.getTime() - 5 * HOUR),
      updated_at: new Date(), // recent non-progress write
    });
    await detector.sweep(new Date());
    assert.ok(await alertRepo.findOne({ where: { ticket_id: ticket.id } }),
      'a 5h-stalled ticket is flagged DESPITE a fresh updated_at — the clock ignores non-progress writes and the candidate gate uses created_at');
  });

  await t.test('#3: a failed first delivery is retried next sweep (not silenced for 24h)', async () => {
    // A separate workspace with NO chat room → the first delivery cannot land.
    const ws2 = await createWorkspace(app, getDataSourceToken, 'noroom');
    const agent2 = await createAgent(app, getDataSourceToken, ws2.id, { name: 'rolf' });
    const board2 = await createBoard(app, getDataSourceToken, ws2.id, { name: 'qa-noroom' });
    const col2 = await createColumn(app, getDataSourceToken, board2.id, {
      name: 'To Do', position: 1, workspaceId: ws2.id, kind: 'active', roleRouting: ['assignee'],
    });
    const ticket = await createTicket(app, getDataSourceToken, {
      columnId: col2.id, workspaceId: ws2.id, title: 'undeliverable first alert', assigneeId: agent2.id,
    });
    await ticketRepo.update(ticket.id, {
      created_at: new Date(now.getTime() - 5 * HOUR),
      updated_at: new Date(now.getTime() - 5 * HOUR),
    });

    // Sweep 1 — no room: the durable row + audit are written, but delivery fails.
    await detector.sweep(new Date());
    let alert = await alertRepo.findOne({ where: { ticket_id: ticket.id } });
    assert.ok(alert, 'the durable alert row is written even when delivery fails (crash-safe recovery pointer)');
    assert.equal(alert.delivered_at, null, 'delivered_at stays null — the alert is NOT yet delivered');
    assert.ok(alert.delivery_attempts >= 1, 'a delivery attempt was recorded');

    // A room appears. Sweep 2 — the alert must RETRY and land (NOT be silenced by
    // a 24h cooldown that a delivered-first design would have set on sweep 1).
    const room2 = await roomRepo.save(roomRepo.create({ workspace_id: ws2.id, type: 'group', name: 'late-alerts' }));
    const before = systemMsgs(await messageRepo.find({ where: { room_id: room2.id } })).length;
    await detector.sweep(new Date());
    alert = await alertRepo.findOne({ where: { ticket_id: ticket.id } });
    assert.ok(alert.delivered_at, 'the retry delivered — delivered_at is now stamped');
    const after = systemMsgs(await messageRepo.find({ where: { room_id: room2.id } })).length;
    assert.equal(after - before, 1, 'exactly one alert landed on the retry (bounded, once-per-sweep — never a 24h silence)');
  });
});

test.after?.(() => exitAfterTests(0));
process.on('beforeExit', () => exitAfterTests(0));
