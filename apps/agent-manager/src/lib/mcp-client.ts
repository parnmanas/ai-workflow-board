import { REQUEST_TIMEOUT_MS } from './constants.js';
import { log } from './logging.js';
import type { AwbConfig } from './rest.js';

export interface McpCallOptions {
  timeoutMs?: number;
  clientName?: string;
}

/**
 * Open a short-lived MCP session against the AWB server, call a single tool,
 * and tear the session down. Returns the JSON-RPC response envelope (with
 * `result` field) or throws on transport / protocol failure.
 *
 * ticket 23253aeb: `config.apiKey`가 stale/스코프 이탈된 per-agent 키면(spawn
 * 시점에 캡처되어 세션 수명 내내 재사용 — rest.ts의 chat-room 발신 함수들과
 * 동일한 실패 클래스) `initialize`가 401/403을 반환해 핸드셰이크가 세션 id를
 * 아예 얻지 못한다. `config.retryApiKey`가 설정돼 있고 실패한 키와 다르면,
 * 포기하기 전에 전체 핸드셰이크를 그 키로 한 번 더 재시도한다 — rest.ts와
 * 동일한 1회 폴백 방식.
 */
export async function callMcpTool(
  config: AwbConfig,
  toolName: string,
  toolArgs: Record<string, unknown> | undefined,
  opts: McpCallOptions = {},
): Promise<any> {
  const base = (config?.url ?? '').replace(/\/$/, '');
  if (!base) throw new Error('callMcpTool: config.url missing');
  if (!config?.apiKey) throw new Error('callMcpTool: config.apiKey missing');
  const url = `${base}/mcp`;
  const timeoutMs = opts.timeoutMs ?? REQUEST_TIMEOUT_MS;

  const makeHeaders = (apiKey: string): Record<string, string> => ({
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
  });
  const doInitialize = (apiKey: string) => fetch(url, {
    method: 'POST',
    headers: makeHeaders(apiKey),
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-03-26',
        capabilities: { experimental: { 'awb/schemaVersion': { version: 2 } } },
        clientInfo: { name: opts.clientName || 'awb-agent-manager-tool', version: '1.0.0' },
      },
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });

  let apiKey = config.apiKey;
  let initResp = await doInitialize(apiKey);
  if (!initResp.ok && (initResp.status === 401 || initResp.status === 403)
    && config.retryApiKey && config.retryApiKey !== apiKey) {
    log(`MCP tool ${toolName} initialize ${initResp.status} with session key — retrying with manager key`);
    apiKey = config.retryApiKey;
    initResp = await doInitialize(apiKey);
  }
  if (!initResp.ok) {
    throw new Error(`initialize HTTP ${initResp.status}`);
  }
  const sid = initResp.headers.get('mcp-session-id');
  if (!sid) throw new Error('initialize did not return Mcp-Session-Id');
  await initResp.text().catch(() => null);

  const sessionHeaders: Record<string, string> = { ...makeHeaders(apiKey), 'Mcp-Session-Id': sid };

  await fetch(url, {
    method: 'POST',
    headers: sessionHeaders,
    body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    signal: AbortSignal.timeout(timeoutMs),
  }).then((r) => r.text().catch(() => null));

  let result: any = null;
  try {
    const callResp = await fetch(url, {
      method: 'POST',
      headers: sessionHeaders,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: toolName, arguments: toolArgs ?? {} },
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!callResp.ok) {
      throw new Error(`tools/call ${toolName} HTTP ${callResp.status}`);
    }
    result = await parseStreamableResponse(callResp);
  } finally {
    fetch(url, {
      method: 'DELETE',
      headers: sessionHeaders,
      signal: AbortSignal.timeout(timeoutMs),
    })
      .then((r) => r.text().catch(() => null))
      .catch(() => {
        /* server TTL will reap */
      });
  }

  return result;
}

/**
 * AWB's MCP endpoint returns either application/json or a one-frame SSE
 * (text/event-stream). Both carry the same `{ jsonrpc, id, result }` envelope.
 */
async function parseStreamableResponse(resp: Response): Promise<any | null> {
  const contentType = resp.headers.get('content-type') ?? '';
  const text = await resp.text();
  if (!text) return null;

  if (contentType.includes('text/event-stream')) {
    for (const line of text.split('\n')) {
      const m = /^data:\s*(.+)$/.exec(line);
      if (m) {
        try {
          return JSON.parse(m[1]);
        } catch {
          /* keep scanning */
        }
      }
    }
    return null;
  }

  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Convenience: extract the structured tool result out of the JSON-RPC envelope.
 * AWB tools return `{ content: [{ type: 'text', text: '<json>' }] }`; the inner
 * text is JSON-encoded. Returns null when the envelope shape is unexpected.
 */
export function unwrapToolResult(rpcResponse: any): any {
  const content = rpcResponse?.result?.content;
  if (!Array.isArray(content) || content.length === 0) return null;
  const text = content[0]?.text;
  if (typeof text !== 'string') return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * Fire-and-forget tool call. Logs failures but never throws.
 */
export async function fireAndForgetTool(
  config: AwbConfig,
  toolName: string,
  toolArgs: Record<string, unknown> | undefined,
): Promise<void> {
  try {
    await callMcpTool(config, toolName, toolArgs);
  } catch (err: any) {
    log(`MCP tool ${toolName} failed (fire-and-forget): ${err?.message ?? err}`);
  }
}
