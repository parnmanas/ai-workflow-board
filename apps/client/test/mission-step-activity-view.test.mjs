// 미션 화면이 "카드별로 지금 실제로 무슨 작업을 하고 있는지" 보여주는가 (운영 요청
// 2026-09-25, EmberDelve 후속).
//
// 고치기 전의 증상: step 카드에는 상태 배지(`Dispatched`)와 담당자만 있었다. 2026-09-25
// EmberDelve 에서 Windows 의 opencode 멤버는 디스패치마다 0초 만에 죽었는데, 카드는
// 100분 동안 다른 정상 step 과 똑같이 보였다 — 화면에 그 차이가 **존재하지 않았다**.
//
// 그래서 세 가지를 카드에서 읽혀야 한다:
//   1. CLI 가 마지막으로 무엇을 건드렸는지(에이전트 보고와 무관한 실제 활동).
//   2. 디스패치 후 활동이 **한 번도** 없었다는 사실(= CLI 가 못 떴다).
//   3. AWB 가 개입을 판단하는 무신호 시계(에이전트 보고 기준, CLI 활동은 이걸 되돌리지
//      않는다) — 활동이 방금 찍혔는데도 step 이 lease 만료로 실패하는 이유가 여기 있다.
//
// 소스에 JSX 가 있는지 보는 것으로는 부족하다(`{cond && <div/>}` 가 조용히 false 로
// 접히는 실버그 전례가 이 저장소에 있다). 실제 DOM 마운트로 단언한다.

import test from 'node:test';
import assert from 'node:assert/strict';
import { setupDom, mount, React, act } from './helpers/jsdom.mjs';
import PlanGraph from '../src/components/orchestration/PlanGraph.tsx';
import { MissionRow } from '../src/components/orchestration/OrchestrationPage.tsx';
import { shortDuration } from '../src/utils/time.ts';

const MIN = 60_000;

const step = (key, overrides = {}) => ({
  id: `step-${key}`,
  step_key: key,
  title: `Step ${key}`,
  instructions: '',
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
  attempt: 0,
  max_attempts: 2,
  dispatched_at: null,
  started_at: null,
  finished_at: null,
  workspace_folder: '',
  visit: 0,
  verdict: '',
  retry_policy: 'auto',
  recovery_reason: '',
  last_heartbeat_at: null,
  confirm_decision: null,
  activity: null,
  ...overrides,
});

const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString();

async function renderGraph(t, props) {
  const dom = setupDom();
  const view = mount(
    React.createElement(PlanGraph, { selectedId: null, onSelect: () => {}, ...props }),
  );
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  t.after(() => {
    view.unmount();
    dom.cleanup();
  });
  return view;
}

test('shortDuration — 구간을 읽을 수 있는 단위로, 음수는 0s 로 접는다', () => {
  assert.equal(shortDuration(12_000), '12s');
  assert.equal(shortDuration(8 * MIN), '8m');
  assert.equal(shortDuration(82 * MIN), '1h 22m');
  assert.equal(shortDuration(-5), '0s', '시계가 거꾸로 가는 표시를 만들지 않는다');
  assert.equal(shortDuration(NaN), '0s');
});

test('진행 중 카드는 CLI 가 마지막으로 한 일과 실행 시간을 보여준다', async (t) => {
  const { container } = await renderGraph(t, {
    steps: [
      step('audit', {
        status: 'running',
        dispatched_at: iso(33 * MIN),
        started_at: iso(33 * MIN),
        activity: { at: iso(12_000), source: 'cli', text: '✅ 명령 완료 · git status --short --branch' },
      }),
    ],
    stepTimeoutMinutes: 90,
  });
  const text = container.textContent;

  assert.match(text, /git status --short --branch/, 'CLI 가 실제로 돌린 명령이 카드에 보인다');
  assert.match(text, /CLI/, '신호의 출처가 구분된다');
  assert.match(text, /running 33m/, '얼마나 돌고 있는지 보인다');
  assert.ok(container.querySelector('[data-testid="step-activity"]'), '활동 블록이 렌더된다');
});

test('에이전트 자신의 보고는 CLI 활동과 다른 출처로 표시된다', async (t) => {
  const { container } = await renderGraph(t, {
    steps: [
      step('audit', {
        status: 'running',
        dispatched_at: iso(5 * MIN),
        activity: { at: iso(30_000), source: 'agent', text: '생존 신호: WIP 검증 중' },
      }),
    ],
    stepTimeoutMinutes: 90,
  });
  assert.match(container.textContent, /REPORT/);
  assert.match(container.textContent, /생존 신호: WIP 검증 중/);
});

test('디스패치 후 활동이 한 번도 없으면 경고로 구분된다 (EmberDelve 증상)', async (t) => {
  const { container } = await renderGraph(t, {
    steps: [step('audit', { status: 'dispatched', dispatched_at: iso(8 * MIN), activity: null })],
    stepTimeoutMinutes: 90,
  });
  const text = container.textContent;

  assert.match(text, /no CLI activity since dispatch/, '"아무 신호도 없다"가 카드에서 읽힌다');
  assert.match(text, /8m/, '얼마나 그런 상태인지도 보인다');
  const block = container.querySelector('[data-testid="step-activity"]');
  assert.ok(
    /title="[^"]*원격 CLI[^"]*"/.test(block.outerHTML) || block.querySelector('[title]'),
    '원인 진단 힌트가 hover 로 붙는다',
  );
});

test('디스패치 직후의 침묵은 경고가 아니다 (CLI 起動 유예)', async (t) => {
  const { container } = await renderGraph(t, {
    steps: [step('audit', { status: 'dispatched', dispatched_at: iso(20_000), activity: null })],
    stepTimeoutMinutes: 90,
  });
  const text = container.textContent;
  assert.match(text, /waiting for the CLI to start/, '막 뜬 step 을 죽었다고 말하지 않는다');
  assert.doesNotMatch(text, /no CLI activity since dispatch/);
});

test('무신호 시계는 에이전트 보고 기준이고, CLI 활동으로 되돌아가지 않는다', async (t) => {
  const { container } = await renderGraph(t, {
    steps: [
      step('audit', {
        status: 'running',
        dispatched_at: iso(95 * MIN),
        started_at: iso(95 * MIN),
        // 에이전트는 한 번도 보고하지 않았다(heartbeat null) — 그런데 CLI 는 방금 일했다.
        last_heartbeat_at: null,
        activity: { at: iso(3_000), source: 'cli', text: '💻 명령 · dotnet build' },
      }),
    ],
    stepTimeoutMinutes: 90,
  });
  const text = container.textContent;

  assert.match(text, /dotnet build/, '활동은 방금 찍혔다');
  assert.match(text, /quiet 95m \/ 90m/, '그런데도 무신호 시계는 허용치를 넘겼다 — 이게 실패 예고다');
});

test('허용치를 넘기지 않은 무신호 구간도 숫자로 보인다', async (t) => {
  const { container } = await renderGraph(t, {
    steps: [
      step('audit', {
        status: 'running',
        dispatched_at: iso(40 * MIN),
        last_heartbeat_at: iso(34 * MIN),
        activity: { at: iso(9_000), source: 'cli', text: '📋 툴 완료 · read' },
      }),
    ],
    stepTimeoutMinutes: 90,
  });
  assert.match(container.textContent, /quiet 34m \/ 90m/);
});

test('허용치를 모르면(0) 무신호 시계를 그리지 않는다 — 없는 숫자를 만들지 않는다', async (t) => {
  const { container } = await renderGraph(t, {
    steps: [
      step('audit', {
        status: 'running',
        dispatched_at: iso(40 * MIN),
        last_heartbeat_at: iso(34 * MIN),
        activity: { at: iso(9_000), source: 'cli', text: 'read' },
      }),
    ],
  });
  assert.doesNotMatch(container.textContent, /quiet/);
});

test('종료된 step 에는 활동 블록이 붙지 않는다 (결과가 이미 답이다)', async (t) => {
  const { container } = await renderGraph(t, {
    steps: [
      step('audit', {
        status: 'done',
        dispatched_at: iso(40 * MIN),
        finished_at: iso(MIN),
        activity: { at: iso(2 * MIN), source: 'cli', text: 'git push' },
      }),
    ],
    stepTimeoutMinutes: 90,
  });
  // 부재는 Boolean 으로 좁힌다 — jsdom 노드를 assert 비교 인자로 넘기면 실패하는 순간
  // util.inspect 가 순환 그래프를 펼쳐 러너가 죽는다(dom-node-assert-guard 참고).
  assert.equal(Boolean(container.querySelector('[data-testid="step-activity"]')), false, '활동 블록이 없다');
  assert.doesNotMatch(container.textContent, /git push/);
});

test('구 서버 응답(activity 필드 없음)에서도 카드가 깨지지 않는다', async (t) => {
  const legacy = step('audit', { status: 'running', dispatched_at: iso(4 * MIN) });
  delete legacy.activity;
  const { container } = await renderGraph(t, { steps: [legacy], stepTimeoutMinutes: 90 });
  assert.match(container.textContent, /Step audit/, '카드는 그대로 렌더된다');
});

// ── 목록 카드 ────────────────────────────────────────────────────────────────

const mission = (overrides = {}) => ({
  id: 'mission-1',
  workspace_id: 'ws-1',
  team_id: 'team-1',
  team_name: 'EmberDelve',
  title: 'emberdelve 제작',
  status: 'running',
  orchestrator_agent_id: 'agent-orch',
  orchestrator_name: 'Ralf/EmberDelve · orchestrator',
  plan_version: 4,
  counts: { total: 10, done: 2, failed: 1, inFlight: 1, pending: 6, awaitingUser: 0 },
  started_at: iso(3 * 60 * MIN),
  finished_at: null,
  created_at: iso(4 * 60 * MIN),
  updated_at: iso(MIN),
  ...overrides,
});

async function renderRow(t, item) {
  const dom = setupDom();
  const view = mount(React.createElement(MissionRow, { mission: item, onOpen: () => {} }));
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  t.after(() => {
    view.unmount();
    dom.cleanup();
  });
  return view;
}

test('목록 카드는 무엇이 돌고 있고 마지막 신호가 언제인지까지 말한다', async (t) => {
  const { container } = await renderRow(
    t,
    mission({
      live_steps: [
        {
          id: 'step-audit',
          step_key: 'audit-commit3',
          title: '미커밋 WIP 검증·커밋',
          status: 'dispatched',
          last_signal_at: iso(95 * MIN),
        },
      ],
    }),
  );
  const text = container.textContent;

  assert.match(text, /1 working/, '기존 카운트는 그대로');
  assert.match(text, /미커밋 WIP 검증·커밋/, '무엇이 돌고 있는지가 목록에서 보인다');
  assert.match(text, /quiet 1h 35m/, '마지막 신호 이후 경과가 보인다 — 카운트만으로는 못 보던 값');
});

test('진행 중인 step 이 없으면 목록 카드에 그 줄을 붙이지 않는다', async (t) => {
  const { container } = await renderRow(t, mission({ status: 'completed', live_steps: [] }));
  assert.equal(Boolean(container.querySelector('[data-testid="mission-live-steps"]')), false, '진행 중 줄이 없다');
});

test('구 서버 응답(live_steps 없음)에서도 목록 카드가 깨지지 않는다', async (t) => {
  const { container } = await renderRow(t, mission());
  assert.match(container.textContent, /emberdelve 제작/);
  assert.equal(Boolean(container.querySelector('[data-testid="mission-live-steps"]')), false, '진행 중 줄이 없다');
});
