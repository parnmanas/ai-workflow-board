import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { randomUUID } from 'node:crypto';
import { In, Repository } from 'typeorm';
import { Agent } from '../../entities/Agent';
import { activityEvents } from '../../services/activity.service';
import { LogService } from '../../services/log.service';
import { InstanceRecord, InstanceRegistryService } from '../agent-manager/instance-registry.service';
import {
  TERMINAL_IN_FLIGHT_STATUSES,
  TERMINAL_INPUT_MAX_CHARS,
  TERMINAL_LIST_LIMIT,
  TERMINAL_OUTPUT_BATCH_MAX,
  TERMINAL_PER_HOST_MAX,
  TERMINAL_STATUSES,
  clampCols,
  clampRows,
} from '../../common/types/terminals';
import type {
  TerminalOutputChunk,
  TerminalShellInfo,
  TerminalSnapshot,
  TerminalSummary,
} from '../../common/types/terminals';
import type { TerminalRequestPayload } from '../../common/types/stream-events';

export class TerminalError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message?: string,
  ) {
    super(message || code);
  }
}

/** 터미널을 띄울 수 있는 Runtime Host 한 줄. */
export interface TerminalHost {
  manager_id: string;
  instance_id: string;
  hostname: string;
  name: string;
  /** 장비의 OS — 화면이 셸 이름을 설명할 때만 쓴다('win32' | 'linux' | 'darwin' | ''). */
  platform: string;
  shells: TerminalShellInfo[];
  plugin_version: string;
  last_seen_at: string;
  /** 지금 이 장비에 살아 있다고 **서버가 아는** 터미널 수. 정확한 목록은 list RPC. */
  live_count: number;
}

/** 매니저가 PATCH / events 로 보내는 상태 패치. */
export interface TerminalStatePatch {
  status?: string;
  cwd?: string;
  title?: string;
  cols?: number;
  rows?: number;
  pid?: number | null;
  exit_code?: number | null;
  last_error?: string | null;
  reason?: string;
}

interface LiveTerminal {
  manager_id: string;
  manager_name: string;
  terminal_id: string;
  shell: string;
  shell_label: string;
  cwd: string;
  title: string;
  cols: number;
  rows: number;
  pid: number | null;
  status: string;
  exit_code: number | null;
  last_error: string | null;
  driver_user_id: string | null;
  created_at: number;
  updated_at: number;
}

interface PendingRpc {
  manager_id: string;
  op: string;
  created_at: number;
  resolve: (body: RpcResponseBody) => void;
  timer: NodeJS.Timeout;
}

export interface RpcResponseBody {
  ok: boolean;
  result?: any;
  error?: string;
  code?: string;
}

const STATUS_SET: ReadonlySet<string> = new Set(TERMINAL_STATUSES);
const TERMINAL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const SHELL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;
const CWD_MAX = 1024;
const TITLE_MAX = 200;
const MAX_PENDING = 200;
const RPC_TIMEOUT_MS: Record<string, number> = { list: 15_000, open: 30_000, attach: 20_000 };
/** 끝난 터미널을 메모리에서 지우기까지의 유예 — 화면이 "exited" 를 한 번은 보게 한다. */
const EXITED_TTL_MS = 60_000;
/** 살아 있는 터미널의 메모리 TTL — 이보다 오래 아무 소식이 없으면 버린다(하트비트는 30초마다 온다). */
const LIVE_TTL_MS = 6 * 60 * 60_000;
/** open RPC 가 도는 동안은 매니저가 "없다" 고 해도 믿지 않는다. */
const STARTING_GRACE_MS = RPC_TIMEOUT_MS.open;

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function liveKey(managerId: string, terminalId: string): string {
  return `${managerId}/${terminalId}`;
}

function str(v: unknown, max: number): string {
  return typeof v === 'string' ? v.slice(0, max) : '';
}

/**
 * Terminal(Runtime Host 셸) — 상태 없는 중계자.
 *
 *   - 목록/스냅샷은 매니저에게 reverse RPC 로 묻는다(agent-sessions 와 같은 패턴:
 *     `terminal_request{request_id}` SSE → 매니저 REST 응답). 저장하지 않는다.
 *   - 살아 있는 터미널의 상태(status/크기/driver)만 메모리에 두고, 매니저가 보내는
 *     PTY 출력 청크를 driver(마지막으로 열거나 attach 한 사용자)에게 SSE 로 흘린다.
 *   - 터미널은 프로세스가 곧 존재다 — 매니저가 보고하지 않는 터미널은 없는 것이다.
 */
@Injectable()
export class TerminalsService implements OnModuleDestroy {
  private readonly pending = new Map<string, PendingRpc>();
  private readonly live = new Map<string, LiveTerminal>();

  /**
   * 매니저 프로세스가 사라지면 그 장비의 PTY 도 전부 함께 죽는다(systemd 는 cgroup 전체에
   * SIGTERM 을 보낸다). 메모리에 남은 live 행은 유령이므로 여기서 정리한다.
   */
  private readonly onInstanceUpdate = (event: any) => {
    const instance = event?.instance;
    if (!instance || instance.mode !== 'manager' || typeof instance.agent_id !== 'string') return;
    if (event.action === 'removed') {
      if (this.managerRecords().some((r) => r.agent_id === instance.agent_id)) return;
      this.markHostOffline(instance.agent_id);
      return;
    }
    if (Array.isArray(instance.terminals)) this.reconcileWithHeartbeat(instance.agent_id, instance.terminals);
  };

  constructor(
    @InjectRepository(Agent) private readonly agents: Repository<Agent>,
    private readonly registry: InstanceRegistryService,
    private readonly logService: LogService,
  ) {
    activityEvents.on('agent_instance_update', this.onInstanceUpdate);
  }

  onModuleDestroy() {
    activityEvents.removeListener('agent_instance_update', this.onInstanceUpdate);
  }

  // ─── Hosts ──────────────────────────────────────────────────────────────

  private managerRecords(): InstanceRecord[] {
    return this.registry.list().filter((r) => r.mode === 'manager');
  }

  /** 이 장비가 보고한 셸 목록. 비어 있으면 터미널을 못 띄우는 매니저다(구버전 또는 PTY 모듈 없음). */
  private hostShells(rec: InstanceRecord): TerminalShellInfo[] {
    const raw = rec.terminal_shells;
    if (!Array.isArray(raw)) return [];
    const out: TerminalShellInfo[] = [];
    for (const item of raw.slice(0, 32)) {
      if (!item || typeof item !== 'object') continue;
      const id = str((item as any).id, 64);
      if (!SHELL_ID_RE.test(id)) continue;
      out.push({
        id,
        label: str((item as any).label, 100) || id,
        path: str((item as any).path, CWD_MAX),
        ...((item as any).default ? { default: true } : {}),
      });
    }
    return out;
  }

  async listHosts(_workspaceId: string): Promise<TerminalHost[]> {
    const records = this.managerRecords();
    const ids = Array.from(new Set(records.map((r) => r.agent_id)));
    const names = new Map<string, string>();
    if (ids.length) {
      for (const a of await this.agents.find({ where: { id: In(ids) } })) {
        if (a.name) names.set(a.id, a.name);
      }
    }
    const byManager = new Map<string, TerminalHost>();
    for (const rec of records) {
      const shells = this.hostShells(rec);
      // PTY 를 못 띄우는 장비는 목록에 넣지 않는다 — 눌러도 열리지 않는 행을 보여줄 이유가 없다.
      if (!shells.length) continue;
      const existing = byManager.get(rec.agent_id);
      if (existing) {
        if (rec.last_seen_at > existing.last_seen_at) existing.last_seen_at = rec.last_seen_at;
        continue;
      }
      byManager.set(rec.agent_id, {
        manager_id: rec.agent_id,
        instance_id: rec.instance_id,
        hostname: rec.hostname,
        name: names.get(rec.agent_id) || rec.hostname,
        platform: typeof rec.platform === 'string' ? rec.platform : '',
        shells,
        plugin_version: rec.plugin_version,
        last_seen_at: rec.last_seen_at,
        live_count: this.countLive(rec.agent_id),
      });
    }
    return Array.from(byManager.values()).sort((a, b) => a.name.localeCompare(b.name));
  }

  private countLive(managerId: string): number {
    let n = 0;
    for (const t of this.live.values()) {
      if (t.manager_id === managerId && TERMINAL_IN_FLIGHT_STATUSES.has(t.status)) n += 1;
    }
    return n;
  }

  private requireHost(managerId: string): InstanceRecord {
    const rec = this.managerRecords().find((r) => r.agent_id === managerId);
    if (!rec) throw new TerminalError(404, 'host_offline', 'This Runtime Host is not connected right now.');
    if (!this.hostShells(rec).length) {
      throw new TerminalError(409, 'terminal_unsupported', `Runtime Host ${rec.hostname} cannot open terminals (no PTY support reported).`);
    }
    return rec;
  }

  private async managerName(managerId: string, fallback: string): Promise<string> {
    const agent = await this.agents.findOne({ where: { id: managerId } });
    return agent?.name || fallback;
  }

  // ─── RPC (서버 → 매니저) ────────────────────────────────────────────────

  private rpc<T>(managerId: string, op: 'list' | 'open' | 'attach', args: Partial<TerminalRequestPayload>, driverUserId: string): Promise<T> {
    if (this.pending.size >= MAX_PENDING) {
      throw new TerminalError(503, 'too_many_requests', 'Too many in-flight terminal requests; try again shortly.');
    }
    const requestId = randomUUID();
    const timeoutMs = RPC_TIMEOUT_MS[op];
    const promise = new Promise<RpcResponseBody>((resolve) => {
      const timer = setTimeout(() => {
        if (!this.pending.delete(requestId)) return;
        this.logService.warn('Terminal', `rpc ${op} timed out (manager=${managerId.slice(0, 8)})`);
        resolve({ ok: false, error: 'The Runtime Host did not respond in time.', code: 'timeout' });
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(requestId, { manager_id: managerId, op, created_at: Date.now(), resolve, timer });
    });
    this.emitRequest({ manager_id: managerId, workspace_id: '', op, request_id: requestId, driver_user_id: driverUserId, ...args });
    return promise.then((body) => {
      if (!body.ok) {
        const status = body.code === 'timeout' ? 504 : body.code === 'not_found' ? 404 : 502;
        throw new TerminalError(status, body.code || 'manager_error', body.error || 'Runtime Host reported an error.');
      }
      return body.result as T;
    });
  }

  /** 매니저 → 서버. request_id 소유 매니저만 풀 수 있다. */
  resolveRpc(requestId: string, managerId: string, body: RpcResponseBody): { ok: boolean; reason?: string } {
    const entry = this.pending.get(requestId);
    if (!entry) return { ok: false, reason: 'Unknown or expired request_id' };
    if (entry.manager_id !== managerId) return { ok: false, reason: 'request_id belongs to a different Runtime Host' };
    clearTimeout(entry.timer);
    this.pending.delete(requestId);
    entry.resolve({ ok: body?.ok === true, result: body?.result, error: body?.error, code: body?.code });
    return { ok: true };
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  // ─── 사용자 읽기 ────────────────────────────────────────────────────────

  /**
   * 살아 있는 터미널만 돌려준다. 매니저의 라이브 테이블이 유일한 원천이므로, 답에 없는
   * 메모리 행은 (starting 유예를 빼고) 그 자리에서 정리한다 — 터미널은 기록이 없어서
   * "예전에 있었던 것" 을 보여줄 이유가 전혀 없다.
   */
  async listTerminals(workspaceId: string, userId: string, managerId: string): Promise<TerminalSummary[]> {
    const rec = this.requireHost(managerId);
    const result = await this.rpc<{ terminals?: unknown }>(managerId, 'list', { workspace_id: workspaceId }, userId);
    const raw = Array.isArray(result?.terminals) ? result.terminals.slice(0, TERMINAL_LIST_LIMIT) : [];
    const managerName = await this.managerName(managerId, rec.hostname);
    const seen = new Set<string>();
    const out: TerminalSummary[] = [];
    for (const item of raw as any[]) {
      const terminalId = typeof item?.terminal_id === 'string' ? item.terminal_id : '';
      if (!TERMINAL_ID_RE.test(terminalId)) continue;
      const state = this.upsertFromManager(managerId, managerName, terminalId, item);
      seen.add(liveKey(managerId, terminalId));
      if (!TERMINAL_IN_FLIGHT_STATUSES.has(state.status)) continue;
      out.push(this.snapshot(state));
    }
    this.dropUnreported(managerId, seen, 'list');
    return out.sort((a, b) => a.created_at.localeCompare(b.created_at));
  }

  /**
   * 터미널에 붙는다 — 매니저가 들고 있던 스크롤백을 한 번 받아 화면을 다시 그리고,
   * 그 순간부터 이 사용자가 driver 가 된다(출력 SSE 를 받는 사람).
   */
  async attach(workspaceId: string, userId: string, managerId: string, terminalId: string, size?: { cols?: unknown; rows?: unknown }): Promise<TerminalSnapshot> {
    const rec = this.requireHost(managerId);
    this.assertTerminalId(terminalId);
    const cols = size?.cols === undefined ? undefined : clampCols(size.cols);
    const rows = size?.rows === undefined ? undefined : clampRows(size.rows);
    const result = await this.rpc<Record<string, any>>(managerId, 'attach', {
      workspace_id: workspaceId,
      terminal_id: terminalId,
      ...(cols !== undefined ? { cols } : {}),
      ...(rows !== undefined ? { rows } : {}),
    }, userId);
    const managerName = await this.managerName(managerId, rec.hostname);
    const state = this.upsertFromManager(managerId, managerName, terminalId, result?.terminal ?? {});
    state.driver_user_id = userId;
    state.updated_at = Date.now();
    const snap = this.snapshot(state);
    this.emitUpdate(state, 'attached');
    return {
      terminal: snap,
      data: typeof result?.data === 'string' ? result.data : '',
      seq: Number.isFinite(result?.seq) ? Number(result.seq) : 0,
      truncated: result?.truncated === true,
    };
  }

  // ─── 사용자 쓰기 ────────────────────────────────────────────────────────

  async openTerminal(
    workspaceId: string,
    userId: string,
    managerId: string,
    input: { shell?: string | null; cwd?: string; title?: string; cols?: unknown; rows?: unknown },
  ): Promise<TerminalSummary> {
    const rec = this.requireHost(managerId);
    const shells = this.hostShells(rec);
    const shell = String(input.shell ?? '').trim();
    if (shell && !shells.some((s) => s.id === shell)) {
      throw new TerminalError(400, 'shell_unknown', `Runtime Host ${rec.hostname} does not offer a "${shell}" shell.`);
    }
    const cwd = String(input.cwd ?? '').trim();
    if (cwd.length > CWD_MAX) throw new TerminalError(400, 'cwd_too_long');
    const title = String(input.title ?? '').trim().slice(0, TITLE_MAX);
    const cols = clampCols(input.cols);
    const rows = clampRows(input.rows);
    if (this.countLive(managerId) >= TERMINAL_PER_HOST_MAX) {
      throw new TerminalError(429, 'too_many_terminals', `This Runtime Host already has ${TERMINAL_PER_HOST_MAX} live terminals. Close one first.`);
    }
    const result = await this.rpc<Record<string, any>>(managerId, 'open', {
      workspace_id: workspaceId,
      terminal_id: null,
      shell: shell || null,
      cwd,
      title,
      cols,
      rows,
    }, userId);
    const openedId = typeof result?.terminal_id === 'string' ? result.terminal_id : '';
    if (!TERMINAL_ID_RE.test(openedId)) throw new TerminalError(502, 'manager_error', 'Runtime Host did not return a terminal id.');
    const managerName = await this.managerName(managerId, rec.hostname);
    const state = this.upsertFromManager(managerId, managerName, openedId, { cols, rows, cwd, title, shell, status: 'live', ...(result?.terminal ?? result ?? {}) });
    state.driver_user_id = userId;
    this.logService.info('Terminal', `opened ${openedId.slice(0, 8)} on ${managerName} (${state.shell_label || state.shell})`);
    return this.emitUpdate(state, 'opened');
  }

  /** 키 입력. PTY 는 조용히 받으므로 fire-and-forget 이다 — 답은 출력 스트림으로 온다. */
  write(workspaceId: string, userId: string, managerId: string, terminalId: string, dataInput: unknown): { ok: true } {
    this.requireHost(managerId);
    this.assertTerminalId(terminalId);
    const data = typeof dataInput === 'string' ? dataInput : '';
    if (!data) throw new TerminalError(400, 'data_required');
    if (data.length > TERMINAL_INPUT_MAX_CHARS) throw new TerminalError(413, 'data_too_long');
    const state = this.requireLive(managerId, terminalId);
    // 입력한 사람이 곧 driver 다 — 그래야 그 답(에코·출력)이 자기 화면으로 온다.
    state.driver_user_id = userId;
    state.updated_at = Date.now();
    this.emitRequest({ manager_id: managerId, workspace_id: workspaceId, op: 'input', terminal_id: terminalId, data, driver_user_id: userId });
    return { ok: true };
  }

  resize(workspaceId: string, userId: string, managerId: string, terminalId: string, colsInput: unknown, rowsInput: unknown): TerminalSummary {
    this.requireHost(managerId);
    this.assertTerminalId(terminalId);
    const state = this.requireLive(managerId, terminalId);
    const cols = clampCols(colsInput, state.cols);
    const rows = clampRows(rowsInput, state.rows);
    if (cols === state.cols && rows === state.rows) return this.snapshot(state);
    state.cols = cols;
    state.rows = rows;
    state.updated_at = Date.now();
    this.emitRequest({ manager_id: managerId, workspace_id: workspaceId, op: 'resize', terminal_id: terminalId, cols, rows, driver_user_id: userId });
    return this.emitUpdate(state, 'resized');
  }

  /**
   * 터미널을 닫는다. 이미 끝난 터미널에도 409 를 내지 않는다 — 사용자가 누르는 이유는
   * "이 행을 치워라" 이고, 매니저가 이미 치웠다면 그 요청은 그냥 만족된 것이다.
   */
  close(workspaceId: string, userId: string, managerId: string, terminalId: string): TerminalSummary | { ok: true } {
    this.requireHost(managerId);
    this.assertTerminalId(terminalId);
    this.emitRequest({ manager_id: managerId, workspace_id: workspaceId, op: 'close', terminal_id: terminalId, driver_user_id: userId });
    const state = this.live.get(liveKey(managerId, terminalId));
    if (!state) return { ok: true };
    state.driver_user_id = userId;
    if (TERMINAL_IN_FLIGHT_STATUSES.has(state.status)) {
      state.status = 'exited';
      state.updated_at = Date.now();
    }
    return this.emitUpdate(state, 'closed');
  }

  // ─── 매니저 쓰기 ────────────────────────────────────────────────────────

  /** PTY 출력 청크 중계(저장 없음). 상태 패치가 함께 오면 같이 적용한다. */
  relayOutput(managerId: string, terminalId: string, chunksInput: unknown, patch?: TerminalStatePatch | null): { relayed: number; terminal: TerminalSummary | null } {
    if (!Array.isArray(chunksInput)) throw new TerminalError(400, 'chunks_required');
    if (chunksInput.length > TERMINAL_OUTPUT_BATCH_MAX) throw new TerminalError(413, 'chunks_batch_too_large');
    this.assertTerminalId(terminalId);
    const key = liveKey(managerId, terminalId);
    let state = this.live.get(key);
    if (!state) {
      // 서버가 재시작한 뒤 매니저가 먼저 말을 거는 경우 — driver 없이 상태만 둔다.
      state = this.createState(managerId, managerId.slice(0, 8), terminalId, { status: 'live' });
    }
    const chunks: TerminalOutputChunk[] = [];
    for (let i = 0; i < chunksInput.length; i += 1) {
      const raw = chunksInput[i] as any;
      const data = typeof raw?.data === 'string' ? raw.data : '';
      if (!data) continue;
      chunks.push({
        seq: Number.isFinite(raw?.seq) ? Number(raw.seq) : i + 1,
        data,
        created_at: typeof raw?.created_at === 'string' ? raw.created_at : new Date().toISOString(),
      });
    }
    if (state.driver_user_id) {
      for (const chunk of chunks) {
        activityEvents.emit('terminal_output', {
          manager_id: managerId,
          terminal_id: terminalId,
          driver_user_id: state.driver_user_id,
          chunk,
          timestamp: chunk.created_at,
        });
      }
    }
    let terminal: TerminalSummary | null = null;
    if (patch && Object.keys(patch).length) {
      this.applyPatch(state, patch);
      terminal = this.emitUpdate(state, patch.reason || 'manager_patch');
    } else {
      state.updated_at = Date.now();
    }
    return { relayed: chunks.length, terminal };
  }

  applyState(managerId: string, terminalId: string, patch: TerminalStatePatch): TerminalSummary {
    this.assertTerminalId(terminalId);
    const state = this.live.get(liveKey(managerId, terminalId))
      ?? this.createState(managerId, managerId.slice(0, 8), terminalId, { status: 'live' });
    this.applyPatch(state, patch);
    return this.emitUpdate(state, patch.reason || 'manager_patch');
  }

  // ─── 매니저 답과 메모리 맞추기 ──────────────────────────────────────────

  /**
   * 하트비트의 `terminals`(이 매니저에 살아 있는 터미널 전체)로 메모리를 맞춘다 — 30초마다 온다.
   * 보고에 없는데 메모리가 살아 있으면 그 행은 유령이다(매니저 재시작·PTY 사망·연결 단절).
   * `starting` 만은 open RPC 가 끝나기 전 하트비트가 먼저 올 수 있어 유예를 둔다.
   */
  reconcileWithHeartbeat(managerId: string, reported: Array<{ terminal_id: string; status: string }>): number {
    const byKey = new Map<string, string>();
    for (const e of reported) {
      if (e && typeof e.terminal_id === 'string' && STATUS_SET.has(e.status)) byKey.set(liveKey(managerId, e.terminal_id), e.status);
    }
    let changed = 0;
    for (const [key, state] of this.live) {
      if (state.manager_id !== managerId) continue;
      const status = byKey.get(key);
      if (status) {
        if (status === state.status) continue;
        state.status = status;
        state.updated_at = Date.now();
        this.emitUpdate(state, 'heartbeat');
        changed += 1;
        continue;
      }
      if (this.retireGhost(state, 'heartbeat')) changed += 1;
    }
    this.sweep();
    return changed;
  }

  /** list RPC 답에 없는 행을 정리한다 — heartbeat 와 같은 규칙. */
  private dropUnreported(managerId: string, seen: Set<string>, reason: string): void {
    for (const [key, state] of this.live) {
      if (state.manager_id !== managerId || seen.has(key)) continue;
      this.retireGhost(state, reason);
    }
    this.sweep();
  }

  /** 매니저가 모르는 살아 있는 행 → exited. `starting` 은 open 이 끝날 때까지 지킨다. */
  private retireGhost(state: LiveTerminal, reason: string): boolean {
    if (!TERMINAL_IN_FLIGHT_STATUSES.has(state.status)) return false;
    if (state.status === 'starting' && Date.now() - state.updated_at < STARTING_GRACE_MS) return false;
    state.status = 'exited';
    state.updated_at = Date.now();
    this.emitUpdate(state, reason);
    return true;
  }

  /** 이 Runtime Host 가 사라졌다 — 그 장비의 PTY 는 전부 함께 죽었다. */
  markHostOffline(managerId: string): number {
    let changed = 0;
    for (const state of this.live.values()) {
      if (state.manager_id !== managerId) continue;
      if (this.retireGhost(state, 'host_offline')) changed += 1;
    }
    if (changed) this.logService.info('Terminal', `Runtime Host ${managerId.slice(0, 8)} went away — ${changed} live terminal(s) marked exited`);
    this.sweep();
    return changed;
  }

  // ─── 내부 ───────────────────────────────────────────────────────────────

  private assertTerminalId(terminalId: string): void {
    if (!TERMINAL_ID_RE.test(terminalId || '')) throw new TerminalError(400, 'terminal_id_invalid');
  }

  private requireLive(managerId: string, terminalId: string): LiveTerminal {
    const state = this.live.get(liveKey(managerId, terminalId));
    if (!state) throw new TerminalError(404, 'terminal_not_found', 'This terminal is not live on that Runtime Host.');
    if (!TERMINAL_IN_FLIGHT_STATUSES.has(state.status)) {
      throw new TerminalError(409, 'terminal_closed', 'This terminal has exited.');
    }
    return state;
  }

  /** 매니저가 보고한 한 줄로 메모리를 만들거나 고친다. */
  private upsertFromManager(managerId: string, managerName: string, terminalId: string, raw: any): LiveTerminal {
    const key = liveKey(managerId, terminalId);
    let state = this.live.get(key);
    if (!state) {
      state = this.createState(managerId, managerName, terminalId, {
        status: typeof raw?.status === 'string' ? raw.status : 'live',
        created_at: typeof raw?.created_at === 'string' ? Date.parse(raw.created_at) || Date.now() : Date.now(),
      });
    }
    state.manager_name = managerName || state.manager_name;
    if (typeof raw?.shell === 'string' && raw.shell) state.shell = raw.shell.slice(0, 64);
    if (typeof raw?.shell_label === 'string' && raw.shell_label) state.shell_label = raw.shell_label.slice(0, 100);
    this.applyPatch(state, {
      ...(typeof raw?.status === 'string' ? { status: raw.status } : {}),
      ...(typeof raw?.cwd === 'string' ? { cwd: raw.cwd } : {}),
      ...(typeof raw?.title === 'string' ? { title: raw.title } : {}),
      ...(raw?.cols !== undefined ? { cols: raw.cols } : {}),
      ...(raw?.rows !== undefined ? { rows: raw.rows } : {}),
      ...(raw?.pid !== undefined ? { pid: raw.pid } : {}),
      ...(raw?.exit_code !== undefined ? { exit_code: raw.exit_code } : {}),
      ...(raw?.last_error !== undefined ? { last_error: raw.last_error } : {}),
    });
    return state;
  }

  private createState(
    managerId: string,
    managerName: string,
    terminalId: string,
    seed: { status: string; created_at?: number },
  ): LiveTerminal {
    this.sweep();
    const now = Date.now();
    const state: LiveTerminal = {
      manager_id: managerId,
      manager_name: managerName,
      terminal_id: terminalId,
      shell: '',
      shell_label: '',
      cwd: '',
      title: '',
      cols: 80,
      rows: 24,
      pid: null,
      status: STATUS_SET.has(seed.status) ? seed.status : 'live',
      exit_code: null,
      last_error: null,
      driver_user_id: null,
      created_at: seed.created_at ?? now,
      updated_at: now,
    };
    this.live.set(liveKey(managerId, terminalId), state);
    return state;
  }

  private applyPatch(state: LiveTerminal, patch: TerminalStatePatch): void {
    if (patch.status !== undefined) {
      if (typeof patch.status !== 'string' || !STATUS_SET.has(patch.status)) throw new TerminalError(400, 'status_invalid');
      state.status = patch.status;
    }
    if (typeof patch.cwd === 'string') state.cwd = patch.cwd.slice(0, CWD_MAX);
    if (typeof patch.title === 'string') state.title = patch.title.slice(0, TITLE_MAX);
    if (patch.cols !== undefined) state.cols = clampCols(patch.cols, state.cols);
    if (patch.rows !== undefined) state.rows = clampRows(patch.rows, state.rows);
    if (patch.pid !== undefined) state.pid = Number.isFinite(patch.pid as number) ? Number(patch.pid) : null;
    if (patch.exit_code !== undefined) state.exit_code = Number.isFinite(patch.exit_code as number) ? Number(patch.exit_code) : null;
    if (patch.last_error !== undefined) state.last_error = patch.last_error ? String(patch.last_error).slice(0, 4000) : null;
    state.updated_at = Date.now();
  }

  /** 끝난 터미널은 짧은 유예 뒤 메모리에서 지운다 — 목록에는 살아 있는 것만 남는다. */
  private sweep(): void {
    const now = Date.now();
    for (const [key, state] of this.live) {
      const age = now - state.updated_at;
      if (!TERMINAL_IN_FLIGHT_STATUSES.has(state.status) ? age > EXITED_TTL_MS : age > LIVE_TTL_MS) {
        this.live.delete(key);
      }
    }
  }

  snapshot(state: LiveTerminal): TerminalSummary {
    return {
      manager_id: state.manager_id,
      manager_name: state.manager_name,
      terminal_id: state.terminal_id,
      shell: state.shell,
      shell_label: state.shell_label || state.shell,
      cwd: state.cwd,
      title: state.title,
      cols: state.cols,
      rows: state.rows,
      pid: state.pid,
      status: state.status,
      exit_code: state.exit_code,
      last_error: state.last_error,
      driver_user_id: state.driver_user_id,
      created_at: iso(state.created_at),
      updated_at: iso(state.updated_at),
    };
  }

  private emitUpdate(state: LiveTerminal, reason: string): TerminalSummary {
    const snap = this.snapshot(state);
    if (state.driver_user_id) {
      activityEvents.emit('terminal_update', {
        terminal: snap,
        reason,
        driver_user_id: state.driver_user_id,
        timestamp: snap.updated_at,
      });
    }
    return snap;
  }

  private emitRequest(fields: Omit<TerminalRequestPayload, 'issued_at'>): void {
    const payload: TerminalRequestPayload = { ...fields, issued_at: new Date().toISOString() };
    activityEvents.emit('terminal_request', payload);
  }
}
