// Agent Session 의 유휴 회수는 **진행 증거의 부재**로만 정당화된다.
//
// 예전에는 30분 타이머가 만료되면 `live.turn` 과 대기 중 권한/질문만 보고 죽였다. 그 판정은
// 세션 프로세스가 들고 있는 자식들을 전혀 보지 않는다 — CLI 세션은 내부적으로 서브에이전트를
// 띄우고, 백그라운드 셸을 돌리고, 긴 빌드/테스트를 기다린다. 그 작업들은 ACP 턴 경계와
// 일치하지 않으므로, 턴이 끝난 뒤에도 도는 자식이 있는데 세션을 죽이며 같이 날렸다.
//
// chat/ticket 세션 쪽은 이 문제를 이미 3-신호 gate 로 풀어 놨다(`session-progress.ts`,
// 티켓 6ff827cb). 그 지배 원칙이 핵심이다: **타이머 만료는 CHECK 이고 KILL 이 아니다.**
// 그래서 Agent Session 도 같은 gate 를 쓴다 — 두 세션 타입이 한 규칙을 공유하니 한쪽만
// 고쳐지는 드리프트가 없다.
//
// 고정하는 것:
//   1. 만료 시 곧바로 죽이지 않고 진행 gate 를 돌린다(`#reapIfIdle`).
//   2. 신호가 하나라도 신선하면 재무장한다.
//   3. gate 판정 자체가 실패하면 **죽이지 않는다** — 증거 없음과 확인 실패는 다르다.
//   4. 턴이 도는 동안에는 타이머를 아예 걸지 않는다(기존 보호 유지).
//   5. 0 이하면 완전히 끈다.
//   6. 침묵한 턴은 경고만 하고 끊지 않는다 — 같은 원칙이 턴에도 적용된다.
// 실행: node --test apps/agent-manager/test/agent-session-idle-reap-default.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(
  new URL('../src/lib/agent-session-runner.ts', import.meta.url),
  'utf8',
);

test('만료 시 바로 죽이지 않고 진행 gate 를 돌린다 — CHECK, not KILL', () => {
  // 타이머 콜백이 #closeLive 를 직접 부르면 예전 동작으로 되돌아간 것이다.
  assert.match(source, /live\.idleTimer = setTimeout\(\(\) => \{[\s\S]{0,400}?this\.#reapIfIdle\(live, ms\);/);
  const timerBody = source.slice(source.indexOf('live.idleTimer = setTimeout'));
  const callback = timerBody.slice(0, timerBody.indexOf('}, ms);'));
  assert.doesNotMatch(callback, /#closeLive/, '타이머 콜백이 직접 죽이면 안 된다');
});

test('gate 는 chat/ticket 세션과 같은 session-progress 모듈을 쓴다', () => {
  assert.match(source, /import \{ checkSessionProgress[\s\S]{0,80}\} from '\.\/session-progress\.js';/);
  // 세 신호가 모두 전달돼야 한다: pid(자손 프로세스) · cliHome+cwd(서브트리 mtime) · 출력 시각.
  assert.match(
    source,
    /checkSessionProgress\(\s*\{ pid, cliHomeDir: live\.cliHome, cwd: live\.cwd, freshMs \},\s*live\.lastOutputAtMs,\s*\)/,
  );
});

test('진행 신호가 있으면 재무장한다 — 일하는 세션을 죽이지 않는다', () => {
  assert.match(source, /if \(progress\.alive\) \{[\s\S]{0,300}?this\.#touch\(live\);\s*\n\s*return;/);
});

test('gate 판정이 실패하면 죽이지 않는다 — 증거 없음과 확인 실패는 다르다', () => {
  assert.match(source, /idle gate failed[\s\S]{0,160}?keeping the session/);
  const catchBlock = source.slice(source.indexOf('idle gate failed'));
  assert.match(catchBlock.slice(0, 400), /this\.#touch\(live\);\s*\n\s*return;/);
});

test('출력 시각은 모든 이벤트가 지나는 한 곳에서만 찍는다', () => {
  // #enqueue 가 유일한 깔때기다. 여기서 throttle 하면 gate 의 증거가 낡는다.
  assert.match(source, /if \(events\.length\) live\.lastOutputAtMs = Date\.now\(\);/);
});

test('턴이 도는 동안에는 타이머를 걸지 않고, 0 이하면 완전히 끈다', () => {
  assert.match(source, /#touch\(live: LiveSession\): void \{\s*\n\s*this\.#clearIdle\(live\);\s*\n\s*if \(live\.turn\) return;/);
  assert.match(source, /const ms = this\.#options\.idleMinutes \* 60_000;\s*\n\s*if \(ms <= 0\) return;/);
});

test('창은 넉넉하게 — 30분처럼 짧은 값으로 되돌리지 않는다', () => {
  const m = source.match(/const DEFAULT_IDLE_MINUTES = (\d+);/);
  assert.ok(m, 'DEFAULT_IDLE_MINUTES 를 찾지 못했다');
  const minutes = Number(m[1]);
  assert.ok(
    minutes === 0 || minutes >= 120,
    `회수 창이 너무 짧다(${minutes}분). 전사는 복원되지만 따뜻한 컨텍스트는 사라지므로 "잠깐 자리를 비웠다" 를 회수하면 안 된다`,
  );
});

test('사용자에게 보이는 사유도 "유휴" 가 아니라 "진행 증거 없음" 이다', () => {
  // 문구가 판정과 어긋나면 운영자가 원인을 오해한다.
  assert.match(source, /No progress for \$\{this\.#options\.idleMinutes\} min/);
  assert.match(source, /no output, no background task, no cli-home activity/);
});

test('침묵한 턴은 경고만 하고 끊지 않는다 — 같은 원칙이 턴에도 적용된다', () => {
  assert.match(source, /const SILENT_TURN_WARN_MS = 90_000;/);
  assert.match(source, /턴을 죽이지는 않는다/);
});
