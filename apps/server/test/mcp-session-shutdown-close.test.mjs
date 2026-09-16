// Regression: MCP sessions must be closed on shutdown, or the process never
// exits on SIGTERM.
//
// Every live MCP session owns an open `text/event-stream` response, pumped by
// the `while (true) reader.read()` loop in internal/express-bridge.ts. Nothing
// ended them when the app shut down, so `server.close()` blocked on those
// sockets and systemd SIGKILLed the process at its stop timeout on every
// restart (rolf, 2026-09-16).
//
// This is the *second* holder of that shutdown. Completing the EventsController
// SSE streams (events-sse-shutdown-completes.test.mjs) was necessary but not
// sufficient — measured on the built server: with only an MCP session held
// open it never exited; with the fix and both an MCP session and an events
// stream open it exits in ~1s.
//
// Covered here: sessionStore.closeAll() closes every transport and empties the
// store, it does NOT fire the idle-eviction hooks (those mark agents offline —
// a shutting-down process must not issue writes while its DB connections are
// being torn down), and McpController is actually wired to call it on destroy.
// The wiring assertion matters because closeAll() is dead code if nothing
// invokes it, and that failure mode is invisible at runtime until a deploy
// hangs.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(__dirname, '..', 'dist');
const CONTROLLER_SRC = path.resolve(__dirname, '..', 'src', 'modules', 'mcp', 'mcp.controller.ts');

function fakeSession(id, closed) {
  return {
    transport: {
      async close() { closed.push(id); },
    },
    server: { id },
  };
}

test('closeAll() closes every live session transport and empties the store', async () => {
  const { sessionStore } = await import(
    'file://' + path.join(DIST, 'modules', 'mcp', 'internal', 'session-store.js')
  );

  const closed = [];
  const a = fakeSession('a', closed);
  const b = fakeSession('b', closed);
  sessionStore.register('sess-a', a.transport, a.server, { agentId: 'agent-1' });
  sessionStore.register('sess-b', b.transport, b.server, { agentId: 'agent-2' });
  assert.equal(sessionStore.size, 2, 'fixture registered');

  sessionStore.closeAll();

  // close() is async; give the microtask queue a turn.
  await new Promise((r) => setTimeout(r, 10));

  assert.deepEqual(closed.sort(), ['a', 'b'], 'every transport is closed — these hold the open SSE responses');
  assert.equal(sessionStore.size, 0, 'store is emptied so nothing reports phantom live sessions');
});

test('closeAll() does not fire eviction hooks', async () => {
  const { sessionStore } = await import(
    'file://' + path.join(DIST, 'modules', 'mcp', 'internal', 'session-store.js')
  );

  const evicted = [];
  sessionStore.onEviction((sid) => evicted.push(sid));

  const closed = [];
  const s = fakeSession('c', closed);
  sessionStore.register('sess-c', s.transport, s.server, { agentId: 'agent-3' });

  sessionStore.closeAll();
  await new Promise((r) => setTimeout(r, 10));

  assert.deepEqual(closed, ['c'], 'transport still closed');
  assert.deepEqual(
    evicted, [],
    'eviction hooks mark agents offline — shutdown must not issue those writes as the DB is torn down',
  );
});

test('McpController calls sessionStore.closeAll() from onModuleDestroy', () => {
  const src = fs.readFileSync(CONTROLLER_SRC, 'utf8');
  assert.match(
    src, /implements\s+OnModuleInit,\s*OnModuleDestroy/,
    'McpController must declare the destroy hook',
  );
  assert.match(
    src, /onModuleDestroy\s*\(\s*\)\s*:\s*void\s*\{[^}]*sessionStore\.closeAll\(\)/,
    'onModuleDestroy must call sessionStore.closeAll() — without the call the method is dead code and deploys hang',
  );
});
