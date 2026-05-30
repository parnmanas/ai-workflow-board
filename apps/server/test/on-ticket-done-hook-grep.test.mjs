// Regression-grep — on-ticket-done Action hook (ticket 16a6339c). The
// behavioural test (test/qa-flows/on-ticket-done-hook.test.mjs) boots NestJS
// and asserts dispatch happens; this cheap static check pins the structural
// invariants so a future refactor can't silently strip them in a
// PR-review-without-flow-tests scenario.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(__dirname, '..', 'src', 'modules', 'actions');
const SERVICE = path.join(SRC, 'on-ticket-done-action.service.ts');
const MODULE = path.join(SRC, 'actions.module.ts');

const read = (p) => fs.readFileSync(p, 'utf8');

test('OnTicketDoneActionService subscribes to and detaches from activityEvents', () => {
  const src = read(SERVICE);
  assert.match(src, /activityEvents\.on\(\s*['"]activity['"]/, 'must subscribe to activityEvents "activity"');
  assert.match(
    src,
    /activityEvents\.removeListener\(\s*['"]activity['"]/,
    'must detach the listener in onModuleDestroy (no listener leak across test module rebuilds)',
  );
});

test('hook fires only on terminal-column moves', () => {
  const src = read(SERVICE);
  assert.match(
    src,
    /log\.action\s*!==\s*['"]moved['"]/,
    'must early-return on non-moved activities',
  );
  assert.match(src, /isTerminalColumn\(/, 'must gate on the terminal-column check');
});

test('idempotency: once-per-terminal-entry atomic claim on on_done_dispatched_at', () => {
  const src = read(SERVICE);
  // The conditional UPDATE is what guarantees a single dispatch per terminal
  // entry. The WHERE must compare on_done_dispatched_at against
  // terminal_entered_at (null OR older) so re-entry re-fires but re-emit/reorder
  // does not.
  assert.match(src, /on_done_dispatched_at/, 'must stamp on_done_dispatched_at');
  assert.match(
    src,
    /on_done_dispatched_at IS NULL OR on_done_dispatched_at < terminal_entered_at/,
    'claim WHERE must guard on_done_dispatched_at < terminal_entered_at',
  );
});

test('recursion guard label blocks hook-origin tickets', () => {
  const src = read(SERVICE);
  assert.match(src, /no-on-done-hook/, 'must define the recursion-guard label');
  assert.match(
    src,
    /labels\.includes\(\s*ON_DONE_HOOK_GUARD_LABEL\s*\)/,
    'must skip tickets carrying the recursion-guard label',
  );
});

test('enabled=false Actions are excluded from both binding methods', () => {
  const src = read(SERVICE);
  // method (b) query filters enabled in SQL …
  assert.match(src, /a\.enabled\s*=\s*:en/, 'policy query must filter enabled=true');
  // … and method (a) explicit ids re-check enabled in JS.
  assert.match(src, /if \(!a\.enabled\) continue/, 'explicit-id path must skip disabled Actions');
});

test('dispatch carries system attribution + the finished-ticket context', () => {
  const src = read(SERVICE);
  assert.match(src, /triggeredByType:\s*['"]system['"]/, 'hook dispatch must be attributed to system');
  assert.match(src, /ticketContext/, 'hook dispatch must pass the finished-ticket context');
});

test('service is registered as an actions-module provider', () => {
  const src = read(MODULE);
  assert.match(
    src,
    /providers:\s*\[[^\]]*OnTicketDoneActionService/,
    'OnTicketDoneActionService must be in ActionsModule providers (else it never subscribes)',
  );
});
