/**
 * 화면용 답(마크다운)을 귀로 들을 문장으로 바꾼다.
 *
 * 세션 응답 낭독 · 음성 알림 · 앱이 **모두 이 함수를 지난다** — 경로마다 규칙이 갈라지면
 * 같은 답이 단말마다 다르게 읽힌다(docs/voice-operator.md "출력").
 *
 * 에이전트의 답은 코드 블록 · 표 · 경로 · UUID · 커밋 해시 덩어리라 그대로 읽으면 몇 분짜리
 * 소음이 된다. 여기서는 **버린다**: 코드·표·URL·이미지·식별자는 화면에 남아 있고, 귀로는
 * 문장만 듣는다. 빈 결과(`''`)는 "읽을 것이 없다" 는 뜻이고, 호출자는 그때 말하지 않는다.
 *
 * 언어 중립을 지킨다 — "코드는 화면을 보세요" 같은 대체 문구를 넣지 않는다. 답이 영어일 때
 * 한국어 문구가 끼어들면 그 자체가 소음이다.
 */

/** 한 번에 읽어 줄 최대 길이. 이보다 긴 답은 문장 경계에서 자른다 — 상세는 화면에 있다. */
export const DEFAULT_MAX_SPEAKABLE_CHARS = 1500;

/** 합성 요청 한 번에 싣는 최대 길이. 짧을수록 첫 소리가 빨리 나온다. */
export const DEFAULT_SPEECH_CHUNK_CHARS = 220;

/** 첫 조각이 이보다 짧으면("네." 같은) 다음 문장과 묶는다 — 요청 하나를 아끼는 편이 낫다. */
const FIRST_CHUNK_MIN_CHARS = 40;

const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
// 커밋 해시·짧은 id: 7자 이상 hex 이면서 숫자와 a-f 를 둘 다 품은 토큰만 — "deadbeef" 같은
// 순수 문자열이나 "2026" 같은 숫자는 남긴다.
const HEX_ID_RE = /\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\b/gi;
const URL_RE = /\b(?:https?|ftp|file):\/\/[^\s)>\]]+/gi;
// 경로 후보. 진짜 경로인지는 replacer 가 가린다(날짜 2026/10/04 같은 것을 남기려고).
const PATH_RE = /(?:~|\.{1,2})?\/?(?:[\w@-][\w.@-]*\/)+[\w@-]+(?:\.[\w@-]+)*(?::\d+(?::\d+)?)?/g;
// 그림 문자. 엔진이 이름("체크 표시")을 읽어 버린다.
const EMOJI_RE = /[\p{Extended_Pictographic}\u{FE0F}\u{200D}]/gu;
// 문장 끝: 마침표류 + 닫는 따옴표/괄호. 숫자 사이의 점(1.5)은 뒤에 공백이 없어 경계가 아니다.
const SENTENCE_END_RE = /([.!?。！？…]+["'”’)\]]*)(?=\s|$)/g;

function stripFencedCode(text: string): string {
  // 닫히지 않은 펜스(스트리밍 중 잘린 답)도 끝까지 코드로 본다.
  return text.replace(/(^|\n)[ \t]*(```|~~~)[^\n]*\n[\s\S]*?(\n[ \t]*\2[ \t]*(?=\n|$)|$)/g, '$1');
}

function isTableLine(line: string): boolean {
  const t = line.trim();
  return t.startsWith('|') && t.endsWith('|') && t.length > 1;
}

/** 경로는 마지막 조각만 읽는다: `apps/server/src/x.service.ts:12` → `x.service.ts`. */
function speakPath(match: string): string {
  const bare = match.replace(/:\d+(?::\d+)?$/, '');
  const segments = bare.split('/').filter(Boolean);
  const last = segments[segments.length - 1] || '';
  if (segments.every((s) => /^\d+$/.test(s))) return match; // 2026/10/04, 3/4
  const looksLikePath = /^(?:~|\.{1,2})?\//.test(bare) || segments.length >= 3 || /\.[a-z]\w*$/i.test(last);
  return looksLikePath ? last : match;
}

function stripInline(line: string): string {
  let s = line;
  s = s.replace(/!\[[^\]]*\]\([^)]*\)/g, ''); // 이미지
  s = s.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1'); // 링크 → 글자만
  s = s.replace(/<\/?[a-z][^>]*>/gi, ''); // HTML 태그
  // 인라인 코드: 짧은 것(명령·이름)은 글자만 남기고, 긴 것(코드 조각)은 버린다.
  s = s.replace(/`([^`]*)`/g, (_m, code: string) => (code.length <= 40 ? code : ''));
  s = s.replace(URL_RE, '');
  s = s.replace(UUID_RE, '');
  s = s.replace(HEX_ID_RE, '');
  s = s.replace(PATH_RE, speakPath);
  s = s.replace(/(\*\*|__)(.+?)\1/g, '$2'); // 굵게
  s = s.replace(/(^|[\s(])[*_]([^*_\s][^*_]*?)[*_](?=[\s).,!?]|$)/g, '$1$2'); // 기울임
  s = s.replace(/~~(.+?)~~/g, '$1');
  s = s.replace(EMOJI_RE, '');
  return s;
}

function hasTerminalPunctuation(s: string): boolean {
  return /[.!?。！？…:;]["'”’)\]]*$/.test(s);
}

/**
 * 마크다운 답 → 읽을 문장. 줄 단위 구조(제목·목록·인용)는 표지만 떼고 문장으로 이어 붙인다 —
 * 목록 항목에 끝맺음이 없으면 엔진이 숨을 쉬지 않고 한 문장으로 읽으므로 마침표를 보탠다.
 */
export function toSpeakable(markdown: string, maxChars: number = DEFAULT_MAX_SPEAKABLE_CHARS): string {
  if (!markdown) return '';
  const withoutCode = stripFencedCode(markdown.replace(/\r\n?/g, '\n'));
  const sentences: string[] = [];
  for (const raw of withoutCode.split('\n')) {
    if (isTableLine(raw)) continue;
    let line = raw.trim();
    if (!line) continue;
    if (/^([-*_]\s*){3,}$/.test(line)) continue; // 가로줄
    line = line
      .replace(/^#{1,6}\s+/, '')
      .replace(/^>\s?/, '')
      .replace(/^[-*+]\s+(\[[ xX]\]\s+)?/, '')
      .replace(/^\d+[.)]\s+/, '');
    line = stripInline(line).replace(/\s+/g, ' ').replace(/\s+([,.;:!?])/g, '$1').trim();
    // 식별자를 지운 자리에 남은 빈 괄호·구두점 찌꺼기
    line = line.replace(/\(\s*[,;:]?\s*\)/g, '').replace(/^[,;:]\s*/, '').trim();
    if (!/[\p{L}\p{N}]/u.test(line)) continue;
    sentences.push(hasTerminalPunctuation(line) ? line : `${line}.`);
  }
  return truncateAtSentence(sentences.join(' '), maxChars);
}

function truncateAtSentence(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const head = text.slice(0, maxChars);
  let cut = -1;
  for (const m of head.matchAll(SENTENCE_END_RE)) cut = (m.index ?? 0) + m[0].length;
  // 첫 문장부터 상한을 넘으면 단어 경계에서 자른다 — 아무것도 안 읽는 것보다 낫다.
  if (cut <= 0) cut = head.lastIndexOf(' ') > 0 ? head.lastIndexOf(' ') : maxChars;
  return text.slice(0, cut).trim();
}

/**
 * 읽을 문장을 합성 요청 단위로 나눈다. 문장 경계에서 자르고, 짧은 문장은 상한까지 묶어
 * 요청 수를 줄인다. 한 문장이 상한을 넘으면(쉼표로만 이어진 긴 문장) 쉼표·공백에서 더 자른다.
 * 첫 조각은 짧게 둔다 — 첫 소리까지의 지연이 첫 조각의 길이에 비례한다.
 */
export function splitSpeakable(text: string, maxChunkChars: number = DEFAULT_SPEECH_CHUNK_CHARS): string[] {
  const clean = (text || '').replace(/\s+/g, ' ').trim();
  if (!clean) return [];
  const sentences: string[] = [];
  let start = 0;
  for (const m of clean.matchAll(SENTENCE_END_RE)) {
    const end = (m.index ?? 0) + m[0].length;
    sentences.push(clean.slice(start, end).trim());
    start = end;
  }
  if (start < clean.length) sentences.push(clean.slice(start).trim());

  const pieces: string[] = [];
  for (const sentence of sentences.filter(Boolean)) {
    let rest = sentence;
    while (rest.length > maxChunkChars) {
      const window = rest.slice(0, maxChunkChars);
      let cut = window.lastIndexOf(', ');
      if (cut < maxChunkChars / 3) cut = window.lastIndexOf(' ');
      cut = cut > 0 ? cut + 1 : maxChunkChars;
      pieces.push(rest.slice(0, cut).trim());
      rest = rest.slice(cut).trim();
    }
    if (rest) pieces.push(rest);
  }

  const chunks: string[] = [];
  for (const piece of pieces) {
    const i = chunks.length - 1;
    const canMerge = i >= 0
      && (i > 0 || chunks[0].length < FIRST_CHUNK_MIN_CHARS)
      && chunks[i].length + 1 + piece.length <= maxChunkChars;
    if (canMerge) chunks[i] = `${chunks[i]} ${piece}`;
    else chunks.push(piece);
  }
  return chunks;
}
