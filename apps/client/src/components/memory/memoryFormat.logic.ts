/**
 * CLI 메모리 파일 형식 — 순수 함수(docs/cli-memory.md).
 *
 * 화면은 파일 내용을 문자열로 받아 이 함수들로 읽고 고친 뒤 통째로 다시 쓴다. CLI 마다 형식이
 * 다르므로 형식 규칙은 여기 한 곳에 둔다:
 *   - Hermes `MEMORY.md` / `USER.md` — 항목을 `\n§\n` 로 잇는다. Hermes 는 그 형식으로 되돌아가지
 *     않는 파일을 보면 쓰기를 거부하므로(drift guard) 같은 규칙으로만 직렬화한다.
 *   - Claude auto memory 주제 파일 — `---` frontmatter(name / description / metadata.type) + 본문.
 *     색인 `MEMORY.md` 는 `- [제목](파일.md) — 설명` 한 줄씩.
 *   - 다른 CLI 로 옮겨 적은 내용은 관리 블록(`<!-- awb-memory:begin <id> -->` … `end`)으로 감싸
 *     같은 출처를 다시 적용하면 그 블록만 바뀐다(멱등).
 */

export const ENTRY_DELIMITER = '\n§\n';

/** Hermes 항목 분리 — hermes-agent `_parse_entries` 와 같은 규칙. */
export function parseEntries(raw: string): string[] {
  if (!raw.trim()) return [];
  return raw.split(ENTRY_DELIMITER).map((e) => e.trim()).filter(Boolean);
}

export function serializeEntries(entries: readonly string[]): string {
  return entries.map((e) => e.trim()).filter(Boolean).join(ENTRY_DELIMITER);
}

/** Python `len()` 과 같은 글자 수(코드 포인트). Hermes 상한은 이것으로 잰다. */
export function charCount(text: string): number {
  let n = 0;
  for (const _ of text) n += 1;
  return n;
}

/** Hermes 가 상한을 재는 값 — 항목을 구분자로 이은 길이. */
export function entriesCharCount(entries: readonly string[]): number {
  return charCount(entries.join(ENTRY_DELIMITER));
}

/** 이 파일이 Hermes 의 parse → serialize 를 그대로 통과하는가(아니면 Hermes 가 쓰기를 거부한다). */
export function entriesRoundTrip(raw: string): boolean {
  if (!raw.trim()) return true;
  return raw.trim() === serializeEntries(parseEntries(raw));
}

/**
 * 대략의 토큰 수. 정확한 토크나이저는 모델마다 다르므로 "매 세션이 내는 비용" 을 비교하는 데만 쓴다 —
 * 라틴 문자는 4자당 1토큰, 한글·한자 같은 비 ASCII 는 1.6자당 1토큰으로 센다.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  let ascii = 0;
  let other = 0;
  for (const ch of text) {
    if (ch.charCodeAt(0) < 128) ascii += 1;
    else other += 1;
  }
  return Math.ceil(ascii / 4 + other / 1.6);
}

// ─── frontmatter ──────────────────────────────────────────────────────────

export interface Frontmatter {
  /** frontmatter 블록이 있는가. */
  present: boolean;
  /** 평탄화한 키 → 값(`metadata.type` 처럼 한 단계 중첩은 점으로). */
  fields: Record<string, string>;
  body: string;
  /** frontmatter 원문(구분선 제외). */
  raw: string;
}

const FM_RE = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

function unquote(value: string): string {
  const v = value.trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) return v.slice(1, -1);
  return v;
}

export function parseFrontmatter(text: string): Frontmatter {
  const m = FM_RE.exec(text);
  if (!m) return { present: false, fields: {}, body: text, raw: '' };
  const fields: Record<string, string> = {};
  let parent: string | null = null;
  for (const line of m[1].split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const nested = /^\s+([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
    if (nested && parent) {
      fields[`${parent}.${nested[1]}`] = unquote(nested[2]);
      continue;
    }
    const top = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
    if (!top) continue;
    if (top[2].trim() === '') {
      parent = top[1];
    } else {
      parent = null;
      fields[top[1]] = unquote(top[2]);
    }
  }
  return { present: true, fields, body: text.slice(m[0].length), raw: m[1] };
}

/** auto memory 의 `type` — 예전 형식(최상위 `type:`)도 읽는다. */
export function memoryType(fm: Frontmatter): string {
  return fm.fields['metadata.type'] || fm.fields.type || '';
}

export const AUTO_MEMORY_TYPES = ['user', 'feedback', 'project', 'reference'] as const;

function yamlValue(value: string): string {
  return /[:#\n]|^\s|\s$|^["']/.test(value) ? JSON.stringify(value) : value;
}

/**
 * Claude auto memory frontmatter 의 name / description / type 을 바꾼다. 다른 키와 본문은 그대로 둔다.
 * frontmatter 가 없으면 만든다.
 */
export function setAutoMemoryFields(text: string, patch: { name?: string; description?: string; type?: string }): string {
  const fm = parseFrontmatter(text);
  const lines = fm.present ? fm.raw.split(/\r?\n/) : [];
  const setTop = (key: string, value: string) => {
    const i = lines.findIndex((l) => new RegExp(`^${key}\\s*:`).test(l));
    const line = `${key}: ${yamlValue(value)}`;
    if (i >= 0) lines[i] = line;
    else lines.push(line);
  };
  if (patch.name !== undefined) setTop('name', patch.name);
  if (patch.description !== undefined) setTop('description', patch.description);
  if (patch.type !== undefined) {
    const legacy = lines.findIndex((l) => /^type\s*:/.test(l));
    if (legacy >= 0) {
      lines[legacy] = `type: ${yamlValue(patch.type)}`;
    } else {
      const meta = lines.findIndex((l) => /^metadata\s*:\s*$/.test(l));
      if (meta < 0) {
        lines.push('metadata:', `  type: ${yamlValue(patch.type)}`);
      } else {
        let j = meta + 1;
        let replaced = false;
        while (j < lines.length && /^\s+/.test(lines[j])) {
          if (/^\s+type\s*:/.test(lines[j])) {
            lines[j] = `  type: ${yamlValue(patch.type)}`;
            replaced = true;
            break;
          }
          j += 1;
        }
        if (!replaced) lines.splice(meta + 1, 0, `  type: ${yamlValue(patch.type)}`);
      }
    }
  }
  const body = fm.present ? fm.body : text;
  return `---\n${lines.join('\n')}\n---\n${body.startsWith('\n') ? body.slice(1) : body}`;
}

// ─── Claude auto memory 색인 ──────────────────────────────────────────────

export interface IndexLink {
  line: number;
  title: string;
  file: string;
  hook: string;
}

const INDEX_LINK_RE = /\[([^\]]*)\]\(([^)\s]+\.md)\)/;

/** 색인의 `[제목](파일.md)` 링크. 상대 경로 파일만 본다. */
export function parseIndexLinks(index: string): IndexLink[] {
  const out: IndexLink[] = [];
  index.split(/\r?\n/).forEach((line, i) => {
    const m = INDEX_LINK_RE.exec(line);
    if (!m || /^[a-z]+:\/\//i.test(m[2])) return;
    const after = line.slice(m.index + m[0].length).replace(/^\s*[—–-]\s*/, '').trim();
    out.push({ line: i, title: m[1], file: m[2].replace(/^\.\//, ''), hook: after });
  });
  return out;
}

export interface TopicFile {
  /** 색인 기준 상대 이름(`foo.md`). */
  file: string;
  content: string;
}

function titleFromSlug(slug: string): string {
  const words = slug.replace(/\.md$/i, '').split(/[-_\s]+/).filter(Boolean);
  return words.map((w, i) => (i === 0 ? w.charAt(0).toUpperCase() + w.slice(1) : w)).join(' ') || slug;
}

/**
 * 색인을 실제 주제 파일에 맞춘다: 없는 파일을 가리키는 줄은 지우고, 색인에 없는 주제 파일은 frontmatter 의
 * 설명으로 한 줄을 덧붙인다. 남는 줄의 제목·순서·그 밖의 글은 그대로 둔다(사람이 다듬은 색인을 갈아엎지 않는다).
 */
export function rebuildIndex(index: string, topics: readonly TopicFile[]): { content: string; added: string[]; removed: string[] } {
  const names = new Set(topics.map((t) => t.file));
  const links = parseIndexLinks(index);
  const removedLines = new Set(links.filter((l) => !names.has(l.file)).map((l) => l.line));
  const removed = links.filter((l) => removedLines.has(l.line)).map((l) => l.file);
  const linked = new Set(links.filter((l) => !removedLines.has(l.line)).map((l) => l.file));
  const kept = index.split(/\r?\n/).filter((_, i) => !removedLines.has(i));
  while (kept.length && !kept[kept.length - 1].trim()) kept.pop();
  const added: string[] = [];
  for (const topic of topics) {
    if (linked.has(topic.file)) continue;
    const fm = parseFrontmatter(topic.content);
    const title = fm.fields.title || titleFromSlug(fm.fields.name || topic.file);
    const hook = fm.fields.description || firstLine(fm.body);
    kept.push(`- [${title}](${topic.file})${hook ? ` — ${hook}` : ''}`);
    added.push(topic.file);
  }
  return { content: kept.length ? `${kept.join('\n')}\n` : '', added, removed };
}

function firstLine(text: string): string {
  const line = text.split(/\r?\n/).map((l) => l.replace(/^#+\s*/, '').trim()).find(Boolean) || '';
  return line.length > 120 ? `${line.slice(0, 117)}…` : line;
}

/** `[[이름]]` 링크. */
export function wikiLinks(text: string): string[] {
  return Array.from(new Set(Array.from(text.matchAll(/\[\[([^\]\n|]+)(?:\|[^\]\n]*)?\]\]/g), (m) => m[1].trim())));
}

// ─── 관리 블록(다른 CLI 로 옮겨 적은 내용) ─────────────────────────────────

function blockMarkers(id: string): { begin: string; end: string } {
  return { begin: `<!-- awb-memory:begin ${id} -->`, end: `<!-- awb-memory:end ${id} -->` };
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 블록 id — 출처 CLI·홈·파일을 담되 주석을 깨뜨리는 글자는 뺀다. */
export function blockId(parts: readonly string[]): string {
  return parts.join(':').replace(/[^A-Za-z0-9._:/~@+-]+/g, '-').replace(/-->/g, '').slice(0, 160);
}

export function findManagedBlock(text: string, id: string): string | null {
  const { begin, end } = blockMarkers(id);
  const m = new RegExp(`${escapeRe(begin)}\\r?\\n([\\s\\S]*?)\\r?\\n?${escapeRe(end)}`).exec(text);
  return m ? m[1] : null;
}

/** 같은 id 블록이 있으면 안만 바꾸고, 없으면 끝에 붙인다. */
export function upsertManagedBlock(text: string, id: string, body: string): string {
  const { begin, end } = blockMarkers(id);
  const block = `${begin}\n${body.replace(/\s+$/, '')}\n${end}`;
  const re = new RegExp(`${escapeRe(begin)}[\\s\\S]*?${escapeRe(end)}`);
  if (re.test(text)) return text.replace(re, () => block);
  const base = text.replace(/\s+$/, '');
  return base ? `${base}\n\n${block}\n` : `${block}\n`;
}

export function removeManagedBlock(text: string, id: string): string {
  const { begin, end } = blockMarkers(id);
  const re = new RegExp(`\\n*${escapeRe(begin)}[\\s\\S]*?${escapeRe(end)}\\n?`);
  const out = text.replace(re, '\n');
  return out.replace(/^\n+/, '').replace(/\n{3,}/g, '\n\n');
}

// ─── markdown ↔ 항목 ─────────────────────────────────────────────────────

function normalizeEntry(text: string): string {
  return text.toLowerCase().replace(/[`*_>#-]/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * markdown 을 Hermes 항목으로. 제목은 버리고, 목록이면 항목 하나가 한 항목, 아니면 문단 하나가 한 항목이다.
 * frontmatter 와 관리 블록 표시는 뺀다.
 */
export function markdownToEntries(markdown: string): string[] {
  const body = parseFrontmatter(markdown).body.replace(/<!-- awb-memory:(?:begin|end)[^>]*-->/g, '');
  const out: string[] = [];
  let current: string[] = [];
  const flush = () => {
    const text = current.join('\n').trim();
    if (text) out.push(text);
    current = [];
  };
  for (const line of body.split(/\r?\n/)) {
    if (/^\s*#{1,6}\s/.test(line) || /^\s*(-{3,}|\*{3,})\s*$/.test(line)) {
      flush();
      continue;
    }
    if (!line.trim()) {
      flush();
      continue;
    }
    const bullet = /^(\s{0,1})[-*+]\s+(.*)$/.exec(line) || /^(\s{0,1})\d+[.)]\s+(.*)$/.exec(line);
    if (bullet) {
      flush();
      current.push(bullet[2]);
      continue;
    }
    current.push(line.replace(/^\s{2,4}/, ''));
  }
  flush();
  return out;
}

export function entriesToMarkdown(entries: readonly string[]): string {
  return entries.map((e) => {
    const [first, ...rest] = e.trim().split(/\r?\n/);
    return [`- ${first}`, ...rest.map((l) => `  ${l}`)].join('\n');
  }).join('\n');
}

/** 이미 있는 항목(공백·기호 무시 비교)은 빼고 새 항목만 붙인다. */
export function mergeEntries(existing: readonly string[], incoming: readonly string[]): { entries: string[]; added: number } {
  const seen = new Set(existing.map(normalizeEntry));
  const out = [...existing];
  let added = 0;
  for (const entry of incoming) {
    const key = normalizeEntry(entry);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(entry.trim());
    added += 1;
  }
  return { entries: out, added };
}

// ─── 줄 diff ─────────────────────────────────────────────────────────────

export interface DiffLine {
  type: 'eq' | 'add' | 'del';
  text: string;
}

/**
 * Myers 줄 diff. 아주 큰 입력(줄 수 합 20,000 초과)은 계산하지 않고 "전부 지우고 전부 넣기" 로 돌려준다 —
 * 메모리 파일은 그만큼 크지 않고, 화면을 멈추게 하는 것보다 낫다.
 */
export function lineDiff(before: string, after: string): DiffLine[] {
  const a = before === '' ? [] : before.split(/\r?\n/);
  const b = after === '' ? [] : after.split(/\r?\n/);
  if (a.length + b.length > 20000) {
    return [...a.map((text) => ({ type: 'del' as const, text })), ...b.map((text) => ({ type: 'add' as const, text }))];
  }
  const n = a.length;
  const m = b.length;
  const max = n + m;
  const offset = max;
  const v = new Int32Array(2 * max + 2);
  const trace: Int32Array[] = [];
  let found = false;
  for (let d = 0; d <= max && !found; d += 1) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1]) ? v[offset + k + 1] : v[offset + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x += 1;
        y += 1;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) {
        found = true;
        break;
      }
    }
  }
  // 되짚기.
  const out: DiffLine[] = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d >= 0; d -= 1) {
    const vd = trace[d];
    const k = x - y;
    const prevK = k === -d || (k !== d && vd[offset + k - 1] < vd[offset + k + 1]) ? k + 1 : k - 1;
    const prevX = vd[offset + prevK];
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      out.push({ type: 'eq', text: a[x - 1] });
      x -= 1;
      y -= 1;
    }
    if (d > 0) {
      if (x === prevX) out.push({ type: 'add', text: b[y - 1] });
      else out.push({ type: 'del', text: a[x - 1] });
    }
    x = prevX;
    y = prevY;
  }
  return out.reverse();
}

export function diffStats(diff: readonly DiffLine[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of diff) {
    if (line.type === 'add') added += 1;
    else if (line.type === 'del') removed += 1;
  }
  return { added, removed };
}

// ─── 경로 ────────────────────────────────────────────────────────────────

/** Claude Code 의 `~/.claude/projects/<key>` — 작업 폴더의 영숫자가 아닌 글자를 `-` 로. 매니저와 같은 규칙. */
export function claudeProjectKey(dir: string): string {
  return dir.replace(/[^a-zA-Z0-9]/g, '-');
}

export function hostSep(platform: string): '/' | '\\' {
  return platform === 'win32' ? '\\' : '/';
}

/** 호스트 경로 잇기 — rel 은 `/` 로 적힌 상대 경로. */
export function joinHostPath(platform: string, base: string, rel: string): string {
  const sep = hostSep(platform);
  const parts = rel.split('/').filter(Boolean);
  const trimmed = base.endsWith(sep) ? base.slice(0, -1) : base;
  return [trimmed, ...parts].join(sep);
}

/** base 아래면 `/` 로 적은 상대 경로, 아니면 null. */
export function relativeHostPath(platform: string, base: string, path: string): string | null {
  const sep = hostSep(platform);
  const root = base.endsWith(sep) ? base : base + sep;
  if (!path.startsWith(root)) return null;
  return path.slice(root.length).split(sep).join('/');
}

export function basenameOf(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

export function dirnameOf(path: string): string {
  const i = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return i > 0 ? path.slice(0, i) : path;
}

/** 새 파일 이름으로 쓸 수 있는가 — 매니저 SAFE_MD_NAME 과 같은 규칙. */
export function isSafeMemoryFileName(name: string): boolean {
  return /^[A-Za-z0-9가-힣][A-Za-z0-9가-힣._ -]{0,120}\.md$/.test(name);
}

export function slugify(text: string): string {
  const slug = text.toLowerCase().normalize('NFKC').replace(/[^a-z0-9가-힣]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
  return slug || 'memory';
}
