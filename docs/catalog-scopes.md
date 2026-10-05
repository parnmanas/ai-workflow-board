# Catalog scopes

AWB 관리 객체는 소유 객체와 재사용 가능한 정의 객체를 구분한다. 재사용
정의는 `account_id` (nullable) 하나로 scope를 표현한다.

| Scope | `account_id` | Resolution priority |
| --- | --- | --- |
| Global | `NULL` | 1 (fallback) |
| Account | account UUID | 2 |

Scope는 생성 후 변경하지 않는다. 다른 scope가 필요하면 새 정의를 만든다. 이
규칙은 한 행을 다른 tenant로 옮기는 실수와 실행 이력의 의미 변경을 막는다.

## Board 계층은 없다

예전에는 Board 가 세 번째 scope 계층(Global < Workspace < Board)이었다. 커밋
`65adf0b` 가 카탈로그 아이템의 Board scope 를 Workspace 로 승격했고, 보드 자체가
제거되면서(`docs/tickets.md`) 남아 있던 `board_id` 호환 컬럼도 엔티티에서 사라졌다.

- `CatalogScoped`(`apps/server/src/common/catalog-scope.ts`)는 `account_id`
  하나뿐이다.
- `normalizeCatalogScope()` 는 `global` / `account` 외의 `scope`(예전
  `'board'` 포함)를 400 으로 거부한다. 구 `workspace` 값은 전송 경계에서 `account`로 읽는다.
- `canUseCatalogItem(row, accountId)` 는 Global 행과 그 Account 행만 허용한다.
- 실행 기록에도 Board 컨텍스트가 없다 — `WorkflowFunctionRun`, `QaRun(Batch)`,
  `SecurityRun(Batch)`, `ActionRun` 어디에도 `board_id` 가 없다.

## 적용 대상

| Type | Global | Account |
| --- | --- | --- |
| Function | yes | yes |
| Credential | yes | yes |
| Resource | yes | yes |
| Action | no | yes |
| QA Scenario / Schedule | no | yes |
| Security Profile / Schedule | no | yes |
| Automation Schedule | no | yes |
| Skill | yes | yes |

Skill은 이 모델을 뒤늦게(마이그레이션 `1760000000077`, 보드 제거 때 코드에서 삭제 — 운영 DB 는 실행 완료) 채택했다. 그 전까지
`skills.account_id`는 NOT NULL이었고 모든 조회가 단순 equality였기 때문에
global skill은 "없었다"가 아니라 **표현 자체가 불가능**했다. 스코프 판정은
`apps/server/src/modules/skills/skill-scope.ts` 가 `canUseCatalogItem()` 을 감싸서
하고, 다른 카탈로그 타입과 다른 점이 하나 있다:

- Global 유일성은 데코레이터의 복합 unique index가 아니라 **partial unique
  index** 두 개(`uq_skills_global_slug` / `uq_skills_workspace_slug`)가 보장한다.
  Postgres에서 `NULL != NULL` 이라 `(account_id, slug)` 복합 index는 global 행을
  전혀 제약하지 못한다 — `workflow_functions`가 쓰는 것과 같은 분리다. 데코레이터
  쪽 index는 partial index를 모르는 sql.js 개발 백엔드용으로만 남아 있다.

Skill은 slug 기준으로 Account가 Global을 **shadow** 한다(Function의 key와 같은
우선순위). 그래서 built-in을 커스터마이즈하는 방법은 global을 직접 고치는 것이
아니라 account로 **fork** 하는 것이다 — fork가 계속 이기는 동안 그 아래의
global은 업스트림 갱신을 계속 받는다. 상세는 `docs/skills.md`.

Ticket, Project, User, Channel, API key는 카탈로그가 아니다. 이들은 업무 상태나
보안 주체를 소유하므로 상속하지 않는다 — Project 는 저장소 1개와 호스트별 main
clone 폴더를 소유하는 Account 전용 객체다(`account_id` NOT NULL).
Claude Backend Profile은 인스턴스 전역 단일 목록인 별도 모델(Account 배정 계층
없음 — `docs/cli-runtime-profiles.md`)이므로 generic catalog scope로 바꾸지 않는다.

## 조회와 override

- 실행에 쓸 카탈로그 정의는 실제 실행의 Account context에서 Global + 그 Account 행을 해소한다.
  작업 목록의 접근 계정 합산과는 별도다. 서로 다른 계정의 같은 key를 한 우선순위로 합치지 않는다.
- Function처럼 안정적인 key가 있는 정의는 Account > Global 순서로 같은
  key를 resolve한다. `include_shadowed=true`는 관리 UI용 원본 전체를
  반환한다.
- Resource/Credential은 ID 참조형이므로 자동으로 같은 이름을 덮어쓰지 않고
  적용 가능한 행을 합쳐서 보여준다.

## UI

Function, Credential, Resource, Action, QA, Security, Schedule은 각각 독립된
메뉴와 전역 URL(`/functions`, `/resources`, `/actions`, `/qa`, `/security`, `/schedules` 등)을
사용한다. 중간 Automation Catalog 화면은 두지 않는다.

계정 선택은 소유권 관리와 새 정의의 귀속을 정하는 곳에만 둔다. Actions,
Automation Schedules, QA Scenarios/Schedules, Security Profiles/Schedules의 목록은
접근 가능한 계정을 합친다. Global QA Scenario는 합산 과정에서 ID로 중복을 제거한다.
Global을 지원하는 정의의 생성 시 계정을 비워 두면 Global, 계정을 지정하면 Account 전용으로 저장한다.
상세·수정 권한은 선택한 계정이나 화면 경로 대신 해당 행의 실제 소유 계정으로 검사한다.

기존 `/catalog` URL은 북마크 호환을 위해 Functions 메뉴로 redirect한다.

## Scope 변경 — Credential만 예외

카탈로그 정의의 scope 는 **만든 뒤에 바뀌지 않는다**. Function / Resource /
Action / QA / Security / Automation Schedule 의 update 경로는
scope 가 달라진 요청을 400 으로 거부하고, 새 scope 의 행을 따로 만들라고
안내한다. scope 는 그 행의 정체성에 가까워서, 옮기는 순간 그 행을 가리키던
참조들이 조용히 다른 의미가 된다.

`Credential` 만 예외다. 다른 카탈로그 정의는 내용을 다시 입력하면 그만이지만
credential 의 내용은 **비밀값**이라, 새로 만들라고 하면 운영자가 토큰을 다시
붙여넣고 그 credential 을 물고 있던 Resource · Project · CLI 세션 설정 ·
Outreach 채널을 전부 손으로 다시 지정해야 한다. 그래서
`PATCH /api/credentials/:id` 는 `scope` 로 global ↔ account 이동을 허용한다
(`credentials.controller.ts` → `update()`). 규칙 네 가지:

- **권한**: global 쪽을 건드리는 모든 방향(global 행 편집, global 로 넓히기,
  global 에서 좁히기)에 `admin.global_credentials` 가 필요하다. Account
  credential 을 자기 계정 안에서 고치는 것은 그대로 `admin.credentials`.
  클라이언트도 **이 권한**으로 판단한다 — `admin.access` 를 대신 쓰면 서버가
  403 할 선택지를 UI 가 제시하게 된다(`AccountManagementPage.tsx`).
- **목적지를 명시한다**: global을 좁힐 때 body의 `account_id`가 목적지 계정이다.
  기존 Account credential의 수정 권한은 실제 소유 계정으로 검사한다. Account credential이 다른
  Account로 한 번에 건너가지 못한다 — global 로 넓힌 뒤 다시 좁히면 되고,
  그 경로에는 아래 dependent 검사가 걸린다.
- **좁히기는 dependent 를 깨뜨리지 않는다**: `credential_id` 로 그 행을
  가리키는 `resources` / `projects` / `agent_session_cli_settings` /
  `agent_session_executions` / `outreach_channels`(`CREDENTIAL_DEPENDENTS`) 중 목적지 Account 밖(다른 account 이거나
  `account_id IS NULL` = 인스턴스 전역)에 있는 것이 하나라도 있으면 409 로
  거부한다. 넓히기는 읽을 수 있는 쪽만 늘어나므로 검사하지 않는다.
- **흔적을 남긴다**: 비밀값을 읽을 수 있는 범위가 바뀌는 일이므로 reveal 과
  같은 급의 감사 항목(`credential_scope_changed`)에 이전·새 범위를 남긴다.
  값 자체는 절대 담지 않는다.

생성 시 scope 는 페이지 상단 "Account for new item" 선택이 정하고,
Edit 다이얼로그의 scope 선택기는 기존 행에만 나온다. 회귀 테스트는
`apps/server/test/credentials-scope-switch.test.mjs` 와
`apps/client/test/credential-scope-switch-ui.test.mjs`.

다른 카탈로그 타입에 같은 것을 붙이고 싶어지면, 먼저 "새로 만들기가 왜 안
되는가" 를 credential 의 비밀값만큼 구체적으로 답할 수 있어야 한다. 답이
"귀찮아서" 라면 붙이지 말 것 — 위 네 규칙(특히 dependent 검사)을 타입마다
다시 설계해야 한다.

## 새 관리 객체 체크리스트

1. 먼저 카탈로그 정의인지, 실행/소유 객체인지 결정한다.
2. 카탈로그라면 `CatalogScoped`의 `account_id`와 `catalogScopeOf`,
   `normalizeCatalogScope`, `canUseCatalogItem`을 사용한다.
3. Global 쓰기는 admin 권한으로 제한하고 Account 간 read/write를 거부한다.
4. REST와 MCP가 같은 상속 범위를 사용하게 한다.
5. Sidebar에 타입별 전역 메뉴를 추가하고, Global 전용 중복 메뉴는
   만들지 않는다. 같은 화면에서 Global + 선택한 소유 계정의 정의를 관리한다.
6. Global/Account 경계(접근 권한 없는 Account 행 거부, scope 변경 거부)를 회귀
   테스트로 고정한다(예: `workflow-functions.test.mjs`, `actions-scope.test.mjs`
   패턴).
