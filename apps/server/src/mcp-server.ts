/**
 * AI-Workflow Board MCP Server (Standalone)
 *
 * Supports two transport modes:
 *
 *   1. stdio  (local, default)
 *      npx tsx src/mcp-server.ts
 *
 *   2. http   (remote, Streamable HTTP — the current MCP standard)
 *      MCP_TRANSPORT=http npx tsx src/mcp-server.ts
 *      MCP_TRANSPORT=http MCP_PORT=7702 npx tsx src/mcp-server.ts
 *
 * In HTTP mode the server exposes:
 *   POST /mcp   — Streamable HTTP (JSON-RPC over HTTP, with optional SSE streaming)
 *   GET  /mcp   — SSE stream for server-initiated notifications
 *   DELETE /mcp — Session termination
 *
 * Remote AI agents connect to  http://<host>:<MCP_PORT>/mcp
 *
 * Uses WebStandardStreamableHTTPServerTransport directly
 * (bypasses @hono/node-server adapter for Codex compatibility)
 */

import 'dotenv/config';
import 'reflect-metadata';
import { randomUUID } from 'crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { initDb, AppDataSource } from './db';
import { registerAllTools } from './modules/mcp/mcp-tools';
import { setEmbeddingDataSource } from './services/embedding.service';

// ─── Helpers ───────────────────────────────────────────────

function mcpLog(...args: unknown[]) {
  console.error('[MCP]', ...args);
}

// ─── JSON-RPC field order normalization ────────────────────
// Some MCP clients (OpenAI Codex/rmcp) are sensitive to field order.
// Standard: jsonrpc → id → result/error
// SDK emits: result → jsonrpc → id

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

// ─── Create & configure MCP server ─────────────────────────

function createMcpServer(): McpServer {
  const server = new McpServer(
    { name: 'ai-workflow-board', version: '1.0.0' },
    { capabilities: { experimental: { 'awb/schemaVersion': { version: 2 } } } },
  );
  registerAllTools(server);
  return server;
}

// ─── STDIO mode ─────────────────────────────────────────────

async function startStdio() {
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  mcpLog('AI-Workflow Board MCP server running on stdio');
}

// ─── HTTP mode (Streamable HTTP) ────────────────────────────

async function startHttp() {
  const express = (await import('express')).default;
  const cors = (await import('cors')).default;

  const app = express();
  const PORT = parseInt(process.env.MCP_PORT || '7702');

  app.use(cors({
    origin: process.env.CORS_ORIGIN || true,
    credentials: true,
  }));

  // ── Session management ──────────────────────────────────
  const SESSION_TTL_MS = 10 * 60 * 1000; // 10 minutes idle timeout
  const sessions = new Map<string, {
    transport: WebStandardStreamableHTTPServerTransport;
    server: McpServer;
    lastActivity: number;
  }>();

  // Cleanup idle sessions every 2 minutes
  setInterval(() => {
    const now = Date.now();
    let cleaned = 0;
    for (const [sid, session] of sessions) {
      if (now - session.lastActivity > SESSION_TTL_MS) {
        session.transport.close().catch(() => {});
        sessions.delete(sid);
        cleaned++;
      }
    }
    if (cleaned > 0) {
      mcpLog(`Session cleanup: removed ${cleaned} idle sessions (active: ${sessions.size})`);
    }
  }, 2 * 60 * 1000);

  // ── Express → Web Standard Request conversion ───────────
  function expressToWebRequest(req: any): Request {
    const protocol = req.protocol || 'http';
    const host = req.get?.('host') || req.headers?.host || 'localhost';
    const url = `${protocol}://${host}${req.originalUrl || req.url}`;

    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers as Record<string, string | string[]>)) {
      if (value === undefined) continue;
      if (Array.isArray(value)) {
        for (const v of value) headers.append(key, v);
      } else {
        headers.set(key, value);
      }
    }

    // Patch Accept header for MCP SDK compatibility
    const accept = headers.get('accept') || '';
    if (!accept.includes('application/json') || !accept.includes('text/event-stream')) {
      const parts = [accept, 'application/json', 'text/event-stream'].filter(Boolean);
      headers.set('accept', parts.join(', '));
      mcpLog(`Accept patched: "${accept}" → "${headers.get('accept')}"`);
    }

    const init: RequestInit = { method: req.method, headers };
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'DELETE') {
      if (req.body !== undefined) {
        init.body = JSON.stringify(req.body);
      }
    }

    return new Request(url, init);
  }

  // ── Web Standard Response → Express response ────────────
  async function sendWebResponse(webRes: Response, res: any): Promise<void> {
    res.status(webRes.status);
    webRes.headers.forEach((value: string, key: string) => {
      res.setHeader(key, value);
    });

    if (!webRes.body) {
      res.end();
      return;
    }

    const contentType = webRes.headers.get('content-type') || '';

    if (contentType.includes('text/event-stream')) {
      res.flushHeaders();
      const reader = webRes.body.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          res.write(value);
          if (typeof res.flush === 'function') res.flush();
        }
      } catch (err) {
        mcpLog('SSE stream error:', err);
      } finally {
        res.end();
      }
    } else {
      // Read full body
      const reader = webRes.body.getReader();
      const chunks: Uint8Array[] = [];
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
      }

      let bodyStr = Buffer.concat(chunks).toString('utf8');

      // For JSON: normalize field order + charset
      if (contentType.includes('application/json')) {
        bodyStr = normalizeJsonRpcBody(bodyStr);
        res.setHeader('content-type', 'application/json; charset=utf-8');
      }

      const bodyBuf = Buffer.from(bodyStr, 'utf8');
      const hexPreview = bodyBuf.slice(0, 20).toString('hex').match(/../g)?.join(' ') || '';
      mcpLog(`Response: status=${webRes.status}, type=${res.getHeader('content-type')}, size=${bodyBuf.length}`);
      mcpLog(`  body: ${bodyStr.slice(0, 500)}`);
      mcpLog(`  hex[0:20]: ${hexPreview}`);

      res.setHeader('content-length', bodyBuf.length);
      res.end(bodyBuf);
    }
  }

  // ── MCP endpoint ────────────────────────────────────────
  app.all('/mcp', express.json(), async (req: any, res: any) => {
    try {
      const sessionId = req.headers['mcp-session-id'] as string | undefined;

      mcpLog(`${req.method} /mcp`, {
        sessionId: sessionId || '(none)',
        contentType: req.headers['content-type'],
        accept: req.headers['accept'],
        bodyPreview: req.method === 'POST' ? JSON.stringify(req.body)?.slice(0, 300) : '(n/a)',
      });

      // ─ DELETE ─────────────────────────────────────────
      if (req.method === 'DELETE') {
        if (sessionId && sessions.has(sessionId)) {
          const session = sessions.get(sessionId)!;
          await session.transport.close();
          sessions.delete(sessionId);
          res.status(200).end();
        } else {
          res.status(404).json({ error: 'Session not found' });
        }
        return;
      }

      const webReq = expressToWebRequest(req);

      // ─ Existing session ───────────────────────────────
      if (sessionId && sessions.has(sessionId)) {
        const session = sessions.get(sessionId)!;
        session.lastActivity = Date.now();
        const webRes = await session.transport.handleRequest(webReq, {
          parsedBody: req.body,
        });
        await sendWebResponse(webRes, res);
        return;
      }

      // ─ Stale session ID — tell client to re-initialize
      if (sessionId) {
        mcpLog(`Stale session rejected: ${sessionId}`);
        res.status(404).json({
          jsonrpc: '2.0',
          error: { code: -32000, message: 'Session not found. Please re-initialize.' },
          id: null,
        });
        return;
      }

      // ─ New session (initialization — no session ID) ───
      if (req.method === 'POST') {
        const transport = new WebStandardStreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          enableJsonResponse: true,
          onsessioninitialized: (id) => {
            sessions.set(id, { transport, server: mcpServer, lastActivity: Date.now() });
            mcpLog(`New session: ${id}  (active: ${sessions.size})`);
          },
        });

        transport.onerror = (err) => {
          mcpLog(`Transport error: ${err.message}`);
        };

        transport.onclose = () => {
          const sid = transport.sessionId;
          if (sid) {
            sessions.delete(sid);
            mcpLog(`Session closed: ${sid}  (active: ${sessions.size})`);
          }
        };

        const mcpServer = createMcpServer();
        await mcpServer.connect(transport);

        const webRes = await transport.handleRequest(webReq, {
          parsedBody: req.body,
        });
        await sendWebResponse(webRes, res);
        return;
      }

      // ─ GET without session ────────────────────────────
      res.status(400).json({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'No valid session. Send initialize request first (POST).' },
        id: null,
      });
    } catch (err) {
      mcpLog('Unhandled error in /mcp:', err);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: { code: -32603, message: 'Internal server error' },
          id: null,
        });
      }
    }
  });

  // ── Health check ────────────────────────────────────────
  app.get('/health', (_req: any, res: any) => {
    res.json({
      status: 'ok',
      transport: 'streamable-http',
      sessions: sessions.size,
      timestamp: new Date().toISOString(),
    });
  });

  app.listen(PORT, () => {
    mcpLog(`AI-Workflow Board MCP server listening on http://0.0.0.0:${PORT}/mcp`);
    mcpLog(`Health check: http://0.0.0.0:${PORT}/health`);
  });
}

// ─── Main ───────────────────────────────────────────────────

async function main() {
  await initDb();
  setEmbeddingDataSource(AppDataSource);

  const transport = (process.env.MCP_TRANSPORT || 'stdio').toLowerCase();

  if (transport === 'http' || transport === 'sse') {
    await startHttp();
  } else {
    await startStdio();
  }
}

main().catch((err) => {
  console.error('[MCP] Fatal error:', err);
  process.exit(1);
});
