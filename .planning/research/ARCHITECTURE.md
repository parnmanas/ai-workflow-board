# Architecture Patterns

**Domain:** AI agent workflow automation platform (kanban + MCP)
**Researched:** 2026-04-08
**Confidence:** HIGH — derived from direct codebase analysis + verified patterns

---

## Context: What Already Exists

This is a subsequent milestone. The existing system is not blank-slate:

| What Exists | Location | Implication |
|---|---|---|
| MCP controller with session map | `modules/mcp/mcp.controller.ts` | Agent sessions are already in-memory; need persistence layer |
| Agent + AgentChannelIdentity entities | `entities/Agent.ts`, `entities/AgentChannelIdentity.ts` | Agent registry exists; lacks role and connection-state fields |
| ApiKey → Agent FK relationship | `entities/ApiKey.ts` | Agent identity already resolves from API key at auth time |
| activityEvents EventEmitter (module-level singleton) | `services/activity.service.ts` | The trigger bus already exists — extend, don't replace |
| SSE stream at `/api/events/stream` | `modules/events/events.controller.ts` | Frontend already receives board events; agents can use same bus |
| Ticket.assignee_id + reporter_id fields | `entities/Ticket.ts` | Role relationship fields exist as string columns, not FK |
| AgentAuthGuard + MCP authenticate() | `guards/agent-auth.guard.ts`, `mcp.controller.ts` | Two separate auth paths; need to unify agent identity resolution |

---

## Recommended Architecture

The new components layer on top of existing infrastructure without replacing any of it. Three focused additions:

1. **AgentRegistry** — connection state tracking (extend Agent entity + in-process map)
2. **RoutingEngine** — role-based ticket dispatch (NestJS service + new MCP tools)
3. **TriggerLoop** — automated progression on column change (extend ActivityService listener)

---

## Component Boundaries

### Component 1: AgentRegistry

**Responsibility:** Know which agents are currently connected, when they last called a tool, and what roles they hold.

**What talks to it:**
- `McpController` — on session init/close, updates connected state
- `RoutingEngine` — queries for agents eligible to receive a trigger
- Admin API — reads for UI display of agent status

**Data model additions to existing `Agent` entity:**

```
Agent (extend existing)
  + roles: string          -- JSON array: ['assignee','reporter','reviewer']
  + connected_at: Date | null
  + last_seen_at: Date | null
  + connection_source: string  -- 'mcp' | 'api' | null
  + workspace_id: string | null  -- scope restriction (nullable = global)
```

**In-memory complement** — `McpController` already holds `mcpSessions: Map<sessionId, {transport, server, lastActivity}>`. Extend this map to also hold `agentId` so session → agent identity is O(1):

```
mcpSessions: Map<sessionId, {
  transport, server, lastActivity,
  agentId: string | undefined,   // from McpAuthInfo.agentId
  agentName: string | undefined
}>
```

On session init → set `Agent.connected_at`, `Agent.last_seen_at`. On session close/idle cleanup → clear `Agent.connected_at`. On every tool call → update `Agent.last_seen_at` (debounced — write at most once per 30s to avoid thrashing).

**Why not pure in-memory:** MCP sessions already expire after 10 minutes idle. DB-backed `last_seen_at` survives server restart and is visible to the admin UI without needing a WebSocket.

**Why not a new AgentConnection entity:** Overkill. A single `Agent` row update covers the use case. Connection history (if ever needed) can be read from ActivityLog.

---

### Component 2: RoutingEngine

**Responsibility:** Given a ticket state change event, find the correct Agent(s) for the next role and push a notification/trigger to them.

**What talks to it:**
- `ActivityService` (event listener) — receives `action: 'moved'` events with `field_changed: 'column'`
- `TicketService` — reads ticket to determine current column and role fields
- `AgentRegistry` — queries agents by role + workspace
- `NotificationService` — sends the trigger payload (extend existing Discord path OR push via SSE)

**Routing rules (simple, no rule engine needed):**

```
column transition → role to notify
"Todo"      → assignee_id agent
"In Review" → reviewer_id agent (new field on Ticket)
"Done"      → reporter_id agent
```

The column-to-role map should be stored as a per-board configuration (new `BoardRoutingConfig` or a JSON field on `Board`), not hardcoded, so workspaces can define their own column names and role mappings.

**Trigger delivery mechanism — two-tier:**

Tier 1 (primary): AWB does NOT need to push to the external Claude instance. The Claude agent polls via MCP tools it already calls. Instead, AWB calls a `notify_agent` webhook URL if the Agent entity has `webhook_url` configured. This is a simple outbound HTTP POST: `{ event: 'ticket_assigned', ticket_id, role, timestamp }`.

Tier 2 (fallback/monitoring): Write a `AgentTrigger` record to the database so agents that reconnect can call `get_pending_triggers` MCP tool and catch up on what they missed while offline.

**Rationale for poll-friendly design:** MCP agents (Claude instances) initiate connections. AWB cannot reliably push to an agent process that may have exited. The `AgentTrigger` table acts as a durable inbox — agents `acknowledge_trigger(trigger_id)` after acting.

**Why not webhooks only:** An agent may not expose an inbound HTTP endpoint (Claude Desktop, CLI agents). The DB inbox is always available regardless of agent topology.

---

### Component 3: TriggerLoop

**Responsibility:** Listen to the existing `activityEvents` bus and fire the RoutingEngine when a ticket changes column.

**What talks to it:**
- `ActivityService.activityEvents` (EventEmitter) — already fires on every create/update/move
- `RoutingEngine` — called when column change detected

**Implementation:** A NestJS Injectable service that subscribes to `activityEvents` in its `onModuleInit` (same pattern as `EventsController`). No new infrastructure. One listener:

```typescript
activityEvents.on('activity', async (log: ActivityLog) => {
  if (log.action === 'moved' && log.field_changed === 'column') {
    await this.routingEngine.dispatch(log.ticket_id, log.new_value);
  }
});
```

**For subagent delegation:** An Agent calls the MCP tool `delegate_ticket(ticket_id, to_agent_id, role, instructions)`. This tool: (1) updates the ticket's role field, (2) writes an AgentTrigger for the target agent, (3) logs to ActivityLog. The subagent then picks it up via `get_pending_triggers`. AWB is the broker — agents never call other agents directly through AWB.

---

## Data Flow

### Flow A: Agent Connects

```
Agent process             McpController              AgentRegistry (DB)
    |                          |                           |
    |-- POST /mcp (init) ------>|                           |
    |                          |-- authenticate() -------->|
    |                          |   resolves agentId        |
    |                          |-- SET Agent.connected_at ->|
    |                          |-- extend mcpSessions map  |
    |<-- session_id ------------|                           |
```

### Flow B: Agent Calls Tool

```
Agent process             McpController              AgentRegistry (DB)
    |                          |                           |
    |-- POST /mcp (tool) ------>|                           |
    |                          |-- update lastActivity     |
    |                          |-- debounced: SET          |
    |                          |   Agent.last_seen_at ---->|
    |<-- tool result ------------|                          |
```

### Flow C: Ticket Moves Column

```
MCP tool (move_ticket)    ActivityService         TriggerLoop        RoutingEngine
    |                          |                      |                    |
    |-- saves Ticket ---------->|                      |                    |
    |                          |-- emit('activity') -->|                    |
    |                          |                      |-- dispatch() ------>|
    |                          |                      |              query Agent by role
    |                          |                      |              write AgentTrigger
    |                          |                      |              optional webhook POST
```

### Flow D: Agent Polls for Work

```
Agent process             MCP tool                 AgentTrigger (DB)
    |                          |                           |
    |-- get_pending_triggers -->|                           |
    |                          |-- SELECT WHERE            |
    |                          |   agent_id = me           |
    |                          |   AND acked = false ------>|
    |<-- [trigger list] --------|                           |
    |                          |                           |
    |-- acknowledge_trigger --->|                           |
    |                          |-- SET acked = true ------->|
```

### Flow E: Subagent Delegation

```
Orchestrator Agent        MCP tool                 RoutingEngine
    |                          |                           |
    |-- delegate_ticket ------->|                           |
    |   (ticket_id,             |-- update Ticket fields    |
    |    to_agent_id,           |-- write AgentTrigger ---->|
    |    role, instructions)    |-- log ActivityLog         |
    |<-- ok --------------------|                           |
                                              |
                         Target Agent <-- get_pending_triggers
```

---

## New Entities Required

### AgentTrigger

```
AgentTrigger
  id: uuid (PK)
  agent_id: string (FK -> Agent)
  ticket_id: string (FK -> Ticket)
  role: string              -- 'assignee' | 'reporter' | 'reviewer'
  event_type: string        -- 'assigned' | 'delegated' | 'review_requested'
  instructions: string      -- optional free-text from delegating agent
  acknowledged: boolean     -- false until agent acks
  acknowledged_at: Date | null
  created_at: Date
  expires_at: Date | null   -- auto-expire stale triggers
```

### BoardRoutingConfig (optional, Phase 2)

```
BoardRoutingConfig
  id: uuid (PK)
  board_id: string (FK -> Board)
  column_name: string       -- matches BoardColumn.name (case-insensitive)
  target_role: string       -- 'assignee' | 'reporter' | 'reviewer'
  created_at: Date
```

Default if no config: hardcode `Todo→assignee`, `In Review→reviewer`, `Done→reporter`. This is the safe Phase 1 default.

---

## New Fields on Existing Entities

### Ticket (extend, no migration breaking change)

```
+ reviewer_id: string   -- agent ID or empty string (mirrors assignee_id pattern)
+ reviewer: string      -- display name (mirrors assignee pattern)
```

### Agent (extend)

```
+ roles: string         -- JSON array, default '["assignee"]'
+ connected_at: Date | null
+ last_seen_at: Date | null
+ webhook_url: string   -- optional outbound trigger URL
+ workspace_id: string | null
```

---

## New MCP Tools Required (extend mcp-tools.ts)

| Tool | Description |
|---|---|
| `get_pending_triggers` | Returns unacknowledged AgentTriggers for the calling agent |
| `acknowledge_trigger` | Marks trigger as handled |
| `delegate_ticket` | Reassigns ticket role to another agent, creates AgentTrigger |
| `get_agent_roster` | Lists agents with roles and online status |
| `update_agent_role` | Updates calling agent's role configuration |

These integrate into the existing `registerAllTools()` function in `mcp-tools.ts` — no architectural change to the MCP layer.

---

## Patterns to Follow

### Pattern: Extend ActivityEvents, Don't Replace

The existing `activityEvents` EventEmitter in `activity.service.ts` is already wired to SSE, Discord notifications, and logging. Add the TriggerLoop as another listener in the same pattern used by `EventsController.activityListener`. This keeps all side-effects of state changes in one place.

### Pattern: Stateless Tool, Stateful Inbox

MCP tools are stateless by design (HIGH confidence — MCP spec). Agent state lives in the DB (`AgentTrigger` table), not in the MCP session. Agents poll `get_pending_triggers` at session start and after each task completion.

### Pattern: Identity Propagation Through ApiKey→Agent

The existing `McpAuthInfo` already carries `agentId` and `agentName` from the authenticated API key. Pass `agentId` into all tool calls that need actor context — no separate auth handshake needed. This is the pattern the codebase already uses for `actor_id` in `ActivityLog`.

### Pattern: Debounced DB Write for last_seen_at

Do not write to DB on every MCP tool call. Use a module-level `Map<agentId, lastWriteTime>` in `McpController`. Write `last_seen_at` only if more than 30 seconds have elapsed since the last write. This prevents N writes per second when an agent calls tools in a tight loop.

### Pattern: Optimistic Locking for Ticket Claim

When two agents race to claim the same ticket, use TypeORM's `@VersionColumn()` on Ticket. An agent that loses the race gets an `OptimisticLockVersionMismatchError` and should re-read the ticket. This is sufficient for the single-node case (SQLite + PostgreSQL both support it).

---

## Anti-Patterns to Avoid

### Anti-Pattern: God Orchestrator

Do not build a central service that maintains a work queue, assigns tickets to agents, and tracks completion. AWB is a board, not a scheduler. Agents decide what to work on by reading the board — AWB only routes notifications. This preserves agent autonomy and avoids making AWB a bottleneck.

### Anti-Pattern: Direct Agent-to-Agent HTTP

Do not have one Agent call another Agent's HTTP endpoint via a tool AWB exposes. AWB cannot know or guarantee target agent topology. Use the AgentTrigger inbox pattern so the target agent pulls on its own schedule.

### Anti-Pattern: New MCP Server for Routing

Do not create a second MCP server for agent management. The existing `/mcp` endpoint and `registerAllTools()` pattern is the correct extension point. A second server would require agents to connect twice and split their context.

### Anti-Pattern: Polling Agent.connected_at for Liveness

TCP session presence does not mean the agent is processing. Use `last_seen_at` (recency of tool calls) as the liveness signal, not `connected_at`. An agent may be connected but idle. Route triggers to agents with `last_seen_at` within a configurable window (e.g., 5 minutes).

---

## Suggested Build Order

Dependencies flow downward — each item must be complete before the next.

```
1. Data Model
   └─ Extend Agent entity (roles, connected_at, last_seen_at, webhook_url)
   └─ Extend Ticket entity (reviewer_id, reviewer)
   └─ Add AgentTrigger entity
   └─ Run migrations

2. AgentRegistry Connection Tracking
   └─ Extend McpController.mcpSessions map to carry agentId
   └─ Write/clear Agent.connected_at on session lifecycle
   └─ Debounced last_seen_at update on tool calls
   └─ (Depends on: Data Model)

3. AgentTrigger MCP Tools
   └─ get_pending_triggers, acknowledge_trigger (add to mcp-tools.ts)
   └─ delegate_ticket tool
   └─ (Depends on: AgentTrigger entity)

4. TriggerLoop + RoutingEngine
   └─ New NestJS module: RoutingModule
   └─ Listens to activityEvents, dispatches on column change
   └─ Writes AgentTrigger records
   └─ Optional webhook POST to Agent.webhook_url
   └─ (Depends on: AgentTrigger entity, Agent.roles field)

5. BoardRoutingConfig (optional Phase 2)
   └─ Per-board column→role mapping
   └─ Admin UI to configure
   └─ (Depends on: TriggerLoop working with hardcoded defaults)

6. Admin UI — Agent Connection Dashboard
   └─ Show Agent.connected_at / last_seen_at
   └─ Show pending AgentTriggers per agent
   └─ (Depends on: AgentRegistry, AgentTrigger entity)

7. UI — Ticket Panel Rework (parallel to 4–6)
   └─ Right-panel layout
   └─ reviewer_id field exposure
   └─ Comments section for high-volume agent output
   └─ (No dependency on routing — can build in parallel)
```

---

## Scalability Considerations

| Concern | At current scale (1 workspace, 2-5 agents) | At moderate scale (10 workspaces, 20+ agents) |
|---|---|---|
| Session tracking | In-memory map in McpController is fine | Still fine — sessions are per-process, bounded by TTL cleanup |
| AgentTrigger table | Unindexed is fine, low volume | Index on `(agent_id, acknowledged)` becomes necessary |
| RoutingEngine dispatch | Synchronous in activityEvents handler | Move to NestJS queue (Bull/BullMQ) if dispatch is slow |
| Agent liveness | last_seen_at DB read on dispatch is fine | Cache agent roster in memory with TTL if N dispatches/sec |
| BoardRoutingConfig | Hardcoded defaults, no config table needed | Config table + per-request lookup with in-memory cache |

The existing single-process NestJS architecture can comfortably handle the milestone scope without Redis, queues, or external services. Queue infrastructure is a later concern.

---

## Sources

- Codebase analysis: `apps/server/src/modules/mcp/mcp.controller.ts` (direct read)
- Codebase analysis: `apps/server/src/services/activity.service.ts` (direct read)
- Codebase analysis: `apps/server/src/modules/events/events.controller.ts` (direct read)
- Codebase analysis: `apps/server/src/entities/Agent.ts`, `ApiKey.ts`, `Ticket.ts` (direct read)
- MCP orchestration patterns: [Advanced MCP: Agent Orchestration, Chaining, and Handoffs](https://www.getknit.dev/blog/advanced-mcp-agent-orchestration-chaining-and-handoffs) (MEDIUM confidence)
- Multi-agent delegation patterns: [Microsoft Multi-Agent Reference Architecture](https://microsoft.github.io/multi-agent-reference-architecture/docs/reference-architecture/Patterns.html) (MEDIUM confidence)
- TypeORM concurrency: [Solve Database Concurrency Issues with TypeOrm](https://hackernoon.com/database-concurrencies-with-typeorm-6b1631k8) (MEDIUM confidence)
- NestJS EventEmitter: [NestJS Events documentation](https://docs.nestjs.com/techniques/events) (HIGH confidence)
- Stateless tool design principle: MCP spec — stateless tools, stateful inbox pattern (HIGH confidence from codebase + spec)
