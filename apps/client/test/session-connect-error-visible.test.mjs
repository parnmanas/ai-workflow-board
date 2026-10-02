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
  // 기계가 분기할 코드도 따로 준다(단순 resume_failed 와 구분된다). 주인을 특정했는지에
  // 따라 코드가 갈린다 — 화면은 특정된 경우에만 "강제로 열기" 를 내놓는다.
  assert.match(runnerSource, /'resume_locked_external'/);
  assert.match(runnerSource, /'resume_locked'/);
});

// ─── 강제로 열기 ───────────────────────────────────────────────────────────
//
// 잠금 주인이 외부 프로세스일 때만 내놓는 선택지다. 사용자가 고른 정책은
// "기본 안전 + 확인 후 강제" — 그래서 여기서 고정하는 것은 세 가지다:
// (1) 주인을 특정했을 때만 버튼이 뜨고, (2) 확인 대화상자를 반드시 거치고,
// (3) 자동 연결과 평범한 Connect 는 절대 force 를 켜지 않는다.

test('주인을 특정한 경우에만 강제 열기를 내놓는다', () => {
  // 매니저가 이름·PID 를 실어 보냈다는 신호가 `resume_locked_external` 이다.
  // 주인을 모르는 `resume_locked` 에서 버튼을 띄우면 무엇을 죽이는지 말하지 못한다.
  assert.match(source, /if \(err\?\.code === 'resume_locked_external'\) setLockedByExternal\(message\)/);
  // 판단은 canForceOpen 하나 — 이 페이지의 실패(lockedByExternal) 또는 서버가 저장한 코드. 어느 쪽이든
  // 근거는 매니저가 주인을 특정했다는 `resume_locked_external` 뿐이다.
  assert.match(source, /\{canForceOpen && !connecting && \([\s\S]*?강제로 열기/);
});

test('강제 열기는 확인 대화상자를 거치고, 매니저가 말한 사유를 그대로 보여 준다', () => {
  assert.match(source, /const forceConnect = useCallback\(async \(\) => \{/);
  // 사유(주인의 이름·PID)가 대화상자 본문에 들어간다.
  assert.match(source, /const ok = await confirm\(\{[\s\S]*?\{reason\}/);
  assert.match(source, /danger: true/);
  // 확인을 취소하면 아무것도 하지 않는다.
  assert.match(source, /if \(!ok\) return;\s*\n\s*await connect\(true\);/);
});

test('자동 연결과 평범한 Connect 는 force 를 켜지 않는다', () => {
  // 페이지를 여는 것만으로 남의 Codex 앱이 죽으면 안 된다.
  assert.match(source, /void connect\(false\);/);
  assert.match(source, /onClick=\{\(\) => void connect\(false\)\}/);
  // 그리고 켜졌을 때만 본문에 실린다.
  assert.match(source, /\.\.\.\(force \? \{ force: true \} : \{\}\)/);
});

// 세션을 **다시 열었을 때도** 강제 열기가 나온다 (실측 2026-10-02).
//
// 증상: "강제로 열기 버튼이 없어". 배너 문구는 서버가 저장한 last_error 에서 오는데, 버튼은 이 페이지의
// Connect 가 실패한 순간에만 켜지는 화면 로컬 상태(lockedByExternal)였다. 세션 페이지를 새로 열면 상태가
// error 라 자동 연결도 하지 않으므로, 문구만 남고 버튼은 끝내 나오지 않았다. 이제 서버가 코드도 저장하고
// (last_error_code), 화면은 그 코드로도 버튼을 낸다 — 누르면 저장된 사유(주인의 이름·PID)를 보여 준다.
test('저장된 오류 코드로도 강제 열기를 낸다 — 이 페이지에서 Connect 를 누르지 않았어도', () => {
  assert.match(
    source,
    /const canForceOpen = !!lockedByExternal \|\| \(status === 'error' && live\?\.last_error_code === 'resume_locked_external'\);/,
  );
  assert.match(source, /\{canForceOpen && !connecting && \(/);
  // 버튼이 나와도 눌러서 아무 일이 없으면 안 된다 — 사유를 저장된 last_error 에서도 가져온다.
  assert.match(source, /const reason = lockedByExternal\s*\n\s*\|\| \(live\?\.last_error_code === 'resume_locked_external' \? live\.last_error : null\);/);
});
