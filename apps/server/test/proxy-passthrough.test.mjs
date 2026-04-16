// Integration test — ROLE-10 / D-21
//
// Verifies that when an `agent_trigger` event is emitted on the internal activityEvents bus
// (the same bus TriggerLoopService uses in production), the SSE stream delivered to a
// subscribed client contains `role_prompt` and `ticket_prompt` fields at the TOP LEVEL
// of the event data JSON. This is the wire-format contract proxy.mjs depends on, per D-21.
//
// The test boots a NestJS app using the compiled dist/, connects to the SSE endpoint as
// an authenticated user, emits a synthetic agent_trigger, and asserts the received SSE
// data contains role_prompt and ticket_prompt with the expected values — AT THE TOP LEVEL,
// not nested under `payload` (flatten-on-emit contract).
//
// Design:
//  - Uses node:test (Node 22+ built-in) — zero new dependencies.
//  - Uses global `fetch` + a manual SSE parser instead of EventSource. EventSource in Node
//    is behind an experimental flag; fetch+stream is portable across Node 20/22/24 without
//    extra flags. The parser only needs to handle `event:` and `data:` lines for this test.
//  - Boots the NestJS app in-process via NestFactory.create(AppModule).
//  - Uses the existing sqlite dev DB (test only writes a throwaway User + session; no persistent state).
//  - Creates a test User via TypeORM repo, then uses AuthService.createSession(userId) to get a token.
//  - Emits the synthetic trigger via the exported `activityEvents` EventEmitter.
//  - Listens on SSE for at most 5 seconds; asserts the first agent_trigger event contains the fields.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Ensure sqlite (default) and pick a test port to avoid dev-server collision
process.env.DB_TYPE = process.env.DB_TYPE || 'sqlite';
process.env.PORT = process.env.TEST_SERVER_PORT || '7791';
process.env.NODE_ENV = 'test';
// Dev-mode flags so bootstrap does not block on MCP/agent key setup
process.env.MCP_DEV_MODE = 'true';
process.env.AGENT_DEV_MODE = 'true';

// Dynamic import of compiled dist — the test assumes `npm run build` ran first.
// The npm test script runs build && node --test, so this is always satisfied when
// invoked via `npm run test`.
async function loadServerModules() {
  const distRoot = path.join(__dirname, '..', 'dist');
  try {
    const { NestFactory } = await import('@nestjs/core');
    const appModuleUrl = 'file://' + path.join(distRoot, 'app.module.js');
    const activityServiceUrl = 'file://' + path.join(distRoot, 'services', 'activity.service.js');
    const authServiceUrl = 'file://' + path.join(distRoot, 'services', 'auth.service.js');
    const { AppModule } = await import(appModuleUrl);
    const { activityEvents } = await import(activityServiceUrl);
    const { AuthService } = await import(authServiceUrl);
    const { getDataSourceToken } = await import('@nestjs/typeorm');
    return { NestFactory, AppModule, activityEvents, AuthService, getDataSourceToken };
  } catch (err) {
    throw new Error(
      'Integration test requires the server to be built first. Run `npm run --workspace=apps/server build`. Original error: ' + err.message
    );
  }
}

// Minimal SSE parser for fetch Response streams. Parses only the fields this test
// needs: `event:` and `data:`. Yields { event, data } objects per SSE event frame.
async function* parseSSE(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let currentEvent = { event: 'message', data: '' };

  while (true) {
    const { value, done } = await reader.read();
    if (done) return;
    buffer += decoder.decode(value, { stream: true });

    // Events are separated by blank lines
    let idx;
    while ((idx = buffer.indexOf('\n\n')) !== -1) {
      const frame = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);

      currentEvent = { event: 'message', data: '' };
      for (const rawLine of frame.split('\n')) {
        const line = rawLine.replace(/\r$/, '');
        if (!line || line.startsWith(':')) continue;
        const colonIdx = line.indexOf(':');
        const field = colonIdx === -1 ? line : line.slice(0, colonIdx);
        let val = colonIdx === -1 ? '' : line.slice(colonIdx + 1);
        if (val.startsWith(' ')) val = val.slice(1);
        if (field === 'event') currentEvent.event = val;
        else if (field === 'data') {
          currentEvent.data = currentEvent.data ? currentEvent.data + '\n' + val : val;
        }
      }
      yield currentEvent;
    }
  }
}

test('SSE stream delivers role_prompt and ticket_prompt at top level for agent_trigger events', async (t) => {
  const { NestFactory, AppModule, activityEvents, AuthService, getDataSourceToken } = await loadServerModules();

  const app = await NestFactory.create(AppModule, { logger: false });
  const port = parseInt(process.env.PORT || '7791', 10);
  await app.listen(port, '0.0.0.0');

  // Track cleanup state so we never call app.close() twice
  let closed = false;
  const closeApp = async () => {
    if (closed) return;
    closed = true;
    try { await app.close(); } catch { /* ignore */ }
  };
  t.after(closeApp);

  // ─── Auth bootstrap ────────────────────────────────────────
  // Create a throwaway User record directly via the TypeORM DataSource, then use
  // AuthService.createSession(userId) to mint a session token. This bypasses the
  // HTTP login flow (which requires bcrypt password_hash seeding) and the /auth/setup
  // endpoint (which requires a specific first-time state).
  //
  // The test does NOT clean up the User row — it is left in the dev sqlite DB. This
  // is accepted per T-03-05 in the plan's threat model. A future improvement would
  // use an isolated test DB.
  const authService = app.get(AuthService);
  const dataSource = app.get(getDataSourceToken());
  const userRepo = dataSource.getRepository('User');

  // Use a deterministic test email so repeated runs reuse the same row
  const TEST_EMAIL = 'proxy-passthrough-test@awb.local';
  let user = await userRepo.findOne({ where: { email: TEST_EMAIL } });
  if (!user) {
    user = await userRepo.save(userRepo.create({
      name: 'proxy-passthrough-test',
      email: TEST_EMAIL,
      role: 'admin',
      status: 'active',
    }));
  }
  const token = authService.createSession(user.id);
  assert.ok(token, 'Failed to obtain session token from AuthService.createSession(userId)');

  // ─── Subscribe to SSE via fetch stream ─────────────────────
  const url = `http://localhost:${port}/api/events/stream?token=${encodeURIComponent(token)}`;
  const abort = new AbortController();
  let sseResponse;
  try {
    sseResponse = await fetch(url, {
      headers: { Accept: 'text/event-stream' },
      signal: abort.signal,
    });
  } catch (err) {
    await closeApp();
    throw new Error('SSE fetch connection failed: ' + err.message);
  }
  if (!sseResponse.ok) {
    await closeApp();
    throw new Error(`SSE fetch returned HTTP ${sseResponse.status}`);
  }

  // Start consuming events and resolve when we see an agent_trigger
  const receivedPromise = (async () => {
    for await (const frame of parseSSE(sseResponse)) {
      if (frame.event === 'agent_trigger') {
        return JSON.parse(frame.data);
      }
    }
    throw new Error('SSE stream ended before agent_trigger event arrived');
  })();

  // 5-second watchdog timeout
  const timeoutPromise = new Promise((_, reject) => {
    setTimeout(() => reject(new Error('Timed out waiting for agent_trigger SSE event (5s)')), 5000).unref();
  });

  // Give the SSE connection a moment to fully establish before emitting.
  await new Promise((r) => setTimeout(r, 300));

  // ─── Emit the synthetic trigger ────────────────────────────
  // This mirrors what TriggerLoopService._createTrigger emits in production after Plan 02 Task 3.
  activityEvents.emit('agent_trigger', {
    trigger_id: 'test-trigger-1',
    ticket_id: 'test-ticket-1',
    agent_id: 'test-agent-1',
    role: 'assignee',
    trigger_source: 'test',
    role_prompt: 'You are a test agent. Respond with TEST_OK.',
    ticket_prompt: 'Ticket-specific instructions for this test.',
    timestamp: new Date().toISOString(),
  });

  let data;
  try {
    data = await Promise.race([receivedPromise, timeoutPromise]);
  } finally {
    // Always abort the fetch stream so the server-side Observable unsubscribes
    try { abort.abort(); } catch { /* ignore */ }
  }

  // ─── Assertions ─────────────────────────────────────────
  // These are the fields proxy.mjs reads at the TOP LEVEL of the data JSON per P-01.

  // Legacy fields (must survive the envelope refactor)
  assert.equal(data.event_type, 'agent_trigger', 'event_type should be agent_trigger');
  assert.equal(data.ticket_id, 'test-ticket-1', 'ticket_id at top level');
  assert.equal(data.action, 'assignee', 'action (= role) at top level per proxy.mjs handleTrigger');
  assert.equal(data.field_changed, 'test-trigger-1', 'field_changed (= trigger_id) at top level per proxy.mjs handleTrigger');
  assert.equal(data.actor_name, 'test-agent-1', 'actor_name (= agent_id) at top level per proxy.mjs handleTrigger');
  assert.equal(data.board_id, '__trigger__', 'board_id sentinel preserved for backward compat');

  // New D-20 fields (the actual contract this test validates)
  assert.equal(data.role_prompt, 'You are a test agent. Respond with TEST_OK.', 'role_prompt at top level (D-20)');
  assert.equal(data.ticket_prompt, 'Ticket-specific instructions for this test.', 'ticket_prompt at top level (D-20)');

  // Negative assertion: the envelope shape should NOT be on the wire for agent_trigger
  assert.equal(data.payload, undefined, 'payload field should NOT be present on the wire (flatten-on-emit contract)');
  assert.equal(data.scope, undefined, 'scope field should NOT be present on the wire (flatten-on-emit contract)');

  // Explicit teardown so the process exits promptly (redundant with t.after but faster)
  await closeApp();

  // The NestJS app leaves an unreffed setInterval behind (AuthService session cleanup)
  // plus any open TypeORM pool handles. Force exit with success after assertions pass
  // so `npm run test` does not hang at the end of the suite. This is safe because the
  // single test has already completed and all assertions have passed by this point.
  setImmediate(() => process.exit(0));
});
