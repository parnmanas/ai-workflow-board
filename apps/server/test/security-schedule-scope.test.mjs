// board_id는 65adf0b(카탈로그 board→workspace 승격)에서 폐지된 레거시 호환
// 컬럼으로, 부트 마이그레이션 이후에는 항상 NULL이어야 한다(SecuritySchedule
// 엔티티 주석 참고). security-schedule-behavior.test.mjs는 스텁 기반으로
// dispatch 시 board_id가 전파되지 않음만 검증하므로, 이 파일은 실제
// DataSource로 (1) 신규 board-scope 스케줄 생성 거부, (2) list()의 legacy 행
// 배제를 검증한다.

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { DataSource } from 'typeorm';
import { SecuritySchedule } from '../dist/entities/SecuritySchedule.js';
import { SecurityScheduleService } from '../dist/modules/security/security-schedule.service.js';

const noopLog = { info() {}, warn() {}, error() {} };

describe('Security Schedule board-scope cleanup', () => {
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
    service = new SecurityScheduleService(scheduleRepo, {}, {}, noopLog, {});
  });

  after(async () => {
    if (dataSource?.isInitialized) await dataSource.destroy();
  });

  it('rejects creating a new Board-scoped Security schedule', async () => {
    await assert.rejects(
      service.create({
        workspaceId: 'workspace-a',
        boardId: 'board-a',
        name: 'Board schedule',
        intervalMs: 60_000,
      }),
      /no longer supported/,
    );
  });

  it('excludes a legacy Board-scoped Security schedule row from list() regardless of scope', async () => {
    const repo = dataSource.getRepository(SecuritySchedule);
    await repo.save(repo.create({
      workspace_id: 'workspace-a',
      board_id: 'board-a',
      name: 'Legacy board-only schedule',
      kind: 'scan',
      scope: 'all',
      profile_ids: null,
      cron: null,
      interval_ms: 60_000,
      enabled: true,
    }));
    await service.create({
      workspaceId: 'workspace-a',
      name: 'Workspace schedule',
      intervalMs: 60_000,
    });

    const rows = await service.list('workspace-a');
    assert.equal(rows.some(row => row.name === 'Legacy board-only schedule'), false);
    assert.ok(rows.every(row => row.board_id === null));
    assert.ok(rows.some(row => row.name === 'Workspace schedule'));
  });
});
