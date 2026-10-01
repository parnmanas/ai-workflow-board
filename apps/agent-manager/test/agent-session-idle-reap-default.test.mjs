// Agent Session 은 **유휴하다고 죽이지 않는다** — idle reap 기본값은 꺼짐(0).
//
// 예전 기본값은 30분이었다. 그 판정이 보는 것은 `live.turn` 과 대기 중인 권한/질문뿐이고,
// **세션 프로세스가 들고 있는 자식들은 전혀 보지 않는다.** CLI 세션은 내부적으로
// 서브에이전트를 띄우고, 백그라운드 셸을 돌리고, 긴 빌드/테스트를 기다린다 — 그 작업들은
// ACP 턴 경계와 일치하지 않는다. 턴이 끝난 뒤에도 아직 돌고 있는 자식이 있을 수 있고,
// 그 상태로 30분이 지나면 세션을 죽이면서 그것들을 같이 날렸다.
//
// "응답이 없으니 죽여도 된다" 는 판단을 이 층에서 할 수 없다는 것이 핵심이다 — 느린 것,
// 멎은 것, 자식을 기다리는 것이 여기서 구분되지 않는다. 90초 침묵에 경고만 하고 턴을
// 끊지 않는 것과 같은 이유다. 그래서 수명 결정은 사람에게 남긴다(화면의 Close).
//
// 고정하는 것:
//   1. 옵션을 안 주면 idle 타이머가 **아예 걸리지 않는다**(0 → `if (ms <= 0) return`).
//   2. 설정으로 켤 수는 있다 — 끄는 것이 기본일 뿐 기능을 없앤 것은 아니다.
//   3. 켰을 때도 **턴이 도는 동안에는 타이머를 걸지 않는다**(기존 보호를 유지).
// 실행: node --test apps/agent-manager/test/agent-session-idle-reap-default.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(
  new URL('../src/lib/agent-session-runner.ts', import.meta.url),
  'utf8',
);

test('idle reap 기본값은 0 — 유휴만으로 세션을 죽이지 않는다', () => {
  assert.match(
    source,
    /const DEFAULT_IDLE_MINUTES = 0;/,
    '기본값을 양수로 되돌리면 서브에이전트가 도는 세션이 조용히 회수된다',
  );
});

test('0 이하면 타이머를 아예 걸지 않는다', () => {
  // `#touch` 가 ms <= 0 에서 즉시 반환해야 기본값 0 이 "끔" 이 된다.
  assert.match(source, /const ms = this\.#options\.idleMinutes \* 60_000;\s*\n\s*if \(ms <= 0\) return;/);
});

test('턴이 도는 동안에는 idle 타이머를 걸지 않는다 — 켠 호스트에서도 긴 턴은 안전하다', () => {
  assert.match(source, /#touch\(live: LiveSession\): void \{\s*\n\s*this\.#clearIdle\(live\);\s*\n\s*if \(live\.turn\) return;/);
});

test('설정으로 켤 수 있는 길은 남아 있다 — 기능을 없앤 것이 아니다', () => {
  assert.match(source, /idleMinutes: options\.idleMinutes \?\? DEFAULT_IDLE_MINUTES/);
});

test('침묵한 턴은 경고만 하고 끊지 않는다 — 같은 원칙이 턴에도 적용된다', () => {
  // 이 둘이 함께 유지돼야 "오래 걸리는 작업을 죽이지 않는다" 가 성립한다.
  assert.match(source, /const SILENT_TURN_WARN_MS = 90_000;/);
  assert.match(source, /턴을 죽이지는 않는다/);
});
