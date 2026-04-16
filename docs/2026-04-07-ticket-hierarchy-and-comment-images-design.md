# Ticket Hierarchy (Subtask as Ticket) & Comment Image Attachment

**Date:** 2026-04-07
**Status:** Approved

## Summary

Replace the separate Subtask entity with a self-referencing Ticket hierarchy (parent_id). Add image attachment support to Comments using database BLOB storage.

## Goals

1. Subtask가 Ticket의 모든 기능을 가지도록 통합
2. 최대 2단계 depth 지원 (Ticket → Subtask → Sub-subtask)
3. Jira 스타일의 서브태스크 UI (오른쪽 슬라이드 패널)
4. Comment에 이미지 첨부 기능 추가

## Data Model

### Ticket Entity Changes

```
Ticket {
  // 기존 필드 모두 유지
  id, column_id, title, description, priority,
  assignee, reporter, assignee_id, reporter_id,
  labels, channel_ids, position, created_at, updated_at

  // 신규 필드
  parent_id: varchar | null     // self-referencing FK → Ticket.id
  depth: int (default: 0)       // 0=루트, 1=서브태스크, 2=서브서브태스크

  // 관계 변경
  parent: ManyToOne → Ticket (nullable, onDelete: CASCADE)
  children: OneToMany → Ticket
  comments: OneToMany → Comment (유지)
  // subtasks 관계 제거
}
```

**Rules:**
- `depth = 0`: 보드에 표시, `column_id` 필수
- `depth = 1, 2`: 보드에 미표시, `column_id = null`
- `depth > 2`: 서버에서 생성 거부 (400 에러)
- 부모 삭제 시 자식도 cascade 삭제

### Subtask Entity

완전 삭제. 엔티티, 모듈, 컨트롤러, 서비스 모두 제거.

### Comment Entity Changes

```
Comment {
  // 기존 필드 유지
  id, ticket_id, author_type, author_id, author, content, created_at

  // 신규 필드
  images: text (default: '[]')  // JSON array of base64 encoded images
}
```

**Image 구조:**
```json
[
  {
    "filename": "screenshot.png",
    "mimetype": "image/png",
    "data": "<base64 encoded string>"
  }
]
```

**제한:**
- 이미지당 최대 5MB
- 코멘트당 최대 5장

### ActivityLog

- `entity_type: 'subtask'` 참조는 이제 모두 `'ticket'`으로 통합

## Backend API

### 유지 (변경 포함)

| Method | Endpoint | 변경사항 |
|--------|----------|----------|
| `POST` | `/columns/{columnId}/tickets` | depth=0, parent_id=null 강제 |
| `GET` | `/tickets/{id}` | children 관계 eager load 추가 |
| `PATCH` | `/tickets/{id}` | 변경 없음 |
| `PATCH` | `/tickets/{id}/move` | depth=0만 허용 |
| `DELETE` | `/tickets/{id}` | cascade로 자식 삭제 |
| `POST` | `/tickets/{id}/comments` | images 필드 추가 지원 |
| `GET` | `/tickets/{id}/activity` | 변경 없음 |

### 신규

| Method | Endpoint | 설명 |
|--------|----------|------|
| `POST` | `/tickets/{parentId}/children` | 자식 티켓 생성 (depth = parent.depth + 1) |

### 삭제

| Method | Endpoint |
|--------|----------|
| `POST` | `/tickets/{ticketId}/subtasks` |
| `PATCH` | `/subtasks/{id}` |
| `DELETE` | `/subtasks/{id}` |

### 보드 조회

`GET /boards/{id}` 응답에서 각 컬럼의 tickets에 `parent_id IS NULL` 조건 추가.

## Frontend UI

### Board (Board.tsx)

- 기존과 동일, `parent_id = null` 티켓만 표시
- TicketCard에 자식 티켓 진행률 표시 유지

### TicketCard (TicketCard.tsx)

- subtask progress bar를 children 기반으로 변경
- children 중 status='done' 비율로 계산

### TicketDetail (TicketDetail.tsx)

- 기존 구조 유지
- Subtasks 섹션을 children 티켓 목록으로 교체
- 각 행: 체크박스, 우선순위 배지, 제목, 상태, 담당자, 삭제 버튼
- 행 클릭 시 오른쪽 슬라이드 패널 열림

### SubtaskPanel (신규 컴포넌트)

- 서브태스크 클릭 시 오른쪽에서 슬라이드 인
- TicketDetail과 동일한 모든 기능 포함:
  - 제목, 설명 편집
  - 우선순위, 담당자, 리포터 선택
  - 알림 채널 설정
  - 자식의 자식 (depth=2) 서브태스크 목록
  - 코멘트 (이미지 첨부 포함)
  - 활동 로그 탭
- depth=2 서브태스크는 인라인 확장 (추가 패널 없음)
- 뒤로가기/닫기 버튼

### Comment 이미지 (TicketDetail, SubtaskPanel)

- 코멘트 입력 영역에 클립 아이콘 (이미지 첨부 버튼)
- 파일 선택 또는 드래그&드롭 지원
- 첨부 시 썸네일 미리보기
- 작성된 코멘트에서 이미지 클릭 시 확대 모달

## Migration

- TypeORM `synchronize: true` 사용 중이므로 자동 스키마 동기화
- 기존 Subtask 데이터는 Ticket으로 마이그레이션하는 시드/스크립트 필요
  - subtask.ticket_id → parent_id
  - depth = 1
  - column_id = null
  - 기존 필드 매핑 (title, description, priority, assignee, etc.)
- Subtask 테이블은 마이그레이션 후 삭제

## Files to Modify

### Backend (삭제)
- `apps/server/src/entities/Subtask.ts`
- `apps/server/src/modules/subtasks/` (전체)

### Backend (수정)
- `apps/server/src/entities/Ticket.ts` — parent_id, depth, children 관계 추가
- `apps/server/src/entities/Comment.ts` — images 필드 추가
- `apps/server/src/modules/tickets/tickets.controller.ts` — children 엔드포인트 추가
- `apps/server/src/modules/tickets/tickets.service.ts` — children CRUD, depth 검증
- `apps/server/src/services/activity.service.ts` — subtask → ticket 통합
- `apps/server/src/database/database.module.ts` — Subtask 엔티티 제거
- `apps/server/src/app.module.ts` — SubtaskModule 제거

### Frontend (삭제)
- (SubtaskList.tsx는 대체될 예정)

### Frontend (수정)
- `apps/client/src/types.ts` — Subtask 타입 제거, Ticket에 parent_id/depth/children 추가
- `apps/client/src/api.ts` — subtask API 제거, children API 추가, comment images 지원
- `apps/client/src/hooks/useBoard.ts` — subtask → children 로직 변경
- `apps/client/src/components/Board.tsx` — children 관련 핸들러 변경
- `apps/client/src/components/TicketCard.tsx` — children 기반 progress
- `apps/client/src/components/TicketDetail.tsx` — children 목록, 코멘트 이미지 UI
- `apps/client/src/components/SubtaskList.tsx` — ChildTicketList로 재작성
- 신규: `apps/client/src/components/SubtaskPanel.tsx` — 서브태스크 상세 슬라이드 패널
