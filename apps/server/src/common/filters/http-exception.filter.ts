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
      message = exception.message;
      stack = exception.stack || '';
    }

    const method = request?.method || '?';
    const url = request?.originalUrl || request?.url || '?';
    const userId = request?.currentUser?.id || '-';
    const userName = request?.currentUser?.name || request?.currentUser?.email || '-';

    if (this.logService) {
      this.logService.error('Error', `${method} ${url} → ${status} — ${message}`, {
        user: userName,
        userId,
        stack: stack ? stack.split('\n').slice(0, 5).join(' | ') : undefined,
      });
    } else {
      console.error(`[Error] ${method} ${url} → ${status} — ${message}`);
      if (stack) console.error(stack);
    }
    response.status(status).json({ error: message });
  }
}
