# Architecture

**Analysis Date:** 2026-04-08

## Pattern Overview

**Overall:** Monorepo with decoupled frontend (React/Vite) and backend (NestJS) serving a collaborative workflow/kanban board platform.

**Key Characteristics:**
- Full-stack TypeScript with shared types
- Module-driven backend (NestJS with feature modules)
- Context-based state management on frontend
- REST API with session-based authentication
- Real-time activity logging and notifications
- Multi-workspace organization with hierarchical tickets (root → child → grandchild)

## Layers

**API Layer (REST):**
- Purpose: Expose endpoints for board operations, authentication, and user management
- Location: `apps/server/src/modules/*/` (16 feature modules)
- Contains: Controllers (one per module) and request/response handling
- Depends on: Services (shared and module-specific), Guards, Filters
- Used by: Frontend via `apps/client/src/api.ts`

**Service Layer:**
- Purpose: Business logic, entity management, cross-cutting concerns
- Location: `apps/server/src/services/` (8 services) and module-level services
- Contains: Activity logging, authentication, API key management, Discord integration, notifications
- Depends on: Repositories (via TypeORM), External APIs (Discord)
- Used by: Controllers, other services, guards

**Data Access Layer (ORM):**
- Purpose: Database abstraction and entity relationships
- Location: `apps/server/src/entities/` (10 entities)
- Contains: TypeORM entities with decorators (@Entity, @Column, @ManyToOne, etc.)
- Depends on: TypeORM, Database connection
- Used by: Services, Controllers via repository injection

**Guard/Middleware Layer:**
- Purpose: Cross-cutting authentication and authorization
- Location: `apps/server/src/common/guards/` (4 guards), `common/filters/`, `common/decorators/`
- Contains: AuthGuard, PermissionGuard, AdminGuard, AgentAuthGuard, exception filters, decorators
- Depends on: User repositories, session management
- Used by: Controllers via @UseGuards decorator

**Frontend View Layer (React):**
- Purpose: UI components and user interactions
- Location: `apps/client/src/components/` (admin and board components)
- Contains: React functional components, drag-and-drop, forms
- Depends on: Context providers, hooks, API client
- Used by: Routes, other components

**Context/State Layer (Frontend):**
- Purpose: Global state and side effects
- Location: `apps/client/src/contexts/` (3 contexts: AuthContext, ToastContext, LoadingContext)
- Contains: Provider components, useContext hooks
- Depends on: API, localStorage
- Used by: App.tsx and nested components

## Data Flow

**Authentication Flow:**

1. User enters credentials on `apps/client/src/components/LoginPage.tsx`
2. Calls `api.login()` → POST `/api/auth/login`
3. `apps/server/src/modules/auth/auth.controller.ts` validates credentials via `AuthService`
4. AuthService creates session token, returns user with resolved permissions
5. Frontend stores token in localStorage, AuthContext updates global state
6. Subsequent requests attach token via `Authorization: Bearer` header
7. AuthGuard middleware on controller verifies token, injects user via `@CurrentUser()` decorator

**Ticket Creation Flow:**

1. User submits form in `TicketCard.tsx` or detail view
2. Calls `api.createTicket()` → POST `/columns/{columnId}/tickets`
3. `apps/server/src/modules/tickets/tickets.controller.ts` receives request
4. Resolves creator from session (authenticated user) or explicit body (agent/MCP)
5. Saves ticket to database with position calculated from max position in column
6. ActivityService logs "created" activity
7. Response includes parsed labels and channel_ids (JSON → array)
8. Frontend optimistically updates board state

**Workspace/Board Hierarchy:**

1. Workspace (root)
   ├── Board (belongs to workspace, has columns)
   │   └── BoardColumn (position-ordered, has default 5 columns)
   │       └── Ticket (position-ordered root tickets)
   │           └── Children (depth: 1, position-ordered subtasks)
   │               └── Grandchildren (depth: 2, position-ordered sub-subtasks)

**State Management:**

- Backend: No global state per-se; session stored in-memory, entity state in database
- Frontend: AuthContext (user/token), LoadingContext (loading states), ToastContext (notifications), local component state
- Persistence: All data to database, auth token to localStorage, no Redux/Zustand

## Key Abstractions

**Entity Model:**
- Purpose: Represent domain objects (User, Board, Ticket, etc.)
- Examples: `apps/server/src/entities/Ticket.ts`, `apps/server/src/entities/User.ts`
- Pattern: TypeORM @Entity classes with relationships (@OneToMany, @ManyToOne)

**Module System:**
- Purpose: Feature organization and dependency injection
- Examples: `BoardsModule`, `TicketsModule`, `AuthModule` in `apps/server/src/modules/`
- Pattern: NestJS @Module with imports, controllers, providers, exports

**Guard Pattern:**
- Purpose: Enforce authentication and authorization
- Examples: `AuthGuard` (checks token), `PermissionGuard` (checks permissions), `AdminGuard` (admin-only)
- Pattern: Implements NestJS CanActivate, returns boolean

**Service Pattern:**
- Purpose: Reusable business logic
- Examples: `AuthService` (sessions), `ActivityService` (logging), `DiscordService` (Discord API)
- Pattern: Injectable NestJS providers, injected into controllers/services

## Entry Points

**Server Main:**
- Location: `apps/server/src/main.ts`
- Triggers: `npm run dev` or `npm start`
- Responsibilities: Create NestFactory app, enable CORS, apply global filters, listen on port 7701

**MCP Server:**
- Location: `apps/server/src/mcp-server.ts`
- Triggers: `npm run mcp` (stdio transport) or `npm run mcp:http` (HTTP transport)
- Responsibilities: Expose NestJS services as MCP tools for Claude/agents

**Client Main:**
- Location: `apps/client/src/main.tsx`
- Triggers: `npm run dev` or build via `npm run build`
- Responsibilities: Render React app into DOM, wrap with BrowserRouter

**App Routing:**
- Location: `apps/client/src/App.tsx`
- Routes: "/" (Board), "/admin/*" (AdminPage), auth guards before routes
- Responsibilities: Check auth state, render login or main interface

## Error Handling

**Strategy:** Centralized exception filter with logging

**Patterns:**
- Backend: AllExceptionsFilter (in `apps/server/src/common/filters/http-exception.filter.ts`) catches all exceptions, logs via LogService, returns HTTP 500
- Frontend: Try-catch in API layer (apps/client/src/api.ts), 401 triggers auth-expired event, errors thrown as Error objects
- Controllers: Explicit res.status(4xx/5xx).json({ error: '...' }) for known cases

## Cross-Cutting Concerns

**Logging:** LogService (`apps/server/src/services/log.service.ts`) provides `logService.info()`, `warn()`, `error()` with category prefix

**Validation:** Zod schema validation in request handlers (example: checking required fields in controllers), no centralized validation pipe

**Authentication:** AuthGuard + session token (Bearer scheme), sessions stored in memory via AuthService

**Authorization:** PermissionGuard + role/custom permissions JSON stored on User entity, resolvePermissions() converts role + custom perms to array

**Activity Tracking:** ActivityService logs all create/update/delete operations to ActivityLog entity with entity_type, action, field_changed, old/new values

**Notifications:** NotificationService (Discord integration) sends messages to configured channels when activities occur (e.g., comment added)
