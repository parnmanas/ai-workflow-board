import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';

export interface LocalWebRequest {
  protocol: 'http:' | 'https:';
  host: 'localhost' | '127.0.0.1' | '[::1]';
  port: number;
  path: string;
  method: 'GET' | 'HEAD';
}

export function webPreviewPorts(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.slice(0, 32).filter((p): p is number => Number.isInteger(p) && p >= 1 && p <= 65535))];
}

function previewError(code: string, message: string) {
  return Object.assign(new Error(message), { code });
}

function originPath(path: unknown): path is string {
  return typeof path === 'string' && path.length <= 8192 && path.startsWith('/') && !path.startsWith('//')
    && !/[\\#\x00-\x20\x7f-\uffff]/.test(path);
}

const MAX_BYTES = 8 * 1024 * 1024;
let inFlight = 0;

function connect(ip: string, target: LocalWebRequest, signal: AbortSignal): Promise<IncomingMessage> {
  // Numeric socket destination, origin-form path and newly constructed headers. No DNS, HTTP proxy,
  // ambient credentials or automatic redirects participate in this request.
  return new Promise((resolve, reject) => {
    const options = {
      hostname: ip, port: target.port, path: target.path, method: target.method, agent: false as const, signal,
      headers: { Host: `${target.host}:${target.port}`, 'Accept-Encoding': 'identity' },
    };
    const req = target.protocol === 'https:'
      ? httpsRequest({ ...options, servername: target.host === 'localhost' ? 'localhost' : undefined, rejectUnauthorized: true }, resolve)
      : httpRequest(options, resolve);
    req.once('error', reject);
    req.once('upgrade', (_response, socket) => {
      socket.destroy();
      reject(previewError('preview_protocol', 'WebSocket upgrades are unavailable in a preview.'));
    });
    req.end();
  });
}

export async function readLocalWebPage(target: LocalWebRequest | undefined, ports: unknown) {
  if (!target || !['http:', 'https:'].includes(target.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(target.host)
      || !['GET', 'HEAD'].includes(target.method) || !originPath(target.path)) {
    throw previewError('preview_invalid', 'Invalid local web request.');
  }
  if (!webPreviewPorts(ports).includes(target.port)) {
    throw previewError('preview_port_denied', 'This port is not listed in web_preview_ports on the Runtime Host.');
  }
  if (inFlight >= 16) throw previewError('preview_busy', 'Too many concurrent web preview requests.');
  inFlight++;
  let response: IncomingMessage | undefined;
  try {
    const signal = AbortSignal.timeout(12_000);
    try {
      response = await connect(target.host === '[::1]' ? '::1' : '127.0.0.1', target, signal);
    } catch (err: any) {
      if (target.host !== 'localhost' || err.code !== 'ECONNREFUSED') throw err;
      response = await connect('::1', target, signal);
    }
    const status = response.statusCode!;
    if ([301, 302, 303, 307, 308].includes(status)) {
      const base = target.protocol + '//' + target.host + ':' + target.port;
      const location = response.headers.location;
      const next = location && URL.canParse(location, base + target.path) ? new URL(location, base + target.path) : null;
      if (!next || next.origin !== new URL(base).origin || next.username || next.password || !originPath(next.pathname + next.search)) {
        throw previewError('preview_redirect', 'The local page redirected outside this preview.');
      }
      return { status, location: next.pathname + next.search + next.hash };
    }
    if (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity') {
      throw previewError('preview_protocol', 'The local server must support uncompressed HTTP responses.');
    }
    const chunks: Buffer[] = [];
    let size = 0;
    if (target.method === 'GET' && Number(response.headers['content-length']) > MAX_BYTES) {
      throw previewError('too_large', 'The preview resource exceeds 8 MiB.');
    }
    for await (const chunk of response) {
      size += chunk.length;
      if (size > MAX_BYTES) throw previewError('too_large', 'The preview resource exceeds 8 MiB.');
      chunks.push(chunk);
    }
    return { status, mime_type: response.headers['content-type'], base64: Buffer.concat(chunks, size).toString('base64') };
  } catch (err: any) {
    if (err.code?.startsWith('preview_') || err.code === 'too_large') throw err;
    throw previewError('preview_unavailable', target.protocol === 'https:'
      ? 'Could not reach the local HTTPS server with a trusted certificate.'
      : 'The local HTTP server is unreachable or did not respond in time.');
  } finally {
    response?.destroy();
    inFlight--;
  }
}
