// 자료실(LibraryItem) — 파일 바이트는 Resource에, 겉장은 여기.
//
// 고정하는 것:
//   1. 목록·생성·최신·삭제는 전부 워크스페이스 멤버십으로 막힌다 — 멤버가 아니면 403.
//   2. 생성은 같은 워크스페이스의 업로드된 파일에만 묶인다. 남의 파일을 갖다 붙이면 400.
//   3. kind 생략 시 .apk는 'app'이다. latest는 그 워크스페이스의 가장 최근 app 하나.
//   4. 목록·생성 응답에 file_data는 절대 안 싣는다(크기만). 다운로드는 /raw?download=1.
//   5. 삭제는 올린 본인 또는 admin만. 딸린 library_file Resource도 함께 거둔다.
//
// 실행: node --test test/library.test.mjs (dist 필요)

import 'reflect-metadata';
import assert from 'node:assert/strict';
import { before, after, describe, it } from 'node:test';
import { DataSource } from 'typeorm';
import { LibraryItem } from '../dist/entities/LibraryItem.js';
import { Resource } from '../dist/entities/Resource.js';
import { LibraryController } from '../dist/modules/library/library.controller.js';

function response() {
  return {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

const adminReq = { currentUser: { id: 'u-admin', role: 'admin' } };
const memberReq = { currentUser: { id: 'u-member', role: 'user' } };
const strangerReq = { currentUser: { id: 'u-stranger', role: 'user' } };

// u-member는 ws-a의 member, u-stranger는 아무 데도 없다.
const members = new Set(['u-member:ws-a']);
const fakeRebac = {
  check: async (sub, _rel, obj) => members.has(`${sub.id}:${obj.id}`),
};

function makeResource(repo, accountId, fileName, bytes) {
  return repo.save(repo.create({
    account_id: accountId,
    credential_id: null,
    name: fileName,
    description: '',
    type: 'library_file',
    url: '',
    content: '',
    file_data: Buffer.from(bytes).toString('base64'),
    file_name: fileName,
    file_mimetype: 'application/octet-stream',
    tags: '[]',
  }));
}

describe('Library (자료실)', () => {
  let dataSource;
  let controller;
  let libRepo;
  let resRepo;

  before(async () => {
    dataSource = new DataSource({
      type: 'sqljs',
      entities: [LibraryItem, Resource],
      synchronize: true,
      logging: false,
    });
    await dataSource.initialize();
    libRepo = dataSource.getRepository(LibraryItem);
    resRepo = dataSource.getRepository(Resource);
    controller = new LibraryController(libRepo, resRepo, fakeRebac);
  });

  after(async () => {
    if (dataSource?.isInitialized) await dataSource.destroy();
  });

  it('멤버가 아니면 목록도 생성도 403이다', async () => {
    const list = response();
    await controller.list('ws-a', strangerReq, list);
    assert.equal(list.statusCode, 403);
    const create = response();
    await controller.create({ account_id: 'ws-a', resource_id: 'x', title: 't' }, strangerReq, create);
    assert.equal(create.statusCode, 403);
    const missing = response();
    await controller.list('', memberReq, missing);
    assert.equal(missing.statusCode, 400);
  });

  it('올린 파일을 자료로 묶는다 — .apk는 kind app, file_data는 응답에 없다', async () => {
    const res = await makeResource(resRepo, 'ws-a', 'awb.apk', 'fake-apk-bytes');
    const out = response();
    await controller.create(
      { account_id: 'ws-a', resource_id: res.id, title: 'AWB Android', version: '1.0' },
      memberReq,
      out,
    );
    assert.equal(out.statusCode, 201);
    assert.equal(out.body.kind, 'app');
    assert.equal(out.body.version, '1.0');
    assert.equal(out.body.file_name, 'awb.apk');
    assert.ok(out.body.size > 0);
    assert.equal(out.body.file_data, undefined);
  });

  it('남의 워크스페이스 파일·없는 파일로는 묶지 못한다', async () => {
    const other = await makeResource(resRepo, 'ws-b', 'other.apk', 'x');
    const mismatch = response();
    await controller.create(
      { account_id: 'ws-a', resource_id: other.id, title: 't' },
      memberReq,
      mismatch,
    );
    assert.equal(mismatch.statusCode, 400);
    const gone = response();
    await controller.create(
      { account_id: 'ws-a', resource_id: 'no-such-id', title: 't' },
      memberReq,
      gone,
    );
    assert.equal(gone.statusCode, 400);
  });

  it('latest는 가장 최근 app 하나 — 없으면 404', async () => {
    const empty = response();
    await controller.latestApp('ws-empty', adminReq, empty);
    assert.equal(empty.statusCode, 404);

    const oldRes = await makeResource(resRepo, 'ws-a', 'old.apk', 'old');
    const oldOut = response();
    await controller.create({ account_id: 'ws-a', resource_id: oldRes.id, title: 'AWB', version: '0.9' }, memberReq, oldOut);
    await libRepo.update({ id: oldOut.body.id }, { created_at: new Date('2026-01-01T00:00:00Z') });

    const latest = response();
    await controller.latestApp('ws-a', memberReq, latest);
    assert.equal(latest.statusCode, 200);
    assert.equal(latest.body.version, '1.0');
  });

  it('삭제는 올린 본인 또는 admin만 — 딸린 파일도 함께 거둔다', async () => {
    const res = await makeResource(resRepo, 'ws-a', 'del.apk', 'del');
    const created = response();
    await controller.create({ account_id: 'ws-a', resource_id: res.id, title: 'Del' }, memberReq, created);

    const denied = response();
    await controller.remove(created.body.id, 'ws-a', strangerReq, denied);
    assert.equal(denied.statusCode, 403);

    const ok = response();
    await controller.remove(created.body.id, 'ws-a', memberReq, ok);
    assert.equal(ok.statusCode, 200);
    assert.equal(await libRepo.findOne({ where: { id: created.body.id } }), null);
    assert.equal(await resRepo.findOne({ where: { id: res.id } }), null);

    const res2 = await makeResource(resRepo, 'ws-a', 'del2.apk', 'del2');
    const created2 = response();
    await controller.create({ account_id: 'ws-a', resource_id: res2.id, title: 'Del2' }, memberReq, created2);
    const adminOk = response();
    await controller.remove(created2.body.id, 'ws-a', adminReq, adminOk);
    assert.equal(adminOk.statusCode, 200);
  });
});
