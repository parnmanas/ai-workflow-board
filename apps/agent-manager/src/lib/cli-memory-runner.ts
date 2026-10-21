// CLI Memory 러너 — docs/cli-memory.md.
//
// LLM CLI 의 메모리는 이 장비의 파일이다(Claude `CLAUDE.md`·auto memory, Codex `AGENTS.md`·
// `memories/`, Hermes `MEMORY.md`/`USER.md` …). 어디에 무엇이 있는지는 CLI 모듈의 `memory`
// 슬라이스가 선언하고, 이 러너는 그 선언 **안에서만** 읽고 쓴다:
//
//   - 쓰기·지우기는 선언된 파일이거나, 선언된 디렉터리 바로 아래의 새 `.md` 일 때만 받는다.
//     project 범위 파일은 서버가 알려 준 프로젝트 폴더에서만 선언되므로 임의의 폴더에
//     `CLAUDE.md` 를 만들 수 없다.
//   - 모든 변경 앞에 이전 내용을 `$AWB_AGENT_MANAGER_HOME/memory-backups` 에 떠 둔다(파일당
//     최근 30개). 화면의 History 가 이것을 보여 주고 되돌린다.
//   - 동시 편집은 `base_hash`(내용 sha256 앞 16자)로 막는다 — CLI 가 그 사이 자기 메모리를
//     고쳤으면 conflict 로 돌려보내고 화면이 다시 읽게 한다.
//   - 쓰기는 같은 디렉터리의 임시 파일 → rename 으로 원자적이다. 심볼릭 링크는 링크 자체가
//     아니라 대상 파일을 갈아 끼운다(세션 홈의 링크가 끊어지지 않게).
//
// AWB 서버는 `cli_memory_request` SSE 로 묻고, 답은 `POST /api/agent/cli-memory/rpc/:id` 다.

import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import { chmod, copyFile, lstat, mkdir, readFile, readlink, realpath, rename, rm, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';

import { AGENT_MANAGER_HOME } from './constants.js';
import { cliModulesWith } from './clis/index.js';
import type { CliMemoryDirDecl, CliMemoryFileDecl, CliMemoryHome, CliMemorySpec } from './clis/cli-module.js';
import { log } from './logging.js';
import { postCliMemoryRpcResponse, type AwbConfig } from './rest.js';

/** 서버 payload (apps/server/src/common/types/stream-events.ts CliMemoryRequestPayload).
 *  op 집합은 서버 `MEMORY_REQUEST_OPS`(common/types/cli-memory.ts)의 사본 — **양쪽을 같은 PR 로**. */
export interface MemoryRequest {
  manager_id: string;
  account_id?: string;
  op: 'scan' | 'read' | 'write' | 'delete' | 'history' | 'read_version' | 'restore' | 'link' | 'batch';
  request_id?: string;
  cli?: string;
  path?: string;
  content?: string;
  /** 문자열 = 지금 내용이 이 해시여야 / null = 없어야 / 생략 = 확인 안 함. */
  base_hash?: string | null;
  version_id?: string;
  target?: string;
  reason?: string;
  ops?: MemoryBatchOp[];
  project_dirs?: string[];
  check_paths?: boolean;
  driver_user_id?: string;
  issued_at?: string;
}

export interface MemoryBatchOp {
  op: 'write' | 'delete' | 'link';
  cli: string;
  path: string;
  content?: string;
  base_hash?: string | null;
  target?: string;
  reason?: string;
}

/** 서버 `MemoryFileInfo` 의 원본. */
export interface MemoryFileInfo {
  home_id: string;
  path: string;
  display_path: string;
  scope: string;
  kind: string;
  format: string;
  label: string;
  group: string;
  project_dir: string | null;
  loaded: string;
  load_limit_lines: number | null;
  char_limit: number | null;
  editable: boolean;
  exists: boolean;
  size: number;
  mtime: string | null;
  hash: string | null;
  content: string | null;
  truncated: boolean;
  omitted: boolean;
  link_target: string | null;
  shared_with: string | null;
  missing_paths?: string[];
}

interface BackupVersion {
  version_id: string;
  created_at: string;
  size: number;
  hash: string;
  reason: string;
}

/** 백업 디렉터리의 index.json — 경로와 그 파일의 선언(지운 뒤에도 되돌릴 수 있게)과 버전 목록. */
interface BackupIndex {
  path: string;
  cli: string;
  decl?: Omit<CliMemoryFileDecl, 'path' | 'slot'>;
  versions: BackupVersion[];
}

export interface MemoryBatchResultItem {
  ok: boolean;
  op: string;
  path: string;
  file?: MemoryFileInfo | null;
  error?: string;
  code?: string;
}

interface MemoryModule {
  id: string;
  label: string;
  memory: CliMemorySpec;
}

export interface MemoryRunnerOptions {
  getManagerId: () => string;
  env?: NodeJS.ProcessEnv;
  /** AWB 세션 전용 cli-home 루트(agent-session-runner 와 같은 곳). */
  sessionHomesDir?: string;
  /** 백업 루트. */
  backupDir?: string;
  userHome?: string;
  /** 테스트용 — CLI 모듈 대신 쓸 메모리 선언. */
  modules?: MemoryModule[];
  /** 테스트용 — RPC 응답을 가로챈다. */
  respond?: (requestId: string, body: RpcBody) => Promise<void> | void;
}

type RpcBody = { ok: boolean; result?: unknown; error?: string; code?: string };

/** 서버 common/types/cli-memory.ts 와 같은 값. */
const SCAN_FILE_MAX = 256 * 1024;
const SCAN_TOTAL_MAX = 6 * 1024 * 1024;
const READ_MAX = 2 * 1024 * 1024;
const WRITE_MAX = 1024 * 1024;
/** 이보다 큰 파일은 읽지 않는다(해시도 없다) — 화면에서는 "너무 커서 여기서 못 고친다" 로 보인다. */
const HASH_MAX = 16 * 1024 * 1024;
const FILES_MAX = 2000;
const BATCH_MAX = 200;
const VERSIONS_KEEP = 30;
const PATH_MAX = 4096;
/** 한 파일에서 확인하는 참조 경로 수 / 스캔 전체 상한. */
const PATH_CHECKS_PER_FILE = 200;
const PATH_CHECKS_TOTAL = 3000;
/** 선언된 디렉터리에 새로 만들 수 있는 파일 이름. */
const SAFE_MD_NAME = /^[A-Za-z0-9가-힣][A-Za-z0-9가-힣._ -]{0,120}\.md$/;
const VERSION_ID_RE = /^[0-9]{13}-[0-9a-f]{8}$/;

class MemoryError extends Error {
  constructor(public readonly code: string, message: string, public readonly detail?: Record<string, unknown>) {
    super(message);
  }
}

export function memoryHash(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex').slice(0, 16);
}

function isBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8192);
  for (let i = 0; i < n; i += 1) if (buf[i] === 0) return true;
  return false;
}

/** 경로가 dir 자신이거나 그 아래인가(문자열 비교 — 둘 다 resolve 된 값). */
function within(path: string, dir: string): boolean {
  return path === dir || path.startsWith(dir.endsWith(sep) ? dir : dir + sep);
}

/**
 * 메모리 내용이 가리키는 경로. 절대 경로(`/mnt/…`, `~/…`)는 첫 구간이 실제로 루트에 있을 때만
 * 경로로 본다 — `/api/agent/sessions` 같은 API 경로를 "없는 파일" 로 오인하지 않기 위해서다.
 * 백틱 안의 상대 경로(`apps/server/src/x.ts`)는 프로젝트 폴더를 알 때만, 그 첫 구간이 그 폴더에
 * 있을 때만 본다.
 */
export function referencedPaths(content: string, opts: { projectDir: string | null; userHome: string; rootEntries: ReadonlySet<string>; platform?: string }): string[] {
  const out = new Set<string>();
  const trim = (s: string) => s.replace(/[.,:;)\]}'"`]+$/, '');
  const absRe = /(?<![\w:/.~$@-])(~\/[^\s`'"<>()[\]{},;|]+|\/(?:[A-Za-z0-9._@+-]+\/)+[A-Za-z0-9._@+-]*)/g;
  for (const m of content.matchAll(absRe)) {
    if (out.size >= PATH_CHECKS_PER_FILE) break;
    let p = trim(m[1]);
    if (p.includes('*') || p.includes('<') || p.includes('{')) continue;
    // 구간 수는 **합치기 전에** 센다 — Windows 에서 `join(홈, …)` 은 `\` 로 이어 붙여 `/` 로 세면 한 구간이 된다.
    if (p.startsWith('~/')) {
      const rel = p.slice(2).replace(/\/+$/, '');
      if (!rel) continue;
      p = join(opts.userHome, rel);
    } else {
      const parts = p.split('/').filter(Boolean);
      if (parts.length < 2 || !opts.rootEntries.has(parts[0])) continue;
      p = p.replace(/\/+$/, '');
    }
    out.add(p);
  }
  if ((opts.platform ?? process.platform) === 'win32') {
    for (const m of content.matchAll(/\b([A-Za-z]:\\[^\s`'"<>|*?]+)/g)) {
      if (out.size >= PATH_CHECKS_PER_FILE) break;
      out.add(trim(m[1]));
    }
  }
  if (opts.projectDir) {
    for (const m of content.matchAll(/`([A-Za-z0-9._@-]+(?:\/[A-Za-z0-9._@-]+)+\/?)`/g)) {
      if (out.size >= PATH_CHECKS_PER_FILE) break;
      const rel = m[1].replace(/\/+$/, '');
      const first = rel.split('/')[0];
      if (first === '.' || first === '..' || /^v?\d/.test(first)) continue;
      if (!existsSync(join(opts.projectDir, first))) continue;
      out.add(join(opts.projectDir, rel));
    }
  }
  return Array.from(out);
}

interface Located {
  module: MemoryModule;
  home: CliMemoryHome;
  files: CliMemoryFileDecl[];
  dirs: CliMemoryDirDecl[];
}

interface ReadResult {
  exists: boolean;
  buf: Buffer | null;
  size: number;
  mtime: string | null;
  hash: string | null;
  linkTarget: string | null;
  real: string | null;
}

export class MemoryRunner {
  readonly #config: AwbConfig;
  readonly #opts: MemoryRunnerOptions;
  readonly #env: NodeJS.ProcessEnv;
  readonly #userHome: string;
  readonly #sessionHomesDir: string;
  readonly #backupDir: string;

  constructor(config: AwbConfig, opts: MemoryRunnerOptions) {
    this.#config = config;
    this.#opts = opts;
    this.#env = opts.env ?? process.env;
    this.#userHome = opts.userHome ?? homedir();
    this.#sessionHomesDir = opts.sessionHomesDir ?? join(AGENT_MANAGER_HOME, 'session-homes');
    this.#backupDir = opts.backupDir ?? join(AGENT_MANAGER_HOME, 'memory-backups');
  }

  /** 메모리 슬라이스를 선언한 CLI. */
  modules(): MemoryModule[] {
    if (this.#opts.modules) return this.#opts.modules;
    return cliModulesWith('memory').map((m) => ({ id: m.id, label: m.label, memory: m.memory }));
  }

  async handle(req: MemoryRequest): Promise<void> {
    try {
      const result = await this.run(req);
      await this.#respond(req, { ok: true, result });
    } catch (err: any) {
      const code = err instanceof MemoryError ? err.code : 'manager_error';
      if (!(err instanceof MemoryError)) log(`cli_memory_request ${req.op} failed: ${err?.message ?? err}`);
      await this.#respond(req, {
        ok: false,
        error: err?.message ?? String(err),
        code,
        ...(err instanceof MemoryError && err.detail ? { result: err.detail } : {}),
      });
    }
  }

  /** RPC 하나를 실행해 결과를 돌려준다(응답 전송 없이) — 테스트와 handle 이 같이 쓴다. */
  async run(req: MemoryRequest): Promise<unknown> {
    const projectDirs = this.#projectDirs(req.project_dirs);
    switch (req.op) {
      case 'scan':
        return this.scan(projectDirs, req.check_paths === true);
      case 'read':
        return { file: await this.read(this.#cli(req.cli), this.#path(req.path), projectDirs) };
      case 'write':
        return { file: await this.write(this.#cli(req.cli), this.#path(req.path), req.content, req.base_hash, projectDirs, req.reason || 'write') };
      case 'delete':
        await this.remove(this.#cli(req.cli), this.#path(req.path), req.base_hash, projectDirs, req.reason || 'delete');
        return { deleted: true };
      case 'history':
        return { versions: await this.history(this.#cli(req.cli), this.#path(req.path), projectDirs) };
      case 'read_version':
        return this.readVersion(this.#cli(req.cli), this.#path(req.path), String(req.version_id ?? ''), projectDirs);
      case 'restore':
        return { file: await this.restore(this.#cli(req.cli), this.#path(req.path), String(req.version_id ?? ''), req.base_hash, projectDirs) };
      case 'link':
        return this.link(this.#cli(req.cli), this.#path(req.path), this.#path(req.target), req.base_hash, projectDirs);
      case 'batch':
        return { results: await this.batch(Array.isArray(req.ops) ? req.ops : [], projectDirs) };
      default:
        throw new MemoryError('op_unknown', `Unknown memory op ${String((req as any).op)}`);
    }
  }

  async #respond(req: MemoryRequest, body: RpcBody): Promise<void> {
    if (!req.request_id) return;
    if (this.#opts.respond) {
      await this.#opts.respond(req.request_id, body);
      return;
    }
    await postCliMemoryRpcResponse(this.#config, this.#opts.getManagerId(), req.request_id, body, req.op);
  }

  // ─── 입력 정리 ───────────────────────────────────────────────────────────

  #projectDirs(raw: unknown): string[] {
    if (!Array.isArray(raw)) return [];
    const out: string[] = [];
    for (const item of raw.slice(0, 500)) {
      if (typeof item !== 'string' || !item || item.length > PATH_MAX || item.includes('\0')) continue;
      if (!isAbsolute(item)) continue;
      const dir = resolve(item);
      if (!out.includes(dir)) out.push(dir);
    }
    return out;
  }

  #cli(raw: unknown): MemoryModule {
    const id = typeof raw === 'string' ? raw : '';
    const module = this.modules().find((m) => m.id === id);
    if (!module) throw new MemoryError('cli_unsupported', `${id || '(none)'} has no memory support on this Runtime Host.`);
    return module;
  }

  #path(raw: unknown): string {
    const p = typeof raw === 'string' ? raw : '';
    if (!p || p.length > PATH_MAX || p.includes('\0') || !isAbsolute(p)) {
      throw new MemoryError('path_invalid', 'An absolute memory file path is required.');
    }
    return resolve(p);
  }

  #display(path: string): string {
    return within(path, this.#userHome) ? `~${path.slice(this.#userHome.length)}` : path;
  }

  // ─── 위치 ────────────────────────────────────────────────────────────────

  async #homes(module: MemoryModule): Promise<CliMemoryHome[]> {
    const operator: CliMemoryHome = { id: 'operator', kind: 'operator', path: resolve(module.memory.root(this.#env)), credentialId: null, profile: null };
    let extra: CliMemoryHome[] = [];
    try {
      extra = (await module.memory.extraHomes?.({ sessionHomesDir: this.#sessionHomesDir, env: this.#env })) ?? [];
    } catch (err: any) {
      log(`[cli-memory ${module.id}] extra homes failed: ${err?.message ?? err}`);
    }
    // 매니저가 세션 홈 안에서 떠 있으면(CLAUDE_CONFIG_DIR 가 그 홈) 운영자 홈과 세션 홈이 같은 곳이다 —
    // 같은 홈을 두 번 세지 않는다.
    return [operator, ...extra.map((h) => ({ ...h, path: resolve(h.path) })).filter((h) => h.path !== operator.path)];
  }

  async #locate(module: MemoryModule, projectDirs: string[]): Promise<Located[]> {
    const out: Located[] = [];
    for (const home of await this.#homes(module)) {
      try {
        const found = await module.memory.locate({ home, userHome: this.#userHome, projectDirs });
        out.push({
          module,
          home,
          files: found.files.slice(0, FILES_MAX).map((f) => ({ ...f, path: resolve(f.path) })),
          dirs: found.dirs.map((d) => ({ ...d, path: resolve(d.path) })),
        });
      } catch (err: any) {
        log(`[cli-memory ${module.id}] locate ${home.id} failed: ${err?.message ?? err}`);
        out.push({ module, home, files: [], dirs: [] });
      }
    }
    return out;
  }

  /**
   * 쓰기 대상 판정 — 선언된 파일이거나, 선언된 디렉터리 바로 아래의 새 `.md`. 둘 다 아니면 거부.
   * 판정 결과로 그 파일의 선언(라벨·형식)을 돌려준다.
   */
  async #resolveTarget(
    module: MemoryModule,
    path: string,
    projectDirs: string[],
    opts: { allowBackedUp?: boolean } = {},
  ): Promise<{ decl: CliMemoryFileDecl; home: CliMemoryHome; located: Located[] }> {
    const located = await this.#locate(module, projectDirs);
    for (const loc of located) {
      const decl = loc.files.find((f) => f.path === path);
      if (decl) return { decl, home: loc.home, located };
    }
    const parent = dirname(path);
    const name = basename(path);
    for (const loc of located) {
      const dir = loc.dirs.find((d) => d.path === parent);
      if (dir && SAFE_MD_NAME.test(name)) {
        return {
          decl: {
            path, scope: dir.scope, kind: dir.kind, format: 'markdown', label: name.replace(/\.md$/i, ''),
            group: dir.group, projectDir: dir.projectDir, loaded: dir.kind === 'auto_topic' ? 'on_demand' : 'always',
          },
          home: loc.home,
          located,
        };
      }
    }
    // 지운 파일(CLI 가 다시 만들지 않는 주제·요약 파일)은 더는 선언되지 않는다 — 그래도 우리가 백업해 둔
    // 경로라면 기록을 보고 되돌릴 수 있어야 한다. 백업이 있다는 것은 그 경로가 선언 위치였다는 증거다.
    if (opts.allowBackedUp) {
      const meta = await this.#backupIndex(this.#backupKey(module.id, path));
      if (meta?.path === path && meta.decl) {
        const operator = located.find((l) => l.home.kind === 'operator')?.home ?? located[0]?.home;
        if (operator) return { decl: { ...meta.decl, path, slot: false }, home: operator, located };
      }
    }
    throw new MemoryError('path_not_allowed', `${this.#display(path)} is not a ${module.label} memory location on this host.`);
  }

  /**
   * 심볼릭 링크를 따라갈 곳이 메모리 위치인가 — 링크의 실제 대상이 **어느 CLI 든** 선언한 메모리 파일이거나
   * 선언된 디렉터리 안이어야 한다. 메모리 디렉터리에 심어 둔 링크로 자격 증명·설정 같은 엉뚱한 파일을
   * 덮어쓰지 못하게 하면서, 흔한 구성(`CLAUDE.md` → `AGENTS.md`)은 어느 탭에서 고쳐도 되게 한다.
   */
  async #linkTargetAllowed(real: string, located: Located[], projectDirs: string[]): Promise<boolean> {
    // 비교는 실제 경로끼리 한다 — 선언 경로는 설정·환경에서 온 문자열이라 realpath 와 글자가 다를 수 있다
    // (Windows 8.3 단축명 `RUNNER~1`, 링크가 낀 상위 폴더, 대소문자).
    const key = (p: string) => (process.platform === 'win32' ? p.toLowerCase() : p);
    const realOf = async (p: string) => key(await realpath(p).catch(() => resolve(p)));
    const target = key(real);
    const targetDir = key(dirname(real));
    const declared = async (locs: Located[]): Promise<boolean> => {
      for (const loc of locs) {
        if (loc.files.some((f) => key(f.path) === target) || loc.dirs.some((d) => key(d.path) === targetDir)) return true;
      }
      for (const loc of locs) {
        for (const f of loc.files) if (await realOf(f.path) === target) return true;
        for (const d of loc.dirs) if (await realOf(d.path) === targetDir) return true;
      }
      return false;
    };
    if (await declared(located)) return true;
    for (const other of this.modules()) {
      if (other.id === located[0]?.module.id) continue;
      if (await declared(await this.#locate(other, projectDirs))) return true;
    }
    return false;
  }

  // ─── 파일 읽기 ───────────────────────────────────────────────────────────

  async #readRaw(path: string, cap: number): Promise<ReadResult> {
    let ls;
    try {
      ls = await lstat(path);
    } catch {
      return { exists: false, buf: null, size: 0, mtime: null, hash: null, linkTarget: null, real: null };
    }
    let linkTarget: string | null = null;
    if (ls.isSymbolicLink()) {
      linkTarget = await readlink(path).catch(() => null);
    }
    let st;
    let real: string;
    try {
      st = await stat(path);
      real = await realpath(path);
    } catch {
      // 끊어진 링크 — 없는 파일로 본다(링크 자체는 지울 수 있게 linkTarget 은 남긴다).
      return { exists: false, buf: null, size: 0, mtime: null, hash: null, linkTarget, real: null };
    }
    if (!st.isFile()) return { exists: false, buf: null, size: 0, mtime: null, hash: null, linkTarget, real };
    if (st.size > HASH_MAX) return { exists: true, buf: null, size: st.size, mtime: st.mtime.toISOString(), hash: null, linkTarget, real };
    const full = await readFile(path);
    return {
      exists: true,
      buf: full.length > cap ? full.subarray(0, cap) : full,
      size: full.length,
      mtime: st.mtime.toISOString(),
      hash: memoryHash(full),
      linkTarget,
      real,
    };
  }

  #info(decl: CliMemoryFileDecl, home: CliMemoryHome, raw: ReadResult, opts: { content: boolean; cap: number }): MemoryFileInfo {
    const binary = raw.buf ? isBinary(raw.buf) : false;
    // 너무 커서 읽지 않은 파일도 "잘림" 이다 — 화면이 읽기 전용으로 보인다.
    const truncated = raw.exists && (!raw.buf || raw.size > opts.cap);
    const content = opts.content && raw.buf && !binary ? raw.buf.subarray(0, opts.cap).toString('utf8') : null;
    return {
      home_id: home.id,
      path: decl.path,
      display_path: this.#display(decl.path),
      scope: decl.scope,
      kind: decl.kind,
      format: decl.format,
      label: decl.label,
      group: decl.group,
      project_dir: decl.projectDir,
      loaded: decl.loaded,
      load_limit_lines: decl.loadLimitLines ?? null,
      char_limit: decl.charLimit ?? null,
      editable: decl.editable !== false && !binary && raw.size <= WRITE_MAX,
      exists: raw.exists,
      size: raw.size,
      mtime: raw.mtime,
      hash: raw.hash,
      content,
      truncated,
      omitted: false,
      link_target: raw.linkTarget,
      shared_with: null,
    };
  }

  // ─── scan ────────────────────────────────────────────────────────────────

  async scan(projectDirs: string[], checkPaths: boolean): Promise<{ platform: string; clis: unknown[]; content_budget_exhausted: boolean }> {
    let budget = SCAN_TOTAL_MAX;
    let pathChecks = PATH_CHECKS_TOTAL;
    let rootEntries: Set<string> = new Set();
    if (checkPaths && process.platform !== 'win32') {
      try { rootEntries = new Set(readdirSync('/')); } catch { /* 경로 검사 없이 */ }
    }
    const statCache = new Map<string, boolean>();
    const exists = async (p: string): Promise<boolean> => {
      const hit = statCache.get(p);
      if (hit !== undefined) return hit;
      let ok = true;
      try { await stat(p); } catch (err: any) { ok = err?.code !== 'ENOENT' && err?.code !== 'ENOTDIR'; }
      statCache.set(p, ok);
      return ok;
    };

    const clis: unknown[] = [];
    for (const module of this.modules()) {
      const root = resolve(module.memory.root(this.#env));
      const located = await this.#locate(module, projectDirs);
      const detected = existsSync(root) || located.some((l) => l.home.kind !== 'operator');
      const files: MemoryFileInfo[] = [];
      const seenReal = new Map<string, string>();
      // 이미 앞 홈에서 나온 실제 디렉터리 — 세션 홈의 `projects` 처럼 링크로 공유된 곳의 빈 자리와
      // 생성 가능 디렉터리를 두 번 내지 않는다.
      const seenRealDirs = new Set<string>();
      const sharedDirs: Array<{ homeId: string; dir: string }> = [];
      for (const loc of located) {
        const seenPath = new Set<string>();
        for (const decl of loc.files) {
          if (seenPath.has(decl.path)) continue;
          seenPath.add(decl.path);
          const raw = await this.#readRaw(decl.path, SCAN_FILE_MAX);
          if (!raw.exists && !(decl.slot && detected)) continue;
          const realDir = await realpath(dirname(decl.path)).catch(() => null);
          if (!raw.exists && realDir && loc.home.kind !== 'operator' && seenRealDirs.has(realDir)) continue;
          if (realDir && loc.home.kind === 'operator') seenRealDirs.add(realDir);
          const sharedWith = raw.real ? seenReal.get(raw.real) ?? null : null;
          const wantContent = raw.exists && !sharedWith && budget > 0;
          const info = this.#info(decl, loc.home, raw, { content: wantContent, cap: SCAN_FILE_MAX });
          if (sharedWith) info.shared_with = sharedWith;
          if (raw.exists && !sharedWith && !wantContent) info.omitted = true;
          if (info.content) budget -= Buffer.byteLength(info.content);
          if (raw.real && !sharedWith) seenReal.set(raw.real, loc.home.id);
          if (checkPaths && info.content && pathChecks > 0) {
            const refs = referencedPaths(info.content, { projectDir: decl.projectDir, userHome: this.#userHome, rootEntries });
            const missing: string[] = [];
            for (const ref of refs) {
              if (pathChecks <= 0) break;
              pathChecks -= 1;
              if (!(await exists(ref))) missing.push(ref);
            }
            if (missing.length) info.missing_paths = missing.map((p) => this.#display(p));
          }
          files.push(info);
        }
      }
      for (const loc of located) {
        for (const d of loc.dirs) {
          const real = await realpath(d.path).catch(() => null);
          if (loc.home.kind === 'operator') {
            if (real) seenRealDirs.add(real);
          } else if (real && seenRealDirs.has(real)) {
            sharedDirs.push({ homeId: loc.home.id, dir: d.path });
          }
        }
      }
      const isShared = (homeId: string, dir: string) => sharedDirs.some((s) => s.homeId === homeId && s.dir === dir);
      const dirs = located.flatMap((loc) => loc.dirs.filter((d) => !isShared(loc.home.id, d.path)).map((d) => ({
        home_id: loc.home.id,
        path: d.path,
        display_path: this.#display(d.path),
        scope: d.scope,
        kind: d.kind,
        label: d.label,
        group: d.group,
        project_dir: d.projectDir,
        exists: existsSync(d.path),
      })));
      let settings: Record<string, string | number | boolean | null> = {};
      try {
        settings = (await module.memory.settings?.(located[0].home)) ?? {};
      } catch { /* best-effort */ }
      clis.push({
        cli: module.id,
        label: module.label,
        summary: module.memory.summary,
        detected,
        homes: located.map((l) => ({
          id: l.home.id,
          kind: l.home.kind,
          path: l.home.path,
          display_path: this.#display(l.home.path),
          credential_id: l.home.credentialId,
          profile: l.home.profile,
          exists: existsSync(l.home.path),
        })),
        files,
        dirs,
        settings,
      });
    }
    return { platform: process.platform, clis, content_budget_exhausted: budget <= 0 };
  }

  // ─── read / write / delete ───────────────────────────────────────────────

  async read(module: MemoryModule, path: string, projectDirs: string[]): Promise<MemoryFileInfo> {
    const { decl, home } = await this.#resolveTarget(module, path, projectDirs);
    const raw = await this.#readRaw(path, READ_MAX);
    return this.#info(decl, home, raw, { content: true, cap: READ_MAX });
  }

  #checkBase(raw: ReadResult, baseHash: string | null | undefined, path: string): void {
    if (baseHash === undefined) return;
    if (baseHash === null) {
      if (raw.exists) throw new MemoryError('conflict', `${this.#display(path)} already exists — reload before writing.`, { current_hash: raw.hash });
      return;
    }
    if (!raw.exists || raw.hash !== baseHash) {
      throw new MemoryError('conflict', `${this.#display(path)} changed on the host since it was loaded — reload before writing.`, { current_hash: raw.hash });
    }
  }

  async write(
    module: MemoryModule,
    path: string,
    content: unknown,
    baseHash: string | null | undefined,
    projectDirs: string[],
    reason: string,
    opts: { allowBackedUp?: boolean } = {},
  ): Promise<MemoryFileInfo> {
    if (typeof content !== 'string') throw new MemoryError('content_required', 'content must be a string.');
    const bytes = Buffer.from(content, 'utf8');
    if (bytes.length > WRITE_MAX) throw new MemoryError('content_too_large', `Memory files are capped at ${WRITE_MAX} bytes.`);
    const { decl, home, located } = await this.#resolveTarget(module, path, projectDirs, opts);
    if (decl.editable === false) throw new MemoryError('read_only', `${this.#display(path)} is read-only.`);
    const raw = await this.#readRaw(path, READ_MAX);
    // 백업할 수 없는(읽지 않은) 큰 파일은 덮어쓰지 않는다 — 되돌릴 길이 없는 쓰기가 된다.
    if (raw.exists && !raw.buf) throw new MemoryError('read_only', `${this.#display(path)} is too large to edit from AWB.`);
    this.#checkBase(raw, baseHash, path);
    // 링크면 대상 파일을 갈아 끼운다 — 링크를 일반 파일로 바꿔 버리면 세션 홈이 운영자 홈과 갈라진다.
    let dest = path;
    if (raw.linkTarget) {
      if (!raw.real) throw new MemoryError('link_broken', `${this.#display(path)} is a broken symbolic link — delete it first.`);
      if (!(await this.#linkTargetAllowed(raw.real, located, projectDirs))) {
        throw new MemoryError('path_not_allowed', `${this.#display(path)} links outside the memory locations.`);
      }
      dest = raw.real;
    }
    if (raw.exists && raw.buf) await this.#backup(module.id, path, await readFile(path), reason, decl);
    await mkdir(dirname(dest), { recursive: true });
    const tmp = join(dirname(dest), `.${basename(dest)}.awb-${randomBytes(4).toString('hex')}.tmp`);
    let mode: number | null = null;
    try { mode = (await stat(dest)).mode & 0o777; } catch { /* 새 파일 */ }
    try {
      await writeFile(tmp, bytes, { mode: mode ?? 0o644 });
      if (mode !== null) await chmod(tmp, mode).catch(() => {});
      await rename(tmp, dest);
    } catch (err) {
      await rm(tmp, { force: true }).catch(() => {});
      throw err;
    }
    log(`[cli-memory ${module.id}] ${reason} ${this.#display(path)} (${bytes.length} bytes)`);
    const after = await this.#readRaw(path, READ_MAX);
    return this.#info(decl, home, after, { content: true, cap: READ_MAX });
  }

  async remove(module: MemoryModule, path: string, baseHash: string | null | undefined, projectDirs: string[], reason: string): Promise<void> {
    const { decl } = await this.#resolveTarget(module, path, projectDirs);
    const raw = await this.#readRaw(path, READ_MAX);
    if (!raw.exists && !raw.linkTarget) throw new MemoryError('not_found', `${this.#display(path)} does not exist.`);
    if (raw.exists && !raw.buf && !raw.linkTarget) throw new MemoryError('read_only', `${this.#display(path)} is too large to delete from AWB.`);
    // 지우기의 base_hash 는 "지금 이 내용이어야" 만 뜻한다(null — "없어야" — 은 지우기에 의미가 없다).
    this.#checkBase(raw, baseHash === null ? undefined : baseHash, path);
    if (raw.exists) await this.#backup(module.id, path, await readFile(path), reason, decl);
    // 링크면 링크만 지운다(대상은 운영자 홈의 원본이다).
    await unlink(path);
    log(`[cli-memory ${module.id}] ${reason} ${this.#display(path)}`);
  }

  // ─── link (세션 홈 → 운영자 홈) ───────────────────────────────────────────

  /**
   * 세션 전용 홈의 메모리 자리를 운영자 홈의 같은 파일로 링크한다 — AWB 세션(credential 이 묶인)이
   * 운영자의 전역 지침을 보게 하는 수단. Windows 에서 심볼릭 링크를 못 만들면 복사한다(그때는 이후
   * 변경이 따라가지 않으므로 결과에 `copied` 로 알린다).
   */
  async link(module: MemoryModule, path: string, target: string, baseHash: string | null | undefined, projectDirs: string[]): Promise<{ file: MemoryFileInfo; linked: boolean; copied: boolean }> {
    const { decl, home, located } = await this.#resolveTarget(module, path, projectDirs);
    if (home.kind === 'operator') throw new MemoryError('link_invalid', 'Only memory slots in session or profile homes can be linked.');
    // 원본은 운영자 홈 **안의** 같은 종류 파일이어야 한다(전역 지침 자리를 프로젝트 파일에 잇지 않는다).
    const operatorLoc = located.find((l) => l.home.kind === 'operator');
    const source = operatorLoc?.files.find((f) => f.path === target);
    if (!source || !operatorLoc || !within(target, operatorLoc.home.path) || source.scope !== decl.scope || source.kind !== decl.kind) {
      throw new MemoryError('path_not_allowed', `${this.#display(target)} is not a matching ${module.label} memory file in the operator home.`);
    }
    const sourceRaw = await this.#readRaw(target, READ_MAX);
    if (!sourceRaw.exists) throw new MemoryError('not_found', `${this.#display(target)} does not exist.`);
    const raw = await this.#readRaw(path, READ_MAX);
    if (raw.exists || raw.linkTarget) {
      this.#checkBase(raw, baseHash, path);
      if (raw.exists) await this.#backup(module.id, path, await readFile(path), 'link', decl);
      await unlink(path);
    }
    await mkdir(dirname(path), { recursive: true });
    let linked = true;
    let copied = false;
    try {
      await symlink(target, path, 'file');
    } catch (err: any) {
      if (process.platform !== 'win32') throw err;
      await copyFile(target, path);
      linked = false;
      copied = true;
    }
    log(`[cli-memory ${module.id}] ${linked ? 'linked' : 'copied'} ${this.#display(path)} → ${this.#display(target)}`);
    const after = await this.#readRaw(path, READ_MAX);
    return { file: this.#info(decl, home, after, { content: true, cap: READ_MAX }), linked, copied };
  }

  // ─── batch ───────────────────────────────────────────────────────────────

  async batch(ops: MemoryBatchOp[], projectDirs: string[]): Promise<MemoryBatchResultItem[]> {
    if (ops.length > BATCH_MAX) throw new MemoryError('batch_too_large', `At most ${BATCH_MAX} operations per batch.`);
    const results: MemoryBatchResultItem[] = [];
    for (const item of ops) {
      const op = String(item?.op ?? '');
      const rawPath = typeof item?.path === 'string' ? item.path : '';
      try {
        const module = this.#cli(item?.cli);
        const path = this.#path(rawPath);
        const reason = typeof item.reason === 'string' && item.reason ? item.reason.slice(0, 40) : op;
        if (op === 'write') {
          results.push({ ok: true, op, path, file: await this.write(module, path, item.content, item.base_hash, projectDirs, reason) });
        } else if (op === 'delete') {
          await this.remove(module, path, item.base_hash, projectDirs, reason);
          results.push({ ok: true, op, path, file: null });
        } else if (op === 'link') {
          const linked = await this.link(module, path, this.#path(item.target), item.base_hash, projectDirs);
          results.push({ ok: true, op, path, file: linked.file });
        } else {
          throw new MemoryError('op_unknown', `Unknown batch op ${op}`);
        }
      } catch (err: any) {
        results.push({ ok: false, op, path: rawPath, error: err?.message ?? String(err), code: err instanceof MemoryError ? err.code : 'manager_error' });
      }
    }
    return results;
  }

  // ─── 백업 ────────────────────────────────────────────────────────────────

  #backupKey(cli: string, path: string): string {
    return join(this.#backupDir, cli, createHash('sha256').update(path).digest('hex').slice(0, 24));
  }

  async #backupIndex(dir: string): Promise<BackupIndex | null> {
    try {
      const parsed = JSON.parse(await readFile(join(dir, 'index.json'), 'utf8'));
      return parsed && typeof parsed === 'object' ? parsed as BackupIndex : null;
    } catch {
      return null;
    }
  }

  async #versions(dir: string): Promise<BackupVersion[]> {
    const index = await this.#backupIndex(dir);
    return Array.isArray(index?.versions) ? index.versions : [];
  }

  async #backup(cli: string, path: string, bytes: Buffer, reason: string, decl: CliMemoryFileDecl): Promise<string> {
    const dir = this.#backupKey(cli, path);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const versions = await this.#versions(dir);
    const hash = memoryHash(bytes);
    // 같은 내용을 연달아 백업하지 않는다(되돌리기 목록이 같은 사본으로 차지 않게).
    if (versions[0]?.hash === hash) return versions[0].version_id;
    const versionId = `${Date.now()}-${randomBytes(4).toString('hex')}`;
    await writeFile(join(dir, `${versionId}.bak`), bytes, { mode: 0o600 });
    versions.unshift({ version_id: versionId, created_at: new Date().toISOString(), size: bytes.length, hash, reason: reason.slice(0, 40) });
    for (const old of versions.splice(VERSIONS_KEEP)) {
      await rm(join(dir, `${old.version_id}.bak`), { force: true }).catch(() => {});
    }
    const tmp = join(dir, `index.${randomBytes(4).toString('hex')}.tmp`);
    const { path: _p, slot: _s, ...declMeta } = decl;
    const index: BackupIndex = { path, cli, decl: declMeta, versions };
    await writeFile(tmp, JSON.stringify(index, null, 2), { mode: 0o600 });
    await rename(tmp, join(dir, 'index.json'));
    return versionId;
  }

  async history(module: MemoryModule, path: string, projectDirs: string[]) {
    await this.#resolveTarget(module, path, projectDirs, { allowBackedUp: true });
    return this.#versions(this.#backupKey(module.id, path));
  }

  async readVersion(module: MemoryModule, path: string, versionId: string, projectDirs: string[]): Promise<{ version_id: string; content: string; hash: string; size: number }> {
    await this.#resolveTarget(module, path, projectDirs, { allowBackedUp: true });
    if (!VERSION_ID_RE.test(versionId)) throw new MemoryError('version_invalid', 'Unknown backup version.');
    const dir = this.#backupKey(module.id, path);
    const meta = (await this.#versions(dir)).find((v) => v.version_id === versionId);
    if (!meta) throw new MemoryError('not_found', 'That backup version no longer exists.');
    const bytes = await readFile(join(dir, `${versionId}.bak`));
    return { version_id: versionId, content: bytes.toString('utf8'), hash: memoryHash(bytes), size: bytes.length };
  }

  async restore(module: MemoryModule, path: string, versionId: string, baseHash: string | null | undefined, projectDirs: string[]): Promise<MemoryFileInfo> {
    const version = await this.readVersion(module, path, versionId, projectDirs);
    return this.write(module, path, version.content, baseHash, projectDirs, 'restore', { allowBackedUp: true });
  }
}
