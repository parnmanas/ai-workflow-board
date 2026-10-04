// Unit test — `resolveAuthorRole` / `mergeAuthorRoleIntoMetadata` (ticket ed07eeeb).
//
// These two helpers decide which role an agent-authored comment is stamped
// with (metadata.author_role). The QA scenario that used to cover this
// (`70633b58`) only exercises the #1 caller-override path, because the
// awb-mcp QA driver is a chat subagent and can NEVER carry an
// `X-AWB-Subagent-Role` session pin — so the **#2 pin auto-fill path that
// operational subagents actually ride** had zero automated coverage. The
// regression that spawned this ticket lived precisely on #2.
//
// A ticket has exactly one agent now — its assignee (RuntimeSpec, identified
// by `assignee_key`) — so the old TicketRoleAssignment fallback collapsed to
// "the author IS the ticket's assignee identity". We pin all documented
// resolution branches so a future refactor can't silently drop the auto-fill
// (which would make every agent comment lose its role badge again):
//   #1 caller `author_role` explicit              → used verbatim
//   #2 session pin (X-AWB-Subagent-Role) present   → pin role auto-filled  ← KEY
//   #3 author identity == ticket.assignee_key      → 'assignee'
//   #3 author is not the assignee / no assignee    → null (omit the badge)
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

// The ticket shape comment-tools hands in (`select: ['id', 'assignee_key']`).
const ticket = (assigneeKey = '') => ({ id: TICKET, assignee_key: assigneeKey });

// ─── #1 caller override ──────────────────────────────────────────────
test('#1 explicit caller author_role wins over the assignee match', () => {
  // The caller IS the assignee, so #3 would say 'assignee' — #1 must win.
  const role = resolveAuthorRole(ticket(AGENT), 'reviewer', 'agent', AGENT, undefined, undefined);
  assert.equal(role, 'reviewer');
});

test('#1 explicit author_role is trimmed + lower-cased', () => {
  const role = resolveAuthorRole(ticket(), '  ReVIEWER  ', 'agent', AGENT, undefined, undefined);
  assert.equal(role, 'reviewer');
});

test('#1 even a user author may carry an explicit role', () => {
  const role = resolveAuthorRole(ticket(), 'reporter', 'user', 'user-1', undefined, undefined);
  assert.equal(role, 'reporter');
});

// ─── #2 session pin (THE key previously-uncovered path) ──────────────
test('#2 session pin auto-fills when caller omits author_role', () => {
  // The author is also the assignee — if #2 didn't fire we'd get 'assignee'.
  // The pin must win.
  const role = resolveAuthorRole(ticket(AGENT), undefined, 'agent', AGENT, 'reviewer', TICKET);
  assert.equal(role, 'reviewer', 'pinned role must auto-fill the badge');
});

test('#2 pin is ignored when it belongs to a DIFFERENT ticket (falls through to #3)', () => {
  const role = resolveAuthorRole(ticket(AGENT), undefined, 'agent', AGENT, 'reviewer', 'other-ticket');
  assert.equal(role, 'assignee', 'stale cross-ticket pin must not leak; #3 assignee match wins');
});

test('#2 pin does not apply to non-agent authors', () => {
  const role = resolveAuthorRole(ticket(), undefined, 'user', 'user-1', 'reviewer', TICKET);
  assert.equal(role, null, 'a human author never gets a subagent pin badge');
});

// ─── #3 assignee identity fallback ───────────────────────────────────
test('#3 the ticket\'s assignee identity auto-fills `assignee`', () => {
  const role = resolveAuthorRole(ticket(AGENT), undefined, 'agent', AGENT, undefined, undefined);
  assert.equal(role, 'assignee');
});

test('#3 an agent that is not the assignee returns null (no over-attribution)', () => {
  const role = resolveAuthorRole(ticket('someone-else'), undefined, 'agent', AGENT, undefined, undefined);
  assert.equal(role, null);
});

test('#3 an unassigned ticket (empty / missing assignee_key) returns null', () => {
  assert.equal(resolveAuthorRole(ticket(''), undefined, 'agent', AGENT, undefined, undefined), null);
  // comment-tools falls back to `{ id }` when the ticket row is gone.
  assert.equal(resolveAuthorRole({ id: TICKET }, undefined, 'agent', AGENT, undefined, undefined), null);
});

test('#3 an empty author id never matches an empty assignee_key', () => {
  assert.equal(resolveAuthorRole(ticket(''), undefined, 'agent', '', undefined, undefined), null);
});

test('#3 a user author matching the assignee_key text still gets no badge', () => {
  assert.equal(resolveAuthorRole(ticket(AGENT), undefined, 'user', AGENT, undefined, undefined), null);
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
