// Minimal MCP HTTP JSON-RPC client used by virtual agents.
//
// Behavior that matters for AWB:
//   - Sends Authorization: Bearer <api-key> (McpController.authenticate path).
//   - Declares capabilities.experimental['awb/schemaVersion'] = { version: 2 }
//     on initialize; otherwise McpController rejects non-internal clients with
//     code -32000 "MCP proxy schemaVersion mismatch".
//   - Captures mcp-session-id from initialize response and sends it back on
//     every subsequent request (transport requires this for session reuse).
//   - Accepts both application/json and text/event-stream responses because
//     WebStandardStreamableHTTPServerTransport may pick either per request.

import { traceEvent } from './trace.mjs';

const DEFAULT_CLIENT_INFO = { name: 'qa-virtual-agent', version: '1.0.0' };
const DEFAULT_PROTOCOL_VERSION = '2024-11-05';

export class McpClient {
  constructor({ baseUrl, apiKey, clientInfo = DEFAULT_CLIENT_INFO }) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.apiKey = apiKey;
    this.clientInfo = clientInfo;
    this.sessionId = null;
    this.initialized = false;
    this._nextId = 1;
  }

  _id() {
    return this._nextId++;
  }

  _buildHeaders() {
    const h = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    };
    if (this.apiKey) h['Authorization'] = `Bearer ${this.apiKey}`;
    if (this.sessionId) h['mcp-session-id'] = this.sessionId;
    return h;
  }

  async _post(body) {
    // Auto-trace every MCP request/response pair so the QA UI can show the
    // exact wire calls a virtual agent made. `id` from the JSON-RPC body is
    // the correlation key (paired on the UI side by `agent_name`+id).
    const reqId = body.id ?? null;
    const method = body.method;
    traceEvent('mcp-request', {
      agent: this.clientInfo?.name,
      session_id: this.sessionId,
      method,
      id: reqId,
      params: body.params,
    });
    const t0 = Date.now();
    const res = await fetch(`${this.baseUrl}/mcp`, {
      method: 'POST',
      headers: this._buildHeaders(),
      body: JSON.stringify(body),
    });
    const newSid = res.headers.get('mcp-session-id');
    if (newSid) this.sessionId = newSid;

    const ctype = (res.headers.get('content-type') || '').toLowerCase();
    let parsed = null;
    if (ctype.includes('text/event-stream')) {
      const text = await res.text();
      const frames = text.split('\n\n').filter(Boolean);
      for (const frame of frames) {
        for (const line of frame.split('\n')) {
          if (line.startsWith('data:')) {
            const raw = line.slice(5).trim();
            try {
              parsed = JSON.parse(raw);
              break;
            } catch {
              /* keep scanning */
            }
          }
        }
        if (parsed) break;
      }
    } else {
      parsed = await res.json().catch(() => null);
    }

    traceEvent('mcp-response', {
      agent: this.clientInfo?.name,
      session_id: this.sessionId,
      method,
      id: reqId,
      status: res.status,
      duration_ms: Date.now() - t0,
      result: parsed?.result,
      error: parsed?.error,
    });

    return { status: res.status, data: parsed };
  }

  async initialize() {
    if (this.initialized) return;
    const resp = await this._post({
      jsonrpc: '2.0',
      id: this._id(),
      method: 'initialize',
      params: {
        protocolVersion: DEFAULT_PROTOCOL_VERSION,
        capabilities: {
          experimental: { 'awb/schemaVersion': { version: 2 } },
        },
        clientInfo: this.clientInfo,
      },
    });
    if (resp.status >= 400) {
      throw new Error(`MCP initialize failed: HTTP ${resp.status} ${JSON.stringify(resp.data)}`);
    }
    if (resp.data?.error) {
      throw new Error(`MCP initialize error: ${JSON.stringify(resp.data.error)}`);
    }
    // Transport requires a notifications/initialized message before normal ops.
    await fetch(`${this.baseUrl}/mcp`, {
      method: 'POST',
      headers: this._buildHeaders(),
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }),
    });
    this.initialized = true;
    return resp.data?.result;
  }

  async listTools() {
    if (!this.initialized) await this.initialize();
    const resp = await this._post({
      jsonrpc: '2.0',
      id: this._id(),
      method: 'tools/list',
      params: {},
    });
    if (resp.data?.error) {
      throw new Error(`tools/list error: ${JSON.stringify(resp.data.error)}`);
    }
    return resp.data?.result?.tools || [];
  }

  /**
   * Call an MCP tool by name. Returns the parsed JSON payload when the tool
   * uses the ok()/err() helpers (content[0].text is JSON); falls back to the
   * raw result otherwise. Throws on protocol-level errors; tool-level errors
   * (isError:true) are returned as { error: ... } so callers can branch.
   */
  async callTool(name, args = {}) {
    if (!this.initialized) await this.initialize();
    const resp = await this._post({
      jsonrpc: '2.0',
      id: this._id(),
      method: 'tools/call',
      params: { name, arguments: args },
    });
    if (resp.data?.error) {
      throw new Error(`tools/call ${name} protocol error: ${JSON.stringify(resp.data.error)}`);
    }
    const result = resp.data?.result;
    if (!result) return null;
    const text = result.content?.[0]?.text;
    if (typeof text === 'string') {
      try {
        const parsed = JSON.parse(text);
        if (result.isError) return { error: parsed, isError: true };
        return parsed;
      } catch {
        return { raw: text, isError: !!result.isError };
      }
    }
    return result;
  }

  async close() {
    if (!this.sessionId) return;
    try {
      await fetch(`${this.baseUrl}/mcp`, {
        method: 'DELETE',
        headers: this._buildHeaders(),
      });
    } catch {
      /* ignore */
    }
    this.sessionId = null;
    this.initialized = false;
  }
}
