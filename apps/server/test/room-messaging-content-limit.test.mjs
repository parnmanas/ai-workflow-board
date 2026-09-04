// Behavioral test for RoomMessagingService.sendMessage() content-limit handling
// (ticket acd24e5d). Server-issued run dispatch (QA / security) renders a
// machine-authored prompt that can legitimately exceed the 10k interactive chat
// cap — the 10,257-char INV-VIS QA prompt was 400-blocked at that cliff for 7
// runs straight. sendMessage now accepts an internal `opts.bypassContentLimit`
// that raises the ceiling to SYSTEM_DISPATCH_CONTENT_MAX (100k). This proves:
//   • no bypass, > 10000 chars                 -> rejected at 10000 (unchanged)
//   • bypass,    10,257 chars (the real value) -> passes the limit gate
//   • bypass,    > 100000 chars                -> still rejected (bounded, no DoS)
//
// The limit check sits right after the participant gate and before the DB
// transaction, so we only stub two seams: membership.requireActiveParticipant
// (resolve) and messageRepo.manager.transaction (throw a sentinel). A send that
// clears the limit gate reaches the transaction and rejects with the sentinel —
// which is exactly how we assert "got past the limit" without a real DB.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RoomMessagingService } from '../dist/modules/chat-rooms/room-messaging.service.js';

const noopLog = { info() {}, warn() {}, error() {}, debug() {} };
const REACHED_TX = 'REACHED_TRANSACTION_SENTINEL';

function makeSvc() {
  // requireMissionRoomSpeaker: 티켓 f6a0de0e 의 orchestration 발화 게이트. 이 스텁의 방은
  // mission 룸이 아니라 no-op 이지만, sendMessage 가 무조건 부르므로 있어야 한다.
  const membership = { async requireActiveParticipant() {}, async requireMissionRoomSpeaker() {} };
  // 같은 게이트가 방을 조회한다 — mission 룸이 아님을 알리려면 null 을 돌려주면 된다.
  const roomRepo = { async findOne() { return null; } };
  const messageRepo = {
    manager: { async transaction() { throw new Error(REACHED_TX); } },
  };
  // Remaining constructor deps are never reached on these paths.
  const empty = {};
  return new RoomMessagingService(
    roomRepo,     // roomRepo
    empty,        // participantRepo
    messageRepo,  // messageRepo
    empty,        // agentRepo
    empty,        // ticketRepo
    empty,        // userMentionRepo
    empty,        // attachmentRepo
    empty,        // workspaceRepo (티켓 9fd27487) — 결코 도달하지 않는다: 여기 모든 경로가
                  // transaction 스텁에 도달하기 전에, 혹은 그 스텁을 통해 reject되고,
                  // 둘 다 sendMessage의 chat_workspace_folder_enabled 조회보다 먼저 실행된다.
    empty,        // dataSource (티켓 7d8ea7c9) — _resolveChatRuntimeProfile 전용, sendMessage
                  // 경로에서는 도달하지 않는다.
    noopLog,      // logService
    membership,   // membership
    empty,        // mentionService
  );
}

const send = (svc, content, opts) =>
  svc.sendMessage('room-1', 'ws-1', 'user', 'system', 'QA', content, undefined, undefined, 'message', opts);

test('no bypass: content over 10000 is rejected at the interactive cap', async () => {
  const svc = makeSvc();
  await assert.rejects(
    () => send(svc, 'a'.repeat(10001)),
    /Message exceeds 10000 character limit/,
    '>10k without bypass hits the 10000 cap',
  );
});

test('no bypass: the exact 10,257-char INV-VIS prompt is still blocked', async () => {
  const svc = makeSvc();
  await assert.rejects(
    () => send(svc, 'a'.repeat(10257)),
    /Message exceeds 10000 character limit/,
    'the real INV-VIS length is blocked without the dispatch bypass',
  );
});

test('bypass: the 10,257-char INV-VIS prompt clears the limit gate', async () => {
  const svc = makeSvc();
  // Clearing the gate means execution reaches the DB transaction, which our stub
  // trips with a sentinel — proving the content-limit check did NOT reject it.
  await assert.rejects(
    () => send(svc, 'a'.repeat(10257), { bypassContentLimit: true }),
    new RegExp(REACHED_TX),
    'bypass lets the 10,257-char prompt past the limit and into the send path',
  );
});

test('bypass: content is still bounded — over 100000 is rejected', async () => {
  const svc = makeSvc();
  await assert.rejects(
    () => send(svc, 'a'.repeat(100001), { bypassContentLimit: true }),
    /Message exceeds 100000 character limit/,
    'the raised ceiling is bounded at 100000 (no unbounded DoS)',
  );
});
