import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(
  new URL('../src/lib/event-dispatcher.ts', import.meta.url),
  'utf8',
);

test('agent-authored comment mentions terminate before any forward, defer, or spawn path', () => {
  const guard = source.indexOf("if (ev.actor_type === 'agent')");
  const forward = source.indexOf('forwardCommentMention(', guard);
  const defer = source.indexOf('const mentionDefer =', guard);
  const spawn = source.indexOf('this.#subagentManager.spawn({', guard);

  assert.notEqual(guard, -1, 'agent-origin guard exists');
  assert.match(source.slice(guard, forward), /return;/, 'guard terminates delivery');
  assert.ok(guard < forward, 'guard runs before live-session forwarding');
  assert.ok(guard < defer, 'guard runs before durable mention deferral');
  assert.ok(guard < spawn, 'guard runs before one-shot dispatch');
});

test('the guard is origin-specific so user-authored mentions remain dispatchable', () => {
  const guardBlock = source.match(
    /if \(ev\.actor_type === 'agent'\) \{[\s\S]*?\n    \}/,
  )?.[0];

  assert.ok(guardBlock);
  assert.doesNotMatch(guardBlock, /actor_type === 'user'/);
});
