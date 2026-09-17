// 초대(참여자 추가) UI 회귀 테스트 — 티켓 70e62a9d.
//
// 소스 문자열 검사가 아니라 **실제 컴포넌트를 마운트**해서 본다. 이 티켓이 고치는
// 결함 자체가 `{room.type === 'group' && <button/>}` 이 DM 에서 조용히 접히는 것이었고,
// 그런 종류의 오배선은 파일에서 문자열을 찾는 검사로는 전혀 잡히지 않는다.
//
// 두 덩어리를 마운트한다:
//   - RoomHeaderActions — context 를 쓰지 않는 순수 표현 컴포넌트라 provider 없이 뜬다.
//   - ParticipantPicker  — useAuth() 를 쓰므로 AuthProvider 로 감싼다
//     (action-fanout-ui.test.mjs 와 같은 방식). 후보 필터링과 **제출 payload** 까지 본다.
//
// 로스터의 "+ Add" 칩은 ChatRoomView 전체(=5개 provider + 라우터)가 필요해 마운트하지
// 않는다. 대신 그 칩과 헤더가 공유하는 노출 규칙 `canInviteToRoom` 을 직접 구동한다 —
// 규칙이 한 곳에 있으므로 여기가 그 게이트의 실제 검증 지점이다.
//
// 실행: node --import tsx --test --test-force-exit --test-concurrency=1 \
//         apps/client/test/chat-invite-participants.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { setupDom, mount, click, React, act } from './helpers/jsdom.mjs';
import { api } from '../src/api.ts';
import { RoomHeaderActions } from '../src/components/chat/RoomDetailPanel.tsx';
import ParticipantPicker from '../src/components/chat/ParticipantPicker.tsx';
import { AuthProvider } from '../src/contexts/AuthContext.tsx';
import { canInviteToRoom } from '../src/components/chat/utils/participantFlow.ts';

const flush = async () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

/** RoomHeaderActions 가 요구하는 콜백들 — 이 테스트는 노출 여부만 보므로 전부 noop. */
const noopHeaderProps = {
  isRenaming: false,
  onRenameStart() {},
  onRenameCancel() {},
  onRenameConfirm() {},
  onLeave() {},
  onClear() {},
  onAddPeople() {},
  onToggleOpenJoin() {},
  openJoinPending: false,
};

const room = (over = {}) => ({
  id: 'room-1',
  type: 'dm',
  name: '',
  dm_partner_name: 'Bot',
  unread_count: 0,
  ...over,
});

const buttonTexts = (container) =>
  [...container.querySelectorAll('button')].map((b) => b.textContent.trim());

// ─── 초대 진입점 노출 조건 ────────────────────────────────────────────────────

test('DM 방에도 "Add People" 버튼이 렌더된다 (이 티켓의 핵심 결함)', () => {
  setupDom();
  const { container, unmount } = mount(
    React.createElement(RoomHeaderActions, { room: room({ type: 'dm' }), ...noopHeaderProps }),
  );
  try {
    assert.ok(
      container.querySelector('[data-testid="room-add-people"]'),
      `DM 에서 초대 버튼이 없다 — 사용자가 실제로 대화하는 방에서 초대가 불가능해진다. 보인 버튼: ${JSON.stringify(buttonTexts(container))}`,
    );
  } finally {
    unmount();
  }
});

test('group 방의 "Add People" 은 회귀 없이 그대로 렌더된다', () => {
  setupDom();
  const { container, unmount } = mount(
    React.createElement(RoomHeaderActions, { room: room({ type: 'group', name: 'Team' }), ...noopHeaderProps }),
  );
  try {
    assert.ok(container.querySelector('[data-testid="room-add-people"]'));
  } finally {
    unmount();
  }
});

test('아직 참여하지 않은 자유 참여 방에서는 초대 버튼을 감추고 참여 방법을 안내한다', () => {
  setupDom();
  const { container, unmount } = mount(
    React.createElement(RoomHeaderActions, {
      room: room({ type: 'group', is_participant: false }),
      ...noopHeaderProps,
    }),
  );
  try {
    assert.equal(
      container.querySelector('[data-testid="room-add-people"]'),
      null,
      '서버가 거부할 버튼을 주면 안 된다',
    );
    assert.ok(container.querySelector('[data-testid="room-open-join-hint"]'), '참여 안내가 보여야 한다');
  } finally {
    unmount();
  }
});

test('Open Join 토글은 group 전용으로 남는다 (서버가 DM 을 계속 거부한다)', () => {
  setupDom();
  const dm = mount(React.createElement(RoomHeaderActions, { room: room({ type: 'dm' }), ...noopHeaderProps }));
  try {
    assert.equal(dm.container.querySelector('[data-testid="room-open-join-toggle"]'), null);
  } finally {
    dm.unmount();
  }

  const group = mount(
    React.createElement(RoomHeaderActions, { room: room({ type: 'group' }), ...noopHeaderProps }),
  );
  try {
    assert.ok(group.container.querySelector('[data-testid="room-open-join-toggle"]'));
  } finally {
    group.unmount();
  }
});

test('"Add People" 클릭이 모달 열기 콜백을 부른다', () => {
  setupDom();
  let opened = 0;
  const { container, unmount } = mount(
    React.createElement(RoomHeaderActions, {
      room: room({ type: 'dm' }),
      ...noopHeaderProps,
      onAddPeople: () => { opened += 1; },
    }),
  );
  try {
    click(container.querySelector('[data-testid="room-add-people"]'));
    assert.equal(opened, 1);
  } finally {
    unmount();
  }
});

test('canInviteToRoom: 방 타입이 아니라 참여 여부만 본다 (로스터 "+ Add" 칩의 게이트)', () => {
  assert.equal(canInviteToRoom({ type: 'dm' }), true, 'DM 도 초대 대상이다');
  assert.equal(canInviteToRoom({ type: 'group' }), true);
  assert.equal(canInviteToRoom({ type: 'group', is_participant: true }), true);
  assert.equal(canInviteToRoom({ type: 'group', is_participant: false }), false);
  assert.equal(canInviteToRoom({ type: 'dm', is_participant: false }), false);
  // 이 필드 이전의 응답은 예전처럼 참여자로 본다 — false 일 때만 감춘다.
  assert.equal(canInviteToRoom({ type: 'dm', is_participant: undefined }), true);
  assert.equal(canInviteToRoom(null), false);
});

// ─── 피커: 승격 경고 · 후보 필터 · 제출 payload ───────────────────────────────

const USERS = [
  { id: 'user-me', name: 'Me' },
  { id: 'user-bob', name: 'Bob' },
  { id: 'user-in-room', name: 'AlreadyIn' },
];
const AGENTS = [
  { id: 'agent-bot', name: 'Bot', manager_name: 'rolf' },
  { id: 'agent-mgr', name: 'Mgr', type: 'manager', manager_name: 'rolf' },
];

/** 피커를 AuthProvider 아래 마운트하고, api 를 원상복구할 정리 함수를 함께 돌려준다. */
function mountPicker(props) {
  const dom = setupDom();
  globalThis.localStorage = dom.window.localStorage;
  const originals = { getUsers: api.getUsers, getAgents: api.getAgents, addChatRoomParticipants: api.addChatRoomParticipants };
  api.getUsers = async () => USERS;
  api.getAgents = async () => AGENTS;
  const mounted = mount(
    React.createElement(AuthProvider, null,
      React.createElement(ParticipantPicker, {
        open: true,
        onClose() {},
        onCreated() {},
        ...props,
      })),
  );
  // api 복원은 호출자가 finally 에서 한다 — 전역이라 남겨 두면 다음 테스트를 오염시킨다.
  mounted.restore = () => Object.assign(api, originals);
  return mounted;
}

test('DM 초대 시 되돌릴 수 없는 승격을 확정 전에 알린다', async () => {
  const picker = mountPicker({ addToRoomId: 'room-1', promotesDmToGroup: true });
  try {
    await flush();
    const notice = picker.container.querySelector('[data-testid="dm-promotion-notice"]');
    assert.ok(notice, 'DM 초대인데 승격 경고가 없다');
    assert.match(notice.textContent, /되돌릴 수\s*없습니다/);
    assert.match(notice.textContent, /그룹 대화/);
    // 이전 대화가 초대된 사람에게 보인다는 사실도 함께 알려야 한다(승격의 의도된 성질).
    assert.match(notice.textContent, /이전 내용/);

    const submit = [...picker.container.querySelectorAll('button')]
      .find((b) => /Convert to Group/.test(b.textContent));
    assert.ok(submit, '확인 버튼 라벨이 승격을 드러내야 한다');
  } finally {
    picker.unmount();
    picker.restore();
  }
});

test('group 방 초대에는 승격 경고를 띄우지 않는다', async () => {
  const picker = mountPicker({ addToRoomId: 'room-1', promotesDmToGroup: false });
  try {
    await flush();
    assert.equal(picker.container.querySelector('[data-testid="dm-promotion-notice"]'), null);
    assert.ok(
      [...picker.container.querySelectorAll('button')].some((b) => b.textContent.trim() === 'Add to Room'),
      'group 방은 기존 라벨 그대로여야 한다',
    );
  } finally {
    picker.unmount();
    picker.restore();
  }
});

test('후보에서 이미 참여 중인 대상과 Agent Manager 가 빠진다', async () => {
  const picker = mountPicker({
    addToRoomId: 'room-1',
    promotesDmToGroup: true,
    existingParticipantIds: ['user-in-room', 'agent-bot'],
  });
  try {
    await flush();
    const labels = [...picker.container.querySelectorAll('label')].map((l) => l.textContent);
    const joined = labels.join(' | ');
    assert.ok(joined.includes('Bob'), `초대 가능한 유저가 후보에 없다: ${joined}`);
    assert.ok(!joined.includes('AlreadyIn'), '이미 방에 있는 대상이 후보에 남아 있다');
    assert.ok(!joined.includes('Mgr'), 'Agent Manager 는 chat 참가자가 될 수 없다 (티켓 941c72d3)');
    assert.ok(!joined.includes('rolf/Bot'), '이미 방에 있는 에이전트가 후보에 남아 있다');
  } finally {
    picker.unmount();
    picker.restore();
  }
});

test('유저와 에이전트를 함께 골라 제출하면 그대로 서버로 나간다', async () => {
  const calls = [];
  const picker = mountPicker({ addToRoomId: 'room-42', promotesDmToGroup: true });
  api.addChatRoomParticipants = async (roomId, participants) => {
    calls.push({ roomId, participants });
    return { ok: true };
  };
  try {
    await flush();

    // 후보 행의 체크박스를 눌러 유저 하나 + 에이전트 하나를 고른다.
    const rows = [...picker.container.querySelectorAll('label')];
    const pick = (needle) => {
      const row = rows.find((l) => l.textContent.includes(needle));
      assert.ok(row, `후보 '${needle}' 를 찾을 수 없다`);
      click(row.querySelector('input[type="checkbox"]'));
    };
    pick('Bob');
    pick('Bot');
    await flush();

    const submit = [...picker.container.querySelectorAll('button')]
      .find((b) => /Convert to Group/.test(b.textContent));
    assert.ok(submit, '제출 버튼이 없다');
    click(submit);
    await flush();

    assert.equal(calls.length, 1, 'production 경로의 api.addChatRoomParticipants 가 불려야 한다');
    assert.equal(calls[0].roomId, 'room-42');
    assert.deepEqual(
      [...calls[0].participants].sort((a, b) => a.participant_id.localeCompare(b.participant_id)),
      [
        { participant_type: 'agent', participant_id: 'agent-bot' },
        { participant_type: 'user', participant_id: 'user-bob' },
      ],
      '유저와 에이전트가 모두, 선택한 그대로 나가야 한다',
    );
  } finally {
    picker.unmount();
    picker.restore();
  }
});

test('아무도 고르지 않으면 제출 버튼이 비활성이다', async () => {
  const picker = mountPicker({ addToRoomId: 'room-1', promotesDmToGroup: true });
  try {
    await flush();
    const submit = [...picker.container.querySelectorAll('button')]
      .find((b) => /Convert to Group/.test(b.textContent));
    assert.ok(submit);
    assert.equal(submit.disabled, true);
  } finally {
    picker.unmount();
    picker.restore();
  }
});
