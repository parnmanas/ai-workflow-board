// AgentWorkloadService.rankFocusCandidates (heartbeat-only BLOCKED filter) —
// sql.js same-second precision fix (ticket 7200396a, 3rd site flagged in
// reviewer comments during 8fc94adf's review, follow-up to 873bf5f).
//
// The "count column moves between the last claim and the last release"
// check compares `created_at >= :claimAt` against ActivityLog rows exactly
// like RespawnStormDetectorService's forward-progress veto did before
// 873bf5f (see respawn-storm-same-second-progress.test.mjs for the shared
// root cause). Unlike that pure rolling-window comparison, this one is a
// bounded interval anchored on two specific events (claim, release) rather
// than "now minus a window" — the ticket explicitly calls this out as
// needing re-verification before reusing sinceBoundaryParam() here. It
// verifies safe: `sinceBoundaryParam` only ever WIDENS the lower bound to
// include the same wall-clock second as `claimAt`, and the two claim/release
// bracket events themselves can never be double-counted (they're
// action='updated' rows, the move-count query only matches action='moved').
//
// Failure direction: a column move landing in the exact same wall-clock
// second as the claim event being silently excluded means moveCount=0 and a
// genuinely-progressing BLOCKED-labeled ticket is misclassified as
// "heartbeat-only" and excluded from the agent's FOCUS candidate set — a
// false workload-idle classification. This test constructs that exact
// boundary deterministically (retries the move event's insert until it
// lands in the same wall-clock second as the claim event) and asserts the
// ticket is NOT excluded.
//
// Runs against compiled dist/ with a REAL sql.js DataSource, instantiating
// AgentWorkloadService directly (bypassing Nest DI), same pattern
// respawn-storm-same-second-progress.test.mjs uses.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(__dirname, '..', 'dist');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awb-agent-workload-same-second-'));
process.env.DB_TYPE = 'sqlite';
process.env.SQLJS_DB_PATH = path.join(tmpDir, 'agent-workload-same-second-test.db');
process.env.NODE_ENV = 'test';

const { buildDataSourceOptions } = await import('file://' + path.join(DIST, 'db.js'));
const { DataSource } = await import('typeorm');
const { Board } = await import('file://' + path.join(DIST, 'entities', 'Board.js'));
const { BoardColumn } = await import('file://' + path.join(DIST, 'entities', 'BoardColumn.js'));
const { Ticket } = await import('file://' + path.join(DIST, 'entities', 'Ticket.js'));
const { ActivityLog } = await import('file://' + path.join(DIST, 'entities', 'ActivityLog.js'));
const { WorkspaceRole } = await import('file://' + path.join(DIST, 'entities', 'WorkspaceRole.js'));
const { TicketRoleAssignment } = await import('file://' + path.join(DIST, 'entities', 'TicketRoleAssignment.js'));
const { AgentWorkloadService } = await import('file://' + path.join(DIST, 'modules', 'agents', 'agent-workload.service.js'));

const ds = new DataSource(buildDataSourceOptions());
await ds.initialize();

const boardRepo = ds.getRepository(Board);
const colRepo = ds.getRepository(BoardColumn);
const ticketRepo = ds.getRepository(Ticket);
const activityRepo = ds.getRepository(ActivityLog);
const roleRepo = ds.getRepository(WorkspaceRole);
const assignRepo = ds.getRepository(TicketRoleAssignment);

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

test('a BLOCKED ticket with a column move in the same wall-clock second as the claim is not excluded as heartbeat-only', async () => {
  const board = await boardRepo.save(boardRepo.create({ name: 'B' }));
  const col = await colRepo.save(colRepo.create({
    board_id: board.id, name: 'In Progress', position: 1, kind: 'active',
  }));
  const role = await roleRepo.save(roleRepo.create({
    workspace_id: 'w1', slug: 'assignee', name: 'Assignee',
  }));

  const blocked = await ticketRepo.save(ticketRepo.create({
    title: 'Blocked ticket', column_id: col.id, workspace_id: 'w1', priority: 'medium',
    labels: JSON.stringify(['BLOCKED-approval']), pending_user_action: false, pending_on_tickets: false,
  }));
  const other = await ticketRepo.save(ticketRepo.create({
    title: 'Other ticket', column_id: col.id, workspace_id: 'w1', priority: 'medium',
    labels: JSON.stringify([]), pending_user_action: false, pending_on_tickets: false,
  }));

  for (const ticket of [blocked, other]) {
    await assignRepo.save(assignRepo.create({
      ticket_id: ticket.id, role_id: role.id, agent_id: 'agent-1', holder_key: 'agent:agent-1',
    }));
  }

  // Claim event — DB-default created_at (no ms), same as production.
  const claimSaved = await activityRepo.save(activityRepo.create({
    workspace_id: 'w1', entity_type: 'ticket', entity_id: blocked.id,
    action: 'updated', field_changed: 'locked_by_agent_id', old_value: '', new_value: 'agent-1',
    actor_id: 'agent-1', actor_name: 'Agent One', ticket_id: blocked.id, role: 'assignee',
    trigger_source: 'agent_claim',
  }));
  const claim = await activityRepo.findOne({ where: { id: claimSaved.id } });

  // A column-move activity row landing in the EXACT SAME wall-clock second
  // as the claim — the tightest possible same-second case for the
  // `>= :claimAt` lower bound.
  await insertActivityAlignedTo({
    workspace_id: 'w1', entity_type: 'ticket', entity_id: blocked.id,
    action: 'moved', field_changed: 'column', old_value: 'To Do', new_value: 'In Progress',
    actor_id: 'agent-1', actor_name: 'Agent One', ticket_id: blocked.id, role: 'assignee',
    trigger_source: 'manual',
  }, claim.created_at.getTime());

  // Release event — real DB-default created_at, whatever second it lands in
  // (>= the claim/move in wall-clock terms regardless; the `<= :releaseAt`
  // upper bound was never the buggy direction — see created-at-since-param.ts).
  await activityRepo.save(activityRepo.create({
    workspace_id: 'w1', entity_type: 'ticket', entity_id: blocked.id,
    action: 'updated', field_changed: 'locked_by_agent_id', old_value: 'agent-1', new_value: '',
    actor_id: 'agent-1', actor_name: 'Agent One', ticket_id: blocked.id, role: 'assignee',
    trigger_source: 'agent_release',
  }));

  const service = new AgentWorkloadService(ds);
  const ids = await service.getAgentFocusTicketIds('agent-1', board.id, 10);

  assert.equal(ids.length, 2, 'sanity: both tickets must be candidates for this agent/board');
  assert.ok(
    ids.includes(blocked.id),
    'same-second column move must count toward the claim→release cycle, not be silently excluded as heartbeat-only',
  );
});
