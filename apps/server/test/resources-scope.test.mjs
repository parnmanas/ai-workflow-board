// board_id는 65adf0b(카탈로그 board→workspace 승격)에서 폐지된 레거시 호환
// 컬럼으로, 부트 마이그레이션 이후에는 항상 NULL이어야 한다(Resource 엔티티
// 주석 참고). Resource CRUD는 별도 서비스 없이 컨트롤러에 직접 구현돼 있어,
// credentials-reveal.test.mjs 선례를 따라 컨트롤러를 직접 인스턴스화해
// 검증한다.

import 'reflect-metadata';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { DataSource } from 'typeorm';
import { Resource } from '../dist/entities/Resource.js';
import { ResourcesController } from '../dist/modules/resources/resources.controller.js';

function response() {
  return {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

describe('Resources board-scope cleanup', () => {
  let dataSource;
  let controller;

  before(async () => {
    dataSource = new DataSource({
      type: 'sqljs',
      entities: [Resource],
      synchronize: true,
      logging: false,
    });
    await dataSource.initialize();
    const resourceRepo = dataSource.getRepository(Resource);
    // assertCatalogBoardScope is a documented no-op (see catalog-scope.ts), so
    // the closure create() builds around `dataSource` is never invoked, and no
    // test here sets credential_id — both stubs are safe as-is.
    controller = new ResourcesController(resourceRepo, {}, {});
  });

  after(async () => {
    if (dataSource?.isInitialized) await dataSource.destroy();
  });

  it('rejects creating a new Board-scoped Resource', async () => {
    const res = response();
    await controller.create(
      { workspace_id: 'workspace-a', board_id: 'board-a', name: 'Board resource', type: 'link', url: 'https://example.test' },
      {},
      res,
    );
    assert.equal(res.statusCode, 400);
    assert.match(res.body.error, /no longer supported/);
  });

  it('excludes a legacy Board-scoped Resource row from list() regardless of scope', async () => {
    const repo = dataSource.getRepository(Resource);
    await repo.save(repo.create({
      workspace_id: 'workspace-a',
      board_id: 'board-a',
      name: 'Legacy board-only resource',
    }));
    const createRes = response();
    await controller.create(
      { workspace_id: 'workspace-a', name: 'Workspace resource', type: 'link', url: 'https://example.test' },
      {},
      createRes,
    );
    assert.equal(createRes.statusCode, 201);

    const listRes = response();
    await controller.list('workspace-a', undefined, undefined, undefined, undefined, listRes);
    assert.equal(listRes.body.some(row => row.name === 'Legacy board-only resource'), false);
    assert.ok(listRes.body.every(row => row.board_id === null));
    assert.ok(listRes.body.some(row => row.name === 'Workspace resource'));
  });

  it('get() hides a legacy Board-scoped Resource even by direct id lookup', async () => {
    const repo = dataSource.getRepository(Resource);
    const legacy = await repo.save(repo.create({
      workspace_id: 'workspace-a',
      board_id: 'board-a',
      name: 'Direct-lookup legacy resource',
    }));
    const res = response();
    await controller.get(legacy.id, 'workspace-a', res);
    assert.equal(res.statusCode, 404);
  });
});
