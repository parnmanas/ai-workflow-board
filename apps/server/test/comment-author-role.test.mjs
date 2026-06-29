// Unit test — `resolveAuthorRole` / `mergeAuthorRoleIntoMetadata` (ticket ed07eeeb).
//
// These two helpers decide which role an agent-authored comment is stamped
// with (metadata.author_role). The QA scenario that used to cover this
// (`70633b58`) only exercises the #1 caller-override path, because the
// awb-mcp QA driver is a chat subagent and can NEVER carry an
// `X-AWB-Subagent-Role` session pin — so the **#2 pin auto-fill path that
// operational assignee/reviewer subagents actually ride** had zero automated
// coverage. The regression that spawned this ticket lived precisely on #2.
//
// We pin all four documented resolution branches here so a future refactor
// can't silently drop the auto-fill (which would make every agent comment
// lose its role badge again):
//   #1 caller `author_role` explicit            → used verbatim
//   #2 session pin (X-AWB-Subagent-Role) present → pin role auto-filled  ← KEY
//   #3 single unambiguous TicketRoleAssignment   → that role auto-filled
//   #3 multi-role holder, no pin, no caller      → null (omit the badge)
//
// Imports the compiled module from dist/ (built by `npm run build`).

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(__dirname, '..', 'dist', 'modules', 'mcp', 'tools', 'author-role.js');

const { resolveAuthorRole, mergeAuthorRoleIntoMetadata } = await import('file://' + DIST);

const TICKET = 'ticket-1';
const AGENT = 'agent-1';

// A resolver stub modelling TicketRoleAssignmentService.resolveForTicket.
// `rows` is the resolved-assignment list; `throws` simulates a DB blow-up.
function makeResolver(rows, { throws = false } = {}) {
  return {
    calls: 0,
    async resolveForTicket(ticketId) {
      this.calls++;
      assert.equal(ticketId, TICKET, 'resolver should be queried for the comment ticket');
      if (throws) throw new Error('boom');
      return rows;
    },
  };
}

const assignment = (slug, holderId, holderType = 'agent') => ({
  holder: holderId ? { type: holderType, id: holderId } : null,
  role: { slug },
});

// ─── #1 caller override ──────────────────────────────────────────────
test('#1 explicit caller author_role wins and short-circuits (no resolver call)', async () => {
  // A resolver that would return a DIFFERENT role proves #1 short-circuits.
  const resolver = makeResolver([assignment('reviewer', AGENT)]);
  const role = await resolveAuthorRole(resolver, TICKET, 'assignee', 'agent', AGENT, undefined, undefined);
  assert.equal(role, 'assignee');
  assert.equal(resolver.calls, 0, 'explicit override must not hit the assignment resolver');
});

test('#1 explicit author_role is trimmed + lower-cased', async () => {
  const role = await resolveAuthorRole(makeResolver([]), TICKET, '  ReVIEWER  ', 'agent', AGENT, undefined, undefined);
  assert.equal(role, 'reviewer');
});

test('#1 even a user author may carry an explicit role', async () => {
  const role = await resolveAuthorRole(makeResolver([]), TICKET, 'reporter', 'user', 'user-1', undefined, undefined);
  assert.equal(role, 'reporter');
});

// ─── #2 session pin (THE key previously-uncovered path) ──────────────
test('#2 session pin auto-fills when caller omits author_role', async () => {
  // Resolver returns a DIFFERENT (ambiguous) shape — if #2 didn't fire we'd
  // get null. The pin must win.
  const resolver = makeResolver([assignment('assignee', AGENT), assignment('reviewer', AGENT)]);
  const role = await resolveAuthorRole(resolver, TICKET, undefined, 'agent', AGENT, 'reviewer', TICKET);
  assert.equal(role, 'reviewer', 'pinned role must auto-fill the badge');
  assert.equal(resolver.calls, 0, 'pin short-circuits before the resolver');
});

test('#2 pin is ignored when it belongs to a DIFFERENT ticket (falls through to #3)', async () => {
  const resolver = makeResolver([assignment('assignee', AGENT)]);
  const role = await resolveAuthorRole(resolver, TICKET, undefined, 'agent', AGENT, 'reviewer', 'other-ticket');
  assert.equal(role, 'assignee', 'stale cross-ticket pin must not leak; #3 single-role wins');
  assert.equal(resolver.calls, 1);
});

test('#2 pin does not apply to non-agent authors', async () => {
  const role = await resolveAuthorRole(makeResolver([]), TICKET, undefined, 'user', 'user-1', 'reviewer', TICKET);
  assert.equal(role, null, 'a human author never gets a subagent pin badge');
});

// ─── #3 TicketRoleAssignment fallback ────────────────────────────────
test('#3 single unambiguous assignment auto-fills', async () => {
  const resolver = makeResolver([assignment('assignee', AGENT)]);
  const role = await resolveAuthorRole(resolver, TICKET, undefined, 'agent', AGENT, undefined, undefined);
  assert.equal(role, 'assignee');
});

test('#3 multi-role holder with no pin returns null (omit badge, no over-attribution)', async () => {
  const resolver = makeResolver([assignment('assignee', AGENT), assignment('reviewer', AGENT)]);
  const role = await resolveAuthorRole(resolver, TICKET, undefined, 'agent', AGENT, undefined, undefined);
  assert.equal(role, null, 'ambiguous multi-role + no pin must NOT stamp every role');
});

test('#3 agent holds no role on the ticket returns null', async () => {
  const resolver = makeResolver([assignment('assignee', 'someone-else')]);
  const role = await resolveAuthorRole(resolver, TICKET, undefined, 'agent', AGENT, undefined, undefined);
  assert.equal(role, null);
});

test('#3 only the calling agent\'s holdings count (other holders ignored)', async () => {
  // Agent holds exactly one role; a different agent holds the other → still
  // unambiguous for the caller.
  const resolver = makeResolver([assignment('assignee', AGENT), assignment('reviewer', 'agent-2')]);
  const role = await resolveAuthorRole(resolver, TICKET, undefined, 'agent', AGENT, undefined, undefined);
  assert.equal(role, 'assignee');
});

test('#3 resolver throwing degrades to null (never fails the comment write)', async () => {
  const resolver = makeResolver([], { throws: true });
  const role = await resolveAuthorRole(resolver, TICKET, undefined, 'agent', AGENT, undefined, undefined);
  assert.equal(role, null);
});

test('#3 absent resolver service degrades to null', async () => {
  assert.equal(await resolveAuthorRole(null, TICKET, undefined, 'agent', AGENT, undefined, undefined), null);
  assert.equal(await resolveAuthorRole(undefined, TICKET, undefined, 'agent', AGENT, undefined, undefined), null);
});

// ─── mergeAuthorRoleIntoMetadata ─────────────────────────────────────
test('merge: null role leaves metadata untouched (no empty badge written)', () => {
  assert.deepEqual(mergeAuthorRoleIntoMetadata(undefined, null), {});
  assert.deepEqual(mergeAuthorRoleIntoMetadata({ references: ['c1'] }, null), { references: ['c1'] });
});

test('merge: resolved role is written onto a fresh bag', () => {
  assert.deepEqual(mergeAuthorRoleIntoMetadata(undefined, 'assignee'), { author_role: 'assignee' });
});

test('merge: resolved role does NOT clobber a caller-set author_role', () => {
  assert.deepEqual(
    mergeAuthorRoleIntoMetadata({ author_role: 'reviewer' }, 'assignee'),
    { author_role: 'reviewer' },
  );
});

test('merge: preserves sibling metadata keys and does not mutate the input', () => {
  const input = { references: ['c1'], target_agent_id: 'a2' };
  const out = mergeAuthorRoleIntoMetadata(input, 'assignee');
  assert.deepEqual(out, { references: ['c1'], target_agent_id: 'a2', author_role: 'assignee' });
  assert.deepEqual(input, { references: ['c1'], target_agent_id: 'a2' }, 'input bag must not be mutated');
});
