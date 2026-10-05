import { createParamDecorator, ExecutionContext } from '@nestjs/common';

export const CurrentAccountId = createParamDecorator(
  (data: unknown, ctx: ExecutionContext): string | null => {
    const request = ctx.switchToHttp().getRequest();
    return request.currentAccountId || null;
  },
);
