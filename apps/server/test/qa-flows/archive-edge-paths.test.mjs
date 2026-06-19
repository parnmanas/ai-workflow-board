// QA flow: archive edge-path regressions for ticket 9b44526b.
//
// Three scenarios reviewer flagged as missing behavioural coverage
// (the existing archive-exclusion-guard.test.mjs is static-grep only):
//
//   1. Stuck-ticket-detector must skip archived tickets, even ones already
//      carrying a stuck_alerts row.
//   2. REST GET /api/workspaces/:id and MCP get_workspace must exclude
//      archived tickets by default (and from column ticket_count).
//   3. Creating a ticket directly in a terminal column must stamp
//      terminal_entered_at, so the archiver actually picks it up.
//
// These exercise the real services (no mocks) on a booted NestJS app.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Isolate this test's sql.js database from the user's live `data.db` so
// concurrent runs (or a stray malformed shared db) don't poison the boot.
// Mirrors how the admin "Run Flow Tests" path sets SQLJS_DB_PATH per
// subprocess (see apps/server/src/db.ts:246).
const __testDbName = `qa-archive-edge-paths-${Date.now()}-${process.pid}.db`;
process.env.SQLJS_DB_PATH = path.join(os.tmpdir(), __testDbName);

import { bootApp, exitAfterTests, step } from '../helpers/boot.mjs';
import {
  createWorkspace,
  createAgent,
  createApiKey,
  createBoard,
  createColumn,
  createTicket,
  createUser,
} from '../helpers/fixtures.mjs';
import { McpClient } from '../helpers/mcp-client.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST_ROOT = path.resolve(__dirname, '..', '..', 'dist');

process.env.PORT = process.env.QA_ARCHIVE_EDGE_PORT || '7842';

async function seedAgentComment(commentRepo, ticketId, workspaceId, author, content, createdAt) {
  const saved = await commentRepo.save(commentRepo.create({
    ticket_id: ticketId,
    workspace_id: workspaceId,
    author_type: 'agent',
    author_id: 'agent-fixture',
    author,
    content,
    type: 'note',
  }));
  if (createdAt) await commentRepo.update(saved.id, { created_at: createdAt });
  return commentRepo.findOne({ where: { id: saved.id } });
}

async function backdate(repo, id, fields) {
  const updates = {};
  if (fields.created_at) updates.created_at = fields.created_at;
  if (fields.updated_at) updates.updated_at = fields.updated_at;
  if (Object.keys(updates).length > 0) await repo.update(id, updates);
}

test('Archive edge-path regressions (ticket 9b44526b)', async (t) => {
  step('Boot NestJS app on test port');
  // Stuck detector reads env at construction; force the sweep cadence we need.
  process.env.STUCK_DETECTOR_ENABLED = 'true';
  process.env.STUCK_DETECTOR_SWEEP_MS = '60000';
  process.env.STUCK_DETECTOR_WINDOW = '4';
  process.env.STUCK_DETECTOR_MIN_SPAN_MS = String(2 * 60 * 60_000);
  process.env.STUCK_DETECTOR_MIN_AGE_MS = String(2 * 60 * 60_000);
  process.env.STUCK_DETECTOR_REALERT_MS = String(24 * 60 * 60_000);

  const port = parseInt(process.env.PORT, 10);
  const { app, modules } = await bootApp({ port });
  t.after(() => { void app.close().catch(() => {}); });
  const { getDataSourceToken, AuthService } = modules;
  const ds = app.get(getDataSourceToken());

  const detectorModule = await import(
    'file://' + path.join(DIST_ROOT, 'modules', 'agents', 'stuck-ticket-detector.service.js')
  );
  const detector = app.get(detectorModule.StuckTicketDetectorService);

  const archiverModule = await import(
    'file://' + path.join(DIST_ROOT, 'modules', 'tickets', 'ticket-archiver.service.js')
  );
  const archiver = app.get(archiverModule.TicketArchiverService);

  step('Seed workspace + board + columns + driver agent + user session');
  const ws = await createWorkspace(app, getDataSourceToken, 'archive-edges');
  const board = await createBoard(app, getDataSourceToken, ws.id, { name: 'archive-edges' });
  const todoCol = await createColumn(app, getDataSourceToken, board.id, {
    name: 'To Do', position: 0, workspaceId: ws.id, kind: 'intake', roleRouting: ['assignee'],
  });
  const doneCol = await createColumn(app, getDataSourceToken, board.id, {
    name: 'Done', position: 1, workspaceId: ws.id, isTerminal: true, kind: 'terminal',
  });

  const driverAgent = await createAgent(app, getDataSourceToken, ws.id, { name: 'driver' });
  const driverKey = await createApiKey(app, getDataSourceToken, driverAgent.id, {
    workspaceId: ws.id, label: 'driver',
  });

  const user = await createUser(app, getDataSourceToken, { name: 'archive-user' });
  const userToken = app.get(AuthService).createSession(user.id);
  assert.ok(userToken, 'AuthService.createSession returned a token');

  const ticketRepo = ds.getRepository('Ticket');
  const commentRepo = ds.getRepository('Comment');
  const alertRepo = ds.getRepository('StuckTicketAlert');
  const roomRepo = ds.getRepository('ChatRoom');
  const messageRepo = ds.getRepository('ChatRoomMessage');
  const boardRepo = ds.getRepository('Board');

  // Chat room so the detector has somewhere to dispatch alerts; we assert
  // the *absence* of new system messages in the archived-ticket subtests.
  const room = await roomRepo.save(roomRepo.create({
    workspace_id: ws.id, type: 'group', name: 'archive-edge-alerts',
  }));

  const now = new Date();
  const HOUR = 3_600_000;

  // ─── Subtest 1a — archived ticket never enters the stuck candidate set ───
  await t.test('Stuck-detector skips archived tickets in the candidate scan', async () => {
    step('Create an old WAIT-shaped ticket then archive it');
    const archivedTicket = await createTicket(app, getDataSourceToken, {
      columnId: todoCol.id, workspaceId: ws.id,
      title: 'archived but WAIT-shaped', assigneeId: driverAgent.id,
    });
    // Backdate so the MIN_AGE_MS=2h gate would otherwise pass.
    await backdate(ticketRepo, archivedTicket.id, {
      created_at: new Date(now.getTime() - 5 * HOUR),
      updated_at: new Date(now.getTime() - 5 * HOUR),
    });
    for (let i = 3; i >= 0; i--) {
      await seedAgentComment(commentRepo, archivedTicket.id, ws.id, 'driver',
        `WAIT stands — check ${4 - i}`, new Date(now.getTime() - i * HOUR));
    }
    await ticketRepo.update(archivedTicket.id, { archived_at: new Date() });

    const before = (await messageRepo.find({ where: { room_id: room.id } })).length;
    const stats = await detector.sweep(now);

    assert.equal(stats.flagged, 0, 'archived ticket must not be flagged on the sweep');
    const alert = await alertRepo.findOne({ where: { ticket_id: archivedTicket.id } });
    assert.equal(alert, null, 'no stuck_alerts row must be written for an archived ticket');
    const after = (await messageRepo.find({ where: { room_id: room.id } })).length;
    assert.equal(after, before, 'archived ticket must not produce any chat alert');
  });

  // ─── Subtest 1b — alert that pre-existed gets silently pruned when archived ───
  await t.test('Pre-existing stuck_alert is silently cleared when the ticket is archived', async () => {
    step('Create a ticket, plant a stuck_alerts row, then archive the ticket');
    const t2 = await createTicket(app, getDataSourceToken, {
      columnId: todoCol.id, workspaceId: ws.id,
      title: 'alert-then-archive', assigneeId: driverAgent.id,
    });
    await backdate(ticketRepo, t2.id, {
      created_at: new Date(now.getTime() - 5 * HOUR),
      updated_at: new Date(now.getTime() - 5 * HOUR),
    });
    await alertRepo.save(alertRepo.create({
      ticket_id: t2.id,
      last_alerted_at: new Date(now.getTime() - 30 * 60_000),
      last_cycle_count: 4,
      last_comment_id: 'comment-fixture',
    }));
    await ticketRepo.update(t2.id, { archived_at: new Date() });

    const before = (await messageRepo.find({ where: { room_id: room.id } })).length;
    const stats = await detector.sweep(new Date());

    const stillThere = await alertRepo.findOne({ where: { ticket_id: t2.id } });
    assert.equal(stillThere, null, 'stuck_alerts row must be removed after archive');
    assert.ok(stats.unstuck >= 1, 'sweep must record the alert cleanup in stats.unstuck');

    const after = (await messageRepo.find({ where: { room_id: room.id } })).length;
    assert.equal(after, before, 'archive-driven cleanup must NOT post an unstuck chat alert');
  });

  // ─── Subtest 2 — workspace REST + MCP default exclusion ───
  await t.test('REST /api/workspaces/:id and MCP get_workspace exclude archived tickets', async () => {
    step('Seed two tickets on the same column: one active, one archived');
    const activeRow = await createTicket(app, getDataSourceToken, {
      columnId: todoCol.id, workspaceId: ws.id, title: 'active row', assigneeId: driverAgent.id,
    });
    const archivedRow = await createTicket(app, getDataSourceToken, {
      columnId: todoCol.id, workspaceId: ws.id, title: 'archived row', assigneeId: driverAgent.id,
    });
    await ticketRepo.update(archivedRow.id, { archived_at: new Date() });

    step('REST GET /api/workspaces/:id');
    const restRes = await fetch(`http://localhost:${port}/api/workspaces/${ws.id}`, {
      headers: { Authorization: `Bearer ${userToken}` },
    });
    assert.equal(restRes.status, 200, `REST workspace fetch must return 200, got ${restRes.status}`);
    const restBody = await restRes.json();
    const restBoard = restBody.boards.find((b) => b.id === board.id);
    assert.ok(restBoard, 'workspace REST payload must include the seeded board');
    const restTodoCol = restBoard.columns.find((c) => c.id === todoCol.id);
    assert.ok(restTodoCol, 'workspace REST payload must include the To Do column');
    const restTitles = restTodoCol.tickets.map((row) => row.title);
    assert.ok(restTitles.includes('active row'), 'active ticket must appear in REST payload');
    assert.ok(!restTitles.includes('archived row'),
      'archived ticket must NOT appear in REST workspace payload by default');
    const archivedIds = restTodoCol.tickets
      .filter((row) => row.archived_at)
      .map((row) => row.id);
    assert.equal(archivedIds.length, 0, 'no row with archived_at set should leak into the REST payload');

    step('MCP get_workspace');
    const mcp = new McpClient({
      baseUrl: `http://localhost:${port}`,
      apiKey: driverKey.raw_key,
      clientInfo: { name: 'qa-archive-edges', version: '1.0.0' },
    });
    await mcp.initialize();
    t.after(() => { void mcp.close().catch(() => {}); });
    const mcpRes = await mcp.callTool('get_workspace', { workspace_id: ws.id });
    assert.ok(mcpRes && !mcpRes.isError, `get_workspace failed: ${JSON.stringify(mcpRes)}`);
    const mcpBoard = mcpRes.boards.find((b) => b.id === board.id);
    assert.ok(mcpBoard, 'MCP get_workspace must include the seeded board');
    const mcpTodoCol = mcpBoard.columns.find((c) => c.id === todoCol.id);
    assert.ok(mcpTodoCol, 'MCP get_workspace must include the To Do column');
    assert.equal(mcpTodoCol.ticket_count, 1,
      `MCP get_workspace column.ticket_count must reflect only the active ticket (got ${mcpTodoCol.ticket_count})`);

    // Sanity: cleanup so subtest 3 doesn't see these tickets.
    await ticketRepo.delete({ id: activeRow.id });
    await ticketRepo.delete({ id: archivedRow.id });
  });

  // ─── Subtest 3 — create directly in terminal column stamps terminal_entered_at ───
  await t.test('Creating a ticket directly in a terminal column stamps terminal_entered_at and is archivable', async () => {
    step('MCP create_ticket targeting the Done column');
    const mcp = new McpClient({
      baseUrl: `http://localhost:${port}`,
      apiKey: driverKey.raw_key,
      clientInfo: { name: 'qa-archive-edges-2', version: '1.0.0' },
    });
    await mcp.initialize();
    t.after(() => { void mcp.close().catch(() => {}); });
    const created = await mcp.callTool('create_ticket', {
      title: 'born-in-done',
      column_id: doneCol.id,
      assignee_id: driverAgent.id,
    });
    assert.ok(created && created.id, `create_ticket must succeed: ${JSON.stringify(created)}`);
    const fresh = await ticketRepo.findOne({ where: { id: created.id } });
    assert.ok(fresh.terminal_entered_at,
      'terminal_entered_at must be stamped when a ticket is created directly on a terminal column');

    step('REST create directly into Done also stamps terminal_entered_at');
    const restRes = await fetch(`http://localhost:${port}/api/columns/${doneCol.id}/tickets`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${userToken}`,
        'X-Workspace-Id': ws.id,
      },
      body: JSON.stringify({ title: 'born-in-done-rest', assignee_id: driverAgent.id }),
    });
    assert.equal(restRes.status, 201, `REST create must return 201, got ${restRes.status}`);
    const restBody = await restRes.json();
    const restFresh = await ticketRepo.findOne({ where: { id: restBody.id } });
    assert.ok(restFresh.terminal_entered_at,
      'REST create on terminal column must also stamp terminal_entered_at');

    step('Backdate all activity signals past the cutoff and run the archiver');
    await boardRepo.update({ id: board.id }, { auto_archive_days: 1 });
    const twoDaysAgo = new Date(Date.now() - 2 * 86_400_000);
    // The idle-since gate compares GREATEST(terminal_entered_at, updated_at,
    // newest comment) against the cutoff, so a fresh ticket needs both its
    // entry time AND its updated_at backdated before it's archivable.
    await ticketRepo.update(fresh.id, { terminal_entered_at: twoDaysAgo, updated_at: twoDaysAgo });

    const result = await archiver.runOnce();
    assert.ok(result.archived_total >= 1,
      `archiver must pick up the directly-created terminal ticket (got ${result.archived_total})`);
    const archivedRow = await ticketRepo.findOne({ where: { id: fresh.id } });
    assert.ok(archivedRow.archived_at,
      'archiver must stamp archived_at on the directly-created terminal ticket');
  });

  // ─── Subtest 4 — last-activity (not just Done-entry) drives the cutoff ───
  await t.test('A comment newer than the cutoff keeps a Done ticket out of the archiver', async () => {
    step('Create a Done ticket whose entry + edit are old but carries a recent comment');
    const tkt = await createTicket(app, getDataSourceToken, {
      columnId: doneCol.id, workspaceId: ws.id, title: 'idle-but-commented', assigneeId: driverAgent.id,
    });
    await boardRepo.update({ id: board.id }, { auto_archive_days: 1 });
    const twoDaysAgo = new Date(Date.now() - 2 * 86_400_000);
    // Entry + last edit are both older than the 1-day cutoff — on the old
    // terminal_entered_at-only logic this would archive immediately.
    await ticketRepo.update(tkt.id, { terminal_entered_at: twoDaysAgo, updated_at: twoDaysAgo });
    // …but a comment landed an hour ago, inside the window.
    await seedAgentComment(commentRepo, tkt.id, ws.id, 'driver', 'still discussing',
      new Date(Date.now() - HOUR));

    await archiver.runOnce();
    let row = await ticketRepo.findOne({ where: { id: tkt.id } });
    assert.ok(!row.archived_at,
      'a ticket with a comment newer than the cutoff must NOT be archived');

    step('Backdate the comment past the cutoff → genuinely idle → archives');
    await commentRepo.update({ ticket_id: tkt.id }, { created_at: twoDaysAgo });
    await ticketRepo.update(tkt.id, { updated_at: twoDaysAgo });
    await archiver.runOnce();
    row = await ticketRepo.findOne({ where: { id: tkt.id } });
    assert.ok(row.archived_at,
      'once every activity signal predates the cutoff, the ticket archives');
  });
});

test.after?.(() => exitAfterTests(0));
process.on('beforeExit', () => exitAfterTests(0));
