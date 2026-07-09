// Worktree / merge convention — config module (worktree 규약 chain, ticket 4ba844ea).
//
// Covers the pure resolver + validator contract the whole chain hinges on:
//   (a) resolveBoardWorktreeMode is null-safe — null / undefined / unknown /
//       malformed all degrade to the regression baseline 'per_ticket'
//   (b) resolveBoardUsePr is null-safe — null/undefined → false, and it reads
//       the DB boolean, the sql.js 0/1 int, and "true"/"1" strings correctly
//   (c) the write-path validators REJECT a typo (so REST can 400) and ACCEPT +
//       normalize the valid / wire-encoded forms
//   (d) the defaults exported for reuse are exactly per_ticket / false
//
// Imports the compiled module from dist/ (built by `npm run build`).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  WORKTREE_MODES,
  DEFAULT_WORKTREE_MODE,
  DEFAULT_USE_PR,
  WORKTREE_ROOT_REL,
  isWorktreeMode,
  resolveBoardWorktreeMode,
  resolveBoardUsePr,
  validateWorktreeModeInput,
  validateUsePrInput,
  worktreeSlugFor,
  resolveWorktreeRelPath,
  USE_PR_MARKER,
  renderUsePrTemplate,
} from '../dist/common/worktree-config.js';
import { DEFAULT_PROMPT_TEMPLATES } from '../dist/database/default-prompt-templates.js';

test('defaults are the regression baseline: per_ticket / false', () => {
  assert.deepEqual([...WORKTREE_MODES], ['per_ticket', 'shared']);
  assert.equal(DEFAULT_WORKTREE_MODE, 'per_ticket');
  assert.equal(DEFAULT_USE_PR, false);
});

test('isWorktreeMode: only the two known modes pass', () => {
  assert.equal(isWorktreeMode('per_ticket'), true);
  assert.equal(isWorktreeMode('shared'), true);
  assert.equal(isWorktreeMode('PER_TICKET'), false);
  assert.equal(isWorktreeMode('worktree'), false);
  assert.equal(isWorktreeMode(''), false);
  assert.equal(isWorktreeMode(null), false);
  assert.equal(isWorktreeMode(undefined), false);
  assert.equal(isWorktreeMode(1), false);
});

test('resolveBoardWorktreeMode: null-safe read, unknown → per_ticket', () => {
  assert.equal(resolveBoardWorktreeMode('per_ticket'), 'per_ticket');
  assert.equal(resolveBoardWorktreeMode('shared'), 'shared');
  // null / undefined / empty / garbage all fall back to the default
  assert.equal(resolveBoardWorktreeMode(null), 'per_ticket');
  assert.equal(resolveBoardWorktreeMode(undefined), 'per_ticket');
  assert.equal(resolveBoardWorktreeMode(''), 'per_ticket');
  assert.equal(resolveBoardWorktreeMode('nonsense'), 'per_ticket');
});

test('resolveBoardUsePr: null-safe read across bool / int / string encodings', () => {
  // native boolean
  assert.equal(resolveBoardUsePr(true), true);
  assert.equal(resolveBoardUsePr(false), false);
  // null / undefined → default false
  assert.equal(resolveBoardUsePr(null), false);
  assert.equal(resolveBoardUsePr(undefined), false);
  // sql.js 0/1 integer
  assert.equal(resolveBoardUsePr(1), true);
  assert.equal(resolveBoardUsePr(0), false);
  // string encodings
  assert.equal(resolveBoardUsePr('true'), true);
  assert.equal(resolveBoardUsePr('1'), true);
  assert.equal(resolveBoardUsePr('false'), false);
  assert.equal(resolveBoardUsePr('anything'), false);
});

test('validateWorktreeModeInput: rejects a typo, accepts the two modes', () => {
  assert.equal(validateWorktreeModeInput('per_ticket').ok, true);
  assert.deepEqual(validateWorktreeModeInput('shared'), { ok: true, value: 'shared' });

  const bad = validateWorktreeModeInput('per-ticket');
  assert.equal(bad.ok, false);
  assert.match(bad.error, /worktree_mode must be one of/);

  assert.equal(validateWorktreeModeInput(null).ok, false);
  assert.equal(validateWorktreeModeInput(undefined).ok, false);
  assert.equal(validateWorktreeModeInput(1).ok, false);
});

test('validateUsePrInput: accepts bool + wire encodings, rejects genuine non-boolean', () => {
  assert.deepEqual(validateUsePrInput(true), { ok: true, value: true });
  assert.deepEqual(validateUsePrInput(false), { ok: true, value: false });
  // common wire encodings normalise to a real boolean
  assert.deepEqual(validateUsePrInput(1), { ok: true, value: true });
  assert.deepEqual(validateUsePrInput('true'), { ok: true, value: true });
  assert.deepEqual(validateUsePrInput(0), { ok: true, value: false });
  assert.deepEqual(validateUsePrInput('false'), { ok: true, value: false });

  // genuine non-boolean 400s instead of being coerced
  const bad = validateUsePrInput('yes');
  assert.equal(bad.ok, false);
  assert.match(bad.error, /use_pr must be a boolean/);
  assert.equal(validateUsePrInput(2).ok, false);
  assert.equal(validateUsePrInput({}).ok, false);
  assert.equal(validateUsePrInput(null).ok, false);
});

// ── worktree 규약 ④: the path the server injects into the trigger prompt ──────
// worktreeSlugFor / resolveWorktreeRelPath must MIRROR agent-manager's
// worktreeSlug (worktree-manager.ts) exactly — the server ships the relative
// path on the SSE trigger and the manager joins it onto working_dir. If the two
// slug fns diverge, the prompt names a folder the manager didn't check out.

test('WORKTREE_ROOT_REL is the fixed .awb/wt root', () => {
  assert.equal(WORKTREE_ROOT_REL, '.awb/wt');
});

test('worktreeSlugFor: per_ticket → first 8 chars, shared → literal "shared"', () => {
  // per_ticket takes the uuid's first 8 chars
  assert.equal(worktreeSlugFor('cd7fc2c6-942e-4b8a-8ab7-56be8787f711', 'per_ticket'), 'cd7fc2c6');
  // default mode is per_ticket (matches DEFAULT_WORKTREE_MODE)
  assert.equal(DEFAULT_WORKTREE_MODE, 'per_ticket');
  assert.equal(worktreeSlugFor('cd7fc2c6-942e-4b8a-8ab7-56be8787f711'), 'cd7fc2c6');
  // shared collapses every ticket to one reusable checkout
  assert.equal(worktreeSlugFor('cd7fc2c6-942e-4b8a-8ab7-56be8787f711', 'shared'), 'shared');
  // a short id shorter than 8 chars is used whole
  assert.equal(worktreeSlugFor('abc', 'per_ticket'), 'abc');
});

test('worktreeSlugFor: sanitizes path-hostile chars and degrades empty → "ticket"', () => {
  // only [A-Za-z0-9._-] survive; everything else → '_' (no path traversal / separators)
  assert.equal(worktreeSlugFor('a/b\\c:d!', 'per_ticket'), 'a_b_c_d_');
  // empty / non-string ids never produce an empty slug (would collide with the root)
  assert.equal(worktreeSlugFor('', 'per_ticket'), 'ticket');
  assert.equal(worktreeSlugFor(null, 'per_ticket'), 'ticket');
  assert.equal(worktreeSlugFor(undefined, 'per_ticket'), 'ticket');
});

test('resolveWorktreeRelPath: `.awb/wt/<slug>` for per_ticket|shared, mirrors the slug fn', () => {
  const id = 'cd7fc2c6-942e-4b8a-8ab7-56be8787f711';
  assert.equal(resolveWorktreeRelPath(id, 'per_ticket'), '.awb/wt/cd7fc2c6');
  assert.equal(resolveWorktreeRelPath(id, 'shared'), '.awb/wt/shared');
  // default mode = per_ticket
  assert.equal(resolveWorktreeRelPath(id), '.awb/wt/cd7fc2c6');
  // invariant: rel path is exactly root + '/' + slug for either mode
  for (const mode of ['per_ticket', 'shared']) {
    assert.equal(
      resolveWorktreeRelPath(id, mode),
      `${WORKTREE_ROOT_REL}/${worktreeSlugFor(id, mode)}`,
    );
  }
});

// ── worktree 규약 ⑥: use_pr-conditional prompt rendering ──────────────────────
// The server strips the pr-only / no-pr marker blocks at trigger-prompt assembly
// so a use_pr=false board never sees the `gh pr` merge branch and a use_pr=true
// board gets the PR create/merge path. Marker-free content must pass through
// byte-identical (the regression guard — existing seeded / custom prompts).

test('USE_PR_MARKER: the four marker tokens are the documented HTML comments', () => {
  assert.equal(USE_PR_MARKER.prOnlyOpen, '<!--awb:pr-only-->');
  assert.equal(USE_PR_MARKER.prOnlyClose, '<!--/awb:pr-only-->');
  assert.equal(USE_PR_MARKER.noPrOpen, '<!--awb:no-pr-->');
  assert.equal(USE_PR_MARKER.noPrClose, '<!--/awb:no-pr-->');
});

test('renderUsePrTemplate: marker-free content passes through byte-identical (both modes)', () => {
  const plain = '# Merging\n\n1. do the thing\n2. do another\n';
  assert.equal(renderUsePrTemplate(plain, true), plain);
  assert.equal(renderUsePrTemplate(plain, false), plain);
  // null / undefined / empty degrade to '' without throwing
  assert.equal(renderUsePrTemplate(null, true), '');
  assert.equal(renderUsePrTemplate(undefined, false), '');
  assert.equal(renderUsePrTemplate('', true), '');
});

test('renderUsePrTemplate: use_pr=true keeps pr-only, drops no-pr (markers stripped)', () => {
  const src = [
    'before',
    '<!--awb:pr-only-->',
    'PR PATH: gh pr merge --squash',
    '<!--/awb:pr-only-->',
    '<!--awb:no-pr-->',
    'FF PATH: direct merge',
    '<!--/awb:no-pr-->',
    'after',
  ].join('\n');
  const out = renderUsePrTemplate(src, true);
  assert.equal(out, 'before\nPR PATH: gh pr merge --squash\nafter');
  // no marker token survives in either branch
  assert.equal(out.includes('<!--awb:'), false);
  assert.equal(out.includes('FF PATH'), false);
});

test('renderUsePrTemplate: use_pr=false keeps no-pr, drops pr-only (markers stripped)', () => {
  const src = [
    'before',
    '<!--awb:pr-only-->',
    'PR PATH: gh pr merge --squash',
    '<!--/awb:pr-only-->',
    '<!--awb:no-pr-->',
    'FF PATH: direct merge',
    '<!--/awb:no-pr-->',
    'after',
  ].join('\n');
  const out = renderUsePrTemplate(src, false);
  assert.equal(out, 'before\nFF PATH: direct merge\nafter');
  assert.equal(out.includes('<!--awb:'), false);
  assert.equal(out.includes('gh pr merge'), false);
});

test('renderUsePrTemplate: a dropped multi-line block leaves no stray blank-line run', () => {
  const src = [
    'para one',
    '',
    '<!--awb:pr-only-->',
    'pr line a',
    'pr line b',
    '<!--/awb:pr-only-->',
    '',
    'para two',
  ].join('\n');
  const out = renderUsePrTemplate(src, false);
  // block gone, and the surrounding blank lines collapse to a single blank line
  assert.equal(out, 'para one\n\npara two');
  assert.match(out, /para one\n\npara two/);
  assert.equal(/\n\n\n/.test(out), false);
});

test('renderUsePrTemplate: indented (nested-bullet) markers still match via trim', () => {
  const src = [
    '- top bullet',
    '  <!--awb:pr-only-->',
    '  - pr sub-bullet',
    '  <!--/awb:pr-only-->',
    '- next bullet',
  ].join('\n');
  assert.equal(renderUsePrTemplate(src, true), '- top bullet\n  - pr sub-bullet\n- next bullet');
  assert.equal(renderUsePrTemplate(src, false), '- top bullet\n- next bullet');
});

// ── integration: the real seeded merging / in-progress / review templates ─────
// Proves the template markers + the renderer agree: the exact strings the DoD
// names must appear / disappear per use_pr. Guards against a future template
// edit that unbalances a marker or drops the `gh pr` gating.

function seededTemplate(name) {
  const tpl = DEFAULT_PROMPT_TEMPLATES.find((t) => t.name === name);
  assert.ok(tpl, `default template ${name} must exist`);
  return tpl.content;
}

test('seeded merging_workflow: use_pr=false renders the ff path only, no `gh pr` merge branch', () => {
  const merging = seededTemplate('merging_workflow');
  // the raw template carries balanced markers
  assert.ok(merging.includes(USE_PR_MARKER.prOnlyOpen) && merging.includes(USE_PR_MARKER.prOnlyClose));
  assert.ok(merging.includes(USE_PR_MARKER.noPrOpen) && merging.includes(USE_PR_MARKER.noPrClose));

  const off = renderUsePrTemplate(merging, false);
  assert.equal(off.includes('<!--awb:'), false, 'no marker tokens leak to the prompt');
  // the actual PR squash-merge COMMAND (pr-only) is gated out; only the no-pr
  // guidance — which names `gh pr merge` to say "do NOT run it" — remains.
  assert.equal(off.includes('gh pr merge <pr> --squash --delete-branch'), false,
    'use_pr=false must not render the PR merge command');
  assert.match(off, /merges directly/); // the no-pr guidance is present
  assert.equal(/uses PRs/.test(off), false, 'the pr-only guidance is dropped when PRs are off');
  // the direct ff steps stay intact for the default path
  assert.match(off, /git merge --ff-only/);
});

test('seeded merging_workflow: use_pr=true renders the PR squash-merge path', () => {
  const merging = seededTemplate('merging_workflow');
  const on = renderUsePrTemplate(merging, true);
  assert.equal(on.includes('<!--awb:'), false);
  assert.match(on, /gh pr merge <pr> --squash --delete-branch/);
  assert.match(on, /uses PRs/); // the pr-only guidance is present
  assert.equal(/merges directly/.test(on), false, 'the no-pr guidance is dropped when PRs are on');
  // the ff steps remain (a PR board still rebases/integrates before merging)
  assert.match(on, /git merge --ff-only/);
});

test('seeded in_progress_workflow: gh pr create renders only when use_pr=true', () => {
  const inprog = seededTemplate('in_progress_workflow');
  const off = renderUsePrTemplate(inprog, false);
  const on = renderUsePrTemplate(inprog, true);
  assert.equal(off.includes('<!--awb:'), false);
  assert.equal(on.includes('<!--awb:'), false);
  // the PR-open COMMAND (pr-only) is gated out; the no-pr guidance may still
  // mention `gh pr create` to forbid it, so assert on the mutually-exclusive
  // mode headers and the concrete `--fill` command form.
  assert.equal(off.includes('gh pr create --fill'), false, 'use_pr=false must not tell the agent to open a PR');
  assert.match(off, /merges directly/);
  assert.equal(/uses PRs/.test(off), false);
  assert.match(on, /gh pr create --fill/);
  assert.match(on, /uses PRs/);
  assert.equal(/merges directly/.test(on), false);
});

test('seeded review_workflow: reviewer preamble switches PR vs branch per use_pr', () => {
  const review = seededTemplate('review_workflow');
  const off = renderUsePrTemplate(review, false);
  const on = renderUsePrTemplate(review, true);
  assert.equal(off.includes('<!--awb:'), false);
  assert.equal(on.includes('<!--awb:'), false);
  // OFF: told to review the branch diff (git equivalents), not a PR
  assert.match(off, /there is usually no PR/i);
  assert.match(off, /git rev-list --left-right --count/);
  // ON: told to use the gh pr commands directly
  assert.match(on, /the assignee opened a PR/i);
});
