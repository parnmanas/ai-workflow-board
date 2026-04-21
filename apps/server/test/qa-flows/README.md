# QA Flow Tests

End-to-end QA tests that simulate real agents behind AWB's MCP/SSE contract.
Each test boots its own NestJS app on a unique port, provisions a scene via
fixtures, and drives it with `VirtualAgent` instances.

## Running

```bash
# Build first — tests import compiled dist/.
cd apps/server
npm run build

# Full QA suite (sequential, ~60–90s on SQLite)
npm run test:qa

# Fast subset (skips the 200-ticket load test and 5-agent concurrency)
npm run test:qa:fast

# Single file
node --test test/qa-flows/ticket-lifecycle.test.mjs
```

Tests are intentionally sequential: each file spins up its own NestJS app and
allocates a dedicated port (7801–7806) to avoid interference.

## What each file covers

| File                               | Port | Covers                                                                |
| ---------------------------------- | ---- | --------------------------------------------------------------------- |
| `ticket-lifecycle.test.mjs`        | 7801 | Reporter → Assignee → Reviewer routing; terminal column suppresses trigger |
| `self-trigger-guard.test.mjs`      | 7807 | `actor_id === targetAgentId` skips emission (no self-loops)            |
| `comment-trigger.test.mjs`         | 7802 | A new comment on a routed column fires `trigger_source='comment'`      |
| `comment-mention.test.mjs`         | 7808 | `comment_mention` only reaches the mentioned agent (ws-scoped)         |
| `mcp-tools-surface.test.mjs`       | 7803 | MCP initialize + `tools/list` returns the expected AWB tool surface    |
| `mcp-schema-version.test.mjs`      | 7809 | Missing `experimental.awb/schemaVersion` → JSON-RPC `-32000`           |
| `mcp-agent-roundtrip.test.mjs`     | 7810 | Virtual agent reacts to `agent_trigger` by calling `add_comment` + `move_ticket`; DB state reflects the tool calls |
| `multi-agent-concurrency.test.mjs` | 7804 | 5 agents × 4 tickets: every trigger lands at its owner, no cross-agent leak under parallel load |
| `multi-user-chat.test.mjs`         | 7806 | `chat_room_message` SSE fan-out is scoped to room participants only    |
| `large-data.test.mjs`              | 7805 | 200 tickets, 200 moves: stream keeps pace, no drops, no duplicates     |

Each file boots its own NestJS app on its own port and runs exactly one
`test()` block that ends with `exitAfterTests(0)` — this is the only shape
that plays nicely with the unreffed NestJS timers + TypeORM pool handles
(mixing multiple `test()` blocks in one file can hang the `node --test`
transition between tests).

## Helpers (`../helpers/`)

- **`boot.mjs`** — `bootApp({ port })` returns `{ app, port, modules }`
  where `modules` already exposes `activityEvents`, `ActivityService`,
  `AuthService`, `getDataSourceToken`, `mcpTools`. Also exports
  `exitAfterTests()` — NestJS leaves unreffed intervals + pool handles, so
  every file must call this after the last test.
- **`fixtures.mjs`** — TypeORM-repo-direct factories:
  `createWorkspace`, `createUser`, `createAgent`, `createApiKey`,
  `createBoard`, `createColumn`, `createTicket`, plus composites
  `setupKanbanScene` (ws + board + Todo/In Progress/Review/Done/Blocked
  columns with a standard `routing_config`) and `createAgentTrio`
  (assignee + reporter + reviewer + scoped API keys).
- **`sse-listener.mjs`** — `openSseStream(port, token, { boardId?, onFrame? })`.
  Generic event-type-agnostic listener; the same helper works for user
  session tokens and agent API keys (events.controller accepts both).
  Supports `waitFor(event?, predicate?, timeoutMs?)` with per-predicate FIFO
  matching plus `onFrame` callback for push-style consumers.
- **`mcp-client.mjs`** — `McpClient`. Sends the required
  `experimental['awb/schemaVersion'] = { version: 2 }` on initialize,
  propagates `mcp-session-id`, handles both JSON and SSE response framing
  from `WebStandardStreamableHTTPServerTransport`.
- **`virtual-agent.mjs`** — `VirtualAgent` composes an SSE subscriber
  (scoped to the agent's API key) with an `McpClient`. Accepts
  `onTrigger` / `onCommentMention` / `onChatMessage` callbacks to script
  reactive behavior. Exposes `triggers`, `mentions`, `chatMessages` arrays
  plus `waitForTrigger` / `waitForMention` / `waitForChatMessage` polling
  helpers for assertions.

  **Field-name note:** `agent_trigger` frames arrive on the wire in the
  legacy-compat shape (`role` is in `action`, `agent_id` is in
  `actor_name`, `trigger_id` is in `field_changed`) because
  `event-registry.ts` flattens the envelope that way for proxy.mjs
  compatibility. `VirtualAgent` un-flattens every `agent_trigger` back to
  the semantic names so test predicates can read `t.role`, `t.agent_id`,
  `t.trigger_id` naturally. The original wire object is still available
  at `t._wire` if a test specifically wants to assert on the flattened
  contract.

## Writing a new QA test

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { bootApp, exitAfterTests } from '../helpers/boot.mjs';
import { setupKanbanScene, createAgentTrio, createTicket } from '../helpers/fixtures.mjs';
import { VirtualAgent } from '../helpers/virtual-agent.mjs';

process.env.PORT = process.env.QA_MY_PORT || '7810';

test('my scenario', async (t) => {
  const { app, port, modules } = await bootApp({ port: parseInt(process.env.PORT, 10) });
  t.after(() => app.close().catch(() => {}));
  const { getDataSourceToken, ActivityService } = modules;

  const { ws, columns } = await setupKanbanScene(app, getDataSourceToken);
  const trio = await createAgentTrio(app, getDataSourceToken, ws.id);
  const ticket = await createTicket(app, getDataSourceToken, {
    columnId: columns.inProgress.id,
    workspaceId: ws.id,
    title: 'demo',
    assigneeId: trio.assignee.agent.id,
  });

  const agent = new VirtualAgent({
    name: 'assignee',
    agentId: trio.assignee.agent.id,
    apiKey: trio.assignee.key.raw_key,
    port,
    onTrigger: async ({ mcp, trigger }) => {
      await mcp.callTool('add_comment', {
        ticket_id: trigger.ticket_id,
        content: 'ack',
        type: 'note',
      });
    },
  });
  await agent.start();
  t.after(() => agent.stop());
  await new Promise(r => setTimeout(r, 200));

  await app.get(ActivityService).logActivity({
    entity_type: 'ticket',
    entity_id: ticket.id,
    action: 'moved',
    ticket_id: ticket.id,
    new_value: 'In Progress',
    actor_id: 'test-user',
  });

  const trig = await agent.waitForTrigger(t => t.ticket_id === ticket.id);
  assert.equal(trig.role, 'assignee');

  exitAfterTests(0); // Only in the LAST test() of the file.
});
```

### Gotchas

- **`exitAfterTests()` is per-file.** NestJS leaves timers open, so each
  file must call it once after the final `test()` completes. If you forget,
  `node --test` hangs.
- **Port collisions.** Pick a port in the 7800–7899 range and update the
  `PORT` env fallback at the top of your file. The `test:qa` npm script
  runs files sequentially, but other locally-running dev servers can steal
  a port.
- **SSE subscriptions are async.** After starting a `VirtualAgent`, give
  it ~200ms before emitting the event under test — the subscription
  attaches asynchronously and events fired before attach are lost.
- **`activityEvents.emit('activity', ...)` bypasses DB.** The trigger
  loop reads the ticket from DB before routing, so the ticket row must
  exist and its `column_id` must point at a column on the same board as
  the `new_value` destination. Prefer `ActivityService.logActivity(...)` —
  it does the DB write and the emit atomically.
- **`actor_id === 'system'` skips.** TriggerLoopService deliberately
  ignores system-originated activity to prevent loops. Use a real user or
  agent id in test emissions.
- **Terminal columns never trigger.** If your routing config maps a
  column that's `is_terminal: true`, no agent_trigger ever fires for it.
  The fixture's `Done` column is terminal by default.
