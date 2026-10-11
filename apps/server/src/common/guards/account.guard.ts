import { Injectable, CanActivate, ExecutionContext, UnauthorizedException, ForbiddenException } from '@nestjs/common';
import { ReBACService } from '../../services/rebac.service';

@Injectable()
export class AccountGuard implements CanActivate {
  constructor(private readonly rebacService: ReBACService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest();
    const user = req.currentUser;

    // A `/accounts/:accountId/...` route names its account in the path; the
    // header is what membership was checked against, so the two must agree.
    const pathAccountId = req.params?.accountId;

    // Admin bypass — per D-09: admins can access any account without a tuple
    if (user?.role === 'admin') {
      const accountId = req.headers['x-account-id'] || req.query['account_id'] || pathAccountId;
      req.currentAccountId = accountId || null;
      return true;
    }

    // Header or query param — SSE uses ?account_id= because EventSource cannot send headers
    const accountId = req.headers['x-account-id'] || req.query['account_id'];
    if (!accountId) {
      throw new UnauthorizedException('account_required');
    }

    // Check both 'member' and 'owner' relations
    const isMember = await this.rebacService.check(
      { type: 'user', id: user.id },
      'member',
      { type: 'account', id: accountId },
    );
    const isOwner = !isMember && await this.rebacService.check(
      { type: 'user', id: user.id },
      'owner',
      { type: 'account', id: accountId },
    );

    if (!isMember && !isOwner) {
      throw new ForbiddenException('account_access_denied');
    }
    if (pathAccountId && pathAccountId !== accountId) {
      throw new ForbiddenException('account_access_denied');
    }

    req.currentAccountId = accountId;
    return true;
  }
}
