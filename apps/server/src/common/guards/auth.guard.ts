import { Injectable, CanActivate, ExecutionContext, UnauthorizedException, Optional } from '@nestjs/common';
import { AuthService } from '../../services/auth.service';
import { AccountAccessService } from '../../services/account-access.service';

function parsePermissions(raw: string): string[] {
  if (!raw) return [];
  try { return JSON.parse(raw); } catch { return []; }
}

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly authService: AuthService, @Optional() private readonly accounts?: AccountAccessService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const authHeader = request.headers['authorization'];
    if (!authHeader?.startsWith('Bearer ')) {
      throw new UnauthorizedException('Authentication required');
    }

    const token = authHeader.slice(7).trim();
    const user = await this.authService.getSessionUser(token);
    if (!user) {
      throw new UnauthorizedException('Invalid or expired session');
    }

    request.currentUser = {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      permissions: parsePermissions((user as any).permissions || ''),
    };

    if (this.accounts) await this.accounts.bindRequest(request);

    return true;
  }
}
