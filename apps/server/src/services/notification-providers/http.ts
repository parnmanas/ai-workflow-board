/**
 * 알림 provider 3종(discord/slack/telegram)이 공유하는 HTTP 계층.
 *
 * raw `fetch` 에는 요청 타임아웃이 없다. 연결은 받아주고 응답은 돌려주지 않는
 * 엔드포인트 하나면 `provider.send()` 가 영원히 pending 으로 남고,
 * `UserChannelDispatcherService.dispatchForUser` 가 바인딩들을 `Promise.all` 로
 * 묶어 기다리므로 그 사용자의 팬아웃 전체가 함께 매달린다. 팬아웃을
 * fire-and-forget 이 아니라 `await` 하는 호출부에서는 그 호출부까지 영구 정지한다.
 *
 * 그래서 provider 의 모든 요청은 `fetchWithTimeout` 을 지난다. 상한은
 * `AbortSignal` 로 걸리고, 그 signal 은 응답 본문 스트림에도 그대로 붙어 있으므로
 * "헤더만 보내고 본문에서 멈추는" 상대도 같은 상한에 끊긴다.
 */

/** 기본 상한. 정상 응답에는 넉넉하고, 매달린 엔드포인트는 확실히 끊는 보수적인 값. */
const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * 상한의 상한. 오타 하나로(`15000` → `150000000`) 사실상 무제한 대기가 다시
 * 생기지 않게 막는다. 이 값 자체가 목표치는 아니다.
 */
const MAX_TIMEOUT_MS = 120_000;

export const NOTIFY_HTTP_TIMEOUT_ENV = 'AWB_NOTIFY_HTTP_TIMEOUT_MS';

/**
 * 요청 상한(ms)을 돌려준다.
 *
 * 모듈 로드 시점에 캐시하지 않고 호출할 때마다 env 를 읽는다 — 캐시하면 값을
 * 바꾸려고 재기동해야 하고, 회귀 테스트도 상한을 낮춰 실제 타임아웃을 재현할 수 없다.
 * 숫자가 아니거나 0 이하이면 조용히 기본값으로 되돌린다: 잘못 적힌 env 하나가
 * 모든 알림을 즉시 실패시키는 쪽이 상한이 없는 것보다 나을 게 없다.
 */
export function notifyHttpTimeoutMs(): number {
  const raw = process.env[NOTIFY_HTTP_TIMEOUT_ENV];
  if (raw === undefined || raw === null || String(raw).trim() === '') return DEFAULT_TIMEOUT_MS;
  const parsed = Number(String(raw).trim());
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_TIMEOUT_MS;
  return Math.min(Math.trunc(parsed), MAX_TIMEOUT_MS);
}

/**
 * 상한이 걸린 `fetch`.
 *
 * 호출마다 새 signal 을 만든다 — 재시도(discord 의 429 재요청)가 첫 시도에서
 * 이미 흘러간 시간을 물려받아 즉시 끊기면 안 되기 때문이다.
 */
export function fetchWithTimeout(
  url: string,
  init: RequestInit = {},
  timeoutMs: number = notifyHttpTimeoutMs(),
): Promise<Response> {
  return fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
}

/**
 * 상한 초과로 끊긴 요청인지 판별한다.
 *
 * `AbortSignal.timeout()` 은 `TimeoutError` DOMException 으로 거부하고, 본문을
 * 읽는 도중 끊긴 경우에도 같은 reason 이 전파된다. undici 가 소켓 단계 오류를
 * `TypeError: fetch failed` 로 감싸면서 원인을 `cause` 에 넣는 경우가 있어 한 겹 더 본다.
 */
export function isHttpTimeoutError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { name?: string; cause?: unknown };
  if (e.name === 'TimeoutError' || e.name === 'AbortError') return true;
  const cause = e.cause as { name?: string } | undefined;
  return !!cause && typeof cause === 'object' && (cause.name === 'TimeoutError' || cause.name === 'AbortError');
}

/**
 * fetch/본문 읽기 실패를 `ProviderResult.error` 에 넣을 한 줄 문구로 정규화한다.
 * 상한 초과는 상한값을 함께 적어, 운영자가 env 를 올려야 할 상황인지 바로 알 수 있게 한다.
 */
export function describeHttpError(err: unknown, timeoutMs: number): string {
  if (isHttpTimeoutError(err)) return `request timed out after ${timeoutMs}ms`;
  const e = err as { message?: string; cause?: { message?: string; code?: string } } | null;
  const base = e?.message || String(err);
  const cause = e?.cause?.code || e?.cause?.message;
  return cause ? `${base} (${cause})` : base;
}

/**
 * 응답 본문을 JSON 으로 읽는다. 파싱 실패(JSON 이 아닌 본문)는 `null` 로 흡수하지만,
 * 상한을 넘겨 끊긴 읽기는 그대로 던져 호출부의 타임아웃 정규화로 보낸다 —
 * 멈춘 본문을 "API 가 이상한 응답을 줬다" 로 오보하면 진단이 엉뚱한 곳을 향한다.
 */
export async function readJsonBody<T>(res: Response): Promise<T | null> {
  try {
    return await res.json() as T;
  } catch (err) {
    if (isHttpTimeoutError(err)) throw err;
    return null;
  }
}

/** `readJsonBody` 와 같은 규칙의 텍스트 본문 판(오류 메시지 발췌용). */
export async function readTextBody(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch (err) {
    if (isHttpTimeoutError(err)) throw err;
    return '';
  }
}
