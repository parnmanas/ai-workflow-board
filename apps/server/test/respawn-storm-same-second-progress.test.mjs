// RespawnStormDetectorService forward-progress veto — sql.js same-second
// precision fix (ticket 8fc94adf, follow-up to a940d75b/50b92d71).
//
// `_hasForwardProgress`/`_recentActivityExists` compare `created_at >=
// :since` against Comment/ActivityLog rows exactly like
// hard-budget-guard.ts's countAutoResponses/countWindowDispatches (see
// hard-budget-guard.test.mjs's same-second regression test for the shared
// root cause: sqlite's DB-level `datetime('now')` default has no fractional
// seconds, but TypeORM always formats a bound Date parameter WITH
// milliseconds, so a same-second row was silently excluded by a
// lexicographic string-prefix mismatch).
//
// For THIS detector the failure direction is worse than hard-budget's: a
// forward-progress comment landing in the exact same wall-clock second as
// the window boundary being silently excluded means the veto fails to fire
// and a genuinely-progressing ticket gets auto-pended by a false storm halt.
// This test constructs that exact boundary deterministically (windowStart is
// set to the comment's own stored timestamp, not derived from a real-time
// sleep) and asserts the veto fires.
//
// Runs against compiled dist/ (requires `npm run build`) with a REAL sql.js
// DataSource, instantiating RespawnStormDetectorService directly (bypassing
// Nest DI, same pattern hard-budget-guard.test.mjs uses for ActivityService)
// with notify:false so RoomMessagingService is never touched and a stub
// suffices. Uses an isolated SQLJS_DB_PATH temp file.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(__dirname, '..', 'dist');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awb-respawn-storm-same-second-'));
process.env.DB_TYPE = 'sqlite';
process.env.SQLJS_DB_PATH = path.join(tmpDir, 'respawn-storm-same-second-test.db');
process.env.NODE_ENV = 'test';

const { buildDataSourceOptions } = await import('file://' + path.join(DIST, 'db.js'));
const { DataSource } = await import('typeorm');
const { Board } = await import('file://' + path.join(DIST, 'entities', 'Board.js'));
const { BoardColumn } = await import('file://' + path.join(DIST, 'entities', 'BoardColumn.js'));
const { Ticket } = await import('file://' + path.join(DIST, 'entities', 'Ticket.js'));
const { Comment } = await import('file://' + path.join(DIST, 'entities', 'Comment.js'));
const { ActivityLog } = await import('file://' + path.join(DIST, 'entities', 'ActivityLog.js'));
const { Agent } = await import('file://' + path.join(DIST, 'entities', 'Agent.js'));
const { Subagent } = await import('file://' + path.join(DIST, 'entities', 'Subagent.js'));
const { ActivityService } = await import('file://' + path.join(DIST, 'services', 'activity.service.js'));
const { RespawnStormDetectorService } = await import('file://' + path.join(DIST, 'modules', 'agents', 'respawn-storm-detector.service.js'));

const ds = new DataSource(buildDataSourceOptions());
await ds.initialize();

const logStub = { warn() {}, info() {}, error() {}, debug() {} };
const activityService = new ActivityService(ds.getRepository(ActivityLog), ds.getRepository(Agent), logStub);
const messagingStub = {}; // notify:false below — sendSystemMessage must never be called

const boardRepo = ds.getRepository(Board);
const colRepo = ds.getRepository(BoardColumn);
const ticketRepo = ds.getRepository(Ticket);
const commentRepo = ds.getRepository(Comment);
const subRepo = ds.getRepository(Subagent);

let subCounter = 0;
async function seedQuickDeath(ticketId, role, when) {
  subCounter += 1;
  return subRepo.save(subRepo.create({
    subagent_id: `sub-fixture-${subCounter}`, agent_id: 'agent-fixture', workspace_id: 'w1',
    kind: 'ticket', session_key: `${ticketId}:${role}`, pid: 1000 + subCounter,
    started_at: when, ticket_id: ticketId, ticket_title: 'T', role,
    ended_at: when, exit_code: 1, signal: null, duration_ms: 100, line_count: 0,
  }));
}

after(async () => {
  await ds.destroy();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('forward-progress veto includes a comment created in the same wall-clock second as the window start', async () => {
  const board = await boardRepo.save(boardRepo.create({
    name: 'B', respawn_storm_config: JSON.stringify({
      window_minutes: 5, min_deaths: 2, quick_death_seconds: 60,
      auto_pend: true, notify: false, detect_twins: false,
    }),
  }));
  const col = await colRepo.save(colRepo.create({ board_id: board.id, name: 'In Progress', position: 1 }));
  const t = await ticketRepo.save(ticketRepo.create({
    title: 'T', column_id: col.id, workspace_id: 'w1', pending_user_action: false,
  }));

  // Fresh forward-progress comment — created_at comes from sqlite's DB-level
  // default (no milliseconds), same as every other Comment row.
  const saved = await commentRepo.save(commentRepo.create({
    ticket_id: t.id, author_type: 'agent', author: 'A', content: 'progress note', type: 'note',
  }));
  const reloadedComment = await commentRepo.findOne({ where: { id: saved.id } });

  // Deterministically place the window boundary AT the comment's own stored
  // instant (not derived from a real-time sleep): windowStart = now -
  // windowMs, so now = comment.created_at + windowMs makes windowStart ===
  // comment.created_at exactly — the tightest possible same-second case.
  const windowMs = 5 * 60_000;
  const now = new Date(reloadedComment.created_at.getTime() + windowMs);
  const deathTime = new Date(now.getTime() - 1000);
  await seedQuickDeath(t.id, 'assignee', deathTime);
  await seedQuickDeath(t.id, 'assignee', deathTime);

  const service = new RespawnStormDetectorService(ds, logStub, activityService, messagingStub);
  const stats = await service.sweep(now);

  assert.equal(stats.storms_detected, 1, 'sanity: 2 quick abnormal deaths on (ticket,role) must be considered a storm candidate');
  assert.equal(stats.skipped_progress, 1, 'same-second comment must veto the halt, not be silently excluded');
  assert.equal(stats.storms_halted, 0);

  const reloadedTicket = await ticketRepo.findOne({ where: { id: t.id } });
  assert.equal(reloadedTicket.pending_user_action, false, 'must NOT be auto-pended — forward progress existed exactly at the window boundary');
});
