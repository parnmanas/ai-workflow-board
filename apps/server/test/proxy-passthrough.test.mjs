// Integration test — ROLE-10 / D-21
//
// Verifies that when an `agent_trigger` event is emitted on the internal
// activityEvents bus (the same bus TriggerLoopService uses in production), the
// SSE stream delivered to the TARGET agent contains `role_prompt` and
// `ticket_prompt` at the TOP LEVEL of the event data JSON. This is the
// wire-format contract proxy.mjs depends on, per D-21.
//
// Recipient scoping (commit 021d7e2): agent_trigger is no longer broadcast to
// every subscriber — it fans out ONLY to the SSE session whose authenticated
// identity is an agent with a matching agent_id (event-registry.ts agent_trigger
// filter). So this test connects to the stream AS THE AGENT (API key passed as
// ?token=) and emits the trigger with that agent's id. The previous version
// connected as a plain user and timed out, because a user stream never receives
// agent_trigger under the current contract (quarantined → ticket 5e5959ef).
//
// Design:
//  - node:test (Node 22+ built-in) — zero new dependencies.
//  - global `fetch` + a manual SSE parser instead of EventSource, so the raw
//    wire frame can be inspected (top-level fields, absence of payload/scope).
//  - Boots the NestJS app via bootApp() (hermetic sql.js DB + prod body parsers).

import test from 'node:test';
import assert from 'node:assert/strict';
import { bootApp } from './helpers/boot.mjs';
import { createWorkspace, createAgent, createApiKey } from './helpers/fixtures.mjs';

process.env.PORT = process.env.TEST_SERVER_PORT || '7791';

// Minimal SSE parser for fetch Response streams. Parses only the fields this
// test needs: `event:` and `data:`. Yields { event, data } objects per frame.
async function* parseSSE(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let currentEvent = { event: 'message', data: '' };

  while (true) {
    const { value, done } = await reader.read();
    if (done) return;
    buffer += decoder.decode(value, { stream: true });

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
  const { app, port, modules } = await bootApp({ port: parseInt(process.env.PORT, 10) });
  const { activityEvents, getDataSourceToken } = modules;

  let closed = false;
  const closeApp = async () => {
    if (closed) return;
    closed = true;
    try { await app.close(); } catch { /* ignore */ }
  };
  t.after(closeApp);

  // ─── Agent + API key ───────────────────────────────────────
  // agent_trigger is recipient-scoped to the target agent's SSE session, so the
  // subscriber must authenticate as an agent. The events stream accepts an API
  // key as ?token= and resolves it to an agent identity (events.controller.ts
  // → ApiKeyService.validateApiKey).
  const ws = await createWorkspace(app, getDataSourceToken, 'proxy-passthrough');
  const agent = await createAgent(app, getDataSourceToken, ws.id, { name: 'proxy-agent' });
  const apiKey = await createApiKey(app, getDataSourceToken, agent.id, {
    workspaceId: ws.id,
    label: 'proxy',
  });

  // ─── Subscribe to SSE via fetch stream, AS THE AGENT ───────
  const url = `http://localhost:${port}/api/events/stream?token=${encodeURIComponent(apiKey.raw_key)}`;
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

  // Give the SSE connection a moment to register in agentSseSessions before emitting.
  await new Promise((r) => setTimeout(r, 300));

  // ─── Emit the synthetic trigger ────────────────────────────
  // Mirrors TriggerLoopService._createTrigger. agent_id MUST match the connected
  // agent or the recipient-scoped filter drops it.
  activityEvents.emit('agent_trigger', {
    trigger_id: 'test-trigger-1',
    ticket_id: 'test-ticket-1',
    agent_id: agent.id,
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
  // Fields proxy.mjs reads at the TOP LEVEL of the data JSON per P-01.

  // Legacy fields (must survive the envelope refactor)
  assert.equal(data.event_type, 'agent_trigger', 'event_type should be agent_trigger');
  assert.equal(data.ticket_id, 'test-ticket-1', 'ticket_id at top level');
  assert.equal(data.action, 'assignee', 'action (= role) at top level per proxy.mjs handleTrigger');
  assert.equal(data.field_changed, 'test-trigger-1', 'field_changed (= trigger_id) at top level per proxy.mjs handleTrigger');
  assert.equal(data.actor_name, agent.id, 'actor_name (= agent_id) at top level per proxy.mjs handleTrigger');
  assert.equal(data.board_id, '__trigger__', 'board_id sentinel preserved for backward compat');

  // New D-20 fields (the actual contract this test validates)
  assert.equal(data.role_prompt, 'You are a test agent. Respond with TEST_OK.', 'role_prompt at top level (D-20)');
  assert.equal(data.ticket_prompt, 'Ticket-specific instructions for this test.', 'ticket_prompt at top level (D-20)');

  // Negative assertion: the envelope shape should NOT be on the wire for agent_trigger
  assert.equal(data.payload, undefined, 'payload field should NOT be present on the wire (flatten-on-emit contract)');
  assert.equal(data.scope, undefined, 'scope field should NOT be present on the wire (flatten-on-emit contract)');

  // Explicit teardown so the process exits promptly (redundant with t.after but faster)
  await closeApp();

  // No process.exit here: a hardcoded exit(0) would override the real exit code
  // and mask a failed assertion. The suite runs with `--test-force-exit`.
});
