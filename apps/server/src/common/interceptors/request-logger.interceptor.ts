import { Injectable, NestInterceptor, ExecutionContext, CallHandler } from '@nestjs/common';
import { Observable } from 'rxjs';
import { tap, catchError } from 'rxjs/operators';
import { Request, Response } from 'express';
import { LogService } from '../../services/log.service';
import { throwError } from 'rxjs';

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

    const method = req.method;
    const url = req.originalUrl || req.url;
    const userId = (req as any).currentUser?.id || '-';
    const userName = (req as any).currentUser?.name || (req as any).currentUser?.email || '-';
    const wsId = req.headers['x-workspace-id'] || '-';
    const start = Date.now();

    // Log request
    const bodySnippet = req.body && Object.keys(req.body).length > 0
      ? JSON.stringify(req.body).slice(0, 200)
      : '';

    return next.handle().pipe(
      tap(() => {
        const duration = Date.now() - start;
        const status = res.statusCode;
        this.logService.info('HTTP', `${method} ${url} → ${status} (${duration}ms)`, {
          user: userName,
          userId,
          wsId,
          body: bodySnippet || undefined,
        });
      }),
      catchError((err) => {
        const duration = Date.now() - start;
        const status = err.status || err.getStatus?.() || 500;
        const message = err.message || 'Unknown error';
        this.logService.error('HTTP', `${method} ${url} → ${status} (${duration}ms) — ${message}`, {
          user: userName,
          userId,
          wsId,
          body: bodySnippet || undefined,
        });
        return throwError(() => err);
      }),
    );
  }
}
