// Dispatch-preflight pure-helper tests (ticket a3047a86).
//
// These cover the decision layer that stops a doomed trigger BEFORE a subagent
// is spawned, without driving the whole dispatcher:
//   - classifyWorktreeOutcome: empty/non-repo (`not_a_git_repo`) and foreign
//     occupied checkout (`path_conflict`) are blockers before dispatch;
//   - isGitAuthFailure / decidePushReadiness: a missing push credential is a
//     blocker, a transient network error is not (fail open);
//   - DispatchBlockerTracker: the SAME blocker is not re-commented on every
//     re-trigger, a DIFFERENT blocker is, and recovery (clear) re-arms.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  isGitAuthFailure,
  decidePushReadiness,
  classifyWorktreeOutcome,
  classifyWorktreeCheckout,
  normalizeRemoteUrl,
  redactRemoteUrl,
  DispatchBlockerTracker,
  RoleSpawnSuppressor,
  firstLine,
} from '../dist/lib/dispatch-preflight.js';

// ── isGitAuthFailure ────────────────────────────────────────────────────────

test('isGitAuthFailure: the exact ticket 8436f96f push failure is an auth blocker', () => {
  // This is the verbatim stderr git printed when Merging died twice.
  const stderr = "fatal: could not read Username for 'https://github.com': No such device or address";
  assert.equal(isGitAuthFailure(stderr), true);
});

test('isGitAuthFailure: recognises the common auth/authorization rejections', () => {
  for (const s of [
    'remote: Support for password authentication was removed.',
    'fatal: Authentication failed for https://github.com/x/y.git',
    "remote: Permission to x/y.git denied to bot.",
    'fatal: unauthorized',
    'remote: Invalid username or password',
    'error: 403 Forbidden',
    'remote: Repository not found.',
    'fatal: could not read Password for https://github.com',
  ]) {
    assert.equal(isGitAuthFailure(s), true, `should classify as auth failure: ${s}`);
  }
});

test('isGitAuthFailure: transient/connectivity errors are NOT auth blockers (fail open)', () => {
  for (const s of [
    'fatal: unable to access ...: Could not resolve host: github.com',
    'ssh: connect to host github.com port 22: Connection timed out',
    'fatal: unable to access ...: Failed to connect to github.com port 443: Connection refused',
    'error: RPC failed; curl 56 Recv failure',
    '',
    undefined,
    null,
  ]) {
    assert.equal(isGitAuthFailure(s), false, `should NOT classify as auth failure: ${String(s)}`);
  }
});

// ── decidePushReadiness ─────────────────────────────────────────────────────

test('decidePushReadiness: non-https remote → ready (key/local auth, not this failure mode)', () => {
  assert.deepEqual(decidePushReadiness({ isHttps: false }), { ok: true });
});

test('decidePushReadiness: probe not run → ready (do not wedge on inability to verify)', () => {
  assert.deepEqual(decidePushReadiness({ isHttps: true }), { ok: true });
  assert.deepEqual(decidePushReadiness({ isHttps: true, probe: { ran: false } }), { ok: true });
});

test('decidePushReadiness: probe succeeds (valid token or anonymous) → ready', () => {
  assert.deepEqual(
    decidePushReadiness({ isHttps: true, probe: { ran: true, ok: true } }),
    { ok: true },
  );
});

test('decidePushReadiness: probe auth-fails → BLOCK before dispatch', () => {
  const d = decidePushReadiness({
    isHttps: true,
    probe: {
      ran: true,
      ok: false,
      stderr: "fatal: could not read Username for 'https://github.com': No such device or address",
    },
  });
  assert.equal(d.ok, false);
  assert.equal(d.reason, 'push_credential_unavailable');
  assert.match(d.detail, /could not read Username/);
});

test('decidePushReadiness: probe fails on a transient error → ready (fail open)', () => {
  const d = decidePushReadiness({
    isHttps: true,
    probe: { ran: true, ok: false, stderr: 'fatal: unable to access: Could not resolve host: github.com' },
  });
  assert.deepEqual(d, { ok: true });
});

// ── classifyWorktreeOutcome (criterion #1: block before dispatch) ────────────

test('classifyWorktreeOutcome: a real worktree is not blocked', () => {
  assert.deepEqual(classifyWorktreeOutcome({ isWorktree: true, reason: undefined }), { blocked: false });
});

test('classifyWorktreeOutcome: empty/non-repo working_dir (not_a_git_repo) is blocked before dispatch', () => {
  assert.deepEqual(classifyWorktreeOutcome({ isWorktree: false, reason: 'not_a_git_repo' }), {
    blocked: true,
    kind: 'worktree:not_a_git_repo',
    reason: 'not_a_git_repo',
  });
});

test('classifyWorktreeOutcome: a foreign/occupied checkout (path_conflict) is blocked before dispatch', () => {
  // In the per-ticket worktree model this is how "another ticket's dirty
  // working folder" surfaces: a directory sits at the ticket's worktree path
  // that isn't a registered worktree, so the manager refuses to clobber it.
  assert.deepEqual(classifyWorktreeOutcome({ isWorktree: false, reason: 'path_conflict' }), {
    blocked: true,
    kind: 'worktree:path_conflict',
    reason: 'path_conflict',
  });
});

test('classifyWorktreeOutcome: disabled isolation remains blocked', () => {
  assert.deepEqual(classifyWorktreeOutcome({ isWorktree: false, reason: 'disabled' }), {
    blocked: true, kind: 'worktree:disabled', reason: 'disabled',
  });
});

test('classifyWorktreeOutcome: missing/empty result is blocked', () => {
  const blocked = { blocked: true, kind: 'worktree:unavailable', reason: 'unavailable' };
  assert.deepEqual(classifyWorktreeOutcome({ isWorktree: false }), blocked);
  assert.deepEqual(classifyWorktreeOutcome(null), blocked);
  assert.deepEqual(classifyWorktreeOutcome(undefined), blocked);
});

// ── DispatchBlockerTracker (criterion #3: suppress dup, retry after recovery) ─

test('DispatchBlockerTracker: same blocker comments once, repeats are suppressed', () => {
  const t = new DispatchBlockerTracker();
  const ticket = 'ticket-1';
  assert.equal(t.shouldComment(ticket, 'worktree:not_a_git_repo'), true, 'first occurrence posts');
  assert.equal(t.shouldComment(ticket, 'worktree:not_a_git_repo'), false, 'repeat suppressed');
  assert.equal(t.shouldComment(ticket, 'worktree:not_a_git_repo'), false, 'still suppressed');
  assert.equal(t.activeKind(ticket), 'worktree:not_a_git_repo');
});

test('DispatchBlockerTracker: a DIFFERENT blocker posts again', () => {
  const t = new DispatchBlockerTracker();
  const ticket = 'ticket-2';
  assert.equal(t.shouldComment(ticket, 'worktree:not_a_git_repo'), true);
  assert.equal(t.shouldComment(ticket, 'push_credential_unavailable'), true, 'kind changed → post');
  assert.equal(t.shouldComment(ticket, 'push_credential_unavailable'), false, 'now repeats suppress');
});

test('DispatchBlockerTracker: clear() re-arms so recovery→re-break posts fresh and retries', () => {
  const t = new DispatchBlockerTracker();
  const ticket = 'ticket-3';
  assert.equal(t.shouldComment(ticket, 'push_credential_unavailable'), true);
  assert.equal(t.shouldComment(ticket, 'push_credential_unavailable'), false);
  t.clear(ticket); // dispatch recovered (preflight went green)
  assert.equal(t.activeKind(ticket), undefined, 'cleared');
  assert.equal(t.shouldComment(ticket, 'push_credential_unavailable'), true, 'post-recovery break posts fresh');
});

test('DispatchBlockerTracker: tickets are independent; missing id never suppresses', () => {
  const t = new DispatchBlockerTracker();
  assert.equal(t.shouldComment('a', 'k'), true);
  assert.equal(t.shouldComment('b', 'k'), true, 'different ticket, same kind → posts');
  assert.equal(t.shouldComment('a', 'k'), false);
  assert.equal(t.shouldComment(undefined, 'k'), true, 'no ticket id → never suppress');
  assert.equal(t.shouldComment('', 'k'), true, 'empty ticket id → never suppress');
  t.clear(undefined); // no-op, must not throw
});

// ── firstLine ───────────────────────────────────────────────────────────────

test('firstLine: returns the first non-empty trimmed line', () => {
  assert.equal(firstLine('\n\n  fatal: boom  \nsecond line\n'), 'fatal: boom');
  assert.equal(firstLine('single'), 'single');
  assert.equal(firstLine(''), '');
  assert.equal(firstLine(undefined), '');
  assert.equal(firstLine(null), '');
});

// ── classifyWorktreeCheckout (ticket feaa7ab0, completion criterion #1/#4) ────
// The three named regression cases: wrong path (not a git repo), incomplete
// checkout, and a valid checkout — plus the foreign-repo defense and the
// fail-open guards so a legitimately-provisioned tree is never wrongly blocked.

const EXPECTED = { url: 'https://github.com/acme/widget.git' };

test('classifyWorktreeCheckout: wrong path — not inside a work tree → not_a_git_repo (blocked)', () => {
  const d = classifyWorktreeCheckout({ insideWorkTree: false }, EXPECTED);
  assert.equal(d.ok, false);
  assert.equal(d.reason, 'not_a_git_repo');
  assert.match(d.detail, /not a git work tree/);
});

test('classifyWorktreeCheckout: incomplete checkout — HEAD unresolved → incomplete_checkout (blocked)', () => {
  const d = classifyWorktreeCheckout(
    { insideWorkTree: true, headResolved: false, originUrl: EXPECTED.url },
    EXPECTED,
  );
  assert.equal(d.ok, false);
  assert.equal(d.reason, 'incomplete_checkout');
  assert.match(d.detail, /HEAD does not resolve/);
});

test('classifyWorktreeCheckout: valid checkout of the expected repo → ok', () => {
  const d = classifyWorktreeCheckout(
    { insideWorkTree: true, headResolved: true, originUrl: EXPECTED.url },
    EXPECTED,
  );
  assert.deepEqual(d, { ok: true });
});

test('classifyWorktreeCheckout: a checkout of a DIFFERENT repo → wrong_repository (blocked)', () => {
  const d = classifyWorktreeCheckout(
    { insideWorkTree: true, headResolved: true, originUrl: 'https://github.com/acme/OTHER.git' },
    EXPECTED,
  );
  assert.equal(d.ok, false);
  assert.equal(d.reason, 'wrong_repository');
  assert.match(d.detail, /does not match/);
  assert.match(d.detail, /github\.com\/acme\/OTHER/);
});

test('classifyWorktreeCheckout: origin equivalence ignores scheme/creds/.git/case (no false block)', () => {
  // A worktree whose origin carries an embedded token and scp/.git form still
  // matches the expected https clone url — must NOT be flagged wrong_repository.
  for (const originUrl of [
    'https://x-access-token:ghs_SECRET@github.com/acme/widget.git',
    'git@github.com:acme/widget.git',
    'https://GitHub.com/ACME/Widget',
    'https://github.com/acme/widget/',
  ]) {
    const d = classifyWorktreeCheckout({ insideWorkTree: true, headResolved: true, originUrl }, EXPECTED);
    assert.deepEqual(d, { ok: true }, `should match expected: ${originUrl}`);
  }
});

test('classifyWorktreeCheckout: fail open when origin or expectation is unknown', () => {
  // Can't prove a mismatch → never block (mirrors decidePushReadiness).
  assert.deepEqual(
    classifyWorktreeCheckout({ insideWorkTree: true, headResolved: true, originUrl: '' }, EXPECTED),
    { ok: true },
    'origin unset → ok',
  );
  assert.deepEqual(
    classifyWorktreeCheckout({ insideWorkTree: true, headResolved: true, originUrl: EXPECTED.url }, undefined),
    { ok: true },
    'no expectation → ok',
  );
  assert.deepEqual(
    classifyWorktreeCheckout({ insideWorkTree: true, headResolved: true, originUrl: 'https://x/y' }, { url: '' }),
    { ok: true },
    'empty expected url → ok',
  );
});

test('classifyWorktreeCheckout: HEAD not probed (undefined) is not treated as incomplete', () => {
  // Only an explicit headResolved:false blocks; undefined (not probed) passes.
  const d = classifyWorktreeCheckout({ insideWorkTree: true, originUrl: EXPECTED.url }, EXPECTED);
  assert.deepEqual(d, { ok: true });
});

// ── normalizeRemoteUrl / redactRemoteUrl ─────────────────────────────────────

test('normalizeRemoteUrl: reduces to host/path, stripping scheme/creds/.git/slash/case', () => {
  const canon = 'github.com/acme/widget';
  assert.equal(normalizeRemoteUrl('https://github.com/acme/widget.git'), canon);
  assert.equal(normalizeRemoteUrl('https://user:tok@github.com/acme/widget.git/'), canon);
  assert.equal(normalizeRemoteUrl('git@github.com:acme/widget.git'), canon);
  assert.equal(normalizeRemoteUrl('ssh://git@github.com/acme/widget'), canon);
  assert.equal(normalizeRemoteUrl('HTTPS://GitHub.com/ACME/Widget'), canon);
  assert.equal(normalizeRemoteUrl(''), '');
  assert.equal(normalizeRemoteUrl(undefined), '');
  assert.equal(normalizeRemoteUrl(null), '');
});

test('redactRemoteUrl: removes user:pass@ credentials but keeps scheme+host (no token leak)', () => {
  assert.equal(
    redactRemoteUrl('https://x-access-token:ghs_SECRET@github.com/acme/widget.git'),
    'https://github.com/acme/widget.git',
  );
  assert.equal(redactRemoteUrl('https://github.com/acme/widget.git'), 'https://github.com/acme/widget.git');
  assert.equal(redactRemoteUrl('git@github.com:acme/widget.git'), 'git@github.com:acme/widget.git');
  assert.equal(redactRemoteUrl(''), '');
  assert.equal(redactRemoteUrl(undefined), '');
});

// ── RoleSpawnSuppressor (ticket feaa7ab0, completion criterion #3/#4) ─────────
// Suppress the automated supervisor re-dispatch storm per (ticket,role) while
// never blocking a human/state-changed trigger, with a cooldown escape and
// re-arm on recovery.

const SUP = { fromSupervisor: true };
const HUMAN = { fromSupervisor: false };

test('RoleSpawnSuppressor: no recorded blocker → never suppress (first trigger runs)', () => {
  const s = new RoleSpawnSuppressor(1000);
  assert.deepEqual(s.shouldSuppress('t', 'assignee', { now: 0, ...SUP }), { suppress: false });
});

test('RoleSpawnSuppressor: a supervisor repeat within cooldown is suppressed', () => {
  const s = new RoleSpawnSuppressor(1000);
  s.note('t', 'assignee', 'worktree:not_a_git_repo', 0);
  const d = s.shouldSuppress('t', 'assignee', { now: 200, ...SUP });
  assert.equal(d.suppress, true);
  assert.equal(d.kind, 'worktree:not_a_git_repo');
  assert.equal(d.count, 1);
  assert.equal(d.sinceMs, 200);
});

test('RoleSpawnSuppressor: human/state-changed triggers ALWAYS pass (operator recovery)', () => {
  const s = new RoleSpawnSuppressor(1000);
  s.note('t', 'assignee', 'worktree:not_a_git_repo', 0);
  // Same instant a supervisor trigger would be suppressed, a human one passes.
  assert.equal(s.shouldSuppress('t', 'assignee', { now: 200, ...SUP }).suppress, true);
  assert.equal(s.shouldSuppress('t', 'assignee', { now: 200, ...HUMAN }).suppress, false);
});

test('RoleSpawnSuppressor: cooldown escape lets exactly one supervisor probe through per window', () => {
  const s = new RoleSpawnSuppressor(1000);
  s.note('t', 'assignee', 'worktree:not_a_git_repo', 0);
  assert.equal(s.shouldSuppress('t', 'assignee', { now: 500, ...SUP }).suppress, true, 'within window → drop');
  assert.equal(s.shouldSuppress('t', 'assignee', { now: 1000, ...SUP }).suppress, false, 'window elapsed → one probe passes');
  assert.equal(s.shouldSuppress('t', 'assignee', { now: 1200, ...SUP }).suppress, true, 'probe consumed → drop again');
  assert.equal(s.shouldSuppress('t', 'assignee', { now: 2000, ...SUP }).suppress, false, 'next window → probe passes');
});

test('RoleSpawnSuppressor: clear() re-arms so a recovered ticket-role backs off afresh', () => {
  const s = new RoleSpawnSuppressor(1000);
  s.note('t', 'assignee', 'worktree:not_a_git_repo', 0);
  assert.equal(s.shouldSuppress('t', 'assignee', { now: 100, ...SUP }).suppress, true);
  s.clear('t', 'assignee'); // green preflight
  assert.equal(s.activeKind('t', 'assignee'), undefined);
  assert.equal(s.shouldSuppress('t', 'assignee', { now: 200, ...SUP }).suppress, false, 're-armed → runs');
});

test('RoleSpawnSuppressor: a DIFFERENT blocker kind resets the episode', () => {
  const s = new RoleSpawnSuppressor(1000);
  s.note('t', 'assignee', 'worktree:not_a_git_repo', 0);
  assert.equal(s.shouldSuppress('t', 'assignee', { now: 500, ...SUP }).count, 1);
  s.note('t', 'assignee', 'push_credential_unavailable', 600); // situation changed
  const d = s.shouldSuppress('t', 'assignee', { now: 700, ...SUP });
  assert.equal(d.kind, 'push_credential_unavailable');
  assert.equal(d.count, 1, 'count reset on kind change');
  assert.equal(d.sinceMs, 100, 'episode clock restarted at the new kind');
});

test('RoleSpawnSuppressor: same-kind repeats increment the abort count', () => {
  const s = new RoleSpawnSuppressor(1000);
  s.note('t', 'assignee', 'worktree:not_a_git_repo', 0);
  s.note('t', 'assignee', 'worktree:not_a_git_repo', 10);
  assert.equal(s.shouldSuppress('t', 'assignee', { now: 20, ...SUP }).count, 2);
});

test('RoleSpawnSuppressor: (ticket,role) pairs are independent; missing id/role never suppress', () => {
  const s = new RoleSpawnSuppressor(1000);
  s.note('t', 'assignee', 'k', 0);
  // Same ticket, different role → independent (reviewer has no record).
  assert.equal(s.shouldSuppress('t', 'reviewer', { now: 100, ...SUP }).suppress, false);
  // Different ticket, same role → independent.
  assert.equal(s.shouldSuppress('other', 'assignee', { now: 100, ...SUP }).suppress, false);
  // The recorded pair still suppresses.
  assert.equal(s.shouldSuppress('t', 'assignee', { now: 100, ...SUP }).suppress, true);
  // Missing ids never suppress and never throw.
  assert.equal(s.shouldSuppress(undefined, 'assignee', { now: 100, ...SUP }).suppress, false);
  assert.equal(s.shouldSuppress('t', undefined, { now: 100, ...SUP }).suppress, false);
  s.note(undefined, 'assignee', 'k', 0); // no-op, must not throw
  s.clear(undefined, undefined); // no-op, must not throw
  assert.equal(s.activeKind(undefined, undefined), undefined);
});
