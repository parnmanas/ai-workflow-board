// parseRuntimeProfile (ticket 7d8ea7c9 root cause B) — the event-field parser
// used to require `value.provider === 'string'`, but RuntimeProfileSpec
// (cli-adapters/base.ts) never had a `provider` field: the real required set
// is id / protocol / base_url / model. Every real profile therefore failed
// validation and silently returned null, so no per-agent Claude backend
// profile (ticket path OR chat path) could ever actually apply — the CLI
// always fell back to the Anthropic default endpoint.
//
// Covers:
//   - a real-shaped profile (no `provider`) parses successfully
//   - each required field's absence/malformed value -> null
//   - null/undefined input (no profile configured) -> null, no warn (the
//     common, unconfigured-agent case must stay quiet)
//   - malformed non-null input -> null AND a warn log, so a broken profile
//     is diagnosable instead of a silent fallback to the cloud default

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseRuntimeProfile, resolveRoomBroadcastRuntimeProfile } from '../dist/lib/event-dispatcher.js';

const REAL_PROFILE = {
  id: 'local-anthropic',
  protocol: 'anthropic-compatible',
  base_url: 'http://192.168.0.6:8000',
  model: 'qwen3-coder-next',
};

// log() writes to stderr (apps/agent-manager/src/lib/logging.ts) with no
// injectable sink — capture by intercepting process.stderr.write for the
// duration of a single call, always restored in `finally` so a failure here
// can't leak into other tests sharing this worker.
function captureStderr(fn) {
  const original = process.stderr.write;
  const lines = [];
  process.stderr.write = (chunk, ...rest) => {
    lines.push(String(chunk));
    return true;
  };
  try {
    fn();
  } finally {
    process.stderr.write = original;
  }
  return lines;
}

test('parseRuntimeProfile accepts a real-shaped profile with no `provider` field', () => {
  const out = parseRuntimeProfile(REAL_PROFILE);
  assert.deepEqual(out, REAL_PROFILE);
});

test('parseRuntimeProfile accepts a profile carrying extra optional fields untouched', () => {
  const withExtras = {
    ...REAL_PROFILE,
    env: { ANTHROPIC_DEFAULT_SONNET_MODEL: 'qwen3-coder-next' },
    credential_required: false,
    args: ['--foo'],
  };
  const out = parseRuntimeProfile(withExtras);
  assert.deepEqual(out, withExtras);
});

test('parseRuntimeProfile: null/undefined (no profile configured) -> null, no warn', () => {
  let out;
  const lines = captureStderr(() => { out = parseRuntimeProfile(null); });
  assert.equal(out, null);
  assert.deepEqual(lines, []);

  const lines2 = captureStderr(() => { out = parseRuntimeProfile(undefined); });
  assert.equal(out, null);
  assert.deepEqual(lines2, []);
});

test('parseRuntimeProfile: missing id -> null + warn', () => {
  const { id, ...rest } = REAL_PROFILE;
  let out;
  const lines = captureStderr(() => { out = parseRuntimeProfile(rest); });
  assert.equal(out, null);
  assert.ok(lines.length > 0, 'a malformed non-null profile must be logged, not silently dropped');
});

test('parseRuntimeProfile: missing/invalid protocol -> null + warn', () => {
  let out;
  const lines = captureStderr(() => {
    out = parseRuntimeProfile({ ...REAL_PROFILE, protocol: undefined });
  });
  assert.equal(out, null);
  assert.ok(lines.length > 0);

  const lines2 = captureStderr(() => {
    out = parseRuntimeProfile({ ...REAL_PROFILE, protocol: 'grpc' });
  });
  assert.equal(out, null);
  assert.ok(lines2.length > 0);
});

test('parseRuntimeProfile: missing base_url -> null + warn', () => {
  const { base_url, ...rest } = REAL_PROFILE;
  let out;
  const lines = captureStderr(() => { out = parseRuntimeProfile(rest); });
  assert.equal(out, null);
  assert.ok(lines.length > 0);
});

test('parseRuntimeProfile: missing model -> null + warn', () => {
  const { model, ...rest } = REAL_PROFILE;
  let out;
  const lines = captureStderr(() => { out = parseRuntimeProfile(rest); });
  assert.equal(out, null);
  assert.ok(lines.length > 0);
});

test('parseRuntimeProfile: the old provider-only-shaped garbage that used to be the ONLY thing rejected still rejects (id/model but no protocol/base_url)', () => {
  let out;
  const lines = captureStderr(() => {
    out = parseRuntimeProfile({ id: 'x', provider: 'anthropic', model: 'm' });
  });
  assert.equal(out, null);
  assert.ok(lines.length > 0);
});

test('parseRuntimeProfile: non-object input -> null + warn', () => {
  for (const bad of ['not an object', 42, true, ['array', 'is', 'not', 'object']]) {
    let out;
    const lines = captureStderr(() => { out = parseRuntimeProfile(bad); });
    assert.equal(out, null, `expected null for ${JSON.stringify(bad)}`);
    assert.ok(lines.length > 0, `expected a warn log for ${JSON.stringify(bad)}`);
  }
});

// resolveRoomBroadcastRuntimeProfile (ticket 7d8ea7c9 review round 1) —
// parseRuntimeProfile의 chat_room_message 짝. 그룹방 broadcast는 모든
// 멤버에게 팬아웃되므로, chat_request가 단일 대상 agent에게 하듯 평면
// profile 필드 하나로 찍을 수 없다: 대신 agent_id -> profile map을
// 보내고, 각 매니저 인스턴스는 그 맵에서 자기 responder의 항목을 직접
// 골라야 한다(handleChatRoomMessage가 타이핑 표시용으로 이미 계산해 둔
// `roomResponderId`가 바로 그 id다).
//
// 커버 범위:
//   - responder 자신의 항목은 parseRuntimeProfile과 동일한 검증을 거쳐
//     해석된다(malformed 항목은 단일 필드일 때와 마찬가지로 warn)
//   - 맵에 있는 DIFFERENT 멤버의 항목은 절대 선택되지 않는다
//   - payload에 맵이 없거나 이 responder 항목이 없으면 -> null, warn 없음
//     (프로필 미설정이라는 흔한 케이스는 조용해야 한다)
//   - responderAgentId가 빈 값(매니저 자신의 identity, 해석된 managed
//     agent 없음)이면 -> 맵을 보지도 않고 null

test('resolveRoomBroadcastRuntimeProfile: picks the responder\'s own entry out of the map', () => {
  const payload = { cli_runtime_profiles: { 'agent-1': REAL_PROFILE, 'agent-2': { ...REAL_PROFILE, id: 'other' } } };
  const out = resolveRoomBroadcastRuntimeProfile(payload, 'agent-1');
  assert.deepEqual(out, REAL_PROFILE);
});

test('resolveRoomBroadcastRuntimeProfile: never picks up a DIFFERENT member\'s entry', () => {
  const payload = { cli_runtime_profiles: { 'agent-2': REAL_PROFILE } };
  let out;
  const lines = captureStderr(() => { out = resolveRoomBroadcastRuntimeProfile(payload, 'agent-1'); });
  assert.equal(out, null);
  assert.deepEqual(lines, [], 'no entry for this responder is the common case — must stay quiet, not warn');
});

test('resolveRoomBroadcastRuntimeProfile: no cli_runtime_profiles map on the payload -> null, no warn', () => {
  let out;
  const lines = captureStderr(() => { out = resolveRoomBroadcastRuntimeProfile({}, 'agent-1'); });
  assert.equal(out, null);
  assert.deepEqual(lines, []);
});

test('resolveRoomBroadcastRuntimeProfile: empty responderAgentId -> null without inspecting the map', () => {
  const payload = { cli_runtime_profiles: { '': REAL_PROFILE } };
  let out;
  const lines = captureStderr(() => { out = resolveRoomBroadcastRuntimeProfile(payload, ''); });
  assert.equal(out, null);
  assert.deepEqual(lines, []);
});

test('resolveRoomBroadcastRuntimeProfile: a malformed entry for this responder -> null + warn (same validation as parseRuntimeProfile)', () => {
  const { base_url, ...malformed } = REAL_PROFILE;
  const payload = { cli_runtime_profiles: { 'agent-1': malformed } };
  let out;
  const lines = captureStderr(() => { out = resolveRoomBroadcastRuntimeProfile(payload, 'agent-1'); });
  assert.equal(out, null);
  assert.ok(lines.length > 0, 'a malformed non-null profile must be logged, not silently dropped');
});
