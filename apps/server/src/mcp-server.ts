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
import { preSyncPostgres } from './database/pre-sync-postgres';
import { createStandaloneContext } from './modules/mcp/tools';
import { createMcpServerForContext } from './modules/mcp/internal/create-mcp-server';
import { expressToWebRequest, sendWebResponse } from './modules/mcp/internal/express-bridge';
import { sessionStore } from './modules/mcp/internal/session-store';

// ─── Helpers ───────────────────────────────────────────────

function mcpLog(...args: unknown[]) {
  console.error('[MCP]', ...args);
}

// ─── Create & configure MCP server ─────────────────────────

function createMcpServer(): McpServer {
  return createMcpServerForContext(createStandaloneContext(AppDataSource));
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

  // ── Session management (unified store with TTL cleanup) ─
  sessionStore.ensureCleanupStarted((removed, remaining) => {
    mcpLog(`Session cleanup: removed ${removed} idle sessions (active: ${remaining})`);
  });

  // ── Bridge logger (routes shared bridge diagnostics through mcpLog) ──
  const bridgeLog = (msg: string, meta?: Record<string, any>) => mcpLog(msg, meta || '');
  const bridgeErr = (msg: string, meta?: Record<string, any>) => mcpLog(msg, meta || '');
  const bridgeOpts = { log: bridgeLog, logError: bridgeErr };

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

      // ─ Existing session ───────────────────────────────
      if (sessionId && sessionStore.has(sessionId)) {
        const session = sessionStore.get(sessionId)!;
        sessionStore.touch(sessionId);
        const webRes = await session.transport.handleRequest(webReq, {
          parsedBody: req.body,
        });
        await sendWebResponse(webRes, res, bridgeOpts);
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
            sessionStore.register(id, transport, mcpServer);
            mcpLog(`New session: ${id}  (active: ${sessionStore.size})`);
          },
        });

        transport.onerror = (err) => {
          mcpLog(`Transport error: ${err.message}`);
        };

        transport.onclose = () => {
          const sid = transport.sessionId;
          if (sid) {
            sessionStore.remove(sid);
            mcpLog(`Session closed: ${sid}  (active: ${sessionStore.size})`);
          }
        };

        const mcpServer = createMcpServer();
        await mcpServer.connect(transport);

        const webRes = await transport.handleRequest(webReq, {
          parsedBody: req.body,
        });
        await sendWebResponse(webRes, res, bridgeOpts);
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
      sessions: sessionStore.size,
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
  // See pre-sync-postgres.ts — must run before TypeORM initializes.
  await preSyncPostgres();
  await initDb();

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
