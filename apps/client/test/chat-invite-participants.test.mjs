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
import { api, getActiveAccountId, setActiveAccountId } from '../src/api.ts';
import { RoomHeaderActions } from '../src/components/chat/RoomDetailPanel.tsx';
import ParticipantPicker from '../src/components/chat/ParticipantPicker.tsx';
import { AuthProvider } from '../src/contexts/AuthContext.tsx';
import { canInviteToRoom } from '../src/components/chat/utils/participantFlow.ts';
import { chatFolderSlug, defaultChatWorkdir, isChatWorkdir } from '../src/components/chat/utils/chatAgents.ts';

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
      Boolean(container.querySelector('[data-testid="room-add-people"]')),
      false,
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
    assert.equal(
      Boolean(dm.container.querySelector('[data-testid="room-open-join-toggle"]')),
      false,
      'DM 방에는 Open Join 토글이 렌더되면 안 된다',
    );
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

// ─── 피커: 승격 경고 · 후보 필터 · 여러 Agent 선언 · 제출 payload ─────────────

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
function mountPicker(props, { hosts } = {}) {
  const dom = setupDom();
  globalThis.localStorage = dom.window.localStorage;
  const originals = {
    getUsers: api.getUsers,
    getAgents: api.getAgents,
    addChatRoomParticipants: api.addChatRoomParticipants,
    createChatRoom: api.createChatRoom,
    listTemplateHosts: api.listTemplateHosts,
    validateRuntimeSpec: api.validateRuntimeSpec,
    listAgentTemplates: api.listAgentTemplates,
  };
  api.getUsers = async () => USERS;
  api.listAgentTemplates = async () => [];
  api.getAgents = async () => AGENTS;
  // P4c-4: 에이전트는 runtime 선언으로 들어간다 — Host 카탈로그 스텁.
  api.listTemplateHosts = async () => hosts ?? [{ id: 'host-1', name: 'host-one' }];
  // 서버 normalizeRuntimeSpec 처럼 label 이 비면 `<폴더 끝>/<cli>` 로 채운다.
  api.validateRuntimeSpec = async (_ws, spec) => ({
    ok: true,
    spec: {
      manager_agent_id: spec.manager_agent_id, cli: spec.cli, model: spec.model ?? null,
      working_dir: spec.working_dir, credential_id: spec.credential_id ?? null,
      label: spec.label || `${spec.working_dir.split('/').filter(Boolean).pop()}/${spec.cli}`,
      role_prompt: spec.role_prompt || '',
    },
  });
  // 런타임 spec 에디터는 accountId 로 credential 을 불러온다.
  const prevWs = getActiveAccountId();
  setActiveAccountId('ws-1');
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
  mounted.restore = () => { Object.assign(api, originals); setActiveAccountId(prevWs); };
  return mounted;
}

const findButton = (container, re) =>
  [...container.querySelectorAll('button')].find((b) => re.test(b.textContent.trim()));

function setNativeValue(el, value) {
  const proto = el instanceof window.HTMLSelectElement
    ? window.HTMLSelectElement.prototype
    : window.HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value')?.set.call(el, value);
  el.dispatchEvent(new window.Event('input', { bubbles: true }));
  el.dispatchEvent(new window.Event('change', { bubbles: true }));
}

/** "+ Agent 추가" → Host/CLI/폴더(+label) 입력 → "Agent 추가". 편집기 안의 결과 텍스트를 돌려준다. */
async function declareAgent(container, { dir, label = '' }) {
  const open = findButton(container, /^\+ Agent 추가$/);
  assert.ok(open, "'+ Agent 추가' 버튼이 없다");
  click(open);
  await flush();
  const editor = container.querySelector('[data-testid="new-chat-agent-editor"]');
  assert.ok(editor, 'Agent 편집기가 열리지 않았다');
  const selects = [...editor.querySelectorAll('select')];
  const hostSelect = selects.find((s) => [...s.options].some((o) => o.value === 'host-1'));
  assert.ok(hostSelect, 'Host 선택이 없다');
  await act(async () => { setNativeValue(hostSelect, 'host-1'); });
  await flush();
  const cliSelect = [...editor.querySelectorAll('select')].find((s) => [...s.options].some((o) => o.value === 'claude'));
  const inputs = [...editor.querySelectorAll('input')];
  const dirInput = inputs.find((i) => i.type === 'text' && i.placeholder && /\/home\/user\/work|채팅 전용 폴더/.test(i.placeholder));
  assert.ok(cliSelect && dirInput, 'runtime 선언 입력(CLI/dir)이 없다');
  await act(async () => {
    setNativeValue(cliSelect, 'claude');
    setNativeValue(dirInput, dir);
  });
  if (label) {
    const labelInput = [...editor.querySelectorAll('input')].find((i) => i.placeholder && i.placeholder.includes('자동 표시'));
    assert.ok(labelInput, 'Label 입력이 없다');
    await act(async () => { setNativeValue(labelInput, label); });
  }
  await flush();
  click(findButton(editor, /^Agent 추가$/));
  await flush();
  return container.querySelector('[data-testid="new-chat-agent-editor"]');
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
    assert.ok(findButton(picker.container, /Convert to Group/), '확인 버튼 라벨이 승격을 드러내야 한다');
  } finally {
    picker.unmount();
    picker.restore();
  }
});

test('group 방 초대에는 승격 경고를 띄우지 않는다', async () => {
  const picker = mountPicker({ addToRoomId: 'room-1', promotesDmToGroup: false });
  try {
    await flush();
    assert.equal(
      Boolean(picker.container.querySelector('[data-testid="dm-promotion-notice"]')),
      false,
      'group 방 초대에는 DM 승격 경고를 띄우지 않는다',
    );
    assert.ok(findButton(picker.container, /^Add to Room$/), 'group 방은 기존 라벨 그대로여야 한다');
  } finally {
    picker.unmount();
    picker.restore();
  }
});

test('공용 Modal 로 뜬다 — 다이얼로그 하나 안에 Agents 와 People 섹션이 있다', async () => {
  const picker = mountPicker({});
  try {
    await flush();
    const dialogs = picker.container.querySelectorAll('[role="dialog"]');
    assert.equal(dialogs.length, 1, '다이얼로그는 하나여야 한다');
    // 공용 Modal 의 다이얼로그는 스스로 스크롤한다 — runtime 편집기가 길어져도 잘리지 않는다.
    assert.equal(dialogs[0].style.overflowY, 'auto', '다이얼로그 본문이 스크롤돼야 한다');
    assert.ok(dialogs[0].querySelector('section[aria-label="Agents"]'), 'Agents 섹션이 없다');
    assert.ok(dialogs[0].querySelector('section[aria-label="People"]'), 'People 섹션이 없다');
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

test('유저와 에이전트를 함께 골라 제출하면 그대로 서버로 나간다 (P4c-4: 에이전트는 runtime 선언)', async () => {
  const calls = [];
  const picker = mountPicker({ addToRoomId: 'room-42', promotesDmToGroup: true });
  api.addChatRoomParticipants = async (roomId, participants) => {
    calls.push({ roomId, participants });
    return { ok: true };
  };
  try {
    await flush();

    // 유저는 후보 행의 체크박스로 고른다.
    const bob = [...picker.container.querySelectorAll('label')].find((l) => l.textContent.includes('Bob'));
    assert.ok(bob, "후보 'Bob' 를 찾을 수 없다");
    click(bob.querySelector('input[type="checkbox"]'));
    await flush();

    // 에이전트는 runtime 선언으로 추가한다 (Agent 목록 표면 없음).
    const editorAfter = await declareAgent(picker.container, { dir: '/wt/invite-bot', label: '초대봇' });
    assert.equal(editorAfter, null, '추가하면 편집기가 닫혀야 한다');
    const cards = [...picker.container.querySelectorAll('[data-testid="new-chat-agent"]')];
    assert.equal(cards.length, 1);
    assert.match(cards[0].textContent, /host-one\/초대봇/, 'Agent 카드는 <Host>/<label> 로 보여야 한다');

    const submit = findButton(picker.container, /Convert to Group/);
    assert.ok(submit, '제출 버튼이 없다');
    click(submit);
    await flush();

    assert.equal(calls.length, 1, 'production 경로의 api.addChatRoomParticipants 가 불려야 한다');
    assert.equal(calls[0].roomId, 'room-42');
    const byType = Object.fromEntries(calls[0].participants.map((p) => [p.participant_type, p]));
    assert.deepEqual(
      byType.user,
      { participant_type: 'user', participant_id: 'user-bob' },
      '유저는 선택한 그대로 나가야 한다',
    );
    assert.equal(byType.agent.participant_type, 'agent');
    assert.equal(byType.agent.participant_id, '', 'spec-direct 초대는 id 가 비고 runtime 이 동봉된다');
    assert.equal(byType.agent.runtime.working_dir, '/wt/invite-bot');
  } finally {
    picker.unmount();
    picker.restore();
  }
});

test('새 채팅: Agent 여럿을 선언해 이름 붙인 그룹 방을 만든다', async () => {
  const calls = [];
  const picker = mountPicker({});
  api.createChatRoom = async (participants, name) => {
    calls.push({ participants, name });
    return { id: 'room-new', type: 'group', name };
  };
  try {
    await flush();
    await declareAgent(picker.container, { dir: '/repo/app', label: 'writer' });
    // 한 Agent 면 DM — 모든 메시지에 답한다고 알린다.
    assert.match(picker.container.querySelector('[data-testid="new-chat-shape"]').textContent, /1:1 대화/);
    assert.ok(findButton(picker.container, /^Start Chat$/));

    await declareAgent(picker.container, { dir: '/repo/review', label: 'reviewer' });
    const names = [...picker.container.querySelectorAll('[data-testid="new-chat-agent"]')].map((c) => c.textContent);
    assert.equal(names.length, 2);
    assert.match(names[0], /host-one\/writer/);
    assert.match(names[1], /host-one\/reviewer/);
    // 둘 이상이면 그룹 — Agent 는 @멘션에 답한다는 규칙을 만들기 전에 알린다.
    assert.match(picker.container.querySelector('[data-testid="new-chat-shape"]').textContent, /그룹 대화.*@멘션/);

    const roomName = [...picker.container.querySelectorAll('input')].find((i) => i.placeholder?.includes('자동 지정'));
    assert.ok(roomName, '방 이름 입력이 없다');
    await act(async () => { setNativeValue(roomName, '설계 회의'); });

    click(findButton(picker.container, /^Create Group$/));
    await flush();
    assert.equal(calls.length, 1, 'api.createChatRoom 이 불려야 한다');
    assert.equal(calls[0].name, '설계 회의');
    assert.deepEqual(
      calls[0].participants.map((p) => [p.participant_type, p.participant_id, p.runtime?.label]),
      [['agent', '', 'writer'], ['agent', '', 'reviewer']],
    );
  } finally {
    picker.unmount();
    picker.restore();
  }
});

test('같은 실행 신원(CLI·폴더·credential)의 Agent 는 두 번 넣지 못한다 — 서버가 하나로 합친다', async () => {
  const picker = mountPicker({});
  try {
    await flush();
    await declareAgent(picker.container, { dir: '/repo/app', label: 'opus' });
    // 모델·label 만 다르고 신원이 같다.
    const editor = await declareAgent(picker.container, { dir: '/repo/app', label: 'sonnet' });
    assert.ok(editor, '중복이면 편집기가 열린 채 남아야 한다');
    const alerts = [...editor.querySelectorAll('[role="alert"]')].map((a) => a.textContent).join(' | ');
    assert.match(alerts, /host-one\/opus/, `중복 신원을 알려야 한다: ${alerts}`);
    assert.equal(picker.container.querySelectorAll('[data-testid="new-chat-agent"]').length, 1);
    // 편집기가 열려 있는 동안은 방을 만들 수 없다 — 입력 중인 Agent 가 조용히 빠지지 않게.
    assert.equal(findButton(picker.container, /^Start Chat$/).disabled, true);
  } finally {
    picker.unmount();
    picker.restore();
  }
});

test('아무도 고르지 않으면 제출 버튼이 비활성이다', async () => {
  const picker = mountPicker({ addToRoomId: 'room-1', promotesDmToGroup: true });
  try {
    await flush();
    const submit = findButton(picker.container, /Convert to Group/);
    assert.ok(submit);
    assert.equal(submit.disabled, true);
  } finally {
    picker.unmount();
    picker.restore();
  }
});

// ─── 작업 폴더는 선택 — 비우면 그 Host 의 채팅 전용 폴더 ─────────────────────
// 폴더는 CLI 의 cwd 이자 실행 신원(cli + 폴더 + credential)의 일부라 없앨 수는 없다. 대신 비우면
// 매니저가 알린 채팅 전용 루트 아래 `<이름>` 을 쓴다 — 홈을 기본값으로 쓰면 Codex 쓰기 범위·Claude
// 신뢰 범위가 홈 전체가 된다.

test('기본 채팅 폴더: 이름 조각 · 겹치면 번호 · Windows 루트 · 루트 없으면 null', () => {
  assert.equal(chatFolderSlug('My Bot!'), 'my-bot');
  assert.equal(chatFolderSlug('  '), 'agent');
  assert.equal(chatFolderSlug('../etc'), 'etc', '경로 조각으로 빠져나가지 않는다');
  const taken = new Set(['/m/chat/claude']);
  assert.deepEqual(defaultChatWorkdir('/m/chat/', 'claude', (d) => taken.has(d)), { dir: '/m/chat/claude-2', n: 2 });
  assert.deepEqual(defaultChatWorkdir('C:\\awb\\chat', '리뷰어', () => false), { dir: 'C:\\awb\\chat\\리뷰어', n: 1 });
  assert.equal(defaultChatWorkdir(null, 'x', () => false), null);
  assert.equal(isChatWorkdir('/m/chat/claude', '/m/chat'), true);
  assert.equal(isChatWorkdir('/m/chatty/x', '/m/chat'), false);
  assert.equal(isChatWorkdir('/m/chat', '/m/chat'), false);
});

const CHAT_ROOT = '/home/u/.config/awb-agent-manager/chat-workdirs';

test('새 채팅: 폴더를 비우면 채팅 전용 폴더를 쓰고, 같은 CLI 둘째는 번호를 붙여 다른 신원이 된다', async () => {
  const calls = [];
  const picker = mountPicker({}, { hosts: [{ id: 'host-1', name: 'host-one', chat_workdir_root: CHAT_ROOT }] });
  api.createChatRoom = async (participants, name) => {
    calls.push({ participants, name });
    return { id: 'room-new', type: 'group', name };
  };
  try {
    await flush();
    click(findButton(picker.container, /^\+ Agent 추가$/));
    await flush();
    assert.ok(picker.container.querySelector('[data-testid="runtime-folder-optional-hint"]'), '폴더가 선택이라는 안내가 보여야 한다');
    click(findButton(picker.container, /^취소$/));
    await flush();

    await declareAgent(picker.container, { dir: '' });
    await declareAgent(picker.container, { dir: '' });
    const cards = [...picker.container.querySelectorAll('[data-testid="new-chat-agent"]')].map((c) => c.textContent);
    assert.equal(cards.length, 2, '같은 CLI 를 둘 넣어도 신원이 갈라져 둘 다 들어간다');
    assert.match(cards[0], /host-one\/Claude Code/);
    assert.match(cards[1], /host-one\/Claude Code 2/);
    assert.match(cards[0], /채팅 전용 폴더/, '긴 기본 경로 대신 짧게 보인다');

    click(findButton(picker.container, /^Create Group$/));
    await flush();
    assert.equal(calls.length, 1);
    const dirs = calls[0].participants.filter((p) => p.participant_type === 'agent').map((p) => p.runtime.working_dir);
    assert.deepEqual(dirs, [`${CHAT_ROOT}/claude`, `${CHAT_ROOT}/claude-2`]);
  } finally {
    picker.unmount();
    picker.restore();
  }
});

test('새 채팅: 채팅 전용 폴더를 모르는 Host(구버전·꺼짐)는 폴더를 비우면 사유를 보이고 추가하지 않는다', async () => {
  const picker = mountPicker({});
  try {
    await flush();
    const editor = await declareAgent(picker.container, { dir: '' });
    assert.ok(editor, '편집기가 그대로 열려 있어야 한다');
    assert.match(editor.querySelector('[role="alert"]').textContent, /채팅 전용 폴더를 알리지 않았습니다/);
    assert.equal(picker.container.querySelectorAll('[data-testid="new-chat-agent"]').length, 0);
  } finally {
    picker.unmount();
    picker.restore();
  }
});
