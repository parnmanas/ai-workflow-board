# Technology Stack — Agent Connection Management Milestone

**Project:** AI Workflow Board (AWB)
**Milestone:** Agent connection management, role-based routing, subagent delegation, UI redesign
**Researched:** 2026-04-08
**Overall confidence:** HIGH (all critical recommendations verified against current official sources or npm registry)

---

## Existing Stack (Do Not Change)

Constraints from PROJECT.md are hard. Do not propose replacements.

| Layer | Current | Version | Constraint |
|---|---|---|---|
| Backend framework | NestJS | 11.0.0 | Hard lock |
| Frontend | React | 18.3.0 | Hard lock |
| ORM | TypeORM | 0.3.20 | Hard lock |
| MCP SDK | @modelcontextprotocol/sdk | 1.29.0 | Hard lock (Streamable HTTP) |
| DB | PostgreSQL / SQLite | pg 8.20.0 / sql.js 1.12.0 | Hard lock |
| Real-time (existing) | NestJS SSE (@Sse decorator + RxJS Subject) | rxjs 7.8.0 | Already in use — extend, don't replace |
| Build | Turbo 2.4.0 + Vite 6.0.0 | — | Hard lock |

---

## What Needs to Be Added

The milestone introduces three new technical concerns that require additional dependencies or patterns:

1. **Agent connection registry** — tracking which agents are online per session/API-key
2. **Role-based routing** — delivering ticket trigger events only to the right role (assignee/reporter/reviewer)
3. **Subagent delegation** — locking a ticket to one logical "task" so concurrent agents don't conflict
4. **UI: right-panel layout** — replace centre-modal with a resizable right-panel for ticket detail, subtask navigation, and mass comments

---

## Recommended Additions

### 1. Agent Connection Registry — Extend Existing SSE Infrastructure

**Decision:** Extend the existing `EventsController` SSE Subject pattern. Do NOT add Socket.IO or WebSockets.

**Rationale:**

The codebase already uses NestJS `@Sse` + RxJS `Subject` in `events.controller.ts`. It already tracks `clientCount`. Agent connection state is simpler than bidirectional chat — agents only need to receive triggers, not push arbitrary messages. The MCP session `Map<sessionId, {transport, server, lastActivity}>` in `mcp.controller.ts` already constitutes a partial connection registry.

Adding Socket.IO (`@nestjs/websockets@11.1.x` + `@nestjs/platform-socket.io@11.1.x` + `socket.io@4.8.x`) would require a new adapter layer, CORS configuration on a second endpoint, and client-side `socket.io-client`. That overhead is not justified when SSE already works.

**What to add:**

A new `AgentConnectionService` (singleton, NestJS provider) that maintains an in-memory Map keyed on `agentId` (resolved from API key during MCP auth). It records:

```typescript
interface AgentConnection {
  agentId: string;
  agentName: string;
  role: string;         // 'assignee' | 'reporter' | 'reviewer' | 'any'
  sessionId: string;    // MCP Mcp-Session-Id
  connectedAt: Date;
  lastActivityAt: Date;
}
```

The `McpController.handleMcp` already extracts `agentId` from `McpAuthInfo` at session init time. Augment `onsessioninitialized` to register into `AgentConnectionService`. Augment `transport.onclose` to deregister.

**Confidence:** HIGH — pattern confirmed in existing codebase + official NestJS SSE docs.

---

### 2. Role-Based Routing — Ticket Column Field + Event Filter

**Decision:** Add `reviewer` and `reviewer_id` fields to the `Ticket` entity (mirroring existing `assignee`/`assignee_id`/`reporter`/`reporter_id`). Route trigger events via the existing SSE Subject with a `role` filter field, not a separate queue system.

**Rationale:**

The `Ticket` entity already has `assignee`, `assignee_id`, `reporter`, `reporter_id` as plain varchar columns. Adding `reviewer`/`reviewer_id` is a TypeORM migration (one ALTER TABLE). No new ORM library is needed.

For routing: when a ticket moves to a new column, emit an event with `{ target_role: 'assignee' | 'reporter' | 'reviewer', ticket_id, agent_id }` onto the existing activity event bus. The MCP layer (or a new `trigger` MCP tool) reads this and calls the appropriate connected agent session. Agents can filter triggers by their registered role.

**Do NOT use BullMQ/Bull.** Redis is not in the stack, and adding a Redis dependency for single-process in-memory routing is disproportionate. The codebase is single-process (one NestJS instance). EventEmitter2 is sufficient.

**What to add (new dependency):**

```
@nestjs/event-emitter@3.0.1
```

This is the official NestJS package for in-process typed events. It wraps `eventemitter2`. Use it to emit typed `TicketRoleTriggered` events from ticket status-change handlers, which are consumed by the `AgentConnectionService` routing logic.

Why not the existing `activityEvents` EventEmitter singleton? Because `activityEvents` is an untyped Node.js `EventEmitter` used for audit logging. Routing logic should be separate, typed, and injectable — EventEmitter2 via `@nestjs/event-emitter` provides this cleanly.

**Confidence:** HIGH — `@nestjs/event-emitter@3.0.1` confirmed on npm, last published ~1 year ago, 370 dependents, official NestJS package.

---

### 3. Subagent Delegation — Optimistic Lock on Ticket

**Decision:** Add a `locked_by_agent_id` (nullable varchar) and `locked_at` (nullable datetime) column to the `Ticket` entity. Implement lock acquisition/release as two new MCP tools (`awb_lock_ticket`, `awb_unlock_ticket`). No external locking library required.

**Rationale:**

Subagent delegation conflict prevention does not need distributed locks (Redis Redlock etc.) because AWB is single-process. A database-level optimistic lock is sufficient: before an agent starts working on a ticket, it calls `awb_lock_ticket`; the tool performs a conditional UPDATE (`WHERE locked_by_agent_id IS NULL OR locked_by_agent_id = ?`). If the row was already locked by another agent, the tool returns an error. The agent can retry or report conflict upward.

Lock TTL: add a cleanup job using `setInterval` in `McpController.onModuleInit` (same pattern as the session cleanup already there) — any lock older than N minutes is auto-released.

This requires zero new npm packages. TypeORM's `dataSource.manager.update` with a `WHERE` clause handles the conditional update.

**Confidence:** HIGH — pattern derived directly from existing codebase code (`McpController` session cleanup, TypeORM repository pattern).

---

### 4. UI: Right-Panel Layout — react-resizable-panels

**Decision:** Use `react-resizable-panels@^2.x` for the kanban+detail split layout.

**Note on version:** npm shows `4.9.0` as latest as of 2026-04-09 (published ~21 hours prior). Verify this is not a breaking change from 2.x before upgrading to 4.x — the changelog shows 2.x→3.x→4.x series had panel API changes. Pin to a stable release after testing.

**Rationale:**

- Zero production dependencies (confirmed npm page). React 18 peer dep already satisfied.
- Maintained by Brian Vaughn (React core team, react-window, react-virtualized author) — high reliability signal.
- shadcn/ui's official `Resizable` component uses `react-resizable-panels` as its primitive, meaning community examples and copy-paste patterns are abundant.
- The alternative (`allotment`) mimics VS Code's panel but is heavier (2 dependencies, less active).
- Pure CSS approach (no library) is viable but requires manual pointer/touch event handling — not worth the effort.

**Installation:**

```bash
npm install react-resizable-panels
```

**Usage pattern:**

```tsx
import { PanelGroup, Panel, PanelResizeHandle } from 'react-resizable-panels';

<PanelGroup direction="horizontal" autoSaveId="board-layout">
  <Panel defaultSize={65} minSize={40}>
    {/* Kanban columns */}
  </Panel>
  <PanelResizeHandle />
  <Panel defaultSize={35} minSize={20} collapsible>
    {/* Ticket detail right pane */}
  </Panel>
</PanelGroup>
```

`autoSaveId` persists panel sizes to `localStorage` automatically — no extra state management needed.

**Confidence:** MEDIUM-HIGH — version number from npm search result (21 hours old at research time); verify on install. Library choice is HIGH confidence.

---

### 5. Frontend State: Zustand for Agent Status Panel

**Decision:** Add `zustand@^5.0.12` for client-side agent connection state.

**Rationale:**

The React client has no current state management library beyond React's own hooks. Agent connection status (which agents are online, their roles, last-seen timestamps) needs to be:
- Shared across components (header status bar, board view, ticket panel)
- Updated from SSE stream events without prop-drilling
- Not persisted to server on every render

Zustand 5.0.12 is the correct choice: 20M weekly downloads, 1.2KB bundle, no Provider boilerplate, integrates cleanly with React 18 concurrent mode via `useSyncExternalStore`. Redux Toolkit is overengineered for this scope.

**Installation:**

```bash
npm install zustand
```

**Confidence:** HIGH — version 5.0.12 confirmed on npm (24 days ago as of research date). Community adoption confirmed (~20M/week downloads).

---

## Packages NOT to Add

| Package | Reason to avoid |
|---|---|
| `@nestjs/platform-socket.io` + `socket.io` | Bidirectional push not required. SSE already in place. Adds adapter complexity, second CORS config, client-side socket.io dependency. |
| `@nestjs/bull` / `@nestjs/bullmq` + Redis | Single-process app. EventEmitter2 handles in-process routing. Redis adds infrastructure dependency with no return for this scale. |
| `ioredis` | Same — Redis not in the stack, not needed for single-process. |
| `react-query` / `@tanstack/react-query` | Useful for server state caching but out of scope for this milestone. Introduces a large surface area change. |
| `allotment` | Split panel alternative — more complex than `react-resizable-panels`, VS Code-specific API, not worth it. |
| `typeorm-optimistic-locking` | Third-party package for TypeORM OCC. Unnecessary — conditional UPDATE in raw TypeORM is sufficient and simpler. |

---

## Summary of Additions

| Package | Version | Layer | Purpose | Confidence |
|---|---|---|---|---|
| `@nestjs/event-emitter` | 3.0.1 | Backend | Typed in-process event bus for role routing triggers | HIGH |
| `react-resizable-panels` | ^2.x (verify latest stable) | Frontend | Kanban+detail right-panel split layout | HIGH (library), MEDIUM (exact version) |
| `zustand` | ^5.0.12 | Frontend | Agent connection status shared state | HIGH |

**Schema additions (no new packages):**

| Entity | New Fields | Purpose |
|---|---|---|
| `Ticket` | `reviewer: varchar`, `reviewer_id: varchar` | Third role for routing |
| `Ticket` | `locked_by_agent_id: varchar nullable`, `locked_at: datetime nullable` | Subagent delegation lock |
| `Agent` | `default_role: varchar` (default `'any'`) | Role assignment for routing |

**New NestJS providers (no new packages):**

| Provider | Purpose |
|---|---|
| `AgentConnectionService` | In-memory Map of active agent sessions, register/deregister on MCP connect/close |
| `AgentRoutingService` | Consumes `TicketRoleTriggered` events, resolves target agent by role, pushes trigger via SSE Subject |

---

## Installation Command

```bash
# From monorepo root
npm install @nestjs/event-emitter --workspace=apps/server
npm install react-resizable-panels zustand --workspace=apps/client
```

---

## Sources

- NestJS WebSocket Gateways (official docs): https://docs.nestjs.com/websockets/gateways
- NestJS SSE (official docs): https://docs.nestjs.com/techniques/server-sent-events
- NestJS EventEmitter (official docs): https://docs.nestjs.com/techniques/events
- @nestjs/event-emitter on npm: https://www.npmjs.com/package/@nestjs/event-emitter
- @nestjs/websockets on npm: https://www.npmjs.com/package/@nestjs/websockets (version 11.1.17 confirmed)
- react-resizable-panels on npm: https://www.npmjs.com/package/react-resizable-panels (version 4.9.0 confirmed)
- zustand on npm: https://www.npmjs.com/package/zustand (version 5.0.12 confirmed)
- MCP Streamable HTTP session identity: https://modelcontextprotocol.io/specification/2025-03-26/basic/transports
- MCP SSE session header issue: https://github.com/modelcontextprotocol/typescript-sdk/issues/852
- shadcn/ui Resizable (uses react-resizable-panels): https://ui.shadcn.com/docs/components/radix/resizable
- State management in 2026: https://dev.to/jsgurujobs/state-management-in-2026-zustand-vs-jotai-vs-redux-toolkit-vs-signals-2gge
