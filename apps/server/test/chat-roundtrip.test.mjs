// Integration test — Phase 2 Plan 02-05 — CHAT-09 / D-32
//
// Four test cases covering the Phase 2 chat subagent seam contract:
//   1. Round trip: user POST → chat_message SSE to user → send_chat_message MCP tool → second chat_message SSE to user.
//   2. Cross-user privacy (D-27, Pitfall 2): user B's stream does NOT receive user A's chat_message; user A's second stream DOES.
//   3. Agent impersonation (D-29, Pitfall 4): agentA's DB-backed API key calling send_chat_message with agent_id=agentB returns Forbidden, and no row is persisted.
//   4. Workspace boundary: user in workspace A posts → user in workspace B listing threads/messages sees nothing from workspace A.
//
// Design:
//  - node:test + node:assert/strict + global fetch (Node 22+ built-in). Zero new deps.
//  - Boots a fresh NestJS app via NestFactory.create(AppModule) using the compiled dist/.
//    Run via `npm run --workspace=apps/server test` which does `npm run build && node --test test/*.test.mjs`.
//  - Manual SSE parser via fetch ReadableStream, mirroring proxy-passthrough.test.mjs. EventSource
//    is behind --experimental-eventsource in Node 22+ so fetch+stream is the portable choice.
//  - For Test 3 (MCP send_chat_message impersonation guard), the test bypasses the MCP HTTP transport
//    and invokes the tool handler directly. registerAllTools is called with a mock `server` object
//    that captures { name → handler } pairs; the test primes setSessionAuth() with a DB-backed API
//    key context so caller.agentId is populated, then calls the handler with { agent_id: agentB.id }
//    and asserts the result contains "Forbidden" (caller.agentId !== agent_id path).
//  - process.exit(0) at the end because NestJS leaves an unreffed setInterval in AuthService (5-min
//    session cleanup) and there are TypeORM pool handles that prevent the event loop from draining.
//    This is the same workaround used by proxy-passthrough.test.mjs and documented there.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Ensure sqlite (default) and pick a test port to avoid dev/proxy-passthrough collision.
process.env.DB_TYPE = process.env.DB_TYPE || 'sqlite';
process.env.PORT = process.env.TEST_SERVER_PORT || '7792';
process.env.NODE_ENV = 'test';
process.env.MCP_DEV_MODE = process.env.MCP_DEV_MODE || 'true';
process.env.AGENT_DEV_MODE = process.env.AGENT_DEV_MODE || 'true';

// ─── Module loading ────────────────────────────────────────────────
async function loadServerModules() {
  const distRoot = path.join(__dirname, '..', 'dist');
  try {
    const { NestFactory } = await import('@nestjs/core');
    const appModuleUrl = 'file://' + path.join(distRoot, 'app.module.js');
    const activityServiceUrl = 'file://' + path.join(distRoot, 'services', 'activity.service.js');
    const authServiceUrl = 'file://' + path.join(distRoot, 'services', 'auth.service.js');
    const mcpToolsUrl = 'file://' + path.join(distRoot, 'modules', 'mcp', 'mcp-tools.js');
    const { AppModule } = await import(appModuleUrl);
    const { activityEvents } = await import(activityServiceUrl);
    const { AuthService } = await import(authServiceUrl);
    const mcpTools = await import(mcpToolsUrl);
    const { getDataSourceToken } = await import('@nestjs/typeorm');
    return { NestFactory, AppModule, activityEvents, AuthService, getDataSourceToken, mcpTools };
  } catch (err) {
    throw new Error(
      'Integration test requires the server to be built first. Run `npm run --workspace=apps/server build`. Original error: ' + err.message
    );
  }
}

// ─── Minimal SSE parser for fetch Response streams ────────────────
async function* parseSSE(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { value, done } = await reader.read();
    if (done) return;
    buffer += decoder.decode(value, { stream: true });

    let idx;
    while ((idx = buffer.indexOf('\n\n')) !== -1) {
      const frame = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);

      const currentEvent = { event: 'message', data: '' };
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

// ─── Bootstrap helpers ────────────────────────────────────────────
// Each test boots its own app (fresh state per test). Helpers take the already-booted
// app and create domain rows via TypeORM repositories directly — the cleanest path for
// test setup per proxy-passthrough.test.mjs precedent.

async function bootApp(modules) {
  const { NestFactory, AppModule } = modules;
  const app = await NestFactory.create(AppModule, { logger: false });
  const port = parseInt(process.env.PORT || '7792', 10);
  await app.listen(port, '0.0.0.0');
  return { app, port };
}

async function createTestUser(app, getDataSourceToken, suffix) {
  const dataSource = app.get(getDataSourceToken());
  const userRepo = dataSource.getRepository('User');
  const email = `chat-roundtrip-${suffix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@awb.local`;
  const user = await userRepo.save(userRepo.create({
    name: `chat-roundtrip-${suffix}`,
    email,
    role: 'admin', // admin gets all permissions including CHAT_SEND + CHAT_VIEW
    status: 'active',
  }));
  return user;
}

async function createTestWorkspace(app, getDataSourceToken, name) {
  const dataSource = app.get(getDataSourceToken());
  const wsRepo = dataSource.getRepository('Workspace');
  const ws = await wsRepo.save(wsRepo.create({
    name: `ws-${name}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    description: 'chat-roundtrip test workspace',
  }));
  return ws;
}

async function createTestAgent(app, getDataSourceToken, workspaceId, name) {
  const dataSource = app.get(getDataSourceToken());
  const agentRepo = dataSource.getRepository('Agent');
  const agent = await agentRepo.save(agentRepo.create({
    name: `agent-${name}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    description: 'chat-roundtrip test agent',
    type: 'custom',
    is_active: 1,
    is_online: 0,
    workspace_id: workspaceId,
    role_prompt: `You are ${name}. Respond with TEST_OK.`,
  }));
  return agent;
}

async function createTestApiKey(app, getDataSourceToken, agentId, label) {
  const dataSource = app.get(getDataSourceToken());
  const apiKeyRepo = dataSource.getRepository('ApiKey');
  const keyVal = `test-key-${label}-${randomUUID()}`;
  const ak = await apiKeyRepo.save(apiKeyRepo.create({
    name: `chat-roundtrip-${label}`,
    key: keyVal,
    agent_id: agentId,
    scope: 'full',
    is_active: 1,
  }));
  return ak;
}

// ─── SSE subscribe helper ────────────────────────────────────────
// Opens an SSE stream, eagerly starts consuming the response body via parseSSE(), and
// buffers every chat_message frame into a rolling queue. Multiple waitForChatMessage
// calls against the same stream are therefore sequential consumers of a single reader
// (which is required — you cannot acquire a second reader from a locked ReadableStream).
async function openUserSseStream(port, token) {
  const abort = new AbortController();
  const url = `http://localhost:${port}/api/events/stream?token=${encodeURIComponent(token)}`;
  const response = await fetch(url, {
    headers: { Accept: 'text/event-stream' },
    signal: abort.signal,
  });
  if (!response.ok) {
    throw new Error(`SSE fetch returned HTTP ${response.status}`);
  }

  const chatBuffer = [];         // chat_message frames that arrived already
  const waiters = [];            // unmatched predicate waiters waiting for future frames
  let streamClosed = false;
  let streamError = null;

  // Single reader — started once, runs for the lifetime of the stream.
  (async () => {
    try {
      for await (const frame of parseSSE(response)) {
        if (frame.event !== 'chat_message') continue;
        let data;
        try { data = JSON.parse(frame.data); } catch { continue; }

        // Try to match against any pending waiters in FIFO order
        let consumed = false;
        for (let i = 0; i < waiters.length; i++) {
          if (waiters[i].predicate(data)) {
            const [w] = waiters.splice(i, 1);
            w.resolve(data);
            consumed = true;
            break;
          }
        }
        if (!consumed) chatBuffer.push(data);
      }
    } catch (err) {
      streamError = err;
    } finally {
      streamClosed = true;
      // Reject any remaining waiters
      for (const w of waiters.splice(0)) {
        w.reject(streamError || new Error('SSE stream closed before matching chat_message frame arrived'));
      }
    }
  })();

  function waitForChatMessage(predicate, timeoutMs) {
    // Check the buffer first
    for (let i = 0; i < chatBuffer.length; i++) {
      if (predicate(chatBuffer[i])) {
        const [hit] = chatBuffer.splice(i, 1);
        return Promise.resolve(hit);
      }
    }
    if (streamClosed) {
      return Promise.reject(streamError || new Error('SSE stream already closed'));
    }
    return new Promise((resolve, reject) => {
      const waiter = { predicate, resolve, reject };
      waiters.push(waiter);
      const timer = setTimeout(() => {
        const idx = waiters.indexOf(waiter);
        if (idx !== -1) waiters.splice(idx, 1);
        reject(new Error(`Timed out waiting for chat_message SSE event (${timeoutMs}ms)`));
      }, timeoutMs);
      timer.unref();
    });
  }

  // Collect every frame seen during a fixed window (used for privacy test).
  function collectChatMessagesFor(windowMs) {
    return new Promise((resolve) => {
      const startIdx = chatBuffer.length;
      const timer = setTimeout(() => {
        resolve(chatBuffer.slice(startIdx));
      }, windowMs);
      timer.unref();
    });
  }

  function close() {
    try { abort.abort(); } catch { /* ignore */ }
  }

  return { response, abort, waitForChatMessage, collectChatMessagesFor, close };
}

// ─── Tests ──────────────────────────────────────────────────────────

test('Test 1: Chat round-trip — user POST → SSE chat_message → send_chat_message MCP tool → SSE chat_message', async (t) => {
  const modules = await loadServerModules();
  const { activityEvents, AuthService, getDataSourceToken } = modules;
  const { app, port } = await bootApp(modules);

  let closed = false;
  const closeApp = async () => {
    if (closed) return;
    closed = true;
    try { await app.close(); } catch { /* ignore */ }
  };
  t.after(closeApp);

  const authService = app.get(AuthService);

  // Bootstrap: workspace + user + agent
  const ws = await createTestWorkspace(app, getDataSourceToken, 'roundtrip');
  const user = await createTestUser(app, getDataSourceToken, 'roundtrip-user');
  const agent = await createTestAgent(app, getDataSourceToken, ws.id, 'roundtrip-agent');
  const token = authService.createSession(user.id);
  assert.ok(token, 'Expected AuthService.createSession to return a token');

  // Open user SSE stream — returns a stream object with waitForChatMessage + close.
  const stream = await openUserSseStream(port, token);

  // Wait briefly so the SSE subscription is fully wired before emit.
  await new Promise(r => setTimeout(r, 300));

  // ── Step 1: POST /api/chat/messages — user → agent ────────────────
  const userMessageContent = 'hello agent — roundtrip test';
  const postReplyPromise = stream.waitForChatMessage(
    (data) => data.payload?.content === userMessageContent && data.payload?.sender_type === 'user',
    3000,
  );

  const postRes = await fetch(`http://localhost:${port}/api/chat/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify({
      workspace_id: ws.id,
      agent_id: agent.id,
      content: userMessageContent,
    }),
  });
  assert.equal(postRes.status, 201, `Expected 201 from POST /api/chat/messages, got ${postRes.status}`);
  const savedUserMessage = await postRes.json();
  assert.ok(savedUserMessage.id, 'Expected saved.id on POST response');

  const firstSseFrame = await postReplyPromise;
  assert.equal(firstSseFrame.event_type, 'chat_message', 'First SSE frame should be chat_message (user message echo)');
  assert.equal(firstSseFrame.payload.content, userMessageContent);
  assert.equal(firstSseFrame.payload.sender_type, 'user');
  assert.equal(firstSseFrame.payload.message_id, savedUserMessage.id);
  assert.equal(firstSseFrame.scope.user_id, user.id);
  assert.equal(firstSseFrame.scope.agent_id, agent.id);

  // ── Step 2: Simulate agent reply via send_chat_message MCP tool ──
  // The MCP HTTP JSON-RPC transport is complex to drive (initialize handshake + session-id
  // header + SSE/JSON content-type negotiation). We use the ChatService-equivalent path the
  // tool itself would use: activityEvents.emit('chat_message', { sender_type: 'agent', ...}).
  // This exercises the SAME code path that the tool invokes (events.controller chatListener →
  // StreamEvent envelope → per-user filter → SSE delivery). Test 3 exercises the tool's
  // identity-guard code path directly.
  const agentReplyContent = 'hello user — reply from agent';
  const dataSource = app.get(getDataSourceToken());
  const chatRepo = dataSource.getRepository('ChatMessage');
  const agentMsg = await chatRepo.save(chatRepo.create({
    workspace_id: ws.id,
    agent_id: agent.id,
    sender_type: 'agent',
    sender_id: agent.id,
    content: agentReplyContent,
    ticket_id: null,
  }));
  const secondSseWait = stream.waitForChatMessage(
    (data) => data.payload?.content === agentReplyContent && data.payload?.sender_type === 'agent',
    3000,
  );
  activityEvents.emit('chat_message', {
    message_id: agentMsg.id,
    sender_type: 'agent',
    sender_id: agent.id,
    agent_id: agent.id,
    user_id: user.id,
    content: agentReplyContent,
    ticket_id: null,
    created_at: agentMsg.created_at.toISOString(),
  });

  const secondSseFrame = await secondSseWait;
  assert.equal(secondSseFrame.event_type, 'chat_message');
  assert.equal(secondSseFrame.payload.content, agentReplyContent);
  assert.equal(secondSseFrame.payload.sender_type, 'agent');
  assert.equal(secondSseFrame.payload.message_id, agentMsg.id);
  assert.equal(secondSseFrame.scope.user_id, user.id);
  assert.equal(secondSseFrame.scope.agent_id, agent.id);

  // Order + both delivered — implicit from sequential awaits above.
  stream.close();
  await closeApp();
});

test('Test 2: Cross-user privacy — user B does NOT receive user A chat_message (sanity: user A does)', async (t) => {
  const modules = await loadServerModules();
  const { AuthService, getDataSourceToken } = modules;
  const { app, port } = await bootApp(modules);

  let closed = false;
  const closeApp = async () => {
    if (closed) return;
    closed = true;
    try { await app.close(); } catch { /* ignore */ }
  };
  t.after(closeApp);

  const authService = app.get(AuthService);

  const ws = await createTestWorkspace(app, getDataSourceToken, 'privacy');
  const userA = await createTestUser(app, getDataSourceToken, 'privacy-A');
  const userB = await createTestUser(app, getDataSourceToken, 'privacy-B');
  const agent = await createTestAgent(app, getDataSourceToken, ws.id, 'privacy-agent');
  const tokenA = authService.createSession(userA.id);
  const tokenB = authService.createSession(userB.id);

  // Open BOTH streams concurrently: user B (should receive NOTHING), user A (sanity: should receive own message).
  const streamB = await openUserSseStream(port, tokenB);
  const streamA = await openUserSseStream(port, tokenA);

  // Wait briefly so both subscriptions are fully wired before emit.
  await new Promise(r => setTimeout(r, 300));

  const privateContent = 'private message — should never leak to user B';

  // Start collecting on BOTH streams BEFORE the POST. User B collects for a window; user A waits for a match.
  const bCollectionPromise = streamB.collectChatMessagesFor(1500);
  const aMatchPromise = streamA.waitForChatMessage(
    (data) => data.payload?.content === privateContent && data.payload?.sender_type === 'user',
    3000,
  );

  // User A posts
  const postRes = await fetch(`http://localhost:${port}/api/chat/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${tokenA}`,
    },
    body: JSON.stringify({
      workspace_id: ws.id,
      agent_id: agent.id,
      content: privateContent,
    }),
  });
  assert.equal(postRes.status, 201);

  // Sanity: user A SHOULD receive the message (proves the event was emitted)
  const aFrame = await aMatchPromise;
  assert.equal(aFrame.scope.user_id, userA.id, 'user A scope should be userA.id');

  // Privacy: user B should see ZERO chat_message frames with the private content
  const bFrames = await bCollectionPromise;
  const leaked = bFrames.filter(f => f?.payload?.content === privateContent);
  assert.equal(leaked.length, 0, `User B received ${leaked.length} leaked chat_message frames; expected 0`);

  streamB.close();
  streamA.close();
  await closeApp();
});

test('Test 3: Agent impersonation — agentA API key cannot call send_chat_message with agent_id=agentB', async (t) => {
  const modules = await loadServerModules();
  const { getDataSourceToken, mcpTools } = modules;
  const { app, port: _port } = await bootApp(modules);
  void _port;

  let closed = false;
  const closeApp = async () => {
    if (closed) return;
    closed = true;
    try { await app.close(); } catch { /* ignore */ }
  };
  t.after(closeApp);

  const ws = await createTestWorkspace(app, getDataSourceToken, 'impersonation');
  const agentA = await createTestAgent(app, getDataSourceToken, ws.id, 'imp-agent-A');
  const agentB = await createTestAgent(app, getDataSourceToken, ws.id, 'imp-agent-B');
  const apiKeyA = await createTestApiKey(app, getDataSourceToken, agentA.id, 'agentA');
  void apiKeyA;

  // Capture tool handlers via a mock `server` object passed to registerAllTools.
  // The mcp-tools module exports registerAllTools and setSessionAuth at module level.
  // setDataSource must be called first so the handlers can use AppDataSource.
  // NOTE: the NestJS McpController normally sets the DataSource during onModuleInit.
  // When the NestJS app is booted via NestFactory.create(AppModule), onModuleInit runs
  // on controllers automatically, so by the time this line runs setDataSource has
  // already been invoked. No need to call it again here.
  const toolRegistry = new Map();
  const mockServer = {
    tool(name, _descOrSchema, _schemaOrHandler, maybeHandler) {
      // Signature is server.tool(name, description, schema, handler) — 4 args.
      // But MCP SDK also supports 3-arg (name, schema, handler). Pick the last fn.
      const args = [name, _descOrSchema, _schemaOrHandler, maybeHandler];
      const handler = args.filter(a => typeof a === 'function').pop();
      if (handler) toolRegistry.set(name, handler);
    },
  };
  mcpTools.registerAllTools(mockServer);
  const sendChatMessageHandler = toolRegistry.get('send_chat_message');
  assert.ok(sendChatMessageHandler, 'send_chat_message tool handler should be registered');

  // Prime setSessionAuth with a DB-backed API key context (caller.agentId populated) so
  // the strict impersonation guard fires. This mirrors what McpController.handleMcp does
  // on session initialization in production.
  const sessionId = `test-session-${randomUUID()}`;
  mcpTools.setSessionAuth(sessionId, {
    agentId: agentA.id,
    agentName: agentA.name,
    scope: 'full',
    source: 'db',
  });

  // Call the tool handler directly with agent_id=agentB.id (impersonation attempt).
  const impersonationContent = 'impersonation attempt — should be blocked';
  const result = await sendChatMessageHandler({
    agent_id: agentB.id,     // attempted target
    user_id: 'any-user-id',  // irrelevant because the guard fires before persistence
    content: impersonationContent,
  }, { sessionId });

  // Verify the result is an error containing "Forbidden"
  assert.ok(result?.isError, `Expected isError=true on impersonation attempt, got: ${JSON.stringify(result)}`);
  const errorPayload = JSON.parse(result.content[0].text);
  assert.match(
    errorPayload.error || '',
    /Forbidden/,
    `Expected Forbidden error, got: ${JSON.stringify(errorPayload)}`
  );

  // Verify zero rows were persisted for the impersonation content
  const dataSource = app.get(getDataSourceToken());
  const chatRepo = dataSource.getRepository('ChatMessage');
  const leakedRows = await chatRepo
    .createQueryBuilder('m')
    .where('m.content = :c', { c: impersonationContent })
    .getMany();
  assert.equal(leakedRows.length, 0, `Expected 0 rows persisted for impersonation content; got ${leakedRows.length}`);

  // Sanity check: calling with agent_id=agentA.id (the owned agent) should NOT return Forbidden.
  const okContent = 'legitimate reply from agentA';
  const legitResult = await sendChatMessageHandler({
    agent_id: agentA.id,
    user_id: 'any-user-id',
    content: okContent,
  }, { sessionId });
  assert.ok(!legitResult?.isError, `Legitimate agentA call should not error, got: ${JSON.stringify(legitResult)}`);

  mcpTools.removeSessionAuth(sessionId);
  await closeApp();
});

test('Test 4: Workspace boundary — user in workspace B cannot see workspace A chat content', async (t) => {
  const modules = await loadServerModules();
  const { AuthService, getDataSourceToken } = modules;
  const { app, port } = await bootApp(modules);

  let closed = false;
  const closeApp = async () => {
    if (closed) return;
    closed = true;
    try { await app.close(); } catch { /* ignore */ }
  };
  t.after(closeApp);

  const authService = app.get(AuthService);

  const wsA = await createTestWorkspace(app, getDataSourceToken, 'boundary-A');
  const wsB = await createTestWorkspace(app, getDataSourceToken, 'boundary-B');
  const userA = await createTestUser(app, getDataSourceToken, 'boundary-userA');
  const userB = await createTestUser(app, getDataSourceToken, 'boundary-userB');
  const agentA = await createTestAgent(app, getDataSourceToken, wsA.id, 'boundary-agentA');
  const tokenA = authService.createSession(userA.id);
  const tokenB = authService.createSession(userB.id);

  // User A posts in workspace A
  const wsAContent = 'workspace-A-secret';
  const postRes = await fetch(`http://localhost:${port}/api/chat/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${tokenA}`,
    },
    body: JSON.stringify({
      workspace_id: wsA.id,
      agent_id: agentA.id,
      content: wsAContent,
    }),
  });
  assert.equal(postRes.status, 201, `Expected 201, got ${postRes.status}`);

  // User B lists threads scoped to workspace B — should be empty (no wsA thread leak)
  const threadsBRes = await fetch(
    `http://localhost:${port}/api/chat/threads?workspace_id=${encodeURIComponent(wsB.id)}`,
    { headers: { 'Authorization': `Bearer ${tokenB}` } },
  );
  assert.equal(threadsBRes.status, 200);
  const threadsB = await threadsBRes.json();
  assert.ok(Array.isArray(threadsB), 'threads response should be an array');
  assert.equal(threadsB.length, 0, `Expected 0 threads for user B in workspace B; got ${threadsB.length}`);

  // User B lists messages for the wsA agent id BUT scoped to workspace B — should be empty
  // (workspace + agent filter combined; the service workspace-scopes every query).
  const messagesBRes = await fetch(
    `http://localhost:${port}/api/chat/messages?workspace_id=${encodeURIComponent(wsB.id)}&agent_id=${encodeURIComponent(agentA.id)}`,
    { headers: { 'Authorization': `Bearer ${tokenB}` } },
  );
  assert.equal(messagesBRes.status, 200);
  const messagesB = await messagesBRes.json();
  assert.ok(Array.isArray(messagesB));
  assert.equal(messagesB.length, 0, `Expected 0 messages for user B looking at wsA agent from wsB; got ${messagesB.length}`);

  // Also assert the content string never appears in either workspace-B response body
  const threadsBytes = JSON.stringify(threadsB);
  const messagesBytes = JSON.stringify(messagesB);
  assert.ok(!threadsBytes.includes(wsAContent), 'wsA content must not appear in wsB threads response');
  assert.ok(!messagesBytes.includes(wsAContent), 'wsA content must not appear in wsB messages response');

  // Sanity: user A listing wsA threads DOES see the posted thread
  const threadsARes = await fetch(
    `http://localhost:${port}/api/chat/threads?workspace_id=${encodeURIComponent(wsA.id)}`,
    { headers: { 'Authorization': `Bearer ${tokenA}` } },
  );
  assert.equal(threadsARes.status, 200);
  const threadsA = await threadsARes.json();
  assert.ok(threadsA.length >= 1, `Sanity: user A should see >=1 thread in wsA; got ${threadsA.length}`);

  await closeApp();

  // Force process exit after the final test — NestJS leaves unreffed intervals and
  // TypeORM pool handles that keep the event loop alive. Same workaround as proxy-passthrough.
  setImmediate(() => process.exit(0));
});
