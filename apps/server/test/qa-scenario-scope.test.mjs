// QA scenarios are Workspace-scoped definitions. The Board layer (and the
// legacy board_id column it left behind) is gone with the board-less ticket
// model (docs/tickets.md), so the only scope left to guard is the Workspace:
// (1) create() refuses a scenario without a workspace, and (2) list() / update()
// never cross into another Workspace's scenarios.

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { DataSource } from 'typeorm';
import { QaScenario } from '../dist/entities/QaScenario.js';
import { QaRun } from '../dist/entities/QaRun.js';
import { RuntimeHost } from '../dist/entities/RuntimeHost.js';
import { QaService } from '../dist/modules/qa/qa.service.js';

const TARGET_RUNTIME = { manager_agent_id: 'agent-1', cli: 'codex', working_dir: '/tmp/work', runtime_config: { strategy: 'single', permission_mode: 'approve' } };

describe('QA Scenario workspace scope', () => {
  let dataSource;
  let service;

  before(async () => {
    dataSource = new DataSource({
      type: 'sqljs',
      entities: [QaScenario, QaRun, RuntimeHost],
      synchronize: true,
      logging: false,
    });
    await dataSource.initialize();
    const scenarioRepo = dataSource.getRepository(QaScenario);
    const runRepo = dataSource.getRepository(QaRun);
    // P4c-4: 타겟 해소는 Host 행이다 ('agent-1' id 로 직접 심는다).
    const hostRepo = dataSource.getRepository(RuntimeHost);
    await hostRepo.save(hostRepo.create({ id: 'agent-1', name: 'qa-host', hostname: 'qa', workspace_id: null }));
    // (scenario, run, dataSource, host, runService) — list/create/update never touch runService.
    service = new QaService(scenarioRepo, runRepo, dataSource, hostRepo, {});
  });

  after(async () => {
    if (dataSource?.isInitialized) await dataSource.destroy();
  });

  it('rejects creating a QA scenario without a workspace', async () => {
    await assert.rejects(
      service.create({ name: 'Unscoped scenario', target_runtime: TARGET_RUNTIME }),
      /workspace_id is required/,
    );
  });

  it('list() and update() stay inside the requested Workspace', async () => {
    const mine = await service.create({ workspace_id: 'workspace-a', name: 'Workspace A scenario', target_runtime: TARGET_RUNTIME });
    const theirs = await service.create({ workspace_id: 'workspace-b', name: 'Workspace B scenario', target_runtime: TARGET_RUNTIME });

    const rows = await service.list('workspace-a');
    assert.ok(rows.some(row => row.id === mine.id));
    assert.equal(rows.some(row => row.id === theirs.id), false, 'another Workspace scenario never leaks in');
    assert.ok(rows.every(row => row.workspace_id === 'workspace-a'));

    assert.equal((await service.update(mine.id, 'workspace-a', { description: 'mine' })).description, 'mine');
    await assert.rejects(service.update(theirs.id, 'workspace-a', { description: 'hijack' }), /not found in workspace/);
  });
});
