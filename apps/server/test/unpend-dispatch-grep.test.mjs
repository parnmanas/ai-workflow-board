// Regression-grep — ticket a57517be finding 2 (unpend must wake current
// column). The behavioural test (test/qa-flows/unpend-emits-trigger.test.mjs)
// boots NestJS and asserts the SSE wake-up arrives. This file is the cheap
// static check: it greps both surfaces (MCP `unpend_ticket` tool and REST
// PATCH /api/tickets/:id) and fails fast if a future refactor strips the
// `dispatchCurrentColumn` call from either path. Catches accidental reverts
// in PR-review-without-flow-tests scenarios.

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

test('MCP unpend_ticket calls TriggerLoopService.dispatchCurrentColumn after clearing the flag', () => {
  const src = read(MCP_TOOL_FILE);
  // Find the unpend_ticket registration block, then assert the call appears
  // inside the same block. Two-step so a stray dispatchCurrentColumn in some
  // other tool can't satisfy the check.
  const blockStart = src.indexOf("'unpend_ticket'");
  assert.notEqual(blockStart, -1, "expected 'unpend_ticket' tool registration block");
  // Next `server.tool(` after the start bounds the block.
  const nextToolIdx = src.indexOf('server.tool(', blockStart + 1);
  const block = nextToolIdx === -1 ? src.slice(blockStart) : src.slice(blockStart, nextToolIdx);

  assert.match(
    block,
    /triggerLoopService\?\.\s*dispatchCurrentColumn\(|triggerLoopService\.dispatchCurrentColumn\(/,
    'unpend_ticket tool must call triggerLoopService.dispatchCurrentColumn(...)',
  );
  assert.match(
    block,
    /['"]unpend['"]/,
    'unpend_ticket dispatch call must label the trigger source as "unpend"',
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

test('MCP update_ticket dispatches when it flips pending_user_action true → false', () => {
  // Same bug class as unpend_ticket — update_ticket can also flip the
  // flag (via `pending_user_action: false` in the body), and the same
  // activity-row-only path does not route through column dispatch on
  // its own. Make sure all three flip surfaces (REST PATCH, MCP
  // unpend_ticket, MCP update_ticket) call dispatchCurrentColumn.
  const src = read(MCP_TOOL_FILE);
  const blockStart = src.indexOf("'update_ticket'");
  assert.notEqual(blockStart, -1, "expected 'update_ticket' tool registration block");
  const nextToolIdx = src.indexOf('server.tool(', blockStart + 1);
  const block = nextToolIdx === -1 ? src.slice(blockStart) : src.slice(blockStart, nextToolIdx);

  assert.match(
    block,
    /triggerLoopService\?\.\s*dispatchCurrentColumn\(|triggerLoopService\.dispatchCurrentColumn\(/,
    'update_ticket tool must call triggerLoopService.dispatchCurrentColumn(...) on pending true → false',
  );
  // Gate must check both the pending_user_action change AND the
  // direction (oldPending && !ticket.pending_user_action) so an update
  // that toggles other fields without touching the flag stays silent.
  assert.match(
    block,
    /changes\.includes\(\s*['"]pending_user_action['"]\s*\)[\s\S]{0,400}oldPending[\s\S]{0,400}!ticket\.pending_user_action/,
    'update_ticket dispatch must be gated by `changes.includes("pending_user_action") && oldPending && !ticket.pending_user_action`',
  );
});
