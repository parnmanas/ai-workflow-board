// QA flow: create_ticket warns on the skip_default_assignments "519fad18
// trap" misreading (ticket bb5b9aed, problem 3 item 1).
//
// What this proves
// ─────────────────
//
// `skip_default_assignments` is documented as an escape hatch to force a
// TRUE, permanent zero-holder ticket (e.g. a QA orphan probe) by
// SUPPRESSING the board's default_role_assignments backfill. Its name
// invites the opposite misreading — "skip [my own] assignments, let the
// board default handle it" — which produces the exact opposite result: a
// ticket that is structurally invisible to BacklogPromotionService and
// never promotes. Nothing in the DB distinguishes that mistake from a
// deliberate probe, so a warning log at creation time is the only signal.
//
// Acceptance:
//   1. skip_default_assignments=true + intake-column destination + a board
//      default that WOULD have staffed the ticket → warns.
//   2. skip_default_assignments=true + intake-column destination, but the
//      board has NO default configured → does NOT warn (nothing would have
//      been staffed either way — not the trap shape).
//   3. skip_default_assignments=false (the normal/default path) → never
//      warns, board default applies normally instead.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootApp, exitAfterTests, step } from '../helpers/boot.mjs';
import {
  createWorkspace, createAgent, createApiKey, createBoard, createColumn,
} from '../helpers/fixtures.mjs';
import { McpClient } from '../helpers/mcp-client.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST_ROOT = path.resolve(__dirname, '..', '..', 'dist');

const PORT = parseInt(process.env.QA_SKIP_DEFAULT_ASSIGN_WARN_PORT || '7927', 10);
process.env.PORT = String(PORT);

test('create_ticket warns when skip_default_assignments likely means the opposite of what was intended', async (t) => {
  step('Boot NestJS app on test port');
  const { app, port, modules } = await bootApp({ port: PORT });
  t.after(() => { void app.close().catch(() => {}); });
  const { getDataSourceToken } = modules;
  const ds = app.get(getDataSourceToken());

  const LogService = (await import('file://' + path.join(DIST_ROOT, 'services', 'log.service.js'))).LogService;
  const logService = app.get(LogService);

  const boardRepo = ds.getRepository('Board');

  step('Seed workspace + driver caller + default-holder agent');
  const ws = await createWorkspace(app, getDataSourceToken, 'skip-default-warn');
  const driverAgent = await createAgent(app, getDataSourceToken, ws.id, { name: 'driver' });
  const driverKey = await createApiKey(app, getDataSourceToken, driverAgent.id, { workspaceId: ws.id, label: 'driver' });
  const bobAgent = await createAgent(app, getDataSourceToken, ws.id, { name: 'bob' });

  async function makeBoard(name) {
    const board = await createBoard(app, getDataSourceToken, ws.id, { name });
    const backlog = await createColumn(app, getDataSourceToken, board.id, {
      name: 'Backlog', position: 0, workspaceId: ws.id, kind: 'intake', roleRouting: [],
    });
    return { board, backlog };
  }

  const mcp = new McpClient({ baseUrl: `http://localhost:${port}`, apiKey: driverKey.raw_key });
  await mcp.initialize();
  t.after(() => { void mcp.close(); });

  function warnCountFor(marker) {
    return logService.query({ level: 'warn', category: 'MCP', search: marker }).length;
  }

  // ────────────────────────────────────────────────────────────────────
  // Case 1 — the trap shape: skip=true, intake destination, board WOULD
  // have staffed it.
  // ────────────────────────────────────────────────────────────────────
  step('Case 1 — skip=true on intake ticket, board default configured → warns');
  const c1 = await makeBoard('skip-warn-case1');
  await boardRepo.update(c1.board.id, {
    default_role_assignments: JSON.stringify({ assignee: [{ agent_id: bobAgent.id }] }),
  });
  const before1 = warnCountFor('skip_default_assignments=true');

  const res1 = await mcp.callTool('create_ticket', {
    title: 'orphan-probe-ish', board_id: c1.board.id, column_id: c1.backlog.id,
    skip_default_assignments: true,
  });
  assert.ok(!res1.isError, `create_ticket must succeed: ${JSON.stringify(res1)}`);

  const after1 = warnCountFor('skip_default_assignments=true');
  assert.equal(after1 - before1, 1,
    `expected exactly one new warn log for the trap shape (before=${before1}, after=${after1})`);

  // ────────────────────────────────────────────────────────────────────
  // Case 2 — skip=true but the board has no default → not the trap shape,
  // nothing would have been staffed either way.
  // ────────────────────────────────────────────────────────────────────
  step('Case 2 — skip=true, no board default → does NOT warn');
  const c2 = await makeBoard('skip-warn-case2');
  // Deliberately no default_role_assignments on this board.
  const before2 = warnCountFor('skip_default_assignments=true');

  const res2 = await mcp.callTool('create_ticket', {
    title: 'genuine-orphan-probe', board_id: c2.board.id, column_id: c2.backlog.id,
    skip_default_assignments: true,
  });
  assert.ok(!res2.isError, `create_ticket must succeed: ${JSON.stringify(res2)}`);

  const after2 = warnCountFor('skip_default_assignments=true');
  assert.equal(after2, before2, 'no board default to suppress — must not warn (not the misreading shape)');

  // ────────────────────────────────────────────────────────────────────
  // Case 3 — skip=false (normal path) — never warns, regardless of board
  // default.
  // ────────────────────────────────────────────────────────────────────
  step('Case 3 — skip=false (default) → never warns, board default applies normally');
  const c3 = await makeBoard('skip-warn-case3');
  await boardRepo.update(c3.board.id, {
    default_role_assignments: JSON.stringify({ assignee: [{ agent_id: bobAgent.id }] }),
  });
  const before3 = warnCountFor('skip_default_assignments=true');

  const res3 = await mcp.callTool('create_ticket', {
    title: 'normal-create', board_id: c3.board.id, column_id: c3.backlog.id,
  });
  assert.ok(!res3.isError, `create_ticket must succeed: ${JSON.stringify(res3)}`);

  const after3 = warnCountFor('skip_default_assignments=true');
  assert.equal(after3, before3, 'skip_default_assignments=false must never trigger the warning');

  const assignRepo = ds.getRepository('TicketRoleAssignment');
  const roleRepo = ds.getRepository('WorkspaceRole');
  const assigneeRole = await roleRepo.findOne({ where: { workspace_id: ws.id, slug: 'assignee' } });
  const t3Holders = await assignRepo.find({ where: { ticket_id: res3.id, role_id: assigneeRole.id } });
  assert.equal(t3Holders.length, 1, 'the normal (skip=false) path must still apply the board default as usual');

  exitAfterTests(0);
});
