// Credentials are the one catalog kind whose scope is mutable in place — every
// sibling (resources, functions, QA, actions) answers 400
// "scope cannot be changed after creation". This file pins the three rules that
// make that safe: who may flip it, that a Account credential still cannot
// hop straight to a different Account, and that narrowing a global one is
// refused while dependents live outside the destination.
//
// credentials-scope.test.mjs covers the Global/Account contract of
// list/create; this file covers update()'s scope handling only.

import 'reflect-metadata';
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { DataSource } from 'typeorm';
import { Credential } from '../dist/entities/Credential.js';
import { Resource } from '../dist/entities/Resource.js';
import { Project } from '../dist/entities/Project.js';
import { AgentSessionExecution } from '../dist/entities/AgentSessionExecution.js';
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
      entities: [Credential, Resource, Project, AgentSessionCliSetting, AgentSessionExecution, OutreachChannel],
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
    for (const entity of [Credential, Resource, Project, AgentSessionCliSetting, AgentSessionExecution, OutreachChannel]) {
      await dataSource.getRepository(entity).clear();
    }
  });

  async function seed(accountId) {
    return credRepo.save(credRepo.create({
      account_id: accountId,
      name: 'Shared PAT',
      description: '',
      provider: 'github',
      encrypted_data: '',
    }));
  }

  it('lets an admin widen a Account credential to global, and audits the move', async () => {
    const cred = await seed('ws-a');
    const res = response();
    await controller.update(cred.id, { account_id: 'ws-a', scope: 'global' }, adminReq, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.account_id, null);
    assert.equal(res.body.scope, 'global');
    assert.equal((await credRepo.findOne({ where: { id: cred.id } })).account_id, null);

    const entry = audit.find((a) => a.action === 'credential_scope_changed');
    assert.ok(entry, 'scope change must leave an activity trail');
    assert.equal(entry.old_value, 'workspace:ws-a');
    assert.equal(entry.new_value, 'global');
    assert.equal(entry.actor_id, 'u-admin');
    // The audit row must never carry the secret itself.
    assert.equal(entry.field_changed, 'account_id');
  });

  it('lets an admin narrow a global credential into the Account being viewed', async () => {
    const cred = await seed(null);
    const res = response();
    await controller.update(cred.id, { account_id: 'ws-a', scope: 'account' }, adminReq, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.account_id, 'ws-a');
    assert.equal(res.body.scope, 'account');
  });

  it('refuses to widen when the caller lacks admin.global_credentials', async () => {
    const cred = await seed('ws-a');
    const res = response();
    await controller.update(cred.id, { account_id: 'ws-a', scope: 'global' }, memberReq, res);
    assert.equal(res.statusCode, 403);
    assert.match(res.body.error, /admin\.global_credentials/);
    assert.equal((await credRepo.findOne({ where: { id: cred.id } })).account_id, 'ws-a');
    assert.equal(audit.length, 0);
  });

  it('still refuses any edit of a global credential from a non-global manager', async () => {
    const cred = await seed(null);
    const res = response();
    await controller.update(cred.id, { account_id: 'ws-a', name: 'Renamed' }, memberReq, res);
    assert.equal(res.statusCode, 403);
  });

  it('keeps the current scope when the body omits `scope` (pre-switch clients)', async () => {
    const cred = await seed('ws-a');
    const res = response();
    await controller.update(cred.id, { account_id: 'ws-a', name: 'Renamed' }, memberReq, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.account_id, 'ws-a');
    assert.equal(res.body.name, 'Renamed');
    assert.equal(audit.length, 0, 'a rename is not a scope change');
  });

  it('does not let a Account credential hop straight to another Account', async () => {
    const cred = await seed('ws-a');
    const res = response();
    await controller.update(cred.id, { account_id: 'ws-b', scope: 'account' }, adminReq, res);
    assert.equal(res.statusCode, 404);
    assert.equal((await credRepo.findOne({ where: { id: cred.id } })).account_id, 'ws-a');
  });

  it('rejects an unknown scope value instead of silently keeping the old one', async () => {
    const cred = await seed('ws-a');
    const res = response();
    await controller.update(cred.id, { account_id: 'ws-a', scope: 'board' }, adminReq, res);
    assert.equal(res.statusCode, 400);
    assert.match(res.body.error, /Unknown scope/);
  });

  describe('narrowing with dependents', () => {
    it('refuses when a dependent outside the destination still points at it', async () => {
      const cred = await seed(null);
      const resourceRepo = dataSource.getRepository(Resource);
      await resourceRepo.save(resourceRepo.create({
        account_id: 'ws-b', credential_id: cred.id, name: 'Other repo',
      }));
      const res = response();
      await controller.update(cred.id, { account_id: 'ws-a', scope: 'account' }, adminReq, res);
      assert.equal(res.statusCode, 409);
      assert.match(res.body.error, /1 resource\(s\)/);
      assert.equal((await credRepo.findOne({ where: { id: cred.id } })).account_id, null);
    });

    // Repository Resources became Projects (same id) and keep their clone
    // credential pointer, so a project elsewhere blocks the narrowing too.
    it('counts a Project (former repository Resource) outside the destination as a blocker', async () => {
      const cred = await seed(null);
      const projectRepo = dataSource.getRepository(Project);
      await projectRepo.save(projectRepo.create({
        account_id: 'ws-b', name: 'Other project', repo_url: 'https://github.com/o/r.git', credential_id: cred.id,
      }));
      const res = response();
      await controller.update(cred.id, { account_id: 'ws-a', scope: 'account' }, adminReq, res);
      assert.equal(res.statusCode, 409);
      assert.match(res.body.error, /1 project\(s\)/);
      assert.equal((await credRepo.findOne({ where: { id: cred.id } })).account_id, null);
    });

    it('preserves a different account session when CLI credential defaults have been cleared', async () => {
      const cred = await seed(null);
      const settings = dataSource.getRepository(AgentSessionCliSetting);
      const setting = await settings.save(settings.create({
        account_id: 'ws-b', manager_id: 'host-one', cli: 'claude',
        credential_id: cred.id, default_config: '{}', known_config_options: '[]', updated_by: 'u-admin',
      }));
      const executions = dataSource.getRepository(AgentSessionExecution);
      const execution = await executions.save(executions.create({
        account_id: 'ws-b', manager_id: 'host-one', cli: 'claude', session_id: 'native-session-b',
        credential_id: cred.id, config_defaults: JSON.stringify({ model: 'sonnet', __mode: 'agent' }),
        runtime_profile: JSON.stringify({ id: 'original-backend', kind: 'claude-backend' }),
      }));
      await settings.update(setting.id, { credential_id: null });
      assert.equal(await settings.count({ where: { credential_id: cred.id } }), 0,
        'the pinned execution is the only remaining reference to this credential');

      const res = response();
      await controller.update(cred.id, { account_id: 'ws-a', scope: 'account' }, adminReq, res);
      assert.equal(res.statusCode, 409, 'narrowing includes persisted executions in dependent checks');
      assert.match(res.body.error, /1 pinned session execution\(s\)/);
      assert.equal((await credRepo.findOneByOrFail({ id: cred.id })).account_id, null,
        'the credential remains available to the original account');
      assert.deepEqual(await executions.findOneByOrFail({ id: execution.id }), execution,
        'owner, native session id, credential, config, and backend snapshot remain untouched');
      assert.equal(audit.length, 0, 'a refused scope change leaves no success audit entry');
    });

    // P4c-4: Agent 항목 제거 — instance-wide 종속은 global Resource 로 센다.
    it('counts an instance-wide dependent (NULL account_id) as outside', async () => {
      const cred = await seed(null);
      const resourceRepo = dataSource.getRepository(Resource);
      await resourceRepo.save(resourceRepo.create({
        account_id: null, credential_id: cred.id, name: 'Global repo',
      }));
      const res = response();
      await controller.update(cred.id, { account_id: 'ws-a', scope: 'account' }, adminReq, res);
      assert.equal(res.statusCode, 409);
      assert.match(res.body.error, /1 resource\(s\)/);
    });

    it('allows the move when every dependent already lives in the destination', async () => {
      const cred = await seed(null);
      const resourceRepo = dataSource.getRepository(Resource);
      await resourceRepo.save(resourceRepo.create({
        account_id: 'ws-a', credential_id: cred.id, name: 'Same-workspace repo',
      }));
      const projectRepo = dataSource.getRepository(Project);
      await projectRepo.save(projectRepo.create({
        account_id: 'ws-a', name: 'Same-workspace project', credential_id: cred.id,
      }));
      const settingRepo = dataSource.getRepository(AgentSessionCliSetting);
      await settingRepo.save(settingRepo.create({
        account_id: 'ws-a', manager_id: 'mgr-1', cli: 'claude', credential_id: cred.id,
      }));
      const res = response();
      await controller.update(cred.id, { account_id: 'ws-a', scope: 'account' }, adminReq, res);
      assert.equal(res.statusCode, 200);
      assert.equal(res.body.account_id, 'ws-a');
    });

    it('does not run the dependent check when widening to global', async () => {
      const cred = await seed('ws-a');
      const channelRepo = dataSource.getRepository(OutreachChannel);
      await channelRepo.save(channelRepo.create({
        account_id: 'ws-b', credential_id: cred.id, name: 'Elsewhere', kind: 'email',
      }));
      const res = response();
      await controller.update(cred.id, { account_id: 'ws-a', scope: 'global' }, adminReq, res);
      assert.equal(res.statusCode, 200, 'widening only ever adds readers');
      assert.equal(res.body.account_id, null);
    });
  });
});
