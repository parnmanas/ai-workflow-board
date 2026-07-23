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
  agentId = 'agent-fixture',
}) {
  subCounter += 1;
  return subRepo.save(subRepo.create({
    subagent_id: `sub-fixture-${subCounter}-${Math.floor(startedAt.getTime())}`,
    agent_id: agentId,
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
  // `agentIds` (optional) assigns a distinct agent_id per index (cycled) so
  // callers can assert the detector's agent_ids aggregation; returns the
  // saved rows so callers can read back the exact ended_at/agent_id it wrote.
  async function seedDeaths(ticketId, { count, durationMs, exitCode = 143, agentIds = null }) {
    const saved = [];
    for (let i = 0; i < count; i++) {
      const startedAt = new Date(now.getTime() - (25 - i * 4) * MIN);
      const endedAt = new Date(startedAt.getTime() + durationMs);
      const row = await seedSubagent(subRepo, {
        workspaceId: ws.id, ticketId, role: 'assignee',
        startedAt, endedAt, exitCode, durationMs,
        ...(agentIds ? { agentId: agentIds[i % agentIds.length] } : {}),
      });
      saved.push(row);
    }
    return saved;
  }

  // Populated by DoD-1 below; reused by the listActiveStorms test so it does
  // not need to re-seed + re-sweep an entire second storm scenario.
  let dod1TicketId = null;

  // ── DoD-1: storm reproducer ────────────────────────────────────────────
  await t.test('DoD-1: 5 quick abnormal deaths, zero progress → auto-pend + alert + activity', async () => {
    step('Create ticket on In Progress + 5 quick (30s) exit-143 deaths across 2 distinct agents');
    const ticket = await createTicket(app, getDataSourceToken, {
      columnId: inProgress.id, workspaceId: ws.id, title: 'storm victim', assigneeId: alice.id,
    });
    const deaths = await seedDeaths(ticket.id, {
      count: 5, durationMs: 30_000, agentIds: ['agent-alpha', 'agent-beta'],
    });
    dod1TicketId = ticket.id;

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
    assert.deepEqual(
      [...payload.agent_ids].sort(),
      ['agent-alpha', 'agent-beta'],
      'activity payload records every distinct participating agent_id (ticket 3970db66)',
    );
    assert.equal(
      payload.first_death_at,
      deaths[0].ended_at.toISOString(),
      'activity payload records the loop start (earliest death timestamp in the group)',
    );

    step('Chat alert posted to the workspace room');
    const afterMsgs = await messageRepo.find({ where: { room_id: room.id } });
    assert.equal(countSystemMessages(afterMsgs) - beforeMsgs, 1, 'exactly one storm chat alert');
    const alert = afterMsgs.find(m => m.sender_type === 'system' && m.content.includes(ticket.id));
    assert.ok(alert, 'alert references the ticket');
    assert.match(alert.content, /Respawn-storm halted/, 'alert labels itself');
  });

  // ── Dashboard surface: listActiveStorms() ───────────────────────────────
  await t.test('listActiveStorms exposes agent_ids + first_death_at for the halted ticket', async () => {
    step('Read back the DoD-1 halted ticket via the dashboard-facing rollup');
    const active = await detector.listActiveStorms();
    const entry = active.find(s => s.ticket_id === dod1TicketId);
    assert.ok(entry, 'listActiveStorms includes the DoD-1 halted ticket');
    assert.deepEqual(
      [...entry.agent_ids].sort(),
      ['agent-alpha', 'agent-beta'],
      'listActiveStorms surfaces the full participating agent_id list (ticket 3970db66)',
    );
    assert.ok(entry.first_death_at, 'listActiveStorms surfaces a loop-start timestamp');
    assert.match(entry.pending_reason, /Respawn-storm/, 'pending_reason still carries the storm summary');
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
    step('Create ticket + 2 live subagents (ended_at null) for the same role, 2 distinct agents');
    const ticket = await createTicket(app, getDataSourceToken, {
      columnId: inProgress.id, workspaceId: ws.id, title: 'twin echo', assigneeId: alice.id,
    });
    const firstStrandStartedAt = new Date(now.getTime() - 3 * MIN);
    await seedSubagent(subRepo, {
      workspaceId: ws.id, ticketId: ticket.id, role: 'assignee',
      startedAt: firstStrandStartedAt, endedAt: null, agentId: 'agent-twin-early',
    });
    await seedSubagent(subRepo, {
      workspaceId: ws.id, ticketId: ticket.id, role: 'assignee',
      startedAt: new Date(now.getTime() - 1 * MIN), endedAt: null, agentId: 'agent-twin-late',
    });

    const stats = await detector.sweep(now);
    assert.equal(stats.twins_detected >= 1, true, 'twin must be detected');

    const twinAct = await activityRepo.find({
      where: { ticket_id: ticket.id, action: 'respawn_twin_detected' },
    });
    assert.equal(twinAct.length, 1, 'exactly one respawn_twin_detected activity');
    const payload = JSON.parse(twinAct[0].new_value);
    assert.equal(payload.live_count, 2, 'twin payload records the live strand count');
    assert.deepEqual(
      [...payload.agent_ids].sort(),
      ['agent-twin-early', 'agent-twin-late'],
      'twin payload records every distinct participating agent_id (ticket 3970db66)',
    );
    assert.equal(
      payload.first_seen_at,
      firstStrandStartedAt.toISOString(),
      'twin payload records the loop start (earliest-started live strand)',
    );
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

  // ── Dashboard surface: topRespawnCounts() ───────────────────────────────
  await t.test('topRespawnCounts includes agent_ids for a (ticket, role) group', async () => {
    step('Create ticket + 3 quick deaths across 2 distinct agents (no auto-pend needed)');
    const ticket = await createTicket(app, getDataSourceToken, {
      columnId: inProgress.id, workspaceId: ws.id, title: 'top-respawns probe', assigneeId: alice.id,
    });
    await seedDeaths(ticket.id, {
      count: 3, durationMs: 30_000, agentIds: ['agent-top-a', 'agent-top-b'],
    });

    const top = await detector.topRespawnCounts({ now });
    const entry = top.find(x => x.ticket_id === ticket.id);
    assert.ok(entry, 'topRespawnCounts includes the seeded (ticket, role) group');
    assert.equal(entry.role, 'assignee', 'entry records the role');
    assert.equal(entry.deaths, 3, 'entry records the death count');
    assert.deepEqual(
      [...entry.agent_ids].sort(),
      ['agent-top-a', 'agent-top-b'],
      'entry records every distinct participating agent_id (ticket 3970db66)',
    );
  });

  // ── Dashboard surface: getSuppressionStats() ────────────────────────────
  await t.test('getSuppressionStats aggregates halt/twin/pingpong ActivityLog rows', async () => {
    // Delta-based: earlier sub-tests in this file already wrote real
    // respawn_storm_halted/respawn_twin_detected rows, and this rollup is
    // intentionally workspace-wide (v1, see service docblock) rather than
    // ticket-scoped, so an absolute count would be order-dependent. Snapshot
    // before seeding synthetic rows and assert the exact delta instead.
    step('Snapshot getSuppressionStats before seeding synthetic activity rows');
    const before = await detector.getSuppressionStats();

    step('Seed 2 halts + 1 twin + 3 comment_pingpong_suppressed rows (all 3 reasons)');
    const ticket = await createTicket(app, getDataSourceToken, {
      columnId: inProgress.id, workspaceId: ws.id, title: 'suppression-stats probe', assigneeId: alice.id,
    });
    const seedActivity = (action, fieldChanged) => activityRepo.save(activityRepo.create({
      entity_type: 'ticket', entity_id: ticket.id, action, field_changed: fieldChanged,
      old_value: '', new_value: '{}', ticket_id: ticket.id,
      actor_id: 'system', actor_name: 'test-seed', role: 'assignee', trigger_source: 'respawn_storm',
    }));
    await seedActivity('respawn_storm_halted', 'respawn_storm');
    await seedActivity('respawn_storm_halted', 'respawn_storm');
    await seedActivity('respawn_twin_detected', 'respawn_twin');
    await seedActivity('comment_pingpong_suppressed', 'repeated_waiting_without_work_target');
    await seedActivity('comment_pingpong_suppressed', 'pending_user_action');
    await seedActivity('comment_pingpong_suppressed', 'duplicate_terminal_acknowledgement');

    step('getSuppressionStats reflects the seeded delta exactly');
    const after = await detector.getSuppressionStats();
    assert.equal(after.respawn_storm.total_halts - before.respawn_storm.total_halts, 2, 'total_halts delta');
    assert.equal(after.respawn_storm.total_twins - before.respawn_storm.total_twins, 1, 'total_twins delta');
    assert.equal(after.comment_pingpong.total - before.comment_pingpong.total, 3, 'comment_pingpong.total delta');
    for (const reason of ['repeated_waiting_without_work_target', 'pending_user_action', 'duplicate_terminal_acknowledgement']) {
      const beforeCount = before.comment_pingpong.by_reason[reason] || 0;
      const afterCount = after.comment_pingpong.by_reason[reason] || 0;
      assert.equal(afterCount - beforeCount, 1, `by_reason.${reason} delta`);
    }
  });
});

test.after?.(() => exitAfterTests(0));
process.on('beforeExit', () => exitAfterTests(0));
