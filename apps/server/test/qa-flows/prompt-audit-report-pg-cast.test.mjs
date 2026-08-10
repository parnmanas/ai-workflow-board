// Regression (Postgres): computeReport() (apps/server/src/common/prompt-audit-report.ts)
// joins uuid PK columns (Board.id, Ticket.id) against varchar FK columns
// (BoardColumn.board_id, ActivityLog.ticket_id, Comment.ticket_id) with no
// cast. Postgres has no implicit uuid<->varchar cast and raises "operator
// does not exist: uuid = character varying" — exactly what production hit
// calling `prompt_audit.measure_effect` (ticket 55bcf89d, run_ids
// 07ac2bb0-b851-4c2e-b622-8ec2bc1fdcab / 9cd95754-6ab4-4a54-9ed5-6865ae259c2b).
// SQLite is loose-typed so the mismatch never reproduces there — the existing
// measure-prompt-audit-effect.test.mjs / workflow-functions.test.mjs suites
// (both sqljs-only) passed 12/12 while this was 100% broken on real Postgres.
//
// This seeds a small fixture and asserts computeReport() returns the CORRECT
// non-zero counts (not just "doesn't throw") against a real Postgres
// connection — a cast applied on the wrong side of a join can silently
// return zero rows instead of erroring, which a throw-only assertion would
// miss.
//
// SKIP semantics: runs only when DB_TYPE=postgres (the CI `test:qa:pg`
// matrix — see .github/workflows/ci.yml's postgres-dialect-matrix job).
// Self-skips everywhere else, same pattern as
// qa-flows/dispatch-intent-pg-race.test.mjs. This sandbox has no
// docker/psql/postgres binary (checked) — matching every prior instance of
// this exact bug class (18396acd, 5cca3ec0) — verified here to load + self-
// skip cleanly; the live-Postgres green must come from the CI pg matrix
// after this branch lands on main.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(__dirname, '..', '..', 'dist');

const IS_PG = (process.env.DB_TYPE || 'sqlite') === 'postgres';
const SKIP = IS_PG ? false : 'requires DB_TYPE=postgres (CI test:qa:pg matrix only)';

// Isolated schema for this test process (mirrors helpers/boot.mjs /
// dispatch-intent-pg-race.test.mjs). Keyed on pid so a reused pid can't
// inherit stale tables. Only touched when IS_PG.
const SCHEMA = `qa_promptaudit_${process.pid}`;

let ds;

after(async () => {
  try { if (ds?.isInitialized) await ds.destroy(); } catch { /* best-effort */ }
  if (IS_PG) {
    try {
      const { Client } = await import('pg');
      const c = new Client({
        host: process.env.DB_HOST || 'localhost',
        port: parseInt(process.env.DB_PORT || '5432', 10),
        user: process.env.DB_USER || 'postgres',
        password: process.env.DB_PASS || '',
        database: process.env.DB_NAME || 'ai_workflow',
      });
      await c.connect();
      await c.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
      await c.end();
    } catch { /* best-effort cleanup */ }
  }
});

test('computeReport() joins uuid PK to varchar FK without crashing on real Postgres, and returns correct counts', { skip: SKIP }, async () => {
  if (!/^[a-z_][a-z0-9_]*$/i.test(SCHEMA)) throw new Error(`unsafe pg schema: ${SCHEMA}`);

  const { Client } = await import('pg');
  const adminClient = new Client({
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '5432', 10),
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASS || '',
    database: process.env.DB_NAME || 'ai_workflow',
  });
  await adminClient.connect();
  // TypeORM auto-installs uuid-ossp in the first schema on search_path — keep
  // it pinned to public so a later test process's disposable schema doesn't
  // strand the extension (mirrors helpers/boot.mjs's prepareIsolatedPgSchema).
  await adminClient.query('CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA public');
  await adminClient.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
  await adminClient.query(`CREATE SCHEMA "${SCHEMA}"`);
  await adminClient.end();

  process.env.DB_SCHEMA = SCHEMA;

  const { buildDataSourceOptions } = await import('file://' + path.join(DIST, 'db.js'));
  const entities = await import('file://' + path.join(DIST, 'entities', 'index.js'));
  const { computeReport } = await import('file://' + path.join(DIST, 'common', 'prompt-audit-report.js'));
  const { DataSource } = await import('typeorm');

  ds = new DataSource(buildDataSourceOptions());
  // synchronize — Board.id/Ticket.id land as real `uuid` columns, the FK
  // columns joined against them (board_id/ticket_id) as `varchar`, matching
  // production's exact type asymmetry (the bug this test guards against).
  await ds.initialize();

  const workspaceRepo = ds.getRepository(entities.Workspace);
  const boardRepo = ds.getRepository(entities.Board);
  const colRepo = ds.getRepository(entities.BoardColumn);
  const ticketRepo = ds.getRepository(entities.Ticket);
  const commentRepo = ds.getRepository(entities.Comment);
  const activityRepo = ds.getRepository(entities.ActivityLog);

  const workspace = await workspaceRepo.save(workspaceRepo.create({ name: 'PgCastFixtureWorkspace' }));
  const wsId = workspace.id;
  // board.workspace_id must be set — computeReport() scopes BoardColumn
  // lookups through Board.workspace_id (the join this test targets).
  const board = await boardRepo.save(boardRepo.create({ name: 'PgCastFixture', workspace_id: wsId }));
  const active = await colRepo.save(colRepo.create({ board_id: board.id, name: 'In Progress', position: 0, kind: 'active' }));
  const review = await colRepo.save(colRepo.create({ board_id: board.id, name: 'Review', position: 1, kind: 'review' }));
  const done = await colRepo.save(colRepo.create({ board_id: board.id, name: 'Done', position: 2, kind: 'terminal', is_terminal: true }));

  const inWindow = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000);

  // start_rate: A enters active then advances to review (counts both);
  // B enters active and never advances (denominator only).
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

  // unnecessary_questions: exactly 1 agent question comment (the user note must not count).
  await commentRepo.save(commentRepo.create({ ticket_id: tA.id, author_type: 'agent', author: 'x', content: 'q?', type: 'question', created_at: inWindow }));
  await commentRepo.save(commentRepo.create({ ticket_id: tA.id, author_type: 'user', author: 'h', content: 'not a question', type: 'note', created_at: inWindow }));

  // pending_misclassification_rate: C is terminal BEFORE its pend event (misclassified).
  const pendTime = new Date(inWindow.getTime() + 60_000);
  const tC = await ticketRepo.save(ticketRepo.create({
    title: 'C', column_id: done.id, workspace_id: wsId, created_at: inWindow,
    terminal_entered_at: inWindow, pending_user_action: true,
  }));
  await activityRepo.save(activityRepo.create({
    entity_type: 'ticket', entity_id: tC.id, ticket_id: tC.id, action: 'updated', field_changed: 'pending_user_action',
    old_value: 'false', new_value: 'true', actor_id: 'system', actor_name: 'test', created_at: pendTime,
  }));

  const since = new Date(inWindow.getTime() - 24 * 60 * 60 * 1000);
  const until = new Date(inWindow.getTime() + 24 * 60 * 60 * 1000);
  const report = await computeReport(ds, {
    ActivityLog: entities.ActivityLog, Comment: entities.Comment, Ticket: entities.Ticket,
    BoardColumn: entities.BoardColumn, Board: entities.Board,
  }, { since, until, workspaceId: wsId });

  assert.deepEqual(
    report.start_rate, { entered_active: 2, also_advanced: 1, rate: 0.5 },
    'start_rate join (Ticket.id::text = ActivityLog.ticket_id, Board.id::text = BoardColumn.board_id) matches real rows on Postgres',
  );
  assert.equal(report.unnecessary_questions, 1, 'unnecessary_questions join (Ticket.id::text = Comment.ticket_id) matches on Postgres');
  assert.deepEqual(
    report.pending_misclassification_rate, { pend_events: 1, misclassified: 1, rate: 1 },
    'pending_misclassification_rate join (Ticket.id::text = ActivityLog.ticket_id) matches on Postgres',
  );
  assert.deepEqual(
    report.completion_rate, { created: 3, completed: 1, rate: 1 / 3 },
    'completion_rate: A, B, C created in-window; only C terminal (no join involved, sanity cross-check)',
  );
});
