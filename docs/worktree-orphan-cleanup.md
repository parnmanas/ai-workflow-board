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
