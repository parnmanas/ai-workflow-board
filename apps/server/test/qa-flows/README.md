# QA Flow Tests

End-to-end QA tests that simulate real agents behind AWB's MCP/SSE contract.
Each test boots its own NestJS app on an OS-assigned port, provisions a scene via
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

# Single file (always pass --test-force-exit, see below)
node --test --test-force-exit test/qa-flows/ticket-lifecycle.test.mjs
```

Tests are intentionally sequential: each file spins up its own NestJS app. Ports
are **not** assigned by hand — every file boots with `port: 0` and the OS hands
back a free one, so two files (or two whole test sessions) can never collide.
There is no port ledger to keep in sync (ticket f2d82793).

## What each file covers

| File                               | Covers                                                                |
| ---------------------------------- | --------------------------------------------------------------------- |
| `ticket-lifecycle.test.mjs`        | Reporter → Assignee → Reviewer routing; terminal column suppresses trigger |
| `self-trigger-guard.test.mjs`      | `actor_id === targetAgentId` skips emission (no self-loops)            |
| `comment-trigger.test.mjs`         | A new comment on a routed column fires `trigger_source='comment'`      |
| `comment-mention.test.mjs`         | `comment_mention` only reaches the mentioned agent (ws-scoped)         |
| `mcp-tools-surface.test.mjs`       | MCP initialize + `tools/list` returns the expected AWB tool surface    |
| `mcp-schema-version.test.mjs`      | Missing `experimental.awb/schemaVersion` → JSON-RPC `-32000`           |
| `mcp-agent-roundtrip.test.mjs`     | Virtual agent reacts to `agent_trigger` by calling `add_comment` + `move_ticket`; DB state reflects the tool calls |
| `multi-agent-concurrency.test.mjs` | 5 agents × 4 tickets: every trigger lands at its owner, no cross-agent leak under parallel load |
| `multi-user-chat.test.mjs`         | `chat_room_message` SSE fan-out is scoped to room participants only    |
| `large-data.test.mjs`              | 200 tickets, 200 moves: stream keeps pace, no drops, no duplicates     |

Each file boots its own NestJS app on an OS-assigned port and runs exactly one
`test()` block that ends with `exitAfterTests()` — this is the only shape
that plays nicely with the unreffed NestJS timers + TypeORM pool handles
(mixing multiple `test()` blocks in one file can hang the `node --test`
transition between tests).

**Always run flow files with `--test-force-exit`** (the `test:qa` scripts and
`qa.controller` already do). NestJS's unreffed intervals keep the event loop
alive, so node:test needs the flag to exit at all — and crucially it then
exits with the *real* code (non-zero when an assertion fails). `exitAfterTests()`
only flushes the trace buffer; it must **never** call `process.exit`. A
hardcoded `process.exit(0)` there raced node:test's async completion and
reported green even when assertions failed — the whole suite was silently
non-gating until ticket `fc84ec30` removed it. The `test-harness-gate.test.mjs`
meta-test guards against that regression returning.

## Helpers (`../helpers/`)

- **`boot.mjs`** — `bootApp({ port })` returns `{ app, port, modules }`
  where the returned `port` is the port the server **actually** bound —
  pass `port: 0` to let the OS pick a free one (ticket 6a9a3fe4) — and
  `modules` already exposes `activityEvents`, `ActivityService`,
  `AuthService`, `getDataSourceToken`, `mcpTools`. Also exports
  `exitAfterTests()` — flushes the trace buffer after the last test. It does
  **not** call `process.exit`; handle teardown + the real exit code come from
  the `--test-force-exit` flag the runners pass.
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

// 포트는 선언하지 않는다 — 0 을 넘기면 OS 가 빈 포트를 고르고 bootApp 이 실제
// 바인딩된 번호를 돌려준다. 특정 번호에 붙어 디버깅할 때만 env 로 덮어쓴다.
process.env.PORT = process.env.QA_MY_PORT || '0';

test('my scenario', async (t) => {
  const { app, port, modules } = await bootApp({ port: parseInt(process.env.PORT, 10) });
  // Fire-and-forget: do NOT return app.close()'s promise from an after-hook.
  // NestJS's HTTP server won't close while SSE streams are open, so a returned
  // promise hangs the hook forever and node:test never reaches exit (see Gotchas).
  t.after(() => { void app.close().catch(() => {}); });
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

  exitAfterTests(); // Only in the LAST test() of the file. Flushes the trace;
                    // never call process.exit (it would mask failures).
});
```

### Gotchas

- **`exitAfterTests()` is per-file and must NOT call `process.exit`.** It only
  flushes the trace; the `--test-force-exit` flag handles the unreffed NestJS
  timers + TypeORM pool handles AND yields the real exit code. If you forget the
  flag, `node --test` hangs; if you add a `process.exit(0)` anywhere in a flow
  file, a failed assertion gets masked and the gate silently dies (ticket
  `fc84ec30`).
- **Never return `app.close()` from a `t.after` hook.** node:test *awaits* a
  hook's returned promise, and NestJS's HTTP server never finishes closing while
  SSE streams are open — so `t.after(() => app.close())` hangs the hook forever
  and the process never exits (it was the old `process.exit(0)` that hid this).
  Always fire-and-forget: `t.after(() => { void app.close().catch(() => {}); });`.
  Awaiting client-side teardown (`VirtualAgent.stop()`, `mcp.close()`) is fine —
  those resolve.
- **포트를 고르지 마라.** 새 파일은 번호를 선언하지 않고 `port: 0` 으로 부팅한다
  — OS 가 빈 포트를 고르고 `bootApp()` 이 **실제로 바인딩된** 번호를 돌려준다.
  예전에는 7800–7899 에서 하나 골라 대장에 적으라고 했는데, 그 대장은 유지되지
  않았다 — 152 개 파일이 선언한 고유값 105 개 중 32 개가 이미 중복이었고(최다
  7842 는 7 개 파일 공유), 순차 러너가 가려주고 있었을 뿐이다(ticket f2d82793).
  특정 번호에 붙어 디버깅해야 할 때만 env(`QA_MY_PORT=7842`)로 덮어쓰면 된다.
  **한 파일에서 앱을 두 번 이상 부팅한다면 고정 포트를 재사용하지 말 것**
  (ticket 6a9a3fe4). 바로 위 항목대로 teardown 은 `void app.close()` 라
  앞 서버가 실제로 소켓을 놓을 때까지 기다리지 않으므로, 다음 부팅이 같은
  포트를 bind 하면 EADDRINUSE 가 난다 — 한가한 머신에서는 통과하고 부하가
  걸린 전체 스위트에서만 터지는 flake 가 된다. 두 번째 부팅부터는 `bootApp({ port: 0 })`
  으로 OS 에 빈 포트를 받아라. `bootApp()` 은 **실제로 바인딩된** 포트를 돌려주므로
  반환값을 그대로 URL 에 쓰면 된다. 고정 지연(sleep)으로 덮지 말 것.
  `BASE_PORT + n` / `parseInt(process.env.PORT, 10) + n` 같은 **산술 파생은 쓰지 마라**
  (ticket 5db0964a) — 그렇게 실제로 점유되는 번호가 소스 어디에도 문자열로 없어서
  다른 파일이 같은 번호를 선언해도 드러나지 않고, bootApp 이 부팅마다 env.PORT 를
  실제 포트로 덮어쓰기 때문에 두 번째 파생부터는 의도한 번호에서 밀리기까지 한다.
  `test/boot-port-guard.test.mjs` 가 산술 파생과 고정 리터럴 선언을 모두 정적으로
  막고, `test/boot-concurrent-sessions.test.mjs` 가 두 세션 동시 부팅을 실제
  프로세스로 검증한다.
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
