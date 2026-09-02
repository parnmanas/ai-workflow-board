// PlanGraph의 그래프 모드 렌더링 회귀 테스트 (티켓 1ca9e49b).
//
// 두 가지를 지킨다.
//
// 1) **레이아웃**: PlanGraph는 원래 `depends_on`으로 열(wave)을 계산했다. 그래프
//    모드에서 조건 분기는 depends_on에 나타나지 않으므로, 그대로 두면 분기 하류가
//    전부 "wave 1 · 즉시 시작"으로 접혀 보인다 — 운영자가 화면만 보고 "왜 안
//    돌지?"를 판단할 수 없게 되는 조용한 오표시다. 그래서 그래프가 있으면 depth를
//    forward edge에서 계산해야 한다.
//
// 2) **실행 상태 가독성**: 선택된 분기·반복 횟수·verdict가 카드에서 실제로 읽혀야
//    한다. 소스에 JSX가 있는 것만으로는 부족하다(`{cond && <div/>}`가 false로
//    접히는 실버그가 이 저장소에서 이미 있었다 — orchestration-team-scope-display
//    테스트 헤더 참고). 그래서 정규식이 아니라 실제 DOM 마운트로 단언한다.

import test from 'node:test';
import assert from 'node:assert/strict';
import { setupDom, mount, React, act } from './helpers/jsdom.mjs';
import PlanGraph, { computeDepths, describeEdgeCondition } from '../src/components/orchestration/PlanGraph.tsx';

const step = (key, overrides = {}) => ({
  id: `step-${key}`,
  step_key: key,
  title: `Step ${key}`,
  instructions: '',
  acceptance_criteria: '',
  depends_on: [],
  assignee_agent_id: 'agent-1',
  assignee_name: 'Worker',
  assignee_online: true,
  status: 'pending',
  position: 0,
  plan_version: 1,
  room_id: null,
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
  ...overrides,
});

/** 위 e2e와 같은 모양의 그래프: fan-out → fan-in → evaluator 분기 + bounded loop. */
const GRAPH = {
  version: 1,
  nodes: [
    { key: 'spec', kind: 'task', join: 'all', max_visits: 1 },
    { key: 'api', kind: 'task', join: 'all', max_visits: 1 },
    { key: 'integrate', kind: 'task', join: 'all', max_visits: 3 },
    { key: 'review', kind: 'evaluator', join: 'all', max_visits: 3 },
    { key: 'ship', kind: 'task', join: 'all', max_visits: 1 },
  ],
  edges: [
    { from: 'spec', to: 'api', kind: 'sequence' },
    { from: 'api', to: 'integrate', kind: 'sequence' },
    { from: 'integrate', to: 'review', kind: 'sequence' },
    { from: 'review', to: 'ship', kind: 'conditional', when: { verdict: ['approve'] }, label: 'looks good' },
    { from: 'review', to: 'integrate', kind: 'loop_back', when: { verdict: ['revise'] }, label: 'needs another pass' },
  ],
  entry: ['spec'],
  terminal: ['ship'],
  max_total_visits: 30,
};

const STEPS = [
  step('spec', { status: 'done', visit: 1, position: 0 }),
  step('api', { status: 'done', visit: 1, position: 1 }),
  step('integrate', { status: 'dispatched', visit: 2, position: 2 }),
  step('review', { status: 'pending', visit: 2, position: 3 }),
  step('ship', { status: 'pending', position: 4 }),
];

async function render(t, props) {
  const dom = setupDom();
  const view = mount(React.createElement(PlanGraph, { selectedId: null, onSelect: () => {}, ...props }));
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  t.after(() => {
    view.unmount();
    dom.cleanup();
  });
  return view;
}

// ── 레이아웃 ────────────────────────────────────────────────────────────────

test('computeDepths — 그래프가 있으면 depends_on이 비어 있어도 forward edge로 깊이를 계산한다', () => {
  // 실버그 재현 조건: 그래프로만 연결되고 depends_on은 전부 비어 있다.
  const depths = computeDepths(STEPS, GRAPH);
  assert.equal(depths.get('spec'), 0, 'entry는 0열');
  assert.equal(depths.get('api'), 1);
  assert.equal(depths.get('integrate'), 2);
  assert.equal(depths.get('review'), 3);
  assert.equal(depths.get('ship'), 4, '조건 분기 하류도 제 깊이를 가진다');

  const collapsed = computeDepths(STEPS, null);
  assert.equal(collapsed.get('ship'), 0, '그래프를 안 주면(기존 경로) 전부 0열로 접힌다 — 이게 고치려는 증상');
});

test('computeDepths — loop_back edge는 깊이 계산에서 제외된다', () => {
  // review → integrate loop_back을 세면 integrate가 review보다 깊어져 열이 발산한다.
  const depths = computeDepths(STEPS, GRAPH);
  assert.ok(depths.get('integrate') < depths.get('review'), 'loop_back은 상류를 하류 뒤로 밀지 않는다');
  for (const [, d] of depths) assert.ok(Number.isFinite(d) && d < STEPS.length, '깊이가 발산하지 않는다');
});

test('computeDepths — 기존 wave 미션은 depends_on 기준 그대로 동작한다', () => {
  const wave = [
    step('api', { position: 0 }),
    step('ui', { position: 1 }),
    step('ship', { depends_on: ['api', 'ui'], position: 2 }),
  ];
  const depths = computeDepths(wave);
  assert.equal(depths.get('api'), 0);
  assert.equal(depths.get('ui'), 0);
  assert.equal(depths.get('ship'), 1);
});

test('describeEdgeCondition — 라벨을 우선하고, 없으면 조건 값을 보여준다', () => {
  assert.equal(describeEdgeCondition({ from: 'a', to: 'b', kind: 'conditional', label: 'looks good' }), 'looks good');
  assert.equal(
    describeEdgeCondition({ from: 'a', to: 'b', kind: 'conditional', when: { verdict: ['approve', 'ship-it'] } }),
    'approve / ship-it',
  );
  assert.equal(describeEdgeCondition({ from: 'a', to: 'b', kind: 'sequence' }), null, '무조건 edge는 표시할 조건이 없다');
});

// ── 렌더링 ──────────────────────────────────────────────────────────────────

test('그래프 모드 카드는 edge·evaluator·pass 카운터·verdict를 실제로 렌더한다', async (t) => {
  const steps = STEPS.map((s) =>
    s.step_key === 'review' ? { ...s, status: 'done', verdict: 'revise' } : s,
  );
  const { container } = await render(t, { steps, graph: GRAPH });
  const text = container.textContent;

  assert.match(text, /looks good/, '조건 edge의 라벨이 카드에 보인다');
  assert.match(text, /needs another pass/, 'loop_back 라벨도 보인다');
  assert.match(text, /evaluator/, 'node 종류가 표시된다');
  assert.match(text, /pass 2\/3/, '반복 횟수와 상한이 보인다');
  assert.match(text, /verdict:/, '분기를 고른 근거가 보인다');
  assert.match(text, /revise/, 'verdict 값 자체가 보인다');
  assert.match(text, /Entry · starts immediately/, '그래프 모드 열 머리말');
  assert.doesNotMatch(text, /Wave 1/, '그래프 모드에서는 wave 용어를 쓰지 않는다');

  // loop_back edge는 title 속성에 방향과 조건이 그대로 담긴다 — hover로 확인 가능해야 한다.
  const titles = [...container.querySelectorAll('[title]')].map((el) => el.getAttribute('title'));
  assert.ok(
    titles.some((v) => /loop_back edge review → integrate .*needs another pass/.test(v ?? '')),
    `loop_back edge의 설명이 없다: ${JSON.stringify(titles)}`,
  );
  assert.ok(
    titles.some((v) => /conditional edge review → ship/.test(v ?? '')),
    '조건 edge의 설명이 없다',
  );
});

test('그래프가 없으면 기존 wave 카드 렌더가 그대로 유지된다', async (t) => {
  const wave = [
    step('api', { status: 'done', position: 0 }),
    step('ship', { depends_on: ['api'], position: 1 }),
  ];
  const { container } = await render(t, { steps: wave });
  const text = container.textContent;

  assert.match(text, /Wave 1 · starts immediately/, '기존 wave 머리말 유지');
  assert.match(text, /Wave 2 · after wave 1/);
  assert.match(text, /← api/, 'depends_on 칩이 그대로 렌더된다');
  assert.doesNotMatch(text, /pass \d+\//, 'wave 미션에는 반복 카운터를 붙이지 않는다');
  assert.doesNotMatch(text, /verdict:/, 'wave 미션에는 verdict 줄이 없다');
});

test('반복 상한이 1인 node에는 pass 카운터를 붙이지 않는다 (노이즈 방지)', async (t) => {
  const { container } = await render(t, {
    steps: [step('ship', { status: 'done', visit: 1 })],
    graph: {
      ...GRAPH,
      nodes: [{ key: 'ship', kind: 'task', join: 'all', max_visits: 1 }],
      edges: [],
      entry: ['ship'],
      terminal: ['ship'],
    },
  });
  assert.doesNotMatch(container.textContent, /pass 1\/1/, 'loop가 아닌 node는 카운터가 의미 없다');
});
