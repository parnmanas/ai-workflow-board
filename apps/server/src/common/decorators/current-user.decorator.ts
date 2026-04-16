import { createParamDecorator, ExecutionContext } from '@nestjs/common';

export interface CurrentUserData {
  id: string;
  name: string;
  email: string;
  role: string;
  permissions: string[];
}

export const CurrentUser = createParamDecorator(
  (data: unknown, ctx: ExecutionContext): CurrentUserData | undefined => {
    const request = ctx.switchToHttp().getRequest();
    return request.currentUser;
  },
);
