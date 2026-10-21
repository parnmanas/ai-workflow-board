import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { randomUUID } from 'node:crypto';
import { In, Repository } from 'typeorm';
import { Credential } from '../../entities/Credential';
import { Project } from '../../entities/Project';
import { ProjectHostFolder } from '../../entities/ProjectHostFolder';
import { RuntimeHost } from '../../entities/RuntimeHost';
import { activityEvents } from '../../services/activity.service';
import { LogService } from '../../services/log.service';
import { InstanceRecord, InstanceRegistryService } from '../agent-manager/instance-registry.service';
import {
  MANAGER_CAPABILITY_CLI_MEMORY,
  MEMORY_BATCH_MAX,
  MEMORY_PATH_MAX,
  MEMORY_WRITE_MAX_BYTES,
} from '../../common/types/cli-memory';
import type {
  CliMemorySnapshot,
  MemoryBatchOp,
  MemoryBatchResultItem,
  MemoryFileInfo,
  MemoryHostInfo,
  MemoryHostSnapshot,
  MemoryProjectDir,
  MemoryRequestOp,
  MemoryVersionInfo,
} from '../../common/types/cli-memory';
import type { CliMemoryRequestPayload } from '../../common/types/stream-events';
import { HOST_RPC_FAILED_STATUS, HOST_RPC_TIMEOUT_STATUS } from '../../common/host-rpc-status';

export class CliMemoryError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message?: string,
    public readonly detail?: Record<string, unknown>,
  ) {
    super(message || code);
  }
}

interface PendingRpc {
  manager_id: string;
  op: string;
  resolve: (body: RpcResponseBody) => void;
  timer: NodeJS.Timeout;
}

export interface RpcResponseBody {
  ok: boolean;
  result?: any;
  error?: string;
  code?: string;
}

const CLI_RE = /^[a-z][a-z0-9_-]{0,31}$/;
const VERSION_ID_RE = /^[0-9]{13}-[0-9a-f]{8}$/;
const HASH_RE = /^[0-9a-f]{16}$/;
const MAX_PENDING = 200;
const RPC_TIMEOUT_MS: Record<string, number> = { scan: 45_000, batch: 90_000 };
const DEFAULT_RPC_TIMEOUT_MS = 20_000;

/** 매니저가 돌려준 오류 코드 → HTTP. 나머지는 HOST_RPC_FAILED_STATUS(사유가 Cloudflare 를 통과한다). */
const MANAGER_CODE_STATUS: Record<string, number> = {
  conflict: 409,
  path_not_allowed: 403,
  read_only: 403,
  link_invalid: 400,
  not_found: 404,
  path_invalid: 400,
  content_required: 400,
  version_invalid: 400,
  op_unknown: 400,
  batch_too_large: 413,
  content_too_large: 413,
  cli_unsupported: 409,
};

/**
 * CLI Memory — 상태 없는 중계자(docs/cli-memory.md).
 *
 *   - 메모리 파일은 Runtime Host 장비에 있고, 위치는 매니저의 CLI 모듈이 선언한다. 서버는
 *     `cli_memory_request{request_id}` SSE 로 묻고 `POST /api/agent/cli-memory/rpc/:id` 로 답을 받는다.
 *   - project 범위 파일을 찾을 폴더는 **서버가** 정한다(그 장비에 등록된 프로젝트 폴더 중 사용자가
 *     접근할 수 있는 것). 화면이 보낸 폴더를 매니저에 넘기지 않는다 — 그래야 임의의 폴더에 지침
 *     파일을 만들 수 없다.
 *   - 분석·변환은 화면이 스냅샷 위에서 한다. 서버는 저장하지 않는다.
 */
@Injectable()
export class CliMemoryService {
  private readonly pending = new Map<string, PendingRpc>();

  constructor(
    @InjectRepository(RuntimeHost) private readonly hosts: Repository<RuntimeHost>,
    @InjectRepository(ProjectHostFolder) private readonly folders: Repository<ProjectHostFolder>,
    @InjectRepository(Project) private readonly projects: Repository<Project>,
    @InjectRepository(Credential) private readonly credentials: Repository<Credential>,
    private readonly registry: InstanceRegistryService,
    private readonly logService: LogService,
  ) {}

  // ─── Hosts ──────────────────────────────────────────────────────────────

  private managerRecords(): InstanceRecord[] {
    return this.registry.list().filter((r) => r.mode === 'manager');
  }

  private supports(rec: InstanceRecord): boolean {
    return Array.isArray(rec.manager_capabilities) && rec.manager_capabilities.includes(MANAGER_CAPABILITY_CLI_MEMORY);
  }

  async listHosts(accountIds: string[]): Promise<MemoryHostInfo[]> {
    const records = this.managerRecords();
    const ids = Array.from(new Set(records.map((r) => r.agent_id)));
    const names = new Map<string, string>();
    const projectCounts = new Map<string, number>();
    if (ids.length) {
      for (const h of await this.hosts.find({ where: { id: In(ids) } })) if (h.name) names.set(h.id, h.name);
      for (const dir of await this.projectDirsFor(ids, accountIds)) {
        projectCounts.set(dir.host_id, (projectCounts.get(dir.host_id) ?? 0) + 1);
      }
    }
    const byManager = new Map<string, MemoryHostInfo>();
    for (const rec of records) {
      const existing = byManager.get(rec.agent_id);
      if (existing) {
        existing.supported = existing.supported || this.supports(rec);
        if (rec.last_seen_at > existing.last_seen_at) existing.last_seen_at = rec.last_seen_at;
        continue;
      }
      byManager.set(rec.agent_id, {
        manager_id: rec.agent_id,
        name: names.get(rec.agent_id) || rec.hostname,
        hostname: rec.hostname,
        platform: typeof rec.platform === 'string' ? rec.platform : '',
        plugin_version: rec.plugin_version,
        last_seen_at: rec.last_seen_at,
        supported: this.supports(rec),
        project_count: projectCounts.get(rec.agent_id) ?? 0,
      });
    }
    return Array.from(byManager.values()).sort((a, b) => a.name.localeCompare(b.name));
  }

  private requireHost(managerId: string): InstanceRecord {
    const records = this.managerRecords().filter((r) => r.agent_id === managerId);
    if (!records.length) throw new CliMemoryError(404, 'host_offline', 'This Runtime Host is not connected right now.');
    const rec = records.find((r) => this.supports(r));
    if (!rec) {
      throw new CliMemoryError(409, 'memory_unsupported', `Runtime Host ${records[0].hostname} runs an agent-manager without memory support — update it first.`);
    }
    return rec;
  }

  private async projectDirsFor(hostIds: string[], accountIds: string[]): Promise<Array<MemoryProjectDir & { host_id: string }>> {
    if (!hostIds.length || !accountIds.length) return [];
    const rows = await this.folders.find({ where: { host_id: In(hostIds) } });
    if (!rows.length) return [];
    const projects = await this.projects.find({ where: { id: In(Array.from(new Set(rows.map((r) => r.project_id)))), account_id: In(accountIds) } });
    const byId = new Map(projects.map((p) => [p.id, p]));
    const out: Array<MemoryProjectDir & { host_id: string }> = [];
    for (const row of rows) {
      const project = byId.get(row.project_id);
      const path = String(row.path || '').trim();
      if (!project || !path || path.length > MEMORY_PATH_MAX) continue;
      out.push({ host_id: row.host_id, path, project_id: project.id, project_name: project.name });
    }
    return out.sort((a, b) => a.project_name.localeCompare(b.project_name));
  }

  private async projectDirs(managerId: string, accountIds: string[]): Promise<MemoryProjectDir[]> {
    const dirs = await this.projectDirsFor([managerId], accountIds);
    const seen = new Set<string>();
    return dirs
      .filter((d) => (seen.has(d.path) ? false : (seen.add(d.path), true)))
      .map(({ host_id: _host, ...rest }) => rest);
  }

  // ─── RPC (서버 → 매니저) ────────────────────────────────────────────────

  private rpc<T>(managerId: string, op: MemoryRequestOp, args: Partial<CliMemoryRequestPayload>, userId: string): Promise<T> {
    if (this.pending.size >= MAX_PENDING) {
      throw new CliMemoryError(503, 'too_many_requests', 'Too many in-flight memory requests; try again shortly.');
    }
    const requestId = randomUUID();
    const timeoutMs = RPC_TIMEOUT_MS[op] ?? DEFAULT_RPC_TIMEOUT_MS;
    const promise = new Promise<RpcResponseBody>((resolve) => {
      const timer = setTimeout(() => {
        if (!this.pending.delete(requestId)) return;
        this.logService.warn('Memory', `rpc ${op} timed out (manager=${managerId.slice(0, 8)})`);
        resolve({ ok: false, error: 'The Runtime Host did not respond in time.', code: 'timeout' });
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(requestId, { manager_id: managerId, op, resolve, timer });
    });
    const payload: CliMemoryRequestPayload = {
      manager_id: managerId,
      op,
      request_id: requestId,
      driver_user_id: userId,
      issued_at: new Date().toISOString(),
      ...args,
    };
    activityEvents.emit('cli_memory_request', payload);
    return promise.then((body) => {
      if (!body.ok) {
        const code = body.code || 'manager_error';
        const status = code === 'timeout' ? HOST_RPC_TIMEOUT_STATUS : MANAGER_CODE_STATUS[code] ?? HOST_RPC_FAILED_STATUS;
        const detail = body.result && typeof body.result === 'object' ? body.result : undefined;
        throw new CliMemoryError(status, code, body.error || 'Runtime Host reported an error.', detail);
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

  // ─── 입력 검사 ──────────────────────────────────────────────────────────

  private cli(value: unknown): string {
    const cli = typeof value === 'string' ? value.trim() : '';
    if (!CLI_RE.test(cli)) throw new CliMemoryError(400, 'cli_invalid', 'A CLI id is required.');
    return cli;
  }

  private path(value: unknown, field = 'path'): string {
    const path = typeof value === 'string' ? value : '';
    if (!path || path.length > MEMORY_PATH_MAX || path.includes('\0')) {
      throw new CliMemoryError(400, `${field}_invalid`, `An absolute ${field} is required.`);
    }
    return path;
  }

  private content(value: unknown): string {
    if (typeof value !== 'string') throw new CliMemoryError(400, 'content_required', 'content must be a string.');
    if (Buffer.byteLength(value, 'utf8') > MEMORY_WRITE_MAX_BYTES) {
      throw new CliMemoryError(413, 'content_too_large', `Memory files are capped at ${MEMORY_WRITE_MAX_BYTES} bytes.`);
    }
    return value;
  }

  /** `undefined`(확인 안 함) · `null`(없어야 함) · 16자리 해시. */
  private baseHash(value: unknown): string | null | undefined {
    if (value === undefined) return undefined;
    if (value === null) return null;
    if (typeof value === 'string' && HASH_RE.test(value)) return value;
    throw new CliMemoryError(400, 'base_hash_invalid', 'base_hash must be a 16-character hex hash or null.');
  }

  private reason(value: unknown, fallback: string): string {
    return typeof value === 'string' && /^[a-z_]{1,40}$/.test(value) ? value : fallback;
  }

  // ─── 사용자 표면 ────────────────────────────────────────────────────────

  async snapshot(accountIds: string[], userId: string, managerId: string, opts: { checkPaths: boolean }): Promise<MemoryHostSnapshot> {
    const rec = this.requireHost(managerId);
    const projectDirs = await this.projectDirs(managerId, accountIds);
    const result = await this.rpc<{ platform?: string; clis?: CliMemorySnapshot[]; content_budget_exhausted?: boolean }>(managerId, 'scan', {
      project_dirs: projectDirs.map((d) => d.path),
      check_paths: opts.checkPaths,
    }, userId);
    const clis = Array.isArray(result?.clis) ? result.clis : [];
    // 세션 홈은 credential id 로만 온다 — 사람이 알아보는 이름을 붙인다.
    const credentialIds = Array.from(new Set(clis.flatMap((c) => (c.homes || []).map((h) => h.credential_id).filter((id): id is string => !!id))));
    const credentialNames = new Map<string, string>();
    if (credentialIds.length) {
      for (const c of await this.credentials.find({ where: { id: In(credentialIds) }, select: ['id', 'name'] })) credentialNames.set(c.id, c.name);
    }
    for (const cli of clis) {
      for (const home of cli.homes || []) {
        if (home.credential_id) home.credential_name = credentialNames.get(home.credential_id) ?? null;
      }
    }
    const host = await this.hosts.findOne({ where: { id: managerId } });
    return {
      manager_id: managerId,
      manager_name: host?.name || rec.hostname,
      hostname: rec.hostname,
      platform: typeof result?.platform === 'string' ? result.platform : (rec.platform || ''),
      generated_at: new Date().toISOString(),
      project_dirs: projectDirs,
      clis,
      content_budget_exhausted: result?.content_budget_exhausted === true,
    };
  }

  async read(accountIds: string[], userId: string, managerId: string, input: { cli: unknown; path: unknown }): Promise<MemoryFileInfo> {
    this.requireHost(managerId);
    const projectDirs = await this.projectDirs(managerId, accountIds);
    const result = await this.rpc<{ file: MemoryFileInfo }>(managerId, 'read', {
      cli: this.cli(input.cli), path: this.path(input.path), project_dirs: projectDirs.map((d) => d.path),
    }, userId);
    return result.file;
  }

  async write(
    accountIds: string[],
    userId: string,
    managerId: string,
    input: { cli: unknown; path: unknown; content: unknown; base_hash: unknown; reason?: unknown },
  ): Promise<MemoryFileInfo> {
    this.requireHost(managerId);
    const cli = this.cli(input.cli);
    const path = this.path(input.path);
    const content = this.content(input.content);
    const baseHash = this.baseHash(input.base_hash);
    const projectDirs = await this.projectDirs(managerId, accountIds);
    const result = await this.rpc<{ file: MemoryFileInfo }>(managerId, 'write', {
      cli, path, content, base_hash: baseHash, reason: this.reason(input.reason, 'write'), project_dirs: projectDirs.map((d) => d.path),
    }, userId);
    this.logService.info('Memory', `write ${cli} ${path} on ${managerId.slice(0, 8)} by ${userId.slice(0, 8)} (${Buffer.byteLength(content)} bytes)`);
    return result.file;
  }

  async remove(accountIds: string[], userId: string, managerId: string, input: { cli: unknown; path: unknown; base_hash: unknown }): Promise<{ deleted: true }> {
    this.requireHost(managerId);
    const cli = this.cli(input.cli);
    const path = this.path(input.path);
    const projectDirs = await this.projectDirs(managerId, accountIds);
    await this.rpc(managerId, 'delete', { cli, path, base_hash: this.baseHash(input.base_hash), project_dirs: projectDirs.map((d) => d.path) }, userId);
    this.logService.info('Memory', `delete ${cli} ${path} on ${managerId.slice(0, 8)} by ${userId.slice(0, 8)}`);
    return { deleted: true };
  }

  async history(accountIds: string[], userId: string, managerId: string, input: { cli: unknown; path: unknown }): Promise<MemoryVersionInfo[]> {
    this.requireHost(managerId);
    const projectDirs = await this.projectDirs(managerId, accountIds);
    const result = await this.rpc<{ versions?: MemoryVersionInfo[] }>(managerId, 'history', {
      cli: this.cli(input.cli), path: this.path(input.path), project_dirs: projectDirs.map((d) => d.path),
    }, userId);
    return Array.isArray(result?.versions) ? result.versions : [];
  }

  async readVersion(
    accountIds: string[],
    userId: string,
    managerId: string,
    input: { cli: unknown; path: unknown; version_id: unknown },
  ): Promise<{ version_id: string; content: string; hash: string; size: number }> {
    this.requireHost(managerId);
    const versionId = typeof input.version_id === 'string' ? input.version_id : '';
    if (!VERSION_ID_RE.test(versionId)) throw new CliMemoryError(400, 'version_invalid', 'Unknown backup version.');
    const projectDirs = await this.projectDirs(managerId, accountIds);
    return this.rpc(managerId, 'read_version', {
      cli: this.cli(input.cli), path: this.path(input.path), version_id: versionId, project_dirs: projectDirs.map((d) => d.path),
    }, userId);
  }

  async restore(
    accountIds: string[],
    userId: string,
    managerId: string,
    input: { cli: unknown; path: unknown; version_id: unknown; base_hash: unknown },
  ): Promise<MemoryFileInfo> {
    this.requireHost(managerId);
    const versionId = typeof input.version_id === 'string' ? input.version_id : '';
    if (!VERSION_ID_RE.test(versionId)) throw new CliMemoryError(400, 'version_invalid', 'Unknown backup version.');
    const cli = this.cli(input.cli);
    const path = this.path(input.path);
    const projectDirs = await this.projectDirs(managerId, accountIds);
    const result = await this.rpc<{ file: MemoryFileInfo }>(managerId, 'restore', {
      cli, path, version_id: versionId, base_hash: this.baseHash(input.base_hash), project_dirs: projectDirs.map((d) => d.path),
    }, userId);
    this.logService.info('Memory', `restore ${cli} ${path} → ${versionId} on ${managerId.slice(0, 8)} by ${userId.slice(0, 8)}`);
    return result.file;
  }

  async link(
    accountIds: string[],
    userId: string,
    managerId: string,
    input: { cli: unknown; path: unknown; target: unknown; base_hash: unknown },
  ): Promise<{ file: MemoryFileInfo; linked: boolean; copied: boolean }> {
    this.requireHost(managerId);
    const cli = this.cli(input.cli);
    const path = this.path(input.path);
    const target = this.path(input.target, 'target');
    const projectDirs = await this.projectDirs(managerId, accountIds);
    const result = await this.rpc<{ file: MemoryFileInfo; linked: boolean; copied: boolean }>(managerId, 'link', {
      cli, path, target, base_hash: this.baseHash(input.base_hash), project_dirs: projectDirs.map((d) => d.path),
    }, userId);
    this.logService.info('Memory', `link ${cli} ${path} → ${target} on ${managerId.slice(0, 8)} by ${userId.slice(0, 8)}`);
    return result;
  }

  async batch(accountIds: string[], userId: string, managerId: string, opsInput: unknown): Promise<MemoryBatchResultItem[]> {
    this.requireHost(managerId);
    if (!Array.isArray(opsInput) || opsInput.length === 0) throw new CliMemoryError(400, 'ops_required', 'ops must be a non-empty array.');
    if (opsInput.length > MEMORY_BATCH_MAX) throw new CliMemoryError(413, 'batch_too_large', `At most ${MEMORY_BATCH_MAX} operations per batch.`);
    let totalBytes = 0;
    const ops: MemoryBatchOp[] = opsInput.map((raw: any) => {
      const op = raw?.op;
      if (op !== 'write' && op !== 'delete' && op !== 'link') throw new CliMemoryError(400, 'op_invalid', 'Each op must be write, delete or link.');
      const item: MemoryBatchOp = { op, cli: this.cli(raw.cli), path: this.path(raw.path) };
      if (raw.base_hash !== undefined) item.base_hash = this.baseHash(raw.base_hash);
      if (op === 'write') {
        item.content = this.content(raw.content);
        totalBytes += Buffer.byteLength(item.content);
      }
      if (op === 'link') item.target = this.path(raw.target, 'target');
      item.reason = this.reason(raw.reason, op);
      return item;
    });
    if (totalBytes > 8 * 1024 * 1024) throw new CliMemoryError(413, 'batch_too_large', 'A batch can write at most 8 MiB.');
    const projectDirs = await this.projectDirs(managerId, accountIds);
    const result = await this.rpc<{ results?: MemoryBatchResultItem[] }>(managerId, 'batch', { ops, project_dirs: projectDirs.map((d) => d.path) }, userId);
    const results = Array.isArray(result?.results) ? result.results : [];
    this.logService.info('Memory', `batch ${ops.length} op(s) on ${managerId.slice(0, 8)} by ${userId.slice(0, 8)}: ${results.filter((r) => r.ok).length} ok`);
    return results;
  }
}
