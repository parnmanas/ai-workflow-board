// Static guard for board output language dispatch plumbing.
//
// The board language option must use one shared instruction string across
// ticket triggers and Action runs. Ticket triggers can carry it through
// harness_config.system_prompt_append, while Action runs reuse chat-room
// messages and must prepend the same instruction to the rendered prompt.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const HARNESS_PATH = path.join(ROOT, 'src', 'common', 'harness-config.ts');
const TRIGGER_PATH = path.join(ROOT, 'src', 'modules', 'agents', 'trigger-loop.service.ts');
const ACTIONS_PATH = path.join(ROOT, 'src', 'modules', 'actions', 'actions.service.ts');

test('board language instruction is centralized in harness-config', () => {
  const src = fs.readFileSync(HARNESS_PATH, 'utf8');
  assert.match(src, /export function buildBoardLanguageInstruction/);
  assert.match(src, /export function appendBoardLanguageInstruction/);
  assert.match(src, /export function prependBoardLanguageInstruction/);
});

test('ticket trigger dispatch appends board language via shared helper', () => {
  const src = fs.readFileSync(TRIGGER_PATH, 'utf8');
  assert.match(src, /appendBoardLanguageInstruction\(harnessConfig,\s*boardForHarness\?\.language\)/);
  assert.doesNotMatch(src, /Write all ticket comments, chat messages, commit messages/);
});

test('Action dispatch prepends board language to rendered prompt', () => {
  const src = fs.readFileSync(ACTIONS_PATH, 'utf8');
  assert.match(src, /prependBoardLanguageInstruction\(renderedPrompt,\s*board\?\.language\)/);
});
