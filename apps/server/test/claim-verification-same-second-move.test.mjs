// ClaimVerificationService._evaluateTicket — sql.js same-second precision fix
// (ticket 7200396a, follow-up to 8fc94adf/873bf5f).
//
// The "did anything move after the claim comment" check compares
// `created_at >= :from` against ActivityLog rows exactly like
// RespawnStormDetectorService's forward-progress veto did before 873bf5f
// (see respawn-storm-same-second-progress.test.mjs for the shared root
// cause). This file's own inline `floorSec` helper looked like a fix but
// wasn't — it's a no-op on a DB-round-tripped Date (already whole-second),
// which is exactly what `commentAt` (the assignee's claim Comment.created_at)
// always is here.
//
// Failure direction: a `move_ticket` call landing in the exact same
// wall-clock second as the claim comment being silently excluded means
// `_evaluateTicket` sees moveCount=0 and auto-pends the ticket as
// "claim-without-action" even though the assignee genuinely moved it. This
// test constructs that exact boundary deterministically (retries the move
// event's insert until it lands in the same wall-clock second as the claim
// comment) and asserts the ticket is never pended.
//
// Runs against compiled dist/ with a REAL sql.js DataSource, instantiating
// ClaimVerificationService directly (bypassing Nest DI), same pattern
// respawn-storm-same-second-progress.test.mjs uses. `now` is derived
// arithmetically from the claim comment's own stored timestamp (not a real
// sleep) so the grace-window check needs no wall-clock wait.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(__dirname, '..', 'dist');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awb-claim-verification-same-second-'));
process.env.DB_TYPE = 'sqlite';
process.env.SQLJS_DB_PATH = path.join(tmpDir, 'claim-verification-same-second-test.db');
process.env.NODE_ENV = 'test';

const { buildDataSourceOptions } = await import('file://' + path.join(DIST, 'db.js'));
const { DataSource } = await import('typeorm');
const { Board } = await import('file://' + path.join(DIST, 'entities', 'Board.js'));
const { BoardColumn } = await import('file://' + path.join(DIST, 'entities', 'BoardColumn.js'));
const { Ticket } = await import('file://' + path.join(DIST, 'entities', 'Ticket.js'));
const { Comment } = await import('file://' + path.join(DIST, 'entities', 'Comment.js'));
const { ActivityLog } = await import('file://' + path.join(DIST, 'entities', 'ActivityLog.js'));
const { Agent } = await import('file://' + path.join(DIST, 'entities', 'Agent.js'));
const { Workspace } = await import('file://' + path.join(DIST, 'entities', 'Workspace.js'));
const { ActivityService } = await import('file://' + path.join(DIST, 'services', 'activity.service.js'));
const { ClaimVerificationService } = await import('file://' + path.join(DIST, 'modules', 'agents', 'claim-verification.service.js'));

const ds = new DataSource(buildDataSourceOptions());
await ds.initialize();

const logStub = { warn() {}, info() {}, error() {}, debug() {} };
const activityService = new ActivityService(ds.getRepository(ActivityLog), ds.getRepository(Agent), logStub);

const wsRepo = ds.getRepository(Workspace);
const boardRepo = ds.getRepository(Board);
const colRepo = ds.getRepository(BoardColumn);
const ticketRepo = ds.getRepository(Ticket);
const commentRepo = ds.getRepository(Comment);
const activityRepo = ds.getRepository(ActivityLog);

after(async () => {
  await ds.destroy();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// See stuck-ticket-detector-same-second-lifecycle.test.mjs for why retrying
// (rather than sleeping) is the deterministic way to land an ActivityLog
// insert in the same wall-clock second as an already-stored row.
async function insertActivityAlignedTo(fields, targetMs, maxAttempts = 50) {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const saved = await activityRepo.save(activityRepo.create(fields));
    const reloaded = await activityRepo.findOne({ where: { id: saved.id } });
    if (reloaded.created_at.getTime() === targetMs) return reloaded;
    await activityRepo.delete({ id: saved.id });
  }
  throw new Error(`failed to align activity insert to target second within ${maxAttempts} attempts`);
}

test('a move_ticket landing in the same wall-clock second as the claim comment cancels the auto-pend', async () => {
  const ws = await wsRepo.save(wsRepo.create({
    name: 'W', claim_verification_enabled: 1, claim_verification_grace_ms: 1000,
  }));
  const board = await boardRepo.save(boardRepo.create({ name: 'B', workspace_id: ws.id }));
  const col = await colRepo.save(colRepo.create({
    board_id: board.id, name: 'In Progress', position: 1, kind: 'active',
  }));
  const t = await ticketRepo.save(ticketRepo.create({
    title: 'T', column_id: col.id, workspace_id: ws.id, assignee_id: 'agent-1',
    pending_user_action: false,
  }));

  // The assignee's claim comment — DB-default created_at (no ms), same as
  // every other Comment row.
  const claimSaved = await commentRepo.save(commentRepo.create({
    ticket_id: t.id, author_type: 'agent', author_id: 'agent-1', author: 'Agent One',
    content: 'done, moving on', type: 'note',
  }));
  const claimComment = await commentRepo.findOne({ where: { id: claimSaved.id } });

  // A column-move activity row landing in the EXACT SAME wall-clock second as
  // the claim comment — the tightest possible same-second case.
  await insertActivityAlignedTo({
    workspace_id: ws.id, entity_type: 'ticket', entity_id: t.id,
    action: 'moved', field_changed: 'column', old_value: 'In Progress', new_value: 'Review',
    actor_id: 'agent-1', actor_name: 'Agent One', ticket_id: t.id, role: 'assignee', trigger_source: 'manual',
  }, claimComment.created_at.getTime());

  // `now` derived arithmetically from the claim comment's own stored
  // timestamp — past the grace window without any real sleep.
  const now = new Date(claimComment.created_at.getTime() + ws.claim_verification_grace_ms + 10);

  const service = new ClaimVerificationService(ds, activityService, logStub);
  const stats = await service.sweep(now);

  assert.equal(stats.scanned, 1, 'sanity: the ticket must be a claim-verification candidate');
  assert.equal(stats.pended, 0, 'same-second move_ticket must cancel the pend, not be silently excluded');

  const reloadedTicket = await ticketRepo.findOne({ where: { id: t.id } });
  assert.equal(reloadedTicket.pending_user_action, false, 'must NOT be auto-pended — the assignee genuinely moved the ticket');
});
