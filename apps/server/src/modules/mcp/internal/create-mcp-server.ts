/**
 * Shared MCP server builder.
 *
 * Two entry points need a configured McpServer:
 *   - `src/mcp-server.ts` (standalone stdio/HTTP entry, no NestJS)
 *   - `src/modules/mcp/mcp.controller.ts` (NestJS HTTP transport)
 *
 * Both previously hand-rolled the same `new McpServer({name, version}, {capabilities})`
 * call immediately followed by `registerAllTools`. The metadata in those
 * constructors (server name, version, experimental capability bundle) must
 * stay in sync between the two callers — so the construction lives here and
 * each caller just supplies its own ToolContext.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerAllTools, type ToolContext } from '../tools';

// Update the version bump target when breaking the MCP surface. Clients read
// experimental['awb/schemaVersion'].version to detect incompatibilities.
const MCP_SERVER_NAME = 'ai-workflow-board';
const MCP_SERVER_VERSION = '1.0.0';
const MCP_SCHEMA_VERSION = 2;

export function createMcpServerForContext(ctx: ToolContext): McpServer {
  const server = new McpServer(
    { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
    { capabilities: { experimental: { 'awb/schemaVersion': { version: MCP_SCHEMA_VERSION } } } },
  );
  registerAllTools(server, ctx);
  return server;
}
