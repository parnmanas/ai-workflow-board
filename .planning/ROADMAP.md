# Roadmap: AI Workflow Board

## Milestones

- 🚧 **v1.0 Agent Orchestration** — Phases 1-6 (in progress)
- 📋 **v1.1 Admin 권한 관리 재구조화** — Phases 7-9 (planned)

## Phases

<details>
<summary>🚧 v1.0 Agent Orchestration (Phases 1-6) — In Progress</summary>

**Milestone Goal:** AWB를 수동 칸반 보드에서 자율 멀티에이전트 조율 플랫폼으로 전환한다.

### Phase 1: Data Model Foundation
**Goal**: All schema fields, entities, and data integrity guards required by routing, locking, and connection tracking are in place
**Depends on**: Nothing (first phase)
**Requirements**: ROLE-01, LOCK-05
**Success Criteria** (what must be TRUE):
  1. Ticket entity has reviewer_id field and the database migration applies cleanly on both SQLite and PostgreSQL
  2. Ticket entity has @VersionColumn applied; concurrent update attempts at the DB level return an optimistic lock error
  3. Agent entity has roles, connected_at, last_seen_at, webhook_url, workspace_id fields persisted in the database
  4. AgentTrigger entity exists with all required fields (ticket_id, role, expires_at, acknowledged_at, cooldown tracking)
**Plans**: 3 plans

Plans:
- [x] 01-01-PLAN.md — Add reviewer_id and @VersionColumn to Ticket entity (ROLE-01, LOCK-05)
- [x] 01-02-PLAN.md — Extend Agent entity + create AgentTrigger entity
- [x] 01-03-PLAN.md — Register AgentTrigger in all three entity locations + human verification

### Phase 2: Agent Connection Tracking
**Goal**: Agents connecting to the MCP server are tracked by identity, role, and recency — and that state survives server restarts
**Depends on**: Phase 1
**Requirements**: CONN-01, CONN-02, CONN-03, CONN-05
**Success Criteria** (what must be TRUE):
  1. An agent connecting via MCP has its agentId and connectedAt recorded in the database
  2. An agent that sends a heartbeat ping has its last_seen_at updated in the database within 30 seconds
  3. An agent that disconnects (timeout or explicit) is marked offline; subsequent connection checks reflect the offline state
  4. When an agent is actively processing a ticket, a typing indicator is visible in the ticket UI
**Plans**: 2 plans

Plans:
- [x] 02-01-PLAN.md — Add is_online to Agent entity + ping MCP tool (CONN-01, CONN-02)
- [x] 02-02-PLAN.md — AgentConnectionService offline sweep + set_typing tool + SSE typing indicator (CONN-03, CONN-05)

### Phase 3: Role Routing + Trigger Engine
**Goal**: Tickets are routed to the correct agent by role, and column transitions automatically trigger the next role's agent via a durable inbox
**Depends on**: Phase 2
**Requirements**: ROLE-02, ROLE-03, ROLE-04, TRIG-01, TRIG-02, TRIG-03, TRIG-04, TRIG-05
**Success Criteria** (what must be TRUE):
  1. An agent with role Assignee calling get_my_tickets receives only tickets assigned to it in its workspace; no cross-workspace tickets appear
  2. Moving a ticket to a designated column creates an AgentTrigger DB record for the next role's agent
  3. An agent calling get_pending_triggers receives the trigger; calling acknowledge_trigger removes it from the pending list
  4. Moving the same ticket to a trigger column twice within the cooldown window creates only one AgentTrigger, not two
  5. Every trigger dispatch and acknowledgement appears in ActivityLog with role and trigger source fields populated
**Plans**: 3 plans

Plans:
- [x] 03-01-PLAN.md — Entity extensions (Board.routing_config, ActivityLog.role+trigger_source) + AgentsController roles PATCH (ROLE-02, TRIG-05)
- [x] 03-02-PLAN.md — TriggerLoopService + AgentsModule registration + get_my_tickets MCP tool (ROLE-03, ROLE-04, TRIG-01, TRIG-02, TRIG-04)
- [x] 03-03-PLAN.md — get_pending_triggers + acknowledge_trigger MCP tools + human verification (TRIG-03, TRIG-05)

### Phase 4: Ticket Lock + Subagent Delegation
**Goal**: Agents can exclusively claim tickets to prevent concurrent mutation, and subagents can be delegated individual tickets under a parent agent
**Depends on**: Phase 3
**Requirements**: LOCK-01, LOCK-02, LOCK-03, LOCK-04
**Success Criteria** (what must be TRUE):
  1. An agent calling claim_ticket on an unclaimed ticket acquires the lock; the ticket shows locked_by_agent_id in the database
  2. A second agent calling claim_ticket on an already-locked ticket receives an error response, not a silent override
  3. A lock whose TTL has expired is automatically released; a new agent can then acquire the lock
  4. A subagent can claim an individual ticket listed under a parent agent's delegation, work it independently, and release the lock without affecting other tickets
**Plans**: 3 plans

Plans:
- [ ] 04-01-PLAN.md — Add locked_by_agent_id, locked_at (Ticket) + parent_agent_id (Agent) entity fields (LOCK-01, LOCK-03, LOCK-04)
- [ ] 04-02-PLAN.md — claim_ticket + release_ticket MCP tools + AgentConnectionService TTL sweep (LOCK-01, LOCK-02, LOCK-03, LOCK-04)
- [ ] 04-03-PLAN.md — Human verification of all LOCK success criteria

### Phase 5: UI Redesign — Right Panel
**Goal**: Users and agents interact with ticket detail, subtasks, and comments through a persistent right panel that handles high-volume agent output
**Depends on**: Phase 1
**Requirements**: UI-01, UI-02, UI-03, UI-04, UI-05
**Success Criteria** (what must be TRUE):
  1. Clicking a ticket card opens its detail in a right-side panel; no center modal appears
  2. The right panel shows the parent ticket and its children subtask list; clicking a subtask switches the panel content to that subtask without a page reload
  3. The comments section distinguishes agent comments from human comments visually and supports collapse/expand per agent; 100+ comments render without layout degradation
  4. A parent ticket card on the kanban board displays its subtask completion ratio (e.g., 3/5) without requiring the panel to open
**Plans**: 3 plans
**UI hint**: yes

Plans:
- [x] 05-01-PLAN.md — Install react-resizable-panels + Board.tsx PanelGroup layout + TicketPanel.tsx (UI-01, UI-02, UI-03)
- [x] 05-02-PLAN.md — CommentList virtualized + TypingIndicator + UI-05 verification (UI-04, UI-05)
- [ ] 05-03-PLAN.md — Human verification of all Phase 5 success criteria

### Phase 6: Agent Session Dashboard
**Goal**: The operator can see which agents are connected, their roles, and how many pending triggers are queued — without digging into logs
**Depends on**: Phase 3
**Requirements**: CONN-04
**Success Criteria** (what must be TRUE):
  1. A dashboard page lists all agents with their connection status, role(s), last_seen_at timestamp, and count of pending AgentTrigger records
  2. An agent that has not sent a heartbeat within the timeout window appears as offline on the dashboard without a page refresh
  3. The dashboard data is scoped to the current workspace; agents from other workspaces are not visible
**Plans**: 2 plans
**UI hint**: yes

Plans:
- [ ] 06-01-PLAN.md — Add GET /api/agents/dashboard endpoint (CONN-04)
- [ ] 06-02-PLAN.md — AgentSessionDashboard component + AdminPanel Sessions tab + human verification (CONN-04)

</details>

---

## v1.1 Admin 권한 관리 재구조화 (Phases 7-9)

**Milestone Goal:** Users/AI Agents/API Keys 관리를 workspace 하위에서 Admin 레벨로 이동하고, workspace↔user/agent 권한 매핑 UI를 구축하며, workspace 전환 흐름을 개선한다.

### Phase Checklist

- [ ] **Phase 7: Admin Menu Restructure** - Users/Agents/API Keys 메뉴를 Admin 레벨로 이동하고 workspace 하위 중복 메뉴를 제거한다
- [ ] **Phase 8: Permission Mapping UI** - Admin에서 user/agent를 workspace에 grant/revoke하는 관계 매핑 UI와 현황 대시보드를 구축한다
- [ ] **Phase 9: Workspace Picker & Switcher** - 로그인 후 workspace 선택 화면과 사이드바/헤더 workspace 전환 기능을 제공한다

## Phase Details

### Phase 7: Admin Menu Restructure
**Goal**: Admin 패널이 workspace에 무관하게 전체 Users, AI Agents, API Keys를 관리하는 단일 진입점이 된다
**Depends on**: Phase 6
**Requirements**: ADM-01, ADM-02, ADM-03, ADM-04
**Success Criteria** (what must be TRUE):
  1. Admin 패널에서 전체 user 목록을 조회할 수 있고, 목록은 현재 선택된 workspace와 무관하게 동일하게 표시된다
  2. Admin 패널에서 전체 AI Agent 목록을 조회할 수 있고, workspace 필터 없이 모든 agent가 나열된다
  3. Admin 패널에서 전체 API Key 목록을 조회할 수 있고, workspace 범위에 제한되지 않는다
  4. 기존 workspace 하위에 있던 Users/AI Agents/API Keys 메뉴 항목이 사라지고, Admin 메뉴로 대체된다
**Plans**: TBD
**UI hint**: yes

Plans:
- [ ] TBD

### Phase 8: Permission Mapping UI
**Goal**: Admin이 user/agent를 workspace에 할당하거나 해제할 수 있고, 전체 관계 현황을 한 화면에서 파악할 수 있다
**Depends on**: Phase 7
**Requirements**: PERM-01, PERM-02, PERM-03, PERM-04, PERM-05
**Success Criteria** (what must be TRUE):
  1. Admin이 user를 특정 workspace에 member 또는 owner 역할로 할당할 수 있고, 할당 후 해당 user가 그 workspace에 접근 가능해진다
  2. Admin이 user의 workspace 관계를 revoke하면 해당 user는 그 workspace에 더 이상 접근할 수 없다
  3. Admin이 AI agent를 특정 workspace에 할당할 수 있고, 할당 후 agent가 해당 workspace의 MCP 도구를 사용할 수 있다
  4. Admin이 agent의 workspace 관계를 revoke하면 해당 agent는 더 이상 그 workspace에 접근할 수 없다
  5. 관계 현황 대시보드에서 모든 user/agent↔workspace 매핑을 한 화면에서 확인할 수 있다
**Plans**: TBD
**UI hint**: yes

Plans:
- [ ] TBD

### Phase 9: Workspace Picker & Switcher
**Goal**: 복수 workspace에 속한 사용자가 로그인 직후 workspace를 선택할 수 있고, 앱 내에서 언제든지 workspace를 전환할 수 있다
**Depends on**: Phase 8
**Requirements**: WS-01, WS-02
**Success Criteria** (what must be TRUE):
  1. 복수 workspace에 속한 사용자가 로그인하면 workspace 선택 화면이 나타나고, 선택 후 해당 workspace의 보드로 진입한다
  2. 단일 workspace에 속한 사용자는 workspace 선택 화면 없이 바로 보드로 진입한다
  3. 앱 내에서 사이드바 또는 헤더의 workspace 전환 컨트롤을 통해 다른 workspace로 이동할 수 있고, 페이지가 새로고침 없이 전환된다
**Plans**: TBD
**UI hint**: yes

Plans:
- [ ] TBD

## Progress

**Execution Order:**
Phases execute in numeric order: 7 → 8 → 9

| Phase | Milestone | Plans Complete | Status | Completed |
|-------|-----------|----------------|--------|-----------|
| 1. Data Model Foundation | v1.0 | 3/3 | Complete | 2026-04-09 |
| 2. Agent Connection Tracking | v1.0 | 1/2 | In Progress | - |
| 3. Role Routing + Trigger Engine | v1.0 | 2/3 | In Progress | - |
| 4. Ticket Lock + Subagent Delegation | v1.0 | 0/3 | Not started | - |
| 5. UI Redesign — Right Panel | v1.0 | 0/3 | Not started | - |
| 6. Agent Session Dashboard | v1.0 | 0/2 | Not started | - |
| 7. Admin Menu Restructure | v1.1 | 0/TBD | Not started | - |
| 8. Permission Mapping UI | v1.1 | 0/TBD | Not started | - |
| 9. Workspace Picker & Switcher | v1.1 | 0/TBD | Not started | - |
