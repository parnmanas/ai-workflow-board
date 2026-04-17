/**
 * `registerAllTools` orchestrator — called by both the NestJS integrated
 * controller (mcp.controller.ts) and the standalone entry point
 * (mcp-server.ts).
 *
 * Phase 3 split the 68 MCP tools across 14 domain files below. Each
 * `register<Domain>Tools(server, ctx)` contributes a slice; the total is
 * the complete AWB MCP surface.
 *
 * Tool count (68):
 *   - workspace (5), board (5), column (3), ticket (11), comment (1),
 *     activity (2), user (6, incl. whoami), agent (9, incl. ping and
 *     prompt templates), chat (3, incl. set_typing), api-key (6),
 *     trigger (3, incl. subscribe_events), resource (6), github (3),
 *     misc (5, channels + batch_operations)
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { setEmbeddingDataSource } from '../../../services/embedding.service';
import { setGitHubDataSource } from '../../../services/github-connector.service';
import type { ToolContext } from './context';

import { registerWorkspaceTools } from './workspace-tools';
import { registerBoardTools } from './board-tools';
import { registerColumnTools } from './column-tools';
import { registerTicketTools } from './ticket-tools';
import { registerCommentTools } from './comment-tools';
import { registerActivityTools } from './activity-tools';
import { registerUserTools } from './user-tools';
import { registerAgentTools } from './agent-tools';
import { registerChatTools } from './chat-tools';
import { registerApiKeyTools } from './api-key-tools';
import { registerTriggerTools } from './trigger-tools';
import { registerResourceTools } from './resource-tools';
import { registerGitHubTools } from './github-tools';
import { registerMiscTools } from './misc-tools';

export type { ToolContext } from './context';
export { createStandaloneContext } from './context';

export function registerAllTools(server: McpServer, ctx: ToolContext): void {
  // Hydrate the DataSource-aware services that are still accessed via
  // module setters (embedding / github). Safe to call on every server
  // creation — both setters are idempotent.
  setEmbeddingDataSource(ctx.dataSource);
  setGitHubDataSource(ctx.dataSource);

  registerWorkspaceTools(server, ctx);
  registerBoardTools(server, ctx);
  registerColumnTools(server, ctx);
  registerTicketTools(server, ctx);
  registerCommentTools(server, ctx);
  registerActivityTools(server, ctx);
  registerUserTools(server, ctx);
  registerAgentTools(server, ctx);
  registerChatTools(server, ctx);
  registerApiKeyTools(server, ctx);
  registerTriggerTools(server, ctx);
  registerResourceTools(server, ctx);
  registerGitHubTools(server, ctx);
  registerMiscTools(server, ctx);
}
