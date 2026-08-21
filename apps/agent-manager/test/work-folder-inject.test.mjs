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
  composeChatPrompt,
  composeChatRoomPrompt,
  runWorkspaceInstructions,
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

// ── ticket 9fd27487: Action Run / 채팅방 프롬프트의 폴더 경계 정책 ──

test('runWorkspaceInstructions: empty work folder → empty string (no block)', () => {
  assert.equal(runWorkspaceInstructions('', 'action'), '');
  assert.equal(runWorkspaceInstructions('', 'chat'), '');
});

test('runWorkspaceInstructions: names the exact folder and distinguishes action vs chat wording', () => {
  const action = runWorkspaceInstructions(ABS, 'action');
  assert.ok(action.includes(ABS));
  assert.ok(action.includes('this Action'));
  assert.ok(!action.includes('this chat room'));

  const chat = runWorkspaceInstructions(ABS, 'chat');
  assert.ok(chat.includes(ABS));
  assert.ok(chat.includes('this chat room'));
  assert.ok(!chat.includes('this Action'));

  // perTicketWorktreeInstructions 와 동일한 반스프롤(anti-sprawl) 항목들이다
  // (구조적으로 동일한 정책 — prompts.ts 의 doc comment 참고).
  for (const text of [action, chat]) {
    assert.ok(/do not create another git worktree, clone/i.test(text));
    assert.ok(/working_dir \(the agent-home container\)/.test(text));
  }
});

test('runWorkspaceInstructions: action wording defers to a pre-existing folder the prompt already pins; chat wording does not', () => {
  // ticket 9fd27487 AC6 — 하위호환: 이 자동 배정 이전부터 자기만의 절대경로
  // worktree를 프롬프트에 못 박아 둔 기존 Action(예: "Package 보안 점검",
  // "Merge To Production.Private and PUSH")이 이미 있다. action에는 그 프롬프트가
  // 우선한다는 탈출구 문구가 있어야 하고, chat에는 이 문제 자체가 없으므로 없어야
  // 한다.
  const action = runWorkspaceInstructions(ABS, 'action');
  assert.ok(
    /already names a different existing working folder/i.test(action),
    'action wording must defer to a pre-existing folder the prompt already pins',
  );

  const chat = runWorkspaceInstructions(ABS, 'chat');
  assert.ok(
    !/already names a different existing working folder/i.test(chat),
    'chat prompts never pin their own folder, so no defer-to-prompt escape hatch is needed',
  );
});

test('composeChatPrompt: byte-identical when workFolder is omitted (default OFF — non-opted-in workspace)', () => {
  const withDefault = composeChatPrompt('', [], 'hello', 'room-1', true);
  const withExplicitEmpty = composeChatPrompt('', [], 'hello', 'room-1', true, '');
  assert.equal(withDefault, withExplicitEmpty);
  assert.ok(!withDefault.includes('AWB work-folder policy'), 'no boundary block for a non-provisioned chat turn');
});

test('composeChatPrompt: injects the boundary block + substitutes {{AWB_WORK_FOLDER}} when provisioned', () => {
  const msg = `Please check ${WORK_FOLDER_TOKEN} for the log.`;
  const out = composeChatPrompt('', [], msg, 'room-1', true, ABS);
  assert.ok(out.includes('AWB work-folder policy'), 'boundary block present once provisioned');
  assert.ok(out.includes(`this chat room is exactly: ${ABS}`));
  assert.ok(out.includes(`Please check ${ABS} for the log.`), 'token in the user message itself is substituted too');
  assert.ok(!out.includes(WORK_FOLDER_TOKEN), 'no raw placeholder survives');
});

test('composeChatRoomPrompt: byte-identical when workFolder is omitted', () => {
  const msg = { content: 'hi', sender_name: 'Alice', sender_id: 'u1' };
  const withDefault = composeChatRoomPrompt('room-1', [], msg, undefined, true, undefined, '', false);
  const withExplicitEmpty = composeChatRoomPrompt('room-1', [], msg, undefined, true, undefined, '', false, '');
  assert.equal(withDefault, withExplicitEmpty);
  assert.ok(!withDefault.includes('AWB work-folder policy'));
});

test('composeChatRoomPrompt: Action Run room gets the "this Action" wording; plain room gets "this chat room"', () => {
  const msg = { content: 'do the thing', sender_name: 'System', sender_id: 'system' };
  const actionPrompt = composeChatRoomPrompt('room-a', [], msg, undefined, true, undefined, '', true, ABS);
  assert.ok(actionPrompt.includes(`this Action is exactly: ${ABS}`));

  const chatPrompt = composeChatRoomPrompt('room-c', [], msg, undefined, true, undefined, '', false, ABS);
  assert.ok(chatPrompt.includes(`this chat room is exactly: ${ABS}`));
});
