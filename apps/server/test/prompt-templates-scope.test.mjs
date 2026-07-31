// board_id는 65adf0b(카탈로그 board→workspace 승격)에서 폐지된 레거시 호환
// 컬럼으로, 부트 마이그레이션 이후에는 항상 NULL이어야 한다(PromptTemplate
// 엔티티 주석 참고). PromptTemplate CRUD는 별도 서비스 없이 컨트롤러에 직접
// 구현돼 있어, credentials-reveal.test.mjs 선례를 따라 컨트롤러를 직접
// 인스턴스화해 검증한다.

import 'reflect-metadata';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { DataSource } from 'typeorm';
import { PromptTemplate } from '../dist/entities/PromptTemplate.js';
import { PromptTemplatesController } from '../dist/modules/prompt-templates/prompt-templates.controller.js';

function response() {
  return {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

describe('Prompt Templates board-scope cleanup', () => {
  let dataSource;
  let controller;

  before(async () => {
    dataSource = new DataSource({
      type: 'sqljs',
      entities: [PromptTemplate],
      synchronize: true,
      logging: false,
    });
    await dataSource.initialize();
    const templateRepo = dataSource.getRepository(PromptTemplate);
    // assertCatalogBoardScope is a documented no-op (see catalog-scope.ts), so
    // the closure create() builds around `dataSource` is never invoked — a
    // stub is sufficient here.
    controller = new PromptTemplatesController(templateRepo, {});
  });

  after(async () => {
    if (dataSource?.isInitialized) await dataSource.destroy();
  });

  it('rejects creating a new Board-scoped Prompt Template', async () => {
    const res = response();
    await controller.create(
      { workspace_id: 'workspace-a', board_id: 'board-a', name: 'Board template', content: 'hello' },
      {},
      res,
    );
    assert.equal(res.statusCode, 400);
    assert.match(res.body.error, /no longer supported/);
  });

  it('excludes a legacy Board-scoped Prompt Template row from list() regardless of scope', async () => {
    const repo = dataSource.getRepository(PromptTemplate);
    await repo.save(repo.create({
      workspace_id: 'workspace-a',
      board_id: 'board-a',
      name: 'Legacy board-only template',
      content: 'legacy',
    }));
    const createRes = response();
    await controller.create(
      { workspace_id: 'workspace-a', name: 'Workspace template', content: 'ok' },
      {},
      createRes,
    );
    assert.equal(createRes.statusCode, 201);

    const listRes = response();
    await controller.list('workspace-a', undefined, undefined, undefined, listRes);
    assert.equal(listRes.body.some(row => row.name === 'Legacy board-only template'), false);
    assert.ok(listRes.body.every(row => row.board_id === null));
    assert.ok(listRes.body.some(row => row.name === 'Workspace template'));
  });
});
