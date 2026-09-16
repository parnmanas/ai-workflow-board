// Regression: EventsController's SSE stream must complete when the module is
// destroyed, so a graceful stop actually stops.
//
// `stream()` returns `merge(versionEvent, keepalive, eventSubject…)`. `merge`
// completes only once EVERY source completes, and `keepalive` is an
// `interval(15_000)` that never does — so completing `eventSubject` in
// `onModuleDestroy()` left each connected agent's response open. Nest's
// `app.close()` then waited on those sockets forever and systemd SIGKILLed the
// process at its stop timeout: observed on rolf 2026-09-16 as a full 90s in
// `stop-sigterm` followed by `Main process exited, code=killed, status=9/KILL`,
// on every single deploy restart.
//
// The guard is behavioural, not a source grep: it subscribes to a real stream,
// asserts it stays open (a stream that completed immediately would satisfy a
// naive "completes on destroy" assertion while breaking SSE entirely), then
// destroys the module and requires completion.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(__dirname, '..', 'dist');

const noopRepo = () => ({
  async findOne() { return null; },
  async find() { return []; },
  async count() { return 0; },
});

function buildController(EventsController) {
  const logService = { info() {}, warn() {}, error() {}, debug() {} };
  const authService = {
    async getSessionUser(token) {
      return token === 'test-token' ? { id: 'u1', name: 'Tester', email: 't@example.com' } : null;
    },
  };
  const apiKeyService = { async validateApiKey() { return { valid: false }; } };
  const instanceRegistry = {
    async register() {}, async unregister() {}, async touch() {},
    async listForAgent() { return []; },
  };
  const connectivity = { markConnected() {}, markDisconnected() {}, isConnected() { return false; } };
  const metrics = { register() {}, observe() {}, set() {}, gauge() {} };

  return new EventsController(
    noopRepo(), noopRepo(), noopRepo(), noopRepo(), noopRepo(),
    authService, apiKeyService, logService, instanceRegistry, connectivity, metrics,
  );
}

function fakeReq() {
  const handlers = new Map();
  const socket = { on(ev, fn) { handlers.set('socket:' + ev, fn); }, setTimeout() {}, setKeepAlive() {} };
  return {
    query: { token: 'test-token' },
    headers: {},
    socket,
    on(ev, fn) { handlers.set(ev, fn); },
    get ip() { return '127.0.0.1'; },
  };
}

test('SSE stream completes on module destroy instead of holding the response open', async () => {
  const { EventsController } = await import(
    'file://' + path.join(DIST, 'modules', 'events', 'events.controller.js')
  );

  const controller = buildController(EventsController);
  const observable = await controller.stream(fakeReq());

  let completed = false;
  let errored = null;
  const sub = observable.subscribe({
    next() {},
    error(e) { errored = e; },
    complete() { completed = true; },
  });

  try {
    // A live stream must stay open — otherwise "completes on destroy" would be
    // trivially true and SSE would be broken for every client.
    await new Promise((r) => setTimeout(r, 250));
    assert.equal(errored, null, 'stream must not error while open');
    assert.equal(completed, false, 'stream must stay open while the module is alive');

    controller.onModuleDestroy();

    // Completion propagates synchronously through takeUntil, but allow a tick.
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(
      completed, true,
      'onModuleDestroy must complete the stream — otherwise server.close() hangs and systemd SIGKILLs the process',
    );
  } finally {
    sub.unsubscribe();
  }
});
