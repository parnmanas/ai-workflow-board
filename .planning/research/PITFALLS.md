# Domain Pitfalls

**Domain:** AI Agent Orchestration / Workflow Automation Platform (NestJS + MCP + Kanban)
**Researched:** 2026-04-08
**Confidence:** HIGH (grounded in existing codebase analysis + verified external sources)

---

## Critical Pitfalls

Mistakes that cause rewrites, data corruption, or silent automation failures.

---

### Pitfall 1: Ticket Ownership Race — Two Agents Claim the Same Ticket

**What goes wrong:** When a ticket transitions to a new column (e.g., "In Review"), the routing system triggers all agents with the Reviewer role simultaneously. Both agents call `move_ticket` or `add_comment` within milliseconds of each other. TypeORM has no optimistic-lock version field on `Ticket` — there is nothing stopping both writes from landing, creating duplicate system comments, duplicate Discord notifications, and inconsistent column state.

**Why it happens:** The current `Ticket` entity has no `version` column. The existing MCP tools execute `ticketRepo.save()` directly with no concurrency guard. Once role-based routing fires events, multiple agents will race to claim ownership of the same ticket.

**Consequences:**
- Duplicate system comments per ticket transition
- Discord notification surge (two notifications for one state change)
- Agent A moves ticket to Done while Agent B is still processing — work is lost
- Audit log shows contradictory state transitions with no clear winner

**Warning signs:**
- Activity log shows two "moved" entries within 500ms of each other for the same ticket
- Discord channel receives identical messages seconds apart
- Comment count on tickets grows faster than expected

**Prevention:**
- Add a `@VersionColumn()` to the `Ticket` entity (TypeORM optimistic locking). Any agent attempting to update a stale version receives a `OptimisticLockVersionMismatchError` and must re-query before retrying.
- For the routing trigger: store a `claimed_by_agent_id` field on Ticket or use a dedicated `AgentTicketLock` table with a unique constraint on `(ticket_id, role)`. The first INSERT wins; all others get a unique constraint error they can handle gracefully.
- Idempotency: routing trigger events should carry a unique `trigger_id`. The target agent checks if it already acted on this `trigger_id` before doing anything.

**Phase mapping:** Address in the Agent Connection Management + Role Routing phase — before any routing logic ships. Retrofitting locking after routing is live is painful.

---

### Pitfall 2: In-Memory MCP Session Store Breaks Agent Connection Tracking

**What goes wrong:** The current `mcp-server.ts` stores all sessions in `Map<string, { transport, server, lastActivity }>` (lines 99-103). The new "agent connection management" feature needs to track which agents are online and correlate MCP sessions to Agent entities. If this mapping lives only in memory, a server restart wipes all "connected" state — the UI shows zero connected agents even though agents are actively polling. Worse, multiple server instances (or a future load balancer) each have their own session pool with no shared visibility.

**Why it happens:** The MCP SDK's `Streamable HTTP` transport is inherently stateful — sessions are created per HTTP initialization and assigned a session ID. The codebase already acknowledges this as a fragile area (CONCERNS.md: "MCP Session Management in HTTP Mode"). Adding connection tracking on top of this fragility without persistence makes the feature unreliable.

**Consequences:**
- Agent online/offline status is wrong after any restart
- Health monitoring dashboards show stale data
- Routing logic that gates on "is this agent connected?" will refuse to route even when the agent is live

**Warning signs:**
- Agent shows as offline immediately after server deploy
- Session count metrics drop to zero then slowly climb back
- Logs show "session not found" errors for valid agent connections

**Prevention:**
- Persist connection state to the database, not to memory. A lightweight `AgentSession` table with `{ session_id, agent_id, api_key_id, connected_at, last_ping_at, status }` survives restarts and can be queried by the routing system.
- On MCP session creation (`POST /mcp` initialization): upsert a row in `AgentSession`. On session cleanup or DELETE `/mcp`: mark as disconnected.
- Treat the memory Map as a cache only — authoritative state lives in the DB.
- Add a periodic "heartbeat" MCP tool (`ping`) that agents call to keep their session alive; stale rows older than 2× heartbeat interval are marked offline by a cleanup job.

**Phase mapping:** Foundation of the connection management feature. Must be resolved before building any UI that shows agent status.

---

### Pitfall 3: Trigger Storms — One Ticket Move Fires Cascading Notifications

**What goes wrong:** The existing notification pipeline is unbounded (CONCERNS.md: "Notification Queue is Unbounded"). Activity events fire immediately with no queue. When a ticket moves column and triggers the next role's agent, that agent may move the ticket again (completing its work), which fires another activity event, which triggers another agent — a cascade. With parent/child ticket relationships, moving a parent ticket can touch dozens of children, each generating their own events. Discord receives a flood of messages, rate limits fire, and the single-retry Discord service starts dropping notifications.

**Why it happens:** `activityEvents` is a synchronous EventEmitter. Every listener (`NotificationService`, `SystemCommentService`) fires inline. There is no backpressure, no deduplication window, and no per-ticket serialization. The Discord service has a hard 10-second retry cap that cannot absorb real rate-limit backoffs.

**Consequences:**
- Discord rate limit 429s during busy periods; notifications silently dropped
- Trigger loop: Agent A finishes → triggers Agent B → B finishes quickly → triggers Agent C → all three active simultaneously on related tickets
- ActivityLog fills with duplicated entries; performance degrades (CONCERNS.md: N+1 query in board retrieval compounds under load)

**Warning signs:**
- Discord channel shows bursts of 10+ messages within 2 seconds during ticket transitions
- ActivityLog row count grows 5-10x faster than ticket count
- Server CPU spikes during multi-ticket batch operations

**Prevention:**
- Gate automated triggers behind a per-ticket debounce/cooldown. After a ticket transitions and a trigger fires, lock that ticket from re-triggering for N seconds (configurable, default 30s). Store cooldown state in the DB, not memory.
- Implement a trigger queue (even a simple DB table with `{ ticket_id, target_role, trigger_id, status, scheduled_at }`) processed by a polling worker. This adds backpressure and makes every trigger auditable.
- For Discord: replace the current single-retry with exponential backoff + queue. Notifications for the same channel within a 5-second window should be coalesced into one message.

**Phase mapping:** Address in the automated trigger phase. Do not ship triggers without the cooldown gate — the storm scenario will manifest in the first integration test.

---

### Pitfall 4: Role-Based Routing Without Workspace Scoping Leaks Tickets Across Workspaces

**What goes wrong:** The routing logic will query "find all agents with role X" to dispatch a trigger. If that query does not filter by workspace, an agent registered in Workspace A will receive triggers for tickets from Workspace B. The `AgentChannelIdentity` entity provides workspace-level identity, but the planned routing uses Assignee/Reporter/Reviewer roles on tickets — it is not yet clear how role assignment is scoped. If role assignment is global (per agent) rather than per-workspace, cross-workspace leakage is certain.

**Why it happens:** The current `Agent` entity has no workspace_id. The `ApiKey` entity has no workspace_id. Role assignment does not exist yet and will likely be added to either Agent or Ticket without careful scoping. Multi-workspace support is already a validated requirement but was designed before role-based routing existed.

**Consequences:**
- Agent for Project A processes tickets from Project B (data leakage)
- In a shared-infrastructure deployment, competitor/client data mixing
- Debugging becomes extremely difficult because routing "works" but fires in wrong workspace

**Warning signs:**
- Agent receives triggers for tickets it has no context for
- Discord notifications go to wrong channels
- Audit log shows agent actions on tickets from unexpected boards

**Prevention:**
- Any routing query must include `WHERE workspace_id = ?` as a mandatory, non-optional clause. Never use a generic "find agent by role" without workspace scope.
- When designing the role-assignment schema, make workspace_id a required field from day one. Consider: `TicketRoleAssignment { ticket_id, agent_id, workspace_id, role }` — the workspace_id is redundant but acts as a safety fence enforced by a DB check constraint or foreign key chain.
- Add an integration test that creates two workspaces with the same role agent configuration and verifies zero cross-workspace trigger firing.

**Phase mapping:** Design decision that must be made before any role schema is created. Retrofitting workspace scoping onto a global role table is a migration with high regression risk.

---

### Pitfall 5: Subagent Delegation Without Conflict Prevention Corrupts Ticket State

**What goes wrong:** A primary agent spawns subagents to process multiple tickets in parallel. Each subagent independently calls `move_ticket`, `update_ticket`, and `add_comment`. If two subagents happen to be assigned the same ticket (due to a race in the delegation logic, or a bug in the primary agent's decomposition), both will write to the same ticket concurrently. TypeORM's `save()` is not atomic at the application layer — the last write wins silently.

Beyond same-ticket conflicts: if subagent A updates a parent ticket while subagent B updates a child ticket, the breadcrumb/hierarchy traversal in `NotificationService.getTicketHierarchy()` may walk a partially-updated hierarchy, generating wrong breadcrumbs in system comments.

**Why it happens:** The subagent delegation is a new pattern for this codebase. The MCP tools were designed for single-agent sequential use. There are no idempotency keys on MCP tool calls, no per-ticket mutexes, and no mechanism to prevent two MCP sessions from acting on the same ticket simultaneously.

**Consequences:**
- Ticket ends in wrong column because two subagents moved it to different destinations
- System comments show impossible state transitions (e.g., "moved from Review to Done" and "moved from In Progress to Done" for the same ticket)
- Parent ticket hierarchy shows inconsistent breadcrumbs

**Warning signs:**
- Two "moved" activity logs for the same ticket within the same second
- System comment text includes impossible column names (column that doesn't exist in current board state)
- Agent reports success on a ticket that another agent already closed

**Prevention:**
- Add an idempotency key parameter to all ticket-mutating MCP tools (`create_ticket`, `move_ticket`, `update_ticket`). The key is stored in ActivityLog; duplicate keys within a TTL window are rejected with a clear error.
- Implement a lightweight ticket lock via the `AgentSession` table: add `locked_ticket_ids JSONB` (or a separate `TicketLock` table). A subagent claims a lock before mutating; any other session attempting to mutate the same ticket receives "ticket locked by session X". Lock is released on comment/move completion or session expiry.
- Document the expected delegation contract in MCP tool descriptions: "primary agent should not delegate the same ticket_id to multiple subagents simultaneously."

**Phase mapping:** Subagent delegation phase. Do not ship parallel subagent support without the idempotency key pattern at minimum.

---

## Moderate Pitfalls

---

### Pitfall 6: EventEmitter Listener Accumulation Under Long-Running Sessions

**What goes wrong:** `NotificationService` and `SystemCommentService` register listeners on `activityEvents` in `onModuleInit`. Under long-running server processes with frequent module reloads (e.g., hot-reload in development, or test suite runs), listeners accumulate without being removed. Node.js emits `MaxListenersExceededWarning` at 11 listeners. In production, the leak is slower but real — each unremoved listener holds references to repository instances, preventing GC.

**Existing debt:** CONCERNS.md explicitly documents this as "EventEmitter Memory Leak Risk."

**Prevention:**
- Before adding more `onModuleInit` listeners for the connection tracking and trigger features, fix the existing listener tracking. Create a `ListenerRegistry` singleton that stores references: `{ emitter, event, handler }`. `onModuleDestroy` iterates the registry and calls `emitter.removeListener(event, handler)` for each.
- Use `emitter.once()` for single-fire events (e.g., initial handshake notifications). Use `emitter.on()` with explicit teardown only for persistent subscriptions.
- Add a test that initializes and destroys the NestJS module 5 times and asserts `activityEvents.listenerCount('activity') === 0` after each destroy.

**Phase mapping:** Pre-existing debt; address in Phase 1 setup before adding more listeners.

---

### Pitfall 7: API Key Scope Unenforced — Agents Can Do Anything

**What goes wrong:** The `ApiKey` entity has a `scope` field defaulting to `'full'`, but CONCERNS.md confirms scopes are never validated at request time. Once role-based routing is added, an agent assigned as "Reviewer" should only be able to use reviewer-appropriate tools. Without scope enforcement, a Reviewer agent can call `delete_ticket`, `create_workspace`, or any other tool — either accidentally or maliciously.

**Prevention:**
- Define scope constants before shipping role-based routing: `'read'`, `'comment'`, `'move'`, `'admin'`. Map each MCP tool to a minimum required scope.
- Enforce scope in the MCP auth guard: after verifying the API key, check that the key's scope includes the minimum scope for the requested tool.
- This also closes the security concern in CONCERNS.md and enables future per-role permission restrictions without schema changes.

**Phase mapping:** Role-routing phase. Scope enforcement is the prerequisite for meaningful role separation.

---

### Pitfall 8: SSE Race Condition Worsens Under Agent-Driven Load

**What goes wrong:** The existing SSE race condition (CONCERNS.md: "SSE Race Condition on Rapid Activity") is currently masked by the 300ms client-side debounce. With agents autonomously processing tickets, the event rate will increase by an order of magnitude — agents move tickets, add comments, and trigger sub-actions all without human pacing. The debounce mask will fail. The UI will miss events, show stale board state, and users will see tickets "snap" to wrong positions.

**Prevention:**
- Replace the global debounce in `useBoard.ts` with an event queue that coalesces events per-board: collect all board events within a 200ms window, then fire one refresh. This is distinct from dropping events (current behavior) — every event updates the queue's "needs refresh" flag.
- Server-side: assign a monotonic sequence number to every SSE event. The client tracks the last received sequence and requests a full board resync if it detects a gap (missed events).

**Phase mapping:** UI redesign phase (right panel). The right panel will display comments and subtask navigation that depends on consistent board state — fix the SSE reliability before building the new panel.

---

### Pitfall 9: Ticket Hierarchy Depth Breaks Subagent Navigation

**What goes wrong:** CONCERNS.md documents hardcoded 3-level depth in ticket hierarchy loading. Subagent delegation patterns commonly create deeper hierarchies: a primary ticket spawns implementation tickets, which spawn sub-implementation tickets. At level 4+, subtasks are invisible to the MCP tools and to the board UI. An agent creates a subtask at depth 4, considers it done, but the system never shows or routes it.

**Prevention:**
- Before subagent delegation ships, fix the hierarchy loading to be recursive (PostgreSQL `WITH RECURSIVE` CTE, or iterative traversal for SQLite).
- Add a configurable `MAX_HIERARCHY_DEPTH` constant (default: 5, not hardcoded 3) with validation in the ticket creation MCP tool.

**Phase mapping:** Subagent delegation phase or earlier. Any parent/child subtask navigation UI also depends on this fix.

---

## Minor Pitfalls

---

### Pitfall 10: MCP Tool Descriptions Mislead Agent Behavior

**What goes wrong:** MCP tool descriptions are the primary interface through which agents decide what tools to call and in what order. Vague or incomplete descriptions cause agents to use tools incorrectly — calling `move_ticket` before `add_comment` completes, or not knowing they need to set `assignee_id` before triggering the next role. This is especially dangerous in automated routing where no human reviews each tool call.

**Prevention:**
- Treat every MCP tool description as a behavioral contract: specify preconditions ("call this only after ticket is in column X"), postconditions ("after calling this, the ticket will be in column Y"), and side effects ("this triggers a Discord notification").
- Add explicit "do not call when" notes for tools that have concurrency risks.
- Review all 33 existing tool descriptions before adding routing-related tools.

**Phase mapping:** Before any new MCP tools are added for connection management or routing.

---

### Pitfall 11: Right Panel UI Diverges from Board State During Agent Updates

**What goes wrong:** The new right panel shows ticket detail, subtask navigation, and comments. If an agent updates a ticket while the user has it open in the right panel, the panel will show stale data (current modal behavior already has this problem). With agents autonomously adding comments at high frequency, the panel needs a live-update strategy, not just an initial load.

**Prevention:**
- The right panel should subscribe to the same SSE event stream as the board and re-fetch ticket detail on any `ticket.updated` event for the currently-displayed ticket_id.
- Comment list should support incremental appending (append new comments from SSE event payload) rather than full re-fetch, to avoid janky reloads when an agent is posting rapidly.

**Phase mapping:** UI redesign phase.

---

### Pitfall 12: TypeORM Schema Drift Between SQLite and PostgreSQL

**What goes wrong:** New entities for connection tracking (`AgentSession`, `TicketLock`, role assignment tables) will be created with TypeORM entity definitions. `synchronize: true` is enabled in development (SQLite) but disabled in production (PostgreSQL). Schema divergence between the two databases will cause silent failures: a column exists in SQLite during development, the code depends on it, then the production PostgreSQL deploy crashes because the migration was never written.

**Prevention:**
- Write explicit TypeORM migration files for every new entity/column added in this milestone. Never rely on `synchronize: true` for milestone features.
- Test migrations against a local PostgreSQL instance before merging.
- Use column types that exist in both SQLite and PostgreSQL (avoid `JSONB` without a fallback — use `text` with JSON serialization for dual-DB compatibility, matching the existing pattern in the codebase).

**Phase mapping:** Any phase that introduces new database entities.

---

## Phase-Specific Warnings

| Phase Topic | Likely Pitfall | Mitigation |
|---|---|---|
| Agent connection management | In-memory session store (Pitfall 2) | Persist AgentSession to DB from day one |
| Role-based routing schema | Missing workspace scope (Pitfall 4) | Add workspace_id as non-nullable FK to role tables |
| Automated trigger on column move | Trigger storm (Pitfall 3) | Per-ticket cooldown gate before any trigger fires |
| Subagent delegation | Same-ticket concurrent mutation (Pitfall 5) | Idempotency keys on all mutating MCP tools |
| Subagent delegation | Hierarchy depth limit (Pitfall 9) | Fix recursive hierarchy loading before shipping delegation |
| Right panel UI | Stale panel under agent load (Pitfall 11) | SSE subscription in panel component before launch |
| Any new MCP tools | Scope unenforced (Pitfall 7) | Define and enforce tool scope map before new tools ship |
| All phases with DB changes | SQLite/PostgreSQL schema drift (Pitfall 12) | Write TypeORM migrations for every new entity |

---

## Sources

- Codebase analysis: `.planning/codebase/CONCERNS.md` (2026-04-08)
- [When AI Agents Collide: Multi-Agent Orchestration Failure Playbook 2026](https://cogentinfo.com/resources/when-ai-agents-collide-multi-agent-orchestration-failure-playbook-for-2026)
- [Six Fatal Flaws of the Model Context Protocol (MCP)](https://www.scalifiai.com/blog/model-context-protocol-flaws-2025)
- [Multi-agent workflows often fail: GitHub Engineering Blog](https://github.blog/ai-and-ml/generative-ai/multi-agent-workflows-often-fail-heres-how-to-engineer-ones-that-dont/)
- [MCP Transport Future: Official MCP Blog](https://blog.modelcontextprotocol.io/posts/2025-12-19-mcp-transport-future/)
- [Agents Need Durable Workflows and Strong Guarantees](https://stack.convex.dev/durable-workflows-and-strong-guarantees)
- [How to Implement Webhook Idempotency](https://hookdeck.com/webhooks/guides/implement-webhook-idempotency)
- [Multi-Agent Coordination Strategies: Galileo](https://galileo.ai/blog/multi-agent-coordination-strategies)
- [NestJS EventEmitter Memory Leak — GitHub Issue #11601](https://github.com/nestjs/nest/issues/11601)
- [Optimistic Locking in JPA — Baeldung](https://www.baeldung.com/jpa-optimistic-locking)
