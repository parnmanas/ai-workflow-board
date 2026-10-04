// Regression-grep — ticket 9b44526b (ticket auto-archive).
//
// The archive feature is a soft-delete: archived rows stay in the DB and
// remain reachable through the dedicated archive endpoints, but every
// "active ticket" scan path must filter them out so the dispatcher's queue /
// supervisor and the ticket list stop re-routing completed work to agents.
//
// The reviewer explicitly asked for a regression test guarding the
// supervisor exclusion (see ticket comment 2026-05-25 "Implementation
// guardrails I want preserved"). Static grep is cheap, fast, and survives
// every refactor short of removing the column itself — exactly the right
// shape for "this filter must not silently disappear".
//
// Board removal (docs/tickets.md): the old scan sites (allocation,
// backlog-promotion, agent-workload, trigger-loop, boards.controller,
// stuck-ticket-detector) are gone. Their jobs now live in
// TicketDispatchService (queue, capacity, supervisor) and TicketService
// (list + every create/move, incl. the terminal_entered_at stamp).
//
// Same pattern as workflow-state-cap-guard.test.mjs: strip comments first
// so doc-prose that legitimately mentions "archived_at" doesn't false-
// positive on files that no longer actually filter.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');
}

// (file, human-readable reason the filter must exist there).
const ACTIVE_TICKET_SOURCES = [
  [
    'modules/agents/ticket-dispatch.service.ts',
    'the todo queue, the per-agent capacity count and the supervisor re-send scan must all skip archived tickets — otherwise the dispatcher re-fires triggers for completed work (or counts it against an agent\'s capacity)',
  ],
  [
    'modules/tickets/ticket.service.ts',
    'GET /api/workspaces/:wsId/tickets + MCP list_tickets must exclude archived tickets by default (include_archived / archived_only opt-in only)',
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

// TicketDispatchService.dispatch() is the chokepoint every agent_trigger runs
// through (start, comment, unpend, prerequisite/CI resume, supervisor, manual
// Run). It must refuse an archived ticket itself — a re-wake path that read
// the ticket before a manual archive landed must not slip past. Distinct from
// the candidate-filter check above — the gate is at emit time, the filter is
// at scan time. Both matter.
test('ticket-dispatch.service.ts refuses archived tickets at dispatch time', () => {
  const SOURCE = path.resolve(__dirname, '..', 'src', 'modules', 'agents', 'ticket-dispatch.service.ts');
  const src = fs.readFileSync(SOURCE, 'utf8');
  const code = stripComments(src);
  assert.match(
    code,
    /async\s+dispatch\([^)]*\)[^{]*\{\s*if\s*\(ticket\.archived_at\)\s*return\s*\{\s*dispatched:\s*false,\s*reason:\s*'archived'/,
    'TicketDispatchService.dispatch must open with the archived_at gate so a manual archive that races a re-wake still wins.',
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
});

// TicketService owns every status change (docs/tickets.md), so it is the one
// place that stamps terminal_entered_at — on create (born in done) and on every
// move (stamped entering done, cleared leaving it). The archiver's
// `terminal_entered_at IS NOT NULL` candidate filter silently skips any done
// ticket that missed the stamp, forever. And every mutation path must reject an
// archived ticket (409 ticket_archived) instead of moving it behind the
// operator's back.
const DONE_STAMP = String.raw`terminal_entered_at\s*[:=]\s*(?:status\s*===\s*(?:'done'|DONE_STATUS)|isDoneStatus\(status\))\s*\?\s*new\s+Date\(\)\s*:\s*null`;
test('ticket.service.ts stamps terminal_entered_at on create and move, and rejects archived tickets', () => {
  const SOURCE = path.resolve(__dirname, '..', 'src', 'modules', 'tickets', 'ticket.service.ts');
  const code = stripComments(fs.readFileSync(SOURCE, 'utf8'));
  const body = (name) => {
    const start = code.search(new RegExp(String.raw`\n  async ${name}\(`));
    assert.ok(start !== -1, `TicketService.${name}() not found`);
    const next = code.slice(start + 1).search(/\n  (?:async |private |\/\*\*)/);
    return next === -1 ? code.slice(start) : code.slice(start, start + 1 + next);
  };
  assert.match(
    body('create'), new RegExp(DONE_STAMP),
    'TicketService.create must stamp terminal_entered_at when a ticket is created straight into done — otherwise an operator-created Done ticket never auto-archives',
  );
  const move = body('move');
  assert.match(
    move, new RegExp(DONE_STAMP),
    'TicketService.move must stamp terminal_entered_at entering done and clear it leaving done',
  );
  for (const name of ['update', 'move', 'pend']) {
    assert.match(
      body(name), /if\s*\(ticket\.archived_at\)\s*throw\s+new\s+TicketInputError\([^)]*'ticket_archived'\)/,
      `TicketService.${name} must reject archived tickets with ticket_archived`,
    );
  }
});

// Compound cursor — the archiver stamps every ticket in a per-workspace sweep
// with the same `archived_at`, so a cursor that only carries the timestamp
// would skip the rest of that batch when a page boundary lands inside it.
// MCP list_archived_tickets must order on (archived_at, id) and carry both in
// next_cursor so same-timestamp ties pass through stably. (The REST archive
// view is now `GET /api/workspaces/:wsId/tickets?archived_only=1` — a filter
// on the ticket list, not a cursor-paged endpoint.)
const COMPOUND_CURSOR_SOURCES = [
  [
    'modules/mcp/tools/archive-tools.ts',
    'MCP list_archived_tickets must use a compound (archived_at,id) cursor — otherwise a 500-ticket batch stamped with the same archived_at silently skips the rest of the batch at the page boundary',
  ],
];
for (const [relPath, why] of COMPOUND_CURSOR_SOURCES) {
  test(`${path.basename(relPath)} pages archive with a compound (archived_at, id) cursor`, () => {
    const SOURCE = path.resolve(__dirname, '..', 'src', relPath);
    const src = fs.readFileSync(SOURCE, 'utf8');
    const code = stripComments(src);
    assert.match(
      code, /addOrderBy\(\s*['"]t\.id['"]/,
      `${relPath} must order on t.id as the secondary key. ${why}`,
    );
    assert.match(
      code, /t\.archived_at\s*=\s*:ts\s+AND\s+t\.id\s*<\s*:id/,
      `${relPath} must keep the compound tiebreak predicate (archived_at = :ts AND id < :id). ${why}`,
    );
    assert.match(
      code, /buildArchiveCursor\(/,
      `${relPath} must emit next_cursor via buildArchiveCursor so it carries (archived_at, id). ${why}`,
    );
  });
}

// Tag search — the archive q parameter searches title / id / tags (labels
// became tags with the board removal). Reviewer flagged that title/id-only
// would miss "find every archived ticket tagged `legal`" workflows.
const TAG_SEARCH_SOURCES = [
  [
    'modules/mcp/tools/archive-tools.ts',
    'MCP list_archived_tickets must let q match tags — the contract is documented in the tool description',
  ],
];
for (const [relPath, why] of TAG_SEARCH_SOURCES) {
  test(`${path.basename(relPath)} archive q matches title / id / tag`, () => {
    const SOURCE = path.resolve(__dirname, '..', 'src', relPath);
    const src = fs.readFileSync(SOURCE, 'utf8');
    const code = stripComments(src);
    assert.match(
      code, /LOWER\(t\.tags\)\s+LIKE/,
      `${relPath} must match tags (LOWER(t.tags) LIKE …) in the q clause. ${why}`,
    );
  });
}

// Cursor helpers — `<isoTimestamp>|<id>` round-trips, and the legacy
// bare-timestamp form still parses so older callers keep working.
test('archive cursor helpers round-trip + accept legacy bare-timestamp', async () => {
  // Compiled JS lives in dist/ after `nest build`; fall back gracefully so
  // running this test before the build still surfaces a useful diagnostic
  // (the regression-grep tests above don't depend on dist/).
  const distPath = path.resolve(
    __dirname, '..', 'dist', 'modules', 'mcp', 'shared', 'archive-helpers.js',
  );
  if (!fs.existsSync(distPath)) {
    console.warn('skip: dist/modules/mcp/shared/archive-helpers.js not built — run `nest build` to exercise this');
    return;
  }
  const mod = await import(pathToFileURL(distPath).href);
  const { buildArchiveCursor, parseArchiveCursor } = mod;

  const ts = new Date('2026-05-25T12:34:56.789Z');
  const id = '00000000-0000-0000-0000-aaaaaaaaaaaa';
  const cursor = buildArchiveCursor(ts, id);
  assert.equal(cursor, `${ts.toISOString()}|${id}`);

  const parsed = parseArchiveCursor(cursor);
  assert.ok(parsed.ts, 'compound cursor must parse to a Date');
  assert.equal(parsed.ts.toISOString(), ts.toISOString());
  assert.equal(parsed.id, id);

  // Legacy bare-timestamp cursor (older clients) — id is null so the
  // caller skips the tiebreak rather than treating "" as a uuid.
  const legacy = parseArchiveCursor(ts.toISOString());
  assert.ok(legacy.ts);
  assert.equal(legacy.id, null);

  // Garbage cursor → null timestamp so the controller falls back to "no
  // cursor" instead of throwing.
  assert.deepEqual(parseArchiveCursor('not-a-timestamp'), { ts: null, id: null });
  assert.deepEqual(parseArchiveCursor(undefined), { ts: null, id: null });
  assert.deepEqual(parseArchiveCursor(''), { ts: null, id: null });
});

// Review-bounce guards (2026-05-25). Reviewer flagged surfaces that either
// still scanned/mutated archived tickets or silently leaked them:
//
//   1. Workspace REST + MCP get_workspace (default-exclusion violation)
//   2. Create-directly-in-done missing terminal_entered_at stamp
//
// (The third, StuckTicketDetector, was removed with the board model.)
// Static-grep guards mirror the rest of this file: cheap, fast, and they
// survive every refactor short of removing the column itself.

const REVIEW_BOUNCE_ARCHIVE_FILTER_SOURCES = [
  [
    'modules/workspaces/workspaces.controller.ts',
    'GET /api/workspaces/:id is an active snapshot — archived tickets must not silently inflate its per-status ticket_counts (use the archive filters for archive-inclusive reads)',
  ],
  [
    'modules/mcp/tools/workspace-tools.ts',
    'MCP get_workspace per-status ticket_counts is the same active surface as the REST workspace get — archived rows must not be counted',
  ],
];
for (const [relPath, why] of REVIEW_BOUNCE_ARCHIVE_FILTER_SOURCES) {
  test(`${path.basename(relPath)} filters archived_at (review-bounce guard)`, () => {
    const SOURCE = path.resolve(__dirname, '..', 'src', relPath);
    const src = fs.readFileSync(SOURCE, 'utf8');
    const code = stripComments(src);
    assert.match(
      code,
      /archived_at\s+IS\s+NULL|archived_at:\s*IsNull/,
      `${relPath} must exclude archived tickets. ${why}`,
    );
  });
}

// Stamping terminal_entered_at on create. Every root-ticket create path
// (REST, MCP, the agent-api chat fallbacks) must route through
// TicketService.create — the one place that stamps terminal_entered_at for a
// ticket born in done (guarded above). A surface that hand-writes its own
// Ticket row would skip the stamp, and the archiver's `terminal_entered_at IS
// NOT NULL` candidate filter would then skip the row forever.
const TERMINAL_STAMP_CREATE_SOURCES = [
  [
    'modules/tickets/tickets.controller.ts',
    'POST /api/workspaces/:wsId/tickets must create through TicketService — otherwise an operator-created Done ticket never auto-archives',
  ],
  [
    'modules/mcp/tools/ticket-crud-tools.ts',
    'MCP create_ticket must create through TicketService — same archiver eligibility issue as the REST path',
  ],
  [
    'modules/agent-api/agent-api.controller.ts',
    'the agent-api operational / ordinary-work fallbacks must create through TicketService too — the manager back-door writes the same Ticket row shape',
  ],
];
for (const [relPath, why] of TERMINAL_STAMP_CREATE_SOURCES) {
  test(`${path.basename(relPath)} creates root tickets through TicketService`, () => {
    const SOURCE = path.resolve(__dirname, '..', 'src', relPath);
    const src = fs.readFileSync(SOURCE, 'utf8');
    const code = stripComments(src);
    assert.match(
      code,
      /(?:this\.tickets|ticketService)\.create\(/,
      `${relPath} must create root tickets via TicketService.create. ${why}`,
    );
    assert.doesNotMatch(
      code,
      /terminal_entered_at\s*:/,
      `${relPath} must not hand-write terminal_entered_at into a Ticket row — TicketService owns the stamp. ${why}`,
    );
  });
}

// The archiver itself must keep the per-workspace batch cap (operator
// guardrail — the first tick after enabling auto-archive on a workspace with
// 10k done tickets shouldn't ship 10k writes in one transaction).
test('ticket-archiver.service.ts caps its per-workspace sweep', () => {
  const SOURCE = path.resolve(
    __dirname, '..', 'src', 'modules', 'tickets', 'ticket-archiver.service.ts',
  );
  const src = fs.readFileSync(SOURCE, 'utf8');
  const code = stripComments(src);
  assert.match(
    code,
    /ARCHIVER_BATCH_LIMIT|\.take\(/,
    'ticket-archiver.service.ts must keep a per-workspace batch cap so first-tick activation on a large workspace does not blow up.',
  );
  assert.match(
    code,
    /terminal_entered_at\s+IS\s+NOT\s+NULL/,
    'ticket-archiver candidate query must require terminal_entered_at to be set — otherwise tickets that never went through Done get swept on first tick.',
  );
});

// Dedupe-key release on archive (ticket a565b657) — a ticket manually
// archived while still open (archive_ticket / REST archive) must give up its
// operational_dedupe_key the same way entering done should (see the todo
// guard below). Otherwise outreach-ingest.service.ts's dedupe-winner lookup
// can pick an invisible archived ticket as the "open" ticket for a
// re-processed external item.
const ARCHIVE_DEDUPE_KEY_RELEASE_SOURCES = [
  [
    'modules/mcp/tools/archive-tools.ts',
    'MCP archive_ticket must clear operational_dedupe_key so an archived ticket can never again be picked as an outreach dedupe-key winner',
  ],
  [
    'modules/tickets/tickets.controller.ts',
    'REST POST /tickets/:id/archive must clear operational_dedupe_key too — the human-facing UI archive path mirrors the MCP tool',
  ],
];
for (const [relPath, why] of ARCHIVE_DEDUPE_KEY_RELEASE_SOURCES) {
  test(`${path.basename(relPath)} clears operational_dedupe_key on archive`, () => {
    const SOURCE = path.resolve(__dirname, '..', 'src', relPath);
    const src = fs.readFileSync(SOURCE, 'utf8');
    const code = stripComments(src);
    assert.match(
      code,
      /operational_dedupe_key\s*=\s*null/,
      `${relPath} must clear operational_dedupe_key when archiving a ticket. ${why}`,
    );
  });
}

// Defense in depth: the outreach dedupe-key winner lookup must also exclude
// archived rows directly (legacy data / narrow commit-ordering races where
// the clear above didn't happen) — ticket a565b657.
test('outreach-ingest.service.ts excludes archived tickets from the dedupe-key winner lookup', () => {
  const SOURCE = path.resolve(
    __dirname, '..', 'src', 'modules', 'outreach', 'outreach-ingest.service.ts',
  );
  const src = fs.readFileSync(SOURCE, 'utf8');
  const code = stripComments(src);
  assert.match(
    code,
    /operational_dedupe_key:\s*dedupeKey,\s*archived_at:\s*IsNull\(\)/,
    'the dedupe-key collision winner lookup must filter archived_at: IsNull() — otherwise an archived ticket can be selected as the winner and silently absorb new feedback.',
  );
});

// Entering done releases operational_dedupe_key, so a finished capability /
// ordinary-work ticket stops absorbing later requests for the same key.
// Behavioural twin: operational-capability-ticket.test.mjs.
test('ticket.service.ts move releases operational_dedupe_key on entering done', () => {
  const SOURCE = path.resolve(__dirname, '..', 'src', 'modules', 'tickets', 'ticket.service.ts');
  const code = stripComments(fs.readFileSync(SOURCE, 'utf8'));
  const start = code.search(/\n  async move\(/);
  const end = code.slice(start + 1).search(/\n  (?:async |private |\/\*\*)/);
  const move = code.slice(start, start + 1 + end);
  assert.match(
    move,
    /operational_dedupe_key\s*[:=]\s*null/,
    'TicketService.move must clear operational_dedupe_key when the ticket enters done.',
  );
});
