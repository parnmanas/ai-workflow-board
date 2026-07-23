// Regression-grep — ticket a57517be finding 2 (unpend must wake current
// column) AND ticket b2e88390 (clearing pending_user_action is human-only).
// The behavioural test (test/qa-flows/unpend-emits-trigger.test.mjs) boots
// NestJS and asserts the SSE wake-up / rejection. This file is the cheap
// static check:
//   - REST PATCH /api/tickets/:id (the human path, AuthGuard-protected) must
//     still call `dispatchCurrentColumn` on a true→false flip.
//   - The two MCP paths that used to ALSO perform that flip — `unpend_ticket`
//     and `update_ticket` — must instead reject it outright (ticket b2e88390:
//     MCP has no authenticated user session to prove a human made the call).
//     A `dispatchCurrentColumn` call surviving inside either MCP block would
//     mean the human-only guard got reverted/bypassed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const MCP_TOOL_FILE = path.resolve(
  __dirname, '..', 'src', 'modules', 'mcp', 'tools', 'ticket-crud-tools.ts',
);
const REST_CTRL_FILE = path.resolve(
  __dirname, '..', 'src', 'modules', 'tickets', 'tickets.controller.ts',
);
const TRIGGER_LOOP_FILE = path.resolve(
  __dirname, '..', 'src', 'modules', 'agents', 'trigger-loop.service.ts',
);

function read(p) { return fs.readFileSync(p, 'utf8'); }

test('TriggerLoopService exposes dispatchCurrentColumn as a public async method', () => {
  const src = read(TRIGGER_LOOP_FILE);
  // The method must exist (this is what both unpend surfaces call).
  assert.match(
    src,
    /async\s+dispatchCurrentColumn\s*\(/,
    'TriggerLoopService.dispatchCurrentColumn(...) must be defined',
  );
  // Must short-circuit on `pending_user_action` to avoid emitting for a
  // ticket the caller forgot to clear (defence-in-depth — both call sites
  // clear the flag before calling, but the focus gate behind _emitTrigger
  // would also re-drop. Belt-and-braces here keeps the no-op clear in logs.)
  assert.match(
    src,
    /pending_user_action[\s\S]{0,160}dispatchCurrentColumn skipped/,
    'dispatchCurrentColumn must short-circuit when ticket.pending_user_action is still true',
  );
});

test('ticket b2e88390: MCP unpend_ticket always rejects — never flips the flag, never dispatches', () => {
  const src = read(MCP_TOOL_FILE);
  // Find the unpend_ticket registration block, then assert inside that same
  // block. Two-step so a stray match in some other tool can't satisfy it.
  const blockStart = src.indexOf("'unpend_ticket'");
  assert.notEqual(blockStart, -1, "expected 'unpend_ticket' tool registration block");
  // Next `server.tool(` after the start bounds the block.
  const nextToolIdx = src.indexOf('server.tool(', blockStart + 1);
  const block = nextToolIdx === -1 ? src.slice(blockStart) : src.slice(blockStart, nextToolIdx);

  assert.match(
    block,
    /HUMAN_ONLY_UNPEND_MESSAGE/,
    'unpend_ticket must reject with HUMAN_ONLY_UNPEND_MESSAGE — MCP has no human session to clear on behalf of',
  );
  assert.doesNotMatch(
    block,
    /ticket\.pending_user_action\s*=\s*false/,
    'unpend_ticket must never itself clear pending_user_action — that would defeat the human-only guard',
  );
  assert.doesNotMatch(
    block,
    /dispatchCurrentColumn/,
    'unpend_ticket must not dispatch — there is no successful-clear path left to wake anyone from',
  );
});

test('REST PATCH /api/tickets/:id wakes the current column after clearing pending_user_action', () => {
  const src = read(REST_CTRL_FILE);
  // Must call the same TriggerLoopService entry point. Gated by `oldPending
  // && !ticket.pending_user_action` so it only fires on a true→false flip
  // (not on a no-op PATCH that left the flag alone).
  assert.match(
    src,
    /this\.triggerLoop\.dispatchCurrentColumn\(/,
    'tickets.controller PATCH must invoke this.triggerLoop.dispatchCurrentColumn(...)',
  );
  assert.match(
    src,
    /oldPending\s*&&\s*!ticket\.pending_user_action[\s\S]{0,400}dispatchCurrentColumn/,
    'dispatchCurrentColumn must be gated by `oldPending && !ticket.pending_user_action` (true→false flip only)',
  );
});

test('ticket b2e88390: MCP update_ticket rejects a true → false pending_user_action flip', () => {
  // Same bug class as unpend_ticket — update_ticket could also flip the
  // flag (via `pending_user_action: false` in the body). Same fix: reject
  // the clear outright instead of applying + dispatching it.
  const src = read(MCP_TOOL_FILE);
  const blockStart = src.indexOf("'update_ticket'");
  assert.notEqual(blockStart, -1, "expected 'update_ticket' tool registration block");
  const nextToolIdx = src.indexOf('server.tool(', blockStart + 1);
  const block = nextToolIdx === -1 ? src.slice(blockStart) : src.slice(blockStart, nextToolIdx);

  assert.match(
    block,
    /pending_user_action\s*===\s*false\s*&&\s*ticket\.pending_user_action[\s\S]{0,120}HUMAN_ONLY_UNPEND_MESSAGE/,
    'update_ticket must reject `pending_user_action: false` while the ticket is pending, with HUMAN_ONLY_UNPEND_MESSAGE',
  );
  assert.doesNotMatch(
    block,
    /dispatchCurrentColumn/,
    'update_ticket must not dispatch — the true→false flip it used to wake up after is now rejected, never applied',
  );
});
