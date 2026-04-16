# Roadmap: AI Workflow Board

## Milestones

- ✅ **v1.0 Agent Orchestration** — Phases 1-6 (complete)
- 🚧 **v1.1 Admin 권한 관리 재구조화** — Phases 7-9 (planned)

## Phases

<details>
<summary>✅ v1.0 Agent Orchestration (Phases 1-6) — Complete</summary>

**Milestone Goal:** AWB를 수동 칸반 보드에서 자율 멀티에이전트 조율 플랫폼으로 전환한다.

### Phase 1: Data Model Foundation
**Goal**: All schema fields, entities, and data integrity guards required by routing, locking, and connection tracking are in place
**Status**: ✅ Complete

### Phase 2: Agent Connection Tracking
**Goal**: Agents connecting to the MCP server are tracked by identity, role, and recency — and that state survives server restarts
**Status**: ✅ Complete

### Phase 3: Role Routing + Trigger Engine
**Goal**: Tickets are routed to the correct agent by role, and column transitions automatically trigger the next role's agent via a durable inbox
**Status**: ✅ Complete

### Phase 4: Ticket Lock + Subagent Delegation
**Goal**: Agents can exclusively claim tickets to prevent concurrent mutation, and subagents can be delegated individual tickets under a parent agent
**Status**: ✅ Complete

### Phase 5: UI Redesign — Right Panel
**Goal**: Users and agents interact with ticket detail, subtasks, and comments through a persistent right panel that handles high-volume agent output
**Status**: ✅ Complete

### Phase 6: Agent Session Dashboard
**Goal**: The operator can see which agents are connected, their roles, and how many pending triggers are queued — without digging into logs
**Status**: ✅ Complete

</details>

---

## v1.1 Admin 권한 관리 재구조화 (Phases 7-9)

**Milestone Goal:** Users/AI Agents/API Keys 관리를 workspace 하위에서 Admin 레벨로 이동하고, workspace↔user/agent 권한 매핑 UI를 구축하며, workspace 전환 흐름을 개선한다.

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

## Progress

**Execution Order:**
Phases execute in numeric order: 7 → 8 → 9

| Phase | Milestone | Status | Completed |
|-------|-----------|--------|-----------|
| 1. Data Model Foundation | v1.0 | ✅ Complete | 2026-04-09 |
| 2. Agent Connection Tracking | v1.0 | ✅ Complete | 2026-04-10 |
| 3. Role Routing + Trigger Engine | v1.0 | ✅ Complete | 2026-04-11 |
| 4. Ticket Lock + Subagent Delegation | v1.0 | ✅ Complete | 2026-04-12 |
| 5. UI Redesign — Right Panel | v1.0 | ✅ Complete | 2026-04-12 |
| 6. Agent Session Dashboard | v1.0 | ✅ Complete | 2026-04-13 |
| 7. Admin Menu Restructure | v1.1 | Not started | - |
| 8. Permission Mapping UI | v1.1 | Not started | - |
| 9. Workspace Picker & Switcher | v1.1 | Not started | - |
