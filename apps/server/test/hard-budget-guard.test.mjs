// Hard-budget ceiling — runtime guard (ticket a940d75b), against a REAL
// sql.js DataSource driven through the app's own buildDataSourceOptions()
// (so `synchronize` actually creates Board.hard_budget_config + every table
// the guard queries — the dual-DB migration-free config-column convention).
//
// Central regression this file exists to pin: the Planner's decision flagged
// a fatal flaw in a naive lifetime counter — once a breach auto-pends a
// ticket, a human unpend must ACTUALLY clear the count, or the very next
// agent comment/dispatch re-trips the same already-over-limit count and the
// ticket dies permanently. `lastHumanUnpendAt` anchors both ceilings to the
// latest `field_changed='pending_user_action', new_value='false'` activity
// row — the epoch test below is the one that would have caught the bug.
//
// Runs against compiled dist/ (requires `npm run build`, satisfied by the
// test script). Uses an isolated SQLJS_DB_PATH temp file so it never touches
// the shared dev database/data.db.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(__dirname, '..', 'dist');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awb-hard-budget-'));
process.env.DB_TYPE = 'sqlite';
process.env.SQLJS_DB_PATH = path.join(tmpDir, 'hard-budget-test.db');
process.env.NODE_ENV = 'test';

const { buildDataSourceOptions } = await import('file://' + path.join(DIST, 'db.js'));
const { DataSource } = await import('typeorm');
const { Board } = await import('file://' + path.join(DIST, 'entities', 'Board.js'));
const { BoardColumn } = await import('file://' + path.join(DIST, 'entities', 'BoardColumn.js'));
const { Ticket } = await import('file://' + path.join(DIST, 'entities', 'Ticket.js'));
const { Comment } = await import('file://' + path.join(DIST, 'entities', 'Comment.js'));
const { ActivityLog } = await import('file://' + path.join(DIST, 'entities', 'ActivityLog.js'));
const { Subagent } = await import('file://' + path.join(DIST, 'entities', 'Subagent.js'));
const { Agent } = await import('file://' + path.join(DIST, 'entities', 'Agent.js'));
const { Workspace } = await import('file://' + path.join(DIST, 'entities', 'Workspace.js'));
const { ActivityService } = await import('file://' + path.join(DIST, 'services', 'activity.service.js'));
const {
  lastHumanUnpendAt,
  countAutoResponses,
  countWindowDispatches,
  countWindowDispatchesBySource,
  countTwinSuppressions,
  countWindowTokens,
  pendTicketForHardBudget,
  enforceAutoResponseBudget,
  resolveHardBudgetForTicket,
} = await import('file://' + path.join(DIST, 'common', 'hard-budget-guard.js'));

const ds = new DataSource(buildDataSourceOptions());
await ds.initialize();

const logStub = { warn() {}, info() {}, error() {}, debug() {} };
const activityService = new ActivityService(ds.getRepository(ActivityLog), ds.getRepository(Agent), logStub);
const deps = { dataSource: ds, activityService, logger: logStub };

const boardRepo = ds.getRepository(Board);
const colRepo = ds.getRepository(BoardColumn);
const ticketRepo = ds.getRepository(Ticket);
const commentRepo = ds.getRepository(Comment);
const activityRepo = ds.getRepository(ActivityLog);
const subagentRepo = ds.getRepository(Subagent);
const agentRepo = ds.getRepository(Agent);
const wsRepo = ds.getRepository(Workspace);

async function makeBoard(hardBudgetConfig) {
  return boardRepo.save(boardRepo.create({ name: 'B', hard_budget_config: hardBudgetConfig ?? null }));
}
async function makeWorkspace(hardBudgetConfig) {
  return wsRepo.save(wsRepo.create({ name: 'W', hard_budget_config: hardBudgetConfig ?? null }));
}
async function makeColumn(board) {
  return colRepo.save(colRepo.create({ board_id: board.id, name: 'To Do', position: 1 }));
}
async function makeDoneColumn(board) {
  return colRepo.save(colRepo.create({
    board_id: board.id, name: 'Done', position: 6, is_terminal: true, kind: 'terminal',
  }));
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
/** Write the exact row REST PATCH /api/tickets/:id leaves on a human unpend. */
async function recordHumanUnpend(ticketId) {
  await activityRepo.save(activityRepo.create({
    entity_type: 'ticket', entity_id: ticketId, ticket_id: ticketId, action: 'updated',
    field_changed: 'pending_user_action', old_value: 'true', new_value: 'false',
    actor_id: 'human1', actor_name: 'Human',
  }));
}
async function recordTriggerEmitted(ticketId, triggerSource = 'comment', triggerId = '') {
  await activityRepo.save(activityRepo.create({
    entity_type: 'ticket', entity_id: ticketId, ticket_id: ticketId, action: 'trigger_emitted',
    field_changed: triggerId, trigger_source: triggerSource, actor_id: 'system', actor_name: 'TriggerLoopService',
  }));
}
/** Write a `subagents` row shaped like the `end` POST leaves it (ticket 6dd3f968). */
let subagentSeq = 0;
async function seedSubagent(ticketId, overrides = {}) {
  subagentSeq += 1;
  return subagentRepo.save(subagentRepo.create({
    subagent_id: `sa-${subagentSeq}`,
    agent_id: 'agent1',
    workspace_id: 'w1',
    kind: 'ticket',
    started_at: new Date(),
    ticket_id: ticketId,
    ...overrides,
  }));
}

after(async () => {
  await ds.destroy();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('countAutoResponses counts only agent/non-system comments at/after `since`', async () => {
  const t = await makeTicket(null);
  const since = new Date(Date.now() - 1000);
  await addAgentComment(t.id, { author_type: 'user' });
  await addAgentComment(t.id, { type: 'system' });
  await addAgentComment(t.id);
  await addAgentComment(t.id);
  assert.equal(await countAutoResponses(ds, t.id, since), 2);
  assert.equal(await countAutoResponses(ds, t.id, new Date(Date.now() + 60_000)), 0, 'a future `since` sees nothing yet');
});

test('lastHumanUnpendAt: null when the ticket was never unpended; latest row otherwise', async () => {
  const t = await makeTicket(null);
  assert.equal(await lastHumanUnpendAt(ds, t.id), null);
  await recordHumanUnpend(t.id);
  const first = await lastHumanUnpendAt(ds, t.id);
  assert.ok(first instanceof Date);
  await new Promise(r => setTimeout(r, 5));
  await recordHumanUnpend(t.id);
  const second = await lastHumanUnpendAt(ds, t.id);
  assert.ok(second.getTime() >= first.getTime(), 'picks the LATEST unpend row');
});

test('countWindowDispatches excludes manual/comment_summary trigger sources', async () => {
  const t = await makeTicket(null);
  const since = new Date(Date.now() - 1000);
  await recordTriggerEmitted(t.id, 'comment');
  await recordTriggerEmitted(t.id, 'manual');
  await recordTriggerEmitted(t.id, 'comment_summary');
  await recordTriggerEmitted(t.id, 'column_move');
  assert.equal(await countWindowDispatches(ds, t.id, since), 2);
});

// ticket 3c8b8026 성공 기준 5: 자동 pend 알림의 trigger_source 분포다.
// countWindowDispatches와 같은 행/제외 조건에 GROUP BY만 더하므로 두 집계의
// 합계는 항상 같아야 한다.
test('countWindowDispatchesBySource groups by trigger_source with the same exclusions as countWindowDispatches', async () => {
  const t = await makeTicket(null);
  const since = new Date(Date.now() - 1000);
  await recordTriggerEmitted(t.id, 'comment');
  await recordTriggerEmitted(t.id, 'comment');
  await recordTriggerEmitted(t.id, 'column_move');
  await recordTriggerEmitted(t.id, 'manual');
  await recordTriggerEmitted(t.id, 'comment_summary');

  const bySource = await countWindowDispatchesBySource(ds, t.id, since);
  const asMap = Object.fromEntries(bySource.map((r) => [r.trigger_source, r.count]));
  assert.deepEqual(asMap, { comment: 2, column_move: 1 },
    'manual/comment_summary excluded exactly like countWindowDispatches; grouped by trigger_source');

  const total = bySource.reduce((sum, r) => sum + r.count, 0);
  assert.equal(total, await countWindowDispatches(ds, t.id, since),
    'the grouped total must equal the scalar count — both read the same underlying rows');
});

test('countWindowDispatchesBySource returns an empty array when nothing is in the window', async () => {
  const t = await makeTicket(null);
  const future = new Date(Date.now() + 60_000);
  await recordTriggerEmitted(t.id, 'comment');
  assert.deepEqual(await countWindowDispatchesBySource(ds, t.id, future), []);
});

test('countTwinSuppressions는 한 hold의 표시 알림 수와 무관하게 억제 N건을 정확히 센다', async () => {
  const t = await makeTicket(null);
  const since = new Date(Date.now() - 1000);
  for (let i = 0; i < 4; i += 1) {
    await activityRepo.save(activityRepo.create({
      entity_type: 'ticket', entity_id: `trigger-${i}`, ticket_id: t.id,
      action: 'dispatch_twin_suppressed', field_changed: 'inflight_dispatch',
      new_value: JSON.stringify({ trigger_id: `trigger-${i}`, role: 'assignee' }),
      trigger_source: 'comment',
    }));
  }
  assert.equal(await countTwinSuppressions(ds, t.id, since), 4,
    '표시 알림이 한 번뿐인 hold에서도 실제 억제 N건을 모두 세어야 한다');
  await activityRepo.save(activityRepo.create({
    entity_type: 'ticket', entity_id: 'trigger-0', ticket_id: t.id,
    action: 'dispatch_twin_suppressed', field_changed: 'inflight_dispatch',
    trigger_source: 'comment',
  }));
  assert.equal(await countTwinSuppressions(ds, t.id, since), 4,
    'outbox 재전송으로 같은 trigger id가 중복 저장되어도 한 번만 차감해야 한다');
});

test('countTwinSuppressions는 원시 dispatch 집합에서 제외한 source를 차감하지 않는다', async () => {
  const t = await makeTicket(null);
  const since = new Date(Date.now() - 1000);
  for (const triggerSource of ['comment', 'manual', 'comment_summary']) {
    await activityRepo.save(activityRepo.create({
      entity_type: 'ticket', entity_id: `suppressed-${triggerSource}`, ticket_id: t.id,
      action: 'dispatch_twin_suppressed', trigger_source: triggerSource,
    }));
  }
  assert.equal(await countTwinSuppressions(ds, t.id, since), 1,
    'manual/comment_summary 억제는 정상 dispatch 차감에 포함하면 안 된다');
});

test('countTwinSuppressions는 윈도우 이전 activity와 다른 action을 제외한다', async () => {
  const t = await makeTicket(null);
  await activityRepo.save(activityRepo.create({
    entity_type: 'ticket', entity_id: t.id, ticket_id: t.id,
    action: 'dispatch_twin_suppressed', field_changed: 'mention_seat',
  }));
  const since = new Date();
  await new Promise((resolve) => setTimeout(resolve, 5));
  await activityRepo.save(activityRepo.create({
    entity_type: 'ticket', entity_id: t.id, ticket_id: t.id,
    action: 'created', actor_id: 'system', actor_name: 'Manager',
  }));

  assert.equal(await countTwinSuppressions(ds, t.id, since), 0,
    '윈도우 이전 억제와 전용 action이 아닌 activity는 차감하면 안 된다');
});

// ── countWindowTokens (ticket ef53fdf4) ─────────────────────────────────────
test('countWindowTokens sums only input_tokens + output_tokens, excluding cache fields', async () => {
  const t = await makeTicket(null);
  const since = new Date(Date.now() - 1000);
  await seedSubagent(t.id, {
    input_tokens: 100, output_tokens: 50,
    cache_read_input_tokens: 99999, cache_creation_input_tokens: 88888,
  });
  assert.equal(await countWindowTokens(ds, t.id, since), 150, 'cache fields must not be folded into the sum');
});

test('countWindowTokens sums multiple rows for the same ticket and ignores a different ticket', async () => {
  const t1 = await makeTicket(null);
  const t2 = await makeTicket(null);
  const since = new Date(Date.now() - 1000);
  await seedSubagent(t1.id, { input_tokens: 10, output_tokens: 5 });
  await seedSubagent(t1.id, { input_tokens: 20, output_tokens: 15 });
  await seedSubagent(t2.id, { input_tokens: 1000, output_tokens: 1000 });
  assert.equal(await countWindowTokens(ds, t1.id, since), 50);
});

test('countWindowTokens: an uninstrumented row (NULL usage columns, e.g. Antigravity) contributes zero, not an error', async () => {
  const t = await makeTicket(null);
  const since = new Date(Date.now() - 1000);
  await seedSubagent(t.id, { input_tokens: null, output_tokens: null });
  await seedSubagent(t.id, { input_tokens: 40, output_tokens: 10 });
  assert.equal(await countWindowTokens(ds, t.id, since), 50);
});

test('countWindowTokens: a future `since` sees nothing yet; a ticket with zero subagent rows returns 0', async () => {
  const t = await makeTicket(null);
  await seedSubagent(t.id, { input_tokens: 100, output_tokens: 100 });
  assert.equal(await countWindowTokens(ds, t.id, new Date(Date.now() + 60_000)), 0);

  const bare = await makeTicket(null);
  assert.equal(await countWindowTokens(ds, bare.id, new Date(0)), 0);
});

test('pendTicketForHardBudget: CAS is idempotent — concurrent breaches pend exactly once', async () => {
  const t = await makeTicket(null);
  const before = await activityRepo.count({ where: { ticket_id: t.id, field_changed: 'pending_user_action' } });
  const results = await Promise.all([
    pendTicketForHardBudget(ds, activityService, t, 'r1', 'test_guard'),
    pendTicketForHardBudget(ds, activityService, t, 'r2', 'test_guard'),
  ]);
  assert.deepEqual(results.sort(), [false, true], 'exactly one of the two racing calls wins the CAS');
  const after = await activityRepo.count({ where: { ticket_id: t.id, field_changed: 'pending_user_action' } });
  assert.equal(after - before, 1, 'exactly one audit row — no duplicate pend logging');
  const reloaded = await ticketRepo.findOne({ where: { id: t.id } });
  assert.equal(reloaded.pending_user_action, true);
});

// ── Terminal-aware pend gate (ticket ec498050) ──────────────────────────────
// A ticket already in a terminal (Done) column is never revisited by a human
// — pending it just strands it. The hard-budget ceiling can legitimately trip
// on a Done ticket (e.g. a post-Done self-improvement retrospective posting
// repeated agent comments), so this guard needed the same terminal check as
// the agent-comment-pingpong guard (ticket 0709ea7c's root cause).

test('pendTicketForHardBudget: a terminal-column ticket is NOT pended — the CAS never runs', async () => {
  const board = await makeBoard();
  const doneCol = await makeDoneColumn(board);
  const t = await makeTicket(doneCol);
  const before = await activityRepo.count({ where: { ticket_id: t.id, field_changed: 'pending_user_action' } });

  const result = await pendTicketForHardBudget(ds, activityService, t, 'ceiling breached', 'test_guard');
  assert.equal(result, false, 'a terminal ticket must report it did NOT pend');

  const after = await activityRepo.count({ where: { ticket_id: t.id, field_changed: 'pending_user_action' } });
  assert.equal(after, before, 'no audit row for a skipped terminal pend');
  const reloaded = await ticketRepo.findOne({ where: { id: t.id } });
  assert.equal(reloaded.pending_user_action, false);
});

test('enforceAutoResponseBudget: over the cap on a Done ticket blocks the comment but does NOT pend it', async () => {
  const board = await makeBoard(JSON.stringify({ max_auto_responses: 2, notify: false }));
  const doneCol = await makeDoneColumn(board);
  const t = await makeTicket(doneCol);
  await addAgentComment(t.id);
  await addAgentComment(t.id);

  const result = await enforceAutoResponseBudget(deps, t);
  assert.equal(result.blocked, true, 'the ceiling itself still fires — the block on repeated agent comments is unrelated to terminal state');
  assert.equal(result.reason, 'max_auto_responses_exceeded');

  const reloaded = await ticketRepo.findOne({ where: { id: t.id } });
  assert.equal(reloaded.pending_user_action, false, 'blocked but NOT pended, because the ticket is terminal');
});

test('enforceAutoResponseBudget: under the cap does not block', async () => {
  const board = await makeBoard(JSON.stringify({ max_auto_responses: 5 }));
  const col = await makeColumn(board);
  const t = await makeTicket(col);
  for (let i = 0; i < 4; i++) await addAgentComment(t.id);
  const result = await enforceAutoResponseBudget(deps, t);
  assert.equal(result.blocked, false);
  const reloaded = await ticketRepo.findOne({ where: { id: t.id } });
  assert.equal(reloaded.pending_user_action, false);
});

test('enforceAutoResponseBudget: at/over the cap blocks and auto-pends (board override, not the 100 default)', async () => {
  const board = await makeBoard(JSON.stringify({ max_auto_responses: 3, notify: false }));
  const col = await makeColumn(board);
  const t = await makeTicket(col);
  for (let i = 0; i < 3; i++) await addAgentComment(t.id);

  const result = await enforceAutoResponseBudget(deps, t);
  assert.equal(result.blocked, true);
  assert.equal(result.reason, 'max_auto_responses_exceeded');

  const reloaded = await ticketRepo.findOne({ where: { id: t.id } });
  assert.equal(reloaded.pending_user_action, true);
  assert.ok(reloaded.pending_reason.includes('하드 상한'));

  const pendRows = await activityRepo.count({
    where: { ticket_id: t.id, field_changed: 'pending_user_action', new_value: 'true' },
  });
  assert.equal(pendRows, 1);
});

test('enforceAutoResponseBudget: enabled=false never blocks regardless of count', async () => {
  const board = await makeBoard(JSON.stringify({ max_auto_responses: 1, enabled: false }));
  const col = await makeColumn(board);
  const t = await makeTicket(col);
  for (let i = 0; i < 5; i++) await addAgentComment(t.id);
  const result = await enforceAutoResponseBudget(deps, t);
  assert.equal(result.blocked, false);
});

// ── THE regression: epoch reset on human unpend (Planner decision #4) ──────
test('enforceAutoResponseBudget: a human unpend actually clears the ceiling — no permanent-death loop', async () => {
  const board = await makeBoard(JSON.stringify({ max_auto_responses: 2, notify: false }));
  const col = await makeColumn(board);
  const t = await makeTicket(col);
  await addAgentComment(t.id);
  await addAgentComment(t.id);

  // First breach: blocks + auto-pends.
  const first = await enforceAutoResponseBudget(deps, t);
  assert.equal(first.blocked, true);
  let reloaded = await ticketRepo.findOne({ where: { id: t.id } });
  assert.equal(reloaded.pending_user_action, true);

  // A human clears it via the REST PATCH path — same activity row shape
  // tickets.controller.ts leaves (field_changed='pending_user_action', new_value='false').
  await ticketRepo.update({ id: t.id }, { pending_user_action: false, pending_reason: '', pending_set_at: null, pending_set_by: '' });
  await recordHumanUnpend(t.id);
  reloaded = await ticketRepo.findOne({ where: { id: t.id } });
  assert.equal(reloaded.pending_user_action, false);

  // The SAME 2 old comments are still in the table (nothing deletes them) —
  // a naive lifetime COUNT would see 2 >= 2 and immediately re-pend. The
  // epoch anchor must exclude them (they predate the unpend) and let the
  // ticket breathe.
  const second = await enforceAutoResponseBudget(deps, reloaded);
  assert.equal(second.blocked, false, 'must NOT immediately re-trip — this is the permanent-death bug the Planner flagged');
  reloaded = await ticketRepo.findOne({ where: { id: t.id } });
  assert.equal(reloaded.pending_user_action, false, 'stays cleared');

  // And the ceiling is still live going forward: two MORE agent comments
  // after the unpend epoch re-trips it.
  //
  // sql.js stores `created_at` without sub-second precision ('...:55', no
  // milliseconds) but binds a Date query parameter WITH milliseconds
  // ('...:55.000') — a same-second stored row is then a lexicographic PREFIX
  // of the bound parameter, so `created_at >= :since` treats it as "before".
  // This is a sql.js/dev-only artifact (Postgres — the actual production DB
  // — has no such mismatch). Investigated in ticket 8fc94adf: this same-
  // second EXCLUSION is actually load-bearing for THIS epoch-anchored
  // ceiling (it guarantees pre-unpend comments never leak into the
  // post-unpend count — see hard-budget-guard.ts's doc comments on
  // countAutoResponses/countWindowDispatches) and is deliberately left as-is
  // rather than "fixed" to be same-second-inclusive. It means a same-second
  // comparison in THIS test would be racing the artifact rather than testing
  // the epoch logic. Cross a full second boundary first so the assertion is
  // deterministic.
  await new Promise((resolve) => setTimeout(resolve, 1100));
  await addAgentComment(t.id);
  await addAgentComment(t.id);
  const third = await enforceAutoResponseBudget(deps, reloaded);
  assert.equal(third.blocked, true, 'the ceiling still works AFTER the epoch reset — this is not a permanent bypass either');
});

test('enforceAutoResponseBudget: fails open (never blocks) when the ticket carries no resolvable board', async () => {
  // No column_id at all — resolveTicketBoardId returns null, config falls
  // back to the env baseline (max_auto_responses=100 by default), well
  // above this test's comment count.
  const t = await makeTicket(null);
  await addAgentComment(t.id);
  const result = await enforceAutoResponseBudget(deps, t);
  assert.equal(result.blocked, false);
});

// ── Workspace layer (ticket a51ec6d9) — resolveHardBudgetForTicket now
// inserts Workspace.hard_budget_config as a middle layer in the existing
// board→env chain. These pin: (1) a boardless ticket (the ActionRun/
// OrchestrationMission shape) still gets a workspace override, (2) the board
// still wins per-key over the workspace, and (3) an unset/unresolvable
// workspace changes nothing — the exact prior board→env behavior every test
// above this section already exercises.
test('resolveHardBudgetForTicket: a workspace override applies even with no board (boardless ticket, mirrors ActionRun/OrchestrationMission scope)', async () => {
  const ws = await makeWorkspace(JSON.stringify({ max_auto_responses: 7 }));
  const t = await makeTicket(null, { workspace_id: ws.id });
  const resolved = await resolveHardBudgetForTicket(ds, t);
  assert.equal(resolved.maxAutoResponses, 7);
});

test('resolveHardBudgetForTicket: board wins over workspace per key; workspace fills the keys the board leaves unset', async () => {
  const ws = await makeWorkspace(JSON.stringify({ max_auto_responses: 55, notify: true }));
  const board = await makeBoard(JSON.stringify({ notify: false }));
  const col = await makeColumn(board);
  const t = await makeTicket(col, { workspace_id: ws.id });
  const resolved = await resolveHardBudgetForTicket(ds, t);
  assert.equal(resolved.notify, false, 'board explicitly sets notify — board wins over the workspace value');
  assert.equal(resolved.maxAutoResponses, 55, 'board leaves max_auto_responses unset — inherits from the workspace layer');
});

test('resolveHardBudgetForTicket: an unresolvable workspace id keeps the exact prior board→env behavior (regression safety)', async () => {
  const board = await makeBoard(JSON.stringify({ max_auto_responses: 42 }));
  const col = await makeColumn(board);
  const t = await makeTicket(col, { workspace_id: 'nonexistent-ws' });
  const resolved = await resolveHardBudgetForTicket(ds, t);
  assert.equal(resolved.maxAutoResponses, 42, 'the board override still applies unchanged when the workspace layer resolves to nothing');
});
