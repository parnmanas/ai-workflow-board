import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, In } from 'typeorm';
import { AgentSessionExecution } from '../../entities/AgentSessionExecution';
import { Credential } from '../../entities/Credential';
import { Project } from '../../entities/Project';
import { ProjectHostFolder } from '../../entities/ProjectHostFolder';
import { RuntimeHost } from '../../entities/RuntimeHost';
import { cliDescriptor } from '../../common/cli-catalog';
import type { AgentSessionConfigOption, AgentSessionRecordSettings, AgentSessionSummary } from '../../common/types/agent-sessions';
import type { McpAgentContext } from '../mcp/shared/session-auth';
import { cachedOperators, type OperatorEntry } from '../voice/operator-config';
import { AgentSessionError, AgentSessionsService, type AgentSessionInfoLive } from './agent-sessions.service';
import { resolveSessionCaller, type SessionCaller } from './session-caller';

/** 프로세스가 살아 있는 상태 — 이때의 라이브 설정이 지금 세션의 설정이다. */
export const RUNNING_STATUSES: ReadonlySet<string> = new Set(['starting', 'ready', 'busy', 'awaiting_permission', 'awaiting_input']);
const LIST_LIMIT_DEFAULT = 30;
const LIST_LIMIT_MAX = 200;
/** `details` 로 기록 설정까지 읽을 세션 수 상한 — 세션마다 기록 꼬리를 읽는 RPC 가 하나씩 든다. */
const DETAILS_MAX = 20;
const DETAILS_CONCURRENCY = 5;

export type SessionSettingSource = 'live' | 'record' | 'awb_launch';

/** 모델 · effort · 모드 하나 — 어디서 읽었는지 함께(`live` 실행 중 어댑터 · `record` CLI 기록의 마지막 턴 · `awb_launch` AWB 가 열 때 거는 값). */
export interface SessionSettingValue {
  value: string;
  label?: string;
  source: SessionSettingSource;
}

export interface SessionSettingsView {
  model: SessionSettingValue | null;
  effort: SessionSettingValue | null;
  mode: SessionSettingValue | null;
}

export interface SessionListInput {
  manager_id?: string;
  cli?: string;
  cwd?: string;
  query?: string;
  active_within_hours?: number;
  running_only?: boolean;
  details?: boolean;
  limit?: number;
}

export interface SessionInfoInput {
  session_id: string;
  manager_id?: string;
  cli?: string;
}

interface Address {
  manager_id: string;
  cli: string;
  session_id: string;
}

/** 누구로 묻는가 — 그 Account 의 Host 만, RPC 는 그 소유자(driver)로 보낸다. */
export interface SessionScope {
  accountId: string;
  userId: string;
}

function scopeOf(who: SessionCaller): SessionScope {
  return { accountId: who.accountId, userId: who.owner.id };
}

interface HostView {
  manager_id: string;
  name: string;
  online: boolean;
  clis: string[];
}

interface Listed {
  host: HostView;
  summary: AgentSessionSummary;
}

/**
 * 폴더 비교 키 — 끝 구분자를 떼고, Windows 경로(`E:\repo`)는 구분자를 `/` 로 맞춰 대소문자를 무시한다.
 * 화면에 내는 값은 원문 그대로다.
 */
function folderKey(path: string): string {
  const windows = /^[A-Za-z]:[\\/]/.test(path) || path.startsWith('\\\\');
  const unified = windows ? path.replace(/\\/g, '/').toLowerCase() : path;
  return unified.length > 1 ? unified.replace(/\/+$/, '') : unified;
}

/** `cwd` 가 `folder` 이거나 그 아래인가(작업 트리 `.awb/wt/…` 같은 하위 폴더의 세션도 그 폴더의 세션이다). */
function inFolder(cwd: string, folder: string): boolean {
  const c = folderKey(cwd);
  const f = folderKey(folder);
  if (!c || !f) return false;
  return c === f || c.startsWith(f.endsWith('/') ? f : `${f}/`);
}

function parseObject(raw: string | null | undefined): Record<string, string | boolean> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function optionLabel(options: AgentSessionConfigOption[], configId: string | undefined, value: string): string | undefined {
  const option = configId ? options.find((o) => o.config_id === configId) : undefined;
  const name = option?.options.find((o) => o.value === value)?.name;
  return name && name !== value ? name : undefined;
}

function setting(value: unknown, source: SessionSettingSource, label?: string): SessionSettingValue | null {
  if (typeof value !== 'string' || !value) return null;
  return { value, ...(label ? { label } : {}), source };
}

type LiveSettingsSource = Pick<AgentSessionInfoLive, 'config_options' | 'current_mode' | 'available_modes'>;

/** 라이브 어댑터의 선택지(current_value 포함) → 모델 · effort · 모드. */
function settingsFromLive(live: LiveSettingsSource): SessionSettingsView {
  const pick = (category: string): SessionSettingValue | null => {
    const option = live.config_options.find((o) => o.category === category && typeof o.current_value === 'string' && o.current_value);
    if (!option) return null;
    const value = option.current_value as string;
    return setting(value, 'live', optionLabel([option], option.config_id, value));
  };
  const modeName = live.current_mode ? live.available_modes.find((m) => m.id === live.current_mode)?.name : undefined;
  return {
    model: pick('model'),
    effort: pick('thought_level'),
    mode: pick('mode') ?? setting(live.current_mode, 'live', modeName && modeName !== live.current_mode ? modeName : undefined),
  };
}

/** AWB 실행 snapshot 의 `{ config_id: value }` → 모델 · effort · 모드(선택지의 category 로 읽는다). */
function settingsFromLaunch(config: Record<string, string | boolean>, options: AgentSessionConfigOption[]): SessionSettingsView {
  const pick = (category: string): SessionSettingValue | null => {
    for (const option of options.filter((o) => o.category === category)) {
      const value = config[option.config_id];
      if (typeof value === 'string' && value) return setting(value, 'awb_launch', optionLabel(options, option.config_id, value));
    }
    return null;
  };
  const permission = config.__permission_mode ?? config.__mode;
  return {
    model: pick('model'),
    effort: pick('thought_level'),
    mode: pick('mode') ?? (typeof permission === 'string' && permission
      ? setting(permission, 'awb_launch', optionLabel(options, '__permission_mode', permission))
      : null),
  };
}

function settingsFromRecord(record: AgentSessionRecordSettings, options: AgentSessionConfigOption[]): SessionSettingsView {
  const modelOption = options.find((o) => o.category === 'model');
  return {
    model: setting(record.model, 'record', record.model ? optionLabel(options, modelOption?.config_id, record.model) : undefined),
    effort: setting(record.effort, 'record'),
    mode: setting(record.mode, 'record', record.mode ? optionLabel(options, '__permission_mode', record.mode) : undefined),
  };
}

/** 칸마다 앞의 출처부터 — 비어 있는 칸만 다음 출처가 채운다. */
function mergeSettings(...views: Array<SessionSettingsView | null>): SessionSettingsView {
  const out: SessionSettingsView = { model: null, effort: null, mode: null };
  for (const view of views) {
    if (!view) continue;
    for (const key of ['model', 'effort', 'mode'] as const) out[key] ??= view[key];
  }
  return out;
}

function sessionPath(a: Address): string {
  return `/sessions/${encodeURIComponent(a.manager_id)}/${encodeURIComponent(a.cli)}/${encodeURIComponent(a.session_id)}`;
}

/**
 * MCP 로 원격 세션을 **찾는** 표면 — Host 목록 → 작업 폴더 → 세션 목록 → 세션 하나의 상세(언제 만들어졌고 마지막으로
 * 언제 쓰였는지, CLI · 모델 · effort · 모드). open_session / send_session_message 에 넘길 주소를 여기서 고른다.
 *
 * 세션 원본은 그 장비의 CLI 기록이고 서버는 저장하지 않는다(docs/agent-sessions.md) — 목록은 화면과 같은 `list` RPC,
 * 상세는 기록의 머리·꼬리만 읽는 `info` RPC 다. 둘 다 읽기라 사람이 보고 있는 세션의 driver 를 빼앗지 않는다.
 * 경계는 open_session 과 같다(`resolveSessionCaller`): 호출자 Account 의 Host 만, 다른 Account 가 연 세션은 보이지 않는다.
 */
@Injectable()
export class SessionDirectoryService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly sessions: AgentSessionsService,
  ) {}

  // ─── Hosts ──────────────────────────────────────────────────────────────

  async listHosts(caller: McpAgentContext | undefined) {
    const who = await resolveSessionCaller(this.dataSource, caller);
    const rows = await this.dataSource.getRepository(RuntimeHost).find({ where: { account_id: who.accountId, is_active: 1 } });
    const online = new Map((await this.sessions.listHosts(who.accountId)).map((h) => [h.manager_id, h]));
    const folders = await this.projectFolders(who.accountId, rows.map((r) => r.id));
    return {
      hosts: rows
        .map((row) => {
          const live = online.get(row.id);
          return {
            manager_id: row.id,
            name: row.name || live?.name || row.hostname,
            hostname: live?.hostname || row.hostname,
            online: !!live,
            ...(row.id === who.hostId ? { is_you: true } : {}),
            session_clis: live?.clis ?? [],
            last_seen_at: live?.last_seen_at ?? (row.last_seen_at ? new Date(row.last_seen_at).toISOString() : null),
            ...(live?.plugin_version ? { agent_manager_version: live.plugin_version } : {}),
            project_folders: folders.get(row.id) ?? [],
          };
        })
        .sort((a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name)),
    };
  }

  // ─── Folders ────────────────────────────────────────────────────────────

  async listFolders(caller: McpAgentContext | undefined, input: { manager_id?: string; cli?: string }) {
    const who = await resolveSessionCaller(this.dataSource, caller);
    const hosts = await this.targetHosts(who, input.manager_id);
    const { listed, unreachable } = await this.collect(scopeOf(who), hosts, input.cli);
    const projectFolders = await this.projectFolders(who.accountId, hosts.map((h) => h.manager_id));
    const byFolder = new Map<string, {
      manager_id: string; host: string; path: string; project: { id: string; name: string } | null;
      sessions: number; running: number; clis: Set<string>; last_used_at: string | null;
    }>();
    for (const host of hosts) {
      for (const folder of projectFolders.get(host.manager_id) ?? []) {
        byFolder.set(`${host.manager_id}\n${folderKey(folder.path)}`, {
          manager_id: host.manager_id, host: host.name, path: folder.path,
          project: { id: folder.project_id, name: folder.project }, sessions: 0, running: 0, clis: new Set(), last_used_at: null,
        });
      }
    }
    for (const { host, summary } of listed) {
      if (!summary.cwd) continue;
      const key = `${host.manager_id}\n${folderKey(summary.cwd)}`;
      const entry = byFolder.get(key) ?? {
        manager_id: host.manager_id, host: host.name, path: summary.cwd,
        project: this.projectFor(projectFolders.get(host.manager_id) ?? [], summary.cwd),
        sessions: 0, running: 0, clis: new Set<string>(), last_used_at: null,
      };
      entry.sessions += 1;
      if (summary.live_status && RUNNING_STATUSES.has(summary.live_status)) entry.running += 1;
      entry.clis.add(summary.cli);
      if (!entry.last_used_at || summary.updated_at > entry.last_used_at) entry.last_used_at = summary.updated_at;
      byFolder.set(key, entry);
    }
    const folders = [...byFolder.values()]
      .sort((a, b) => (b.last_used_at ?? '').localeCompare(a.last_used_at ?? '') || a.path.localeCompare(b.path))
      .map((f) => ({
        manager_id: f.manager_id, host: f.host, path: f.path,
        ...(f.project ? { project: f.project } : {}),
        sessions: f.sessions, running: f.running, clis: [...f.clis].sort(), last_used_at: f.last_used_at,
      }));
    return { folders, ...(unreachable.length ? { unreachable } : {}) };
  }

  // ─── Sessions ───────────────────────────────────────────────────────────

  async listSessions(caller: McpAgentContext | undefined, input: SessionListInput) {
    const who = await resolveSessionCaller(this.dataSource, caller);
    const hosts = await this.targetHosts(who, input.manager_id);
    const { listed, unreachable } = await this.collect(scopeOf(who), hosts, input.cli);
    const query = input.query?.trim().toLowerCase() || '';
    const since = typeof input.active_within_hours === 'number' && input.active_within_hours > 0
      ? new Date(Date.now() - input.active_within_hours * 3_600_000).toISOString()
      : null;
    const matched = listed.filter(({ summary }) => {
      if (input.cwd && !inFolder(summary.cwd, input.cwd)) return false;
      if (input.running_only && !(summary.live_status && RUNNING_STATUSES.has(summary.live_status))) return false;
      if (since && summary.updated_at < since) return false;
      if (query && ![summary.title, summary.session_id, summary.cwd].some((v) => v.toLowerCase().includes(query))) return false;
      return true;
    }).sort((a, b) => b.summary.updated_at.localeCompare(a.summary.updated_at));
    const limit = Math.min(Math.max(1, Math.floor(input.limit ?? LIST_LIMIT_DEFAULT)), LIST_LIMIT_MAX);
    const page = matched.slice(0, limit);

    const context = await this.sessionContext(who, caller, page);
    const details = new Map<string, { settings: AgentSessionRecordSettings | null; live: AgentSessionInfoLive | null }>();
    if (input.details) {
      const targets = page.slice(0, DETAILS_MAX);
      for (let i = 0; i < targets.length; i += DETAILS_CONCURRENCY) {
        await Promise.all(targets.slice(i, i + DETAILS_CONCURRENCY).map(async ({ host, summary }) => {
          const info = await this.sessions.readSessionInfo(who.accountId, who.owner.id, host.manager_id, summary.cli, summary.session_id).catch(() => null);
          if (info) details.set(`${host.manager_id}/${summary.cli}/${summary.session_id}`, info);
        }));
      }
    }
    const sessions = await Promise.all(page.map(async ({ host, summary }) => {
      const address = { manager_id: host.manager_id, cli: summary.cli, session_id: summary.session_id };
      const key = `${address.manager_id}/${address.cli}/${address.session_id}`;
      const execution = context.executions.get(key) ?? null;
      // listSessions 가 메모리 상태를 매니저의 답에 맞춰 두었다 — 여기서는 그대로 믿는다. details 면 매니저의 라이브 답이 먼저다.
      const memory = this.sessions.liveSnapshot(address.manager_id, address.cli, address.session_id);
      const detail = details.get(key);
      const running = detail?.live?.status && RUNNING_STATUSES.has(detail.live.status) ? detail.live
        : memory && RUNNING_STATUSES.has(memory.status) ? memory : null;
      const options = await context.options(address.manager_id, address.cli);
      const settings = this.resolveSettings(running, detail?.settings ?? null, running ? null : memory, execution, options);
      return {
        manager_id: address.manager_id,
        host: host.name,
        cli: address.cli,
        session_id: address.session_id,
        title: summary.title,
        cwd: summary.cwd,
        created_at: summary.created_at,
        last_used_at: summary.updated_at,
        status: summary.live_status ?? 'not_running',
        model: settings.model?.value ?? null,
        effort: settings.effort?.value ?? null,
        mode: settings.mode?.value ?? null,
        opened_in_awb: !!execution,
        ...(context.isYou(address) ? { is_you: true } : {}),
        ...(context.operator(address) ? { operator: context.operator(address)!.name } : {}),
      };
    }));
    return {
      total: matched.length,
      returned: sessions.length,
      sessions,
      ...(unreachable.length ? { unreachable } : {}),
      ...(input.details && page.length > DETAILS_MAX ? { note: `model/effort/mode were read from native records for the first ${DETAILS_MAX} sessions only.` } : {}),
    };
  }

  async getSessionInfo(caller: McpAgentContext | undefined, input: SessionInfoInput) {
    const who = await resolveSessionCaller(this.dataSource, caller);
    const sessionId = input.session_id.trim();
    const { address, listed } = await this.locate(scopeOf(who), sessionId, input.manager_id?.trim() || undefined, input.cli?.trim() || undefined);
    const hostRow = await this.dataSource.getRepository(RuntimeHost).findOne({ where: { id: address.manager_id } });
    const online = (await this.sessions.listHosts(who.accountId)).find((h) => h.manager_id === address.manager_id);
    // 다른 Account 가 연 세션은 매니저에게 묻기 전에 거른다 — 그 세션의 기록을 읽는 RPC 조차 보내지 않는다.
    const execution = await this.dataSource.getRepository(AgentSessionExecution).findOne({ where: { ...address } });
    if (execution && execution.account_id !== who.accountId) throw new AgentSessionError(404, 'session_not_found');
    const notes: string[] = [];
    let info: { session: AgentSessionSummary | null; settings: AgentSessionRecordSettings | null; live: AgentSessionInfoLive | null } | null = null;
    if (online?.clis.includes(address.cli)) {
      try {
        info = await this.sessions.readSessionInfo(who.accountId, who.owner.id, address.manager_id, address.cli, address.session_id);
      } catch (err: any) {
        if (err instanceof AgentSessionError && err.status === 404) throw new AgentSessionError(404, 'session_not_found', 'That session is not on the Runtime Host.');
        notes.push(`Native record unavailable (${err?.code || 'error'}): ${err?.message || 'the Runtime Host could not read it.'}`);
      }
    } else {
      notes.push(online ? `The Runtime Host has no session adapter for ${address.cli} right now.` : 'The Runtime Host is offline — only what AWB stored is shown.');
    }
    const memory = this.sessions.liveSnapshot(address.manager_id, address.cli, address.session_id);
    if (!info && !execution && !memory && !listed) throw new AgentSessionError(404, 'session_not_found', 'AWB knows nothing about that session and its Runtime Host cannot be asked.');
    const options = await this.sessions.configOptionsFor(who.accountId, address.manager_id, address.cli).catch(() => [] as AgentSessionConfigOption[]);
    const launch = execution ? parseObject(execution.config_defaults) : {};
    // 매니저가 답했으면(info) 그 라이브 상태가 진실이다 — 메모리는 매니저 재시작 뒤의 유령일 수 있다.
    const reported = info ? info.live : (online && memory ? memory : null);
    const running = reported?.status && RUNNING_STATUSES.has(reported.status) ? reported : null;
    const settings = this.resolveSettings(running, info?.settings ?? null, running ? null : memory, execution, options);
    const status = (info ? info.live?.status : online ? memory?.status : null) ?? 'not_running';
    // 기록을 못 읽었으면(구버전 매니저 등) 주소를 찾을 때 본 목록의 요약이라도 쓴다.
    const summary = info?.session ?? listed;
    const operators = await cachedOperators(this.dataSource);
    const operator = operators.find((op) => op.manager_id === address.manager_id && op.cli === address.cli && op.session_id === address.session_id);
    const credential = execution?.credential_id
      ? await this.dataSource.getRepository(Credential).findOne({ where: { id: execution.credential_id } }) : null;
    const backend = this.backendName(execution?.runtime_profile);
    return {
      manager_id: address.manager_id,
      host: { name: hostRow?.name || online?.name || address.manager_id.slice(0, 8), online: !!online },
      cli: address.cli,
      cli_label: cliDescriptor(address.cli)?.label ?? address.cli,
      session_id: address.session_id,
      title: summary?.title || memory?.title || '',
      cwd: summary?.cwd || memory?.cwd || '',
      created_at: summary?.created_at ?? (execution ? new Date(execution.created_at).toISOString() : null),
      last_used_at: summary?.updated_at ?? memory?.updated_at ?? null,
      ...(summary?.size_bytes !== undefined ? { size_bytes: summary.size_bytes } : {}),
      status,
      ...(memory?.last_error ? { last_error: memory.last_error } : {}),
      settings,
      record: info?.settings ?? null,
      awb: execution
        ? {
          opened: true,
          first_opened_at: new Date(execution.created_at).toISOString(),
          credential: credential ? { name: credential.name, provider: credential.provider } : null,
          ...(backend ? { backend } : {}),
          launch_config: launch,
        }
        : { opened: false },
      ...(this.isYou(who, caller, address) ? { is_you: true } : {}),
      ...(operator ? { operator: operator.name } : {}),
      path: sessionPath(address),
      ...(notes.length ? { notes } : {}),
    };
  }

  // ─── 내부 ────────────────────────────────────────────────────────────────

  /**
   * 출처의 우선순위: 지금 돌고 있는 어댑터(`live`) → CLI 기록의 마지막 턴(`record`) → 돌지 않는 세션의 마지막 라이브 상태 →
   * AWB 가 다시 열 때 거는 값(`awb_launch`). 칸마다 따로 채운다(기록에 effort 가 없는 CLI 가 있다).
   */
  private resolveSettings(
    running: LiveSettingsSource | null,
    record: AgentSessionRecordSettings | null,
    stale: LiveSettingsSource | null,
    execution: AgentSessionExecution | null,
    options: AgentSessionConfigOption[],
  ): SessionSettingsView {
    return mergeSettings(
      running ? settingsFromLive(running) : null,
      record ? settingsFromRecord(record, options) : null,
      stale ? settingsFromLive(stale) : null,
      execution ? settingsFromLaunch(parseObject(execution.config_defaults), options) : null,
    );
  }

  private backendName(raw: string | null | undefined): string | null {
    if (!raw) return null;
    try {
      const profile = JSON.parse(raw);
      return typeof profile?.name === 'string' && profile.name ? profile.name
        : typeof profile?.id === 'string' ? profile.id : null;
    } catch {
      return null;
    }
  }

  /** `manager_id` 가 있으면 그 Host 하나(이 Account 의 것이어야 한다), 없으면 이 Account 의 연결된 Host 전부. */
  private async targetHosts(who: SessionCaller, managerId: string | undefined): Promise<HostView[]> {
    const online = await this.sessions.listHosts(who.accountId);
    if (!managerId) return online.map((h) => ({ manager_id: h.manager_id, name: h.name, online: true, clis: h.clis }));
    const row = await this.dataSource.getRepository(RuntimeHost).findOne({ where: { id: managerId, account_id: who.accountId, is_active: 1 } });
    if (!row) throw new AgentSessionError(403, 'account_access_denied', 'That Runtime Host is not in your account.');
    const live = online.find((h) => h.manager_id === managerId);
    if (!live) throw new AgentSessionError(404, 'host_offline', `Runtime Host ${row.name} is not connected right now.`);
    return [{ manager_id: live.manager_id, name: row.name || live.name, online: true, clis: live.clis }];
  }

  /** Host × CLI 마다 `list` RPC 를 동시에 — 한 곳이 느리거나 실패해도 나머지는 답한다. */
  private async collect(scope: SessionScope, hosts: HostView[], cli: string | undefined): Promise<{
    listed: Listed[]; unreachable: Array<{ manager_id: string; host: string; cli: string; error: string }>;
  }> {
    const jobs = hosts.flatMap((host) => host.clis.filter((c) => !cli || c === cli).map((c) => ({ host, cli: c })));
    const results = await Promise.allSettled(jobs.map((job) =>
      this.sessions.listSessions(scope.accountId, scope.userId, job.host.manager_id, job.cli, [scope.accountId])));
    const listed: Listed[] = [];
    const unreachable: Array<{ manager_id: string; host: string; cli: string; error: string }> = [];
    results.forEach((result, i) => {
      const { host, cli: jobCli } = jobs[i];
      if (result.status === 'fulfilled') {
        for (const summary of result.value) listed.push({ host, summary });
      } else {
        unreachable.push({ manager_id: host.manager_id, host: host.name, cli: jobCli, error: result.reason?.message || String(result.reason) });
      }
    });
    if (cli && !jobs.length && hosts.length) {
      for (const host of hosts) unreachable.push({ manager_id: host.manager_id, host: host.name, cli, error: `No ${cli} session adapter on this Runtime Host.` });
    }
    return { listed, unreachable };
  }

  /** 목록 한 쪽에 필요한 AWB 쪽 사실(실행 snapshot · 선택지 · 나 · operator)을 한 번에 읽는다. */
  private async sessionContext(who: SessionCaller, caller: McpAgentContext | undefined, page: Listed[]) {
    const executions = new Map<string, AgentSessionExecution>();
    const ids = [...new Set(page.map(({ summary }) => summary.session_id))];
    if (ids.length) {
      const rows = await this.dataSource.getRepository(AgentSessionExecution).find({ where: { account_id: who.accountId, session_id: In(ids) } });
      for (const row of rows) executions.set(`${row.manager_id}/${row.cli}/${row.session_id}`, row);
    }
    const optionCache = new Map<string, Promise<AgentSessionConfigOption[]>>();
    const operators: OperatorEntry[] = await cachedOperators(this.dataSource);
    return {
      executions,
      options: (managerId: string, cli: string) => {
        const key = `${managerId}/${cli}`;
        if (!optionCache.has(key)) optionCache.set(key, this.sessions.configOptionsFor(who.accountId, managerId, cli).catch(() => []));
        return optionCache.get(key)!;
      },
      isYou: (a: Address) => this.isYou(who, caller, a),
      operator: (a: Address) => operators.find((op) => op.manager_id === a.manager_id && op.cli === a.cli && op.session_id === a.session_id),
    };
  }

  /** 호출한 세션 자신인가 — 새로 만든 세션의 MCP 연결은 세션 id 대신 참조값을 보낸다(resolveMcpSessionRef). */
  private isYou(who: SessionCaller, caller: McpAgentContext | undefined, a: Address): boolean {
    const ref = caller?.agentSessionId;
    if (!ref || who.hostId !== a.manager_id) return false;
    return (this.sessions.resolveMcpSessionRef(who.hostId, ref) ?? ref) === a.session_id;
  }

  /**
   * 세션 id 만 받았을 때 주소(Host · CLI)를 찾는다: AWB 가 연 세션(실행 snapshot) → 서버가 아는 라이브 세션 →
   * 연결된 Host 의 목록. 둘 이상이면 고르게 한다 — 다른 장비의 같은 id 를 멋대로 고르지 않는다.
   * send_session_message 도 이것으로 받는 세션을 찾는다 — AWB 에서 연 적 없는 세션도 Host 목록에 있으면 주소가 된다.
   * `listed` 는 목록에서 찾았을 때의 요약(그 세션이 Host 에 있다는 증거)이다.
   */
  async locate(scope: SessionScope, sessionId: string, managerId?: string, cli?: string): Promise<{
    address: Address; listed: AgentSessionSummary | null;
  }> {
    if (!sessionId) throw new AgentSessionError(400, 'session_id_required');
    const hosts = await this.dataSource.getRepository(RuntimeHost).find({ where: { account_id: scope.accountId, is_active: 1 } });
    const accountHosts = new Set(hosts.map((h) => h.id));
    if (managerId && !accountHosts.has(managerId)) throw new AgentSessionError(403, 'account_access_denied', 'That Runtime Host is not in your account.');
    if (managerId && cli) return { address: { manager_id: managerId, cli, session_id: sessionId }, listed: null };
    const found = new Map<string, { address: Address; listed: AgentSessionSummary | null }>();
    const add = (a: Address, listed: AgentSessionSummary | null = null) => {
      if (!accountHosts.has(a.manager_id) || (managerId && a.manager_id !== managerId) || (cli && a.cli !== cli)) return;
      found.set(`${a.manager_id}/${a.cli}`, { address: { manager_id: a.manager_id, cli: a.cli, session_id: sessionId }, listed });
    };
    const executions = await this.dataSource.getRepository(AgentSessionExecution).find({ where: { account_id: scope.accountId, session_id: sessionId } });
    executions.forEach((row) => add(row));
    this.sessions.liveSnapshotsById(sessionId).forEach((live) => add(live));
    if (!found.size) {
      const targets = (await this.sessions.listHosts(scope.accountId))
        .filter((h) => !managerId || h.manager_id === managerId)
        .map((h) => ({ manager_id: h.manager_id, name: h.name, online: true, clis: h.clis }));
      const { listed } = await this.collect(scope, targets, cli);
      for (const { host, summary } of listed) {
        if (summary.session_id === sessionId) add({ manager_id: host.manager_id, cli: summary.cli, session_id: sessionId }, summary);
      }
    }
    const matches = [...found.values()];
    if (!matches.length) throw new AgentSessionError(404, 'session_not_found', 'No session with that ID on your connected Runtime Hosts. Check list_sessions.');
    if (matches.length > 1) {
      throw new AgentSessionError(409, 'session_ambiguous', `More than one session has that ID: ${matches.map((m) => `${m.address.manager_id}/${m.address.cli}`).join(', ')}. Specify manager_id and cli.`);
    }
    return matches[0];
  }

  /** Host → 이 Account 의 project 폴더들. */
  private async projectFolders(accountId: string, hostIds: string[]): Promise<Map<string, Array<{ project_id: string; project: string; path: string }>>> {
    const out = new Map<string, Array<{ project_id: string; project: string; path: string }>>();
    if (!hostIds.length) return out;
    const projects = await this.dataSource.getRepository(Project).find({ where: { account_id: accountId } });
    if (!projects.length) return out;
    const names = new Map(projects.map((p) => [p.id, p.name]));
    const rows = await this.dataSource.getRepository(ProjectHostFolder).find({ where: { host_id: In(hostIds), project_id: In([...names.keys()]) } });
    for (const row of rows) {
      const list = out.get(row.host_id) ?? [];
      list.push({ project_id: row.project_id, project: names.get(row.project_id) ?? row.project_id, path: row.path });
      out.set(row.host_id, list);
    }
    for (const list of out.values()) list.sort((a, b) => a.project.localeCompare(b.project));
    return out;
  }

  /** 세션 폴더가 속한 project — 가장 깊은(가장 구체적인) project 폴더. */
  private projectFor(folders: Array<{ project_id: string; project: string; path: string }>, cwd: string): { id: string; name: string } | null {
    const match = folders.filter((f) => inFolder(cwd, f.path)).sort((a, b) => b.path.length - a.path.length)[0];
    return match ? { id: match.project_id, name: match.project } : null;
  }
}
