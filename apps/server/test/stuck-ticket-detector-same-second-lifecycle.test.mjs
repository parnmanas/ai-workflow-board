// StuckTicketDetectorService._countLifecycleEvents — sql.js same-second
// precision fix (ticket 7200396a, follow-up to 8fc94adf/873bf5f).
//
// `_countLifecycleEvents` compares `created_at >= :from` (and `<= :to`)
// against ActivityLog rows exactly like RespawnStormDetectorService's
// `_hasForwardProgress`/`_recentActivityExists` did before 873bf5f fixed them
// (see respawn-storm-same-second-progress.test.mjs for the shared root cause:
// sqlite's DB-level `datetime('now')` default has no fractional seconds, but
// TypeORM always formats a bound Date parameter WITH milliseconds, so a
// same-second row was silently excluded by a lexicographic string-prefix
// mismatch). This file's own inline `floorSec`/`ceilSec` pair looked like a
// fix but wasn't — both are no-ops on a DB-round-tripped Date (already
// whole-second), which is exactly what `fromTime`/`toTime` (Comment.created_at)
// always are here.
//
// Failure direction: a column-move/claim/release landing in the exact same
// wall-clock second as the oldest comment in the stale-WAIT window being
// silently excluded means `_evaluateTicket` never sees the intervening
// lifecycle event and flags a genuinely-progressing ticket as stale-WAIT — a
// false stuck alert. This test constructs that exact boundary deterministically
// (retries the lifecycle-event insert until it lands in the same wall-clock
// second as the oldest comment, rather than depending on a lucky race) and
// asserts the alert never fires.
//
// Runs against compiled dist/ (requires `npm run build`) with a REAL sql.js
// DataSource, instantiating StuckTicketDetectorService directly (bypassing
// Nest DI), same pattern respawn-storm-same-second-progress.test.mjs uses.
// Uses an isolated SQLJS_DB_PATH temp file.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(__dirname, '..', 'dist');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awb-stuck-detector-same-second-'));
process.env.DB_TYPE = 'sqlite';
process.env.SQLJS_DB_PATH = path.join(tmpDir, 'stuck-detector-same-second-test.db');
process.env.NODE_ENV = 'test';
// Shrink every threshold well below the real defaults (2h span/age) so the
// scenario needs only a single ~1.1s real sleep (to force the two comments
// into different wall-clock seconds) instead of hours of fixture time.
process.env.STUCK_DETECTOR_WINDOW = '2';
process.env.STUCK_DETECTOR_MIN_SPAN_MS = '1';
process.env.STUCK_DETECTOR_MIN_AGE_MS = '1';

const { buildDataSourceOptions } = await import('file://' + path.join(DIST, 'db.js'));
const { DataSource } = await import('typeorm');
const { Board } = await import('file://' + path.join(DIST, 'entities', 'Board.js'));
const { BoardColumn } = await import('file://' + path.join(DIST, 'entities', 'BoardColumn.js'));
const { Ticket } = await import('file://' + path.join(DIST, 'entities', 'Ticket.js'));
const { Comment } = await import('file://' + path.join(DIST, 'entities', 'Comment.js'));
const { ActivityLog } = await import('file://' + path.join(DIST, 'entities', 'ActivityLog.js'));
const { Agent } = await import('file://' + path.join(DIST, 'entities', 'Agent.js'));
const { StuckTicketAlert } = await import('file://' + path.join(DIST, 'entities', 'StuckTicketAlert.js'));
const { ActivityService } = await import('file://' + path.join(DIST, 'services', 'activity.service.js'));
const { StuckTicketDetectorService } = await import('file://' + path.join(DIST, 'modules', 'agents', 'stuck-ticket-detector.service.js'));

const ds = new DataSource(buildDataSourceOptions());
await ds.initialize();

const logStub = { warn() {}, info() {}, error() {}, debug() {} };
const activityService = new ActivityService(ds.getRepository(ActivityLog), ds.getRepository(Agent), logStub);
const messagingStub = {}; // unreached in this scenario — no alert should ever be posted
const policiesStub = {};  // unreached — only used by the (unreached) policy-violation escalation

const boardRepo = ds.getRepository(Board);
const colRepo = ds.getRepository(BoardColumn);
const ticketRepo = ds.getRepository(Ticket);
const commentRepo = ds.getRepository(Comment);
const activityRepo = ds.getRepository(ActivityLog);
const alertRepo = ds.getRepository(StuckTicketAlert);

after(async () => {
  await ds.destroy();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// Repeatedly re-insert an ActivityLog row (relying on sqlite's DB-level
// `datetime('now')` default, same as production — created_at is never set
// explicitly) until it lands in the same wall-clock second as `targetMs`.
// sql.js's 1-second clock resolution means two back-to-back inserts land in
// the same second the vast majority of the time; retrying instead of
// sleeping keeps the test fast while staying fully deterministic (bounded
// attempts, no arbitrary wait).
async function insertActivityAlignedTo(fields, targetMs, maxAttempts = 50) {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const saved = await activityRepo.save(activityRepo.create(fields));
    const reloaded = await activityRepo.findOne({ where: { id: saved.id } });
    if (reloaded.created_at.getTime() === targetMs) return reloaded;
    await activityRepo.delete({ id: saved.id });
  }
  throw new Error(`failed to align activity insert to target second within ${maxAttempts} attempts`);
}

test('stale-WAIT candidate with a column move in the same wall-clock second as the oldest comment is not falsely flagged', async () => {
  const board = await boardRepo.save(boardRepo.create({ name: 'B' }));
  const col = await colRepo.save(colRepo.create({
    board_id: board.id, name: 'In Progress', position: 1, kind: 'active',
  }));
  const t = await ticketRepo.save(ticketRepo.create({
    title: 'T', column_id: col.id, workspace_id: 'w1', pending_user_action: false,
  }));

  // Oldest comment of the stale-WAIT window — DB-default created_at (no ms).
  const oldestSaved = await commentRepo.save(commentRepo.create({
    ticket_id: t.id, author_type: 'agent', author: 'A', content: 'update 1', type: 'note',
  }));
  const oldest = await commentRepo.findOne({ where: { id: oldestSaved.id } });

  // A column-move activity row landing in the EXACT SAME wall-clock second as
  // `oldest` — the tightest possible same-second case for the `>=` bound.
  await insertActivityAlignedTo({
    workspace_id: 'w1', entity_type: 'ticket', entity_id: t.id,
    action: 'moved', field_changed: 'column', old_value: 'To Do', new_value: 'In Progress',
    actor_id: 'agent-x', actor_name: 'Agent X', ticket_id: t.id, role: '', trigger_source: 'manual',
  }, oldest.created_at.getTime());

  // Force a real (small) gap so the latest comment lands in a LATER
  // wall-clock second — sql.js's `datetime('now')` has 1s resolution, so
  // anything shorter risks both comments hashing to the identical stored
  // string and failing the span guard for an unrelated reason.
  await new Promise((resolve) => setTimeout(resolve, 1100));

  const latestSaved = await commentRepo.save(commentRepo.create({
    ticket_id: t.id, author_type: 'agent', author: 'A', content: 'update 2', type: 'note',
  }));
  const latest = await commentRepo.findOne({ where: { id: latestSaved.id } });

  const now = new Date(latest.created_at.getTime() + 10);

  const service = new StuckTicketDetectorService(ds, logStub, activityService, messagingStub, policiesStub);
  const stats = await service.sweep(now);

  assert.equal(stats.scanned, 1, 'sanity: the ticket must be in the candidate set');
  assert.equal(stats.flagged, 0, 'same-second column move must veto the stale-WAIT flag, not be silently excluded');
  assert.equal(stats.realerted, 0);

  const alert = await alertRepo.findOne({ where: { ticket_id: t.id } });
  assert.equal(alert, null, 'no stuck alert row should exist — the ticket genuinely progressed');
});
