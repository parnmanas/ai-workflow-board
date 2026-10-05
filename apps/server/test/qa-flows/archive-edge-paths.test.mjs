// QA flow: archive edge-path regressions for ticket 9b44526b.
//
// Scenarios the reviewer flagged as missing behavioural coverage
// (the existing archive-exclusion-guard.test.mjs is static-grep only):
//
//   1. REST GET /api/accounts/:id, the ticket list and MCP get_account
//      must exclude archived tickets by default (and from the per-status
//      ticket_counts).
//   2. Creating a ticket directly in `done` must stamp terminal_entered_at, so
//      the archiver actually picks it up.
//   3. Last activity (not just the Done entry) drives the archive cutoff.
//   4. Manually archiving an open ticket releases its outreach dedupe key.
//
// (The stuck-ticket-detector subtests went away with the detector itself —
// board removal, docs/tickets.md.) These exercise the real services (no mocks)
// on a booted NestJS app.

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
  createAccount,
  createAgent,
  createApiKey,
  createTicket,
  createUser,
} from '../helpers/fixtures.mjs';
import { McpClient } from '../helpers/mcp-client.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST_ROOT = path.resolve(__dirname, '..', '..', 'dist');

process.env.PORT = process.env.QA_ARCHIVE_EDGE_PORT || '0';

async function seedAgentComment(commentRepo, ticketId, accountId, author, content, createdAt) {
  const saved = await commentRepo.save(commentRepo.create({
    ticket_id: ticketId,
    account_id: accountId,
    author_type: 'agent',
    author_id: 'agent-fixture',
    author,
    content,
    type: 'note',
  }));
  if (createdAt) await commentRepo.update(saved.id, { created_at: createdAt });
  return commentRepo.findOne({ where: { id: saved.id } });
}

test('Archive edge-path regressions (ticket 9b44526b)', async (t) => {
  step('Boot NestJS app on test port');
  const { app, port, modules } = await bootApp({ port: 0 });
  t.after(() => { void app.close().catch(() => {}); });
  const { getDataSourceToken, AuthService } = modules;
  const ds = app.get(getDataSourceToken());

  const archiverModule = await import(
    'file://' + path.join(DIST_ROOT, 'modules', 'tickets', 'ticket-archiver.service.js')
  );
  const archiver = app.get(archiverModule.TicketArchiverService);

  step('Seed workspace + driver agent + user session');
  const ws = await createAccount(app, getDataSourceToken, 'archive-edges');
  const driverAgent = await createAgent(app, getDataSourceToken, ws.id, { name: 'driver', runtime: true });
  const driverKey = await createApiKey(app, getDataSourceToken, driverAgent.id, {
    accountId: ws.id, label: 'driver',
  });

  const user = await createUser(app, getDataSourceToken, { name: 'archive-user' });
  const userToken = app.get(AuthService).createSession(user.id);
  assert.ok(userToken, 'AuthService.createSession returned a token');

  const ticketRepo = ds.getRepository('Ticket');
  const commentRepo = ds.getRepository('Comment');
  const wsRepo = ds.getRepository('Account');
  const HOUR = 3_600_000;

  const rest = (method, urlPath, body) => fetch(`http://localhost:${port}/api${urlPath}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${userToken}`,
      'X-Account-Id': ws.id,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const mcp = new McpClient({
    baseUrl: `http://localhost:${port}`,
    apiKey: driverKey.raw_key,
    clientInfo: { name: 'qa-archive-edges', version: '1.0.0' },
  });
  await mcp.initialize();
  t.after(() => { void mcp.close().catch(() => {}); });

  // Tickets below are backlog (or done) on purpose: an assigned todo ticket
  // would be started by the dispatcher, and these tests are about archiving,
  // not dispatch.

  // ─── Subtest 1 — workspace REST + ticket list + MCP default exclusion ───
  await t.test('REST /api/accounts/:id, the ticket list and MCP get_account exclude archived tickets', async () => {
    step('Seed two tickets in the same status: one active, one archived');
    const activeRow = await createTicket(app, getDataSourceToken, {
      accountId: ws.id, status: 'backlog', title: 'active row', assignee: driverAgent,
    });
    const archivedRow = await createTicket(app, getDataSourceToken, {
      accountId: ws.id, status: 'backlog', title: 'archived row', assignee: driverAgent,
    });
    await ticketRepo.update(archivedRow.id, { archived_at: new Date() });

    step('REST GET /api/accounts/:id');
    const restRes = await rest('GET', `/accounts/${ws.id}`);
    assert.equal(restRes.status, 200, `REST workspace fetch must return 200, got ${restRes.status}`);
    const restBody = await restRes.json();
    assert.equal(restBody.ticket_counts.backlog, 1,
      `REST workspace ticket_counts must reflect only the active ticket (got ${JSON.stringify(restBody.ticket_counts)})`);

    step('REST GET /api/accounts/:wsId/tickets');
    const listRes = await rest('GET', `/accounts/${ws.id}/tickets?status=backlog`);
    assert.equal(listRes.status, 200);
    const listTitles = (await listRes.json()).tickets.map((row) => row.title);
    assert.ok(listTitles.includes('active row'), 'active ticket must appear in the ticket list');
    assert.ok(!listTitles.includes('archived row'),
      'archived ticket must NOT appear in the ticket list by default');
    const archivedOnly = await (await rest('GET', `/accounts/${ws.id}/tickets?archived_only=1`)).json();
    assert.deepEqual(archivedOnly.tickets.map((row) => row.id), [archivedRow.id],
      'archived_only=1 is the opt-in archive view');

    step('MCP get_account');
    const mcpRes = await mcp.callTool('get_account', { account_id: ws.id });
    assert.ok(mcpRes && !mcpRes.isError, `get_account failed: ${JSON.stringify(mcpRes)}`);
    assert.equal(mcpRes.ticket_counts.backlog, 1,
      `MCP get_account ticket_counts must reflect only the active ticket (got ${JSON.stringify(mcpRes.ticket_counts)})`);

    // Sanity: cleanup so the later subtests don't see these tickets.
    await ticketRepo.delete({ id: activeRow.id });
    await ticketRepo.delete({ id: archivedRow.id });
  });

  // ─── Subtest 2 — create directly in done stamps terminal_entered_at ───
  await t.test('Creating a ticket directly in done stamps terminal_entered_at and is archivable', async () => {
    step('MCP create_ticket straight into done');
    const created = await mcp.callTool('create_ticket', {
      account_id: ws.id,
      title: 'born-in-done',
      status: 'done',
      assignee: driverAgent.runtime_spec,
    });
    assert.ok(created && created.id, `create_ticket must succeed: ${JSON.stringify(created)}`);
    const fresh = await ticketRepo.findOne({ where: { id: created.id } });
    assert.equal(fresh.status, 'done');
    assert.ok(fresh.terminal_entered_at,
      'terminal_entered_at must be stamped when a ticket is created directly in done');

    step('REST create directly into done also stamps terminal_entered_at');
    const restRes = await rest('POST', `/accounts/${ws.id}/tickets`, {
      title: 'born-in-done-rest', status: 'done', assignee: driverAgent.runtime_spec,
    });
    assert.equal(restRes.status, 201, `REST create must return 201, got ${restRes.status}`);
    const restBody = await restRes.json();
    const restFresh = await ticketRepo.findOne({ where: { id: restBody.id } });
    assert.ok(restFresh.terminal_entered_at,
      'REST create in done must also stamp terminal_entered_at');

    step('Backdate all activity signals past the cutoff and run the archiver');
    await wsRepo.update({ id: ws.id }, { auto_archive_days: 1 });
    const twoDaysAgo = new Date(Date.now() - 2 * 86_400_000);
    // The idle-since gate compares GREATEST(terminal_entered_at, updated_at,
    // newest comment) against the cutoff, so a fresh ticket needs both its
    // entry time AND its updated_at backdated before it's archivable.
    await ticketRepo.update(fresh.id, { terminal_entered_at: twoDaysAgo, updated_at: twoDaysAgo });

    const result = await archiver.runOnce();
    assert.ok(result.archived_total >= 1,
      `archiver must pick up the directly-created done ticket (got ${result.archived_total})`);
    const archivedRow = await ticketRepo.findOne({ where: { id: fresh.id } });
    assert.ok(archivedRow.archived_at,
      'archiver must stamp archived_at on the directly-created done ticket');
    const stillFresh = await ticketRepo.findOne({ where: { id: restFresh.id } });
    assert.equal(stillFresh.archived_at, null, 'a done ticket inside the window is not archived yet');
  });

  // ─── Subtest 3 — last-activity (not just Done-entry) drives the cutoff ───
  await t.test('A comment newer than the cutoff keeps a done ticket out of the archiver', async () => {
    step('Create a done ticket whose entry + edit are old but carries a recent comment');
    const tkt = await createTicket(app, getDataSourceToken, {
      accountId: ws.id, status: 'done', title: 'idle-but-commented', assignee: driverAgent,
    });
    await wsRepo.update({ id: ws.id }, { auto_archive_days: 1 });
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

  // ─── Subtest 4 — manual archive of an open ticket releases its outreach dedupe key (ticket a565b657) ───
  await t.test('MCP archive_ticket clears operational_dedupe_key when archiving an open ticket', async () => {
    step('Create an open ticket carrying an outreach-style dedupe key');
    const outreachLike = await createTicket(app, getDataSourceToken, {
      accountId: ws.id, status: 'backlog',
      title: 'outreach-created ticket', assignee: driverAgent,
    });
    await ticketRepo.update(outreachLike.id, {
      operational_dedupe_key: `outreach:fixture-channel:${outreachLike.id}`,
    });
    const beforeArchive = await ticketRepo.findOne({ where: { id: outreachLike.id } });
    assert.ok(beforeArchive.operational_dedupe_key, 'fixture ticket must carry a dedupe key before archiving');
    assert.equal(beforeArchive.archived_at, null, 'fixture ticket starts unarchived and not done');

    step('MCP archive_ticket');
    const archived = await mcp.callTool('archive_ticket', { ticket_id: outreachLike.id });
    assert.ok(archived && !archived.isError, `archive_ticket failed: ${JSON.stringify(archived)}`);

    const afterArchive = await ticketRepo.findOne({ where: { id: outreachLike.id } });
    assert.ok(afterArchive.archived_at, 'ticket must be archived');
    assert.equal(afterArchive.operational_dedupe_key, null,
      'archiving an open ticket must clear operational_dedupe_key so outreach-ingest can never pick it as a dedupe-key winner later');
  });
});

test.after?.(() => exitAfterTests(0));
process.on('beforeExit', () => exitAfterTests(0));
