// credential 공란 fallback 안내 순수 로직 회귀 테스트 (티켓 d2360de6).
//
// 미러가 아니라 4개 표시 지점(admin/AgentManager, AgentsPage,
// admin/ManagedAgentDialog, AgentDetailModal)이 실제로 import 하는
// src/utils/credentialFallback.ts 를 그대로 구동한다. 어댑터별 문구를
// 오배선하거나(예: deepseek 을 "CLI login" 이라 표기) 반오판 방지 프레이밍을
// 지우면 이 테스트가 실패한다.
//
// 배경: 원 티켓 09a0442f 에서 Codex `credential_id: null` 을 "인증 미설정"으로
// 반복 오판했다. 이 헬퍼는 공란 credential 이 "호스트 로그인 fallback(정상)"임을
// 어댑터별로 명확히 표시하기 위한 단일 진실이다.
//
// 실행:  node --import tsx --test apps/client/test/credential-fallback.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';

import { credentialFallbackCopy } from '../src/utils/credentialFallback.ts';

// ─── 1. 반오판 방지 불변식 — 공란은 "정상 fallback 설정"이되 인증 가용성 단정 금지 ──
//
// 이 티켓의 존재 이유. 어떤 어댑터든 공란 fallback 설명은 (a) "공란 = per-agent
// credential 미부착(정상 fallback 설정)이지 그 자체가 인증 실패 아님" 프레이밍을
// 담아야 한다(이 문장을 지우면 반오판이 재발한다). 동시에 (b) 공란이 실제 인증
// 가용성까지 보장한다고 과잉 단정하면 안 된다 — host 파일/env 가 없으면 auth 는
// 여전히 실패하므로, 문구는 host credential 이 "실제로 존재해야 함"을 함께 밝힌다.
// (리뷰 지적: 예전 "not missing auth" 단정이 host credential 부재 가능성을 오인시킴.)

for (const cli of ['claude', 'codex', 'deepseek', 'antigravity', 'pi', 'custom', 'unknown-future-cli']) {
  test(`meaning: ${cli} → "정상 fallback 설정" 프레이밍 포함`, () => {
    const { meaning } = credentialFallbackCopy(cli);
    assert.match(meaning, /valid fallback configuration/i, `${cli} meaning 이 반오판 방지 문구를 담아야 함`);
    assert.match(meaning, /not a per-agent credential gap/i);
  });
  test(`meaning: ${cli} → 인증 가용성은 host credential 존재에 달렸음을 명시(과잉단정 금지)`, () => {
    const { meaning } = credentialFallbackCopy(cli);
    // 설정 의미(fallback 경로 선택)와 실제 인증 가용성을 구분한다: 공란이 auth
    // 존재를 보장한다고 오인시키면 안 됨.
    assert.match(
      meaning,
      /authentication still requires/i,
      `${cli} meaning 은 host credential/env 가 실제로 존재해야 함을 밝혀야 함`,
    );
    // 예전의 과잉 단정 문구가 되살아나지 않도록 고정.
    assert.doesNotMatch(meaning, /not missing auth/i);
  });
  test(`optionLabel: ${cli} → "None" 으로 시작(빈 옵션 규약)`, () => {
    const { optionLabel } = credentialFallbackCopy(cli);
    assert.match(optionLabel, /^None\b/, '드롭다운 빈 옵션은 항상 None 으로 시작');
  });
}

// ─── 2. 어댑터별 정확성 — claude/codex 는 CLI 로그인 파일, deepseek/antigravity 는 env ──
//
// 뭉뚱그려 전부 "Host CLI login" 이라 쓰면 deepseek/antigravity 에는 틀린다
// (그들은 로그인 파일이 아니라 호스트 셸 env 로 fallback). 그 구분을 고정한다.

test('codex → 호스트 codex login / auth.json (티켓의 핵심 케이스)', () => {
  const { optionLabel, meaning } = credentialFallbackCopy('codex');
  assert.match(optionLabel, /Codex CLI login/);
  assert.match(optionLabel, /codex login/);
  assert.match(meaning, /~\/\.codex\/auth\.json/);
});

test('claude → 호스트 claude login / .credentials.json', () => {
  const { optionLabel, meaning } = credentialFallbackCopy('claude');
  assert.match(optionLabel, /Claude CLI login/);
  assert.match(optionLabel, /claude login/);
  assert.match(meaning, /\.credentials\.json/);
});

test('deepseek → 호스트 env(DEEPSEEK_API_KEY), 로그인 파일 아님', () => {
  const { optionLabel, meaning } = credentialFallbackCopy('deepseek');
  assert.match(optionLabel, /DEEPSEEK_API_KEY/);
  assert.match(meaning, /shell environment/);
  // 로그인 파일 기반 어댑터가 아니므로 "CLI login" 이라 표기하면 안 됨.
  assert.doesNotMatch(optionLabel, /CLI login/);
});

test('antigravity → 호스트 env(GEMINI_API_KEY), 로그인 파일 아님', () => {
  const { optionLabel, meaning } = credentialFallbackCopy('antigravity');
  assert.match(optionLabel, /GEMINI_API_KEY/);
  assert.match(meaning, /GEMINI_API_KEY|GOOGLE_API_KEY/);
  assert.doesNotMatch(optionLabel, /CLI login/);
});

test('pi → 호스트 pi login / ~/.pi/agent, 항상 fallback(per-agent credential 개념 자체가 없음)', () => {
  const { optionLabel, meaning } = credentialFallbackCopy('pi');
  assert.match(optionLabel, /pi login/);
  assert.match(meaning, /~\/\.pi\/agent/);
  assert.match(meaning, /no per-agent credential concept/i);
});

// ─── 3. 어댑터 문구는 서로 구별된다(예전엔 4곳이 동일 리터럴을 복제했다) ──────────

test('claude/codex/deepseek/antigravity/pi optionLabel 은 모두 서로 다름', () => {
  const labels = ['claude', 'codex', 'deepseek', 'antigravity', 'pi'].map(
    (c) => credentialFallbackCopy(c).optionLabel,
  );
  assert.equal(new Set(labels).size, 5, '어댑터별로 구별되는 라벨이어야 함');
});

// ─── 4. 미지/누락 타입 안전 폴백 — 던지지 않고 일반 문구 ─────────────────────────

test('custom / unknown / null / undefined → 일반 폴백(throw 없음)', () => {
  const generic = credentialFallbackCopy('custom');
  assert.match(generic.optionLabel, /operator login/);
  // custom 은 특정 어댑터 세부(auth.json/env var 등)를 단정하지 않는다.
  assert.doesNotMatch(generic.optionLabel, /codex|claude|DEEPSEEK|GEMINI/);
  assert.deepEqual(credentialFallbackCopy('unknown-future-cli'), generic);
  assert.deepEqual(credentialFallbackCopy(null), generic);
  assert.deepEqual(credentialFallbackCopy(undefined), generic);
});
