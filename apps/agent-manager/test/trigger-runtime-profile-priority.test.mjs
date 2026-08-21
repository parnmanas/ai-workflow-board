// resolveTriggerRuntimeProfile (티켓 0fbe802c, 7d8ea7c9 root cause C 후속) —
// ticket-dispatch 경로(#dispatchTriggerBody)는 예전에 인스턴스 전역
// `--runtime-profile <file>` 오버라이드가 설정되어 있으면 항상 그것이
// 최우선이었다:
//
//   const runtimeProfile = this.#runtimeProfileOverride !== undefined
//     ? this.#runtimeProfileOverride
//     : parseRuntimeProfile(ev.cli_runtime_profile);
//
// 여러 agent를 호스팅하는 매니저 인스턴스(예: Manager agent 1개 + 전용 vLLM
// agent 1개)에서 vLLM agent용 오버라이드 플래그가 설정되어 있으면, 티켓
// 작업을 하는 **모든** agent(Manager 포함)가 자신의 per-agent
// cli_runtime_profile과 무관하게 그 오버라이드 백엔드로 강제 라우팅됐다.
// 이는 7d8ea7c9가 chat 경로(오버라이드를 아예 참조하지 않도록 고침)에서
// 이미 고친 것과 동일한 교차 오염이다. ticket-dispatch 경로는 chat과 달리
// 오버라이드를 폴백으로 유지한다 — 단일-agent 호스트가 DB 프로필 없이
// `--runtime-profile <file>`만으로 백엔드를 강제하는 기존 용법을 위해서다.
// 다만 이제 그 폴백은 per-agent 프로필이 실제로 설정된 agent에게는 더 이상
// 이기지 못한다.
//
// 커버 범위:
//   - 인스턴스 오버라이드 상태(미설정 / 다른 프로필 / 명시적 `none`)와
//     무관하게 유효한 per-agent 프로필이 항상 우선한다
//   - per-agent 프로필이 없을 때(미설정 또는 형식 오류)는 인스턴스
//     오버라이드가 여전히 폴백으로 쓰인다
//   - per-agent 프로필도 오버라이드도 없으면 -> null(CLI 기본값)

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { resolveTriggerRuntimeProfile } from '../dist/lib/event-dispatcher.js';

// 두 픽스처 모두 `provider` 필드를 갖고 있는데, 이는 순전히 티켓 7d8ea7c9
// (parseRuntimeProfile의 `provider` 요구를 없앤다 — 이 파일이 다루는
// 우선순위 로직과는 별개인 root cause B)의 병합 여부와 무관하게
// parseRuntimeProfile()에서 항상 정상 파싱되게 하기 위함이다. 이 테스트들은
// resolveTriggerRuntimeProfile의 폴백 순서만 검증하며 parseRuntimeProfile의
// 정확한 검증 규칙에는 관심이 없다.
const AGENT_PROFILE = {
  id: 'agent-db-profile',
  provider: 'anthropic',
  protocol: 'anthropic-compatible',
  base_url: 'http://192.168.0.6:8000',
  model: 'qwen3-coder-next',
};

const INSTANCE_OVERRIDE_PROFILE = {
  id: 'instance-cli-override',
  provider: 'anthropic',
  protocol: 'anthropic-compatible',
  base_url: 'http://127.0.0.1:8000',
  model: 'some-other-model',
};

test('resolveTriggerRuntimeProfile: valid per-agent profile wins when no instance override is set', () => {
  const out = resolveTriggerRuntimeProfile(AGENT_PROFILE, undefined);
  assert.deepEqual(out, AGENT_PROFILE);
});

test('resolveTriggerRuntimeProfile: valid per-agent profile wins over a DIFFERENT instance override (the cross-contamination fix)', () => {
  const out = resolveTriggerRuntimeProfile(AGENT_PROFILE, INSTANCE_OVERRIDE_PROFILE);
  assert.deepEqual(out, AGENT_PROFILE);
});

test('resolveTriggerRuntimeProfile: valid per-agent profile wins over an explicit `--runtime-profile none` (instanceOverride === null)', () => {
  const out = resolveTriggerRuntimeProfile(AGENT_PROFILE, null);
  assert.deepEqual(out, AGENT_PROFILE);
});

test('resolveTriggerRuntimeProfile: no per-agent profile (null) falls back to the instance override', () => {
  const out = resolveTriggerRuntimeProfile(null, INSTANCE_OVERRIDE_PROFILE);
  assert.deepEqual(out, INSTANCE_OVERRIDE_PROFILE);
});

test('resolveTriggerRuntimeProfile: no per-agent profile (undefined) falls back to the instance override', () => {
  const out = resolveTriggerRuntimeProfile(undefined, INSTANCE_OVERRIDE_PROFILE);
  assert.deepEqual(out, INSTANCE_OVERRIDE_PROFILE);
});

test('resolveTriggerRuntimeProfile: malformed per-agent raw input is treated as absent and falls back to the instance override', () => {
  const out = resolveTriggerRuntimeProfile({ id: 'incomplete' }, INSTANCE_OVERRIDE_PROFILE);
  assert.deepEqual(out, INSTANCE_OVERRIDE_PROFILE);
});

test('resolveTriggerRuntimeProfile: no per-agent profile and no instance override (unset) -> null (CLI default)', () => {
  const out = resolveTriggerRuntimeProfile(null, undefined);
  assert.equal(out, null);
});

test('resolveTriggerRuntimeProfile: no per-agent profile and explicit `--runtime-profile none` -> null (CLI default)', () => {
  const out = resolveTriggerRuntimeProfile(undefined, null);
  assert.equal(out, null);
});
