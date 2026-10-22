## Project

**AI Workflow Board (AWB)**

AI Workflow Board는 Runtime Host의 네이티브 CLI **session**을 기본 작업 표면으로 삼고, 티켓과 프로젝트 및 팀 미션으로 업무를 추적·자동화하는 플랫폼이다. 티켓 하나는 **한 Agent(assignee)** 가 처음부터 끝까지 맡아(혼자 하든, 자기 subagent 들에게 나눠 하든) 처리하고, 결과를 comment 로 남긴 뒤 상태를 `done`(또는 사람 확인용 `review`)으로 옮긴다. 보드는 없다 — 티켓은 접근 가능한 계정의 업무를 합쳐 보여주고 **tag** 와 **project** 로 분류·필터링한다.

**Account가 기본 소유·실행 경계다.** 명시적으로 Global로 생성한 카탈로그 항목 외에는 Account에 귀속한다. Runtime Host·manager key·runtime key·세션·티켓·프로젝트·팀·미션 모두 같은 경계를 지킨다. 관리자 권한이나 Global 카탈로그 쓰기 권한을 다른 계정 호스트의 실행 권한으로 해석하지 않는다. 예전 workspace 목록과 Account/Scope 선택기는 다시 만들지 않는다. 계약: `docs/ownership.md`, `docs/catalog-scopes.md`.

**User는 로그인 신원, Account는 소유 경계다.** 사용자마다 개인 Account를 생성하며 `accounts.owner_user_id`로 접근을 판정한다. 관리자는 다른 사용자의 업무를 자동으로 열람하지 않는다. 조직 membership은 아직 도입하지 않는다. 이관 95는 `AWB_LEGACY_OWNER_USER_ID`로 명시한 사용자에게 기존 업무·호스트를 귀속한다. 기존 소유 UUID·업무 객체 ID·내용·credential 암호문·네이티브 세션 파일을 보존하며, 이관 94를 다시 실행하지 않는다.

**Core Value:** Agent가 MCP로 연결되어 티켓을 자율 처리하고, 큐에 쌓인 다음 티켓이 그 Agent 에게 자동으로 이어지는 연속 자동화 루프.

### Constraints

- **Tech Stack**: 기존 NestJS + React + TypeORM 유지 — 전면 재작성 불가
- **MCP 호환**: @modelcontextprotocol/sdk 기반 Streamable HTTP 유지
- **DB 호환**: SQLite(개발) + PostgreSQL(운영) 이중 지원 유지
- **Agent 독립성**: AWB는 Agent의 내부 구현에 의존하지 않음 — MCP 인터페이스만 사용
- **Agent Manager sync**: SSE 이벤트, subagent 위임, persistent ticket/chat session, CLI lifecycle 변경은 `apps/agent-manager/` 에서 처리. 절차 → (1) `apps/agent-manager/src/` 수정, (2) `npm run build` 통과 확인 (monorepo root turbo 빌드 포함), (3) commit + push — **버전은 손으로 범프하지 말 것**: `main` 랜딩 시 `.github/workflows/publish-agent-manager.yml` 이 `apps/agent-manager/scripts/compute-publish-version.mjs` 로 버전을 자동 계산해 publish 한다 (상세 절차는 `docs/runbooks/agent-manager-release.md` 참조). SSE 이벤트 타입을 추가/변경한 경우 서버측 (`apps/server/src/modules/agent-manager/`) 변경과 같은 PR 으로 묶을 것 — agent-manager 와 AWB 서버가 같은 contract 를 본다. `agent_trigger` payload 의 `harness_config` (Account CLI 하네스, `apps/server/src/common/harness-config.ts` 스키마) 와 `status` / `project` / `base_repo.main_clone_dir` (docs/tickets.md) 도 이 SSE contract 에 포함 — 키 추가/변경 시 server·agent-manager 양쪽을 같은 PR 로 (필드별 CLI 매핑은 `docs/agent-manager.md` → "Harness config" 참조).
- **전송 계약**: 현재 실행 필드는 `account_id`, `X-Account-Id`, `*_automation_schedule`이다. workspace 소유권 이름을 런타임 alias로 다시 읽거나 내보내지 않는다. 구 DB 변환은 이관 코드에만 둔다. `workspace_folder`, `RunWorkspace`, CLI workspace trust, Codex `workspace-write`는 실제 파일 작업공간 의미라 유지한다.

## Technology Stack

## Languages
- TypeScript 5.6.0 - Used throughout client and server
- HTML/CSS - Client UI rendering
- JavaScript (Node.js) - Runtime and build tooling
## Runtime
- Node.js 22.12+ for the full source build; packageManager pins npm@11.6.1
- npm 11.6.1
- Lockfile: package-lock.json present
## Frameworks
- NestJS 11.0.0 - Backend REST API framework
- React 18.3.0 - Frontend UI library
- React Router 7.14.0 - Client-side routing
- Node.js built-in test runner; suites in each workspace (no root npm test script)
- Vite 8 - Frontend bundler and dev server (exact versions: apps/client/package.json + package-lock.json)
- Turbo 2.4.0 - Monorepo build orchestration
- TypeScript 5.6.0 - Language compiler
- tsx 4.19.0 - TypeScript executor (server dev)
- @nestjs/serve-static 5.0.0 - Serves client dist from server
## Key Dependencies
- @modelcontextprotocol/sdk 1.32 (floor ^1.31.0 — GHSA-6qxp-vccf-f47h) - MCP server implementation (core feature)
- TypeORM 0.3 - ORM for database abstraction
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
- Development: server `nest start --watch`; client Vite; manager `tsx watch src/main.ts`
- Production: `node dist/main.js`
- Compiled output: `apps/server/dist/`
- Development: Vite dev server on port 7700 (proxies /api and /mcp to 7701)
- Build output: `apps/client/dist/`
- React entry: `src/main.tsx`
## Platform Requirements
- Node.js 22.12+ with npm 11.6.1
- Port 7700 available (Vite dev server)
- Port 7701 available (NestJS server)
- Port 5432 available (PostgreSQL, if using Postgres in dev)
- Docker and docker-compose (see docker-compose.yml)
- PostgreSQL 16-alpine (as service)
- Node.js runtime
- Port 7701 for server
- GitHub Container Registry access (image: ghcr.io/parnmanas/ai-workflow-board:latest)
## Database Configuration
- Development default: SQLite (sql.js); deployment: PostgreSQL
- Location: `database/data.db` (auto-created)
- Batched sql.js persistence: SqljsFlushService / standalone flush timer + graceful shutdown
- Synchronize enabled (auto-migrate schema)
- PostgreSQL port: 5432 (SQLite uses a local file, no listener)
- Connection via TypeORM DataSource
- Schema synchronize is enabled in all current DB configurations, including production; back up before upgrades
- Also supported via TypeORM (configurable via DB_TYPE env var)
- **Corrupt dev DB**: a malformed `data.db` ("database disk image is malformed") used to hang boot ~25s (killing agent subagents at exit 143). `ensureSqljsDbHealthy()` in `db.ts` now runs a sql.js integrity check *before* TypeORM initializes (wired into both `initDb()` and `main.ts` bootstrap) — sql.js/dev only, Postgres untouched. A corrupt file aborts in ~1s with a clear message; `rm database/data.db` to recreate, or set `AWB_DB_AUTORECOVER=1` to auto-backup to `data.db.corrupt-<ts>` + recreate empty. The same guard also covers the independent Ontology Graph sql.js file (`database/ontology.db`, ticket 6ca4894a) via the sibling `ensureOntologySqljsDbHealthy()` (ticket b646ed54), wired at the same two call sites. See README → Development → Troubleshooting.
- **트랜잭션 직렬화 큐 — sql.js**: sql.js 백엔드(`db.ts`의 `AppDataSource`)는 단일 WASM 인스턴스/단일 커넥션이라 진짜 풀링이 없다 — 겹치는(overlapping) `dataSource.transaction()` 호출이 같은 커넥션을 공유해 "cannot start a transaction within a transaction" 또는 "Transaction is not started yet, start transaction before committing or rolling it back." 에러로 실패하거나, 한쪽의 실패 처리가 다른 쪽의 진행 중이던 트랜잭션까지 롤백시켜 쓰기가 조용히 유실될 수 있었다. `db.ts`의 `serializeSqljsTransactions()`가 sqljs 백엔드에서만 `dataSource.manager.transaction()` 호출을 FIFO 큐로 직렬화해 해소 — `AppDataSource`(standalone 진입점)와 `DatabaseModule`(NestJS 진입점) 생성 시 양쪽에 적용된다. 같은 호출 체인 내 중첩(nested) `transaction()` 호출은 AsyncLocalStorage로 감지해 큐를 우회하고 즉시 실행한다(SAVEPOINT로 이미 안전 — 큐잉하면 데드락). Postgres/MySQL은 그대로 네이티브 풀 기반 동시 트랜잭션을 유지하며 영향 없음. 이 큐는 겹치는 호출이 에러·유실 없이 끝나도록 순차 실행만 보장할 뿐 진짜 병렬 격리를 재현하지는 않으므로, sql.js 기준 동시성 테스트의 통과를 Postgres의 실제 동시 트랜잭션 동작과 동일시하지 말 것 — 진짜 병렬 트랜잭션 검증은 Postgres 전용으로 분리할 것. outreach 모듈 등 기존 claim-first + 보상삭제(compensate) 우회 코드는 이 큐 도입과 별개로 유지 중이며, 트랜잭션 기반으로 되돌릴지는 별도 판단 사항.
- **sql.js 파일 쓰기는 열린 트랜잭션을 끊는다**: `Database.export()` 가 연결을 닫았다 다시 열어서, 그 순간 열린 트랜잭션은 롤백되고 남은 쓰기는 autocommit 되며 COMMIT 은 실패한다. 살아 있는 DataSource 를 파일로 쓸 때는 `flushSqljs()`/`flushOntologySqljs()` 만 쓰고 `sqljsManager.saveDatabase()` 를 직접 부르지 말 것 — 이 둘은 트랜잭션 큐 뒤에서, 큐를 거치지 않는 `repo.save()` 의 암묵 트랜잭션까지 닫혔는지 SQLite 에 직접 확인한 뒤 export 한다(`exportSqljsWhenIdle`). 큐 뒤에 서는 것(`afterSqljsTransactions`)만으로는 부족하다. 트랜잭션 안에서 부른 flush 는 자기 트랜잭션이 열려 있어 쓰지 못하고 제한 시간(1초) 뒤 실패하니, 내려 써야 하는 쓰기는 커밋한 뒤에 flush 할 것. 회귀: `apps/server/test/sqljs-flush-transaction-overlap.test.mjs`.
## Environment Variables
- `DB_TYPE` - 'sqlite' | 'postgres' | 'mysql' (default: sqlite)
- `DB_HOST` - Database hostname (default: localhost)
- `DB_PORT` - Database port (sqlite ignored, postgres 5432, mysql 3306)
- `DB_USER` - Database username (default: postgres/root)
- `DB_PASS` - Database password (required for production)
- `DB_NAME` - Database name (default: ai_workflow)
- `NODE_ENV` - 'development' | 'production'
- `PORT` - Server port (default: 7701)
- `CORS_ORIGIN` - Explicit origin; unset reflects origins in dev and rejects cross-origin requests in production
- `MCP_API_KEYS` - Comma-separated API keys, optionally with agent names (format: "agentName:key,key2")
- `MCP_ACCOUNT_ID` - Explicit owning Account for environment MCP keys; required when using `MCP_API_KEYS`
- `MCP_DEV_MODE` - Explicit dev bypass only outside production and with no active DB/env MCP keys
- `AGENT_API_KEY` - Static API key for agent authentication (checked via X-Agent-Key header)
- `AGENT_ACCOUNT_ID` - Explicit owning Account for `AGENT_API_KEY`; missing ownership disables that key
- `AGENT_DEV_MODE` - Explicit dev bypass only outside production and without AGENT_API_KEY
## Port Configuration
- 7700 - Vite client dev server (with /api and /mcp proxies)
- 7701 - NestJS server API and MCP endpoint
- 7701 - Combined server (serves client + API + MCP)

## Conventions

## Naming Patterns
- Entity files: PascalCase (e.g., `Project.ts`, `User.ts`) - located in `apps/server/src/entities/`
- Controller files: kebab-case with `.controller.ts` suffix (e.g., `projects.controller.ts`) - located in `apps/server/src/modules/{feature}/`
- Service files: kebab-case with `.service.ts` suffix (e.g., `auth.service.ts`) - located in `apps/server/src/services/`
- Module files: kebab-case with `.module.ts` suffix (e.g., `projects.module.ts`)
- React components: PascalCase (e.g., `TicketsPage.tsx`, `TicketCard.tsx`) - located in `apps/client/src/components/`
- Hooks: camelCase with `use` prefix (e.g., `useAuth`) - located in `apps/client/src/hooks/`
- Context files: PascalCase with `Context.tsx` suffix (e.g., `AuthContext.tsx`) - located in `apps/client/src/contexts/`
- Guards: kebab-case with `.guard.ts` suffix (e.g., `auth.guard.ts`) - located in `apps/server/src/common/guards/`
- Decorators: kebab-case with `.decorator.ts` suffix (e.g., `current-user.decorator.ts`) - located in `apps/server/src/common/decorators/`
- Async functions: camelCase (e.g., `async login(email, password)`, `async refresh()`)
- NestJS handlers: camelCase with method name (e.g., `@Get() list(...)`, `@Post() create(...)`)
- React hooks: camelCase starting with `use` (e.g., `useHostModels`, `useAuth`)
- Private methods: camelCase prefixed with underscore (e.g., `private _resolveAgentId(...)`)
- Helper functions: camelCase (e.g., `parseTicket()`, `parseComments()`)
- Constants: UPPER_SNAKE_CASE (e.g., `MAX_IMAGE_SIZE`, `SESSION_TTL_MS`, `SALT_ROUNDS`)
- Local variables: camelCase (e.g., `projectId`, `currentUser`, `showToast`)
- Database/API fields: snake_case (e.g., `account_id`, `created_at`, `channel_ids`)
- TypeScript/React state: camelCase (e.g., `isAuthenticated`, `accountId`, `selectedChannelIds`)
- Interfaces: PascalCase, often plural for collections (e.g., `User`, `Project`, `TicketDetailProps`)
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
- Relative imports use `../` navigation (e.g., `../../entities/Project`)
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
- Services return typed data (User, Project, Ticket, etc.) or null on failure
- Async functions return Promises with generic types (e.g., `Promise<Project>`)
- Example pattern: `async function loadTicketFull(ticketRepo: Repository<Ticket>, id: string): Promise<Ticket | null>`
## Module Design
- Barrel exports in `index.ts` files (e.g., `apps/server/src/entities/index.ts`)
- NestJS modules use `@Module({ imports: [...], controllers: [...], providers: [...] })`
- Services provided to modules via `providers` array for dependency injection
- Example from `projects.module.ts`:
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
- **인덱스는 엔티티에 선언한다.** synchronize(항상 켜짐)는 메타데이터에 없는 인덱스를 부팅마다 지운다 — 마이그레이션에서 raw `CREATE INDEX` 로만 만든 인덱스는 다음 부팅에 사라진다(운영에서 `uq_skills_global_slug` 가 그렇게 없어져 있었다). 부분 인덱스도 `@Index(name, cols, { unique, where })` 로 선언하라(SQLite 도 지원). 컬럼을 지울 때 그 컬럼을 `where` 에 쓰는 인덱스는 pre-sync 에서 먼저 drop 해야 같은 부팅에 다시 만들어진다.
- **배럴 export 와 이관 레지스트리 등록은 한 쌍이다.** `apps/server/src/entities/index.ts` 에 `export { Foo } from './Foo';` 를 넣었으면 **같은 커밋에서** `apps/server/src/modules/migration/migration-entity-registry.ts` 의 `MIGRATION_ENTITY_ORDER` 에도 클래스명을 추가하라. 빠뜨리면 (1) **동일 빌드끼리도** migration preflight 가 항상 실패해 main CI 가 red 가 되고, (2) `resolveMigrationEntity()` 가 그 이름을 거부해 해당 테이블이 인스턴스 이관에서 **조용히** 빠진다.
- 배치 위치는 FK 위상 순서(부모 먼저)를 따른다. 실제 DB FK 는 7개뿐이고 그 목록은 레지스트리 파일 상단 주석에 있다 — `@ManyToOne`/`@JoinColumn` 없이 평문 varchar 로만 참조하는 엔티티라면 순서는 사실상 자유다.
- ⚠️ `MIGRATION_CONTROL_ENTITY_REASONS` 는 **도피처가 아니다.** 누락 엔티티를 여기 넣으면 preflight 는 green 이 되지만(`comparePreflight()` 가 CONTROL 이름을 소스 쪽에서 먼저 걸러낸다) 그 테이블은 이관에서 **영구히** 빠진다. 이관 기능 자신의 제어 상태이고 도착지에서 재생성되는 테이블에만 쓰고, 사유를 함께 적어라.
- 이 한 쌍은 `apps/server/test/migration-registry-completeness.test.mjs` 가 배럴 ↔ 레지스트리 양방향 차집합으로 강제한다(CONTROL 집합은 핀으로 고정). 누락 시 엔티티 이름·소스 파일·조치법을 그 실패 메시지가 찍어 준다. 온톨로지 그래프 테이블(`ontology_` 접두)만 의도적 제외 대상이다.

## Architecture

## Pattern Overview
- Full-stack TypeScript with shared types
- Module-driven backend (NestJS with feature modules)
- Context-based state management on frontend
- REST API with session-based authentication
- Real-time activity logging and notifications
- Session-first work views with account ownership and hierarchical tickets (root → child → grandchild)
## Layers
- Purpose: Expose endpoints for tickets, projects, authentication, and user management
- Location: `apps/server/src/modules/*/` (see docs/architecture/modules.md for the current module map)
- Contains: Controllers (one per module) and request/response handling
- Depends on: Services (shared and module-specific), Guards, Filters
- Used by: Frontend via `apps/client/src/api.ts`
- Purpose: Business logic, entity management, cross-cutting concerns
- Location: `apps/server/src/services/` and feature-local services under `apps/server/src/modules/`
- Contains: Activity logging, authentication, API key management, Discord integration, notifications
- Depends on: Repositories (via TypeORM), External APIs (Discord)
- Used by: Controllers, other services, guards
- Purpose: Database abstraction and entity relationships
- Location: `apps/server/src/entities/` (see entities/index.ts and migration-entity-registry.ts)
- Contains: TypeORM entities with decorators (@Entity, @Column, @ManyToOne, etc.); entities/index.ts is paired with the migration registry
- Depends on: TypeORM, Database connection
- Used by: Services, Controllers via repository injection
- Purpose: Cross-cutting authentication and authorization
- Location: `apps/server/src/common/guards/` (4 guards), `common/filters/`, `common/decorators/`
- Contains: AuthGuard, PermissionGuard, AdminGuard, AgentAuthGuard, exception filters, decorators
- Depends on: User repositories, session management
- Used by: Controllers via @UseGuards decorator
- Purpose: UI components and user interactions
- Location: `apps/client/src/components/` (admin, tickets and projects components)
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
- Purpose: Represent domain objects (User, Project, Ticket, etc.)
- Examples: `apps/server/src/entities/Ticket.ts`, `apps/server/src/entities/User.ts`
- Pattern: TypeORM @Entity classes with relationships (@OneToMany, @ManyToOne)
- Purpose: Feature organization and dependency injection
- Examples: `ProjectsModule`, `TicketsModule`, `AuthModule` in `apps/server/src/modules/`
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
- Routes: "/sessions" (native CLI sessions), "/tickets", "/projects", "/missions", "/settings/ownership" (ownership administration), auth guards before routes
- Responsibilities: Check auth state, render login or main interface
## Error Handling
- Backend: AllExceptionsFilter (in `apps/server/src/common/filters/http-exception.filter.ts`) catches all exceptions, logs via LogService, returns HTTP 500
- Frontend: Try-catch in API layer (apps/client/src/api.ts), 401 triggers auth-expired event, errors thrown as Error objects
- Controllers: Explicit res.status(4xx/5xx).json({ error: '...' }) for known cases
## Cross-Cutting Concerns

## Agent Manager (standalone subagent runner)
- Location: `apps/agent-manager/`
- Standalone Node binary (`awb-agent-manager`) — the manager starts independently of any one CLI; supported features come from the server CLI catalog and manager CliModules (`docs/cli-modules.md`)
- Owns the SSE pipeline (`EventStream` → `EventDispatcher`), subagent supervision (`SubagentManager`), persistent ticket/chat sessions, fs-browser reverse-RPC, instance heartbeat, agent lockfile
- Bootstraps via a one-time pairing token from Hosts; persists `config.json` and `agent.json` under `$AWB_AGENT_MANAGER_HOME` (default `~/.config/awb-agent-manager/`). Pairing creates a RuntimeHost + host-bound key, not an Agent row; response/config `agent_id` is the compatibility Host identity. Heartbeat resolves the Host (`body.host_id` → key `host_id`) and stamps the live registry with its owner. `AgentAuthGuard.currentAgentId` is the runtime key parsed from a provisioned key name, or the Host id; `currentHostId` stays the Host id. Both manager and runtime keys must match their active Host's Account. SSE `server_meta` binds the manager's current account before work or reconnect callbacks; every work frame and durable retry must match that account. See `docs/agent-manager.md` and host-pairing/ownership regression tests.
- AWB → manager control surface: SSE event `agent_manager_command` — payload 필드는 `command_id`/`instance_id`/`agent_id`/`command`/`args`/`issued_by`/`issued_at`(`AgentManagerCommandPayload`, `apps/agent-manager/src/lib/agent-manager-commands.ts` 및 `apps/server/src/common/types/stream-events.ts`에 동일 이름으로 정의). verb 목록은 여기 하드코딩하지 말고 그 파일의 `CommandKind`/`KNOWN_COMMANDS`를 근거로 볼 것 — "5 verbs"로 개수를 적어뒀다가 stale해진 전례가 있어 개수 표현 자체를 없앰(리뷰 지적: 소스 티켓에서 verb 추가가 예정돼 있어 개수를 다시 적으면 병합 순서에 따라 즉시 또 stale해짐). ack via `POST /api/agent-manager/command/ack`
- `action`→role(항상 `assignee`) / `field_changed`→trigger_id / `actor_name`→agent_id 매핑은 `agent_manager_command`가 아니라 **`agent_trigger`(티켓 dispatch) SSE 계열** 전용 필드 별칭이다 — `apps/agent-manager/src/lib/event-dispatcher.ts`의 트리거 처리부(`dispatchTrigger`/`#ackDispatch`) 참조.
- **모델 목록은 한 경로로만 읽고 갱신한다**: 매니저 하트비트 `available_models` + `available_models_at`(재열거 시각; server·agent-manager 공동 contract) → 서버 `HostModelsService`(`GET/POST /api/agent-manager/hosts/:managerAgentId/models[/refresh]`) → 클라이언트 `src/cli/hostModels.ts` 의 `useHostModels()`. 모델을 보여주는 화면(Agent 템플릿/RuntimeSpec 선택기·팀 슬롯·세션 설정·새 세션·Runtime Hosts)은 전부 이 훅을 쓰고, 열릴 때 오래된/빈 목록을 스스로 재열거한다. `available_models` 를 직접 읽거나 `refresh_available_models` 를 화면에서 직접 보내지 말 것. 상세: `docs/cli-modules.md` → "모델 목록". **서버 쪽도 마찬가지다**: `HostModelsService.modelsFor()/modelsByCli()` 가 유일한 답이고, 하트비트 `available_models` 를 직접 읽어 자기만의 합집합을 만들지 말 것 — 오케스트레이션 로스터가 "하트비트 + 기존 agent 행에 핀된 모델, 알파벳 재정렬" 로 따로 계산해서 같은 호스트의 목록이 mission 과 session/chat 에서 **내용도 순서도** 달랐다(2026-09-27). ACP 어댑터가 보고한 모델은 반대로 그 출처로 흘려보낸다 — 살아 있는 세션은 `noteObservedModels()`, 이미 영속된 것(`agent_session_cli_settings.known_config_options`)은 `HostModelsService` 가 부팅·조회 시 직접 읽는다. **영속본을 빠뜨리면 "이 프로세스에서 세션을 한 번 열었는가"에 따라 목록이 갈린다**(실측: Ralf opencode = ACP 108개 vs 하트비트 짧은 목록). **ACP 보고가 있으면 그것만 쓰고 하트비트와 합치지 않는다**(라이브 → 가장 최근 영속본 → 하트비트 순으로 처음 비지 않은 하나) — 하트비트는 CLI 바이너리 스캔이라 `claude-sonnet-5-5` 같은 id 가 섞이고, 합집합이던 동안 새 세션·팀 슬롯에는 있고 세션 안에는 없었다(2026-10-02 ragnar). 이름(`labels`)도 같은 출처에서 내려간다. 회귀: `apps/server/test/host-models-single-source.test.mjs`(세 경로의 결과가 글자 그대로 같은지), `apps/client/test/mission-slot-model-list.test.mjs`(팀 슬롯 dropdown 이 스토어만 읽는지).
- **CLI 별 지식은 `src/lib/clis/<id>/index.ts` 의 `CliModule` 한 곳에 있다** (바이너리 경로 · credential provider · device-auth 로그인 · Agent Session 스캐너 · effort 슬라이스 · 디스패치 게이트). 소비자(`cli-login.ts`, `agent-session-*.ts`, `cli-resolver.ts`, `agent-manager-commands.ts`, `event-dispatcher.ts`)는 `clis/index.ts` 로 조회만 한다 — `if (cli === 'claude')` 를 새로 쓰지 말 것. 서버 `cli-catalog.ts` 와의 일치는 `test/cli-catalog-contract.test.mjs` 가 강제한다. 상세: `docs/cli-modules.md`.
- **버전은 두 개다**: 실행 중(`plugin_version`, 부팅 때 `setRunningVersion`)과 디스크 설치본(`installed_version`, `dist/package.json`). 프로세스 밖에서 `npm i -g awb-agent-manager` 를 돌리면 둘이 갈리고 하트비트가 `restart_required` 를 광고한다 — 그때 `update_manager` 는 설치 없이 재기동만 한다. 세션/셸에서 매니저 바이너리를 직접(`--force`) 띄우면 감독 중인 서비스를 죽이지 않고 SIGUSR2 로 재기동을 넘긴다(`docs/agent-manager.md` → Self-update policy).
- **업데이트·재기동은 돌고 있는 작업을 기다리지 않는다**: 재시작 경로가 떠나기 직전 끊길 작업을 `restart-resume.json` 에 저장하고(SIGTERM 핸들러가 아니다 — Windows 는 핸들러 없이 죽는다), 새 프로세스가 연결되면 `POST /api/agent-manager/restart-resume` 으로 넘긴다 → 서버가 그 호스트 티켓을 다시 보내고, 끊긴 Agent Session 은 operator 에게 보고한다. drain(작업이 끝날 때까지 갱신 연기)을 다시 들이지 말 것. 상세: `docs/agent-manager.md` → "재시작으로 끊긴 작업".
- Reference: `docs/agent-manager.md` (internals), `apps/agent-manager/README.md` (quickstart)

## Tickets & Projects (보드 없는 모델)

- **보드·컬럼·워크스페이스 역할·컬럼 role 라우팅·prompt template·board lesson·합의(consensus)·cross-board handoff·benchmark·feature chain·merge lease/gate 는 전부 제거됐다.** 다시 들이지 말 것 — 계약 문서는 `docs/tickets.md`.
- 티켓 상태는 고정 집합 `backlog → todo → in_progress → review → done` (`apps/server/src/common/ticket-status.ts` 가 단일 원천 — 상태 문자열을 다른 곳에 손으로 쓰지 말 것). 분류는 `tags`(자유 문자열 배열)와 `project_id`.
- 티켓마다 **assignee 한 명**(RuntimeSpec, `Ticket.assignee` + `assignee_key = runtimeIdentityKey(spec)`). 디스패치는 `TicketDispatchService`(`modules/agents/ticket-dispatch.service.ts`) **한 곳**이다: `todo` 큐 → 소유 Account의 용량(`account.max_concurrent_tickets_per_agent`)이 나면 `in_progress` 로 옮기며 `agent_trigger`, 사람 코멘트/unpend/선행 완료/CI 대기 해제/수동 Run 에 재전송, 죽은 agent 는 supervisor 가 최대 3회 재전송 후 pend. 다른 경로에서 `agent_trigger` 를 직접 emit 하지 말 것 — "막혔던 게 풀렸다" 는 `resumeTicket(id, source)` 하나로 부른다.
- 티켓 쓰기(생성·수정·이동·pend/unpend)는 `TicketService`(`modules/tickets/ticket.service.ts`) 를 거친다 — REST·MCP·QA/Security 실패 티켓·CI red·outreach·채팅 fallback 이 같은 부수효과(terminal stamp, activity, dispatch)를 공유해야 한다. 티켓 행을 직접 `save` 해 상태를 바꾸지 말 것.
- **Project = 저장소 1개 + 호스트별 main clone 폴더**(`Project`, `ProjectHostFolder`). repository Resource 를 **같은 id 로** 이관했으므로 저장된 repo id(`repo_ref.project_id`, 온톨로지 graph 의 `resource_id`)는 project id 다. 티켓 dispatch 는 assignee 호스트의 main clone 을 `base_repo.main_clone_dir` 로 실어 보내고, 매니저는 거기서 `<main_clone>/.awb/wt/<ticket8>` worktree 를 뜬다(main clone 자체는 절대 reset/clean 하지 않는다). 미션 step 지시문도 각 멤버 호스트의 project 폴더를 명시한다.
- `board_update` SSE 이름은 wire 호환 때문에 유지한다(티켓 변경 이벤트다). `current_column_*` 는 `statusColumnProjection(status)` 로 채워 구버전 매니저가 계속 dispatch 한다 — 새 필드는 `status`.
- 데이터 이관: `database/pre-sync-board-removal.ts`(synchronize 전 스냅샷) + 마이그레이션 `1760000000091-BoardlessTickets`(컬럼→상태, 보드 이름→tag, repo→project, 보드 설정→소유 Account, 구 테이블 drop). 운영 배포 전 DB 백업 필수 — down 은 없다.

## Orchestration mode (팀 기반 자율 업무 오케스트레이션)

- Tickets와 같은 레벨의 팀 미션 작업 표면. Team(오케스트레이터 1 + 멤버 N) 에게 Mission 을 통째로 맡기면, 오케스트레이터 Agent 가 런타임에 Step DAG 계획을 세우고 팀원에게 배분한다.
- **로스터는 Agent 를 고르는 게 아니라 slot 을 선언한다**: `Runtime Host + CLI + model (+ credential·backend·runtime_config)` — **폴더는 없다** (`apps/server/src/common/orchestration-member-spec.ts` 의 `TeamSlotSpec`, `OrchestrationTeamMember.spec` / `OrchestrationTeam.orchestrator_spec` 에 저장). 팀은 여러 미션에 재사용되므로 "어디서 일하는가" 는 **미션의 `projects`**(첫 항목이 primary)가 정한다: slot 은 각 project 의 **자기 Host** 폴더(`ProjectHostFolder`)에서 일하고, 폴더가 없는 Host 는 그 project 를 맡지 못한다. 미션 시작이 `slot × project` 를 실행 spec(slot + 그 폴더)으로 풀어 `OrchestrationMission.runtime_roster` 에 **고정**한다(`modules/orchestration/orchestration-roster.ts`) — 브리핑·계획 검증·동시성 상한·runtime 준비(credential)·디스패치·매니저 credential 조회가 전부 이 스냅샷을 읽는다. 실행 identity 는 `runtimeIdentityKey(실행 spec)`(cli + 폴더 + credential)라 slot 하나가 project 마다 다른 identity 를 갖고, 모델만 다른 두 slot 은 같은 폴더에서 한 identity 를 공유한다 — 그래서 **step 은 identity 가 아니라 slot(`assignee_slot`) + `project_id` 로 배정**하고 상한도 slot 단위다. 팀 slot 을 고쳐도 실행 중인 미션은 바뀌지 않는다(다음 미션·다시 열기가 반영). Agent 행은 만들지 않는다.
- **Agent 쓰기 제거 (P4c-3b)**: `create/update/delete/move_agent` MCP 툴, `POST/PATCH/DELETE /agents`, `POST /admin/agent-manager/agents`, Agent 생성/편집 UI 가 삭제됐다. 새 실행 선언은 전부 RuntimeSpec (`POST /api/runtime-specs/validate` 로 검증). `list/get_agents`와 Agent 행 읽기도 P4c-4 테이블 제거와 함께 없어졌다. 현재 선택은 RuntimeSpec/Host 카탈로그를 사용한다.
- **Hosts 카탈로그는 Host 원천 (P4c-4)**: `listRuntimeHosts`는 `runtime_hosts`와 live registry에서 읽는다(Agent 테이블 없음). 새 spec의 `manager_agent_id`는 Host id다. 오프라인 CLI 후보는 저장된 팀 slot spec에서 복원하며(slot 에 폴더가 없으므로 폴더 후보는 없다) 모델 목록은 `HostModelsService`만 사용한다. `legacy_agent_id` 응답 필드는 구 소비자 호환용으로 남고 현재 카탈로그는 null을 내린다. 회귀: `test/orchestration-runtime-hosts-union.test.mjs`.
- `folder_scope` 는 **미션** 설정이다: `shared`(기본, step 이 project 폴더 자체에서 돌고 **RunProvision 을 보내지 않는다** — provision 의 `fresh` 가 운영자 체크아웃을 `rm -rf` 하므로) / `isolated`(project 폴더 아래 `.awb/orch/<mission>/<step>` 격리 + 그 step 의 project 체크아웃). 같은 Host 에서 같은 project 를 맡은 slot 끼리 한 working tree 를 공유하고, 플래닝 로스터와 step work order 가 공유 사실·동시 편집 위험을 명시한다. `shared` 미션 둘이 같은 Host·같은 폴더에서 동시에 돌면 서로 덮어쓰므로 시작·다시 열기에서 409 로 막는다. project 가 없는 미션은 시작할 수 없다. 상세: `docs/orchestration.md` → "로스터 — slot 과 runtime identity", "미션 프로젝트".
- Location: `apps/server/src/modules/orchestration/` · MCP 툴 `modules/mcp/tools/orchestration-tools.ts` · UI `apps/client/src/components/orchestration/`
- **디스패치는 QA/Action 런과 같은 ChatRoom 파이프라인을 재사용한다** — `chat_rooms.orchestration_mission_id/_step_id` 로 표시하고 기존 `is_action_room` SSE 마커를 켠다. 따라서 **agent-manager 변경 없음, SSE contract 변경 없음**. `isolated` step은 `run_provision` (`kind: 'orchestration'`)을 보내며 server·manager 공동 contract다. `shared`에는 보내지 않는다.
- `orchestration_update` SSE는 **UI 전용** 이벤트 (user-only filter) — agent 비소비이므로 agent-manager contract 무관.
- 미션은 **암묵적으로 끝나지 않는다**: `complete_orchestration_mission` (또는 운영자 cancel) 만이 종료 경로. 엔진은 스스로 진행 못 할 때만 오케스트레이터를 깨운다(실패/차단, 디스패치 불가, 전 step 종료).
- **실행 그래프(Graph mode, ticket 1ca9e49b)**: 미션 단위 feature flag `graph_enabled`(기본 off)로 켜면 `depends_on` DAG 위에 버전된 `GraphSpec`(typed edge, 조건 분기, join policy, bounded loop)이 얹힌다. 순수 로직은 `orchestration-graph.ts`, graph/wave 판정 분기는 `computeMissionProgress()` **한 곳에만** 둔다. 순환은 `loop_back` edge로만 만들 수 있고, 종료 조건·node별 `max_visits`·미션 `max_total_visits`가 없으면 `validateGraphSpec()`이 실행 전에 거부한다. 꺼진 미션의 동작은 이 기능 도입 전과 동일하며, wave adapter(`graphFromWavePlan`)의 무손실성은 회귀 테스트가 상태 조합 전수로 단언한다.
- **실행 중 그래프 수정 + 템플릿(ticket 2fc8f99a)**: `patch_orchestration_graph`가 그래프**만** 부분 수정한다(node 추가/삭제는 없음 — node는 step과 1:1이라 `submit_orchestration_plan`의 일). plan을 안 건드리므로 `plan_version` 대신 `graph_revision`이 오른다. 원칙은 **이미 일어난 실행 이력을 소급 무효화하지 않는다**: `max_visits`/`max_total_visits`를 이미 소진한 값 아래로 낮추는 것은 거부(정확히 소진량으로 낮추면 "이번이 마지막"), `loop_back` 제거는 진행 중이어도 항상 허용(폭주 loop 탈출구). 구조 검증은 patch 전용 경로를 만들지 말고 결과 전체를 `validateGraphSpec()`에 다시 통과시킨다. `GraphSpec.version`은 스키마 버전이라 수정 카운터로 재사용 금지. 템플릿(`orchestration-graph-templates.ts`, `linear`/`review_loop`/`fan_out_aggregate`)은 저작 편의일 뿐 실행 규칙 면제가 아니다.
- **replan 은 그래프도 additive(ticket 301018c5)**: `submit_orchestration_plan`이 `graph`/`graph_template` 없이 다시 들어오면 확정된 `graph_spec`을 **보존**하고 새 step만 고립 node로 편입한다(`carryGraphThroughReplan()`). 예전엔 `graphFromWavePlan`으로 통째 재생성해 conditional/loop_back과 그동안의 patch가 오류·경고 없이 사라졌다. 보존 경로도 patch와 마찬가지로 전용 검증을 만들지 말고 결과 전체를 `validateGraphSpec()`에 다시 통과시킬 것 — 누락 step을 고립 node로 채우는 건 검증기가 이미 하는 일이다. 이 보존이 성립하는 근거는 **plan에서 step이 사라지지 않는다**는 불변식(재제출은 누락 키 보존, `cancel`은 status만 변경, `listSteps`는 상태 미필터)이므로, step을 실제 삭제하는 경로를 만들면 여기도 함께 고쳐야 한다. 폐기는 `reset_graph: true`로만 명시하고, 그때만 `graph_revision`이 0으로 리셋된다.
- Reference: `docs/orchestration.md`

## Agent templates (2026-10 cleanup)

- `AgentTemplate` is a reusable preference in Hosts, with host/cli/model/effort/runtime_config only. Never put working_dir, lifecycle or execution identity on templates.
- `RuntimeSelectionFields` is the shared selection UI. Loading a template copies preferences; inline RuntimeSpecs and session folders own execution settings independently.
- The legacy Agent table, key/assistant references, duplicate Action/QA/Security/Schedule target columns and per-Agent skill bindings are retired. Response/SSE `agent_id` names on execution records are runtime identity keys, not template IDs.
- `preSyncAgentCleanup` preserves Host pairing aliases before synchronize; migration 1760000000090 performs the same idempotent cleanup. New skills bind to `RuntimeSkillAssignment.runtime_key`; classifiers use `OutreachChannel.classifier_runtime`.

## Agent Sessions (CLI 직접 세션)

- Chat 과 **별개 표면**: Runtime Host 장비에 있는 CLI(Claude Code / Codex / Hermes)의 세션을 AWB 화면에서 직접 몬다. 단위는 **(Runtime Host, CLI, 네이티브 세션 id)** 이고 **트랜스크립트 원본은 CLI가 보관한다** — 목록·기록은 매니저가 CLI 홈(`~/.claude/projects`, `~/.codex/sessions`)에서 읽어 reverse RPC 로 답하고, 라이브 턴의 스트림만 driver 사용자에게 SSE 로 중계한다. AWB는 `AgentSessionExecution`에 실행 소유권과 설정만 저장한다. 그 장비에서 터미널로 쓰던 세션도 그대로 뜬다. 기본 랜딩이 `/sessions` 다. ChatRoom 은 그대로(다자간 대화 + run dispatch 버스) — 세션 기능을 방(room)에 분기로 얹지 말 것.
- 이름 규약: 실행 메타데이터 엔티티 `AgentSessionExecution` + 메모리 라이브 상태, 모듈 `modules/agent-sessions`, REST `/api/agent-sessions/hosts/:managerId/:cli/sessions[/:id/...]`(사용자) · `/api/agent/sessions/rpc/:requestId`, `/api/agent/sessions/:managerId/:cli/:id[/events]`(매니저), SSE `agent_session_request`(→manager, scope 는 매니저 identity) · `agent_session_update`/`agent_session_event`(→driver UI), 권한 `agent_sessions.use`(기본 admin 전용), 클라이언트 `components/sessions/*`, 매니저 `agent-session-runner.ts` + `agent-session-store.ts`, 하트비트 `acp_session_clis`. 상수 단일 원천은 `apps/server/src/common/types/agent-sessions.ts`.
- **CLI 설정과 실행 고정**: Account × Runtime Host × CLI의 credential/backend/default_config는 새 세션의 기본값이다(`agent_session_cli_settings`, `PUT /api/agent-sessions/hosts/:managerId/:cli/settings`). 처음 AWB에서 실행할 때 `AgentSessionExecution`이 소유 `account_id`, `credential_id`, `config_defaults`, `runtime_profile`을 고정한다. 이후 계정 기본값 변경은 기존 세션에 소급하지 않는다 — 단 사용자가 세션을 **restart** 하면 인증(`credential_id`)만 소유 계정의 현재 CLI 설정으로 다시 묶는다(usage limit 에 걸린 credential 을 호스트 설정에서 바꾸고 재시작하는 경로; config/backend snapshot 은 유지). 사용자가 해당 세션에서 명시적으로 바꾼 mode/config는 실행 snapshot에도 기록하며 재개 시 유지한다. 매니저는 바인딩된 credential 만 `GET /api/agent/sessions/credential/:id` 로 받아 **세션 전용 cli-home**(`session-homes/<cli>/<credential_id>`, 기록 디렉터리만 운영자 홈으로 링크)에 기존 어댑터 `prepareCliHome` 으로 적용한다 — 운영자 홈의 로그인 파일은 절대 건드리지 않는다. 비워 두면 장비의 CLI 로그인 상태를 그대로 쓴다.
- `agent_session_request` payload(`credential_id` 포함) · `/api/agent/sessions/*` 바디·credential 응답 · 하트비트 `acp_session_clis` · `agent_sessions[]`(새 세션의 MCP 연결 참조 `mcp_session_ref` 포함) 는 server·agent-manager 공동 contract — 변경은 같은 PR. 상세: `docs/agent-sessions.md`.

## Terminal (Runtime Host 셸)

- Agent Session 과 **같은 배선, 다른 수명**: 표면(호스트 → 목록 → 하나)과 reverse RPC + driver SSE 는 세션을 그대로 따랐지만, 터미널은 장비에 기록이 없다 — PTY 프로세스가 곧 터미널이라 **살아 있는 것만 존재한다**. 죽은 행을 목록에 남기지 말 것(복원할 것이 없어 눌러도 아무 일도 안 일어나는 행이 된다). 다시 붙을 때 되살리는 것은 매니저가 들고 있는 스크롤백(256KiB)뿐이다.
- 이름 규약: 엔티티 없음(메모리 라이브 상태만), 모듈 `modules/terminals`, REST `/api/terminals/hosts/:managerId/terminals[/:id/...]`(사용자) · `/api/agent/terminals/rpc/:requestId`, `/api/agent/terminals/:managerId/:id[/output]`(매니저), SSE `terminal_request`(→manager, scope 는 매니저 identity) · `terminal_update`/`terminal_output`(→driver UI), 권한 `terminals.use`(기본 admin 전용 — 사실상 그 장비 운영자 권한의 셸이다), 클라이언트 `components/terminals/*`(xterm.js), 매니저 `terminal-runner.ts` + `terminal-shells.ts`, 하트비트 `terminal_shells`/`terminals`/`platform`. 상수 단일 원천은 `apps/server/src/common/types/terminals.ts`.
- PTY 는 **선택 의존성**(`@lydell/node-pty`, 플랫폼별 prebuild — linux/darwin/win32). 못 불러오면 던지지 않고 그 장비의 셸 목록을 비운다 → 서버가 터미널 호스트 목록에서 뺀다(409 `terminal_unsupported`). Windows 는 ConPTY 로 같은 경로를 탄다.
- `terminal_request` payload · `/api/agent/terminals/*` 바디 · 하트비트 필드는 server·agent-manager 공동 contract — 변경은 같은 PR. 상세: `docs/terminals.md`.

## CLI Memory (LLM CLI 메모리 파일)

- Runtime Host 장비의 CLI 메모리(Claude `CLAUDE.md`·rules·auto memory, Codex `AGENTS.md`·`memories/`, Hermes `MEMORY.md`/`USER.md`, OpenCode/Pi `AGENTS.md`, Antigravity `GEMINI.md` …)를 `/memory` 에서 보고·분석하고·고치고·다른 CLI/장비에 적용하고·import/export 한다. **원본은 그 장비의 파일**이고 서버는 상태 없는 중계자다(`modules/cli-memory`, SSE `cli_memory_request`, 매니저 `cli-memory-runner.ts`, 권한 `cli_memory.use` 기본 admin 전용, 상수 단일 원천 `apps/server/src/common/types/cli-memory.ts`).
- **어디에 무엇이 있는지는 CLI 모듈의 `memory` 슬라이스 한 곳**(`apps/agent-manager/src/lib/clis/<id>/memory.ts`)이 선언한다 — 러너·화면에 CLI 이름 분기를 쓰지 말 것. 러너는 선언된 파일, 또는 선언된 디렉터리 바로 아래의 새 `.md` 에만 쓴다. project 범위 폴더는 **서버가** `ProjectHostFolder` 에서 골라 싣는다 — 화면이 보낸 폴더를 매니저로 넘기지 말 것(임의 폴더에 지침 파일을 만드는 길이 된다).
- 쓰기는 `base_hash`(내용 sha256 앞 16자; 문자열 = 그 내용이어야 · `null` = 없어야 · 생략 = 확인 안 함)로 CLI 의 동시 편집을 막고, 모든 변경 전에 매니저가 `memory-backups/` 에 백업한다(History · 지운 파일 복원). 링크를 통한 쓰기는 대상을 바꾸고 링크를 보존한다.
- AWB credential 세션은 자기 CLI 홈(`session-homes/<cli>/<credential_id>`)을 쓰고 기록 디렉터리만 운영자 홈으로 링크하므로 **운영자의 전역 지침(CLAUDE.md · AGENTS.md)을 못 본다** — 스캔은 세션 홈도 보고, 분석이 경고하며 link op 로 잇는다. 세션 홈 준비 경로를 바꿀 때 이 관계를 함께 볼 것.
- 분석·형식 변환·번들은 화면의 순수 함수(`components/memory/*.logic.ts`)다. Hermes 항목은 hermes-agent 와 같은 `\n§\n` 규칙으로만 직렬화한다(아니면 Hermes drift guard 가 그 파일 쓰기를 거부한다). 다른 CLI 로 옮긴 내용은 관리 블록(`<!-- awb-memory:begin <id> -->`)으로 넣어 재적용이 멱등이다.
- `cli_memory_request` payload · `/api/agent/cli-memory/rpc` 바디 · `manager_capabilities` 의 `cli_memory` 는 server·agent-manager 공동 contract — 변경은 같은 PR. 상세: `docs/cli-memory.md`.

## Android 앱 (`apps/android`)

- 네이티브 껍데기(Java)가 **서버가 서빙하는 웹 화면 전체**를 WebView 로 띄운다 — 웹 빌드를 앱에 묶지 말 것(예전 Capacitor 껍데기가 그래서 CORS · 구글 로그인 이탈을 겪고 버려졌다). 네이티브는 상시 음성(`voice/VoiceService`) · 단말 자격(`UserDevice`, `/api/auth/devices*`) · 구글 로그인 PKCE 왕복(`oauth/google/start?app=android` → `awb://oauth` → `oauth/app/exchange`)만 맡는다.
- 웹 ↔ 앱은 `window.AwbAndroid`(`apps/client/src/native/androidBridge.ts` ↔ `WebBridge.java`). 요청 이름을 바꾸면 양쪽을 같이 — `apps/client/test/android-bridge.test.mjs` 가 본다. `VoiceRules.java` 는 `voice/wake.logic.ts` 의 사본이다(`android-voice-rules.test.mjs`).
- 앱 화면이 보이면 웹이, 안 보이면 서비스가 듣고 읽는다(한 단말에서 둘이 같이 들으면 두 번 깨어난다). 웹 음성 코드를 고칠 때 `hiddenInAndroidApp()` 게이트를 지우지 말 것. 상세: `docs/android-app.md`.

## Voice (음성 입력 · 낭독 · 음성 알림)

- 음성은 **AWB 서버가 엔진을 잡는다**(`modules/voice`, SystemSettings `voice.*`, 권한 `voice.use` 기본 admin 전용) — 화면은 녹음 바이트를 보내 글자를 받고, 글자를 보내 소리를 받는다. CLI 에이전트는 텍스트만 다루고 **agent-manager 는 오디오 경로에 없다**(SSE contract 무관). Claude/Codex 의 자체 음성 기능은 구독 경로로 재사용할 수 없어서 별도 엔진(Soniox · ElevenLabs · Typecast · Azure · Google · OpenAI 호환)을 쓴다.
- 화면용 답을 소리로 바꾸는 규칙은 `modules/voice/speakable.ts` 의 `toSpeakable()` 한 곳이다 — 세션 낭독 · 음성 알림 · 앱이 모두 이것을 지난다. 경로마다 따로 다듬지 말 것. operator 의 답은 같은 파일의 `toSpokenSummary()`(첫 문단만, 300자)로 읽는다 — 결과를 통째로 읽지 않게.
- 설정이 비었거나 공급자 이름이 틀리거나 키가 없으면 409 + 사유다. 다른 공급자로 조용히 넘어가는 대체 경로를 만들지 말 것.
- 엔진은 Admin → Voice 의 lab(STT 비교 · TTS 블라인드 테스트)으로 고른다. 상세 · 로드맵(음성 알림, operator, Android 앱): `docs/voice-operator.md`.
- 셀프호스팅 엔진(ragnar: Qwen3-ASR + Qwen3-TTS)은 `services/voice-server/`(npm 워크스페이스 밖, Python)에 있고 AWB 는 `local` 어댑터로 그 게이트웨이만 부른다 — 모델·목소리 교체는 게이트웨이/`voices.json` 쪽 일이지 AWB 코드 변경이 아니다.
- **Operator 는 이름 붙은 Agent Session 여러 개**(`operator.sessions`, `/api/voice/operators`)이고, "헤이 <이름>" 으로 깨운다. 깨우는 말은 키워드 모델이 아니라 셀프호스팅 STT 로 받아 적은 **글자로** 확인한다(`apps/client/src/voice/wake.logic.ts`, 상시 청취는 `?purpose=wake` 로 `local` 엔진에서만). 잠들기는 화면이 낱말로 추측하지 않고 **operator 가 문맥으로 정해 답 끝에 `[[sleep]]`** 을 붙인다 — 그 표시를 바꾸면 지침(`operatorBrief`) · 화면(`splitSleepMarker`) · 서버 낭독 정리(`SLEEP_MARKER_RE`) 셋을 같이 바꿀 것. 이름만 한 발화로는 깨우지 않는다(엔진이 용어집을 읊는 메아리 때문). 상세: `docs/voice-operator.md` → "음성 지원 · 잠들기".
- **세션 소식은 operator 가 전한다**: AWB 를 거친 세션의 턴 종료·오류·승인/질문 대기를 AWB 가 감지해 operator(같은 호스트 → 없으면 가장 최근 대화)에게 보고 프롬프트로 보내고(`OperatorReportService` → `AgentSessionsService.promptOnBehalf`), operator 의 요약이 `voice_announcement`(`operator_report`)로 간다. 보고 있는 세션도 보고하되 소리로는 전하지 않는다(`PUT /api/voice/presence` 의 "보고 있음" — operator 는 기록만), 끝난 턴의 보고에는 그 턴에서 정해진 것(권한 선택 · 질문의 답)이 실린다. 닿지 못한 보고는 직접 알림으로 되돌린다 — 버리지 말 것. 사이드바 OPERATORS 의 음성 지원 스위치(단말마다 따로 → `PUT /api/voice/support`, `VoiceSupportService`)가 그 사용자의 **모든 단말에서 꺼져 있으면** 턴 종료·오류는 보고하지 않는다(승인·질문 대기와 operator 가 시킨 작업의 결과는 예외). 보고 프롬프트 첫머리 `[AWB 작업 보고]` 는 server(`operator-report.ts`)·client(`wake.logic.ts`) 계약이다. 상세: `docs/voice-operator.md` → "작업 보고".
- **작업 제안**: operator 는 다른 세션에 일을 직접 시키지 못하고 MCP `propose_session_prompt` 로 **제안**만 한다(어느 턴에서든, operator 세션 포함, 호스트 무관). 보내는 것은 사용자 승인 뒤다 — 화면 Send(`POST /api/voice/proposals/:id/send`) 또는 사용자가 시작한 operator 턴의 `send_session_prompt_proposal`. 제안은 승인 대기 상태라 메모리가 아니라 `AgentSessionPromptProposal` 에 둔다(배포 재시작에 사라지지 않게). operator 세션을 대상으로 보낼 때 그 턴은 작업 턴으로 표시돼 "사용자 턴" 으로 세어지지 않으므로 승인 권한이 새지 않고, 답은 `delegated` 로 시킨 쪽에만 돌아간다. 보낸 프롬프트 첫 줄 `[AWB 오퍼레이터 작업] <이름> — 사용자 승인` 은 server(`voice/operator-proposal.ts`)·client(`sessionTranscript.logic.ts`) 계약이다. 그 턴의 결과는 **제안한 operator** 에게 보고된다(`SessionReport.delegated`, 소리 설정과 무관). 상세: `docs/voice-operator.md` → "작업 제안".
- **재시작으로 끊긴 세션**: operator 는 `resume_interrupted_session` 으로 **사용자 승인 없이** 잇는다 — 작업 제안의 유일한 예외. 보내는 글이 고정 문구(`[AWB 재개]`, server `voice/interrupted-sessions.ts`·client `sessionTranscript.logic.ts` 계약)이고 AWB 가 끊김을 기록한 세션만 6시간 안에 한 번이라 다른 세션의 글이 명령이 되지 않는다. 글을 operator 가 고르게 하거나 기록 밖의 세션을 허용하는 변경은 제안 규칙을 우회하는 길이다 — 하지 말 것. 상세: `docs/voice-operator.md` → "재시작으로 끊긴 작업".
- **말로 답하기**: operator 는 MCP `answer_session_permission` / `answer_session_question` 으로 사용자가 말로 고른 것을 기다리는 세션에 전한다. MCP 는 "사람이 정했다" 를 증명하지 못하므로 서버가 **operator 연결 · 사용자가 시작한 operator 턴(보고 턴 거절) · 같은 사용자 · 아직 미결인 요청과 그 선택지**만 허락한다(`voice/operator-decision.service.ts`). 이 조건을 느슨하게 하는 변경(예: 보고 턴에서 허용)은 다른 세션이 쓴 글로 승인이 일어나는 길을 연다 — 하지 말 것. 상세: `docs/voice-operator.md` → "말로 답하기".

## Marketing (에이전트 기반 제품 마케팅 루프)

- `/marketing` 의 캠페인 에이전트가 주기마다 채널 탐색 → 게시 · 메일 → 예산 편성 · 지출 요청 → 분석 → 피드백 → 제품 티켓을 돈다(`modules/marketing`, MCP `marketing-tools.ts`, 규칙 · 상수 `common/marketing/*`). **에이전트는 제안만 하고 사람이 정하고 서버가 집행한다** — 승인 · 거부 · 결제 기록 · 연락처 MCP 툴을 만들지 말 것. 결제 키 · 메일 키를 에이전트에게 주지 말 것(`agent_env` credential 은 거부된다).
- 돈: 잔액 칼럼을 두지 말 것 — 한도는 append-only `marketing_ledger_entries` 합으로 `common/marketing/budget.ts` 한 곳에서 계산한다. 돈이 움직이는 전이는 `lockCampaign` 트랜잭션(캠페인 행 잠금 → 상태 CAS → 원장 · 감사)으로만, 승인은 화면이 본 `payload_sha256` 과 함께. 결과가 모호한 결제(`unknown`)를 자동으로 재전송하거나 `failed` 로 닫지 말 것(이중 지출). 원장 · 감사 로그를 UPDATE/DELETE 하는 경로를 만들지 말 것.
- 직접 결제(`marketing-payment-*.ts`)는 돈을 보내지 않는다. 공급자는 `DIRECT_PROVIDER_SPECS` 의 두 종류다 — 공급자별 분기는 그 표와 exhaustive switch 로만(“Meta 가 아니면 Google” 금지).
  - 상한(Meta Ads · Google Ads): 광고 캠페인의 **고정 상한**(Meta `spend_cap`, Google `CUSTOM_PERIOD` 총예산)만 올린다 — 승인 금액 = 상한 증가분. 계획(`from → to`)은 요청 때 서버가 대상을 읽어 만들어 해시하고, 실행은 다시 읽어 `from` 일 때만 쓴다. 대상마다 열린 요청은 하나(`uq_marketing_spend_open_target`). 일 예산 · 공유 예산을 받거나, 통화를 닫힌 표(`PAYMENT_CURRENCIES`) 밖에서 추측하지 말 것.
  - 카드(Stripe Issuing): 승인 하나에 가상 카드 한 장(누적 한도 = 승인 금액). **비활성으로 만들어 계획과 대조한 뒤 활성화**하고, 어긋나거나 활성화가 거절되면 해지한 뒤 `failed`. 멱등 키 `awb-spend-<id>` 고정, `Stripe-Version` 고정. 카드 번호를 펼치거나(`expand[]=number`) 응답에 박힌 카드 소지자 정보를 읽어 저장하지 말 것. 운영 키는 제한된 키(`rk_live_`)만. 이 요청의 카드가 해지되지 않은 채 있으면 실패로 기록하지 않는다(해지된 카드만 있거나 확인하지 못하면 `confirm_no_spend`). 카드 찾기의 "없음" 은 확인 없이 예산을 풀어 주므로 요청 때와 같은 키로 범위의 모든 쪽 · 항목을 읽었을 때만이다 — 모양이 틀린 답을 빈 목록으로 읽지 말 것. 실행 시작에서 5분이 지난(멈췄던) 실행은 카드를 만들거나 활성화하지 않는다.
  - 공통: 결제 경로는 수취인마다(`payees[].provider` · `credential_id` · `ref`, 카드는 일회용 · 업종을 계획에 해시하고 카드당 최대까지 승인 · 실행 때 대조). 어댑터는 보내기 전 실패만 `PaymentNotSentError` 로 알린다 — 그 밖의 예외는 `unknown`. 에이전트 payload 를 계획에 섞지 말 것. 직접 결제의 환불은 상한을 낮추거나 카드를 해지 · 대조하기 전에는 막는다. credential 발급 안내는 `apps/client/src/components/marketing/paymentCredentialGuides.ts` 한 곳. 상세: `docs/marketing.md` → "직접 결제 어댑터".
- 외부 발신은 전부 사람 승인 뒤다(자동 게시 없음). 메일은 동의 연락처에게만, 광고 표기 · 발신자 정보 · 수신거부 링크 · One-Click 헤더는 `common/marketing/email.ts` 가 강제한다. 외부 글은 사이클 지시문의 비신뢰 블록(`common/marketing/cycle-prompt.ts`)과 MCP 의 `*_untrusted` 필드로만 에이전트에게 간다.
- 메일 공급자 webhook(`/api/m/email/<credential id>/{events,inbound}`)은 **서명이 곧 인증**이다 — 서명 검증 전에 본문을 해석하거나, 키 없는 credential 에서 아무거나 받아 주는 경로를 만들지 말 것. 이벤트는 그 credential 로 보낸 발송 행에만 닿는다(`MarketingEmailEventsService.inScope`). 답장은 인용 · 서명 · 메일 주소 · 수신거부 링크를 지운 본문(`common/marketing/email-reply.ts`, 선형 스캔 — 외부 입력에 본문 전체 정규식을 돌리지 말 것)만 피드백이 되고, 답장한 연락처는 `contact_id` 로만 이어 사람용 REST 에만 싣는다(author · MCP · 지시문에 주소를 넣지 말 것). 스팸 신고율이 높은 목록은 `MarketingListHold` 로 멈추고 해제는 사람만. 상세: `docs/marketing.md` → "공급자 이벤트".
- 동의 재확인 안내(정보통신망법 §50⑧, `MarketingConsentNoticeService`)는 **법정 통지이지 광고가 아니다** — 광고 표기 · 광고 문구를 섞지 말고, 법정 항목(보낸 곳 · 동의한 날짜 · 유지/철회 방법 · 무응답 처리)은 `common/marketing/consent-notice.ts` 가 붙인다. 기한 전에만 보낸다 — 지난 동의를 안내로 되살리는 경로를 만들지 말 것(동의를 다시 묻는 메일 자체가 광고성 정보다). "응답이 없으면 유지" 안내는 **기한이 올 때** 그 사이 철회 · 새 동의 · 미도달이 없었으면 그 기한부터 잇는다(`consent_renewed_at`, 기산일은 원래 동의일 — 보낼 때 미리 잇지 말 것). 공급자에 넘긴 안내는 다시 보내지 않는다. 유지 링크는 POST 로만 새 동의를 남긴다(GET 무변경). 동의 기간 판정은 `consentFresh(contact)` · `consentDeadline` 한 곳 — `consent_at` 만 보는 판정을 새로 쓰지 말 것. 상세: `docs/marketing.md` → "동의 재확인 안내".
- 승인 대기 알림(사용자 채널)은 `MarketingApprovalNotifyService` 한 곳이 승인함과 같은 기준으로 **상태에서** 계산해 묶어 보낸다. (대상, 종류)당 한 번은 `marketing_approval_notices` 가 보장한다. 요청 · 승인 · 결제 경로에서 `dispatchForUser` 를 직접 부르지 말 것 — 묶음과 중복 방지를 우회하고 알림 실패가 돈 트랜잭션에 섞인다. 알림 본문에 에이전트가 쓴 글(목적 · 제목 · 채널 이름)을 싣지 말 것.
- 참여 지표 자동 수집(`MarketingEngagementService`, 규칙 `common/marketing/engagement.ts`)은 reddit · GitHub outreach 채널에 서버가 게시한 글을 14일 동안 커넥터로 읽어 **직전 값과의 변화량**을 `MarketingMetric`(source `connector`)에 남긴다 — 행의 합이 플랫폼의 현재 값이라 리포트의 누적형 합산이 그대로 맞는다. 읽은 수준값을 그대로 누적형 행에 넣지 말 것(읽을 때마다 다시 더해진다). 채널 `rate_limit_per_hour` 의 절반은 게시 · 폴링 몫으로 남긴다. 수집기의 모든 쓰기는 `engagement_rev` CAS 에 rev 를 올린다 — 값만 쓰고 rev 를 두면 낡은 직전 값을 든 다른 서버가 같은 변화를 또 넣는다. 이 채널들의 engagements · replies 를 사람 · 에이전트 기록으로도 받으면 두 번 센다 — 거부를 풀지 말 것. 상세: `docs/marketing.md` → "참여 지표 자동 수집".
- 사이클은 자체 tick(qa-cron 의미)이고 디스패치는 방 + 첫 메시지라 agent-manager · SSE contract 변경이 없다. `marketing_update` 는 UI 전용 SSE. 상세: `docs/marketing.md`.

## Skills (AWB 기능)

- Global(`account_id NULL`) / Account 2계층. 같은 slug면 Account가 Global을 shadow — 커스터마이즈는 global 직접 수정이 아니라 **fork**.
- Global 쓰기는 admin 전용(`/api/admin/skill-registry`). Account 사용자는 global을 읽고 배정만 할 수 있다.
- Global을 채우는 소스 두 개: 저장소 안의 **내장 팩** `skills/` (부팅 시 멱등 시드, 네트워크 불필요 — "최신"은 서버 업그레이드로 따라온다)과 **tap**(외부 git repo, **기본 비활성**, 부팅 시 절대 동기화 안 함).
- 동기화는 **append-only**: 변경은 새 불변 버전을 추가할 뿐이고, assignment는 특정 버전을 핀하므로 이미 배정된 에이전트가 읽는 내용은 절대 바뀌지 않는다. `quarantined` 는 운영자 거부권이라 동기화가 되살리지 않는다.
- **배정 범위**: skill 버전은 공용(계정 모든 Agent, `runtime_key='*'`) · 프로젝트(`project:<id>`) · 실행(`rt-…`) 에 핀한다. 한 실행 = 공용 ∪ 그 프로젝트 ∪ 그 실행, 같은 skill 은 **좁은 범위가 이긴다**. 범위 계산은 `modules/skills/knowledge.ts` 한 곳(런 스냅샷 · 미션 step · MCP 공용) — 경로마다 따로 풀지 말 것.
- **Knowledge(공용 메모리 · 프로젝트 메모리 · skill)** 는 화면 Knowledge → Memory / Skills 에 있다. 공용 메모리 `Account.knowledge_memory`, 프로젝트 메모리 `Project.instructions`. 티켓 work order · 미션 step 은 `renderKnowledgeSection()` 으로 공용 메모리와 skill **목차**만 싣고, 본문은 MCP `get_skill`(티켓 안에서는 그 런의 고정 버전)로 읽는다 — 모든 CLI 에 같은 경로다. 사람이 여는 CLI 세션용으로는 공용 지식을 호스트 CLI 전역 파일에 관리 블록으로 동기화한다(CLI Memory 쓰기 경로).
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
