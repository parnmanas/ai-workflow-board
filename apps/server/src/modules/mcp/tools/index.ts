/**
 * `registerAllTools` orchestrator — called by both the NestJS integrated
 * controller (mcp.controller.ts) and the standalone entry point
 * (mcp-server.ts). Each domain file below contributes a slice of the full
 * tool surface.
 *
 * Phase 3 C1 started this split. Subsequent commits (C2..C15) peel tool
 * blocks out of mcp-tools.ts into tools/<domain>-tools.ts and wire each
 * slice's `register*Tools(server, ctx)` into the list below. Whatever
 * hasn't been moved yet is still registered by the monolithic pass at the
 * end — that path shrinks with each commit and disappears after C15.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolContext } from './context';
import { registerAllTools as registerMonolithTools } from '../mcp-tools';
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

export type { ToolContext } from './context';
export { createStandaloneContext } from './context';

export function registerAllTools(server: McpServer, ctx: ToolContext): void {
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
  // Monolithic fallback — remaining tools not yet moved to domain files.
  // Shrinks with every Phase 3 commit; removed once C15 lands.
  registerMonolithTools(server, ctx);
}
