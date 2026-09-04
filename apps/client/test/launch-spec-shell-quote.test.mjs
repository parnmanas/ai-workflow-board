// 회귀 테스트 — 복사용 실행 명령의 셸 안전 인용 (ticket 20fff298 리뷰 2R).
//
// 이전 구현은 **공백이 있을 때만** `JSON.stringify` 로 감쌌고 실행 파일 경로는
// 아예 인용하지 않았다. 두 가지가 잘못이었다:
//   1. 공백 없는 토큰은 그대로 나가므로 `$(…)`·백틱·`$VAR`·`;` 가 붙여넣는
//      순간 확장·실행된다.
//   2. `JSON.stringify` 의 큰따옴표 안에서는 `$` 와 백틱이 여전히 확장된다.
// 그래서 모든 토큰을 POSIX 홑따옴표로 감싼다.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

import { posixShellQuote, posixCommandLine, argvJson } from '../src/utils/shellQuote.ts';

/** 실제 셸에 인용 결과를 먹여 **원문 토큰이 그대로 복원되는지** 확인한다.
 *  정규식으로 "위험해 보이지 않는다"를 단언하는 것보다 강한 증거다. */
function roundTripThroughShell(tokens) {
  const script = `for a in ${tokens.map(posixShellQuote).join(' ')}; do printf '%s\\n' "$a"; done`;
  const out = execFileSync('/bin/sh', ['-c', script], { encoding: 'utf8' });
  return out.split('\n').slice(0, tokens.length);
}

const HOSTILE = [
  'plain',
  'has space',
  "single'quote",
  'double"quote',
  '$HOME',
  '$(id -u)',
  '`id -u`',
  'a;id',
  'a|id',
  'a&&id',
  'a>out',
  '*',
  '~root',
  '',
  '--flag=value with space',
  "it's a $(trap)",
];

test('적대적 토큰이 셸을 통과해도 원문 그대로 복원된다 (확장·실행 없음)', () => {
  const restored = roundTripThroughShell(HOSTILE);
  assert.deepEqual(restored, HOSTILE);
});

test('셸 메타문자는 공백이 없어도 인용된다', () => {
  // 예전 구현이 통과시켰던 정확한 부류.
  for (const t of ['$(id -u)', '`id`', '$HOME', 'a;id', 'a|id', '*']) {
    const q = posixShellQuote(t);
    assert.notEqual(q, t, `${t} 가 인용되지 않았다`);
    assert.ok(q.startsWith("'") && q.endsWith("'"), `${t} 가 홑따옴표로 감싸이지 않았다`);
  }
});

test('큰따옴표가 아니라 홑따옴표를 쓴다 ($ 확장을 막는 유일한 방법)', () => {
  const q = posixShellQuote('$HOME');
  assert.equal(q, "'$HOME'");
  assert.equal(q.includes('"'), false);
});

test('홑따옴표가 든 토큰도 정확히 복원된다', () => {
  assert.deepEqual(roundTripThroughShell(["it's", "a'b'c", "'''"]), ["it's", "a'b'c", "'''"]);
});

test('안전한 문자만 있는 토큰은 가독성을 위해 인용하지 않는다', () => {
  for (const t of ['--print', '/usr/local/bin/claude', 'claude-opus-5', 'stream-json', 'a.b_c-d:e,f@g%h+i=j']) {
    assert.equal(posixShellQuote(t), t);
  }
});

test('빈 토큰은 사라지지 않고 빈 인자로 남는다', () => {
  assert.equal(posixShellQuote(''), "''");
  const line = posixCommandLine('/bin/claude', ['', '--print']);
  assert.equal(line, "/bin/claude '' --print");
});

test('실행 파일 경로도 인용 대상이다 (공백 든 설치 경로)', () => {
  // 예전 구현은 bin 을 인용하지 않아 두 토큰으로 쪼개졌다.
  const line = posixCommandLine('/opt/My Tools/claude', ['--print']);
  assert.equal(line, "'/opt/My Tools/claude' --print");
  // 셸이 실제로 한 토큰으로 보는지 확인.
  const out = execFileSync('/bin/sh', ['-c', `set -- ${line}; printf '%s' "$1"`], { encoding: 'utf8' });
  assert.equal(out, '/opt/My Tools/claude');
});

test('argv JSON 은 셸 문법 없이 토큰 경계를 보존한다', () => {
  const json = argvJson('/opt/My Tools/claude', ['$(id)', "it's", '']);
  assert.deepEqual(JSON.parse(json), ['/opt/My Tools/claude', '$(id)', "it's", '']);
});
