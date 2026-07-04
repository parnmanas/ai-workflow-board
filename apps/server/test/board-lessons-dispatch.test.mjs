// Board Lessons / Runbook dispatch injection (ticket 9d0d6ac4).
//
// DoD coverage:
//  1. A lesson registered on a board lands in the dispatch prompt (the
//     harness_config.system_prompt_append the trigger ships to agent-manager).
//  2. The self-improvement retrospective has a path to register a lesson
//     (SELF_IMPROVEMENT_PROMPT references add_board_lesson; the tool exists).
//  3. A board with ZERO active lessons ships a byte-identical harness — no
//     regression for the overwhelming majority of boards that never use this.
//
// The compose/append behavior is exercised against the compiled dist (built by
// `npm run build`); the dispatch wiring + self-improvement path are checked as
// static guards over the source (the injection is deep inside _emitTrigger,
// which is not cheaply bootable in isolation — the guard asserts the exact call
// is present so a refactor can't silently drop it).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  composeLessonsAppend,
  appendBoardLessons,
  validateBoardLessonInput,
  validateBoardLessonUpdate,
  parseLessonTags,
  serializeLessonTags,
  MAX_INJECTED_LESSONS,
  MAX_INJECTED_LESSON_BYTES,
  MAX_LESSON_BODY_LEN,
} from '../dist/common/board-lessons.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}
function code(relPath) {
  return stripComments(fs.readFileSync(path.join(ROOT, 'src', relPath), 'utf8'));
}

// ── 1. compose / append behavior ─────────────────────────────────────────────

test('composeLessonsAppend returns null for no lessons (regression base)', () => {
  assert.equal(composeLessonsAppend(null), null);
  assert.equal(composeLessonsAppend(undefined), null);
  assert.equal(composeLessonsAppend([]), null);
  // blank-only lessons collapse to null too
  assert.equal(composeLessonsAppend([{ title: '  ', body: '' }]), null);
});

test('composeLessonsAppend renders title + body + source ref', () => {
  const block = composeLessonsAppend([
    { title: 'worktree node_modules 부재', body: 'symlink node_modules before build', source_ticket_id: 'abc123' },
  ]);
  assert.ok(block.includes('worktree node_modules 부재'));
  assert.ok(block.includes('symlink node_modules before build'));
  assert.ok(block.includes('[ref: abc123]'));
  assert.match(block, /Board Lessons \/ Runbook/);
});

test('appendBoardLessons injects into system_prompt_append (E2E of the prompt data path)', () => {
  const lessons = [{ title: 'red-run 분류', body: '먼저 프리플라이트로 분류하라' }];
  const out = appendBoardLessons(null, lessons);
  assert.ok(out && typeof out.system_prompt_append === 'string');
  assert.ok(out.system_prompt_append.includes('먼저 프리플라이트로 분류하라'));
});

test('appendBoardLessons APPENDS — never clobbers an existing system_prompt_append', () => {
  const harness = { system_prompt_append: 'RESPOND IN KOREAN', model: 'opus' };
  const out = appendBoardLessons(harness, [{ title: 't', body: 'do the thing' }]);
  assert.ok(out.system_prompt_append.startsWith('RESPOND IN KOREAN'));
  assert.ok(out.system_prompt_append.includes('do the thing'));
  assert.equal(out.model, 'opus'); // other keys preserved
});

// ── 2. abuse caps ─────────────────────────────────────────────────────────────

test('count cap: no more than MAX_INJECTED_LESSONS lessons are numbered in the block', () => {
  const many = Array.from({ length: MAX_INJECTED_LESSONS + 10 }, (_, i) => ({
    title: `L${i}`,
    body: `body ${i}`,
  }));
  const block = composeLessonsAppend(many);
  // The last possible index that could be numbered is MAX_INJECTED_LESSONS.
  assert.ok(!block.includes(`${MAX_INJECTED_LESSONS + 1}. `), 'must not number past the count cap');
});

test('byte cap: composed block stays within MAX_INJECTED_LESSON_BYTES and notes the remainder', () => {
  const big = 'x'.repeat(MAX_LESSON_BODY_LEN);
  const many = Array.from({ length: 40 }, (_, i) => ({ title: `T${i}`, body: big }));
  const block = composeLessonsAppend(many);
  assert.ok(
    Buffer.byteLength(block, 'utf8') <= MAX_INJECTED_LESSON_BYTES + 200,
    'block must respect the byte ceiling (+ small header/note slack)',
  );
  assert.match(block, /more lesson\(s\) not shown/, 'dropped lessons must be disclosed, not silently cut');
});

// ── 3. regression: zero active lessons ⇒ untouched harness ────────────────────

test('regression: empty lessons return the SAME harness object (byte-identical prompt)', () => {
  const harness = { system_prompt_append: 'X', model: 'opus' };
  assert.equal(appendBoardLessons(harness, []), harness, 'must return the same reference');
  assert.equal(appendBoardLessons(null, []), null, 'null harness stays null');
});

// ── validation (write-path caps) ──────────────────────────────────────────────

test('validation rejects over-long body and empty title; accepts a good lesson', () => {
  assert.equal(validateBoardLessonInput({ title: 't', body: 'x'.repeat(MAX_LESSON_BODY_LEN + 1) }).ok, false);
  assert.equal(validateBoardLessonInput({ title: '', body: 'ok' }).ok, false);
  const good = validateBoardLessonInput({ title: 'ok', body: 'do X', tags: ['git', 'build'] });
  assert.equal(good.ok, true);
  assert.deepEqual(good.value.tags, ['git', 'build']);
});

test('update validation allows a bare active toggle (deactivate path)', () => {
  const r = validateBoardLessonUpdate({ active: false });
  assert.equal(r.ok, true);
  assert.equal(r.value.active, false);
});

test('tag (de)serialization round-trips; empty ⇒ null', () => {
  assert.equal(serializeLessonTags([]), null);
  assert.equal(serializeLessonTags(null), null);
  assert.deepEqual(parseLessonTags(serializeLessonTags(['a', 'b'])), ['a', 'b']);
  assert.deepEqual(parseLessonTags('not json'), []);
});

// ── dispatch simulation: mirror the exact _emitTrigger read → append ──────────

test('dispatch simulation: only ACTIVE lessons are injected; inactive board ⇒ unchanged', () => {
  // Stub repo over rows — the same find shape _emitTrigger uses:
  //   find({ where: { board_id, active: true }, order: { updated_at: 'DESC' } })
  const rows = [
    { id: '1', board_id: 'B', active: true, title: 'active one', body: 'INJECT ME', updated_at: new Date('2026-07-02') },
    { id: '2', board_id: 'B', active: false, title: 'inactive', body: 'SKIP ME', updated_at: new Date('2026-07-03') },
    { id: '3', board_id: 'OTHER', active: true, title: 'other board', body: 'NOT MINE', updated_at: new Date('2026-07-04') },
  ];
  const find = ({ where }) =>
    rows
      .filter((r) => r.board_id === where.board_id && (where.active === undefined || r.active === where.active))
      .sort((a, b) => b.updated_at - a.updated_at);

  const active = find({ where: { board_id: 'B', active: true } });
  const injected = appendBoardLessons(null, active);
  assert.ok(injected.system_prompt_append.includes('INJECT ME'));
  assert.ok(!injected.system_prompt_append.includes('SKIP ME'), 'deactivated lesson must not inject');
  assert.ok(!injected.system_prompt_append.includes('NOT MINE'), 'other board must not inject');

  // A board with no active lessons: find returns [], harness stays untouched.
  const noneActive = find({ where: { board_id: 'EMPTY', active: true } });
  const base = { system_prompt_append: 'BASE' };
  assert.equal(appendBoardLessons(base, noneActive), base);
});

// ── static wiring guards ──────────────────────────────────────────────────────

test('trigger-loop._emitTrigger wires the lessons query + append (single chokepoint)', () => {
  const src = code('modules/agents/trigger-loop.service.ts');
  assert.match(src, /appendBoardLessons\(harnessConfig,\s*lessons\)/, 'must append lessons onto harnessConfig');
  assert.match(src, /getRepository\(BoardLesson\)/, 'must read BoardLesson rows');
  assert.match(src, /board_id:\s*boardId,\s*active:\s*true/, 'must filter to the board + active');
});

test('MCP tools register add/list/update_board_lesson', () => {
  const src = code('modules/mcp/tools/board-lesson-tools.ts');
  assert.match(src, /'add_board_lesson'/);
  assert.match(src, /'list_board_lessons'/);
  assert.match(src, /'update_board_lesson'/);
});

test('self-improvement retrospective can register a lesson instead of a ticket', () => {
  const src = code('modules/agents/trigger-loop.service.ts');
  assert.match(src, /add_board_lesson/, 'SELF_IMPROVEMENT_PROMPT must offer the lesson path');
});
