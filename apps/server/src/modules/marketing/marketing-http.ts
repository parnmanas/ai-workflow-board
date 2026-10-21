import type { Request } from 'express';
import type { MarketingActor } from '../../common/marketing/marketing-constants';

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
