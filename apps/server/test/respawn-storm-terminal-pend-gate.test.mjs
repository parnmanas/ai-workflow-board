// RespawnStormDetectorService terminal-aware pend gate (ticket ec498050, one
// of the 5 system-originated pend sites that never checked terminal state —
// root cause of ticket 0709ea7c on a sibling guard).
//
// A ticket already sitting in a terminal (Done) column can still death-loop —
// e.g. a post-Done self-improvement retrospective session crash-looping — and
// the detector must still HALT (log the event, notify) so the loop is
// observable, but must NOT set `pending_user_action`: nothing ever revisits a
// Done ticket's User tab, so the park would just strand it invisibly forever.
//
// Runs against compiled dist/ (requires `npm run build`) with a REAL sql.js
// DataSource, instantiating RespawnStormDetectorService directly (bypassing
// Nest DI, same pattern as respawn-storm-same-second-progress.test.mjs).
// Uses an isolated SQLJS_DB_PATH temp file.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(__dirname, '..', 'dist');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awb-respawn-storm-terminal-'));
process.env.DB_TYPE = 'sqlite';
process.env.SQLJS_DB_PATH = path.join(tmpDir, 'respawn-storm-terminal-test.db');
process.env.NODE_ENV = 'test';

const { buildDataSourceOptions } = await import('file://' + path.join(DIST, 'db.js'));
const { DataSource } = await import('typeorm');
const { Board } = await import('file://' + path.join(DIST, 'entities', 'Board.js'));
const { BoardColumn } = await import('file://' + path.join(DIST, 'entities', 'BoardColumn.js'));
const { Ticket } = await import('file://' + path.join(DIST, 'entities', 'Ticket.js'));
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
const subRepo = ds.getRepository(Subagent);
const activityRepo = ds.getRepository(ActivityLog);

let subCounter = 0;
async function seedQuickDeath(ticketId, role, when) {
  subCounter += 1;
  return subRepo.save(subRepo.create({
    subagent_id: `sub-terminal-${subCounter}`, agent_id: 'agent-fixture', workspace_id: 'w1',
    kind: 'ticket', session_key: `${ticketId}:${role}`, pid: 2000 + subCounter,
    started_at: when, ticket_id: ticketId, ticket_title: 'T', role,
    ended_at: when, exit_code: 1, signal: null, duration_ms: 100, line_count: 0,
  }));
}

after(async () => {
  await ds.destroy();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('a respawn storm on a terminal (Done) ticket is halted (event logged) but NOT pended', async () => {
  const board = await boardRepo.save(boardRepo.create({
    name: 'B', respawn_storm_config: JSON.stringify({
      window_minutes: 5, min_deaths: 2, quick_death_seconds: 60,
      auto_pend: true, notify: false, detect_twins: false,
    }),
  }));
  const doneCol = await colRepo.save(colRepo.create({
    board_id: board.id, name: 'Done', position: 6, is_terminal: true, kind: 'terminal',
  }));
  const t = await ticketRepo.save(ticketRepo.create({
    title: 'T', column_id: doneCol.id, workspace_id: 'w1', pending_user_action: false,
  }));

  const now = new Date();
  const deathTime = new Date(now.getTime() - 1000);
  await seedQuickDeath(t.id, 'assignee', deathTime);
  await seedQuickDeath(t.id, 'assignee', deathTime);

  const service = new RespawnStormDetectorService(ds, logStub, activityService, messagingStub);
  const stats = await service.sweep(now);

  assert.equal(stats.storms_detected, 1, '2 quick abnormal deaths on (ticket,role) is still a storm candidate on a terminal column');
  assert.equal(stats.storms_halted, 1, 'the halt-processing path (event log) still runs — the storm stays observable');

  const reloaded = await ticketRepo.findOne({ where: { id: t.id } });
  assert.equal(reloaded.pending_user_action, false, 'must NOT be auto-pended — a Done ticket is never revisited by a human');

  const haltEvent = await activityRepo.findOne({ where: { ticket_id: t.id, action: 'respawn_storm_halted' } });
  assert.ok(haltEvent, 'the halt event is still logged for observability even though nothing was pended');

  const pendActs = await activityRepo.find({ where: { ticket_id: t.id, field_changed: 'pending_user_action' } });
  assert.equal(pendActs.length, 0, 'no pending_user_action audit row for a skipped terminal pend');
});

test('control: the SAME scenario on a non-terminal (active) column still pends — the gate is column-specific', async () => {
  const board = await boardRepo.save(boardRepo.create({
    name: 'B2', respawn_storm_config: JSON.stringify({
      window_minutes: 5, min_deaths: 2, quick_death_seconds: 60,
      auto_pend: true, notify: false, detect_twins: false,
    }),
  }));
  const activeCol = await colRepo.save(colRepo.create({ board_id: board.id, name: 'In Progress', position: 1 }));
  const t = await ticketRepo.save(ticketRepo.create({
    title: 'T', column_id: activeCol.id, workspace_id: 'w1', pending_user_action: false,
  }));

  const now = new Date();
  const deathTime = new Date(now.getTime() - 1000);
  await seedQuickDeath(t.id, 'assignee', deathTime);
  await seedQuickDeath(t.id, 'assignee', deathTime);

  const service = new RespawnStormDetectorService(ds, logStub, activityService, messagingStub);
  const stats = await service.sweep(now);

  assert.equal(stats.storms_halted, 1);
  const reloaded = await ticketRepo.findOne({ where: { id: t.id } });
  assert.equal(reloaded.pending_user_action, true, 'an active-column ticket is still auto-pended as before');
});
