// 진행 표시의 단일 어휘 회귀 테스트 (운영 요청 2026-09-26: "진행중인 작업들
// (session, chat, board, mission 등)에 대해서 같은 형태의 ui 경험을 할 수 있도록
// 통일해줘. 색깔이나 표현을 맞춰서 왼쪽 프레임이나 오른쪽 프레임에 적용해줘").
//
// 고치기 전의 증상: 같은 "지금 돌고 있다"가 표면마다 다른 색과 다른 모양이었다.
//   · 사이드바 세션 행     busy → 노란 점        (자체 색 표가 파일 안에 있었다)
//   · 세션 화면 pill        busy → 보라 pill      (또 다른 색 표)
//   · 미션 카드            running → 파란 배지
//   · 보드 카드            in_progress → 표시 없음
//   · 채팅 방 목록          작업 중 → 표시 없음
// 심지어 애니메이션도 둘이 섞여 있었다: 진행 중인 세션 점에 "사람이 답해야 함"을
// 뜻하는 링 펄스(awb-pending-pulse)가 붙어 있었다.
//
// 여기서 고정하는 계약:
//   ① 네 표면의 "작업 중"은 **같은 tone** 이므로 같은 색이다 — 색 값을 직접 비교한다.
//   ② 사람을 기다리는 상태는 절대 `live` 가 아니다(숨쉬기 금지, 링 펄스 담당).
//   ③ idle 은 점을 찍지 않는다 — 모든 행이 점을 달면 신호가 사라진다.
//   ④ 미션 상태 표는 공용 팔레트에서 색을 받는다(자체 색 하드코딩 없음).
//   ⑤ 왼쪽 프레임(사이드바)의 세션/채팅 행과 오른쪽 프레임(티켓 패널)이 실제로 그린다.

import test from 'node:test';
import assert from 'node:assert/strict';

import { setupDom, mount, React, act } from './helpers/jsdom.mjs';
import { installFakeEventSource } from './helpers/boardStream.mjs';
import { MemoryRouter } from 'react-router-dom';
import { AuthProvider } from '../src/contexts/AuthContext.tsx';
import { ToastProvider } from '../src/contexts/ToastContext.tsx';
import { BoardStreamProvider } from '../src/contexts/BoardStreamContext.tsx';
import { NotificationProvider } from '../src/contexts/NotificationContext.tsx';
import Sidebar from '../src/components/Sidebar.tsx';
import { ActivityDot, ActivityPill } from '../src/components/common/ActivityIndicator.tsx';
import {
  ACTIVITY_TONES,
  roomActivity,
  sessionActivity,
  terminalActivity,
  ticketActivity,
  toneStyle,
} from '../src/activity.ts';
import { missionStyle, stepStyle } from '../src/components/orchestration/status.ts';
import { applyTypingFrame, pruneRoomWorking, roomWorkingNames } from '../src/hooks/useRoomActivity.ts';

const h = React.createElement;
const WS_ID = 'ws-1';
const BASE = `/ws/${WS_ID}`;
const MANAGER_ID = 'mgr-1';

test('① 네 표면의 "작업 중"은 같은 색이다', () => {
  const working = [
    sessionActivity('busy'),
    terminalActivity('live'),
    missionStyle('running'),
    stepStyle('running'),
    ticketActivity({ status: 'in_progress' }),
    roomActivity({ workingNames: ['Coder.Muse'] }),
  ];
  for (const view of working) {
    assert.equal(view.tone, 'live', `작업 중은 live tone 이어야 한다: ${JSON.stringify(view)}`);
    assert.equal(view.live, true, '작업 중은 스스로 바뀌므로 숨쉬는 점을 켠다');
  }
  const colors = new Set(working.map((v) => (v.color ? v.color : toneStyle(v.tone).color)));
  assert.equal(colors.size, 1, `표면마다 색이 갈리면 안 된다: ${[...colors].join(', ')}`);
  assert.equal([...colors][0], ACTIVITY_TONES.live.color);
});

test('② 사람을 기다리는 상태는 숨쉬지 않는다 — 링 펄스가 맡는다', () => {
  const waiting = [
    sessionActivity('awaiting_permission'),
    sessionActivity('awaiting_input'),
    stepStyle('awaiting_user'),
    ticketActivity({ pending_user_action: true }),
  ];
  for (const view of waiting) {
    assert.equal(view.tone, 'attention', `사람 대기 상태는 attention: ${JSON.stringify(view)}`);
    assert.equal(view.live, false, '숨쉬는 점은 "곧 알아서 진행된다"로 읽혀 정확히 반대 뜻이 된다');
  }
  assert.equal(toneStyle('attention').attention, true);
  assert.notEqual(toneStyle('attention').color, ACTIVITY_TONES.live.color, '진행과 같은 색이면 무엇을 해야 하는지가 사라진다');

  // 사람을 기다리는 사실이 진행보다 먼저다 — 돌고 있어도 답을 요구하는 티켓이면 attention.
  assert.equal(ticketActivity({ status: 'in_progress', pending_user_action: true }).tone, 'attention');
});

test('③ ActivityDot — idle 은 아무것도 그리지 않고, 애니메이션 클래스는 뜻에 따라 갈린다', () => {
  const dom = setupDom({ width: 1280 });
  const view = mount(
    h('div', null,
      h('span', { 'data-slot': 'idle' }, h(ActivityDot, { view: sessionActivity('idle') })),
      h('span', { 'data-slot': 'live' }, h(ActivityDot, { view: sessionActivity('busy') })),
      h('span', { 'data-slot': 'attention' }, h(ActivityDot, { view: sessionActivity('awaiting_input') })),
      h('span', { 'data-slot': 'pill' }, h(ActivityPill, { view: terminalActivity('live') })),
    ),
  );
  const slot = (name) => view.container.querySelector(`span[data-slot="${name}"]`);
  assert.equal(slot('idle').childElementCount, 0, 'idle 행에 점을 찍으면 신호가 사라진다');
  assert.equal(slot('live').querySelector('[data-activity-tone="live"]').className, 'awb-activity-live');
  assert.equal(
    slot('attention').querySelector('[data-activity-tone="attention"]').className,
    'awb-activity-attention',
    '사람 대기에는 링 펄스',
  );
  assert.match(slot('pill').textContent, /Live/, 'pill 은 라벨까지 보여 준다');
  view.unmount();
  dom.cleanup();
});

test('④ 미션 상태 표는 공용 팔레트에서만 색을 받는다', () => {
  const cases = [
    ['planning', 'live'], ['running', 'live'], ['paused', 'stalled'],
    ['completed', 'done'], ['failed', 'failed'], ['draft', 'idle'],
  ];
  for (const [status, tone] of cases) {
    const style = missionStyle(status);
    assert.equal(style.tone, tone, `${status} → ${tone}`);
    assert.equal(style.color, toneStyle(tone).color, `${status} 의 색이 공용 팔레트를 벗어났다`);
    assert.equal(style.background, toneStyle(tone).background);
  }
  // step 도 같은 팔레트 — dispatched/running 은 세션의 busy 와 같은 색이다.
  assert.equal(stepStyle('dispatched').color, sessionActivity('busy') && toneStyle('live').color);
  assert.equal(stepStyle('needs_recovery').color, toneStyle('failed').color);
});

test('⑤ 방별 작업 상태 — SSE 프레임을 모으고 TTL 로 만료시킨다', () => {
  let map = {};
  map = applyTypingFrame(map, { room_id: 'r1', agent_id: 'a1', agent_name: 'Coder.Muse', is_typing: true }, 1_000);
  map = applyTypingFrame(map, { room_id: 'r2', agent_id: 'a2', agent_name: 'Grapher.Muse', is_typing: true }, 1_000);
  assert.deepEqual(roomWorkingNames(map, 'r1'), ['Coder.Muse']);
  assert.equal(roomActivity({ workingNames: roomWorkingNames(map, 'r1') }).label, 'Coder.Muse is working');
  assert.equal(roomActivity({ workingNames: roomWorkingNames(map, 'r3') }).tone, 'idle', '조용한 방은 점이 없다');

  // is_typing:false 가 도착하면 즉시 사라진다.
  map = applyTypingFrame(map, { room_id: 'r1', agent_id: 'a1', is_typing: false }, 2_000);
  assert.equal(roomWorkingNames(map, 'r1').length, 0);

  // 그 프레임이 유실되면 TTL 이 치운다 — 아니면 끝난 작업의 점이 영원히 돈다.
  const stale = pruneRoomWorking(map, 1_000 + 60_000);
  assert.equal(roomWorkingNames(stale, 'r2').length, 0);
  // 바뀔 것이 없으면 같은 참조를 돌려준다(불필요한 렌더 방지).
  assert.equal(pruneRoomWorking(stale, 1_000 + 60_000), stale);
});

test('⑥ 왼쪽 프레임 — 돌고 있는 세션과 작업 중인 방에 같은 점이 붙는다', async (t) => {
  const dom = setupDom({ width: 1280 });
  const previousAudio = globalThis.Audio;
  globalThis.Audio = class { constructor() { this.volume = 0; this.currentTime = 0; } play() { return Promise.resolve(); } pause() {} };
  const { uninstall, FakeEventSource } = installFakeEventSource();
  globalThis.localStorage = dom.window.localStorage;
  localStorage.setItem('auth_token', 'test-token');

  const host = {
    manager_id: MANAGER_ID, instance_id: 'i1', hostname: 'rolf', name: 'Rolf',
    clis: ['claude'], plugin_version: '1.0.0', last_seen_at: new Date().toISOString(),
  };
  const busySession = {
    cli: 'claude', session_id: 's-busy', cwd: '/srv/awb', title: '바쁜 세션',
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    source: 'cli', live_status: 'busy',
  };
  const previousFetch = globalThis.fetch;
  const json = (body) => Promise.resolve({ ok: true, status: 200, json: async () => body });
  globalThis.fetch = (url) => {
    const p = String(url);
    if (/\/agent-sessions\/hosts\/[^/]+\/claude\/sessions$/.test(p)) return json([busySession]);
    if (/\/agent-sessions\/hosts\/[^/]+\/[^/]+\/sessions$/.test(p)) return json([]);
    if (p.endsWith('/agent-sessions/hosts')) return json([host]);
    if (p.includes('/auth/me')) {
      return json({
        id: 'u1', name: 'Tester', email: 't@example.com', role: 'member', status: 'active',
        permissions: ['agent_sessions.use'], resolved_permissions: ['agent_sessions.use'],
        workspaces: [{ id: WS_ID, name: 'Workspace', slug: null, relations: [] }],
      });
    }
    if (p.includes('/tickets/unread-counts')) return json({ total: 0, perTicket: {}, perBoard: {}, ticketBoard: {} });
    if (p.includes('/chat-rooms/unread-counts')) return json({ total: 0, perRoom: {} });
    if (p.includes('/mentions/unread')) return json({ count: 0, items: [] });
    return json([]);
  };

  const room = {
    id: 'room-1', type: 'group', name: '릴리스 방', last_message_at: null,
    created_at: new Date().toISOString(), unread_count: 0, last_message_preview: null,
    last_message_sender: null, dm_partner_name: null, dm_partner_type: null,
  };
  const view = mount(
    h(MemoryRouter, { initialEntries: [`${BASE}/boards`] },
      h(ToastProvider, null,
        h(AuthProvider, null,
          h(BoardStreamProvider, null,
            h(NotificationProvider, null,
              h(Sidebar, {
                overlay: false, isOpen: false, onClose: () => {}, wsId: WS_ID,
                boards: [], rooms: [room], roomsLoading: false,
              }),
            ),
          ),
        ),
      ),
    ),
  );
  const flush = async (times = 12) => {
    for (let i = 0; i < times; i += 1) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  };
  await flush();
  t.after(() => {
    view.unmount();
    globalThis.fetch = previousFetch;
    uninstall();
    globalThis.Audio = previousAudio;
    dom.cleanup();
  });

  const sessionRow = view.container.querySelector('button[title="바쁜 세션"]');
  assert.equal(Boolean(sessionRow), true, '세션 행이 그려져야 한다');
  const sessionDot = sessionRow.querySelector('[data-activity-tone]');
  assert.equal(Boolean(sessionDot), true, 'busy 세션 행에 진행 점이 있어야 한다');
  assert.equal(sessionDot.getAttribute('data-activity-tone'), 'live');
  assert.equal(sessionDot.className, 'awb-activity-live', '진행에는 링 펄스가 아니라 숨쉬기');

  // 조용한 방은 점이 없다 → 타이핑 프레임이 오면 같은 tone 의 점이 생긴다.
  const roomRow = () => view.container.querySelector('button[title="릴리스 방"]');
  assert.equal(Boolean(roomRow()), true, '방 행이 그려져야 한다');
  assert.equal(Boolean(roomRow().querySelector('[data-activity-tone]')), false, '조용한 방에는 점이 없다');

  await act(async () => {
    for (const es of FakeEventSource.instances) {
      es.emit('chat_room_typing', {
        event_type: 'chat_room_typing', room_id: room.id, agent_id: 'a1',
        agent_name: 'Coder.Muse', is_typing: true, status: 'building',
      });
    }
  });
  await flush();
  const roomDot = roomRow().querySelector('[data-activity-tone]');
  assert.equal(Boolean(roomDot), true, '작업 중인 방에는 세션과 같은 점이 붙는다');
  assert.equal(roomDot.getAttribute('data-activity-tone'), 'live');
});
