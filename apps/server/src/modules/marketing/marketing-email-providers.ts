/**
 * 메일 공급자 어댑터 — Resend · SendGrid HTTP API(docs/marketing.md "메일").
 *
 * 결과 분류: 2xx → sent, 4xx(잘못된 주소 · 거부) → failed(다시 보내지 않는다), 그 밖(5xx · 네트워크 · 타임아웃) →
 * retry(발송 큐가 몇 번 다시 시도한다). 키는 서버만 복호화해 여기로 넘긴다.
 */
import type { ComposedEmail, EmailSender } from '../../common/marketing/email';

const TIMEOUT_MS = 15_000;

export type EmailOutcome =
  | { outcome: 'sent'; message_id: string }
  | { outcome: 'failed'; error: string }
  | { outcome: 'retry'; error: string };

export interface EmailSendInput {
  provider: string;
  apiKey: string;
  sender: EmailSender;
  to: { email: string; name: string };
  message: ComposedEmail;
  fetchImpl?: typeof fetch;
}

function fromHeader(sender: EmailSender): string {
  const name = sender.from_name.replace(/["<>\r\n]/g, '').trim();
  return name ? `"${name}" <${sender.from_address}>` : sender.from_address;
}

export async function sendEmail(input: EmailSendInput): Promise<EmailOutcome> {
  const fetchImpl = input.fetchImpl || fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let res: Response;
  try {
    if (input.provider === 'resend') {
      res = await fetchImpl('https://api.resend.com/emails', {
        method: 'POST',
        headers: { authorization: `Bearer ${input.apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          from: fromHeader(input.sender),
          to: [input.to.email],
          subject: input.message.subject,
          text: input.message.text,
          ...(input.sender.reply_to ? { reply_to: input.sender.reply_to } : {}),
          headers: input.message.headers,
        }),
        signal: controller.signal,
      });
    } else if (input.provider === 'sendgrid') {
      res = await fetchImpl('https://api.sendgrid.com/v3/mail/send', {
        method: 'POST',
        headers: { authorization: `Bearer ${input.apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          personalizations: [{ to: [{ email: input.to.email, ...(input.to.name ? { name: input.to.name } : {}) }] }],
          from: { email: input.sender.from_address, name: input.sender.from_name },
          ...(input.sender.reply_to ? { reply_to: { email: input.sender.reply_to } } : {}),
          subject: input.message.subject,
          content: [{ type: 'text/plain', value: input.message.text }],
          headers: input.message.headers,
        }),
        signal: controller.signal,
      });
    } else {
      return { outcome: 'failed', error: `unknown email provider "${input.provider}"` };
    }
  } catch (e: any) {
    clearTimeout(timer);
    return { outcome: 'retry', error: e?.name === 'AbortError' ? 'email provider timed out' : `email provider unreachable: ${String(e?.message || e).slice(0, 200)}` };
  }
  let text = '';
  try { text = await res.text(); } catch { text = ''; } finally { clearTimeout(timer); }
  if (res.status >= 200 && res.status < 300) {
    let id = res.headers.get('x-message-id') || '';
    if (!id) {
      try { id = String(JSON.parse(text)?.id || ''); } catch { id = ''; }
    }
    return { outcome: 'sent', message_id: id.slice(0, 200) };
  }
  const detail = text.slice(0, 300);
  if (res.status >= 400 && res.status < 500 && res.status !== 429) {
    return { outcome: 'failed', error: `email provider refused (HTTP ${res.status}): ${detail}` };
  }
  return { outcome: 'retry', error: `email provider answered HTTP ${res.status}: ${detail}` };
}
