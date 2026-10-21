/** HTTP 상태를 실은 오류 — REST 는 `status` 로 응답하고, MCP 는 메시지를 그대로 돌려준다. */
export class MarketingError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = 'MarketingError';
  }
}

export function marketingError(status: number, message: string): MarketingError {
  return new MarketingError(status, message);
}

/**
 * REST 응답용 상태 — 상태를 실은 오류(MarketingError · 다른 모듈의 makeError · RunBudgetExceededError …)는 그 상태,
 * 모르는 오류(DB · 프로그래밍 오류)는 500. 서버 오류를 404/400 으로 감추지 않는다.
 */
export function errorStatus(e: unknown): number {
  const status = (e as { status?: unknown })?.status;
  return typeof status === 'number' && status >= 400 && status < 600 ? status : 500;
}
