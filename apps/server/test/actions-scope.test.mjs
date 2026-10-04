// Actions are workspace-scoped catalog rows. Boards are gone (docs/tickets.md),
// and with them Action.board_id — the board layer this file used to guard
// (reject new board-scoped Actions, hide legacy board-only rows) no longer
// exists. What survives is the workspace boundary: list() returns only the
// workspace's own Actions, and a stale client that still sends `board_id`
// gets an ordinary workspace Action rather than an error or a hidden row.

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { DataSource } from 'typeorm';
import { Action } from '../dist/entities/Action.js';
import { RuntimeHost } from '../dist/entities/RuntimeHost.js';
import { ApiKey } from '../dist/entities/ApiKey.js';
import { ActionsService } from '../dist/modules/actions/actions.service.js';

// P4c-4: 대상 검증은 Host 행으로 해소한다 (Agent 테이블 없음). 전역 스코프
// 행이면 모든 워크스페이스에서 보인다.
const HOST_ID = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const TARGET = { manager_agent_id: HOST_ID, cli: 'codex', working_dir: '/tmp/work', runtime_config: { strategy: 'single', permission_mode: 'approve' } };

describe('Actions workspace scope', () => {
  let dataSource;
  let service;

  before(async () => {
    dataSource = new DataSource({
      type: 'sqljs',
      entities: [Action, RuntimeHost, ApiKey],
      synchronize: true,
      logging: false,
    });
    await dataSource.initialize();
    await dataSource.getRepository(RuntimeHost).save(
      dataSource.getRepository(RuntimeHost).create({ id: HOST_ID, name: 'host', workspace_id: null }),
    );
    const actionRepo = dataSource.getRepository(Action);
    const stub = {};
    // (action, run, approval, room, participant, message, attachment, host,
    // workspace, user, comment, activity, ticket, dataSource, membership,
    // messaging, logService, projects).
    const hostRepo = dataSource.getRepository(RuntimeHost);
    service = new ActionsService(
      actionRepo, stub, stub, stub, stub, stub, stub,
      hostRepo, stub, stub, stub, stub, stub,
      dataSource, stub, stub, stub, stub,
    );
  });

  after(async () => {
    if (dataSource?.isInitialized) await dataSource.destroy();
  });

  it('a stale board_id in the create payload yields a plain workspace Action', async () => {
    const created = await service.create({
      workspace_id: 'workspace-a',
      board_id: 'board-a',
      name: 'Stale client action',
      target_runtimes: [TARGET],
    });
    assert.equal(created.workspace_id, 'workspace-a');
    assert.equal('board_id' in created, false, 'Action has no board layer to persist into');
    const rows = await service.list('workspace-a');
    assert.ok(rows.some((row) => row.id === created.id), 'the Action is listed in its workspace');
  });

  it('list() returns only the requested workspace\'s Actions', async () => {
    await service.create({ workspace_id: 'workspace-a', name: 'Workspace A action', target_runtimes: [TARGET] });
    await service.create({ workspace_id: 'workspace-b', name: 'Workspace B action', target_runtimes: [TARGET] });

    const rowsA = await service.list('workspace-a');
    assert.ok(rowsA.some((row) => row.name === 'Workspace A action'));
    assert.ok(rowsA.every((row) => row.workspace_id === 'workspace-a'));
    const rowsB = await service.list('workspace-b');
    assert.deepEqual(rowsB.map((row) => row.name), ['Workspace B action']);
  });
});
