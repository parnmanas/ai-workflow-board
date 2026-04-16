import { createParamDecorator, ExecutionContext } from '@nestjs/common';

export const CurrentWorkspaceId = createParamDecorator(
  (data: unknown, ctx: ExecutionContext): string | null => {
    const request = ctx.switchToHttp().getRequest();
    return request.currentWorkspaceId || null;
  },
);
