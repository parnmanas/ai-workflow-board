import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const root = new URL('../src/lib/', import.meta.url);

test('silent-exit accounting waits for stdio close, not process exit', async () => {
  const [base, oneshot] = await Promise.all([
    readFile(new URL('base-session-manager.ts', root), 'utf8'),
    readFile(new URL('subagent-manager.ts', root), 'utf8'),
  ]);

  assert.match(base, /sess\.child\.once\('close', async \(code, signal\) =>/);
  assert.doesNotMatch(base, /sess\.child\.once\('exit', async \(code, signal\) =>/);
  assert.match(oneshot, /child\.once\('close', async \(code, signal\) =>/);
  assert.doesNotMatch(oneshot, /child\.once\('exit', async \(code, signal\) =>/);
});

test('cycle exit paths do not fall back to ticket-wide time-window attribution', async () => {
  const [persistent, oneshot] = await Promise.all([
    readFile(new URL('ticket-session-manager.ts', root), 'utf8'),
    readFile(new URL('subagent-manager.ts', root), 'utf8'),
  ]);

  assert.doesNotMatch(persistent, /hasAuditTrailSince/);
  assert.doesNotMatch(oneshot, /hasAuditTrailSince/);
});
