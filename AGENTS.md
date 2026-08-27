<!-- scripts/sync-agent-instructions.mjs가 CLAUDE.md에서 생성했습니다. 수동으로 편집하지 마세요. -->

## Codex 전용 참고 사항

Codex는 저장소 루트부터 현재 작업 디렉터리까지 AGENTS.md를 탐색합니다. 더 가까운 AGENTS.md에서 이 지침을 구체화할 수 있지만, 시스템 정책과 AWB 역할 정책이 항상 우선합니다.

## Project

**AI Workflow Board (AWB)**

AI Workflow Board는 AI Agent가 MCP를 통해 연결하여 자율적으로 티켓을 처리하는 칸반 기반 워크플로우 자동화 플랫폼이다. Agent가 역할(Assignee/Reporter/Reviewer)별로 티켓을 수신하고, subagent를 통해 실제 작업을 수행한 뒤, 결과를 comment로 남기고 티켓 상태를 이동시키는 자동화 루프를 제공한다.

**Core Value:** Agent가 MCP로 연결되어 티켓을 자율 처리하고, 완료된 티켓이 다음 역할의 Agent에게 자동 트리거되는 연속 자동화 루프.

### Constraints

- **Tech Stack**: 기존 NestJS + React + TypeORM 유지 — 전면 재작성 불가
- **MCP 호환**: @modelcontextprotocol/sdk 기반 Streamable HTTP 유지
- **DB 호환**: SQLite(개발) + PostgreSQL(운영) 이중 지원 유지
- **Agent 독립성**: AWB는 Agent의 내부 구현에 의존하지 않음 — MCP 인터페이스만 사용
- **Agent Manager sync**: SSE 이벤트, subagent 위임, persistent ticket/chat session, CLI lifecycle 변경은 `apps/agent-manager/` 에서 처리. 절차 → (1) `apps/agent-manager/src/` 수정, (2) `npm run build` 통과 확인 (workspace root turbo 빌드 포함), (3) commit + push — **버전은 손으로 범프하지 말 것**: `main` 랜딩 시 `.github/workflows/publish-agent-manager.yml` 이 `apps/agent-manager/scripts/compute-publish-version.mjs` 로 버전을 자동 계산해 publish 한다 (상세 절차는 `.claude/skills/awb-agent-manager-release/SKILL.md` 참조). SSE 이벤트 타입을 추가/변경한 경우 서버측 (`apps/server/src/modules/agent-manager/`) 변경과 같은 PR 으로 묶을 것 — agent-manager 와 AWB 서버가 같은 contract 를 본다. `agent_trigger` payload 의 `harness_config` (Board/Workspace 별 CLI 하네스, `apps/server/src/common/harness-config.ts` 스키마) 도 이 SSE contract 에 포함 — 키 추가/변경 시 server·agent-manager 양쪽을 같은 PR 로 (필드별 CLI 매핑은 `docs/agent-manager.md` → "Harness config" 참조).

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
- Each module has its own file structure without explicit barrel files (imports done directly)
## Entity Naming (Database)
- `@Entity('table_name')` for table mapping
- `@PrimaryGeneratedColumn('uuid')` for ID generation
- `@Column()` with type and options for fields
- `@CreateDateColumn()` and `@UpdateDateColumn()` for timestamps
- `@ManyToOne()`, `@OneToMany()` for relationships
- `@JoinColumn()` for foreign key specification

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
- Reference: `docs/agent-manager.md` (internals), `apps/agent-manager/README.md` (quickstart)

## Orchestration mode (팀 기반 자율 업무 오케스트레이션)

- 칸반 보드와 같은 레벨의 두 번째 작업 표면. Team(오케스트레이터 1 + 멤버 N) 에게 Mission 을 통째로 맡기면, 오케스트레이터 Agent 가 런타임에 Step DAG 계획을 세우고 팀원에게 배분한다.
- Location: `apps/server/src/modules/orchestration/` · MCP 툴 `modules/mcp/tools/orchestration-tools.ts` · UI `apps/client/src/components/orchestration/`
- **디스패치는 QA/Action 런과 같은 ChatRoom 파이프라인을 재사용한다** — `chat_rooms.orchestration_mission_id/_step_id` 로 표시하고 기존 `is_action_room` SSE 마커를 켠다. 따라서 **agent-manager 변경 없음, SSE contract 변경 없음**. `run_provision` 은 v1 범위 밖 (붙이려면 `RunProvision.kind` 에 `'orchestration'` 추가 → agent-manager `run-provisioner.ts` 파서와 같은 PR).
- `orchestration_update` SSE 는 `consensus_update` 와 같은 **UI 전용** 이벤트 (user-only filter) — agent 비소비이므로 agent-manager contract 무관.
- 미션은 **암묵적으로 끝나지 않는다**: `complete_orchestration_mission` (또는 운영자 cancel) 만이 종료 경로. 엔진은 스스로 진행 못 할 때만 오케스트레이터를 깨운다(실패/차단, 디스패치 불가, 전 step 종료).
- Reference: `docs/orchestration.md`

## Skills (AWB 기능)

- Global(`workspace_id NULL`) / Workspace 2계층. 같은 slug면 Workspace가 Global을 shadow — 커스터마이즈는 global 직접 수정이 아니라 **fork**.
- Global 쓰기는 admin 전용(`/api/admin/skill-registry`). Workspace 사용자는 global을 읽고 배정만 할 수 있다.
- Global을 채우는 소스 두 개: 저장소 안의 **내장 팩** `skills/` (부팅 시 멱등 시드, 네트워크 불필요 — "최신"은 서버 업그레이드로 따라온다)과 **tap**(외부 git repo, **기본 비활성**, 부팅 시 절대 동기화 안 함).
- 동기화는 **append-only**: 변경은 새 불변 버전을 추가할 뿐이고, assignment는 특정 버전을 핀하므로 이미 배정된 에이전트가 읽는 내용은 절대 바뀌지 않는다. `quarantined` 는 운영자 거부권이라 동기화가 되살리지 않는다.
- 새 SKILL.md 레이아웃/스코프/동기화 규칙은 `docs/skills.md`, 스코프 모델 전반은 `docs/catalog-scopes.md`.

## Project Skills

Skills live in `.claude/skills/<name>/SKILL.md` (added with the agent-harness work, ticket 040afa10):

- **awb-ticket-recovery** — stuck / never-dispatching ticket runbook (edge-triggered dispatch, terminal-column births, async create-dispatch, duplicate-instance check)
- **awb-agent-manager-release** — agent-manager build-verify + same-PR SSE contract rule (버전은 publish 시 자동 계산 — 손 범프 금지)
- **awb-field-wiring** — 5-touch-point checklist for Ticket JSON-array columns
- **awb-mcp-tool-wiring** — 7-touch-point checklist for new MCP tool registration (TOOL_AUTHZ_TABLE tier classification, plus agent-manager ticket-ref-capture classification — skipping the former ships a tool that always denies, skipping the latter ships one whose card silently vanishes from chat)
- **awb-agent-display-name** — the `<Manager>/<Agent>` display contract: 6 touch points for ANY surface that shows an agent (picker, roster, typing/status indicator, timeline, SSE frame, agent-facing prompt). Rendering a bare `agent.name` — or a raw agent id — is a bug: the same leaf name legitimately exists under multiple managers. **Read this before adding any agent picker or agent-name label.**

`.claude/settings.json` carries the read-only permission allowlist generated via `/fewer-permission-prompts` — extend it there rather than ad-hoc allowing in session.
