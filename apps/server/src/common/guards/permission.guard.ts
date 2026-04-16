import { Injectable, CanActivate, ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthGuard } from './auth.guard';
import { PERMISSION_KEY } from '../decorators/require-permission.decorator';
import { hasPermission } from '../types/permissions';

@Injectable()
export class PermissionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly authGuard: AuthGuard,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // First authenticate
    await this.authGuard.canActivate(context);

    const requiredPermission = this.reflector.getAllAndOverride<string>(PERMISSION_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (!requiredPermission) return true;

    const request = context.switchToHttp().getRequest();
    const user = request.currentUser;

    if (!hasPermission(user.role, user.permissions, requiredPermission)) {
      throw new ForbiddenException(`Permission required: ${requiredPermission}`);
    }

    return true;
  }
}
