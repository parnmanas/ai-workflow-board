/**
 * Bridge helpers that translate between Express's req/res objects and the
 * Web-standard Request/Response objects the MCP SDK's
 * WebStandardStreamableHTTPServerTransport expects.
 *
 * Extracted from mcp-server.ts and mcp.controller.ts (Phase 2 C2).
 *
 * Controller and standalone implementations were nearly identical; this
 * version adopts the (slightly more concise) controller form as the single
 * source of truth, with a `logger` callback so callers can route response
 * diagnostics through their preferred logging stack (LogService in NestJS,
 * console.error in standalone).
 *
 * Uses `any` on the Express sides so the same helpers work whether the
 * caller's type stack is @types/express, NestJS-wrapped Express, or a bare
 * http.IncomingMessage/ServerResponse pair.
 */

import { normalizeJsonRpcBody } from './json-rpc';

export type BridgeLogger = (message: string, meta?: Record<string, any>) => void;
export type BridgeErrorLogger = (message: string, meta?: Record<string, any>) => void;

const noopLogger: BridgeLogger = () => {};

export function expressToWebRequest(req: any): Request {
  const protocol = req.protocol || 'http';
  const host = (typeof req.get === 'function' ? req.get('host') : undefined)
    || req.headers?.host
    || 'localhost';
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
  }

  const init: RequestInit = { method: req.method, headers };
  if (req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'DELETE') {
    if (req.body !== undefined) {
      init.body = JSON.stringify(req.body);
    }
  }

  return new Request(url, init);
}

export interface SendWebResponseOptions {
  /** Called with info-level diagnostics (response summary, hex preview). */
  log?: BridgeLogger;
  /** Called when the SSE stream loop throws. */
  logError?: BridgeErrorLogger;
}

export async function sendWebResponse(
  webRes: Response,
  res: any,
  opts: SendWebResponseOptions = {},
): Promise<void> {
  const log = opts.log || noopLogger;
  const logError = opts.logError || noopLogger;

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
      logError('SSE stream error', { error: String(err) });
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
    log(`Response: status=${webRes.status}, type=${res.getHeader('content-type')}, size=${bodyBuf.length}`, {
      body: bodyStr.slice(0, 500),
      hex: hexPreview,
    });

    res.setHeader('content-length', bodyBuf.length);
    res.end(bodyBuf);
  }
}
