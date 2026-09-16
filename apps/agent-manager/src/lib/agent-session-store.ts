// Agent Session(CLI 직접 세션) — 이 장비의 CLI 세션 저장소 리더.
//
// AWB 는 세션 전문을 저장하지 않는다. Claude Code 는 `$CLAUDE_CONFIG_DIR/projects/<cwd>/<id>.jsonl`,
// Codex 는 `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-<ts>-<id>.jsonl` 에 전문을 갖고 있으므로
// 여기서 그 파일을 읽어 (1) 목록(제목·cwd·최근 활동) 과 (2) 트랜스크립트 이벤트를 만든다.
// 이벤트 모양은 라이브 스트림(agent-session-runner)과 같다 — UI 는 둘을 구분하지 않는다.
//
// Hermes 는 자체 저장소 포맷을 모르므로 AWB 화면에서 만든 세션만 로컬 인덱스
// (`$AWB_AGENT_MANAGER_HOME/agent-sessions.json`)로 기억한다. claude/codex 도 AWB 가
// 만든 세션은 인덱스에 남겨 제목을 보존한다(파일 스캔 결과와 병합).

import { createReadStream } from 'node:fs';
import { mkdir, open, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { createInterface } from 'node:readline';

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
  indexPath?: string;
  listLimit?: number;
  historyEventLimit?: number;
  env?: NodeJS.ProcessEnv;
}

const HEAD_BYTES = 256 * 1024;
const TAIL_BYTES = 64 * 1024;
const DEFAULT_LIST_LIMIT = 200;
const DEFAULT_HISTORY_LIMIT = 4000;
const TITLE_MAX = 120;
const TOOL_TEXT_MAX = 16_000;
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

export class AgentSessionStore {
  readonly claudeHome: string;
  readonly codexHome: string;
  readonly indexPath: string;
  readonly #listLimit: number;
  readonly #historyLimit: number;

  constructor(options: AgentSessionStoreOptions = {}) {
    const env = options.env ?? process.env;
    this.claudeHome = options.claudeHome ?? resolveClaudeHome(env);
    this.codexHome = options.codexHome ?? resolveCodexHome(env);
    this.indexPath = options.indexPath ?? join(AGENT_MANAGER_HOME, 'agent-sessions.json');
    this.#listLimit = options.listLimit ?? DEFAULT_LIST_LIMIT;
    this.#historyLimit = options.historyEventLimit ?? DEFAULT_HISTORY_LIMIT;
  }

  // ─── 목록 ───────────────────────────────────────────────────────────────

  async listSessions(cli: string): Promise<SessionSummary[]> {
    const index = await this.#readIndex();
    const indexed = index.filter((e) => e.cli === cli);
    let scanned: SessionSummary[] = [];
    if (cli === 'claude') scanned = await this.#listClaude();
    else if (cli === 'codex') scanned = await this.#listCodex();
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
    const events = parsed.events.map((e, i) => ({ ...e, seq: i + 1, id: `${sessionId}:${i + 1}` }));
    const truncated = events.length > this.#historyLimit;
    const kept = truncated ? events.slice(events.length - this.#historyLimit) : events;
    if (truncated) {
      kept.unshift({
        id: `${sessionId}:truncated`, seq: 0, turn_id: '', type: 'system',
        payload: { text: `Earlier history omitted (${events.length - this.#historyLimit} events).` },
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

  async #claudeHistory(path: string, sessionId: string): Promise<{ events: HistoryEvent[]; title: string; cwd: string; createdAt: string | null }> {
    const events: HistoryEvent[] = [];
    let title = '';
    let firstPrompt = '';
    let cwd = '';
    let createdAt: string | null = null;
    let turnId = '';
    const push = (type: string, payload: Record<string, unknown>, createdAtRec: string | undefined) => {
      events.push({ id: '', seq: 0, turn_id: turnId, type, payload, created_at: createdAtRec || createdAt || new Date().toISOString() });
    };
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
          turnId = typeof rec.uuid === 'string' ? rec.uuid : `${events.length}`;
          if (!firstPrompt) firstPrompt = content;
          push('user_prompt', { text: content }, ts);
          continue;
        }
        if (!Array.isArray(content)) continue;
        for (const block of content) {
          if (!isRecord(block)) continue;
          if (block.type === 'text' && typeof block.text === 'string') {
            if (isSyntheticPrompt(block.text)) continue;
            turnId = typeof rec.uuid === 'string' ? rec.uuid : `${events.length}`;
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
    return { events, title: cleanTitle(title || firstPrompt), cwd, createdAt };
  }

  async #codexHistory(path: string, sessionId: string): Promise<{ events: HistoryEvent[]; title: string; cwd: string; createdAt: string | null }> {
    const events: HistoryEvent[] = [];
    let firstPrompt = '';
    let cwd = '';
    let createdAt: string | null = null;
    let turnId = '';
    let turnCounter = 0;
    const push = (type: string, payload: Record<string, unknown>, ts: string | undefined) => {
      events.push({ id: '', seq: 0, turn_id: turnId, type, payload, created_at: ts || createdAt || new Date().toISOString() });
    };
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
    return { events, title: cleanTitle(firstPrompt), cwd, createdAt };
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
