// Terminal(Runtime Host 셸) 러너 — docs/terminals.md.
//
// 터미널의 단위는 **(이 Runtime Host, 여기서 발급한 terminal id)** 다. Agent Session 과
// 결정적으로 다른 점: **장비에 기록이 없다.** PTY 프로세스가 곧 터미널이고, 죽으면 그
// 터미널은 사라진다 — 그래서 목록은 살아 있는 것만 나오고, 서버도 화면도 아무것도
// 저장하지 않는다. 다시 붙었을 때 화면을 되살리는 스크롤백만 여기서 바이트 상한 안에
// 들고 있다가 attach 때 한 번 넘겨준다.
//
// AWB 서버는 `terminal_request` SSE 로 (1) list / open / attach 를 RPC 로 묻고,
// (2) input / resize / close 를 fire-and-forget 으로 보낸다.

import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';

import { log } from './logging.js';
import {
  patchTerminalState,
  postTerminalOutput,
  postTerminalRpcResponse,
  type AwbConfig,
  type TerminalOutputChunkInput,
  type TerminalStatePatch,
} from './rest.js';
import { defaultTerminalCwd, detectTerminalShells, type TerminalShell } from './terminal-shells.js';

/** 서버 payload (apps/server/src/common/types/stream-events.ts TerminalRequestPayload). */
export interface TerminalRequest {
  manager_id: string;
  workspace_id?: string;
  /** 서버의 `TERMINAL_REQUEST_OPS`(apps/server/src/common/types/terminals.ts)를 그대로
   *  비춘다. agent-manager 는 별도 패키지라 그 타입을 import 할 수 없어 사본이 불가피하다
   *  — op 를 추가할 때는 **양쪽을 같은 PR 로** 고칠 것. */
  op: 'list' | 'open' | 'attach' | 'input' | 'resize' | 'close';
  request_id?: string;
  terminal_id?: string | null;
  shell?: string | null;
  cwd?: string;
  title?: string;
  cols?: number;
  rows?: number;
  data?: string;
  driver_user_id: string;
  issued_at: string;
}

export interface TerminalRunnerOptions {
  getManagerId: () => string;
  /** 출력 청크를 모아 보내는 간격(ms). 키 에코가 느껴지지 않을 만큼 짧아야 한다. */
  flushIntervalMs?: number;
  /** attach 가 넘겨줄 스크롤백 상한(bytes). */
  scrollbackBytes?: number;
  /** 한 장비의 동시 터미널 수 상한 — 서버의 TERMINAL_PER_HOST_MAX 와 같은 값. */
  maxTerminals?: number;
  /** 입력도 출력도 없이 이만큼 지나면 회수한다(시간). 0 이면 끄지 않는다. */
  idleHours?: number;
  /** 테스트용 PTY 주입점. 없으면 `@lydell/node-pty` 를 동적으로 불러온다. */
  ptyFactory?: PtyFactory;
  /** 테스트용 셸 목록 override. */
  shellProvider?: () => Promise<TerminalShell[]>;
  baseEnv?: NodeJS.ProcessEnv;
}

export interface PtySpawnOptions {
  file: string;
  args: string[];
  cwd: string;
  cols: number;
  rows: number;
  env: NodeJS.ProcessEnv;
}

/** node-pty 의 IPty 중 우리가 쓰는 만큼. 테스트는 이 모양만 흉내 내면 된다. */
export interface PtyHandle {
  pid: number;
  onData(listener: (data: string | Buffer) => void): void;
  onExit(listener: (e: { exitCode: number; signal?: number }) => void): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
}

export type PtyFactory = (opts: PtySpawnOptions) => PtyHandle;

/** 서버 `TerminalSummary` 의 매니저 쪽 원본. */
export interface TerminalInfo {
  terminal_id: string;
  shell: string;
  shell_label: string;
  cwd: string;
  title: string;
  cols: number;
  rows: number;
  pid: number | null;
  status: 'starting' | 'live' | 'exited' | 'error';
  exit_code: number | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

interface LiveTerminal extends TerminalInfo {
  pty: PtyHandle | null;
  /** 스크롤백(최근 바이트). attach 가 이것을 한 번 넘겨준다. */
  scrollback: Buffer[];
  scrollbackBytes: number;
  /** 앞부분을 버린 적이 있는가. */
  truncated: boolean;
  /** 출력 청크의 절대 번호 — attach 스냅샷 이후의 라이브 청크를 화면이 가리는 근거. */
  seq: number;
  pendingOut: Buffer[];
  pendingBytes: number;
  flushTimer: NodeJS.Timeout | null;
  flushing: boolean;
  /** 전송 중에 생긴 상태 패치 — 다음 회차가 같이 실어 보낸다. */
  pendingState: TerminalStatePatch | null;
  /** exit 뒤 이 시각이 지나면 테이블에서 지운다. */
  reapAt: number | null;
  lastActiveAt: number;
}

const DEFAULT_FLUSH_MS = 40;
const DEFAULT_SCROLLBACK_BYTES = 256 * 1024;
const DEFAULT_MAX_TERMINALS = 16;
const DEFAULT_IDLE_HOURS = 12;
/** 한 청크(원문 바이트)의 상한 — 서버 TERMINAL_CHUNK_MAX_BYTES 와 같은 값. */
const CHUNK_MAX_BYTES = 64 * 1024;
/** 한 번의 POST 에 담을 청크 수 — 서버 TERMINAL_OUTPUT_BATCH_MAX 와 같은 값. */
const BATCH_MAX = 64;
/** 끝난 터미널을 테이블에 남겨 두는 시간 — 화면이 "exited" 를 한 번은 보게 한다. */
const REAP_DELAY_MS = 30_000;
const CWD_MAX = 1024;
const TITLE_MAX = 200;

let ptyModulePromise: Promise<any> | null = null;
let ptyLoadError: string | null = null;

/**
 * PTY 모듈은 **선택 의존성**이다(`@lydell/node-pty`, 플랫폼별 prebuild). 없는 장비는
 * 터미널을 못 열 뿐 나머지 매니저 기능은 그대로다 — 그래서 실패를 던지지 않고 기억만 한다.
 */
async function loadPtyModule(): Promise<any | null> {
  if (!ptyModulePromise) {
    ptyModulePromise = import('@lydell/node-pty').catch((err: any) => {
      ptyLoadError = err?.message ?? String(err);
      log(`Terminal support disabled — @lydell/node-pty could not be loaded: ${ptyLoadError}`);
      return null;
    });
  }
  return ptyModulePromise;
}

export function ptyUnavailableReason(): string | null {
  return ptyLoadError;
}

function nowIso(): string {
  return new Date().toISOString();
}

function toBuffer(data: string | Buffer): Buffer {
  return Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
}

export class TerminalRunner {
  readonly #config: AwbConfig;
  readonly #opts: TerminalRunnerOptions;
  readonly #terminals = new Map<string, LiveTerminal>();
  #shells: TerminalShell[] | null = null;
  #idleTimer: NodeJS.Timeout | null = null;
  #stopped = false;

  constructor(config: AwbConfig, opts: TerminalRunnerOptions) {
    this.#config = config;
    this.#opts = opts;
    const idleHours = opts.idleHours ?? DEFAULT_IDLE_HOURS;
    if (idleHours > 0) {
      this.#idleTimer = setInterval(() => this.#reapIdle(idleHours * 3_600_000), 60_000);
      this.#idleTimer.unref?.();
    }
  }

  // ─── 하트비트가 읽는 것 ─────────────────────────────────────────────────

  /**
   * 이 장비에서 띄울 수 있는 셸. PTY 모듈이 없으면 **빈 배열**이다 — 서버는 이것을
   * "터미널을 못 여는 장비" 로 읽고 목록에서 뺀다(눌러도 안 열리는 행을 만들지 않는다).
   */
  async availableShells(): Promise<TerminalShell[]> {
    if (this.#shells) return this.#shells;
    const pty = this.#opts.ptyFactory ? {} : await loadPtyModule();
    if (!pty) {
      this.#shells = [];
      return this.#shells;
    }
    const provider = this.#opts.shellProvider ?? detectTerminalShells;
    try {
      this.#shells = await provider();
    } catch (err: any) {
      log(`Terminal shell detection failed: ${err?.message ?? err}`);
      this.#shells = [];
    }
    return this.#shells;
  }

  /** 하트비트 `terminals[]` — 살아 있는 것만. */
  liveStates(): Array<{ terminal_id: string; status: string }> {
    const out: Array<{ terminal_id: string; status: string }> = [];
    for (const t of this.#terminals.values()) {
      if (t.status === 'starting' || t.status === 'live') out.push({ terminal_id: t.terminal_id, status: t.status });
    }
    return out;
  }

  countInFlight(): number {
    return this.liveStates().length;
  }

  // ─── SSE 요청 처리 ──────────────────────────────────────────────────────

  async handle(req: TerminalRequest): Promise<void> {
    try {
      switch (req.op) {
        case 'list': return await this.#handleList(req);
        case 'open': return await this.#handleOpen(req);
        case 'attach': return await this.#handleAttach(req);
        case 'input': return this.#handleInput(req);
        case 'resize': return this.#handleResize(req);
        case 'close': return this.#handleClose(req);
        default:
          log(`terminal_request: unknown op ${String((req as any).op)}`);
      }
    } catch (err: any) {
      log(`terminal_request ${req.op} failed: ${err?.message ?? err}`);
      await this.#respond(req, { ok: false, error: err?.message ?? String(err), code: 'manager_error' });
    }
  }

  async #respond(req: TerminalRequest, body: { ok: boolean; result?: unknown; error?: string; code?: string }): Promise<void> {
    if (!req.request_id) return;
    await postTerminalRpcResponse(this.#config, this.#opts.getManagerId(), req.request_id, body);
  }

  async #handleList(req: TerminalRequest): Promise<void> {
    this.#reapExited();
    const terminals = Array.from(this.#terminals.values())
      .filter((t) => t.status === 'starting' || t.status === 'live')
      .map((t) => this.#info(t));
    await this.#respond(req, { ok: true, result: { terminals } });
  }

  async #handleOpen(req: TerminalRequest): Promise<void> {
    const max = this.#opts.maxTerminals ?? DEFAULT_MAX_TERMINALS;
    if (this.countInFlight() >= max) {
      await this.#respond(req, { ok: false, error: `This machine already has ${max} live terminals.`, code: 'too_many_terminals' });
      return;
    }
    const shells = await this.availableShells();
    if (!shells.length) {
      await this.#respond(req, {
        ok: false,
        code: 'terminal_unsupported',
        error: ptyUnavailableReason()
          ? `This machine cannot open terminals: ${ptyUnavailableReason()}`
          : 'This machine reported no usable shell.',
      });
      return;
    }
    const wanted = String(req.shell ?? '').trim();
    const shell = (wanted ? shells.find((s) => s.id === wanted) : null) ?? shells.find((s) => s.default) ?? shells[0];
    if (wanted && !shells.some((s) => s.id === wanted)) {
      await this.#respond(req, { ok: false, error: `No "${wanted}" shell on this machine.`, code: 'shell_unknown' });
      return;
    }
    const cwd = await this.#resolveCwd(req.cwd);
    const cols = Math.max(2, Math.min(1000, Math.round(Number(req.cols) || 80)));
    const rows = Math.max(1, Math.min(500, Math.round(Number(req.rows) || 24)));
    const terminalId = randomUUID();
    const term: LiveTerminal = {
      terminal_id: terminalId,
      shell: shell.id,
      shell_label: shell.label,
      cwd,
      title: String(req.title ?? '').slice(0, TITLE_MAX),
      cols,
      rows,
      pid: null,
      status: 'starting',
      exit_code: null,
      last_error: null,
      created_at: nowIso(),
      updated_at: nowIso(),
      pty: null,
      scrollback: [],
      scrollbackBytes: 0,
      truncated: false,
      seq: 0,
      pendingOut: [],
      pendingBytes: 0,
      flushTimer: null,
      flushing: false,
      pendingState: null,
      reapAt: null,
      lastActiveAt: Date.now(),
    };
    this.#terminals.set(terminalId, term);

    try {
      term.pty = await this.#spawn(shell, term);
    } catch (err: any) {
      term.status = 'error';
      term.last_error = err?.message ?? String(err);
      term.updated_at = nowIso();
      term.reapAt = Date.now() + REAP_DELAY_MS;
      await this.#respond(req, { ok: false, error: term.last_error ?? 'spawn failed', code: 'spawn_failed' });
      return;
    }
    term.pid = term.pty.pid;
    term.status = 'live';
    term.updated_at = nowIso();
    log(`terminal ${terminalId.slice(0, 8)} opened (${shell.label}, pid ${term.pid}, cwd ${cwd})`);
    await this.#respond(req, { ok: true, result: { terminal_id: terminalId, terminal: this.#info(term) } });
  }

  async #handleAttach(req: TerminalRequest): Promise<void> {
    const term = this.#terminals.get(String(req.terminal_id ?? ''));
    if (!term) {
      await this.#respond(req, { ok: false, error: 'No such terminal on this machine.', code: 'not_found' });
      return;
    }
    // 붙는 쪽 화면 크기를 알려 주면 그 크기로 맞춘다 — 다시 그릴 때 줄바꿈이 어긋나지 않게.
    if (term.status === 'live' && term.pty && Number.isFinite(req.cols) && Number.isFinite(req.rows)) {
      this.#applyResize(term, Number(req.cols), Number(req.rows));
    }
    // 아직 안 보낸 출력을 먼저 털어야 스냅샷의 seq 와 라이브 청크가 어긋나지 않는다.
    await this.#flush(term);
    const data = Buffer.concat(term.scrollback);
    await this.#respond(req, {
      ok: true,
      result: {
        terminal: this.#info(term),
        data: data.toString('base64'),
        seq: term.seq,
        truncated: term.truncated,
      },
    });
  }

  #handleInput(req: TerminalRequest): void {
    const term = this.#terminals.get(String(req.terminal_id ?? ''));
    if (!term || !term.pty || term.status !== 'live') return;
    const data = typeof req.data === 'string' ? req.data : '';
    if (!data) return;
    term.lastActiveAt = Date.now();
    try {
      term.pty.write(data);
    } catch (err: any) {
      log(`terminal ${term.terminal_id.slice(0, 8)} write failed: ${err?.message ?? err}`);
    }
  }

  #handleResize(req: TerminalRequest): void {
    const term = this.#terminals.get(String(req.terminal_id ?? ''));
    if (!term) return;
    this.#applyResize(term, Number(req.cols), Number(req.rows));
  }

  #applyResize(term: LiveTerminal, colsInput: number, rowsInput: number): void {
    const cols = Math.max(2, Math.min(1000, Math.round(colsInput || term.cols)));
    const rows = Math.max(1, Math.min(500, Math.round(rowsInput || term.rows)));
    if (cols === term.cols && rows === term.rows) return;
    term.cols = cols;
    term.rows = rows;
    term.updated_at = nowIso();
    if (term.status !== 'live' || !term.pty) return;
    try {
      term.pty.resize(cols, rows);
    } catch (err: any) {
      log(`terminal ${term.terminal_id.slice(0, 8)} resize failed: ${err?.message ?? err}`);
    }
  }

  #handleClose(req: TerminalRequest): void {
    const term = this.#terminals.get(String(req.terminal_id ?? ''));
    if (!term) return;
    this.#kill(term, 'closed by user');
  }

  // ─── PTY ────────────────────────────────────────────────────────────────

  async #resolveCwd(input: string | undefined): Promise<string> {
    const wanted = String(input ?? '').trim().slice(0, CWD_MAX);
    if (!wanted) return defaultTerminalCwd();
    try {
      const st = await stat(wanted);
      if (st.isDirectory()) return wanted;
    } catch {
      /* 존재하지 않는 폴더로 spawn 하면 PTY 가 통째로 실패한다 — 홈으로 떨어뜨리는 편이 낫다. */
    }
    log(`terminal cwd "${wanted}" is not a directory — falling back to home`);
    return defaultTerminalCwd();
  }

  async #spawn(shell: TerminalShell, term: LiveTerminal): Promise<PtyHandle> {
    const env: NodeJS.ProcessEnv = {
      ...(this.#opts.baseEnv ?? process.env),
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      // 이 셸이 AWB 화면에서 돌고 있다는 표시 — 운영자의 rc 파일이 분기할 수 있게.
      AWB_TERMINAL: '1',
    };
    delete env.TERM_PROGRAM;
    const opts: PtySpawnOptions = {
      file: shell.path,
      args: this.#shellArgs(shell),
      cwd: term.cwd,
      cols: term.cols,
      rows: term.rows,
      env,
    };
    let handle: PtyHandle;
    if (this.#opts.ptyFactory) {
      handle = this.#opts.ptyFactory(opts);
    } else {
      const pty = await loadPtyModule();
      if (!pty) throw new Error(ptyUnavailableReason() || 'node-pty is not available on this machine');
      handle = pty.spawn(opts.file, opts.args, {
        name: 'xterm-256color',
        cols: opts.cols,
        rows: opts.rows,
        cwd: opts.cwd,
        env: opts.env,
        // 원문 바이트 그대로 받는다 — 멀티바이트 문자가 청크 경계에서 깨지지 않도록
        // 디코딩은 화면(xterm)에 맡긴다.
        encoding: null,
      }) as PtyHandle;
    }
    handle.onData((data) => this.#onData(term, data));
    handle.onExit((e) => this.#onExit(term, e));
    return handle;
  }

  /** 로그인 셸로 띄워 운영자의 rc(PATH·alias)를 그대로 쓰게 한다. Windows 는 인자 없이. */
  #shellArgs(shell: TerminalShell): string[] {
    if (process.platform === 'win32') return [];
    if (shell.id === 'cmd' || shell.id === 'pwsh' || shell.id === 'powershell') return [];
    return ['-l'];
  }

  #onData(term: LiveTerminal, data: string | Buffer): void {
    const buf = toBuffer(data);
    if (!buf.length) return;
    term.lastActiveAt = Date.now();
    term.updated_at = nowIso();
    // 스크롤백 — 상한을 넘으면 오래된 것부터 버린다(붙었을 때 되살릴 "최근 화면" 만 있으면 된다).
    term.scrollback.push(buf);
    term.scrollbackBytes += buf.length;
    const limit = this.#opts.scrollbackBytes ?? DEFAULT_SCROLLBACK_BYTES;
    while (term.scrollbackBytes > limit && term.scrollback.length > 1) {
      const dropped = term.scrollback.shift()!;
      term.scrollbackBytes -= dropped.length;
      term.truncated = true;
    }
    term.pendingOut.push(buf);
    term.pendingBytes += buf.length;
    if (term.pendingBytes >= CHUNK_MAX_BYTES) {
      void this.#flush(term);
      return;
    }
    if (!term.flushTimer) {
      term.flushTimer = setTimeout(() => {
        term.flushTimer = null;
        void this.#flush(term);
      }, this.#opts.flushIntervalMs ?? DEFAULT_FLUSH_MS);
      term.flushTimer.unref?.();
    }
  }

  /**
   * 모아 둔 출력을 서버로 보낸다. 한 번에 하나만 돌게 해서(`flushing`) 순서가 뒤집히지
   * 않게 하고, 보내는 동안 쌓인 것은 다음 회차가 가져간다.
   */
  async #flush(term: LiveTerminal, state?: TerminalStatePatch | null): Promise<void> {
    if (term.flushTimer) {
      clearTimeout(term.flushTimer);
      term.flushTimer = null;
    }
    if (term.flushing) {
      // 진행 중인 전송이 끝나면 남은 것을 다시 털도록 예약만 하고 돌아간다.
      if (state) term.pendingState = { ...(term.pendingState ?? {}), ...state };
      queueMicrotask(() => {
        if (!term.flushing && (term.pendingOut.length || term.pendingState)) void this.#flush(term);
      });
      return;
    }
    const patch = { ...(term.pendingState ?? {}), ...(state ?? {}) };
    term.pendingState = null;
    if (!term.pendingOut.length && !Object.keys(patch).length) return;
    term.flushing = true;
    try {
      const chunks: TerminalOutputChunkInput[] = [];
      const merged = term.pendingOut.length ? Buffer.concat(term.pendingOut) : Buffer.alloc(0);
      term.pendingOut = [];
      term.pendingBytes = 0;
      for (let offset = 0; offset < merged.length && chunks.length < BATCH_MAX; offset += CHUNK_MAX_BYTES) {
        const slice = merged.subarray(offset, Math.min(offset + CHUNK_MAX_BYTES, merged.length));
        term.seq += 1;
        chunks.push({ seq: term.seq, data: slice.toString('base64'), created_at: nowIso() });
      }
      // BATCH_MAX 를 넘긴 나머지는 다음 회차로 미룬다(순서는 seq 가 지킨다).
      const sent = chunks.length * CHUNK_MAX_BYTES;
      if (merged.length > sent) {
        const rest = merged.subarray(sent);
        term.pendingOut.unshift(rest);
        term.pendingBytes += rest.length;
      }
      await postTerminalOutput(
        this.#config,
        { manager_id: this.#opts.getManagerId(), terminal_id: term.terminal_id },
        chunks,
        Object.keys(patch).length ? patch : null,
      );
    } finally {
      term.flushing = false;
    }
    if (term.pendingOut.length || term.pendingState) void this.#flush(term);
  }

  #onExit(term: LiveTerminal, e: { exitCode: number; signal?: number }): void {
    if (term.status === 'exited') return;
    term.status = 'exited';
    term.exit_code = Number.isFinite(e?.exitCode) ? e.exitCode : null;
    term.pty = null;
    term.updated_at = nowIso();
    term.reapAt = Date.now() + REAP_DELAY_MS;
    log(`terminal ${term.terminal_id.slice(0, 8)} exited (code ${term.exit_code ?? '?'})`);
    void this.#flush(term, { status: 'exited', exit_code: term.exit_code, reason: 'exited' });
  }

  #kill(term: LiveTerminal, why: string): void {
    if (term.pty) {
      try {
        term.pty.kill();
      } catch (err: any) {
        log(`terminal ${term.terminal_id.slice(0, 8)} kill failed: ${err?.message ?? err}`);
      }
    }
    if (term.status === 'starting' || term.status === 'live') {
      term.status = 'exited';
      term.updated_at = nowIso();
      term.reapAt = Date.now() + REAP_DELAY_MS;
      void this.#flush(term, { status: 'exited', reason: why });
    }
  }

  // ─── 정리 ───────────────────────────────────────────────────────────────

  #info(term: LiveTerminal): TerminalInfo {
    return {
      terminal_id: term.terminal_id,
      shell: term.shell,
      shell_label: term.shell_label,
      cwd: term.cwd,
      title: term.title,
      cols: term.cols,
      rows: term.rows,
      pid: term.pid,
      status: term.status,
      exit_code: term.exit_code,
      last_error: term.last_error,
      created_at: term.created_at,
      updated_at: term.updated_at,
    };
  }

  #reapExited(): void {
    const now = Date.now();
    for (const [id, term] of this.#terminals) {
      if (term.reapAt !== null && term.reapAt <= now) this.#terminals.delete(id);
    }
  }

  #reapIdle(idleMs: number): void {
    this.#reapExited();
    const cutoff = Date.now() - idleMs;
    for (const term of this.#terminals.values()) {
      if (term.status !== 'live') continue;
      if (term.lastActiveAt > cutoff) continue;
      log(`terminal ${term.terminal_id.slice(0, 8)} idle for too long — closing`);
      this.#kill(term, 'idle');
    }
  }

  /** 매니저 종료 — 모든 PTY 를 내린다. 서버 쪽 유령은 하트비트 부재로 정리된다. */
  async stopAll(reason = 'manager shutting down'): Promise<void> {
    if (this.#stopped) return;
    this.#stopped = true;
    if (this.#idleTimer) clearInterval(this.#idleTimer);
    const terms = Array.from(this.#terminals.values());
    for (const term of terms) this.#kill(term, reason);
    // 마지막 상태 패치가 나갈 시간을 조금 준다(agent-session stopAll 과 같은 규약).
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline && terms.some((t) => t.flushing || t.pendingOut.length)) {
      await new Promise((r) => setTimeout(r, 50));
    }
    for (const term of terms) {
      await patchTerminalState(
        this.#config,
        { manager_id: this.#opts.getManagerId(), terminal_id: term.terminal_id },
        { status: 'exited', reason },
      ).catch(() => undefined);
    }
    this.#terminals.clear();
  }
}
