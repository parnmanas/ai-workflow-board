/**
 * `registerAllTools` orchestrator — called by both the NestJS integrated
 * controller (mcp.controller.ts) and the standalone entry point
 * (mcp-server.ts). Each domain file below contributes a slice of the full
 * tool surface.
 *
 * Current state (Phase 3 C1): domain files have not yet been created.
 * `registerAllTools` delegates to the monolithic implementation still
 * living in mcp-tools.ts. Subsequent commits (C2..C15) peel tool blocks
 * out of that file into tools/<domain>-tools.ts and wire each slice's
 * `register*Tools(server, ctx)` into the array below.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolContext } from './context';
import { registerAllTools as registerMonolithTools } from '../mcp-tools';

export type { ToolContext } from './context';
export { createStandaloneContext } from './context';

export function registerAllTools(server: McpServer, ctx: ToolContext): void {
  // Phase 3 C1: still a single monolithic pass. C2..C15 will replace this
  // with an explicit list of domain-specific registration calls.
  registerMonolithTools(server, ctx);
}
