// Work-folder placeholder substitution (worktree 규약 ④).
//
// The server bakes a `{{AWB_WORK_FOLDER}}` token into every non-merging column
// workflow guide and ships only the working_dir-RELATIVE path on the trigger
// SSE. agent-manager owns the ABSOLUTE render: it substitutes the token with the
// concrete spawn cwd (agentContext.cwd) so the trigger prompt names the exact
// folder the subagent runs in.
//
// These lock:
//   (a) the token is replaced with the resolved absolute path (every occurrence);
//   (b) BYTE-IDENTITY when the token is absent (pre-④ template / merging guide)
//       or the work folder is empty — the 0-diff regression guard;
//   (c) end-to-end: a column prompt carrying the token, once injected, renders the
//       absolute path (and no raw token) inside the composed trigger prompt.
//
// Imports the compiled module from dist/ (built by `npm run build`).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  WORK_FOLDER_TOKEN,
  injectWorkFolder,
  composeTriggerPrompt,
} from '../dist/lib/prompts.js';

const ABS = '/home/agent/.config/awb/agents/x/work/.awb/wt/cd7fc2c6';

test('token is the AWB work-folder placeholder', () => {
  assert.equal(WORK_FOLDER_TOKEN, '{{AWB_WORK_FOLDER}}');
});

test('injectWorkFolder: substitutes the token with the absolute work folder', () => {
  const content = `너의 작업 폴더 = \`${WORK_FOLDER_TOKEN}\` — 여기서만 작업하라.`;
  const out = injectWorkFolder(content, ABS);
  assert.ok(out.includes(ABS), 'absolute path must appear');
  assert.ok(!out.includes(WORK_FOLDER_TOKEN), 'raw token must be gone');
  assert.equal(out, `너의 작업 폴더 = \`${ABS}\` — 여기서만 작업하라.`);
});

test('injectWorkFolder: replaces EVERY occurrence of the token', () => {
  const content = `${WORK_FOLDER_TOKEN} ... ${WORK_FOLDER_TOKEN}`;
  const out = injectWorkFolder(content, ABS);
  assert.equal(out, `${ABS} ... ${ABS}`);
  assert.ok(!out.includes(WORK_FOLDER_TOKEN));
});

test('injectWorkFolder: byte-identical when the token is absent (0-diff guard)', () => {
  // A merging-style guide (server omits the token) or any pre-④ template.
  const content = '# Merging — Integrate into Default (assignee)\n\nLand the branch on default.';
  const out = injectWorkFolder(content, ABS);
  assert.equal(out, content, 'no token → content returned unchanged');
  // reference-equality is not guaranteed, but byte-equality is the contract.
});

test('injectWorkFolder: no-op on empty work folder / empty content', () => {
  const content = `dir = ${WORK_FOLDER_TOKEN}`;
  // empty / falsy work folder leaves the token untouched (caller had no cwd)
  assert.equal(injectWorkFolder(content, ''), content);
  assert.equal(injectWorkFolder(content, undefined), content);
  // empty content stays empty
  assert.equal(injectWorkFolder('', ABS), '');
});

test('end-to-end: composed trigger prompt names the absolute folder, not the token', () => {
  // Mirror the event-dispatcher flow: substitution runs on ev.column_prompt.content
  // BEFORE composeTriggerPrompt consumes it.
  const columnPrompt = {
    name: 'in_progress_workflow',
    content: `# In Progress\n\n> 작업 폴더 = \`${WORK_FOLDER_TOKEN}\` — 이 안에서만.`,
  };
  const injected = {
    ...columnPrompt,
    content: injectWorkFolder(columnPrompt.content, ABS),
  };
  const prompt = composeTriggerPrompt(
    { id: 'cd7fc2c6', title: 'T', description: 'D' },
    '', // rolePrompt (injected separately)
    '', // ticketPrompt
    'cd7fc2c6',
    injected,
  );
  assert.ok(prompt.includes(`Column workflow guide (in_progress_workflow):`));
  assert.ok(prompt.includes(ABS), 'absolute work folder must be printed in the prompt');
  assert.ok(!prompt.includes(WORK_FOLDER_TOKEN), 'no raw placeholder must survive to the CLI prompt');
});
