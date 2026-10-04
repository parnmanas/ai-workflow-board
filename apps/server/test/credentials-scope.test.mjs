// Credentials live in exactly two catalog layers — Global (`workspace_id NULL`)
// and one Workspace (common/catalog-scope.ts). The Board layer and its dead
// `board_id` column are gone with boards. git-credential-resolution.test.mjs
// covers the git credential resolution path and credentials-scope-switch
// covers update(); this file pins the REST CRUD (list/create) scope contract.

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

const adminReq = { currentUser: { id: 'u-admin', name: 'Admin', role: 'admin', permissions: [] } };
const memberReq = { currentUser: { id: 'u-member', name: 'Member', role: 'user', permissions: ['admin.credentials'] } };

describe('Credentials REST scope contract (Global / Workspace)', () => {
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
    // auth/activity services are only touched by reveal()/update(), not here.
    controller = new CredentialsController(credRepo, {}, {}, {});
  });

  after(async () => {
    if (dataSource?.isInitialized) await dataSource.destroy();
  });

  it('rejects a Board scope — it is just an unknown scope now', async () => {
    const res = response();
    await controller.create(
      {
        scope: 'board',
        workspace_id: 'workspace-a',
        name: 'Board credential',
        provider: 'github',
        credentials: { token: 'secret' },
      },
      memberReq,
      res,
    );
    assert.equal(res.statusCode, 400);
    assert.match(res.body.error, /scope must be 'global' or 'workspace'/);
  });

  it('refuses a global credential without admin.global_credentials', async () => {
    const res = response();
    await controller.create(
      { scope: 'global', name: 'Global PAT', provider: 'github', credentials: { token: 'secret' } },
      memberReq,
      res,
    );
    assert.equal(res.statusCode, 403);
    assert.match(res.body.error, /admin\.global_credentials/);
  });

  it('list() returns the Workspace own credentials plus inherited globals, never another Workspace', async () => {
    for (const [body, req] of [
      [{ workspace_id: 'workspace-a', name: 'Workspace credential', provider: 'github', credentials: { token: 'a' } }, memberReq],
      [{ workspace_id: 'workspace-b', name: 'Other workspace credential', provider: 'github', credentials: { token: 'b' } }, memberReq],
      [{ scope: 'global', name: 'Global credential', provider: 'github', credentials: { token: 'g' } }, adminReq],
    ]) {
      const res = response();
      await controller.create(body, req, res);
      assert.equal(res.statusCode, 201, JSON.stringify(res.body));
    }

    const listRes = response();
    await controller.list('workspace-a', undefined, undefined, undefined, listRes);
    const names = listRes.body.map((row) => row.name).sort();
    assert.deepEqual(names, ['Global credential', 'Workspace credential']);
    assert.equal(listRes.body.find((r) => r.name === 'Global credential').scope, 'global');
    assert.equal(listRes.body.find((r) => r.name === 'Workspace credential').scope, 'workspace');
    // The response shape carries no Board layer at all.
    assert.ok(listRes.body.every((row) => !('board_id' in row)));

    const globalsOnly = response();
    await controller.list(undefined, undefined, 'global', undefined, globalsOnly);
    assert.deepEqual(globalsOnly.body.map((r) => r.name), ['Global credential']);

    const missingWs = response();
    await controller.list(undefined, undefined, undefined, undefined, missingWs);
    assert.equal(missingWs.statusCode, 400);
  });
});
