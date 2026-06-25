/**
 * ToolContext — the runtime context passed to each MCP tool registration
 * function. Carries the shared DataSource plus the services that tools need,
 * so every tool file can be plain module-scope code (no globals, no
 * getRepository side-imports).
 *
 * Two construction paths:
 *
 *   1. NestJS integrated (apps/server/src/modules/mcp/mcp.controller.ts):
 *      The controller builds a ToolContext out of the DI-injected services
 *      and passes it to `registerAllTools(server, ctx)`.
 *
 *   2. Standalone (apps/server/src/mcp-server.ts):
 *      The standalone entry point calls `createStandaloneContext(dataSource)`
 *      which manually instantiates thin services (no DI) on top of the
 *      DataSource.
 *
 * Historic globals (`AppDataSource`, inline `logActivity`, inline
 * `createApiKey`, etc.) are now removed — every tool goes through `ctx`.
 */

import type { DataSource } from 'typeorm';
import { ActivityLog } from '../../../entities/ActivityLog';
import { ApiKey } from '../../../entities/ApiKey';
import { ChatRoom } from '../../../entities/ChatRoom';
import { ChatRoomParticipant } from '../../../entities/ChatRoomParticipant';
import { ChatRoomMessage } from '../../../entities/ChatRoomMessage';
import { User } from '../../../entities/User';
import { Agent } from '../../../entities/Agent';
import { Ticket } from '../../../entities/Ticket';
import { UserMention } from '../../../entities/UserMention';
import { TicketAttachment } from '../../../entities/TicketAttachment';
import { ActivityService } from '../../../services/activity.service';
import { ApiKeyService } from '../../../services/api-key.service';
import { LogService } from '../../../services/log.service';
import { EmbeddingService } from '../../../services/embedding.service';
import { GitHubConnectorService } from '../../../services/github-connector.service';
import { MentionService } from '../../../services/mention.service';
import type { AgentStatusService } from '../../agents/agent-status.service';
import type { AllocationService } from '../../agents/allocation.service';
import type { TriggerLoopService } from '../../agents/trigger-loop.service';
import type { RoomCrudService } from '../../chat-rooms/room-crud.service';
import { RoomMembershipService } from '../../chat-rooms/room-membership.service';
import { RoomMessagingService } from '../../chat-rooms/room-messaging.service';
import type { TicketRoleAssignmentService } from '../../workspace-roles/ticket-role-assignment.service';
import type { ActionsService } from '../../actions/actions.service';
import type { QaService } from '../../qa/qa.service';
import type { QaRunService } from '../../qa/qa-run.service';
import type { QaScheduleService } from '../../qa/qa-schedule.service';
import type { SecurityProfileService } from '../../security/security-profile.service';
import type { SecurityRunService } from '../../security/security-run.service';
import type { SecurityScheduleService } from '../../security/security-schedule.service';
import { TicketPrerequisitesService } from '../../tickets/ticket-prerequisites.service';
import { BenchmarkService } from '../../benchmarks/benchmark.service';

/**
 * Minimal surface that MCP tools need from the logging subsystem.
 * NestJS LogService satisfies this; the standalone console shim below
 * satisfies it too.
 */
export interface McpLogger {
  info(category: string, message: string, meta?: Record<string, any>): any;
  warn(category: string, message: string, meta?: Record<string, any>): any;
  error(category: string, message: string, meta?: Record<string, any>): any;
}

/**
 * Context passed to every tool registration function.
 *
 * Kept deliberately small: `dataSource` for repositories, the three domain
 * services (activity/apiKey/logger), and that's it. More services can be
 * added here as tools require them.
 */
export interface ToolContext {
  dataSource: DataSource;
  activityService: ActivityService;
  apiKeyService: ApiKeyService;
  embeddingService: EmbeddingService;
  githubService: GitHubConnectorService;
  mentionService: MentionService;
  logger: McpLogger;
  // Optional — present in NestJS integrated mode; undefined when invoked from
  // the standalone mcp-server entry point (no DI). Tools that depend on it
  // must degrade gracefully.
  agentStatusService?: AgentStatusService;
  allocationService?: AllocationService;
  roomCrudService?: RoomCrudService;
  roomMembershipService?: RoomMembershipService;
  // v0.33: shared message-send entry point. Required for the MCP
  // send_chat_room_message tool so it goes through the same dispatch path
  // (mention parsing, DM auto-route, chat_room_message emit with
  // agent_chain_depth) as the REST endpoints. Standalone context omits it —
  // the tool degrades to an explicit error in that mode.
  roomMessagingService?: RoomMessagingService;
  // v0.34: ticket role-assignment helper. Required for ticket CRUD MCP tools
  // to keep the assignment table in sync with legacy column writes.
  // Standalone context omits it; tools degrade by skipping the sync.
  ticketRoleAssignmentService?: TicketRoleAssignmentService;
  // Actions feature: required by `run_action` MCP tool which needs to dispatch
  // a Run (create room, add participants, send first message). The CRUD tools
  // operate directly on repositories and don't need this.
  actionsService?: ActionsService;
  // Scenario-based QA feature. Required by the qa-tools MCP tools.
  // `qaService` handles scenario CRUD (also doable over repos, but the service
  // centralizes validation); `qaRunService` is required for start_qa_run +
  // record/complete since those touch the chat-room dispatch + run lifecycle.
  // Standalone context omits both — the tools degrade to an explicit error.
  qaService?: QaService;
  qaRunService?: QaRunService;
  // QA scheduler (ticket b6bb7efd) — automatic batch trigger layer. Required by
  // the qa-schedule MCP tools (CRUD + run-now). Standalone context omits it; the
  // tools degrade to an explicit error (no background tick in standalone mode).
  qaScheduleService?: QaScheduleService;
  // Security-inspection feature (SecurityProfile/SecurityRun). Required by the
  // security-tools MCP tools. `securityProfileService` handles profile CRUD;
  // `securityRunService` is required for start_security_run + record/complete
  // since those touch the chat-room dispatch + run lifecycle. Standalone context
  // omits both — the tools degrade to an explicit error.
  securityProfileService?: SecurityProfileService;
  securityRunService?: SecurityRunService;
  // Security scheduler — automatic batch trigger layer. Required by the
  // security-schedule MCP tools (CRUD + run-now). Standalone context omits it;
  // the tools degrade to an explicit error (no background tick in standalone mode).
  securityScheduleService?: SecurityScheduleService;
  // Ticket a57517be: `unpend_ticket` tool needs to wake the ticket's current
  // column's role-holders right after clearing `pending_user_action` (the
  // `field_changed='pending_user_action'` activity row by itself does not
  // dispatch through the column-routing path). Standalone context omits it;
  // unpend in that mode degrades to a no-op for the dispatch with a warn log,
  // since standalone has no live agent session to push to anyway.
  triggerLoopService?: TriggerLoopService;
  // Ticket 48d14fff: prerequisite ("blocked-by ticket") mutations. Present in
  // both modes — the standalone builder constructs a thin instance directly
  // on the DataSource since the service is stateless over dataSource +
  // activityService. Used by ticket-prerequisite-tools.
  ticketPrerequisitesService?: TicketPrerequisitesService;
  // Ticket 684c012b: benchmark score persistence + leaderboard aggregation.
  // Present in both modes — the service is stateless over the DataSource, so the
  // standalone builder constructs a thin instance directly (same pattern as
  // ticketPrerequisitesService). Used by benchmark-tools.
  benchmarkService?: BenchmarkService;
}

/**
 * Build a ToolContext for the standalone MCP server. Services are
 * instantiated directly against the given DataSource (no NestJS DI).
 *
 * Safe to call with the mutable `AppDataSource` that the standalone entry
 * creates via `initDb()` — TypeORM repositories resolve at call time.
 */
export function createStandaloneContext(dataSource: DataSource): ToolContext {
  const logger: McpLogger = {
    info: (category, message, meta) => { console.log(`[${category}]`, message, meta || ''); },
    warn: (category, message, meta) => { console.warn(`[${category}]`, message, meta || ''); },
    error: (category, message, meta) => { console.error(`[${category}]`, message, meta || ''); },
  };

  // Standalone ActivityService needs a LogService-compatible dependency. We
  // instantiate a real LogService for it (in-memory log buffer is harmless;
  // console output is already covered by our own `logger`).
  const logService = new LogService();

  const activityService = new ActivityService(
    dataSource.getRepository(ActivityLog),
    logService,
  );
  const apiKeyService = new ApiKeyService(dataSource.getRepository(ApiKey));
  const embeddingService = new EmbeddingService(dataSource);
  const githubService = new GitHubConnectorService(dataSource);
  const mentionService = new MentionService();

  // v0.33: standalone chat support. Required for send_chat_room_message.
  const roomMembershipService = new RoomMembershipService(
    dataSource.getRepository(ChatRoom),
    dataSource.getRepository(ChatRoomParticipant),
    dataSource.getRepository(User),
    dataSource.getRepository(Agent),
    dataSource,
  );
  const roomMessagingService = new RoomMessagingService(
    dataSource.getRepository(ChatRoom),
    dataSource.getRepository(ChatRoomParticipant),
    dataSource.getRepository(ChatRoomMessage),
    dataSource.getRepository(Agent),
    dataSource.getRepository(Ticket),
    dataSource.getRepository(UserMention),
    dataSource.getRepository(TicketAttachment),
    logService,
    roomMembershipService,
    mentionService,
  );

  // Prerequisite service — stateless over dataSource + activityService, so a
  // direct instantiation matches the DI singleton's behavior in standalone mode.
  const ticketPrerequisitesService = new TicketPrerequisitesService(dataSource as any, activityService);

  // BenchmarkService is stateless over the DataSource (the @InjectDataSource
  // decorator is DI metadata only — calling the constructor directly is the
  // standalone equivalent of the DI singleton, matching the prereq service above).
  const benchmarkService = new BenchmarkService(dataSource);

  return {
    dataSource,
    activityService,
    apiKeyService,
    embeddingService,
    githubService,
    mentionService,
    logger,
    roomMembershipService,
    roomMessagingService,
    ticketPrerequisitesService,
    benchmarkService,
  };
}
