// Regression-grep — ticket 0c175408 (proposal #3). Root cause of the
// `operator does not exist: uuid = character varying` crash (ticket ca31a6ea,
// hotfix 85ec511) is an entity type asymmetry: chat_room_participants.room_id
// is a @ManyToOne(ChatRoom) FK so TypeORM schema-sync makes it a Postgres
// `uuid` column, while chat_room_messages.room_id is a bare @Column varchar.
// Any column-vs-column join on room_id across those two tables therefore needs
// a `::text` cast (RoomMembershipService.toText()) on BOTH sides, or Postgres
// crashes deterministically while SQLite — both columns are text — masks it.
//
// listRooms() was the first instance, searchMessages() the second. That is a
// pattern, not a one-off, so this static guard fails fast if a future query in
// the chat-rooms module reintroduces a bare `*.room_id = *.room_id`
// column-vs-column comparison without the cast. Reviewers previously confirmed
// 0 occurrences by hand `grep`; this automates that check so a refactor can't
// silently regress it in a PR reviewed without a live Postgres.
//
// Scope: column-vs-column equality where at least one side references
// `room_id`. `room_id = :param` (parameter binding) is SAFE — pg coerces the
// bind param to the column type — so the right side must itself be an
// `alias.column` reference (contains a dot) to be flagged. The toText() wrap
// interposes `')} = ${t('` between the two column refs, breaking the
// adjacency the patterns below require, so a correctly-cast join never matches.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CHAT_ROOMS_DIR = path.resolve(__dirname, '..', 'src', 'modules', 'chat-rooms');

// Strip comments so the explanatory `p.room_id = m.room_id` text the hotfix
// added in its own code comment (and any future doc comment naming the
// anti-pattern) does not trip the guard. Block comments first, then `//` to
// end-of-line (won't touch `::text`, which has no `//`).
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');
}

// Dangerous: `alias.room_id = alias.col` or `alias.col = alias.room_id`, with
// only whitespace around `=` (a column-vs-column compare). Both sides are
// `\w+\.\w+` so a `:param` / `IN (:...)` right-hand side never matches.
const BARE_LHS = /\b\w+\.room_id\s*=\s*\w+\.\w+/g;
const BARE_RHS = /\b\w+\.\w+\s*=\s*\w+\.room_id/g;

function listTsFiles(dir) {
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.ts'))
    .map((f) => path.join(dir, f));
}

test('chat-rooms module has no bare column-vs-column room_id join (must ::text-cast)', () => {
  const files = listTsFiles(CHAT_ROOMS_DIR);
  assert.ok(files.length > 0, `expected .ts files under ${CHAT_ROOMS_DIR}`);

  const offenders = [];
  for (const file of files) {
    const src = stripComments(fs.readFileSync(file, 'utf8'));
    const hits = new Set();
    for (const m of src.matchAll(BARE_LHS)) hits.add(m[0].trim());
    for (const m of src.matchAll(BARE_RHS)) hits.add(m[0].trim());
    for (const h of hits) offenders.push(`${path.basename(file)}: ${JSON.stringify(h)}`);
  }

  assert.deepEqual(
    offenders,
    [],
    'Found bare column-vs-column room_id join(s) — wrap BOTH sides with ' +
      'RoomMembershipService.toText() (adds ::text on Postgres) so the ' +
      'uuid(participants.room_id) = varchar(messages.room_id) compare does ' +
      'not crash Postgres:\n  ' + offenders.join('\n  '),
  );
});

// Guard-the-guard: the patterns above must actually fire on the known
// anti-pattern. If a refactor of the regexes silently stops matching, the
// test above would pass vacuously and the safety net would be dead. This
// pins the detector to a synthetic offender.
test('guard regex detects the known bare-join anti-pattern (self-check)', () => {
  const sample = "  'p.room_id = m.room_id AND p.participant_id = :callerId',";
  const stripped = stripComments(sample);
  const matched = BARE_LHS.test(stripped) || BARE_RHS.test(stripped);
  // reset lastIndex (global regexes are stateful)
  BARE_LHS.lastIndex = 0; BARE_RHS.lastIndex = 0;
  assert.ok(matched, 'guard regex failed to detect a bare `p.room_id = m.room_id` join');

  // ...and must NOT fire on a properly toText()-wrapped join or a param bind.
  const safe = "`${t('p.room_id')} = ${t('m.room_id')} AND m.room_id = :roomId`";
  const safeStripped = stripComments(safe);
  const safeMatched = BARE_LHS.test(safeStripped) || BARE_RHS.test(safeStripped);
  BARE_LHS.lastIndex = 0; BARE_RHS.lastIndex = 0;
  assert.ok(!safeMatched, 'guard regex false-positived on a toText()-wrapped / param-bound join');
});
