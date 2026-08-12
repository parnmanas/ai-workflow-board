/**
 * Shared MCP HTTP authentication.
 *
 * Both the NestJS-integrated `/mcp` endpoint (mcp.controller.ts) and the
 * standalone HTTP entry point (mcp-server.ts, MCP_TRANSPORT=http) expose the
 * same Streamable HTTP transport and MUST enforce the same credential check
 * on every request — DB-backed ApiKeys first, MCP_API_KEYS env entries as
 * fallback, and only skip the check when MCP_DEV_MODE=true outside
 * production AND no keys exist anywhere. Extracted here so the two
 * transports can never authenticate differently (ticket 7f4a4062 — the
 * standalone path previously had no authentication at all).
 */

import type { Request, Response } from 'express';
import type { ApiKeyService } from '../../../services/api-key.service';

export interface McpAuthInfo {
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

export function loadMcpEnvKeys(): EnvKeyEntry[] {
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

export function maskMcpKey(key: string): string {
  if (key.length <= 12) return key.slice(0, 4) + '***';
  return key.slice(0, 8) + '***' + key.slice(-4);
}

/**
 * Validates the incoming request's credentials. On failure, writes the
 * JSON-RPC error response (401/403) itself and returns null — callers must
 * stop handling the request immediately since the response was already sent.
 */
export async function authenticateMcpRequest(
  req: Request,
  res: Response,
  apiKeyService: ApiKeyService,
  logError: (message: string, meta?: Record<string, any>) => void,
): Promise<McpAuthInfo | null> {
  const authHeader = req.headers['authorization'];
  let token: string | undefined;
  if (authHeader) {
    token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : authHeader.trim();
  }
  if (!token) token = req.headers['x-api-key'] as string | undefined;

  if (token) {
    // DB validation
    try {
      const dbResult = await apiKeyService.validateApiKey(token);
      if (dbResult.valid && dbResult.apiKey) {
        const ak = dbResult.apiKey;
        return {
          // ak.key is now a SHA-256 hash, not the raw key — use the stored
          // display prefix for the hint.
          keyHint: ak.key_prefix || 'awb_***',
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
      logError('DB key validation failed', { error: String(dbErr) });
    }

    // ENV validation
    const envKeys = loadMcpEnvKeys();
    const envMatch = envKeys.find(k => k.key === token);
    if (envMatch) {
      return { keyHint: maskMcpKey(envMatch.key), agentName: envMatch.agentName, scope: 'full', source: 'env' };
    }

    res.status(403).json({ jsonrpc: '2.0', error: { code: -32002, message: 'Invalid API key.' }, id: null });
    return null;
  }

  // No token - check dev mode
  const envKeys = loadMcpEnvKeys();
  let dbKeyCount = 0;
  try {
    dbKeyCount = (await apiKeyService.listApiKeys()).filter((k: any) => k.is_active).length;
  } catch (dbErr) {
    logError('Failed to count DB keys', { error: String(dbErr) });
  }

  if (envKeys.length === 0 && dbKeyCount === 0) {
    // HARD-gate the dev-mode fallback behind NODE_ENV !== 'production'. A
    // fresh prod deploy with no keys yet must not expose full-scope MCP
    // tooling unauthenticated just because MCP_DEV_MODE leaked into the
    // environment (security finding: authz).
    if (process.env.MCP_DEV_MODE === 'true' && process.env.NODE_ENV !== 'production') {
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
