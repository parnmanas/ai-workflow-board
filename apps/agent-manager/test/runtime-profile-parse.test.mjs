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

// resolveRoomBroadcastRuntimeProfile (ticket 7d8ea7c9 review round 1) — the
// chat_room_message twin of parseRuntimeProfile. A group-room broadcast fans
// out to every member, so the server can't stamp a single flat profile field
// the way chat_request does for its one target agent: it sends an agent_id ->
// profile map instead, and each manager instance must pick its own
// responder's entry out of that map (handleChatRoomMessage already computes
// `roomResponderId` for the typing indicator — this is the same id).
//
// Covers:
//   - the responder's own entry resolves through the same validation as
//     parseRuntimeProfile (a malformed entry warns, same as a malformed
//     singular field would)
//   - a DIFFERENT member's entry in the map is never picked up
//   - no map on the payload, or no entry for this responder -> null, no warn
//     (the common no-profile-configured case must stay quiet)
//   - an empty responderAgentId (manager's own identity, no managed agent
//     resolved) -> null without even looking at the map

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
