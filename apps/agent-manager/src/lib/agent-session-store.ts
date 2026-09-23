// Agent Session(CLI 직접 세션) — 이 장비의 CLI 세션 저장소 리더.
//
// AWB 는 세션 전문을 저장하지 않는다. Claude Code 는 `$CLAUDE_CONFIG_DIR/projects/<cwd>/<id>.jsonl`,
// Codex 는 `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-<ts>-<id>.jsonl` 에 전문을 갖고 있으므로
// 여기서 그 파일을 읽어 (1) 목록(제목·cwd·최근 활동) 과 (2) 트랜스크립트 이벤트를 만든다.
// 이벤트 모양은 라이브 스트림(agent-session-runner)과 같다 — UI 는 둘을 구분하지 않는다.
//
// opencode 는 파일이 아니라 SQLite(`~/.local/share/opencode/opencode.db`, WAL)에 세션을 넣는다.
// 그 파일을 직접 열지 않고 opencode 자신의 `opencode db <SQL> --format json` 으로 질의한다 —
// 스키마의 주인이 opencode 이고, WAL 락도 그쪽이 관리하게 두는 편이 안전하다.
//
// Hermes 는 자체 저장소 포맷을 모르므로 AWB 화면에서 만든 세션만 로컬 인덱스
// (`$AWB_AGENT_MANAGER_HOME/agent-sessions.json`)로 기억한다. claude/codex 도 AWB 가
// 만든 세션은 인덱스에 남겨 제목을 보존한다(파일 스캔 결과와 병합).

import { execFile } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { mkdir, open, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';

import { AGENT_MANAGER_HOME } from './constants.js';

export interface SessionSummary {
  cli: string;
  session_id: string;
  cwd: string;
  title: string;
  created_at: string | null;
  updated_at: string;
  source: 'cli' | 'awb';
  size_bytes?: number;
}

export interface HistoryEvent {
  id: string;
  seq: number;
  turn_id: string;
  type: string;
  payload: Record<string, unknown>;
  created_at: string;
}

export interface HistoryResult {
  session: SessionSummary | null;
  events: HistoryEvent[];
  truncated: boolean;
}

export interface AwbSessionIndexEntry {
  cli: string;
  session_id: string;
  cwd: string;
  title: string;
  created_at: string;
  updated_at: string;
}

export interface AgentSessionStoreOptions {
  claudeHome?: string;
  codexHome?: string;
  /** opencode 의 DB 질의 실행기(기본: `opencode db <sql> --format json`). 테스트가
   *  실제 CLI 없이 목록 매핑을 검증할 수 있도록 주입 가능하게 둔다. */
  opencodeQuery?: (sql: string) => Promise<string>;
  indexPath?: string;
  listLimit?: number;
  historyEventLimit?: number;
  env?: NodeJS.ProcessEnv;
}

const HEAD_BYTES = 256 * 1024;
const TAIL_BYTES = 64 * 1024;
const DEFAULT_LIST_LIMIT = 200;
/** opencode db 질의 상한. 목록 한 번이 세션 화면을 오래 붙잡지 않게 한다. */
const OPENCODE_QUERY_TIMEOUT_MS = 10_000;

const execFileAsync = promisify(execFile);

/** 기본 opencode 질의 실행기 — CLI 가 자기 DB 를 열게 하고 JSON 만 받아온다. */
async function defaultOpencodeQuery(sql: string): Promise<string> {
  const { stdout } = await execFileAsync(
    'opencode',
    ['db', sql, '--format', 'json', '--log-level', 'ERROR'],
    { timeout: OPENCODE_QUERY_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024, windowsHide: true },
  );
  return stdout;
}

/** opencode 의 시각 컬럼은 epoch ms 정수다. 숫자로 못 읽히면 null. */
function toEpochMs(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}
const DEFAULT_HISTORY_LIMIT = 4000;
const TITLE_MAX = 120;
const TOOL_TEXT_MAX = 16_000;
/**
 * 기록 이벤트 하나가 직렬화됐을 때의 상한. codex 의 tool 출력은 문자열이 아니라 content block
 * 배열로 오는데, 그 경로가 잘리지 않아 이벤트 하나가 1.3MiB 를 넘기도 했다. 응답 전체는 서버의
 * JSON 본문 상한(10MB)을 넘으면 413 으로 버려지고 화면은 타임아웃 에러만 본다.
 */
const HISTORY_EVENT_PAYLOAD_MAX_CHARS = 32_000;
/**
 * 기록 응답 본문의 바이트 상한(가장 최근 것부터 채운다). 서버 상한(10MB)보다 넉넉히 낮게 잡아
 * base64·헤더 같은 부대 비용을 감안한다. 개별 이벤트를 아무리 잘라도 수천 건이 쌓이면 넘을 수
 * 있으므로 마지막 방어선으로 둔다.
 */
const HISTORY_BODY_MAX_BYTES = 6 * 1024 * 1024;
const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;

export function resolveClaudeHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), '.claude');
}

export function resolveCodexHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.CODEX_HOME?.trim() || join(homedir(), '.codex');
}

function isRecord(value: unknown): value is Record<string, any> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n…[truncated ${text.length - max} chars]` : text;
}

function cleanTitle(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, TITLE_MAX);
}

/** 프롬프트 텍스트로 쓸 수 없는 CLI 내부 마크업(명령 XML, 환경 컨텍스트, 지침 주입). */
function isSyntheticPrompt(text: string): boolean {
  const t = text.trimStart();
  return t.startsWith('<') || t.startsWith('# AGENTS.md') || t.startsWith('[Request interrupted');
}

/** Claude 툴 이름 → ACP 툴 kind 근사치. */
export function claudeToolKind(name: string): string {
  switch (name) {
    case 'Read': case 'Glob': case 'NotebookRead': case 'LS': return 'read';
    case 'Grep': case 'WebSearch': return 'search';
    case 'Edit': case 'MultiEdit': case 'Write': case 'NotebookEdit': return 'edit';
    case 'Bash': case 'BashOutput': case 'KillShell': return 'execute';
    case 'WebFetch': return 'fetch';
    case 'Task': case 'Agent': return 'delegate';
    case 'TodoWrite': case 'ExitPlanMode': case 'EnterPlanMode': return 'think';
    default: return name.startsWith('mcp__') ? 'other' : 'other';
  }
}

function codexToolKind(name: string): string {
  if (/shell|exec|command|bash/i.test(name)) return 'execute';
  if (/read|view|cat|list|ls/i.test(name)) return 'read';
  if (/search|grep|find/i.test(name)) return 'search';
  if (/edit|write|patch|apply/i.test(name)) return 'edit';
  if (/fetch|web|http/i.test(name)) return 'fetch';
  return 'other';
}

function textOfBlocks(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((block) => {
      if (typeof block === 'string') return block;
      if (!isRecord(block)) return '';
      if (typeof block.text === 'string') return block.text;
      if (typeof block.thinking === 'string') return block.thinking;
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

async function readChunk(path: string, position: number, length: number): Promise<string> {
  const fh = await open(path, 'r');
  try {
    const buf = Buffer.alloc(length);
    const { bytesRead } = await fh.read(buf, 0, length, position);
    return buf.subarray(0, bytesRead).toString('utf8');
  } finally {
    await fh.close();
  }
}

function parseLines(chunk: string, dropFirst = false, dropLast = false): Record<string, any>[] {
  const lines = chunk.split('\n');
  if (dropFirst) lines.shift();
  if (dropLast) lines.pop();
  const out: Record<string, any>[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (isRecord(parsed)) out.push(parsed);
    } catch {
      /* partial / non-JSON line */
    }
  }
  return out;
}

async function walk(dir: string, depth: number, out: string[]): Promise<void> {
  if (depth < 0) return;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) await walk(full, depth - 1, out);
    else if (entry.isFile() && entry.name.endsWith('.jsonl')) out.push(full);
  }
}

/**
 * 이벤트 payload 를 크기 안으로 접는다. 문자열은 자르고, 배열·객체는 개수를 제한한다.
 * (러너의 boundedValue 와 같은 규칙 — 그쪽은 라이브 스트림, 이쪽은 CLI 홈 기록이다.)
 */
export function boundHistoryPayload(payload: Record<string, unknown>): Record<string, unknown> {
  const bounded = boundValue(payload, 0) as Record<string, unknown>;
  if (JSON.stringify(bounded).length <= HISTORY_EVENT_PAYLOAD_MAX_CHARS) return bounded;
  // 구조를 아무리 접어도 큰 경우(거대한 배열 등) — 내용을 미리보기로 대체한다.
  const preview = JSON.stringify(bounded).slice(0, 4_000);
  return { truncated: true, preview };
}

function boundValue(value: unknown, depth: number): unknown {
  if (value === undefined || value === null) return value;
  if (typeof value === 'string') return truncate(value, TOOL_TEXT_MAX);
  if (typeof value !== 'object') return value;
  if (depth > 6) return '[nested]';
  if (Array.isArray(value)) return value.slice(0, 100).map((entry) => boundValue(entry, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>).slice(0, 100)) {
    out[key] = boundValue(entry, depth + 1);
  }
  return out;
}

/**
 * 직렬화 바이트가 상한에 들어오도록 **오래된 것부터** 버린다 — 화면은 끝(최근)부터 읽으므로
 * 최근 대화를 지키는 편이 쓸모 있다. 한 건도 못 담을 만큼 큰 이벤트만 남는 경우에도 최소 한 건은 남긴다.
 */
/**
 * 마지막 `limit` 건만 들고 있는 링 버퍼. 기록 파일은 수백 MB 까지 자라는데(실측: codex rollout 353MB)
 * 어차피 화면은 최근 것만 쓴다 — 전부 배열에 쌓은 뒤 잘라내면 파일 크기에 비례해 메모리를 먹는다
 * (353MB 파일에서 최대 RSS 586MB). 파싱하면서 창(window) 밖으로 나간 건 즉시 버린다.
 * `total` 은 버린 것까지 포함한 전체 개수 — seq 를 절대 위치로 유지하고 생략 건수를 세는 데 쓴다.
 */
export class BoundedHistory<T> {
  #items: T[] = [];
  #start = 0;
  #total = 0;
  constructor(private readonly limit: number) {}

  push(item: T): void {
    this.#total += 1;
    if (this.limit <= 0) return;
    this.#items.push(item);
    if (this.#items.length > this.limit) {
      // 앞을 자주 shift 하면 O(n²) 가 되므로 창의 두 배까지 모았다가 한 번에 접는다.
      this.#start += 1;
      if (this.#start >= this.limit) {
        this.#items = this.#items.slice(this.#start);
        this.#start = 0;
      }
    }
  }

  /** 남아 있는(최근) 항목. */
  items(): T[] {
    return this.#start > 0 ? this.#items.slice(this.#start) : this.#items;
  }

  /** 버려진 것까지 포함한 전체 개수. */
  get total(): number {
    return this.#total;
  }

  /** 남아 있는 첫 항목의 절대 인덱스(0-based). */
  get offset(): number {
    return this.#total - (this.#items.length - this.#start);
  }
}

export function fitHistoryBytes<T extends { payload: Record<string, unknown> }>(events: T[], maxBytes: number): T[] {
  let total = 0;
  let firstKept = events.length;
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const size = Buffer.byteLength(JSON.stringify(events[i])) + 1;
    if (total + size > maxBytes && firstKept < events.length) break;
    total += size;
    firstKept = i;
    if (total > maxBytes) break;
  }
  return events.slice(firstKept);
}

export class AgentSessionStore {
  readonly claudeHome: string;
  readonly codexHome: string;
  readonly indexPath: string;
  readonly #listLimit: number;
  readonly #historyLimit: number;
  readonly #opencodeQuery: (sql: string) => Promise<string>;

  constructor(options: AgentSessionStoreOptions = {}) {
    const env = options.env ?? process.env;
    this.claudeHome = options.claudeHome ?? resolveClaudeHome(env);
    this.codexHome = options.codexHome ?? resolveCodexHome(env);
    this.indexPath = options.indexPath ?? join(AGENT_MANAGER_HOME, 'agent-sessions.json');
    this.#listLimit = options.listLimit ?? DEFAULT_LIST_LIMIT;
    this.#historyLimit = options.historyEventLimit ?? DEFAULT_HISTORY_LIMIT;
    this.#opencodeQuery = options.opencodeQuery ?? defaultOpencodeQuery;
  }

  // ─── 목록 ───────────────────────────────────────────────────────────────

  async listSessions(cli: string): Promise<SessionSummary[]> {
    const index = await this.#readIndex();
    const indexed = index.filter((e) => e.cli === cli);
    let scanned: SessionSummary[] = [];
    if (cli === 'claude') scanned = await this.#listClaude();
    else if (cli === 'codex') scanned = await this.#listCodex();
    else if (cli === 'opencode') scanned = await this.#listOpencode();
    const byId = new Map<string, SessionSummary>();
    for (const s of scanned) byId.set(s.session_id, s);
    for (const e of indexed) {
      const existing = byId.get(e.session_id);
      if (existing) {
        // AWB 가 만든 세션: 인덱스의 제목이 파일의 첫 프롬프트보다 낫다(사용자 지정).
        byId.set(e.session_id, { ...existing, source: 'awb', title: e.title || existing.title });
      } else {
        byId.set(e.session_id, {
          cli, session_id: e.session_id, cwd: e.cwd, title: e.title,
          created_at: e.created_at, updated_at: e.updated_at, source: 'awb',
        });
      }
    }
    return Array.from(byId.values())
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
      .slice(0, this.#listLimit);
  }

  async #listClaude(): Promise<SessionSummary[]> {
    const projectsDir = join(this.claudeHome, 'projects');
    let dirs: string[];
    try {
      dirs = await readdir(projectsDir);
    } catch {
      return [];
    }
    const files: Array<{ path: string; mtimeMs: number; size: number }> = [];
    for (const dir of dirs) {
      const full = join(projectsDir, dir);
      let entries;
      try {
        entries = await readdir(full, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        // agent-*.jsonl 은 서브에이전트(sidechain) 전용 파일이라 세션이 아니다.
        if (!entry.isFile() || !entry.name.endsWith('.jsonl') || entry.name.startsWith('agent-')) continue;
        const path = join(full, entry.name);
        try {
          const st = await stat(path);
          if (st.size > 0) files.push({ path, mtimeMs: st.mtimeMs, size: st.size });
        } catch {
          /* vanished */
        }
      }
    }
    files.sort((a, b) => b.mtimeMs - a.mtimeMs);
    const out: SessionSummary[] = [];
    for (const file of files) {
      if (out.length >= this.#listLimit) break;
      const meta = await this.#claudeMeta(file.path, file.size);
      if (!meta) continue;
      out.push({
        cli: 'claude',
        session_id: meta.sessionId,
        cwd: meta.cwd,
        title: meta.title,
        created_at: meta.createdAt,
        updated_at: new Date(file.mtimeMs).toISOString(),
        source: 'cli',
        size_bytes: file.size,
      });
    }
    return out;
  }

  async #claudeMeta(path: string, size: number): Promise<{ sessionId: string; cwd: string; title: string; createdAt: string | null } | null> {
    const headLen = Math.min(size, HEAD_BYTES);
    const head = parseLines(await readChunk(path, 0, headLen), false, size > headLen);
    let sessionId = '';
    let cwd = '';
    let createdAt: string | null = null;
    let firstPrompt = '';
    let customTitle = '';
    const absorb = (rec: Record<string, any>) => {
      if (!sessionId && typeof rec.sessionId === 'string') sessionId = rec.sessionId;
      if (!cwd && typeof rec.cwd === 'string') cwd = rec.cwd;
      if (!createdAt && typeof rec.timestamp === 'string') createdAt = rec.timestamp;
      if (rec.type === 'custom-title' && typeof rec.customTitle === 'string') customTitle = rec.customTitle;
      if (rec.type === 'summary' && typeof rec.summary === 'string' && !customTitle) customTitle = rec.summary;
      if (!firstPrompt && rec.type === 'user' && !rec.isSidechain && isRecord(rec.message)) {
        const text = textOfBlocks(rec.message.content);
        if (text && !isSyntheticPrompt(text)) firstPrompt = text;
      }
    };
    for (const rec of head) absorb(rec);
    if (size > headLen) {
      const tailLen = Math.min(size - headLen, TAIL_BYTES);
      const tail = parseLines(await readChunk(path, size - tailLen, tailLen), true, false);
      for (const rec of tail) absorb(rec);
    }
    if (!sessionId) sessionId = basename(path, '.jsonl');
    if (!SESSION_ID_RE.test(sessionId)) return null;
    if (!firstPrompt && !customTitle) return null; // 빈 세션(프롬프트 없음)
    return { sessionId, cwd, title: cleanTitle(customTitle || firstPrompt), createdAt };
  }

  /**
   * opencode 세션 목록. 파일 스캔이 아니라 opencode 자신의 DB 도구에 SQL 을 던진다:
   * `opencode db "SELECT …" --format json`. 직접 SQLite 를 여는 것보다 이쪽이 나은 이유는
   * (1) 스키마가 opencode 것이고 (2) WAL 락을 그쪽이 관리하며 (3) agent-manager 에
   * sqlite 의존성을 새로 들이지 않아도 되기 때문이다.
   *
   * 실패(미설치·스키마 변경·타임아웃)는 빈 목록으로 접는다 — 목록 조회 하나가 세션 화면
   * 전체를 못 쓰게 만들면 안 된다. `time_archived` 가 찍힌 세션은 opencode 에서 보관
   * 처리된 것이므로 제외한다.
   */
  async #listOpencode(): Promise<SessionSummary[]> {
    const sql =
      'SELECT id, directory, title, time_created, time_updated FROM session '
      + 'WHERE time_archived IS NULL AND parent_id IS NULL '
      + `ORDER BY time_updated DESC LIMIT ${this.#listLimit}`;
    let stdout: string;
    try {
      stdout = await this.#opencodeQuery(sql);
    } catch {
      return [];
    }
    let rows: unknown;
    try {
      rows = JSON.parse(stdout);
    } catch {
      return [];
    }
    if (!Array.isArray(rows)) return [];
    const out: SessionSummary[] = [];
    for (const raw of rows) {
      if (!raw || typeof raw !== 'object') continue;
      const row = raw as Record<string, unknown>;
      const id = typeof row.id === 'string' ? row.id : '';
      const cwd = typeof row.directory === 'string' ? row.directory : '';
      if (!id || !cwd) continue;
      // 시각은 epoch ms 정수다. 못 읽으면 그 세션만 버리지 말고 updated 를 created 로,
      // 둘 다 없으면 0 으로 접어 목록에는 남긴다(정렬 맨 뒤로 간다).
      const created = toEpochMs(row.time_created);
      const updated = toEpochMs(row.time_updated) ?? created ?? 0;
      out.push({
        cli: 'opencode',
        session_id: id,
        cwd,
        title: (typeof row.title === 'string' && row.title.trim()) || '(제목 없음)',
        created_at: created === null ? null : new Date(created).toISOString(),
        updated_at: new Date(updated).toISOString(),
        source: 'cli',
      });
    }
    return out;
  }

  async #listCodex(): Promise<SessionSummary[]> {
    const paths: string[] = [];
    await walk(join(this.codexHome, 'sessions'), 4, paths);
    const files: Array<{ path: string; mtimeMs: number; size: number }> = [];
    for (const path of paths) {
      if (!basename(path).startsWith('rollout-')) continue;
      try {
        const st = await stat(path);
        if (st.size > 0) files.push({ path, mtimeMs: st.mtimeMs, size: st.size });
      } catch {
        /* vanished */
      }
    }
    files.sort((a, b) => b.mtimeMs - a.mtimeMs);
    const out: SessionSummary[] = [];
    for (const file of files) {
      if (out.length >= this.#listLimit) break;
      const meta = await this.#codexMeta(file.path, file.size);
      if (!meta) continue;
      out.push({
        cli: 'codex',
        session_id: meta.sessionId,
        cwd: meta.cwd,
        title: meta.title,
        created_at: meta.createdAt,
        updated_at: new Date(file.mtimeMs).toISOString(),
        source: 'cli',
        size_bytes: file.size,
      });
    }
    return out;
  }

  async #codexMeta(path: string, size: number): Promise<{ sessionId: string; cwd: string; title: string; createdAt: string | null } | null> {
    const headLen = Math.min(size, HEAD_BYTES);
    const head = parseLines(await readChunk(path, 0, headLen), false, size > headLen);
    let sessionId = '';
    let cwd = '';
    let createdAt: string | null = null;
    let firstPrompt = '';
    for (const rec of head) {
      const payload = isRecord(rec.payload) ? rec.payload : {};
      if (rec.type === 'session_meta') {
        sessionId = typeof payload.id === 'string' ? payload.id : sessionId;
        cwd = typeof payload.cwd === 'string' ? payload.cwd : cwd;
        createdAt = typeof payload.timestamp === 'string' ? payload.timestamp : createdAt;
      } else if (!firstPrompt && rec.type === 'response_item' && payload.type === 'message' && payload.role === 'user') {
        const text = textOfBlocks(payload.content);
        if (text && !isSyntheticPrompt(text)) firstPrompt = text;
      } else if (!firstPrompt && rec.type === 'event_msg' && payload.type === 'user_message' && typeof payload.message === 'string') {
        if (!isSyntheticPrompt(payload.message)) firstPrompt = payload.message;
      }
    }
    if (!sessionId) {
      const match = basename(path, '.jsonl').match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i);
      if (match) sessionId = match[1];
    }
    if (!SESSION_ID_RE.test(sessionId) || !cwd) return null;
    if (!firstPrompt) return null;
    return { sessionId, cwd, title: cleanTitle(firstPrompt), createdAt };
  }

  // ─── 파일 찾기 ──────────────────────────────────────────────────────────

  async findSessionFile(cli: string, sessionId: string): Promise<string | null> {
    if (!SESSION_ID_RE.test(sessionId)) return null;
    if (cli === 'claude') {
      const projectsDir = join(this.claudeHome, 'projects');
      let dirs: string[];
      try {
        dirs = await readdir(projectsDir);
      } catch {
        return null;
      }
      for (const dir of dirs) {
        const candidate = join(projectsDir, dir, `${sessionId}.jsonl`);
        try {
          await stat(candidate);
          return candidate;
        } catch {
          /* next */
        }
      }
      return null;
    }
    if (cli === 'codex') {
      const paths: string[] = [];
      await walk(join(this.codexHome, 'sessions'), 4, paths);
      return paths.find((p) => basename(p, '.jsonl').endsWith(`-${sessionId}`)) ?? null;
    }
    return null;
  }

  // ─── 기록 ───────────────────────────────────────────────────────────────

  async readHistory(cli: string, sessionId: string): Promise<HistoryResult> {
    const indexEntry = (await this.#readIndex()).find((e) => e.cli === cli && e.session_id === sessionId) ?? null;
    const path = await this.findSessionFile(cli, sessionId);
    if (!path) {
      if (!indexEntry) return { session: null, events: [], truncated: false };
      return {
        session: { cli, session_id: sessionId, cwd: indexEntry.cwd, title: indexEntry.title, created_at: indexEntry.created_at, updated_at: indexEntry.updated_at, source: 'awb' },
        events: [],
        truncated: false,
      };
    }
    const st = await stat(path);
    const parsed = cli === 'claude' ? await this.#claudeHistory(path, sessionId) : await this.#codexHistory(path, sessionId);
    // payload 크기 정리는 여기 한 곳에서만 한다 — CLI 별 파서가 각자 자르면 한 갈래만 빠뜨려도
    // (실제로 codex 의 배열형 tool 출력이 그랬다) 응답 전체가 서버 상한을 넘어 버려진다.
    // 파서는 이미 최근 `historyLimit` 건만 들고 온다(BoundedHistory) — seq/id 는 절대 위치를 유지해
    // 같은 세션을 다시 읽어도 앞부분이 변하지 않는 한 같은 이벤트가 같은 id 를 갖는다.
    const events = parsed.events.map((e, i) => {
      const absolute = parsed.offset + i + 1;
      return { ...e, seq: absolute, id: `${sessionId}:${absolute}` };
    });
    const kept = fitHistoryBytes(events, HISTORY_BODY_MAX_BYTES);
    const omitted = parsed.total - kept.length;
    const truncated = omitted > 0;
    if (truncated) {
      kept.unshift({
        id: `${sessionId}:truncated`, seq: 0, turn_id: '', type: 'system',
        payload: { text: `Earlier history omitted (${omitted} events).` },
        created_at: kept[0]?.created_at ?? new Date().toISOString(),
      });
    }
    const title = indexEntry?.title || parsed.title;
    return {
      session: {
        cli, session_id: sessionId, cwd: parsed.cwd || indexEntry?.cwd || '', title,
        created_at: parsed.createdAt, updated_at: new Date(st.mtimeMs).toISOString(),
        source: indexEntry ? 'awb' : 'cli', size_bytes: st.size,
      },
      events: kept,
      truncated,
    };
  }

  async #claudeHistory(path: string, sessionId: string): Promise<{ events: HistoryEvent[]; total: number; offset: number; title: string; cwd: string; createdAt: string | null }> {
    const events = new BoundedHistory<HistoryEvent>(this.#historyLimit);
    let title = '';
    let firstPrompt = '';
    let cwd = '';
    let createdAt: string | null = null;
    let turnId = '';
    // payload 크기는 **담는 시점에** 정리한다 — 나중에 한 번에 하면 창 안에 원본 blob 이 그대로 남아
    // 파일이 클수록 메모리를 먹는다(353MB 세션에서 최대 RSS 584MB). 파서가 갈래마다 따로 자르다
    // 하나를 빠뜨렸던 전례가 있어(codex 배열형 tool 출력) 갈래가 아니라 이 한 줄에서만 자른다.
    const push = (type: string, payload: Record<string, unknown>, createdAtRec: string | undefined) => {
      events.push({ id: '', seq: 0, turn_id: turnId, type, payload: boundHistoryPayload(payload), created_at: createdAtRec || createdAt || new Date().toISOString() });
    };
    const done = (title: string, cwd: string, createdAt: string | null) =>
      ({ events: events.items(), total: events.total, offset: events.offset, title, cwd, createdAt });
    for await (const rec of this.#lines(path)) {
      if (!cwd && typeof rec.cwd === 'string') cwd = rec.cwd;
      if (!createdAt && typeof rec.timestamp === 'string') createdAt = rec.timestamp;
      if (rec.type === 'custom-title' && typeof rec.customTitle === 'string') { title = rec.customTitle; continue; }
      if (rec.type === 'summary' && typeof rec.summary === 'string' && !title) { title = rec.summary; continue; }
      if (rec.isSidechain) continue;
      const message = isRecord(rec.message) ? rec.message : null;
      if (!message) continue;
      const ts = typeof rec.timestamp === 'string' ? rec.timestamp : undefined;
      if (rec.type === 'user') {
        const content = message.content;
        if (typeof content === 'string') {
          if (isSyntheticPrompt(content)) continue;
          turnId = typeof rec.uuid === 'string' ? rec.uuid : `${events.total}`;
          if (!firstPrompt) firstPrompt = content;
          push('user_prompt', { text: content }, ts);
          continue;
        }
        if (!Array.isArray(content)) continue;
        for (const block of content) {
          if (!isRecord(block)) continue;
          if (block.type === 'text' && typeof block.text === 'string') {
            if (isSyntheticPrompt(block.text)) continue;
            turnId = typeof rec.uuid === 'string' ? rec.uuid : `${events.total}`;
            if (!firstPrompt) firstPrompt = block.text;
            push('user_prompt', { text: block.text }, ts);
          } else if (block.type === 'tool_result') {
            push('tool_update', {
              tool_call_id: typeof block.tool_use_id === 'string' ? block.tool_use_id : '',
              status: block.is_error ? 'failed' : 'completed',
              output: truncate(textOfBlocks(block.content), TOOL_TEXT_MAX),
            }, ts);
          }
        }
        continue;
      }
      if (rec.type === 'assistant') {
        const content = Array.isArray(message.content) ? message.content : [];
        for (const block of content) {
          if (!isRecord(block)) continue;
          if (block.type === 'text' && typeof block.text === 'string' && block.text) {
            push('text', { text: block.text }, ts);
          } else if (block.type === 'thinking' && typeof block.thinking === 'string' && block.thinking) {
            push('reasoning', { text: truncate(block.thinking, TOOL_TEXT_MAX) }, ts);
          } else if (block.type === 'tool_use') {
            const name = typeof block.name === 'string' ? block.name : 'tool';
            push('tool_call', {
              tool_call_id: typeof block.id === 'string' ? block.id : '',
              title: name,
              kind: claudeToolKind(name),
              input: block.input,
            }, ts);
          }
        }
      }
    }
    return done(cleanTitle(title || firstPrompt), cwd, createdAt);
  }

  async #codexHistory(path: string, sessionId: string): Promise<{ events: HistoryEvent[]; total: number; offset: number; title: string; cwd: string; createdAt: string | null }> {
    const events = new BoundedHistory<HistoryEvent>(this.#historyLimit);
    let firstPrompt = '';
    let cwd = '';
    let createdAt: string | null = null;
    let turnId = '';
    let turnCounter = 0;
    // payload 크기는 담는 시점에 정리한다 — 이유는 #claudeHistory 의 같은 자리 주석 참조.
    const push = (type: string, payload: Record<string, unknown>, ts: string | undefined) => {
      events.push({ id: '', seq: 0, turn_id: turnId, type, payload: boundHistoryPayload(payload), created_at: ts || createdAt || new Date().toISOString() });
    };
    const done = (title: string, cwd: string, createdAt: string | null) =>
      ({ events: events.items(), total: events.total, offset: events.offset, title, cwd, createdAt });
    for await (const rec of this.#lines(path)) {
      const payload = isRecord(rec.payload) ? rec.payload : {};
      const ts = typeof rec.timestamp === 'string' ? rec.timestamp : undefined;
      if (rec.type === 'session_meta') {
        cwd = typeof payload.cwd === 'string' ? payload.cwd : cwd;
        createdAt = typeof payload.timestamp === 'string' ? payload.timestamp : createdAt;
        continue;
      }
      if (rec.type === 'response_item') {
        switch (payload.type) {
          case 'message': {
            const text = textOfBlocks(payload.content);
            if (!text) break;
            if (payload.role === 'user') {
              if (isSyntheticPrompt(text)) break;
              turnCounter += 1;
              turnId = `turn-${turnCounter}`;
              if (!firstPrompt) firstPrompt = text;
              push('user_prompt', { text }, ts);
            } else if (payload.role === 'assistant') {
              push('text', { text }, ts);
            }
            break;
          }
          case 'reasoning': {
            const text = textOfBlocks(payload.summary) || textOfBlocks(payload.content);
            if (text) push('reasoning', { text: truncate(text, TOOL_TEXT_MAX) }, ts);
            break;
          }
          case 'function_call':
          case 'custom_tool_call': {
            const name = typeof payload.name === 'string' ? payload.name : 'tool';
            let input: unknown = payload.arguments ?? payload.input;
            if (typeof input === 'string') {
              const raw: string = input;
              try { input = JSON.parse(raw); } catch { input = truncate(raw, TOOL_TEXT_MAX); }
            }
            push('tool_call', {
              tool_call_id: typeof payload.call_id === 'string' ? payload.call_id : '',
              title: name,
              kind: codexToolKind(name),
              input,
              // codex 는 호출 행에 자기 status 를 남긴다(completed/failed). 결과 행이 없는 호출도
              // 있으므로(중단된 턴 등) 이걸 무시하면 기록이 영원히 "running" 으로 보인다.
              ...(typeof payload.status === 'string' && payload.status ? { status: payload.status } : {}),
            }, ts);
            break;
          }
          case 'local_shell_call': {
            const action = isRecord(payload.action) ? payload.action : {};
            const command = Array.isArray(action.command) ? action.command.join(' ') : '';
            push('tool_call', {
              tool_call_id: typeof payload.call_id === 'string' ? payload.call_id : (typeof payload.id === 'string' ? payload.id : ''),
              title: command || 'shell',
              kind: 'execute',
              input: action,
            }, ts);
            break;
          }
          case 'function_call_output':
          case 'custom_tool_call_output': {
            const output = typeof payload.output === 'string' ? truncate(payload.output, TOOL_TEXT_MAX) : payload.output;
            push('tool_update', {
              tool_call_id: typeof payload.call_id === 'string' ? payload.call_id : '',
              status: 'completed',
              output,
            }, ts);
            break;
          }
          default:
            break;
        }
        continue;
      }
      if (rec.type === 'event_msg') {
        if (payload.type === 'task_complete') push('turn', { phase: 'finished', stop_reason: 'end_turn' }, ts);
        else if (payload.type === 'turn_aborted') push('turn', { phase: 'finished', stop_reason: 'cancelled' }, ts);
      }
    }
    return done(cleanTitle(firstPrompt), cwd, createdAt);
  }

  async *#lines(path: string): AsyncGenerator<Record<string, any>> {
    const rl = createInterface({ input: createReadStream(path, { encoding: 'utf8' }), crlfDelay: Infinity });
    for await (const line of rl) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed);
        if (isRecord(parsed)) yield parsed;
      } catch {
        /* skip */
      }
    }
  }

  // ─── AWB 가 만든 세션 인덱스 ──────────────────────────────────────────────

  async recordAwbSession(entry: { cli: string; session_id: string; cwd: string; title: string }): Promise<void> {
    const index = await this.#readIndex();
    const now = new Date().toISOString();
    const idx = index.findIndex((e) => e.cli === entry.cli && e.session_id === entry.session_id);
    if (idx === -1) {
      index.push({ ...entry, created_at: now, updated_at: now });
    } else {
      index[idx] = { ...index[idx], cwd: entry.cwd || index[idx].cwd, title: entry.title || index[idx].title, updated_at: now };
    }
    await this.#writeIndex(index);
  }

  async touchAwbSession(cli: string, sessionId: string, patch: { title?: string } = {}): Promise<void> {
    const index = await this.#readIndex();
    const idx = index.findIndex((e) => e.cli === cli && e.session_id === sessionId);
    if (idx === -1) return;
    index[idx] = { ...index[idx], ...(patch.title ? { title: patch.title } : {}), updated_at: new Date().toISOString() };
    await this.#writeIndex(index);
  }

  async #readIndex(): Promise<AwbSessionIndexEntry[]> {
    try {
      const raw = JSON.parse(await readFile(this.indexPath, 'utf8'));
      const list = Array.isArray(raw?.sessions) ? raw.sessions : [];
      return list.filter((e: any) => isRecord(e) && typeof e.cli === 'string' && typeof e.session_id === 'string');
    } catch {
      return [];
    }
  }

  async #writeIndex(entries: AwbSessionIndexEntry[]): Promise<void> {
    await mkdir(join(this.indexPath, '..'), { recursive: true });
    await writeFile(this.indexPath, JSON.stringify({ version: 1, sessions: entries.slice(-500) }, null, 2), { mode: 0o600 });
  }
}
