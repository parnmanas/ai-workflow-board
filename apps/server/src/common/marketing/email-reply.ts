/**
 * 메일 답장 정리 — 순수 함수(docs/marketing.md "메일" → "답장").
 *
 * 답장은 외부인이 쓴 글이고, 기록하면 사이클 지시문의 비신뢰 블록과 MCP `_untrusted` 필드로 에이전트에게 간다.
 * 그런데 답장에는 그 사람이 쓴 것 말고도 우리가 보낸 원문(꼬리말의 수신거부 링크 = 그 사람의 토큰), 인용 머리의 주소,
 * 서명(전화 · 주소)이 딸려 온다. 그래서 그 사람이 새로 쓴 부분만 남기고, 메일 주소와 수신거부 링크는 지운다 —
 * 에이전트는 연락처를 보지 못한다(docs/marketing.md "원칙" 4).
 *
 * 입력은 아무나 회신 주소로 보낼 수 있는 글이다. 그래서 정규식 하나로 본문 전체를 훑지 않는다 — '@' · 링크 · 태그를
 * 찾는 곳은 전부 indexOf 로 위치를 잡고 양쪽으로 펼치는 선형 스캔이다(긴 줄 하나로 처리 시간이 제곱으로 늘지 않게).
 */

export const MAX_REPLY_CHARS = 8000;
/** 이보다 긴 답장은 앞부분만 본다 — 정리한 결과는 어차피 MAX_REPLY_CHARS 까지다. */
const MAX_INPUT_CHARS = 200_000;

const SUBJECT_PREFIX_RE = /^\s*(?:(?:re|fwd?|aw|wg|sv|답장|회신|전달)\s*(?:\[\d+\])?\s*[:：]\s*)+/i;

export function stripSubjectPrefixes(subject: string): string {
  return String(subject || '').slice(0, 1000).replace(SUBJECT_PREFIX_RE, '').trim();
}

/**
 * 자동 응답(부재중 · 휴가 · 시스템 회신)인가 — 답장으로 기록하지 않는다. RFC 3834 `Auto-Submitted` 와 흔한 표식,
 * 제목 앞머리로 본다. Outlook 이 보내는 `X-Auto-Response-Suppress` 는 "자동 응답하지 말라" 는 요청이라 표식이 아니다.
 */
export function isAutoReply(headers: Record<string, string>, subject: string): boolean {
  const auto = String(headers['auto-submitted'] || '').trim().toLowerCase();
  if (auto && auto !== 'no') return true;
  if (headers['x-autoreply'] || headers['x-autorespond'] || headers['x-autoresponder']) return true;
  const precedence = String(headers['precedence'] || headers['x-precedence'] || '').trim().toLowerCase();
  if (['bulk', 'junk', 'list', 'auto_reply'].includes(precedence)) return true;
  return /^\s*(?:auto(?:matic)?[ -]?(?:reply|response)|autoreply|out of (?:the )?office|자동\s*(?:회신|응답|답장)|부재\s*중)/i
    .test(String(subject || '').slice(0, 1000));
}

/**
 * List-Unsubscribe 의 mailto(`?subject=unsubscribe`)로 온 수신거부 요청인가. 제목만 본다 — 본문의 낱말로 추측하면
 * "수신거부 링크가 안 돼요" 같은 문의까지 처리해 버린다(그런 글은 답장으로 기록돼 사람이 본다).
 */
export function isUnsubscribeRequest(subject: string): boolean {
  const s = stripSubjectPrefixes(subject).toLowerCase().replace(/\s+/g, ' ');
  return s === 'unsubscribe' || s === '수신거부' || s === '수신 거부';
}

const ENTITIES: Record<string, string> = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,8});/gi, (whole, name: string) => {
    const key = name.toLowerCase();
    if (key in ENTITIES) return ENTITIES[key];
    const code = key.startsWith('#x') ? Number.parseInt(key.slice(2), 16) : key.startsWith('#') ? Number.parseInt(key.slice(1), 10) : NaN;
    return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
  });
}

const SKIPPED_ELEMENTS = new Set(['script', 'style', 'head', 'title']);
const BLOCK_ELEMENTS = new Set(['p', 'div', 'li', 'tr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'table', 'ul', 'ol']);

/**
 * HTML 만 있는 답장 → 글자. 인용 블록(Gmail `gmail_quote` · `<blockquote>` · Outlook `divRplyFwdMsg`/`appendonsend`)부터
 * 끝까지는 원문이라 버린다. 링크 · 마크업은 남기지 않는다(데이터로만 다룬다).
 */
export function htmlToText(html: string): string {
  const h = String(html || '').slice(0, MAX_INPUT_CHARS * 2);
  const lower = h.toLowerCase();
  let out = '';
  let i = 0;
  while (i < h.length) {
    const lt = h.indexOf('<', i);
    if (lt === -1) { out += h.slice(i); break; }
    out += h.slice(i, lt);
    const gt = h.indexOf('>', lt + 1);
    if (gt === -1) break; // 닫히지 않은 태그 — 나머지는 버린다
    const tag = lower.slice(lt + 1, gt);
    const closing = tag.startsWith('/');
    const name = /^\/?\s*([a-z0-9]+)/.exec(tag)?.[1] || '';
    if (!closing && (name === 'blockquote' || (name === 'div' && (tag.includes('gmail_quote') || tag.includes('divrplyfwdmsg') || tag.includes('appendonsend'))))) {
      break; // 인용 원문부터 끝까지 버린다
    }
    if (!closing && SKIPPED_ELEMENTS.has(name)) {
      const close = lower.indexOf(`</${name}`, gt + 1);
      const closeGt = close === -1 ? -1 : lower.indexOf('>', close);
      if (closeGt === -1) break;
      i = closeGt + 1;
      continue;
    }
    if (name === 'br' || (closing && BLOCK_ELEMENTS.has(name))) out += '\n';
    i = gt + 1;
  }
  return decodeEntities(out);
}

/** 인용 머리 — "On … wrote:" · "…님이 작성:" 등. 문자열 비교로만 본다(긴 줄에서도 선형). */
function isAttribution(candidate: string): boolean {
  if (candidate.length > 1000) return false;
  if (candidate.startsWith('On ') && candidate.endsWith(' wrote:')) return true;
  if (candidate.endsWith('작성:') && /\d{4}년/.test(candidate)) return true;
  if (candidate.startsWith('Le ') && (candidate.endsWith(' a écrit :') || candidate.endsWith(' a écrit:'))) return true;
  if (candidate.startsWith('Am ') && candidate.includes(' schrieb') && candidate.endsWith(':')) return true;
  if (candidate.startsWith('El ') && candidate.endsWith(' escribió:')) return true;
  return false;
}

/** 여기서부터 아래는 그 사람이 쓴 것이 아니다 — 인용 머리, 원문 구분선, Outlook 의 From/Sent 묶음, 서명 구분선. */
function isCutLine(lines: string[], i: number): boolean {
  const line = lines[i].trim();
  if (line === '--' || lines[i] === '-- ') return true;
  if (/^_{8,}$/.test(line)) return true;
  if (/^-{2,}\s*(?:original message|forwarded message|원본 메시지|전달된 메시지)\s*-{2,}$/i.test(line)) return true;
  if (isAttribution(line) || isAttribution(`${line} ${(lines[i + 1] || '').trim()}`)) return true;
  if (/^(?:from|보낸 ?사람)\s*:/i.test(line)) {
    for (let j = i + 1; j <= i + 4 && j < lines.length; j++) {
      if (/^(?:sent|date|to|subject|보낸 ?날짜|날짜|받는 ?사람|제목)\s*:/i.test(lines[j].trim())) return true;
    }
  }
  return false;
}

const URL_STOP = new Set([' ', '\t', '\n', '<', '>', '"', "'"]);
const ADDRESS_STOP = new Set([' ', '\t', '\n', '<', '>', '"', "'", '(', ')', ',', ';', ':', '[', ']', '@']);
const UNSUBSCRIBE_PATH = '/api/m/u/';

/** 우리 수신거부 링크(그 사람의 토큰이 들어 있다)를 통째로 지운다. */
function redactUnsubscribeLinks(text: string): string {
  let out = '';
  let last = 0;
  for (let i = text.indexOf(UNSUBSCRIBE_PATH); i !== -1; i = text.indexOf(UNSUBSCRIBE_PATH, last)) {
    let start = i;
    while (start > last && !URL_STOP.has(text[start - 1])) start--;
    let end = i + UNSUBSCRIBE_PATH.length;
    while (end < text.length && /[A-Za-z0-9_-]/.test(text[end])) end++;
    out += `${text.slice(last, start)}[수신거부 링크]`;
    last = end;
  }
  return out + text.slice(last);
}

/** 메일 주소를 지운다 — '@' 를 중심으로 양쪽으로 펼쳐 찾는다. */
function redactEmails(text: string): string {
  let out = '';
  let last = 0;
  for (let at = text.indexOf('@'); at !== -1; at = text.indexOf('@', Math.max(at + 1, last))) {
    let start = at;
    while (start > last && !ADDRESS_STOP.has(text[start - 1])) start--;
    let end = at + 1;
    while (end < text.length && !ADDRESS_STOP.has(text[end])) end++;
    while (end > at + 1 && text[end - 1] === '.') end--; // 문장 끝의 마침표
    const domain = text.slice(at + 1, end);
    if (start < at && domain.includes('.') && /\.[A-Za-z]{2,}$/.test(domain)) {
      out += `${text.slice(last, start)}[메일 주소]`;
      last = end;
    }
  }
  return out + text.slice(last);
}

/**
 * 답장 본문에서 그 사람이 새로 쓴 부분만 — 인용 머리 · 서명부터 아래와 `>` 인용 줄을 버리고, 메일 주소와 우리 수신거부 링크를
 * 지우고, 자른다. 남는 글이 없으면 ''.
 */
export function cleanReplyText(input: { text?: string; html?: string }): string {
  const source = input.text && input.text.trim() ? input.text : htmlToText(input.html || '');
  const lines = source.slice(0, MAX_INPUT_CHARS).replace(/\r\n?/g, '\n').split('\n');
  let end = lines.length;
  for (let i = 0; i < lines.length; i++) {
    if (isCutLine(lines, i)) { end = i; break; }
  }
  const kept: string[] = [];
  for (const line of lines.slice(0, end)) {
    if (line.trimStart().startsWith('>')) continue;
    const trimmed = line.trimEnd();
    if (!trimmed && (!kept.length || !kept[kept.length - 1])) continue; // 빈 줄은 하나만
    kept.push(trimmed);
  }
  let text = redactEmails(redactUnsubscribeLinks(kept.join('\n'))).trim();
  if (text.length > MAX_REPLY_CHARS) text = `${text.slice(0, MAX_REPLY_CHARS - 1)}…`;
  return text;
}
