// 미션 화면 개편의 회귀 테스트 (운영 요청 2026-09-25: "한 페이지에 너무 많은 내용이 다
// 나와서 보기 힘들다. step 을 선택하면 그 step 의 작업 session, 선택을 풀면 main session").
//
// 개편의 핵심 계약은 **선택 상태가 오른쪽 패널의 내용을 가른다**는 것이다. 그래서
// 좌측 레일과 step 세션 패널을 DOM 으로 마운트해 그 규칙을 고정한다:
//   1. 레일 맨 위는 미션 대화 행이고, 아무 step 도 선택되지 않았을 때 그것이 선택 상태다.
//   2. step 행을 누르면 그 step 이 선택된다.
//   3. **선택된 행을 다시 누르면 선택이 풀린다**(= 미션 대화로 돌아간다). 이게 "선택
//      취소" 의 구현이고, 레일에서 가장 짧은 복귀 동작이다.
//   4. 레일은 단계(stage)로 묶어 세로로 늘어놓는다 — 같은 묶음이 진짜 병렬 작업이라는
//      정보를 좁은 폭에서도 잃지 않아야 한다.
//   5. step 세션 패널은 지시(work order)·CLI 하트비트·에이전트 보고·실행 이벤트를 **하나의
//      시간축**으로 엮고, 사람이 쓸 입력창을 만들지 않는다(step 방은 참여 대상이 아니다).

import test from 'node:test';
import assert from 'node:assert/strict';
import { setupDom, mount, React, act } from './helpers/jsdom.mjs';
import MissionStepRail from '../src/components/orchestration/MissionStepRail.tsx';
import { api } from '../src/api.ts';
import StepSessionPanel, {
  buildStepSessionRows,
  systemBlockTitle,
} from '../src/components/orchestration/StepSessionPanel.tsx';

const MIN = 60_000;
const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString();

const step = (key, overrides = {}) => ({
  id: `step-${key}`,
  step_key: key,
  title: `Step ${key}`,
  instructions: `do ${key}`,
  acceptance_criteria: '',
  depends_on: [],
  assignee_agent_id: 'agent-1',
  assignee_name: 'Ralf/EmberDelve · Coder.Muse',
  assignee_online: true,
  status: 'pending',
  position: 0,
  plan_version: 1,
  room_id: 'room-1',
  result_summary: '',
  artifacts: [],
  attempt: 1,
  max_attempts: 2,
  dispatched_at: null,
  started_at: null,
  finished_at: null,
  workspace_folder: '.awb/orch/m/s',
  visit: 1,
  verdict: '',
  retry_policy: 'auto',
  recovery_reason: '',
  last_heartbeat_at: null,
  confirm_decision: null,
  activity: null,
  ...overrides,
});

const COUNTS = { total: 3, done: 1, failed: 0, inFlight: 1, pending: 1, awaitingUser: 0 };

async function renderRail(t, props) {
  const dom = setupDom();
  const view = mount(
    React.createElement(MissionStepRail, {
      steps: [],
      graph: null,
      stepTimeoutMinutes: 90,
      selectedId: null,
      onSelect: () => {},
      counts: COUNTS,
      planVersion: 4,
      emptyHint: 'no steps yet',
      ...props,
    }),
  );
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
  t.after(() => {
    view.unmount();
    dom.cleanup();
  });
  return view;
}

test('레일 맨 위는 미션 대화이고, 선택된 step 이 없으면 그것이 현재 선택이다', async (t) => {
  const { container } = await renderRail(t, { steps: [step('a')], selectedId: null });
  const missionRow = container.querySelector('[data-testid="rail-mission-row"]');
  assert.ok(missionRow, '미션 대화 행이 있다');
  assert.match(missionRow.textContent, /Mission conversation/);
  assert.match(missionRow.textContent, /plan v4/, '어느 계획 버전을 보고 있는지 같이 읽힌다');
  assert.match(missionRow.textContent, /1\/3 done/);
  assert.equal(missionRow.getAttribute('aria-current'), 'true', '선택 상태가 접근성 속성으로도 드러난다');
});

test('step 행을 누르면 그 step 이 선택된다', async (t) => {
  const picked = [];
  const { container } = await renderRail(t, {
    steps: [step('a'), step('b', { position: 1 })],
    selectedId: null,
    onSelect: (id) => picked.push(id),
  });
  const rows = [...container.querySelectorAll('[data-testid="rail-step-row"]')];
  assert.equal(rows.length, 2);
  await act(async () => {
    rows[1].click();
  });
  assert.deepEqual(picked, ['step-b']);
});

test('선택된 step 행을 다시 누르면 선택이 풀린다 — 미션 대화로 돌아가는 동작', async (t) => {
  const picked = [];
  const { container } = await renderRail(t, {
    steps: [step('a')],
    selectedId: 'step-a',
    onSelect: (id) => picked.push(id),
  });
  const row = container.querySelector('[data-testid="rail-step-row"]');
  assert.equal(row.getAttribute('aria-current'), 'true');
  await act(async () => {
    row.click();
  });
  assert.deepEqual(picked, [null], 'null = 미션 대화');
});

test('미션 대화 행을 누르면 언제든 선택이 풀린다', async (t) => {
  const picked = [];
  const { container } = await renderRail(t, {
    steps: [step('a')],
    selectedId: 'step-a',
    onSelect: (id) => picked.push(id),
  });
  await act(async () => {
    container.querySelector('[data-testid="rail-mission-row"]').click();
  });
  assert.deepEqual(picked, [null]);
});

test('레일은 의존성 단계로 묶는다 — 같은 묶음이 병렬 작업이라는 정보를 잃지 않는다', async (t) => {
  const { container } = await renderRail(t, {
    steps: [
      step('a', { position: 0 }),
      step('b', { position: 1 }),
      step('c', { position: 2, depends_on: ['a'] }),
    ],
  });
  const text = container.textContent;
  assert.match(text, /Stage 1 · starts immediately/);
  assert.match(text, /Stage 2/);
});

test('진행 중인 행만 활동 한 줄을 갖는다 — 끝난 행이 조용해야 움직이는 것이 보인다', async (t) => {
  const { container } = await renderRail(t, {
    steps: [
      step('live', {
        status: 'running',
        dispatched_at: iso(30 * MIN),
        activity: { at: iso(9_000), source: 'cli', text: '✅ 명령 완료 · git status' },
      }),
      step('done', { status: 'done', position: 1, finished_at: iso(MIN) }),
    ],
  });
  const lines = [...container.querySelectorAll('[data-testid="rail-step-activity"]')];
  assert.equal(lines.length, 1, '진행 중인 한 행만');
  assert.match(lines[0].textContent, /git status/);
});

test('진행 중인데 활동이 한 번도 없으면 레일에서도 경고 문구가 뜬다', async (t) => {
  const { container } = await renderRail(t, {
    steps: [step('dead', { status: 'dispatched', dispatched_at: iso(8 * MIN) })],
  });
  assert.match(container.textContent, /no CLI activity since dispatch/);
});

test('step 이 없으면 레일은 이유를 한 줄로 말한다', async (t) => {
  const { container } = await renderRail(t, { steps: [], emptyHint: 'The orchestrator is working out the plan.' });
  assert.match(container.textContent, /working out the plan/);
  assert.equal(container.querySelectorAll('[data-testid="rail-step-row"]').length, 0);
});

// ── step 세션 패널 ───────────────────────────────────────────────────────────

test('buildStepSessionRows — 세션 줄과 실행 이벤트를 시간순으로 엮고, 동시각이면 이벤트를 뒤에 둔다', () => {
  const rows = buildStepSessionRows(
    [
      { id: 'm2', at: '2026-09-25T00:00:02.000Z', kind: 'agent', sender_type: 'agent', sender_id: 'a', sender_name: 'A', text: '보고' },
      { id: 'm1', at: '2026-09-25T00:00:01.000Z', kind: 'system', sender_type: 'user', sender_id: 'system', sender_name: '', text: '# Assigned task' },
    ],
    [{ id: 'e1', type: 'step_completed', step_id: 's', step_key: 'k', actor_type: 'agent', actor_id: 'a', actor_name: 'A', message: 'done', data: null, created_at: '2026-09-25T00:00:02.000Z', write_seq: 1 }],
  );
  assert.deepEqual(
    rows.map((r) => (r.kind === 'item' ? r.item.id : `event:${r.event.id}`)),
    ['m1', 'm2', 'event:e1'],
  );
});

test('systemBlockTitle — 마크다운 heading 을 접힌 블록의 제목으로 쓴다', () => {
  assert.equal(systemBlockTitle('# Assigned task (RETRY, attempt 2): 검증\n\n본문'), 'Assigned task (RETRY, attempt 2): 검증');
  assert.equal(systemBlockTitle('## Are you still working on "X"?\n'), 'Are you still working on "X"?');
  assert.equal(systemBlockTitle(''), 'AWB message');
});

/**
 * 세션 패널은 `api` 를 통해 읽는다. 다른 클라이언트 테스트와 같은 방식으로 **api 메서드를
 * 직접 스텁**한다(fetch 를 가로채면 auth 토큰·localStorage 같은 request 헬퍼의 전제까지
 * 테스트가 흉내내야 한다).
 */
async function renderSession(t, { step: s, items, events = [], hasMore = false }) {
  const dom = setupDom();
  globalThis.localStorage = dom.window.localStorage;
  localStorage.setItem('auth_token', 'test-token');

  const calls = [];
  const original = api.getOrchestrationStepSession;
  api.getOrchestrationStepSession = async (stepId, wsId, opts) => {
    calls.push({ stepId, wsId, opts });
    const page = opts?.beforeId ? [] : items;
    return {
      step_id: s.id,
      step_key: s.step_key,
      room_id: s.room_id,
      items: page,
      has_more: hasMore && !opts?.beforeId,
      next_before_id: hasMore && !opts?.beforeId ? page[page.length - 1]?.id ?? null : null,
    };
  };

  const view = mount(
    React.createElement(StepSessionPanel, {
      step: s,
      wsId: 'ws-1',
      events,
      stepTimeoutMinutes: 90,
      onClose: () => {},
    }),
  );
  await act(async () => {
    await new Promise((r) => setTimeout(r, 10));
  });
  t.after(() => {
    view.unmount();
    dom.cleanup();
    api.getOrchestrationStepSession = original;
  });
  return { ...view, calls };
}

test('step 세션은 지시·CLI 하트비트·에이전트 보고·실행 이벤트를 한 흐름으로 보여준다', async (t) => {
  const s = step('audit', {
    status: 'running',
    dispatched_at: iso(40 * MIN),
    activity: { at: iso(8_000), source: 'cli', text: '✅ 명령 완료 · git push' },
  });
  const { container } = await renderSession(t, {
    step: s,
    items: [
      { id: 'i3', at: iso(10_000), kind: 'agent', sender_type: 'agent', sender_id: 'a', sender_name: 'Coder.Muse', text: '빌드 통과했습니다' },
      { id: 'i2', at: iso(60_000), kind: 'progress', sender_type: 'agent', sender_id: 'a', sender_name: '', text: '✅ 명령 완료 · dotnet build' },
      { id: 'i1', at: iso(120_000), kind: 'system', sender_type: 'user', sender_id: 'system', sender_name: '', text: '# Assigned task: 검증\n\nstep_id: xyz' },
    ],
    events: [
      { id: 'e1', type: 'step_dispatched', step_id: s.id, step_key: 'audit', actor_type: 'system', actor_id: '', actor_name: '', message: 'Step dispatched to Coder.Muse', data: null, created_at: iso(150_000), write_seq: 1 },
      { id: 'e2', type: 'step_completed', step_id: 'other-step', step_key: 'x', actor_type: 'agent', actor_id: '', actor_name: '', message: '다른 step 의 이벤트', data: null, created_at: iso(50_000), write_seq: 2 },
    ],
  });
  const text = container.textContent;

  assert.match(text, /Assigned task: 검증/, '지시는 제목만 접혀서 보인다');
  assert.doesNotMatch(text, /step_id: xyz/, '지시 본문은 펼치기 전에는 나오지 않는다');
  assert.match(text, /dotnet build/, 'CLI 하트비트가 보인다');
  assert.match(text, /빌드 통과했습니다/, '에이전트 보고가 보인다');
  assert.match(text, /Step dispatched to Coder.Muse/, '이 step 의 실행 이벤트가 같은 축에 있다');
  assert.doesNotMatch(text, /다른 step 의 이벤트/, '다른 step 의 이벤트는 섞이지 않는다');
  assert.match(text, /Back to mission/, '선택을 푸는 길이 패널 안에도 있다');
  assert.equal(container.querySelectorAll('textarea, input[type="text"]').length, 0, 'step 방에는 쓰기 입구가 없다');
  assert.match(text, /읽기 전용/, '왜 쓸 수 없는지 화면이 설명한다');
});

test('지시 블록을 펼치면 본문이 나온다', async (t) => {
  const s = step('audit', { status: 'running', dispatched_at: iso(5 * MIN) });
  const { container } = await renderSession(t, {
    step: s,
    items: [
      { id: 'i1', at: iso(60_000), kind: 'system', sender_type: 'user', sender_id: 'system', sender_name: '', text: '# Assigned task: 검증\n\nlease_token: abc-123' },
    ],
  });
  const toggle = [...container.querySelectorAll('button')].find((b) => /Assigned task/.test(b.textContent));
  assert.ok(toggle, '접힌 블록의 제목이 버튼이다');
  await act(async () => {
    toggle.click();
  });
  assert.match(container.textContent, /lease_token: abc-123/);
});

test('진행 중인 step 세션 헤더는 카드와 같은 두 시계를 보여준다', async (t) => {
  const s = step('audit', {
    status: 'running',
    dispatched_at: iso(95 * MIN),
    last_heartbeat_at: null,
    activity: { at: iso(3_000), source: 'cli', text: '💻 dotnet build' },
  });
  const { container } = await renderSession(t, { step: s, items: [] });
  const header = container.querySelector('[data-testid="step-session-activity"]');
  assert.ok(header);
  assert.match(header.textContent, /dotnet build/);
  assert.match(header.textContent, /running 1h 35m/);
  assert.match(header.textContent, /quiet 95m \/ 90m/, '활동이 방금 찍혔어도 무신호 시계는 따로 흐른다');
});

test('아직 디스패치되지 않은 step 은 방이 없다고 말한다', async (t) => {
  const s = step('later', { status: 'pending', room_id: null });
  const { container } = await renderSession(t, { step: s, items: [] });
  assert.match(container.textContent, /디스패치되지 않았습니다/);
});

test('복구 불가 상태는 세션 헤더에서 사유까지 보인다', async (t) => {
  const s = step('audit', {
    status: 'needs_recovery',
    retry_policy: 'manual',
    recovery_reason: '[lease expired] 100분간 무신호',
    dispatched_at: iso(120 * MIN),
  });
  const { container } = await renderSession(t, { step: s, items: [] });
  assert.ok(container.querySelector('[data-testid="step-recovery-reason"]'));
  assert.match(container.textContent, /100분간 무신호/);
  assert.ok(container.querySelector('[data-testid="step-retry-policy-manual"]'));
});
