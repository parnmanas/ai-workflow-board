// user_mention SSE 프레임은 **평평(flat)** 해야 한다 — 회귀 가드.
//
// 근본 함정:
//   events.controller 의 프레임 생성은
//       const rawDataObj = def?.flatten ? def.flatten(event) : event;
//   이다. 즉 registry 엔트리에 `flatten` 이 없으면 클라이언트는 payload 가 아니라
//   **봉투 전체**(`{ event_type, scope, payload, timestamp }`)를 받는다.
//
//   `user_mention` 의 유일한 소비자는 웹 UI(useMentions / NotificationContext)이고
//   둘 다 `data.mention_id`, `data.source_type`, `data.preview`, `data.board_id` …
//   를 **top-level 로** 읽는다. flatten 이 빠져 있던 동안 라이브 멘션은 모든 필드가
//   undefined 인 채로 인박스에 꽂혔다:
//     - 행 표시가 "someone · chat · Invalid Date · (no preview)"
//     - source_type 이 undefined → 코멘트/채팅 어느 분기에도 안 걸려 **클릭해도 이동 없음**
//     - id 가 undefined → 두 번째 멘션이 dedup 으로 사라지는데 카운트만 증가 (숫자 불일치)
//     - markRead 가 /api/mentions/undefined/read 로 404
//   REST 로 목록을 다시 받는 새로고침 후에만 정상으로 보여서 "가끔 이상하다" 로 관측됐다.
//
//   TypeScript 는 `flatten` 이 optional 이라 누락을 잡지 못하고, payload-parity
//   가드는 map() 의 필드 커버리지만 본다. 그래서 이 가드가 따로 필요하다.
//
// 이 가드는 registry 정의를 직접 실행해 실제 wire 객체를 만들고, 봉투 키가 아니라
// payload 필드가 top-level 에 있는지 확인한다.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { EVENT_TYPES } = await import('../dist/modules/events/event-registry.js');

const def = EVENT_TYPES.find((d) => d.eventType === 'user_mention');

test('user_mention 정의가 존재하고 flatten 을 갖는다', () => {
  assert.ok(def, 'user_mention 엔트리가 registry 에 없다');
  assert.equal(
    typeof def.flatten,
    'function',
    'user_mention 에 flatten 이 없으면 클라이언트가 봉투를 받아 모든 필드가 undefined 가 된다',
  );
});

test('flatten 결과는 웹 UI 가 읽는 필드를 top-level 로 노출한다', () => {
  const emitted = {
    mention_id: 'm-1',
    user_id: 'u-1',
    workspace_id: 'ws-1',
    source_type: 'comment',
    source_id: 'c-1',
    ticket_id: 't-1',
    board_id: 'b-1',
    room_id: null,
    actor_id: 'u-2',
    actor_type: 'user',
    actor_name: '박민수',
    preview: '@[user:u-1|나] 확인 부탁',
    created_at: '2026-08-18T00:00:00.000Z',
  };

  const envelope = def.map(emitted);
  const frame = def.flatten({ ...envelope, event_type: 'user_mention', timestamp: emitted.created_at });

  // 봉투가 그대로 새어나오면 안 된다.
  assert.equal(frame.payload, undefined, 'frame 에 payload 키가 남아 있으면 봉투가 노출된 것이다');
  assert.equal(frame.scope, undefined, 'frame 에 scope 키가 남아 있으면 봉투가 노출된 것이다');

  // 클라이언트가 실제로 읽는 필드들(useMentions / NotificationContext.mentionTarget).
  for (const key of [
    'mention_id',
    'user_id',
    'workspace_id',
    'source_type',
    'source_id',
    'ticket_id',
    'board_id',
    'room_id',
    'actor_name',
    'preview',
    'created_at',
  ]) {
    assert.ok(key in frame, `flatten 결과에 ${key} 가 top-level 로 없다 — UI 가 undefined 를 읽는다`);
  }

  assert.equal(frame.mention_id, 'm-1');
  assert.equal(frame.source_type, 'comment');
  assert.equal(frame.board_id, 'b-1');
  assert.equal(frame.preview, '@[user:u-1|나] 확인 부탁');
});

test('코멘트 멘션은 board_id 를, 채팅 멘션은 room_id 를 실어 보낸다 (딥링크 분기 근거)', () => {
  const chat = def.flatten({
    ...def.map({
      mention_id: 'm-2',
      user_id: 'u-1',
      workspace_id: 'ws-1',
      source_type: 'chat_message',
      source_id: 'msg-1',
      ticket_id: null,
      board_id: null,
      room_id: 'r-1',
      actor_id: 'u-2',
      actor_type: 'user',
      actor_name: '박민수',
      preview: '안녕',
      created_at: '2026-08-18T00:00:00.000Z',
    }),
    event_type: 'user_mention',
    timestamp: '2026-08-18T00:00:00.000Z',
  });

  assert.equal(chat.source_type, 'chat_message');
  assert.equal(chat.room_id, 'r-1');
  assert.equal(chat.board_id, null);
});
