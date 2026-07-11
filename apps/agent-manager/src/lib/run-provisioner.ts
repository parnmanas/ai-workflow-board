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
// Unlike environment-provisioner.ts (board environment_config, fingerprint-marker
// idempotent → skips work on a repeat dispatch), a run must pull on EVERY reuse
// dispatch so a warm run picks up new commits. Hence no marker here — the cost is
// one fetch+ff-pull per run, which is the whole point.

import { promises as fsp } from 'node:fs';
import { join, dirname, resolve, sep } from 'node:path';
import { execFile } from 'node:child_process';
import { AGENT_MANAGER_HOME } from './constants.js';
import { log } from './logging.js';

export type RunCheckoutMode = 'reuse' | 'fresh';

/** A repo to clone for the run — the server resolves repo_ref → concrete url. */
export interface RunRepoSpec {
  url: string;
  branch?: string;
}

/** Wire shape of the `run_provision` hint (mirror of the server's RunProvision —
 *  agent-manager is a separate package and only consumes the wire shape, same
 *  pattern as ResolvedEnvironmentConfig / HarnessSpec). */
export interface RunProvision {
  kind: 'qa' | 'security';
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

/**
 * Defensively parse a wire `run_provision` value into a RunProvision (or null
 * when absent/malformed — an ordinary chat turn carries no such field). Mirrors
 * the env-config parser pattern: never throws, drops anything it can't validate.
 */
export function parseRunProvision(raw: unknown): RunProvision | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const kind = o.kind === 'security' ? 'security' : o.kind === 'qa' ? 'qa' : null;
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
        // No clone source — just ensure the folder exists; the rendered prompt
        // still tells the agent what to do inside it.
        await fsp.mkdir(dir, { recursive: true });
        steps.push(`ensure folder ${rel} (no repo to clone) → ok`);
        log(`[run-provision] ${p.kind} run=${p.run_id.slice(0, 8)} folder ready (no repo): ${dir}`);
        return { ok: true, dir, steps, notes };
      }

      const haveClone = p.checkout_mode === 'reuse' && (await pathExists(gitDir));
      if (haveClone) {
        // Proactively clear a stale index.lock a prior crashed run may have left,
        // so the first index-writing op below doesn't trip over a crash remnant.
        await recoverStaleIndexLock(gitDir, steps, notes);
        // Existing clone — update non-destructively: fetch, then ff-only pull.
        // Each index-writing op self-recovers a stale index.lock and retries once.
        const fetched = await gitWithLockRecovery(['-C', dir, 'fetch', '--all', '--prune'], gitDir, steps, notes);
        steps.push(`fetch ${rel} → ${fetched.ok ? 'ok' : `FAIL: ${tail(fetched.stderr)}`}`);
        if (!fetched.ok) throw new Error(`git fetch failed for ${rel}: ${tail(fetched.stderr)}`);
        if (p.repo.branch) {
          const co = await gitWithLockRecovery(['-C', dir, 'checkout', p.repo.branch], gitDir, steps, notes);
          steps.push(`checkout ${p.repo.branch} → ${co.ok ? 'ok' : `FAIL: ${tail(co.stderr)}`}`);
          if (!co.ok) throw new Error(`git checkout ${p.repo.branch} failed in ${rel}: ${tail(co.stderr)}`);
        }
        // ff-only so a diverged local tree stays usable rather than getting clobbered.
        const pulled = await gitWithLockRecovery(['-C', dir, 'pull', '--ff-only'], gitDir, steps, notes);
        steps.push(`pull --ff-only ${rel} → ${pulled.ok ? 'ok' : `non-ff (left as-is): ${tail(pulled.stderr)}`}`);
      } else {
        // Clone — folder is absent (reuse first run), was just wiped (fresh), or
        // exists without a .git. In the last case the leftover would make clone
        // fail, so clear it first.
        if (p.checkout_mode === 'reuse' && (await pathExists(dir))) {
          await fsp.rm(dir, { recursive: true, force: true });
          steps.push(`clear non-git ${rel} before clone → ok`);
        }
        await fsp.mkdir(dirname(dir), { recursive: true });
        const args = ['clone'];
        if (p.repo.branch) args.push('--branch', p.repo.branch);
        args.push(p.repo.url, dir);
        log(`[run-provision] ${p.kind} run=${p.run_id.slice(0, 8)} clone ${p.repo.url} → ${dir}`);
        const cloned = await git(args, RUN_GIT_TIMEOUT_MS);
        steps.push(`clone ${p.repo.url} → ${rel} ${cloned.ok ? 'ok' : `FAIL: ${tail(cloned.stderr)}`}`);
        if (!cloned.ok) throw new Error(`git clone failed for ${p.repo.url}: ${tail(cloned.stderr)}`);
      }

      log(`[run-provision] ${p.kind} run=${p.run_id.slice(0, 8)} ready: ${dir}`);
      return { ok: true, dir, steps, notes };
    } catch (err: any) {
      const error = String(err?.message ?? err);
      log(`[run-provision] ${p.kind} run=${p.run_id.slice(0, 8)} FAILED: ${error}`);
      return { ok: false, dir, steps, notes, error };
    }
  });
}
