import { ApiTags } from '@nestjs/swagger';
import { Controller, All, Req, Res, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { Request, Response } from 'express';
import { randomUUID } from 'crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { type ToolContext } from './tools';
import { createMcpServerForContext } from './internal/create-mcp-server';
import { expressToWebRequest, sendWebResponse } from './internal/express-bridge';
import { sessionStore } from './internal/session-store';
import { SystemSetting } from '../../entities/SystemSetting';
import { ApiKeyService } from '../../services/api-key.service';
import { LogService } from '../../services/log.service';
import { AgentConnectionService } from '../agents/agent-connection.service';
import { TriggerLoopService } from '../agents/trigger-loop.service';
import { AgentStatusService } from '../agents/agent-status.service';
import { AllocationService } from '../agents/allocation.service';
import { RoomCrudService } from '../chat-rooms/room-crud.service';
import { RoomMembershipService } from '../chat-rooms/room-membership.service';
import { RoomMessagingService } from '../chat-rooms/room-messaging.service';
import { TicketRoleAssignmentService } from '../workspace-roles/ticket-role-assignment.service';
import { ActionsService } from '../actions/actions.service';
import { MentionService } from '../../services/mention.service';
import { ActivityService, activityEvents } from '../../services/activity.service';
import { EmbeddingService } from '../../services/embedding.service';
import { GitHubConnectorService } from '../../services/github-connector.service';

interface McpAuthInfo {
  keyHint: string;
  agentName?: string;
  agentId?: string;
  keyId?: string;
  scope?: string;
  workspaceId?: string;
  source: 'db' | 'env' | 'dev-mode';
}

interface EnvKeyEntry {
  key: string;
  agentName?: string;
}

function loadEnvKeys(): EnvKeyEntry[] {
  const raw = process.env.MCP_API_KEYS || '';
  if (!raw.trim()) return [];
  return raw.split(',').map(entry => {
    const trimmed = entry.trim();
    if (!trimmed) return null;
    const colonIdx = trimmed.indexOf(':');
    if (colonIdx > 0) {
      return { agentName: trimmed.slice(0, colonIdx).trim(), key: trimmed.slice(colonIdx + 1).trim() };
    }
    return { key: trimmed };
  }).filter(Boolean) as EnvKeyEntry[];
}

function maskKey(key: string): string {
  if (key.length <= 12) return key.slice(0, 4) + '***';
  return key.slice(0, 8) + '***' + key.slice(-4);
}

// Module-level log reference, set from McpController.onModuleInit
let logService: LogService | null = null;
function mcpLog(message: string, meta?: Record<string, any>) {
  if (logService) {
    logService.info('MCP', message, meta);
  } else {
    console.log('[MCP]', message, meta || '');
  }
}
function mcpLogError(message: string, meta?: Record<string, any>) {
  if (logService) {
    logService.error('MCP', message, meta);
  } else {
    console.error('[MCP]', message, meta || '');
  }
}

// Bridge logger options that route through the controller's logService-aware mcpLog.
const bridgeLogOpts = { log: mcpLog, logError: mcpLogError };

/**
 * tools/list response cache. Tool registration is static (registerAllTools
 * runs once per session via createMcpServerForContext, but every session
 * registers the same set), so the JSON-RPC result body is identical across
 * sessions and across time — only the request `id` varies. We cache the
 * body produced by the first call with a placeholder where the id sits and
 * substitute the real id for every subsequent call. Skips the SDK's tool
 * registry walk + zod-to-JSON-schema serialization on every cached hit;
 * for a 79-tool registry that's a ~59KB body otherwise rebuilt per session.
 */
const TOOLS_LIST_ID_PLACEHOLDER = '__AWB_TOOLS_LIST_ID__';
let cachedToolsListBody: string | null = null;

function buildCachedToolsListResponse(reqId: unknown): string | null {
  if (!cachedToolsListBody) return null;
  return cachedToolsListBody.replace(
    `"${TOOLS_LIST_ID_PLACEHOLDER}"`,
    JSON.stringify(reqId ?? null),
  );
}

function captureToolsListBodyIfFirst(bodyStr: string): void {
  if (cachedToolsListBody) return;
  // Body shape: {"jsonrpc":"2.0","id":<X>,"result":{"tools":[...]}}
  // Replace the id field with our placeholder string. Only replace the
  // first id occurrence to avoid clobbering an id nested in a tool's
  // schema (paranoid, but safe). normalizeJsonRpcBody puts id second
  // in the JSON output — the regex anchors to that location.
  const placeheld = bodyStr.replace(
    /"id":\s*(?:-?\d+|"[^"]*"|null)/,
    `"id":"${TOOLS_LIST_ID_PLACEHOLDER}"`,
  );
  // Sanity check: the placeholder must have landed and the body must look
  // like a tools/list result. If anything is off, skip caching — better
  // to re-run SDK than to serve a malformed response forever.
  if (!placeheld.includes(TOOLS_LIST_ID_PLACEHOLDER)) return;
  if (!placeheld.includes('"tools":')) return;
  cachedToolsListBody = placeheld;
}

@ApiTags('mcp')
@Controller()
export class McpController implements OnModuleInit, OnModuleDestroy {
  // agentId → McpServer mapping for push notifications
  private agentServers = new Map<string, McpServer>();
  private triggerListener: ((event: any) => void) | null = null;

  constructor(
    private readonly apiKeyService: ApiKeyService,
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly _logService: LogService,
    private readonly agentConnectionService: AgentConnectionService,
    private readonly activityService: ActivityService,
    private readonly embeddingService: EmbeddingService,
    private readonly githubService: GitHubConnectorService,
    private readonly triggerLoopService: TriggerLoopService,
    private readonly mentionService: MentionService,
    private readonly agentStatusService: AgentStatusService,
    private readonly allocationService: AllocationService,
    private readonly roomCrudService: RoomCrudService,
    private readonly roomMembershipService: RoomMembershipService,
    private readonly roomMessagingService: RoomMessagingService,
    private readonly ticketRoleAssignmentService: TicketRoleAssignmentService,
    private readonly actionsService: ActionsService,
  ) {}

  onModuleInit() {
    logService = this._logService;

    // Listen for agent_trigger events and push MCP notifications to connected agents
    this.triggerListener = (event: any) => {
      const agentId = event.agent_id;
      if (!agentId) return;
      const mcpServer = this.agentServers.get(agentId);
      if (!mcpServer) {
        mcpLog('Trigger push skipped: agent not connected via MCP', { agent_id: agentId });
        return;
      }
      mcpServer.sendLoggingMessage({
        level: 'info',
        data: {
          type: 'agent_trigger',
          trigger_id: event.trigger_id,
          ticket_id: event.ticket_id,
          agent_id: agentId,
          role: event.role,
          trigger_source: event.trigger_source,
          role_prompt: event.role_prompt,
          ticket_prompt: event.ticket_prompt,
          column_prompt: event.column_prompt,
          timestamp: event.timestamp,
        },
      }).catch((e: unknown) => {
        mcpLogError('Failed to push trigger via MCP', { error: String(e), agent_id: agentId });
      });
      mcpLog('Trigger pushed via MCP logging notification', { agent_id: agentId, trigger_id: event.trigger_id });
    };
    activityEvents.on('agent_trigger', this.triggerListener);

    // Register eviction hook to mark agents offline when their session idles out.
    // (Normal close handles this via transport.onclose — this covers abnormal
    // disconnects that never fire onclose.)
    //
    // Guard against false offlines on reconnect: if another live session for
    // the same agent exists (typical when a client reconnects before the old
    // session's 10-min TTL expires), leave it alone. The AgentStatusService's
    // 90s heartbeat-gap sweep is the authoritative offline detector anyway;
    // this hook is just a fast-path for the common clean case.
    sessionStore.onEviction((_sid, entry) => {
      const agentId = entry.auth?.agentId;
      if (!agentId) return;
      if (sessionStore.hasAgentSession(agentId)) {
        // Still connected on another session — do nothing.
        return;
      }
      this.agentServers.delete(agentId);
      this.agentConnectionService.markOffline(agentId).catch((e) => {
        mcpLogError(`Failed to mark agent offline on idle eviction: ${e}`);
      });
    });

    // Start the unified idle-cleanup sweep (idempotent; no-op if already running).
    sessionStore.ensureCleanupStarted((removed, remaining) => {
      mcpLog(`Session cleanup: removed ${removed} idle sessions (active: ${remaining})`);
    });

    // Pull the configured `mcp.max_sessions` cap from system_settings so the
    // LRU evict ceiling matches the admin UI without a restart. Failures are
    // non-fatal — the store keeps DEFAULT_MAX_SESSIONS until the next PATCH
    // pushes a new value via SettingsController.
    this.loadMcpMaxSessions().catch((err) => {
      mcpLog(`Failed to load mcp.max_sessions from DB: ${err.message}`);
    });
  }

  private async loadMcpMaxSessions(): Promise<void> {
    const repo = this.dataSource.getRepository(SystemSetting);
    const row = await repo.findOne({ where: { key: 'mcp.max_sessions' } });
    if (!row || !row.value) return;
    const n = parseInt(row.value, 10);
    if (Number.isFinite(n) && n > 0) {
      sessionStore.setMaxSessions(n);
      mcpLog(`MCP session cap loaded from settings: ${n}`);
    }
  }

  onModuleDestroy() {
    if (this.triggerListener) {
      activityEvents.removeListener('agent_trigger', this.triggerListener);
    }
  }

  private buildToolContext(): ToolContext {
    return {
      dataSource: this.dataSource,
      activityService: this.activityService,
      apiKeyService: this.apiKeyService,
      embeddingService: this.embeddingService,
      githubService: this.githubService,
      logger: this._logService,
      mentionService: this.mentionService,
      agentStatusService: this.agentStatusService,
      allocationService: this.allocationService,
      roomCrudService: this.roomCrudService,
      roomMembershipService: this.roomMembershipService,
      roomMessagingService: this.roomMessagingService,
      ticketRoleAssignmentService: this.ticketRoleAssignmentService,
      actionsService: this.actionsService,
    };
  }

  private createMcpServer(): McpServer {
    return createMcpServerForContext(this.buildToolContext());
  }

  private async authenticate(req: Request, res: Response): Promise<McpAuthInfo | null> {
    const authHeader = req.headers['authorization'];
    let token: string | undefined;
    if (authHeader) {
      token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : authHeader.trim();
    }
    if (!token) token = req.headers['x-api-key'] as string | undefined;

    if (token) {
      // DB validation
      try {
        const dbResult = await this.apiKeyService.validateApiKey(token);
        if (dbResult.valid && dbResult.apiKey) {
          const ak = dbResult.apiKey;
          return {
            keyHint: maskKey(ak.key),
            agentName: ak.agent?.name,
            agentId: ak.agent_id ?? undefined,
            keyId: ak.id,
            scope: ak.scope,
            workspaceId: ak.workspace_id || undefined,
            source: 'db',
          };
        }
        if (dbResult.reason && dbResult.reason !== 'Key not found') {
          res.status(403).json({ jsonrpc: '2.0', error: { code: -32002, message: `API key rejected: ${dbResult.reason}` }, id: null });
          return null;
        }
      } catch (dbErr) {
        mcpLogError('DB key validation failed', { error: String(dbErr) });
      }

      // ENV validation
      const envKeys = loadEnvKeys();
      const envMatch = envKeys.find(k => k.key === token);
      if (envMatch) {
        return { keyHint: maskKey(envMatch.key), agentName: envMatch.agentName, scope: 'full', source: 'env' };
      }

      res.status(403).json({ jsonrpc: '2.0', error: { code: -32002, message: 'Invalid API key.' }, id: null });
      return null;
    }

    // No token - check dev mode
    const envKeys = loadEnvKeys();
    let dbKeyCount = 0;
    try {
      dbKeyCount = (await this.apiKeyService.listApiKeys()).filter((k: any) => k.is_active).length;
    } catch (dbErr) {
      mcpLogError('Failed to count DB keys', { error: String(dbErr) });
    }

    if (envKeys.length === 0 && dbKeyCount === 0) {
      if (process.env.MCP_DEV_MODE === 'true') {
        return { keyHint: 'dev-mode', scope: 'full', source: 'dev-mode' };
      }
      res.status(401).json({
        jsonrpc: '2.0',
        error: { code: -32001, message: 'No API keys configured. Create API keys or set MCP_DEV_MODE=true for development.' },
        id: null,
      });
      return null;
    }

    res.status(401).json({
      jsonrpc: '2.0',
      error: { code: -32001, message: 'Authentication required. Provide Authorization: Bearer <api-key> header.' },
      id: null,
    });
    return null;
  }

  @All('mcp')
  async handleMcp(@Req() req: Request, @Res() res: Response) {
    try {
      const mcpAuthInfo = await this.authenticate(req, res);
      if (!mcpAuthInfo) return; // Response already sent

      // Inject workspace_id from API key into request context for downstream use
      (req as any).currentWorkspaceId = mcpAuthInfo.workspaceId ?? null;

      // schemaVersion:2 validation — per D-12..D-14
      // Skip for internal clients (presence heartbeat) that only call ping tool.
      // Skip for subagents spawned directly via Claude CLI (no proxy.mjs in path):
      // the gate's purpose is to detect outdated proxy.mjs versions, which is
      // meaningless when the client isn't a proxy at all. Subagent-manager marks
      // these sessions with X-AWB-Client-Type: subagent.
      if (req.method === 'POST' && req.body?.method === 'initialize') {
        const clientName = req.body?.params?.clientInfo?.name;
        const clientTypeHeader = String(req.headers['x-awb-client-type'] || '').toLowerCase();
        const schemaVerRaw = req.body?.params?.capabilities?.experimental?.['awb/schemaVersion'];
        // Accept both { version: 2 } (MCP-compliant object) and bare 2 (legacy)
        const schemaVer = typeof schemaVerRaw === 'object' && schemaVerRaw !== null
          ? schemaVerRaw.version
          : schemaVerRaw;
        const isInternalClient = clientName === 'awb-presence-heartbeat';
        const isSubagent = clientTypeHeader === 'subagent';
        if (schemaVer !== 2 && !isInternalClient && !isSubagent) {
          return res.status(200).json({
            jsonrpc: '2.0',
            id: req.body.id ?? null,
            error: {
              code: -32000,
              message: 'MCP proxy schemaVersion mismatch — upgrade proxy.mjs to v2',
            },
          });
        }
      }

      const sessionId = req.headers['mcp-session-id'] as string | undefined;

      mcpLog(`${req.method} /mcp`, {
        sessionId: sessionId || '(none)',
        contentType: req.headers['content-type'],
        accept: req.headers['accept'],
        bodyPreview: req.method === 'POST' ? JSON.stringify(req.body)?.slice(0, 300) : '(n/a)',
      });

      // DELETE: terminate session
      if (req.method === 'DELETE') {
        if (sessionId && sessionStore.has(sessionId)) {
          const session = sessionStore.get(sessionId)!;
          await session.transport.close();
          sessionStore.remove(sessionId);
          res.status(200).end();
        } else {
          res.status(404).json({ error: 'Session not found' });
        }
        return;
      }

      const webReq = expressToWebRequest(req);

      // Existing session
      if (sessionId && sessionStore.has(sessionId)) {
        const session = sessionStore.get(sessionId)!;
        sessionStore.touch(sessionId);

        // Cache hit: skip the SDK pipeline entirely for tools/list. The
        // result body is invariant across sessions, so substituting the
        // request id into the cached body yields a byte-equivalent
        // response without serializing 79 tool schemas again.
        if (req.method === 'POST' && req.body?.method === 'tools/list') {
          const cachedBody = buildCachedToolsListResponse(req.body.id);
          if (cachedBody) {
            res.setHeader('content-type', 'application/json; charset=utf-8');
            res.setHeader('content-length', Buffer.byteLength(cachedBody));
            res.status(200).end(cachedBody);
            return;
          }
        }

        const isFirstToolsList =
          req.method === 'POST' && req.body?.method === 'tools/list' && !cachedToolsListBody;
        const webRes = await session.transport.handleRequest(webReq, { parsedBody: req.body });
        await sendWebResponse(webRes, res, {
          ...bridgeLogOpts,
          onJsonBody: isFirstToolsList ? captureToolsListBodyIfFirst : undefined,
        });
        return;
      }

      // Stale session ID — tell client to re-initialize (MCP Streamable HTTP spec)
      if (sessionId) {
        mcpLog(`Stale session rejected: ${sessionId}`);
        res.status(404).json({
          jsonrpc: '2.0',
          error: { code: -32000, message: 'Session not found. Please re-initialize.' },
          id: null,
        });
        return;
      }

      // Role + ticket context pinned per-spawn by the plugin subagent-manager.
      // Plugin writes one MCP config file per (ticket, role) subagent and
      // injects these headers there, so every tool call from that child
      // process carries them. Stashing on the session lets add_comment and
      // friends attribute work to the correct role without each tool needing
      // a role argument. Top-level proxy and chat sessions omit the headers.
      const subagentRoleHeader = String(req.headers['x-awb-subagent-role'] || '').toLowerCase().trim() || undefined;
      const subagentTicketIdHeader = String(req.headers['x-awb-subagent-ticket-id'] || '').trim() || undefined;

      // New session (initialization request — no session ID)
      if (req.method === 'POST') {
        const transport = new WebStandardStreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          enableJsonResponse: true,
          onsessioninitialized: (id) => {
            // Register transport + auth context atomically in the unified store.
            sessionStore.register(id, transport, mcpServer, {
              agentId: mcpAuthInfo.agentId,
              agentName: mcpAuthInfo.agentName,
              scope: mcpAuthInfo.scope,
              source: mcpAuthInfo.source,
              subagentRole: subagentRoleHeader,
              subagentTicketId: subagentTicketIdHeader,
            });
            // Register agentId → server mapping for push notifications
            if (mcpAuthInfo.agentId) {
              this.agentServers.set(mcpAuthInfo.agentId, mcpServer);
            }
            const who = mcpAuthInfo?.agentName || mcpAuthInfo?.keyHint || 'anonymous';
            mcpLog(`New session: ${id} by [${who}]  (active: ${sessionStore.size})`);
          },
        });

        transport.onerror = (err) => {
          // SSE duplicate stream is a normal client behavior, not a real error
          if (err.message?.includes('Only one SSE')) {
            mcpLog(`SSE duplicate stream attempt (session: ${transport.sessionId})`);
          } else {
            mcpLogError(`Transport error: ${err.message}`);
          }
        };
        transport.onclose = () => {
          const sid = transport.sessionId;
          if (sid) {
            sessionStore.remove(sid);
            mcpLog(`Session closed: ${sid}  (active: ${sessionStore.size})`);
          }
          // Clean up agent → server mapping and mark offline, BUT only if no
          // other live session for this agent remains (reconnect guard — see
          // the eviction-hook comment above).
          if (mcpAuthInfo?.agentId && !sessionStore.hasAgentSession(mcpAuthInfo.agentId)) {
            this.agentServers.delete(mcpAuthInfo.agentId);
            this.agentConnectionService.markOffline(mcpAuthInfo.agentId).catch((e) => {
              mcpLogError(`Failed to mark agent offline: ${e}`);
            });
          }
        };

        const mcpServer = this.createMcpServer();
        await mcpServer.connect(transport);

        const webRes = await transport.handleRequest(webReq, { parsedBody: req.body });
        await sendWebResponse(webRes, res, bridgeLogOpts);
        return;
      }

      // GET without session
      if (req.method === 'GET') {
        res.status(400).json({
          jsonrpc: '2.0',
          error: { code: -32000, message: 'Bad Request: No valid session. Send an initialize request first (POST).' },
          id: null,
        });
        return;
      }

      res.status(405).json({ error: 'Method not allowed' });
    } catch (err) {
      mcpLogError('Unhandled error in /mcp', { error: String(err) });
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null });
      }
    }
  }
}
