import type { Request } from 'express';
import type { MarketingActor } from '../../common/marketing/marketing-constants';
import { PERMISSIONS, hasPermission } from '../../common/types/permissions';
import { marketingError } from './marketing-errors';

/** 로그인한 사람 = 행위자. identity 는 세션에서만 온다(본문의 이름·id 는 믿지 않는다). */
export function userActor(req: Request): MarketingActor {
  const user = (req as any).currentUser as { id?: string; name?: string; email?: string } | undefined;
  return {
    type: 'user',
    id: user?.id || '',
    name: user?.name || user?.email || '',
    ip: (req.ip || '').slice(0, 64) || null,
  };
}

/** 목록: 명시적으로 고른 계정이 있으면 그 계정만, 아니면 접근 가능한 모든 계정. */
export function listAccountIds(req: Request): string[] {
  const accessible: string[] = (req as any).accessibleAccountIds || [];
  const requested: string | null = (req as any).requestedAccountId || null;
  if (requested && accessible.includes(requested)) return [requested];
  return accessible.length ? accessible : [((req as any).currentAccountId as string) || ''].filter(Boolean);
}

/** 상세 · 쓰기: AccountAccessService 가 객체의 실제 소유 계정으로 맞춰 둔 값. */
export function boundAccountId(req: Request): string {
  return ((req as any).currentAccountId as string) || String((req.query as any)?.account_id || '');
}

/**
 * 결제 방식(공급자 · 결제 credential)은 돈이 어디로 가는지를 정한다 — 캠페인 운영 권한(manage)만으로는
 * 바꾸지 못하고 marketing.approve_spend 가 있어야 한다.
 */
export function assertCanChangePayment(req: Request, body: Record<string, unknown> | null | undefined): void {
  if (!body || (body.payment_provider === undefined && body.payment_credential_id === undefined)) return;
  const user = (req as any).currentUser as { role?: string; permissions?: string[] } | undefined;
  if (!user || !hasPermission(user.role || '', user.permissions || [], PERMISSIONS.APPROVE_MARKETING_SPEND)) {
    throw marketingError(403, `Permission required: ${PERMISSIONS.APPROVE_MARKETING_SPEND} (payment settings decide where money goes)`);
  }
}
