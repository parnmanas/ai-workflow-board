import { Injectable, CanActivate, ExecutionContext, ForbiddenException } from '@nestjs/common';
import { AuthGuard } from './auth.guard';

@Injectable()
export class AdminGuard implements CanActivate {
  constructor(private readonly authGuard: AuthGuard) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // First authenticate
    await this.authGuard.canActivate(context);

    const request = context.switchToHttp().getRequest();
    if (request.currentUser?.role !== 'admin') {
      throw new ForbiddenException('Admin access required');
    }

    return true;
  }
}
