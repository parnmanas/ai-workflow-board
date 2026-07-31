# Catalog scopes

AWB 관리 객체는 소유 객체와 재사용 가능한 정의 객체를 구분한다. 재사용
정의는 `workspace_id` (nullable) 하나로 scope를 표현한다.

| Scope | `workspace_id` | Resolution priority |
| --- | --- | --- |
| Global | `NULL` | 1 (fallback) |
| Workspace | workspace UUID | 2 |

Scope는 생성 후 변경하지 않는다. 다른 scope가 필요하면 새 정의를 만든다. 이
규칙은 한 행을 다른 tenant로 옮기는 실수와 실행 이력의 의미 변경을 막는다.

## `board_id` — 폐지된 레거시 컬럼

커밋 `65adf0b`(feat(catalog): promote board definitions to workspaces)가 모든
카탈로그 아이템의 Board scope를 Workspace scope로 강제 승격했다. 그 이전에는
Board가 세 번째 scope 계층(Global < Workspace < Board)이었으나, 지금은:

- 각 엔티티의 `board_id` 컬럼은 legacy compatibility 목적으로만 남아 있고,
  부트 마이그레이션(`1760000000069-PromoteBoardCatalogScopes.ts`) 이후
  항상 `NULL`이다.
- `normalizeCatalogScope()`(`apps/server/src/common/catalog-scope.ts`)는
  `scope: 'board'` 또는 `board_id`를 지정한 생성 시도를 400으로 거부한다.
- `canUseCatalogItem(row, workspaceId)`은 `board_id !== null`인 행을 무조건
  사용 불가로 판정한다 — 인자는 `workspaceId`만 받는다.
- 각 서비스의 `list(workspaceId)`는 workspace_id만 받는다. REST 쿼리
  파라미터에도 `board_id`는 없다.

**"Board context 조회"라는 개념은 없다.** 카탈로그 정의는 Global/Workspace
두 계층만 있고, Board는 그 정의를 "실행하는 맥락"에만 등장한다 — 정의 자체의
가시성을 좌우하지 않는다. 예: `FunctionExecutionArgs.boardId`는
`WorkflowFunctionRun.board_id`에 찍히는 실행 기록일 뿐, `list()`/`resolve()`가
반환하는 Function 정의 집합에는 영향을 주지 않는다. QA/Security도 동일 —
`QaRun(Batch)`/`SecurityRun(Batch)`의 `board_id`는 실행 컨텍스트이고,
`QaScenario`/`SecurityProfile` 자체의 board_id는 죽은 컬럼이다. Action과
Workspace Schedule의 실행 기록(`ActionRun`, dispatch가 여는 ChatRoom)에는
애초에 board_id 필드가 없다.

## 적용 대상

| Type | Global | Workspace | 실행 기록의 Board 컨텍스트 |
| --- | --- | --- | --- |
| Function | yes | yes | `WorkflowFunctionRun.board_id` |
| Credential | yes | yes | — |
| Resource | yes | yes | — |
| Prompt Template | yes | yes | — |
| Action | no | yes | 없음 (`ActionRun`에 board_id 컬럼 없음) |
| QA Scenario / Schedule | no | yes | `QaRun`/`QaRunBatch.board_id` |
| Security Profile / Schedule | no | yes | `SecurityRun`/`SecurityRunBatch.board_id` |
| Workspace Schedule | no | yes | 없음 |

Feature, Ticket, Board, Role, User, Agent, Channel, API key는 카탈로그가 아니다.
이들은 업무 상태나 보안 주체를 소유하므로 상속하지 않는다.
Claude Backend Profile은 instance registry와 Workspace assignment 관계를 가진
별도 모델이므로 generic catalog scope로 바꾸지 않는다.

## 조회와 override

- 조회는 Workspace context 하나뿐이다: Global + 현재 Workspace 행을 반환한다.
- Function처럼 안정적인 key가 있는 정의는 Workspace > Global 순서로 같은
  key를 resolve한다. `include_shadowed=true`는 관리 UI용 원본 전체를
  반환한다.
- Resource/Credential/Prompt Template은 ID 참조형이므로 자동으로 같은 이름을
  덮어쓰지 않고 적용 가능한 행을 합쳐서 보여준다.

## UI

Function, Credential, Resource, Prompt Template, Action, QA, Security,
Schedule은 각각 독립된 Workspace 메뉴와 URL을 사용한다. 중간 Automation
Catalog 화면은 두지 않는다.

Workspace 메뉴에서는 Global 행과 현재 Workspace 행만 함께 보여준다. 새
Function/Credential/Resource/Prompt Template을 등록할 때 Workspace를 비워
두면 Global, 현재 Workspace를 선택하면 Workspace 전용으로 저장한다. **Board
스코프 옵션은 UI에 없다** — 서버가 어차피 400으로 거부한다.

기존 `/catalog` URL은 북마크 호환을 위해 Functions 메뉴로 redirect한다.

## 새 관리 객체 체크리스트

1. 먼저 카탈로그 정의인지, 실행/소유 객체인지 결정한다.
2. 카탈로그라면 `CatalogScoped`의 `workspace_id`와 `catalogScopeOf`,
   `normalizeCatalogScope`, `canUseCatalogItem`을 사용한다 — 새 엔티티는
   `board_id` 컬럼을 아예 추가하지 않는다(레거시 10개 타입만 호환 목적으로
   보유).
3. Global 쓰기는 admin 권한으로 제한하고 Workspace 간 read/write를 거부한다.
4. REST와 MCP가 같은 상속 범위를 사용하게 한다.
5. Workspace Sidebar에 타입별 메뉴를 추가하고, Global 전용 중복 메뉴는
   만들지 않는다. 같은 화면에서 Global + 현재 Workspace를 관리한다.
6. 신규 Board-scope 생성 거부 + `list()`의 legacy `board_id` 행 배제를
   회귀 테스트로 고정한다(예: `workflow-functions.test.mjs`,
   `actions-scope.test.mjs` 패턴).
