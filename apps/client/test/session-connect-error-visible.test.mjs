// 세션 Connect 가 실패하면 **왜 실패했는지가 화면에 남아야 한다**.
//
// 실측 증상(ralf/codex): 터미널이나 Codex 앱에서 이미 열려 있는 스레드를 Connect 하면
// codex 가 `thread … already has an active writer` 로 거절한다. 매니저도 서버도 그 사유를
// 정확히 들고 있었지만 화면은 토스트 한 번으로 끝냈고, 토스트가 사라지면 사용자에게는
// "실패" 라는 사실만 남았다. 사유를 볼 방법이 전혀 없었다.
//
// 실제 동작은 서버 테스트(`apps/server/test/agent-session-open-failure.test.mjs`)가 본다.
// 여기서는 화면 쪽 배선이 되돌아가지 않도록 고정한다: 실패 사유를 상태로 들고, 배너가
// 그것을 읽고, 다시 시도할 때 지운다.

import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

const source = await readFile(
  new URL('../src/components/sessions/SessionsPage.tsx', import.meta.url),
  'utf8',
);

test('연결 실패 사유를 상태로 들고 있는다 — 토스트만으로 끝내지 않는다', () => {
  assert.match(source, /const \[connectError, setConnectError\] = useState<string \| null>\(null\)/);
  // 실패 경로가 토스트와 **같은 문구**를 상태에도 남긴다.
  assert.match(
    source,
    /const message = err\?\.message \|\| 'Failed to connect to the session on the Runtime Host';[\s\S]*?setConnectError\(message\);[\s\S]*?showToast\(message, 'error'\)/,
  );
  // 다시 시도할 때는 지운다 — 고쳐서 붙은 뒤에도 옛 사유가 남아 있으면 그게 또 거짓말이다.
  assert.match(source, /setConnecting\(true\);\s*\n\s*setConnectError\(null\);/);
});

test('오류 배너가 서버가 남긴 사유와 방금 실패한 사유를 모두 읽는다', () => {
  // 예전 조건은 `live.last_error && status === 'error'` 뿐이라, SSE 가 오기 전이거나
  // 상태가 error 로 넘어가지 않은 연결 실패는 배너가 통째로 사라졌다.
  assert.match(
    source,
    /\(\(status === 'error' && live\?\.last_error\) \|\| connectError\) && \(/,
  );
  assert.match(
    source,
    /role="alert"[\s\S]*?\{\(status === 'error' && live\?\.last_error\) \|\| connectError\}/,
  );
});

const runnerSource = await readFile(
  new URL('../../agent-manager/src/lib/agent-session-runner.ts', import.meta.url),
  'utf8',
);

test('매니저가 active-writer 거절에 조치를 덧붙인다', () => {
  // codex 원문만 중계하면 "무엇을 고치라는 건지" 가 빠진다. 가장 흔한 사유 하나는
  // 문구만으로 행동을 알 수 없으므로 어디서 닫아야 하는지까지 말한다.
  assert.match(runnerSource, /already has an active writer/);
  assert.match(runnerSource, /터미널 또는 Codex 앱/);
  // 기계가 분기할 코드도 따로 준다(단순 resume_failed 와 구분된다).
  assert.match(runnerSource, /activeWriter \? 'resume_locked' : 'resume_failed'/);
});
