// MCP `batch_operations`'s add-comment op (misc-tools.ts) — author_type
// misclassification fix + hard-budget guard wiring (ticket 50b92d71, closing
// a940d75b's residual bypass).
//
// Before the fix this op saved every comment with the Comment column default
// author_type='user' (no field passed at all), so agent-authored comments
// posted through this path were invisible to the (a) hard-budget ceiling
// (`countAutoResponses` only counts author_type='agent') — an unlimited
// bypass of the per-ticket auto-response cap. This file pins:
//   (i)  the saved row defaults to author_type='agent' (matching the REST
//        batch add-comment op in agent-api.controller.ts, not the raw
//        Comment column default), while still honoring an explicit override;
//   (ii) enforceAutoResponseBudget actually suppresses once the ticket's
//        board-configured ceiling is exceeded, same contract as every other
//        comment-creation surface (see hard-budget-guard.test.mjs).
//
// Runs against compiled dist/ (requires `npm run build`, satisfied by the
// test script) with a REAL sql.js DataSource (mirrors hard-budget-guard.
// test.mjs) — enforceAutoResponseBudget walks Ticket -> BoardColumn ->
// Board.hard_budget_config, so a mocked-repo harness would only test the
// mock, not the actual wiring. Uses an isolated SQLJS_DB_PATH temp file so it
// never touches the shared dev database/data.db.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(__dirname, '..', 'dist');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awb-misc-tools-batch-comment-'));
process.env.DB_TYPE = 'sqlite';
process.env.SQLJS_DB_PATH = path.join(tmpDir, 'misc-tools-batch-comment-test.db');
process.env.NODE_ENV = 'test';

const { buildDataSourceOptions } = await import('file://' + path.join(DIST, 'db.js'));
const { DataSource } = await import('typeorm');
const { Board } = await import('file://' + path.join(DIST, 'entities', 'Board.js'));
const { BoardColumn } = await import('file://' + path.join(DIST, 'entities', 'BoardColumn.js'));
const { Ticket } = await import('file://' + path.join(DIST, 'entities', 'Ticket.js'));
const { Comment } = await import('file://' + path.join(DIST, 'entities', 'Comment.js'));
const { ActivityLog } = await import('file://' + path.join(DIST, 'entities', 'ActivityLog.js'));
const { Agent } = await import('file://' + path.join(DIST, 'entities', 'Agent.js'));
const { ActivityService } = await import('file://' + path.join(DIST, 'services', 'activity.service.js'));
const { registerMiscTools } = await import('file://' + path.join(DIST, 'modules', 'mcp', 'tools', 'misc-tools.js'));

const ds = new DataSource(buildDataSourceOptions());
await ds.initialize();

const logStub = { warn() {}, info() {}, error() {}, debug() {} };
const activityService = new ActivityService(ds.getRepository(ActivityLog), ds.getRepository(Agent), logStub);

const boardRepo = ds.getRepository(Board);
const colRepo = ds.getRepository(BoardColumn);
const ticketRepo = ds.getRepository(Ticket);
const commentRepo = ds.getRepository(Comment);

async function makeBoard(hardBudgetConfig) {
  return boardRepo.save(boardRepo.create({ name: 'B', hard_budget_config: hardBudgetConfig ?? null }));
}
async function makeColumn(board) {
  return colRepo.save(colRepo.create({ board_id: board.id, name: 'To Do', position: 1 }));
}
async function makeTicket(col, overrides = {}) {
  return ticketRepo.save(ticketRepo.create({
    title: 'T', column_id: col ? col.id : null, workspace_id: 'w1', pending_user_action: false, ...overrides,
  }));
}
async function addAgentComment(ticketId, opts = {}) {
  return commentRepo.save(commentRepo.create({
    ticket_id: ticketId, author_type: 'agent', author: 'A', content: 'x', type: 'note', ...opts,
  }));
}

function registerBatchOperations() {
  const handlers = new Map();
  const server = { tool(name, _description, _schema, handler) { handlers.set(name, handler); } };
  const ctx = { dataSource: ds, activityService, roomMessagingService: null, logger: logStub, ticketRoleAssignmentService: null };
  registerMiscTools(server, ctx);
  return handlers.get('batch_operations');
}

after(async () => {
  await ds.destroy();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('batch_operations add-comment defaults author_type to agent (fixes misclassification)', async () => {
  const batchOperations = registerBatchOperations();
  const t = await makeTicket(null);
  const res = await batchOperations({
    operations: [{ action: 'add-comment', ticketId: t.id, author: 'Agent X', content: 'hello' }],
  });
  const parsed = JSON.parse(res.content[0].text);
  assert.equal(parsed.results[0].success, true);
  const saved = await commentRepo.findOne({ where: { id: parsed.results[0].commentId } });
  assert.equal(saved.author_type, 'agent', 'must default to agent, not the Comment column default (user)');
});

test('batch_operations add-comment respects an explicit authorType override', async () => {
  const batchOperations = registerBatchOperations();
  const t = await makeTicket(null);
  const res = await batchOperations({
    operations: [{ action: 'add-comment', ticketId: t.id, author: 'Human', content: 'hi', authorType: 'user' }],
  });
  const parsed = JSON.parse(res.content[0].text);
  const saved = await commentRepo.findOne({ where: { id: parsed.results[0].commentId } });
  assert.equal(saved.author_type, 'user');
});

test('batch_operations add-comment: unknown ticket errors instead of throwing', async () => {
  const batchOperations = registerBatchOperations();
  const res = await batchOperations({
    operations: [{ action: 'add-comment', ticketId: 'does-not-exist', author: 'A', content: 'x' }],
  });
  const parsed = JSON.parse(res.content[0].text);
  assert.equal(parsed.results[0].error, 'Ticket not found');
});

test('batch_operations add-comment: over the hard-budget cap suppresses instead of saving (agent bypass closed)', async () => {
  const batchOperations = registerBatchOperations();
  const board = await makeBoard(JSON.stringify({ max_auto_responses: 2, notify: false }));
  const col = await makeColumn(board);
  const t = await makeTicket(col);
  await addAgentComment(t.id);
  await addAgentComment(t.id);

  const before = await commentRepo.count({ where: { ticket_id: t.id } });
  const res = await batchOperations({
    operations: [{ action: 'add-comment', ticketId: t.id, author: 'Agent X', content: 'over budget' }],
  });
  const parsed = JSON.parse(res.content[0].text);
  assert.deepEqual(parsed.results[0], { suppressed: true, reason: 'max_auto_responses_exceeded' });

  const after = await commentRepo.count({ where: { ticket_id: t.id } });
  assert.equal(after, before, 'no new comment row must be saved when the budget guard blocks');

  const reloaded = await ticketRepo.findOne({ where: { id: t.id } });
  assert.equal(reloaded.pending_user_action, true, 'auto-pends the ticket like every other hard-budget surface');
});

test('batch_operations add-comment: user-authored comments never trip the agent-only ceiling', async () => {
  const batchOperations = registerBatchOperations();
  const board = await makeBoard(JSON.stringify({ max_auto_responses: 1, notify: false }));
  const col = await makeColumn(board);
  const t = await makeTicket(col);
  await addAgentComment(t.id);

  const res = await batchOperations({
    operations: [{ action: 'add-comment', ticketId: t.id, author: 'Human', content: 'still fine', authorType: 'user' }],
  });
  const parsed = JSON.parse(res.content[0].text);
  assert.equal(parsed.results[0].success, true, 'user comments must not be counted against the agent-only cap');
});
