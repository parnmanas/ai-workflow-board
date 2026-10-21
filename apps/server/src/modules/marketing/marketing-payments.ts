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
 */
import { createHmac } from 'node:crypto';
import { marketingError } from './marketing-errors';

export const WEBHOOK_TIMEOUT_MS = 20_000;
const RESPONSE_SNIPPET = 2000;

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
  if (res.status >= 400 && res.status < 500) {
    return { outcome: 'failed', error: `payment endpoint refused the payment (HTTP ${res.status})`, response };
  }
  return { outcome: 'unknown', error: `payment endpoint answered HTTP ${res.status} — the payment may or may not have happened`, response };
}
