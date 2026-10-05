// Security profiles are Account-scoped definitions. The Board layer (and the
// legacy board_id column it left behind) is gone with the board-less ticket
// model (docs/tickets.md), so the only scope left to guard is the Account:
// (1) create() refuses a profile without a workspace, and (2) list() returns a
// Account's own profiles and never another Account's.

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { DataSource } from 'typeorm';
import { SecurityProfile } from '../dist/entities/SecurityProfile.js';
import { SecurityRun } from '../dist/entities/SecurityRun.js';
import { RuntimeHost } from '../dist/entities/RuntimeHost.js'; // P4c-4
import { SecurityProfileService } from '../dist/modules/security/security-profile.service.js';

const TARGET_RUNTIME = { manager_agent_id: 'agent-1', cli: 'codex', working_dir: '/tmp/work', runtime_config: { strategy: 'single', permission_mode: 'approve' } };

describe('Security Profile workspace scope', () => {
  let dataSource;
  let service;

  before(async () => {
    dataSource = new DataSource({
      type: 'sqljs',
      entities: [SecurityProfile, SecurityRun, RuntimeHost],
      synchronize: true,
      logging: false,
    });
    await dataSource.initialize();
    const profileRepo = dataSource.getRepository(SecurityProfile);
    const runRepo = dataSource.getRepository(SecurityRun);
    // P4c-4: 타겟 해소는 Host 행이다 ('agent-1' id 로 직접 심는다).
    const hostRepo = dataSource.getRepository(RuntimeHost);
    await hostRepo.save(hostRepo.create({ id: 'agent-1', name: 'sec-host', hostname: 'sec', account_id: null }));
    // (profile, run, dataSource, host, runService) — list/create never touch runService.
    service = new SecurityProfileService(profileRepo, runRepo, dataSource, hostRepo, {});
  });

  after(async () => {
    if (dataSource?.isInitialized) await dataSource.destroy();
  });

  it('rejects creating a Security profile without a workspace', async () => {
    await assert.rejects(
      service.create({
        name: 'Unscoped profile',
        target_runtime: TARGET_RUNTIME,
        scan_driver: 'code-review',
      }),
      /account_id is required/,
    );
  });

  it('list() returns only the requested Account profiles', async () => {
    await service.create({
      account_id: 'workspace-a',
      name: 'Account A profile',
      target_runtime: TARGET_RUNTIME,
      scan_driver: 'code-review',
    });
    await service.create({
      account_id: 'workspace-b',
      name: 'Account B profile',
      target_runtime: TARGET_RUNTIME,
      scan_driver: 'code-review',
    });

    const rows = await service.list('workspace-a');
    assert.ok(rows.some(row => row.name === 'Account A profile'));
    assert.equal(rows.some(row => row.name === 'Account B profile'), false, 'another Account profile never leaks in');
    assert.ok(rows.every(row => row.account_id === 'workspace-a'));
  });
});
