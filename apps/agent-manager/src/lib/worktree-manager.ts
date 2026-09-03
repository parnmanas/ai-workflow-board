// Per-ticket git worktree isolation, rooted inside the agent's working_dir.
//
// Problem this solves (ticket 9f26f091): a managed agent has ONE working_dir,
// and every (ticket,role) session it runs shares that cwd. The current branch
// is global state of that cwd, so a `git checkout` in one ticket's session
// bleeds into another ticket's session sharing the same agent — commits land
// on the wrong branch when focus flips between tickets (pend/unpend,
// preemption, idle-reap → respawn).
//
// Fix: give each ticket its own dedicated git worktree, checked out from the
// agent's base repo. A branch switch inside one worktree cannot touch another
// worktree's HEAD or working tree, so:
//   - two tickets commit/checkout independent branches concurrently,
//   - a pended ticket's branch + uncommitted changes survive in its own
//     worktree dir while another ticket runs, and resume lands back in it.
//
// The worktree dir is deterministic per ticket, so a fresh spawn after an
// idle-reap reattaches to the SAME worktree (branch + dirty tree intact) — that
// is what makes the focus gain/loss handling fall out for free.
//
// ── worktree 규약 ② (this ticket) ──────────────────────────────────────────
// Where the worktrees live is now FIXED, always inside the agent's working_dir:
//
//     <working_dir>/.awb/wt/<slug>
//
//   - worktree_mode = 'per_ticket' (default) → slug = <ticket8>  (one per ticket)
//   - worktree_mode = 'shared'   → a WARM POOL of slots `shared-0 … shared-<N-1>`
//         (규약 ⑥). N = the board concurrency (max_concurrent_tickets_per_agent,
//         flattened onto the trigger event). A ticket LEASES an idle slot for its
//         whole lifecycle (reattaches across roles / resumes) and RELEASES it
//         (idle-mark only, lazy) at terminal/archive. The NEXT lease RESETS the
//         slot to the base tip before handing it over — `git reset --hard` returns
//         only TRACKED source to the base while UNTRACKED build artifacts (Unity
//         Library/, node_modules, out-of-tree outputs) survive, so the next ticket
//         builds incrementally (warm). Never `git clean -fdx` — that would defeat
//         the whole point. Reset-on-acquire (not on-release) is deliberate: workers
//         die uncleanly (exit-143) all the time, so cleanup can't depend on a tidy
//         handback. Pool size == concurrency and the manager caps concurrent ticket
//         sessions at N (ticket-session-manager), so a lease that clears the gate
//         always finds a free slot — the pool never starves. QA/Security runs use a
//         SEPARATE `.awb/qa/<id8>` clone (run-provisioner), NOT this pool; the
//         "shared" ticket+QA budget is enforced by the server concurrency gate.
//         See #acquireSharedSlot + the on-disk lease registry (.pool-leases.json).
//
// working_dir is storage only. AWB owns repository clones below
// `<working_dir>/.awb/base/<resource>` and worktrees below
// `<working_dir>/.awb/wt/<resource>`, leaving the container root untouched even
// when somebody has placed an unrelated `.git` there. Fallback is
// reserved for missing repository metadata or `git worktree` failures
// (unsupported/old git, disk error).

import { promises as fsp } from 'node:fs';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { log } from './logging.js';
import { readRunWorkspaceLeaves, forgetRunWorkspaceLeaf } from './run-workspace-manifest.js';
import {
  decidePushReadiness,
  classifyWorktreeCheckout,
  isGitAuthFailure,
  type PushReadinessDecision,
  type WorktreeCheckoutDecision,
} from './dispatch-preflight.js';
import {
  cloneWithRepoCredential,
  type CloneWirePolicy,
  installRepoCredential,
  scrubOriginUrl,
  maskCredential,
} from './repo-credential.js';

const GIT_TIMEOUT_MS = 20_000;
// A non-interactive `git ls-remote` auth probe should fail fast (git prompts
// are disabled), so a short timeout is a backstop against a hung askpass — well
// under the git default so a network stall can't wedge a dispatch for long.
const PUSH_PROBE_TIMEOUT_MS = 15_000;
const PROVISION_LOCK_TIMEOUT_MS = 20_000;
const PROVISION_LOCK_STALE_MS = 60_000;
const PROVISION_LOCK_HEARTBEAT_MS = 10_000;

interface ProvisionLockOwner {
  token: string;
  pid: number;
}

/** Board worktree placement mode (mirrors the server's worktree-config enum —
 *  kept as a local literal so agent-manager doesn't depend on the server pkg). */
export type WorktreeMode = 'per_ticket' | 'shared';
export const DEFAULT_WORKTREE_MODE: WorktreeMode = 'per_ticket';

/** Prefix for warm-pool slot dirs in shared mode: `shared-0 … shared-<N-1>`.
 *  The legacy single reused checkout was the literal `shared` — both are treated
 *  as pool members (protected from sweep/terminal removal) by isSharedSlotSeg. */
export const SHARED_SLOT_PREFIX = 'shared-';

/** Warm-pool slot dir name for index i (`shared-0`, `shared-1`, …). */
export function sharedSlotName(i: number): string {
  return `${SHARED_SLOT_PREFIX}${i}`;
}

/** Is this last-path-segment a shared-pool slot (new `shared-<i>` OR the legacy
 *  literal `shared`)? Used so sweep()/removeTicketWorktrees never delete a pool
 *  slot — that would wipe the warm build the pool exists to preserve. */
export function isSharedSlotSeg(seg: string): boolean {
  return seg === 'shared' || seg.startsWith(SHARED_SLOT_PREFIX);
}

/** On-disk warm-pool lease registry (`<working_dir>/.awb/wt/.pool-leases.json`).
 *  Persisted so a manager restart re-reads which ticket owns which slot (resume
 *  reattaches; released slots stay released). Keyed by slot name. */
export interface PoolSlotLease {
  slot: string;
  /** The ticket that currently (active) or last (released) held this slot. */
  ticketId: string;
  /** Role of the last acquire — observability only. */
  role?: string;
  /** true = leased to a ticket that has not reached terminal/archive; false =
   *  released (idle) and awaiting a reset-on-acquire by the next lease. */
  active: boolean;
  leasedAt: string;
  releasedAt?: string;
  /** The slot's checked-out branch captured AT RELEASE — the next acquire deletes
   *  it (`git branch -D`) so stale `ticket/<id>` refs don't accumulate. */
  branch?: string | null;
}

export interface PoolRegistry {
  version: number;
  slots: Record<string, PoolSlotLease>;
}

export interface TerminalTicketCleanupReport {
  removedWorktrees: number;
  removedLocalBranches: string[];
  removedRemoteBranches: string[];
  remainingBranches: string[];
  heldReasons: string[];
}

/**
 * Freshness grace for crash-reclaim: a lease whose `leasedAt` is within this
 * window is NEVER reclaimed, even if no live session/`/proc` owner is visible
 * yet. A slot's lease is written durably (`active=true`) at acquire time, but
 * the worker only becomes visible to the live-session snapshot much later —
 * dispatch first runs environment provisioning (a cold clone of a large repo
 * can take many minutes — see run-provisioner's 20-min git timeout), then
 * fetches ticket context, then spawns the child, which registers in `_sessions`
 * only at the END of spawn. During that whole [lease → child registered] gap the
 * ticket is in neither snapshot and has no `/proc` cwd in the slot yet, so a
 * reconcile tick would otherwise false-reclaim a live-but-still-dispatching
 * worker (the exact failure the ticket forbids — cf. the force_respawn
 * death-loop lesson). The grace covers that provision+spawn upper bound.
 *
 * This does NOT delay the common leak this feature targets: a worker that dies
 * mid-work (exit-143 hours into a build) leased its slot long ago, so its
 * `leasedAt` is already well past the grace and it is reclaimed on the next
 * tick regardless. Only a worker that dies *inside* the dispatch window has its
 * reclaim deferred — by at most one extra tick, which is harmless.
 */
const POOL_LEASE_RECLAIM_GRACE_MS = 20 * 60 * 1000;

/**
 * Action-Run/채팅방 작업폴더 회수를 위한 idle 임계값(ticket 9fd27487,
 * `sweepRunWorkspaces`). 티켓-워크트리 스윕의 "지금 당장 idle"이라는 기준보다
 * 의도적으로 훨씬 길게 잡았다: `.awb/act`/`.awb/chat` 폴더는 동일한 action/room에
 * 대한 여러 run/메시지에 걸쳐(run-keyed가 아니라 action-keyed / room-keyed) 워밍업된
 * 체크아웃을 유지하기 위해 존재하므로, idle tick마다 회수해버리면 바로 다음 사용
 * 시점에 재-clone 또는 재-프로비저닝을 강제하게 된다 — 이는 정확히 ticket
 * 9fd27487의 `.awb/act` 설계가 피하려 했던 "warm 재사용 비용"이다.
 * 7일이면 정상적인 간헐적 사용 간격(주 몇 번 방문하는 채팅방, 야간/주간 cron
 * Action)은 여유 있게 넘기면서도, 티켓이 지적한 무한 증식 실패 모드는 여전히
 * 억제한다 — 진짜로 방치된 채팅방은 "영원히 회수 안 됨"이 아니라 일주일 안에
 * 결국 회수되는 쪽으로 수렴한다.
 */
const RUN_WORKSPACE_IDLE_MS = 7 * 24 * 60 * 60 * 1000;

function nowIso(): string {
  return new Date().toISOString();
}

/** Fixed worktree root for an agent working_dir: `<working_dir>/.awb/wt`.
 *  Every worktree this manager creates lives directly under it. Exported so the
 *  event-dispatcher (and ticket ④'s prompt injection) can reference the same
 *  root without re-deriving it. */
export function worktreesRootFor(baseWorkingDir: string): string {
  return join(baseWorkingDir, '.awb', 'wt');
}

/** Fixed QA/Security run-workspace root for an agent working_dir:
 *  `<working_dir>/.awb/qa` — mirrors the server's `RUN_WORKSPACE_ROOT` ('.awb/qa',
 *  worktree 규약 ③). Exported so the archive-reclamation path (규약 ⑤) can target
 *  `<root>/<ticket8>` without re-deriving the segment layout. */
export function runWorkspaceRootFor(baseWorkingDir: string): string {
  return join(baseWorkingDir, '.awb', 'qa');
}

/** Action-Run 작업폴더의 고정 루트(ticket 9fd27487): `<working_dir>/.awb/act`
 *  — 서버의 `ACTION_WORKSPACE_ROOT`와 대응된다. `.awb/qa`처럼 run-keyed가 아니라
 *  action-keyed라, 같은 Action의 모든 Run이 폴더 하나를 재사용한다. */
export function actionWorkspaceRootFor(baseWorkingDir: string): string {
  return join(baseWorkingDir, '.awb', 'act');
}

/** 순수 채팅방(plain chat room) 작업폴더의 고정 루트(ticket 9fd27487):
 *  `<working_dir>/.awb/chat` — 서버의 `CHAT_WORKSPACE_ROOT`와 대응된다.
 *  room-keyed이며, qa/action과 달리 이 폴더들은 기본적으로 repo 체크아웃을
 *  전혀 받지 않는다(run-provisioner 참고 — 채팅용 RunProvision은 항상
 *  `repo: null`을 실어보낸다). 그래서 이 폴더들은 항상 비어 있는, 에이전트가
 *  만든 스크래치 폴더로만 남는다. */
export function chatWorkspaceRootFor(baseWorkingDir: string): string {
  return join(baseWorkingDir, '.awb', 'chat');
}

/** Orchestration Mission-Step 작업폴더의 고정 루트(ticket 2dc3c62f):
 *  `<working_dir>/.awb/orch` — 서버의 `ORCHESTRATION_WORKSPACE_ROOT`와
 *  대응된다. mission-keyed 루트 아래 step_key별 leaf로 격리된다
 *  (orchestration-runner.service.ts의 dispatchStep 참고). */
export function orchestrationWorkspaceRootFor(baseWorkingDir: string): string {
  return join(baseWorkingDir, '.awb', 'orch');
}

interface GitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

/** Thin promisified `git -C <cwd> <args...>`. Never throws — failures come
 *  back as { ok:false }. We avoid util.promisify(execFile) so a non-zero git
 *  exit (expected for "is this a repo?" probes) doesn't reject. */
function git(cwd: string, args: string[], timeoutMs = GIT_TIMEOUT_MS): Promise<GitResult> {
  return new Promise((resolve) => {
    execFile(
      'git',
      ['-C', cwd, ...args],
      { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        resolve({
          ok: !err,
          stdout: (stdout ?? '').toString(),
          stderr: (stderr ?? (err as any)?.message ?? '').toString(),
        });
      },
    );
  });
}

export interface WorktreeInfo {
  path: string;
  head: string | null;
  branch: string | null; // refs/heads/<x> stripped to <x>; null when detached
  detached: boolean;
}

/** Lease state of a worktree for the observability snapshot.
 *  - allocated: a live worker owns it (or a shared slot leased inside its
 *    dispatch grace window — assumed in-flight, not a leak).
 *  - idle: released / never-leased (shared warm slot) or a per_ticket dir with
 *    no live session.
 *  - orphaned: a shared slot with an ACTIVE lease but no live owner AND past the
 *    reclaim grace — the exact leak reconcilePoolLeases will reclaim. Surfaced so
 *    an operator can spot a stuck lease by eye. */
export type WorktreeState = 'allocated' | 'idle' | 'orphaned';

/** Read-only observability view of one worktree under `<working_dir>/.awb/wt/`,
 *  joined to the pool lease registry. Produced by snapshotWorktrees() for the
 *  instance heartbeat so the admin UI can render "slot → current task". This is
 *  a pure projection — no mutation path consumes it. */
export interface WorktreeSnapshotEntry {
  /** Absolute worktree path (`<working_dir>/.awb/wt/<slot>`). */
  path: string;
  /** Last path segment: `shared-<i>` (shared pool slot) or `<ticket8>` (per_ticket). */
  slot: string;
  mode: WorktreeMode;
  /** Full ticket uuid when known (shared active lease from the registry, or a
   *  live per_ticket dir matched by prefix); null for an idle shared slot and an
   *  idle per_ticket dir (only the 8-char slug is locally known). */
  ticketId: string | null;
  /** Current branch (from `git worktree list --porcelain`); null when detached /
   *  sitting at the base HEAD. */
  branch: string | null;
  state: WorktreeState;
  /** True when a live worker session / subagent currently holds this worktree's ticket. */
  live: boolean;
}

/** `<working_dir>/.awb/act/` 또는 `<working_dir>/.awb/chat/` 아래에 있는
 *  Action-Run 또는 채팅방 작업폴더 하나에 대한 읽기 전용 관전(observability) 뷰
 *  (ticket 9fd27487). WorktreeSnapshotEntry와 달리 이것들은 git 워크트리가 아니라
 *  일반 디렉터리다(`git worktree list` 항목도, 브랜치도, 풀 lease도 없다) —
 *  티켓-워크트리 형태를 억지로 끼워 맞춘 변형이 아니라, 별개의 병렬 projection이다.
 *  인스턴스 heartbeat를 위해 snapshotRunWorkspaces()가 생성한다. */
export interface RunWorkspaceSnapshotEntry {
  /** 절대경로(`<working_dir>/.awb/act/<leaf>`, `.../.awb/chat/<leaf>`, 또는 `.../.awb/orch/<leaf>`). */
  path: string;
  kind: 'action' | 'chat' | 'orchestration';
  /** root(`.awb/act` 또는 `.awb/chat`) 기준 상대경로 — action/room id의 앞 8자리
   *  단일 세그먼트가 기본값이지만, 커스텀 `workspace_folder`가 `deploy/scripts`처럼
   *  중첩 경로면(기존 QA/security workspace_folder 옵션이 이미 허용하던 값) 그
   *  전체 상대경로가 그대로 leaf가 된다 — 마지막 세그먼트만 잘라내면 `path`가
   *  `join(root, leaf)`로 재구성되지 않는다(리뷰 지적, ticket 9fd27487). */
  leaf: string;
  /** provisionRunWorkspace() 호출이 성공할 때마다 갱신되는 `.awb-last-used`
   *  마커의 타임스탬프. 폴더가 이 마커 도입 이전부터 있었다면 null(이 경우도
   *  보수적으로 스윕 대상에 포함된다 — sweepRunWorkspaces 참고). */
  lastUsedAt: string | null;
  /** 살아있는 프로세스의 cwd가 현재 이 폴더 안에 있으면 true(`/proc` 교차 확인) —
   *  마커가 아무리 오래됐어도 이 경우엔 절대 회수하지 않는다. */
  live: boolean;
}

export interface ResolveCwdArgs {
  /** The agent's base repo working_dir (the shared cwd). */
  baseWorkingDir: string;
  ticketId: string;
  /** Kept for logging/observability; no longer part of the worktree path (a
   *  ticket gets ONE worktree that every role of it reuses). */
  role: string;
  /** Board worktree_mode (worktree 규약 ①/②). Defaults to 'per_ticket'. */
  mode?: WorktreeMode;
  /** Warm-pool size for shared mode (규약 ⑥) = the board concurrency
   *  (max_concurrent_tickets_per_agent), flattened onto the trigger event.
   *  Ignored in per_ticket mode. Absent / ≤0 → 1 (a single reused slot, i.e. the
   *  pre-pool behavior). */
  poolSize?: number;
  /** Repository cloned under the working_dir storage container before creating
   *  the ticket worktree. Dispatch resolves this as ticket repo first, then the board
   *  environment's first repository. */
  bootstrapRepo?: {
    resourceId?: string;
    url: string;
    branch?: string;
    credential?: { username?: string; token: string } | null;
    /** 서버가 Repo Resource ⊕ Workspace 기본값으로 해석해 agent_trigger 에 실어보낸
     *  clone 정책(ticket bddb63ee). 없으면 repo-credential 의 시스템 기본값
     *  (60분 wall-clock / idle 비활성 / 전체 clone)이 적용된다. */
    clonePolicy?: CloneWirePolicy | null;
  } | null;
}

export interface ResolveCwdResult {
  /** cwd the child should spawn under — the prepared repository worktree. */
  cwd: string;
  /** true when cwd is a dedicated worktree, false when it fell back to base. */
  isWorktree: boolean;
  /** true when an existing worktree was reattached (vs freshly created). */
  reused?: boolean;
  /** populated on fallback so callers can log why isolation was skipped. */
  reason?: string;
  detail?: string;
  /** the worktree checkout root; undefined on fallback. */
  worktreePath?: string;
  /** Reserved relative work subpath; currently always empty. */
  workSubpath?: string;
  /** the effective mode used to pick the slug. */
  mode?: WorktreeMode;
  /** 에이전트 프롬프트에 그대로 전달할 확정된 Git 상태. 비밀은 포함하지 않는다. */
  repositoryContext?: TicketRepositoryContext;
}

export interface TicketRepositoryContext {
  resourceId: string;
  cwd: string;
  baseBranch: string;
  baseSha: string;
  currentSha?: string;
  workingBranch: string | null;
  dirty: boolean;
  ahead: number;
  behind: number;
  resumed: boolean;
  remoteUrl?: string;
  defaultBranch?: string;
  fetchedSha?: string;
  currentShaFailure?: string;
  credentialAvailable?: boolean | null;
  credentialFailure?: string | null;
}

/** Map a ticket + mode to the worktree dir's last path segment.
 *  per_ticket → the ticket uuid's first 8 chars (unique enough per agent);
 *  shared     → the literal 'shared' (one reused checkout for every ticket). */
export function worktreeSlug(ticketId: string, mode: WorktreeMode = DEFAULT_WORKTREE_MODE): string {
  if (mode === 'shared') return 'shared';
  const t = String(ticketId || '').slice(0, 8).replace(/[^A-Za-z0-9._-]/g, '_');
  return t || 'ticket';
}

export class WorktreeManager {
  #provisionLockTimeoutMs: number;
  #provisionLockStaleMs: number;
  #provisionLockHeartbeatMs: number;
  /** Per-worktree-root serialization for warm-pool acquire/release so two
   *  concurrent triggers can't lease the same idle slot (규약 ⑥). Keyed by the
   *  normalized worktrees root; one chained promise per key. */
  #poolLocks = new Map<string, Promise<unknown>>();
  /** Serialize git worktree registration changes per base repo. The lock is
   *  held only while provisioning a per-ticket checkout; workers run outside
   *  it, so different tickets remain fully concurrent after their cwd exists. */
  #provisionLocks = new Map<string, Promise<unknown>>();
  /** Serialize first-clone attempts for agents sharing one working_dir. */
  #bootstrapLocks = new Map<string, Promise<{ repo: string | null; reason?: string; detail?: string }>>();
  /** OS 셸 래퍼 없이 오류·경쟁 조건을 재현하기 위한 플랫폼 중립 테스트 seam. */
  #terminalCleanupHooks: {
    removeWorktree?: (repo: string, worktreePath: string) => Promise<boolean> | boolean;
    beforeRemoteDelete?: (branch: string) => Promise<void> | void;
  };

  constructor(opts: {
    provisionLockTimeoutMs?: number;
    provisionLockStaleMs?: number;
    provisionLockHeartbeatMs?: number;
    terminalCleanupHooks?: {
      removeWorktree?: (repo: string, worktreePath: string) => Promise<boolean> | boolean;
      beforeRemoteDelete?: (branch: string) => Promise<void> | void;
    };
  } = {}) {
    this.#provisionLockTimeoutMs = opts.provisionLockTimeoutMs ?? PROVISION_LOCK_TIMEOUT_MS;
    this.#provisionLockStaleMs = opts.provisionLockStaleMs ?? PROVISION_LOCK_STALE_MS;
    this.#provisionLockHeartbeatMs = opts.provisionLockHeartbeatMs ?? PROVISION_LOCK_HEARTBEAT_MS;
    this.#terminalCleanupHooks = opts.terminalCleanupHooks ?? {};
  }

  /**
   * Detach the base repo's primary worktree HEAD when it is sitting on a
   * branch, so ticket worktrees can `git checkout <base-branch>` (a branch is
   * checkable-out in only one worktree at a time). Idempotent — a no-op when
   * HEAD is already detached. Detaching points HEAD at the same commit, so it
   * never touches the working tree or loses the branch ref. Best-effort.
   */
  async #freeBaseBranch(baseWorkingDir: string): Promise<void> {
    // `symbolic-ref -q HEAD` succeeds (and prints refs/heads/<b>) only when on
    // a branch; it exits non-zero on a detached HEAD.
    const onBranch = await git(baseWorkingDir, ['symbolic-ref', '-q', 'HEAD']);
    if (!onBranch.ok) return; // already detached
    const branch = onBranch.stdout.trim().replace(/^refs\/heads\//, '');
    const det = await git(baseWorkingDir, ['checkout', '--detach']);
    if (det.ok) {
      log(
        `[worktree] detached base working_dir HEAD (was ${branch}) so ticket worktrees can check out the base branch: ${baseWorkingDir}`,
      );
    } else {
      log(
        `[worktree] could not detach base HEAD (${det.stderr.trim()}); ticket worktrees should branch off origin/<base> directly`,
      );
    }
  }

  /** Validate an AWB-managed checkout below working_dir/.awb/base. */
  async #isGitWorkTree(dir: string): Promise<boolean> {
    const r = await git(dir, ['rev-parse', '--is-inside-work-tree']);
    return r.ok && r.stdout.trim() === 'true';
  }

  async #bootstrapContainerRepo(
    baseWorkingDir: string,
    repo: ResolveCwdArgs['bootstrapRepo'],
  ): Promise<{ repo: string | null; reason?: string; detail?: string }> {
    if (!repo?.url?.trim()) return { repo: null, reason: 'repository_unlinked' };
    const cleanUrl = repo.url.trim();
    const resourceSlug = repo.resourceId?.trim().replace(/[^A-Za-z0-9._-]/g, '_');
    // Legacy URL-only bootstraps still need stable isolation without leaking
    // credentials, query strings, or filesystem-hostile characters into paths.
    const repoSlug = resourceSlug || `url-${createHash('sha256').update(cleanUrl).digest('hex').slice(0, 16)}`;
    const key = `${baseWorkingDir}\0${repoSlug}`;
    const active = this.#bootstrapLocks.get(key);
    if (active) return active;
    const run = (async () => {
      await fsp.mkdir(baseWorkingDir, { recursive: true });
      const cloneDir = join(baseWorkingDir, '.awb', 'base', repoSlug);
      if (await this.#isGitWorkTree(cloneDir)) {
        await installRepoCredential(cloneDir, cleanUrl, repo.credential);
        return { repo: cloneDir };
      }
      await fsp.mkdir(join(baseWorkingDir, '.awb', 'base'), { recursive: true });
      const branch = (repo.branch || '').trim();
      const cloned = await cloneWithRepoCredential({
        url: cleanUrl,
        dir: cloneDir,
        branch,
        credential: repo.credential,
        policy: repo.clonePolicy,
      });
      if (!cloned.ok) {
        log(`[worktree] container base clone failed: ${maskCredential(cloned.stderr, repo.credential).trim()}`);
        const detail = maskCredential(cloned.stderr, repo.credential).trim();
        return {
          repo: null,
          reason: isGitAuthFailure(detail) ? 'repository_auth_failed' : 'repository_clone_failed',
          detail,
        };
      }
      // Never leave the token embedded in origin. Persist it in the checkout's
      // private credential-store file so later fetch/push from ticket worktrees
      // authenticate without exposing it in `git remote -v` or process args.
      await scrubOriginUrl(cloneDir, cleanUrl);
      await installRepoCredential(cloneDir, cleanUrl, repo.credential);
      log(`[worktree] cloned container base from ${repo.url}${branch ? ` branch=${branch}` : ''}: ${cloneDir}`);
      return { repo: cloneDir };
    })().finally(() => this.#bootstrapLocks.delete(key));
    this.#bootstrapLocks.set(key, run);
    return run;
  }

  /** Discover only repositories owned by AWB below the working container. */
  async #managedRepos(baseWorkingDir: string, resourceId?: string): Promise<Array<{ repo: string; worktreesRoot: string }>> {
    const baseRoot = join(baseWorkingDir, '.awb', 'base');
    const wtRoot = worktreesRootFor(baseWorkingDir);
    const wanted = resourceId?.trim().replace(/[^A-Za-z0-9._-]/g, '_');
    let names: string[] = [];
    try {
      names = wanted ? [wanted] : await fsp.readdir(baseRoot);
    } catch {
      return [];
    }
    const out: Array<{ repo: string; worktreesRoot: string }> = [];
    for (const name of names) {
      if (!name || name === '.' || name === '..') continue;
      const repo = join(baseRoot, name);
      if (await this.#isGitWorkTree(repo)) out.push({ repo, worktreesRoot: join(wtRoot, name) });
    }
    return out;
  }

  /** Parse `git worktree list --porcelain`. Returns [] on any failure. */
  async listWorktrees(baseWorkingDir: string): Promise<WorktreeInfo[]> {
    const r = await git(baseWorkingDir, ['worktree', 'list', '--porcelain']);
    if (!r.ok) return [];
    const out: WorktreeInfo[] = [];
    let cur: WorktreeInfo | null = null;
    for (const rawLine of r.stdout.split('\n')) {
      const line = rawLine.replace(/\r$/, '');
      if (line.startsWith('worktree ')) {
        if (cur) out.push(cur);
        cur = { path: line.slice('worktree '.length), head: null, branch: null, detached: false };
      } else if (!cur) {
        continue;
      } else if (line.startsWith('HEAD ')) {
        cur.head = line.slice('HEAD '.length);
      } else if (line.startsWith('branch ')) {
        cur.branch = line.slice('branch '.length).replace(/^refs\/heads\//, '');
      } else if (line === 'detached') {
        cur.detached = true;
      } else if (line === '') {
        if (cur) {
          out.push(cur);
          cur = null;
        }
      }
    }
    if (cur) out.push(cur);
    return out;
  }

  /** Best-effort `git worktree prune` — drops registrations whose dir vanished.
   *  Safe to call often; never throws. */
  async prune(baseWorkingDir: string): Promise<void> {
    await git(baseWorkingDir, ['worktree', 'prune']).catch(() => {});
  }

  /**
   * Resolve the cwd a ticket's child should spawn under. Reattaches to an
   * existing worktree when present (preserving its branch + dirty tree),
   * creates one otherwise. Repository clones and worktrees always land below
   * the working_dir storage container; the container itself is never used as a
   * checkout.
   */
  async resolveCwd(args: ResolveCwdArgs): Promise<ResolveCwdResult> {
    const { baseWorkingDir, ticketId, role } = args;
    const mode: WorktreeMode = args.mode === 'shared' ? 'shared' : 'per_ticket';
    const fallback = (reason: string): ResolveCwdResult => ({
      cwd: baseWorkingDir,
      isWorktree: false,
      reason,
    });

    if (!baseWorkingDir) return fallback('no_base_dir');
    // Both modes key a lease/slug on the ticket id, so it is required for either.
    if (!ticketId) return fallback('no_ticket');

    // working_dir is ALWAYS a storage container, never a repository input.
    // Even when an operator points it at a directory that happens to contain
    // `.git`, leave that checkout untouched and create AWB's managed base below
    // `.awb/base/<resource>`. This removes all behavior differences based on
    // whether working_dir itself is a repo.
    const bootstrapped = await this.#bootstrapContainerRepo(baseWorkingDir, args.bootstrapRepo);
    const localBaseRepo = bootstrapped.repo;
    if (!localBaseRepo) {
      const result = fallback(bootstrapped.reason ?? 'repository_unavailable');
      result.detail = bootstrapped.detail;
      return result;
    }
    // Existing checkouts need the Resource credential too; limiting this to
    // fresh clone would leave resumed/private-repo tickets unable to fetch.
    await installRepoCredential(localBaseRepo, args.bootstrapRepo?.url ?? '', args.bootstrapRepo?.credential);

    // 모든 신규/재개 dispatch는 먼저 원격을 갱신한다. 재개 worktree 자체에는
    // checkout/reset을 하지 않으므로 dirty 파일과 기존 브랜치는 그대로 보존된다.
    const fetched = await git(localBaseRepo, ['fetch', '--prune', 'origin']);
    if (!fetched.ok) {
      const detail = maskCredential(fetched.stderr, args.bootstrapRepo?.credential).trim();
      const reason = isGitAuthFailure(detail) ? 'repository_auth_failed' : 'repository_fetch_failed';
      const result = fallback(reason);
      result.detail = detail || undefined;
      return result;
    }
    let baseBranch = (args.bootstrapRepo?.branch || '').trim();
    if (!baseBranch) {
      const remoteHead = await git(localBaseRepo, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
      baseBranch = remoteHead.ok ? remoteHead.stdout.trim().replace(/^origin\//, '') : '';
    }
    if (!baseBranch) return fallback('base_branch_unavailable');
    const baseRef = `refs/remotes/origin/${baseBranch}`;
    const baseTip = await git(localBaseRepo, ['rev-parse', '--verify', baseRef]);
    if (!baseTip.ok) return fallback('base_branch_unavailable');
    const baseSha = baseTip.stdout.trim();

    const resourceId = args.bootstrapRepo?.resourceId?.trim();
    const cleanUrl = args.bootstrapRepo?.url?.trim() || '';
    const resourceSlug = resourceId?.replace(/[^A-Za-z0-9._-]/g, '_')
      || `url-${createHash('sha256').update(cleanUrl).digest('hex').slice(0, 16)}`;
    const provisioningBase = localBaseRepo;
    const workSubpath = '';
    const withSub = (p: string) => p;
    const worktreesRoot = join(worktreesRootFor(baseWorkingDir), resourceSlug);

    // ── shared: lease a warm-pool slot (규약 ⑥) ─────────────────────────────
    if (mode === 'shared') {
      // Shared allocation has its own root-scoped registry mutex.
      await this.prune(provisioningBase);
      return this.#acquireSharedSlot({
        baseWorkingDir: provisioningBase,
        worktreesRoot,
        ticketId,
        role,
        poolSize: args.poolSize,
        workSubpath,
        withSub,
        fallback,
        resourceId: resourceId || '',
        baseBranch,
        baseSha,
        baseRef,
      });
    }

    // ── per_ticket: one dedicated worktree named `<ticket8>` ────────────────
    const wtPath = join(worktreesRoot, worktreeSlug(ticketId, mode));
    return this.#withProvisionLock(worktreesRoot, async () => {
      // Prune + inspect + add is one atomic provisioning transaction. Without
      // this, simultaneous triggers can both observe a missing registration;
      // the loser then falls back to the shared base cwd and defeats isolation.
      await this.prune(provisioningBase);
      const ens = await this.#ensureWorktree(provisioningBase, worktreesRoot, wtPath, baseRef);
      if (!ens.ok) {
        if (ens.reason === 'add_failed') {
          log(
            `[worktree] add failed for ticket=${String(ticketId).slice(0, 8)} role=${role} mode=${mode}: ${ens.detail ?? ''}`,
          );
        }
        return fallback(ens.reason ?? 'worktree_unavailable');
      }
      if (ens.created) {
        log(
          `[worktree] created ${wtPath} for ticket=${String(ticketId).slice(0, 8)} role=${role} mode=${mode}${workSubpath ? ` subpath=${workSubpath}` : ''} (detached at base HEAD)`,
        );
      }
      // 신규·재개 양쪽 모두 attach 를 보장한다. 재개 경로를 건너뛰면 detached
      // HEAD 로 시작한 worktree 가 계속 detached 로 남아 커밋이 고아가 된다.
      const attached = await this.#attachFeatureBranch(wtPath, `ticket/${ticketId}-work`, baseRef);
      if (!attached.ok) {
        log(
          `[worktree] branch attach failed for ticket=${String(ticketId).slice(0, 8)} role=${role} mode=${mode}: ${attached.action}${attached.detail ? ` — ${attached.detail}` : ''}`,
        );
        const result = fallback('branch_prepare_failed');
        result.detail = attached.detail;
        return result;
      }
      const repositoryContext = await this.#describeRepositoryContext(
        wtPath, resourceId || '', baseBranch, baseSha, !ens.created,
      );
      return {
        cwd: withSub(wtPath),
        isWorktree: true,
        reused: !ens.created,
        worktreePath: wtPath,
        workSubpath,
        mode,
        repositoryContext,
      };
    });
  }

  /**
   * Verify the ticket's worktree can authenticate to its https `origin` BEFORE
   * a subagent is spawned, so a dispatch never burns a whole CLI session only
   * to die at `git push` with `could not read Username for 'https://github.com'`
   * — the failure that stalled ticket 8436f96f's Merging twice. Callers run
   * this for the push role at dispatch, so a missing credential is caught at
   * the latest before Merging (usually earlier, at In Progress's feature push).
   *
   * Ground truth is a live, non-interactive `git ls-remote`, NOT credential
   * config inspection: an empty `credential.helper cache`/`store` is configured
   * yet still fails push, so "a helper is set" would be a false positive in
   * exactly the failure environment. A real installed token makes the probe
   * succeed → ready; an empty/missing credential makes it auth-fail → blocked.
   * We block SOLELY on an auth-signature rejection; a transient/network error
   * fails OPEN so a blip never wedges a ticket. Non-https remotes use key/local
   * auth we can't cheaply probe → ready. Best-effort: never throws.
   */
  async verifyPushReadiness(cwd: string, remoteUrl?: string): Promise<PushReadinessDecision> {
    try {
      if (!cwd) return { ok: true };
      let url = (remoteUrl || '').trim();
      if (!url) {
        const r = await git(cwd, ['remote', 'get-url', 'origin']);
        url = r.ok ? r.stdout.trim() : '';
      }
      const isHttps = /^https?:\/\//i.test(url);
      if (!url || !isHttps) return decidePushReadiness({ isHttps: false });
      const probe = await this.#lsRemoteProbe(cwd, url);
      return decidePushReadiness({ isHttps, probe: { ran: true, ok: probe.ok, stderr: probe.stderr } });
    } catch (err: any) {
      // Never let a verification bug block dispatch — fail open, just log.
      log(`[worktree] push-readiness check errored (${err?.message ?? err}); treating as ready`);
      return { ok: true };
    }
  }

  /**
   * ticket feaa7ab0: verify a freshly-resolved worktree is actually a valid git
   * checkout of the EXPECTED repository BEFORE a subagent is spawned into it. A
   * successful `git worktree add` is NOT proof: the cwd can be an empty/clobbered
   * dir (`not_a_git_repo`), a half-written clone whose HEAD does not resolve
   * (`incomplete_checkout`), or a stale checkout of a DIFFERENT repo when the
   * working_dir was re-pointed (`wrong_repository`). Spawning there just burns a
   * CLI session and invites a supervisor re-dispatch storm (ticket 965e6229
   * failed `not_a_git_repo` 4×).
   *
   * Probes are non-mutating (`git rev-parse` / `remote get-url`) and the git()
   * helper never throws; the classification lives in the pure
   * `classifyWorktreeCheckout`. The expected/observed origin is credential-
   * stripped before it reaches a log or comment, so no token leaks. A truly
   * unexpected JS fault fails OPEN — better to spawn than to wedge a
   * legitimately-provisioned tree on a probe bug.
   */
  async verifyCheckout(cwd: string, expectedUrl?: string): Promise<WorktreeCheckoutDecision> {
    try {
      if (!cwd) return { ok: false, reason: 'not_a_git_repo', detail: 'no worktree path' };
      const inside = await git(cwd, ['rev-parse', '--is-inside-work-tree']);
      const insideWorkTree = inside.ok && inside.stdout.trim() === 'true';
      let headResolved: boolean | undefined;
      let originUrl: string | undefined;
      if (insideWorkTree) {
        const head = await git(cwd, ['rev-parse', '--verify', 'HEAD']);
        headResolved = head.ok && /^[0-9a-f]{7,}$/i.test(head.stdout.trim());
        const origin = await git(cwd, ['remote', 'get-url', 'origin']);
        originUrl = origin.ok ? origin.stdout.trim() : '';
      }
      return classifyWorktreeCheckout({ insideWorkTree, headResolved, originUrl }, { url: expectedUrl });
    } catch (err: any) {
      log(`[worktree] checkout verification errored (${err?.message ?? err}); treating as valid (fail open)`);
      return { ok: true };
    }
  }

  /** Non-interactive `git ls-remote --heads <url>` used to verify push auth.
   *  `GIT_TERMINAL_PROMPT=0` + an empty `GIT_ASKPASS` force git to fail fast
   *  (`could not read Username`) instead of hanging on a username prompt. git
   *  still consults any configured credential.helper, so a valid installed
   *  token authenticates and the probe succeeds. Never throws — a failure comes
   *  back as { ok:false }. */
  #lsRemoteProbe(cwd: string, url: string): Promise<GitResult> {
    return new Promise((resolve) => {
      execFile(
        'git',
        ['-C', cwd, 'ls-remote', '--heads', url],
        {
          timeout: PUSH_PROBE_TIMEOUT_MS,
          maxBuffer: 8 * 1024 * 1024,
          windowsHide: true,
          env: {
            ...process.env,
            GIT_TERMINAL_PROMPT: '0',
            GIT_ASKPASS: '',
            GCM_INTERACTIVE: 'never',
          },
        },
        (err, stdout, stderr) => resolve({
          ok: !err,
          stdout: (stdout ?? '').toString(),
          stderr: (stderr ?? (err as any)?.message ?? '').toString(),
        }),
      );
    });
  }

  /**
   * Materialize the worktree at `wtPath`: reattach to an existing registered
   * worktree (the resume path — branch + dirty tree the prior session left
   * behind), or create a fresh detached checkout at the base repo's HEAD. We
   * deliberately do NOT check out a named branch (a branch can live in only one
   * worktree; the column workflow creates its own `ticket/<id>` branch here).
   * Never throws — failures come back as { ok:false, reason }. Assumes the
   * caller has already run `prune`. Shared by the per_ticket path and each
   * warm-pool slot in #acquireSharedSlot.
   */
  async #ensureWorktree(
    baseWorkingDir: string,
    worktreesRoot: string,
    wtPath: string,
    startRef?: string,
  ): Promise<{ ok: boolean; created: boolean; reason?: string; detail?: string }> {
    const worktrees = await this.listWorktrees(baseWorkingDir);
    // Git for Windows는 porcelain 경로의 8.3 단축명을 긴 경로로 확장할 수
    // 있다. 존재하는 경로는 native realpath로 맞춰 재개 worktree를 새 경로
    // 충돌로 오인하지 않게 하고, 해석 실패 시 기존 문자열 비교를 유지한다.
    const comparableWtPath = await fsp.realpath(wtPath).catch(() => wtPath);
    let existing: WorktreeInfo | undefined;
    for (const worktree of worktrees) {
      const comparableWorktreePath = await fsp.realpath(worktree.path).catch(() => worktree.path);
      if (samePath(comparableWorktreePath, comparableWtPath)) {
        existing = worktree;
        break;
      }
    }
    if (existing) {
      try {
        const st = await fsp.stat(wtPath);
        if (st.isDirectory()) return { ok: true, created: false };
      } catch {
        // Registered but dir is gone — prune already ran; fall through to add.
      }
    }

    // If the dir exists but isn't a registered worktree, we don't know what's
    // in it — refuse to clobber.
    if (!existing && (await pathExists(wtPath))) {
      log(
        `[worktree] path exists but is not a registered worktree, falling back to base cwd: ${wtPath}`,
      );
      return { ok: false, created: false, reason: 'path_conflict' };
    }

    try {
      await fsp.mkdir(worktreesRoot, { recursive: true });
    } catch (err: any) {
      return { ok: false, created: false, reason: `mkdir_failed:${err?.message ?? err}` };
    }

    // Free the base branch: the column workflow guide tells the agent to
    // `git checkout <base-branch> && git pull` first, but a branch can be
    // checked out in only ONE worktree. Detaching the base HEAD (no file
    // changes — same commit) frees the branch. Best-effort.
    await this.#freeBaseBranch(baseWorkingDir);

    const add = await git(baseWorkingDir, ['worktree', 'add', '--detach', wtPath, ...(startRef ? [startRef] : [])]);
    if (!add.ok) {
      return { ok: false, created: false, reason: 'add_failed', detail: add.stderr.trim() };
    }
    return { ok: true, created: true };
  }

  /**
   * `wtPath` 를 반드시 이름 있는 branch 에 붙인 상태로 남긴다 — detached HEAD 로
   * 끝내지 않는다(ticket 15db8628). `git worktree add --detach` 는 모든 체크아웃을
   * detached 로 시작하는데, 뒤따르는 `switch -c` 는 `ticket/<id>-work` 가 공유 refs
   * 에 이미 있으면(worktree 디렉터리가 지워지거나 prune 돼도 ref 는 살아남는다)
   * 그대로 실패한다. 그래서 디스패치가 base tip 에 detached 인 채, 옆에 stale
   * branch 를 둔 상태로 도착했다. 그 상태에서 만든 커밋은 어느 branch 에도 안 붙는
   * 고아 커밋이 되어 `git push` 에 보이지 않고 조용히 유실된다.
   *
   * 이미 `featureBranch` 위면 → 건드리지 않는다. 다른 branch 위면 티켓 전용
   * worktree 의 보장이 깨진 상태이므로 `#attachFromOtherBranch` 가 되돌리거나
   * 거부한다(Merging 이 지시하는 base branch 체크아웃은 예외로 인정).
   *
   * detached 면 → 에이전트 커밋을 절대 버리지 않는 순서로 복구한다:
   *   - branch 없음                → HEAD 에서 `switch -c` (고아 커밋까지 흡수)
   *   - HEAD 가 branch 보다 앞섬   → `switch -C` 로 stale ref 를 HEAD 까지 ff
   *                                 (관측된 경우: worktree 가 새 base tip 에서
   *                                 재생성되고 branch 만 뒤에 남은 상태)
   *   - HEAD 에 고유 커밋이 없음   → branch 를 체크아웃한 뒤 전진시킨다:
   *                                 base 를 넘는 커밋이 없으면 `merge --ff-only`,
   *                                 있으면 base 위로 `rebase`
   *   - 양쪽 모두 고유 커밋 보유   → 거부한다. 어느 쪽을 골라도 실제 작업이 사라지므로
   *                                 `branch_prepare_failed` 로 올려 담당자가 직접
   *                                 정리하게 둔다.
   * attach 이후의 base 전진은 `#advanceOntoBase` 가 맡는다 — rebase 가 실패하면
   * 복구 미완이므로 성공으로 보고하지 않는다. 예외를 던지지 않는다.
   */
  async #attachFeatureBranch(
    wtPath: string,
    featureBranch: string,
    baseRef: string,
  ): Promise<{ ok: boolean; action: string; detail?: string }> {
    const current = await git(wtPath, ['branch', '--show-current']);
    if (current.ok && current.stdout.trim()) {
      const branch = current.stdout.trim();
      if (branch === featureBranch) return { ok: true, action: 'already_attached' };
      return this.#attachFromOtherBranch(wtPath, featureBranch, baseRef, branch);
    }

    const head = await git(wtPath, ['rev-parse', 'HEAD']);
    if (!head.ok) return { ok: false, action: 'head_unresolved', detail: head.stderr.trim() };

    const exists = await git(wtPath, ['show-ref', '--verify', '--quiet', `refs/heads/${featureBranch}`]);
    if (!exists.ok) {
      const created = await git(wtPath, ['switch', '-c', featureBranch]);
      return created.ok
        ? { ok: true, action: 'created' }
        : { ok: false, action: 'create_failed', detail: created.stderr.trim() };
    }

    // detached HEAD 가 가진 고유 커밋 — feature branch 에도 base 에도 없는 것.
    // 0 보다 크면 branch 를 그냥 체크아웃하는 순간 그 커밋들이 유실된다.
    // `!== 0` 이므로 카운트 해석 실패(-1)도 "고아가 있을 수 있음"으로 취급한다 —
    // 판단 불가일 때 커밋을 버릴 수 있는 쪽으로 기울지 않는다.
    const orphans = await this.#countCommits(wtPath, ['HEAD', '--not', featureBranch, baseRef]);
    if (orphans !== 0) {
      const behindHead = await git(wtPath, ['merge-base', '--is-ancestor', featureBranch, 'HEAD']);
      if (!behindHead.ok) {
        return {
          ok: false,
          action: 'diverged',
          detail: `detached HEAD and ${featureBranch} both hold unique commits — refusing to pick one`,
        };
      }
      const forced = await git(wtPath, ['switch', '-C', featureBranch]);
      return forced.ok
        ? { ok: true, action: 'fast_forwarded' }
        : { ok: false, action: 'attach_failed', detail: forced.stderr.trim() };
    }

    const switched = await git(wtPath, ['switch', featureBranch]);
    if (!switched.ok) {
      return { ok: false, action: 'attach_failed', detail: switched.stderr.trim() };
    }
    return this.#advanceOntoBase(wtPath, featureBranch, baseRef, 'attached');
  }

  /**
   * 이미 `featureBranch` 에 붙은 worktree 를 base tip 위로 전진시킨다 —
   * 자기 커밋이 없으면 `merge --ff-only`, 있으면 `rebase`(완료 기준의
   * "커밋 0개 → ff attach / 커밋 있음 → rebase" 분기).
   *
   * rebase 실패는 **성공으로 보고하지 않는다.** 충돌이나 커미터 신원 부재로
   * 실패한 상태는 attach 만 된 것이지 복구가 끝난 게 아니므로, 기준대로
   * `branch_prepare_failed` 를 올려 담당 에이전트가 진단하게 한다. 다만 abort 로
   * rebase 중간 상태만 걷어내고 **branch 는 붙은 채로** 남겨, 진단하러 온
   * 에이전트가 최소한 고아 커밋 위험은 없는 worktree 를 만나게 한다.
   */
  async #advanceOntoBase(
    wtPath: string,
    featureBranch: string,
    baseRef: string,
    okAction: string,
  ): Promise<{ ok: boolean; action: string; detail?: string }> {
    const own = await this.#countCommits(wtPath, [featureBranch, '--not', baseRef]);
    if (own === 0) {
      // rebase 와 같은 기준으로 판정한다 — ff merge 가 거부되면(예: upstream 과
      // 겹치는 tracked 파일에 미커밋 변경이 있는 경우) branch 는 stale 한 채로
      // 남으므로 준비 성공이 아니다.
      const merged = await git(wtPath, ['merge', '--ff-only', baseRef]);
      if (!merged.ok) {
        return {
          ok: false,
          action: 'merge_failed',
          detail: `${featureBranch} attached but fast-forward onto ${baseRef} failed: ${merged.stderr.trim()}`,
        };
      }
      return { ok: true, action: `${okAction}_ff` };
    }
    const rebased = await git(wtPath, ['rebase', baseRef]);
    if (!rebased.ok) {
      await git(wtPath, ['rebase', '--abort']);
      return {
        ok: false,
        action: 'rebase_failed',
        detail: `${featureBranch} attached but rebase onto ${baseRef} failed: ${rebased.stderr.trim()}`,
      };
    }
    return { ok: true, action: `${okAction}_rebased` };
  }

  /**
   * feature branch 가 아닌 **다른 branch** 에 붙어 있는 티켓 worktree 를 처리한다.
   * 티켓 전용 worktree 이므로 그대로 승인하면 이후 커밋이 엉뚱한 branch 에 쌓인다.
   *
   *   - feature branch 가 살아 있고 tree 가 clean → 되돌려 붙인다(보장 복구).
   *   - feature branch 가 살아 있는데 tree 가 dirty → 브랜치를 옮기면 작업물이
   *     따라가거나 덮일 수 있어 자동 판단 불가 → `branch_prepare_failed`.
   *   - feature branch 가 이미 없음 → 어떤 branch 위든 거부한다.
   *
   * 마지막 경우에 **branch 를 새로 만들지 않는다**는 점이 중요하다. Merging
   * 가이드는 step 3 에서 base branch 를 체크아웃하고 step 5 에서 feature branch 를
   * 지우라고 지시하므로, "base branch 위 + feature ref 없음" 은 Merging 이 끝난
   * 뒤의 모양과 같다. 여기서 ref 를 다시 만들면 step 5 가 방금 지운 것을 되살려
   * terminal-cleanup 이 기대하는 상태를 깨뜨린다 — 그래서 거부하되 ref 는 건드리지
   * 않는다. 다만 이 계층에는 지금 어느 단계에서 호출됐는지 알려주는 신호가 없어
   * "정말 Merging 이 끝난 것"과 "In Progress 인데 feature ref 가 실수로 사라진 것"
   * 을 구분할 수 없다. 후자를 통과시키면 이후 커밋이 base branch 에 붙는 위험이
   * 그대로 열리므로, 구분 불가일 때는 안전한 실패를 택한다(리뷰 결정).
   */
  async #attachFromOtherBranch(
    wtPath: string,
    featureBranch: string,
    baseRef: string,
    currentBranch: string,
  ): Promise<{ ok: boolean; action: string; detail?: string }> {
    const exists = await git(wtPath, ['show-ref', '--verify', '--quiet', `refs/heads/${featureBranch}`]);
    if (!exists.ok) {
      return {
        ok: false,
        action: 'feature_branch_missing',
        detail: `worktree sits on '${currentBranch}' and ${featureBranch} no longer exists — refusing to guess`,
      };
    }

    const status = await git(wtPath, ['status', '--porcelain']);
    if (!status.ok || status.stdout.trim()) {
      return {
        ok: false,
        action: 'other_branch_dirty',
        detail: `worktree sits on '${currentBranch}' with uncommitted changes — cannot switch to ${featureBranch} safely`,
      };
    }

    const switched = await git(wtPath, ['switch', featureBranch]);
    if (!switched.ok) {
      return {
        ok: false,
        action: 'other_branch_attach_failed',
        detail: `could not switch from '${currentBranch}' to ${featureBranch}: ${switched.stderr.trim()}`,
      };
    }
    return this.#advanceOntoBase(wtPath, featureBranch, baseRef, 'restored_from_other_branch');
  }

  /** `git rev-list --count <args>`. 카운트를 못 구하면 -1 을 돌려준다 — 호출부가
   *  git 실패를 "커밋 0개"로 오인하지 않게 하기 위해서다. */
  async #countCommits(cwd: string, args: string[]): Promise<number> {
    const res = await git(cwd, ['rev-list', '--count', ...args]);
    if (!res.ok) return -1;
    const parsed = Number(res.stdout.trim());
    return Number.isFinite(parsed) ? parsed : -1;
  }

  async #describeRepositoryContext(
    cwd: string,
    resourceId: string,
    baseBranch: string,
    baseSha: string,
    resumed: boolean,
  ): Promise<TicketRepositoryContext> {
    const branch = await git(cwd, ['branch', '--show-current']);
    const head = await git(cwd, ['rev-parse', 'HEAD']);
    const status = await git(cwd, ['status', '--porcelain']);
    const counts = await git(cwd, ['rev-list', '--left-right', '--count', `origin/${baseBranch}...HEAD`]);
    const [behind = 0, ahead = 0] = counts.ok
      ? counts.stdout.trim().split(/\s+/).map((value) => Number(value) || 0)
      : [0, 0];
    return {
      resourceId,
      cwd,
      baseBranch,
      baseSha,
      currentSha: head.ok ? head.stdout.trim() : undefined,
      currentShaFailure: head.ok ? undefined : 'head_lookup_failed',
      workingBranch: branch.ok && branch.stdout.trim() ? branch.stdout.trim() : null,
      dirty: status.ok && status.stdout.length > 0,
      ahead,
      behind,
      resumed,
    };
  }

  // ── warm-pool (shared mode, 규약 ⑥) ──────────────────────────────────────

  /**
   * Lease a warm-pool slot for a shared-mode ticket. Serialized per worktrees
   * root so two triggers never grab the same idle slot. Three outcomes:
   *   - Reattach: this ticket already owns a slot → return it, no reset (its
   *     branch + tree survive — resume / next role / follow-up turn).
   *   - Fresh lease: pick an idle slot (a released one first — it's warm — else
   *     an unused index), reset-on-acquire it (tracked source → base tip;
   *     untracked build artifacts preserved), and record the lease.
   *   - Pool exhausted: no idle slot in [0, N). The invariant (N == concurrency,
   *     the ticket cap holds concurrent ticket sessions ≤ N) makes this
   *     unreachable in normal operation; a leaked dead-worker lease can still
   *     exhaust it (crash reclaim is a follow-up ticket). Safe fallback: base cwd.
   */
  async #acquireSharedSlot(a: {
    baseWorkingDir: string;
    worktreesRoot: string;
    ticketId: string;
    role: string;
    poolSize?: number;
    workSubpath: string;
    withSub: (p: string) => string;
    fallback: (reason: string) => ResolveCwdResult;
    resourceId: string;
    baseBranch: string;
    baseSha: string;
    baseRef: string;
  }): Promise<ResolveCwdResult> {
    const N = Math.max(1, Math.floor(a.poolSize && a.poolSize > 0 ? a.poolSize : 1));
    const t8 = String(a.ticketId).slice(0, 8);
    const result = async (wtPath: string, reused: boolean): Promise<ResolveCwdResult> => ({
      cwd: a.withSub(wtPath),
      isWorktree: true,
      reused,
      worktreePath: wtPath,
      workSubpath: a.workSubpath,
      mode: 'shared',
      repositoryContext: await this.#describeRepositoryContext(
        wtPath, a.resourceId, a.baseBranch, a.baseSha, reused,
      ),
    });

    return this.#withPoolLock(a.worktreesRoot, async () => {
      const reg = await this.#readRegistry(a.worktreesRoot);

      // 1. Reattach — this ticket already holds a slot (active OR released; a
      //    released ticket re-triggering keeps its own tree, no reset).
      const mine = Object.keys(reg.slots).find((s) => reg.slots[s].ticketId === a.ticketId);
      if (mine) {
        const wtPath = join(a.worktreesRoot, mine);
        const ens = await this.#ensureWorktree(a.baseWorkingDir, a.worktreesRoot, wtPath);
        if (ens.ok) {
          // per_ticket 재개와 같은 이유로 slot 재부착에서도 attach 를 보장한다.
          const attached = await this.#attachFeatureBranch(wtPath, `ticket/${a.ticketId}-work`, a.baseRef);
          if (!attached.ok) {
            log(
              `[worktree] branch attach failed for shared slot ${mine} ticket=${t8}: ${attached.action}${attached.detail ? ` — ${attached.detail}` : ''}`,
            );
            const failed = a.fallback('branch_prepare_failed');
            failed.detail = attached.detail;
            return failed;
          }
          reg.slots[mine].active = true;
          reg.slots[mine].role = a.role;
          // Refresh leasedAt on reattach too: a re-dispatch (idle-reap respawn,
          // pend/unpend) reopens the same [lease → child registered] gap, and the
          // reclaim freshness grace keys off leasedAt. Without this, a slot whose
          // leasedAt is stale (worker was reaped long ago) would be reclaimable
          // during its re-spawn window before the new child registers a session.
          reg.slots[mine].leasedAt = nowIso();
          delete reg.slots[mine].releasedAt;
          await this.#writeRegistry(a.worktreesRoot, reg);
          return await result(wtPath, !ens.created);
        }
        // Owned slot can't be materialized (dir clobbered by a non-worktree,
        // add failed) — drop the stale lease and fall through to a fresh pick.
        delete reg.slots[mine];
      }

      // 2. Fresh lease — classify slots [0, N): prefer a released (warm) slot,
      //    else an unused index.
      let resetIdx = -1;
      let freshIdx = -1;
      for (let i = 0; i < N; i++) {
        const lease = reg.slots[sharedSlotName(i)];
        if (lease && lease.active) continue; // held by a live ticket — never touch
        if (lease) {
          if (resetIdx < 0) resetIdx = i; // released → warm, reuse first
        } else if (freshIdx < 0) {
          freshIdx = i; // never used
        }
      }
      const pick = resetIdx >= 0 ? resetIdx : freshIdx;
      if (pick < 0) {
        log(
          `[worktree] shared pool exhausted (N=${N}) for ticket=${t8} — every slot is an active lease; falling back to base cwd`,
        );
        return a.fallback('pool_exhausted');
      }

      const slotName = sharedSlotName(pick);
      const wtPath = join(a.worktreesRoot, slotName);
      const prevLease = reg.slots[slotName];
      const ens = await this.#ensureWorktree(a.baseWorkingDir, a.worktreesRoot, wtPath, a.baseRef);
      if (!ens.ok) return a.fallback(ens.reason ?? 'worktree_unavailable');

      // Reset-on-acquire: hand a clean TRACKED tree at the base tip while keeping
      // UNTRACKED warm-build artifacts. A brand-new dir is already clean at base
      // HEAD, so it only needs the stale recorded branch dropped.
      await this.#resetSlotOnAcquire(a.baseWorkingDir, wtPath, {
        fullReset: !ens.created,
        recordedBranch: prevLease?.branch ?? null,
        baseRef: a.baseRef,
        baseBranch: a.baseBranch,
      });
      // reset-on-acquire 가 HEAD 를 detach 해두므로 여기서 반드시 다시 붙인다.
      // `switch -c` 단독으로는 이 티켓의 branch 가 다른 slot 에서 살아남은 경우
      // "already exists" 로 실패해 slot 이 detached 로 남았다.
      const attached = await this.#attachFeatureBranch(wtPath, `ticket/${a.ticketId}-work`, a.baseRef);
      if (!attached.ok) {
        log(
          `[worktree] branch attach failed for shared slot ${slotName} ticket=${t8}: ${attached.action}${attached.detail ? ` — ${attached.detail}` : ''}`,
        );
        const failed = a.fallback('branch_prepare_failed');
        failed.detail = attached.detail;
        return failed;
      }

      reg.slots[slotName] = {
        slot: slotName,
        ticketId: a.ticketId,
        role: a.role,
        active: true,
        leasedAt: nowIso(),
      };
      await this.#writeRegistry(a.worktreesRoot, reg);
      log(
        `[worktree] leased shared pool slot ${slotName} (${resetIdx >= 0 ? 'reset warm' : 'fresh'}) to ticket=${t8} role=${a.role} of N=${N}`,
      );
      return await result(wtPath, !ens.created);
    });
  }

  /**
   * Reset a pool slot back to the base tip before handing it to a new lease.
   * `git reset --hard` restores TRACKED source only — UNTRACKED build artifacts
   * (Unity Library/, node_modules, out-of-tree outputs) survive, so the next
   * ticket builds warm. NEVER `git clean` — that would wipe exactly what makes
   * the pool valuable. Detaches HEAD first so a hard-reset can't be blocked by
   * (and the prior work branch can be deleted despite) a checked-out branch. All
   * steps best-effort; a git failure degrades to "slightly less clean", never a
   * throw.
   */
  async #resetSlotOnAcquire(
    baseWorkingDir: string,
    slotPath: string,
    opts: { fullReset: boolean; recordedBranch: string | null; baseRef: string; baseBranch: string },
  ): Promise<void> {
    // The branch the dead/prior occupant left checked out — delete it too.
    const liveHead = await git(slotPath, ['rev-parse', '--abbrev-ref', 'HEAD']);
    const liveBranch = liveHead.ok ? liveHead.stdout.trim() : '';

    if (opts.fullReset) {
      // Detach at the current commit (no file changes → safe on a dirty tree),
      // freeing the branch so `reset --hard` and `branch -D` below can proceed.
      await git(slotPath, ['checkout', '--detach']);
      const reset = await git(slotPath, ['reset', '--hard', opts.baseRef]);
      const resetOk = reset.ok;
      if (!resetOk) {
        // origin/<base> unresolvable (no remote / stale) → fall back to the base
        // repo's current HEAD commit, which is where fresh slots start anyway.
        const head = await git(baseWorkingDir, ['rev-parse', 'HEAD']);
        if (head.ok && head.stdout.trim()) {
          await git(slotPath, ['reset', '--hard', head.stdout.trim()]);
        }
      }
    }

    // Drop the prior occupant's work branch(es) so `ticket/<id>` refs don't pile
    // up. Safe: release only happens at terminal (work merged) / archive (work
    // abandoned). `-D` is best-effort — a no-op when already deleted by Merging.
    // Base-branch guard: also skip the `main`/`master` literals unconditionally,
    // not just the detected `base`. When #detectBaseBranch returns null (no
    // remote), `b !== base` is `b !== null` — always true — so a slot that ever
    // sat on `main` could get `branch -D main`. Protecting the literals closes
    // that (crash-reclaim hardening requested in the ticket 83b2d43b review).
    const protectedBranches = new Set(
      ['HEAD', opts.baseBranch, 'main', 'master'].filter((x): x is string => !!x),
    );
    for (const b of new Set([liveBranch, opts.recordedBranch ?? ''])) {
      if (b && !protectedBranches.has(b)) {
        await git(slotPath, ['branch', '-D', b]);
      }
    }
  }

  /**
   * Determine the repo's base branch name (typically `main` / `master`) for the
   * reset-on-acquire target. Prefers the remote's default (`origin/HEAD`), then
   * probes `origin/main` / `origin/master`. Returns null when none resolves (the
   * caller then falls back to the base repo HEAD). Never throws.
   */
  async #detectBaseBranch(baseWorkingDir: string): Promise<string | null> {
    const sym = await git(baseWorkingDir, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
    if (sym.ok) {
      const b = sym.stdout.trim().replace(/^origin\//, '');
      if (b) return b;
    }
    for (const cand of ['main', 'master']) {
      const ref = await git(baseWorkingDir, [
        'show-ref',
        '--verify',
        '--quiet',
        `refs/remotes/origin/${cand}`,
      ]);
      if (ref.ok) return cand;
    }
    return null;
  }

  /**
   * Release the pool slot a shared-mode ticket holds — LAZY: mark it idle and
   * record its current branch (for the next acquire's `branch -D`), but do NOT
   * reset or remove it. The reset is deferred to the next acquire so cleanup
   * never depends on a tidy handback (workers die on exit-143 mid-work). No-op
   * (returns 0) when the ticket holds no active slot. Never throws.
   */
  async #releaseSharedSlot(baseWorkingDir: string, worktreesRoot: string, ticketId: string): Promise<number> {
    return this.#withPoolLock(worktreesRoot, async () => {
      const reg = await this.#readRegistry(worktreesRoot);
      const key = Object.keys(reg.slots).find(
        (s) => reg.slots[s].ticketId === ticketId && reg.slots[s].active,
      );
      if (!key) return 0;
      const wtPath = join(worktreesRoot, key);
      let branch: string | null = null;
      const hb = await git(wtPath, ['rev-parse', '--abbrev-ref', 'HEAD']);
      if (hb.ok) {
        const b = hb.stdout.trim();
        if (b && b !== 'HEAD') branch = b;
      }
      reg.slots[key] = { ...reg.slots[key], active: false, releasedAt: nowIso(), branch };
      await this.#writeRegistry(worktreesRoot, reg);
      log(
        `[worktree] released shared pool slot ${key} for ticket=${String(ticketId).slice(0, 8)} (idle; reset deferred to next acquire)`,
      );
      return 1;
    });
  }

  /**
   * Crash-tolerant lease reclaim (this ticket): reconcile the persisted lease
   * registry against the set of live ticket workers, flipping any ACTIVE lease
   * whose owner is no longer alive back to IDLE. This closes the leak that
   * reset-on-acquire alone can't: a worker that dies uncleanly (exit-143 /
   * crash) BEFORE its ticket reaches terminal/archive never runs the release
   * path (#releaseSharedSlot), so its slot stays `active` forever and the pool
   * eventually starves (`pool_exhausted`).
   *
   * The persisted registry is the source of truth; `liveTicketIds` is the
   * caller's live-worker view — the union of the manager's live ticket sessions
   * and one-shot subagents (the same snapshots the worktree sweep reuses, kept
   * honest against the OS by _getLiveSession / #reconcileOnStart). A lease is an
   * orphan candidate when its ticket is `active` in the registry but ABSENT from
   * that live set. We trust this OS/output-liveness view, NOT a ticket's
   * my_last_update_at — the force_respawn death-loop lesson (fdc69c13): a live
   * but quiet worker still holds a live session, so it stays in the snapshot and
   * is never mistaken for dead.
   *
   * Safety belt (규약: never false-reclaim a live worker): before reclaiming, a
   * best-effort `/proc/<pid>/cwd` scan (#liveProcessCwds) spares any slot a live
   * process is still working INSIDE. This covers a detached persistent ticket
   * child that outlived a manager restart but isn't yet re-registered in
   * `_sessions` at boot — its cwd still points at the slot, so it survives.
   *
   * Reclaim is a pure STATE FLIP: mark idle + record the slot's branch for the
   * next acquire's `branch -D`. The slot dir (and its untracked warm build) is
   * NEVER touched — the reset-on-acquire the next lease runs does the cleanup.
   * Serialized under the same per-root pool lock as acquire/release. Returns the
   * number of leases reclaimed. Never throws.
   */
  async reconcilePoolLeases(opts: {
    baseWorkingDir: string;
    liveTicketIds: Set<string>;
  }): Promise<number> {
    const { baseWorkingDir, liveTicketIds } = opts;
    if (!baseWorkingDir) return 0;
    let total = 0;
    for (const managed of await this.#managedRepos(baseWorkingDir)) {
      total += await this.#reconcilePoolLeasesForRepo(managed.repo, managed.worktreesRoot, liveTicketIds);
    }
    return total;
  }

  async #reconcilePoolLeasesForRepo(
    baseRepo: string,
    worktreesRoot: string,
    liveTicketIds: Set<string>,
  ): Promise<number> {
    return this.#withPoolLock(worktreesRoot, async () => {
      const reg = await this.#readRegistry(worktreesRoot);
      const now = Date.now();
      // Orphan candidates: active leases with no live owner. A per_ticket board
      // has an empty registry → no candidates → cheap no-op (no /proc scan).
      // Freshness grace (POOL_LEASE_RECLAIM_GRACE_MS): skip a lease still within
      // its dispatch window — the worker may be provisioning/spawning and just
      // not yet in the live-session snapshot (never false-reclaim a live worker).
      // An unparseable leasedAt falls through to a candidate; the /proc belt is
      // the final safety net there.
      const candidates = Object.keys(reg.slots).filter((s) => {
        const lease = reg.slots[s];
        if (!lease.active || liveTicketIds.has(lease.ticketId)) return false;
        const leasedMs = Date.parse(lease.leasedAt);
        if (Number.isFinite(leasedMs) && now - leasedMs < POOL_LEASE_RECLAIM_GRACE_MS) {
          return false;
        }
        return true;
      });
      if (candidates.length === 0) return 0;

      // Secondary guard — spare any slot a live process is still cwd'd inside
      // (a detached child that outlived a restart before the session map was
      // rebuilt). Best-effort; empty on non-Linux / failure → snapshot-only.
      const liveCwds = (await this.#liveProcessCwds()).map(normPath);
      const inUse = (slotPath: string): boolean => {
        const p = normPath(slotPath);
        // Exact match covers a process at the checkout root; startsWith covers
        // a process in any checkout subdirectory.
        return liveCwds.some((c) => c === p || c.startsWith(p + '/'));
      };

      let reclaimed = 0;
      for (const slot of candidates) {
        const lease = reg.slots[slot];
        const t8 = String(lease.ticketId).slice(0, 8);
        const wtPath = join(worktreesRoot, slot);
        // `/proc/<pid>/cwd` is kernel-canonicalized, so compare against the slot's
        // realpath (working_dir / .awb may sit under a symlink). Dir gone → the
        // raw path, and inUse is false anyway (no live cwd in a vanished dir).
        let realWt = wtPath;
        try {
          realWt = await fsp.realpath(wtPath);
        } catch {
          /* slot dir pruned/removed — nothing can be cwd'd inside it */
        }
        if (inUse(realWt)) {
          log(
            `[worktree] pool reclaim SKIP slot ${slot} ticket=${t8} — a live process is still working in it (not in session snapshot but OS-alive)`,
          );
          continue;
        }
        // Record the branch the dead occupant left so the next acquire drops it
        // (falls back to the already-recorded branch when the dir is gone).
        let branch: string | null = lease.branch ?? null;
        const hb = await git(wtPath, ['rev-parse', '--abbrev-ref', 'HEAD']);
        if (hb.ok) {
          const b = hb.stdout.trim();
          branch = b && b !== 'HEAD' ? b : null;
        }
        reg.slots[slot] = { ...lease, active: false, releasedAt: nowIso(), branch };
        reclaimed++;
        log(
          `[worktree] pool reclaim slot ${slot} — orphaned lease from dead ticket=${t8} flipped to idle (reset deferred to next acquire)`,
        );
      }
      if (reclaimed > 0) await this.#writeRegistry(worktreesRoot, reg);
      return reclaimed;
    });
  }

  /**
   * Read-only observability snapshot of every worktree under this working_dir's
   * `<working_dir>/.awb/wt/` root, joined to the pool lease registry so the admin
   * UI can render "which slot / folder holds which task" (ticket 72fc244f). Pure
   * projection — never mutates state and never throws (a failure yields []).
   * Best-effort; called on the instance-heartbeat clock (30s), so it stays cheap:
   * one `git worktree list` + one registry read per working_dir.
   *
   * SHARED mode — the lease registry (`.pool-leases.json`) is the source of truth
   * for slot→ticket. An active lease with a live owner → 'allocated'; an active
   * lease with no live owner but still inside the reclaim grace → 'allocated'
   * (assumed mid-dispatch, not a leak); an active lease past the grace with no
   * owner → 'orphaned' (the exact lease reconcilePoolLeases reclaims). A
   * released/absent lease → 'idle' (warm slot awaiting the next acquire's reset).
   *
   * PER_TICKET mode — no lease record exists; the dir `<ticket8>` IS the task.
   * 'allocated' when a live worker session owns it (matched by id prefix), else
   * 'idle'. Only a live per_ticket dir yields a full ticket uuid; an idle one is
   * reported with ticketId=null (only the 8-char slug is locally knowable).
   *
   * QA/Security run workspaces are a SEPARATE `.awb/qa/<id8>` clone (not a git
   * worktree of this repo), so they never appear in `git worktree list` and are
   * intentionally out of scope here.
   */
  async snapshotWorktrees(opts: {
    baseWorkingDir: string;
    liveTicketIds: Set<string>;
  }): Promise<WorktreeSnapshotEntry[]> {
    const { baseWorkingDir, liveTicketIds } = opts;
    if (!baseWorkingDir) return [];
    const out: WorktreeSnapshotEntry[] = [];
    for (const managed of await this.#managedRepos(baseWorkingDir)) {
      out.push(...await this.#snapshotWorktreesForRepo(managed.repo, managed.worktreesRoot, liveTicketIds));
    }
    out.sort((a, b) => {
      if (a.mode !== b.mode) return a.mode === 'shared' ? -1 : 1;
      return a.path.localeCompare(b.path, undefined, { numeric: true });
    });
    return out;
  }

  async #snapshotWorktreesForRepo(
    baseRepo: string,
    worktreesRoot: string,
    liveTicketIds: Set<string>,
  ): Promise<WorktreeSnapshotEntry[]> {
    try {
      // Read the lease registry under the pool lock so we never observe a
      // half-written file mid-acquire. listWorktrees is a read-only git call and
      // needs no lock.
      const reg = await this.#withPoolLock(worktreesRoot, () =>
        this.#readRegistry(worktreesRoot),
      );
      const wts = await this.listWorktrees(baseRepo);
      // Keep only worktrees strictly under `.awb/wt` (drops the main checkout).
      const bySlot = new Map<string, WorktreeInfo>();
      for (const w of wts) {
        if (!isUnder(w.path, worktreesRoot)) continue;
        bySlot.set(lastSegment(w.path), w);
      }
      // Union of on-disk slots and registry slots — a lease pointing at a
      // vanished dir is itself a leak worth surfacing.
      const slots = new Set<string>([...bySlot.keys(), ...Object.keys(reg.slots)]);
      const now = Date.now();
      const out: WorktreeSnapshotEntry[] = [];
      for (const slot of slots) {
        const wt = bySlot.get(slot) ?? null;
        const path = wt?.path ?? join(worktreesRoot, slot);
        if (isSharedSlotSeg(slot)) {
          const lease = reg.slots[slot] ?? null;
          const active = lease?.active === true;
          const ticketId = active ? lease!.ticketId : null;
          const live = active && !!ticketId && liveTicketIds.has(ticketId);
          let state: WorktreeState = 'idle';
          if (active) {
            const leasedMs = lease ? Date.parse(lease.leasedAt) : NaN;
            const withinGrace =
              Number.isFinite(leasedMs) && now - leasedMs < POOL_LEASE_RECLAIM_GRACE_MS;
            state = live || withinGrace ? 'allocated' : 'orphaned';
          }
          out.push({
            path,
            slot,
            mode: 'shared',
            ticketId,
            branch: wt?.branch ?? lease?.branch ?? null,
            state,
            live,
          });
        } else {
          // per_ticket: slug is the ticket's first 8 chars. The full id is only
          // knowable when a live session holds it.
          const fullLive = [...liveTicketIds].find((id) => id.slice(0, 8) === slot) ?? null;
          const live = !!fullLive;
          out.push({
            path,
            slot,
            mode: 'per_ticket',
            ticketId: fullLive,
            branch: wt?.branch ?? null,
            state: live ? 'allocated' : 'idle',
            live,
          });
        }
      }
      // Stable order: shared pool slots first (numeric by index), then per_ticket
      // dirs by slug — deterministic so the UI list doesn't jitter between ticks.
      out.sort((a, b) => {
        if (a.mode !== b.mode) return a.mode === 'shared' ? -1 : 1;
        return a.slot.localeCompare(b.slot, undefined, { numeric: true });
      });
      return out;
    } catch (err: any) {
      log(`[worktree] snapshotWorktrees failed under ${worktreesRoot}: ${err?.message ?? err}`);
      return [];
    }
  }

  /**
   * Best-effort snapshot of the cwd of every live process (Linux
   * `/proc/<pid>/cwd`). Used by reconcilePoolLeases as an OS-liveness cross-check
   * so a slot a live process is still working in is never reclaimed. Returns []
   * on non-Linux or any read failure (the caller then relies on the live-session
   * snapshot alone). Mirrors subagent-manager's `/proc` scan — same host
   * assumption. Never throws.
   */
  async #liveProcessCwds(): Promise<string[]> {
    if (process.platform !== 'linux') return [];
    let entries: string[];
    try {
      entries = await fsp.readdir('/proc');
    } catch {
      return [];
    }
    const cwds: string[] = [];
    await Promise.all(
      entries.map(async (e) => {
        if (!/^\d+$/.test(e)) return; // only numeric pid dirs
        try {
          cwds.push(await fsp.readlink(`/proc/${e}/cwd`));
        } catch {
          /* process gone between readdir and readlink, or EPERM — skip */
        }
      }),
    );
    return cwds;
  }

  #registryPath(worktreesRoot: string): string {
    return join(worktreesRoot, '.pool-leases.json');
  }

  /** Read the on-disk lease registry; a missing / malformed file yields an empty
   *  registry (so a per_ticket board never spuriously creates one). Never throws. */
  async #readRegistry(worktreesRoot: string): Promise<PoolRegistry> {
    try {
      const raw = await fsp.readFile(this.#registryPath(worktreesRoot), 'utf8');
      const parsed = JSON.parse(raw);
      const slots: Record<string, PoolSlotLease> = {};
      if (parsed && typeof parsed === 'object' && parsed.slots && typeof parsed.slots === 'object') {
        for (const [k, v] of Object.entries(parsed.slots as Record<string, any>)) {
          if (v && typeof v.ticketId === 'string' && v.ticketId) {
            slots[k] = {
              slot: k,
              ticketId: v.ticketId,
              role: typeof v.role === 'string' ? v.role : undefined,
              active: v.active === true,
              leasedAt: typeof v.leasedAt === 'string' ? v.leasedAt : '',
              releasedAt: typeof v.releasedAt === 'string' ? v.releasedAt : undefined,
              branch:
                typeof v.branch === 'string' ? v.branch : v.branch === null ? null : undefined,
            };
          }
        }
      }
      return { version: 1, slots };
    } catch {
      return { version: 1, slots: {} };
    }
  }

  /** Persist the lease registry under `<worktreesRoot>/.pool-leases.json`
   *  (inside the gitignored `.awb/`). Best-effort; never throws. */
  async #writeRegistry(worktreesRoot: string, reg: PoolRegistry): Promise<void> {
    try {
      await fsp.mkdir(worktreesRoot, { recursive: true });
      await fsp.writeFile(
        this.#registryPath(worktreesRoot),
        JSON.stringify({ version: 1, slots: reg.slots }, null, 2) + '\n',
        'utf8',
      );
    } catch (err: any) {
      log(`[worktree] pool lease registry write failed under ${worktreesRoot}: ${err?.message ?? err}`);
    }
  }

  /** Serialize an async op per worktrees root (one chained promise per key). */
  async #withPoolLock<T>(worktreesRoot: string, fn: () => Promise<T>): Promise<T> {
    const key = normPath(worktreesRoot);
    const prev = this.#poolLocks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    this.#poolLocks.set(key, prev.then(() => gate));
    await prev.catch(() => {});
    try {
      return await fn();
    } finally {
      release();
    }
  }

  /** Serialize per-ticket worktree provisioning per repository root. */
  async #withProvisionLock<T>(worktreesRoot: string, fn: () => Promise<T>): Promise<T> {
    const key = normPath(worktreesRoot);
    const prev = this.#provisionLocks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const tail = prev.then(() => gate);
    this.#provisionLocks.set(key, tail);
    await prev.catch(() => {});
    const lockDir = join(worktreesRoot, '.provision.lock');
    const ownerPath = join(lockDir, 'owner.json');
    const owner: ProvisionLockOwner = { token: randomUUID(), pid: process.pid };
    const deadline = Date.now() + this.#provisionLockTimeoutMs;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    try {
      await fsp.mkdir(worktreesRoot, { recursive: true });
      for (;;) {
        try {
          await fsp.mkdir(lockDir);
          await fsp.writeFile(ownerPath, JSON.stringify(owner), { flag: 'wx' });
          break;
        } catch (err: any) {
          if (err?.code !== 'EEXIST') throw err;
          try {
            const stat = await fsp.stat(lockDir);
            if (Date.now() - stat.mtimeMs > this.#provisionLockStaleMs) {
              let current: ProvisionLockOwner | undefined;
              try {
                const parsed = JSON.parse(await fsp.readFile(ownerPath, 'utf8')) as Partial<ProvisionLockOwner>;
                if (typeof parsed.token === 'string' && parsed.token && Number.isInteger(parsed.pid)) {
                  current = parsed as ProvisionLockOwner;
                }
              } catch {
                // A crash can leave the directory behind before owner.json is
                // written (or while it is being written). Once the directory
                // itself is stale, missing/corrupt metadata cannot identify a
                // live owner and is safe to quarantine via atomic rename.
              }
              let ownerAlive = false;
              if (current && current.pid > 0) {
                try {
                  process.kill(current.pid, 0);
                  ownerAlive = true;
                } catch (signalErr: any) {
                  ownerAlive = signalErr?.code === 'EPERM';
                }
              }
              if (!ownerAlive) {
                const staleDir = `${lockDir}.stale-${randomUUID()}`;
                await fsp.rename(lockDir, staleDir);
                await fsp.rm(staleDir, { recursive: true, force: true });
                continue;
              }
            }
          } catch {}
          if (Date.now() >= deadline) throw new Error(`provision lock timeout: ${lockDir}`);
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
      }
      heartbeat = setInterval(() => {
        void fsp.utimes(lockDir, new Date(), new Date()).catch(() => {});
      }, this.#provisionLockHeartbeatMs);
      heartbeat.unref?.();
      try {
        return await fn();
      } finally {
        if (heartbeat) clearInterval(heartbeat);
        try {
          const current = JSON.parse(await fsp.readFile(ownerPath, 'utf8')) as ProvisionLockOwner;
          if (current.token === owner.token) {
            const releasedDir = `${lockDir}.released-${owner.token}`;
            await fsp.rename(lockDir, releasedDir);
            await fsp.rm(releasedDir, { recursive: true, force: true });
          }
        } catch {}
      }
    } finally {
      release();
      if (this.#provisionLocks.get(key) === tail) this.#provisionLocks.delete(key);
    }
  }

  /**
   * Force-remove a ticket's worktree, regardless of dirty state. This is the
   * terminal-ticket reclamation path (ticket 9f26f091 acceptance (d)): once a
   * ticket reaches a terminal column (done/merged) its work is committed to its
   * branch (or already merged), so the checkout is disposable — the branch ref
   * survives in the repo even after the worktree is gone. Unlike `sweep()`,
   * this deliberately ignores a dirty tree: in this repo a worktree goes
   * permanently dirty after any build (untracked tsbuildinfo / database dir),
   * so a dirty-preserving sweep would never reclaim a terminal ticket's tree.
   *
   * Matches the worktree dir whose last path segment is the ticket's `<ticket8>`
   * (tolerating a legacy `<ticket8>-<role>` suffix). A shared-pool slot
   * (`shared-<i>` / legacy `shared`) never matches — it is reused across tickets
   * and must survive a terminal ticket (규약 ⑥); instead this RELEASES the
   * shared-mode ticket's pool slot (idle-mark, lazy — the reset happens at the
   * next acquire). Confined to `<working_dir>/.awb/wt` so the agent's main
   * worktree is never touched. Returns the number of per_ticket worktrees
   * physically removed (a released pool slot is not a removal). Never throws.
   */
  async removeTicketWorktrees(opts: {
    baseWorkingDir: string;
    ticketId: string;
    repositoryResourceId?: string;
  }): Promise<number> {
    const { baseWorkingDir } = opts;
    const { ticketId } = opts;
    if (!baseWorkingDir || !ticketId) return 0;
    const ticket8 = String(ticketId).slice(0, 8);
    const legacyPrefix = `${ticket8}-`;
    let removed = 0;
    const managed = await this.#managedRepos(baseWorkingDir, opts.repositoryResourceId);
    for (const entry of managed) {
      await this.prune(entry.repo);
      const worktrees = await this.listWorktrees(entry.repo);
      let removedHere = 0;
      for (const w of worktrees) {
        if (!isUnder(w.path, entry.worktreesRoot)) continue;
        const seg = lastSegment(w.path);
        if (isSharedSlotSeg(seg)) continue;
        if (seg !== ticket8 && !seg.startsWith(legacyPrefix)) continue;
        const r = await git(entry.repo, ['worktree', 'remove', '--force', w.path]);
        if (r.ok || /is not a working tree|No such file/i.test(r.stderr)) {
          removed++;
          removedHere++;
          log(`[worktree] removed terminal-ticket worktree ${w.path}`);
        } else {
          log(`[worktree] terminal remove failed ${w.path}: ${r.stderr.trim()}`);
        }
      }
      if (removedHere > 0) await this.prune(entry.repo);
      await this.#releaseSharedSlot(entry.repo, entry.worktreesRoot, ticketId).catch(() => {});
    }
    return removed;
  }

  /**
   * terminal 진입 시 티켓 전용 Git 흔적을 보수적으로 정리한다.
   *
   * 판정은 **두 축**으로 나뉜다(ticket 7b384c10) — 하나로 뭉치면 Merging 가이드를
   * 정확히 지킨 worktree가 회수되지 않는다:
   *  1. **경로 소유권** → *checkout을 회수해도 되는가*. worktree 경로가 관리 루트
   *     아래 있고 마지막 세그먼트가 이 티켓의 8자 slug(또는 이 티켓이 lease한
   *     shared slot)일 때 확정된다.
   *  2. **branch 소유권** → *ref를 지워도 되는가*. full UUID가 들어간
   *     `ticket/<uuid>-*` ref만 인정해 8자 prefix 충돌로 남의 branch를 지우지
   *     않는다.
   *
   * 1번이 확정된 worktree를 branch **이름**으로 다시 거부하지 않는다.
   * `merging_workflow`가 step 3에서 base branch 체크아웃을, step 5에서 로컬
   * feature branch 삭제를 지시하므로 `[main]`(또는 detached) 위 티켓 worktree는
   * 절차를 정상 완료한 **기대 상태**이지 소유권 부정 근거가 아니다.
   *
   * 회수 조건은 어느 경우든 "이 checkout을 지워서 잃는 것이 없음"이다:
   *  - working tree가 clean해야 한다(공통).
   *  - branch 위 checkout은 worktree를 지워도 **ref가 저장소에 남으므로** 커밋이
   *     도달 불가가 되지 않는다. 공용 branch(main·base 등)는 이 루틴이 삭제
   *     대상으로 삼지도 않는다.
   *  - detached HEAD만 참조가 사라져 커밋이 도달 불가가 될 수 있으므로 base에
   *     포함된 커밋인지 확인한다.
   *  - 삭제 대상인 우리 티켓 branch는 기존대로 로컬·원격 양쪽 tip이 base에
   *     포함될 때만 지운다.
   * 우리 티켓 것도 공용 branch도 아닌 ref(=다른 티켓 branch) 위 checkout은
   * 그대로 보류·보고한다 — 다른 티켓이 작업 중인 checkout일 수 있다.
   */
  async cleanupTerminalTicketGit(opts: {
    baseWorkingDir: string;
    ticketId: string;
    baseBranch?: string;
    repositoryResourceId?: string;
  }): Promise<TerminalTicketCleanupReport> {
    const report: TerminalTicketCleanupReport = {
      removedWorktrees: 0,
      removedLocalBranches: [],
      removedRemoteBranches: [],
      remainingBranches: [],
      heldReasons: [],
    };
    if (!opts.baseWorkingDir || !opts.ticketId) return report;
    const ticket8 = String(opts.ticketId).slice(0, 8);
    // 8자 slug는 worktree 위치를 찾는 힌트일 뿐 브랜치 소유권 증명이 아니다.
    // UUID 전체가 들어간 ref만 현재 티켓의 브랜치로 인정해 prefix 충돌을 막는다.
    const branchPrefix = `ticket/${opts.ticketId}-`;
    const ownsBranch = (branch: string | null): branch is string =>
      !!branch && branch.startsWith(branchPrefix);
    const baseBranch = (opts.baseBranch || 'main').trim();
    const protectedBranches = new Set(['main', 'production.private', 'codex', baseBranch]);
    const managed = await this.#managedRepos(opts.baseWorkingDir, opts.repositoryResourceId);

    for (const entry of managed) {
      const blockedBranches = new Set<string>();
      const reportOnlyBranches = new Set<string>();
      let sharedSlotOwned = false;
      let sharedSlotReady = false;
      const ownedSharedSlots = new Map<string, string | null>();
      // 이름 스캔 결과가 아니라, 이번 실행에서 ticket 경로와 full UUID ref가 함께
      // 검증된 worktree의 브랜치만 삭제 경계 안에 둔다.
      const ownedBranches = new Set<string>();
      // 경로 소유권이 확정된 checkout을 **경로**로 키잉한다. 값은 그 checkout이
      // 물고 있는 우리 티켓 branch이며, base branch 위이거나 detached면 null이다
      // (회수 대상이지만 지울 ref는 없다).
      const ownedTicketWorktrees = new Map<string, string | null>();
      await git(entry.repo, ['fetch', '--prune', 'origin']).catch(() => {});
      const baseRef = `refs/remotes/origin/${baseBranch}`;
      const baseExists = await git(entry.repo, ['show-ref', '--verify', '--quiet', baseRef]);
      if (!baseExists.ok) {
        report.heldReasons.push(`base 브랜치 origin/${baseBranch}를 확인할 수 없음`);
        continue;
      }

      await this.prune(entry.repo);
      const worktrees = await this.listWorktrees(entry.repo);
      const registry = await this.#readRegistry(entry.worktreesRoot);
      // Windows의 `git worktree list`는 8.3 단축 경로(RUNNER~1)를 긴 경로로
      // 되돌려 출력할 수 있다. Node가 만든 관리 루트와 문자열만 비교하면 같은
      // 디렉터리도 소유권 밖으로 오판하므로, 존재하는 양쪽 경로를 native
      // realpath로 맞춘 뒤 경계를 검사한다. 해석 실패 시에는 원문 비교로
      // fail-closed 동작을 유지한다.
      const comparableWorktreesRoot = await fsp.realpath(entry.worktreesRoot).catch(() => entry.worktreesRoot);
      for (const w of worktrees) {
        const comparableWorktreePath = await fsp.realpath(w.path).catch(() => w.path);
        if (!isUnder(comparableWorktreePath, comparableWorktreesRoot)) continue;
        const seg = lastSegment(w.path);
        const sharedLease = isSharedSlotSeg(seg) ? registry.slots[seg] : undefined;
        const isOwnedSharedSlot = sharedLease?.active === true && sharedLease.ticketId === opts.ticketId;
        if (isSharedSlotSeg(seg) && !isOwnedSharedSlot) continue;
        if (!isSharedSlotSeg(seg) && seg !== ticket8 && !seg.startsWith(`${ticket8}-`)) continue;
        if (isOwnedSharedSlot) sharedSlotOwned = true;
        // 여기서부터 경로 소유권은 확정됐다. branch 이름은 "이 ref를 지워도
        // 되는가"만 가르며 회수 자격을 다시 뒤집지 않는다(ticket 7b384c10).
        const ownedBranch = ownsBranch(w.branch) && !protectedBranches.has(w.branch) ? w.branch : null;
        const label = w.branch ?? (w.head ? `detached ${w.head.slice(0, 8)}` : 'detached');
        if (!ownedBranch && w.branch && !protectedBranches.has(w.branch)) {
          // 우리 티켓 것도 저장소 공용 branch도 아니다 — 다른 티켓이 작업 중인
          // checkout일 수 있으므로 회수하지 않고 보고만 한다.
          report.heldReasons.push(`worktree 소유권 불일치: ${w.path} (${w.branch})`);
          reportOnlyBranches.add(w.branch);
          continue;
        }
        if (!w.branch && !w.head) {
          // HEAD를 읽지 못하면 유실이 없음을 증명할 수 없다 — fail-closed.
          report.heldReasons.push(`worktree HEAD 확인 불가: ${w.path}`);
          continue;
        }
        if (ownedBranch) ownedBranches.add(ownedBranch);
        const dirty = await git(w.path, ['status', '--porcelain', '--untracked-files=normal']);
        if (!dirty.ok || dirty.stdout.trim()) {
          report.heldReasons.push(`dirty worktree: ${w.path} (${label})`);
          if (ownedBranch) blockedBranches.add(ownedBranch);
          continue;
        }
        // 커밋 유실 가능성 확인. 공용 branch 위 checkout은 ref가 남아 회수만으로
        // 잃는 것이 없으므로 검사 대상이 아니다. detached HEAD는 참조가 사라지고,
        // 우리 티켓 branch는 아래에서 ref까지 지우므로 둘 다 base 포함을 요구한다.
        const mergeCheckRev = ownedBranch ?? (w.branch ? null : w.head);
        if (mergeCheckRev) {
          const merged = await git(entry.repo, ['merge-base', '--is-ancestor', mergeCheckRev, baseRef]);
          if (!merged.ok) {
            report.heldReasons.push(`미병합/고유 커밋: ${ownedBranch ?? `${w.path} (${label})`}`);
            if (ownedBranch) blockedBranches.add(ownedBranch);
            continue;
          }
        }
        if (isOwnedSharedSlot) {
          // 원격 ref가 로컬보다 전진했을 수 있으므로 여기서는 checkout을
          // 변경하지 않는다. 양쪽 ref의 병합 가능성을 모두 확정한 뒤에만
          // 아래에서 detach하여, 보류된 active lease와 실제 checkout이
          // 계속 같은 티켓 브랜치를 가리키게 한다.
          ownedSharedSlots.set(w.path, ownedBranch);
          continue;
        }
        // 일반 티켓 worktree도 원격 ref가 로컬보다 전진했을 수 있다.
        // 로컬·원격 ref의 병합 가능성을 모두 확정하기 전에는 경로를 제거하지
        // 않아, 어느 한쪽이라도 보존 대상일 때 checkout과 ref를 함께 보존한다.
        ownedTicketWorktrees.set(w.path, ownedBranch);
      }

      await this.prune(entry.repo);
      const localRefs = await git(entry.repo, ['for-each-ref', '--format=%(refname:short)', 'refs/heads/ticket/']);
      const remoteRefs = await git(entry.repo, ['for-each-ref', '--format=%(refname:short)', 'refs/remotes/origin/ticket/']);
      const localRefNames = localRefs.stdout.split(/\r?\n/).filter(Boolean);
      const remoteRefNames = remoteRefs.stdout.split(/\r?\n/).filter(Boolean);
      const localBranches = localRefs.stdout.split(/\r?\n/).filter((branch) => ownedBranches.has(branch));
      const remoteBranches = remoteRefs.stdout.split(/\r?\n/)
        .map((ref) => ref.replace(/^origin\//, '')).filter((branch) => ownedBranches.has(branch));

      // 로컬 삭제 전에 양쪽 ref의 병합 상태와 원격 tip을 함께 고정한다.
      // 어느 한쪽이라도 보존 대상이면 부분 삭제하지 않으며, 원격 삭제 시에는
      // 이 SHA를 lease로 사용해 검증 이후 전진한 ref를 지우지 않는다.
      const remoteTips = new Map<string, string>();
      for (const branch of ownedBranches) {
        if (protectedBranches.has(branch) || blockedBranches.has(branch)) continue;
        if (localBranches.includes(branch)) {
          const merged = await git(entry.repo, ['merge-base', '--is-ancestor', branch, baseRef]);
          if (!merged.ok) {
            report.heldReasons.push(`미병합/고유 커밋: ${branch}`);
            blockedBranches.add(branch);
          }
        }
        if (remoteBranches.includes(branch)) {
          const remoteRef = `refs/remotes/origin/${branch}`;
          const tip = await git(entry.repo, ['rev-parse', '--verify', remoteRef]);
          const merged = await git(entry.repo, ['merge-base', '--is-ancestor', remoteRef, baseRef]);
          if (!tip.ok || !merged.ok) {
            report.heldReasons.push(`미병합/고유 커밋: origin/${branch}`);
            blockedBranches.add(branch);
          } else {
            remoteTips.set(branch, tip.stdout.trim());
          }
        }
      }

      // 테스트 seam을 포함한 알려진 worktree 제거 불가 상태도 원격 ref를
      // 건드리기 전에 확정한다. 실제 제거는 원격 lease 삭제 성공 뒤 수행한다.
      const worktreeRemovalAllowed = new Map<string, boolean>();
      for (const [worktreePath, branch] of ownedTicketWorktrees) {
        if (branch && blockedBranches.has(branch)) continue;
        const injectedRemoval = this.#terminalCleanupHooks.removeWorktree;
        const allowed = injectedRemoval
          ? await Promise.resolve(injectedRemoval(entry.repo, worktreePath))
          : true;
        worktreeRemovalAllowed.set(worktreePath, allowed);
        if (!allowed) {
          report.heldReasons.push(`worktree 삭제 실패: ${worktreePath}`);
          if (branch) blockedBranches.add(branch);
        }
      }

      // 원격 ref는 checkout·로컬 ref보다 먼저 lease 조건부로 삭제한다.
      // 검증 직후 원격이 전진하면 이 단계에서 중단되므로 shared slot의
      // checkout과 active lease, 일반 티켓 worktree와 로컬 ref가 모두 유지된다.
      const remotelyDeleted = new Set<string>();
      for (const branch of remoteBranches) {
        if (protectedBranches.has(branch)) continue;
        if (blockedBranches.has(branch)) continue;
        const verifiedTip = remoteTips.get(branch);
        if (!verifiedTip) continue;
        await this.#terminalCleanupHooks.beforeRemoteDelete?.(branch);
        const deleted = await git(entry.repo, [
          'push',
          `--force-with-lease=refs/heads/${branch}:${verifiedTip}`,
          'origin',
          `:refs/heads/${branch}`,
        ]);
        if (deleted.ok || /remote ref does not exist|unable to delete/i.test(deleted.stderr)) {
          remotelyDeleted.add(branch);
        } else {
          report.heldReasons.push(`원격 브랜치 삭제 실패: origin/${branch}`);
          blockedBranches.add(branch);
        }
      }

      for (const [worktreePath, branch] of ownedSharedSlots) {
        if (branch && blockedBranches.has(branch)) continue;
        // warm build 산출물과 slot 자체는 보존하되, 원격 삭제까지 성공한 뒤
        // 검증된 base tip에서 detach해 원격 경쟁 실패 시 checkout을 보존한다.
        const detached = await git(worktreePath, ['switch', '--detach', baseRef]);
        if (!detached.ok) {
          report.heldReasons.push(`shared slot detach 실패: ${worktreePath} (${branch ?? 'detached'})`);
          if (branch) blockedBranches.add(branch);
          continue;
        }
        sharedSlotReady = true;
      }

      for (const [worktreePath, branch] of ownedTicketWorktrees) {
        if (branch && blockedBranches.has(branch)) continue;
        const removed = worktreeRemovalAllowed.get(worktreePath) !== false
          ? await git(entry.repo, ['worktree', 'remove', worktreePath])
          : { ok: false, stdout: '', stderr: '주입된 worktree 삭제 실패' };
        if (!removed.ok && !/is not a working tree|No such file/i.test(removed.stderr)) {
          report.heldReasons.push(`worktree 삭제 실패: ${worktreePath}`);
          if (branch) blockedBranches.add(branch);
          continue;
        }
        report.removedWorktrees++;
      }

      for (const branch of localBranches) {
        if (protectedBranches.has(branch)) continue;
        if (blockedBranches.has(branch)) continue;
        const deleted = await git(entry.repo, ['branch', '-d', branch]);
        if (deleted.ok || /not found/i.test(deleted.stderr)) report.removedLocalBranches.push(branch);
        else {
          report.heldReasons.push(`로컬 브랜치 삭제 실패: ${branch}`);
          blockedBranches.add(branch);
        }
      }
      for (const branch of remotelyDeleted) {
        if (!blockedBranches.has(branch)) report.removedRemoteBranches.push(branch);
      }

      // 이름은 삭제 권한으로 사용하지 않는다. 다만 full UUID 고아 ref와
      // legacy 8자 ref는 티켓과 연관 가능하므로 보존 사실을 보고한다.
      const isReportCandidate = (branch: string) =>
        branch.startsWith(branchPrefix) || branch.startsWith(`ticket/${ticket8}-`);
      for (const branch of localRefNames) {
        if (!ownedBranches.has(branch) && isReportCandidate(branch)) reportOnlyBranches.add(branch);
      }
      for (const ref of remoteRefNames) {
        const branch = ref.replace(/^origin\//, '');
        if (!ownedBranches.has(branch) && isReportCandidate(branch)) reportOnlyBranches.add(ref);
      }
      for (const branch of reportOnlyBranches) {
        report.heldReasons.push(`소유권 미확인 브랜치 보존: ${branch}`);
      }

      await git(entry.repo, ['fetch', '--prune', 'origin']).catch(() => {});
      const remainingLocal = await git(entry.repo, ['for-each-ref', '--format=%(refname:short)', 'refs/heads/ticket/']);
      const remainingRemote = await git(entry.repo, ['for-each-ref', '--format=%(refname:short)', 'refs/remotes/origin/ticket/']);
      report.remainingBranches.push(
        ...remainingLocal.stdout.split(/\r?\n/).filter((branch) => ownedBranches.has(branch)),
        ...remainingRemote.stdout.split(/\r?\n/)
          .filter((ref) => ownedBranches.has(ref.replace(/^origin\//, ''))),
        ...reportOnlyBranches,
      );
      if (sharedSlotOwned && sharedSlotReady && blockedBranches.size === 0) {
        await this.#releaseSharedSlot(entry.repo, entry.worktreesRoot, opts.ticketId).catch(() => {});
      }
    }
    report.heldReasons = [...new Set(report.heldReasons)];
    report.remainingBranches = [...new Set(report.remainingBranches)];
    return report;
  }

  /**
   * worktree 규약 ⑤: best-effort removal of a ticket's per-ticket QA/Security
   * run workspace (`<working_dir>/.awb/qa/<ticket8>`), invoked when the ticket is
   * ARCHIVED. Unlike a worktree this is a plain directory rm — a run workspace is
   * not a registered git worktree, it's a checkout the run provisioner clones
   * into, so `git worktree remove` doesn't apply. Strongly guarded: the target
   * is always `<runRoot>/<ticket8>` and must sit strictly UNDER
   * `<working_dir>/.awb/qa` (never the qa root itself, never anything outside
   * `.awb/`). Returns true when a dir was removed. Never throws.
   *
   * Note: run workspaces are keyed by QA scenario / security profile id (id8),
   * not by ticket id, so for an ordinary dev ticket this is a no-op (no such
   * dir). It's kept so archive reclaims everything a ticket could have used and
   * stays symmetric with removeTicketWorktrees.
   */
  async removeTicketRunWorkspace(opts: {
    baseWorkingDir: string;
    ticketId: string;
  }): Promise<boolean> {
    const { baseWorkingDir, ticketId } = opts;
    if (!baseWorkingDir || !ticketId) return false;
    const runRoot = runWorkspaceRootFor(baseWorkingDir);
    const ticket8 = String(ticketId).slice(0, 8).replace(/[^A-Za-z0-9._-]/g, '_');
    if (!ticket8) return false;
    const target = join(runRoot, ticket8);
    // Guard: only ever remove a dir strictly under `<working_dir>/.awb/qa`.
    if (!isUnder(target, runRoot)) return false;
    try {
      const st = await fsp.stat(target).catch(() => null);
      if (!st || !st.isDirectory()) return false;
      await fsp.rm(target, { recursive: true, force: true });
      log(`[worktree] removed archived-ticket run workspace ${target}`);
      return true;
    } catch (err: any) {
      log(`[worktree] run workspace remove failed ${target}: ${err?.message ?? err}`);
      return false;
    }
  }

  /**
   * Reclaim worktrees that are no longer in use. Conservative on purpose:
   * a worktree is removed only when ALL hold:
   *   - its dir lives under `<working_dir>/.awb/wt` (never the main worktree),
   *   - it is NOT a warm-pool slot (`shared-<i>` / legacy `shared`) — those are
   *     reused across tickets and their untracked warm build must survive (규약 ⑥),
   *   - its slug is NOT in `activeKeys` (no live session), and
   *   - its working tree is clean (no uncommitted / untracked changes) — a
   *     dirty tree means a pended ticket still has unsaved work; keep it.
   * Removing a clean, inactive worktree loses nothing recoverable: the branch
   * ref stays in the repo, and resume recreates the worktree on demand.
   * Returns the number of worktrees removed.
   */
  async sweep(opts: {
    baseWorkingDir: string;
    activeKeys: Set<string>;
  }): Promise<number> {
    const { baseWorkingDir, activeKeys } = opts;
    if (!baseWorkingDir) return 0;
    let removed = 0;
    for (const entry of await this.#managedRepos(baseWorkingDir)) {
      await this.prune(entry.repo);
      const worktrees = await this.listWorktrees(entry.repo);
      let removedHere = 0;
      for (const w of worktrees) {
        if (!isUnder(w.path, entry.worktreesRoot)) continue;
        const slug = lastSegment(w.path);
        if (isSharedSlotSeg(slug) || activeKeys.has(slug)) continue;
        const status = await git(w.path, ['status', '--porcelain']);
        if (!status.ok || status.stdout.trim() !== '') continue;
        const r = await git(entry.repo, ['worktree', 'remove', '--force', w.path]);
        if (r.ok) {
          removed++;
          removedHere++;
          log(`[worktree] swept idle clean worktree ${w.path}`);
        }
      }
      if (removedHere > 0) await this.prune(entry.repo);
    }
    return removed;
  }

  /**
   * `<working_dir>/.awb/act`와 `<working_dir>/.awb/chat` 아래에 있는 Action-Run +
   * 채팅방 작업폴더들의 읽기 전용 스냅샷(ticket 9fd27487) — 인스턴스 heartbeat용,
   * snapshotWorktrees의 일반-디렉터리 버전 형제 함수다(WorktreeSnapshotEntry의
   * 변형이 아니라 별도 타입으로 둔 이유는 RunWorkspaceSnapshotEntry 문서 참고).
   * Best-effort: 아직 존재하지 않는 루트는 해당 kind에 대해 그냥 []을 반환할 뿐,
   * 절대 throw하지 않는다.
   */
  async snapshotRunWorkspaces(baseWorkingDir: string): Promise<RunWorkspaceSnapshotEntry[]> {
    if (!baseWorkingDir) return [];
    const liveCwds = await this.#liveProcessCwds();
    const out: RunWorkspaceSnapshotEntry[] = [];
    for (const kind of ['action', 'chat', 'orchestration'] as const) {
      const root =
        kind === 'action'
          ? actionWorkspaceRootFor(baseWorkingDir)
          : kind === 'chat'
            ? chatWorkspaceRootFor(baseWorkingDir)
            : orchestrationWorkspaceRootFor(baseWorkingDir);
      const leaves = await this.#listAllRunWorkspaceLeaves(root);
      for (const leaf of leaves) {
        const path = join(root, leaf);
        out.push({
          path,
          kind,
          leaf,
          lastUsedAt: await this.#readLastUsedMarker(path),
          live: this.#isPathLive(path, liveCwds),
        });
      }
    }
    return out;
  }

  /**
   * Action-Run + 채팅방 작업폴더용 idle-GC(ticket 9fd27487, AC7): `.awb/act`/
   * `.awb/chat`에 대한 sweep()의 일반-디렉터리 버전. idle+clean이 되는 즉시
   * 제거되는 티켓 워크트리와는 다르다(브랜치는 어차피 base repo에 남아있으니까) —
   * 이 폴더들은 오직 동일한 action/room에 대한 여러 run/메시지에 걸쳐(run-keyed가
   * 아니라 action-keyed / room-keyed) warm 체크아웃/빌드를 유지하기 위해서만
   * 존재하므로, 아무도 디스패치하지 않는 그 순간 바로 회수해버리면 존재 의미가
   * 없어진다. RUN_WORKSPACE_IDLE_MS만큼 비활성 상태가 지속되고(모든
   * provisionRunWorkspace 성공 호출이 갱신하는 `.awb-last-used` 마커 — run-provisioner
   * 참고) 동시에 그 폴더 안에 살아있는 프로세스가 전혀 없을 때만(`/proc` 교차 확인,
   * reconcilePoolLeases가 쓰는 것과 같은 가드) 회수한다. 마커가 아예 없는 폴더는
   * (이 기능 이전부터 있었거나, 첫 프로비저닝이 마커를 찍기 전에 죽은 경우)
   * 디렉터리 자체의 mtime으로 폴백한다.
   *
   * leaf 목록은 root의 직계 자식이 아니라 #listRunWorkspaceLeaves가 재귀적으로
   * 찾은 실제 작업공간 디렉터리다 — 중첩 `workspace_folder`(예: `deploy/scripts`)는
   * provisionRunWorkspace가 그 최종 디렉터리에만 체크아웃하고 마커도 거기에만
   * 찍으므로, 직계 자식(`deploy`)만 보면 그 mtime(자식 git 활동으로는 갱신되지
   * 않는다)으로 폴백하다가 방금 쓰인 자손 폴더까지 통째로 삭제해버린다(리뷰 지적,
   * ticket 9fd27487).
   *
   * `deploy`와 `deploy/scripts`처럼 서로 접두 관계인 두 leaf가 동시에 존재할 때
   * (리뷰 지적, 2라운드) — 가장 깊은 leaf부터 처리해 얕은 leaf를 지우기 전에
   * 그 자손이 살아남았는지(fresh거나 live거나, 혹은 자손의 자손을 보호하느라
   * 남았거나) 먼저 안다. 자손이 하나라도 살아남았으면 조상은 자기 마커가
   * stale이어도 지우지 않는다 — `fsp.rm(recursive)`는 자손까지 통째로 지우므로,
   * 조상을 지우면서 방금 쓰인 자손을 함께 날려버리는 걸 막기 위해서다. 반대로
   * 자손이 이미 정리됐거나(또는 애초에 없었으면) 조상은 평소처럼 자기 마커
   * 기준으로 독립적으로 판정된다.
   */
  async sweepRunWorkspaces(baseWorkingDir: string): Promise<number> {
    if (!baseWorkingDir) return 0;
    const liveCwds = await this.#liveProcessCwds();
    const now = Date.now();
    let removed = 0;
    for (const kind of ['action', 'chat', 'orchestration'] as const) {
      const root =
        kind === 'action'
          ? actionWorkspaceRootFor(baseWorkingDir)
          : kind === 'chat'
            ? chatWorkspaceRootFor(baseWorkingDir)
            : orchestrationWorkspaceRootFor(baseWorkingDir);
      const leaves = await this.#listAllRunWorkspaceLeaves(root);
      leaves.sort((a, b) => b.split('/').length - a.split('/').length);
      const survived: string[] = [];
      for (const leaf of leaves) {
        const path = join(root, leaf);
        // 다중 방어책(defense-in-depth) — removeTicketRunWorkspace의 컨테인먼트 가드를 그대로 따른다.
        if (!isUnder(path, root)) continue;
        if (survived.some((s) => s.startsWith(`${leaf}/`))) {
          survived.push(leaf); // 살아남은 자손을 보호하기 위해 나도 지우지 않는다 — 위쪽 조상에도 전이된다
          continue;
        }
        if (this.#isPathLive(path, liveCwds)) {
          survived.push(leaf);
          continue;
        }
        let idleMs: number;
        const markerAt = await this.#readLastUsedMarker(path);
        if (markerAt) {
          const parsed = Date.parse(markerAt);
          idleMs = Number.isFinite(parsed) ? now - parsed : Infinity;
        } else {
          const st = await fsp.stat(path).catch(() => null);
          idleMs = st ? now - st.mtimeMs : Infinity;
        }
        if (idleMs < RUN_WORKSPACE_IDLE_MS) {
          survived.push(leaf);
          continue;
        }
        try {
          await fsp.rm(path, { recursive: true, force: true });
          removed++;
          await forgetRunWorkspaceLeaf(root, leaf);
          log(`[worktree] swept idle ${kind} workspace ${path} (idle ${Math.round(idleMs / 60000)}min)`);
        } catch (err: any) {
          log(`[worktree] sweep failed for ${kind} workspace ${path}: ${err?.message ?? err}`);
          survived.push(leaf); // 삭제 실패 — 조상이 이 경로를 함께 지우지 않도록 살아남은 것으로 취급
        }
      }
    }
    return removed;
  }

  /**
   * `#listRunWorkspaceLeaves`의 디렉터리-내용 휴리스틱과, provisionRunWorkspace가
   * 직접 기록한 manifest(`run-workspace-manifest.ts`)를 합집합(union)한 leaf
   * 목록(ticket 9fd27487, 리뷰 3라운드). 휴리스틱 단독으로는 조상이 `.git`을
   * 갖는 순간(체크아웃된 repo) 그 밑으로 절대 내려가지 않으므로, 그 안에
   * 독립적으로 프로비저닝된 중첩 workspace_folder 경계(예: `deploy`에 자기
   * repo가 있고 그 밑에 `deploy/scripts`가 별도로 프로비저닝된 경우)를 영원히
   * 못 찾는다 — manifest가 정확히 그 경계를 알고 있으므로 여기서 보충한다.
   * manifest가 아직 비어있는(이 기능 이전에 프로비저닝된) 폴더는 휴리스틱이
   * 그대로 커버하므로 기존 동작과 100% 호환이다. 두 소스 모두 같은 leaf를
   * 찾아내는 일반적인 경우(매니페스트 도입 이후)는 Set으로 중복 제거된다.
   */
  async #listAllRunWorkspaceLeaves(root: string): Promise<string[]> {
    const [heuristic, manifest] = await Promise.all([
      this.#listRunWorkspaceLeaves(root),
      readRunWorkspaceLeaves(root),
    ]);
    return Array.from(new Set([...heuristic, ...manifest]));
  }

  /**
   * root 아래 실제 작업공간 leaf들을 root-상대경로로 재귀 나열한다(리뷰 지적,
   * ticket 9fd27487). root의 직계 자식만 보면 안 되는 이유 — 중첩
   * `workspace_folder`(예: `deploy/scripts`, 기존 QA/security workspace_folder
   * 옵션이 이미 허용하던 값)는 provisionRunWorkspace가 `<root>/deploy/scripts`에
   * 직접 체크아웃하고 `.awb-last-used` 마커도 그 최종 디렉터리에만 남긴다. 직계
   * 자식만 보면 `deploy`를 leaf로 오인해 마커를 못 찾고 `deploy` 자체의
   * mtime(자식 git 활동으로는 갱신되지 않는다)으로 폴백하다가, 방금 쓰인
   * `deploy/scripts`가 안에 있어도 `deploy` 전체를 재귀 삭제할 수 있다.
   *
   * 그래서 하위 디렉터리 "만" 있고 그 외엔 아무것도 없는 순수 경로 세그먼트
   * 컨테이너만 한 단계씩 내려가고, `.git`/파일/마커가 하나라도 있거나 완전히
   * 빈 디렉터리를 만나면 그 디렉터리 자체를 leaf로 확정한다.
   *
   * 그런데 leaf로 확정됐다고 항상 거기서 멈추면 안 된다(리뷰 지적, ticket
   * 9fd27487 2라운드) — `workspace_folder='deploy'`(Action A)와
   * `workspace_folder='deploy/scripts'`(Action B)처럼 서로 접두(prefix) 관계인
   * 두 값이 **동시에** 유효해서, `deploy`도 자기 자신의 `.awb-last-used`를 갖고
   * 있으면서 그 안에 또 다른 독립 프로비저닝된 `deploy/scripts`가 중첩될 수
   * 있다. 그래서 "우리가 직접 마커를 남겼고(hasMarker) `.git`은 없는" 경우에만
   * — 즉 그 디렉터리가 우리 자신의 프로비저닝 산출물이라고 확신할 수 있을 때만
   * — leaf로 push한 뒤에도 계속 내려가 자손 leaf를 마저 찾는다. `.git`이 있는
   * 디렉터리는 절대 더 내려가지 않는다: 그 밑은 전부 체크아웃된 저장소 자신의
   * 콘텐츠이지 별개 workspace 경계일 수 없고, 서브디렉터리마다 파일이 있다는
   * 이유로 leaf 취급하면(예: `src/`, `node_modules/`) 실제로 살아있는 저장소의
   * 일부를 독립 sweep 대상으로 오인해 지워버리는, 원래 버그보다 더 나쁜 상황을
   * 만든다. 마커도 `.git`도 없이 파일만 있어서 leaf로 폴백 판정된 경우(스크래치
   * 콘텐츠 — 우리가 프로비저닝했다는 보장이 없다)도 같은 이유로 내려가지 않는다.
   */
  async #listRunWorkspaceLeaves(root: string, relDir = ''): Promise<string[]> {
    const abs = relDir ? join(root, relDir) : root;
    let entries;
    try {
      entries = await fsp.readdir(abs, { withFileTypes: true });
    } catch {
      return []; // 루트(또는 중간 경로)가 아직 없다는 뜻 — 아직 아무것도 프로비저닝되지 않음
    }
    const hasMarker = entries.some((e) => e.isFile() && e.name === '.awb-last-used');
    const hasGit = entries.some((e) => e.name === '.git');
    const isLeaf = hasMarker || hasGit || entries.length === 0 || entries.some((e) => e.isFile());
    const out: string[] = [];
    if (relDir && isLeaf) out.push(relDir);
    const shouldDescend = !isLeaf || (hasMarker && !hasGit);
    if (shouldDescend) {
      for (const sub of entries.filter((e) => e.isDirectory())) {
        if (sub.name === '.git') continue;
        const childRel = relDir ? `${relDir}/${sub.name}` : sub.name;
        out.push(...(await this.#listRunWorkspaceLeaves(root, childRel)));
      }
    }
    return out;
  }

  async #readLastUsedMarker(dir: string): Promise<string | null> {
    try {
      const raw = await fsp.readFile(join(dir, '.awb-last-used'), 'utf8');
      return raw.trim() || null;
    } catch {
      return null;
    }
  }

  #isPathLive(path: string, liveCwds: string[]): boolean {
    return liveCwds.some((cwd) => samePath(cwd, path) || isUnder(cwd, path));
  }
}

// ── path helpers (no realpath: worktree dirs may be transient) ──────────────

function normPath(p: string): string {
  // Strip trailing slashes; on win32 compare case-insensitively + unify seps.
  let s = String(p || '').replace(/[/\\]+$/, '');
  if (process.platform === 'win32') s = s.replace(/\\/g, '/').toLowerCase();
  return s;
}

function samePath(a: string, b: string): boolean {
  return normPath(a) === normPath(b);
}

function isUnder(child: string, parent: string): boolean {
  const c = normPath(child);
  const p = normPath(parent);
  return c === p ? false : c.startsWith(p + '/');
}

function lastSegment(p: string): string {
  const n = normPath(p);
  const idx = n.lastIndexOf('/');
  return idx >= 0 ? n.slice(idx + 1) : n;
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fsp.stat(p);
    return true;
  } catch {
    return false;
  }
}
