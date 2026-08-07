// QA flow: batch_operations create-ticket now wires roles like every other
// creation path (ticket bb5b9aed).
//
// What this proves
// ─────────────────
//
// `batch_operations`'s `create-ticket` op used to call `tRepo.save()` as a
// raw insert and nothing else — no `workspace_id` backfill, no
// `syncBuiltinTrio`, no `applyBoardDefaults`. A root ticket created this way
// was ALWAYS zero-holder, even on a board with `default_role_assignments`
// configured, because the role-assignment table was never touched — making
// it permanently invisible to `BacklogPromotionService.tryPromote` (the
// exact "structurally can never promote" failure mode ticket bb5b9aed
// describes). MCP `create_ticket` / REST POST already did this correctly;
// this was the one creation surface left out.
//
// Acceptance:
//   1. No explicit ids, board HAS a default → the vacant role is backfilled
//      from the board default, and the ticket actually promotes end-to-end
//      via `BacklogPromotionService.tryPromote` — proving it is no longer
//      permanently zero-holder.
//   2. Explicit `assignee_id` supplied → wins over the board default
//      (explicit holder > board default, same priority every other creation
//      surface enforces) — the default holder is NOT also attached.
//   3. No explicit ids, board has NO default → the ticket is genuinely
//      zero-holder (unchanged, expected — nothing to backfill from), but
//      `workspace_id` is still correctly backfilled.

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

const PORT = parseInt(process.env.QA_BATCH_CREATE_ROLE_WIRING_PORT || '7926', 10);
process.env.PORT = String(PORT);

test('batch_operations create-ticket: role wiring + board default backfill parity', async (t) => {
  step('Boot NestJS app on test port');
  const { app, port, modules } = await bootApp({ port: PORT });
  t.after(() => { void app.close().catch(() => {}); });
  const { getDataSourceToken } = modules;
  const ds = app.get(getDataSourceToken());

  const backlogPromotionModule = await import(
    'file://' + path.join(DIST_ROOT, 'modules', 'agents', 'backlog-promotion.service.js')
  );
  const backlogPromotion = app.get(backlogPromotionModule.BacklogPromotionService);

  const ticketRepo = ds.getRepository('Ticket');
  const boardRepo = ds.getRepository('Board');
  const assignRepo = ds.getRepository('TicketRoleAssignment');
  const roleRepo = ds.getRepository('WorkspaceRole');
  const activityRepo = ds.getRepository('ActivityLog');

  step('Seed workspace + driver caller + default-holder + explicit-holder agents');
  const ws = await createWorkspace(app, getDataSourceToken, 'batch-create-wiring');
  const driverAgent = await createAgent(app, getDataSourceToken, ws.id, { name: 'driver' });
  const driverKey = await createApiKey(app, getDataSourceToken, driverAgent.id, { workspaceId: ws.id, label: 'driver' });
  const bobAgent = await createAgent(app, getDataSourceToken, ws.id, { name: 'bob' }); // board default holder
  const carolAgent = await createAgent(app, getDataSourceToken, ws.id, { name: 'carol' }); // explicit holder

  const assigneeRole = await roleRepo.findOne({ where: { workspace_id: ws.id, slug: 'assignee' } });
  assert.ok(assigneeRole, 'assignee WorkspaceRole must exist (seeded by createWorkspace)');

  async function makeBoard(name) {
    const board = await createBoard(app, getDataSourceToken, ws.id, { name });
    const backlog = await createColumn(app, getDataSourceToken, board.id, {
      name: 'Backlog', position: 0, workspaceId: ws.id, kind: 'intake', roleRouting: [],
    });
    const todo = await createColumn(app, getDataSourceToken, board.id, {
      name: 'To Do', position: 1, workspaceId: ws.id, kind: 'active', roleRouting: ['assignee'],
    });
    return { board, backlog, todo };
  }

  const mcp = new McpClient({ baseUrl: `http://localhost:${port}`, apiKey: driverKey.raw_key });
  await mcp.initialize();
  t.after(() => { void mcp.close(); });

  async function holdersFor(ticketId) {
    return assignRepo.find({ where: { ticket_id: ticketId, role_id: assigneeRole.id } });
  }

  // ────────────────────────────────────────────────────────────────────
  // Case 1 — no explicit ids, board HAS a default → backfilled + actually
  // promotes end-to-end.
  // ────────────────────────────────────────────────────────────────────
  step('Case 1 — board default configured, no explicit assignee → backfilled + promotes via tryPromote');
  const c1 = await makeBoard('batch-wiring-case1');
  await boardRepo.update(c1.board.id, {
    default_role_assignments: JSON.stringify({ assignee: [{ agent_id: bobAgent.id }] }),
  });

  const res1 = await mcp.callTool('batch_operations', {
    operations: [
      { action: 'create-ticket', boardId: c1.board.id, column: 'Backlog', title: 'batch-wired candidate', priority: 'high' },
    ],
  });
  assert.ok(!res1.isError, `batch_operations must succeed: ${JSON.stringify(res1)}`);
  assert.ok(res1.results[0].success, `create-ticket op must succeed: ${JSON.stringify(res1.results[0])}`);
  const t1Id = res1.results[0].ticketId;
  assert.ok(t1Id, 'op result must carry the new ticket id');

  const t1 = await ticketRepo.findOne({ where: { id: t1Id } });
  assert.ok(t1.workspace_id, 'workspace_id must be backfilled from column → board (previously stayed empty)');
  assert.equal(t1.workspace_id, ws.id, 'workspace_id must resolve to the board\'s actual workspace');

  const t1Holders = await holdersFor(t1Id);
  assert.equal(t1Holders.length, 1, 'assignee role must be backfilled from the board default');
  assert.equal(t1Holders[0].agent_id, bobAgent.id, 'backfilled holder must be the board default agent');

  const createdRows = await activityRepo.find({ where: { ticket_id: t1Id, action: 'created' } });
  assert.equal(createdRows.length, 1, 'a "created" activity row must now be written (previously none was)');

  step('  end-to-end proof: tryPromote actually promotes it (it is no longer permanently zero-holder)');
  const promotedId = await backlogPromotion.tryPromote(c1.board.id);
  assert.equal(promotedId, t1Id, `the batch-created ticket must promote once eligible (got ${promotedId?.slice(0, 8) || 'null'})`);
  const t1After = await ticketRepo.findOne({ where: { id: t1Id } });
  assert.equal(t1After.column_id, c1.todo.id, 'ticket must have moved out of intake');

  // ────────────────────────────────────────────────────────────────────
  // Case 2 — explicit assignee_id wins over the board default.
  // ────────────────────────────────────────────────────────────────────
  step('Case 2 — explicit assignee_id must win over the board default (never both)');
  const c2 = await makeBoard('batch-wiring-case2');
  await boardRepo.update(c2.board.id, {
    default_role_assignments: JSON.stringify({ assignee: [{ agent_id: bobAgent.id }] }),
  });

  const res2 = await mcp.callTool('batch_operations', {
    operations: [
      {
        action: 'create-ticket', boardId: c2.board.id, column: 'Backlog',
        title: 'explicit-assignee candidate', priority: 'medium', assignee_id: carolAgent.id,
      },
    ],
  });
  assert.ok(res2.results[0].success, `create-ticket op must succeed: ${JSON.stringify(res2.results[0])}`);
  const t2Id = res2.results[0].ticketId;

  const t2Holders = await holdersFor(t2Id);
  assert.equal(t2Holders.length, 1, 'exactly one assignee holder — explicit wins, default must not also apply');
  assert.equal(t2Holders[0].agent_id, carolAgent.id, 'explicit assignee_id must be the holder, not the board default');

  // ────────────────────────────────────────────────────────────────────
  // Case 3 — no explicit ids, board has NO default → genuinely zero-holder
  // (unchanged — nothing to backfill from), workspace_id still backfilled.
  // ────────────────────────────────────────────────────────────────────
  step('Case 3 — no board default: genuinely zero-holder (expected), workspace_id still backfilled');
  const c3 = await makeBoard('batch-wiring-case3');
  // Deliberately no default_role_assignments set on this board.

  const res3 = await mcp.callTool('batch_operations', {
    operations: [
      { action: 'create-ticket', boardId: c3.board.id, column: 'Backlog', title: 'no-default candidate', priority: 'low' },
    ],
  });
  assert.ok(res3.results[0].success, `create-ticket op must succeed: ${JSON.stringify(res3.results[0])}`);
  const t3Id = res3.results[0].ticketId;

  const t3 = await ticketRepo.findOne({ where: { id: t3Id } });
  assert.equal(t3.workspace_id, ws.id, 'workspace_id must be backfilled even when there is no board default to apply');
  assert.equal((await holdersFor(t3Id)).length, 0, 'no board default → role stays genuinely vacant, no guessed holder');

  const t3Promoted = await backlogPromotion.tryPromote(c3.board.id);
  assert.notEqual(t3Promoted, t3Id, 'a genuinely zero-holder ticket (no board default) must not promote — expected, not a regression target');

  exitAfterTests(0);
});
