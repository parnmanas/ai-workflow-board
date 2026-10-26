import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { SESSION_MESSAGE_MAX_CHARS } from '../../agent-sessions/session-messages.service';
import { err, ok } from '../shared/helpers';
import { getCallerAgent } from '../shared/session-auth';
import type { ToolContext } from './context';

export function registerSessionMessageTools(server: McpServer, ctx: ToolContext): void {
  server.tool(
    'send_session_message',
    'Message an existing native session, preserving its context. Requires an AWB native sender with a DB-backed full-scope Host key; ' +
    'both sessions must be opened in AWB and in the same account. Operators use propose_session_prompt instead. ' +
    'Busy recipients receive steering or a queued prompt. Includes your address for replies. ' +
    'submitted confirms dispatch, not receipt. No human approval is granted. Self-messages and chains beyond 3 messages are blocked.',
    {
      session_id: z.string().trim().min(1).describe('Full native session ID, not an rt- key or MCP transport ID.'),
      content: z.string().min(1).max(SESSION_MESSAGE_MAX_CHARS).describe('Message text.'),
      manager_id: z.string().uuid().optional().describe('Host UUID to disambiguate the session ID.'),
      cli: z.string().trim().min(1).optional().describe('CLI (codex, claude, etc.) to disambiguate the session ID.'),
    },
    async (args, extra) => {
      if (!ctx.sessionMessagesService) return err('Session messages require the NestJS-integrated AWB server.');
      try {
        return ok(await ctx.sessionMessagesService.send(getCallerAgent(extra), args));
      } catch (e: any) {
        return err(e?.message || 'Session message failed', { code: e?.code, status: e?.status });
      }
    },
  );
}
