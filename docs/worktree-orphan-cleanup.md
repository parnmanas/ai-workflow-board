# Worktree orphan cleanup runbook (worktree 규약 ⑤)

One-time sweep for git-worktree debris left behind **before** the `.awb/wt/`
convention. This is the operational counterpart to the automatic archive
reclamation (`EventDispatcher.#cleanupArchivedTicketWorkspace`) — that handles
newly-archived tickets going forward; this runbook cleans the pre-existing pile.

## What we're cleaning

Coding subagents used to run ad-hoc `git worktree add` for throwaway
compile-checks (`_compilecheck_*`) and ticket work (`_wt_*`), and the manager's
old layout put worktrees under `<home>/agents/<id>/worktrees/`. None of these
were removed. Observed debris (2026-07-09):

- **Linux host** (Rolf/codex, GameClient/txiv): ~51 orphans
- **Windows host** (Ralf/claude, GameClient/txiv): ~20 orphans

The manager now fixes every worktree at `<working_dir>/.awb/wt/<slug>` and
reclaims it at Done (terminal cleanup) and archive (규약 ⑤), so this is a
one-shot backfill, not a recurring job.

## The tool

`apps/agent-manager/scripts/cleanup-orphan-worktrees.mjs` — pure Node + `git`,
no build step, runs identically on Linux and Windows.

**Safe by default:**
- **Dry-run** unless `--execute` is passed — prints exactly what it *would* do.
- **Never removes** a worktree that is **dirty** (uncommitted/untracked changes)
  or that carries **unmerged commits** (e.g. a live `ticket/...` branch whose
  commits aren't in `origin/HEAD`). Those are logged `SKIP (dirty)` /
  `SKIP (unmerged)` so no in-flight work is lost.
- **Never removes** a worktree **touched within the last `--min-age-hours` hours**
  (default 24) — a live subagent checkout is touched constantly (checkout on
  spawn, file writes while running, `index`/`HEAD` on any git op), a stale orphan
  is not. Logged `SKIP (recently active)`. This is the guard that stops a
  **clean + merged idle** worktree (an idle reviewer, a just-merged strand, a
  freshly-spawned one) from slipping past the dirty/unmerged skips — those only
  protect worktrees that have *pending* work.
- **Never touches** the main worktree or anything under `.awb/wt/` · `.awb/qa/`
  (the current convention, including the reusable `.awb/wt/shared`).
- **Does NOT touch the manager's own worktree root** (`<home>/agents/*/worktrees/*`)
  by default — that is the manager's *current* live layout (the `.awb/wt/`
  migration is unfinished), not legacy debris. Sweeping it is opt-in
  (`--include-manager-root`) and **must be run with the manager stopped** (see
  below).

## Procedure

1. **Identify the repos.** For a GameClient agent, the repo is the agent's
   `working_dir` (or its repo root). You can pass the working_dir directly — the
   script resolves the repo root with `git rev-parse --show-toplevel`.

2. **Dry-run first** (default). Review the `WOULD-REMOVE` / `SKIP` lines:

   ```bash
   # Linux (Rolf)
   node apps/agent-manager/scripts/cleanup-orphan-worktrees.mjs \
     --repo /path/to/gameclient/txiv

   # Windows (Ralf) — from the manager checkout
   node apps\agent-manager\scripts\cleanup-orphan-worktrees.mjs ^
     --repo D:\path\to\gameclient\txiv
   ```

   Add `--all-non-awb` to widen the net from the known `_compilecheck_*` /
   `_wt_*` patterns to **every** non-main worktree outside `.awb/` (still gated
   by the freshness/dirty/unmerged skips). Use it only after eyeballing the
   default run.

3. **Verify the SKIP list.** Anything skipped as `dirty` or `unmerged` is
   intentional — a subagent may still owe a commit/push on that branch. Resolve
   those by hand (finish + merge, or confirm disposable and `git worktree remove
   --force` manually).

4. **Execute** once the dry-run looks right:

   ```bash
   node apps/agent-manager/scripts/cleanup-orphan-worktrees.mjs \
     --repo /path/to/gameclient/txiv --execute
   ```

   The script also runs `git worktree prune` to drop registrations whose dirs
   already vanished.

5. **Confirm.** `git -C <repo> worktree list` should now show only the main
   worktree plus any live `.awb/wt/` entries.

## Options

| flag | effect |
|------|--------|
| `--repo <path>` | Repo (or a dir inside it) to sweep. Repeatable. Required. |
| `--execute` | Actually remove. Omit for dry-run. |
| `--all-non-awb` | Treat every non-main, non-`.awb/` worktree as a candidate. |
| `--include-manager-root` | Also sweep the manager root `<home>/agents/*/worktrees/*`. **Live layout — run with the manager stopped.** Still freshness-gated. |
| `--min-age-hours <n>` | Skip candidates touched within the last `n` hours (default `24`). `--min-age-hours 0` disables the freshness guard. |
| `--base <ref>` | Ref an orphan's commits must be merged into to be removable (default: auto-detected `origin/HEAD`, else `origin/main`). |

Exit code is always `0` (best-effort maintenance); every decision is logged to
stdout, so capture it (`… | tee cleanup-$(date +%s).log`) for the audit trail.

## Sweeping the manager's own worktree root

The manager currently checks subagent worktrees out under
`<home>/agents/<id>/worktrees/<ticket>-<role>` (the `.awb/wt/` migration is still
in flight). Those are **live** — the agent-manager process holds them as running
subagents' working directories. A default sweep therefore **ignores** that root;
you must opt in with `--include-manager-root`.

Because a clean, merged, *idle* worktree (an idle reviewer waiting on a
bounce-back, a strand that just merged, one freshly spawned) is not protected by
the dirty/unmerged skips, removing it while the manager is running would
`git worktree remove --force` a live subagent's cwd out from under it → the
worker dies with **exit 143** (the exact death the `.awb/wt/` convention exists
to eliminate). Two guards keep this from happening:

1. **Stop the manager first.** With no subagents running, nothing is live.
2. The **freshness guard** (`--min-age-hours`, default 24) skips anything touched
   recently even if you forget step 1 — a just-stopped manager's worktrees are
   still "recently active", so re-run after they age out, or lower the threshold
   deliberately once you're sure the manager is down.

```bash
# 1. stop the agent-manager, then:
node apps/agent-manager/scripts/cleanup-orphan-worktrees.mjs \
  --repo /mnt/data/repositories/ai-workflow-board \
  --include-manager-root --min-age-hours 0        # dry-run first

# 2. review the WOULD-REMOVE list, then add --execute
```

## 잔여물 회수 주체 — 확정 (ticket 7b384c10)

"다른 에이전트 home 에 남은 티켓 worktree / branch 는 누가 회수하는가"에 대한
결정. 근거는 아래 네 경로의 실제 코드다 (경로는 repo root 기준).

| 경로 | 대상 범위 | 무엇을 회수하나 |
|---|---|---|
| **terminal cleanup** — `EventDispatcher.#cleanupTerminalTicketWorktrees` → `WorktreeManager.cleanupTerminalTicketGit` (`apps/agent-manager/src/lib/event-dispatcher.ts`) | 그 매니저가 관리하는 **모든** agent 의 `working_dir` (`managedAgentContexts.list()` 를 순회하며 `working_dir` 로 dedupe) | 티켓 worktree + 그 worktree 가 물고 있던 로컬/origin `ticket/<uuid>-*` ref |
| **archive 회수 (규약 ⑤)** — `EventDispatcher.#cleanupArchivedTicketWorkspace` → `WorktreeManager.removeTicketWorktrees` / `removeTicketRunWorkspace` | 위와 같은 범위 | 티켓 worktree + QA/Security run workspace. **branch ref 는 건드리지 않는다** |
| **10분 주기 sweep** — `apps/agent-manager/src/main.ts` 의 `sweepWorktrees()` → `WorktreeManager.sweep` | 위와 같은 범위 | idle + clean 인 worktree **만**. branch ref 는 건드리지 않는다 |
| **런북** — 이 문서의 `apps/agent-manager/scripts/cleanup-orphan-worktrees.mjs` | 운영자가 지정한 repo | 수동 |

즉 **ref 를 지우는 자동 경로는 terminal cleanup 하나뿐**이고, 나머지 셋은 전부
checkout 만 회수한다.

### 결정

1. **회수 주체는 "그 home 을 관리하는 agent-manager 인스턴스"다.** assignee 세션도
   AWB 서버도 아니다. terminal cleanup 을 여는 `board_update` 는 board 스코프
   브로드캐스트다 — `apps/server/src/modules/events/event-registry.ts` 의
   `filter: (env, id) => !id.boardId || env.scope.board_id === id.boardId` 는
   인스턴스도 agent 도 타깃하지 않는다. 그래서 연결된 **모든** 매니저가 같은
   terminal 이벤트를 받고, 각자 자기 관리 범위의 home 을 정리한다. 따라서 같은
   매니저 아래 여러 agent home 이 있으면 그 전부가 이미 커버된다 — 이건 구멍이
   아니다.

2. **구멍은 "terminal 이벤트 시점에 연결돼 있지 않던 매니저의 home"이다.
   여기에는 담당 주체가 없다 — 이것이 확정된 결론이며, 새 주체를 만들지 않는다.**
   terminal 이벤트는 재생되지 않으므로 그 매니저가 나중에 떠도 지나간 티켓을 소급
   정리하지 않는다 — 매니저는 재연결 때 `Last-Event-ID` 를 보내지만 AWB 서버(NestJS
   `@Sse`, 라이브 rxjs Subject)는 `id:` 를 찍지도 그 헤더를 읽지도 않는다
   (`apps/agent-manager/src/lib/event-stream.ts` 의 `#lastEventId` 주석 참조).
   남는 안전망은 10분 sweep 과 archive 회수뿐이고 둘 다 worktree 만 회수하므로,
   **그 범위의 잔여 `ticket/<uuid>-*` ref 는 자동 회수 대상이 아니다.** 운영자가
   위 런북으로 처리한다.

   새 주체를 만들지 않는 이유: 원격 호스트의 파일시스템에 접근할 수 있는 주체가
   구조상 없다. AWB 서버는 매니저에게 명령만 보낼 수 있고, assignee 세션은 자기
   worktree 밖을 건드리지 않는 것이 worktree 규약의 전제다. 남은 선택지는
   "매니저 부팅 시 과거 terminal 티켓 전수 스캔"인데, 비용이 잔여물의 실제 피해
   (디스크 몇 GB, 운영자 런북으로 회수 가능)에 비해 크다.

3. **따라서 `로컬 브랜치 삭제 실패: ticket/<uuid>-…` 알림은 그 자체로 조치
   대상이 아니다.** 알림을 낸 매니저가 자기 범위에서 실패했다는 뜻이므로 그 home
   을 확인하면 되고, 자기 repo 에서 `git branch --list` / `git ls-remote` 가 둘 다
   비어 있다면 **다른 매니저 범위의 사본**을 가리키는 관측 보고다. 티켓 담당자가
   할 수 있는 일은 없다.

### 회수되는 checkout 의 형태 (ticket 7b384c10)

`merging_workflow` 는 step 3 에서 base branch 체크아웃을, step 5 에서 로컬 feature
branch 삭제를 지시한다. 그래서 정상 완료한 티켓 worktree 는 `[main]`(또는
detached) 상태로 남는다 — 이건 **기대 상태이지 소유권 부정 근거가 아니다.**
terminal cleanup 은 경로 소유권과 branch 소유권을 분리해 판정한다: 경로가
확정되면 checkout 을 회수하고, ref 삭제는 full UUID 가 들어간 `ticket/<uuid>-*`
에만 허용한다. clean 이 아니거나, detached HEAD 가 base 에 포함되지 않거나,
우리 티켓 것도 공용 branch 도 아닌 ref 위에 있으면 그대로 보류한다.
