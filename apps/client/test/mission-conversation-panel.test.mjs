// Mission 대화 패널 렌더링 회귀 테스트 (티켓 4d065f82).
//
// 보드 교훈 1번을 따른다: 사용자 동작 뒤의 화면 상태가 완료 기준이므로 소스 문자열
// 검사가 아니라 **실제 컴포넌트를 jsdom 에 마운트해** 단언한다. `{cond && <div/>}`
// 가 false 로 접혀 조용히 사라지는 실버그가 이 저장소에 이미 있었다
// (orchestration-plan-graph-view.test.mjs 헤더 참고).
//
// 커버 범위:
//   • 대화 메시지와 실행 이벤트가 **서로 다른 렌더러**로, 시간순으로 엮여 나온다
//   • 사용자가 보낸 메시지가 POST 응답과 SSE 브로드캐스트로 중복 도착해도 한 번만 그려진다
//   • SSE 로 도착한 다른 방 메시지는 이 패널에 새지 않는다
//   • 참여자가 아니면 observer 로 강등되고 입력창 대신 사유가 표시된다
//   • 종료된 미션은 입력창이 없고 기록 보존 안내가 나온다
//   • 미션이 시작 전(room 없음)이면 안내만 나오고 조회를 시도하지 않는다
//   • 긴 로그는 창 크기로 bounded 되고, 위로 스크롤하면 커서로 과거를 이어 붙인다
//   • 과거 페이지를 여러 장 넘겨도 가장 오래된 페이지가 실제로 렌더링된다(창이 뒤로 밀린다)
//   • bare 멘션이 참여자 로스터로 해석돼 pill 로 렌더링된다
//   • 참여자는 읽음 처리되고 관전자는 남의 방 읽음을 건드리지 않는다
//   • needs_recovery step 이 "Waiting" 으로 조용히 오표시되지 않는다

import test from 'node:test';
import assert from 'node:assert/strict';
import { setupDom, React, act } from './helpers/jsdom.mjs';
import { installFakeEventSource, mountWithBoardStream } from './helpers/boardStream.mjs';
import { api } from '../src/api.ts';
import Panel from '../src/components/orchestration/MissionConversationPanel.tsx';

const h = React.createElement;

// ─── 픽스처 ───────────────────────────────────────────────────────────────────

const ROOM = 'room-mission-1';

function msg(id, content, overrides = {}) {
  return {
    id,
    room_id: ROOM,
    content,
    sender_type: 'user',
    sender_id: 'user-1',
    sender_name: 'Operator',
    type: 'text',
    attachments: [],
    created_at: '2026-06-01T00:00:10.000Z',
    ...overrides,
  };
}

function evt(id, type, message, createdAt) {
  return {
    id,
    type,
    step_id: null,
    step_key: '',
    actor_type: 'system',
    actor_id: '',
    actor_name: '',
    message,
    data: null,
    created_at: createdAt,
  };
}

/**
 * 패널 하나를 실제 BoardStreamProvider 아래에 띄우고, 정리까지 책임진다.
 * `getChatRoomMessages` 만 스텁하면 되므로 별도 DI 를 만들지 않고 api 모듈에 직접
 * 대입한다(이 저장소의 smoke-ticket-artifact-realtime.test.mjs 와 같은 관례).
 */
async function withPanel({ props, getChatRoomMessages, getChatRoom, listOrchestrationMissionEvents }, body) {
  const dom = setupDom({ width: 1280 });
  const { FakeEventSource, uninstall } = installFakeEventSource();
  globalThis.localStorage = dom.window.localStorage;
  localStorage.setItem('auth_token', 'test-token');

  const originals = {
    getChatRoomMessages: api.getChatRoomMessages,
    getChatRoom: api.getChatRoom,
    markChatRoomRead: api.markChatRoomRead,
    listOrchestrationMissionEvents: api.listOrchestrationMissionEvents,
  };
  const readCalls = [];
  const eventPageCalls = [];
  if (getChatRoomMessages) api.getChatRoomMessages = getChatRoomMessages;
  api.getChatRoom = getChatRoom ?? (async () => ({ participants: [] }));
  api.markChatRoomRead = async (roomId) => {
    readCalls.push(roomId);
  };
  api.listOrchestrationMissionEvents =
    listOrchestrationMissionEvents ??
    (async (_id, _ws, opts) => {
      eventPageCalls.push(opts);
      return { events: [], has_more: false, next_cursor: null };
    });

  try {
    // 실제 App 트리와 같은 순서(AuthProvider 바깥 > BoardStreamProvider 안쪽)로 띄운다 —
    // 패널이 로그인 사용자 id 로 "내 메시지"를 가르므로 AuthProvider 가 필요하다.
    const view = mountWithBoardStream(h(Panel, props), { withAuth: true });
    await settle();
    await body({ view, es: () => FakeEventSource.instances[0], readCalls, eventPageCalls });
    view.unmount();
  } finally {
    Object.assign(api, originals);
    uninstall();
    dom.cleanup();
  }
}

/** effect 안의 promise 들이 정착할 때까지 microtask 큐를 비운다. */
async function settle() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

function textOf(container) {
  return container.textContent || '';
}

// ─── 테스트 ───────────────────────────────────────────────────────────────────

test('대화 메시지와 실행 이벤트가 서로 다른 렌더러로 시간순으로 엮인다', async () => {
  await withPanel(
    {
      props: {
        missionId: 'mission-1',
        workspaceId: 'ws-1',
        roomId: ROOM,
        live: true,
        events: [
          evt('e1', 'step_dispatched', 'Step "api" dispatched', '2026-06-01T00:00:20.000Z'),
          evt('e2', 'step_completed', 'Worker reported "api" as done', '2026-06-01T00:00:40.000Z'),
        ],
      },
      getChatRoomMessages: async () => [
        msg('m1', '이 미션 지금 어디까지 됐어?', { created_at: '2026-06-01T00:00:10.000Z' }),
        msg('m2', 'api 먼저 끝내줘', { created_at: '2026-06-01T00:00:30.000Z' }),
      ],
    },
    async ({ view }) => {
      const runs = view.container.querySelectorAll('[data-testid="mission-execution-run"]');
      const events = view.container.querySelectorAll('[data-testid="mission-execution-event"]');

      assert.equal(events.length, 2, '두 실행 이벤트가 모두 렌더링돼야 한다');
      assert.equal(
        runs.length,
        2,
        '두 이벤트 사이에 대화(00:00:30)가 끼어 있으므로 실행 구간이 두 덩어리로 나뉜다 — 시간순으로 엮인다는 증거',
      );

      // 실행 이벤트는 채팅 말풍선이 아니라 전용 렌더러로 나온다.
      assert.deepEqual(
        [...events].map((el) => el.getAttribute('data-event-type')),
        ['step_dispatched', 'step_completed'],
      );

      const text = textOf(view.container);
      assert.ok(text.includes('이 미션 지금 어디까지 됐어?'), '대화 메시지가 화면에 있어야 한다');
      assert.ok(text.includes('Step "api" dispatched'), '실행 이벤트가 화면에 있어야 한다');
    },
  );
});

test('POST 응답과 SSE 브로드캐스트로 같은 메시지가 두 번 와도 한 번만 그려진다', async () => {
  await withPanel(
    {
      props: { missionId: 'mission-1', workspaceId: 'ws-1', roomId: ROOM, live: true, events: [] },
      getChatRoomMessages: async () => [],
    },
    async ({ view, es }) => {
      const sent = msg('dup-1', '중복되면 안 되는 지시');
      const source = es();
      assert.ok(source, 'BoardStreamProvider 가 EventSource 를 연다');

      await act(async () => {
        source.emit('chat_room_message', sent);
        await Promise.resolve();
      });
      await act(async () => {
        source.emit('chat_room_message', sent);
        await Promise.resolve();
      });
      await settle();

      const occurrences = textOf(view.container).split('중복되면 안 되는 지시').length - 1;
      assert.equal(occurrences, 1, '같은 id 의 메시지는 몇 번 도착하든 한 번만 그려져야 한다');
    },
  );
});

test('다른 방의 SSE 메시지는 이 패널에 새지 않는다', async () => {
  await withPanel(
    {
      props: { missionId: 'mission-1', workspaceId: 'ws-1', roomId: ROOM, live: true, events: [] },
      getChatRoomMessages: async () => [],
    },
    async ({ view, es }) => {
      await act(async () => {
        es().emit('chat_room_message', msg('other-1', '남의 방 메시지', { room_id: 'room-other' }));
        await Promise.resolve();
      });
      await settle();

      assert.ok(
        !textOf(view.container).includes('남의 방 메시지'),
        '미션 room 이 아닌 메시지가 새어 들어오면 대화가 미션에 귀속된다는 계약이 깨진다',
      );
    },
  );
});

test('참여자가 아니면 observer 로 강등되고 입력창 대신 사유가 표시된다', async () => {
  const observerFlags = [];
  await withPanel(
    {
      props: { missionId: 'mission-1', workspaceId: 'ws-1', roomId: ROOM, live: true, events: [] },
      getChatRoomMessages: async (_roomId, _limit, _before, observer) => {
        observerFlags.push(!!observer);
        if (!observer) throw new Error('not a participant of this room');
        return [msg('m1', '관전으로 읽는 메시지')];
      },
    },
    async ({ view }) => {
      assert.deepEqual(
        observerFlags,
        [false, true],
        '먼저 참여자로 시도하고, 거부될 때만 관전으로 재시도해야 한다',
      );
      assert.ok(
        view.container.querySelector('[data-testid="mission-conversation-observer-notice"]'),
        '권한이 없으면 조용히 빈 패널이 아니라 사유가 보여야 한다',
      );
      assert.ok(textOf(view.container).includes('관전으로 읽는 메시지'), '읽기는 가능해야 한다');
      assert.equal(
        view.container.querySelector('textarea'),
        null,
        '읽기 전용인데 입력창이 살아 있으면 보내지지 않는 지시를 쓰게 된다',
      );
    },
  );
});

test('종료된 미션은 입력창 없이 기록 보존 안내를 보여준다', async () => {
  await withPanel(
    {
      props: { missionId: 'mission-1', workspaceId: 'ws-1', roomId: ROOM, live: false, events: [] },
      getChatRoomMessages: async () => [msg('m1', '완료 전 마지막 지시')],
    },
    async ({ view }) => {
      assert.ok(
        view.container.querySelector('[data-testid="mission-conversation-closed-notice"]'),
        '종료된 미션에는 보낼 orchestrator 세션이 없으므로 안내가 나와야 한다',
      );
      assert.equal(
        view.container.querySelector('textarea'),
        null,
        '종료된 미션에서 입력창이 살아 있으면 사용자가 허공에 지시를 보낸다',
      );
      assert.ok(
        textOf(view.container).includes('완료 전 마지막 지시'),
        '재시작·종료 후에도 기록은 그대로 보존돼 보여야 한다',
      );
    },
  );
});

test('아직 시작되지 않은 미션은 조회를 시도하지 않고 안내만 보여준다', async () => {
  let called = 0;
  await withPanel(
    {
      props: { missionId: 'mission-1', workspaceId: 'ws-1', roomId: null, live: true, events: [] },
      getChatRoomMessages: async () => {
        called += 1;
        return [];
      },
    },
    async ({ view }) => {
      assert.equal(called, 0, 'room 이 없는데 조회하면 매번 404 를 두드린다');
      assert.ok(textOf(view.container).includes('아직 시작되지 않아'));
    },
  );
});

test('긴 실행 로그는 창 크기까지만 DOM 에 유지한다', async () => {
  const many = Array.from({ length: 500 }, (_, i) =>
    evt(`e${i}`, 'step_progress', `progress ${i}`, new Date(Date.UTC(2026, 5, 1, 0, 0, i)).toISOString()),
  );

  await withPanel(
    {
      props: { missionId: 'mission-1', workspaceId: 'ws-1', roomId: ROOM, live: true, events: many },
      getChatRoomMessages: async () => [],
    },
    async ({ view }) => {
      const rendered = view.container.querySelectorAll('[data-testid="mission-execution-event"]').length;
      assert.ok(rendered > 0, '이벤트가 있으면 뭔가는 보여야 한다');
      assert.ok(
        rendered < many.length,
        `500건을 전부 그리면 긴 미션에서 패널이 멈춘다 (렌더링된 수: ${rendered})`,
      );
      // 잘라내되 **최신** 쪽을 남겨야 운영자가 지금 상황을 본다.
      assert.ok(
        textOf(view.container).includes('progress 499'),
        '가장 최근 이벤트가 잘려나가면 지금 무슨 일이 벌어지는지 볼 수 없다',
      );
    },
  );
});

test('위로 스크롤하면 커서로 과거 실행 이벤트를 이어 붙인다', async () => {
  // 잘라내기만 하고 이전 이력을 가져올 방법이 없으면 그건 pagination 이 아니라 그냥 손실이다.
  // detail 응답 자체가 bounded window 이므로 이 경로가 유일한 과거 접근 수단이다.
  const firstPage = Array.from({ length: 100 }, (_, i) =>
    evt(`recent-${i}`, 'step_progress', `recent ${i}`, new Date(Date.UTC(2026, 5, 1, 1, 0, i)).toISOString()),
  );
  const older = Array.from({ length: 3 }, (_, i) =>
    evt(`older-${i}`, 'note', `older ${i}`, new Date(Date.UTC(2026, 5, 1, 0, 0, i)).toISOString()),
  );

  await withPanel(
    {
      props: { missionId: 'mission-1', workspaceId: 'ws-1', roomId: ROOM, live: true, events: firstPage },
      getChatRoomMessages: async () => [],
      // 서버는 최신 → 과거 순으로 돌려준다.
      listOrchestrationMissionEvents: async (id, ws, opts) => {
        assert.equal(id, 'mission-1');
        assert.equal(ws, 'ws-1');
        assert.ok(opts.before_at, '커서 없이 부르면 같은 페이지를 무한히 다시 가져온다');
        assert.equal(
          typeof opts.before_seq,
          'number',
          'created_at 만으로 커서를 만들면 같은 초에 몰린 이벤트가 페이지 경계에서 통째로 누락된다',
        );
        return { events: [...older].reverse(), has_more: false, next_cursor: null };
      },
    },
    async ({ view }) => {
      const scroller = view.container.querySelector('[data-testid="mission-conversation-scroll"]');
      assert.ok(scroller, '스크롤 컨테이너가 있어야 위로 올려 과거를 부를 수 있다');

      await act(async () => {
        scroller.scrollTop = 0;
        scroller.dispatchEvent(new window.Event('scroll', { bubbles: true }));
        await Promise.resolve();
      });
      await settle();

      const text = textOf(view.container);
      assert.ok(text.includes('older 0'), '커서로 가져온 과거 이벤트가 화면에 붙어야 한다');
      assert.ok(text.includes('older 2'));
    },
  );
});

test('과거 페이지를 여러 장 넘겨도 가장 오래된 페이지가 실제로 렌더링된다 (창이 뒤로 밀린다)', async () => {
  // 라운드1 테스트는 100+3=103 건만 써서 창 상한(200)을 **넘지 않았고**, 그래서
  // `slice(-200)` 이 과거를 즉시 버리는 버그를 놓쳤다. 여기서는 상한을 확실히 넘겨
  // 3페이지 이상 거슬러 올라간다.
  const firstPage = Array.from({ length: 100 }, (_, i) =>
    evt(`recent-${i}`, 'step_progress', `recent ${i}`, new Date(Date.UTC(2026, 5, 1, 3, 0, i)).toISOString()),
  );
  // 서버가 돌려줄 과거 페이지 3장(오래된 것부터 p0 → p1 → p2 순서로 거슬러 올라간다).
  const pages = [
    Array.from({ length: 100 }, (_, i) =>
      evt(`p1-${i}`, 'note', `page1 ${i}`, new Date(Date.UTC(2026, 5, 1, 2, 0, i)).toISOString()),
    ),
    Array.from({ length: 100 }, (_, i) =>
      evt(`p2-${i}`, 'note', `page2 ${i}`, new Date(Date.UTC(2026, 5, 1, 1, 0, i)).toISOString()),
    ),
    Array.from({ length: 100 }, (_, i) =>
      evt(`p3-${i}`, 'note', `page3 ${i}`, new Date(Date.UTC(2026, 5, 1, 0, 0, i)).toISOString()),
    ),
  ];
  let served = 0;

  await withPanel(
    {
      props: { missionId: 'mission-1', workspaceId: 'ws-1', roomId: ROOM, live: true, events: firstPage },
      getChatRoomMessages: async () => [],
      listOrchestrationMissionEvents: async () => {
        const page = pages[served] ?? [];
        served += 1;
        return {
          events: [...page].reverse(), // 서버는 최신 → 과거 순
          has_more: served < pages.length,
          next_cursor: { at: page[0].created_at, seq: 0 },
        };
      },
    },
    async ({ view }) => {
      const scroller = view.container.querySelector('[data-testid="mission-conversation-scroll"]');
      const scrollUp = async () => {
        await act(async () => {
          scroller.scrollTop = 0;
          scroller.dispatchEvent(new window.Event('scroll', { bubbles: true }));
          await Promise.resolve();
        });
        await settle();
      };

      await scrollUp();
      await scrollUp();
      await scrollUp();

      assert.equal(served, 3, '세 페이지를 모두 불러와야 이 경계를 검증할 수 있다');

      const text = textOf(view.container);
      assert.ok(
        text.includes('page3 0'),
        '가장 오래된 페이지가 렌더링되지 않으면 창이 뒤로 밀리지 않은 것이다 — 사용자는 최신 N건 너머를 영원히 볼 수 없다',
      );

      const rendered = view.container.querySelectorAll('[data-testid="mission-execution-event"]').length;
      assert.ok(
        rendered <= 200,
        `DOM 상한은 유지돼야 한다 (렌더링된 수: ${rendered})`,
      );
      assert.ok(
        !text.includes('recent 99'),
        '과거를 파고 있으면 반대쪽(최신) 끝을 버려야 상한 안에서 과거를 볼 수 있다',
      );
    },
  );
});

test('첫 페이지가 창보다 작으면 과거를 더 부르지 않는다', async () => {
  // has_more 판정을 안 하면 스크롤할 때마다 서버를 두드린다.
  await withPanel(
    {
      props: {
        missionId: 'mission-1',
        workspaceId: 'ws-1',
        roomId: ROOM,
        live: true,
        events: [evt('only-1', 'note', '유일한 이벤트', '2026-06-01T00:00:00.000Z')],
      },
      getChatRoomMessages: async () => [],
    },
    async ({ view, eventPageCalls }) => {
      const scroller = view.container.querySelector('[data-testid="mission-conversation-scroll"]');
      await act(async () => {
        scroller.scrollTop = 0;
        scroller.dispatchEvent(new window.Event('scroll', { bubbles: true }));
        await Promise.resolve();
      });
      await settle();

      assert.equal(eventPageCalls.length, 0, '가져올 과거가 없는데 요청하면 스크롤마다 서버를 두드린다');
    },
  );
});

test('참여자 로스터가 있어야 bare 멘션이 pill 로 해석된다', async () => {
  // 구조화 토큰 `@[user:id|이름]` 은 표시명을 자기가 들고 있어 로스터 없이도 pill 이 된다.
  // 로스터가 실제로 갈리는 지점은 **bare `@name`** 이다 — 참여자와 이름이 맞아야 pill 이
  // 되고, 못 맞추면 "unresolved" 무채색 평문으로 떨어진다(markdown.tsx Step 1c).
  // 그래서 이 테스트는 bare 형태로 단언한다. 구조화 토큰으로 쓰면 로스터를 떼도 통과해
  // 아무것도 지키지 못한다(실제로 그렇게 썼다가 변이 검증에서 걸렀다).
  await withPanel(
    {
      props: { missionId: 'mission-1', workspaceId: 'ws-1', roomId: ROOM, live: true, events: [] },
      getChatRoomMessages: async () => [msg('m1', '@jeongmin 이 부분 확인 부탁해요')],
      getChatRoom: async () => ({
        participants: [
          { participant_id: 'user-9', participant_type: 'user', name: 'jeongmin' },
          { participant_id: 'user-1', participant_type: 'user', name: 'Operator' },
        ],
      }),
    },
    async ({ view }) => {
      const pill = view.container.querySelector('[aria-label="Mention: @jeongmin"]');
      assert.ok(
        pill,
        '로스터를 넘기지 않으면 멘션이 pill 이 아니라 무채색 평문으로 떨어진다 — 기존 Chat 의 멘션 UX 재사용이 성립하지 않는다',
      );
      assert.ok(textOf(view.container).includes('이 부분 확인 부탁해요'), '본문도 함께 렌더링돼야 한다');
    },
  );
});

test('참여자로 열면 읽음 처리하고, 관전자는 남의 방 읽음을 건드리지 않는다', async () => {
  await withPanel(
    {
      props: { missionId: 'mission-1', workspaceId: 'ws-1', roomId: ROOM, live: true, events: [] },
      getChatRoomMessages: async () => [],
    },
    async ({ view, es, readCalls }) => {
      assert.deepEqual(readCalls, [ROOM], '패널을 열면 그 방은 읽은 것이다');

      await act(async () => {
        es().emit('chat_room_message', msg('new-1', '새 메시지'));
        await Promise.resolve();
      });
      await settle();
      assert.equal(readCalls.length, 2, '열어 둔 채 받은 메시지도 읽음 처리해야 배지가 안 쌓인다');
    },
  );

  await withPanel(
    {
      props: { missionId: 'mission-1', workspaceId: 'ws-1', roomId: ROOM, live: true, events: [] },
      getChatRoomMessages: async (_r, _l, _b, observer) => {
        if (!observer) throw new Error('not a participant');
        return [];
      },
    },
    async ({ readCalls }) => {
      assert.deepEqual(readCalls, [], '관전자가 남의 방을 읽음 처리하면 그 방 참여자의 미읽음이 사라진다');
    },
  );
});

test('needs_recovery step 이 조용히 "Waiting" 으로 오표시되지 않는다', async () => {
  // stepStyle 은 모르는 상태를 pending(=Waiting, muted 회색)으로 fallback 한다.
  // 상태만 추가하고 스타일을 빠뜨리면 가장 급한 상태가 "대기 중"으로 보인다.
  const { stepStyle } = await import('../src/components/orchestration/status.ts');
  const recovery = stepStyle('needs_recovery');
  const waiting = stepStyle('pending');

  assert.notEqual(
    recovery.label,
    waiting.label,
    'needs_recovery 가 pending 으로 fallback 되면 운영자가 개입 필요를 알 수 없다',
  );
  assert.match(recovery.label, /recovery/i);
  assert.notEqual(recovery.color, waiting.color, '색까지 달라야 목록에서 눈에 띈다');
});
