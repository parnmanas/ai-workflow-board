// Workspace-scope contract for OutreachChannel CRUD (ticket 2500fea3 step 7) —
// mirrors credentials-scope.test.mjs's shape: a real in-memory sqljs
// DataSource + the controller instantiated directly (no HTTP/NestJS module
// boot), asserting on the plain status()/json() response mock.
//
//   • a credential from a DIFFERENT workspace is rejected on create.
//   • a GLOBAL credential (workspace_id=null) is accepted from any workspace.
//   • a target_project_id from a DIFFERENT workspace is rejected on create;
//     a same-workspace project + target_tags are stored and echoed back.
//   • a channel created in workspace A never appears listing workspace B.
//   • get() 404s for a channel that exists but in a different workspace.
//   • the response never carries `credential_id` (see outreach.controller.ts's
//     channelToJson allowlist) — only a `has_credential` boolean.

import 'reflect-metadata';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { DataSource } from 'typeorm';
import { Workspace } from '../dist/entities/Workspace.js';
import { Project } from '../dist/entities/Project.js';
import { Ticket } from '../dist/entities/Ticket.js';
import { Comment } from '../dist/entities/Comment.js';
import { Credential } from '../dist/entities/Credential.js';
import { RuntimeHost } from '../dist/entities/RuntimeHost.js';
import { ApiKey } from '../dist/entities/ApiKey.js'; // P4c-4
import { OutreachChannel } from '../dist/entities/OutreachChannel.js';
import { OutreachInboundItem } from '../dist/entities/OutreachInboundItem.js';
import { OutreachChannelService } from '../dist/modules/outreach/outreach-channel.service.js';
import { OutreachPollingService } from '../dist/modules/outreach/outreach-polling.service.js';
import { OutreachController } from '../dist/modules/outreach/outreach.controller.js';

const noopLog = { info() {}, warn() {}, error() {}, debug() {} };
const noQuiesce = { isQuiesced: async () => false };

function response() {
  return {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

describe('Outreach channels — workspace scope contract', () => {
  let dataSource;
  let controller;

  before(async () => {
    dataSource = new DataSource({
      type: 'sqljs',
      entities: [Workspace, Project, Ticket, Comment, Credential, RuntimeHost, ApiKey, OutreachChannel, OutreachInboundItem], // P4c-4
      synchronize: true,
      logging: false,
    });
    await dataSource.initialize();

    const channelRepo = dataSource.getRepository(OutreachChannel);
    const itemRepo = dataSource.getRepository(OutreachInboundItem);
    const credentialRepo = dataSource.getRepository(Credential);
    // pollingService is only used for computeNextPoll() here (a pure
    // date computation) — its own repo/ingest deps are never exercised.
    const pollingService = new OutreachPollingService(channelRepo, credentialRepo, {}, noopLog, noQuiesce);
    // (channel, item, credential, dataSource, polling) — the target project is
    // looked up through dataSource, so no Project repo is injected.
    const channelService = new OutreachChannelService(channelRepo, itemRepo, credentialRepo, dataSource, pollingService);
    controller = new OutreachController(channelService);
  });

  after(async () => {
    if (dataSource?.isInitialized) await dataSource.destroy();
  });

  async function makeRuntime(name) {
    const repo = dataSource.getRepository(RuntimeHost);
    const host = await repo.save(repo.create({ name, hostname: 'outreach-test' }));
    return { manager_agent_id: host.id, cli: 'codex', working_dir: '/tmp/project', folder_scope: 'shared', runtime_config: { strategy: 'single', permission_mode: 'approve' } };
  }

  it('rejects creating a channel with a credential from a DIFFERENT workspace', async () => {
    const wsRepo = dataSource.getRepository(Workspace);
    const wsA = await wsRepo.save(wsRepo.create({ name: 'ws-a' }));
    const wsB = await wsRepo.save(wsRepo.create({ name: 'ws-b' }));
    const credRepo = dataSource.getRepository(Credential);
    const credB = await credRepo.save(credRepo.create({
      workspace_id: wsB.id, name: 'cred-b', provider: 'github', encrypted_data: '',
    }));

    const res = response();
    await controller.create({ workspace_id: wsA.id, kind: 'github', name: 'channel a', credential_id: credB.id }, res);
    assert.equal(res.statusCode, 400);
    assert.match(res.body.error, /not available in this workspace scope/);
  });

  it('allows a GLOBAL credential (workspace_id=null) to attach to any workspace channel', async () => {
    const wsRepo = dataSource.getRepository(Workspace);
    const ws = await wsRepo.save(wsRepo.create({ name: 'ws-global-test' }));
    const credRepo = dataSource.getRepository(Credential);
    const globalCred = await credRepo.save(credRepo.create({
      workspace_id: null, name: 'global-cred', provider: 'github', encrypted_data: '',
    }));

    const res = response();
    await controller.create({ workspace_id: ws.id, kind: 'github', name: 'channel global', credential_id: globalCred.id }, res);
    assert.equal(res.statusCode, 201);
    assert.equal(res.body.has_credential, true);
    assert.equal(res.body.credential_id, undefined, 'credential_id must never appear in the response');
  });

  it('rejects a target_project_id belonging to a DIFFERENT workspace', async () => {
    const wsRepo = dataSource.getRepository(Workspace);
    const wsA = await wsRepo.save(wsRepo.create({ name: 'ws-project-a' }));
    const wsB = await wsRepo.save(wsRepo.create({ name: 'ws-project-b' }));
    const projectRepo = dataSource.getRepository(Project);
    const projectB = await projectRepo.save(projectRepo.create({ workspace_id: wsB.id, name: 'project-b' }));

    const res = response();
    await controller.create({
      workspace_id: wsA.id, kind: 'github', name: 'channel project scope', target_project_id: projectB.id,
    }, res);
    assert.equal(res.statusCode, 400);
    assert.match(res.body.error, /target_project_id must reference a project in this workspace/);
  });

  it('stores a same-workspace target_project_id and normalized target_tags', async () => {
    const wsRepo = dataSource.getRepository(Workspace);
    const ws = await wsRepo.save(wsRepo.create({ name: 'ws-project-ok' }));
    const projectRepo = dataSource.getRepository(Project);
    const project = await projectRepo.save(projectRepo.create({ workspace_id: ws.id, name: 'project-ok' }));

    const res = response();
    await controller.create({
      workspace_id: ws.id, kind: 'github', name: 'channel project ok',
      target_project_id: project.id, target_tags: [' feedback ', 'Feedback', 'mobile'],
    }, res);
    assert.equal(res.statusCode, 201);
    assert.equal(res.body.target_project_id, project.id);
    assert.deepEqual(res.body.target_tags, ['feedback', 'mobile'], 'tags are trimmed and de-duplicated case-insensitively');
    assert.equal(res.body.target_board_id, undefined, 'the board target is gone from the response');

    // Clearing both on update.
    const upd = response();
    await controller.update(res.body.id, { workspace_id: ws.id, target_project_id: null, target_tags: [] }, upd);
    assert.equal(upd.statusCode, 200);
    assert.equal(upd.body.target_project_id, null);
    assert.deepEqual(upd.body.target_tags, []);
  });

  it('rejects a classifier runtime with a credential from another workspace', async () => {
    const wsRepo = dataSource.getRepository(Workspace);
    const wsA = await wsRepo.save(wsRepo.create({ name: 'ws-runtime-a' }));
    const wsB = await wsRepo.save(wsRepo.create({ name: 'ws-runtime-b' }));
    const credRepo = dataSource.getRepository(Credential);
    const credential = await credRepo.save(credRepo.create({ workspace_id: wsB.id, name: 'private', provider: 'codex', encrypted_data: '' }));
    const runtime = { ...await makeRuntime('host-private'), credential_id: credential.id };
    const res = response();
    await controller.create({ workspace_id: wsA.id, kind: 'github', name: 'scoped', classifier_runtime: runtime }, res);
    assert.equal(res.statusCode, 400);
    assert.match(res.body.error, /not available in this workspace scope/);
  });

  it('saves a classifier runtime on a global Host without an Agent row', async () => {
    const wsRepo = dataSource.getRepository(Workspace);
    const ws = await wsRepo.save(wsRepo.create({ name: 'ws-runtime' }));
    const runtime = await makeRuntime('host-classifier');
    const res = response();
    await controller.create({ workspace_id: ws.id, kind: 'github', name: 'runtime', classifier_runtime: runtime }, res);
    assert.equal(res.statusCode, 201);
    assert.equal(res.body.classifier_runtime.manager_agent_id, runtime.manager_agent_id);
    assert.equal(res.body.classifier_agent_id, undefined);
  });

  it('rejects a classifier runtime whose host does not exist', async () => {
    const wsRepo = dataSource.getRepository(Workspace);
    const ws = await wsRepo.save(wsRepo.create({ name: 'ws-missing-host' }));
    const runtime = { ...await makeRuntime('host-unused'), manager_agent_id: 'missing' };
    const res = response();
    await controller.create({ workspace_id: ws.id, kind: 'github', name: 'missing', classifier_runtime: runtime }, res);
    assert.equal(res.statusCode, 400);
  });

  it('a channel created in workspace A is not visible when listing workspace B', async () => {
    const wsRepo = dataSource.getRepository(Workspace);
    const wsA = await wsRepo.save(wsRepo.create({ name: 'ws-list-a' }));
    const wsB = await wsRepo.save(wsRepo.create({ name: 'ws-list-b' }));

    const createRes = response();
    await controller.create({ workspace_id: wsA.id, kind: 'reddit', name: 'reddit channel' }, createRes);
    assert.equal(createRes.statusCode, 201);

    const listResB = response();
    await controller.list(wsB.id, listResB);
    assert.equal(listResB.statusCode, 200);
    assert.equal(listResB.body.length, 0, 'workspace B sees no channels from workspace A');

    const listResA = response();
    await controller.list(wsA.id, listResA);
    assert.equal(listResA.body.some((c) => c.id === createRes.body.id), true, 'workspace A sees its own channel');
  });

  it('get() 404s for a channel that exists but in a different workspace', async () => {
    const wsRepo = dataSource.getRepository(Workspace);
    const wsA = await wsRepo.save(wsRepo.create({ name: 'ws-get-a' }));
    const wsB = await wsRepo.save(wsRepo.create({ name: 'ws-get-b' }));

    const createRes = response();
    await controller.create({ workspace_id: wsA.id, kind: 'github', name: 'gh channel' }, createRes);

    const getRes = response();
    await controller.get(createRes.body.id, wsB.id, getRes);
    assert.equal(getRes.statusCode, 404);
  });
});
