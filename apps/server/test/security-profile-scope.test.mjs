// Security profiles are Workspace-scoped definitions. The Board layer (and the
// legacy board_id column it left behind) is gone with the board-less ticket
// model (docs/tickets.md), so the only scope left to guard is the Workspace:
// (1) create() refuses a profile without a workspace, and (2) list() returns a
// Workspace's own profiles and never another Workspace's.

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
    await hostRepo.save(hostRepo.create({ id: 'agent-1', name: 'sec-host', hostname: 'sec', workspace_id: null }));
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
      /workspace_id is required/,
    );
  });

  it('list() returns only the requested Workspace profiles', async () => {
    await service.create({
      workspace_id: 'workspace-a',
      name: 'Workspace A profile',
      target_runtime: TARGET_RUNTIME,
      scan_driver: 'code-review',
    });
    await service.create({
      workspace_id: 'workspace-b',
      name: 'Workspace B profile',
      target_runtime: TARGET_RUNTIME,
      scan_driver: 'code-review',
    });

    const rows = await service.list('workspace-a');
    assert.ok(rows.some(row => row.name === 'Workspace A profile'));
    assert.equal(rows.some(row => row.name === 'Workspace B profile'), false, 'another Workspace profile never leaks in');
    assert.ok(rows.every(row => row.workspace_id === 'workspace-a'));
  });
});
