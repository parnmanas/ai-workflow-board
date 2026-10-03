// board_id는 65adf0b(카탈로그 board→workspace 승격)에서 폐지된 레거시 호환
// 컬럼으로, 부트 마이그레이션 이후에는 항상 NULL이어야 한다(Action 엔티티
// 주석 참고). 이 회귀 테스트는 workflow-functions.test.mjs의 골드 스탠다드
// 패턴을 Action에 그대로 적용한다: (1) 신규 board-scope Action 생성은
// 거부되고, (2) create()를 우회해 남아있는 legacy board-scoped 행이 있어도
// list()는 이를 항상 제외해야 한다.

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

describe('Actions board-scope cleanup', () => {
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
    // P4c-4: (action, run, approval, room, participant, message, attachment,
    // host, board, workspace, user, comment, activity, ticket, column,
    // dataSource, membership, messaging, logService).
    const hostRepo = dataSource.getRepository(RuntimeHost);
    service = new ActionsService(
      actionRepo, stub, stub, stub, stub, stub, stub,
      hostRepo, stub, stub, stub, stub, stub, stub, stub,
      dataSource, stub, stub, stub,
    );
  });

  after(async () => {
    if (dataSource?.isInitialized) await dataSource.destroy();
  });

  it('rejects creating a new Board-scoped Action', async () => {
    await assert.rejects(
      service.create({
        workspace_id: 'workspace-a',
        board_id: 'board-a',
        name: 'Board Action',
        target_agent_id: HOST_ID,
      }),
      /no longer supported/,
    );
  });

  it('excludes a legacy Board-scoped Action row from list() regardless of scope', async () => {
    const repo = dataSource.getRepository(Action);
    await repo.save(repo.create({
      workspace_id: 'workspace-a',
      board_id: 'board-a',
      name: 'Legacy board-only action',
      target_agent_id: HOST_ID,
    }));
    await service.create({
      workspace_id: 'workspace-a',
      name: 'Workspace action',
      target_agent_id: HOST_ID,
    });

    const rows = await service.list('workspace-a');
    assert.equal(rows.some(row => row.name === 'Legacy board-only action'), false);
    assert.ok(rows.every(row => row.board_id === null));
    assert.ok(rows.some(row => row.name === 'Workspace action'));
  });
});
