# AWB Server — Module Composition

Map of every NestJS `@Module` in `apps/server/src`. Kept by hand because
tree-sitter AST extraction does not see decorator arguments — without this
doc, module topology is invisible to the knowledge graph / onboarding.

**How to read this doc:** each module table row shows what the module
imports (other modules + entities), what HTTP surface it exposes
(controllers), what services it adds to the DI graph (providers), and what
it makes available to importers (exports). Rows sorted by name.

When you add or remove a module, update the corresponding row here. A CI
check that diffs `@Module` decorators against this doc is a reasonable
follow-up.

---

## Root composition

```
AppModule
├── DatabaseModule          ← TypeORM DataSource (global via forRoot)
├── SharedServicesModule    ← @Global() cross-cutting services
├── ServeStaticModule       ← client SPA, cache-control headers
├── AuthModule              /api/auth/*
├── WorkspacesModule        /api/workspaces/*
├── BoardsModule            /api/boards/*
├── ColumnsModule           /api/columns/*
├── TicketsModule           /api/tickets/*
├── UsersModule             /api/users/*
├── AgentsModule            /api/agents/*
├── PromptTemplatesModule   /api/prompt-templates/*
├── ChannelsModule          /api/channels/*
├── ApiKeysModule           /api/api-keys/*
├── ActivityModule          /api/activity/*
├── AgentApiModule          /api/agent/*   (X-Agent-Key auth)
├── QaModule                /api/qa/*      (admin)
├── HealthModule            /api/health
├── McpModule               /mcp           (+ McpServicesModule)
├── AdminModule             /api/admin/*   (admin gated)
├── EventsModule            /api/events/stream (SSE)
├── ChatRoomsModule         /api/chat-rooms/*
├── ResourcesModule         /api/resources/*
├── CredentialsModule       /api/credentials/*
├── AgentLogsModule         /api/agent-logs/*
└── MentionsModule          /api/workspaces/:id/mentions/*
```

---

## Global module — `SharedServicesModule`

`@Global()` — imported by `AppModule`, available to every module's DI
graph without explicit `imports`.

| Entity repositories | Providers (@Injectable) | Exports (injectable from anywhere) |
|---|---|---|
| ActivityLog, ApiKey, Agent, AgentChannelIdentity, Channel, Comment, Ticket, User, BoardColumn, RelationTuple | ActivityService, AuthService, ApiKeyService, DiscordService, LogService, NotificationService, SystemCommentService, ReBACService, MentionService | ActivityService, AuthService, ApiKeyService, LogService, ReBACService, MentionService |

**Providers not exported** (intentional): `DiscordService` (consumed only
by `NotificationService`, a sibling provider in the same module);
`NotificationService` + `SystemCommentService` (event-listener
singletons — they subscribe to `activityEvents` in `OnModuleInit` and run
as background listeners for the app's lifetime; nothing injects them).

Membership audit (2026-04-18): consumer counts for exported services —
LogService 15, ApiKeyService 7, ActivityService 6, ReBACService 5,
AuthService 5, MentionService 2. Services with lower counts (Embedding,
GitHub, Mentions-in-doubt) are scoped to feature modules instead of
polluting the global exports list.

---

## MCP module cluster

### `McpModule`

| Imports | Controllers | Notes |
|---|---|---|
| `TypeOrmModule.forFeature([ApiKey])`, `AgentsModule`, `McpServicesModule` | `McpController` | Streamable HTTP transport at `/mcp`. Builds `ToolContext` with DI-injected services and hands it to `registerAllTools(server, ctx)`. |

### `McpServicesModule`

| Providers | Exports | Notes |
|---|---|---|
| `EmbeddingService`, `GitHubConnectorService` | `EmbeddingService`, `GitHubConnectorService` | Narrow-scope module — services used only inside `modules/mcp/*`. Previously global providers; moved out of `SharedServicesModule` to reduce blast radius. |

### `AgentsModule`

| Imports | Controllers | Providers | Exports |
|---|---|---|---|
| `TypeOrmModule.forFeature([Agent, AgentChannelIdentity, AgentTrigger, Ticket])` | `AgentsController` | `AuthGuard`, `PermissionGuard`, `AgentConnectionService`, `TriggerLoopService`, `AgentStatusService` | `AgentConnectionService`, `TriggerLoopService`, `AgentStatusService` |

Imported by `McpModule` so MCP tools can reach trigger / connection /
status state.

---

## Feature modules (alphabetical)

### `ActivityModule`
- Controllers: `ActivityController`
- Providers: `AuthGuard`, `PermissionGuard`
- No TypeOrm entity imports — reaches `ActivityLog` via the global
  `SharedServicesModule` export chain.

### `AdminModule`
- Imports: `TypeOrmModule.forFeature([User, Workspace, SystemSetting])`
- Controllers: `LogsController`, `PendingUsersController`, `SettingsController`
- Providers: `AuthGuard`, `AdminGuard`, `PermissionGuard`

### `AgentApiModule`
- Imports: `TypeOrmModule.forFeature([Board, BoardColumn, Ticket, Comment, ChatRoom, ChatRoomParticipant, ChatRoomMessage, User, Agent, UserMention])`
- Controllers: `AgentApiController`
- Providers: `AgentAuthGuard`, `ChatRoomsService`, `RoomCrudService`, `RoomMembershipService`, `RoomMessagingService`
- Re-instantiates the chat-room services here rather than importing
  `ChatRoomsModule` because agent auth uses `X-Agent-Key` (different
  guard surface) and the controllers split is intentional.

### `AgentLogsModule`
- Imports: `TypeOrmModule.forFeature([AgentErrorLog, Agent])`
- Controllers: `AgentLogsUploadController`, `AgentLogsAdminController`
- Providers: `AgentLogsService`, `AgentAuthGuard`, `AuthGuard`, `AdminGuard`

### `ApiKeysModule`
- Controllers: `ApiKeysController`
- Providers: `AuthGuard`, `PermissionGuard`
- `ApiKeyService` comes from `SharedServicesModule`.

### `AuthModule`
- Imports: `TypeOrmModule.forFeature([User, Workspace])`
- Controllers: `AuthController`
- `AuthService` / `ApiKeyService` / `ReBACService` come from `SharedServicesModule`.

### `BoardsModule`
- Imports: `TypeOrmModule.forFeature([Board, BoardColumn, Ticket])`
- Controllers: `BoardsController`
- Providers: `AuthGuard`

### `ChannelsModule`
- Imports: `TypeOrmModule.forFeature([Channel])`
- Controllers: `ChannelsController`
- Providers: `AuthGuard`, `PermissionGuard`

### `ChatRoomsModule`
- Imports: `TypeOrmModule.forFeature([ChatRoom, ChatRoomParticipant, ChatRoomMessage, User, Agent, Ticket, UserMention])`, `SharedServicesModule`
- Controllers: `ChatRoomsController`
- Providers: `ChatRoomsService`, `RoomCrudService`, `RoomMembershipService`, `RoomMessagingService`, `AuthGuard`, `PermissionGuard`
- Exports: `ChatRoomsService`, `RoomCrudService`, `RoomMembershipService`, `RoomMessagingService`

### `ColumnsModule`
- Imports: `TypeOrmModule.forFeature([BoardColumn])`
- Controllers: `ColumnsController`
- Providers: `AuthGuard`

### `CredentialsModule`
- Imports: `TypeOrmModule.forFeature([Credential])`
- Controllers: `CredentialsController`
- Providers: `AuthGuard`, `PermissionGuard`

### `EventsModule`
- Imports: `TypeOrmModule.forFeature([Ticket, BoardColumn])`
- Controllers: `EventsController`
- `EventsController` owns the single SSE endpoint `/api/events/stream`
  and the table-driven event registry (`event-registry.ts`). Keepalive
  ping fires every 15s to survive reverse-proxy idle timeout.

### `HealthModule`
- Controllers: `HealthController`

### `MentionsModule`
- Imports: `TypeOrmModule.forFeature([UserMention])`
- Controllers: `MentionsController`
- Providers: `MentionsService`, `AuthGuard`
- `MentionService` (the parser) is separate — lives in
  `SharedServicesModule` exports because both `TicketsModule` and
  `ChatRoomsModule` need it at dispatch time. `MentionsService` is
  the CRUD service for the `user_mentions` inbox.

### `PromptTemplatesModule`
- Imports: `TypeOrmModule.forFeature([PromptTemplate])`
- Controllers: `PromptTemplatesController`
- Providers: `AuthGuard`, `PermissionGuard`

### `QaModule`
- Imports: `TypeOrmModule.forFeature([Workspace, Board, BoardColumn, Ticket, Comment, User, Agent, AgentChannelIdentity, Channel, ApiKey, ActivityLog])`
- Controllers: `QaController`
- Providers: `AuthGuard`, `AdminGuard`
- Admin-gated QA test surface.

### `ResourcesModule`
- Imports: `TypeOrmModule.forFeature([Resource])`
- Controllers: `ResourcesController`
- Providers: `AuthGuard`, `PermissionGuard`

### `TicketsModule`
- Imports: `TypeOrmModule.forFeature([Ticket, BoardColumn, Comment, Agent, UserMention])`
- Controllers: `TicketsController`
- Providers: `AuthGuard`

### `UsersModule`
- Imports: `TypeOrmModule.forFeature([User])`
- Controllers: `UsersController`
- Providers: `AuthGuard`, `PermissionGuard`

### `WorkspacesModule`
- Imports: `TypeOrmModule.forFeature([Workspace, Board, BoardColumn, Ticket, User, Agent])`
- Controllers: `WorkspacesController`
- Providers: `AuthGuard`
- Hosts the `/api/workspaces/:id/mention-candidates` endpoint that
  powers the client-side `@`-mention autocomplete composer.

---

## Design principles

- **`@Global()` only for truly cross-cutting services.** If a service is
  consumed only inside one feature's folder, it lives in that feature's
  module, not in `SharedServicesModule`. Global services currently
  exported: 6 (Log, Auth, ApiKey, Activity, ReBAC, Mention).
- **Listener-only providers** (NotificationService, SystemCommentService)
  stay as non-exported providers — they subscribe to `activityEvents` in
  `OnModuleInit` and run for the app's lifetime; exporting them from
  `@Global()` would be a false signal that someone is supposed to inject
  them.
- **Guards are providers, not imports.** Each module that needs
  `AuthGuard` / `PermissionGuard` / `AgentAuthGuard` registers them in
  its own `providers` list. They are cheap to instantiate and NestJS
  reuses the singleton within a module scope — duplicating them across
  modules is intentional and avoids creating a shared "guards module"
  with circular-import risk.
- **Entities are listed explicitly in `forFeature`.** Some modules
  re-list entities that `SharedServicesModule` also registers (e.g.
  `Ticket`). Both registrations coexist — TypeORM repository resolution
  looks up the first registration it finds and reuses it. This pattern
  is intentional: the feature module's `forFeature` documents which
  tables that feature touches, independent of the global side.
- **Two MCP entry points, shared tool surface.** `McpController` serves
  MCP over HTTP inside the NestJS app. `apps/server/src/mcp-server.ts`
  serves the same tool surface over stdio without NestJS (standalone
  CLI use). Both call `createMcpServerForContext(ctx)` where `ctx` is a
  `ToolContext` — NestJS DI builds one path, `createStandaloneContext`
  builds the other.
