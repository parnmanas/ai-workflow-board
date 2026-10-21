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

/** REST 응답용: 알려진 오류는 그 상태, 모르는 오류는 fallback 상태로. */
export function errorStatus(e: unknown, fallback = 400): number {
  const status = (e as { status?: unknown })?.status;
  return typeof status === 'number' && status >= 400 && status < 600 ? status : fallback;
}
