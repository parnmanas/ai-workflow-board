// Prompt-audit effect measurement — formula regression guard (ticket ec498050,
// Planner decision Q3: "산식은 후속 티켓이 그대로 재실행할 수 있게 스크립트에
// 고정하세요"). This test pins the exact arithmetic `computeReport()` in
// `scripts/measure-prompt-audit-effect.mjs` uses, against a small hand-built
// fixture where every metric's expected numerator/denominator is known by
// construction — so a future edit to the formula (by this ticket's follow-up,
// f3fc298a) can't silently drift without a red test.
//
// Runs against compiled dist/ (requires `npm run build`) with a REAL sql.js
// DataSource, same pattern as hard-budget-guard.test.mjs. Isolated
// SQLJS_DB_PATH temp file.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(__dirname, '..', 'dist');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awb-prompt-audit-measure-'));
process.env.DB_TYPE = 'sqlite';
process.env.SQLJS_DB_PATH = path.join(tmpDir, 'measure-test.db');
process.env.NODE_ENV = 'test';

const { buildDataSourceOptions } = await import('file://' + path.join(DIST, 'db.js'));
const { DataSource } = await import('typeorm');
const { Board } = await import('file://' + path.join(DIST, 'entities', 'Board.js'));
const { BoardColumn } = await import('file://' + path.join(DIST, 'entities', 'BoardColumn.js'));
const { Ticket } = await import('file://' + path.join(DIST, 'entities', 'Ticket.js'));
const { Comment } = await import('file://' + path.join(DIST, 'entities', 'Comment.js'));
const { ActivityLog } = await import('file://' + path.join(DIST, 'entities', 'ActivityLog.js'));
const { Workspace } = await import('file://' + path.join(DIST, 'entities', 'Workspace.js'));
const { computeReport } = await import('file://' + path.resolve(__dirname, '..', 'scripts', 'measure-prompt-audit-effect.mjs'));

const ds = new DataSource(buildDataSourceOptions());
await ds.initialize();

const workspaceRepo = ds.getRepository(Workspace);
const boardRepo = ds.getRepository(Board);
const colRepo = ds.getRepository(BoardColumn);
const ticketRepo = ds.getRepository(Ticket);
const commentRepo = ds.getRepository(Comment);
const activityRepo = ds.getRepository(ActivityLog);

after(async () => {
  await ds.destroy();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('computeReport: all 4 metrics match a hand-built fixture with known numerators/denominators', async () => {
  const inWindow = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000);

  // board.workspace_id (not just ticket.workspace_id) must be set to wsId —
  // computeReport() scopes BoardColumn lookups through Board.workspace_id
  // (BoardColumn itself has no reliable own workspace_id), matching real
  // columns.controller.ts-created boards/columns. Board.workspace_id is a
  // real FK to Workspace, unlike Ticket.workspace_id, so a real Workspace
  // row is required here.
  const workspace = await workspaceRepo.save(workspaceRepo.create({ name: 'MeasureFixtureWorkspace' }));
  const wsId = workspace.id;
  const board = await boardRepo.save(boardRepo.create({ name: 'MeasureFixture', workspace_id: wsId }));
  const active = await colRepo.save(colRepo.create({ board_id: board.id, name: 'In Progress', position: 3, kind: 'active' }));
  const review = await colRepo.save(colRepo.create({ board_id: board.id, name: 'Review', position: 4, kind: 'review' }));
  const done = await colRepo.save(colRepo.create({ board_id: board.id, name: 'Done', position: 6, kind: 'terminal', is_terminal: true }));

  // start_rate: A enters active then advances to review (counts both);
  // B enters active and never advances (denominator only).
  // NOTE: ticket-move.ts's real logActivity() writes the COLUMN NAME into
  // old/new_value, not the column id — the fixture must match that shape or
  // it silently tests nothing (caught the hard way: an id-based fixture here
  // made this test pass against a script that could never match production
  // data, until this comment's history was fixed alongside the script).
  const tA = await ticketRepo.save(ticketRepo.create({ title: 'A', column_id: review.id, workspace_id: wsId, created_at: inWindow }));
  await activityRepo.save(activityRepo.create({
    entity_type: 'ticket', entity_id: tA.id, ticket_id: tA.id, action: 'moved', field_changed: 'column',
    old_value: '', new_value: active.name, actor_id: 'system', actor_name: 'test', created_at: inWindow,
  }));
  await activityRepo.save(activityRepo.create({
    entity_type: 'ticket', entity_id: tA.id, ticket_id: tA.id, action: 'moved', field_changed: 'column',
    old_value: active.name, new_value: review.name, actor_id: 'system', actor_name: 'test', created_at: inWindow,
  }));
  const tB = await ticketRepo.save(ticketRepo.create({ title: 'B', column_id: active.id, workspace_id: wsId, created_at: inWindow }));
  await activityRepo.save(activityRepo.create({
    entity_type: 'ticket', entity_id: tB.id, ticket_id: tB.id, action: 'moved', field_changed: 'column',
    old_value: '', new_value: active.name, actor_id: 'system', actor_name: 'test', created_at: inWindow,
  }));

  // unnecessary_questions: exactly 2 agent question comments.
  await commentRepo.save(commentRepo.create({ ticket_id: tA.id, author_type: 'agent', author: 'x', content: 'q1?', type: 'question', created_at: inWindow }));
  await commentRepo.save(commentRepo.create({ ticket_id: tB.id, author_type: 'agent', author: 'x', content: 'q2?', type: 'question', created_at: inWindow }));
  // A non-question, non-agent comment must NOT be counted.
  await commentRepo.save(commentRepo.create({ ticket_id: tA.id, author_type: 'user', author: 'h', content: 'not a question', type: 'note', created_at: inWindow }));

  // pending_misclassification_rate: C is terminal BEFORE its pend event (misclassified,
  // the exact 0709ea7c shape); D is pended while non-terminal (correctly NOT counted).
  const pendTime = new Date(inWindow.getTime() + 60_000);
  const tC = await ticketRepo.save(ticketRepo.create({
    title: 'C', column_id: done.id, workspace_id: wsId, created_at: inWindow,
    terminal_entered_at: inWindow, pending_user_action: true,
  }));
  await activityRepo.save(activityRepo.create({
    entity_type: 'ticket', entity_id: tC.id, ticket_id: tC.id, action: 'updated', field_changed: 'pending_user_action',
    old_value: 'false', new_value: 'true', actor_id: 'system', actor_name: 'test', created_at: pendTime,
  }));
  const tD = await ticketRepo.save(ticketRepo.create({ title: 'D', column_id: active.id, workspace_id: wsId, created_at: inWindow, pending_user_action: true }));
  await activityRepo.save(activityRepo.create({
    entity_type: 'ticket', entity_id: tD.id, ticket_id: tD.id, action: 'updated', field_changed: 'pending_user_action',
    old_value: 'false', new_value: 'true', actor_id: 'system', actor_name: 'test', created_at: pendTime,
  }));
  // A pending_user_action FALSE transition must not count as a pend event.
  await activityRepo.save(activityRepo.create({
    entity_type: 'ticket', entity_id: tD.id, ticket_id: tD.id, action: 'updated', field_changed: 'pending_user_action',
    old_value: 'true', new_value: 'false', actor_id: 'human1', actor_name: 'Human', created_at: pendTime,
  }));

  // start_rate event-ordering regression (ec498050 review, changes-requested):
  // H moves to Review at t0, then bounces BACK to In Progress at t1 (t1 > t0)
  // — a changes-requested rework re-entry, with no forward progress after
  // that. H must count toward entered_active (it does enter an active column
  // in-window) but NOT toward also_advanced — its only forward move (t0) is
  // BEFORE its active entry (t1), not after. The old set-intersection logic
  // (ignoring event order) wrongly counted this as "advanced".
  const t0 = new Date(inWindow.getTime() + 500);
  const t1 = new Date(inWindow.getTime() + 2000);
  const tH = await ticketRepo.save(ticketRepo.create({ title: 'H', column_id: active.id, workspace_id: wsId, created_at: inWindow }));
  await activityRepo.save(activityRepo.create({
    entity_type: 'ticket', entity_id: tH.id, ticket_id: tH.id, action: 'moved', field_changed: 'column',
    old_value: active.name, new_value: review.name, actor_id: 'system', actor_name: 'test', created_at: t0,
  }));
  await activityRepo.save(activityRepo.create({
    entity_type: 'ticket', entity_id: tH.id, ticket_id: tH.id, action: 'moved', field_changed: 'column',
    old_value: review.name, new_value: active.name, actor_id: 'system', actor_name: 'test', created_at: t1,
  }));

  // completion_rate: E created in-window and terminal (counted); F created
  // in-window and NOT terminal (denominator only).
  await ticketRepo.save(ticketRepo.create({ title: 'E', column_id: done.id, workspace_id: wsId, created_at: inWindow, terminal_entered_at: inWindow }));
  await ticketRepo.save(ticketRepo.create({ title: 'F', column_id: active.id, workspace_id: wsId, created_at: inWindow }));
  // A ticket created OUTSIDE the window must not count.
  const longAgo = new Date(inWindow.getTime() - 100 * 24 * 60 * 60 * 1000);
  await ticketRepo.save(ticketRepo.create({ title: 'OldG', column_id: done.id, workspace_id: wsId, created_at: longAgo, terminal_entered_at: longAgo }));

  const since = new Date(inWindow.getTime() - 24 * 60 * 60 * 1000);
  const until = new Date(inWindow.getTime() + 24 * 60 * 60 * 1000);
  const report = await computeReport(ds, { ActivityLog, Comment, Ticket, BoardColumn, Board }, { since, until, workspaceId: wsId });

  assert.deepEqual(
    report.start_rate, { entered_active: 3, also_advanced: 1, rate: 1 / 3 },
    'start_rate: A advanced after entering active, B never advanced, H bounced back into active AFTER an earlier forward move — 1/3',
  );
  assert.equal(report.unnecessary_questions, 2, 'unnecessary_questions: exactly the 2 agent question comments, not the user note');
  assert.deepEqual(
    report.pending_misclassification_rate, { pend_events: 2, misclassified: 1, rate: 0.5 },
    'pending_misclassification_rate: only C (terminal before pend) counts, D (non-terminal) and the false-transition do not',
  );
  assert.deepEqual(
    report.completion_rate, { created: 7, completed: 2, rate: 2 / 7 },
    'completion_rate: 7 in-window root tickets (A,B,C,D,E,F,H), 2 terminal (C,E) — OldG excluded by window',
  );
  assert.equal(report.window.since, since.toISOString());
  assert.equal(report.window.until, until.toISOString());
  assert.equal(report.workspace_id, wsId);
});

test('computeReport: empty window returns zero counts and null rates (no crash on zero denominators)', async () => {
  const since = new Date('2020-01-01T00:00:00Z');
  const until = new Date('2020-01-02T00:00:00Z');
  const report = await computeReport(ds, { ActivityLog, Comment, Ticket, BoardColumn, Board }, { since, until, workspaceId: `empty-${Date.now()}` });
  assert.deepEqual(report.start_rate, { entered_active: 0, also_advanced: 0, rate: null });
  assert.equal(report.unnecessary_questions, 0);
  assert.deepEqual(report.pending_misclassification_rate, { pend_events: 0, misclassified: 0, rate: null });
  assert.deepEqual(report.completion_rate, { created: 0, completed: 0, rate: null });
});

test('computeReport: default window is [now-30d, now) when since/until are omitted', async () => {
  const before = Date.now();
  const report = await computeReport(ds, { ActivityLog, Comment, Ticket, BoardColumn, Board }, { workspaceId: `defaultwindow-${before}` });
  const untilMs = new Date(report.window.until).getTime();
  const sinceMs = new Date(report.window.since).getTime();
  assert.ok(untilMs - before < 5000, 'until defaults to ~now');
  assert.equal(untilMs - sinceMs, 30 * 24 * 60 * 60 * 1000, 'since defaults to exactly 30 days before until');
});

test('computeReport: maturationBufferHours excludes tickets that had no time to mature from completion_rate (right-censoring mitigation, ticket c936cee7)', async () => {
  const workspace = await workspaceRepo.save(workspaceRepo.create({ name: 'MaturationFixtureWorkspace' }));
  const wsId = workspace.id;
  const board = await boardRepo.save(boardRepo.create({ name: 'MaturationFixture', workspace_id: wsId }));
  const active = await colRepo.save(colRepo.create({ board_id: board.id, name: 'In Progress', position: 0, kind: 'active' }));
  const done = await colRepo.save(colRepo.create({ board_id: board.id, name: 'Done', position: 1, kind: 'terminal', is_terminal: true }));

  const until = new Date();
  const since = new Date(until.getTime() - 72 * 60 * 60 * 1000);

  // X: created 10h before `until` — under a 24h buffer, must be excluded
  // from both created and completed regardless of its own terminal state.
  await ticketRepo.save(ticketRepo.create({
    title: 'X', column_id: active.id, workspace_id: wsId,
    created_at: new Date(until.getTime() - 10 * 60 * 60 * 1000),
  }));
  // Y: created 48h before `until`, terminal — matured, counts as completed.
  await ticketRepo.save(ticketRepo.create({
    title: 'Y', column_id: done.id, workspace_id: wsId,
    created_at: new Date(until.getTime() - 48 * 60 * 60 * 1000),
    terminal_entered_at: new Date(until.getTime() - 47 * 60 * 60 * 1000),
  }));
  // Z: created 48h before `until`, NOT terminal — matured, counts as incomplete.
  await ticketRepo.save(ticketRepo.create({
    title: 'Z', column_id: active.id, workspace_id: wsId,
    created_at: new Date(until.getTime() - 48 * 60 * 60 * 1000),
  }));

  const unbuffered = await computeReport(ds, { ActivityLog, Comment, Ticket, BoardColumn, Board }, { since, until, workspaceId: wsId });
  assert.deepEqual(
    unbuffered.completion_rate, { created: 3, completed: 1, rate: 1 / 3 },
    'without a buffer, X counts in the denominator despite having had almost no time to complete (the bias this ticket documents)',
  );

  const buffered = await computeReport(ds, { ActivityLog, Comment, Ticket, BoardColumn, Board }, { since, until, workspaceId: wsId, maturationBufferHours: 24 });
  assert.deepEqual(
    buffered.completion_rate, { created: 2, completed: 1, rate: 0.5, excluded_for_maturation: 1 },
    'a 24h buffer excludes X (created 10h before until) but keeps Y and Z (created 48h before until)',
  );
});

test('computeReport: maturationBufferHours boundary rejects negative/non-finite/out-of-range values instead of silently corrupting completion_rate (ticket c936cee7 review blocker)', async () => {
  const since = new Date('2020-01-01T00:00:00Z');
  const until = new Date('2020-01-02T00:00:00Z');
  const wsId = `maturation-guard-${Date.now()}`;
  const call = (maturationBufferHours) =>
    computeReport(ds, { ActivityLog, Comment, Ticket, BoardColumn, Board }, { since, until, workspaceId: wsId, maturationBufferHours });

  // Negative: must be rejected, not silently clamped to 0 (the previous
  // Math.max(0, x) behavior masked caller bugs instead of surfacing them).
  await assert.rejects(() => call(-1), /must be a finite number >= 0/);

  // NaN / Infinity: Math.max(0, NaN) === NaN and untilResolved - Infinity ===
  // -Infinity, both of which used to build `new Date(NaN)` — an Invalid Date
  // cutoff that fails every `<` comparison, silently excluding ALL tickets
  // from the denominator instead of erroring.
  await assert.rejects(() => call(NaN), /must be a finite number >= 0/);
  await assert.rejects(() => call(Infinity), /must be a finite number >= 0/);

  // Number.MAX_VALUE: finite and >= 0, but `* 60 * 60 * 1000` overflows to
  // Infinity and pushes the cutoff outside the representable Date range —
  // must be rejected explicitly rather than producing another Invalid Date.
  await assert.rejects(() => call(Number.MAX_VALUE), /out-of-range cutoff date/);

  // A large but still in-range buffer must continue to work normally (not
  // over-rejected by the range guard).
  const report = await call(24);
  assert.deepEqual(report.completion_rate, { created: 0, completed: 0, rate: null, excluded_for_maturation: 0 });
});
