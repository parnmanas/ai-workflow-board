import { Controller, All, Req, Res, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { Request, Response } from 'express';
import { randomUUID } from 'crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { registerAllTools, setDataSource, setLogService as setMcpToolsLogService, setSessionAuth, removeSessionAuth } from './mcp-tools';
import { ApiKeyService } from '../../services/api-key.service';
import { LogService } from '../../services/log.service';
import { AgentConnectionService } from '../agents/agent-connection.service';
import { activityEvents } from '../../services/activity.service';

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

function reorderJsonRpc(msg: any): any {
  if (!msg || typeof msg !== 'object' || !msg.jsonrpc) return msg;
  const ordered: any = { jsonrpc: msg.jsonrpc };
  if ('id' in msg) ordered.id = msg.id;
  if ('method' in msg) { ordered.method = msg.method; if ('params' in msg) ordered.params = msg.params; }
  if ('result' in msg) ordered.result = msg.result;
  if ('error' in msg) ordered.error = msg.error;
  return ordered;
}

function normalizeJsonRpcBody(raw: string): string {
  try {
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== 'object') return raw;
    if (Array.isArray(obj)) return JSON.stringify(obj.map(reorderJsonRpc));
    return JSON.stringify(reorderJsonRpc(obj));
  } catch { return raw; }
}

function expressToWebRequest(req: Request): globalThis.Request {
  const protocol = req.protocol || 'http';
  const host = req.get('host') || 'localhost';
  const url = `${protocol}://${host}${req.originalUrl}`;

  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const v of value) headers.append(key, v);
    } else {
      headers.set(key, value);
    }
  }

  const accept = headers.get('accept') || '';
  if (!accept.includes('application/json') || !accept.includes('text/event-stream')) {
    const parts = [accept, 'application/json', 'text/event-stream'].filter(Boolean);
    headers.set('accept', parts.join(', '));
  }

  const init: RequestInit = { method: req.method, headers };
  if (req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'DELETE') {
    if (req.body !== undefined) init.body = JSON.stringify(req.body);
  }

  return new globalThis.Request(url, init);
}

async function sendWebResponse(webRes: globalThis.Response, res: Response): Promise<void> {
  res.status(webRes.status);
  webRes.headers.forEach((value, key) => { res.setHeader(key, value); });

  if (!webRes.body) { res.end(); return; }

  const contentType = webRes.headers.get('content-type') || '';

  if (contentType.includes('text/event-stream')) {
    res.flushHeaders();
    const reader = webRes.body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(value);
        if (typeof (res as any).flush === 'function') (res as any).flush();
      }
    } catch (err) { mcpLogError('SSE stream error', { error: String(err) }); }
    finally { res.end(); }
  } else {
    const reader = webRes.body.getReader();
    const chunks: Uint8Array[] = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }

    let bodyStr = Buffer.concat(chunks).toString('utf8');
    if (contentType.includes('application/json')) {
      bodyStr = normalizeJsonRpcBody(bodyStr);
      res.setHeader('content-type', 'application/json; charset=utf-8');
    }

    const bodyBuf = Buffer.from(bodyStr, 'utf8');
    const hexPreview = bodyBuf.slice(0, 20).toString('hex').match(/../g)?.join(' ') || '';
    mcpLog(`Response: status=${webRes.status}, type=${res.getHeader('content-type')}, size=${bodyBuf.length}`, {
      body: bodyStr.slice(0, 500),
      hex: hexPreview,
    });

    res.setHeader('content-length', bodyBuf.length);
    res.end(bodyBuf);
  }
}

const SESSION_TTL_MS = 10 * 60 * 1000; // 10 minutes idle timeout

@Controller()
export class McpController implements OnModuleInit, OnModuleDestroy {
  private mcpSessions = new Map<string, {
    transport: WebStandardStreamableHTTPServerTransport;
    server: McpServer;
    lastActivity: number;
  }>();

  // agentId → McpServer mapping for push notifications
  private agentServers = new Map<string, McpServer>();
  private triggerListener: ((event: any) => void) | null = null;

  constructor(
    private readonly apiKeyService: ApiKeyService,
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly _logService: LogService,
    private readonly agentConnectionService: AgentConnectionService,
  ) {}

  onModuleInit() {
    setDataSource(this.dataSource);
    logService = this._logService;
    setMcpToolsLogService(this._logService);

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
          timestamp: event.timestamp,
        },
      }).catch((e: unknown) => {
        mcpLogError('Failed to push trigger via MCP', { error: String(e), agent_id: agentId });
      });
      mcpLog('Trigger pushed via MCP logging notification', { agent_id: agentId, trigger_id: event.trigger_id });
    };
    activityEvents.on('agent_trigger', this.triggerListener);

    // Cleanup idle sessions every 2 minutes
    setInterval(() => {
      const now = Date.now();
      let cleaned = 0;
      for (const [sid, session] of this.mcpSessions) {
        if (now - session.lastActivity > SESSION_TTL_MS) {
          session.transport.close().catch(() => {});
          this.mcpSessions.delete(sid);
          removeSessionAuth(sid);
          cleaned++;
        }
      }
      if (cleaned > 0) {
        mcpLog(`Session cleanup: removed ${cleaned} idle sessions (active: ${this.mcpSessions.size})`);
      }
    }, 2 * 60 * 1000);
  }

  onModuleDestroy() {
    if (this.triggerListener) {
      activityEvents.removeListener('agent_trigger', this.triggerListener);
    }
  }

  private createMcpServer(): McpServer {
    const server = new McpServer(
      { name: 'ai-workflow-board', version: '1.0.0' },
      { capabilities: { experimental: { 'awb/schemaVersion': { version: 2 } } } },
    );
    registerAllTools(server);
    return server;
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
      // Skip for internal clients (presence heartbeat) that only call ping tool
      if (req.method === 'POST' && req.body?.method === 'initialize') {
        const clientName = req.body?.params?.clientInfo?.name;
        const schemaVerRaw = req.body?.params?.capabilities?.experimental?.['awb/schemaVersion'];
        // Accept both { version: 2 } (MCP-compliant object) and bare 2 (legacy)
        const schemaVer = typeof schemaVerRaw === 'object' && schemaVerRaw !== null
          ? schemaVerRaw.version
          : schemaVerRaw;
        const isInternalClient = clientName === 'awb-presence-heartbeat';
        if (schemaVer !== 2 && !isInternalClient) {
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
        if (sessionId && this.mcpSessions.has(sessionId)) {
          const session = this.mcpSessions.get(sessionId)!;
          await session.transport.close();
          this.mcpSessions.delete(sessionId);
          removeSessionAuth(sessionId);
          res.status(200).end();
        } else {
          res.status(404).json({ error: 'Session not found' });
        }
        return;
      }

      const webReq = expressToWebRequest(req);

      // Existing session
      if (sessionId && this.mcpSessions.has(sessionId)) {
        const session = this.mcpSessions.get(sessionId)!;
        session.lastActivity = Date.now();
        const webRes = await session.transport.handleRequest(webReq, { parsedBody: req.body });
        await sendWebResponse(webRes, res);
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

      // New session (initialization request — no session ID)
      if (req.method === 'POST') {
        const transport = new WebStandardStreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          enableJsonResponse: true,
          onsessioninitialized: (id) => {
            this.mcpSessions.set(id, { transport, server: mcpServer, lastActivity: Date.now() });
            // Inject agent auth context for tool handlers
            setSessionAuth(id, {
              agentId: mcpAuthInfo.agentId,
              agentName: mcpAuthInfo.agentName,
              scope: mcpAuthInfo.scope,
              source: mcpAuthInfo.source,
            });
            // Register agentId → server mapping for push notifications
            if (mcpAuthInfo.agentId) {
              this.agentServers.set(mcpAuthInfo.agentId, mcpServer);
            }
            const who = mcpAuthInfo?.agentName || mcpAuthInfo?.keyHint || 'anonymous';
            mcpLog(`New session: ${id} by [${who}]  (active: ${this.mcpSessions.size})`);
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
            this.mcpSessions.delete(sid);
            removeSessionAuth(sid);
            mcpLog(`Session closed: ${sid}  (active: ${this.mcpSessions.size})`);
          }
          // Clean up agent → server mapping and mark offline
          if (mcpAuthInfo?.agentId) {
            this.agentServers.delete(mcpAuthInfo.agentId);
            this.agentConnectionService.markOffline(mcpAuthInfo.agentId).catch((e) => {
              mcpLogError(`Failed to mark agent offline: ${e}`);
            });
          }
        };

        const mcpServer = this.createMcpServer();
        await mcpServer.connect(transport);

        const webRes = await transport.handleRequest(webReq, { parsedBody: req.body });
        await sendWebResponse(webRes, res);
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
