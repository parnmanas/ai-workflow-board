// Security schedules are Account-scoped. The Board layer (and the legacy
// board_id column it left behind) is gone with the board-less ticket model
// (docs/tickets.md); security-schedule-behavior.test.mjs covers the tick and
// dispatch with stubs, so this file checks the Account boundary against a real
// DataSource: (1) create() refuses a schedule without a account, (2) list()
// and get() never cross into another Account.

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { DataSource } from 'typeorm';
import { SecuritySchedule } from '../dist/entities/SecuritySchedule.js';
import { SecurityScheduleService } from '../dist/modules/security/security-schedule.service.js';

const noopLog = { info() {}, warn() {}, error() {} };
const noQuiesce = { isQuiesced: async () => false };

describe('Security Schedule account scope', () => {
  let dataSource;
  let service;

  before(async () => {
    dataSource = new DataSource({
      type: 'sqljs',
      entities: [SecuritySchedule],
      synchronize: true,
      logging: false,
    });
    await dataSource.initialize();
    const scheduleRepo = dataSource.getRepository(SecuritySchedule);
    // (schedule, batch, runService, log, quiesce) — CRUD never touches batch/runService.
    service = new SecurityScheduleService(scheduleRepo, {}, {}, noopLog, noQuiesce);
  });

  after(async () => {
    if (dataSource?.isInitialized) await dataSource.destroy();
  });

  it('rejects creating a Security schedule without a account', async () => {
    await assert.rejects(
      service.create({ name: 'Unscoped schedule', intervalMs: 60_000 }),
      /account_id is required/,
    );
  });

  it('list() and get() stay inside the requested Account', async () => {
    const mine = await service.create({ accountId: 'account-a', name: 'Account A schedule', intervalMs: 60_000 });
    const theirs = await service.create({ accountId: 'account-b', name: 'Account B schedule', intervalMs: 60_000 });

    const rows = await service.list('account-a');
    assert.ok(rows.some(row => row.id === mine.id));
    assert.equal(rows.some(row => row.id === theirs.id), false, 'another Account schedule never leaks in');
    assert.ok(rows.every(row => row.account_id === 'account-a'));

    assert.equal((await service.get(mine.id, 'account-a')).id, mine.id);
    await assert.rejects(service.get(theirs.id, 'account-a'), /not found in account/);
  });
});
