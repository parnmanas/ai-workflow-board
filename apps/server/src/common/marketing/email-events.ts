/**
 * 메일 공급자 webhook — 순수 함수(docs/marketing.md "메일" → "공급자 이벤트").
 *
 * 서명 검증, 공급자 이벤트를 한 모양으로 바꾸기, SendGrid Inbound Parse 의 multipart/form-data 읽기.
 *   - Resend 는 Svix 로 서명한다: `svix-id` · `svix-timestamp` · `svix-signature`, 비밀(`whsec_…`)로
 *     HMAC-SHA256(`<id>.<timestamp>.<raw body>`). 재시도도 새로 서명하므로 시각 허용은 5 분이다.
 *   - SendGrid 는 ECDSA P-256 으로 서명한다: `X-Twilio-Email-Event-Webhook-Signature`(base64 DER) ·
 *     `…-Timestamp`, 서명 대상은 timestamp 뒤에 raw body 를 붙인 바이트. Event Webhook 과 Inbound Parse 가 같은
 *     방식이고 키만 다르다. 재시도가 새로 서명되는지 공급자 문서가 말하지 않아 시각 허용을 3 일로 넓게 둔다 —
 *     처리가 상태 기반이라 같은 이벤트를 다시 받아도 결과가 같다.
 * 검증은 받은 바이트 그대로 한다. 검증이 통과하기 전에는 본문을 해석하지 않는다.
 */
import { createHmac, createPublicKey, timingSafeEqual, verify as verifySignature, type KeyObject } from 'node:crypto';

export const SVIX_TOLERANCE_SEC = 5 * 60;
export const SENDGRID_TOLERANCE_SEC = 3 * 24 * 60 * 60;
/** 발송할 때 공급자에 실어 보내는 발송 행 id 의 이름(Resend tag · SendGrid custom_args). 이벤트에 그대로 돌아온다. */
export const SEND_ID_TAG = 'awb_send_id';

function fresh(timestamp: string, now: Date, toleranceSec: number): boolean {
  if (!/^\d{1,12}$/.test(timestamp)) return false;
  return Math.abs(now.getTime() / 1000 - Number(timestamp)) <= toleranceSec;
}

/** Resend(Svix) 서명. 헤더는 공백으로 나뉜 `v1,<base64>` 여러 개일 수 있고, 하나라도 맞으면 된다. */
export function verifySvixSignature(input: {
  secret: string;
  id: string;
  timestamp: string;
  signature: string;
  body: Buffer;
  now?: Date;
  toleranceSec?: number;
}): boolean {
  const { id, timestamp, signature } = input;
  if (!input.secret || !id || !timestamp || !signature) return false;
  if (!fresh(timestamp, input.now || new Date(), input.toleranceSec ?? SVIX_TOLERANCE_SEC)) return false;
  const key = Buffer.from(input.secret.trim().replace(/^whsec_/, ''), 'base64');
  if (!key.length) return false;
  const expected = createHmac('sha256', key)
    .update(Buffer.concat([Buffer.from(`${id}.${timestamp}.`, 'utf8'), input.body]))
    .digest();
  for (const entry of signature.split(' ')) {
    const [version, value] = entry.split(',', 2);
    if (version !== 'v1' || !value) continue;
    const given = Buffer.from(value, 'base64');
    if (given.length === expected.length && timingSafeEqual(given, expected)) return true;
  }
  return false;
}

function sendGridKey(publicKey: string): KeyObject | null {
  try {
    const raw = publicKey.trim();
    if (raw.includes('BEGIN PUBLIC KEY')) return createPublicKey(raw);
    return createPublicKey({ key: Buffer.from(raw.replace(/\s+/g, ''), 'base64'), format: 'der', type: 'spki' });
  } catch {
    return null;
  }
}

/** SendGrid 서명(Event Webhook · Inbound Parse 공통). 공개 키는 SendGrid 화면이 주는 base64 그대로(PEM 도 받는다). */
export function verifySendGridSignature(input: {
  publicKey: string;
  signature: string;
  timestamp: string;
  body: Buffer;
  now?: Date;
  toleranceSec?: number;
}): boolean {
  if (!input.publicKey || !input.signature || !input.timestamp) return false;
  if (!fresh(input.timestamp, input.now || new Date(), input.toleranceSec ?? SENDGRID_TOLERANCE_SEC)) return false;
  const key = sendGridKey(input.publicKey);
  if (!key) return false;
  try {
    return verifySignature('sha256', Buffer.concat([Buffer.from(input.timestamp, 'utf8'), input.body]), key, Buffer.from(input.signature, 'base64'));
  } catch {
    return false;
  }
}

/**
 * 공급자 이벤트 하나 — 처리 쪽이 공급자를 몰라도 되게.
 *   - `bounce`      : 다시 보내도 닿지 않는다(하드 바운스 · 공급자 억제 목록) → 연락처 `bounced`
 *   - `soft_bounce` : 이번 메일만 닿지 않았다 → 발송 행에만 기록
 *   - `complaint`   : 스팸 신고 → 연락처 `complained`, 목록 신고율에 센다
 *   - `unsubscribe` : 공급자 쪽 수신거부 → 연락처 `unsubscribed`
 * `repeat` 은 공급자가 예전의 바운스 · 신고 · 수신거부 때문에 이번 메일을 보내지 않았다는 뜻이다. 연락처는 똑같이 억제하지만
 * 새 신고로 세지 않는다(같은 사람의 신고가 메일마다 다시 세어지지 않게).
 */
export interface EmailProviderEvent {
  kind: 'bounce' | 'soft_bounce' | 'complaint' | 'unsubscribe';
  repeat: boolean;
  /** 소문자 수신 주소('' = 모름). */
  recipient: string;
  /** 보낼 때 실은 발송 행 id('' = 없음). */
  send_id: string;
  /** 공급자 메시지 id — 발송 응답의 id 와 같은 값(Resend email_id, SendGrid X-Message-Id). */
  provider_message_id: string;
  occurred_at: Date;
  /** 공급자가 준 사유(수신 서버의 SMTP 응답이 섞인다 — 사람에게만 보이고 잘라서 둔다). */
  detail: string;
}

/** Resend `email.received` — 본문은 이벤트에 없어서 받은 메일 API 로 따로 읽는다. */
export interface ResendReceivedRef {
  email_id: string;
  from: string;
  to: string[];
  subject: string;
  message_id: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function clip(value: unknown, max: number): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function eventDate(value: unknown, fallback: Date): Date {
  const t = typeof value === 'number' ? value * 1000 : Date.parse(String(value ?? ''));
  return Number.isFinite(t) ? new Date(t) : fallback;
}

/** "Name <a@b.c>" · "<a@b.c>" · "a@b.c" → "a@b.c"(소문자). 주소가 아니면 ''. */
export function parseAddress(value: unknown): string {
  // 보낸 사람 머리는 아무나 쓴다 — 정규식에 넣기 전에 자른다(주소는 254자를 넘지 않는다).
  const text = String(value ?? '').slice(0, 1000).trim();
  const angle = text.match(/<([^<>\s]+@[^<>\s]+)>/);
  const candidate = (angle ? angle[1] : text).trim().toLowerCase();
  return /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/.test(candidate) && candidate.length <= 254 ? candidate : '';
}

function sendIdFrom(value: unknown): string {
  const id = typeof value === 'string' ? value.trim() : '';
  return UUID_RE.test(id) ? id.toLowerCase() : '';
}

/** Resend 의 tags 는 webhook 에서 `{name: value}` 객체다(예전 모양 `[{name, value}]` 도 읽는다). */
function resendTag(tags: unknown, name: string): string {
  if (Array.isArray(tags)) {
    const hit = tags.find((t) => t && typeof t === 'object' && (t as any).name === name);
    return hit ? String((hit as any).value ?? '') : '';
  }
  if (tags && typeof tags === 'object') return String((tags as Record<string, unknown>)[name] ?? '');
  return '';
}

export function parseResendEvent(payload: unknown, now: Date = new Date()): {
  type: string;
  events: EmailProviderEvent[];
  received: ResendReceivedRef | null;
} {
  const body = (payload && typeof payload === 'object' ? payload : {}) as Record<string, any>;
  const type = typeof body.type === 'string' ? body.type : '';
  const data = (body.data && typeof body.data === 'object' ? body.data : {}) as Record<string, any>;
  const to = (Array.isArray(data.to) ? data.to : [data.to]).map(parseAddress).filter(Boolean);
  if (type === 'email.received') {
    const emailId = clip(data.email_id, 200);
    if (!emailId) return { type, events: [], received: null };
    return {
      type,
      events: [],
      received: { email_id: emailId, from: parseAddress(data.from), to, subject: clip(data.subject, 500), message_id: clip(data.message_id, 500) },
    };
  }
  let kind: EmailProviderEvent['kind'] | null = null;
  let repeat = false;
  let detail = '';
  if (type === 'email.bounced') {
    const bounce = (data.bounce && typeof data.bounce === 'object' ? data.bounce : {}) as Record<string, any>;
    const subType = String(bounce.subType ?? bounce.sub_type ?? '');
    const hard = /^permanent$/i.test(String(bounce.type ?? ''));
    // 공급자 억제 목록 때문에 막힌 것(subType Suppressed)은 예전 바운스의 반복이다.
    repeat = /suppress/i.test(subType);
    kind = hard || repeat ? 'bounce' : 'soft_bounce';
    const diagnostic = Array.isArray(bounce.diagnosticCode) ? bounce.diagnosticCode[0] : bounce.diagnosticCode;
    detail = [`${bounce.type || 'bounce'}${subType ? `/${subType}` : ''}`, bounce.message, diagnostic].filter(Boolean).join(' — ');
  } else if (type === 'email.complained') {
    kind = 'complaint';
    detail = 'spam complaint';
  } else if (type === 'email.suppressed') {
    const suppressed = (data.suppressed && typeof data.suppressed === 'object' ? data.suppressed : {}) as Record<string, any>;
    kind = 'bounce';
    repeat = true;
    detail = [`suppressed${suppressed.type ? `/${suppressed.type}` : ''}`, suppressed.message].filter(Boolean).join(' — ');
  }
  if (!kind) return { type, events: [], received: null };
  const base = {
    kind,
    repeat,
    send_id: sendIdFrom(resendTag(data.tags, SEND_ID_TAG)),
    provider_message_id: clip(data.email_id, 200),
    occurred_at: eventDate(body.created_at, now),
    detail: clip(detail, 500),
  };
  return { type, events: (to.length ? to : ['']).map((recipient) => ({ ...base, recipient })), received: null };
}

/** SendGrid Event Webhook — 이벤트 배열. 바운스 · 드롭 · 신고 · 수신거부만 쓰고 나머지(processed · delivered · open …)는 버린다. */
export function parseSendGridEvents(payload: unknown, now: Date = new Date()): EmailProviderEvent[] {
  if (!Array.isArray(payload)) return [];
  const out: EmailProviderEvent[] = [];
  for (const raw of payload.slice(0, 5000)) {
    if (!raw || typeof raw !== 'object') continue;
    const ev = raw as Record<string, any>;
    const event = String(ev.event ?? '');
    const reason = String(ev.reason ?? '');
    let kind: EmailProviderEvent['kind'] | null = null;
    let repeat = false;
    if (event === 'bounce') {
      // type "blocked" 는 일시 거절(soft), "bounce"(또는 없음)는 영구 거절(hard).
      kind = String(ev.type ?? '') === 'blocked' ? 'soft_bounce' : 'bounce';
    } else if (event === 'dropped') {
      // SendGrid 가 보내지 않은 메일 — 그 사유가 예전의 바운스 · 신고 · 수신거부 목록이면 같은 억제를 따른다.
      if (/spam reporting/i.test(reason)) kind = 'complaint';
      else if (/unsubscribed/i.test(reason)) kind = 'unsubscribe';
      else if (/bounced address|invalid address/i.test(reason)) kind = 'bounce';
      repeat = true;
    } else if (event === 'spamreport') {
      kind = 'complaint';
    } else if (event === 'unsubscribe' || event === 'group_unsubscribe') {
      kind = 'unsubscribe';
    }
    if (!kind) continue;
    out.push({
      kind,
      repeat,
      recipient: parseAddress(ev.email),
      send_id: sendIdFrom(ev[SEND_ID_TAG]),
      provider_message_id: clip(String(ev.sg_message_id ?? '').split('.')[0], 200),
      occurred_at: eventDate(Number(ev.timestamp), now),
      detail: clip([event, ev.type, ev.status, reason, ev.bounce_classification].filter((v) => v !== undefined && v !== null && v !== '').join(' · '), 500),
    });
  }
  return out;
}

// ── multipart/form-data (SendGrid Inbound Parse) ──────────────────────────────

/**
 * multipart/form-data 에서 파일이 아닌 칸만 읽는다(첨부는 쓰지 않는다). 서명은 원래 바이트로 이미 검증한 뒤다.
 * 형식이 틀리면 지금까지 읽은 칸만 돌려준다.
 */
export function parseMultipartFields(body: Buffer, contentType: string, maxParts = 200): Record<string, Buffer> {
  const m = /boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType || '');
  const boundary = m ? (m[1] || m[2]) : '';
  const fields: Record<string, Buffer> = {};
  if (!boundary) return fields;
  const delimiter = Buffer.from(`--${boundary}`, 'utf8');
  let pos = body.indexOf(delimiter);
  for (let parts = 0; pos !== -1 && parts < maxParts; parts++) {
    let start = pos + delimiter.length;
    if (body[start] === 0x2d && body[start + 1] === 0x2d) break; // "--" = 끝
    if (body[start] === 0x0d && body[start + 1] === 0x0a) start += 2;
    else if (body[start] === 0x0a) start += 1;
    const next = body.indexOf(delimiter, start);
    if (next === -1) break;
    let end = next;
    if (body[end - 1] === 0x0a) end--;
    if (body[end - 1] === 0x0d) end--;
    const part = body.subarray(start, end);
    let split = part.indexOf('\r\n\r\n');
    let gap = 4;
    if (split === -1) { split = part.indexOf('\n\n'); gap = 2; }
    if (split !== -1) {
      const head = part.subarray(0, split).toString('utf8');
      const disposition = /content-disposition:([^\r\n]*)/i.exec(head)?.[1] || '';
      const name = /\bname="([^"]*)"/i.exec(disposition)?.[1] ?? /\bname=([^;\s]+)/i.exec(disposition)?.[1];
      const isFile = /\bfilename\*?=/i.test(disposition);
      if (name && !isFile && !(name in fields)) fields[name] = part.subarray(split + gap);
    }
    pos = next;
  }
  return fields;
}

function decode(bytes: Buffer | undefined, charset: string): string {
  if (!bytes) return '';
  try {
    return new TextDecoder(charset || 'utf-8').decode(bytes);
  } catch {
    return new TextDecoder('utf-8').decode(bytes);
  }
}

/** 원문 헤더 묶음 → 소문자 이름 · 첫 값(접힌 줄은 편다). */
export function parseRawHeaders(block: string): Record<string, string> {
  const out: Record<string, string> = {};
  const unfolded = String(block || '').replace(/\r\n/g, '\n').replace(/\n[ \t]+/g, ' ');
  for (const line of unfolded.split('\n')) {
    const i = line.indexOf(':');
    if (i <= 0) continue;
    const name = line.slice(0, i).trim().toLowerCase();
    if (name && !(name in out)) out[name] = line.slice(i + 1).trim();
  }
  return out;
}

/** 받은 메일 한 통 — 공급자가 무엇이든 답장 처리에 필요한 것만. */
export interface InboundEmail {
  from: string;
  to: string[];
  subject: string;
  text: string;
  html: string;
  headers: Record<string, string>;
  message_id: string;
  /**
   * 공급자가 보낸 사람 인증이 **실패했다고** 알렸다(보낸 사람 주소를 사칭한 메일). 모르는 것(결과 없음)은 false 다 —
   * 인증을 안 하는 도메인의 진짜 답장을 버리지 않게.
   */
  auth_failed: boolean;
}

/** SendGrid Inbound Parse 칸 → 받은 메일. `charsets`(칸별 문자 집합 JSON)를 따라 읽는다. */
export function sendGridInboundEmail(fields: Record<string, Buffer>): InboundEmail {
  let charsets: Record<string, string> = {};
  try {
    const parsed = JSON.parse(decode(fields.charsets, 'utf-8') || '{}');
    if (parsed && typeof parsed === 'object') charsets = parsed;
  } catch {
    charsets = {};
  }
  const field = (name: string) => decode(fields[name], String(charsets[name] || 'utf-8'));
  const headers = parseRawHeaders(field('headers'));
  // SendGrid 는 SPF 결과(`SPF`)와 DKIM 결과(`dkim`, 예: "{@example.com : pass}")만 준다 — 둘 다 실패면 사칭으로 본다.
  const spf = field('SPF').trim().toLowerCase();
  const dkim = field('dkim').toLowerCase();
  return {
    from: parseAddress(field('from')),
    to: field('to').split(',').map(parseAddress).filter(Boolean),
    subject: clip(field('subject'), 500),
    text: field('text'),
    html: field('html'),
    headers,
    message_id: clip(headers['message-id'] || '', 500),
    auth_failed: spf === 'fail' && !/\bpass\b/.test(dkim),
  };
}

/** Resend 받은 메일 API(`GET /emails/receiving/{id}`) 응답 → 받은 메일. 헤더는 객체로 온다. */
export function resendInboundEmail(ref: ResendReceivedRef, body: unknown): InboundEmail {
  const r = (body && typeof body === 'object' ? body : {}) as Record<string, any>;
  const headers: Record<string, string> = {};
  if (r.headers && typeof r.headers === 'object' && !Array.isArray(r.headers)) {
    for (const [k, v] of Object.entries(r.headers as Record<string, unknown>)) {
      headers[k.toLowerCase()] = Array.isArray(v) ? String(v[0] ?? '') : String(v ?? '');
    }
  }
  // Resend 는 SPF · DKIM · DMARC 결과를 준다 — 보낸 사람 도메인이 정한 정책(DMARC)이 실패면 사칭으로 본다.
  const auth = (r.authentication && typeof r.authentication === 'object' ? r.authentication : {}) as Record<string, unknown>;
  return {
    from: parseAddress(r.from) || ref.from,
    to: (Array.isArray(r.to) ? r.to : ref.to).map(parseAddress).filter(Boolean),
    subject: clip(r.subject ?? ref.subject, 500),
    text: typeof r.text === 'string' ? r.text : '',
    html: typeof r.html === 'string' ? r.html : '',
    headers,
    message_id: clip(r.message_id ?? ref.message_id, 500),
    auth_failed: String(auth.dmarc ?? '').toLowerCase() === 'fail',
  };
}
