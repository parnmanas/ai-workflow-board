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
  DispatchBlockerTracker,
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
