## Project

**AI Workflow Board (AWB)**

AI Workflow Board는 AI Agent가 MCP를 통해 연결하여 자율적으로 티켓을 처리하는 칸반 기반 워크플로우 자동화 플랫폼이다. Agent가 역할(Assignee/Reporter/Reviewer)별로 티켓을 수신하고, subagent를 통해 실제 작업을 수행한 뒤, 결과를 comment로 남기고 티켓 상태를 이동시키는 자동화 루프를 제공한다.

**Core Value:** Agent가 MCP로 연결되어 티켓을 자율 처리하고, 완료된 티켓이 다음 역할의 Agent에게 자동 트리거되는 연속 자동화 루프.

### Constraints

- **Tech Stack**: 기존 NestJS + React + TypeORM 유지 — 전면 재작성 불가
- **MCP 호환**: @modelcontextprotocol/sdk 기반 Streamable HTTP 유지
- **DB 호환**: SQLite(개발) + PostgreSQL(운영) 이중 지원 유지
- **Agent 독립성**: AWB는 Agent의 내부 구현에 의존하지 않음 — MCP 인터페이스만 사용
- **Agent Manager sync**: SSE 이벤트, subagent 위임, persistent ticket/chat session, CLI lifecycle 변경은 `apps/agent-manager/` 에서 처리. 절차 → (1) `apps/agent-manager/src/` 수정, (2) `npm run build` 통과 확인 (workspace root turbo 빌드 포함), (3) commit + push — **버전은 손으로 범프하지 말 것**: `main` 랜딩 시 `.github/workflows/publish-agent-manager.yml` 이 `apps/agent-manager/scripts/compute-publish-version.mjs` 로 버전을 자동 계산해 publish 한다 (상세 절차는 `docs/runbooks/agent-manager-release.md` 참조). SSE 이벤트 타입을 추가/변경한 경우 서버측 (`apps/server/src/modules/agent-manager/`) 변경과 같은 PR 으로 묶을 것 — agent-manager 와 AWB 서버가 같은 contract 를 본다. `agent_trigger` payload 의 `harness_config` (Board/Workspace 별 CLI 하네스, `apps/server/src/common/harness-config.ts` 스키마) 도 이 SSE contract 에 포함 — 키 추가/변경 시 server·agent-manager 양쪽을 같은 PR 로 (필드별 CLI 매핑은 `docs/agent-manager.md` → "Harness config" 참조).

## Technology Stack

## Languages
- TypeScript 5.6.0 - Used throughout client and server
- HTML/CSS - Client UI rendering
- JavaScript (Node.js) - Runtime and build tooling
## Runtime
- Node.js (version specified via packageManager: npm@11.6.1)
- npm 11.6.1
- Lockfile: package-lock.json present
## Frameworks
- NestJS 11.0.0 - Backend REST API framework
- React 18.3.0 - Frontend UI library
- React Router 7.14.0 - Client-side routing
- None detected in package.json (no jest, vitest, mocha configured)
- Vite 6.0.0 - Frontend bundler and dev server
- Turbo 2.4.0 - Monorepo build orchestration
- TypeScript 5.6.0 - Language compiler
- tsx 4.19.0 - TypeScript executor (server dev)
- @nestjs/serve-static 5.0.0 - Serves client dist from server
## Key Dependencies
- @modelcontextprotocol/sdk 1.29.0 - MCP server implementation (core feature)
- TypeORM 0.3.20 - ORM for database abstraction
- pg 8.20.0 - PostgreSQL client driver
- sql.js 1.12.0 - SQLite (for embedded database mode)
- bcryptjs 3.0.3 - Password hashing (SALT_ROUNDS: 10)
- zod 4.3.6 - Schema validation and type inference
- reflect-metadata 0.2.0 - Decorator metadata reflection (required by NestJS)
- rxjs 7.8.0 - Reactive programming library (NestJS dependency)
- dotenv - Environment variable loading in main.ts
- Express 5.0.0 (via @nestjs/platform-express) - Underlying HTTP server
- cors enabled via NestJS app configuration
## Configuration
- Configured via environment variables (see .env section below)
- `.env` file expected (not committed, see docker-compose.env.example)
- Development mode: uses SQLite by default (auto-saves to database/data.db)
- Production mode: uses PostgreSQL
- `nest build` - Compiles server to dist/
- `tsc && vite build` - Builds client (TypeScript + Vite bundle)
- Turbo handles monorepo task orchestration
- Client dist served from server's static directory: `join(__dirname, '..', '..', 'client', 'dist')`
- Development: `nest start --watch` (via tsx)
- Production: `node dist/main.js`
- Compiled output: `apps/server/dist/`
- Development: Vite dev server on port 7700 (proxies /api and /mcp to 7701)
- Build output: `apps/client/dist/`
- React entry: `src/main.tsx`
## Platform Requirements
- Node.js with npm 11.6.1+
- Port 7700 available (Vite dev server)
- Port 7701 available (NestJS server)
- Port 5432 available (PostgreSQL, if using Postgres in dev)
- Docker and docker-compose (see docker-compose.yml)
- PostgreSQL 16-alpine (as service)
- Node.js runtime
- Port 7701 for server
- GitHub Container Registry access (image: ghcr.io/parnmanas/ai-workflow-board:latest)
## Database Configuration
- Type: SQLite (sql.js)
- Location: `database/data.db` (auto-created)
- Auto-save enabled
- Synchronize enabled (auto-migrate schema)
- Port: 5432
- Connection via TypeORM DataSource
- Schema auto-sync disabled in production
- Also supported via TypeORM (configurable via DB_TYPE env var)
- **Corrupt dev DB**: a malformed `data.db` ("database disk image is malformed") used to hang boot ~25s (killing agent subagents at exit 143). `ensureSqljsDbHealthy()` in `db.ts` now runs a sql.js integrity check *before* TypeORM initializes (wired into both `initDb()` and `main.ts` bootstrap) — sql.js/dev only, Postgres untouched. A corrupt file aborts in ~1s with a clear message; `rm database/data.db` to recreate, or set `AWB_DB_AUTORECOVER=1` to auto-backup to `data.db.corrupt-<ts>` + recreate empty. The same guard also covers the independent Ontology Graph sql.js file (`database/ontology.db`, ticket 6ca4894a) via the sibling `ensureOntologySqljsDbHealthy()` (ticket b646ed54), wired at the same two call sites. See README → Development → Troubleshooting.
- **트랜잭션 직렬화 큐 — sql.js**: sql.js 백엔드(`db.ts`의 `AppDataSource`)는 단일 WASM 인스턴스/단일 커넥션이라 진짜 풀링이 없다 — 겹치는(overlapping) `dataSource.transaction()` 호출이 같은 커넥션을 공유해 "cannot start a transaction within a transaction" 또는 "Transaction is not started yet, start transaction before committing or rolling it back." 에러로 실패하거나, 한쪽의 실패 처리가 다른 쪽의 진행 중이던 트랜잭션까지 롤백시켜 쓰기가 조용히 유실될 수 있었다. `db.ts`의 `serializeSqljsTransactions()`가 sqljs 백엔드에서만 `dataSource.manager.transaction()` 호출을 FIFO 큐로 직렬화해 해소 — `AppDataSource`(standalone 진입점)와 `DatabaseModule`(NestJS 진입점) 생성 시 양쪽에 적용된다. 같은 호출 체인 내 중첩(nested) `transaction()` 호출은 AsyncLocalStorage로 감지해 큐를 우회하고 즉시 실행한다(SAVEPOINT로 이미 안전 — 큐잉하면 데드락). Postgres/MySQL은 그대로 네이티브 풀 기반 동시 트랜잭션을 유지하며 영향 없음. 이 큐는 겹치는 호출이 에러·유실 없이 끝나도록 순차 실행만 보장할 뿐 진짜 병렬 격리를 재현하지는 않으므로, sql.js 기준 동시성 테스트의 통과를 Postgres의 실제 동시 트랜잭션 동작과 동일시하지 말 것 — 진짜 병렬 트랜잭션 검증은 Postgres 전용으로 분리할 것. outreach 모듈 등 기존 claim-first + 보상삭제(compensate) 우회 코드는 이 큐 도입과 별개로 유지 중이며, 트랜잭션 기반으로 되돌릴지는 별도 판단 사항.
## Environment Variables
- `DB_TYPE` - 'sqlite' | 'postgres' | 'mysql' (default: sqlite)
- `DB_HOST` - Database hostname (default: localhost)
- `DB_PORT` - Database port (sqlite ignored, postgres 5432, mysql 3306)
- `DB_USER` - Database username (default: postgres/root)
- `DB_PASS` - Database password (required for production)
- `DB_NAME` - Database name (default: ai_workflow)
- `NODE_ENV` - 'development' | 'production'
- `PORT` - Server port (default: 7701)
- `CORS_ORIGIN` - CORS origin (default: true = reflect request origin in dev)
- `MCP_API_KEYS` - Comma-separated API keys, optionally with agent names (format: "agentName:key,key2")
- `MCP_DEV_MODE` - Set to 'true' to disable API key requirement in dev
- `AGENT_API_KEY` - Static API key for agent authentication (checked via X-Agent-Key header)
- `AGENT_DEV_MODE` - Set to 'true' to allow unauthenticated agent access
## Port Configuration
- 7700 - Vite client dev server (with /api and /mcp proxies)
- 7701 - NestJS server API and MCP endpoint
- 7701 - Combined server (serves client + API + MCP)

## Conventions

## Naming Patterns
- Entity files: PascalCase (e.g., `Board.ts`, `User.ts`) - located in `apps/server/src/entities/`
- Controller files: kebab-case with `.controller.ts` suffix (e.g., `boards.controller.ts`) - located in `apps/server/src/modules/{feature}/`
- Service files: kebab-case with `.service.ts` suffix (e.g., `auth.service.ts`) - located in `apps/server/src/services/`
- Module files: kebab-case with `.module.ts` suffix (e.g., `boards.module.ts`)
- React components: PascalCase (e.g., `Board.tsx`, `TicketCard.tsx`) - located in `apps/client/src/components/`
- Hooks: camelCase with `use` prefix (e.g., `useBoard.ts`) - located in `apps/client/src/hooks/`
- Context files: PascalCase with `Context.tsx` suffix (e.g., `AuthContext.tsx`) - located in `apps/client/src/contexts/`
- Guards: kebab-case with `.guard.ts` suffix (e.g., `auth.guard.ts`) - located in `apps/server/src/common/guards/`
- Decorators: kebab-case with `.decorator.ts` suffix (e.g., `current-user.decorator.ts`) - located in `apps/server/src/common/decorators/`
- Async functions: camelCase (e.g., `async login(email, password)`, `async refresh()`)
- NestJS handlers: camelCase with method name (e.g., `@Get() list(...)`, `@Post() create(...)`)
- React hooks: camelCase starting with `use` (e.g., `useBoard`, `useAuth`)
- Private methods: camelCase prefixed with underscore (e.g., `private _resolveAgentId(...)`)
- Helper functions: camelCase (e.g., `parseTicket()`, `parseComments()`)
- Constants: UPPER_SNAKE_CASE (e.g., `MAX_IMAGE_SIZE`, `SESSION_TTL_MS`, `SALT_ROUNDS`)
- Local variables: camelCase (e.g., `boardId`, `currentUser`, `showToast`)
- Database/API fields: snake_case (e.g., `workspace_id`, `created_at`, `channel_ids`)
- TypeScript/React state: camelCase (e.g., `isAuthenticated`, `currentWorkspaceId`, `selectedChannelIds`)
- Interfaces: PascalCase, often plural for collections (e.g., `User`, `Board`, `TicketDetailProps`)
- Types: PascalCase (e.g., `CurrentUserData`)
- Enum values: UPPER_SNAKE_CASE
- Generic type parameters: Single uppercase letter (e.g., `<T>`, `<R>`)
## Code Style
- Tool: None configured (no .prettierrc or similar detected)
- **Line length:** No hard limit enforced, but observe natural breaks
- **Indentation:** 2 spaces (observed in all files)
- **Semicolons:** Required at end of statements
- **Quotes:** Single quotes in TypeScript, template literals for interpolation
- Tool: None configured (no .eslintrc detected)
- **TypeScript configuration:**
## Import Organization
- No explicit path aliases configured (no baseUrl/paths in tsconfig)
- Relative imports use `../` navigation (e.g., `../../entities/Board`)
## Error Handling
- **Server (NestJS):**
- **Client (React):**
## Logging
- Categorized logging: `logService.info('System', 'Message', { meta })`, `logService.error('Category', 'Message')`
- Log levels: `info`, `warn`, `error`, `debug`
- Categories: 'MCP', 'Discord', 'Notification', 'DB', 'Auth', 'System', etc.
- Logs stored in memory (max 2000 entries) with dual output to console
- In-memory storage for admin UI access via `/admin/logs` endpoint
- Example from `main.ts`:
## Comments
- Document non-obvious business logic (e.g., permission resolution, session management)
- Explain guard/decorator behavior and expectations
- Mark important constants with their purpose
- Do not comment obvious code (e.g., variable assignments, straightforward loops)
- Minimal use observed
- Type interfaces and decorators may include JSDoc for clarity
- Method signatures rely on TypeScript types for documentation
## Function Design
- Controllers handle request validation and routing, typically 20-40 lines
- Services contain business logic, vary in size (20-100+ lines)
- Helper functions stay focused on single transformation (e.g., `parseTicket()`, `parseComments()`)
- Request objects use type `any` without strict typing in many cases
- Body parameters use `@Body() body: any` pattern
- Optional query parameters extracted via `@Query()`
- Dependent parameters extracted via `@Param()`
- Use object destructuring for multiple parameters
- Controllers return Express `Response` objects with explicit status codes and JSON
- Services return typed data (User, Board, Ticket, etc.) or null on failure
- Async functions return Promises with generic types (e.g., `Promise<Board>`)
- Example pattern: `async function loadTicketFull(ticketRepo: Repository<Ticket>, id: string): Promise<Ticket | null>`
## Module Design
- Barrel exports in `index.ts` files (e.g., `apps/server/src/entities/index.ts`)
- NestJS modules use `@Module({ imports: [...], controllers: [...], providers: [...] })`
- Services provided to modules via `providers` array for dependency injection
- Example from `boards.module.ts`:
- `apps/server/src/entities/index.ts` exports all entity types
- 단, 엔티티 배럴은 **혼자 완결되지 않는다** — 이관 레지스트리 등록이 한 쌍으로 따라온다. 아래 "Entity Naming (Database)" 참고.
- Each module has its own file structure without explicit barrel files (imports done directly)
## Entity Naming (Database)
- `@Entity('table_name')` for table mapping
- `@PrimaryGeneratedColumn('uuid')` for ID generation
- `@Column()` with type and options for fields
- `@CreateDateColumn()` and `@UpdateDateColumn()` for timestamps
- `@ManyToOne()`, `@OneToMany()` for relationships
- `@JoinColumn()` for foreign key specification
- **배럴 export 와 이관 레지스트리 등록은 한 쌍이다.** `apps/server/src/entities/index.ts` 에 `export { Foo } from './Foo';` 를 넣었으면 **같은 커밋에서** `apps/server/src/modules/migration/migration-entity-registry.ts` 의 `MIGRATION_ENTITY_ORDER` 에도 클래스명을 추가하라. 빠뜨리면 (1) **동일 빌드끼리도** migration preflight 가 항상 실패해 main CI 가 red 가 되고, (2) `resolveMigrationEntity()` 가 그 이름을 거부해 해당 테이블이 인스턴스 이관에서 **조용히** 빠진다.
- 배치 위치는 FK 위상 순서(부모 먼저)를 따른다. 실제 DB FK 는 11개뿐이고 그 목록은 레지스트리 파일 상단 주석에 있다 — `@ManyToOne`/`@JoinColumn` 없이 평문 varchar 로만 참조하는 엔티티라면 순서는 사실상 자유다.
- ⚠️ `MIGRATION_CONTROL_ENTITY_REASONS` 는 **도피처가 아니다.** 누락 엔티티를 여기 넣으면 preflight 는 green 이 되지만(`comparePreflight()` 가 CONTROL 이름을 소스 쪽에서 먼저 걸러낸다) 그 테이블은 이관에서 **영구히** 빠진다. 이관 기능 자신의 제어 상태이고 도착지에서 재생성되는 테이블에만 쓰고, 사유를 함께 적어라.
- 이 한 쌍은 `apps/server/test/migration-registry-completeness.test.mjs` 가 배럴 ↔ 레지스트리 양방향 차집합으로 강제한다(CONTROL 집합은 핀으로 고정). 누락 시 엔티티 이름·소스 파일·조치법을 그 실패 메시지가 찍어 준다. 온톨로지 그래프 테이블(`ontology_` 접두)만 의도적 제외 대상이다.

## Architecture

## Pattern Overview
- Full-stack TypeScript with shared types
- Module-driven backend (NestJS with feature modules)
- Context-based state management on frontend
- REST API with session-based authentication
- Real-time activity logging and notifications
- Multi-workspace organization with hierarchical tickets (root → child → grandchild)
## Layers
- Purpose: Expose endpoints for board operations, authentication, and user management
- Location: `apps/server/src/modules/*/` (16 feature modules)
- Contains: Controllers (one per module) and request/response handling
- Depends on: Services (shared and module-specific), Guards, Filters
- Used by: Frontend via `apps/client/src/api.ts`
- Purpose: Business logic, entity management, cross-cutting concerns
- Location: `apps/server/src/services/` (8 services) and module-level services
- Contains: Activity logging, authentication, API key management, Discord integration, notifications
- Depends on: Repositories (via TypeORM), External APIs (Discord)
- Used by: Controllers, other services, guards
- Purpose: Database abstraction and entity relationships
- Location: `apps/server/src/entities/` (10 entities)
- Contains: TypeORM entities with decorators (@Entity, @Column, @ManyToOne, etc.)
- Depends on: TypeORM, Database connection
- Used by: Services, Controllers via repository injection
- Purpose: Cross-cutting authentication and authorization
- Location: `apps/server/src/common/guards/` (4 guards), `common/filters/`, `common/decorators/`
- Contains: AuthGuard, PermissionGuard, AdminGuard, AgentAuthGuard, exception filters, decorators
- Depends on: User repositories, session management
- Used by: Controllers via @UseGuards decorator
- Purpose: UI components and user interactions
- Location: `apps/client/src/components/` (admin and board components)
- Contains: React functional components, drag-and-drop, forms
- Depends on: Context providers, hooks, API client
- Used by: Routes, other components
- Purpose: Global state and side effects
- Location: `apps/client/src/contexts/` (3 contexts: AuthContext, ToastContext, LoadingContext)
- Contains: Provider components, useContext hooks
- Depends on: API, localStorage
- Used by: App.tsx and nested components
## Data Flow
- Backend: No global state per-se; session stored in-memory, entity state in database
- Frontend: AuthContext (user/token), LoadingContext (loading states), ToastContext (notifications), local component state
- Persistence: All data to database, auth token to localStorage, no Redux/Zustand
## Key Abstractions
- Purpose: Represent domain objects (User, Board, Ticket, etc.)
- Examples: `apps/server/src/entities/Ticket.ts`, `apps/server/src/entities/User.ts`
- Pattern: TypeORM @Entity classes with relationships (@OneToMany, @ManyToOne)
- Purpose: Feature organization and dependency injection
- Examples: `BoardsModule`, `TicketsModule`, `AuthModule` in `apps/server/src/modules/`
- Pattern: NestJS @Module with imports, controllers, providers, exports
- Purpose: Enforce authentication and authorization
- Examples: `AuthGuard` (checks token), `PermissionGuard` (checks permissions), `AdminGuard` (admin-only)
- Pattern: Implements NestJS CanActivate, returns boolean
- Purpose: Reusable business logic
- Examples: `AuthService` (sessions), `ActivityService` (logging), `DiscordService` (Discord API)
- Pattern: Injectable NestJS providers, injected into controllers/services
## Entry Points
- Location: `apps/server/src/main.ts`
- Triggers: `npm run dev` or `npm start`
- Responsibilities: Create NestFactory app, enable CORS, apply global filters, listen on port 7701
- Location: `apps/server/src/mcp-server.ts`
- Triggers: `npm run mcp` (stdio transport) or `npm run mcp:http` (HTTP transport)
- Responsibilities: Expose NestJS services as MCP tools for Claude/agents
- Location: `apps/client/src/main.tsx`
- Triggers: `npm run dev` or build via `npm run build`
- Responsibilities: Render React app into DOM, wrap with BrowserRouter
- Location: `apps/client/src/App.tsx`
- Routes: "/" (Board), "/admin/*" (AdminPage), auth guards before routes
- Responsibilities: Check auth state, render login or main interface
## Error Handling
- Backend: AllExceptionsFilter (in `apps/server/src/common/filters/http-exception.filter.ts`) catches all exceptions, logs via LogService, returns HTTP 500
- Frontend: Try-catch in API layer (apps/client/src/api.ts), 401 triggers auth-expired event, errors thrown as Error objects
- Controllers: Explicit res.status(4xx/5xx).json({ error: '...' }) for known cases
## Cross-Cutting Concerns

## Agent Manager (standalone subagent runner)
- Location: `apps/agent-manager/`
- Standalone Node binary (`awb-agent-manager`) — runs without Claude CLI, drives Claude / Codex / Gemini / custom CLIs
- Owns the SSE pipeline (`EventStream` → `EventDispatcher`), subagent supervision (`SubagentManager`), persistent ticket/chat sessions, fs-browser reverse-RPC, instance heartbeat, agent lockfile
- Bootstraps via one-time pairing token minted from AWB admin UI; persists `config.json` at `$AWB_AGENT_MANAGER_HOME` (default `~/.config/awb-agent-manager/`)
- AWB → manager control surface: SSE event `agent_manager_command` — payload 필드는 `command_id`/`instance_id`/`agent_id`/`command`/`args`/`issued_by`/`issued_at`(`AgentManagerCommandPayload`, `apps/agent-manager/src/lib/agent-manager-commands.ts` 및 `apps/server/src/common/types/stream-events.ts`에 동일 이름으로 정의). verb 목록은 여기 하드코딩하지 말고 그 파일의 `CommandKind`/`KNOWN_COMMANDS`를 근거로 볼 것 — "5 verbs"로 개수를 적어뒀다가 stale해진 전례가 있어 개수 표현 자체를 없앰(리뷰 지적: 소스 티켓에서 verb 추가가 예정돼 있어 개수를 다시 적으면 병합 순서에 따라 즉시 또 stale해짐). ack via `POST /api/agent-manager/command/ack`
- `action`→role / `field_changed`→trigger_id / `actor_name`→agent_id 매핑은 `agent_manager_command`가 아니라 **`agent_trigger`(티켓 dispatch) SSE 계열** 전용 필드 별칭이다 — `apps/agent-manager/src/lib/event-dispatcher.ts`의 트리거 처리부(`dispatchTrigger`/`#ackDispatch`) 참조.
- **모델 목록은 한 경로로만 읽고 갱신한다**: 매니저 하트비트 `available_models` + `available_models_at`(재열거 시각; server·agent-manager 공동 contract) → 서버 `HostModelsService`(`GET/POST /api/agent-manager/hosts/:managerAgentId/models[/refresh]`) → 클라이언트 `src/cli/hostModels.ts` 의 `useHostModels()`. 모델을 보여주는 화면(Agent 다이얼로그·팀 슬롯·세션 설정·새 세션·Runtime Hosts)은 전부 이 훅을 쓰고, 열릴 때 오래된/빈 목록을 스스로 재열거한다. `available_models` 를 직접 읽거나 `refresh_available_models` 를 화면에서 직접 보내지 말 것. 상세: `docs/cli-modules.md` → "모델 목록".
- **CLI 별 지식은 `src/lib/clis/<id>/index.ts` 의 `CliModule` 한 곳에 있다** (바이너리 경로 · credential provider · device-auth 로그인 · Agent Session 스캐너 · effort 슬라이스 · 디스패치 게이트). 소비자(`cli-login.ts`, `agent-session-*.ts`, `cli-resolver.ts`, `agent-manager-commands.ts`, `event-dispatcher.ts`)는 `clis/index.ts` 로 조회만 한다 — `if (cli === 'claude')` 를 새로 쓰지 말 것. 서버 `cli-catalog.ts` 와의 일치는 `test/cli-catalog-contract.test.mjs` 가 강제한다. 상세: `docs/cli-modules.md`.
- Reference: `docs/agent-manager.md` (internals), `apps/agent-manager/README.md` (quickstart)

## Orchestration mode (팀 기반 자율 업무 오케스트레이션)

- 칸반 보드와 같은 레벨의 두 번째 작업 표면. Team(오케스트레이터 1 + 멤버 N) 에게 Mission 을 통째로 맡기면, 오케스트레이터 Agent 가 런타임에 Step DAG 계획을 세우고 팀원에게 배분한다.
- **로스터는 Agent 를 고르는 게 아니라 slot 을 선언한다**: `Runtime Host + CLI + model + working folder + folder_scope` (`apps/server/src/common/orchestration-member-spec.ts` 의 `TeamAgentSpec`, `OrchestrationTeamMember.spec` / `OrchestrationTeam.orchestrator_spec` 에 저장). backing Agent 행은 `orchestration-agent-provisioner.service.ts` 가 만들고(`Agent.origin='orchestration'`), 그래서 dispatch/SSE/MCP contract 는 **하나도 바뀌지 않았다** — 전부 그대로 `agent_id` 를 본다. 이 origin 행은 `GET /api/agents` 기본 목록에서 숨는다(`?include_orchestration=1` 로 옵트인, `/agents/dashboard` 는 필터 없음). 운영자가 만든 Agent 는 절대 수정/삭제하지 않는다 — slot spec 을 고치면 새 팀 소유 정체성을 발급한다.
- `folder_scope`: `shared`(기본, step 이 `working_dir` 자체에서 돌고 **RunProvision 을 보내지 않는다** — provision 의 `fresh` 가 운영자 작업폴더를 `rm -rf` 하므로) / `isolated`(기존 `.awb/orch/<mission>/<step>` 격리 + repo 체크아웃). 같은 Host·같은 폴더를 가리키는 slot 끼리 한 working tree 를 공유하는 것이 이 모델의 요점이고, 플래닝 로스터와 step work order 가 공유 사실·동시 편집 위험을 모두 명시한다.
- Location: `apps/server/src/modules/orchestration/` · MCP 툴 `modules/mcp/tools/orchestration-tools.ts` · UI `apps/client/src/components/orchestration/`
- **디스패치는 QA/Action 런과 같은 ChatRoom 파이프라인을 재사용한다** — `chat_rooms.orchestration_mission_id/_step_id` 로 표시하고 기존 `is_action_room` SSE 마커를 켠다. 따라서 **agent-manager 변경 없음, SSE contract 변경 없음**. `run_provision` 은 v1 범위 밖 (붙이려면 `RunProvision.kind` 에 `'orchestration'` 추가 → agent-manager `run-provisioner.ts` 파서와 같은 PR).
- `orchestration_update` SSE 는 `consensus_update` 와 같은 **UI 전용** 이벤트 (user-only filter) — agent 비소비이므로 agent-manager contract 무관.
- 미션은 **암묵적으로 끝나지 않는다**: `complete_orchestration_mission` (또는 운영자 cancel) 만이 종료 경로. 엔진은 스스로 진행 못 할 때만 오케스트레이터를 깨운다(실패/차단, 디스패치 불가, 전 step 종료).
- **실행 그래프(Graph mode, ticket 1ca9e49b)**: 미션 단위 feature flag `graph_enabled`(기본 off)로 켜면 `depends_on` DAG 위에 버전된 `GraphSpec`(typed edge, 조건 분기, join policy, bounded loop)이 얹힌다. 순수 로직은 `orchestration-graph.ts`, graph/wave 판정 분기는 `computeMissionProgress()` **한 곳에만** 둔다. 순환은 `loop_back` edge로만 만들 수 있고, 종료 조건·node별 `max_visits`·미션 `max_total_visits`가 없으면 `validateGraphSpec()`이 실행 전에 거부한다. 꺼진 미션의 동작은 이 기능 도입 전과 동일하며, wave adapter(`graphFromWavePlan`)의 무손실성은 회귀 테스트가 상태 조합 전수로 단언한다.
- **실행 중 그래프 수정 + 템플릿(ticket 2fc8f99a)**: `patch_orchestration_graph`가 그래프**만** 부분 수정한다(node 추가/삭제는 없음 — node는 step과 1:1이라 `submit_orchestration_plan`의 일). plan을 안 건드리므로 `plan_version` 대신 `graph_revision`이 오른다. 원칙은 **이미 일어난 실행 이력을 소급 무효화하지 않는다**: `max_visits`/`max_total_visits`를 이미 소진한 값 아래로 낮추는 것은 거부(정확히 소진량으로 낮추면 "이번이 마지막"), `loop_back` 제거는 진행 중이어도 항상 허용(폭주 loop 탈출구). 구조 검증은 patch 전용 경로를 만들지 말고 결과 전체를 `validateGraphSpec()`에 다시 통과시킨다. `GraphSpec.version`은 스키마 버전이라 수정 카운터로 재사용 금지. 템플릿(`orchestration-graph-templates.ts`, `linear`/`review_loop`/`fan_out_aggregate`)은 저작 편의일 뿐 실행 규칙 면제가 아니다.
- **replan 은 그래프도 additive(ticket 301018c5)**: `submit_orchestration_plan`이 `graph`/`graph_template` 없이 다시 들어오면 확정된 `graph_spec`을 **보존**하고 새 step만 고립 node로 편입한다(`carryGraphThroughReplan()`). 예전엔 `graphFromWavePlan`으로 통째 재생성해 conditional/loop_back과 그동안의 patch가 오류·경고 없이 사라졌다. 보존 경로도 patch와 마찬가지로 전용 검증을 만들지 말고 결과 전체를 `validateGraphSpec()`에 다시 통과시킬 것 — 누락 step을 고립 node로 채우는 건 검증기가 이미 하는 일이다. 이 보존이 성립하는 근거는 **plan에서 step이 사라지지 않는다**는 불변식(재제출은 누락 키 보존, `cancel`은 status만 변경, `listSteps`는 상태 미필터)이므로, step을 실제 삭제하는 경로를 만들면 여기도 함께 고쳐야 한다. 폐기는 `reset_graph: true`로만 명시하고, 그때만 `graph_revision`이 0으로 리셋된다.
- Reference: `docs/orchestration.md`

## Agent Sessions (CLI 직접 세션)

- Chat 과 **별개 표면**: Runtime Host 장비에 있는 CLI(Claude Code / Codex / Hermes)의 세션을 AWB 화면에서 직접 몬다. 단위는 **(Runtime Host, CLI, 네이티브 세션 id)** 이고 **AWB 는 세션 내용을 저장하지 않는다** — 목록·기록은 매니저가 CLI 홈(`~/.claude/projects`, `~/.codex/sessions`)에서 읽어 reverse RPC 로 답하고, 라이브 턴의 스트림만 driver 사용자에게 SSE 로 중계한다. 그 장비에서 터미널로 쓰던 세션도 그대로 뜬다. chat 모드 기본 랜딩이 `/ws/:wsId/sessions` 다. ChatRoom 은 그대로(다자간 대화 + run dispatch 버스) — 세션 기능을 방(room)에 분기로 얹지 말 것.
- 이름 규약: 엔티티 없음(메모리 라이브 상태만), 모듈 `modules/agent-sessions`, REST `/api/agent-sessions/hosts/:managerId/:cli/sessions[/:id/...]`(사용자) · `/api/agent/sessions/rpc/:requestId`, `/api/agent/sessions/:managerId/:cli/:id[/events]`(매니저), SSE `agent_session_request`(→manager, scope 는 매니저 identity) · `agent_session_update`/`agent_session_event`(→driver UI), 권한 `agent_sessions.use`(기본 admin 전용), 클라이언트 `components/sessions/*`, 매니저 `agent-session-runner.ts` + `agent-session-store.ts`, 하트비트 `acp_session_clis`. 상수 단일 원천은 `apps/server/src/common/types/agent-sessions.ts`.
- **CLI 설정**: Runtime Host × CLI 마다 워크스페이스 Credential 을 묶는다(`agent_session_cli_settings`, `PUT /api/agent-sessions/hosts/:managerId/:cli/settings`). 매니저는 바인딩된 credential 만 `GET /api/agent/sessions/credential/:id` 로 받아 **세션 전용 cli-home**(`session-homes/<cli>/<credential_id>`, 기록 디렉터리만 운영자 홈으로 링크)에 기존 어댑터 `prepareCliHome` 으로 적용한다 — 운영자 홈의 로그인 파일은 절대 건드리지 않는다. 비워 두면 장비의 `claude login` 상태를 그대로 쓴다.
- `agent_session_request` payload(`credential_id` 포함) · `/api/agent/sessions/*` 바디·credential 응답 · 하트비트 `acp_session_clis` 는 server·agent-manager 공동 contract — 변경은 같은 PR. 상세: `docs/agent-sessions.md`.

## Skills (AWB 기능)

- Global(`workspace_id NULL`) / Workspace 2계층. 같은 slug면 Workspace가 Global을 shadow — 커스터마이즈는 global 직접 수정이 아니라 **fork**.
- Global 쓰기는 admin 전용(`/api/admin/skill-registry`). Workspace 사용자는 global을 읽고 배정만 할 수 있다.
- Global을 채우는 소스 두 개: 저장소 안의 **내장 팩** `skills/` (부팅 시 멱등 시드, 네트워크 불필요 — "최신"은 서버 업그레이드로 따라온다)과 **tap**(외부 git repo, **기본 비활성**, 부팅 시 절대 동기화 안 함).
- 동기화는 **append-only**: 변경은 새 불변 버전을 추가할 뿐이고, assignment는 특정 버전을 핀하므로 이미 배정된 에이전트가 읽는 내용은 절대 바뀌지 않는다. `quarantined` 는 운영자 거부권이라 동기화가 되살리지 않는다.
- 새 SKILL.md 레이아웃/스코프/동기화 규칙은 `docs/skills.md`, 스코프 모델 전반은 `docs/catalog-scopes.md`.

## Development runbooks

Longer procedures live in `docs/runbooks/` as plain Markdown, readable by every
agent rather than only the one whose vendor directory they used to sit in. Each
opens with a **When:** line saying what pulls you into it.

- **[field-wiring](docs/runbooks/field-wiring.md)** — 5-touch-point checklist for Ticket JSON-array columns. Missing one makes the client receive a raw string or silently fail to save.
- **[mcp-tool-wiring](docs/runbooks/mcp-tool-wiring.md)** — registering a new MCP tool. The `TOOL_AUTHZ_TABLE` tier decision and the agent-manager ticket-ref-capture classification are the two easy misses: skip the first and the tool always denies, skip the second and its card silently vanishes from chat.
- **[agent-manager-release](docs/runbooks/agent-manager-release.md)** — build-verify for `apps/agent-manager` and the same-PR SSE contract rule. Versions are computed at publish time; never bump by hand.
- **[cli-module-wiring](docs/runbooks/cli-module-wiring.md)** — adding a new LLM CLI. One declaration per app (`apps/agent-manager/src/lib/clis/<id>/`, `apps/server/src/common/cli-catalog.ts`, `apps/client/src/cli/catalog.ts`); consumers never compare CLI names. Three contract tests pin the declarations to each other — a CLI name typed anywhere else is a design bypass. Background: `docs/cli-modules.md`.
- **[agent-display-name](docs/runbooks/agent-display-name.md)** — the `<Manager>/<Agent>` display contract across all 6 surfaces that show an agent. Rendering a bare `agent.name`, or a raw agent id, is a bug: the same leaf name legitimately exists under several managers. **Read this before adding any agent picker or agent-name label.**

`.claude/settings.json` stays Claude-specific on purpose — it is a permission
allowlist for that CLI, not instructions, and has no cross-vendor equivalent.
Extend it there rather than granting permissions ad hoc in a session.
