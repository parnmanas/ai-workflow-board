/**
 * JSON-RPC field-order normalization helpers.
 *
 * Some MCP clients (notably OpenAI Codex / rmcp) validate JSON-RPC payloads
 * with strict field ordering. The MCP SDK emits { result, jsonrpc, id } while
 * the spec conventionally orders them { jsonrpc, id, result }. These helpers
 * rewrite outbound payloads to match the conventional order.
 *
 * Extracted from mcp-server.ts and mcp.controller.ts (Phase 2 C1).
 */

export function reorderJsonRpc(msg: any): any {
  if (!msg || typeof msg !== 'object' || !msg.jsonrpc) return msg;
  const ordered: any = { jsonrpc: msg.jsonrpc };
  if ('id' in msg) ordered.id = msg.id;
  if ('method' in msg) { ordered.method = msg.method; if ('params' in msg) ordered.params = msg.params; }
  if ('result' in msg) ordered.result = msg.result;
  if ('error' in msg) ordered.error = msg.error;
  return ordered;
}

export function normalizeJsonRpcBody(raw: string): string {
  try {
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== 'object') return raw;
    if (Array.isArray(obj)) return JSON.stringify(obj.map(reorderJsonRpc));
    return JSON.stringify(reorderJsonRpc(obj));
  } catch { return raw; }
}
