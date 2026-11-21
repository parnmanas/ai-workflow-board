# AI Workflow Board (AWB)

AWB의 기본 작업 화면은 Runtime Host의 네이티브 CLI 세션이다. 대화 원본은 호스트에 보관한다. 티켓·프로젝트·팀 미션으로 업무를 추적하고 MCP로 자동화한다.

## 작업과 소유권

- 세션·채팅에서 받은 일은 그 자리에서 수행한다. **티켓 생성은 사용자가 명시적으로 요청할 때만 한다.** 하위·후속 티켓에도 같은 규칙을 적용한다. 기존 티켓을 지목하면 그 티켓을 사용한다. 티켓 생성 여부를 되묻지 않고, 막힌 점이나 추가 작업은 답변으로 알린다.
- 티켓 하나는 assignee 한 명이 끝까지 맡는다. 결과를 댓글로 남기고 `done` 또는 사람 확인이 필요한 `review`로 옮긴다. 티켓 목록은 접근 가능한 계정의 업무를 합쳐 태그와 프로젝트로 분류한다. [티켓과 프로젝트](docs/tickets.md)
- User는 로그인 신원이고 **Account는 소유·실행 경계**다. `accounts.owner_user_id`로 실제 소유자를 확인한다. 호스트·키·세션·업무 데이터에 같은 경계를 적용하며, 관리자도 다른 계정의 업무를 열람하거나 그 호스트에서 실행할 수 없다. Global 공유는 명시적으로 생성한 카탈로그 항목에만 적용한다. [소유권](docs/ownership.md) · [카탈로그 범위](docs/catalog-scopes.md)
- 전송 필드는 `account_id`, `X-Account-Id`, `*_automation_schedule`을 쓴다. 예전 workspace 소유권 이름은 DB 이관에서만 변환한다. `workspace_folder`처럼 실제 작업 폴더를 뜻하는 이름은 유지한다. [소유권 이관](docs/runbooks/account-ownership-migration.md)

## 개발과 검증

서버는 NestJS·TypeORM, 클라이언트는 React를 사용한다. SQLite(sql.js)와 PostgreSQL을 함께 지원한다. 외부 에이전트 연동은 `@modelcontextprotocol/sdk`의 Streamable HTTP 계약을 유지한다.

저장소 루트에서 `npm run build`로 전체를 빌드한다. 테스트는 변경한 워크스페이스에 맞춰 `npm test -w server`, `npm test -w client`, `npm test -w awb-agent-manager`로 실행한다. 설치·개발 서버·브라우저 테스트 명령은 [개발 가이드](README.md#development)에 있다.

## 변경할 때 확인할 계약

- **호스트 실행과 통신** — CLI 수명주기·하위 프로세스·지속 세션은 `apps/agent-manager/`가 담당한다. 서버와 매니저가 주고받는 SSE·RPC·하트비트 필드는 양쪽을 같은 변경으로 반영한다. 매니저 소스 변경은 루트 빌드 후 커밋·푸시한다. 패키지 버전은 `main` 반영 시 CI가 계산한다. [매니저 릴리스](docs/runbooks/agent-manager-release.md) · [새 CLI 연결](docs/runbooks/cli-module-wiring.md)
- **티켓과 MCP** — 티켓 쓰기는 `TicketService`, 큐 디스패치는 `TicketDispatchService`를 거친다. JSON 배열 필드를 바꿀 때는 저장·조회 경로를 함께 확인한다. 새 MCP 도구는 권한 등급과 매니저의 티켓 참조 분류를 확인한다. [필드 연결](docs/runbooks/field-wiring.md) · [MCP 도구 등록](docs/runbooks/mcp-tool-wiring.md)
- **DB 스키마** — 부팅 시 TypeORM이 스키마를 동기화하므로 인덱스는 엔티티에 선언한다. 이관할 엔티티는 `entities/index.ts`와 `MIGRATION_ENTITY_ORDER`에 같은 커밋으로 등록한다. [엔티티 목록](apps/server/src/entities/index.ts) · [이관 순서와 예외](apps/server/src/modules/migration/migration-entity-registry.ts)
- **DB 쓰기** — sql.js 트랜잭션은 `dataSource.transaction()`으로 열고 콜백이 받은 manager로 쓴다. 파일 저장은 커밋 뒤 `flushSqljs()` 또는 `flushOntologySqljs()`로 한다. 병렬 트랜잭션 동작은 PostgreSQL에서 검증한다. [DB 구현과 제약](apps/server/src/db.ts)
- **세션과 미션** — 세션은 첫 AWB 실행 때 계정의 CLI 기본값을 기록한다. 미션의 `shared` step은 운영자의 프로젝트 폴더에서 실행하므로 `run_provision`은 `isolated` step에만 보낸다. [세션의 실행 설정과 재시작](docs/agent-sessions.md#소유권과-실행-설정-고정) · [미션 실행과 재시도](docs/orchestration.md)
- **비즈니스·마케팅 화면** — `BusinessPageHeader`를 쓰고 `.business-shell`의 본문 폭에 맞춰 배치한다. 새 페이지는 모바일·사이드바가 열린 태블릿·가로 화면에서 긴 이름, 주요 버튼과 보조 메뉴의 실제 조작을 확인한다. [헤더 배치](docs/business.md#헤더와-모바일-배치) · [브라우저 테스트](apps/client/test/business-header.e2e.mjs)

기능별 계약과 운영 절차는 [문서 색인](docs/README.md)에서 찾아 해당 문서에 갱신한다.
