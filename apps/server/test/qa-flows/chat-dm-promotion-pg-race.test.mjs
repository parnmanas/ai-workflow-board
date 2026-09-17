// 회귀 테스트 (Postgres 전용): DM 초대의 동시 추가 경합 — 티켓 70e62a9d.
//
// 왜 sql.js 로는 증명이 안 되는가
// ──────────────────────────────
//
// 막아야 하는 결함은 check-then-insert write skew 다: 두 `addParticipants` 가 동시에
// "이 대상은 아직 없다" 와 "지금 인원은 N 이다" 를 읽고, 둘 다 insert 한다. 결과는
// (a) 같은 대상의 중복 active 행 — `leaveRoom` 주석이 기록한 "방을 나갈 수 없는"
// 상태가 되고, (b) 50인 cap 초과다. `addParticipants` 는 이걸
// `pg_advisory_xact_lock(hashtext('chat_room_participants:<roomId>'))` 로 막는다 —
// 키는 `ensureActiveParticipantInTransaction` 과 **동일**해야 자유 참여 auto-join 과도
// 직렬화된다.
//
// 이 인터리빙은 **진짜 동시 트랜잭션이 있어야만** 재현된다. sql.js 백엔드는 단일 WASM
// 커넥션이고 `db.ts` 의 `serializeSqljsTransactions()` 가 트랜잭션을 FIFO 로 직렬화하므로,
// 겹쳐 호출해도 한쪽이 끝난 뒤 다른 쪽이 시작한다 — 락을 통째로 빼도 통과한다. 그래서
// sqljs 스위트(`test/chat-dm-promotion.test.mjs`)는 **순차 멱등성만** 고정하고, 겹치는
// 트랜잭션을 아예 쓰지 않는다(보드 교훈: sql.js 통과를 PostgreSQL 병렬 보장으로 간주하지
// 않는다). 진짜 경합은 이 파일이 검증한다.
//
// SKIP 규약: `DB_TYPE=postgres` 일 때만 실행된다(CI `test:qa:pg` 매트릭스). 기본 sql.js
// 실행에서는 사유를 남기고 자체 스킵하므로 어디서든 green 이다. 작성 환경(담당자
// 샌드박스)에는 Postgres 가 없으므로 **실제 green 은 pg 매트릭스에서 나와야 한다** —
// `backlog-promotion-pg-slot-race.test.mjs` / `dispatch-intent-pg-race.test.mjs` 가 세운
// 것과 같은 규약이다.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST_ROOT = path.resolve(__dirname, '..', '..', 'dist');

const IS_PG = (process.env.DB_TYPE || 'sqlite') === 'postgres';
const SKIP = IS_PG ? false : 'requires DB_TYPE=postgres (CI test:qa:pg matrix only)';

process.env.PORT = process.env.QA_PG_CHAT_INVITE_PORT || '0';

const PARTICIPANT_CAP = 50;

test('Postgres: DM 초대의 동시 실행이 중복 참여자도 cap 초과도 만들지 않는다', { skip: SKIP }, async (t) => {
  const { bootApp, step } = await import('../helpers/boot.mjs');
  const { createWorkspace, createUser, createAgent } = await import('../helpers/fixtures.mjs');

  step('Boot NestJS app on Postgres (isolated schema)');
  const { app, modules } = await bootApp({ port: parseInt(process.env.PORT, 10) });
  t.after(() => { void app.close().catch(() => {}); });
  const { getDataSourceToken } = modules;

  const membershipModule = await import(
    'file://' + path.join(DIST_ROOT, 'modules', 'chat-rooms', 'room-membership.service.js')
  );
  const membership = app.get(membershipModule.RoomMembershipService);
  const ds = app.get(getDataSourceToken());

  assert.equal(
    ds.driver.options.type, 'postgres',
    '이 파일은 진짜 Postgres 커넥션 풀에서만 의미가 있다 — 드라이버가 postgres 가 아니면 검증이 공허하다',
  );

  const roomRepo = ds.getRepository('ChatRoom');
  const partRepo = ds.getRepository('ChatRoomParticipant');

  const ws = await createWorkspace(app, getDataSourceToken, 'pgchatinvite');
  const alice = await createUser(app, getDataSourceToken, { name: 'alice' });
  const bob = await createUser(app, getDataSourceToken, { name: 'bob' });
  const carol = await createUser(app, getDataSourceToken, { name: 'carol' });
  const bot = await createAgent(app, getDataSourceToken, ws.id, { name: 'bot' });

  /** DM 방 하나를 만들고 주어진 참여자를 active 로 넣는다. */
  async function seedDm(participants) {
    const room = await roomRepo.save(roomRepo.create({
      workspace_id: ws.id, type: 'dm', name: '', last_message_at: null,
    }));
    for (const p of participants) {
      await partRepo.save(partRepo.create({
        room_id: room.id, participant_type: p.type, participant_id: p.id,
        last_read_at: null, left_at: null,
      }));
    }
    return room;
  }

  const activeRows = (roomId, participantId) =>
    partRepo.find({ where: participantId
      ? { room_id: roomId, participant_id: participantId, left_at: null }
      : { room_id: roomId, left_at: null } });

  const invite = (roomId, callerId, targets) =>
    membership.addParticipants(roomId, ws.id, { type: 'user', id: callerId }, targets);

  // ── 케이스 1: 같은 대상을 동시에 초대 ─────────────────────────────────
  step('같은 대상을 두 번 동시 초대 — 중복 active 행이 생기면 안 된다');
  {
    const room = await seedDm([{ type: 'user', id: alice.id }, { type: 'agent', id: bot.id }]);

    const results = await Promise.allSettled([
      invite(room.id, alice.id, [{ participant_type: 'user', participant_id: bob.id }]),
      invite(room.id, alice.id, [{ participant_type: 'user', participant_id: bob.id }]),
    ]);
    const rejected = results.filter(r => r.status === 'rejected');
    assert.deepEqual(
      rejected.map(r => r.reason?.message), [],
      '멱등 경로라 양쪽 모두 성공해야 한다 (한쪽은 아무것도 추가하지 않고 조용히 반환)',
    );

    const dupes = await activeRows(room.id, bob.id);
    assert.equal(
      dupes.length, 1,
      `중복 active 행 ${dupes.length}개 — advisory lock 이 check-then-insert 를 직렬화하지 못했다. ` +
      '이 상태의 사용자는 방을 나갈 수 없다(leaveRoom 이 한 행만 정리하던 회귀와 같은 형태).',
    );
    assert.equal((await activeRows(room.id)).length, 3);
    assert.equal((await roomRepo.findOne({ where: { id: room.id } })).type, 'group');
  }

  // ── 케이스 2: 서로 다른 대상을 동시에 초대 ────────────────────────────
  step('서로 다른 대상을 동시 초대 — 둘 다 들어가고 승격은 한 번만');
  {
    const room = await seedDm([{ type: 'user', id: alice.id }, { type: 'agent', id: bot.id }]);

    await Promise.all([
      invite(room.id, alice.id, [{ participant_type: 'user', participant_id: bob.id }]),
      invite(room.id, alice.id, [{ participant_type: 'user', participant_id: carol.id }]),
    ]);

    assert.equal((await activeRows(room.id, bob.id)).length, 1);
    assert.equal((await activeRows(room.id, carol.id)).length, 1);
    assert.equal((await activeRows(room.id)).length, 4, '기존 2인 + 신규 2인');

    const promoted = await roomRepo.findOne({ where: { id: room.id } });
    assert.equal(promoted.type, 'group');
    assert.ok(
      (promoted.name || '').trim().length > 0,
      '조건부 UPDATE 로 한쪽만 승격하더라도 자동 이름은 채워져 있어야 한다',
    );
  }

  // ── 케이스 3: cap 경계에서의 동시 초대 ────────────────────────────────
  step('49인 방에 서로 다른 신규 1명씩 동시 초대 — cap 50 을 넘기면 안 된다');
  {
    const room = await roomRepo.save(roomRepo.create({
      workspace_id: ws.id, type: 'group', name: 'cap-race', last_message_at: null,
    }));
    await partRepo.save(partRepo.create({
      room_id: room.id, participant_type: 'user', participant_id: alice.id,
      last_read_at: null, left_at: null,
    }));
    // 48명을 더 채워 49명으로 만든다 (초대 호출자 alice 포함).
    const filler = [];
    for (let i = 0; i < 48; i++) {
      filler.push(partRepo.create({
        room_id: room.id, participant_type: 'user',
        participant_id: `aaaaaaaa-0000-4000-8000-${String(i).padStart(12, '0')}`,
        last_read_at: null, left_at: null,
      }));
    }
    await partRepo.save(filler);
    assert.equal((await activeRows(room.id)).length, 49, '사전 조건: 49명');

    const results = await Promise.allSettled([
      invite(room.id, alice.id, [{ participant_type: 'user', participant_id: bob.id }]),
      invite(room.id, alice.id, [{ participant_type: 'user', participant_id: carol.id }]),
    ]);

    const total = (await activeRows(room.id)).length;
    assert.ok(
      total <= PARTICIPANT_CAP,
      `동시 초대가 cap 을 넘겼다 (${total}명) — 둘 다 "지금 49명"을 읽고 각각 insert 한 write skew 다`,
    );
    assert.equal(total, PARTICIPANT_CAP, '한 건은 성공해 정확히 50명이 되어야 한다');
    assert.equal(
      results.filter(r => r.status === 'rejected').length, 1,
      '나머지 한 건은 cap 초과로 거부되어야 한다',
    );
    const rejection = results.find(r => r.status === 'rejected');
    assert.match(rejection.reason.message, /50 participant limit/);
  }
});
