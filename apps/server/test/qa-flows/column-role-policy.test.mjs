// QA flow: ColumnRolePolicy enrichment of the stuck-ticket detector
// (ticket f886ada7 — PR #2).
//
// Acceptance criteria locked here:
//
//   AC#2 — Detector sweep reads ColumnRolePolicy and emits a single
//          enriched alert per violating ticket per dedup window.
//
//   AC#3 — Alert message includes ticket link, current column, configured
//          target column, role(s) responsible, gate labels configured vs.
//          attached.
//
//   Gate-label honored — When a label matching a configured gate pattern
//          IS attached, the alert falls back to the plain stale-WAIT
//          shape (no policy_violation enrichment).
//
//   Activity row — A policy_violation row is written to activity_logs so
//          downstream admin tooling can surface the history.

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

process.env.PORT = process.env.QA_COLUMN_POLICY_PORT || '7833';

async function backdate(repo, id, fields) {
  const updates = {};
  if (fields.created_at) updates.created_at = fields.created_at;
  if (fields.updated_at) updates.updated_at = fields.updated_at;
  if (Object.keys(updates).length > 0) await repo.update(id, updates);
}

async function seedAgentComment(commentRepo, ticketId, workspaceId, agentName, content, createdAt) {
  const saved = await commentRepo.save(commentRepo.create({
    ticket_id: ticketId,
    workspace_id: workspaceId,
    author_type: 'agent',
    author_id: 'agent-fixture',
    author: agentName,
    content,
    type: 'note',
  }));
  await backdate(commentRepo, saved.id, { created_at: createdAt });
  return commentRepo.findOne({ where: { id: saved.id } });
}

async function seedChatRoom(roomRepo, workspaceId) {
  return roomRepo.save(roomRepo.create({
    workspace_id: workspaceId,
    type: 'group',
    name: 'qa-policy-alerts',
  }));
}

test('ColumnRolePolicy — alert enrichment + gate-label honored', async (t) => {
  step('Boot NestJS app on test port');
  process.env.STUCK_DETECTOR_ENABLED = 'true';
  process.env.STUCK_DETECTOR_SWEEP_MS = '60000';
  process.env.STUCK_DETECTOR_WINDOW = '4';
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

  step('Seed workspace + board + columns + policy + chat room');
  const ws = await createWorkspace(app, getDataSourceToken, 'crp');
  const agent = await createAgent(app, getDataSourceToken, ws.id, { name: 'alice' });
  const board = await createBoard(app, getDataSourceToken, ws.id, { name: 'qa-crp' });

  const todoCol = await createColumn(app, getDataSourceToken, board.id, {
    name: 'To Do', position: 1, workspaceId: ws.id, kind: 'active', roleRouting: ['assignee'],
  });
  const inProgress = await createColumn(app, getDataSourceToken, board.id, {
    name: 'In Progress', position: 2, workspaceId: ws.id, kind: 'active', roleRouting: ['assignee'],
  });
  void inProgress;

  const polRepo = ds.getRepository('ColumnRolePolicy');
  await polRepo.save(polRepo.create({
    board_id: board.id,
    column_id: todoCol.id,
    role_slug: 'assignee',
    expected_action: 'move',
    target_column_id: inProgress.id,
    gate_labels: '["BLOCKED-*"]',
    max_cycles_without_progress: 4,
    on_violation: 'alert',
    enabled: true,
  }));

  const roomRepo = ds.getRepository('ChatRoom');
  const messageRepo = ds.getRepository('ChatRoomMessage');
  const ticketRepo = ds.getRepository('Ticket');
  const commentRepo = ds.getRepository('Comment');
  const activityRepo = ds.getRepository('ActivityLog');
  const room = await seedChatRoom(roomRepo, ws.id);
  void room;

  const now = new Date();
  const HOUR = 3_600_000;

  // ── Violation case: no gate label attached, 4 stale WAITs → enriched alert ─
  await t.test('violation: 4 WAITs without BLOCKED-* label → policy_violation alert', async () => {
    step('Create ticket with no labels on To Do');
    const ticket = await createTicket(app, getDataSourceToken, {
      columnId: todoCol.id, workspaceId: ws.id,
      title: 'no-gate-label violator', assigneeId: agent.id,
    });
    await backdate(ticketRepo, ticket.id, {
      created_at: new Date(now.getTime() - 5 * HOUR),
      updated_at: new Date(now.getTime() - 5 * HOUR),
    });

    step('Seed 4 WAIT comments at 1h spacing over 3h');
    for (let i = 3; i >= 0; i--) {
      await seedAgentComment(commentRepo, ticket.id, ws.id, 'alice',
        `WAIT stands — check ${4 - i}`,
        new Date(now.getTime() - i * HOUR));
    }

    const stats = await detector.sweep(now);
    assert.equal(stats.flagged >= 1, true, 'sweep must flag this ticket');

    const msgs = await messageRepo.find();
    const mine = msgs.filter(m => m.sender_type === 'system' && m.content.includes(ticket.id));
    assert.equal(mine.length, 1, 'exactly one alert posted');
    const content = mine[0].content;
    assert.match(content, /Stale-WAIT \+ policy violation/, 'message uses the enriched header');
    assert.match(content, /expected: In Progress/, 'message names the configured target column');
    assert.match(content, /role\(s\): assignee/, 'message lists role(s) responsible');
    assert.match(content, /Gate labels \(configured\): BLOCKED-\*/, 'message exposes configured gate labels');
    assert.match(content, /Attached labels: \(none\)/, 'message exposes empty attached label set');

    step('Activity log row written for the violation');
    const rows = await activityRepo.find({ where: { ticket_id: ticket.id, action: 'policy_violation' } });
    assert.equal(rows.length, 1, 'exactly one policy_violation activity row written');
    const meta = JSON.parse(rows[0].new_value);
    assert.equal(Array.isArray(meta.policy_ids) && meta.policy_ids.length === 1, true,
      'activity row carries the matching policy id');
    assert.deepEqual(meta.role_slugs, ['assignee'], 'activity row carries the role slug list');
    assert.equal(meta.cycle_count, 4, 'activity row carries the cycle count');
  });

  // ── Gate-label honored: BLOCKED-* attached → plain stale-WAIT alert ─────
  await t.test('gate-label honored: BLOCKED-PHASE3 attached → plain stale-WAIT alert', async () => {
    step('Create ticket with BLOCKED-PHASE3 attached on To Do');
    const ticket = await createTicket(app, getDataSourceToken, {
      columnId: todoCol.id, workspaceId: ws.id,
      title: 'gate-honored ticket', assigneeId: agent.id,
    });
    await ticketRepo.update(ticket.id, { labels: JSON.stringify(['BLOCKED-PHASE3']) });
    await backdate(ticketRepo, ticket.id, {
      created_at: new Date(now.getTime() - 5 * HOUR),
      updated_at: new Date(now.getTime() - 5 * HOUR),
    });

    for (let i = 3; i >= 0; i--) {
      await seedAgentComment(commentRepo, ticket.id, ws.id, 'alice',
        `WAIT stands — phase 3 ${4 - i}`,
        new Date(now.getTime() - i * HOUR));
    }

    await detector.sweep(now);

    const msgs = await messageRepo.find();
    const mine = msgs.filter(m => m.sender_type === 'system' && m.content.includes(ticket.id));
    assert.equal(mine.length, 1, 'exactly one alert posted');
    const content = mine[0].content;
    assert.match(content, /Stale-WAIT detected/, 'gate-label honored → plain stale-WAIT header');
    assert.equal(/policy violation/.test(content), false,
      'gate-label honored case must NOT emit the policy_violation header');

    const rows = await activityRepo.find({ where: { ticket_id: ticket.id, action: 'policy_violation' } });
    assert.equal(rows.length, 0, 'no policy_violation activity row for gate-honored case');
  });

  // ── Disabled policy: enabled=false → falls back to plain stale-WAIT ────
  await t.test('disabled policy row → enrichment skipped', async () => {
    step('Set up a brand-new column without an enabled policy');
    const isolatedCol = await createColumn(app, getDataSourceToken, board.id, {
      name: 'Isolated', position: 9, workspaceId: ws.id, kind: 'active', roleRouting: ['assignee'],
    });
    // Disabled policy — enrichment should be skipped, plain stale-WAIT only.
    await polRepo.save(polRepo.create({
      board_id: board.id,
      column_id: isolatedCol.id,
      role_slug: 'assignee',
      expected_action: 'move',
      target_column_id: inProgress.id,
      gate_labels: '["BLOCKED-*"]',
      max_cycles_without_progress: 4,
      on_violation: 'alert',
      enabled: false,
    }));

    const ticket = await createTicket(app, getDataSourceToken, {
      columnId: isolatedCol.id, workspaceId: ws.id,
      title: 'disabled-policy ticket', assigneeId: agent.id,
    });
    await backdate(ticketRepo, ticket.id, {
      created_at: new Date(now.getTime() - 5 * HOUR),
      updated_at: new Date(now.getTime() - 5 * HOUR),
    });
    for (let i = 3; i >= 0; i--) {
      await seedAgentComment(commentRepo, ticket.id, ws.id, 'alice',
        `WAIT stands — disabled-row check ${4 - i}`,
        new Date(now.getTime() - i * HOUR));
    }

    await detector.sweep(now);

    const msgs = await messageRepo.find();
    const mine = msgs.filter(m => m.sender_type === 'system' && m.content.includes(ticket.id));
    assert.equal(mine.length, 1, 'exactly one alert posted');
    assert.match(mine[0].content, /Stale-WAIT detected/, 'disabled policy → plain stale-WAIT only');
    assert.equal(/policy violation/.test(mine[0].content), false,
      'disabled policy must not emit policy_violation enrichment');
  });
});

test.after?.(() => exitAfterTests(0));
process.on('beforeExit', () => exitAfterTests(0));
