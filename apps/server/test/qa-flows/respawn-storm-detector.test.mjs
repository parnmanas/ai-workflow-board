// QA flow: RespawnStormDetectorService — cause-agnostic respawn-storm circuit
// breaker + twin detection (ticket ab06eac2).
//
// What this proves (maps 1:1 to the ticket DoD)
// ─────────────────────────────────────────────
//   DoD-1 (storm reproducer): 5 QUICK abnormal (ticket,role) deaths inside the
//          window with ZERO forward progress → sweep auto-pends the ticket,
//          posts a chat alert, and writes a first-class respawn_storm_halted
//          activity row.
//   DoD-2 (false-positive regression A — slow-but-working): 5 deaths that each
//          ran LONGER than quick_death_seconds → NOT flagged (duration gate).
//   DoD-2 (false-positive regression B — progress veto): 5 quick deaths but a
//          fresh non-system comment inside the window → NOT flagged.
//   Twin:  2 concurrently-live strands on the same (ticket,role) →
//          respawn_twin_detected activity.
//   Kill-switch: a board with respawn_storm_config={enabled:false} → no flag.

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

process.env.PORT = process.env.QA_RESPAWN_STORM_PORT || '7841';

let subCounter = 0;

/**
 * Insert a Subagent row directly. started_at / ended_at are plain @Column Date
 * fields (not @CreateDateColumn), so a historical timestamp can be written on
 * insert — no backdating UPDATE needed (unlike Comment/Ticket).
 */
async function seedSubagent(subRepo, {
  workspaceId, ticketId, role, startedAt, endedAt = null,
  exitCode = null, signal = null, durationMs = null, lineCount = 0,
}) {
  subCounter += 1;
  return subRepo.save(subRepo.create({
    subagent_id: `sub-fixture-${subCounter}-${Math.floor(startedAt.getTime())}`,
    agent_id: 'agent-fixture',
    workspace_id: workspaceId,
    kind: 'ticket',
    session_key: `${ticketId}:${role}`,
    pid: 1000 + subCounter,
    started_at: startedAt,
    ticket_id: ticketId,
    ticket_title: 'storm probe',
    role,
    ended_at: endedAt,
    exit_code: exitCode,
    signal,
    duration_ms: durationMs,
    line_count: lineCount,
  }));
}

async function seedChatRoom(roomRepo, workspaceId) {
  return roomRepo.save(roomRepo.create({
    workspace_id: workspaceId, type: 'group', name: 'qa-alerts',
  }));
}

function countSystemMessages(messages) {
  return messages.filter(m => m.sender_type === 'system').length;
}

test('RespawnStormDetectorService — storm halt + false-positive regression + twins', async (t) => {
  step('Boot NestJS app on test port');
  // Detector reads config at construction — set explicit conservative values
  // BEFORE bootApp so the in-process singleton picks them up. Big sweep interval
  // so the background loop never races the manual sweep(now) calls below.
  process.env.RESPAWN_STORM_ENABLED = 'true';
  process.env.RESPAWN_STORM_SWEEP_MS = String(60 * 60_000);
  process.env.RESPAWN_STORM_WINDOW_MINUTES = '30';
  process.env.RESPAWN_STORM_MIN_DEATHS = '5';
  process.env.RESPAWN_STORM_QUICK_DEATH_SECONDS = '120';
  process.env.RESPAWN_STORM_AUTO_PEND = 'true';
  process.env.RESPAWN_STORM_NOTIFY = 'true';
  process.env.RESPAWN_STORM_DETECT_TWINS = 'true';

  const { app, modules } = await bootApp({ port: parseInt(process.env.PORT, 10) });
  t.after(() => { void app.close().catch(() => {}); });
  const { getDataSourceToken } = modules;
  const ds = app.get(getDataSourceToken());

  const detectorModule = await import(
    'file://' + path.join(DIST_ROOT, 'modules', 'agents', 'respawn-storm-detector.service.js')
  );
  const detector = app.get(detectorModule.RespawnStormDetectorService);

  step('Seed workspace + board + columns + chat alerts room');
  const ws = await createWorkspace(app, getDataSourceToken, 'storm');
  const alice = await createAgent(app, getDataSourceToken, ws.id, { name: 'alice' });
  const board = await createBoard(app, getDataSourceToken, ws.id, { name: 'qa-storm' });
  await createColumn(app, getDataSourceToken, board.id, {
    name: 'Backlog', position: 0, workspaceId: ws.id, kind: 'intake', roleRouting: [],
  });
  const inProgress = await createColumn(app, getDataSourceToken, board.id, {
    name: 'In Progress', position: 1, workspaceId: ws.id, kind: 'active', roleRouting: ['assignee'],
  });

  const roomRepo = ds.getRepository('ChatRoom');
  const messageRepo = ds.getRepository('ChatRoomMessage');
  const room = await seedChatRoom(roomRepo, ws.id);

  const subRepo = ds.getRepository('Subagent');
  const ticketRepo = ds.getRepository('Ticket');
  const commentRepo = ds.getRepository('Comment');
  const activityRepo = ds.getRepository('ActivityLog');

  const now = new Date();
  const MIN = 60_000;

  // Seed N deaths for a (ticket,'assignee') spread across the last ~25 min.
  async function seedDeaths(ticketId, { count, durationMs, exitCode = 143 }) {
    for (let i = 0; i < count; i++) {
      const startedAt = new Date(now.getTime() - (25 - i * 4) * MIN);
      const endedAt = new Date(startedAt.getTime() + durationMs);
      await seedSubagent(subRepo, {
        workspaceId: ws.id, ticketId, role: 'assignee',
        startedAt, endedAt, exitCode, durationMs,
      });
    }
  }

  // ── DoD-1: storm reproducer ────────────────────────────────────────────
  await t.test('DoD-1: 5 quick abnormal deaths, zero progress → auto-pend + alert + activity', async () => {
    step('Create ticket on In Progress + 5 quick (30s) exit-143 deaths');
    const ticket = await createTicket(app, getDataSourceToken, {
      columnId: inProgress.id, workspaceId: ws.id, title: 'storm victim', assigneeId: alice.id,
    });
    await seedDeaths(ticket.id, { count: 5, durationMs: 30_000 });

    const beforeMsgs = countSystemMessages(await messageRepo.find({ where: { room_id: room.id } }));

    step('Run one sweep');
    const stats = await detector.sweep(now);
    assert.equal(stats.storms_detected >= 1, true, 'storm must be detected');
    assert.equal(stats.storms_halted >= 1, true, 'storm must be halted');

    step('Ticket auto-pended by the detector');
    const pended = await ticketRepo.findOne({ where: { id: ticket.id } });
    assert.equal(pended.pending_user_action, true, 'ticket must be auto-pended');
    assert.equal(pended.pending_set_by, 'RespawnStormDetector', 'pend attributed to the detector');
    assert.match(pended.pending_reason, /Respawn-storm/, 'pending_reason carries the storm summary');
    assert.match(pended.pending_reason, /exit 143/, 'pending_reason cites the exit code');

    step('First-class respawn_storm_halted activity written');
    const halted = await activityRepo.find({
      where: { ticket_id: ticket.id, action: 'respawn_storm_halted' },
    });
    assert.equal(halted.length, 1, 'exactly one respawn_storm_halted activity');
    const payload = JSON.parse(halted[0].new_value);
    assert.equal(payload.deaths, 5, 'activity payload records the death count');
    assert.equal(payload.role, 'assignee', 'activity payload records the role');

    step('Chat alert posted to the workspace room');
    const afterMsgs = await messageRepo.find({ where: { room_id: room.id } });
    assert.equal(countSystemMessages(afterMsgs) - beforeMsgs, 1, 'exactly one storm chat alert');
    const alert = afterMsgs.find(m => m.sender_type === 'system' && m.content.includes(ticket.id));
    assert.ok(alert, 'alert references the ticket');
    assert.match(alert.content, /Respawn-storm halted/, 'alert labels itself');
  });

  // ── DoD-1 idempotency: a second sweep does not re-pend / re-alert ────────
  await t.test('DoD-1 dedup: re-sweep does not double-halt an already-pended ticket', async () => {
    const stormTickets = await ticketRepo.find({ where: { pending_set_by: 'RespawnStormDetector' } });
    assert.ok(stormTickets.length >= 1, 'at least one storm-halted ticket exists from DoD-1');
    const beforeMsgs = countSystemMessages(await messageRepo.find({ where: { room_id: room.id } }));

    const stats = await detector.sweep(now);
    assert.equal(stats.skipped_already_halted >= 1, true, 'already-halted ticket is skipped');

    const afterMsgs = countSystemMessages(await messageRepo.find({ where: { room_id: room.id } }));
    assert.equal(afterMsgs, beforeMsgs, 'no duplicate alert on re-sweep');
  });

  // ── DoD-2 regression A: slow-but-working deaths are NOT a storm ──────────
  await t.test('DoD-2A: 5 SLOW deaths (ran > quick_death_seconds) → NOT flagged (duration gate)', async () => {
    step('Create ticket + 5 deaths that each ran 5 min (> 120s quick-death)');
    const ticket = await createTicket(app, getDataSourceToken, {
      columnId: inProgress.id, workspaceId: ws.id, title: 'slow but working', assigneeId: alice.id,
    });
    await seedDeaths(ticket.id, { count: 5, durationMs: 5 * MIN });

    await detector.sweep(now);

    const t2 = await ticketRepo.findOne({ where: { id: ticket.id } });
    assert.equal(t2.pending_user_action, false, 'slow-but-working task must never be pended');
    const halted = await activityRepo.count({
      where: { ticket_id: ticket.id, action: 'respawn_storm_halted' },
    });
    assert.equal(halted, 0, 'no storm activity for a slow task');
  });

  // ── DoD-2 regression B: forward-progress signal vetoes a storm ──────────
  await t.test('DoD-2B: 5 quick deaths BUT a fresh comment in-window → NOT flagged (progress veto)', async () => {
    step('Create ticket + 5 quick deaths + one fresh non-system comment');
    const ticket = await createTicket(app, getDataSourceToken, {
      columnId: inProgress.id, workspaceId: ws.id, title: 'progressing despite deaths', assigneeId: alice.id,
    });
    await seedDeaths(ticket.id, { count: 5, durationMs: 30_000 });
    // A fresh agent comment (created_at = real now, inside the 30 min window).
    await commentRepo.save(commentRepo.create({
      ticket_id: ticket.id, workspace_id: ws.id, author_type: 'agent',
      author_id: alice.id, author: 'alice', content: '진전 있음: 절반 구현 완료', type: 'note',
    }));

    const stats = await detector.sweep(now);
    assert.equal(stats.skipped_progress >= 1, true, 'progress veto must fire for this group');

    const t2 = await ticketRepo.findOne({ where: { id: ticket.id } });
    assert.equal(t2.pending_user_action, false, 'a progressing ticket must never be pended');
  });

  // ── Twin detection ──────────────────────────────────────────────────────
  await t.test('Twin: 2 concurrently-live strands → respawn_twin_detected activity', async () => {
    step('Create ticket + 2 live subagents (ended_at null) for the same role');
    const ticket = await createTicket(app, getDataSourceToken, {
      columnId: inProgress.id, workspaceId: ws.id, title: 'twin echo', assigneeId: alice.id,
    });
    await seedSubagent(subRepo, {
      workspaceId: ws.id, ticketId: ticket.id, role: 'assignee',
      startedAt: new Date(now.getTime() - 3 * MIN), endedAt: null,
    });
    await seedSubagent(subRepo, {
      workspaceId: ws.id, ticketId: ticket.id, role: 'assignee',
      startedAt: new Date(now.getTime() - 1 * MIN), endedAt: null,
    });

    const stats = await detector.sweep(now);
    assert.equal(stats.twins_detected >= 1, true, 'twin must be detected');

    const twinAct = await activityRepo.find({
      where: { ticket_id: ticket.id, action: 'respawn_twin_detected' },
    });
    assert.equal(twinAct.length, 1, 'exactly one respawn_twin_detected activity');
    const payload = JSON.parse(twinAct[0].new_value);
    assert.equal(payload.live_count, 2, 'twin payload records the live strand count');
  });

  // ── Kill-switch: per-board enabled:false opts out ───────────────────────
  await t.test('Kill-switch: board respawn_storm_config={enabled:false} → no flag', async () => {
    step('Second board with the breaker disabled + a storm-shaped ticket');
    const board2 = await createBoard(app, getDataSourceToken, ws.id, { name: 'qa-storm-off' });
    await ds.getRepository('Board').update(board2.id, {
      respawn_storm_config: JSON.stringify({ enabled: false }),
    });
    const col2 = await createColumn(app, getDataSourceToken, board2.id, {
      name: 'In Progress', position: 1, workspaceId: ws.id, kind: 'active', roleRouting: ['assignee'],
    });
    const ticket = await createTicket(app, getDataSourceToken, {
      columnId: col2.id, workspaceId: ws.id, title: 'disabled board victim', assigneeId: alice.id,
    });
    await seedDeaths(ticket.id, { count: 5, durationMs: 30_000 });

    await detector.sweep(now);

    const t2 = await ticketRepo.findOne({ where: { id: ticket.id } });
    assert.equal(t2.pending_user_action, false, 'disabled board must never pend');
    const halted = await activityRepo.count({
      where: { ticket_id: ticket.id, action: 'respawn_storm_halted' },
    });
    assert.equal(halted, 0, 'no storm activity on a disabled board');
  });
});

test.after?.(() => exitAfterTests(0));
process.on('beforeExit', () => exitAfterTests(0));
