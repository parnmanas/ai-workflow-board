// Runtime graph patching + graph template 라이브러리 (순수 로직, 티켓 2fc8f99a).
//
// 이 파일이 지키는 두 계약:
//
//   applyGraphPatch()      — 실행 중인 그래프를 부분 수정하되 **이미 일어난 실행
//                            이력을 소급해서 무효화하지 않는다**. 여기서 막지
//                            못하면 "상한 2인데 이미 3번 실행된 node" 같은, 엔진이
//                            표현할 수 없는 상태가 DB에 남는다.
//   expandGraphTemplate()  — 템플릿이 펼친 그래프도 손으로 쓴 그래프와 **똑같이**
//                            validateGraphSpec을 통과해야 한다. 템플릿이 규칙을
//                            면제받기 시작하면 "템플릿으로는 되는데 직접 쓰면
//                            거부되는" 그래프가 생긴다.
//
// 특히 중요한 단언은 loop 관련 두 가지다: (1) 진행 중인 loop의 max_visits를 이미
// 소진한 횟수 아래로 낮추는 것은 거부되고, (2) loop_back edge 제거는 항상 허용되며
// 이미 끝난 반복은 그대로 남는다(= 폭주 loop의 탈출구).

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(__dirname, '..', 'dist');

const {
  MAX_GRAPH_PATCHES,
  applyGraphPatch,
  computeGraphProgress,
  validateGraphSpec,
} = await import(
  pathToFileURL(path.join(DIST, 'modules', 'orchestration', 'orchestration-graph.js')).href
);

const { GRAPH_TEMPLATE_NAMES, expandGraphTemplate, listGraphTemplates } = await import(
  pathToFileURL(path.join(DIST, 'modules', 'orchestration', 'orchestration-graph-templates.js')).href
);

// ── 픽스처 ───────────────────────────────────────────────────────────────────

const mustValidate = (input, nodeKeys) => {
  const result = validateGraphSpec(input, { nodeKeys });
  assert.ok(!('error' in result), `expected a valid graph, got: ${result.error}`);
  return result.spec;
};

/** draft → review 검토 루프 + 통과 시 ship. 이 파일 대부분이 이 그래프를 쓴다. */
const LOOP_KEYS = ['draft', 'review', 'ship', 'audit'];
const loopSpec = () =>
  mustValidate(
    {
      nodes: [
        { key: 'draft', max_visits: 3 },
        { key: 'review', kind: 'evaluator', max_visits: 3 },
        { key: 'ship' },
      ],
      edges: [
        { from: 'draft', to: 'review', kind: 'sequence' },
        { from: 'review', to: 'draft', kind: 'loop_back', when: { verdict: ['revise'] } },
        { from: 'review', to: 'ship', kind: 'conditional', when: { verdict: ['pass'] } },
      ],
      max_total_visits: 10,
    },
    LOOP_KEYS,
  );

/** 실행 상태를 만든다. 지정하지 않은 node는 아직 실행 전(pending, visit 0). */
const runtime = (overrides = {}, totalVisits = 0) => ({
  nodes: LOOP_KEYS.map((key) => ({
    key,
    status: overrides[key]?.status ?? 'pending',
    visit: overrides[key]?.visit ?? 0,
    verdict: overrides[key]?.verdict ?? '',
  })),
  total_visits: totalVisits,
});

const patch = (spec, input, rt = runtime(), nodeKeys = LOOP_KEYS) =>
  applyGraphPatch(spec, input, { nodeKeys, runtime: rt });

const mustPatch = (spec, input, rt, nodeKeys) => {
  const result = patch(spec, input, rt, nodeKeys);
  assert.ok(!('error' in result), `expected the patch to apply, got: ${result.error}`);
  return result;
};

const mustRefuse = (spec, input, rt, pattern, message, nodeKeys) => {
  const result = patch(spec, input, rt, nodeKeys);
  assert.ok('error' in result, `${message} — but the patch was accepted`);
  assert.match(result.error, pattern, message);
  return result.error;
};

const hasEdge = (spec, from, to, kind) =>
  spec.edges.some((e) => e.from === from && e.to === to && (!kind || e.kind === kind));

// ── 실행 이력 보존 규칙 ──────────────────────────────────────────────────────

test('진행 중인 loop의 max_visits를 이미 소진한 횟수 아래로 낮추면 거부된다', () => {
  // draft가 이미 3번 돌았는데 상한을 2로 낮추면 "상한 초과 상태로 이미 실행된 node"가 된다.
  const error = mustRefuse(
    loopSpec(),
    { set_nodes: [{ key: 'draft', max_visits: 2 }] },
    runtime({ draft: { status: 'done', visit: 3 }, review: { status: 'running', visit: 3 } }, 6),
    /already run 3 time\(s\)/,
    '이미 3회 실행된 node의 상한을 2로 낮추는 것은 거부돼야 한다',
  );
  assert.match(error, /Lower it to 3/, '거부 메시지는 허용 가능한 최소값을 알려줘야 한다');
});

test('max_visits를 정확히 현재 visit으로 낮추는 것은 허용된다 — 폭주 loop를 세우는 정상 수단', () => {
  // 상한 5로 시작해 3번 돈 loop를 "이번이 마지막"으로 잠근다.
  const spec = mustValidate(
    {
      nodes: [
        { key: 'draft', max_visits: 5 },
        { key: 'review', kind: 'evaluator', max_visits: 5 },
        { key: 'ship' },
      ],
      edges: [
        { from: 'draft', to: 'review', kind: 'sequence' },
        { from: 'review', to: 'draft', kind: 'loop_back', when: { verdict: ['revise'] } },
        { from: 'review', to: 'ship', kind: 'conditional', when: { verdict: ['pass'] } },
      ],
      max_total_visits: 15,
    },
    ['draft', 'review', 'ship'],
  );
  const result = mustPatch(
    spec,
    { set_nodes: [{ key: 'draft', max_visits: 3 }] },
    {
      nodes: [
        { key: 'draft', status: 'done', visit: 3, verdict: '' },
        { key: 'review', status: 'done', visit: 3, verdict: 'revise' },
        { key: 'ship', status: 'pending', visit: 0, verdict: '' },
      ],
      total_visits: 6,
    },
    ['draft', 'review', 'ship'],
  );
  assert.equal(result.spec.nodes.find((n) => n.key === 'draft').max_visits, 3);
});

test('예산을 이미 소진한 total_visits 아래로 낮추면 거부된다', () => {
  mustRefuse(
    loopSpec(),
    { max_total_visits: 4 },
    runtime({ draft: { status: 'done', visit: 2 } }, 7),
    /already used 7 of its execution budget/,
    '이미 7을 쓴 미션의 예산을 4로 낮추는 것은 거부돼야 한다',
  );
});

test('예산을 정확히 소진량으로 낮추면 허용된다 — 추가 디스패치만 멈춘다', () => {
  const result = mustPatch(loopSpec(), { max_total_visits: 7 }, runtime({}, 7));
  assert.equal(result.spec.max_total_visits, 7);
  assert.ok(
    result.changes.some((c) => c.kind === 'budget_updated' && /10 → 7/.test(c.detail)),
    '예산 변경이 changes에 기록돼야 한다',
  );
});

test('loop_back 제거는 진행 중이어도 허용되고, 이미 끝난 반복은 그대로 남는다', () => {
  const before = loopSpec();
  const rt = runtime({ draft: { status: 'done', visit: 2 }, review: { status: 'done', visit: 2, verdict: 'revise' } }, 4);
  const result = mustPatch(before, { remove_edges: [{ from: 'review', to: 'draft', kind: 'loop_back' }] }, rt);

  assert.ok(!hasEdge(result.spec, 'review', 'draft'), 'loop_back edge가 제거돼야 한다');
  // 이미 소진한 visit(2)보다 큰 상한이 남아 있어도 재진입 경로 자체가 사라졌으므로 안전하다.
  assert.equal(result.spec.nodes.find((n) => n.key === 'draft').max_visits, 3);
  // 그리고 draft는 done 상태 그대로다 — patch는 step 상태를 건드리지 않는다.
  const progress = computeGraphProgress(result.spec, rt.nodes);
  assert.ok(progress.done.includes('draft'), '이미 완료된 반복은 patch 후에도 완료로 남아야 한다');
});

test('이미 종료한 node로 들어가는 edge 추가는 허용되지만 이번 pass에 효력이 없다고 알려준다', () => {
  const result = mustPatch(
    loopSpec(),
    { add_edges: [{ from: 'audit', to: 'draft', kind: 'conditional', when: { status: ['done'] } }] },
    runtime({ draft: { status: 'done', visit: 1 }, ship: { status: 'pending' } }, 1),
  );
  const added = result.changes.find((c) => c.kind === 'edge_added');
  assert.ok(added.inert_reason, '이미 끝난 node로 가는 edge는 inert_reason이 있어야 한다');
  assert.match(added.inert_reason, /already finished/);
});

test('실행 중인 node로 들어가는 edge 추가도 inert 로 표시된다', () => {
  const result = mustPatch(
    loopSpec(),
    { add_edges: [{ from: 'audit', to: 'review' }] },
    runtime({ draft: { status: 'done', visit: 1 }, review: { status: 'running', visit: 1 } }, 2),
  );
  const added = result.changes.find((c) => c.kind === 'edge_added');
  assert.match(added.inert_reason ?? '', /already running/);
});

test('아직 시작 안 한 node로 가는 edge 추가는 inert 표시가 없다 — 실제로 게이트가 걸린다', () => {
  const result = mustPatch(loopSpec(), { add_edges: [{ from: 'draft', to: 'ship' }] }, runtime());
  const added = result.changes.find((c) => c.kind === 'edge_added');
  assert.equal(added.inert_reason, undefined);
  assert.ok(hasEdge(result.spec, 'draft', 'ship', 'sequence'));
});

// ── 구조 재검증(patch 전용 우회 경로가 없어야 한다) ─────────────────────────

test('patch로도 순환을 몰래 만들 수 없다 — 재검증이 그대로 거부한다', () => {
  mustRefuse(
    loopSpec(),
    { add_edges: [{ from: 'ship', to: 'draft', kind: 'sequence' }] },
    runtime(),
    /cycle through non-loop_back edges/,
    'sequence edge로 순환을 닫는 patch는 거부돼야 한다',
  );
});

test('patch로 추가한 loop_back에도 종료 조건 규칙이 그대로 적용된다', () => {
  mustRefuse(
    loopSpec(),
    { add_edges: [{ from: 'ship', to: 'draft', kind: 'loop_back' }] },
    runtime(),
    /has no "when" condition/,
    '종료 조건 없는 loop_back은 patch 경로에서도 거부돼야 한다',
  );
});

test('patch가 node를 도달 불가로 만들면 거부된다', () => {
  mustRefuse(
    loopSpec(),
    { remove_edges: [{ from: 'draft', to: 'review' }] },
    runtime(),
    /cannot be reached from any entry node|does not close a loop/,
    'review를 고아로 만드는 edge 제거는 거부돼야 한다',
  );
});

test('patch 결과의 예산은 node 수 하한을 그대로 지켜야 한다', () => {
  mustRefuse(
    loopSpec(),
    { max_total_visits: 2 },
    runtime(),
    /is below the \d+ node\(s\)/,
    'node 수보다 작은 예산은 거부돼야 한다',
  );
});

// ── patch 연산 자체의 계약 ──────────────────────────────────────────────────

test('빈 patch는 거부된다', () => {
  mustRefuse(loopSpec(), {}, runtime(), /graph patch is empty/, '빈 patch는 거부돼야 한다');
  mustRefuse(loopSpec(), null, runtime(), /must be an object/, 'null patch는 거부돼야 한다');
});

test('존재하지 않는 edge 제거는 조용한 no-op이 아니라 오류다', () => {
  mustRefuse(
    loopSpec(),
    { remove_edges: [{ from: 'draft', to: 'ship' }] },
    runtime(),
    /no such edge in the current graph/,
    '없는 edge를 지우려는 시도는 오류여야 한다(오타가 성공으로 보고되면 안 된다)',
  );
});

test('kind를 생략한 제거는 두 node 사이의 모든 edge를 지운다', () => {
  // 같은 (from,to) 쌍에 kind 만 다른 edge 두 개를 둔다 — validateGraphSpec 은
  // `from to kind` 로 중복을 판정하므로 이 조합은 유효하다.
  const keys = ['a', 'b', 'c'];
  const spec = mustValidate(
    {
      nodes: keys.map((key) => ({ key })),
      edges: [
        { from: 'a', to: 'b', kind: 'sequence' },
        { from: 'a', to: 'b', kind: 'conditional', when: { status: ['done'] } },
        { from: 'b', to: 'c', kind: 'sequence' },
      ],
      max_total_visits: 3,
    },
    keys,
  );
  assert.equal(spec.edges.filter((e) => e.from === 'a' && e.to === 'b').length, 2);

  const result = mustPatch(spec, { remove_edges: [{ from: 'a', to: 'b' }] }, {
    nodes: keys.map((key) => ({ key, status: 'pending', visit: 0, verdict: '' })),
    total_visits: 0,
  }, keys);
  assert.ok(!hasEdge(result.spec, 'a', 'b'), 'kind 를 생략했으므로 두 edge 모두 사라져야 한다');
  assert.equal(result.changes.filter((c) => c.kind === 'edge_removed').length, 2);
  assert.ok(hasEdge(result.spec, 'b', 'c'), '관계없는 edge 는 남아야 한다');
});

test('그래프에 없는 node를 set_nodes로 만들 수 없다 — node 추가는 plan의 일이다', () => {
  mustRefuse(
    loopSpec(),
    { set_nodes: [{ key: 'deploy', max_visits: 2 }] },
    runtime(),
    /not in the current graph/,
    'patch로 node를 새로 만들 수 없어야 한다',
  );
});

test('아무것도 바꾸지 않는 patch는 거부된다', () => {
  mustRefuse(
    loopSpec(),
    { set_nodes: [{ key: 'ship', max_visits: 1 }], max_total_visits: 10 },
    runtime(),
    /would not change anything/,
    '현재 상태와 동일한 patch는 거부돼야 한다',
  );
});

test('patch가 건드리지 않은 속성은 재검증에서 기본값으로 되돌아가지 않는다', () => {
  const result = mustPatch(loopSpec(), { max_total_visits: 12 }, runtime());
  const review = result.spec.nodes.find((n) => n.key === 'review');
  assert.equal(review.kind, 'evaluator', 'kind가 task로 되돌아가면 안 된다');
  assert.equal(review.max_visits, 3, 'max_visits가 1로 되돌아가면 안 된다');
  const conditional = result.spec.edges.find((e) => e.from === 'review' && e.to === 'ship');
  assert.deepEqual(conditional.when, { verdict: ['pass'] }, 'edge 조건이 유실되면 안 된다');
});

test('patch 횟수 상한 상수가 존재한다', () => {
  assert.ok(Number.isInteger(MAX_GRAPH_PATCHES) && MAX_GRAPH_PATCHES > 0);
});

// ── 그래프 템플릿 ────────────────────────────────────────────────────────────

test('카탈로그는 이름·용도·파라미터·예시를 모두 제공한다', () => {
  const templates = listGraphTemplates();
  assert.deepEqual(
    templates.map((t) => t.name).sort(),
    [...GRAPH_TEMPLATE_NAMES].sort(),
    '카탈로그와 이름 목록이 어긋나면 MCP 스키마 enum이 존재하지 않는 템플릿을 광고하게 된다',
  );
  for (const t of templates) {
    assert.ok(t.summary && t.when_to_use, `${t.name}: 요약과 용도가 있어야 한다`);
    assert.ok(Array.isArray(t.params) && t.params.length > 0, `${t.name}: 파라미터 설명이 있어야 한다`);
    assert.ok(t.example && Object.keys(t.example).length > 0, `${t.name}: 예시가 있어야 한다`);
    assert.equal(t.build, undefined, '빌더 함수는 카탈로그에 노출되면 안 된다');
  }
});

test('카탈로그의 예시는 그대로 펼쳐서 유효한 그래프가 된다', () => {
  for (const t of listGraphTemplates()) {
    const keys = new Set();
    for (const v of Object.values(t.example)) {
      if (typeof v === 'string') keys.add(v);
      else if (Array.isArray(v)) v.forEach((k) => keys.add(k));
    }
    const result = expandGraphTemplate(t.name, t.example, { nodeKeys: [...keys] });
    assert.ok(!('error' in result), `템플릿 "${t.name}"의 예시가 펼쳐지지 않는다: ${result.error}`);
  }
});

test('linear 템플릿은 주어진 순서대로 사슬을 만든다', () => {
  const keys = ['research', 'draft', 'publish'];
  const result = expandGraphTemplate('linear', { steps: keys }, { nodeKeys: keys });
  assert.ok(!('error' in result), result.error);
  assert.ok(hasEdge(result.spec, 'research', 'draft', 'sequence'));
  assert.ok(hasEdge(result.spec, 'draft', 'publish', 'sequence'));
  assert.ok(!hasEdge(result.spec, 'research', 'publish'), '건너뛰는 edge를 만들면 안 된다');
  assert.deepEqual(result.spec.entry, ['research']);
  assert.deepEqual(result.spec.terminal, ['publish']);
});

test('linear 템플릿은 step 2개 미만이거나 중복이면 거부한다', () => {
  const one = expandGraphTemplate('linear', { steps: ['solo'] }, { nodeKeys: ['solo'] });
  assert.match(one.error, /at least 2 step_key/);
  const dup = expandGraphTemplate('linear', { steps: ['a', 'a'] }, { nodeKeys: ['a'] });
  assert.match(dup.error, /twice/);
});

test('review_loop 템플릿은 loop 4대 요건을 한 번에 만족시킨다', () => {
  const keys = ['draft', 'critique', 'publish'];
  const result = expandGraphTemplate(
    'review_loop',
    { work: 'draft', review: 'critique', max_passes: 3, on_pass: 'publish' },
    { nodeKeys: keys },
  );
  assert.ok(!('error' in result), result.error);
  const spec = result.spec;

  // (1) loop_back edge + (2) 종료 조건
  const loop = spec.edges.find((e) => e.kind === 'loop_back');
  assert.ok(loop, 'loop_back edge가 있어야 한다');
  assert.deepEqual(loop.when, { verdict: ['revise'] });
  // (3) 대상 node의 유한한 반복 상한
  assert.equal(spec.nodes.find((n) => n.key === 'draft').max_visits, 3);
  // (4) 미션 단위 예산
  assert.ok(spec.max_total_visits >= 3);
  // evaluator 로 표시돼야 verdict 분기가 의미를 갖는다
  assert.equal(spec.nodes.find((n) => n.key === 'critique').kind, 'evaluator');
  assert.ok(hasEdge(spec, 'critique', 'publish', 'conditional'));
});

test('review_loop가 만든 그래프는 실제로 재진입한다', () => {
  const keys = ['draft', 'critique', 'publish'];
  const { spec } = expandGraphTemplate(
    'review_loop',
    { work: 'draft', review: 'critique', max_passes: 3, on_pass: 'publish' },
    { nodeKeys: keys },
  );
  // critique가 revise를 냈을 때 publish는 dead edge 때문에 blocked 후보가 돼야 하고,
  // draft로 돌아가는 loop_back이 발화 대상이어야 한다.
  const states = [
    { key: 'draft', status: 'done', visit: 1, verdict: '' },
    { key: 'critique', status: 'done', visit: 1, verdict: 'revise' },
    { key: 'publish', status: 'pending', visit: 0, verdict: '' },
  ];
  const progress = computeGraphProgress(spec, states);
  assert.ok(
    progress.newlyBlocked.includes('publish'),
    'revise verdict면 통과 분기는 blocked로 확정돼야 한다(영원한 pending 방지)',
  );
});

test('review_loop는 max_passes가 2 미만이거나 verdict가 겹치면 거부한다', () => {
  const keys = ['w', 'r'];
  const tooFew = expandGraphTemplate('review_loop', { work: 'w', review: 'r', max_passes: 1 }, { nodeKeys: keys });
  assert.match(tooFew.error, /max_passes/);
  const sameVerdict = expandGraphTemplate(
    'review_loop',
    { work: 'w', review: 'r', max_passes: 2, pass_verdict: 'ok', revise_verdict: 'ok' },
    { nodeKeys: keys },
  );
  assert.match(sameVerdict.error, /must differ/);
  const same = expandGraphTemplate('review_loop', { work: 'w', review: 'w', max_passes: 2 }, { nodeKeys: keys });
  assert.match(same.error, /must be different steps/);
});

test('fan_out_aggregate 템플릿은 모든 갈래를 집계 step에 join=all로 모은다', () => {
  const keys = ['spec', 'api', 'ui', 'docs', 'integrate'];
  const result = expandGraphTemplate(
    'fan_out_aggregate',
    { source: 'spec', branches: ['api', 'ui', 'docs'], aggregate: 'integrate' },
    { nodeKeys: keys },
  );
  assert.ok(!('error' in result), result.error);
  const spec = result.spec;
  for (const branch of ['api', 'ui', 'docs']) {
    assert.ok(hasEdge(spec, 'spec', branch, 'sequence'), `spec → ${branch} 이 있어야 한다`);
    assert.ok(hasEdge(spec, branch, 'integrate', 'sequence'), `${branch} → integrate 가 있어야 한다`);
  }
  assert.equal(spec.nodes.find((n) => n.key === 'integrate').join, 'all');
  assert.deepEqual(spec.entry, ['spec']);

  // source가 끝나면 세 갈래가 한꺼번에 디스패치 가능해야 한다(진짜 fan-out).
  const progress = computeGraphProgress(spec, [
    { key: 'spec', status: 'done', visit: 1, verdict: '' },
    ...['api', 'ui', 'docs', 'integrate'].map((key) => ({ key, status: 'pending', visit: 0, verdict: '' })),
  ]);
  assert.deepEqual(progress.dispatchable.sort(), ['api', 'docs', 'ui']);
  assert.ok(progress.waiting.includes('integrate'), '집계 step은 모든 갈래를 기다려야 한다');
});

test('fan_out_aggregate는 aggregate가 갈래와 겹치면 거부한다', () => {
  const result = expandGraphTemplate(
    'fan_out_aggregate',
    { branches: ['a', 'b'], aggregate: 'a' },
    { nodeKeys: ['a', 'b'] },
  );
  assert.match(result.error, /cannot also be one of the branches/);
});

test('plan에 없는 step을 가리키는 템플릿은 템플릿 이름과 함께 거부된다', () => {
  const result = expandGraphTemplate(
    'linear',
    { steps: ['exists', 'missing'] },
    { nodeKeys: ['exists'] },
  );
  assert.match(result.error, /graph template "linear" references step\(s\) missing/);
});

test('알 수 없는 템플릿 이름은 사용 가능한 목록을 알려주며 거부된다', () => {
  const result = expandGraphTemplate('spiral', {}, { nodeKeys: ['a'] });
  assert.match(result.error, /unknown graph template "spiral"/);
  for (const name of GRAPH_TEMPLATE_NAMES) assert.match(result.error, new RegExp(name));
});

test('템플릿이 언급하지 않은 step은 고립 node로 채워진다(기존 동작 유지)', () => {
  const result = expandGraphTemplate(
    'linear',
    { steps: ['a', 'b'] },
    { nodeKeys: ['a', 'b', 'orphan_free_standalone'] },
  );
  assert.ok(!('error' in result), result.error);
  assert.ok(result.spec.nodes.some((n) => n.key === 'orphan_free_standalone'));
  assert.ok(result.spec.entry.includes('orphan_free_standalone'), '고립 node는 entry 이자 terminal 이다');
  assert.ok(result.spec.terminal.includes('orphan_free_standalone'));
});
