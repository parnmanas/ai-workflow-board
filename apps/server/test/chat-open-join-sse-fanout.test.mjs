// `open_join_changed` SSE 의 수신 범위 — 티켓 995a9519, 리뷰 라운드1 P1-2.
//
// 이 옵션이 바뀔 때 **실제로 영향을 받는 사람은 방 구성원이 아니라 비참여자**다:
// ON 이면 그들에게 방이 새로 보여야 하고, OFF 면 그들의 사이드바에서 사라져야 한다.
// 처음 구현은 다른 chat_room_update 와 같이 `roomMemberFilter` 를 그대로 써서 정작
// 상태가 바뀐 쪽에는 아무것도 보내지 않았고, OFF 뒤에도 새로고침 전까지 닫힌 방을
// 계속 보다가 읽기·발화 403 을 맞았다.
//
// 그래서 이 파일은 **실제 EVENT_TYPES 정의**(dist)를 그대로 구동한다 — map() 으로 봉투를
// 만들고 filter() 로 수신 여부를 판정하는, events.controller 가 하는 그 순서다. 정적
// grep 이 아니라 실제 함수를 돌리므로 필터를 되돌리면 여기서 바로 깨진다.
//
// 워크스페이스 대조는 서버가 아니라 수신 측이 한다. 이 스택에서 users 는 워크스페이스에
// 소속되지 않고(User 엔티티에 멤버십 컬럼이 없다) SSE identity 에도 워크스페이스가 없어
// 동기 필터가 판정할 근거가 없기 때문이다. 그래서 이 파일은 두 겹을 나눠 검증한다:
//   1) 서버 — 이 update type 이 방 구성원 밖의 user 에게도 나가고, workspace_id 를
//      함께 싣는다(수신 측이 대조할 근거). 에이전트에게는 나가지 않는다.
//   2) 클라이언트 — 같은 워크스페이스면 목록을 재조회하고, 다른 워크스페이스면 버린다.
//      (2) 는 apps/client/test/chat-participants.test.mjs 가 담당한다.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST_ROOT = path.resolve(__dirname, '..', 'dist');

const { EVENT_TYPES } = await import(
  'file://' + path.join(DIST_ROOT, 'modules', 'events', 'event-registry.js')
);

const WS = 'ws-1';
const ROOM = 'room-1';
const MEMBER = 'user-member';
const OUTSIDER = 'user-outsider';
const AGENT_MEMBER = 'agent-member';
const AGENT_OTHER = 'agent-other';

function chatRoomUpdateDef() {
  const def = EVENT_TYPES.find((d) => d.eventType === 'chat_room_update');
  assert.ok(def, 'EVENT_TYPES 에 chat_room_update 정의가 있어야 한다');
  return def;
}

/** events.controller 와 같은 순서: map() 으로 봉투를 만든다. */
function envelopeFor(rawEvent) {
  const def = chatRoomUpdateDef();
  const mapped = def.map(rawEvent);
  assert.ok(mapped, 'map() 이 봉투를 만들어야 한다');
  return { def, envelope: { ...mapped, event_type: 'chat_room_update' } };
}

const userIdentity = (userId) => ({ type: 'user', name: userId, userId });
const agentIdentity = (agentId) => ({ type: 'agent', name: agentId, agentId });

/** room-crud.setOpenJoin 이 실제로 emit 하는 모양. */
const openJoinEvent = (openJoin) => ({
  room_id: ROOM,
  update_type: 'open_join_changed',
  open_join: openJoin,
  workspace_id: WS,
  member_ids: new Set([MEMBER]),
  agent_member_ids: new Set([AGENT_MEMBER]),
});

test('open_join_changed 는 방 구성원이 아닌 사용자에게도 전달된다', () => {
  const { def, envelope } = envelopeFor(openJoinEvent(true));

  assert.equal(
    def.filter(envelope, userIdentity(OUTSIDER)),
    true,
    '비참여자야말로 이 변경의 실제 수신 대상이다 — 방이 새로 보여야 한다',
  );
  assert.equal(
    def.filter(envelope, userIdentity(MEMBER)),
    true,
    '참여자도 계속 받는다 (헤더 토글 상태가 다른 탭에서 갱신돼야 한다)',
  );
});

test('OFF 전환도 같은 범위로 나간다 — 사이드바에서 지울 사람이 비참여자다', () => {
  const { def, envelope } = envelopeFor(openJoinEvent(false));
  assert.equal(
    def.filter(envelope, userIdentity(OUTSIDER)),
    true,
    'OFF 를 못 받으면 닫힌 방을 계속 보다가 읽기·발화 403 을 맞는다',
  );
  assert.equal(envelope.payload.open_join, false, '새 값이 그대로 실린다');
});

test('open_join_changed 는 수신 측이 스코프를 판정할 workspace_id 를 싣는다', () => {
  const { envelope } = envelopeFor(openJoinEvent(true));

  assert.equal(
    envelope.payload.workspace_id,
    WS,
    'users 는 워크스페이스에 소속되지 않아 서버 필터가 판정할 수 없다 — 대조 근거를 실어 보내야 한다',
  );
  assert.equal(envelope.scope.workspace_id, WS, '봉투 scope 에도 실린다');

  // 최종 wire bytes 에도 남아야 한다(flatten 이 payload 를 그대로 내보낸다).
  const wire = JSON.stringify(chatRoomUpdateDef().flatten(envelope));
  assert.match(wire, /"workspace_id":"ws-1"/, '직렬화 뒤에도 workspace_id 가 남는다');
  assert.match(wire, /"open_join":true/, '직렬화 뒤에도 open_join 이 남는다');
});

test('open_join_changed 는 에이전트에게는 가지 않는다', () => {
  const { def, envelope } = envelopeFor(openJoinEvent(true));

  // 이 옵션은 사람의 방 목록 가시성에만 관계한다. 에이전트의 발신 규약은 이 값과
  // 무관하게 참여자 행을 그대로 요구하므로, 방 구성원인 에이전트에게도 보내지 않는다.
  assert.equal(def.filter(envelope, agentIdentity(AGENT_MEMBER)), false);
  assert.equal(def.filter(envelope, agentIdentity(AGENT_OTHER)), false);
});

test('나머지 update_type 은 예전 그대로 방 구성원 전용이다 (회귀 없음)', () => {
  // 완화는 open_join_changed 하나에만 적용된다. 이 단언이 없으면 필터를 "user 면 전부
  // 통과"로 넓혀도 위 테스트들이 그대로 통과해, 방 대화의 수신 범위가 조용히 새어 나간다.
  for (const updateType of ['renamed', 'participant_added', 'participant_left', 'read']) {
    const { def, envelope } = envelopeFor({
      room_id: ROOM,
      update_type: updateType,
      new_name: 'x',
      member_ids: new Set([MEMBER]),
      agent_member_ids: new Set([AGENT_MEMBER]),
    });

    assert.equal(
      def.filter(envelope, userIdentity(MEMBER)),
      true,
      `${updateType}: 방 구성원은 받는다`,
    );
    assert.equal(
      def.filter(envelope, userIdentity(OUTSIDER)),
      false,
      `${updateType}: 비참여자는 받지 않는다 — 이 완화는 open_join_changed 전용이다`,
    );
    assert.equal(
      def.filter(envelope, agentIdentity(AGENT_MEMBER)),
      true,
      `${updateType}: 방 구성원 에이전트는 예전처럼 받는다`,
    );
  }
});
