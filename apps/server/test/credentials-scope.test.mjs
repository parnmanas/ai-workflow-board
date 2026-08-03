// board_id는 65adf0b(카탈로그 board→workspace 승격)에서 폐지된 레거시 호환
// 컬럼으로, 부트 마이그레이션 이후에는 항상 NULL이어야 한다(Credential 엔티티
// 주석 참고). git-credential-resolution.test.mjs는 git 자격증명 해석 경로만
// 다루므로, 이 파일은 REST CRUD(list/create) 자체의 scope 계약을 검증한다.

import 'reflect-metadata';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { DataSource } from 'typeorm';
import { Credential } from '../dist/entities/Credential.js';
import { CredentialsController } from '../dist/modules/credentials/credentials.controller.js';

function response() {
  return {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

describe('Credentials board-scope cleanup', () => {
  let dataSource;
  let controller;

  before(async () => {
    dataSource = new DataSource({
      type: 'sqljs',
      entities: [Credential],
      synchronize: true,
      logging: false,
    });
    await dataSource.initialize();
    const credRepo = dataSource.getRepository(Credential);
    // assertCatalogBoardScope is a documented no-op (see catalog-scope.ts), so
    // the closure create() builds around `dataSource` is never invoked; auth/
    // activity services are only touched by reveal(), not exercised here.
    controller = new CredentialsController(credRepo, {}, {}, {});
  });

  after(async () => {
    if (dataSource?.isInitialized) await dataSource.destroy();
  });

  it('rejects creating a new Board-scoped Credential', async () => {
    const res = response();
    await controller.create(
      {
        workspace_id: 'workspace-a',
        board_id: 'board-a',
        name: 'Board credential',
        provider: 'github',
        credentials: { token: 'secret' },
      },
      {},
      res,
    );
    assert.equal(res.statusCode, 400);
    assert.match(res.body.error, /no longer supported/);
  });

  it('excludes a legacy Board-scoped Credential row from list() regardless of scope', async () => {
    const repo = dataSource.getRepository(Credential);
    await repo.save(repo.create({
      workspace_id: 'workspace-a',
      board_id: 'board-a',
      name: 'Legacy board-only credential',
      provider: 'github',
      encrypted_data: '',
    }));
    const createRes = response();
    await controller.create(
      {
        workspace_id: 'workspace-a',
        name: 'Workspace credential',
        provider: 'github',
        credentials: { token: 'secret' },
      },
      {},
      createRes,
    );
    assert.equal(createRes.statusCode, 201);

    const listRes = response();
    await controller.list('workspace-a', undefined, undefined, undefined, listRes);
    assert.equal(listRes.body.some(row => row.name === 'Legacy board-only credential'), false);
    assert.ok(listRes.body.every(row => row.board_id === null));
    assert.ok(listRes.body.some(row => row.name === 'Workspace credential'));
  });
});
