## Project

**AI Workflow Board (AWB)**

AI Workflow Board는 AI Agent가 MCP를 통해 연결하여 자율적으로 티켓을 처리하는 칸반 기반 워크플로우 자동화 플랫폼이다. Agent가 역할(Assignee/Reporter/Reviewer)별로 티켓을 수신하고, subagent를 통해 실제 작업을 수행한 뒤, 결과를 comment로 남기고 티켓 상태를 이동시키는 자동화 루프를 제공한다.

**Core Value:** Agent가 MCP로 연결되어 티켓을 자율 처리하고, 완료된 티켓이 다음 역할의 Agent에게 자동 트리거되는 연속 자동화 루프.

### Constraints

- **Tech Stack**: 기존 NestJS + React + TypeORM 유지 — 전면 재작성 불가
- **MCP 호환**: @modelcontextprotocol/sdk 기반 Streamable HTTP 유지
- **DB 호환**: SQLite(개발) + PostgreSQL(운영) 이중 지원 유지
- **Agent 독립성**: AWB는 Agent의 내부 구현에 의존하지 않음 — MCP 인터페이스만 사용
- **Plugin version sync**: AWB MCP tool surface 변경 시 동반 stdio MCP plugin (`https://github.com/parnmanas/claude-plugins`, subpath `ai-workflow-board/`) 도 업데이트. 절차 → (1) `proxy.mjs` / MCP tool 수정, (2) `.claude-plugin/plugin.json` version 범프, (3) plugin repo commit + push. 버전을 안 올리면 marketplace 캐시에 반영 안 됨. SSE / subagent / 채널 처리는 plugin 책임이 아님 (plugin v0.40.0 부터 agent-manager 로 이전).
- **Agent Manager sync**: SSE 이벤트, subagent 위임, persistent ticket/chat session, CLI lifecycle 변경은 `apps/agent-manager/` 에서 처리. 절차 → (1) `apps/agent-manager/src/` 수정, (2) `npm run build` 통과 확인 (workspace root turbo 빌드 포함), (3) `apps/agent-manager/package.json` version 범프, (4) commit + push. SSE 이벤트 타입을 추가/변경한 경우 서버측 (`apps/server/src/modules/agent-manager/`) 변경과 같은 PR 으로 묶을 것 — agent-manager 와 AWB 서버가 같은 contract 를 본다.

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
- **Corrupt dev DB**: a malformed `data.db` ("database disk image is malformed") used to hang boot ~25s (killing agent subagents at exit 143). `ensureSqljsDbHealthy()` in `db.ts` now runs a sql.js integrity check *before* TypeORM initializes (wired into both `initDb()` and `main.ts` bootstrap) — sql.js/dev only, Postgres untouched. A corrupt file aborts in ~1s with a clear message; `rm database/data.db` to recreate, or set `AWB_DB_AUTORECOVER=1` to auto-backup to `data.db.corrupt-<ts>` + recreate empty. See README → Development → Troubleshooting.
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

## Claude Plugin (stdio MCP forwarder)
- Location: separate repo `https://github.com/parnmanas/claude-plugins` (subpath `ai-workflow-board/`)
- `proxy.mjs` is a pure stdio↔HTTP MCP forwarder. Claude CLI ↔ proxy.mjs ↔ AWB `/mcp`
- `lib/mcp-forward-session.mjs` owns the AWB MCP session — stale-session recovery, retries
- The proxy does **not** consume the SSE stream and does **not** spawn subagents (since plugin v0.40.0 — those moved to agent-manager)

## Agent Manager (standalone subagent runner)
- Location: `apps/agent-manager/`
- Standalone Node binary (`awb-agent-manager`) — runs without Claude CLI, drives Claude / Codex / Gemini / custom CLIs
- Owns the SSE pipeline (`EventStream` → `EventDispatcher`), subagent supervision (`SubagentManager`), persistent ticket/chat sessions, fs-browser reverse-RPC, instance heartbeat, agent lockfile
- Bootstraps via one-time pairing token minted from AWB admin UI; persists `config.json` at `$AWB_AGENT_MANAGER_HOME` (default `~/.config/awb-agent-manager/`)
- AWB → manager control surface: SSE event `agent_manager_command` (5 verbs: `spawn_agent`, `stop_agent`, `restart_agent`, `set_working_dir`, `reload_config`); ack via `POST /api/agent-manager/command/ack`
- Field mapping (AWB SSE → handlers): `action`→role, `field_changed`→trigger_id, `actor_name`→agent_id
- Reference: `docs/agent-manager.md` (internals), `apps/agent-manager/README.md` (quickstart)

## Project Skills

No project skills found. Add skills to any of: `.claude/skills/`, `.agents/skills/`, `.cursor/skills/`, or `.github/skills/` with a `SKILL.md` index file.

