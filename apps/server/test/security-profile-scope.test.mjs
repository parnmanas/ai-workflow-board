// board_id는 65adf0b(카탈로그 board→workspace 승격)에서 폐지된 레거시 호환
// 컬럼으로, 부트 마이그레이션 이후에는 항상 NULL이어야 한다(SecurityProfile
// 엔티티 주석 참고). workflow-functions.test.mjs의 골드 스탠다드 패턴을
// SecurityProfile에 그대로 적용한다: (1) 신규 board-scope 프로필 생성은
// 거부되고, (2) create()를 우회해 남아있는 legacy board-scoped 행이 있어도
// list()는 이를 항상 제외해야 한다.

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { DataSource } from 'typeorm';
import { SecurityProfile } from '../dist/entities/SecurityProfile.js';
import { SecurityRun } from '../dist/entities/SecurityRun.js';
import { SecurityProfileService } from '../dist/modules/security/security-profile.service.js';

describe('Security Profile board-scope cleanup', () => {
  let dataSource;
  let service;

  before(async () => {
    dataSource = new DataSource({
      type: 'sqljs',
      entities: [SecurityProfile, SecurityRun],
      synchronize: true,
      logging: false,
    });
    await dataSource.initialize();
    const profileRepo = dataSource.getRepository(SecurityProfile);
    const runRepo = dataSource.getRepository(SecurityRun);
    const agentRepo = { findOne: async () => ({ id: 'agent-1', workspace_id: null }) };
    service = new SecurityProfileService(profileRepo, runRepo, agentRepo, {}, {});
  });

  after(async () => {
    if (dataSource?.isInitialized) await dataSource.destroy();
  });

  it('rejects creating a new Board-scoped Security profile', async () => {
    await assert.rejects(
      service.create({
        workspace_id: 'workspace-a',
        board_id: 'board-a',
        name: 'Board profile',
        target_agent_id: 'agent-1',
        scan_driver: 'code-review',
      }),
      /no longer supported/,
    );
  });

  it('excludes a legacy Board-scoped Security profile row from list() regardless of scope', async () => {
    const repo = dataSource.getRepository(SecurityProfile);
    await repo.save(repo.create({
      workspace_id: 'workspace-a',
      board_id: 'board-a',
      name: 'Legacy board-only profile',
      target_agent_id: 'agent-1',
      scan_driver: 'code-review',
    }));
    await service.create({
      workspace_id: 'workspace-a',
      name: 'Workspace profile',
      target_agent_id: 'agent-1',
      scan_driver: 'code-review',
    });

    const rows = await service.list('workspace-a');
    assert.equal(rows.some(row => row.name === 'Legacy board-only profile'), false);
    assert.ok(rows.every(row => row.board_id === null));
    assert.ok(rows.some(row => row.name === 'Workspace profile'));
  });
});
