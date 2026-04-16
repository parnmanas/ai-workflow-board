# Codebase Structure

**Analysis Date:** 2026-04-08

## Directory Layout

```
ai-workflow-board/
├── apps/
│   ├── client/                    # React/Vite frontend
│   │   ├── src/
│   │   │   ├── components/        # UI components
│   │   │   ├── contexts/          # React context providers
│   │   │   ├── hooks/             # Custom React hooks
│   │   │   ├── api.ts             # REST client
│   │   │   ├── App.tsx            # Root component + routing
│   │   │   ├── main.tsx           # Entry point
│   │   │   └── types.ts           # TypeScript types
│   │   ├── package.json           # Client dependencies
│   │   ├── tsconfig.json          # TypeScript config
│   │   ├── vite.config.ts         # Vite build config
│   │   └── index.html             # HTML template
│   │
│   └── server/                    # NestJS backend
│       ├── src/
│       │   ├── common/            # Shared guards, filters, types
│       │   ├── database/          # TypeORM setup & migration
│       │   ├── entities/          # Database entity definitions
│       │   ├── modules/           # Feature modules (16 total)
│       │   ├── services/          # Shared services
│       │   ├── main.ts            # Server entry point
│       │   ├── mcp-server.ts      # MCP protocol server
│       │   └── db.ts              # Database connection util
│       ├── package.json           # Server dependencies
│       ├── tsconfig.json          # TypeScript config
│       ├── nest-cli.json          # NestJS CLI config
│       └── dist/                  # Compiled output
│
├── database/                      # Data files
│   └── data.db                    # SQLite database (default)
│
├── docs/                          # Documentation
├── scripts/                       # Utility scripts (e.g., clear-ports.mjs)
├── .planning/                     # This directory (analysis & planning docs)
├── package.json                   # Workspace root (Turbo config, npm scripts)
├── turbo.json                     # Turbo build orchestration
├── docker-compose.yml             # Multi-container setup
├── Dockerfile                     # Server container image
└── tsconfig.json                  # Root TypeScript config
```

## Directory Purposes

**apps/client/src/**
- Purpose: React frontend for workflow board UI
- Contains: Components (Board, Column, Ticket, Admin panels), context providers, hooks, API client
- Key files: `App.tsx` (routing), `api.ts` (HTTP client), `main.tsx` (entry point)

**apps/client/src/components/**
- Purpose: Reusable React functional components
- Contains: Core UI (Board, Column, TicketCard, TicketDetail), admin panels (UserManager, ChannelManager, etc.)
- Structure: Flat with admin/ subdirectory

**apps/client/src/contexts/**
- Purpose: React context providers for global state
- Contains: AuthContext (user/token/permissions), ToastContext (notifications), LoadingContext (loading states)

**apps/client/src/hooks/**
- Purpose: Custom React hooks
- Contains: useBoard (fetch and manage board data)

**apps/server/src/common/**
- Purpose: Cross-cutting concerns shared by all modules
- Contains: Guards (AuthGuard, PermissionGuard, AdminGuard, AgentAuthGuard), HTTP exception filter, decorators (@CurrentUser, @RequirePermission)

**apps/server/src/database/**
- Purpose: TypeORM configuration and database setup
- Location: `apps/server/src/database/database.module.ts`
- Responsibilities: Database initialization, entity registration, default data seeding, migrations
- Supported databases: SQLite (default via sql.js), MySQL, PostgreSQL

**apps/server/src/entities/**
- Purpose: Database schema definitions
- Contains: 10 entities (User, Workspace, Board, BoardColumn, Ticket, Comment, Agent, AgentChannelIdentity, Channel, ActivityLog, ApiKey)
- Pattern: TypeORM @Entity classes with relationships

**apps/server/src/modules/**
- Purpose: Feature modules following NestJS modular architecture
- Contains: 16 modules total:
  - auth: Login, setup, registration, session management
  - workspaces: Workspace CRUD
  - boards: Board CRUD, column management
  - columns: Column CRUD (position, color)
  - tickets: Ticket CRUD, move, hierarchy (children/grandchildren)
  - users: User management, profiles
  - agents: AI agent definitions and channel identities
  - channels: Integration channels (Discord, Slack, etc.)
  - api-keys: API key generation and management
  - activity: Activity log queries
  - agent-api: External API for agents to interact with system
  - mcp: Model Context Protocol server endpoints
  - admin: Admin-only operations (logs, QA)
  - qa: Quality assurance runner
  - health: Health check endpoints
  - events: Event publishing (WebSockets, etc.)
- Pattern: Each module has controller.ts, module.ts, optional service.ts

**apps/server/src/services/**
- Purpose: Shared services used across modules
- Contains:
  - `auth.service.ts`: Session management, password hashing, login
  - `activity.service.ts`: Log all entity changes to ActivityLog
  - `api-key.service.ts`: API key CRUD and validation
  - `discord.service.ts`: Discord bot integration, message sending
  - `notification.service.ts`: Send notifications to channels on events
  - `log.service.ts`: Centralized logging with categories
  - `system-comment.service.ts`: Auto-generate system comments
  - `shared-services.module.ts`: Dependency injection module for all services
- Pattern: Injectable NestJS providers, exported globally via SharedServicesModule

## Key File Locations

**Entry Points:**
- `apps/server/src/main.ts`: Server startup, app initialization, port listening
- `apps/server/src/mcp-server.ts`: MCP protocol server startup
- `apps/client/src/main.tsx`: React DOM render to #root
- `apps/client/src/App.tsx`: Root component, routing logic, auth check

**Configuration:**
- `apps/server/src/database/database.module.ts`: TypeORM config, database type selection
- `apps/client/tsconfig.json`: Frontend TypeScript settings
- `apps/server/tsconfig.json`: Backend TypeScript settings
- `turbo.json`: Monorepo build pipeline definition
- `docker-compose.yml`: Database and service orchestration

**Core Logic:**
- `apps/server/src/modules/tickets/tickets.controller.ts`: Main ticket CRUD logic including nested hierarchy
- `apps/server/src/modules/boards/boards.controller.ts`: Board and column retrieval with full hierarchy
- `apps/server/src/modules/auth/auth.controller.ts`: Authentication endpoints (login, setup, register)
- `apps/client/src/api.ts`: REST API client with all endpoints
- `apps/client/src/contexts/AuthContext.tsx`: Auth state management and session persistence

**Testing:**
- No dedicated test directory detected — testing configuration not visible

## Naming Conventions

**Files:**
- Controllers: `[feature].controller.ts` (e.g., `tickets.controller.ts`)
- Modules: `[feature].module.ts` (e.g., `tickets.module.ts`)
- Services: `[service].service.ts` (e.g., `auth.service.ts`)
- Entities: PascalCase class name (e.g., `Ticket.ts`, `BoardColumn.ts`)
- Components: PascalCase (e.g., `TicketCard.tsx`, `LoginPage.tsx`)
- Hooks: camelCase with `use` prefix (e.g., `useBoard.ts`)
- Contexts: PascalCase with "Context" suffix (e.g., `AuthContext.tsx`)

**Directories:**
- Feature modules: kebab-case (e.g., `api-keys/`, `agent-api/`, `board-columns/`)
- Component subdirectories: Organized by feature (e.g., `admin/` for admin-only components)
- Entity plural: `entities/` (not singular)

**API Routes:**
- Collection endpoints: `/api/{resource}` (e.g., `/api/users`, `/api/boards`)
- Item endpoints: `/api/{resource}/{id}` (e.g., `/api/tickets/{id}`)
- Action endpoints: `/api/{resource}/{id}/{action}` (e.g., `/tickets/{id}/move`, `/tickets/{id}/comments`)
- Nested resources: `/api/{parent}/{parentId}/{child}` (e.g., `/columns/{columnId}/tickets`)

## Where to Add New Code

**New Feature Module:**
1. Create directory: `apps/server/src/modules/{feature-name}/`
2. Add files:
   - `{feature-name}.controller.ts`: Define @Controller and @Get/@Post/@Patch/@Delete methods
   - `{feature-name}.module.ts`: NestJS @Module with imports, controllers, providers
3. Register in `apps/server/src/app.module.ts`: Add to imports array
4. Example: New "notifications" endpoint → create `apps/server/src/modules/notifications/`

**New Entity:**
1. Create: `apps/server/src/entities/NewEntity.ts`
2. Define: @Entity class with @Column, @ManyToOne, @OneToMany decorators
3. Register: Add to `entities` array in `apps/server/src/database/database.module.ts`
4. Add to TypeOrmModule.forFeature() in relevant modules

**New Service:**
1. Create: `apps/server/src/services/new-service.service.ts`
2. Implement: Injectable provider with methods
3. Register: Add to providers and exports in `apps/server/src/services/shared-services.module.ts`
4. Inject: Use @Inject(ServiceName) in controllers/services

**New React Component:**
1. Create: `apps/client/src/components/NewComponent.tsx`
2. Implement: React functional component with hooks
3. Admin-only: Place in `apps/client/src/components/admin/`
4. Use context: Import from `../contexts/` if needing auth/toast/loading

**New API Endpoint (Client):**
1. Add method to `apps/client/src/api.ts`: api.{resourceMethod}() = request<T>(...) call
2. Follow existing pattern: Organize by resource in comments, pass body as JSON

## Special Directories

**database/:**
- Purpose: Persistent data storage
- Generated: Yes (by TypeORM at runtime if using SQLite)
- Committed: No (data.db ignored in .gitignore)
- Contains: `data.db` (SQLite file — can be replaced with MySQL/PostgreSQL via DB_TYPE env var)

**dist/:**
- Purpose: Compiled TypeScript output
- Generated: Yes (by `tsc` or `nest build`)
- Committed: No (.gitignore excludes dist/)
- Location: Both `apps/client/dist/` and `apps/server/dist/`

**.planning/:**
- Purpose: GSD planning and codebase analysis documents
- Generated: Yes (by GSD CLI)
- Committed: Yes (for reference)
- Contents: ARCHITECTURE.md, STRUCTURE.md, CONVENTIONS.md, TESTING.md, CONCERNS.md, INTEGRATIONS.md, STACK.md

**node_modules/:**
- Purpose: Installed dependencies
- Generated: Yes (by npm install)
- Committed: No (.gitignore excludes)
- Location: Root, apps/client/, apps/server/ (monorepo allows nested installations)
