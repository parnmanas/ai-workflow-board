// QA schedules are Workspace-scoped. The Board layer (and the legacy board_id
// column it left behind) is gone with the board-less ticket model
// (docs/tickets.md); qa-schedule-behavior.test.mjs covers the tick and dispatch
// with stubs, so this file checks the Workspace boundary against a real
// DataSource: (1) create() refuses a schedule without a workspace, (2) list()
// and get() never cross into another Workspace.

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { DataSource } from 'typeorm';
import { QaSchedule } from '../dist/entities/QaSchedule.js';
import { QaScheduleService } from '../dist/modules/qa/qa-schedule.service.js';

const noopLog = { info() {}, warn() {}, error() {} };
const noQuiesce = { isQuiesced: async () => false };

describe('QA Schedule workspace scope', () => {
  let dataSource;
  let service;

  before(async () => {
    dataSource = new DataSource({
      type: 'sqljs',
      entities: [QaSchedule],
      synchronize: true,
      logging: false,
    });
    await dataSource.initialize();
    const scheduleRepo = dataSource.getRepository(QaSchedule);
    // (schedule, batch, runService, log, quiesce) — CRUD never touches batch/runService.
    service = new QaScheduleService(scheduleRepo, {}, {}, noopLog, noQuiesce);
  });

  after(async () => {
    if (dataSource?.isInitialized) await dataSource.destroy();
  });

  it('rejects creating a QA schedule without a workspace', async () => {
    await assert.rejects(
      service.create({ name: 'Unscoped schedule', intervalMs: 60_000 }),
      /workspace_id is required/,
    );
  });

  it('list() and get() stay inside the requested Workspace', async () => {
    const mine = await service.create({ workspaceId: 'workspace-a', name: 'Workspace A schedule', intervalMs: 60_000 });
    const theirs = await service.create({ workspaceId: 'workspace-b', name: 'Workspace B schedule', intervalMs: 60_000 });

    const rows = await service.list('workspace-a');
    assert.ok(rows.some(row => row.id === mine.id));
    assert.equal(rows.some(row => row.id === theirs.id), false, 'another Workspace schedule never leaks in');
    assert.ok(rows.every(row => row.workspace_id === 'workspace-a'));

    assert.equal((await service.get(mine.id, 'workspace-a')).id, mine.id);
    await assert.rejects(service.get(theirs.id, 'workspace-a'), /not found in workspace/);
  });
});
