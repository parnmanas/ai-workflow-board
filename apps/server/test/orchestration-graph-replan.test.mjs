// replan 너머로 그래프 잇기 (순수 로직, 티켓 301018c5).
//
// 고치는 결함: graph 모드 미션에서 `submit_orchestration_plan` 을 `graph` 없이
// 재제출하면 확정된 그래프가 `depends_on` 기반 평면 DAG 로 조용히 교체됐다.
// `graphFromWavePlan` 은 sequence edge 만 만들므로 conditional/loop_back 은 표현될
// 수 없고, 오류도 경고도 없이 분기와 loop 가 사라졌다.
//
// 이 파일이 고정하는 계약:
//
//   carryGraphThroughReplan() — 이미 확정된 node/edge 는 **그대로** 두고, 이번
//                               replan 이 새로 만든 step 만 고립 node 로 편입한다.
//                               step 병합이 additive 인 것과 같은 원칙이다.
//
// 특히 중요한 단언 두 가지:
//   (1) conditional/loop_back edge 와 node 의 kind/join/max_visits 가 살아남는다.
//       이게 결함의 본체이고, sequence edge 만 세는 단언으로는 잡히지 않는다.
//   (2) applyGraphPatch 로 만든 spec 도 똑같이 이어진다 — replan 한 번이 그동안
//       적용한 patch 를 전부 되돌리던 것이 이 티켓이 급해진 이유였다.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(__dirname, '..', 'dist');

const { applyGraphPatch, carryGraphThroughReplan, graphFromWavePlan, validateGraphSpec } = await import(
  pathToFileURL(path.join(DIST, 'modules', 'orchestration', 'orchestration-graph.js')).href
);

// ── 픽스처 ───────────────────────────────────────────────────────────────────

const mustValidate = (input, nodeKeys) => {
  const result = validateGraphSpec(input, { nodeKeys });
  assert.ok(!('error' in result), `expected a valid graph, got: ${result.error}`);
  return result.spec;
};

const mustCarry = (spec, nodeKeys) => {
  const result = carryGraphThroughReplan(spec, { nodeKeys });
  assert.ok(!('error' in result), `expected the graph to carry, got: ${result.error}`);
  return result;
};

const countKind = (spec, kind) => spec.edges.filter((e) => e.kind === kind).length;
const nodeKeysOf = (spec) => spec.nodes.map((n) => n.key).sort();
const edgeSigs = (spec) =>
  spec.edges.map((e) => `${e.from}->${e.to}:${e.kind}${e.when ? `:${JSON.stringify(e.when)}` : ''}`).sort();

/**
 * 티켓 본문의 재현 픽스처와 같은 모양: fan-out + 조건 분기 2 + bounded loop 1.
 * (`orchestration-graph-execution.test.mjs` 의 `planFor` 를 순수 로직용으로 줄인 것)
 */
const BRANCHY_KEYS = ['spec', 'api', 'ui', 'integrate', 'review', 'ship', 'abort'];
const branchySpec = () =>
  mustValidate(
    {
      nodes: [
        { key: 'integrate', join: 'all', max_visits: 3 },
        { key: 'review', kind: 'evaluator', max_visits: 3 },
      ],
      edges: [
        { from: 'spec', to: 'api' },
        { from: 'spec', to: 'ui' },
        { from: 'api', to: 'integrate' },
        { from: 'ui', to: 'integrate' },
        { from: 'integrate', to: 'review' },
        { from: 'review', to: 'ship', kind: 'conditional', when: { verdict: ['approve'] }, label: 'looks good' },
        { from: 'review', to: 'abort', kind: 'conditional', when: { verdict: ['reject'] } },
        { from: 'review', to: 'integrate', kind: 'loop_back', when: { verdict: ['revise'] } },
      ],
      max_total_visits: 40,
    },
    BRANCHY_KEYS,
  );

// ── 결함 그 자체 ─────────────────────────────────────────────────────────────

test('replan 이 조건 분기와 bounded loop 를 보존한다 (결함 재현)', () => {
  const before = branchySpec();
  assert.equal(countKind(before, 'loop_back'), 1, '픽스처 전제: loop_back 1개');
  assert.equal(countKind(before, 'conditional'), 2, '픽스처 전제: conditional 2개');

  // 전형적인 replan: step 하나를 추가하고 graph 는 보내지 않는다.
  const after = mustCarry(before, [...BRANCHY_KEYS, 'docs']).spec;

  assert.equal(countKind(after, 'loop_back'), 1, 'loop_back 이 유실됐다');
  assert.equal(countKind(after, 'conditional'), 2, 'conditional 이 유실됐다');
  assert.deepEqual(
    edgeSigs(after).filter((s) => !s.startsWith('docs')),
    edgeSigs(before),
    'edge 집합이 조건까지 그대로 보존돼야 한다',
  );
});

test('예전 동작(graphFromWavePlan 재생성)이었다면 분기와 loop 가 사라진다 — 대조군', () => {
  // 이 단언이 깨지면 위 테스트가 "원래 안 사라졌는데" 를 확인하는 공허한 테스트가
  // 된다. 결함이 실재했음을 같은 픽스처로 고정해 둔다.
  const regenerated = graphFromWavePlan(
    [...BRANCHY_KEYS, 'docs'].map((key) => ({ step_key: key, depends_on: [] })),
  );
  assert.equal(countKind(regenerated, 'loop_back'), 0);
  assert.equal(countKind(regenerated, 'conditional'), 0);
});

test('node 의 kind·join·max_visits 도 함께 보존된다', () => {
  const after = mustCarry(branchySpec(), [...BRANCHY_KEYS, 'docs']).spec;
  const byKey = Object.fromEntries(after.nodes.map((n) => [n.key, n]));

  assert.equal(byKey.review.kind, 'evaluator', 'evaluator 가 task 로 되돌아갔다');
  assert.equal(byKey.integrate.join, 'all');
  assert.equal(byKey.integrate.max_visits, 3, 'loop 상한이 기본값 1 로 되돌아갔다');
  assert.equal(byKey.review.max_visits, 3);
});

// ── 새 step 편입 ─────────────────────────────────────────────────────────────

test('새 step 은 고립 node 로 편입된다 — entry 이자 terminal', () => {
  const { spec, added } = mustCarry(branchySpec(), [...BRANCHY_KEYS, 'docs', 'changelog']);

  assert.deepEqual(added.sort(), ['changelog', 'docs']);
  assert.deepEqual(nodeKeysOf(spec), [...BRANCHY_KEYS, 'docs', 'changelog'].sort());
  for (const key of ['docs', 'changelog']) {
    assert.ok(spec.entry.includes(key), `${key} 는 의존성이 없으므로 entry 여야 한다`);
    assert.ok(spec.terminal.includes(key), `${key} 는 하류가 없으므로 terminal 이어야 한다`);
    assert.equal(spec.edges.filter((e) => e.from === key || e.to === key).length, 0);
  }
});

test('step 이 늘지 않은 replan 은 그래프를 그대로 둔다', () => {
  const before = branchySpec();
  const { spec, added } = mustCarry(before, BRANCHY_KEYS);

  assert.deepEqual(added, []);
  assert.deepEqual(nodeKeysOf(spec), nodeKeysOf(before));
  assert.deepEqual(edgeSigs(spec), edgeSigs(before));
  assert.equal(spec.max_total_visits, before.max_total_visits);
});

// ── max_total_visits ─────────────────────────────────────────────────────────

test('예산에 여유가 있으면 max_total_visits 를 건드리지 않는다', () => {
  const before = branchySpec(); // 7 node, 예산 40
  const { spec } = mustCarry(before, [...BRANCHY_KEYS, 'docs']);
  assert.equal(spec.max_total_visits, 40, '선언된 상한을 편의로 올리면 안 된다');
});

test('예산이 새 node 수보다 작아지면 딱 node 수까지만 올린다', () => {
  // loop 가 없으면 validateGraphSpec 이 예산을 node 수로 자동 유도한다. 그 상태로
  // step 이 늘면 "예산이 node 수보다 작다" 로 replan 자체가 거부되던 자리다.
  const linear = mustValidate({ edges: [{ from: 'a', to: 'b' }] }, ['a', 'b', 'c']);
  assert.equal(linear.max_total_visits, 3, '픽스처 전제: 예산이 node 수로 자동 유도됨');

  const { spec } = mustCarry(linear, ['a', 'b', 'c', 'd', 'e']);
  assert.equal(spec.max_total_visits, 5, 'node 수만큼만 최소로 들어올려야 한다');
  assert.deepEqual(edgeSigs(spec), ['a->b:sequence']);
});

// ── patch 와의 조합 (완료 기준 3의 순수 로직 측면) ──────────────────────────

test('patch 로 바뀐 그래프도 replan 을 그대로 넘어간다', () => {
  const base = branchySpec();
  const runtime = { nodes: BRANCHY_KEYS.map((key) => ({ key, status: 'pending', visit: 0 })), total_visits: 0 };

  // 대기 중이던 node 로 가는 길을 하나 열고, 예산도 함께 조인다.
  const patched = applyGraphPatch(
    base,
    { add_edges: [{ from: 'spec', to: 'abort', kind: 'conditional', when: { status: ['failed'] } }] },
    { nodeKeys: BRANCHY_KEYS, runtime },
  );
  assert.ok(!('error' in patched), `patch 가 거부됐다: ${patched.error}`);
  assert.equal(countKind(patched.spec, 'conditional'), 3);

  const { spec } = mustCarry(patched.spec, [...BRANCHY_KEYS, 'docs']);
  assert.equal(countKind(spec, 'conditional'), 3, 'patch 로 추가한 edge 가 replan 에 되돌려졌다');
  assert.equal(countKind(spec, 'loop_back'), 1);
  assert.ok(
    edgeSigs(spec).some((s) => s.startsWith('spec->abort:conditional')),
    'patch 가 연 길이 그대로 남아야 한다',
  );
});

test('patch 로 제거한 loop_back 이 replan 으로 되살아나지 않는다', () => {
  const base = branchySpec();
  const runtime = {
    nodes: BRANCHY_KEYS.map((key) => ({ key, status: 'pending', visit: 0 })),
    total_visits: 0,
  };
  const patched = applyGraphPatch(
    base,
    { remove_edges: [{ from: 'review', to: 'integrate', kind: 'loop_back' }] },
    { nodeKeys: BRANCHY_KEYS, runtime },
  );
  assert.ok(!('error' in patched), `patch 가 거부됐다: ${patched.error}`);
  assert.equal(countKind(patched.spec, 'loop_back'), 0);

  const { spec } = mustCarry(patched.spec, [...BRANCHY_KEYS, 'docs']);
  assert.equal(countKind(spec, 'loop_back'), 0, 'replan 이 폭주 loop 를 되살렸다');
});

// ── 계약 경계 ────────────────────────────────────────────────────────────────

test('그래프가 참조하는 step 이 사라지면 명확한 사유로 거부한다', () => {
  // 지금은 도달 불가다 — replan 은 누락 키를 보존하고 update_orchestration_step 의
  // cancel 은 행을 지우지 않고 status 만 바꾼다. step 을 실제로 지우는 경로가 생기면
  // 여기서 걸리므로, 조용히 통과시키지 않는다는 계약을 고정해 둔다.
  const result = carryGraphThroughReplan(branchySpec(), {
    nodeKeys: BRANCHY_KEYS.filter((k) => k !== 'abort'),
  });
  assert.ok('error' in result, '사라진 step 을 참조하는 그래프가 조용히 통과했다');
  assert.match(result.error, /abort/);
});
