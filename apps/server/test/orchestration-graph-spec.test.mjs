// GraphSpec 검증 + 그래프 실행 판정 (순수 로직, 티켓 1ca9e49b).
//
// `orchestration-plan-dag.test.mjs`가 wave/DAG 모델에 대해 하는 일을 그래프
// 모델에 대해 한다 — 이 두 함수가 무엇 하나라도 잘못 판정하면 미션은 조용히
// 죽는다:
//
//   validateGraphSpec()    — 실행될 수 없는 그래프를 **실행 전에** 거부한다.
//                            특히 종료 조건이나 반복 상한이 없는 loop는 여기서
//                            막지 못하면 예산이 바닥날 때까지 subagent를 계속
//                            띄운다.
//   computeGraphProgress() — 상태가 바뀔 때마다 무엇을 지금 디스패치할 수 있고,
//                            무엇이 기다리는 중이고, 무엇이 영영 실행될 수 없는지
//                            판정한다.
//
// 그리고 이 파일에서 가장 중요한 단언은 마지막 블록의 **wave adapter 동치성**이다:
// 기존 depends_on plan을 graphFromWavePlan으로 승격했을 때 computeGraphProgress가
// computePlanProgress와 글자 그대로 같은 결과를 내야 한다. 이게 깨지면 그래프 모드를
// 켜는 순간 기존 미션의 실행 순서가 조용히 달라진다.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(__dirname, '..', 'dist');

const {
  GRAPH_SPEC_VERSION,
  applyGraphPatch,
  MAX_NODE_VISITS_CEILING,
  MAX_TOTAL_VISITS_CEILING,
  computeGraphProgress,
  computeMissionProgress,
  evaluateEdge,
  firedLoopBacks,
  graphFromWavePlan,
  loopBodyNodes,
  selectOutgoingEdges,
  validateGraphSpec,
} = await import(
  pathToFileURL(path.join(DIST, 'modules', 'orchestration', 'orchestration-graph.js')).href
);

const { computePlanProgress } = await import(
  pathToFileURL(path.join(DIST, 'modules', 'orchestration', 'orchestration.constants.js')).href
);

/** 검증을 통과시키고 spec을 꺼낸다 — 실패하면 에러 메시지를 그대로 보여준다. */
const mustValidate = (input, nodeKeys) => {
  const result = validateGraphSpec(input, { nodeKeys });
  assert.ok(!('error' in result), `expected a valid graph, got: ${result.error}`);
  return result.spec;
};

/** 검증이 거부하는지 확인하고 메시지를 돌려준다. */
const mustReject = (input, nodeKeys, pattern, message) => {
  const result = validateGraphSpec(input, { nodeKeys });
  assert.ok('error' in result, `${message} — but the graph validated`);
  assert.match(result.error, pattern, message);
  return result.error;
};

const state = (key, status, extra = {}) => ({ key, status, visit: 1, verdict: '', ...extra });

// ── 기본 형태 ────────────────────────────────────────────────────────────────

test('validateGraphSpec — 선형/병렬/fan-in DAG를 받아들이고 entry·terminal을 계산한다', () => {
  const spec = mustValidate(
    {
      nodes: [{ key: 'api' }, { key: 'ui' }, { key: 'ship' }],
      edges: [
        { from: 'api', to: 'ship' },
        { from: 'ui', to: 'ship' },
      ],
    },
    ['api', 'ui', 'ship'],
  );
  assert.equal(spec.version, GRAPH_SPEC_VERSION);
  assert.deepEqual(spec.entry.sort(), ['api', 'ui'], 'incoming edge가 없는 node가 entry');
  assert.deepEqual(spec.terminal, ['ship'], 'outgoing edge가 없는 node가 terminal');
  assert.equal(spec.max_total_visits, 3, 'loop가 없으면 예산 기본값은 node 수');
  assert.ok(
    spec.edges.every((e) => e.kind === 'sequence'),
    'kind를 생략하면 sequence',
  );
});

test('validateGraphSpec — 그래프에서 빠진 step은 고립 node로 채워진다', () => {
  const spec = mustValidate({ nodes: [{ key: 'a' }], edges: [] }, ['a', 'orphan-but-runnable']);
  assert.equal(spec.nodes.length, 2, 'plan의 모든 step이 node가 된다');
  assert.ok(spec.entry.includes('orphan-but-runnable'), '연결되지 않은 step은 entry이자 terminal');
  assert.ok(spec.terminal.includes('orphan-but-runnable'));
});

test('validateGraphSpec — plan에 없는 step을 가리키면 거부한다', () => {
  mustReject({ nodes: [{ key: 'ghost' }] }, ['real'], /does not match any step/, '유령 node는 거부');
  mustReject(
    { nodes: [{ key: 'real' }], edges: [{ from: 'real', to: 'ghost' }] },
    ['real'],
    /unknown node "ghost" as its target/,
    '유령 edge 대상은 거부',
  );
});

test('validateGraphSpec — self-edge와 중복 edge를 거부한다', () => {
  mustReject({ edges: [{ from: 'a', to: 'a' }] }, ['a'], /self-edge/, 'self-edge 거부');
  mustReject(
    { edges: [{ from: 'a', to: 'b' }, { from: 'a', to: 'b' }] },
    ['a', 'b'],
    /duplicate graph edge/,
    '같은 (from,to,kind) 중복 거부',
  );
});

test('validateGraphSpec — loop_back이 아닌 edge로 만든 순환을 거부한다', () => {
  mustReject(
    {
      edges: [
        { from: 'a', to: 'b' },
        { from: 'b', to: 'c' },
        { from: 'c', to: 'a' },
      ],
    },
    ['a', 'b', 'c'],
    /cycle through non-loop_back edges/,
    '실수로 만든 순환은 여전히 거부된다',
  );
});

test('validateGraphSpec — 어느 entry에서도 도달할 수 없는 node를 거부한다(deadlock)', () => {
  // b ↔ c 쌍은 서로만 가리켜 entry가 없다 — a에서 도달할 수 없다.
  const result = validateGraphSpec(
    { edges: [{ from: 'b', to: 'c' }, { from: 'c', to: 'b' }] },
    { nodeKeys: ['a', 'b', 'c'] },
  );
  assert.ok('error' in result, '고립된 순환 쌍은 거부돼야 한다');
  assert.match(result.error, /cycle through non-loop_back edges|cannot be reached/);
});

// ── 조건 분기 ────────────────────────────────────────────────────────────────

test('validateGraphSpec — conditional edge는 when 조건이 없으면 거부한다', () => {
  mustReject(
    { edges: [{ from: 'a', to: 'b', kind: 'conditional' }] },
    ['a', 'b'],
    /has no "when" condition/,
    '조건 없는 conditional은 sequence와 구별되지 않는다',
  );
});

test('validateGraphSpec — router는 2개 이상의 조건부 outgoing edge를 요구한다', () => {
  mustReject(
    {
      nodes: [{ key: 'route', kind: 'router' }],
      edges: [{ from: 'route', to: 'only', kind: 'conditional', when: { verdict: ['x'] } }],
    },
    ['route', 'only'],
    /must choose between at least 2/,
    '분기가 하나뿐인 router는 router가 아니다',
  );
  mustReject(
    {
      nodes: [{ key: 'route', kind: 'router' }],
      edges: [
        { from: 'route', to: 'a', kind: 'conditional', when: { verdict: ['x'] } },
        { from: 'route', to: 'b' },
      ],
    },
    ['route', 'a', 'b'],
    /unconditional outgoing edge/,
    'router에서 무조건 나가는 길이 있으면 분기 선택이 무의미해진다',
  );
});

test('validateGraphSpec — evaluator는 verdict로 갈라지는 edge를 최소 하나 요구한다', () => {
  mustReject(
    {
      nodes: [{ key: 'review', kind: 'evaluator' }],
      edges: [{ from: 'review', to: 'ship' }],
    },
    ['review', 'ship'],
    /no outgoing edge that branches on a verdict/,
    'verdict를 아무도 안 보는 evaluator는 task와 같다',
  );
});

// ── loop 안전장치 (수용 기준: 종료 조건 + hard cap 없으면 거부) ──────────────

const loopGraph = (overrides = {}) => ({
  nodes: [
    { key: 'draft', max_visits: 3 },
    { key: 'review', kind: 'evaluator', max_visits: 3 },
    { key: 'ship' },
    ...(overrides.extraNodes ?? []),
  ],
  edges: [
    { from: 'draft', to: 'review' },
    { from: 'review', to: 'ship', kind: 'conditional', when: { verdict: ['approve'] } },
    { from: 'review', to: 'draft', kind: 'loop_back', when: { verdict: ['revise'] }, ...(overrides.loopEdge ?? {}) },
  ],
  max_total_visits: 12,
  ...overrides.spec,
});

test('validateGraphSpec — evaluator→revision bounded loop를 받아들인다', () => {
  const spec = mustValidate(loopGraph(), ['draft', 'review', 'ship']);
  const loop = spec.edges.find((e) => e.kind === 'loop_back');
  assert.ok(loop, 'loop_back edge가 보존된다');
  assert.deepEqual(spec.entry, ['draft'], 'loop_back은 entry 계산에서 제외된다');
  assert.deepEqual(spec.terminal, ['ship']);
});

test('validateGraphSpec — 종료 조건(when)이 없는 loop_back을 거부한다', () => {
  const graph = loopGraph();
  delete graph.edges[2].when;
  mustReject(
    graph,
    ['draft', 'review', 'ship'],
    /loop_back edge .* has no "when" condition/,
    '종료 조건 없는 loop는 멈출 수 없다',
  );
});

test('validateGraphSpec — 반복 상한(max_visits >= 2)이 없는 loop_back을 거부한다', () => {
  const graph = loopGraph();
  graph.nodes[0].max_visits = 1; // draft
  mustReject(
    graph,
    ['draft', 'review', 'ship'],
    /needs node "draft" to declare max_visits >= 2/,
    'hard iteration cap 없는 loop는 거부된다',
  );
});

test('validateGraphSpec — global budget(max_total_visits)이 없는 loop를 거부한다', () => {
  const graph = loopGraph();
  delete graph.max_total_visits;
  mustReject(
    graph,
    ['draft', 'review', 'ship'],
    /no max_total_visits budget/,
    'loop가 있으면 mission 단위 hard budget cap이 필수다',
  );
});

test('validateGraphSpec — loop가 없으면 max_total_visits는 선택이다', () => {
  const spec = mustValidate({ edges: [{ from: 'a', to: 'b' }] }, ['a', 'b']);
  assert.equal(spec.max_total_visits, 2, 'loop 없는 그래프는 node 수를 기본 예산으로 받는다');
});

test('validateGraphSpec — 실제로 순환을 닫지 않는 loop_back을 거부한다', () => {
  mustReject(
    {
      nodes: [{ key: 'a' }, { key: 'b', max_visits: 3 }, { key: 'c' }],
      edges: [
        { from: 'a', to: 'c' },
        // b는 a의 하류가 아니므로 a→b는 순환이 아니다.
        { from: 'a', to: 'b', kind: 'loop_back', when: { verdict: ['x'] } },
      ],
      max_total_visits: 9,
    },
    ['a', 'b', 'c'],
    /does not close a loop/,
    'loop_back으로 위장한 일반 점프는 거부된다',
  );
});

test('validateGraphSpec — 예산과 반복 상한의 상한/하한을 강제한다', () => {
  mustReject(
    { edges: [{ from: 'a', to: 'b' }], max_total_visits: MAX_TOTAL_VISITS_CEILING + 1 },
    ['a', 'b'],
    /invalid max_total_visits/,
    '전역 예산 상한 초과 거부',
  );
  mustReject(
    { nodes: [{ key: 'a' }, { key: 'b' }, { key: 'c' }], max_total_visits: 2 },
    ['a', 'b', 'c'],
    /below the 3 node\(s\)/,
    '모든 node를 한 번도 못 도는 예산은 거부',
  );
  mustReject(
    { nodes: [{ key: 'a', max_visits: MAX_NODE_VISITS_CEILING + 1 }] },
    ['a'],
    /invalid max_visits/,
    'node 반복 상한 초과 거부',
  );
});

test('validateGraphSpec — loop 본문 node에 반복 상한을 전파한다', () => {
  // draft → mid → review → (loop_back) draft. mid는 max_visits를 선언하지 않았지만
  // 재진입 때 함께 리셋되므로 loop 상한을 물려받아야 한다.
  const spec = mustValidate(
    {
      nodes: [{ key: 'draft', max_visits: 4 }, { key: 'mid' }, { key: 'review', kind: 'evaluator' }, { key: 'ship' }],
      edges: [
        { from: 'draft', to: 'mid' },
        { from: 'mid', to: 'review' },
        { from: 'review', to: 'ship', kind: 'conditional', when: { verdict: ['approve'] } },
        { from: 'review', to: 'draft', kind: 'loop_back', when: { verdict: ['revise'] } },
      ],
      max_total_visits: 20,
    },
    ['draft', 'mid', 'review', 'ship'],
  );
  const byKey = Object.fromEntries(spec.nodes.map((n) => [n.key, n]));
  assert.equal(byKey.mid.max_visits, 4, 'loop 본문은 loop 상한을 물려받는다');
  assert.equal(byKey.review.max_visits, 4, 'evaluator 자신도 본문이다');
  assert.equal(byKey.ship.max_visits, 1, 'loop 밖 node는 그대로 1');
});

test('loopBodyNodes — loop 밖으로 갈라진 가지는 리셋 대상이 아니다', () => {
  const spec = mustValidate(
    {
      nodes: [{ key: 'draft', max_visits: 3 }, { key: 'review', kind: 'evaluator' }, { key: 'ship' }, { key: 'aside' }],
      edges: [
        { from: 'draft', to: 'review' },
        { from: 'draft', to: 'aside' }, // loop 밖 가지
        { from: 'review', to: 'ship', kind: 'conditional', when: { verdict: ['approve'] } },
        { from: 'review', to: 'draft', kind: 'loop_back', when: { verdict: ['revise'] } },
      ],
      max_total_visits: 20,
    },
    ['draft', 'review', 'ship', 'aside'],
  );
  const loop = spec.edges.find((e) => e.kind === 'loop_back');
  const body = loopBodyNodes(spec.edges, loop).sort();
  assert.deepEqual(body, ['draft', 'review'], 'loop를 통과하는 node만 재실행된다');
  assert.ok(!body.includes('aside'), '이미 확정된 곁가지를 다시 돌리면 중복 실행이 된다');
  assert.ok(!body.includes('ship'), 'loop 하류는 본문이 아니다');
});

// ── edge 판정 ────────────────────────────────────────────────────────────────

test('evaluateEdge — 조건 없는 edge는 done/skipped만 만족시킨다', () => {
  const edge = { from: 'a', to: 'b', kind: 'sequence' };
  assert.equal(evaluateEdge(edge, state('a', 'done')).state, 'satisfied');
  assert.equal(evaluateEdge(edge, state('a', 'skipped')).state, 'satisfied');
  assert.equal(evaluateEdge(edge, state('a', 'running')).state, 'pending');
  assert.equal(evaluateEdge(edge, state('a', 'failed')).state, 'dead');
  assert.equal(evaluateEdge(edge, undefined).state, 'satisfied', 'plan에서 사라진 상류는 하류를 고착시키지 않는다');
});

test('evaluateEdge — verdict 조건은 값이 맞을 때만 통과하고 이유를 남긴다', () => {
  const edge = { from: 'review', to: 'ship', kind: 'conditional', when: { verdict: ['approve'] } };
  const ok = evaluateEdge(edge, state('review', 'done', { verdict: 'approve' }));
  assert.equal(ok.state, 'satisfied');
  assert.match(ok.reason, /verdict "approve"/, '선택 이유가 사람이 읽을 수 있게 남는다');

  const no = evaluateEdge(edge, state('review', 'done', { verdict: 'revise' }));
  assert.equal(no.state, 'dead');
  assert.match(no.reason, /reported verdict "revise", not approve/, '기각 이유도 남는다');

  const missing = evaluateEdge(edge, state('review', 'done', { verdict: '' }));
  assert.equal(missing.state, 'dead');
  assert.match(missing.reason, /no verdict/);
});

test('evaluateEdge — 실패한 상류의 verdict는 신뢰하지 않는다', () => {
  const edge = { from: 'review', to: 'ship', kind: 'conditional', when: { verdict: ['approve'] } };
  const result = evaluateEdge(edge, state('review', 'failed', { verdict: 'approve' }));
  assert.equal(result.state, 'dead', 'failed로 끝난 evaluator의 판정은 분기 근거가 될 수 없다');
  assert.match(result.reason, /not trusted/);

  // 다만 status를 명시적으로 허용하면 실패 경로 분기도 표현할 수 있다.
  const failureBranch = {
    from: 'review',
    to: 'rescue',
    kind: 'conditional',
    when: { status: ['failed'] },
  };
  assert.equal(evaluateEdge(failureBranch, state('review', 'failed')).state, 'satisfied');
});

// ── join policy ──────────────────────────────────────────────────────────────

test('computeGraphProgress — join=all은 fan-in, join=any는 분기 합류에서 동작한다', () => {
  const all = mustValidate(
    { nodes: [{ key: 'ship', join: 'all' }], edges: [{ from: 'api', to: 'ship' }, { from: 'ui', to: 'ship' }] },
    ['api', 'ui', 'ship'],
  );
  const half = computeGraphProgress(all, [state('api', 'done'), state('ui', 'running'), state('ship', 'pending')]);
  assert.deepEqual(half.waiting, ['ship'], 'all 이면 하나만 끝나도 아직 대기');

  const both = computeGraphProgress(all, [state('api', 'done'), state('ui', 'done'), state('ship', 'pending')]);
  assert.deepEqual(both.dispatchable, ['ship']);

  const any = mustValidate(
    { nodes: [{ key: 'ship', join: 'any' }], edges: [{ from: 'api', to: 'ship' }, { from: 'ui', to: 'ship' }] },
    ['api', 'ui', 'ship'],
  );
  const one = computeGraphProgress(any, [state('api', 'done'), state('ui', 'running'), state('ship', 'pending')]);
  assert.deepEqual(one.dispatchable, ['ship'], 'any 면 하나로 충분');
});

test('computeGraphProgress — join=all에서 죽은 edge가 하나라도 있으면 blocked', () => {
  const spec = mustValidate({ edges: [{ from: 'api', to: 'ship' }] }, ['api', 'ship']);
  const progress = computeGraphProgress(spec, [state('api', 'failed'), state('ship', 'pending')]);
  assert.deepEqual(progress.newlyBlocked, ['ship']);
  assert.equal(progress.allTerminal, false);
});

test('computeGraphProgress — join=any는 모든 분기가 죽어야 blocked가 된다', () => {
  const spec = mustValidate(
    {
      nodes: [{ key: 'merge', join: 'any' }, { key: 'route', kind: 'router' }],
      edges: [
        { from: 'route', to: 'merge', kind: 'conditional', when: { verdict: ['left'] } },
        { from: 'route', to: 'other', kind: 'conditional', when: { verdict: ['right'] } },
        { from: 'other', to: 'merge' },
      ],
    },
    ['route', 'merge', 'other'],
  );
  // router가 right를 골랐다 → route→merge는 죽었지만 other 경유 경로가 살아있다.
  const routed = computeGraphProgress(spec, [
    state('route', 'done', { verdict: 'right' }),
    state('other', 'pending'),
    state('merge', 'pending'),
  ]);
  assert.deepEqual(routed.dispatchable, ['other']);
  assert.deepEqual(routed.waiting, ['merge'], '살아있는 경로가 남아 있으면 blocked가 아니다');
});

test('computeGraphProgress — 조건 분기: 선택되지 않은 가지만 blocked가 된다', () => {
  const spec = mustValidate(
    {
      nodes: [{ key: 'review', kind: 'evaluator' }],
      edges: [
        { from: 'review', to: 'ship', kind: 'conditional', when: { verdict: ['approve'] } },
        { from: 'review', to: 'rework', kind: 'conditional', when: { verdict: ['reject'] } },
      ],
    },
    ['review', 'ship', 'rework'],
  );
  const progress = computeGraphProgress(spec, [
    state('review', 'done', { verdict: 'approve' }),
    state('ship', 'pending'),
    state('rework', 'pending'),
  ]);
  assert.deepEqual(progress.dispatchable, ['ship'], '선택된 분기만 실행된다');
  assert.deepEqual(progress.newlyBlocked, ['rework'], '선택되지 않은 분기는 영구 차단');
});

// ── 선택 이유 / loop 발화 ────────────────────────────────────────────────────

test('selectOutgoingEdges — 선택된 edge와 기각된 edge를 이유와 함께 돌려준다', () => {
  const spec = mustValidate(
    {
      nodes: [{ key: 'review', kind: 'evaluator' }],
      edges: [
        { from: 'review', to: 'ship', kind: 'conditional', when: { verdict: ['approve'] }, label: 'looks good' },
        { from: 'review', to: 'rework', kind: 'conditional', when: { verdict: ['reject'] } },
      ],
    },
    ['review', 'ship', 'rework'],
  );
  const { taken, notTaken } = selectOutgoingEdges(spec, 'review', state('review', 'done', { verdict: 'approve' }));
  assert.deepEqual(taken.map((t) => t.edge.to), ['ship']);
  assert.equal(taken[0].edge.label, 'looks good', '라벨이 보존돼 trace에 그대로 실린다');
  assert.deepEqual(notTaken.map((t) => t.edge.to), ['rework']);
  assert.match(notTaken[0].reason, /not reject/, '기각 이유가 재구성 가능하다');
});

test('firedLoopBacks — 조건이 맞은 loop_back만 발화한다', () => {
  const spec = mustValidate(loopGraph(), ['draft', 'review', 'ship']);
  assert.equal(firedLoopBacks(spec, 'review', state('review', 'done', { verdict: 'revise' })).length, 1);
  assert.equal(firedLoopBacks(spec, 'review', state('review', 'done', { verdict: 'approve' })).length, 0);
  assert.equal(firedLoopBacks(spec, 'review', state('review', 'failed', { verdict: 'revise' })).length, 0);
});

// ── wave adapter 동치성 (기존 미션 회귀 보장) ────────────────────────────────

test('graphFromWavePlan — depends_on plan을 무손실로 승격한다', () => {
  const spec = graphFromWavePlan([
    { step_key: 'ship', depends_on: ['api', 'ui'] },
    { step_key: 'api', depends_on: [] },
    { step_key: 'ui', depends_on: ['api'] },
  ]);
  assert.equal(spec.nodes.length, 3);
  assert.ok(spec.nodes.every((n) => n.kind === 'task' && n.join === 'all' && n.max_visits === 1));
  assert.ok(spec.edges.every((e) => e.kind === 'sequence' && !e.when));
  assert.deepEqual(
    spec.edges.map((e) => `${e.from}->${e.to}`).sort(),
    ['api->ship', 'api->ui', 'ui->ship'],
    'depends_on이 forward edge로 전치된다',
  );
});

test('graphFromWavePlan — plan에 없는 의존성은 edge로 만들지 않는다', () => {
  // computePlanProgress가 dangling dependency를 "만족됨"으로 취급하는 것과 같은 결과.
  const spec = graphFromWavePlan([{ step_key: 'a', depends_on: ['deleted-by-replan'] }]);
  assert.equal(spec.edges.length, 0);
  assert.deepEqual(spec.entry, ['a'], 'a는 여전히 즉시 실행 가능해야 한다');
});

test('graphFromWavePlan — 승격된 그래프의 판정이 computePlanProgress와 정확히 일치한다', () => {
  const plan = [
    { step_key: 'api', depends_on: [] },
    { step_key: 'ui', depends_on: [] },
    { step_key: 'ship', depends_on: ['api', 'ui'] },
    { step_key: 'docs', depends_on: ['ship'] },
    { step_key: 'solo', depends_on: [] },
  ];
  const spec = graphFromWavePlan(plan);

  // 모든 step에 서로 다른 상태 조합을 넣어 두 구현이 같은 답을 내는지 확인한다.
  const STATUSES = ['pending', 'ready', 'dispatched', 'running', 'done', 'failed', 'blocked', 'skipped', 'cancelled'];
  let compared = 0;
  for (const apiStatus of STATUSES) {
    for (const uiStatus of STATUSES) {
      for (const shipStatus of ['pending', 'running', 'done', 'failed']) {
        const steps = [
          { step_key: 'api', status: apiStatus, depends_on: [] },
          { step_key: 'ui', status: uiStatus, depends_on: [] },
          { step_key: 'ship', status: shipStatus, depends_on: ['api', 'ui'] },
          { step_key: 'docs', status: 'pending', depends_on: ['ship'] },
          { step_key: 'solo', status: 'pending', depends_on: [] },
        ];
        const wave = computePlanProgress(steps);
        const graph = computeGraphProgress(
          spec,
          steps.map((s) => ({ key: s.step_key, status: s.status, visit: 1, verdict: '' })),
        );
        const label = `api=${apiStatus} ui=${uiStatus} ship=${shipStatus}`;
        assert.deepEqual(graph.dispatchable.sort(), wave.dispatchable.sort(), `dispatchable diverged: ${label}`);
        assert.deepEqual(graph.waiting.sort(), wave.waiting.sort(), `waiting diverged: ${label}`);
        assert.deepEqual(graph.newlyBlocked.sort(), wave.newlyBlocked.sort(), `newlyBlocked diverged: ${label}`);
        assert.deepEqual(graph.inFlight.sort(), wave.inFlight.sort(), `inFlight diverged: ${label}`);
        assert.deepEqual(graph.done.sort(), wave.done.sort(), `done diverged: ${label}`);
        assert.deepEqual(graph.failed.sort(), wave.failed.sort(), `failed diverged: ${label}`);
        assert.equal(graph.allTerminal, wave.allTerminal, `allTerminal diverged: ${label}`);
        compared += 1;
      }
    }
  }
  assert.equal(compared, STATUSES.length * STATUSES.length * 4, '모든 상태 조합을 실제로 비교했다');
});

test('computeMissionProgress — graph_spec이 없으면 기존 depends_on 경로를 그대로 쓴다', () => {
  const steps = [
    { step_key: 'a', status: 'done', depends_on: [] },
    { step_key: 'b', status: 'pending', depends_on: ['a'] },
  ];
  assert.deepEqual(computeMissionProgress(null, steps), computePlanProgress(steps));
  assert.deepEqual(computeMissionProgress(undefined, steps).dispatchable, ['b']);
});

// ── 사용자 확인(confirm) 노드 — 티켓 5dbe4aa2 ────────────────────────────────
//
// confirm 노드는 사람이 답할 때까지 미션을 멈춘다. 그래서 잘못 만들어진 게이트의
// 실패 형태는 "에러"가 아니라 **영구 정지**다:
//   - 한쪽 판정만 라우팅된 게이트 → 사용자가 다른 답을 고르면 나가는 edge 가 전부
//     dead 라 미션이 조용히 선다. 사람에게 물어놓고 그 답을 버리는 셈이다.
//   - `none` 정책 미션의 게이트 → 운영자가 "확인 없이 끝까지 돌려라"라고 지시한
//     미션이 사람을 기다리며 멈춘다.
// 둘 다 실행 **전에** 거부해야 한다.

/** confirm 게이트가 붙은 최소 그래프. `overrides` 로 edge/정책을 바꿔 끼운다. */
const confirmGraph = (edges) => ({
  version: GRAPH_SPEC_VERSION,
  nodes: [
    { key: 'build', kind: 'task', max_visits: 3 },
    { key: 'gate', kind: 'confirm', max_visits: 3 },
    { key: 'ship', kind: 'task' },
  ],
  edges,
  max_total_visits: 20,
});

const PASS_FAIL_EDGES = [
  { from: 'build', to: 'gate' },
  { from: 'gate', to: 'ship', kind: 'conditional', when: { verdict: ['pass'] }, label: 'approved' },
  { from: 'gate', to: 'build', kind: 'loop_back', when: { verdict: ['fail'] }, label: 'needs rework' },
];
const CONFIRM_KEYS = ['build', 'gate', 'ship'];

test('validateGraphSpec — pass/fail 양쪽이 라우팅된 confirm 게이트는 수용된다', () => {
  const r = validateGraphSpec(confirmGraph(PASS_FAIL_EDGES), {
    nodeKeys: CONFIRM_KEYS,
    confirmPolicy: 'auto',
  });
  assert.ok(!('error' in r), `수용돼야 한다: ${r.error}`);
  assert.equal(r.spec.nodes.find((n) => n.key === 'gate').kind, 'confirm');
  // fail 경로가 loop_back 이어도 라우팅으로 인정된다 — 재작업 loop 가 표준 형태다.
  assert.ok(r.spec.edges.some((e) => e.kind === 'loop_back' && e.when.verdict.includes('fail')));
});

test('validateGraphSpec — confirm 게이트에 fail 경로가 없으면 거부된다', () => {
  const r = validateGraphSpec(
    confirmGraph([
      { from: 'build', to: 'gate' },
      { from: 'gate', to: 'ship', kind: 'conditional', when: { verdict: ['pass'] } },
    ]),
    { nodeKeys: CONFIRM_KEYS, confirmPolicy: 'auto' },
  );
  assert.ok('error' in r, '한쪽만 라우팅된 게이트는 사용자의 다른 답을 버린다');
  assert.match(r.error, /"fail"/);
  assert.match(r.error, /gate/);
});

test('validateGraphSpec — confirm 게이트에 pass 경로가 없으면 거부된다', () => {
  const r = validateGraphSpec(
    confirmGraph([
      { from: 'build', to: 'gate' },
      { from: 'gate', to: 'build', kind: 'loop_back', when: { verdict: ['fail'] } },
      // ship 이 고아가 되지 않도록 붙여 둔다 — 거부 사유가 고아 검사로 바뀌면
      // 이 테스트가 검증하려던 규칙을 지나쳐 통과한다.
      { from: 'build', to: 'ship' },
    ]),
    { nodeKeys: CONFIRM_KEYS, confirmPolicy: 'auto' },
  );
  assert.ok('error' in r);
  assert.match(r.error, /"pass"/);
});

test('validateGraphSpec — confirm_policy "none" 은 confirm 노드의 존재 자체를 거부한다', () => {
  const r = validateGraphSpec(confirmGraph(PASS_FAIL_EDGES), {
    nodeKeys: CONFIRM_KEYS,
    confirmPolicy: 'none',
  });
  assert.ok('error' in r);
  assert.match(r.error, /confirm_policy is "none"/);
});

test('validateGraphSpec — key_steps/every_step/auto 는 모두 confirm 노드를 허용한다', () => {
  for (const policy of ['auto', 'key_steps', 'every_step']) {
    const r = validateGraphSpec(confirmGraph(PASS_FAIL_EDGES), {
      nodeKeys: CONFIRM_KEYS,
      confirmPolicy: policy,
    });
    assert.ok(!('error' in r), `${policy} 에서 수용돼야 한다: ${r.error}`);
  }
});

test('validateGraphSpec — 미지/빈 confirm_policy 는 기본값(auto)으로 접혀 confirm 을 허용한다', () => {
  // DDL 마이그레이션 없이 추가된 컬럼이라 기존 행이 ''/NULL 로 남을 수 있다.
  // 그 값이 `none` 처럼 취급되면 기존 미션에서 기능이 조용히 죽는다.
  for (const policy of ['', null, undefined, 'nonsense']) {
    const r = validateGraphSpec(confirmGraph(PASS_FAIL_EDGES), {
      nodeKeys: CONFIRM_KEYS,
      confirmPolicy: policy,
    });
    assert.ok(!('error' in r), `${JSON.stringify(policy)} 는 기본값으로 접혀야 한다: ${r.error}`);
  }
});

test('validateGraphSpec — confirm 노드는 assignee 를 요구하지 않는다(그래프 검증 대상이 아니다)', () => {
  // 그래프 검증은 assignee 를 아예 보지 않는다. 이 단언은 "봐서는 안 된다"를 고정한다 —
  // 만약 여기에 assignee 검사가 생기면 confirm 노드가 실행 전에 거부되고, 사람이
  // 답하는 게이트에 담당 에이전트를 배정하라는 모순된 요구가 된다.
  const r = validateGraphSpec(confirmGraph(PASS_FAIL_EDGES), {
    nodeKeys: CONFIRM_KEYS,
    confirmPolicy: 'auto',
  });
  assert.ok(!('error' in r));
});

test('applyGraphPatch — set_nodes 로 task 를 confirm 으로 바꿔도 정책과 라우팅 규칙을 그대로 받는다', () => {
  // patch 는 결과 전체를 validateGraphSpec 에 다시 태운다. 정책을 전달하지 않으면
  // `none` 미션이 patch 한 번으로 게이트를 얻는다 — 제출로는 거부되는 그래프가
  // patch 로는 통과하는, 두 경로가 갈라지는 정확한 구멍이다.
  const base = validateGraphSpec(
    {
      version: GRAPH_SPEC_VERSION,
      nodes: [{ key: 'build' }, { key: 'gate' }, { key: 'ship' }],
      edges: [
        { from: 'build', to: 'gate' },
        { from: 'gate', to: 'ship' },
      ],
      max_total_visits: 10,
    },
    { nodeKeys: CONFIRM_KEYS, confirmPolicy: 'none' },
  );
  assert.ok(!('error' in base));
  const runtime = {
    nodes: CONFIRM_KEYS.map((key) => ({ key, status: 'pending', visit: 0, verdict: '' })),
    total_visits: 0,
  };

  const denied = applyGraphPatch(base.spec, { set_nodes: [{ key: 'gate', kind: 'confirm' }] }, {
    nodeKeys: CONFIRM_KEYS,
    confirmPolicy: 'none',
    runtime,
  });
  assert.ok('error' in denied, 'none 정책은 patch 경로로도 게이트를 얻을 수 없어야 한다');
  assert.match(denied.error, /confirm_policy is "none"/);

  // 정책이 허용해도 라우팅 규칙은 그대로다 — 지금 gate → ship 은 무조건 edge 라
  // pass/fail 어느 쪽도 라우팅되지 않았다.
  const unrouted = applyGraphPatch(base.spec, { set_nodes: [{ key: 'gate', kind: 'confirm' }] }, {
    nodeKeys: CONFIRM_KEYS,
    confirmPolicy: 'auto',
    runtime,
  });
  assert.ok('error' in unrouted);
  assert.match(unrouted.error, /"pass"/);
});

test('computeGraphProgress — awaiting_user 게이트는 하류를 열지 않고, 자신도 다시 열리지 않는다', () => {
  const spec = validateGraphSpec(confirmGraph(PASS_FAIL_EDGES), {
    nodeKeys: CONFIRM_KEYS,
    confirmPolicy: 'auto',
  }).spec;
  const p = computeGraphProgress(spec, [
    { key: 'build', status: 'done', visit: 1, verdict: '' },
    { key: 'gate', status: 'awaiting_user', visit: 1, verdict: '' },
    { key: 'ship', status: 'pending', visit: 0, verdict: '' },
  ]);
  assert.deepEqual(p.awaitingUser, ['gate']);
  assert.ok(!p.dispatchable.includes('gate'));
  assert.ok(!p.inFlight.includes('gate'));
  // 하류는 대기 — 사용자의 답이 아직 없으므로 pass edge 는 pending 이다.
  assert.deepEqual(p.waiting, ['ship']);
  assert.deepEqual(p.newlyBlocked, []);
  assert.equal(p.allTerminal, false);
});

test('computeGraphProgress — pass 판정 뒤에는 pass edge 만 열린다', () => {
  const spec = validateGraphSpec(
    confirmGraph([
      { from: 'build', to: 'gate' },
      { from: 'gate', to: 'ship', kind: 'conditional', when: { verdict: ['pass'] } },
      { from: 'gate', to: 'build', kind: 'loop_back', when: { verdict: ['fail'] } },
    ]),
    { nodeKeys: CONFIRM_KEYS, confirmPolicy: 'auto' },
  ).spec;
  const p = computeGraphProgress(spec, [
    { key: 'build', status: 'done', visit: 1, verdict: '' },
    // 판정이 끝난 게이트는 done + verdict 를 갖는다 — evaluator 와 정확히 같은 모양이라
    // 분기 기계를 새로 만들 필요가 없다는 것이 이 설계의 근거다.
    { key: 'gate', status: 'done', visit: 1, verdict: 'pass' },
    { key: 'ship', status: 'pending', visit: 0, verdict: '' },
  ]);
  assert.deepEqual(p.dispatchable, ['ship']);
  assert.deepEqual(p.awaitingUser, []);
});

// ── confirm 분기가 **실제로** 갈라지는지 (리뷰 라운드1) ──────────────────────
//
// "pass 용 edge 와 fail 용 edge 가 각각 하나 이상 있다"만 재면 구멍이 둘 남는다.
// 둘 다 검증은 통과하는데 사용자의 두 답이 실행상 구분되지 않아, 게이트가 분기가 아니라
// 단순 "확인 버튼"이 된다 — 요구사항 5가 조용히 깨지는 형태다.

test('validateGraphSpec — 한 edge 가 pass 와 fail 을 동시에 실으면 거부된다', () => {
  // `{ verdict: ['pass','fail'] }` 하나뿐이면 어느 답을 골라도 같은 edge 를 탄다.
  const r = validateGraphSpec(
    confirmGraph([
      { from: 'build', to: 'gate' },
      { from: 'gate', to: 'ship', kind: 'conditional', when: { verdict: ['pass', 'fail'] } },
    ]),
    { nodeKeys: CONFIRM_KEYS, confirmPolicy: 'auto' },
  );
  assert.ok('error' in r, '결합 verdict edge 는 분기를 만들지 못한다');
  assert.match(r.error, /matches BOTH "pass" and "fail"/);
  assert.match(r.error, /gate/);
});

test('validateGraphSpec — pass 와 fail 이 같은 node 로 가면 거부된다', () => {
  // edge 는 둘로 갈라져 있지만 도착지가 같으면 그 node 는 사람이 무엇을 답하든 실행된다.
  // 두 edge 모두 conditional 로 둔다 — loop_back 을 쓰면 "loop 를 닫지 않는다" 규칙에
  // 먼저 걸려서 정작 재려던 규칙을 지나쳐버린다.
  const r = validateGraphSpec(
    confirmGraph([
      { from: 'build', to: 'gate' },
      { from: 'gate', to: 'ship', kind: 'conditional', when: { verdict: ['pass'] } },
      { from: 'gate', to: 'ship', kind: 'sequence', when: { verdict: ['fail'] } },
    ]),
    { nodeKeys: CONFIRM_KEYS, confirmPolicy: 'auto' },
  );
  assert.ok('error' in r);
  assert.match(r.error, /routes both "pass" and "fail" to "ship"/);
});

test('validateGraphSpec — 별도 edge + 별도 target 이면 수용된다(정상 형태)', () => {
  // 이 파일 위쪽의 PASS_FAIL_EDGES 가 바로 그 형태다. 위 두 규칙이 정상 그래프를
  // 잡아먹지 않는다는 것을 같은 자리에서 다시 고정한다.
  const r = validateGraphSpec(confirmGraph(PASS_FAIL_EDGES), {
    nodeKeys: CONFIRM_KEYS,
    confirmPolicy: 'auto',
  });
  assert.ok(!('error' in r), `정상 형태가 거부되면 안 된다: ${r.error}`);
  const outgoing = r.spec.edges.filter((e) => e.from === 'gate');
  const pass = outgoing.filter((e) => (e.when?.verdict ?? []).includes('pass'));
  const fail = outgoing.filter((e) => (e.when?.verdict ?? []).includes('fail'));
  assert.equal(pass.length, 1);
  assert.equal(fail.length, 1);
  assert.notEqual(pass[0].to, fail[0].to, '두 답이 서로 다른 node 를 연다');
});

test('validateGraphSpec — 두 답의 경로가 겹치지만 않으면 여러 갈래여도 수용된다', () => {
  // 규칙은 "겹치지 마라"이지 "각각 하나여야 한다"가 아니다. fan-out 자체는 막지 않는다.
  const r = validateGraphSpec(
    {
      version: GRAPH_SPEC_VERSION,
      nodes: [
        { key: 'build', kind: 'task', max_visits: 3 },
        { key: 'gate', kind: 'confirm', max_visits: 3 },
        { key: 'ship', kind: 'task' },
        { key: 'announce', kind: 'task' },
      ],
      edges: [
        { from: 'build', to: 'gate' },
        { from: 'gate', to: 'ship', kind: 'conditional', when: { verdict: ['pass'] } },
        { from: 'gate', to: 'announce', kind: 'conditional', when: { verdict: ['pass'] } },
        { from: 'gate', to: 'build', kind: 'loop_back', when: { verdict: ['fail'] } },
      ],
      max_total_visits: 20,
    },
    { nodeKeys: ['build', 'gate', 'ship', 'announce'], confirmPolicy: 'auto' },
  );
  assert.ok(!('error' in r), `pass 쪽 fan-out 은 정상이다: ${r.error}`);
});

test('validateGraphSpec — evaluator 의 동의어 verdict 묶음은 여전히 허용된다', () => {
  // 위 규칙은 confirm 전용이다. evaluator 에서 `['approve','ship-it']` 같은 동의어
  // 묶음까지 막으면 기존 그래프가 깨진다.
  const r = validateGraphSpec(
    {
      version: GRAPH_SPEC_VERSION,
      nodes: [
        { key: 'build', kind: 'task' },
        { key: 'review', kind: 'evaluator' },
        { key: 'ship', kind: 'task' },
      ],
      edges: [
        { from: 'build', to: 'review' },
        { from: 'review', to: 'ship', kind: 'conditional', when: { verdict: ['approve', 'ship-it'] } },
      ],
      max_total_visits: 10,
    },
    { nodeKeys: ['build', 'review', 'ship'], confirmPolicy: 'auto' },
  );
  assert.ok(!('error' in r), `evaluator 규칙은 바뀌지 않았다: ${r.error}`);
});

test('applyGraphPatch — patch 로도 결합 verdict edge 를 만들 수 없다', () => {
  // 제출로 거부되는 그래프가 patch 로는 통과하면 두 경로가 갈라진다.
  const base = validateGraphSpec(confirmGraph(PASS_FAIL_EDGES), {
    nodeKeys: CONFIRM_KEYS,
    confirmPolicy: 'auto',
  });
  assert.ok(!('error' in base));
  const runtime = {
    nodes: CONFIRM_KEYS.map((key) => ({ key, status: 'pending', visit: 0, verdict: '' })),
    total_visits: 0,
  };

  const merged = applyGraphPatch(
    base.spec,
    {
      remove_edges: [
        { from: 'gate', to: 'ship' },
        { from: 'gate', to: 'build' },
      ],
      add_edges: [{ from: 'gate', to: 'ship', kind: 'conditional', when: { verdict: ['pass', 'fail'] } }],
    },
    { nodeKeys: CONFIRM_KEYS, confirmPolicy: 'auto', runtime },
  );
  assert.ok('error' in merged);
  assert.match(merged.error, /matches BOTH "pass" and "fail"/);
});
