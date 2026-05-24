/**
 * Tiny helper for calling a SINGLE tool on a REMOTE AWB MCP server over
 * Streamable HTTP. Wraps the SDK's Client + StreamableHTTPClientTransport
 * so the self-improvement forwarder (and the admin "Test connection"
 * probe) don't have to hand-roll the initialize handshake / session
 * lifecycle every time.
 *
 * Why MCP and not REST: the remote's REST tickets controller is gated by
 * `AuthGuard` (Bearer session) + `WorkspaceGuard` — it does not accept the
 * static / DB-issued API keys we hand out to agents. The `/mcp` endpoint,
 * by contrast, accepts `Authorization: Bearer <api-key>` (or `X-API-Key`)
 * and routes through `ApiKeyService.validateApiKey`. Speaking MCP from the
 * forwarder gives us authenticated tool access without inventing a new
 * agent-authenticated REST surface on the remote.
 *
 * Lifecycle: open one transport per call, run initialize + tools/call,
 * then terminate. The remote-improvement-ticket flow is low-volume (a
 * post-Done retrospective at most) so connection pooling is not worth the
 * complexity — every call is a fresh session, every session is closed.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

export interface RemoteMcpCallResult {
  ok: boolean;
  /** Parsed structured content from the tool result (first text-part JSON, if any). */
  data?: any;
  /** Human-readable error reason — populated whenever ok=false. */
  message?: string;
  /** HTTP-style status hint for UI ("connection", "auth", "tool", "tool_error"). */
  kind?: 'connection' | 'auth' | 'tool' | 'tool_error';
}

/**
 * Open an MCP session against `remoteUrl` (the base URL of the remote AWB —
 * the helper appends `/mcp` itself), authenticate with `apiKey`, call
 * `toolName` with `args`, and return the parsed result. Always closes the
 * session before returning, even on error paths.
 *
 * Failure surfaces:
 *   - kind='connection' — fetch / network / TLS / DNS failure
 *   - kind='auth'       — server returned an auth-shaped error during initialize
 *                         (401-shaped JSON-RPC error from the remote's MCP guard)
 *   - kind='tool'       — tool invocation threw before producing a result
 *   - kind='tool_error' — tool ran but returned `{ isError: true }` (e.g. our
 *                         own `err()` helper from the remote's tool code)
 */
export async function callRemoteMcpTool(
  remoteUrl: string,
  apiKey: string,
  toolName: string,
  args: Record<string, unknown>,
  opts?: { clientName?: string; clientVersion?: string },
): Promise<RemoteMcpCallResult> {
  const trimmed = (remoteUrl || '').trim().replace(/\/$/, '');
  if (!trimmed) return { ok: false, kind: 'connection', message: 'remoteUrl is empty' };
  if (!apiKey) return { ok: false, kind: 'auth', message: 'apiKey is empty' };

  let url: URL;
  try {
    url = new URL(`${trimmed}/mcp`);
  } catch (e: any) {
    return { ok: false, kind: 'connection', message: `Invalid remoteUrl: ${e?.message || e}` };
  }

  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        // Tag this as a server-to-server call so the remote's audit/log
        // distinguishes forwarder traffic from subagent traffic.
        'x-awb-client-type': 'self-improvement-forwarder',
      },
    },
  });

  const client = new Client({
    name: opts?.clientName || 'awb-self-improvement-forwarder',
    version: opts?.clientVersion || '1.0.0',
  });

  try {
    try {
      await client.connect(transport);
    } catch (e: any) {
      const msg = String(e?.message || e);
      // The SDK surfaces auth/initialize-time failures as plain Errors; the
      // remote's MCP controller emits a 401 with a JSON-RPC error body that
      // ends up in the message. Distinguish so the UI can show a clearer
      // "API key rejected" vs "couldn't even reach the host".
      const looksAuth = /401|unauthorized|authentic|api key|rejected/i.test(msg);
      return {
        ok: false,
        kind: looksAuth ? 'auth' : 'connection',
        message: msg,
      };
    }

    let toolResult: any;
    try {
      toolResult = await client.callTool({ name: toolName, arguments: args });
    } catch (e: any) {
      return { ok: false, kind: 'tool', message: String(e?.message || e) };
    }

    if (toolResult?.isError) {
      const text = extractFirstText(toolResult);
      return { ok: false, kind: 'tool_error', message: text || 'Remote tool returned an error' };
    }

    const text = extractFirstText(toolResult);
    let parsed: any = null;
    if (text) {
      try { parsed = JSON.parse(text); } catch { parsed = text; }
    }
    return { ok: true, data: parsed };
  } finally {
    // Best-effort termination. terminateSession() may 405 if the server
    // refuses session DELETEs (spec-allowed); transport.close() always
    // releases the local abort controller regardless.
    try { await transport.terminateSession(); } catch { /* ignore */ }
    try { await client.close(); } catch { /* ignore */ }
  }
}

function extractFirstText(toolResult: any): string {
  const content = toolResult?.content;
  if (!Array.isArray(content)) return '';
  for (const part of content) {
    if (part?.type === 'text' && typeof part.text === 'string') return part.text;
  }
  return '';
}
