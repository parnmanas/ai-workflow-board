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

import { createHash } from 'node:crypto';
import { InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { type McpOAuthService, oauthScopes } from '../../mcp-oauth/mcp-oauth.service';
import { oauthBase } from '../../mcp-oauth/mcp-oauth-clients';
import type { McpAgentContext } from '../internal/session-store';
import type { Request, Response } from 'express';
import type { ApiKeyService } from '../../../services/api-key.service';

export interface McpAuthInfo {
  keyHint: string;
  agentName?: string;
  agentId?: string;
  userId?: string;
  canManageKeys?: boolean;
  keyId?: string;
  scope?: string;
  accountId?: string;
  source: 'db' | 'env' | 'dev-mode' | 'oauth';
  /** P4c-2b: parsed from `runtime-provisioned:<rtKey>` key names (else undefined). */
  runtimeKey?: string;
}

/** Even cached discovery and DELETE must belong to this credential and its current authority. */
export function sameMcpCredential(session: McpAgentContext | undefined, auth: McpAuthInfo) {
  return !!session && session.source === auth.source && session.keyId === auth.keyId && session.scope === auth.scope
    && session.accountId === auth.accountId && session.userId === auth.userId && session.canManageKeys === auth.canManageKeys
    && session.agentId === auth.agentId && session.runtimeKey === auth.runtimeKey;
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
  oauth?: McpOAuthService,
): Promise<McpAuthInfo | null> {
  const authHeader = req.headers['authorization'];
  let token: string | undefined;
  if (authHeader) {
    token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : authHeader.trim();
  }
  if (!token) token = req.headers['x-api-key'] as string | undefined;

  const challenge = () => {
    const base = oauth && oauthBase();
    if (!base) return false;
    res.setHeader('WWW-Authenticate', 'Bearer resource_metadata="' + base + '/.well-known/oauth-protected-resource/mcp", scope="' + oauthScopes.join(' ') + '"');
    return true;
  };
  if (oauth && authHeader?.startsWith('Bearer awbo_') && token) {
    try {
      const info = await oauth.verifyAccessToken(token);
      return { source: 'oauth', scope: info.scopes.includes('awb.manage') ? 'full' : 'read', keyHint: 'OAuth',
        keyId: info.extra.grantId, accountId: info.extra.accountId, userId: info.extra.userId, agentName: info.extra.clientName,
        canManageKeys: info.scopes.includes('awb.keys') };
    } catch (error) {
      if (!(error instanceof InvalidTokenError)) throw error;
      challenge();
      res.status(401).json({ jsonrpc: '2.0', error: { code: -32001, message: 'Expired or revoked AWB connection.' }, id: null });
      return null;
    }
  }
  if (token) {
    // DB validation
    try {
      const dbResult = await apiKeyService.validateApiKey(token);
      if (dbResult.valid && dbResult.apiKey) {
        const ak = dbResult.apiKey;
        // P4c-2b: runtime-tuple keys (host-bound, no Agent row). agentId is
        // the HOST uuid — stable across rotations and uuid-shaped, so every
        // Postgres uuid-column lookup against it degrades to null instead of
        // throwing. Account scoping rides the key row's account_id (set
        // per scope at provision), so authz needs no agent lookup. The rtKey
        // (parsed from the provisioned name) is what orchestration gates
        // compare against stored rt- assignee/orchestrator ids.
        let runtimeKey: string | undefined;
        if (ak.host_id) {
          // P4c-4: `runtime:<label>:<key>` (label may contain spaces, never colons).
          const m = /^runtime:.*:(rt-[0-9a-f]{16})$/.exec(ak.name || '');
          runtimeKey = m ? m[1] : undefined;
        }
        return {
          // ak.key is now a SHA-256 hash, not the raw key — use the stored
          // display prefix for the hint.
          keyHint: ak.key_prefix || 'awb_***',
          agentName: ak.host_id ? ak.name : undefined,
          agentId: ak.host_id ?? undefined,
          runtimeKey,
          keyId: ak.id,
          scope: ak.scope,
          accountId: ak.account_id || undefined,
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
    const envAccountId = process.env.MCP_ACCOUNT_ID?.trim();
    if (envMatch && envAccountId) {
      return { keyId: createHash('sha256').update(token).digest('hex'), keyHint: maskMcpKey(envMatch.key), agentName: envMatch.agentName, scope: 'full', accountId: envAccountId, source: 'env' };
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
  }

  const message = challenge()
    ? 'Authentication required. Connect with OAuth or supply an AWB API key.'
    : envKeys.length === 0 && dbKeyCount === 0
      ? 'No API keys configured. Create API keys or set MCP_DEV_MODE=true for development.'
      : 'Authentication required. Provide Authorization: Bearer <api-key> header.';
  res.status(401).json({
    jsonrpc: '2.0',
    error: { code: -32001, message },
    id: null,
  });
  return null;
}
