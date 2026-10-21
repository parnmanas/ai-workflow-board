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

/** 목록: account_id 를 명시하면 그 실행 키만, 아니면 전부(공통 업무 — docs/ownership.md). */
export function listAccountIds(req: Request): string[] {
  const accessible: string[] = (req as any).accessibleAccountIds || [];
  const requested: string | null = (req as any).requestedAccountId || null;
  if (requested && accessible.includes(requested)) return [requested];
  return accessible.length ? accessible : [((req as any).currentAccountId as string) || ''].filter(Boolean);
}

/** 상세 · 쓰기: AccountAccessService 가 객체의 실행 키(account_id)로 맞춰 둔 값. */
export function boundAccountId(req: Request): string {
  return ((req as any).currentAccountId as string) || String((req.query as any)?.account_id || '');
}

/**
 * 돈에 관한 설정 — 한도 · 2인 승인 임계값 · 수취인 허용 목록 · 통화 · 결제 방식. 이것을 바꾸는 것은 지출 승인과 같은 무게다
 * (임계값을 0 으로 내리면 혼자 승인할 수 있고, 수취인을 넣으면 돈이 갈 곳이 생긴다) — 그래서 캠페인 운영 권한(manage)만으로는
 * 바꾸지 못하고 marketing.approve_spend 가 있어야 한다.
 */
export const MONEY_SETTING_KEYS = [
  'currency', 'budget_total_minor', 'budget_period', 'budget_period_minor', 'max_transaction_minor',
  'dual_approval_threshold_minor', 'payees', 'payment_provider', 'payment_credential_id',
] as const;

export function assertCanChangeMoneySettings(req: Request, body: Record<string, unknown> | null | undefined): void {
  if (!body) return;
  const touched = MONEY_SETTING_KEYS.filter((k) => body[k] !== undefined);
  if (!touched.length) return;
  const user = (req as any).currentUser as { role?: string; permissions?: string[] } | undefined;
  if (!user || !hasPermission(user.role || '', user.permissions || [], PERMISSIONS.APPROVE_MARKETING_SPEND)) {
    throw marketingError(403, `Permission required: ${PERMISSIONS.APPROVE_MARKETING_SPEND} to change ${touched.join(', ')} (money settings)`);
  }
}

/** 보기 — 캠페인 운영자(manage)나 돈 승인자(approve_spend) 중 하나면 된다. 승인자도 무엇을 승인하는지 봐야 한다. */
export function assertCanViewMarketing(req: Request): void {
  const user = (req as any).currentUser as { role?: string; permissions?: string[] } | undefined;
  const ok = !!user && [PERMISSIONS.MANAGE_MARKETING, PERMISSIONS.APPROVE_MARKETING_SPEND]
    .some((p) => hasPermission(user.role || '', user.permissions || [], p));
  if (!ok) throw marketingError(403, `Permission required: ${PERMISSIONS.MANAGE_MARKETING} or ${PERMISSIONS.APPROVE_MARKETING_SPEND}`);
}

export function userHas(req: Request, permission: string): boolean {
  const user = (req as any).currentUser as { role?: string; permissions?: string[] } | undefined;
  return !!user && hasPermission(user.role || '', user.permissions || [], permission);
}
