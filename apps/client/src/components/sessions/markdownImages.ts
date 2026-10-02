/**
 * 에이전트 답 속의 미리보기 참조(`![alt](target)` 이미지, `[보고서](./report.html)` 같은
 * html/md 파일 링크)를 떼어 낸다.
 *
 * Codex 데스크톱 앱은 에이전트가 `![변경된 UI](E:/…/forge.png)` 처럼 **로컬 경로**를 적으면 그
 * 파일을 그려 준다 — 앱이 곧 에이전트 장비라서 가능한 일이다. AWB 화면은 다른 장비에 있으므로
 * 경로는 Runtime Host 매니저에게 바이트를 받아 그린다(`local_image` RPC). 이 모듈은 그 앞단,
 * "답의 어디가 미리보기인가" 만 판정한다(표현·로딩은 SessionTranscript).
 *
 * CLI 분기 없음 — codex·claude·opencode 모두 assistant 텍스트는 이 갈래를 그대로 탄다. 그래서
 * html/md 확장은 특정 CLI 손질 없이 전 CLI 에 적용된다. Claude 가 tool 결과로 이미지를 낼 때는
 * 기록 스캐너의 `storeImage` 통로(매니저)를 타고, 답 텍스트에 경로를 적을 때는 여기를 탄다.
 *
 * 공통 마크다운 렌더러(`renderMarkdown`)는 이미지 문법을 모른다 — 채팅방까지 바꾸지 않으려고
 * 세션 전사에서만 먼저 쪼갠다.
 */

export type MarkdownImageSegment =
  | { kind: 'text'; text: string }
  /** source: `local` 은 Runtime Host 의 파일 경로, `remote` 는 http(s) URL. */
  | { kind: 'image'; alt: string; target: string; source: 'local' | 'remote' }
  /**
   * 로컬 html/md 미리보기. `![결과](./report.html)` 와 `[결과](./report.html)` 둘 다 받는다 —
   * 에이전트는 파일 링크에 `!` 를 붙일 때도 있고 안 붙일 때도 있다. 원격 http(s) 는 여기서
   * 떼지 않는다(브라우저 직접 fetch 의 CORS·프레이밍 문제가 있어 세션 전사 범위를 넘는다).
   */
  | { kind: 'file'; alt: string; target: string; source: 'local'; fileKind: 'html' | 'markdown' };

/**
 * `![alt](` 뒤의 대상을 읽는다. 끝 위치(닫는 `)` 다음)와 대상을 돌려주고, 못 읽으면 null.
 *
 * CommonMark 는 공백 든 경로를 `<…>` 로 감싸라고 하지만 에이전트는 Windows 경로를 공백째 그냥
 * 적는다(Codex 앱도 이 경우를 못 그리는 버그가 있었다). 그래서 `<…>` 가 아니면 괄호 균형을 맞춰
 * 닫는 `)` 까지를 통째로 대상으로 보고, 끝의 `"title"` 만 떼어 낸다. 줄은 넘지 않는다.
 */
function readTarget(text: string, start: number): { end: number; target: string } | null {
  if (text[start] === '<') {
    const close = text.indexOf('>', start + 1);
    if (close < 0) return null;
    const target = text.slice(start + 1, close);
    if (target.includes('\n')) return null;
    let i = close + 1;
    const rest = /^\s*(?:"[^"\n]*"\s*)?\)/.exec(text.slice(i));
    if (!rest) return null;
    i += rest[0].length;
    return { end: i, target };
  }
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (ch === '\n') return null;
    if (ch === '(') depth++;
    else if (ch === ')') {
      if (depth === 0) {
        const raw = text.slice(start, i).replace(/\s+"[^"]*"\s*$/, '').trim();
        return raw ? { end: i + 1, target: raw } : null;
      }
      depth--;
    }
  }
  return null;
}

function classify(target: string): 'local' | 'remote' | null {
  if (/^https?:\/\//i.test(target)) return 'remote';
  // 다른 스킴(data:, javascript:, …)은 그림으로 다루지 않는다. Windows 드라이브(`E:`)와 file: 은 로컬.
  if (/^[a-z][a-z0-9+.-]+:/i.test(target) && !/^[a-z]:[\\/]/i.test(target) && !/^file:/i.test(target)) return null;
  return 'local';
}

const HTML_EXTS = new Set(['html', 'htm']);
const MD_EXTS = new Set(['md', 'markdown']);

/** 로컬 경로의 미리보기 파일 종류. 쿼리·프래그먼트가 붙어도 확장자로 판정한다. */
function fileKindOf(target: string): 'html' | 'markdown' | null {
  const m = /\.([A-Za-z0-9]+)(?:[?#].*)?$/.exec(target.trim());
  if (!m) return null;
  const ext = m[1].toLowerCase();
  if (HTML_EXTS.has(ext)) return 'html';
  if (MD_EXTS.has(ext)) return 'markdown';
  return null;
}

/** 코드 펜스(```)와 인라인 코드 안의 `![…](…)` 는 예시이지 그림이 아니다 — 그 구간을 건너뛴다. */
function codeRanges(text: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  const fence = /^(```|~~~)[^\n]*\n[\s\S]*?(?:^\1[^\n]*$|(?![\s\S]))/gm;
  let m: RegExpExecArray | null;
  while ((m = fence.exec(text)) !== null) {
    ranges.push([m.index, m.index + m[0].length]);
    if (m[0].length === 0) fence.lastIndex++;
  }
  const inline = /`[^`\n]+`/g;
  while ((m = inline.exec(text)) !== null) {
    const at = m.index;
    if (!ranges.some(([s, e]) => at >= s && at < e)) ranges.push([at, at + m[0].length]);
  }
  return ranges;
}

export function splitMarkdownImages(text: string): MarkdownImageSegment[] {
  if (!text || !text.includes('[')) return text ? [{ kind: 'text', text }] : [];
  const code = codeRanges(text);
  const inCode = (at: number) => code.some(([s, e]) => at >= s && at < e);
  const out: MarkdownImageSegment[] = [];
  let cursor = 0;
  // `!` 가 있으면 이미지 문법, 없으면 일반 링크 문법. html/md 로컬 파일은 둘 다 미리보기로 떼고,
  // 그 밖의 일반 링크(`[링크](x)`)는 렌더러가 그대로 두던 대로 글자로 둔다.
  const opener = /(!?)\[([^\]\n]*)\]\(/g;
  let m: RegExpExecArray | null;
  while ((m = opener.exec(text)) !== null) {
    if (inCode(m.index)) continue;
    const isImageSyntax = m[1] === '!';
    const alt = m[2].trim();
    const read = readTarget(text, m.index + m[0].length);
    if (!read) continue;
    const source = classify(read.target);
    if (!source) continue;
    const fileKind = source === 'local' ? fileKindOf(read.target) : null;
    // html/md 가 아닌 일반 링크(`[링크](x)`)는 미리보기가 아니다 — 여기서 건너뛰어 앞뒤 글과
    // 한 텍스트 세그먼트로 남긴다. 소비할 때만 커서를 움직여야 기존 동작과 글자 단위로 같다.
    if (!fileKind && !isImageSyntax) continue;
    if (m.index > cursor) out.push({ kind: 'text', text: text.slice(cursor, m.index) });
    if (fileKind) {
      out.push({ kind: 'file', alt, target: read.target, source: 'local', fileKind });
    } else {
      out.push({ kind: 'image', alt, target: read.target, source });
    }
    cursor = read.end;
    opener.lastIndex = read.end;
  }
  if (cursor < text.length) out.push({ kind: 'text', text: text.slice(cursor) });
  // 그림은 블록으로 그리므로, 그림에 맞닿은 줄바꿈 하나씩은 빈 줄로 남지 않게 걷어 낸다.
  return out
    .map((seg, i) => {
      if (seg.kind !== 'text') return seg;
      let t = seg.text;
      if (out[i - 1]?.kind !== 'text') t = t.replace(/^[ \t]*\r?\n/, '');
      if (out[i + 1]?.kind !== 'text') t = t.replace(/\r?\n[ \t]*$/, '');
      return { kind: 'text' as const, text: t };
    })
    .filter((seg) => seg.kind !== 'text' || seg.text.length > 0);
}
