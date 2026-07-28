# Catalog scopes

AWB 관리 객체는 소유 객체와 재사용 가능한 정의 객체를 구분한다. 재사용
정의는 `workspace_id`와 `board_id` 두 nullable 열로 동일한 scope를 표현한다.

| Scope | `workspace_id` | `board_id` | Resolution priority |
| --- | --- | --- | --- |
| Global | `NULL` | `NULL` | 1 (fallback) |
| Workspace | workspace UUID | `NULL` | 2 |
| Board | workspace UUID | board UUID | 3 |

`board_id`가 있으면 `workspace_id`도 반드시 있고, 그 Board가 해당 Workspace에
속해야 한다. Scope는 생성 후 변경하지 않는다. 다른 scope가 필요하면 새
정의를 만든다. 이 규칙은 한 행을 다른 tenant로 옮기는 실수와 실행 이력의
의미 변경을 막는다.

## 적용 대상

| Type | Global | Workspace | Board | 이유 |
| --- | --- | --- | --- | --- |
| Function | yes | yes | yes | 실행 정의이며 key 기준 override 가능 |
| Credential | yes | yes | yes | 비밀 정의를 필요한 범위까지만 노출 |
| Resource | yes | yes | yes | 문서·저장소 정의를 상속 |
| Prompt Template | yes | yes | yes | 프롬프트 정의를 상속 |
| Action | no | yes | yes | Workspace Agent와 실행 방/이력을 직접 소유 |
| QA Scenario / Schedule | no | yes | yes | Workspace Agent 및 실행 이력 소유 |
| Security Profile / Schedule | no | yes | yes | Workspace Agent 및 실행 이력 소유 |
| Workspace Schedule | no | yes | yes | Workspace Agent로 실제 작업 dispatch |

Feature, Ticket, Board, Role, User, Agent, Channel, API key는 카탈로그가 아니다.
이들은 업무 상태나 보안 주체를 소유하므로 상속하지 않는다.
Claude Backend Profile은 instance registry와 Workspace assignment 관계를 가진
별도 모델이므로 generic catalog scope로 바꾸지 않는다.

## 조회와 override

- Board context 조회: Global + Workspace + 해당 Board 행을 반환한다.
- Workspace context 조회: Global + Workspace 행을 반환한다.
- 관리용 `include_all_scopes`: 현재 Workspace에 속한 모든 Board 행까지 한 번에
  반환한다.
- Function처럼 안정적인 key가 있는 정의는 Board > Workspace > Global 순서로
  같은 key를 resolve한다. `include_shadowed=true`는 관리 UI용 원본 전체를
  반환한다.
- Resource/Credential/Prompt Template은 ID 참조형이므로 자동으로 같은 이름을
  덮어쓰지 않고 적용 가능한 행을 합쳐서 보여준다.

## UI

`/ws/:workspaceId/catalog`이 단일 관리 진입점이다. Function, Credential,
Resource, Prompt Template, Action, QA, Security, Schedule을 탭으로 전환하며,
상단의 공통 scope selector가 새 항목의 scope를 정한다. 목록은 scope badge와
함께 한 화면에서 전체 scope를 보여준다.

기존 Workspace/Admin/Board별 관리 URL은 이 Catalog로 redirect한다. 이 호환
경로는 기존 북마크와 외부 링크를 깨지 않기 위해 유지한다.

## 새 관리 객체 체크리스트

1. 먼저 카탈로그 정의인지, 실행/소유 객체인지 결정한다.
2. 카탈로그라면 `CatalogScoped`의 두 열과 `catalogScopeOf`,
   `normalizeCatalogScope`, `assertCatalogBoardScope`를 사용한다.
3. Global 쓰기는 admin 권한으로 제한하고 Workspace 간 read/write를 거부한다.
4. REST와 MCP가 같은 상속 범위와 Board 검증을 사용하게 한다.
5. 별도 Sidebar/Admin/Board 메뉴를 추가하지 않고 Automation Catalog에 탭을
   추가한다.
6. PostgreSQL additive/nullable 변경 migration과 SQLite synchronize 양쪽을
   검증한다.
