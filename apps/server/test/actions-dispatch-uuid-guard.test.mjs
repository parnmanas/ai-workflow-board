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

test('dispatch() saves the ActionRun row exactly once', () => {
  const src = fs.readFileSync(SERVICE_PATH, 'utf8');
  const code = stripCommentsAndStrings(src);

  // Two saves on the same row was how the bug existed: scaffold first
  // (with empty room_id), then patch. After the fix there is one save in
  // dispatch(). We tolerate _deleteRunWithRoom etc. which use runRepo.delete
  // — only `runRepo.save` is counted.
  const saveCalls = code.match(/runRepo\.save\(/g) || [];
  assert.equal(
    saveCalls.length,
    1,
    `dispatch() should call runRepo.save() once with every field populated, ` +
      `but found ${saveCalls.length} runRepo.save calls. A second save almost ` +
      'certainly means the placeholder-scaffold pattern crept back in. ' +
      '(If you legitimately need an UPDATE elsewhere in the service, switch ' +
      'to runRepo.update() so this guard stays meaningful.)',
  );
});
