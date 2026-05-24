// Unit test — `sanitizeHarnessMarkers` / `stripHarnessMarkers` helper used by
// MCP tool ingress (add_comment, send_chat_room_message, ticket description
// CRUD). See ticket ce6c8d58: a confused CLI subagent echoed a literal
// `<system-reminder>…</system-reminder>` block from its model context into
// the `add_comment` content arg, which landed verbatim in the DB and broke
// the reviewer's `move_ticket` follow-up. This sanitizer is the
// defense-in-depth filter at the server boundary; we lock the contract here.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST_ROOT = path.resolve(__dirname, '..', 'dist');

const mod = await import(
  'file://' + path.join(DIST_ROOT, 'modules', 'mcp', 'shared', 'helpers.js')
);
const { stripHarnessMarkers, sanitizeHarnessMarkers } = mod;

test('stripHarnessMarkers — passes clean content through untouched', () => {
  const r = stripHarnessMarkers('LGTM — approved for merge.\n\nMoving to Merging.');
  assert.equal(r.cleaned, 'LGTM — approved for merge.\n\nMoving to Merging.');
  assert.deepEqual(r.removed, []);
});

test('stripHarnessMarkers — strips the exact ce6c8d58 reproducer payload', () => {
  // Literal text observed in the DB on the broken reviewer comment (newlines
  // collapsed to match how the helper sees the input).
  const input =
    'Moving to Merging.\n\n<system-reminder>\n' +
    "The task tools haven't been used recently. If you're working on tasks " +
    'that would benefit from tracking progress, consider using TaskCreate to ' +
    'add new tasks and TaskUpdate to update task status (set to in_progress ' +
    'when starting, completed when done). Also consider cleaning up the task ' +
    'list if it has become stale. Only use these if relevant to the current ' +
    "work. This is just a gentle reminder - ignore if not applicable.\n\n" +
    '</system-reminder>';
  const r = stripHarnessMarkers(input);
  assert.equal(r.cleaned, 'Moving to Merging.');
  assert.deepEqual(r.removed, ['system-reminder']);
});

test('stripHarnessMarkers — handles unclosed trailing tag (truncated leak)', () => {
  // Sometimes the model only emits the opening `<system-reminder>` and the
  // body, then runs out of budget before the closer. Better to drop the tail
  // than store a half-open tag.
  const input = 'LGTM.\n\n<system-reminder>\nhalf a leak with no closer';
  const r = stripHarnessMarkers(input);
  assert.equal(r.cleaned, 'LGTM.');
  assert.deepEqual(r.removed, ['system-reminder']);
});

test('stripHarnessMarkers — strips all known harness tag names', () => {
  const cases = [
    'system-reminder',
    'command-message',
    'command-args',
    'command-name',
    'local-command-stdout',
    'local-command-stderr',
    'user-prompt-submit-hook',
  ];
  for (const tag of cases) {
    const r = stripHarnessMarkers(`body\n<${tag}>noise</${tag}>`);
    assert.equal(r.cleaned, 'body', `tag=${tag} should be stripped`);
    assert.deepEqual(r.removed, [tag]);
  }
});

test('stripHarnessMarkers — leaves unrelated XML / HTML-like content alone', () => {
  // Comments often contain real `<code>` / `<pre>` / `<details>` tags. The
  // sanitizer only knows the explicit harness names; everything else passes.
  const input = '<details>\n<summary>x</summary>\n```html\n<div>ok</div>\n```\n</details>';
  const r = stripHarnessMarkers(input);
  assert.equal(r.cleaned, input);
  assert.deepEqual(r.removed, []);
});

test('stripHarnessMarkers — multiple closed blocks of the same tag', () => {
  const input =
    'a\n<system-reminder>one</system-reminder>\nb\n<system-reminder>two</system-reminder>\nc';
  const r = stripHarnessMarkers(input);
  assert.equal(r.cleaned, 'a\n\nb\n\nc');
  assert.deepEqual(r.removed, ['system-reminder']);
});

test('stripHarnessMarkers — mixed tag names in one body', () => {
  const input =
    'header\n<system-reminder>r</system-reminder>\nmid\n<command-message>m</command-message>\nfooter';
  const r = stripHarnessMarkers(input);
  assert.equal(r.cleaned, 'header\n\nmid\n\nfooter');
  // Order in `removed[]` follows the HARNESS_TAG_NAMES iteration order; we
  // only assert membership so future re-orderings don't break this test.
  assert.equal(r.removed.includes('system-reminder'), true);
  assert.equal(r.removed.includes('command-message'), true);
});

test('stripHarnessMarkers — null / undefined / empty / non-string inputs', () => {
  assert.equal(stripHarnessMarkers(null).cleaned, '');
  assert.equal(stripHarnessMarkers(undefined).cleaned, '');
  assert.equal(stripHarnessMarkers('').cleaned, '');
  assert.deepEqual(stripHarnessMarkers(null).removed, []);
});

test('stripHarnessMarkers — case-insensitive tag matching', () => {
  // The harness writes lower-case, but a model paraphrasing the marker may
  // case-fold. Belt-and-braces.
  const r = stripHarnessMarkers('keep\n<SYSTEM-REMINDER>x</SYSTEM-REMINDER>\ntail');
  assert.equal(r.cleaned, 'keep\n\ntail');
  assert.deepEqual(r.removed, ['system-reminder']);
});

test('sanitizeHarnessMarkers — convenience wrapper calls logger.warn on hit', () => {
  let captured = null;
  const logger = {
    warn: (category, message) => { captured = { category, message }; },
  };
  const cleaned = sanitizeHarnessMarkers(
    'Moving to Merging.\n<system-reminder>x</system-reminder>',
    { logger, toolName: 'add_comment', fieldName: 'content', agentId: '1b88dd21-d0c8-4af3-b8fa-199a172f701c' },
  );
  assert.equal(cleaned, 'Moving to Merging.');
  assert.ok(captured, 'logger.warn should have been called');
  assert.equal(captured.category, 'MCP');
  assert.match(captured.message, /add_comment\.content/);
  assert.match(captured.message, /system-reminder/);
  assert.match(captured.message, /agent=1b88dd21/);
});

test('sanitizeHarnessMarkers — does NOT log when nothing was stripped', () => {
  let called = false;
  const logger = { warn: () => { called = true; } };
  const cleaned = sanitizeHarnessMarkers('clean text', { logger, toolName: 'x', fieldName: 'y' });
  assert.equal(cleaned, 'clean text');
  assert.equal(called, false);
});
