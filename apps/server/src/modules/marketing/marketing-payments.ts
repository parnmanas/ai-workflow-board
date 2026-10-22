/**
 * 결제 어댑터 — docs/marketing.md "상태 기계" 3.
 *
 * `webhook`: 운영자 결제 엔드포인트(자기 결제 시스템 · Stripe 스크립트 …)로 서명된 실행 지시를 보낸다.
 *   - 서명: `X-AWB-Signature: t=<unix>,v1=<hex hmac-sha256(secret, "<t>.<body>")>` — 받는 쪽은 t 가 오래됐으면
 *     거부해 재전송을 막는다.
 *   - `Idempotency-Key: <spend request id>` — 재시도에도 바뀌지 않는다. 같은 키를 두 번 받으면 한 번만 결제하는 것은
 *     받는 쪽의 책임이고, 그래서 이쪽은 **자동으로 다시 보내지 않는다**.
 *   - 결과 분류: 2xx + transaction_id → paid, 4xx → failed(받는 쪽이 명시적으로 거절), 그 밖(타임아웃 · 5xx ·
 *     네트워크 · 2xx 인데 transaction_id 없음) → unknown. 모호한 결과를 failed 로 닫으면 예산이 풀려 같은 돈이
 *     두 번 나갈 수 있으므로 unknown 은 사람이 대조한다.
 * `manual`: 이 파일이 할 일이 없다 — 사람이 AWB 밖에서 결제하고 결과를 기록한다.
 * 직접 공급자(Meta Ads · Google Ads)의 어댑터는 marketing-payment-meta.ts · marketing-payment-google.ts 에 있고, 여기에는 그들이
 * 함께 쓰는 것(보내기 전 실패 · 읽기 실패 · 시간 제한 요청)만 둔다.
 */
import { createHmac } from 'node:crypto';
import { marketingError } from './marketing-errors';

export const WEBHOOK_TIMEOUT_MS = 20_000;
const DEFINITE_REFUSALS = new Set([400, 401, 402, 403, 404, 422]);
const RESPONSE_SNIPPET = 2000;

/**
 * 보내기 전에 멈췄다 — 아무것도 나가지 않았으니 failed(예산 해제)로 닫아도 이중 지출이 없다. 실행 경로는 이 오류만 failed 로
 * 닫고, 그 밖의 예외(보낸 뒤의 파싱 실패 · 프로그래밍 오류 …)는 unknown 으로 둔다 — 이미 나갔을 수 있다.
 */
export class PaymentNotSentError extends Error {
  /** 공급자가 준 글(정리 · 비밀 지움) — 사람용 응답 요약에만 `message_untrusted` 로 싣는다. */
  constructor(message: string, readonly providerMessage = '') {
    super(message);
    this.name = 'PaymentNotSentError';
  }
}

/**
 * 공급자 읽기(계획 · 연결 확인 · 실행 전 대조)가 실패했다. `retryable` 은 공급자 장애 · 시간 초과 · 호출 제한처럼 다음 사이클에
 * 다시 해 볼 만한 것, 아니면 사람이 설정(credential · 대상 · 권한)을 고쳐야 하는 것이다.
 */
export class PaymentReadError extends Error {
  readonly status: number;
  /**
   * `message` 는 서버가 쓴 문장과 상태 · 오류 코드뿐이다(에이전트까지 간다). 공급자가 준 글은 `providerMessage` 로 따로 두고
   * 감사 · 응답 요약에 `*_untrusted` 로만 싣는다(docs/marketing.md "원칙" 7).
   */
  constructor(message: string, readonly retryable: boolean, readonly providerMessage = '') {
    super(message);
    this.name = 'PaymentReadError';
    this.status = retryable ? 502 : 409;
  }
}

/** 공급자 HTTP 응답 — 본문은 JSON 이면 해석해 둔다. */
export interface ProviderReply {
  status: number;
  json: any;
  text: string;
  header(name: string): string;
}

/** 연결 자체가 안 됐거나 시간이 지났다 — 쓰기였다면 나갔는지 모른다. */
export class ProviderTransportError extends Error {
  constructor(message: string, readonly timedOut: boolean) {
    super(message);
    this.name = 'ProviderTransportError';
  }
}

/**
 * 공급자 호출 한 번 — 시간 제한, 리다이렉트를 따라가지 않음(토큰을 다른 호스트로 넘기지 않는다), 자동 재시도 없음.
 * 주소는 호출하는 쪽이 코드에 고정한 공급자 호스트뿐이다(credential 로 바꿀 수 없다). 오류 메시지에 주소를 넣지 않는다.
 */
export async function providerRequest(opts: {
  url: string;
  method: 'GET' | 'POST';
  headers: Record<string, string>;
  body?: string;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
}): Promise<ProviderReply> {
  const fetchImpl = opts.fetchImpl || fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
  let res: Response;
  try {
    res = await fetchImpl(opts.url, {
      method: opts.method,
      headers: { 'user-agent': 'awb-marketing/1', ...opts.headers },
      ...(opts.body !== undefined ? { body: opts.body } : {}),
      signal: controller.signal,
      redirect: 'manual',
    });
  } catch (e: any) {
    clearTimeout(timer);
    const timedOut = e?.name === 'AbortError';
    const code = typeof e?.cause?.code === 'string' ? ` (${e.cause.code})` : '';
    throw new ProviderTransportError(timedOut ? 'the provider did not answer in time' : `the provider is unreachable${code}`, timedOut);
  }
  let text = '';
  try {
    text = await res.text();
  } catch {
    text = '';
  } finally {
    clearTimeout(timer);
  }
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  return { status: res.status, json, text, header: (name) => res.headers.get(name) || '' };
}

export interface WebhookSecret {
  webhook_url: string;
  secret: string;
}

export type PaymentOutcome =
  | { outcome: 'paid'; transaction_id: string; receipt_url: string; response: Record<string, any> }
  | { outcome: 'failed'; error: string; response: Record<string, any> }
  | { outcome: 'unknown'; error: string; response: Record<string, any> };

/** https 만. 로컬 개발 · 테스트용으로 loopback 의 http 는 허용한다. */
export function validateWebhookUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw marketingError(400, 'payment webhook_url is not a valid URL');
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]', '::1'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw marketingError(400, 'payment webhook_url must use https');
  }
  if (url.username || url.password) throw marketingError(400, 'payment webhook_url must not embed credentials');
  return url.toString();
}

export function readWebhookSecret(fields: Record<string, string>): WebhookSecret {
  const webhookUrl = fields.webhook_url || fields.url || '';
  const secret = fields.secret || fields.signing_secret || '';
  if (!webhookUrl) throw marketingError(400, 'payment credential needs a "webhook_url" field');
  if (secret.length < 16) throw marketingError(400, 'payment credential needs a "secret" field of at least 16 characters');
  return { webhook_url: validateWebhookUrl(webhookUrl), secret };
}

export function signWebhookBody(secret: string, body: string, unixSeconds: number): string {
  const mac = createHmac('sha256', secret).update(`${unixSeconds}.${body}`, 'utf8').digest('hex');
  return `t=${unixSeconds},v1=${mac}`;
}

export async function executeWebhookPayment(opts: {
  secret: WebhookSecret;
  body: string;
  idempotencyKey: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
}): Promise<PaymentOutcome> {
  const fetchImpl = opts.fetchImpl || fetch;
  const t = Math.floor((opts.now ? opts.now() : Date.now()) / 1000);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? WEBHOOK_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetchImpl(opts.secret.webhook_url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': opts.idempotencyKey,
        'x-awb-signature': signWebhookBody(opts.secret.secret, opts.body, t),
        'user-agent': 'awb-marketing/1',
      },
      body: opts.body,
      signal: controller.signal,
      redirect: 'manual',
    });
  } catch (e: any) {
    clearTimeout(timer);
    const aborted = e?.name === 'AbortError';
    return {
      outcome: 'unknown',
      error: aborted ? 'payment endpoint timed out — the payment may or may not have happened' : `payment endpoint unreachable: ${String(e?.message || e).slice(0, 300)}`,
      response: { status: null, network_error: true },
    };
  }
  let text = '';
  try {
    text = await res.text();
  } catch {
    text = '';
  } finally {
    clearTimeout(timer);
  }
  const response: Record<string, any> = { status: res.status, body: text.slice(0, RESPONSE_SNIPPET) };
  if (res.status >= 200 && res.status < 300) {
    let parsed: any = null;
    try { parsed = JSON.parse(text); } catch { parsed = null; }
    const txn = parsed && typeof parsed.transaction_id === 'string' ? parsed.transaction_id.trim() : '';
    if (!txn) {
      return { outcome: 'unknown', error: 'payment endpoint answered 2xx without a transaction_id', response };
    }
    const receipt = parsed && typeof parsed.receipt_url === 'string' && /^https?:\/\//.test(parsed.receipt_url) ? parsed.receipt_url : '';
    return { outcome: 'paid', transaction_id: txn.slice(0, 200), receipt_url: receipt.slice(0, 1000), response };
  }
  // 받는 쪽이 "이 결제를 하지 않았다" 고 분명히 말한 경우만 failed(예산 해제)다. 408 · 409(멱등 키 중복 = 이미 처리됐을
  // 수 있다) · 425 · 429 같은 그 밖의 4xx 는 모호하므로 unknown — 사람이 대조한다.
  if (DEFINITE_REFUSALS.has(res.status)) {
    return { outcome: 'failed', error: `payment endpoint refused the payment (HTTP ${res.status})`, response };
  }
  return { outcome: 'unknown', error: `payment endpoint answered HTTP ${res.status} — the payment may or may not have happened`, response };
}
