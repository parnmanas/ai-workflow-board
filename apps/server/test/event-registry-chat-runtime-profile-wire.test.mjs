// Reviewer 지적(round 1, ticket 7d8ea7c9): "미해석 시 wire-shape 불변" 주장을
// event-registry-payload-parity-guard.test.mjs의 정적 regex만으로는 증명할 수
// 없다 — 그 가드는 map() 리터럴에 키가 "존재"하는지만 보고, 그 값이 실제
// JSON.stringify 이후 최종 SSE 바이트에서 사라지는지는 보지 않는다. 이 파일은
// events.controller.ts가 실제로 하는 일(def.map() → envelope 조립 → 있으면
// def.flatten() → JSON.stringify)을 그대로 재현해 최종 wire bytes 수준에서
// 검증한다:
//   • chat_request: RoomMessagingService가 cli_runtime_profile 키 자체를
//     생략했을 때 (event-registry.ts가 `?? null`을 썼던 회귀) 최종 바이트에
//     "cli_runtime_profile" 문자열이 전혀 나타나지 않아야 한다.
//   • chat_room_message: 새로 추가된 per-agent cli_runtime_profiles map도
//     동일하게 생략/전달 모두 최종 바이트 기준으로 검증한다.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST_ROOT = path.resolve(__dirname, '..', 'dist');

const { EVENT_TYPES } = await import(
  'file://' + path.join(DIST_ROOT, 'modules', 'events', 'event-registry.js')
);

function findDef(eventType) {
  const def = EVENT_TYPES.find((d) => d.eventType === eventType);
  assert.ok(def, `EVENT_TYPES must include ${eventType}`);
  return def;
}

// Mirrors events.controller.ts's handler + SSE map() pipeline exactly:
// def.map() alone is NOT what ships — the controller wraps it into
// {event_type, scope, payload, timestamp} and, for types that declare
// flatten(), re-derives the actual wire object from THAT envelope before
// JSON.stringify. Skipping either step would test a shape nothing ever sends.
async function wireBytes(eventType, rawEvent) {
  const def = findDef(eventType);
  const mapped = await def.map(rawEvent, {});
  assert.ok(mapped, `${eventType} map() unexpectedly returned null/undefined for this fixture`);
  const envelope = {
    event_type: def.eventType,
    scope: mapped.scope,
    payload: mapped.payload,
    timestamp: mapped.timestamp || new Date(0).toISOString(),
  };
  const dataObj = def.flatten ? def.flatten(envelope) : envelope;
  return JSON.stringify(dataObj);
}

const PROFILE = {
  id: 'local-anthropic',
  protocol: 'anthropic-compatible',
  base_url: 'http://192.168.0.6:8000',
  model: 'qwen3-coder-next',
};

test('chat_request final SSE bytes omit cli_runtime_profile when RoomMessagingService did not include the key', async () => {
  const raw = { agent_id: 'agent-1', user_id: 'user-1', role_prompt: '', new_message: 'hi', history: [] };
  const bytes = await wireBytes('chat_request', raw);
  assert.ok(
    !bytes.includes('cli_runtime_profile'),
    `expected no cli_runtime_profile in final SSE bytes, got: ${bytes}`,
  );
});

test('chat_request final SSE bytes carry cli_runtime_profile when RoomMessagingService resolved one', async () => {
  const raw = {
    agent_id: 'agent-1', user_id: 'user-1', role_prompt: '', new_message: 'hi', history: [],
    cli_runtime_profile: PROFILE,
  };
  const bytes = await wireBytes('chat_request', raw);
  const parsed = JSON.parse(bytes);
  assert.deepEqual(parsed.payload.cli_runtime_profile, PROFILE);
});

test('chat_room_message final SSE bytes omit cli_runtime_profiles when no room member resolved a profile', async () => {
  const raw = {
    room_id: 'room-1', message_id: 'msg-1', sender_type: 'user', sender_id: 'user-1', sender_name: 'Alice',
    content: 'hi', created_at: new Date(0).toISOString(),
    member_ids: ['user-1'], agent_member_ids: [],
  };
  const bytes = await wireBytes('chat_room_message', raw);
  assert.ok(
    !bytes.includes('cli_runtime_profiles'),
    `expected no cli_runtime_profiles in final SSE bytes, got: ${bytes}`,
  );
});

test('chat_room_message final SSE bytes carry the per-agent cli_runtime_profiles map when RoomMessagingService resolved one', async () => {
  const raw = {
    room_id: 'room-1', message_id: 'msg-1', sender_type: 'user', sender_id: 'user-1', sender_name: 'Alice',
    content: 'hi', created_at: new Date(0).toISOString(),
    member_ids: ['user-1'], agent_member_ids: ['agent-1'],
    cli_runtime_profiles: { 'agent-1': PROFILE },
  };
  const bytes = await wireBytes('chat_room_message', raw);
  // chat_room_message's flatten() spreads payload fields to the top level
  // (`{ ...p, id: p.message_id }`), so the map lands at the top level too —
  // this is the shape agent-manager's handleChatRoomMessage actually reads
  // (resolveRoomBroadcastRuntimeProfile(p, roomResponderId) off `p`).
  const parsed = JSON.parse(bytes);
  assert.deepEqual(parsed.cli_runtime_profiles, { 'agent-1': PROFILE });
});

test('chat_room_message final SSE bytes omit an empty cli_runtime_profiles map (no member resolved, but the key was technically present)', async () => {
  const raw = {
    room_id: 'room-1', message_id: 'msg-1', sender_type: 'user', sender_id: 'user-1', sender_name: 'Alice',
    content: 'hi', created_at: new Date(0).toISOString(),
    member_ids: ['user-1'], agent_member_ids: ['agent-1'],
    cli_runtime_profiles: {},
  };
  const bytes = await wireBytes('chat_room_message', raw);
  assert.ok(
    !bytes.includes('cli_runtime_profiles'),
    `expected an empty map to still be omitted from final SSE bytes, got: ${bytes}`,
  );
});
