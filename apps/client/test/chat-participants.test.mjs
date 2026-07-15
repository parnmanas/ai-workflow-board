// 채팅 참여자 흐름의 경합/반영 회귀 테스트 (티켓 6dfb5921).
//
// 원본 티켓 141b7414(채팅 참여자 표시·추가)에서 리뷰 중 P2 경합 결함
// — 방 전환 후 늦게 도착한 참여자 재조회 응답이 현재 방 로스터를 덮어씀 —
// 이 발견됐으나, 멀티유저 클라이언트 E2E 하네스가 없어 수동 out-of-order
// 시뮬레이션으로만 회귀 확인했다. 이 테스트가 그 공백을 메운다.
//
// 핵심: 미러(로직 복제)가 아니라 ChatPage.tsx / ParticipantPicker.tsx 가 실제로
// import 하는 participantFlow.ts 를 그대로 구동한다. 그래서 누군가 P2 가드나
// 후보 제외 로직을 컴포넌트에서 제거해도 이 테스트가 실패한다.
//
// 실행:  node --import tsx --test apps/client/test/chat-participants.test.mjs
//   또는 npm test -w client   (레포 루트에서)
// tsx 는 참여자 흐름의 .ts 를 온더플라이 트랜스파일한다. participantFlow.ts 의
// 두 import 는 `import type` 이라 런타임에 지워지므로, React/DOM/jsdom 없이 순수
// 함수만 로드된다 — 별도 test runner·브라우저 불필요.
//
// API mock 모델: 여기엔 실제 네트워크가 없다. 참여자 흐름 함수는 의존성 주입
// (getChatRoom / listChatRooms / setter)을 받으므로, 아래 deferred() 로 응답을
// "임의 순서로" 완료시켜 방 전환 경합을 결정적으로 재현한다. 최소 시드 = 아래
// user()/agent()/roomDetail()/roomListItem() 팩토리가 만드는 인메모리 픽스처.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  makeRefreshActiveRoomParticipants,
  reflectParticipantChange,
  buildAddPeopleCandidates,
  projectParticipants,
  countUserParticipants,
} from '../src/components/chat/utils/participantFlow.ts';

// ─── 테스트 유틸 ──────────────────────────────────────────────────────────────

/** 외부에서 임의 시점에 완료시킬 수 있는 promise (응답 순서 역전 재현용). */
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** 대기 중인 microtask(.then) 를 모두 흘려보낸다 (macrotask 한 틱). */
const flush = () => new Promise((r) => setTimeout(r, 0));

// 최소 시드: 방 상세 wire 참여자 행 (participant_id/participant_type/flat name).
const user = (id, name = id) => ({ participant_id: id, participant_type: 'user', name });
const agent = (id, name = id) => ({ participant_id: id, participant_type: 'agent', name });
const roomDetail = (id, participants) => ({ id, participants });
const roomListItem = (id) => ({ id, type: 'group', name: id, unread_count: 0 });

// ─── 시나리오 1: 방 전환 응답 역전 경합 (P2 stale-response 가드) ──────────────

test('방 A 재조회 진행 중 → B 로 전환 → 응답 역전돼도 B 로스터 유지 (P2 가드)', async () => {
  // ChatPage 상태를 흉내낸 가변 홀더. activeRoomId 는 ref 처럼 "응답 시점" 값을 읽힌다.
  let activeRoomId = 'A';
  const roster = { participants: null, count: null };

  // getChatRoom 응답을 방별로 지연시켜 완료 순서를 테스트가 통제한다.
  const pending = { A: deferred(), B: deferred() };

  const refresh = makeRefreshActiveRoomParticipants({
    getChatRoom: (roomId) => pending[roomId].promise,
    getActiveRoomId: () => activeRoomId,
    isObserver: () => false,
    setRoomParticipants: (ps) => {
      roster.participants = ps;
    },
    setParticipantCount: (n) => {
      roster.count = n;
    },
  });

  // 1) 방 A 에서 참여자 갱신 요청 시작 (예: A 에 참여자 추가) — 아직 응답 전.
  refresh('A');
  // 2) 사용자가 방 B 로 전환하고, B 로스터 갱신 요청도 시작.
  activeRoomId = 'B';
  refresh('B');

  // 3) 응답이 역순으로 도착: B 가 먼저, A 가 늦게.
  pending.B.resolve(roomDetail('B', [user('b1'), user('b2'), agent('bot')]));
  await flush();
  pending.A.resolve(roomDetail('A', [user('a1')]));
  await flush();

  // 늦게 도착한 A 응답은 가드(activeRoomId !== 'A')에 폐기되고 B 로스터가 유지돼야 한다.
  // (가드를 제거하면 A 의 ['a1'] 이 덮어써 이 단언이 깨진다 — load-bearing.)
  assert.deepEqual(
    roster.participants.map((p) => p.id),
    ['b1', 'b2', 'bot'],
    'B 로스터가 늦게 온 A 응답에 덮이지 않아야 한다',
  );
  assert.equal(roster.count, 2, 'B 의 user 참여자 수(2) 유지 — agent 는 카운트 제외');
});

test('제어군: 방 전환이 없으면 그 방의 재조회 응답은 정상 반영된다', async () => {
  let activeRoomId = 'A';
  const roster = { participants: null, count: null };
  const pendingA = deferred();

  const refresh = makeRefreshActiveRoomParticipants({
    getChatRoom: () => pendingA.promise,
    getActiveRoomId: () => activeRoomId,
    isObserver: () => false,
    setRoomParticipants: (ps) => {
      roster.participants = ps;
    },
    setParticipantCount: (n) => {
      roster.count = n;
    },
  });

  refresh('A'); // A 에 머무름 — 전환 없음
  pendingA.resolve(roomDetail('A', [user('a1'), user('a2')]));
  await flush();

  // 가드는 "stale" 응답만 버린다 — 여전히 활성인 방의 응답은 반영해야 한다.
  assert.deepEqual(roster.participants.map((p) => p.id), ['a1', 'a2']);
  assert.equal(roster.count, 2);
});

test('participants 필드 없는 응답은 로스터를 지우지 않는다 (가드 2)', async () => {
  let activeRoomId = 'A';
  const roster = { participants: 'UNSET', count: 'UNSET' };
  const pendingA = deferred();
  const refresh = makeRefreshActiveRoomParticipants({
    getChatRoom: () => pendingA.promise,
    getActiveRoomId: () => activeRoomId,
    isObserver: () => false,
    setRoomParticipants: (ps) => {
      roster.participants = ps;
    },
    setParticipantCount: (n) => {
      roster.count = n;
    },
  });
  refresh('A');
  pendingA.resolve({ id: 'A' }); // participants 누락
  await flush();
  assert.equal(roster.participants, 'UNSET', 'participants 없으면 세터 미호출');
  assert.equal(roster.count, 'UNSET');
});

// ─── 시나리오 2: participant_added / participant_left 반영 ──────────────────────

test('participant_added: 활성 방 로스터 + 방 목록이 함께 갱신된다', async () => {
  let activeRoomId = 'A';
  const captured = { rooms: null, roster: null, count: null };
  const listResult = [roomListItem('A'), roomListItem('B')];

  const refresh = makeRefreshActiveRoomParticipants({
    getChatRoom: (roomId) => Promise.resolve(roomDetail(roomId, [user('a1'), user('a2')])),
    getActiveRoomId: () => activeRoomId,
    isObserver: () => false,
    setRoomParticipants: (ps) => {
      captured.roster = ps;
    },
    setParticipantCount: (n) => {
      captured.count = n;
    },
  });

  let listCalls = 0;
  reflectParticipantChange(
    {
      listChatRooms: () => {
        listCalls++;
        return Promise.resolve(listResult);
      },
      setRooms: (r) => {
        captured.rooms = r;
      },
      getActiveRoomId: () => activeRoomId,
      refreshActiveRoomParticipants: refresh,
    },
    'A', // 이벤트가 발생한 방 == 활성 방
  );

  await flush();
  assert.equal(listCalls, 1, '방 목록 재조회 1회');
  assert.deepEqual(captured.rooms.map((r) => r.id), ['A', 'B'], '방 목록이 갱신 반영');
  assert.deepEqual(captured.roster.map((p) => p.id), ['a1', 'a2'], '활성 방 로스터 재조회 반영');
  assert.equal(captured.count, 2);
});

test('participant_left: 비활성 방 이벤트는 방 목록만 갱신, 활성 로스터는 건드리지 않는다', async () => {
  let activeRoomId = 'A';
  let listCalls = 0;
  let rosterRefreshed = false;

  reflectParticipantChange(
    {
      listChatRooms: () => {
        listCalls++;
        return Promise.resolve([]);
      },
      setRooms: () => {},
      getActiveRoomId: () => activeRoomId,
      refreshActiveRoomParticipants: () => {
        rosterRefreshed = true;
      },
    },
    'B', // 이벤트는 방 B — 하지만 활성 방은 A
  );

  await flush();
  assert.equal(listCalls, 1, '방 목록은 어느 방 이벤트든 항상 재조회');
  assert.equal(rosterRefreshed, false, '상단 로스터는 이벤트 방이 활성일 때만 재조회');
});

// ─── 시나리오 3: 기존 참여자가 Add People 후보에서 제외 ────────────────────────

test('buildAddPeopleCandidates: 기존 참여자·본인·Agent Manager 를 후보에서 제외', () => {
  const users = [
    { id: 'u-self', name: 'Me' },
    { id: 'u1', name: 'Alice' },
    { id: 'u2', name: 'Bob' },
  ];
  const agents = [
    { id: 'a1', name: 'Bot1', type: 'agent' },
    { id: 'a2', name: 'Manager', type: 'manager' }, // 채팅 참가 불가
    { id: 'a3', name: 'Bot3' }, // type 누락 → 매니저 아님 → 포함
  ];

  const out = buildAddPeopleCandidates({
    users,
    agents,
    existingParticipantIds: ['u1', 'a1'], // 방에 이미 있는 사람/에이전트
    currentUserId: 'u-self',
    formatAgentName: (a) => a.name,
  });
  const ids = out.map((p) => p.id);

  assert.ok(!ids.includes('u1'), '기존 참여 user 제외');
  assert.ok(!ids.includes('a1'), '기존 참여 agent 제외');
  assert.ok(!ids.includes('u-self'), '본인 제외');
  assert.ok(!ids.includes('a2'), 'Agent Manager 제외');
  assert.deepEqual(ids, ['u2', 'a3'], '남는 후보는 Bob + Bot3 뿐');

  // 매핑 shape(=PickerParticipant) 도 확인.
  assert.deepEqual(out.find((p) => p.id === 'u2'), { id: 'u2', name: 'Bob', type: 'user' });
  assert.deepEqual(out.find((p) => p.id === 'a3'), { id: 'a3', name: 'Bot3', type: 'agent' });
});

test('buildAddPeopleCandidates: 제외 목록이 비어도 본인만 빠지고 나머지 유지', () => {
  const out = buildAddPeopleCandidates({
    users: [{ id: 'u-self', name: 'Me' }, { id: 'u1', name: 'Alice' }],
    agents: [{ id: 'a1', name: 'Bot', type: 'agent' }],
    currentUserId: 'u-self',
    formatAgentName: (a) => a.name,
  });
  assert.deepEqual(out.map((p) => p.id), ['u1', 'a1']);
});

// ─── 순수 프로젝션 헬퍼 (ChatPage 의 방 변경 effect·refresh 공용) ───────────────

test('projectParticipants / countUserParticipants: wire → 로스터 투영과 user 카운트', () => {
  const detail = roomDetail('A', [user('u1', 'Alice'), agent('bot', 'Bot'), user('u2', 'Bob')]);
  const ps = projectParticipants(detail);
  assert.deepEqual(ps, [
    { id: 'u1', name: 'Alice', type: 'user' },
    { id: 'bot', name: 'Bot', type: 'agent' },
    { id: 'u2', name: 'Bob', type: 'user' },
  ]);
  assert.equal(countUserParticipants(ps), 2, 'user 만 세고 agent 는 제외');
  assert.deepEqual(projectParticipants(null), [], 'null 방어');
  assert.deepEqual(projectParticipants({ id: 'A' }), [], 'participants 누락 방어');
});
