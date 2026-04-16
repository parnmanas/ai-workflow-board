# AI Workflow Board (AWB)

## What This Is

AI Workflow Board는 AI Agent가 MCP를 통해 연결하여 자율적으로 티켓을 처리하는 칸반 기반 워크플로우 자동화 플랫폼이다. Agent가 역할(Assignee/Reporter/Reviewer)별로 티켓을 수신하고, subagent를 통해 실제 작업을 수행한 뒤, 결과를 comment로 남기고 티켓 상태를 이동시키는 자동화 루프를 제공한다.

## Core Value

Agent가 MCP로 연결되어 티켓을 자율 처리하고, 완료된 티켓이 다음 역할의 Agent에게 자동 트리거되는 연속 자동화 루프.

## Requirements

### Validated

- ✓ 칸반 보드 기반 티켓 관리 — existing
- ✓ MCP 서버를 통한 Agent 연동 (33개 도구) — existing
- ✓ Agent가 MCP로 column 이동 가능 — existing
- ✓ Multi-workspace 지원 — existing
- ✓ Parent/children 계층적 티켓 구조 — existing
- ✓ Discord 채널 알림 — existing
- ✓ API key 기반 Agent 인증 — existing
- ✓ 댓글(comment) 시스템 — existing
- ✓ 활동 로그 — existing

### Active

- [ ] Agent 연결 관리 (접속/해제 추적, 상태 모니터링)
- [ ] 역할 기반 Agent 라우팅 (Assignee/Reporter/Reviewer)
- [ ] 티켓 상태 변경 시 다음 역할 Agent에게 자동 트리거
- [ ] Subagent 위임 구조 (다중 티켓 병렬 처리, 충돌 방지)
- [ ] UI: 티켓 상세를 오른쪽 패널로 전환 (가운데 모달 제거)
- [ ] UI: Parent/children subtask 탐색 (클릭 시 해당 티켓으로 전환)
- [ ] UI: Comments 섹션 개편 (Agent 댓글 대량 수용)

### Out of Scope

- Agent 자체 개발 (Claude 등 외부 Agent 사용) — AWB는 연결/라우팅만 담당
- 채팅 기반 Agent 인터페이스 — MCP 도구 기반 통신 유지
- 실시간 화상/음성 — 텍스트 기반 워크플로우만

## Context

- **기존 스택:** NestJS 11 + React 18 + TypeORM + PostgreSQL/SQLite 모노레포 (Turbo)
- **MCP 현황:** 이미 33개 도구가 등록된 MCP 서버 운영 중 (`/mcp` 엔드포인트, Streamable HTTP)
- **Agent 인증:** API key 기반 (MCP_API_KEYS 환경변수 또는 DB)
- **기존 UI:** 티켓 선택 시 가운데 모달로 상세 표시, Column 기반 칸반
- **기존 엔티티:** Board, BoardColumn, Ticket (계층 구조), Channel, Workspace, AgentChannelIdentity, ActivityLog

## Constraints

- **Tech Stack**: 기존 NestJS + React + TypeORM 유지 — 전면 재작성 불가
- **MCP 호환**: @modelcontextprotocol/sdk 기반 Streamable HTTP 유지
- **DB 호환**: SQLite(개발) + PostgreSQL(운영) 이중 지원 유지
- **Agent 독립성**: AWB는 Agent의 내부 구현에 의존하지 않음 — MCP 인터페이스만 사용

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| 역할 기반 라우팅 (Assignee/Reporter/Reviewer) | Agent마다 전문 역할을 부여해 책임 분리 | — Pending |
| Subagent 위임 구조 | 한 Agent가 여러 티켓 처리 시 충돌 방지 | — Pending |
| 오른쪽 패널 UI | Subtask 탐색과 대량 댓글에 적합한 레이아웃 | — Pending |
| 기존 MCP 서버 확장 | 새 서버 분리 대신 기존 도구 세트에 연결 관리 추가 | — Pending |

## Current Milestone: v1.1 Admin 권한 관리 재구조화

**Goal:** Users/AI Agents 관리를 workspace 하위에서 Admin 레벨로 이동하고, ReBACservice 기반 workspace↔user/agent 매핑 UI 구축

**Target features:**
- Users/AI Agents 메뉴를 Admin으로 이동 (workspace 독립적 리소스로 관리)
- Admin에서 workspace↔user ReBACservice 관계 매핑 UI (grant/revoke)
- Admin에서 workspace↔AI agent ReBACservice 관계 매핑 UI
- Workspace 선택/전환 개선 (로그인 후 workspace picker)

## Evolution

This document evolves at phase transitions and milestone boundaries.

**After each phase transition** (via `/gsd-transition`):
1. Requirements invalidated? → Move to Out of Scope with reason
2. Requirements validated? → Move to Validated with phase reference
3. New requirements emerged? → Add to Active
4. Decisions to log? → Add to Key Decisions
5. "What This Is" still accurate? → Update if drifted

**After each milestone** (via `/gsd-complete-milestone`):
1. Full review of all sections
2. Core Value check — still the right priority?
3. Audit Out of Scope — reasons still valid?
4. Update Context with current state

---
*Last updated: 2026-04-13 after milestone v1.1 start*
