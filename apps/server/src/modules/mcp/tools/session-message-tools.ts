import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { SESSION_MESSAGE_MAX_CHARS } from '../../agent-sessions/session-messages.service';
import { err, ok } from '../shared/helpers';
import { getCallerAgent } from '../shared/session-auth';
import type { ToolContext } from './context';

export function registerSessionMessageTools(server: McpServer, ctx: ToolContext): void {
  server.tool(
    'open_session',
    'Open a native CLI session in AWB: create with cwd, or resume with session_id. Requires a DB-backed full-scope Host key and an account owner with agent_sessions.use; target Host must belong to the same account. Runtime keys are denied. Uses saved CLI settings; no prompt, approvals or forced takeover. Returns the session address and UI path. Native callers can then use send_session_message; operators use proposals.',
    {
      manager_id: z.string().uuid().optional().describe('Target Host UUID; defaults to your MCP Host.'),
      cli: z.string().trim().min(1).max(40).describe('Installed session CLI, e.g. codex or claude.'),
      session_id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/).optional().describe('Native session ID to resume; omit to create.'),
      cwd: z.string().trim().min(1).max(1024).optional().describe('Working directory on the Host. Required for a new session.'),
      title: z.string().trim().max(200).optional().describe('Title for a new session.'),
    },
    async (args, extra) => {
      if (!ctx.sessionOpenService) return err('Opening sessions requires the NestJS-integrated AWB server.');
      try {
        return ok(await ctx.sessionOpenService.open(getCallerAgent(extra), args));
      } catch (e: any) {
        return err(e?.message || 'Opening session failed', { code: e?.code, status: e?.status });
      }
    },
  );
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
