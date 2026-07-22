// Parity guard — F-1 (ticket 24694916), reviewer's standing recommendation.
//
// Across three review rounds the recurring defect was a SILENT GAP: a server MCP
// tool that mutates a ticket (update_child_ticket, then batch_operations, then
// ask_question / record_decision / reject_handoff) was missing from the capture
// allowlist, so its card was dropped without any signal. Manually chasing the list
// never converges.
//
// This test closes the loop mechanically: it enumerates EVERY tool the server
// registers (`server.tool('<name>', …)` across apps/server/src/modules/mcp/tools/
// *-tools.ts — the exact files the convention loader in tools/index.ts discovers)
// and asserts each one is classified EXACTLY once in ticket-ref-capture:
//   EMIT     — TICKET_ACTION_TOOLS
//   BATCH    — BATCH_TICKET_TOOL
//   REJECT   — REJECT_HANDOFF_TOOL
//   ARTIFACT — ARTIFACT_ACTION_TOOLS (F2-4 ⓒ 결과물 카드; EXCLUDE 아님)
//   EXCLUDE  — TICKET_TOOL_EXCLUSIONS (with a per-tool reason)
// A newly-added server tool therefore fails THIS test until someone decides whether
// it emits a card or is deliberately excluded — the silent gap can no longer recur.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  TICKET_ACTION_TOOLS,
  BATCH_TICKET_TOOL,
  REJECT_HANDOFF_TOOL,
  ARTIFACT_ACTION_TOOLS,
  AGENT_ACTION_TOOLS,
  BOARD_ACTION_TOOLS,
  TICKET_TOOL_EXCLUSIONS,
  classifiedToolNames,
} from '../dist/lib/ticket-ref-capture.js';

const HERE = dirname(fileURLToPath(import.meta.url));
// apps/agent-manager/test → apps/server/src/modules/mcp/tools
const SERVER_TOOLS_DIR = join(HERE, '..', '..', 'server', 'src', 'modules', 'mcp', 'tools');

/** Scan the server's tool files for every `server.tool('<name>', …)` registration.
 *  The name literal sits on the line AFTER `server.tool(`, so the regex spans
 *  whitespace/newlines (JS `\s` matches `\n`). Mirrors the loader's *-tools.{ts,js}
 *  convention (index.ts / *.d.ts carry no registrations). */
function scanRegisteredTools() {
  assert.ok(existsSync(SERVER_TOOLS_DIR), `server MCP tools dir not found: ${SERVER_TOOLS_DIR}`);
  const files = readdirSync(SERVER_TOOLS_DIR).filter((f) => /-tools\.ts$/.test(f) && !f.endsWith('.d.ts'));
  assert.ok(files.length >= 5, `expected several *-tools.ts files, found ${files.length}`);
  const names = new Set();
  const re = /server\.tool\(\s*['"]([a-z0-9_]+)['"]/g;
  for (const f of files) {
    const src = readFileSync(join(SERVER_TOOLS_DIR, f), 'utf8');
    let m;
    while ((m = re.exec(src)) !== null) names.add(m[1]);
  }
  return names;
}

test('classification buckets are disjoint (no tool classified twice)', () => {
  const emit = Object.keys(TICKET_ACTION_TOOLS);
  const exclude = Object.keys(TICKET_TOOL_EXCLUSIONS);
  const seen = new Map(); // name → bucket
  const put = (name, bucket) => {
    assert.ok(!seen.has(name), `"${name}" classified in both ${seen.get(name)} and ${bucket}`);
    seen.set(name, bucket);
  };
  for (const n of emit) put(n, 'emit');
  put(BATCH_TICKET_TOOL, 'batch');
  put(REJECT_HANDOFF_TOOL, 'reject');
  for (const n of Object.keys(ARTIFACT_ACTION_TOOLS)) put(n, 'artifact');
  for (const n of Object.keys(AGENT_ACTION_TOOLS)) put(n, 'agent');
  for (const n of Object.keys(BOARD_ACTION_TOOLS)) put(n, 'board');
  for (const n of exclude) put(n, 'exclude');
  // classifiedToolNames() must equal the union with no dupes swallowed.
  assert.equal(classifiedToolNames().size, seen.size, 'classifiedToolNames drops or dupes a bucket');
});

test('every registered server MCP tool is classified (no silent capture gap)', () => {
  const registered = scanRegisteredTools();
  // Floor guard: a broken scan (0–few names) must fail loudly, not falsely pass.
  assert.ok(registered.size >= 150, `scan found only ${registered.size} tools — regex/loader drift?`);

  const classified = classifiedToolNames();

  // (A) No UNCLASSIFIED tool — the silent-gap direction the reviewer flagged.
  const unclassified = [...registered].filter((n) => !classified.has(n)).sort();
  assert.deepEqual(
    unclassified, [],
    `Unclassified MCP tool(s) — a card would be silently dropped. Classify each in ` +
    `apps/agent-manager/src/lib/ticket-ref-capture.ts as an EMIT (TICKET_ACTION_TOOLS) ` +
    `or an EXCLUDE (TICKET_TOOL_EXCLUSIONS, with a reason): ${unclassified.join(', ')}`,
  );

  // (B) No STALE classification — a renamed/removed tool left behind in the table.
  const stale = [...classified].filter((n) => !registered.has(n)).sort();
  assert.deepEqual(
    stale, [],
    `Stale entries in ticket-ref-capture no longer registered on the server ` +
    `(remove them): ${stale.join(', ')}`,
  );
});

test('the emit surface actually contains the ticket-mutation tools reviewers flagged', () => {
  // Regression floor: the specific omissions caught across the three review rounds
  // must stay emitters (this test fails if a refactor drops them from the map).
  for (const t of [
    'update_child_ticket', 'batch_operations', 'ask_question', 'answer_question',
    'record_decision', 'reject_handoff', 'add_ticket_prerequisites', 'handoff_to_agent',
    'propose_move', 'record_agreement',
  ]) {
    const classified = classifiedToolNames();
    assert.ok(classified.has(t), `${t} must be classified`);
    assert.ok(
      !TICKET_TOOL_EXCLUSIONS[t],
      `${t} is a ticket mutation — it must EMIT a card, not be excluded`,
    );
  }
});
