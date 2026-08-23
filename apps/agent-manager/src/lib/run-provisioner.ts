// QA/security run-workspace provisioner (ticket 25db3cc6 — 작업폴더 옵션화 4/5).
//
// Runs JUST BEFORE a QA/security run subagent is spawned, driven by the
// `run_provision` hint the server ships on the run-dispatch chat_room_message.
// It guarantees the working folder is checked out so the run never improvises a
// folder of its own (the GameClient re-clone problem):
//   - `reuse`: fetch + ff-only pull when the clone already exists, else clone.
//   - `fresh`: wipe the folder, then clone.
//   - no repo: just ensure the folder exists (the rendered prompt drives the rest).
//
// worktree 규약 ③: the folder is rooted at the agent's WORKING_DIR — a run folder
// is `<working_dir>/.awb/qa/<id8>`, symmetric with the worktree manager's
// `<working_dir>/.awb/wt/<slug>` root (규약 ②). The server ships the
// working_dir-relative `workspace_folder` (`.awb/qa/<id8>`) and the caller passes
// the agent's working_dir as `baseWorkingDir`; this provisioner joins them and
// returns the absolute path so the caller can pin it as the subagent cwd —
// matching exactly the path ticket (3) renders into the run prompt. When no
// working_dir is available it falls back to AGENT_MANAGER_HOME (the pre-규약-③
// root) so a run dispatched without a resolved agent context still gets a folder.
//
// Responsibility boundary (agreed with ticket 3): this provisioner does SOURCE
// SYNC only (checkout). Build/test stays the agent's job, kept in the prompt.
//
// A run must pull on EVERY reuse
// dispatch so a warm run picks up new commits. Hence no marker here — the cost is
// one fetch+ff-pull per run, which is the whole point.

import { promises as fsp } from 'node:fs';
import { join, dirname, resolve, relative, sep } from 'node:path';
import { execFile } from 'node:child_process';
import { AGENT_MANAGER_HOME } from './constants.js';
import { log } from './logging.js';
import { recordRunWorkspaceLeaf } from './run-workspace-manifest.js';
import {
  authenticatedCloneUrl,
  installRepoCredential,
  scrubOriginUrl,
  maskCredential,
  type RepoCredential,
} from './repo-credential.js';

export type RunCheckoutMode = 'reuse' | 'fresh';

/** A repo to clone for the run — the server resolves repo_ref → concrete url. */
export interface RunRepoSpec {
  url: string;
  branch?: string;
  /**
   * https 인증 자격(선택). worktree 경로의 `bootstrapRepo.credential` 과 동일한 wire
   * 형태 — 서버가 Resource 토큰을 복호화해 `run_provision.repo.credential` 로
   * 실어보내면 clone/fetch/pull 이 공유 헬퍼(repo-credential)를 통해 인증된다.
   * 없으면(현재 서버 동작) 무인증 clone 이라 기존과 100% 동일하고, private repo
   * 커버는 서버측 wiring(후속 티켓)이 이 필드를 채우는 순간 구조적으로 활성화된다.
   */
  credential?: RepoCredential | null;
}

/** 서버가 프로비저닝하는 모든 종류의 run/dispatch 작업폴더(ticket 9fd27487가
 *  원래 'qa'|'security' 두 가지였던 것을 확장했다). 'chat'은 one-shot run이
 *  아니다 — 순수 채팅방에는 complete_*_run 생명주기가 없으므로 — 호출자는
 *  run-completion / orphan-sweep 관련 바인딩을 반드시 `kind !== 'chat'`으로
 *  걸러야 한다(event-dispatcher의 handleChatRoomMessage 참고). 'orchestration'
 *  (ticket 2dc3c62f, Mission step 디스패치)은 'chat'과 같은 이유로 걸러야
 *  한다 — 하지만 다른 이유에서다: report_orchestration_step 은 run_id/
 *  workspace_id 가 아니라 step_id 로 완료 처리하는 다른 모양의 계약이라
 *  qa/security/action 이 공유하는 `resolveRunCompletionRoute` 에 억지로
 *  맞추지 않는다 — 대신 미션의 기존 `step_timeout_minutes` reaper 가 프로비저닝
 *  실패/스폰 실패로 응답 없는 step 을 회수한다(event-dispatcher 의
 *  `kind !== 'chat' && kind !== 'orchestration'` 가드 참고). */
export type RunProvisionKind = 'qa' | 'security' | 'action' | 'chat' | 'orchestration';

/** kind별 one-shot run의 MCP 완료-도구(completion-tool) 계약(ticket 9fd27487 —
 *  ticket 89716f04의 orphan-sweep 라우팅을 확장한 것으로, 그 전엔 qa|security만
 *  다루는 삼항연산자라 'action'을 조용히 complete_security_run으로 잘못
 *  라우팅하고 있었다). run을 종료 처리해야 하는 모든 호출자가 kind별로 도구
 *  이름/상태 enum을 다시 유도할 필요 없이 공유해서 쓴다: chat-session-manager /
 *  subagent-manager의 orphan-sweep, 그리고 event-dispatcher의 spawn 이전
 *  프로비저닝-실패 중단(abort) 처리. 'chat'에는 항목이 없다 — 순수 채팅방에는
 *  complete_*_run 생명주기가 없으므로, 호출자는 이걸 호출하기 전에 반드시
 *  걸러내야 한다(RunSessionBinding의 타입 자체가 구조적으로 이미 chat을
 *  제외한다). */
export interface RunCompletionRoute {
  /** reap 하거나 최종 종료(finalize) 처리하기 전에 현재 상태를 읽어올 MCP
   *  도구이며, 존재하지 않으면 null이다. 'action'에는 get_action_run 도구가
   *  없다 — 호출자는 항상 종료 처리 쪽으로 폴백하며, complete_action_run의
   *  terminal 전이는 멱등(idempotent)이라(actions.service.ts의 completeRun
   *  참고) 이 폴백은 안전하다. */
  getTool: 'get_qa_run' | 'get_security_run' | null;
  completeTool: 'complete_qa_run' | 'complete_security_run' | 'complete_action_run';
  /** 이 completeTool의 스키마가 받아들이는 실패 상태값. QA/security는 'error'를
   *  받지만, complete_action_run의 스키마는 'succeeded'|'failed'만 허용한다
   *  (action-tools.ts 참고). */
  failureStatus: 'error' | 'failed';
}

export function resolveRunCompletionRoute(kind: 'qa' | 'security' | 'action'): RunCompletionRoute {
  if (kind === 'action') return { getTool: null, completeTool: 'complete_action_run', failureStatus: 'failed' };
  if (kind === 'security') return { getTool: 'get_security_run', completeTool: 'complete_security_run', failureStatus: 'error' };
  return { getTool: 'get_qa_run', completeTool: 'complete_qa_run', failureStatus: 'error' };
}

/** Wire shape of the `run_provision` hint (mirror of the server's RunProvision —
 *  agent-manager is a separate package and only consumes the wire shape, same
 *  pattern as ResolvedEnvironmentConfig / HarnessSpec). */
export interface RunProvision {
  kind: RunProvisionKind;
  run_id: string;
  workspace_id: string;
  workspace_folder: string;
  checkout_mode: RunCheckoutMode;
  repo: RunRepoSpec | null;
}

export interface RunProvisionResult {
  ok: boolean;
  /** Absolute prepared folder (subagent cwd). Set even on failure for logging. */
  dir: string;
  /** Human-readable log of each step (surfaced in the failure room message). */
  steps: string[];
  /**
   * Noteworthy NON-FATAL provisioning events — a stale `.git/index.lock` that was
   * auto-recovered, or a serialized wait behind a concurrent same-folder
   * provisioning. A surfaced SUBSET of `steps`: the dispatcher posts these to the
   * run room even on success so a conflict/recovery is never silently swallowed
   * (ticket 6254fb4e req 3). Empty/undefined on an uneventful provisioning.
   */
  notes?: string[];
  error?: string;
}

// Generous timeout — a cold clone of a large repo (GameClient) is exactly the
// case this feature exists for. Source sync only; builds are not run here.
const RUN_GIT_TIMEOUT_MS = 20 * 60 * 1000;

interface ExecResult {
  ok: boolean;
  code: number | null;
  stdout: string;
  stderr: string;
}

function git(args: string[], timeoutMs: number): Promise<ExecResult> {
  return new Promise((resolve) => {
    execFile(
      'git',
      args,
      { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        resolve({
          ok: !err,
          code: (err as any)?.code ?? 0,
          stdout: (stdout ?? '').toString(),
          stderr: (stderr ?? (err as any)?.message ?? '').toString(),
        });
      },
    );
  });
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

function tail(s: string, n = 1500): string {
  const t = (s || '').trim();
  return t.length > n ? `…${t.slice(-n)}` : t;
}

/** Defensively parse a wire `repo.credential` → RepoCredential (or null when
 *  absent/malformed). Mirrors worktree's `{ username?, token }` shape; drops
 *  anything without a non-empty string token. Never throws. */
function parseRepoCredential(raw: unknown): RepoCredential | null {
  if (!raw || typeof raw !== 'object') return null;
  const c = raw as Record<string, unknown>;
  if (typeof c.token !== 'string' || !c.token.trim()) return null;
  const cred: RepoCredential = { token: c.token };
  if (typeof c.username === 'string' && c.username.trim()) cred.username = c.username;
  return cred;
}

/**
 * Defensively parse a wire `run_provision` value into a RunProvision (or null
 * when absent/malformed — an ordinary chat turn carries no such field). Mirrors
 * the env-config parser pattern: never throws, drops anything it can't validate.
 */
const RUN_PROVISION_KINDS: RunProvisionKind[] = ['qa', 'security', 'action', 'chat', 'orchestration'];

export function parseRunProvision(raw: unknown): RunProvision | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const kind = RUN_PROVISION_KINDS.includes(o.kind as RunProvisionKind) ? (o.kind as RunProvisionKind) : null;
  const run_id = typeof o.run_id === 'string' ? o.run_id : '';
  const workspace_id = typeof o.workspace_id === 'string' ? o.workspace_id : '';
  const folderRaw = typeof o.workspace_folder === 'string' ? o.workspace_folder : '';
  if (!kind || !run_id || !workspace_id || !folderRaw) return null;
  const checkout_mode: RunCheckoutMode = o.checkout_mode === 'fresh' ? 'fresh' : 'reuse';

  let repo: RunRepoSpec | null = null;
  const r = o.repo as Record<string, unknown> | null | undefined;
  if (r && typeof r === 'object' && typeof r.url === 'string' && r.url.trim()) {
    repo = { url: r.url.trim() };
    if (typeof r.branch === 'string' && r.branch.trim()) repo.branch = r.branch.trim();
    const cred = parseRepoCredential(r.credential);
    if (cred) repo.credential = cred;
  }

  return { kind, run_id, workspace_id, workspace_folder: folderRaw, checkout_mode, repo };
}

/** Drop trailing path separators so `<dir>` and `<dir>/` compare equal. */
function stripTrailingSep(p: string): string {
  return p.replace(/[/\\]+$/, '');
}

export interface RunBaseReconcile {
  /** The working_dir to root the run folder at (규약 ③ base). */
  base: string;
  /** True when the server-registered working_dir differed from the cache. */
  drifted: boolean;
  /** True when the server returned a usable working_dir (i.e. re-validation ran). */
  serverAuthoritative: boolean;
}

/**
 * Reconcile the cached base working_dir (the managed-agent context registry's
 * `cwd`, resolved at dispatch time) against the server-authoritative working_dir
 * fetched fresh for the same agent. The cache can drift from the server record —
 * e.g. a `set_working_dir` command that updated the heartbeat registry but not the
 * hot-path context cache, or a working_dir changed on the server since the last
 * spawn_agent — and applying 규약 ③ to a stale base silently checks the run out at
 * the WRONG path (the GameClient `D:\Repository\...` vs `D:\AWBAgents\GameClient`
 * divergence this ticket exists for).
 *
 * When the server reports a non-empty working_dir that differs from the cache,
 * prefer the SERVER value (authoritative) and flag `drifted` so the caller can heal
 * the cache + warn. A missing/empty server value (fetch failed, record gone) is
 * availability-first: keep the cached base rather than block the run on a transient
 * server hiccup. Pure + side-effect free so the dispatch path can unit-test it.
 */
export function reconcileRunBaseWorkingDir(
  cachedCwd: string,
  serverWorkingDir: string | null | undefined,
): RunBaseReconcile {
  const cached = (cachedCwd || '').trim();
  const server = (serverWorkingDir || '').trim();
  if (server && stripTrailingSep(server) !== stripTrailingSep(cached)) {
    return { base: server, drifted: true, serverAuthoritative: true };
  }
  return { base: cached, drifted: false, serverAuthoritative: !!server };
}

// ── Provisioning serialization + stale-lock recovery (ticket 6254fb4e) ─────────
//
// A QA/security run folder is scenario-keyed (`.awb/qa/<scenario>`), NOT run-keyed,
// so two runs of the SAME scenario resolve to the SAME folder. event-stream
// dispatches chat_room_message events fire-and-forget, so two provisionRunWorkspace
// calls for that folder can be in-flight AT ONCE inside one manager process — and
// their concurrent `git fetch`/`checkout`/`pull` race on git's own `.git/index.lock`.
// The later one dies with "Unable to create '.../index.lock': File exists" before
// its driver ever starts; that run finalizes as `error` and auto-files a phantom
// failure ticket (the reported crash). Serialize provisioning PER FOLDER so the
// later run WAITS for the earlier one's git ops to finish instead of racing them.
// Different scenarios (different folders) still provision in parallel. Mirrors the
// chained-promise mutex in WorktreeManager.#withPoolLock.
const provisionLocks = new Map<string, Promise<void>>();

async function withFolderLock<T>(
  key: string,
  fn: (wasBusy: boolean) => Promise<T>,
): Promise<T> {
  const prev = provisionLocks.get(key);
  const wasBusy = prev !== undefined; // someone was already provisioning this folder
  let release!: () => void;
  const mine = new Promise<void>((r) => (release = r));
  const composed = (prev ?? Promise.resolve()).then(() => mine);
  provisionLocks.set(key, composed);
  if (prev) await prev.catch(() => {});
  try {
    return await fn(wasBusy);
  } finally {
    release();
    // Drop the entry once the chain drains so a LATER, non-concurrent run sees the
    // folder as free (wasBusy=false → warm reuse, no spurious "waited" note). A
    // waiter that chained after us replaced the map value, so only delete our own.
    if (provisionLocks.get(key) === composed) provisionLocks.delete(key);
  }
}

// A stale `.git/index.lock` blocks every index-writing git op (checkout, pull)
// with "Unable to create '.../index.lock': File exists". git leaves it behind when
// a git process is killed mid-write — a run subagent hard-killed, a crashed/oom'd
// manager. Left in place it PERMANENTLY blocks every future run of the scenario
// (the "다음 run 이 영구 차단" failure this ticket fixes). We reclaim it, but guard
// against yanking a lock a genuinely-live git just created: git's index.lock
// carries NO pid, so — combined with our per-folder mutex guaranteeing no
// concurrent provisioning of OURS holds it — a lock is treated as stale when it is
// either older than STALE_INDEX_LOCK_MS or is actively blocking a git op we just
// ran (blocking=true → reclaimed regardless of age, since retrying is the only way
// forward). Cross-process sharing of one `.awb/qa/<scenario>` by two managers is an
// unusual setup; the age guard is the best-effort liveness proxy for it.
const STALE_INDEX_LOCK_MS = 10_000;

async function recoverStaleIndexLock(
  gitDir: string,
  steps: string[],
  notes: string[],
  opts: { blocking?: boolean } = {},
): Promise<boolean> {
  const lockPath = join(gitDir, 'index.lock');
  let st;
  try {
    st = await fsp.stat(lockPath);
  } catch {
    return false; // no lock present — nothing to recover
  }
  const ageMs = Date.now() - st.mtimeMs;
  const stale = !!opts.blocking || ageMs >= STALE_INDEX_LOCK_MS;
  if (!stale) {
    // Fresh and not (yet) blocking us: a live git may hold it. Don't reclaim — the
    // serialized git op will either succeed or fail-then-reclaim reactively.
    steps.push(`index.lock present but fresh (${Math.round(ageMs)}ms) — not reclaiming yet`);
    return false;
  }
  try {
    await fsp.rm(lockPath, { force: true });
    const msg =
      `stale .git/index.lock 자동 복구(제거 후 진행) — age ${Math.round(ageMs / 1000)}s` +
      `${opts.blocking ? ', git op 을 차단 중이었음' : ''}`;
    steps.push(msg);
    notes.push(msg);
    log(
      `[run-provision] recovered stale index.lock ${lockPath} ` +
        `(age ${Math.round(ageMs)}ms, blocking=${!!opts.blocking})`,
    );
    return true;
  } catch (err: any) {
    steps.push(`index.lock 제거 실패: ${String(err?.message ?? err)}`);
    return false;
  }
}

/**
 * Run a git op, and if it fails specifically because `.git/index.lock` exists,
 * reclaim the stale lock (see recoverStaleIndexLock) and retry ONCE. Any other
 * failure is returned as-is for the caller's normal error handling.
 */
async function gitWithLockRecovery(
  args: string[],
  gitDir: string,
  steps: string[],
  notes: string[],
): Promise<ExecResult> {
  let res = await git(args, RUN_GIT_TIMEOUT_MS);
  if (!res.ok && /index\.lock/i.test(res.stderr)) {
    const recovered = await recoverStaleIndexLock(gitDir, steps, notes, { blocking: true });
    if (recovered) {
      steps.push('retry git op after stale index.lock recovery');
      res = await git(args, RUN_GIT_TIMEOUT_MS);
    }
  }
  return res;
}

/**
 * worktree 규약 ③ root for a run folder: the agent's working_dir when resolved,
 * else AGENT_MANAGER_HOME (the pre-규약-③ fallback for a run dispatched without a
 * resolved agent context). Shared by `resolveRunFolder` + `provisionRunWorkspace`
 * so both derive the run folder from the exact same rule.
 */
function runFolderRoot(baseWorkingDir: string): string {
  const hasBase = typeof baseWorkingDir === 'string' && !!baseWorkingDir.trim();
  return hasBase ? baseWorkingDir : AGENT_MANAGER_HOME;
}

/**
 * Resolve the ABSOLUTE run working folder for a `run_provision` + base
 * working_dir WITHOUT touching disk. This is both the folder the provisioner
 * checks out (and pins as the subagent cwd) AND the key the dispatcher locks for
 * the run's whole provision→execute lifetime (ticket e9d0e8bc). It must match
 * exactly what `provisionRunWorkspace` computes as its `dir`, so it reuses the
 * same `runFolderRoot` + leading-slash strip. Pure + side-effect free.
 */
export function resolveRunFolder(p: RunProvision, baseWorkingDir: string): string {
  const rel = p.workspace_folder.replace(/^[/\\]+/, '');
  return resolve(join(runFolderRoot(baseWorkingDir), rel));
}

/**
 * idle-GC용 liveness 마커(ticket 9fd27487) — provisionRunWorkspace가 프로비저닝에
 * 성공할 때마다 갱신하며, 그와 더불어 기존 clone의(느릴 수 있는) fetch/pull이
 * 시작되기 직전에도(`haveClone` 재사용 분기) 갱신한다. 그래야 주기적 스윕
 * (worktree-manager의 sweepRunWorkspaces)이, 이미 티켓 생명주기에 묶여
 * 회수되는 게 아니라 폴더가 무기한 재사용되는 kind(action/chat)에 대해
 * "최근에 사용됨"과 "방치됨"을 구분할 수 있다. 이 "이른 시점의 touch"는
 * 마지막 touch 못지않게 중요하다: 느린 fetch로 이제 막 워밍업되려는, 오래
 * idle 상태였던 폴더야말로 정확히 마커가 stale한 그 폴더이고, 스윕은 진행
 * 중인 프로비저닝과 별다른 조율 수단이 없다(withFolderLock은 같은 폴더에
 * 대한 동시 프로비저닝끼리만 서로 직렬화할 뿐, 스윕 타이머에 대해서는 아무
 * 역할도 하지 않는다) — 미리 touch해두면 fetch/pull이 끝난 뒤가 아니라 그
 * 작업 전체 구간 동안 마커가 fresh하게 유지된다. fresh clone 전에는 touch하지
 * 않는다: `git clone`은 비어 있지 않은 대상을 거부하므로, 곧 clone될
 * 디렉터리에 마커 파일을 미리 써두면 clone이 깨진다 — 방금 비워졌거나 아직
 * 존재하지 않는 폴더는 애초에 stale-마커 레이스 케이스가 아니다(그 폴더
 * 자체의 mtime이 최근이라, sweepRunWorkspaces의 마커-없음 폴백이 이미 이를
 * 커버한다). 폴더 자체의 mtime이 아니라 별도의 마커 파일을 쓰는 이유: 재사용
 * 되는 git clone은 fetch/pull을 해도 바깥쪽 디렉터리의 mtime이 갱신되지
 * 않으므로(git은 `.git/` 내부 항목만 건드린다), `dir` 자체의 mtime에
 * 의존하면 warm하게 재사용되는 폴더가 첫 프로비저닝 직후부터 영원히 stale한
 * 것처럼 보이게 된다. Best-effort다 — 마커 쓰기 실패가, 이 프로비저닝이
 * 애초에 풀어주려는 디스패치 자체를 실패시켜서는 절대 안 된다.
 */
async function touchLastUsedMarker(dir: string): Promise<void> {
  try {
    await fsp.writeFile(join(dir, '.awb-last-used'), new Date().toISOString());
  } catch {
    /* best-effort — 실패해도 무시한다 */
  }
}

/**
 * Prepare the run's working folder per its `run_provision`. Never throws — a
 * git failure is captured into `{ ok:false, error, steps }` so the caller can
 * abort the dispatch and surface the reason (the "dispatch 중단 + 코멘트" path).
 */
export async function provisionRunWorkspace(
  p: RunProvision,
  baseWorkingDir: string,
): Promise<RunProvisionResult> {
  const steps: string[] = [];
  const notes: string[] = [];
  // worktree 규약 ③: root the run folder at the agent's working_dir. Fall back to
  // AGENT_MANAGER_HOME when no working_dir was resolved (a degenerate dispatch
  // where the caller could not pin a cwd anyway) so a run still gets a folder.
  const hasBase = typeof baseWorkingDir === 'string' && !!baseWorkingDir.trim();
  const root = runFolderRoot(baseWorkingDir);
  if (!hasBase) {
    // Loud about the silent-misplacement path: the run folder is about to land
    // under the MANAGER HOME, not the agent's working_dir (규약 ③ base absent).
    // This usually means the managed-agent context was not bootstrapped at
    // dispatch time. Surface it in both the log and the returned steps so the
    // failure/room message makes the misplacement visible instead of silent.
    const warn =
      `⚠️ working_dir 미해석 — AGENT_MANAGER_HOME 로 폴백 (${AGENT_MANAGER_HOME}): ` +
      `런 폴더가 agent working_dir 가 아닌 매니저 홈 밑에 생성됩니다 (규약 ③ base 없음)`;
    steps.push(warn);
    log(
      `[run-provision] ⚠️ ${p.kind} run=${p.run_id.slice(0, 8)} NO working_dir resolved — ` +
        `falling back to AGENT_MANAGER_HOME (${AGENT_MANAGER_HOME}); run folder lands under the ` +
        `manager home, NOT the agent working_dir. Managed-agent context likely not bootstrapped ` +
        `at dispatch time.`,
    );
  }
  // workspace_folder is root-relative; strip any leading slash so it can never
  // escape the root (matches the server's normalizeWorkspaceFolder).
  const rel = p.workspace_folder.replace(/^[/\\]+/, '');
  const dir = join(root, rel);
  const gitDir = join(dir, '.git');

  // Record the exact provisioned boundary for 'action'/'chat' (the two kinds
  // worktree-manager's idle-sweep/snapshot walk) — see run-workspace-manifest.ts
  // for why the directory-content heuristic alone cannot see a nested
  // workspace_folder once an ancestor holds a `.git` (ticket 9fd27487, review
  // round 3). Called only after a successful provisioning below.
  const recordManifestLeaf = async (): Promise<void> => {
    if (p.kind !== 'action' && p.kind !== 'chat' && p.kind !== 'orchestration') return;
    const kindDir = p.kind === 'action' ? 'act' : p.kind === 'chat' ? 'chat' : 'orch';
    const kindRoot = join(root, '.awb', kindDir);
    const leaf = relative(kindRoot, resolve(dir)).split(sep).join('/');
    await recordRunWorkspaceLeaf(kindRoot, leaf).catch(() => {});
  };

  // Defense-in-depth path-traversal guard: this provisioner runs `rm -rf` on
  // `dir` for a fresh checkout (and to clear a non-git reuse folder), and it
  // trusts a wire value the server already normalized. Re-assert here that the
  // resolved folder stays STRICTLY under the root (a proper subdir — never the
  // working_dir itself) before any destructive op — a `..` that slipped past the
  // server guard must abort via the standard "dispatch 중단 + 코멘트" path, never
  // wipe outside the sandbox (or the working_dir root).
  const rootResolved = resolve(root);
  const resolvedDir = resolve(dir);
  if (!resolvedDir.startsWith(rootResolved + sep)) {
    const error = `run workspace_folder escapes the working dir (path traversal): ${p.workspace_folder}`;
    log(`[run-provision] ${p.kind} run=${p.run_id.slice(0, 8)} REJECTED: ${error}`);
    return { ok: false, dir: resolvedDir, steps: [`reject ${rel}: path traversal`], notes, error };
  }

  // Serialize provisioning PER FOLDER (keyed by the absolute dir) so two runs of
  // the same scenario never race git on the shared `.git/index.lock`. The later
  // run WAITS here for the earlier one's git ops to finish, then does its own.
  return withFolderLock(resolvedDir, async (wasBusy) => {
    if (wasBusy) {
      const note =
        '같은 작업폴더의 선행 run 프로비저닝 완료까지 직렬화 대기 (.git/index.lock 동시 접근 충돌 방지)';
      steps.push(`serialize: ${note}`);
      notes.push(note);
      log(
        `[run-provision] ${p.kind} run=${p.run_id.slice(0, 8)} serialized behind a concurrent ` +
          `provisioning of the same folder (${rel})`,
      );
    }
    try {
      if (p.checkout_mode === 'fresh') {
        await fsp.rm(dir, { recursive: true, force: true });
        steps.push(`wipe ${rel} → ok`);
      }

      if (!p.repo) {
        // clone할 소스가 없음 — 폴더 존재만 보장한다; 렌더링된 프롬프트가
        // 그 안에서 뭘 해야 하는지는 에이전트에게 여전히 알려준다.
        await fsp.mkdir(dir, { recursive: true });
        await touchLastUsedMarker(dir);
        await recordManifestLeaf();
        steps.push(`ensure folder ${rel} (no repo to clone) → ok`);
        log(`[run-provision] ${p.kind} run=${p.run_id.slice(0, 8)} folder ready (no repo): ${dir}`);
        return { ok: true, dir, steps, notes };
      }

      // 인증이 필요한 private repo 를 위해 clone/fetch/pull 을 공유 repo-credential
      // 헬퍼로 경유시킨다. credential 이 없으면 헬퍼가 전부 no-op → 기존과 동일한
      // 무인증 동작이라, 이 경로는 구조적으로 credential-blind 될 수 없다.
      const cred = p.repo.credential ?? null;
      const mask = (s: string) => tail(maskCredential(s, cred));
      const haveClone = p.checkout_mode === 'reuse' && (await pathExists(gitDir));
      if (haveClone) {
        // idle-GC 레이스 가드(ticket 9fd27487 리뷰 후속조치): 아래의(대형 repo에서는
        // 몇 분씩 걸릴 수 있는) fetch/pull보다 먼저 liveness 마커를 touch한다 —
        // 이 함수가 반환된 다음이 아니라. sweepRunWorkspaces의 기준을 넘겨 idle
        // 상태였던 reuse-모드 폴더는 정확히 여기 도달하는 그 케이스다 — 오래
        // idle이었던 마커에 이제 막 fetch가 시작되려는 상황 — 그리고 주기적
        // 스윕은 자체 타이머로 돌아갈 뿐 이 폴더별 락과는 아무 조율도 하지
        // 않는다(withFolderLock은 같은 폴더에 대한 동시 PROVISION끼리만 서로
        // 직렬화할 뿐, 스윕에 대해서는 아니다). 지금 touch해두면 git 작업이
        // 끝난 뒤뿐 아니라 전체 진행 구간 내내 스윕이 fresh한 마커를 보게
        // 된다. haveClone(fetch/pull) 분기에만 한정한 이유 — 아래의 clone
        // 분기는 EMPTY한(또는 존재하지 않는) 디렉터리를 그대로 `git clone`에
        // 넘기는데, `git clone`은 비어 있지 않은 대상을 거부하므로 마커
        // 파일을 먼저 써버리면 모든 fresh/최초 clone이 깨진다.
        await touchLastUsedMarker(dir);
        // Proactively clear a stale index.lock a prior crashed run may have left,
        // so the first index-writing op below doesn't trip over a crash remnant.
        await recoverStaleIndexLock(gitDir, steps, notes);
        // 기존 clone 에도 Resource credential 을 idempotent 하게 (재)설치 — 토큰
        // 회전이나 이 기능 이전에 만들어진 clone 의 fetch/pull 인증을 보장한다.
        await installRepoCredential(dir, p.repo.url, cred);
        // Existing clone — update non-destructively: fetch, then ff-only pull.
        // Each index-writing op self-recovers a stale index.lock and retries once.
        const fetched = await gitWithLockRecovery(['-C', dir, 'fetch', '--all', '--prune'], gitDir, steps, notes);
        steps.push(`fetch ${rel} → ${fetched.ok ? 'ok' : `FAIL: ${mask(fetched.stderr)}`}`);
        if (!fetched.ok) throw new Error(`git fetch failed for ${rel}: ${mask(fetched.stderr)}`);
        if (p.repo.branch) {
          const co = await gitWithLockRecovery(['-C', dir, 'checkout', p.repo.branch], gitDir, steps, notes);
          steps.push(`checkout ${p.repo.branch} → ${co.ok ? 'ok' : `FAIL: ${mask(co.stderr)}`}`);
          if (!co.ok) throw new Error(`git checkout ${p.repo.branch} failed in ${rel}: ${mask(co.stderr)}`);
        }
        // ff-only so a diverged local tree stays usable rather than getting clobbered.
        const pulled = await gitWithLockRecovery(['-C', dir, 'pull', '--ff-only'], gitDir, steps, notes);
        steps.push(`pull --ff-only ${rel} → ${pulled.ok ? 'ok' : `non-ff (left as-is): ${mask(pulled.stderr)}`}`);
      } else {
        // Clone — folder is absent (reuse first run), was just wiped (fresh), or
        // exists without a .git. In the last case the leftover would make clone
        // fail, so clear it first.
        if (p.checkout_mode === 'reuse' && (await pathExists(dir))) {
          await fsp.rm(dir, { recursive: true, force: true });
          steps.push(`clear non-git ${rel} before clone → ok`);
        }
        await fsp.mkdir(dirname(dir), { recursive: true });
        // 토큰을 URL 에 주입해 clone 하되(로그/steps 에는 항상 clean url 만 노출),
        // clone 직후 origin 을 clean url 로 scrub + credential.helper 설치 → 토큰이
        // `git remote -v`/on-disk 에 남지 않고 이후 fetch/pull 이 인증된다.
        const cloneUrl = authenticatedCloneUrl(p.repo.url, cred);
        const args = ['clone'];
        if (p.repo.branch) args.push('--branch', p.repo.branch);
        args.push(cloneUrl, dir);
        log(`[run-provision] ${p.kind} run=${p.run_id.slice(0, 8)} clone ${p.repo.url} → ${dir}`);
        const cloned = await git(args, RUN_GIT_TIMEOUT_MS);
        steps.push(`clone ${p.repo.url} → ${rel} ${cloned.ok ? 'ok' : `FAIL: ${mask(cloned.stderr)}`}`);
        if (!cloned.ok) throw new Error(`git clone failed for ${p.repo.url}: ${mask(cloned.stderr)}`);
        await scrubOriginUrl(dir, p.repo.url);
        await installRepoCredential(dir, p.repo.url, cred);
      }

      log(`[run-provision] ${p.kind} run=${p.run_id.slice(0, 8)} ready: ${dir}`);
      await touchLastUsedMarker(dir);
      await recordManifestLeaf();
      return { ok: true, dir, steps, notes };
    } catch (err: any) {
      const error = String(err?.message ?? err);
      log(`[run-provision] ${p.kind} run=${p.run_id.slice(0, 8)} FAILED: ${error}`);
      return { ok: false, dir, steps, notes, error };
    }
  });
}
