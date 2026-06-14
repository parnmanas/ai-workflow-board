// Regression-grep — ticket ad0eb567 (terminal-reopen guard).
//
// move_ticket must refuse to drag a ticket OUT of a terminal column (Done)
// back into a non-terminal one unless an explicit force flag is passed. The
// stale-strand reopen race this prevents was recorded on tickets e163c952 and
// 9f507f5c. The behavioural proof lives in qa-flows/terminal-reopen-guard.
// This static check is the cheap, refactor-surviving guard that the gate stays
// wired into every automated move surface — a future refactor that drops the
// `isTerminalReopen` call would silently re-open the race.
//
// Same shape as archive-exclusion-guard.test.mjs: strip comments first so the
// doc-prose that legitimately names the helper doesn't false-positive on a
// file that no longer actually calls it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');
}

function code(relPath) {
  const SOURCE = path.resolve(__dirname, '..', 'src', relPath);
  return stripComments(fs.readFileSync(SOURCE, 'utf8'));
}

test('archive-helpers exports isTerminalReopen + TerminalReopenError', () => {
  const src = code('modules/mcp/shared/archive-helpers.ts');
  assert.match(src, /export function isTerminalReopen\b/, 'isTerminalReopen helper must exist');
  assert.match(src, /export class TerminalReopenError\b/, 'TerminalReopenError must exist');
  // The helper must gate on OUT-of-terminal specifically: terminal source AND
  // non-terminal dest. A refactor that drops the negation would block forward
  // moves into Done too.
  assert.match(
    src,
    /isTerminalColumn\(sourceColumn\)\s*&&\s*!isTerminalColumn\(destColumn\)/,
    'isTerminalReopen must be terminal-source AND non-terminal-dest',
  );
});

// Every AUTOMATED move surface must call the guard. The human REST drag path
// (tickets.controller PATCH /tickets/:id/move) is intentionally NOT here — a
// person dragging a Done card back is a deliberate reopen, not a stale strand.
const GUARDED_MOVE_SOURCES = [
  [
    'modules/mcp/tools/ticket-workflow-tools.ts',
    'MCP move_ticket — the tool the concurrent role-strands actually call',
  ],
  [
    'modules/agent-api/agent-api.controller.ts',
    'legacy agent-api move-ticket (single + batch) — automated callers too',
  ],
];

for (const [relPath, why] of GUARDED_MOVE_SOURCES) {
  test(`${path.basename(relPath)} calls isTerminalReopen before moving`, () => {
    const src = code(relPath);
    assert.match(
      src,
      /isTerminalReopen\(/,
      `${relPath} must invoke the terminal-reopen guard. ${why}`,
    );
    // The guard must be bypassable only via an explicit force flag — assert the
    // call is gated on a force check so a refactor can't make it unconditional
    // (which would block legitimate forced reopens) or drop the override.
    assert.match(
      src,
      /!\s*(force|op\.force)\s*&&\s*isTerminalReopen\(/,
      `${relPath} must gate isTerminalReopen behind a force override`,
    );
  });
}

// The batch surface is a known backdoor risk — it loops move-ticket ops in one
// transaction. Make sure its move-ticket branch carries the guard too, not
// just the single-shot handler.
test('agent-api batch move-ticket guards op.force', () => {
  const src = code('modules/agent-api/agent-api.controller.ts');
  assert.match(src, /!op\.force\s*&&\s*isTerminalReopen\(/, 'batch move-ticket must honor op.force terminal-reopen guard');
});
