# Project Research Summary

**Project:** AI Workflow Board (AWB) -- Agent Connection Management Milestone
**Domain:** AI Agent Orchestration / Kanban-based Workflow Automation Platform (NestJS + MCP + React)
**Researched:** 2026-04-08
**Confidence:** HIGH

## Executive Summary

AWB is an MCP-based kanban board that coordinates AI agents through structured ticket workflows. The milestone adds the coordination layer that makes autonomous multi-agent operation viable: agents register their presence and role at connection time, tickets carry routing metadata (assignee/reporter/reviewer), and column transitions automatically trigger the appropriate next agent via a durable inbox pattern. All four research files converge on the same architectural conclusion: extend existing infrastructure conservatively rather than introduce new infrastructure layers. The codebase already has MCP session management, SSE event streaming, an activity EventEmitter, and API-key-to-Agent identity resolution. Every new capability layers onto these foundations without replacing them.

The recommended approach is a strict dependency-ordered build: data model first, then AgentRegistry connection tracking, then the RoutingEngine/TriggerLoop, then the UI panel redesign -- with subagent delegation and the agent session dashboard as the final milestone deliverables. The only new packages required are `@nestjs/event-emitter@3.0.1` (typed in-process event bus), `react-resizable-panels` (right-panel split layout), and `zustand@^5.0.12` (shared agent status state on the frontend). Socket.IO, BullMQ, and Redis are explicitly excluded -- the single-process NestJS architecture does not need them.

The primary risk profile is data integrity under concurrent agent operation. Three pitfalls must be addressed before any routing logic ships: ticket ownership races (no `@VersionColumn` on Ticket today), trigger storms from unbounded ActivityEvents cascades, and workspace scope leakage in role queries. These are not hypothetical -- the existing CONCERNS.md documents the unbounded notification queue and SSE race condition as pre-existing debt. Adding autonomous agents without these guards in place will manifest immediately in the first integration test.

---

## Key Findings

### Recommended Stack

The existing stack is fully locked (NestJS 11, React 18, TypeORM 0.3.20, MCP SDK 1.29.0, PostgreSQL/SQLite, Turbo/Vite). No runtime or framework changes are permitted or needed. Three additions are justified:

**Core technologies to add:**
- `@nestjs/event-emitter@3.0.1` -- typed in-process routing event bus -- separates routing concerns from the untyped `activityEvents` audit bus; official NestJS package with 370 dependents
- `react-resizable-panels` (latest stable, verify 4.x API before pinning) -- kanban+detail split layout -- zero production dependencies, maintained by React core team member, used by shadcn/ui official Resizable primitive
- `zustand@^5.0.12` -- frontend agent connection state -- 20M weekly downloads, 1.2KB bundle, no Provider boilerplate, correct fit for cross-component agent status tracking

**Schema additions (no new packages required):**
- `Ticket`: add `reviewer_id`, `reviewer`, `locked_by_agent_id`, `locked_at`
- `Agent`: add `roles` (JSON array), `connected_at`, `last_seen_at`, `webhook_url`, `workspace_id`
- New entity: `AgentTrigger` -- durable inbox for routing triggers (survives agent disconnect/restart)

**New NestJS providers (no new packages):**
- `AgentConnectionService` -- in-memory Map of live sessions keyed on `agentId`
- `AgentRoutingService` -- consumes `TicketRoleTriggered` events, resolves target agent by role, writes `AgentTrigger` records

**Do not add:** Socket.IO, BullMQ/Bull + Redis, ioredis, react-query, allotment, typeorm-optimistic-locking

### Expected Features

**Must have (table stakes) -- ship in this milestone:**
- Agent connection state visibility -- connected_at, last_seen_at per agent; DB-backed to survive server restart
- Role-based ticket routing (Assignee/Reporter/Reviewer) -- `reviewer_id` field on Ticket + role filter on `get_my_tickets` MCP tool
- Automatic trigger on ticket column transition -- emit to next role's agent; gated by per-ticket cooldown to prevent storms
- Ticket lock/claim mechanism -- `locked_by_agent_id` + `locked_at` on Ticket; MCP tools `awb_lock_ticket`/`awb_unlock_ticket`
- Subagent delegation model -- `delegate_ticket` MCP tool writes `AgentTrigger` for target agent; AWB is broker, never direct caller
- Right panel ticket detail UI -- replace center modal with resizable right panel
- Subtask click-through navigation -- frontend routing/state change within the right panel
- Comments section redesigned for agent volume -- collapsible groups, agent/human distinction, SSE-driven incremental append

**Should have (differentiators) -- defer to follow-on milestone:**
- Agent session dashboard -- observability UI; agents can operate without it
- `get_my_tickets` MCP tool -- role-filtered ticket list; reduces LLM context consumption significantly
- Automation loop audit trail -- augment ActivityLog with role context and trigger source
- Role assignment UI -- initial version uses admin config or env vars
- Webhook/event trigger endpoint -- external CI/monitoring integration

**Defer to v2+:**
- Agent execution engine, chat interface, full OAuth2 agent auth, per-ticket SLA enforcement, multi-board routing, agent memory/vector store

### Architecture Approach

Three new components layer onto existing infrastructure without replacing it. `AgentRegistry` extends the existing `mcpSessions` Map and `Agent` entity to track connection state -- DB-backed so state survives restarts, with a 30-second debounced write to avoid thrashing. `RoutingEngine` listens to `activityEvents` via a `TriggerLoop` NestJS service and dispatches `AgentTrigger` DB records when a ticket changes column. The `AgentTrigger` inbox pattern is central: agents poll `get_pending_triggers` at session start and post-task; AWB never pushes to agent processes that may have exited.

**Major components:**
1. `AgentRegistry` (AgentConnectionService + DB fields on Agent) -- tracks which agents are live, their roles, and last-seen recency
2. `RoutingEngine` (AgentRoutingService + TriggerLoop) -- column-change listener that writes durable AgentTrigger records and optionally calls agent webhook_url
3. `AgentTrigger` entity + MCP tools (`get_pending_triggers`, `acknowledge_trigger`, `delegate_ticket`, `get_agent_roster`, `update_agent_role`) -- the durable inbox decoupling AWB dispatch from agent availability
4. UI: right panel (react-resizable-panels + zustand) -- persistent ticket detail/subtask/comments panel replacing the center modal

**Key patterns:**
- Stateless MCP tools, stateful DB inbox -- never assume an agent process is alive
- Identity propagation through ApiKey->Agent -- `McpAuthInfo.agentId` is resolved at auth time; pass into all tool calls
- Extend ActivityEvents, do not replace -- add TriggerLoop as another listener in the same pattern as EventsController
- Debounced DB write for `last_seen_at` -- max one write per 30 seconds per agent

**Anti-patterns explicitly avoided:**
- God orchestrator (AWB is a board/router, not a scheduler)
- Direct agent-to-agent HTTP through AWB
- Second MCP server for routing
- Polling `connected_at` for liveness (use `last_seen_at` recency instead)

### Critical Pitfalls

1. **Ticket ownership race** -- No `@VersionColumn` on Ticket today; two agents triggered simultaneously will corrupt state. Add `@VersionColumn()` to Ticket AND unique constraint on `(ticket_id, role)` in lock table before any routing ships.

2. **Trigger storms** -- Unbounded `activityEvents` pipeline: agent A finishes, triggers B, B finishes, triggers C; parent/child tickets multiply the fan-out. Discord rate limits fire; notifications drop. Per-ticket cooldown gate (30s, stored in DB) is mandatory before triggers ship.

3. **Workspace scope leakage in role queries** -- "Find agents with role X" without WHERE workspace_id clause leaks tickets across workspaces. workspace_id is a non-nullable required field on all role-assignment schema from day one.

4. **In-memory session store breaks connection tracking** -- Server restart wipes connected state; routing gates on liveness refuse to route even when agents are live. Persist `connected_at`/`last_seen_at` to DB from day one; treat in-memory Map as cache only.

5. **Subagent concurrent mutation** -- Two subagents on overlapping tickets; TypeORM `save()` is last-write-wins. Idempotency key parameter on all ticket-mutating MCP tools (stored in ActivityLog; duplicate keys within TTL rejected) before parallel subagent support ships.

---

## Implications for Roadmap

The dependency graph is clear and rigid. The UI redesign is the only work that can proceed in parallel with backend phases.

### Phase 1: Data Model Foundation
**Rationale:** Every subsequent feature requires the new schema fields. TypeORM migrations must be written explicitly (not relying on `synchronize: true`) to avoid SQLite/PostgreSQL drift. This phase also clears pre-existing debt: `@VersionColumn()` on Ticket and EventEmitter `ListenerRegistry` for teardown -- both must be done before adding more listeners.
**Delivers:** `reviewer_id`/`reviewer`/`locked_by_agent_id`/`locked_at` on Ticket; `roles`/`connected_at`/`last_seen_at`/`webhook_url`/`workspace_id` on Agent; `AgentTrigger` entity; TypeORM migrations for all new fields.
**Addresses:** Pitfall 1 (`@VersionColumn` added here), Pitfall 6 (EventEmitter leak cleanup before adding listeners), Pitfall 12 (explicit migrations prevent schema drift).

### Phase 2: AgentRegistry -- Connection Tracking
**Rationale:** All routing, routing UI, and trigger logic depend on knowing which agents are connected and what roles they hold. Identity resolution must be complete end-to-end before dispatch logic runs.
**Delivers:** Extended `mcpSessions` Map with `agentId`, write/clear `Agent.connected_at` on session lifecycle, debounced `last_seen_at` updates, `AgentConnectionService` NestJS provider, basic admin endpoint exposing agent roster.
**Implements:** AgentRegistry component.
**Avoids:** Pitfall 2 (DB is authoritative, not memory), Pitfall 4 (workspace_id on all agent queries).

### Phase 3: RoutingEngine + TriggerLoop
**Rationale:** Depends on Phase 2 AgentRegistry and Phase 1 `AgentTrigger` entity. Delivers the core automation loop.
**Delivers:** `TriggerLoop` NestJS service, `AgentRoutingService`, `AgentTrigger` DB writes, optional webhook POST to `Agent.webhook_url`, hardcoded BoardRoutingConfig defaults, MCP tools: `get_pending_triggers`, `acknowledge_trigger`, `delegate_ticket`, `get_agent_roster`, `update_agent_role`.
**Implements:** RoutingEngine and TriggerLoop components.
**Avoids:** Pitfall 3 (per-ticket cooldown gate ships with this phase -- mandatory), Pitfall 4 (workspace_id in all routing queries), Pitfall 7 (API key scope enforcement before new tools ship), Pitfall 10 (MCP tool descriptions reviewed before shipping).

### Phase 4: Subagent Delegation
**Rationale:** Depends on Phase 3 routing (AgentTrigger inbox is the delivery mechanism) and Phase 1 locking fields. Parallel subagent processing is unsafe without idempotency and the full locking model.
**Delivers:** `awb_lock_ticket`/`awb_unlock_ticket` MCP tools, lock TTL cleanup job, idempotency key parameter on all ticket-mutating MCP tools, delegation contract documentation in tool descriptions, recursive ticket hierarchy loading (replaces hardcoded 3-level depth).
**Avoids:** Pitfall 5 (concurrent mutation -- idempotency keys), Pitfall 9 (hierarchy depth breaks subagent navigation -- must fix before shipping delegation).

### Phase 5: UI Redesign -- Right Panel (parallel to phases 2-4)
**Rationale:** No data dependencies on backend phases 2-4; can be developed in a parallel frontend track. Must land before the agent session dashboard. SSE race condition fix is required alongside this phase.
**Delivers:** react-resizable-panels horizontal split (65/35 default, collapsible), subtask click-through navigation, comments redesigned for agent volume (SSE-driven incremental append), zustand store for agent connection status, SSE event queue with per-board coalescing replacing the global 300ms debounce.
**Uses:** `react-resizable-panels`, `zustand`.
**Avoids:** Pitfall 8 (SSE race worsens under agent load -- coalescing queue), Pitfall 11 (stale panel under agent updates -- SSE subscription in panel component).

### Phase 6: Agent Session Dashboard + BoardRoutingConfig
**Rationale:** Reads from all previous phases; build after routing is proven stable. `BoardRoutingConfig` replaces hardcoded column->role defaults from Phase 3.
**Delivers:** Read-only agent session dashboard (connected agents, roles, last_seen_at, pending AgentTrigger count), `BoardRoutingConfig` entity + admin UI, role assignment UI, `get_my_tickets` MCP tool (role-filtered).
**Avoids:** Pitfall 4 (workspace scoping verified end-to-end in dashboard queries).

### Phase Ordering Rationale

- Data model first because schema changes require explicit TypeORM migrations and workspace scope cannot be retrofitted safely once routing queries exist
- AgentRegistry before RoutingEngine because routing queries which agents have a given role and are alive have no answer without connection state
- RoutingEngine before Subagent Delegation because AgentTrigger inbox is the delegation delivery mechanism
- UI parallel to backend phases 2-4 because no data dependencies exist between right-panel layout work and routing infrastructure
- Dashboard last because it is a read layer on top of completed write infrastructure

### Research Flags

Phases likely needing deeper research during planning:
- **Phase 3 (RoutingEngine):** Per-ticket cooldown window values and trigger deduplication design need tuning against real agent call rates. Consider a short spike before committing to the trigger architecture.
- **Phase 4 (Subagent Delegation):** Idempotency key design in MCP tool calls is not well-documented. ActivityLog-based deduplication approach needs implementation review against existing ActivityLog schema before committing to it.
- **Phase 6 (BoardRoutingConfig):** Column name matching (string vs. FK to BoardColumn.id) has edge cases when columns are renamed. Pre-decide in Phase 3 to avoid a Phase 6 migration.

Phases with standard patterns (skip research-phase):
- **Phase 1 (Data Model):** TypeORM entity extension and migration authoring -- well-documented, clear patterns already in the codebase.
- **Phase 2 (AgentRegistry):** In-memory Map + DB upsert pattern -- direct extension of existing McpController pattern.
- **Phase 5 (UI Redesign):** react-resizable-panels and zustand are well-documented with abundant examples; shadcn/ui Resizable provides copy-paste patterns.

---

## Confidence Assessment

| Area | Confidence | Notes |
|------|------------|-------|
| Stack | HIGH | All package versions verified on npm; existing stack constraints confirmed from direct codebase read. Only uncertainty: react-resizable-panels 4.9.0 was 21 hours old at research time -- verify API compatibility on install. |
| Features | HIGH | Table stakes derived from PROJECT.md + Azure Architecture Center multi-agent patterns. Differentiators at MEDIUM (community sources). Anti-features at HIGH (project constraints + MCP roadmap). |
| Architecture | HIGH | Derived from direct codebase analysis of mcp.controller.ts, activity.service.ts, events.controller.ts, Agent.ts, Ticket.ts. All patterns are extensions of existing code, not speculative. |
| Pitfalls | HIGH | Grounded in CONCERNS.md (existing documented debt) + multi-agent orchestration failure patterns from GitHub Engineering Blog, Convex, and Galileo. All 5 critical pitfalls confirmed by multiple independent sources. |

**Overall confidence:** HIGH

### Gaps to Address

- **react-resizable-panels exact version:** 4.9.0 was 21 hours old at research time; changelog shows breaking API changes 2.x->3.x->4.x. Pin to known-stable version after install-time verification.
- **BoardRoutingConfig column name matching:** String match vs. FK to BoardColumn.id has rename edge cases. Pre-decide in Phase 3 to avoid a Phase 6 migration.
- **AgentTrigger `expires_at` TTL value:** ARCHITECTURE.md defines the field but does not specify the default TTL or cleanup job interval. Needs a concrete value before Phase 3 ships.
- **Idempotency key storage in ActivityLog:** PITFALLS.md recommends ActivityLog-based deduplication but the existing ActivityLog schema may need a new indexed column. Verify before committing to this approach in Phase 4.

---

## Sources

### Primary (HIGH confidence)
- Codebase direct analysis: `apps/server/src/modules/mcp/mcp.controller.ts`, `activity.service.ts`, `events.controller.ts`, `entities/Agent.ts`, `entities/ApiKey.ts`, `entities/Ticket.ts`
- `.planning/codebase/CONCERNS.md` -- existing known debt
- NestJS SSE official docs: https://docs.nestjs.com/techniques/server-sent-events
- NestJS EventEmitter official docs: https://docs.nestjs.com/techniques/events
- `@nestjs/event-emitter@3.0.1` on npm (verified)
- `zustand@5.0.12` on npm (verified)
- `react-resizable-panels@4.9.0` on npm (verified, version age caveat noted)
- MCP Streamable HTTP spec: https://modelcontextprotocol.io/specification/2025-03-26/basic/transports

### Secondary (MEDIUM confidence)
- Azure Architecture Center -- AI Agent Design Patterns (Feb 2026): https://learn.microsoft.com/en-us/azure/architecture/ai-ml/guide/ai-agent-design-patterns
- Microsoft Multi-Agent Reference Architecture: https://microsoft.github.io/multi-agent-reference-architecture/docs/reference-architecture/Patterns.html
- GitHub Engineering Blog -- Multi-agent workflow failures: https://github.blog/ai-and-ml/generative-ai/multi-agent-workflows-often-fail-heres-how-to-engineer-ones-that-dont/
- Convex -- Durable workflows: https://stack.convex.dev/durable-workflows-and-strong-guarantees
- Galileo -- Multi-agent coordination strategies: https://galileo.ai/blog/multi-agent-coordination-strategies
- MCP Advanced Orchestration: https://www.getknit.dev/blog/advanced-mcp-agent-orchestration-chaining-and-handoffs

### Tertiary (LOW confidence)
- Vibe Kanban feature analysis -- differentiators section: https://vibekanban.com/
- KaibanJS patterns -- differentiators section
- State management in 2026 (dev.to): https://dev.to/jsgurujobs/state-management-in-2026-zustand-vs-jotai-vs-redux-toolkit-vs-signals-2gge

---
*Research completed: 2026-04-08*
*Ready for roadmap: yes*
