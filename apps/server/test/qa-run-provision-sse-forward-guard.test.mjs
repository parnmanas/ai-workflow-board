// Static guard — QA/security run-workspace provisioning hint must survive the
// chat_room_message SSE wire end-to-end (ticket fe297886 / 25db3cc6).
//
// 근본 버그: `QaRunService.startQaRun` 은 run 디스패치 메시지에 `run_provision`
// (workspace_folder + repo_ref + checkout_mode 를 해석한 RunProvision)을 실어
// 보내고, agent-manager 는 그 힌트로 run 작업폴더를 clone/pull 한 뒤 subagent cwd
// 를 핀해서 spawn 한다. 그런데 SSE 직렬화 경로인 event-registry 의
// `chat_room_message` map() 이 payload 를 **필드별로 재구성**하면서 run_provision
// 을 복사하지 않아, manager 까지 도달하기 전에 조용히 누락됐다. 결과적으로 모든
// QA run 이 프로비저닝 없는 cwd 로 spawn → 드라이버가 빌드/드라이브할 체크아웃이
// 없음 → record_qa_step 0 건 → reaper. (= 티켓 DoD #1 의 진짜 차단점.)
//
// 이 가드는 emit → SSE map → 타입 선언 → manager 소비까지 4-touch wire 가 모두
// 살아있는지 확인한다. 어느 한 곳이 refactor 로 끊기면(특히 map() 이 다시 필드별
// 재구성으로 회귀하면) 컴파일은 통과하지만 wire 가 죽으므로, static guard 가 가장
// 싼 회귀 검출 수단이다. 패턴은 board-language-dispatch-guard.test.mjs 를 미러.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'src');

const read = (rel) => fs.readFileSync(path.join(SRC, rel), 'utf8');
// 주석 안에 심볼이 등장해도 false-positive 가 나지 않도록 코드만 남긴다.
const stripComments = (s) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

test('ChatRoomMessagePayload type declares run_provision on the wire', () => {
  const code = stripComments(read('common/types/stream-events.ts'));
  assert.match(
    code,
    /run_provision\?:\s*RunProvision/,
    'ChatRoomMessagePayload must declare run_provision so SSE consumers (agent-manager) see it',
  );
});

test('RoomMessagingService.sendMessage stamps run_provision onto the emit', () => {
  const code = stripComments(read('modules/chat-rooms/room-messaging.service.ts'));
  // QA/security dispatch ships the hint via opts.runProvision; the emit must
  // surface it as the wire field run_provision (conditional spread is fine).
  assert.match(
    code,
    /run_provision:\s*opts\.runProvision/,
    'sendMessage must emit run_provision from opts.runProvision',
  );
});

test('chat_room_message SSE map() forwards run_provision (regression: was dropped)', () => {
  const code = stripComments(read('modules/events/event-registry.ts'));
  // THE regression. The field-by-field payload reconstruction in the
  // chat_room_message map must copy event.run_provision; without this exact
  // assignment the hint never reaches the manager and every run dispatches
  // into an unprovisioned cwd.
  assert.match(
    code,
    /run_provision:\s*event\.run_provision/,
    'event-registry chat_room_message map() must copy event.run_provision into the payload',
  );
});

test('QaRunService dispatch hands a built RunProvision to sendMessage', () => {
  const code = stripComments(read('modules/qa/qa-run.service.ts'));
  assert.match(code, /buildRunProvision\(/, 'startQaRun must build a RunProvision');
  // runProvision must be handed to sendMessage as an opts property. Allow extra
  // keys after it — ticket acd24e5d added `{ runProvision, bypassContentLimit:
  // true }`, so pinning `{ runProvision }` exactly is too strict (it silently
  // regressed this guard until ticket 09ed8def).
  assert.match(
    code,
    /\{\s*runProvision\s*[,}]/,
    'startQaRun must pass runProvision to messaging.sendMessage',
  );
});
