// Static guard — prevents regression of the "invalid input syntax for type
// uuid: \"\"" Run-button crash that hit production.private on 2026-05-13.
//
// Background: commit d971fa1 (Phase B) widened action_runs.room_id from
// varchar to uuid. The pre-fix ActionsService.dispatch() persisted a half-
// empty ActionRun scaffold first ({ room_id: '', prompt_rendered: '' }) so
// it could grab tempRun.id for {{run.id}} interpolation, then patched
// room_id + prompt_rendered after the room existed. That first INSERT
// dropped '' into a uuid column on Postgres and got rejected:
//
//   ⚠ invalid input syntax for type uuid: ""
//
// The fix pre-generates the run UUID via crypto.randomUUID(), creates the
// chat room first, then persists the ActionRun row exactly once with every
// field populated. This guard pins those three structural invariants so a
// future refactor cannot silently reintroduce the empty-string sentinel.
//
// If any of these checks fires it almost certainly means the dispatch flow
// has been re-shaped to do a placeholder save again — switch back to the
// "create room first, then save run once" pattern (or, if the entity is
// changed to make room_id nullable+transformer, delete this guard and the
// `randomUUID` requirement together).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVICE_PATH = path.resolve(
  __dirname,
  '..',
  'src',
  'modules',
  'actions',
  'actions.service.ts',
);

function stripCommentsAndStrings(src) {
  // Drop // line comments, /* block */ comments, and string literals so we
  // only match against live code. We do NOT need to be perfect — the goal
  // is just to keep doc-prose ("room_id: '' was the old shape…") from
  // false-positiving the anti-pattern grep.
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '')
    .replace(/`(?:\\.|[^`\\])*`/g, '``')
    .replace(/'(?:\\.|[^'\\])*'/g, "''")
    .replace(/"(?:\\.|[^"\\])*"/g, '""');
}

test('actions.service.ts imports randomUUID', () => {
  const src = fs.readFileSync(SERVICE_PATH, 'utf8');
  assert.match(
    src,
    /import\s+\{[^}]*\brandomUUID\b[^}]*\}\s+from\s+['"]crypto['"]/,
    'ActionsService must import randomUUID from crypto so dispatch() can ' +
      'pre-allocate ActionRun.id before any DB write — otherwise the only ' +
      'way to learn the id is to save a placeholder scaffold first, which ' +
      'is the regression this guard exists to block.',
  );
});

test('dispatch() does not save a placeholder ActionRun with empty room_id', () => {
  const src = fs.readFileSync(SERVICE_PATH, 'utf8');
  const code = stripCommentsAndStrings(src);

  // The historical regression: `room_id: ''` (or `room_id: ""`) as a
  // placeholder inside an ActionRun create()/save() call. After stripping
  // strings the literal becomes `room_id: ''` / `room_id: ""` — both forms
  // collapse to the same shape, so we grep for that exact pattern.
  assert.doesNotMatch(
    code,
    /room_id\s*:\s*(''|"")/,
    "dispatch() must not insert ActionRun.room_id as an empty string — " +
      'production.private widened that column to uuid (commit d971fa1) ' +
      'and PG rejects empty-string writes with "invalid input syntax for ' +
      'type uuid: \\"\\"". Create the room first, then save the run row ' +
      'once with room_id = room.id.',
  );
});

// 이 가드가 막는 것은 "행 하나를 두 번 저장" (빈 room_id 스캐폴드 → 패치) 이지
// "파일 안에 save 호출이 하나뿐" 이 아니다. fan-out(티켓 fc3906c5)으로 저장
// 지점이 두 곳이 됐다 — run 을 만드는 `_dispatchOne` 과, 디스패치에 실패한
// 대상을 terminal 감사 행으로 남기는 `_recordFailedTarget`. 둘은 **서로 다른
// 행**을 각각 한 번씩 완전한 상태로 INSERT 하므로 원래 위험과 무관하다.
// 그래서 전체 개수 대신 **메서드별로 정확히 1회**를 고정해 가드의 실효를 지킨다.
function methodBody(code, openRe, label) {
  const m = code.match(openRe);
  assert.ok(m, `could not isolate ${label}`);
  return m[0];
}

test('_dispatchOne() saves the ActionRun row exactly once', () => {
  const src = fs.readFileSync(SERVICE_PATH, 'utf8');
  const code = stripCommentsAndStrings(src);
  const body = methodBody(
    code,
    /private async _dispatchOne\(input: \{[\s\S]*?\r?\n  \}\r?\n/,
    '_dispatchOne',
  );

  // Two saves on the same row was how the bug existed: scaffold first
  // (with empty room_id), then patch.
  const saveCalls = body.match(/runRepo\.save\(/g) || [];
  assert.equal(
    saveCalls.length,
    1,
    `_dispatchOne() should call runRepo.save() once with every field populated, ` +
      `but found ${saveCalls.length} runRepo.save calls. A second save almost ` +
      'certainly means the placeholder-scaffold pattern crept back in. ' +
      '(If you legitimately need an UPDATE elsewhere, switch to runRepo.update() ' +
      'so this guard stays meaningful.)',
  );
});

test('_recordFailedTarget() writes one complete terminal row with a NULL room_id', () => {
  const src = fs.readFileSync(SERVICE_PATH, 'utf8');
  const code = stripCommentsAndStrings(src);
  const body = methodBody(
    code,
    /private async _recordFailedTarget\(input: \{[\s\S]*?\r?\n  \}\r?\n/,
    '_recordFailedTarget',
  );

  const saveCalls = body.match(/runRepo\.save\(/g) || [];
  assert.equal(saveCalls.length, 1, '실패 대상 감사 행도 한 번에 완전히 써야 한다');
  // 빈 문자열은 Postgres 의 uuid 컬럼에서 거부된다 — 이 경로는 붙일 방이 아예
  // 없으므로 반드시 null 이어야 한다(파일 전역 room_id:'' 금지 가드와 짝).
  assert.match(
    body,
    /room_id:\s*null/,
    '방 없이 끝난 대상의 run 은 room_id 를 null 로 써야 한다 — PG 는 uuid 컬럼에 빈 문자열을 거부한다',
  );
  // 문자열 리터럴은 stripCommentsAndStrings 가 비워버리므로 원본에서 확인한다.
  const rawBody = methodBody(
    src,
    /private async _recordFailedTarget\(input: \{[\s\S]*?\r?\n  \}\r?\n/,
    '_recordFailedTarget (raw)',
  );
  assert.match(rawBody, /status:\s*'failed'/, '디스패치 실패 행은 terminal 이어야 한다');
});
