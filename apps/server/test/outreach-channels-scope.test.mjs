// Workspace-scope contract for OutreachChannel CRUD (ticket 2500fea3 step 7) —
// mirrors credentials-scope.test.mjs's shape: a real in-memory sqljs
// DataSource + the controller instantiated directly (no HTTP/NestJS module
// boot), asserting on the plain status()/json() response mock.
//
//   • a credential from a DIFFERENT workspace is rejected on create.
//   • a GLOBAL credential (workspace_id=null) is accepted from any workspace.
//   • a target_board_id from a DIFFERENT workspace is rejected on create.
//   • a channel created in workspace A never appears listing workspace B.
//   • get() 404s for a channel that exists but in a different workspace.
//   • the response never carries `credential_id` (see outreach.controller.ts's
//     channelToJson allowlist) — only a `has_credential` boolean.

import 'reflect-metadata';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { DataSource } from 'typeorm';
import { Workspace } from '../dist/entities/Workspace.js';
import { Board } from '../dist/entities/Board.js';
import { BoardColumn } from '../dist/entities/BoardColumn.js';
import { Ticket } from '../dist/entities/Ticket.js';
import { Comment } from '../dist/entities/Comment.js';
import { Credential } from '../dist/entities/Credential.js';
import { OutreachChannel } from '../dist/entities/OutreachChannel.js';
import { OutreachInboundItem } from '../dist/entities/OutreachInboundItem.js';
import { OutreachChannelService } from '../dist/modules/outreach/outreach-channel.service.js';
import { OutreachPollingService } from '../dist/modules/outreach/outreach-polling.service.js';
import { OutreachController } from '../dist/modules/outreach/outreach.controller.js';

const noopLog = { info() {}, warn() {}, error() {}, debug() {} };

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
      entities: [Workspace, Board, BoardColumn, Ticket, Comment, Credential, OutreachChannel, OutreachInboundItem],
      synchronize: true,
      logging: false,
    });
    await dataSource.initialize();

    const channelRepo = dataSource.getRepository(OutreachChannel);
    const itemRepo = dataSource.getRepository(OutreachInboundItem);
    const credentialRepo = dataSource.getRepository(Credential);
    const boardRepo = dataSource.getRepository(Board);
    // pollingService is only used for computeNextPoll() here (a pure
    // date computation) — its own repo/ingest deps are never exercised.
    const pollingService = new OutreachPollingService(channelRepo, credentialRepo, {}, noopLog);
    const channelService = new OutreachChannelService(channelRepo, itemRepo, credentialRepo, boardRepo, pollingService);
    controller = new OutreachController(channelService);
  });

  after(async () => {
    if (dataSource?.isInitialized) await dataSource.destroy();
  });

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

  it('rejects a target_board_id belonging to a DIFFERENT workspace', async () => {
    const wsRepo = dataSource.getRepository(Workspace);
    const wsA = await wsRepo.save(wsRepo.create({ name: 'ws-board-a' }));
    const wsB = await wsRepo.save(wsRepo.create({ name: 'ws-board-b' }));
    const boardRepo = dataSource.getRepository(Board);
    const boardB = await boardRepo.save(boardRepo.create({ workspace_id: wsB.id, name: 'board-b' }));

    const res = response();
    await controller.create({
      workspace_id: wsA.id, kind: 'github', name: 'channel board scope', target_board_id: boardB.id,
    }, res);
    assert.equal(res.statusCode, 400);
    assert.match(res.body.error, /target_board_id must reference a board in this workspace/);
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
