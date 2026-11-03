import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { SESSION_MESSAGE_MAX_CHARS } from '../../agent-sessions/session-messages.service';
import { err, ok } from '../shared/helpers';
import { getCallerAgent } from '../shared/session-auth';
import type { ToolContext } from './context';

const SESSION_TOOL_AUTH = 'Requires a DB-backed full-scope Host key (not a runtime key) whose account owner has agent_sessions.use; only Hosts of that account are visible, and sessions another account opened are hidden.';

async function directory(ctx: ToolContext, run: (svc: NonNullable<ToolContext['sessionDirectoryService']>) => Promise<unknown>) {
  if (!ctx.sessionDirectoryService) return err('Finding sessions requires the NestJS-integrated AWB server.');
  try {
    return ok(await run(ctx.sessionDirectoryService));
  } catch (e: any) {
    return err(e?.message || 'Session lookup failed', { code: e?.code, status: e?.status });
  }
}

export function registerSessionMessageTools(server: McpServer, ctx: ToolContext): void {
  server.tool(
    'list_session_hosts',
    'List the Runtime Hosts of your account for native CLI sessions: manager_id, name, online, session CLIs, last_seen_at, and registered project folders. ' +
    `Use the manager_id with list_session_folders, list_sessions, open_session or send_session_message. ${SESSION_TOOL_AUTH} Read-only.`,
    {},
    async (_args, extra) => directory(ctx, svc => svc.listHosts(getCallerAgent(extra))),
  );
  server.tool(
    'list_session_folders',
    'List working folders that have native CLI sessions, plus registered project folders, per Host: path, project, session count, running count, CLIs, last_used_at. ' +
    `Pass a path to list_sessions (cwd) or open_session (cwd). Asks each connected Host; offline Hosts are skipped. ${SESSION_TOOL_AUTH} Read-only.`,
    {
      manager_id: z.string().uuid().optional().describe('One Host; default: every connected Host of your account.'),
      cli: z.string().trim().min(1).max(40).optional().describe('One CLI, e.g. codex or claude.'),
    },
    async (args, extra) => directory(ctx, svc => svc.listFolders(getCallerAgent(extra), args)),
  );
  server.tool(
    'list_sessions',
    'Find native CLI sessions (including ones started in a terminal) on connected Hosts, newest first: address (manager_id, cli, session_id), title, cwd, created_at, last_used_at, status, model, effort, mode, opened_in_awb. ' +
    'Status is the live process state, or not_running/idle. model/effort/mode come from the running process or AWB launch settings; details=true also reads them from each session\'s native record. ' +
    `send_session_message opens a listed session that is not running. Use get_session_info for one session. ${SESSION_TOOL_AUTH} Read-only.`,
    {
      manager_id: z.string().uuid().optional().describe('One Host; default: every connected Host.'),
      cli: z.string().trim().min(1).max(40).optional().describe('One CLI, e.g. codex or claude.'),
      cwd: z.string().trim().min(1).max(1024).optional().describe('Working folder; includes sessions in its subfolders.'),
      query: z.string().trim().min(1).max(200).optional().describe('Case-insensitive text in title, session ID or cwd.'),
      active_within_hours: z.number().positive().max(24 * 365).optional().describe('Only sessions used within this many hours.'),
      running_only: z.boolean().optional().describe('Only sessions with a live process.'),
      details: z.boolean().optional().describe('Read model/effort/mode from native records for up to 20 results (slower).'),
      limit: z.number().int().min(1).max(200).optional().describe('Default 30.'),
    },
    async (args, extra) => directory(ctx, svc => svc.listSessions(getCallerAgent(extra), args)),
  );
  server.tool(
    'get_session_info',
    'Describe one native CLI session: Host, CLI, title, cwd, created_at, last_used_at, status, model/effort/mode with their source ' +
    '(live process, native record of the last turn, or AWB launch setting), the raw native record (CLI version, git branch, sandbox), ' +
    `and AWB state (first opened in AWB, credential name, launch config). Does not read the transcript or take over the session. ${SESSION_TOOL_AUTH}`,
    {
      session_id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/).describe('Native session ID.'),
      manager_id: z.string().uuid().optional().describe('Host UUID; needed when the ID is not unique.'),
      cli: z.string().trim().min(1).max(40).optional().describe('CLI; needed when the ID is not unique.'),
    },
    async (args, extra) => directory(ctx, svc => svc.getSessionInfo(getCallerAgent(extra), args)),
  );
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
    'Message an existing native session, preserving its context. Requires an AWB native sender with a DB-backed full-scope Host key. ' +
    'The target is any session on your account\'s connected Hosts (find it with list_sessions), including ones never opened in AWB: ' +
    'if it is not running, AWB opens it first (waits up to 30s; open failures and open_timeout are returned and nothing is sent). ' +
    'Operators use propose_session_prompt instead. Busy recipients receive steering or a queued prompt. Includes your address for replies. ' +
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
