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

예전에는 Board 가 세 번째 scope 계층(Global < Account < Board)이었다. 커밋
`65adf0b` 가 카탈로그 아이템의 Board scope 를 Account 로 승격했고, 보드 자체가
제거되면서(`docs/tickets.md`) 남아 있던 `board_id` 호환 컬럼도 엔티티에서 사라졌다.

- `CatalogScoped`(`apps/server/src/common/catalog-scope.ts`)는 `account_id`
  하나뿐이다.
- `normalizeCatalogScope()` 는 `global` / `account` 외의 `scope`(예전
  `'board'` 포함)를 400 으로 거부한다. 구 `account` 값은 전송 경계에서 `account`로 읽는다.
- `canUseCatalogItem(row, accountId)` 는 Global 행과 그 Account 행만 허용한다.
- 실행 기록에도 Board 컨텍스트가 없다 — `WorkflowFunctionRun`, `QaRun(Batch)`,
  `SecurityRun(Batch)`, `ActionRun` 어디에도 `board_id` 가 없다.

## 적용 대상

### MCP credential 조회

`list_credentials({ account_id?, provider?, scope?, limit?, offset? })`는 접근 가능한
credential 목록을 `{ credentials, total, limit, offset }`으로 반환한다. 기본 페이지
크기는 50, 최대 100이다. `get_credential({ credential_id })`는 같은 메타데이터 한 건을
반환하며, 조회한 ID를 프로젝트·GitHub 도구 등의 `credential_id`에 넣을 수 있다.

DB 인증과 살아 있는 Runtime Host/runtime identity가 필요하다. 계정에 바인딩된
키는 그 계정과 Global credential만 조회한다(read 키도 허용). 계정에 바인딩되지
않은 full-scope Host는 전체 계정을 조회하며, `account_id`로 한 계정과 Global을
선택할 수 있다. `scope: 'account'` 또는 `'global'`은 해당 계층만 남긴다.

이름·설명·provider·소유 계정·환경변수 노출 설정/변수명·저장 상태·시각을 반환하고,
토큰·비밀번호·마스킹된 값·암호문은 반환하지 않는다. `credential_status`의 `ok`는
복호화 가능한 필드가 있다는 뜻이며 공급자의 인증 성공이나 토큰 유효성을 검증한
것은 아니다. 비어 있는 객체는 `empty`, 손상/복호화/형식 오류는 `unreadable`이다.
생성·수정과 비밀값 관리는 기존 Settings → Credentials를 사용한다.
두 도구는 기본 full 도구 프로필에 제공되며 compact에는 포함되지 않는다.

### 객체별 지원 범위

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
  index** 두 개(`uq_skills_global_slug` / `uq_skills_account_slug`)가 보장한다.
  Postgres에서 `NULL != NULL` 이라 `(account_id, slug)` 복합 index는 global 행을
  전혀 제약하지 못한다 — `workflow_functions`가 쓰는 것과 같은 분리다. 두 부분
  인덱스는 `Skill.ts`의 `@Index(..., { unique: true, where })`로 선언하며
  PostgreSQL과 SQLite(sql.js) 모두에 적용된다. `account`가 들어간 인덱스 이름은
  기존 DB와의 호환을 위해 유지한 이름이다.

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
- 목록 REST(`GET /api/functions`, `/api/credentials`, `/api/resources`)는 두 모드다
  (`catalogListAccountIds()`, `common/catalog-scope.ts`). `account_id`를 **명시**하면
  그 Account + Global 단일 뷰 — CLI 세션 설정 · Project · 런타임 슬롯의 credential
  picker, 티켓의 resource picker처럼 한 Account의 작업에 묶는 선택기가 쓴다.
  명시하지 않으면 접근 가능한 모든 Account + Global 행을 합친다(관리 화면).
  `bindRequest`가 `query.account_id`를 생성 기본 계정으로 덮어쓰므로 "명시"는
  `req.requestedAccountId`로 판정한다 — 기본 계정이 목록 필터가 되면 안 된다.
  여러 Account를 합친 Function 목록은 shadow를 한 우선순위로 합치지 않는다:
  `include_shadowed` 없이는 각 Account의 해소 결과의 합집합(모든 Account 행 +
  아직 상속하는 Account가 하나라도 있는 Global 행)이다. 회귀:
  `apps/server/test/catalog-list-aggregation.test.mjs`.

## UI

Function, Credential, Resource, Action, QA, Security, Schedule은 각각 독립된
메뉴와 전역 URL(`/functions`, `/resources`, `/actions`, `/qa`, `/security`, `/schedules` 등)을
사용한다. 중간 Automation Catalog 화면은 두지 않는다.

Functions, Credentials, Resources, Actions, Automation Schedules, QA Scenarios/Schedules,
Security Profiles/Schedules의 목록은 접근 가능한 계정을 합친다(Global을 지원하는
타입은 Global 행도 함께). QA Scenario는 Account 전용이며 합산 과정에서 ID로 중복을 제거한다.

**작업·카탈로그 화면에는 계정/Scope 선택기와 Owner 표시를 두지 않는다.** 예전
workspace 목록을 Account나 Scope라는 이름으로 다시 노출하지 않는다. 계정은
내부 권한·소유 경계이며, 계정 관리 자체는 `/settings/ownership`에서만 다룬다.
Functions / Credentials / Resources의 생성 소유권은 자동으로 정한다: 해당 타입의
Global 쓰기 권한이 있으면 Global, 아니면 첫 번째 접근 계정이다. 이 기본값은
목록 필터로 사용하지 않는다. 상세·수정·삭제는 해당 행의 실제 소유 계정으로
요청하고 검사하며, 편집으로 소유권을 바꾸지 않는다. Credential 선택도 기존
Resource가 사용할 수 있는 항목만 제시하지만 계정 이름은 표시하지 않는다.

Account Function은 소유 계정에서 실행한다. Global Function은 연결한 Ticket의
소유 계정, Ticket이 없으면 로그인 시 정한 기본 접근 계정에서 실행한다. 별도의
실행 계정 선택은 없다. 내부 귀속 규칙은
`apps/client/src/components/admin/catalogOwner.logic.ts`와 `FunctionManager.tsx`,
회귀 검증은 `apps/client/test/catalog-owner.test.mjs`에서 다룬다.

Teams도 생성·편집에서 Scope 및 허용 계정 목록을 노출하지 않는다. 새 팀은 기본
접근 계정에 귀속되고 기존 팀의 소유권·허용 계정 정책은 편집으로 바뀌지 않는다.
Shared Memory 역시 기본 접근 계정을 자동 사용하며 계정 선택기는 두지 않는다.

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
- **agent env 도 같이 넓어진다**: "Expose to agents as environment variables"
  (`agent_env`)가 켜진 credential 을 global 로 넓히면 모든 계정의 에이전트
  실행이 그 env 를 받는다(`docs/agent-manager.md` → "Credential env for agent
  runs").

이 API 계약은 기존 연동을 위해 유지한다. Credentials 화면은 생성·편집 모두
Scope 선택기를 제공하지 않으며, 기존 credential 편집은 원래 소유권을 그대로
보낸다. API의 권한·dependent 검증은 `apps/server/test/credentials-scope-switch.test.mjs`,
화면에서 scope 선택이 없고 수정·삭제가 실제 소유권을 보존하는지는
`apps/client/test/credential-scope-switch-ui.test.mjs`가 검증한다.

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
   만들지 않는다. 같은 화면에서 Global + 접근 가능한 모든 계정의 정의를 함께
   관리하고(행마다 소유 계정 표시), 새 정의의 소유 계정은 화면에서 명시적으로 고른다.
6. Global/Account 경계(접근 권한 없는 Account 행 거부, scope 변경 거부)를 회귀
   테스트로 고정한다(예: `workflow-functions.test.mjs`, `actions-scope.test.mjs`
   패턴).
