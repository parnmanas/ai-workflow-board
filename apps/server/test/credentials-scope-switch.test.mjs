// Credentials are the one catalog kind whose scope is mutable in place — every
// sibling (resources, functions, prompt-templates, QA, actions) answers 400
// "scope cannot be changed after creation". This file pins the three rules that
// make that safe: who may flip it, that a Workspace credential still cannot
// hop straight to a different Workspace, and that narrowing a global one is
// refused while dependents live outside the destination.
//
// credentials-scope.test.mjs covers the board_id legacy contract of list/create;
// this file covers update()'s scope handling only.

import 'reflect-metadata';
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { DataSource } from 'typeorm';
import { Credential } from '../dist/entities/Credential.js';
import { Agent } from '../dist/entities/Agent.js';
import { Resource } from '../dist/entities/Resource.js';
import { AgentSessionCliSetting } from '../dist/entities/AgentSessionCliSetting.js';
import { OutreachChannel } from '../dist/entities/OutreachChannel.js';
import { CredentialsController } from '../dist/modules/credentials/credentials.controller.js';

function response() {
  return {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

// canManageGlobal() reads role + permissions off req.currentUser; the admin role
// resolves to ALL_PERMISSIONS, so it holds admin.global_credentials implicitly.
const adminReq = { currentUser: { id: 'u-admin', name: 'Admin', role: 'admin', permissions: [] } };
const memberReq = { currentUser: { id: 'u-member', name: 'Member', role: 'user', permissions: ['admin.credentials'] } };

describe('Credential scope switch (update)', () => {
  let dataSource;
  let controller;
  let credRepo;
  let audit;

  before(async () => {
    dataSource = new DataSource({
      type: 'sqljs',
      entities: [Credential, Agent, Resource, AgentSessionCliSetting, OutreachChannel],
      synchronize: true,
      logging: false,
    });
    await dataSource.initialize();
    credRepo = dataSource.getRepository(Credential);
    audit = [];
    controller = new CredentialsController(
      credRepo,
      dataSource,
      {},
      { logActivity: async (params) => { audit.push(params); return params; } },
      {},
      {},
    );
  });

  after(async () => {
    if (dataSource?.isInitialized) await dataSource.destroy();
  });

  beforeEach(async () => {
    audit.length = 0;
    for (const entity of [Credential, Agent, Resource, AgentSessionCliSetting, OutreachChannel]) {
      await dataSource.getRepository(entity).clear();
    }
  });

  async function seed(workspaceId) {
    return credRepo.save(credRepo.create({
      workspace_id: workspaceId,
      board_id: null,
      name: 'Shared PAT',
      description: '',
      provider: 'github',
      encrypted_data: '',
    }));
  }

  it('lets an admin widen a Workspace credential to global, and audits the move', async () => {
    const cred = await seed('ws-a');
    const res = response();
    await controller.update(cred.id, { workspace_id: 'ws-a', scope: 'global' }, adminReq, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.workspace_id, null);
    assert.equal(res.body.scope, 'global');
    assert.equal((await credRepo.findOne({ where: { id: cred.id } })).workspace_id, null);

    const entry = audit.find((a) => a.action === 'credential_scope_changed');
    assert.ok(entry, 'scope change must leave an activity trail');
    assert.equal(entry.old_value, 'workspace:ws-a');
    assert.equal(entry.new_value, 'global');
    assert.equal(entry.actor_id, 'u-admin');
    // The audit row must never carry the secret itself.
    assert.equal(entry.field_changed, 'workspace_id');
  });

  it('lets an admin narrow a global credential into the Workspace being viewed', async () => {
    const cred = await seed(null);
    const res = response();
    await controller.update(cred.id, { workspace_id: 'ws-a', scope: 'workspace' }, adminReq, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.workspace_id, 'ws-a');
    assert.equal(res.body.scope, 'workspace');
  });

  it('refuses to widen when the caller lacks admin.global_credentials', async () => {
    const cred = await seed('ws-a');
    const res = response();
    await controller.update(cred.id, { workspace_id: 'ws-a', scope: 'global' }, memberReq, res);
    assert.equal(res.statusCode, 403);
    assert.match(res.body.error, /admin\.global_credentials/);
    assert.equal((await credRepo.findOne({ where: { id: cred.id } })).workspace_id, 'ws-a');
    assert.equal(audit.length, 0);
  });

  it('still refuses any edit of a global credential from a non-global manager', async () => {
    const cred = await seed(null);
    const res = response();
    await controller.update(cred.id, { workspace_id: 'ws-a', name: 'Renamed' }, memberReq, res);
    assert.equal(res.statusCode, 403);
  });

  it('keeps the current scope when the body omits `scope` (pre-switch clients)', async () => {
    const cred = await seed('ws-a');
    const res = response();
    await controller.update(cred.id, { workspace_id: 'ws-a', name: 'Renamed' }, memberReq, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.workspace_id, 'ws-a');
    assert.equal(res.body.name, 'Renamed');
    assert.equal(audit.length, 0, 'a rename is not a scope change');
  });

  it('does not let a Workspace credential hop straight to another Workspace', async () => {
    const cred = await seed('ws-a');
    const res = response();
    await controller.update(cred.id, { workspace_id: 'ws-b', scope: 'workspace' }, adminReq, res);
    assert.equal(res.statusCode, 404);
    assert.equal((await credRepo.findOne({ where: { id: cred.id } })).workspace_id, 'ws-a');
  });

  it('rejects an unknown scope value instead of silently keeping the old one', async () => {
    const cred = await seed('ws-a');
    const res = response();
    await controller.update(cred.id, { workspace_id: 'ws-a', scope: 'board' }, adminReq, res);
    assert.equal(res.statusCode, 400);
    assert.match(res.body.error, /Unknown scope/);
  });

  describe('narrowing with dependents', () => {
    it('refuses when a dependent outside the destination still points at it', async () => {
      const cred = await seed(null);
      const resourceRepo = dataSource.getRepository(Resource);
      await resourceRepo.save(resourceRepo.create({
        workspace_id: 'ws-b', board_id: null, credential_id: cred.id, name: 'Other repo',
      }));
      const res = response();
      await controller.update(cred.id, { workspace_id: 'ws-a', scope: 'workspace' }, adminReq, res);
      assert.equal(res.statusCode, 409);
      assert.match(res.body.error, /1 resource\(s\)/);
      assert.equal((await credRepo.findOne({ where: { id: cred.id } })).workspace_id, null);
    });

    it('counts an instance-wide dependent (NULL workspace_id) as outside', async () => {
      const cred = await seed(null);
      const agentRepo = dataSource.getRepository(Agent);
      await agentRepo.save(agentRepo.create({
        workspace_id: null, name: 'runtime-host', credential_id: cred.id,
      }));
      const res = response();
      await controller.update(cred.id, { workspace_id: 'ws-a', scope: 'workspace' }, adminReq, res);
      assert.equal(res.statusCode, 409);
      assert.match(res.body.error, /1 agent\(s\)/);
    });

    it('allows the move when every dependent already lives in the destination', async () => {
      const cred = await seed(null);
      const resourceRepo = dataSource.getRepository(Resource);
      await resourceRepo.save(resourceRepo.create({
        workspace_id: 'ws-a', board_id: null, credential_id: cred.id, name: 'Same-workspace repo',
      }));
      const settingRepo = dataSource.getRepository(AgentSessionCliSetting);
      await settingRepo.save(settingRepo.create({
        workspace_id: 'ws-a', manager_id: 'mgr-1', cli: 'claude', credential_id: cred.id,
      }));
      const res = response();
      await controller.update(cred.id, { workspace_id: 'ws-a', scope: 'workspace' }, adminReq, res);
      assert.equal(res.statusCode, 200);
      assert.equal(res.body.workspace_id, 'ws-a');
    });

    it('does not run the dependent check when widening to global', async () => {
      const cred = await seed('ws-a');
      const channelRepo = dataSource.getRepository(OutreachChannel);
      await channelRepo.save(channelRepo.create({
        workspace_id: 'ws-b', credential_id: cred.id, name: 'Elsewhere', kind: 'email',
      }));
      const res = response();
      await controller.update(cred.id, { workspace_id: 'ws-a', scope: 'global' }, adminReq, res);
      assert.equal(res.statusCode, 200, 'widening only ever adds readers');
      assert.equal(res.body.workspace_id, null);
    });
  });
});
