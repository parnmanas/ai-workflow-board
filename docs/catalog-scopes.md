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
| Skill | yes | yes | `RunSkillSnapshot.run_id` (board_id 컬럼 없음) |

Skill은 이 모델을 뒤늦게(마이그레이션 `1760000000077`) 채택했다. 그 전까지
`skills.workspace_id`는 NOT NULL이었고 모든 조회가 단순 equality였기 때문에
global skill은 "없었다"가 아니라 **표현 자체가 불가능**했다. 채택하면서 두 가지가
다른 카탈로그 타입과 다르다:

- `board_id` 컬럼을 아예 만들지 않았다(신규 엔티티 규칙). `canUseCatalogItem()`
  호출부는 `board_id: null` 리터럴로 어댑트한다 —
  `apps/server/src/modules/skills/skill-scope.ts`.
- Global 유일성은 데코레이터의 복합 unique index가 아니라 **partial unique
  index** 두 개(`uq_skills_global_slug` / `uq_skills_workspace_slug`)가 보장한다.
  Postgres에서 `NULL != NULL` 이라 `(workspace_id, slug)` 복합 index는 global 행을
  전혀 제약하지 못한다 — `workflow_functions`가 쓰는 것과 같은 분리다. 데코레이터
  쪽 index는 partial index를 모르는 sql.js 개발 백엔드용으로만 남아 있다.

Skill은 slug 기준으로 Workspace가 Global을 **shadow** 한다(Function의 key와 같은
우선순위). 그래서 built-in을 커스터마이즈하는 방법은 global을 직접 고치는 것이
아니라 workspace로 **fork** 하는 것이다 — fork가 계속 이기는 동안 그 아래의
global은 업스트림 갱신을 계속 받는다. 상세는 `docs/skills.md`.

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

## Scope 변경 — Credential만 예외

카탈로그 정의의 scope 는 **만든 뒤에 바뀌지 않는다**. Function / Resource /
Prompt Template / Action / QA / Security / Workspace Schedule 의 update 경로는
scope 가 달라진 요청을 400 으로 거부하고, 새 scope 의 행을 따로 만들라고
안내한다. scope 는 그 행의 정체성에 가까워서, 옮기는 순간 그 행을 가리키던
참조들이 조용히 다른 의미가 된다.

`Credential` 만 예외다. 다른 카탈로그 정의는 내용을 다시 입력하면 그만이지만
credential 의 내용은 **비밀값**이라, 새로 만들라고 하면 운영자가 토큰을 다시
붙여넣고 그 credential 을 물고 있던 Agent · Resource · CLI 세션 설정 ·
Outreach 채널을 전부 손으로 다시 지정해야 한다. 그래서
`PATCH /api/credentials/:id` 는 `scope` 로 global ↔ workspace 이동을 허용한다
(`credentials.controller.ts` → `update()`). 규칙 네 가지:

- **권한**: global 쪽을 건드리는 모든 방향(global 행 편집, global 로 넓히기,
  global 에서 좁히기)에 `admin.global_credentials` 가 필요하다. Workspace
  credential 을 자기 workspace 안에서 고치는 것은 그대로 `admin.credentials`.
  클라이언트도 **이 권한**으로 판단한다 — `admin.access` 를 대신 쓰면 서버가
  403 할 선택지를 UI 가 제시하게 된다(`WorkspaceManagementPage.tsx`).
- **목적지는 보고 있는 Workspace 다**: body 의 `workspace_id` 는 예전 의미
  (호출자가 어느 workspace 에서 행동하는가)를 그대로 유지하면서, global 을
  좁힐 때의 목적지 역할을 겸한다. 그래서 Workspace credential 이 다른
  Workspace 로 한 번에 건너가지 못한다 — global 로 넓힌 뒤 다시 좁히면 되고,
  그 경로에는 아래 dependent 검사가 걸린다.
- **좁히기는 dependent 를 깨뜨리지 않는다**: `credential_id` 로 그 행을
  가리키는 `agents` / `resources` / `agent_session_cli_settings` /
  `outreach_channels` 중 목적지 Workspace 밖(다른 workspace 이거나
  `workspace_id IS NULL` = 인스턴스 전역)에 있는 것이 하나라도 있으면 409 로
  거부한다. 넓히기는 읽을 수 있는 쪽만 늘어나므로 검사하지 않는다.
- **흔적을 남긴다**: 비밀값을 읽을 수 있는 범위가 바뀌는 일이므로 reveal 과
  같은 급의 감사 항목(`credential_scope_changed`, old/new 는 `global` 또는
  `workspace:<id>`)을 남긴다. 값 자체는 절대 담지 않는다.

생성 시 scope 는 여전히 페이지 상단 "Workspace for new item" 선택이 정하고,
Edit 다이얼로그의 scope 선택기는 기존 행에만 나온다. 회귀 테스트는
`apps/server/test/credentials-scope-switch.test.mjs` 와
`apps/client/test/credential-scope-switch-ui.test.mjs`.

다른 카탈로그 타입에 같은 것을 붙이고 싶어지면, 먼저 "새로 만들기가 왜 안
되는가" 를 credential 의 비밀값만큼 구체적으로 답할 수 있어야 한다. 답이
"귀찮아서" 라면 붙이지 말 것 — 위 네 규칙(특히 dependent 검사)을 타입마다
다시 설계해야 한다.

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
