// Agent Session(CLI 직접 세션) — 이 장비의 CLI 세션 저장소 리더.
//
// AWB 는 세션 전문을 저장하지 않는다. 각 CLI 가 자기 홈에 갖고 있는 기록(Claude Code 는
// `$CLAUDE_CONFIG_DIR/projects/<cwd>/<id>.jsonl`, Codex 는 `$CODEX_HOME/sessions/…/rollout-*.jsonl`,
// opencode 는 SQLite)을 읽어 (1) 목록(제목·cwd·최근 활동) 과 (2) 트랜스크립트 이벤트를
// 만든다. 이벤트 모양은 라이브 스트림(agent-session-runner)과 같다 — UI 는 둘을 구분하지 않는다.
//
// CLI 별 읽기 규칙은 이 파일에 없다: `clis/<id>/sessions.ts` 의 `CliSessionStoreDriver` 가
// 열거·파싱을 맡고, 여기서는 (a) 드라이버를 레지스트리로 찾아 호출하고 (b) AWB 가 만든 세션
// 인덱스(`$AWB_AGENT_MANAGER_HOME/agent-sessions.json`)와 병합하며 (c) 이벤트 번호 매기기·
// 바이트 상한·생략 안내처럼 CLI 와 무관한 마무리를 **한 곳에서만** 한다 — CLI 별 파서가
// 각자 자르면 한 갈래만 빠뜨려도(실제로 codex 의 배열형 tool 출력이 그랬다) 응답 전체가
// 서버 상한을 넘어 버려진다.
//
// 스토어 드라이버가 없는 CLI(hermes)는 AWB 화면에서 만든 세션만 인덱스로 기억한다.

import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

import {
  fitHistoryBytes,
  type HistoryEvent,
  isRecord,
  SESSION_ID_RE,
} from './agent-session-history.js';
import type { CliSessionStoreContext, CliSessionStoreDriver } from './clis/cli-module.js';
import { cliSessions } from './clis/index.js';
import { AGENT_MANAGER_HOME } from './constants.js';

// 스캐너와 테스트가 함께 쓰는 헬퍼는 leaf(agent-session-history.ts)에 있고 여기서 다시 내보낸다.
export { BoundedHistory, boundHistoryPayload, fitHistoryBytes, type HistoryEvent } from './agent-session-history.js';
export { claudeToolKind } from './clis/claude/sessions.js';
export { resolveClaudeHome } from './clis/claude/index.js';
export { resolveCodexHome } from './clis/codex/index.js';

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
  /** CLI id → 운영자 홈 override(테스트). 생략하면 모듈의 `operatorHome(env)`. */
  homes?: Record<string, string>;
  /** @deprecated `homes.claude` — 옛 테스트 seam. */
  claudeHome?: string;
  /** @deprecated `homes.codex` — 옛 테스트 seam. */
  codexHome?: string;
  /** 외부 명령 실행기(기본: execFile). 스캐너가 CLI 자신의 도구를 부를 때 쓴다
   *  (opencode `db`). 테스트가 실제 CLI 없이 매핑을 검증할 수 있도록 주입 가능하게 둔다. */
  exec?: (bin: string, args: string[]) => Promise<string>;
  /** @deprecated `exec` — opencode `db <sql>` 만 가로채던 옛 테스트 seam. */
  opencodeQuery?: (sql: string) => Promise<string>;
  indexPath?: string;
  listLimit?: number;
  historyEventLimit?: number;
  env?: NodeJS.ProcessEnv;
}

const DEFAULT_LIST_LIMIT = 200;
const DEFAULT_HISTORY_LIMIT = 4000;
/** 외부 명령 상한. 목록 한 번이 세션 화면을 오래 붙잡지 않게 한다. */
const EXTERNAL_COMMAND_TIMEOUT_MS = 10_000;
/**
 * 기록 응답 본문의 바이트 상한(가장 최근 것부터 채운다). 서버 상한(10MB)보다 넉넉히 낮게 잡아
 * base64·헤더 같은 부대 비용을 감안한다. 개별 이벤트를 아무리 잘라도 수천 건이 쌓이면 넘을 수
 * 있으므로 마지막 방어선으로 둔다.
 */
const HISTORY_BODY_MAX_BYTES = 6 * 1024 * 1024;

const execFileAsync = promisify(execFile);

async function defaultExec(bin: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(bin, args, {
    timeout: EXTERNAL_COMMAND_TIMEOUT_MS,
    maxBuffer: 8 * 1024 * 1024,
    windowsHide: true,
  });
  return stdout;
}

export class AgentSessionStore {
  readonly indexPath: string;
  readonly #homes: Record<string, string>;
  readonly #env: NodeJS.ProcessEnv;
  readonly #listLimit: number;
  readonly #historyLimit: number;
  readonly #exec: (bin: string, args: string[]) => Promise<string>;

  constructor(options: AgentSessionStoreOptions = {}) {
    this.#env = options.env ?? process.env;
    this.#homes = { ...(options.homes ?? {}) };
    if (options.claudeHome) this.#homes.claude = options.claudeHome;
    if (options.codexHome) this.#homes.codex = options.codexHome;
    this.indexPath = options.indexPath ?? join(AGENT_MANAGER_HOME, 'agent-sessions.json');
    this.#listLimit = options.listLimit ?? DEFAULT_LIST_LIMIT;
    this.#historyLimit = options.historyEventLimit ?? DEFAULT_HISTORY_LIMIT;
    const opencodeQuery = options.opencodeQuery;
    this.#exec = options.exec
      ?? (opencodeQuery
        ? (bin, args) => (bin === 'opencode' && args[0] === 'db' ? opencodeQuery(args[1]) : defaultExec(bin, args))
        : defaultExec);
  }

  /** @deprecated 테스트 호환 — `homes.claude`. */
  get claudeHome(): string {
    return this.#homeFor('claude');
  }

  /** @deprecated 테스트 호환 — `homes.codex`. */
  get codexHome(): string {
    return this.#homeFor('codex');
  }

  #homeFor(cli: string): string {
    return this.#homes[cli] ?? cliSessions(cli)?.operatorHome(this.#env) ?? '';
  }

  #driverFor(cli: string): { driver: CliSessionStoreDriver; ctx: CliSessionStoreContext } | null {
    const driver = cliSessions(cli)?.store;
    if (!driver) return null;
    return {
      driver,
      ctx: { home: this.#homeFor(cli), listLimit: this.#listLimit, historyLimit: this.#historyLimit, exec: this.#exec },
    };
  }

  // ─── 목록 ───────────────────────────────────────────────────────────────

  async listSessions(cli: string): Promise<SessionSummary[]> {
    const index = await this.#readIndex();
    const indexed = index.filter((e) => e.cli === cli);
    const bound = this.#driverFor(cli);
    let scanned: SessionSummary[] = [];
    if (bound) {
      try {
        scanned = await bound.driver.listSessions(bound.ctx);
      } catch {
        // 드라이버 계약상 throw 하지 않지만, 한 CLI 의 스캔 실패가 목록 전체를 막지는 않게 한다.
        scanned = [];
      }
    }
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

  // ─── 파일 찾기 ──────────────────────────────────────────────────────────

  async findSessionFile(cli: string, sessionId: string): Promise<string | null> {
    if (!SESSION_ID_RE.test(sessionId)) return null;
    const bound = this.#driverFor(cli);
    if (!bound?.driver.findSessionFile) return null;
    return bound.driver.findSessionFile(bound.ctx, sessionId);
  }

  // ─── 기록 ───────────────────────────────────────────────────────────────

  async readHistory(cli: string, sessionId: string): Promise<HistoryResult> {
    const indexEntry = (await this.#readIndex()).find((e) => e.cli === cli && e.session_id === sessionId) ?? null;
    const fromIndexOnly: HistoryResult = {
      session: indexEntry
        ? { cli, session_id: sessionId, cwd: indexEntry.cwd, title: indexEntry.title, created_at: indexEntry.created_at, updated_at: indexEntry.updated_at, source: 'awb' }
        : null,
      events: [],
      truncated: false,
    };
    // id 는 파일명·SQL 에 그대로 박히므로 형식을 먼저 강제한다(따옴표·백슬래시가 낄 수 없는 집합).
    if (!SESSION_ID_RE.test(sessionId)) return fromIndexOnly;
    const bound = this.#driverFor(cli);
    if (!bound) return fromIndexOnly;
    let read;
    try {
      read = await bound.driver.readHistory(bound.ctx, sessionId, indexEntry);
    } catch {
      read = null;
    }
    if (!read) return fromIndexOnly;

    // payload 크기 정리는 스캐너가 담는 시점에 이미 끝냈다(boundHistoryPayload). 여기서는
    // 절대 위치 번호와 응답 바이트 상한만 다룬다 — seq/id 는 절대 위치를 유지해 같은 세션을
    // 다시 읽어도 앞부분이 변하지 않는 한 같은 이벤트가 같은 id 를 갖는다.
    const events: HistoryEvent[] = read.events.map((e, i) => {
      const absolute = read.offset + i + 1;
      return { ...e, seq: absolute, id: `${sessionId}:${absolute}` };
    });
    const kept = fitHistoryBytes<HistoryEvent>(events, HISTORY_BODY_MAX_BYTES);
    // 생략분 = 창 앞의 것(offset) + 바이트 상한으로 떨어진 것. 스캐너가 화면에 안 그리는
    // 항목(opencode 의 step-start 등)을 건너뛰어도 그것을 "생략" 으로 세지 않는다.
    const omitted = read.offset + (read.events.length - kept.length);
    const truncated = omitted > 0;
    if (truncated) {
      kept.unshift({
        id: `${sessionId}:truncated`, seq: 0, turn_id: '', type: 'system',
        payload: { text: `Earlier history omitted (${omitted} events).` },
        created_at: kept[0]?.created_at ?? new Date().toISOString(),
      });
    }
    return {
      session: {
        cli,
        session_id: sessionId,
        cwd: read.cwd || indexEntry?.cwd || '',
        title: indexEntry?.title || read.title,
        created_at: read.createdAt ?? indexEntry?.created_at ?? null,
        updated_at: read.updatedAt ?? indexEntry?.updated_at ?? new Date().toISOString(),
        source: indexEntry ? 'awb' : 'cli',
        ...(read.sizeBytes !== undefined ? { size_bytes: read.sizeBytes } : {}),
      },
      events: kept,
      truncated,
    };
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
