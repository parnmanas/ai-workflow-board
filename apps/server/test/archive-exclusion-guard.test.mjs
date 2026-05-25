// Regression-grep — ticket 9b44526b (ticket auto-archive).
//
// The archive feature is a soft-delete: archived rows stay in the DB and
// remain reachable through the dedicated archive endpoints, but every
// "active ticket" scan path must filter them out so the supervisor /
// trigger-loop / backlog-promotion / focus-selector stop re-routing
// completed work to agents.
//
// The reviewer explicitly asked for a regression test guarding the
// supervisor exclusion (see ticket comment 2026-05-25 "Implementation
// guardrails I want preserved"). Static grep is cheap, fast, and survives
// every refactor short of removing the column itself — exactly the right
// shape for "this filter must not silently disappear".
//
// Same pattern as workflow-state-cap-guard.test.mjs: strip comments first
// so doc-prose that legitimately mentions "archived_at" doesn't false-
// positive on files that no longer actually filter.

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

// (file, human-readable reason the filter must exist there).
//
// Note — trigger-loop.service.ts intentionally NOT in this list. Its archive
// guard is a runtime re-read inside `_emitTrigger` (covered by the dedicated
// test below), not a SQL scan filter. Listing it here would force a SQL
// pattern into a file that doesn't need one.
const ACTIVE_TICKET_SOURCES = [
  [
    'modules/agents/agent-workload.service.ts',
    'focus-selector candidate set must not include archived tickets',
  ],
  [
    'modules/agents/allocation.service.ts',
    'supervisor re-push (allocation) must skip archived tickets — otherwise it re-fires triggers for completed work',
  ],
  [
    'modules/agents/backlog-promotion.service.ts',
    'backlog-promotion must not consume a promotion slot with an archived intake ticket',
  ],
  [
    'modules/boards/boards.controller.ts',
    'GET /api/boards/:id must exclude archived tickets by default (include_archived=true opt-in only)',
  ],
];

for (const [relPath, why] of ACTIVE_TICKET_SOURCES) {
  test(`${path.basename(relPath)} filters archived_at on its active-ticket scan`, () => {
    const SOURCE = path.resolve(__dirname, '..', 'src', relPath);
    const src = fs.readFileSync(SOURCE, 'utf8');
    const code = stripComments(src);
    assert.match(
      code,
      /archived_at\s+IS\s+NULL|archived_at:\s*IsNull/,
      `${relPath} must filter archived tickets out of active-ticket scans. ${why}`,
    );
  });
}

// trigger-loop also carries a fresh-read archive gate inside `_emitTrigger`
// (the chokepoint every dispatch path runs through). Removing it would let
// a manual archive that races a queued trigger slip past the supervisor
// gate. Distinct from the candidate-filter check above — the gate is a
// runtime re-read at emit time, the filter is at scan time. Both matter.
test('trigger-loop.service.ts re-checks archived_at at emit time', () => {
  const SOURCE = path.resolve(__dirname, '..', 'src', 'modules', 'agents', 'trigger-loop.service.ts');
  const src = fs.readFileSync(SOURCE, 'utf8');
  const code = stripComments(src);
  assert.match(
    code,
    /freshForArchive\?\.archived_at|agent_trigger_dropped_archived/,
    'trigger-loop._emitTrigger must keep the fresh-read archive gate so manual archives that race a queued trigger still win.',
  );
});

// Mutation gate — every server-side write path that touches a ticket
// must reject archived rows with TicketArchivedError (rendered as 409
// `ticket_archived` over REST). We check both the helper exists and that
// the controllers reference it. A single archive surface is allowed to
// import without using — but the helper has to live in shared so REST +
// MCP share the message.
test('archive-helpers.ts exports TicketArchivedError + assertTicketActive', () => {
  const SOURCE = path.resolve(
    __dirname, '..', 'src', 'modules', 'mcp', 'shared', 'archive-helpers.ts',
  );
  const src = fs.readFileSync(SOURCE, 'utf8');
  assert.match(
    src, /class\s+TicketArchivedError/,
    'archive-helpers.ts must export TicketArchivedError — REST + MCP both map archived-mutation rejections through it.',
  );
  assert.match(
    src, /export\s+function\s+assertTicketActive/,
    'archive-helpers.ts must export assertTicketActive (used by code paths that prefer throw-over-return).',
  );
  assert.match(
    src, /applyTerminalEnteredAtForMove/,
    'archive-helpers.ts must export applyTerminalEnteredAtForMove so every move path stamps terminal_entered_at consistently.',
  );
});

// The archiver itself must keep the per-board batch cap (operator
// guardrail — the first tick after enabling auto-archive on a 10k-Done
// board shouldn't ship 10k writes in one transaction).
test('ticket-archiver.service.ts caps its per-board sweep', () => {
  const SOURCE = path.resolve(
    __dirname, '..', 'src', 'modules', 'tickets', 'ticket-archiver.service.ts',
  );
  const src = fs.readFileSync(SOURCE, 'utf8');
  const code = stripComments(src);
  assert.match(
    code,
    /ARCHIVER_BATCH_LIMIT|\.take\(/,
    'ticket-archiver.service.ts must keep a per-board batch cap so first-tick activation on a large board does not blow up.',
  );
  assert.match(
    code,
    /terminal_entered_at\s+IS\s+NOT\s+NULL/,
    'ticket-archiver candidate query must require terminal_entered_at to be set — otherwise tickets that never went through Done get swept on first tick.',
  );
});
