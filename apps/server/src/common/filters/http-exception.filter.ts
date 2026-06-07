import { ExceptionFilter, Catch, ArgumentsHost, HttpException, HttpStatus } from '@nestjs/common';
import { Response } from 'express';
import { LogService } from '../../services/log.service';

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private logService: LogService | null = null;

  setLogService(logService: LogService) {
    this.logService = logService;
  }

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<any>();

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let message = 'Internal Server Error';
    let stack = '';

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const res = exception.getResponse();
      message = typeof res === 'string' ? res : (res as any).message || (res as any).error || message;
    } else if (exception instanceof Error) {
      // body-parser / raw-body throw plain Errors carrying a numeric `status`
      // (or `statusCode`) and a machine `type` — most importantly
      // `entity.too.large` (413) when an upload exceeds the configured limit.
      // Without this branch those surfaced as a generic 500 "request entity
      // too large", so the client could not tell an oversize upload apart from
      // a real server fault. Honor the carried status and give 413 a friendly,
      // user-facing message (ticket ff3e7337 — clear oversize error).
      const carried = (exception as any).status ?? (exception as any).statusCode;
      const bodyType = (exception as any).type;
      if (typeof carried === 'number' && carried >= 400 && carried < 600) {
        status = carried;
      }
      if (bodyType === 'entity.too.large' || status === HttpStatus.PAYLOAD_TOO_LARGE) {
        status = HttpStatus.PAYLOAD_TOO_LARGE;
        message = 'File too large — the upload exceeds the maximum allowed size.';
      } else {
        message = exception.message;
      }
      stack = exception.stack || '';
    }

    const method = request?.method || '?';
    const url = request?.originalUrl || request?.url || '?';
    const userId = request?.currentUser?.id || '-';
    const userName = request?.currentUser?.name || request?.currentUser?.email || '-';

    // Skip persisting failures of the log-query endpoints themselves — every
    // stored Error row would otherwise balloon on the next poll that pulls
    // the full log list, same recursion problem as RequestLoggerInterceptor.
    // We still flush to console so docker/pm2 collectors see it.
    const reqPath: string = request?.path || (typeof url === 'string' ? url.split('?')[0] : '');
    const isLogEndpoint = reqPath === '/api/admin/logs' || reqPath.startsWith('/api/admin/logs/');

    // HTTP semantics — 5xx is the server's fault (real `error`),
    // 4xx is the client's (Bad Request, Unauthorized, NotFound, …)
    // and gets logged at `debug` so the in-memory ring still keeps
    // an audit row but stdout stays quiet. The historical alternative
    // (every exception → `error`) drowned the console in routine MCP
    // client probes — most notably MCP SDK's RFC 8414 OAuth Authorization
    // Server Metadata probe (`GET /mcp/.well-known/oauth-authorization-server`)
    // which every connecting Claude Code / Cursor / ChatGPT client fires
    // to negotiate auth scheme; AWB is API-key based so the 404 is the
    // correct response, but it's not an error. Same logic covers 401s
    // from agents booting with a stale credential, 404s from clients
    // hitting a non-existent ticket, etc — meaningful in the admin log
    // viewer, noise in `docker logs`.
    const level: 'error' | 'debug' = status >= 500 ? 'error' : 'debug';

    if (this.logService && !isLogEndpoint) {
      this.logService.log(level, 'Error', `${method} ${url} → ${status} — ${message}`, {
        user: userName,
        userId,
        stack: stack ? stack.split('\n').slice(0, 5).join(' | ') : undefined,
      });
    } else if (level === 'error') {
      // Fall-through console output reserved for the no-LogService /
      // log-endpoint-recursion paths AND only for true server errors —
      // a 4xx coming through this branch (extremely rare) stays silent
      // to match the gated-logging path above.
      console.error(`[Error] ${method} ${url} → ${status} — ${message}`);
      if (stack) console.error(stack);
    }
    response.status(status).json({ error: message });
  }
}
