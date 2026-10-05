// Resources live in exactly two catalog layers — Global (`account_id NULL`)
// and one Account (common/catalog-scope.ts). The Board layer and its dead
// `board_id` column are gone with boards, and repository Resources became
// Projects (same id). Resource CRUD is implemented directly in the controller
// with no separate service, so — following credentials-reveal.test.mjs — the
// controller is instantiated directly.

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

const adminReq = { currentUser: { id: 'u-admin', role: 'admin' } };
const memberReq = { currentUser: { id: 'u-member', role: 'user' } };

describe('Resources scope contract (Global / Account)', () => {
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
    // No test here sets credential_id, so the credential repo stub is never read.
    controller = new ResourcesController(resourceRepo, {});
  });

  after(async () => {
    if (dataSource?.isInitialized) await dataSource.destroy();
  });

  it('rejects a Board scope — it is just an unknown scope now', async () => {
    const res = response();
    await controller.create(
      { scope: 'board', account_id: 'workspace-a', name: 'Board resource', type: 'link', url: 'https://example.test' },
      memberReq,
      res,
    );
    assert.equal(res.statusCode, 400);
    assert.match(res.body.error, /scope must be 'global' or 'account'/);
  });

  it('refuses a repository Resource — repositories are Projects now', async () => {
    const res = response();
    await controller.create(
      { account_id: 'workspace-a', name: 'Repo', type: 'repository', url: 'https://github.com/o/r.git' },
      memberReq,
      res,
    );
    assert.equal(res.statusCode, 400);
    assert.match(res.body.error, /repositories are Projects now/);
  });

  it('only admins create Global Resources', async () => {
    const res = response();
    await controller.create({ scope: 'global', name: 'Global doc', type: 'link' }, memberReq, res);
    assert.equal(res.statusCode, 403);
  });

  it('list() returns the Account own Resources plus inherited globals, never another Account', async () => {
    for (const [body, req] of [
      [{ account_id: 'workspace-a', name: 'Account resource', type: 'link', url: 'https://a.test' }, memberReq],
      [{ account_id: 'workspace-b', name: 'Other workspace resource', type: 'link', url: 'https://b.test' }, memberReq],
      [{ scope: 'global', name: 'Global resource', type: 'link', url: 'https://g.test' }, adminReq],
    ]) {
      const res = response();
      await controller.create(body, req, res);
      assert.equal(res.statusCode, 201, JSON.stringify(res.body));
    }

    const listRes = response();
    await controller.list('workspace-a', undefined, 'name', 'asc', undefined, listRes);
    assert.deepEqual(listRes.body.map((row) => row.name), ['Account resource', 'Global resource']);
    assert.deepEqual(listRes.body.map((row) => row.scope), ['account', 'global']);
    // The row shape carries no Board layer at all.
    assert.ok(listRes.body.every((row) => !('board_id' in row)));
  });

  it('get() hides another Account Resource even by direct id lookup, but serves globals', async () => {
    const repo = dataSource.getRepository(Resource);
    const foreign = await repo.save(repo.create({ account_id: 'workspace-b', name: 'Direct-lookup foreign resource' }));
    const global = await repo.save(repo.create({ account_id: null, name: 'Direct-lookup global resource' }));

    const hidden = response();
    await controller.get(foreign.id, 'workspace-a', hidden);
    assert.equal(hidden.statusCode, 404);

    const shown = response();
    await controller.get(global.id, 'workspace-a', shown);
    assert.equal(shown.statusCode, 200);
    assert.equal(shown.body.scope, 'global');
  });
});
