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
import { ActivityService } from '../../../services/activity.service';
import { ApiKeyService } from '../../../services/api-key.service';
import { LogService } from '../../../services/log.service';
import { EmbeddingService } from '../../../services/embedding.service';
import { GitHubConnectorService } from '../../../services/github-connector.service';
import { MentionService } from '../../../services/mention.service';
import type { AgentStatusService } from '../../agents/agent-status.service';
import type { AllocationService } from '../../agents/allocation.service';
import type { RoomCrudService } from '../../chat-rooms/room-crud.service';
import type { RoomMembershipService } from '../../chat-rooms/room-membership.service';
import type { RoomMessagingService } from '../../chat-rooms/room-messaging.service';

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

  return { dataSource, activityService, apiKeyService, embeddingService, githubService, mentionService, logger };
}
