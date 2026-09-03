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
