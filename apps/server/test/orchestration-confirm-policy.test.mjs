// 사용자 확인 강도 정책 — 정규화 + 오케스트레이터에게 전달되는 지시 (티켓 5dbe4aa2).
//
// 이 정책은 서버가 강제하는 부분(`none` = confirm 노드 거부)과, **프롬프트로만**
// 전달되는 부분(auto / key_steps / every_step)으로 나뉜다. 후자를 정량 강제하지
// 않기로 한 이상, 정책이 실제로 하는 일은 브리핑 문구를 바꾸는 것이 전부다 — 즉
// 네 값이 서로 다른 지시를 만들어내지 못하면 옵션이 존재하지 않는 것과 같다.
// "select 는 있는데 골라도 아무 일도 없는" 죽은 컨트롤이 되는 실패 형태라, 여기서
// 값별 차이를 직접 단언한다.
//
// `normalizeConfirmPolicy` 는 그보다 조용한 실패를 막는다: 이 컬럼은 DDL
// 마이그레이션 없이 엔티티 default 로 추가되므로 기존 행이 ''/NULL 로 남을 수 있고,
// 그 값이 그대로 흐르면 어느 분기에도 걸리지 않아 기능이 영구 no-op 이 된다.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(__dirname, '..', 'dist');

const { CONFIRM_POLICIES, DEFAULT_CONFIRM_POLICY, normalizeConfirmPolicy } = await import(
  pathToFileURL(path.join(DIST, 'modules', 'orchestration', 'orchestration.constants.js')).href
);
const { renderConfirmPolicyGuidance, renderMissionPrompt } = await import(
  pathToFileURL(path.join(DIST, 'modules', 'orchestration', 'orchestration-prompt.js')).href
);

const mission = (overrides = {}) => ({
  id: 'mission-1',
  title: 'Ship the export',
  objective: 'Add a CSV export.',
  context: '',
  method: '',
  acceptance_criteria: '',
  completion_criteria: null,
  max_parallel_steps: 3,
  max_steps: 60,
  max_plan_versions: 6,
  graph_enabled: true,
  confirm_policy: 'auto',
  ...overrides,
});

const brief = (overrides = {}) =>
  renderMissionPrompt({
    mission: mission(overrides),
    teamName: 'Squad',
    teamPrompt: '',
    roster: [
      {
        agent_id: 'a1',
        agent_name: 'Manager/Worker',
        role_label: 'builder',
        capabilities: '',
        max_concurrent: 2,
        is_online: true,
      },
    ],
  });

// ── 정규화 ───────────────────────────────────────────────────────────────────

test('normalizeConfirmPolicy — 알려진 값 4개는 그대로 통과한다', () => {
  assert.deepEqual([...CONFIRM_POLICIES], ['none', 'auto', 'key_steps', 'every_step']);
  for (const p of CONFIRM_POLICIES) assert.equal(normalizeConfirmPolicy(p), p);
});

test('normalizeConfirmPolicy — 빈값/NULL/미지값은 기본값으로 접힌다', () => {
  assert.equal(DEFAULT_CONFIRM_POLICY, 'auto');
  for (const bad of ['', '   ', null, undefined, 'NONE_BUT_TYPOED', 42, {}, []]) {
    assert.equal(
      normalizeConfirmPolicy(bad),
      'auto',
      `${JSON.stringify(bad)} 가 기본값으로 접히지 않으면 그 미션에서 정책이 영구 no-op 이 된다`,
    );
  }
});

test('normalizeConfirmPolicy — 대소문자/공백은 흡수하되 의미는 바꾸지 않는다', () => {
  assert.equal(normalizeConfirmPolicy(' NONE '), 'none');
  assert.equal(normalizeConfirmPolicy('Key_Steps'), 'key_steps');
  // 'none' 이 공백 하나 때문에 'auto' 로 접히면, 확인을 금지한 미션이 게이트를 얻는다.
  assert.notEqual(normalizeConfirmPolicy(' NONE '), 'auto');
});

// ── 정책별 지시문 ────────────────────────────────────────────────────────────

test('renderConfirmPolicyGuidance — 네 값이 서로 다른 지시를 만든다', () => {
  const rendered = new Map(CONFIRM_POLICIES.map((p) => [p, renderConfirmPolicyGuidance(p)]));
  const seen = new Set();
  for (const [policy, text] of rendered) {
    assert.ok(text.trim().length > 0, `${policy} 의 지시가 비어 있다`);
    assert.ok(!seen.has(text), `${policy} 의 지시가 다른 정책과 글자 그대로 같다 — 옵션이 무의미해진다`);
    seen.add(text);
  }
});

test('renderConfirmPolicyGuidance — none 은 금지를 명시하고 작성법을 알려주지 않는다', () => {
  const text = renderConfirmPolicyGuidance('none');
  assert.match(text, /does NOT allow user confirmation gates/);
  // 금지해놓고 만드는 법을 이어서 설명하면 오케스트레이터가 거부당할 계획을 짠다.
  assert.doesNotMatch(text, /How to write one/);
});

test('renderConfirmPolicyGuidance — 허용 정책은 pass/fail 양쪽 필수를 반드시 알린다', () => {
  for (const policy of ['auto', 'key_steps', 'every_step']) {
    const text = renderConfirmPolicyGuidance(policy);
    assert.match(text, /verdict: \["pass"\]/, `${policy}: pass edge 작성법이 없다`);
    assert.match(text, /verdict: \["fail"\]/, `${policy}: fail edge 작성법이 없다`);
    // 이걸 안 알려주면 오케스트레이터가 한쪽만 라우팅한 그래프를 만들고 제출에서 거부된다.
    assert.match(text, /Both are required/);
    assert.match(text, /no assignee/i, `${policy}: assignee 불필요 안내가 없다`);
    assert.match(text, /pauses/, `${policy}: 미션이 멈춘다는 사실을 알려야 게이트 수를 판단할 수 있다`);
  }
});

test('renderConfirmPolicyGuidance — 미지값도 기본 정책 지시를 낸다', () => {
  assert.equal(renderConfirmPolicyGuidance('bogus'), renderConfirmPolicyGuidance('auto'));
  assert.equal(renderConfirmPolicyGuidance(''), renderConfirmPolicyGuidance('auto'));
});

// ── 브리핑에 실제로 실리는가 ─────────────────────────────────────────────────

test('renderMissionPrompt — graph 모드 미션의 브리핑은 정책 절을 담고, 값에 따라 달라진다', () => {
  const texts = CONFIRM_POLICIES.map((p) => brief({ confirm_policy: p }));
  for (const [i, text] of texts.entries()) {
    assert.match(text, /## User confirmation gates/, `${CONFIRM_POLICIES[i]}: 정책 절이 없다`);
  }
  assert.equal(new Set(texts).size, texts.length, '정책이 달라도 브리핑이 같으면 옵션이 전달되지 않은 것이다');
});

test('renderMissionPrompt — graph 모드가 꺼진 미션에는 정책 절을 아예 싣지 않는다', () => {
  // confirm 노드는 graph 모드에서만 만들 수 있다. 꺼진 미션에 작성법을 설명하면
  // 오케스트레이터가 만들 수 없는 계획을 짜고 submit 에서 거부당한다.
  const text = brief({ graph_enabled: false, confirm_policy: 'every_step' });
  assert.doesNotMatch(text, /## User confirmation gates/);
});

test('renderMissionPrompt — confirm_policy 가 빈 문자열인 기존 미션도 기본 지시를 받는다', () => {
  const text = brief({ confirm_policy: '' });
  assert.match(text, /## User confirmation gates/);
  assert.match(text, /Current policy: \*\*auto\*\*/);
});
