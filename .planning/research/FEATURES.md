# Feature Landscape

**Domain:** AI Agent Orchestration / Kanban-based Workflow Automation Platform
**Researched:** 2026-04-08
**Milestone Context:** Adding agent connection management, role-based routing (Assignee/Reporter/Reviewer), subagent delegation, and UI panel redesign to existing kanban board.

---

## Current Baseline (Already Exists)

These are already validated and shipped. Not on the milestone scope, but important context.

| Feature | Status |
|---------|--------|
| Kanban board with column-based ticket management | Exists |
| MCP server (33 tools, Streamable HTTP) | Exists |
| Agent can move tickets across columns | Exists |
| Multi-workspace support | Exists |
| Parent/children hierarchical tickets (3 levels) | Exists |
| Discord channel notifications | Exists |
| API key-based agent authentication | Exists |
| Comment system (agent + user) | Exists |
| Activity log | Exists |
| Agent entity with channel identity mapping | Exists |
| Ticket has assignee_id and reporter_id fields | Exists |

---

## Table Stakes

Features users expect from an AI agent workflow platform. Missing any of these makes the system feel unreliable or incomplete.

| Feature | Why Expected | Complexity | Notes |
|---------|--------------|------------|-------|
| **Agent connection state visibility** | Without knowing which agents are connected/active, users cannot tell if automation is running. Blind operation. | Medium | Needs: connected_at, last_seen, connection_count per agent session. Not full OAuth — just presence tracking via heartbeat. |
| **Role-based ticket routing (Assignee/Reporter/Reviewer)** | The entire value proposition of sequential agent handoff requires agents to receive only their scoped tickets. Without this, every agent sees every ticket — no specialization. | Medium | Ticket already has `assignee_id` and `reporter_id`. Need: `reviewer_id`, role-to-agent mapping, and filtered MCP tool responses. |
| **Automatic trigger on ticket state change** | Sequential orchestration (Reporter creates → Assignee executes → Reviewer checks) requires that completing a phase automatically notifies the next agent. Without this, the chain is manual. | High | Core to the "continuous automation loop" in PROJECT.md. Requires event emission + agent notification channel. |
| **Ticket lock / claim mechanism** | When multiple agent instances connect, two subagents must not process the same ticket simultaneously. Without locking, data corruption and duplicate work occur. | Medium | A `locked_by` field + lock timestamp on Ticket. MCP tool `claim_ticket` returns error if already claimed. |
| **Subagent delegation model** | A single orchestrator agent spawning parallel subagents to handle multiple tickets is the standard multi-agent pattern (hub-and-spoke). Without this, one agent processes tickets serially, blocking throughput. | High | Needs: mechanism for an agent to declare it is operating as a subagent under a parent session. AWB does not run subagents — it tracks the delegation structure. |
| **Right panel ticket detail UI** | Modal-centered detail is incompatible with large comment volumes (agents generate dozens of comments) and subtask navigation. The market standard (Linear, GitHub Issues) is a side panel. | Medium | UI-only. No backend changes. Removes center modal, adds persistent right panel. |
| **Subtask navigation (click-through)** | Hierarchical tickets with 3 levels are unusable if navigating between them requires closing and reopening. Table stakes for any tool with nested work items. | Low | Frontend routing/state change. Click on child ticket switches the panel context. |
| **Comments section redesigned for agent volume** | An agent can add 10-30 comments per ticket during processing. The current comment layout is designed for human conversation threads, not structured agent output. | Medium | Collapsible groups, agent-vs-human visual distinction, pagination or virtual scroll for large volumes. |

---

## Differentiators

Features that create competitive advantage. Not universally expected, but create significant value when present.

| Feature | Value Proposition | Complexity | Notes |
|---------|-------------------|------------|-------|
| **Agent session dashboard** | See all connected agents, their roles, which tickets they are currently processing, last activity time. Comparable to GitHub Actions run view. Provides trust and debuggability for autonomous operation. | Medium | Read-only dashboard pulling from AgentSession + ActivityLog. No real-time WebSocket required — polling at 5s is acceptable for MVP. |
| **MCP tool: `get_my_tickets`** | Agents can call one tool and receive only the tickets relevant to their role. Eliminates agents scanning the entire board to find relevant work. Reduces LLM context consumption significantly. | Low | Filter logic on existing `list_tickets` by `assignee_id`, `reporter_id`, `reviewer_id` matching the calling agent's identity. |
| **Conflict-free claim-and-work pattern** | Agent calls `claim_ticket(id)` → receives exclusive lock → does work → calls `release_ticket(id)` or column move auto-releases. Deterministic, no race conditions. | Medium | Standard optimistic lock via DB field. Exponential backoff on conflict is an agent concern, not AWB's. |
| **Automation loop audit trail** | Every step of the Reporter→Assignee→Reviewer handoff is recorded with timestamps, agent identity, and action. Provides full traceability of autonomous decisions. | Low | ActivityLog already exists. Augment with role context and trigger source (manual vs auto-trigger). |
| **Role assignment UI** | Human can drag-and-drop or select which agent handles which role per workspace/board. This is the configuration surface for the entire routing system. | Medium | Admin panel addition. Maps Agent ID → role → board/workspace scope. |
| **Webhook / event trigger endpoint** | External systems (CI pipelines, monitoring) can POST to AWB to create or transition tickets. Enables AWB to be the coordination hub for a broader automation ecosystem. | Medium | New controller endpoint. Auth via API key. Triggers same event chain as manual transitions. |
| **Agent typing indicator in comments** | When an agent is actively writing a long response, a "Agent X is processing..." indicator appears. Reduces anxiety about silent automation. | Low | SSE or polling-based. Agent posts a `processing` comment type that resolves to final result. |
| **Subtask completion percentage on parent ticket** | Shows `N/M subtasks done` on the parent card in the kanban column. Lets humans see progress without opening the ticket. | Low | Computed field. Already partially shown in `agent-api.controller.ts`. Needs to surface in board view. |

---

## Anti-Features

Features to explicitly NOT build. Each has a rationale grounded in the project constraints and domain tradeoffs.

| Anti-Feature | Why Avoid | What to Do Instead |
|--------------|-----------|-------------------|
| **Agent execution engine / runner** | AWB's boundary is connection + routing + state. Running agent code couples AWB to LLM provider contracts and adds massive complexity. Any LLM (Claude, GPT, Gemini) should be an external agent connecting to AWB. | Keep MCP interface clean. Let agents self-execute. |
| **Chat-based agent interface** | A conversational UI inside AWB is a different product (Slack, Teams). Agents communicate through MCP tool calls and ticket comments — not free-form chat. Adding a chat UI blurs this. | Agent outputs go in ticket comments. Structured, not conversational. |
| **Real-time WebSocket event streaming to agents** | MCP Streamable HTTP is already the transport. Adding a separate WebSocket channel for agents creates two communication paths to maintain. Use SSE progress events for long operations only. | Agents poll via `get_my_tickets`. Notifications via existing Discord channel already in place. |
| **Full OAuth2 agent authentication** | The 2026 MCP roadmap plans to standardize agent auth, but AWB's API key model is sufficient and already working. Replacing it mid-milestone adds risk with no user-facing value. | Keep API key auth. Document upgrade path for when MCP auth standard settles. |
| **Per-ticket agent SLA enforcement** | Monitoring whether an agent completed work within N minutes and escalating is an operations product (PagerDuty, Linear SLAs). AWB has no alerting infrastructure. | Use activity log timestamps if a user wants to inspect timing. Do not automate escalation. |
| **AI-powered ticket auto-creation from natural language** | Accepting free text and using an LLM to parse it into a structured ticket requires an AI integration layer. AWB is the downstream consumer, not the upstream classifier. | Agents create tickets via MCP tools with structured fields. |
| **Multi-board agent routing** | Routing an agent across multiple boards based on ticket content requires cross-board state awareness that does not exist. One agent, one board scope per session. | Define agent scope at session connect time (board_id parameter). |
| **Agent memory / long-term context store** | Persisting what an agent "knows" between sessions is the agent's own concern. AWB provides the ticket and comment history. Agents should read activity logs if they need context. | ActivityLog + Comments serve as the shared memory substrate. Do not build a vector store. |

---

## Feature Dependencies

```
Role-based routing
  → requires: Agent session tracking (to know which agent is calling)
  → requires: Ticket claim/lock mechanism (to prevent concurrent claim)
  → enables: Automatic trigger on state change (need to know which role receives next)

Automatic trigger on state change
  → requires: Role-based routing (to know who to trigger)
  → requires: Agent connection state (to know if target agent is online)

Subagent delegation model
  → requires: Agent session tracking (parent session must be identifiable)
  → requires: Ticket claim/lock (subagents claim individual tickets under parent)

Agent session dashboard
  → requires: Agent connection state visibility (raw data source)
  → requires: Role-based routing (to show role assignments per session)

Right panel UI
  → enables: Subtask navigation (spatial context for click-through)
  → enables: Redesigned comments section (more vertical space for agent output)

MCP tool: get_my_tickets
  → requires: Role-based routing (filtering logic)
  → requires: Agent session tracking (to identify caller's role)

Role assignment UI
  → requires: Role-based routing data model (what to configure)
```

### Dependency Order for Implementation

1. **Agent session tracking** — prerequisite for everything else. No role routing, no lock, no dashboard without knowing which agent is connected and what role it holds.
2. **Ticket claim/lock** — prerequisite for subagent safety. Must exist before parallel subagents are supported.
3. **Role-based routing** — builds on session tracking. Enables `get_my_tickets`, enables trigger logic.
4. **Automatic trigger** — builds on routing. The automated handoff chain.
5. **Subagent delegation** — builds on session tracking + claim. Parallel processing.
6. **UI changes** (right panel, subtask nav, comments redesign) — independent of backend changes. Can develop in parallel.
7. **Agent session dashboard** — reads from all of the above. Build last in the milestone.

---

## MVP Recommendation for This Milestone

Prioritize (must ship for milestone to deliver value):
1. Agent session tracking — connection/disconnection recording, role stored at connect time
2. Ticket claim/lock mechanism — `locked_by`, `locked_at` on Ticket entity, MCP `claim_ticket` / `release_ticket` tools
3. Role-based routing — `get_my_tickets` filtered by role, `reviewer_id` field on Ticket
4. Right panel UI — core UX improvement, unblocks comments redesign
5. Automatic trigger on column move — emit event to connected agent of next role

Defer to follow-on milestone:
- **Agent session dashboard** — valuable observability, but agents can operate without it. Build after routing is proven.
- **Webhook / event trigger endpoint** — external system integration. Not needed for the core agent loop.
- **Role assignment UI** — initial version can use admin config or environment variables for role→agent mapping.

---

## Confidence Assessment

| Area | Confidence | Source |
|------|------------|--------|
| Table stakes list | HIGH | Derived from PROJECT.md requirements + Azure/Microsoft multi-agent patterns (official docs, Feb 2026) |
| Differentiators list | MEDIUM | Vibe Kanban feature analysis + KaibanJS patterns + community observation |
| Anti-features rationale | HIGH | Project constraints from PROJECT.md + MCP 2026 roadmap (official blog) |
| Dependency ordering | HIGH | Standard multi-agent system design patterns (Microsoft Azure Architecture Center) |

---

## Sources

- [AI Agent Orchestration Patterns — Azure Architecture Center (Feb 2026)](https://learn.microsoft.com/en-us/azure/architecture/ai-ml/guide/ai-agent-design-patterns)
- [Vibe Kanban — AI Agent Kanban Board](https://vibekanban.com/)
- [MCP 2026 Roadmap — Enterprise Readiness](https://blog.modelcontextprotocol.io/posts/2026-mcp-roadmap/)
- [Multi-agent Coordination Strategies — Galileo](https://galileo.ai/blog/multi-agent-coordination-strategies)
- [MCP Architecture Overview — Official Docs](https://modelcontextprotocol.io/docs/learn/architecture)
- [Agents Need Durable Workflows — Convex](https://stack.convex.dev/durable-workflows-and-strong-guarantees)
- [The Multi-Agent Trap — Towards Data Science](https://towardsdatascience.com/the-multi-agent-trap/)
- [Routing Agent Pattern — agentpatterns.tech](https://www.agentpatterns.tech/en/agent-patterns/routing-agent)
