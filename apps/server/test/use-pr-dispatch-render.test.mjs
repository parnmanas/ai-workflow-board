// use_pr-conditional column-prompt rendering at dispatch (worktree 규약 ⑥, ticket a566bcda).
//
// DoD coverage — the SERVER injects use_pr at trigger-prompt assembly (same
// channel as 규약 ④'s work-folder path):
//  1. `_emitTrigger` resolves the board's use_pr (resolveBoardUsePr) and renders
//     `columnPrompt.content` through `renderUsePrTemplate` BEFORE the trigger
//     ships — so a use_pr=false board never sees the `gh pr` merge branch and a
//     use_pr=true board gets the PR create/merge path.
//  2. It stays on the EXISTING `column_prompt` payload field — no new SSE field,
//     so agent-manager / the plugin need no change and the parity guard is moot.
//  3. Dispatch simulation: mirror the exact read → render the service does and
//     confirm the emitted content flips per use_pr for the real seeded template.
//
// The render behavior is exercised against the compiled dist; the dispatch
// wiring is a static guard over the source (the transform is deep inside
// _emitTrigger, which is not cheaply bootable in isolation — the guard asserts
// the exact call is present so a refactor can't silently drop it), mirroring
// board-lessons-dispatch.test.mjs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  resolveBoardUsePr,
  renderUsePrTemplate,
} from '../dist/common/worktree-config.js';
import { DEFAULT_PROMPT_TEMPLATES } from '../dist/database/default-prompt-templates.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}
function code(relPath) {
  return stripComments(fs.readFileSync(path.join(ROOT, 'src', relPath), 'utf8'));
}

// ── dispatch simulation: mirror the exact _emitTrigger read → render ──────────

test('dispatch simulation: emitted column_prompt flips per board use_pr', () => {
  const merging = DEFAULT_PROMPT_TEMPLATES.find((t) => t.name === 'merging_workflow');
  assert.ok(merging, 'merging_workflow must be a seeded default');

  // Mirror the two Board rows the service reads use_pr off of.
  const boards = {
    ffBoard: { use_pr: false }, // default board — direct ff merge
    prBoard: { use_pr: true },  // opt-in PR board
  };

  // The transform the service applies to columnPrompt.content before emit.
  const render = (board) => {
    const usePr = resolveBoardUsePr(board?.use_pr);
    let columnPrompt = { template_id: 't', name: merging.name, content: merging.content };
    columnPrompt = { ...columnPrompt, content: renderUsePrTemplate(columnPrompt.content, usePr) };
    return columnPrompt.content;
  };

  const ff = render(boards.ffBoard);
  const pr = render(boards.prBoard);

  // use_pr=false → the PR squash-merge command is gone; the ff path stays.
  assert.equal(ff.includes('gh pr merge <pr> --squash --delete-branch'), false);
  assert.match(ff, /git merge --ff-only/);
  assert.match(ff, /merges directly/);
  assert.equal(ff.includes('<!--awb:'), false, 'no marker tokens leak downstream');

  // use_pr=true → the PR squash-merge path renders.
  assert.match(pr, /gh pr merge <pr> --squash --delete-branch/);
  assert.equal(/merges directly/.test(pr), false);
  assert.equal(pr.includes('<!--awb:'), false);

  // A board that never set use_pr (null) resolves to the ff path (regression base).
  assert.equal(render({}), ff);
  assert.equal(render(null), ff);
});

// ── static wiring guards over _emitTrigger ───────────────────────────────────

test('trigger-loop imports the ⑥ resolver + renderer from worktree-config', () => {
  const src = code('modules/agents/trigger-loop.service.ts');
  assert.match(src, /resolveBoardUsePr/, 'must import/use the use_pr resolver');
  assert.match(src, /renderUsePrTemplate/, 'must import/use the prompt renderer');
});

test('_emitTrigger resolves board use_pr and renders columnPrompt through it', () => {
  const src = code('modules/agents/trigger-loop.service.ts');
  // reads use_pr off the same Board row loaded for harness
  assert.match(src, /resolveBoardUsePr\(\s*boardForHarness\?\.use_pr\s*\)/,
    'must resolve use_pr from the board row');
  // renders the column workflow prompt with the resolved use_pr
  assert.match(src, /renderUsePrTemplate\(\s*columnPrompt\.content,\s*usePr\s*\)/,
    'must render columnPrompt.content for this board\'s use_pr');
});

test('the transform stays on the existing column_prompt field — no new SSE field', () => {
  const src = code('modules/agents/trigger-loop.service.ts');
  // the emit still ships `column_prompt: columnPrompt` (transformed in place),
  // so no *Payload field is added and the SSE parity guard is untouched.
  assert.match(src, /column_prompt:\s*columnPrompt/, 'emit must still ship the column_prompt field');
});
