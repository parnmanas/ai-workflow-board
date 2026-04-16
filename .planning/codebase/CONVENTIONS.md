# Coding Conventions

**Analysis Date:** 2026-04-08

## Naming Patterns

**Files:**
- Entity files: PascalCase (e.g., `Board.ts`, `User.ts`) - located in `apps/server/src/entities/`
- Controller files: kebab-case with `.controller.ts` suffix (e.g., `boards.controller.ts`) - located in `apps/server/src/modules/{feature}/`
- Service files: kebab-case with `.service.ts` suffix (e.g., `auth.service.ts`) - located in `apps/server/src/services/`
- Module files: kebab-case with `.module.ts` suffix (e.g., `boards.module.ts`)
- React components: PascalCase (e.g., `Board.tsx`, `TicketCard.tsx`) - located in `apps/client/src/components/`
- Hooks: camelCase with `use` prefix (e.g., `useBoard.ts`) - located in `apps/client/src/hooks/`
- Context files: PascalCase with `Context.tsx` suffix (e.g., `AuthContext.tsx`) - located in `apps/client/src/contexts/`
- Guards: kebab-case with `.guard.ts` suffix (e.g., `auth.guard.ts`) - located in `apps/server/src/common/guards/`
- Decorators: kebab-case with `.decorator.ts` suffix (e.g., `current-user.decorator.ts`) - located in `apps/server/src/common/decorators/`

**Functions:**
- Async functions: camelCase (e.g., `async login(email, password)`, `async refresh()`)
- NestJS handlers: camelCase with method name (e.g., `@Get() list(...)`, `@Post() create(...)`)
- React hooks: camelCase starting with `use` (e.g., `useBoard`, `useAuth`)
- Private methods: camelCase prefixed with underscore (e.g., `private _resolveAgentId(...)`)
- Helper functions: camelCase (e.g., `parseTicket()`, `parseComments()`)

**Variables:**
- Constants: UPPER_SNAKE_CASE (e.g., `MAX_IMAGE_SIZE`, `SESSION_TTL_MS`, `SALT_ROUNDS`)
- Local variables: camelCase (e.g., `boardId`, `currentUser`, `showToast`)
- Database/API fields: snake_case (e.g., `workspace_id`, `created_at`, `channel_ids`)
- TypeScript/React state: camelCase (e.g., `isAuthenticated`, `currentWorkspaceId`, `selectedChannelIds`)

**Types:**
- Interfaces: PascalCase, often plural for collections (e.g., `User`, `Board`, `TicketDetailProps`)
- Types: PascalCase (e.g., `CurrentUserData`)
- Enum values: UPPER_SNAKE_CASE
- Generic type parameters: Single uppercase letter (e.g., `<T>`, `<R>`)

## Code Style

**Formatting:**
- Tool: None configured (no .prettierrc or similar detected)
- **Line length:** No hard limit enforced, but observe natural breaks
- **Indentation:** 2 spaces (observed in all files)
- **Semicolons:** Required at end of statements
- **Quotes:** Single quotes in TypeScript, template literals for interpolation

**Linting:**
- Tool: None configured (no .eslintrc detected)
- **TypeScript configuration:**
  - Server: `strict: false` with selective strictness (strictNullChecks: true, noImplicitAny: false)
  - Client: `strict: true` with full type checking enabled
  - Target: ES2022
  - Decorators: experimentalDecorators enabled (NestJS requirement)

## Import Organization

**Order:**
1. Node.js built-in modules (e.g., `import 'dotenv/config'`, `import { randomBytes } from 'crypto'`)
2. Third-party libraries (e.g., `import { NestFactory } from '@nestjs/core'`, `import React from 'react'`)
3. Relative imports from project (e.g., `import { Board } from '../../entities/Board'`)
4. Wildcard/barrel imports (e.g., `export { Workspace } from './Workspace'`)

**Path Aliases:**
- No explicit path aliases configured (no baseUrl/paths in tsconfig)
- Relative imports use `../` navigation (e.g., `../../entities/Board`)

## Error Handling

**Patterns:**
- **Server (NestJS):**
  - HTTP exceptions thrown as `HttpException` or `UnauthorizedException`, `ForbiddenException` from `@nestjs/common`
  - Global exception filter at `apps/server/src/common/filters/http-exception.filter.ts` catches all exceptions
  - Response format: `{ error: "message" }` for errors, `{ success: true }` for successful operations
  - Status codes: 400 for validation, 401 for authentication, 403 for authorization, 404 for not found, 500 for server errors
  - Example from `boards.controller.ts`:
    ```typescript
    if (!name) return res.status(400).json({ error: 'name is required' });
    if (!board) return res.status(404).json({ error: 'Board not found' });
    ```

- **Client (React):**
  - Try-catch blocks with error message extraction: `catch (err: any) { showToast(err.message || 'Operation failed', 'error'); }`
  - API errors converted to user-facing toast messages
  - Session errors trigger `auth-expired` custom event for auth state reset
  - Example from `api.ts`:
    ```typescript
    if (!res.ok) {
      if (res.status === 401) {
        localStorage.removeItem('auth_token');
        window.dispatchEvent(new Event('auth-expired'));
      }
      throw new Error(err.error || 'Request failed');
    }
    ```

## Logging

**Framework:** Custom `LogService` at `apps/server/src/services/log.service.ts`

**Patterns:**
- Categorized logging: `logService.info('System', 'Message', { meta })`, `logService.error('Category', 'Message')`
- Log levels: `info`, `warn`, `error`, `debug`
- Categories: 'MCP', 'Discord', 'Notification', 'DB', 'Auth', 'System', etc.
- Logs stored in memory (max 2000 entries) with dual output to console
- In-memory storage for admin UI access via `/admin/logs` endpoint
- Example from `main.ts`:
  ```typescript
  logService.info('System', `AI Workflow Board server running on http://localhost:${PORT}`);
  ```

## Comments

**When to Comment:**
- Document non-obvious business logic (e.g., permission resolution, session management)
- Explain guard/decorator behavior and expectations
- Mark important constants with their purpose
- Do not comment obvious code (e.g., variable assignments, straightforward loops)

**JSDoc/TSDoc:**
- Minimal use observed
- Type interfaces and decorators may include JSDoc for clarity
- Method signatures rely on TypeScript types for documentation

## Function Design

**Size:** 
- Controllers handle request validation and routing, typically 20-40 lines
- Services contain business logic, vary in size (20-100+ lines)
- Helper functions stay focused on single transformation (e.g., `parseTicket()`, `parseComments()`)

**Parameters:**
- Request objects use type `any` without strict typing in many cases
- Body parameters use `@Body() body: any` pattern
- Optional query parameters extracted via `@Query()`
- Dependent parameters extracted via `@Param()`
- Use object destructuring for multiple parameters

**Return Values:**
- Controllers return Express `Response` objects with explicit status codes and JSON
- Services return typed data (User, Board, Ticket, etc.) or null on failure
- Async functions return Promises with generic types (e.g., `Promise<Board>`)
- Example pattern: `async function loadTicketFull(ticketRepo: Repository<Ticket>, id: string): Promise<Ticket | null>`

## Module Design

**Exports:**
- Barrel exports in `index.ts` files (e.g., `apps/server/src/entities/index.ts`)
- NestJS modules use `@Module({ imports: [...], controllers: [...], providers: [...] })`
- Services provided to modules via `providers` array for dependency injection
- Example from `boards.module.ts`:
  ```typescript
  @Module({
    imports: [TypeOrmModule.forFeature([Board, BoardColumn, Ticket])],
    controllers: [BoardsController],
    providers: [AuthGuard],
  })
  export class BoardsModule {}
  ```

**Barrel Files:**
- `apps/server/src/entities/index.ts` exports all entity types
- Each module has its own file structure without explicit barrel files (imports done directly)

## Entity Naming (Database)

**Column naming:** snake_case for database columns (e.g., `workspace_id`, `created_at`, `updated_at`)

**Decorators used:**
- `@Entity('table_name')` for table mapping
- `@PrimaryGeneratedColumn('uuid')` for ID generation
- `@Column()` with type and options for fields
- `@CreateDateColumn()` and `@UpdateDateColumn()` for timestamps
- `@ManyToOne()`, `@OneToMany()` for relationships
- `@JoinColumn()` for foreign key specification

---

*Convention analysis: 2026-04-08*
