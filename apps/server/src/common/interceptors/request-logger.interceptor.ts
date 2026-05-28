import { Injectable, NestInterceptor, ExecutionContext, CallHandler } from '@nestjs/common';
import { Observable } from 'rxjs';
import { tap, catchError } from 'rxjs/operators';
import { Request, Response } from 'express';
import { LogService } from '../../services/log.service';
import { throwError } from 'rxjs';

const REDACTED_HEADERS = new Set([
  'authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'x-agent-key',
  'x-auth-token',
  'proxy-authorization',
]);

const REDACTED_BODY_KEYS = new Set([
  'password',
  'current_password',
  'new_password',
  'old_password',
  'token',
  'api_key',
  'apikey',
  'secret',
]);

const MAX_PAYLOAD_BYTES = 10_000;

function sanitizeHeaders(headers: Record<string, any> | undefined): Record<string, any> {
  if (!headers) return {};
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(headers)) {
    out[k] = REDACTED_HEADERS.has(k.toLowerCase()) ? '***' : v;
  }
  return out;
}

function sanitizeBody(body: any): any {
  if (body == null || typeof body !== 'object') return body;
  if (Array.isArray(body)) return body;
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(body)) {
    out[k] = REDACTED_BODY_KEYS.has(k.toLowerCase()) ? '***' : v;
  }
  return out;
}

function capPayload(value: any): string | undefined {
  if (value == null) return undefined;
  let serialized: string;
  try {
    serialized = typeof value === 'string' ? value : JSON.stringify(value);
  } catch {
    serialized = String(value);
  }
  if (serialized.length <= MAX_PAYLOAD_BYTES) return serialized;
  return serialized.slice(0, MAX_PAYLOAD_BYTES) + `...[truncated: ${serialized.length - MAX_PAYLOAD_BYTES} bytes]`;
}

@Injectable()
export class RequestLoggerInterceptor implements NestInterceptor {
  constructor(private readonly logService: LogService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const ctx = context.switchToHttp();
    const req = ctx.getRequest<Request>();
    const res = ctx.getResponse<Response>();

    // Skip SSE/streaming endpoints (headers already sent — interceptor tap causes crash)
    if (req.path.startsWith('/api/events')) return next.handle();
    if (req.path.startsWith('/mcp')) return next.handle();
    // Skip log-query endpoints. Logging the query itself stuffs the returned
    // log array into `resBody`, which on the NEXT poll gets stuffed into
    // *that* request's log, and so on — the buffer grows quadratically until
    // it fills up the 2000-entry ring and every entry is a nested snapshot
    // of earlier entries. Polling the Server Logs page was enough to make
    // the symptom obvious. The admin UI doesn't lose anything: request
    // counts are still visible as the other rows in the viewer.
    if (req.path === '/api/admin/logs' || req.path.startsWith('/api/admin/logs/')) return next.handle();

    const method = req.method;
    const url = req.originalUrl || req.url;
    const userId = (req as any).currentUser?.id || '-';
    const userName = (req as any).currentUser?.name || (req as any).currentUser?.email || '-';
    const wsId = req.headers['x-workspace-id'] || '-';
    const start = Date.now();

    const reqHeaders = sanitizeHeaders(req.headers as any);
    const reqBody = capPayload(sanitizeBody(req.body));

    return next.handle().pipe(
      tap((responseBody) => {
        const duration = Date.now() - start;
        const status = res.statusCode;
        const resHeaders = sanitizeHeaders(res.getHeaders() as any);
        const resBody = capPayload(responseBody);
        this.logService.info('HTTP', `${method} ${url} → ${status} (${duration}ms)`, {
          user: userName,
          userId,
          wsId,
          status,
          duration,
          reqHeaders,
          reqBody,
          resHeaders,
          resBody,
        });
      }),
      catchError((err) => {
        const duration = Date.now() - start;
        const status = err.status || err.getStatus?.() || 500;
        const message = err.message || 'Unknown error';
        const resHeaders = sanitizeHeaders(res.getHeaders() as any);
        // Same level split as AllExceptionsFilter — 5xx is a real
        // server error worth surfacing on stdout, 4xx is a client
        // outcome the admin log viewer still records (ring) but
        // shouldn't spam `docker logs`. Without this split every
        // 401 from an agent with a rotated credential lit up the
        // console at error level even though the auth guard's
        // rejection is normal.
        const level: 'error' | 'debug' = status >= 500 ? 'error' : 'debug';
        this.logService.log(level, 'HTTP', `${method} ${url} → ${status} (${duration}ms) — ${message}`, {
          user: userName,
          userId,
          wsId,
          status,
          duration,
          reqHeaders,
          reqBody,
          resHeaders,
          error: message,
        });
        return throwError(() => err);
      }),
    );
  }
}
