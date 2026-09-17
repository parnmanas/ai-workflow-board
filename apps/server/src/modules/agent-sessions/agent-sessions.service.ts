import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { randomUUID } from 'node:crypto';
import { In, IsNull, Like, Repository } from 'typeorm';
import { Agent } from '../../entities/Agent';
import { AgentSessionCliSetting } from '../../entities/AgentSessionCliSetting';
import { Credential } from '../../entities/Credential';
import { decrypt } from '../../services/encryption.service';
import { normalizeCredentialFields } from '../../common/credential-fields';
import { activityEvents } from '../../services/activity.service';
import { LogService } from '../../services/log.service';
import { InstanceRecord, InstanceRegistryService } from '../agent-manager/instance-registry.service';
import {
  ACP_SESSION_CLIS,
  AGENT_SESSION_EVENT_BATCH_MAX,
  AGENT_SESSION_EVENT_PAYLOAD_MAX_CHARS,
  AGENT_SESSION_EVENT_TYPES,
  AGENT_SESSION_PROMPT_MAX_CHARS,
  AGENT_SESSION_STATUSES,
  agentSessionAcceptsPrompt,
  type AgentSessionEventRecord,
  type AgentSessionSummary,
} from '../../common/types/agent-sessions';
import type {
  AgentSessionLiveSnapshot,
  AgentSessionModeOption,
  AgentSessionRequestPayload,
} from '../../common/types/stream-events';

/** 컨트롤러가 HTTP 상태로 옮기는 도메인 오류. */
export class AgentSessionError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message?: string,
  ) {
    super(message || code);
    this.name = 'AgentSessionError';
  }
}

/** CLI 설정에 묶인 credential 의 공개 투영(비밀 없음). */
export interface AgentSessionCredentialRef {
  id: string;
  name: string;
  provider: string;
  scope: 'global' | 'workspace';
}

/** 세션을 열 수 있는 Runtime Host 한 대 (+ 그 장비에서 세션이 되는 CLI). */
export interface AgentSessionHost {
  manager_id: string;
  instance_id: string;
  hostname: string;
  /** Agent.name (운영자가 붙인 이름) — 없으면 hostname. */
  name: string;
  clis: string[];
  plugin_version: string;
  last_seen_at: string;
  /** cli → 이 워크스페이스의 CLI 설정(credential). null = 장비 운영자 로그인 사용. */
  cli_settings: Record<string, AgentSessionCredentialRef | null>;
}

export interface AgentSessionCliSettings {
  manager_id: string;
  cli: string;
  /** 이 CLI 가 AWB credential 을 받을 수 있는가(hermes 는 아직 아니다). */
  supports_credential: boolean;
  credential: AgentSessionCredentialRef | null;
  candidates: AgentSessionCredentialRef[];
  updated_at: string | null;
}

/** CLI → 호환 credential provider 접두어. agents 화면의 CLI_TO_CREDENTIAL_PREFIX 와 같은 규약. */
export const SESSION_CLI_CREDENTIAL_PREFIX: Record<string, string> = {
  claude: 'claude_',
  codex: 'codex_',
};

export interface ManagerStatePatch {
  status?: string;
  cwd?: string;
  title?: string;
  current_mode?: string | null;
  available_modes?: AgentSessionModeOption[] | null;
  resume_supported?: boolean;
  last_error?: string | null;
  reason?: string;
}

interface LiveState {
  manager_id: string;
  manager_name: string;
  cli: string;
  session_id: string;
  cwd: string;
  title: string;
  status: string;
  current_mode: string | null;
  available_modes: AgentSessionModeOption[];
  resume_supported: boolean;
  last_error: string | null;
  driver_user_id: string | null;
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

const STATUS_SET: ReadonlySet<string> = new Set(AGENT_SESSION_STATUSES);
const EVENT_TYPE_SET: ReadonlySet<string> = new Set(AGENT_SESSION_EVENT_TYPES);
const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const CLI_RE = /^[a-z][a-z0-9_-]{0,31}$/;
const CWD_MAX = 1024;
const TITLE_MAX = 200;
const MAX_PENDING = 200;
const LIVE_TTL_MS = 24 * 60 * 60_000;
const RPC_TIMEOUT_MS = { list: 20_000, history: 40_000, open: 120_000 } as const;

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function liveKey(managerId: string, cli: string, sessionId: string): string {
  return `${managerId}/${cli}/${sessionId}`;
}

/**
 * Agent Session(CLI 직접 세션) — 상태 없는 중계자.
 *
 *   - 세션 목록/기록은 매니저에게 reverse RPC 로 묻는다(fs-browser 와 같은 패턴:
 *     `agent_session_request{request_id}` SSE → 매니저 REST 응답). 저장하지 않는다.
 *   - 살아 있는 세션의 상태(status/mode/driver)만 메모리에 두고, 매니저가 보내는
 *     스트림 이벤트를 driver(마지막으로 open/prompt 한 사용자)에게 SSE 로 흘린다.
 */
@Injectable()
export class AgentSessionsService {
  private readonly pending = new Map<string, PendingRpc>();
  private readonly live = new Map<string, LiveState>();

  constructor(
    @InjectRepository(Agent) private readonly agents: Repository<Agent>,
    @InjectRepository(AgentSessionCliSetting) private readonly settings: Repository<AgentSessionCliSetting>,
    @InjectRepository(Credential) private readonly credentials: Repository<Credential>,
    private readonly registry: InstanceRegistryService,
    private readonly logService: LogService,
  ) {}

  // ─── Hosts ──────────────────────────────────────────────────────────────

  /** 매니저 identity 는 워크스페이스에 속하지 않는다(하트비트가 workspace_id:null 로
   *  등록). 세션은 장비의 것이므로 살아 있는 모든 Runtime Host 를 보여준다. */
  private managerRecords(): InstanceRecord[] {
    return this.registry.list().filter((r) => r.mode === 'manager');
  }

  async listHosts(workspaceId: string): Promise<AgentSessionHost[]> {
    const records = this.managerRecords();
    const ids = Array.from(new Set(records.map((r) => r.agent_id)));
    const names = new Map<string, string>();
    if (ids.length) {
      for (const a of await this.agents.find({ where: { id: In(ids) } })) {
        if (a.name) names.set(a.id, a.name);
      }
    }
    const settingsByHost = await this.cliSettingsMap(workspaceId, ids);
    // 같은 매니저 identity 로 여러 프로세스가 떠 있어도 host 는 하나로 보여준다.
    const byManager = new Map<string, AgentSessionHost>();
    for (const rec of records) {
      const clis = this.hostClis(rec);
      const existing = byManager.get(rec.agent_id);
      if (existing) {
        for (const cli of clis) if (!existing.clis.includes(cli)) existing.clis.push(cli);
        if (rec.last_seen_at > existing.last_seen_at) existing.last_seen_at = rec.last_seen_at;
        continue;
      }
      byManager.set(rec.agent_id, {
        manager_id: rec.agent_id,
        instance_id: rec.instance_id,
        hostname: rec.hostname,
        name: names.get(rec.agent_id) || rec.hostname,
        clis,
        plugin_version: rec.plugin_version,
        last_seen_at: rec.last_seen_at,
        cli_settings: settingsByHost.get(rec.agent_id) ?? {},
      });
    }
    return Array.from(byManager.values()).sort((a, b) => a.name.localeCompare(b.name));
  }

  private hostClis(rec: InstanceRecord): string[] {
    // 매니저가 직접 보고한 값이 우선(ACP 어댑터 존재 여부까지 본 것). 구버전 매니저는
    // 설치된 CLI 어댑터 중 세션이 되는 것만 추린다.
    const reported = rec.acp_session_clis;
    const base = Array.isArray(reported) && reported.length
      ? reported
      : (rec.cli_adapters || []).filter((cli) => ACP_SESSION_CLIS.has(cli));
    return Array.from(new Set(base.filter((cli) => ACP_SESSION_CLIS.has(cli))));
  }

  private requireHost(_workspaceId: string, managerId: string, cli: string): InstanceRecord {
    if (!CLI_RE.test(cli)) throw new AgentSessionError(400, 'cli_invalid');
    const rec = this.managerRecords().find((r) => r.agent_id === managerId);
    if (!rec) throw new AgentSessionError(404, 'host_offline', 'This Runtime Host is not connected right now.');
    if (!this.hostClis(rec).includes(cli)) {
      throw new AgentSessionError(409, 'cli_unsupported', `Runtime Host ${rec.hostname} has no ACP session adapter for ${cli}.`);
    }
    return rec;
  }

  private async managerName(managerId: string, fallback: string): Promise<string> {
    const agent = await this.agents.findOne({ where: { id: managerId } });
    return agent?.name || fallback;
  }

  // ─── CLI 설정 (credential 바인딩) ──────────────────────────────────────

  private credentialRef(cred: Credential): AgentSessionCredentialRef {
    return { id: cred.id, name: cred.name, provider: cred.provider, scope: cred.workspace_id === null ? 'global' : 'workspace' };
  }

  /** 워크스페이스에서 보이는(자기 것 + global) credential 중 이 CLI 와 호환되는 것. */
  private async candidateCredentials(workspaceId: string, cli: string): Promise<Credential[]> {
    const prefix = SESSION_CLI_CREDENTIAL_PREFIX[cli];
    if (!prefix) return [];
    const rows = await this.credentials.find({
      where: [
        { workspace_id: workspaceId, provider: Like(`${prefix}%`) },
        { workspace_id: IsNull(), provider: Like(`${prefix}%`) },
      ],
      order: { name: 'ASC' },
    });
    return rows;
  }

  private async cliSettingsMap(workspaceId: string, managerIds: string[]): Promise<Map<string, Record<string, AgentSessionCredentialRef | null>>> {
    const out = new Map<string, Record<string, AgentSessionCredentialRef | null>>();
    if (!managerIds.length) return out;
    const rows = await this.settings.find({ where: { workspace_id: workspaceId, manager_id: In(managerIds) } });
    const credIds = Array.from(new Set(rows.map((r) => r.credential_id).filter((x): x is string => !!x)));
    const creds = new Map<string, Credential>();
    if (credIds.length) {
      for (const c of await this.credentials.find({ where: { id: In(credIds) } })) creds.set(c.id, c);
    }
    for (const row of rows) {
      const bucket = out.get(row.manager_id) ?? {};
      const cred = row.credential_id ? creds.get(row.credential_id) : undefined;
      bucket[row.cli] = cred ? this.credentialRef(cred) : null;
      out.set(row.manager_id, bucket);
    }
    return out;
  }

  private async requireManagerAgent(managerId: string): Promise<Agent> {
    const agent = await this.agents.findOne({ where: { id: managerId } });
    if (!agent || agent.type !== 'manager') throw new AgentSessionError(404, 'host_unknown', 'No Runtime Host with this id.');
    return agent;
  }

  async getCliSettings(workspaceId: string, managerId: string, cli: string): Promise<AgentSessionCliSettings> {
    if (!CLI_RE.test(cli)) throw new AgentSessionError(400, 'cli_invalid');
    await this.requireManagerAgent(managerId);
    const row = await this.settings.findOne({ where: { workspace_id: workspaceId, manager_id: managerId, cli } });
    const candidates = await this.candidateCredentials(workspaceId, cli);
    const current = row?.credential_id ? candidates.find((c) => c.id === row.credential_id) ?? null : null;
    return {
      manager_id: managerId,
      cli,
      supports_credential: !!SESSION_CLI_CREDENTIAL_PREFIX[cli],
      credential: current ? this.credentialRef(current) : null,
      candidates: candidates.map((c) => this.credentialRef(c)),
      updated_at: row ? new Date(row.updated_at).toISOString() : null,
    };
  }

  async setCliSettings(workspaceId: string, userId: string, managerId: string, cli: string, credentialIdInput: unknown): Promise<AgentSessionCliSettings> {
    if (!CLI_RE.test(cli)) throw new AgentSessionError(400, 'cli_invalid');
    await this.requireManagerAgent(managerId);
    const prefix = SESSION_CLI_CREDENTIAL_PREFIX[cli];
    const credentialId = typeof credentialIdInput === 'string' && credentialIdInput.trim() ? credentialIdInput.trim() : null;
    if (credentialId) {
      if (!prefix) throw new AgentSessionError(409, 'credential_unsupported', `${cli} sessions cannot take an AWB credential yet.`);
      const cred = await this.credentials.findOne({ where: { id: credentialId } });
      if (!cred || (cred.workspace_id !== null && cred.workspace_id !== workspaceId)) {
        throw new AgentSessionError(404, 'credential_not_found', 'Credential not found in this workspace.');
      }
      if (!cred.provider.startsWith(prefix)) {
        throw new AgentSessionError(400, 'credential_provider_mismatch', `A ${cli} session needs a ${prefix}* credential, got ${cred.provider}.`);
      }
    }
    const existing = await this.settings.findOne({ where: { workspace_id: workspaceId, manager_id: managerId, cli } });
    if (existing) {
      existing.credential_id = credentialId;
      existing.updated_by = userId;
      await this.settings.save(existing);
    } else {
      await this.settings.save(this.settings.create({ workspace_id: workspaceId, manager_id: managerId, cli, credential_id: credentialId, updated_by: userId }));
    }
    this.logService.info('AgentSession', `cli settings ${managerId.slice(0, 8)}/${cli}: credential=${credentialId ? credentialId.slice(0, 8) : 'none'} by ${userId.slice(0, 8)}`);
    return this.getCliSettings(workspaceId, managerId, cli);
  }

  private async boundCredentialId(workspaceId: string, managerId: string, cli: string): Promise<string | null> {
    const row = await this.settings.findOne({ where: { workspace_id: workspaceId, manager_id: managerId, cli } });
    return row?.credential_id ?? null;
  }

  /**
   * 매니저 → 서버: CLI 설정으로 이 매니저에 묶인 credential 만 복호화해 준다.
   * (managed-agent 의 `/api/agent-manager/managed-agents/:id/credential` 와 같은 복호화·503 규약.)
   */
  async getSessionCredential(managerId: string, credentialId: string, workspaceId: string): Promise<{ credential_id: string; provider: string; fields: Record<string, string> }> {
    if (!workspaceId) throw new AgentSessionError(400, 'workspace_required');
    const binding = await this.settings.findOne({ where: { workspace_id: workspaceId, manager_id: managerId, credential_id: credentialId } });
    if (!binding) throw new AgentSessionError(403, 'credential_not_bound', 'This credential is not assigned to this Runtime Host in the workspace CLI settings.');
    const cred = await this.credentials.findOne({ where: { id: credentialId } });
    if (!cred) throw new AgentSessionError(404, 'credential_not_found');
    if (cred.workspace_id !== null && cred.workspace_id !== workspaceId) throw new AgentSessionError(403, 'credential_not_bound');
    const ciphertext = cred.encrypted_data || '';
    const plaintext = ciphertext ? decrypt(ciphertext) : '';
    if (ciphertext.startsWith('enc:') && !plaintext) {
      this.logService.error('AgentSession', `Credential decrypt failed for cred=${cred.id.slice(0, 8)} (provider=${cred.provider}) — encryption key changed? Re-save it in Settings → Credentials.`);
      throw new AgentSessionError(503, 'credential_decrypt_failed', 'Server failed to decrypt the stored credential. Re-edit it in Settings → Credentials to re-encrypt it.');
    }
    let fields: Record<string, string> = {};
    if (plaintext) {
      try {
        const decoded = JSON.parse(plaintext);
        if (decoded && typeof decoded === 'object' && !Array.isArray(decoded)) {
          for (const [k, v] of Object.entries(decoded)) if (typeof v === 'string') fields[k] = v;
        }
      } catch {
        fields = {};
      }
    }
    // 줄바꿈이 섞인 채 저장된 토큰(정규화 이전에 만든 row)도 여기서 고쳐 보낸다 — 매니저도 같은 규칙을 다시 적용한다.
    return { credential_id: cred.id, provider: cred.provider, fields: normalizeCredentialFields(fields) };
  }

  // ─── Reverse RPC ────────────────────────────────────────────────────────

  private rpc<T>(
    managerId: string,
    cli: string,
    op: 'list' | 'history' | 'open',
    args: Partial<AgentSessionRequestPayload>,
    driverUserId: string,
  ): Promise<T> {
    if (this.pending.size >= MAX_PENDING) {
      throw new AgentSessionError(503, 'too_many_requests', 'Too many in-flight session requests; try again shortly.');
    }
    const requestId = randomUUID();
    const timeoutMs = RPC_TIMEOUT_MS[op];
    const promise = new Promise<RpcResponseBody>((resolve) => {
      const timer = setTimeout(() => {
        if (!this.pending.delete(requestId)) return;
        this.logService.warn('AgentSession', `rpc ${op} timed out (manager=${managerId.slice(0, 8)} cli=${cli})`);
        resolve({ ok: false, error: 'The Runtime Host did not respond in time.', code: 'timeout' });
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(requestId, { manager_id: managerId, op, created_at: Date.now(), resolve, timer });
    });
    this.emitRequest({ manager_id: managerId, workspace_id: '', cli, op, request_id: requestId, driver_user_id: driverUserId, ...args });
    return promise.then((body) => {
      if (!body.ok) {
        const status = body.code === 'timeout' ? 504 : body.code === 'not_found' ? 404 : 502;
        throw new AgentSessionError(status, body.code || 'manager_error', body.error || 'Runtime Host reported an error.');
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

  // ─── 사용자 읽기 ───────────────────────────────────────────────────────

  async listSessions(workspaceId: string, userId: string, managerId: string, cli: string): Promise<AgentSessionSummary[]> {
    this.requireHost(workspaceId, managerId, cli);
    const result = await this.rpc<{ sessions?: unknown }>(managerId, cli, 'list', { workspace_id: workspaceId }, userId);
    const list = Array.isArray(result?.sessions) ? result.sessions : [];
    return list
      .map((raw: any) => this.normalizeSummary(cli, raw))
      .filter((s): s is AgentSessionSummary => !!s)
      .map((s) => ({ ...s, live_status: this.live.get(liveKey(managerId, cli, s.session_id))?.status }));
  }

  async getSession(
    workspaceId: string,
    userId: string,
    managerId: string,
    cli: string,
    sessionId: string,
  ): Promise<{ session: AgentSessionSummary | null; live: AgentSessionLiveSnapshot; events: AgentSessionEventRecord[] }> {
    const rec = this.requireHost(workspaceId, managerId, cli);
    this.assertSessionId(sessionId);
    const result = await this.rpc<{ session?: unknown; events?: unknown }>(managerId, cli, 'history', { workspace_id: workspaceId, session_id: sessionId }, userId);
    const summary = this.normalizeSummary(cli, result?.session);
    const events = Array.isArray(result?.events)
      ? result.events.map((e: any, i: number) => this.normalizeEvent(e, i)).filter((e): e is AgentSessionEventRecord => !!e)
      : [];
    const state = this.live.get(liveKey(managerId, cli, sessionId)) ?? await this.seedState(rec, managerId, cli, sessionId, {
      cwd: summary?.cwd || '',
      title: summary?.title || '',
      status: 'idle',
      driver_user_id: null,
    });
    return { session: summary, live: this.snapshot(state), events };
  }

  // ─── 사용자 쓰기 ───────────────────────────────────────────────────────

  async openSession(
    workspaceId: string,
    userId: string,
    managerId: string,
    cli: string,
    input: { session_id?: string | null; cwd?: string; title?: string },
  ): Promise<AgentSessionLiveSnapshot> {
    const rec = this.requireHost(workspaceId, managerId, cli);
    const sessionId = input.session_id ? String(input.session_id) : null;
    if (sessionId) this.assertSessionId(sessionId);
    const cwd = String(input.cwd ?? '').trim();
    if (cwd.length > CWD_MAX) throw new AgentSessionError(400, 'cwd_too_long');
    if (!sessionId && !cwd) throw new AgentSessionError(400, 'cwd_required', 'A working directory is required for a new session.');
    const title = String(input.title ?? '').trim().slice(0, TITLE_MAX);
    const credentialId = await this.boundCredentialId(workspaceId, managerId, cli);
    const result = await this.rpc<Record<string, any>>(managerId, cli, 'open', { workspace_id: workspaceId, session_id: sessionId, cwd, title, credential_id: credentialId }, userId);
    const openedId = typeof result?.session_id === 'string' ? result.session_id : sessionId;
    if (!openedId || !SESSION_ID_RE.test(openedId)) throw new AgentSessionError(502, 'manager_error', 'Runtime Host did not return a session id.');
    const state = await this.seedState(rec, managerId, cli, openedId, {
      cwd: typeof result?.cwd === 'string' && result.cwd ? result.cwd : cwd,
      title: typeof result?.title === 'string' ? result.title : title,
      status: 'ready',
      driver_user_id: userId,
    });
    this.applyPatch(state, {
      status: typeof result?.status === 'string' ? result.status : 'ready',
      current_mode: result?.current_mode ?? null,
      available_modes: Array.isArray(result?.available_modes) ? result.available_modes : [],
      resume_supported: result?.resume_supported === true,
      last_error: null,
    });
    state.driver_user_id = userId;
    return this.emitUpdate(state, 'opened');
  }

  async prompt(
    workspaceId: string,
    userId: string,
    managerId: string,
    cli: string,
    sessionId: string,
    textInput: unknown,
  ): Promise<{ turn_id: string; live: AgentSessionLiveSnapshot }> {
    const rec = this.requireHost(workspaceId, managerId, cli);
    this.assertSessionId(sessionId);
    const text = typeof textInput === 'string' ? textInput : '';
    if (!text.trim()) throw new AgentSessionError(400, 'text_required');
    if (text.length > AGENT_SESSION_PROMPT_MAX_CHARS) throw new AgentSessionError(413, 'text_too_long');
    const state = this.live.get(liveKey(managerId, cli, sessionId))
      ?? await this.seedState(rec, managerId, cli, sessionId, { cwd: '', title: '', status: 'idle', driver_user_id: userId });
    if (!agentSessionAcceptsPrompt(state.status)) {
      throw new AgentSessionError(409, 'session_busy', 'A turn is already in progress. Cancel it or wait for it to finish.');
    }
    const turnId = randomUUID();
    state.driver_user_id = userId;
    state.status = state.status === 'idle' || state.status === 'closed' || state.status === 'error' ? 'starting' : 'busy';
    state.last_error = null;
    state.updated_at = Date.now();
    if (!state.title) state.title = text.trim().replace(/\s+/g, ' ').slice(0, 80);
    const live = this.emitUpdate(state, 'prompt');
    this.emitRequest({
      manager_id: managerId,
      workspace_id: workspaceId,
      cli,
      op: 'prompt',
      session_id: sessionId,
      cwd: state.cwd,
      title: state.title,
      turn_id: turnId,
      text,
      credential_id: await this.boundCredentialId(workspaceId, managerId, cli),
      driver_user_id: userId,
    });
    return { turn_id: turnId, live };
  }

  async decidePermission(
    workspaceId: string,
    userId: string,
    managerId: string,
    cli: string,
    sessionId: string,
    requestIdInput: unknown,
    optionIdInput: unknown,
  ): Promise<AgentSessionLiveSnapshot> {
    this.requireHost(workspaceId, managerId, cli);
    this.assertSessionId(sessionId);
    const requestId = typeof requestIdInput === 'string' ? requestIdInput.trim() : '';
    if (!requestId) throw new AgentSessionError(400, 'request_id_required');
    const optionId = typeof optionIdInput === 'string' && optionIdInput.trim() ? optionIdInput.trim() : null;
    const state = this.live.get(liveKey(managerId, cli, sessionId));
    if (!state) throw new AgentSessionError(409, 'session_not_live', 'This session has no live process on the Runtime Host.');
    state.driver_user_id = userId;
    if (state.status === 'awaiting_permission') state.status = 'busy';
    state.updated_at = Date.now();
    const live = this.emitUpdate(state, 'permission');
    this.emitRequest({
      manager_id: managerId, workspace_id: workspaceId, cli, op: 'permission', session_id: sessionId,
      permission_request_id: requestId, option_id: optionId, driver_user_id: userId,
    });
    return live;
  }

  async cancel(workspaceId: string, userId: string, managerId: string, cli: string, sessionId: string): Promise<AgentSessionLiveSnapshot> {
    this.requireHost(workspaceId, managerId, cli);
    this.assertSessionId(sessionId);
    const state = this.live.get(liveKey(managerId, cli, sessionId));
    if (!state) throw new AgentSessionError(409, 'session_not_live');
    this.emitRequest({ manager_id: managerId, workspace_id: workspaceId, cli, op: 'cancel', session_id: sessionId, driver_user_id: userId });
    return this.snapshot(state);
  }

  async setMode(workspaceId: string, userId: string, managerId: string, cli: string, sessionId: string, modeIdInput: unknown): Promise<AgentSessionLiveSnapshot> {
    this.requireHost(workspaceId, managerId, cli);
    this.assertSessionId(sessionId);
    const modeId = typeof modeIdInput === 'string' ? modeIdInput.trim() : '';
    if (!modeId) throw new AgentSessionError(400, 'mode_id_required');
    const state = this.live.get(liveKey(managerId, cli, sessionId));
    if (!state) throw new AgentSessionError(409, 'session_not_live', 'Send a prompt first — modes apply to a live session.');
    this.emitRequest({ manager_id: managerId, workspace_id: workspaceId, cli, op: 'set_mode', session_id: sessionId, mode_id: modeId, driver_user_id: userId });
    return this.snapshot(state);
  }

  async close(workspaceId: string, userId: string, managerId: string, cli: string, sessionId: string): Promise<AgentSessionLiveSnapshot> {
    const rec = this.requireHost(workspaceId, managerId, cli);
    this.assertSessionId(sessionId);
    const state = this.live.get(liveKey(managerId, cli, sessionId))
      ?? await this.seedState(rec, managerId, cli, sessionId, { cwd: '', title: '', status: 'closed', driver_user_id: userId });
    state.status = 'closed';
    state.driver_user_id = userId;
    state.updated_at = Date.now();
    this.emitRequest({ manager_id: managerId, workspace_id: workspaceId, cli, op: 'close', session_id: sessionId, driver_user_id: userId });
    return this.emitUpdate(state, 'closed');
  }

  // ─── 매니저 쓰기 ───────────────────────────────────────────────────────

  relayEvents(managerId: string, cli: string, sessionId: string, itemsInput: unknown, patch?: ManagerStatePatch | null): { relayed: number; live: AgentSessionLiveSnapshot | null } {
    if (!Array.isArray(itemsInput)) throw new AgentSessionError(400, 'events_required');
    if (itemsInput.length > AGENT_SESSION_EVENT_BATCH_MAX) throw new AgentSessionError(413, 'events_batch_too_large');
    this.assertSessionId(sessionId);
    const key = liveKey(managerId, cli, sessionId);
    let state = this.live.get(key);
    if (!state) {
      // 매니저가 먼저 말을 거는 경우(서버 재시작 뒤 진행 중이던 세션) — driver 없이 상태만 둔다.
      state = this.createState(managerId, managerId.slice(0, 8), cli, sessionId, { cwd: '', title: '', status: 'busy', driver_user_id: null });
    }
    const events = itemsInput
      .map((raw: any, i: number) => this.normalizeEvent(raw, i, true))
      .filter((e): e is AgentSessionEventRecord => !!e);
    if (state.driver_user_id) {
      for (const event of events) {
        activityEvents.emit('agent_session_event', {
          manager_id: managerId,
          cli,
          session_id: sessionId,
          driver_user_id: state.driver_user_id,
          event,
          timestamp: event.created_at,
        });
      }
    }
    let live: AgentSessionLiveSnapshot | null = null;
    if (patch && Object.keys(patch).length) {
      this.applyPatch(state, patch);
      live = this.emitUpdate(state, patch.reason || 'manager_patch');
    } else {
      state.updated_at = Date.now();
    }
    return { relayed: events.length, live };
  }

  applyState(managerId: string, cli: string, sessionId: string, patch: ManagerStatePatch): AgentSessionLiveSnapshot {
    this.assertSessionId(sessionId);
    const key = liveKey(managerId, cli, sessionId);
    const state = this.live.get(key)
      ?? this.createState(managerId, managerId.slice(0, 8), cli, sessionId, { cwd: '', title: '', status: 'idle', driver_user_id: null });
    this.applyPatch(state, patch);
    return this.emitUpdate(state, patch.reason || 'manager_patch');
  }

  // ─── 내부 ────────────────────────────────────────────────────────────────

  private assertSessionId(sessionId: string): void {
    if (!SESSION_ID_RE.test(sessionId || '')) throw new AgentSessionError(400, 'session_id_invalid');
  }

  private normalizeSummary(cli: string, raw: any): AgentSessionSummary | null {
    if (!raw || typeof raw !== 'object') return null;
    const sessionId = typeof raw.session_id === 'string' ? raw.session_id : '';
    if (!SESSION_ID_RE.test(sessionId)) return null;
    return {
      cli,
      session_id: sessionId,
      cwd: typeof raw.cwd === 'string' ? raw.cwd.slice(0, CWD_MAX) : '',
      title: typeof raw.title === 'string' ? raw.title.slice(0, TITLE_MAX) : '',
      created_at: typeof raw.created_at === 'string' ? raw.created_at : null,
      updated_at: typeof raw.updated_at === 'string' ? raw.updated_at : new Date().toISOString(),
      source: raw.source === 'awb' ? 'awb' : 'cli',
      size_bytes: typeof raw.size_bytes === 'number' ? raw.size_bytes : undefined,
    };
  }

  private normalizeEvent(raw: any, index: number, strict = false): AgentSessionEventRecord | null {
    if (!raw || typeof raw !== 'object') return null;
    const type = typeof raw.type === 'string' ? raw.type : '';
    if (!EVENT_TYPE_SET.has(type)) {
      if (strict) throw new AgentSessionError(400, 'event_type_invalid', `events[${index}].type=${type || '(empty)'}`);
      return null;
    }
    const payload = raw.payload && typeof raw.payload === 'object' && !Array.isArray(raw.payload) ? raw.payload : {};
    if (strict && JSON.stringify(payload).length > AGENT_SESSION_EVENT_PAYLOAD_MAX_CHARS) {
      throw new AgentSessionError(413, 'event_payload_too_large', `events[${index}] payload exceeds ${AGENT_SESSION_EVENT_PAYLOAD_MAX_CHARS} chars`);
    }
    const seq = typeof raw.seq === 'number' && Number.isFinite(raw.seq) ? raw.seq : index + 1;
    return {
      id: typeof raw.id === 'string' && raw.id ? raw.id.slice(0, 200) : `${seq}`,
      seq,
      turn_id: typeof raw.turn_id === 'string' ? raw.turn_id.slice(0, 64) : '',
      type,
      payload,
      created_at: typeof raw.created_at === 'string' ? raw.created_at : new Date().toISOString(),
    };
  }

  private async seedState(
    rec: InstanceRecord,
    managerId: string,
    cli: string,
    sessionId: string,
    seed: { cwd: string; title: string; status: string; driver_user_id: string | null },
  ): Promise<LiveState> {
    const existing = this.live.get(liveKey(managerId, cli, sessionId));
    if (existing) return existing;
    const name = await this.managerName(managerId, rec.hostname);
    return this.createState(managerId, name, cli, sessionId, seed);
  }

  private createState(
    managerId: string,
    managerName: string,
    cli: string,
    sessionId: string,
    seed: { cwd: string; title: string; status: string; driver_user_id: string | null },
  ): LiveState {
    this.sweep();
    const state: LiveState = {
      manager_id: managerId,
      manager_name: managerName,
      cli,
      session_id: sessionId,
      cwd: seed.cwd,
      title: seed.title,
      status: STATUS_SET.has(seed.status) ? seed.status : 'idle',
      current_mode: null,
      available_modes: [],
      resume_supported: false,
      last_error: null,
      driver_user_id: seed.driver_user_id,
      updated_at: Date.now(),
    };
    this.live.set(liveKey(managerId, cli, sessionId), state);
    return state;
  }

  private applyPatch(state: LiveState, patch: ManagerStatePatch): void {
    if (patch.status !== undefined) {
      if (typeof patch.status !== 'string' || !STATUS_SET.has(patch.status)) throw new AgentSessionError(400, 'status_invalid');
      state.status = patch.status;
    }
    if (typeof patch.cwd === 'string') state.cwd = patch.cwd.slice(0, CWD_MAX);
    if (typeof patch.title === 'string') state.title = patch.title.slice(0, TITLE_MAX);
    if (patch.current_mode !== undefined) state.current_mode = patch.current_mode ? String(patch.current_mode).slice(0, 128) : null;
    if (patch.available_modes !== undefined) {
      state.available_modes = Array.isArray(patch.available_modes)
        ? patch.available_modes
          .filter((m) => m && typeof m.id === 'string')
          .slice(0, 32)
          .map((m) => ({ id: m.id, name: typeof m.name === 'string' ? m.name : m.id, description: typeof m.description === 'string' ? m.description : undefined }))
        : [];
    }
    if (patch.resume_supported !== undefined) state.resume_supported = !!patch.resume_supported;
    if (patch.last_error !== undefined) state.last_error = patch.last_error ? String(patch.last_error).slice(0, 4000) : null;
    state.updated_at = Date.now();
  }

  private sweep(): void {
    const cutoff = Date.now() - LIVE_TTL_MS;
    for (const [key, state] of this.live) {
      if (state.updated_at < cutoff) this.live.delete(key);
    }
  }

  snapshot(state: LiveState): AgentSessionLiveSnapshot {
    return {
      manager_id: state.manager_id,
      manager_name: state.manager_name,
      cli: state.cli,
      session_id: state.session_id,
      cwd: state.cwd,
      title: state.title,
      status: state.status,
      current_mode: state.current_mode,
      available_modes: state.available_modes,
      resume_supported: state.resume_supported,
      last_error: state.last_error,
      driver_user_id: state.driver_user_id,
      updated_at: iso(state.updated_at),
    };
  }

  private emitUpdate(state: LiveState, reason: string): AgentSessionLiveSnapshot {
    const snap = this.snapshot(state);
    if (state.driver_user_id) {
      activityEvents.emit('agent_session_update', {
        session: snap,
        reason,
        driver_user_id: state.driver_user_id,
        timestamp: snap.updated_at,
      });
    }
    return snap;
  }

  private emitRequest(fields: Omit<AgentSessionRequestPayload, 'issued_at'>): void {
    const payload: AgentSessionRequestPayload = { ...fields, issued_at: new Date().toISOString() };
    activityEvents.emit('agent_session_request', payload);
  }
}
