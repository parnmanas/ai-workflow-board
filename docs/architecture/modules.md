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
├── DatabaseModule              ← TypeORM DataSource (forRoot + every entity via forFeature)
├── SharedServicesModule        ← @Global() cross-cutting services
├── ServeStaticModule           ← client SPA, cache-control headers
├── AuthModule                  /api/auth/*
├── AccountsModule              /api/accounts/*
├── ProjectsModule              /api/projects/*, /api/accounts/:accountId/projects   (@Global — ProjectsService)
├── TicketsModule               /api/tickets/*, /api/accounts/:accountId/tickets
├── UsersModule                 /api/users/*
├── AgentsModule                TicketService + TicketDispatchService; /api/subagent-monitor/*, fs-browser, child-runs
├── ChannelsModule              /api/channels/*
├── ApiKeysModule               /api/keys/*
├── ActivityModule              /api/activity, /api/tickets/:ticketId/activity
├── AgentApiModule              /api/agent/*   (X-Agent-Key auth)
├── QaModule                    /api/admin/qa/*  (admin flow-test runner)
├── QaScenarioModule            /api/qa/*
├── SecurityProfileModule       /api/security/*
├── HealthModule                /api/health
├── McpModule                   /mcp           (+ McpServicesModule, BuildsModule, DeploymentsModule)
├── AdminModule                 /api/admin/*, /api/claude-backend-profiles, /api/diagnostics
├── EventsModule                /api/events/stream (SSE)
├── ChatRoomsModule             /api/chat-rooms/*
├── AgentSessionsModule         /api/agent-sessions/* + /api/agent/sessions/*
├── TerminalsModule             /api/terminals/* + /api/agent/terminals/*
├── CliCatalogModule            /api/cli-catalog
├── VoiceModule                 /api/voice/*
├── ResourcesModule             /api/resources/*
├── ActionsModule               /api/actions/*
├── CredentialsModule           /api/credentials/*, /api/agent-manager/cli-login/*
├── AgentLogsModule             /api/agent/error-logs, /api/admin/agent-logs
├── MentionsModule              /api/mentions/*, /api/accounts/:accountId/mentions/*
├── AgentManagerModule          /api/agent-manager/*, /api/agent-templates, /api/runtime-specs   (+ @Global InstanceRegistryModule)
├── UserChannelsModule          /api/me/channels/*, /api/admin/users/:userId/channels
├── AutomationScheduleModule     /api/automation-schedules/*
├── WorkflowFunctionsModule     /api/functions/*
├── SkillsModule                /api/accounts/:accountId/skills/*, /api/admin/skill-registry/*
├── ArtifactRefsModule          /api/artifact-refs
├── OutreachModule              /api/outreach-channels/*
├── MarketingModule             /api/marketing/*, public /api/m/*   (docs/marketing.md)
├── BusinessModule              /api/business/*, /api/business-integrations/* (docs/business.md)
├── OrchestrationModule         /api/orchestration/*
├── OntologyModule              /api/ontology/*
└── MigrationModule             /api/admin/migration/*, /api/migration/export/*
```

Canonical work lists aggregate accessible accounts; ID-addressed operations check
the actual owner. The `/api/accounts` routes/headers remain transport aliases,
not separate work surfaces. See [ownership](../ownership.md).

There is no Boards, Columns, PromptTemplates or AccountRoles module any more —
boards, columns, prompt templates and ticket role assignments were removed (see
[`docs/tickets.md`](../tickets.md)). Ticket writes live in `TicketService`, ticket
dispatch in `TicketDispatchService`; both are provided by `AgentsModule`.

---

## Global modules

### `SharedServicesModule`

`@Global()` — imported by `AppModule`, available to every module's DI
graph without explicit `imports`.

| Entity repositories | Providers (@Injectable) | Exports (injectable from anywhere) |
|---|---|---|
| ActivityLog, AgentErrorLog, ApiKey, Channel, Comment, Ticket, User, RelationTuple, UserChannel, SystemSetting | ActivityService, AuthService, ApiKeyService, DbRetentionService, DiscordService, LogService, MemoryMetricsRegistry, MemoryWatchdogService, AgentConnectivityRegistry, SqljsFlushService, OntologySqljsFlushService, NotificationService, SystemCommentService, ReBACService, MentionService, PresenceService, Discord/Slack/Telegram user providers, NotificationProviderRegistry, UserChannelDispatcherService, InstanceQuiesceService | ActivityService, AuthService, ApiKeyService, DiscordService, LogService, MemoryMetricsRegistry, AgentConnectivityRegistry, ReBACService, MentionService, PresenceService, NotificationProviderRegistry, UserChannelDispatcherService, InstanceQuiesceService |

**Providers not exported** (intentional): `NotificationService` +
`SystemCommentService` (event-listener singletons — they subscribe to
`activityEvents` in `OnModuleInit` and run as background listeners for the
app's lifetime; nothing injects them), and the timer-driven
`DbRetentionService`, `MemoryWatchdogService`, `SqljsFlushService`,
`OntologySqljsFlushService`.

### `ProjectsModule`

`@Global()` — `ProjectsService` (projects + per-host main clone folders,
`ProjectHostFolder`) is resolved by tickets, dispatch, QA/Security/Actions,
orchestration, ontology and MCP tools, so it is global rather than imported
everywhere. Controller: `ProjectsController`. Contract: [`docs/tickets.md`](../tickets.md) → "Project".

### `InstanceRegistryModule`

`@Global()` — provides/exports `InstanceRegistryService` (the live Runtime Host
heartbeat registry). Imported once by `AgentManagerModule`; chat rooms, agents
and events reach it without an import edge.

---

## MCP module cluster

### `McpModule`

| Imports | Controllers | Notes |
|---|---|---|
| `TypeOrmModule.forFeature([ApiKey])`, `AgentsModule`, `McpServicesModule`, `ChatRoomsModule`, `ActionsModule`, `QaScenarioModule`, `BuildsModule`, `DeploymentsModule`, `SecurityProfileModule`, `AutomationScheduleModule`, `WorkflowFunctionsModule`, `ArtifactRefsModule`, `OutreachModule`, `OrchestrationModule`, `AgentManagerModule`, `OntologyModule`, `VoiceModule`, `AgentSessionsModule`, `MarketingModule`, `BusinessModule` | `McpController` | Streamable HTTP transport at `/mcp`. Builds `ToolContext` with DI-injected services and hands it to `registerAllTools(server, ctx)`. |

### `McpServicesModule`

| Providers | Exports | Notes |
|---|---|---|
| `EmbeddingService`, `GitHubConnectorService` | `EmbeddingService`, `GitHubConnectorService` | Narrow-scope module — services used only inside `modules/mcp/*`. |

`BuildsModule` (`BuildArtifactService`) and `DeploymentsModule`
(`DeploymentService`, `DeploymentController` at `/api/deployments`) are not in
`AppModule` directly; they enter through `McpModule` (and `MigrationModule`).

### `AgentsModule`

| Imports | Controllers | Providers | Exports |
|---|---|---|---|
| RuntimeHost, ApiKey, Ticket, Subagent, SubagentLogLine, AgentUsageDailyRollup, CiRedAlert, ChildRun repositories; `forwardRef(AgentManagerModule)`, `ChatRoomsModule`, `SkillsModule` | `FsBrowserController`, `SubagentMonitorController`, `ChildRunsController`, `AgentChildRunsController` | `TicketDispatchService`, `TicketService`, `TicketDuplicateService`, `TicketPrerequisitesService`, `CiWaitService`, `CiWaitResumeService`, `CiHealthMonitorService`, `AgentConnectionService`, `AgentStatusService`, `AgentUsageService`, `AgentAutostartService`, `FsBrowserService`, `SubagentMonitorService`, `ChildRunService`, guards | everything above except `AgentAutostartService` and the guards |

`AgentsModule` is the home of the ticket mutation layer and the dispatcher
(they share one DI graph): `TicketService` is the one write path for tickets,
`TicketDispatchService` the one place that emits `agent_trigger` for a ticket.
`TicketsModule`, `AgentApiModule`, `OutreachModule`, QA/Security and `McpModule`
import `AgentsModule` for them. `ChildRunService` persists bounded Hermes
collaboration telemetry — ChildRuns are children of a durable run and are
deliberately not Agent identities. (The Agent-row CRUD controller was removed
with the Agent table, P4c-4.)

---

## Feature modules (alphabetical)

### `AccountsModule`
- Imports: `TypeOrmModule.forFeature([Account, Ticket, User])`
- Controllers: `AccountsController`
- Providers: `AuthGuard`
- Account settings hold ownership/membership and execution policy: `language`,
  `max_concurrent_tickets_per_agent`, `auto_archive_days`, `dispatch_paused_at`,
  `harness_config`. Hosts the `/api/accounts/:id/mention-candidates`
  endpoint that powers the client-side `@`-mention autocomplete composer.

### `ActionsModule`
- Imports: Action, ActionRun, ActionApproval, ChatRoom(+Participant/Message), TicketAttachment, RuntimeHost, Account, User, Ticket, Comment, ActivityLog repositories; `ChatRoomsModule`, `SharedServicesModule`, `AgentsModule`
- Controllers: `ActionsController`
- Providers: `ActionsService`, `ActionRunReaperService`, `OnTicketDoneActionService` (fires on a ticket entering `done` — [`docs/on-ticket-done-action-hook.md`](../on-ticket-done-action-hook.md))
- Exports: `ActionsService`

### `ActivityModule`
- Controllers: `ActivityController`
- Providers: `AuthGuard`, `PermissionGuard`
- No TypeOrm entity imports — reaches `ActivityLog` via the global
  `SharedServicesModule` export chain.

### `AdminModule`
- Imports: `TypeOrmModule.forFeature([User, Account, SystemSetting, ClaudeBackendProfile])`, `forwardRef(AgentsModule)` (workflow health reads `AgentUsageService`)
- Controllers: `DiagnosticsController`, `PublicDiagnosticsController`, `LogsController`, `PendingUsersController`, `SettingsController`, `WorkflowHealthController`, `ClaudeBackendProfilesController`, `ClaudeBackendProfileCatalogController`
- Providers: `AuthGuard`, `AdminGuard`, `PermissionGuard`

### `AgentApiModule`
- Imports: `TypeOrmModule.forFeature([Ticket, Comment, ChatRoom, ChatRoomParticipant, ChatRoomMessage, User, UserMention, TicketAttachment, ActivityLog])`, `ChatRoomsModule`, `AgentsModule` (`TicketService` for the chat "ordinary work" fallback tickets)
- Controllers: `AgentApiController` (`/api/agent/*`, `X-Agent-Key`)
- Providers: `AgentAuthGuard`

### `AgentLogsModule`
- Imports: `TypeOrmModule.forFeature([AgentErrorLog])`
- Controllers: `AgentLogsUploadController`, `AgentLogsAdminController`
- Providers: `AgentLogsService`, `AgentAuthGuard`, `AuthGuard`, `AdminGuard`

### `AgentManagerModule`
- Imports: `forwardRef(AgentsModule)`, `InstanceRegistryModule`, `SkillsModule`, `TypeOrmModule.forFeature([AgentTemplate, RuntimeHost, AgentSessionCliSetting, ApiKey, Credential, Ticket, Account])`
- Controllers: `AgentTemplatesController`, `AgentManagerController`, `HostModelsController`, `RuntimeSpecController`
- Providers: `PairingService`, `CommandLedgerService`, `SudoTicketService`, `PrivilegedCommandService`, `AgentManagerCommandService`, `HostModelsService`, `ManagerDriftMonitorService`, guards
- Exports: `PairingService`, `AgentManagerCommandService`, `PrivilegedCommandService`, `CommandLedgerService`, `HostModelsService`
- Architectural name: **Runtime Host**. The module and route names remain
  compatibility aliases. Serves the project git credential to managers
  (`GET /api/agent-manager/projects/:projectId/git-credential`).

### `AgentSessionsModule`
- Imports: `TypeOrmModule.forFeature([RuntimeHost, AgentSessionCliSetting, Credential, ClaudeBackendProfile])`, `forwardRef(AgentManagerModule)` (shares the `HostModelsService` singleton)
- Controllers: `AgentSessionsController` (`/api/agent-sessions/hosts/*`, user), `AgentSessionsAgentController` (`/api/agent/sessions/*`, `X-Agent-Key`)
- Providers: `AgentSessionsService`, guards
- Exports: `AgentSessionsService`
- Agent Session (CLI 직접 세션) — reverse RPC + 라이브 SSE 중계, ChatRoomsModule과 독립. Native transcript는 CLI에 있고, `AgentSessionExecution`은 소유 account·credential·config·backend만 영속한다(전역 DatabaseModule의 repository로 접근). `docs/agent-sessions.md`.

### `ApiKeysModule`
- Controllers: `ApiKeysController` (`/api/keys`)
- Providers: `AuthGuard`, `PermissionGuard`
- `ApiKeyService` comes from `SharedServicesModule`.

### `ArtifactRefsModule`
- Imports: `TypeOrmModule.forFeature([Ticket, Action, WorkflowFunction, Account, AutomationSchedule])`
- Controllers: `ArtifactRefsController`; Providers/Exports: `ArtifactRefsService`
- Resolves `#[type:id|name]` references — [`docs/entity-references.md`](../entity-references.md).

### `AuthModule`
- Imports: `TypeOrmModule.forFeature([User, Account, SystemSetting])`
- Controllers: `AuthController`; Providers: `GoogleOAuthService`
- `AuthService` / `ApiKeyService` / `ReBACService` come from `SharedServicesModule`.

### `ChannelsModule`
- Imports: `TypeOrmModule.forFeature([Channel])`
- Controllers: `ChannelsController`
- Providers: `AuthGuard`, `PermissionGuard`

### `ChatRoomsModule`
- Imports: `TypeOrmModule.forFeature([ChatRoom, ChatRoomParticipant, ChatRoomMessage, User, Ticket, UserMention, TicketAttachment, Account, OrchestrationMission])`, `SharedServicesModule`, `ArtifactRefsModule`
- Controllers: `ChatRoomsController`
- Providers / Exports: `RoomCrudService`, `RoomMembershipService`, `RoomMessagingService`

### `CliCatalogModule`
- Controllers: `CliCatalogController` — serves the server CLI catalogue (`common/cli-catalog.ts`).

### `CredentialsModule`
- Imports: `TypeOrmModule.forFeature([Credential, CliLoginSession])`, `AgentManagerModule`
- Controllers: `CredentialsController`, `CliLoginAgentController`
- Providers: `CliLoginSessionService`, `CliLoginSessionReaperService`, guards

### `EventsModule`
- Imports: `TypeOrmModule.forFeature([Ticket, Account, RuntimeHost, ApiKey])`, `AgentManagerModule`
- Controllers: `EventsController`
- `EventsController` owns the single SSE endpoint `/api/events/stream`
  and the table-driven event registry (`event-registry.ts`). Keepalive
  ping fires every 15s to survive reverse-proxy idle timeout. The ticket-change
  event keeps its historical name `board_update`.

### `HealthModule`
- Controllers: `HealthController`

### `MentionsModule`
- Imports: `TypeOrmModule.forFeature([UserMention])`
- Controllers: `MentionsController`
- Providers: `MentionsService`, `AuthGuard`
- `MentionService` (the parser) is separate — lives in
  `SharedServicesModule` exports because both ticket comments and
  `ChatRoomsModule` need it at dispatch time. `MentionsService` is
  the CRUD service for the `user_mentions` inbox.

### `MigrationModule`
- Imports: `TypeOrmModule.forFeature([MigrationRun])`, `DeploymentsModule`
- Controllers: `MigrationExportController`, `MigrationImportController`
- Providers: `MigrationRunService`, `MigrationExportGuard`, guards
- Live instance import. Entity coverage is pinned by `migration-entity-registry.ts`.

### `OntologyModule`
- Imports: `TypeOrmModule.forFeature([Credential])` (graph tables live on their own DataSource)
- Controllers: `OntologyController`
- Providers / Exports: extraction, resolver, query, lifecycle, incremental-scheduler and stale-sweep services
- Graphs are keyed by the repository's project id — [`docs/ontology-graph/DESIGN.md`](../ontology-graph/DESIGN.md).
- Build lifecycle (`OntologyLifecycleService`). `status='building'` is both the in-progress marker and the lock against a second build.
  - **Claim.** The first reference and Refresh each claim the row with a fresh `build_id` and a 2-minute lease (`build_lease_until_ms`). The claim commits before the build runs.
    - The lease is epoch milliseconds, not a `Date` column. Postgres `timestamp without time zone` would store each writer's local wall clock, so servers in different time zones, or a DST fall-back, would misread each other's leases.
  - **Heartbeat (Postgres).** The build renews its lease every 30 s so other servers can see it is alive. A failed renewal is retried after 5 s.
    - It also renews once right before the replacement transaction; that renewal is also the "do I still own it" check.
    - Every lease time is taken inside a short transaction, when the write actually runs. A renewal that waited in the sql.js queue or the connection pool must not write an already-expired lease.
    - sql.js skips the periodic renewals. The DB lives in one process, and renewals would only dirty `ontology.db` for a full export on every flush.
  - **This server's own builds** are never released or reclaimed by this server, whatever their lease says (`liveBuilds`). A stalled queue, event loop or pool therefore cannot make a server throw away its own build.
  - **Maximum build age.** A build gets 2 h (monotonic clock) to reach its replacement transaction.
    - Past that it is no longer protected: its heartbeat stops, and the first read after its lease lapses releases it.
    - If it reaches the replacement anyway, it fails with "ran past its maximum duration" instead of replacing.
    - A replacement that has started stays protected, and keeps renewing, until it ends.
    - On Postgres the replacement transaction sets `lock_timeout` (10 min). If another session holds the graph's rows (a frozen server's old replacement, an idle psql transaction), the build fails instead of staying `building`.
  - **Fencing.** The build finishes (`ready`, or `error` on failure) only while the row still carries its `build_id`. A build that lost its claim discards its result; the replacement transaction checks at its end and rolls back.
  - **Abandoned builds.** If the server running a build restarts or crashes, its lease expires. The next read of the graph (REST status/graph or any MCP `graph_` tool) turns it into `error`, keeping the last ready snapshot and its commit. Refresh also reclaims it directly.
  - Postgres may be shared by several servers, so boot cannot tell a dead build from a live one; the lease decides. Upgrade all servers sharing a database together: an older server claims without a lease, and a newer one releases that build on first read. sql.js lives in one process, so it also releases every `building` row at boot.
  - **Per-file limit.** Extraction gives each file 30 s (`AWB_ONTOLOGY_EXTRACT_FILE_TIMEOUT_MS`, positive milliseconds). A fresh worker's first file gets 10 s more for start-up. A worker past its limit is terminated and the file counts in `files_failed_extraction`.

### `OrchestrationModule`
- Imports: Orchestration{Team,TeamMember,Mission,Step,Event}, ChatRoom(+Participant/Message), RuntimeHost, ApiKey, Action, ActionRun, Account, Credential repositories; `ChatRoomsModule`, `AgentManagerModule`, `ActionsModule`, `SharedServicesModule`
- Controllers: `OrchestrationController`
- Providers: `OrchestrationTeamService`, `OrchestrationHostsService`, `OrchestrationMissionService`, `OrchestrationConfirmNotifyService`, `OrchestrationRunnerService`, `OrchestrationReaperService`
- Exports: `OrchestrationTeamService`, `OrchestrationMissionService`, `OrchestrationRunnerService`
- The mission project (main clone folder per member host) comes from the global `ProjectsService` — [`docs/orchestration.md`](../orchestration.md).

### `OutreachModule`
- Imports: OutreachChannel, OutreachInboundItem, OutreachOutboundPost, Credential, Ticket, ChatRoom, ChatRoomParticipant repositories; `AgentsModule` (`TicketService` for report tickets), `ChatRoomsModule`
- Controllers: `OutreachController`
- Providers: ingest/polling/channel services, `ClassificationBridgeService`, `AgentDispatchClassifier`, publisher, resolve notifier, release consistency
- Exports: `ClassificationBridgeService`

### `BusinessModule`
- Imports: `SharedServicesModule`, `AgentsModule` (the shared `TicketService`); the database module registers `BusinessCompany`, `BusinessTask`, `BusinessConnection`, `BusinessEvent`, `BusinessFormation`, `BusinessTrademark`, `BusinessTrademarkMail`, `BusinessTrademarkIntegration`, `BusinessTrademarkRecord`, and `BusinessTrademarkAction`.
- Controllers: `BusinessController`, `BusinessTrademarkController`, `BusinessTrademarkIntegrationsController` (`/api/business/*`); authenticated `business.manage` access plus Account ownership. `BusinessTrademarkIntegrationCallbacksController` exposes single-use browser-bound OAuth callbacks and signed webhooks at `/api/business-integrations/*`.
- Providers: `BusinessService`, `BusinessFormationService`, `BusinessTrademarkService`, `BusinessTrademarkIntegrationsService`; company workflows, atomic task-to-ticket creation, service/price comparison and preferences, credential references, read synchronization, reviewed doola formation submissions, encrypted trademark records, reviewed Resend/Gmail/Microsoft correspondence, DocuSign signature requests and downloads, automatic inbound/TSDR/Clio synchronization, OAuth token refresh and activity history.
- Exports: all four services to `McpModule`. The full MCP profile exposes 43 Business tools over the same services; standalone constructs the same services without a duplicate poller. Shared access checks enforce live Host/Account ownership, active owner `business.manage`, and full-scope DB keys for writes. Browser consent and provider-signed callbacks remain transport-specific. `business-mcp.test.mjs` guards REST/MCP coverage and executes every tool over HTTP.
- Connectors: capability descriptors and provider adapters under `modules/business/connectors`; see [`docs/business.md`](../business.md).
- Formation submissions and attorney email require an explicit review and confirmation; operations adapters read provider data. Trademark filing, personal signatures and legal decisions use the provider or counsel. Six trademark integration adapters implement Resend Receiving, Gmail, Microsoft Graph, DocuSign, Clio Manage and USPTO TSDR. Shared leases, encrypted tokens/records/reviews, background read synchronization and provider-specific webhooks are independent from confirmed external writes. MCP confirmation is the agent caller's assertion, not authenticated human approval; existing Marketing human-only approvals remain intact. See [`docs/trademarks.md`](../trademarks.md). Task-to-ticket creation requires an explicit user request and records the returned ticket in both MCP session and Agent Manager capture; other Business tools do not dispatch tickets.

### `MarketingModule`
- Imports: Marketing{Campaign,AuditEvent,Channel,BudgetAllocation,SpendRequest,LedgerEntry,Post,Link,Metric,Feedback,Contact,EmailSend,Cycle,ApprovalNotice}, Project, RuntimeHost, OutreachChannel, OutreachInboundItem, Credential, Ticket, ChatRoom(+Participant) repositories; `OutreachModule` (`OutreachChannelService`), `AgentsModule` (`TicketService` for feedback tickets), `ChatRoomsModule` (cycle dispatch), `SharedServicesModule`
- Controllers: campaigns, channels, budget, posts, analytics, feedback, contacts, inbox (all `/api/marketing`), `MarketingPublicController` (`/api/m/:code`, `/api/m/u/:token`, no auth)
- Providers: audit, campaign hooks, campaign, channel, budget, spend, post, analytics, feedback, contact, email, agent (MCP facade), cycle, inbox services, `MarketingApprovalNotifyService` (approval digests to user channels)
- Exports: the services the MCP module needs (`MarketingAgentService`, `MarketingCycleService`, …)
- Money, external sends and channel activation are human decisions over REST; agents only propose through MCP — [`docs/marketing.md`](../marketing.md).

### `QaModule`
- Controllers: `QaController` (`/api/admin/qa`)
- Providers: `AuthGuard`, `AdminGuard`
- Admin-gated flow-test runner (`test/qa-flows/*`).

### `QaScenarioModule`
- Imports: QaScenario, QaRun, QaRunBatch, QaSchedule, ChatRoom(+Participant/Message), TicketAttachment, RuntimeHost, Ticket, Comment, Resource repositories; `ChatRoomsModule`, `AgentsModule`, `SharedServicesModule`
- Controllers: `QaScenarioController` (`/api/qa`)
- Providers: `QaService`, `QaRunService`, `QaRunReaperService`, `QaRunBatchReaperService`, `QaFailureTicketService`, `QaRerunOnFixService`, `QaScheduleService`
- Exports: all of those except `QaRerunOnFixService`

### `ResourcesModule`
- Imports: `TypeOrmModule.forFeature([Resource, Credential])`
- Controllers: `ResourcesController`, `ResourceMediaController`
- Providers: `AuthGuard`, `PermissionGuard`
- Repositories are Projects, not Resources — `type='repository'` is rejected.

### `SecurityProfileModule`
- Imports: SecurityProfile, SecurityRun, SecurityRunBatch, SecuritySchedule, ChatRoom(+Participant/Message), TicketAttachment, RuntimeHost, Ticket, Comment, Resource repositories; `ChatRoomsModule`, `AgentsModule`, `SharedServicesModule`
- Controllers: `SecurityProfileController` (`/api/security`)
- Providers / Exports: `SecurityProfileService`, `SecurityRunService`, `SecurityRunReaperService`, `SecurityFailureTicketService`, `SecurityScheduleService`

### `SkillsModule`
- Imports: `Skill`, `SkillVersion`, `RuntimeSkillAssignment`, `RunSkillSnapshot`, `SkillProposal`, `SkillTap` repositories
- Controllers: `SkillsController`, `SkillRegistryController`
- Providers: `SkillsService`, `RunSkillSnapshotService`, `SkillSyncService`, `SkillTapService`, `BuiltinSkillPackService`
- Exports: `SkillsService`, `RunSkillSnapshotService`, `SkillTapService`, `BuiltinSkillPackService`
- Owns immutable version publication, exact-version assignments to a runtime
  identity (`runtime_key`), quarantine, deterministic run snapshots, and
  human-reviewed proposals. Runtime MCP clients can propose changes but cannot
  approve, publish, or assign a skill.

### `TerminalsModule`
- Imports: `TypeOrmModule.forFeature([RuntimeHost])`
- Controllers: `TerminalsController` (user), `TerminalsAgentController` (`X-Agent-Key`)
- Providers / Exports: `TerminalsService` — `docs/terminals.md`.

### `TicketsModule`
- Imports: `TypeOrmModule.forFeature([Ticket, Comment, UserMention, TicketReadState, TicketAttachment])`, `AgentsModule` (`TicketService` / `TicketDispatchService` / `TicketDuplicateService`), `ArtifactRefsModule`
- Controllers: `TicketsController` (`/api/accounts/:accountId/tickets`, `/api/tickets/*` incl. `/move`, `/trigger`, children, comments, attachments, prerequisites)
- Providers: `AuthGuard`, `TicketArchiverService` (auto-archive by `account.auto_archive_days`)

### `UserChannelsModule`
- Imports: `TypeOrmModule.forFeature([UserChannel])`
- Controllers: `UserChannelsController`; Providers: `UserChannelsService`, guards

### `UsersModule`
- Imports: `TypeOrmModule.forFeature([User])`
- Controllers: `UsersController`
- Providers: `AuthGuard`, `PermissionGuard`

### `VoiceModule`
- Imports: `AgentSessionsModule`
- Controllers: `VoiceController`, `VoiceLabController`, `VoiceOperatorsController`
- Providers: `VoiceService`, `VoiceAnnouncerService`, `OperatorReportService`, `OperatorDecisionService`, `VoicePresenceService`
- Exports: `VoiceService`, `VoiceAnnouncerService`, `OperatorDecisionService` — `docs/voice-operator.md`.

### `WorkflowFunctionsModule`
- Imports: `TypeOrmModule.forFeature([WorkflowFunction, WorkflowFunctionRun, Ticket])`, `ActionsModule`
- Controllers: `WorkflowFunctionsController`; Providers/Exports: `WorkflowFunctionsService`

### `AutomationScheduleModule`

The class/service/controller names are retained internal names. The entity is
`AutomationSchedule`, the folder is `modules/automation-schedule`, and canonical
REST/MCP names use automation schedules. Legacy account routes are aliases.

- Imports: `TypeOrmModule.forFeature([AutomationSchedule, ChatRoom, ChatRoomParticipant, RuntimeHost, Action])`, `ChatRoomsModule`, `ActionsModule`, `SharedServicesModule`
- Controllers: `AutomationScheduleController`; Providers/Exports: `AutomationScheduleService`


---

## Design principles

- **`@Global()` only for truly cross-cutting services.** If a service is
  consumed only inside one feature's folder, it lives in that feature's
  module, not in `SharedServicesModule`. The other two `@Global()` modules
  (`ProjectsModule`, `InstanceRegistryModule`) each export exactly one
  service that half the app needs.
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
