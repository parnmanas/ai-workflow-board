# Agent Manager — Reference

`apps/agent-manager/` is the standalone subagent runner that drives CLI-based
AI agents (Claude, Codex, Gemini, custom) on behalf of an AWB workspace. It
replaces the daemon that used to live inside the
`@parnmanas/awb` Claude plugin (≤ v0.39).

For an installation walkthrough, see
[`apps/agent-manager/README.md`](../apps/agent-manager/README.md). This document is the
internals / operations reference.

## Responsibilities

| Concern                                  | Owner                                |
|------------------------------------------|--------------------------------------|
| stdio MCP forwarding (Claude CLI → AWB)  | `claude-plugins/ai-workflow-board/proxy.mjs` (separate package) |
| SSE event delivery to subagents          | `agent-manager` `EventStream` + `EventDispatcher` |
| Subagent lifecycle (spawn / drain / TTL) | `agent-manager` `SubagentManager`    |
| Persistent ticket / chat sessions        | `agent-manager` `TicketSessionManager`, `ChatSessionManager` |
| CLI process supervision                  | `agent-manager` `ManagedAgentRegistry` + cli-adapters |
| Instance heartbeat for AWB dashboard     | `agent-manager` `InstanceHeartbeat`  |
| Pairing + agent identity issuance        | AWB server `apps/server/src/modules/agent-manager/` |

The plugin is now a pure stdio↔HTTP MCP forwarder. It does **not** consume the
SSE stream and does **not** spawn subagents.

## Process layout

```
awb-agent-manager (single Node process per host/instance)
├── EventStream           SSE consumer; reconnect with backoff
├── EventDispatcher       routes incoming events by type
│   ├── agent_trigger        → TicketSessionManager (dispatch ticket subagent)
│   ├── board_update         → TicketSessionManager (persistent ticket session)
│   ├── comment_mention      → TicketSessionManager (mention fan-out)
│   ├── chat_request         → ChatSessionManager (ticket-chat session)
│   ├── chat_room_message    → ChatSessionManager (persistent room session)
│   ├── fs_request           → FsBrowser (reverse-RPC fs handler)
│   └── agent_manager_command → AgentManagerCommandHandler (admin RPC)
├── ManagedAgentRegistry  in-memory state of CLI children (status, pid, cwd)
├── InstanceHeartbeat     POST /api/agent/instance-heartbeat every 30s
├── PresenceHeartbeat     POST /api/agent/presence (online/offline marker)
└── AgentLockfile         PID-owned exclusion at $AWB_AGENT_MANAGER_HOME/agent.lock
```

## Configuration

### Paths

`AGENT_MANAGER_HOME` resolves in this order (first hit wins):

1. `$AWB_AGENT_MANAGER_HOME`
2. `%APPDATA%\awb-agent-manager` (Windows only)
3. `$XDG_CONFIG_HOME/awb-agent-manager`
4. `~/.config/awb-agent-manager`

Inside that directory:

| File                    | Purpose                                              |
|-------------------------|------------------------------------------------------|
| `config.json`           | URL, API key, workspace_id, agent_id, CLI selection  |
| `agent.json`            | Cached agent identity (resolved via MCP whoami)      |
| `agent.lock`            | PID-owned mutual exclusion                           |
| `subagents.json`        | Persisted subagent state (resumable across restarts) |
| `subagents/`            | Per-subagent working directories                     |
| `instances/`            | Per-instance heartbeat state (multi-instance hosts)  |
| `agent-manager.log`     | Append-only log file                                 |

### Legacy import

On first run, agent-manager copies
`~/.claude/channels/awb/{config,agent}.json` into the new location if no
`config.json` exists yet. A `MIGRATED-TO-AGENT-MANAGER.txt` marker is dropped
in the legacy directory so subsequent runs skip the import. Legacy files are
**never deleted** — the claude-plugin proxy still reads them for stdio MCP
forwarding.

### Schema

```ts
interface AwbConfig {
  url: string;                 // AWB base URL, no trailing slash
  apiKey: string;              // bearer issued by /api/agent-manager/pair/redeem
  workspace_id?: string;       // workspace this manager binds to
  agent_id?: string | null;    // manager's Agent identity (auto-resolved if null)
  cli?: 'claude' | 'codex' | 'antigravity' | string;  // default 'claude'
  delegation?: {
    enabled?: boolean;         // master switch for SubagentManager
    max_concurrent_subagents?: number;
    // …other tunables documented in lib/constants.ts → DELEGATION_DEFAULTS
  };
}
```

## Pairing & bootstrap

Pairing is the only supported way to provision a fresh manager. The flow:

1. **Mint** — admin POSTs `/api/admin/agent-manager/pair` (workspace-scoped,
   ttl 10 min, response includes raw token + 6-char display code, shown once).
2. **Redeem** — manager POSTs `/api/agent-manager/pair/redeem` with the token
   or display code plus a stable `instance_id`. AWB returns:
   - `api_key` — bearer for subsequent requests
   - `agent_id` — Agent identity created for this manager (`type='manager'`)
   - `workspace_id` — bound workspace
3. **Persist** — the manager writes the response into `config.json` and
   starts. (At present this is a manual write — see README.)

Tokens become single-use after redemption (`redeemed_at` set,
`redeemed_by_instance_id` recorded). Each redemption creates a new Agent row
to keep multi-host setups independently revocable.

Display code alphabet: `ABCDEFGHJKLMNPQRSTUVWXYZ23456789` (no
`0/O/1/I/l`).

## SSE event contract

Events arrive on the AWB SSE stream (`GET /api/events/stream`, scoped by API
key via `?token=` or `Authorization: Bearer`). The dispatcher maps `event.type`
to the right handler:

| `type`                  | Handler                        | Notes                                                             |
|-------------------------|--------------------------------|-------------------------------------------------------------------|
| `agent_trigger`         | `TicketSessionManager`         | Dispatches into the ticket session; one-shot spawn falls back to `SubagentManager` |
| `board_update`          | `TicketSessionManager`         | Forwards board/ticket updates into the long-lived ticket session  |
| `comment_mention`       | `TicketSessionManager`         | Mention fan-out into the ticket session (spawn fallback)          |
| `chat_request`          | `ChatSessionManager`           | Forwards into the ticket-chat session (spawn fallback)            |
| `chat_room_message`     | `ChatSessionManager`           | Forwards into the chat-room session (spawn fallback)             |
| `fs_request`            | `FsBrowser`                    | Reverse-RPC: lists / reads files in scoped paths                  |
| `agent_manager_command` | `AgentManagerCommandHandler`   | Admin → manager RPC (see below)                                   |

The dispatcher switches on exactly these seven `type` strings; every other event
the server emits (`agent_instance_update`, `agent_typing`, `consensus_update`,
`server_meta`, `ping` keepalive, …) hits the `default` branch and is silently
dropped. Instance heartbeat is an **outbound** `POST /api/agent/instance-heartbeat`
from the manager, not an inbound SSE event.

### Multi-holder fan-out & consensus (T2–T7, manager ≥ 0.10.0)

- 한 티켓의 routing role 은 서로 다른 holder(agent/user) 여럿이 공동 보유할 수
  있고, 컬럼 이동 시 서버가 **홀더별로 `agent_trigger` 를 1건씩 팬아웃**한다.
  한 manager 가 공동 홀더 agent 를 여럿 소유하면(멀티테넌시) 같은 티켓의
  트리거를 여러 번 — 각기 다른 `actor_name`(=agent id) 으로 — 받는 것이 정상.
- **v0.10.0**: ticket 세션 키가 `${ticketId}:${role}` → `${ticketId}:${role}:${agentId}`
  로 agent 차원을 포함한다. 이전에는 두 번째 홀더의 트리거가 첫 홀더의
  살아있는 세션으로 follow-up 접힘되어 자기 identity 로 `record_agreement` 를
  못 해 합의가 데드락됐다. one-shot 경로의 (ticket, role) single-flight dedup
  도 같은 이유로 agent 차원을 본다(어느 한쪽 agent 미상이면 레거시 collapse
  유지). 보드 업데이트/멘션 포워딩은 티켓 단위 스캔이라 공동 홀더 세션
  전체에 브로드캐스트된다.
- `metadata.consensus_vote` 가 스탬프된 투표 코멘트는 서버가 comment 팬아웃을
  억제한다(승인 echo 루프 방지) — manager 쪽 처리 불필요.
- `consensus_update` SSE 이벤트는 **user-identity 전용**(웹 UI 합의 패널)이라
  event-registry 필터에서 agent 스트림으로는 오지 않는다 — manager 계약 밖
  (의도적 미전달; 게이트 판정은 move 시점에 서버가 재계산). dispatcher 는
  미지 타입을 조용히 drop 하므로 향후 새어 들어와도 무해하다.
- `agent_trigger` payload 자체는 T1~T7 에서 무변경.

### `agent_manager_command` payload

```ts
interface AgentManagerCommand {
  instance_id: string;     // target manager instance (drop if not us)
  command_id: string;      // ack key
  command: 'spawn_agent' | 'stop_agent' | 'restart_agent'
         | 'set_working_dir' | 'reload_config'
         | 'update_plugins' | 'refresh_mcp_config' | 'pull_working_dir'
         | 'update_manager' | 'restart_manager';
  agent_id: string;        // server fans out scoped to the manager identity;
                           // this is the MANAGER's id, not the target managed
                           // agent. The target travels in args.agent_id.
  args?: {
    agent_id?: string;     // REQUIRED for *_agent / set_working_dir / maintenance verbs;
                           // identifies the managed-agent target on this manager
    working_dir?: string;
    cli?: 'claude' | 'codex' | 'antigravity' | 'custom';
  };
}
```

Each handler returns an ack via
`POST /api/agent-manager/command/ack` with shape
`{ command_id, status: 'ok' | 'error', detail: string }`. The ack travels
over REST (not SSE) so it is not affected by the SSE reconnect loop.

The server-side ack endpoint enforces:

- `command_id` must match a pending dispatch (in-memory ledger, 10-minute TTL).
  Unknown / expired ids → `410 Gone`.
- The API key making the ack request must belong to the same manager Agent
  identity the dispatch was scoped to. Mismatch → `403 Forbidden` and the
  ledger record is restored so the legitimate manager can still ack.
- Each `command_id` is one-shot: a successful ack consumes the ledger
  entry. Replays land on `410 Gone`.

| Command              | Status                          |
|----------------------|---------------------------------|
| `set_working_dir`    | Real — registry update + heartbeat |
| `reload_config`      | Real — re-reads `config.json`. URL/apiKey/cli changes flagged disruptive |
| `spawn_agent`        | Real — provisions apiKey, writes mcp-config, registers context (ST-6) |
| `stop_agent`         | Real — drops context + erases on-disk secrets                          |
| `restart_agent`      | Real — `stop` + `spawn` composition                                    |
| `update_plugins`     | Real — `git pull --ff-only` on every claude marketplace under `<cli-home>/plugins/marketplaces/*` |
| `refresh_mcp_config` | Real — rewrites `mcp-config.json` with current AWB url + existing apiKey |
| `pull_working_dir`   | Real — `git pull --ff-only` inside `Agent.working_dir` (30s timeout)    |
| `update_manager`     | Real — `git pull` + `npm install` + build, then detached re-exec       |
| `restart_manager`    | Real — re-exec in place (no pull/install/build); takes over the lockfile |

## Harness config (per-board CLI flags)

Boards and workspaces can carry a `harness_config` JSON (workspace = default,
board = key-level override; resolved server-side by
`apps/server/src/common/harness-config.ts`). The resolved object rides on
every `agent_trigger` event as `harness_config` and is applied at subagent
spawn time (ticket e9c7a896):

| Key                    | Claude-family flag                                | Other CLIs |
|------------------------|---------------------------------------------------|------------|
| `system_prompt_append` | appended to the role prompt in `--append-system-prompt` (never replaces it) | warn + skip |
| `allowed_tools`        | appended to the AWB baseline in `--allowedTools` (baseline `mcp__awb__*,mcp__host__*` always survives) | warn + skip |
| `disallowed_tools`     | `--disallowedTools`                               | warn + skip |
| `model`                | `--model` — beats the per-agent `Agent.model` default | `--model` (codex / antigravity support it; deepseek also mirrors it into `ANTHROPIC_MODEL` so flag and env agree) |
| `permission_mode`      | `--permission-mode`, REPLACING `--dangerously-skip-permissions` (the skip flag pins bypassPermissions, so passing both would no-op the mode) | warn + skip |

Rules and constraints:

- **Null-safe**: a missing/empty/malformed `harness_config` produces exactly
  the pre-harness argv — boards without a harness see zero behavior change.
- **Graceful skip**: keys a CLI can't express are logged
  (`harness keys skipped (cli=… can't express them)`) and dropped; the spawn
  itself never fails because of a harness.
- **Session-creation only**: persistent ticket sessions get the harness when
  the CLI process is spawned. Follow-up turns into a live pid keep the
  harness the session was born with — CLI flags can't change mid-process.
  An edited board harness takes effect on the next fresh session (new
  ticket, server `force_respawn`, or an agent-requested session split).
- **Operator visibility**: every applied harness logs one line at spawn —
  `harness applied: … model=… permission_mode=… allowed_tools=+N …` — which
  is the acceptance check for "did my board harness reach the CLI".
- `permission_mode` values are free text on the wire; the claude CLI
  validates them itself. A mode that blocks tool prompts in non-interactive
  runs (`default`, `plan`) is an operator choice, not something the manager
  second-guesses.

## Environment provisioning (per-board working environment)

Boards and workspaces can carry an `environment_config` JSON (workspace =
default, board = key-level override; resolved server-side by
`apps/server/src/common/environment-config.ts`). At dispatch the server merges
the two layers, expands each repository's `resource_id` into a concrete
url/branch (workspace-scoped `Resource` lookup), and ships the resolved object
on every `agent_trigger` event as `environment_config` (ticket 354d336b).

`EventDispatcher.handleTrigger` runs `EnvironmentProvisioner.provision(...)`
**before either spawn path** (persistent ticket-session or one-shot subagent),
so the agent never starts work in an unprepared environment:

1. **Repositories** — each entry is cloned into `<agent home>/<target_dir>`
   (agent home = `<AWB_AGENT_MANAGER_HOME>/agents/<agent_id>/`). An existing
   clone is updated non-destructively (`git fetch --all --prune`, optional
   `git checkout <branch>`, then `git pull --ff-only` — a diverged tree is left
   as-is, never clobbered). `post_clone_commands` run once, only on a fresh
   clone, inside the repo dir.
2. **setup_commands** — run once in the agent home, with `env_vars` injected.
3. **env_vars** — non-secret `KEY=VALUE` pairs. Injected into the spawned CLI's
   process environment on **every** dispatch (they are process env, not
   persisted on disk), merged right after `process.env` but before
   `AWB_API_KEY` / cli-home / per-agent credential / harness env so those
   always win. Secrets stay on the per-agent credential path, not here.

Idempotency, concurrency, failure:

- **Fingerprint marker** — the resolved config is hashed (sha256, folding in
  `version`); a success marker lands at `<agent home>/env/<fingerprint>.json`.
  A matching marker → skip (environment already prepared). A changed config (or
  a bumped `version`) → new fingerprint → re-provision. An agent serving two
  boards with different configs keeps two markers.
- **Concurrency** — an in-flight `(agent, fingerprint)` provision is shared, so
  two near-simultaneous triggers never clone into the same dir twice.
- **Failure aborts the dispatch** — a clone / fetch / setup-command failure
  returns `ok=false` with **no** success marker; the dispatch is dropped (the
  subagent is never spawned) and the error is posted as a ticket comment
  (`⚠️ 환경 프로비저닝 실패 …`) so it surfaces in the activity feed. A
  `<fingerprint>.failed.json` cooldown marker (~5 min) suppresses re-clone /
  re-comment churn against the supervisor's re-push cadence; it is cleared on
  the next success.
- **Null-safe**: a missing/empty/malformed `environment_config` produces
  exactly the pre-provisioning behaviour — boards without one spawn as before.
- **Additive to working_dir** — provisioning does NOT repurpose the operator's
  `working_dir` / worktree flow; repos land under the agent home alongside it.

## Heartbeats

Two heartbeats run on independent timers:

- **InstanceHeartbeat** — `POST /api/agent/instance-heartbeat` every 30s with
  `{ mode, agent_ids, working_dirs, paired_at, active_worktrees, ... }`. AWB
  stores the latest payload and surfaces it in the admin dashboard.
  `mode='manager'` triggers the additional ManagedAgents UI section.
  `active_worktrees[]` (ticket 72fc244f) is a best-effort snapshot of every live
  worktree under each supervised agent's `<working_dir>/.awb/wt/`, joined to the
  warm-pool lease registry (`.pool-leases.json`): each row carries
  `{ working_dir, path, slot, mode, ticket_id, branch, state, live }` where
  `state` is `allocated` / `idle` / `orphaned` (an `orphaned` shared slot is an
  active lease past the reclaim grace with no live owner — the exact leak
  `reconcilePoolLeases` reclaims). The server joins `ticket_id → ticket_title`
  on the admin instance-list fetch; the "Live worktrees" panel renders shared
  pool slots as an explicit `slot → current task` map. QA/Security run clones
  (`.awb/qa/<id8>`) are separate checkouts, not repo worktrees, so they never
  appear here.
- **PresenceHeartbeat** — `POST /api/agent/presence`. Coarser ping that drives
  the agent's online/offline indicator.

If the manager exits cleanly it sends a final heartbeat with
`mode='offline'`. A crash leaves the prior heartbeat in place; the dashboard
will mark the instance stale based on `last_seen`.

## Lockfile

`$AWB_AGENT_MANAGER_HOME/agent.lock` holds the running manager's PID and
start time. On startup:

1. If no lock — create one and continue.
2. If a lock exists and the PID is alive — refuse to start (exit 1) unless
   `--force` is passed.
3. If the PID is dead — take it over.

The lockfile is also inspected for the legacy `~/.claude/channels/awb/agent.lock`
to refuse running concurrently with the old plugin daemon.

## Worktree isolation (per-(ticket,role) cwd)

A managed agent has a single `working_dir`, and historically every
`(ticket, role)` session it ran shared that cwd. The current git branch is
global state of that cwd, so a `git checkout` in one ticket's session bled
into another ticket's session on the same agent whenever focus flipped
(pend/unpend, preemption, idle-reap → respawn) — commits could land on the
wrong branch (ticket `9f26f091`).

`WorktreeManager` (`lib/worktree-manager.ts`) gives each `(ticket, role)` its
own dedicated git worktree:

- `EventDispatcher.handleTrigger` rewrites the managed agent's
  execution-context `cwd` to `<MANAGER_HOME>/agents/<id>/worktrees/<ticket8>-<role>`
  via `WorktreeManager.resolveCwd()` before any spawn. Both the persistent
  ticket-session and the one-shot subagent fallback read `agentContext.cwd`,
  so the single rewrite covers both. The follow-up *reuse* path doesn't
  re-spawn, so it stays in the worktree the live child already holds.
- The worktree dir is deterministic per `(ticket, role)`, so a fresh spawn
  after an idle-reap / unpend **reattaches** to the same tree — the branch and
  any uncommitted work survive, and resume continues where it left off.
- New worktrees are created `--detach`ed at the base repo's current HEAD; the
  agent's column workflow then creates/attaches its own `ticket/<id>-<slug>`
  branch inside the isolated worktree (a branch can only be checked out in one
  worktree, so detached-create avoids the "already checked out" conflict).
- **Base repo becomes a reference**: when the first worktree is created, the
  manager detaches the base `working_dir`'s HEAD (same commit, no file
  changes). The column guide's first step is `git checkout <base-branch>` —
  a branch can be checked out in only one worktree, so if the base tree still
  sat on the base branch that checkout would fail. Detaching frees the branch
  so every ticket worktree can check it out per the documented flow. Side
  effects: the base `working_dir` shows a detached HEAD (expected — agents
  work in worktrees, not the base). The `pull_working_dir` maintenance verb
  detects the detached base and runs `git fetch --all --prune` instead of
  `git pull --ff-only` (which can't run on a detached HEAD) — refreshing the
  `origin/<base>` refs the ticket worktrees branch off, which is the useful
  work there. No base/chat session assumes the base repo is on a branch:
  base/chat sessions only spawn a CLI with `cwd = working_dir` to answer chat,
  and self-update operates on the *manager's own* repo, not the agent's
  `working_dir` — so a detached base is inert for every flow except the now
  detached-aware `pull_working_dir`.
- **Concurrent base-branch checkout**: the column guide's first step is
  `git checkout <base-branch>`, and a branch can be checked out in only one
  worktree at a time. With `subagentConcurrency` ≥ 2 two tickets can transiently
  both want the base branch checked out, and the second `checkout <base>` then
  fails with *"<base> is already used by worktree …"*. The detached base frees
  the branch for the first taker, and the documented flow leaves the base
  branch immediately (`checkout -b ticket/…`), so the window is small and
  cap=1 (the default) never hits it. Agents that hit the collision should
  branch directly off the remote-tracking ref instead —
  `git checkout -b ticket/<id>-<slug> origin/<base>` never claims the local
  base branch and so never collides.
- **Fallback**: when `working_dir` is not a git repo, or `git worktree add`
  fails (old git, disk error), `resolveCwd` returns the shared base cwd with
  `isWorktree=false` and the legacy single-cwd behavior applies.
- **Cleanup** happens on two paths:
  - *Terminal tickets* — when a ticket lands in a terminal column (done/merged),
    `handleBoardUpdate` reads the freshly-stamped `Ticket.terminal_entered_at`
    and calls `WorktreeManager.removeTicketWorktrees()` to force-remove **all**
    of that ticket's per-role worktrees **regardless of dirty state**. This is
    deliberate: the work is committed to its branch (or already merged), so the
    checkout is disposable (the branch ref survives). It also can't rely on the
    sweep below — in this repo a worktree goes permanently dirty after any build
    (untracked `tsbuildinfo` / `database/`), so a dirty-preserving sweep would
    never reclaim a done/merged ticket's tree.
  - *Idle sweep* — a 10-minute sweep (`WorktreeManager.sweep`) reclaims
    worktrees that have no live session **and** a clean working tree. Dirty
    trees (a pended ticket with unsaved work) and worktrees with a live session
    are kept. Removing a clean worktree loses nothing recoverable — the branch
    ref stays in the repo and resume recreates the worktree on demand.

Gated by `delegation.worktreeIsolation` (default `true`); set `false` to keep
the legacy shared-cwd path. This is an agent-manager-internal change — no SSE
event contract changed.

## Shared worktree warm pool (`worktree_mode = shared`)

Since 규약 ④/⑥ every worktree lives inside the agent's `working_dir` under
`<working_dir>/.awb/wt/<slug>` (auto-registered in `.gitignore`). The board's
`worktree_mode` picks the slug scheme:

- **`per_ticket`** (default) — `slug = <ticket8>`, one dedicated worktree per
  ticket, removed when the ticket lands terminal/archived.
- **`shared`** — a **warm pool** of slots `shared-0 … shared-<N-1>`, where
  **`N` = the board's Agent concurrency** (`max_concurrent_tickets_per_agent`,
  flattened onto the trigger event). The pool trades per-ticket isolation for a
  warm incremental build cache that survives ticket→ticket handover.

Set the mode on the board (Board Settings → *폴더·Worktree 규약*); its **Agent
concurrency** field is what sizes the pool. QA/Security runs never touch this
pool — they get a separate `.awb/qa/<id8>` clone (run-provisioner).

### Lease / release

- A ticket **leases an idle slot** for its whole lifecycle. The lease is keyed
  by ticket id, so every role hop and every resume (idle-reap → respawn,
  pend/unpend) **reattaches to the same slot** — the branch and any uncommitted
  work survive, exactly like the per-ticket path.
- **Release is lazy** — reaching a terminal column (or archive) only *idle-marks*
  the lease, it does not clean the checkout. A worker that dies uncleanly
  (exit-143 mid-build, the common case) never gets to run a tidy handback, so
  cleanup can't depend on one.
- The pool is **protected from the sweeps**: neither the idle sweep nor the
  terminal-ticket removal ever deletes a `shared-<i>` slot (guarded by
  `isSharedSlotSeg`) — deleting it would wipe the warm build the pool exists to
  keep.

### Reset-on-acquire (not on-release)

The **next** lease resets the slot before handing it over: a `git reset --hard`
to the base tip returns **tracked source** to base while **untracked build
artifacts** (`node_modules`, Unity `Library/`, `tsbuildinfo`, out-of-tree
outputs) survive, so the incoming ticket builds incrementally (warm). The
manager never runs `git clean -fdx` — that would defeat the whole point.
Resetting on *acquire* rather than on *release* is deliberate: it makes cleanup
robust to workers that exit uncleanly, since the tidy-up is owned by the taker,
not the leaver.

### No starvation — the concurrency gate queues the excess

Pool size **equals** concurrency, and the manager independently caps concurrent
ticket sessions at `N` (ticket-session-manager). So **in normal operation** any
lease that clears the gate finds a free slot — the pool does not starve. When
more tickets (plus QA/Security runs, which share the same `N` budget via the
server concurrency gate) are eligible than `N`, the **excess queues at the gate**
until a slot frees; it never spins waiting on an empty pool.

The one exception is a **leaked dead-worker lease**: a worker that dies uncleanly
keeps its slot marked `active` until crash reclaim runs, so during that window a
lease that has already cleared the gate can still find every slot busy — the
acquire path reports `pool_exhausted`. That case is **not fatal**: the manager
falls back to the shared base cwd (see *Fallback* below) and `reconcilePoolLeases`
returns the orphaned slot to IDLE once its freshness grace elapses (see
*Crash-tolerant lease reclaim*). The invariant `N == concurrency` makes exhaustion
unreachable in normal operation; only an unreclaimed dead lease can trip it.

### Crash-tolerant lease reclaim

Because release is lazy and workers die uncleanly, a slot could otherwise stay
`active` forever after its owner vanished, leaking a pool slot. `reconcilePoolLeases`
(driven off the same reconcile tick as the worktree sweep) reconciles the
on-disk lease registry (`<working_dir>/.awb/wt/.pool-leases.json`, persisted so a
manager restart re-reads slot ownership) back to **IDLE** for any lease whose
owner is no longer alive:

- A lease is reclaimed only when **no live session** (persistent ticket or
  one-shot subagent snapshot) owns the ticket **and** no live process is working
  inside the slot dir (best-effort `/proc/<pid>/cwd` scan) — this spares a
  detached-but-quiet worker.
- A **freshness grace** (`POOL_LEASE_RECLAIM_GRACE_MS`, 20 min) never reclaims a
  lease whose `leasedAt` is inside the window, even if no owner is visible yet.
  The lease is written durably at *acquire* time but the spawned child only
  registers in the live-session snapshot at the *end* of spawn; without the grace
  a reconcile tick during that gap would false-reclaim a live-but-still-dispatching
  worker. A genuinely dead worker leased long ago, so its `leasedAt` is already
  past the grace and it is reclaimed on the next tick.

### Fallback

`resolveCwd` returns the shared base cwd (`isWorktree=false`, legacy single-cwd
behavior — dispatch-level serialization keeps it safe) whenever it cannot hand
out a slot:

- `working_dir` is not a git repo, or `git worktree add` fails (old git, disk
  error);
- (`shared` pool only) **`pool_exhausted`** — every `shared-<i>` slot is held by
  an `active` lease. Because pool size equals concurrency, in a correctly-sized
  pool this only happens when a dead-worker lease has not yet been reclaimed (see
  *No starvation* above); `reconcilePoolLeases` frees it on a later tick.

## Security model

- **API key scope** — pairing redeem creates an `ApiKey` bound to the
  manager's Agent row. All subsequent requests use this key as a Bearer
  header. The key has full agent scope (same as a Claude plugin install).
- **Pairing tokens** — never persisted on the manager. Single-use,
  10-minute TTL, mint endpoint is admin-only.
- **fs-browser scope** — reverse-RPC fs operations are gated by realpath
  against an explicit allowlist (working_dir of each managed agent). Symlink
  escapes are rejected at `realpath` time before any IO.
- **Lockfile** — prevents two managers writing the same `subagents.json`. A
  hostile take-over still requires PID forge; honest installations are safe.

## Operational runbooks

- **Assignee overlap pre-flight (build only after checking for a sibling fix)** —
  before writing any implementation code, an assignee must confirm the
  bug/symptom isn't already resolved on the default branch and isn't being
  attacked by another open/recently-Done ticket with a conflicting design.
  Step 2 of the `in_progress_workflow` prompt template encodes this:
  `git fetch` + scan `origin/<base>` for the symptom, scan the board
  (`get_board_summary` / sibling ticket titles) for in-flight overlap, and
  **stop-and-escalate** (comment + `pend_ticket`) instead of building when a
  conflicting sibling already merged or is in-flight. Rationale: the
  `7929ef0b` / `ff3e7337` retrospective — two tickets shipped incompatible
  designs for the same pair of comment-attachment bugs in parallel; one
  landed 8 commits on main while the other's assignee built substantial WIP
  before checking `origin/main`. The check was run correctly *on resume* but
  too late; the gate moves it *before* the first build pass. Refreshed onto
  existing workspaces by migration `1760000000031`.
- **Re-login a managed claude CLI** — see
  [`docs/managed-agent-relogin.md`](managed-agent-relogin.md). Covers both
  the direct path (`scripts/relogin-managed-agent.{ps1,sh}` redirecting
  `CLAUDE_CONFIG_DIR` to the per-agent cli-home) and the remote-injection
  path (paste `.credentials.json` into AWB Admin → Credentials →
  Claude (Subscription), attach to agent, restart). Required when subagent
  turns return `is_error=true` in 1–2 s and sessions are killed as
  UNHEALTHY every 25 minutes — the canonical signature of an expired
  OAuth token.

## Testing

> **No automated tests yet — all behavior is verified manually.** The plugin
> daemon's prior unit tests (`subagent-manager`, `chat-session-manager`,
> `agent-lockfile`, `self-update`, `subagent-delegation`) were dropped when
> the daemon moved here and have not been ported to TS yet. The same logic
> still runs (re-typed line-for-line during ST-2), so short-term regression
> risk is low — but new contributors should treat the public contracts here
> (SSE event shapes, config schema, ack semantics) as the source of truth
> rather than inferring from code.

Minimum manual smoke pass before each version bump:

- `npm run build` (workspace root, via turbo) — agent-manager + server +
  client all compile clean.
- Pairing dry-run — mint via admin UI → redeem via curl → manager starts and
  the instance shows up on the dashboard.
- `agent_manager_command` round-trip — every verb (`spawn_agent`,
  `stop_agent`, `restart_agent`, `set_working_dir`, `reload_config`,
  `update_plugins`, `refresh_mcp_config`, `pull_working_dir`) acks `ok` for
  the happy path. Maintenance verbs additionally exercise:
  `update_plugins` against an agent with a non-empty
  `<cli-home>/plugins/marketplaces/`; `refresh_mcp_config` against an agent
  with an existing apiKey; `pull_working_dir` against a clean checkout.

## Versioning + sync rules

- `apps/agent-manager/package.json#version` — bump on any behavior or contract
  change; published artefacts (npm tarball / Docker image) are tagged from
  this number.
- Changes to the SSE contract (new `type`, new fields, semantics) require a
  matching server change in `apps/server/src/modules/agent-manager/` and
  must include a smoke-test of the new event end-to-end.
- The claude-plugin (`submodules/claude-plugins/ai-workflow-board/`) is a
  separate distribution. Touch only when stdio MCP forwarding behavior
  itself changes; agent-manager work does not require a plugin version
  bump.

See the parent repo's `CLAUDE.md` _Agent Manager sync_ rule for how the
ralf monorepo coordinates submodule ref bumps after these changes land.

## Server-side complements

These knobs live on the AWB server (not the manager) but interact with
the lifecycle of agents the manager drives. They are surfaced here so an
operator tuning manager behaviour has a single place to find related
runtime settings.

### Stale-WAIT detector (`StuckTicketDetectorService`)

`apps/server/src/modules/agents/stuck-ticket-detector.service.ts` is a
periodic sweep that flags tickets where an assignee subagent has logged
N consecutive WAIT-shaped comments without any column move, claim, or
release in between. When a ticket newly crosses the threshold, the
detector posts a system-authored message into the workspace's chat
room — by default the workspace's oldest room, overridable via
`Workspace.alerts_chat_room_id`. Dedup state is held in the additive
`stuck_alerts` table (PK `ticket_id`). Admin observability lives at
`GET /api/admin/stuck-tickets` (gated by `AdminGuard`), with
`POST /:id/realert` to force a re-fire and `DELETE /:id` to dismiss.

| Var | Default | Purpose |
|---|---|---|
| `STUCK_DETECTOR_ENABLED` | `true` | Kill-switch. `false` / `0` / `no` / `off` all disable. |
| `STUCK_DETECTOR_SWEEP_MS` | `900000` (15 min) | Sweep cadence. |
| `STUCK_DETECTOR_WINDOW` | `4` | Number of consecutive agent comments that form the WAIT signature. |
| `STUCK_DETECTOR_MIN_SPAN_MS` | `7200000` (2 h) | Minimum window duration — fast-loop comments are excluded. |
| `STUCK_DETECTOR_MIN_AGE_MS` | `7200000` (2 h) | Grace period: newly-touched tickets are skipped. |
| `STUCK_DETECTOR_REALERT_MS` | `86400000` (24 h) | Re-alert cooldown. |

The detector is intentionally text-agnostic — it counts comments and
lifecycle events, not phrasings. Agents that phrase WAIT differently are
still caught.

### ColumnRolePolicy enrichment (`ColumnRolePolicyService`)

`apps/server/src/modules/column-policies/column-role-policy.service.ts`
layers a declarative "what should this column×role cycle have produced?"
check on top of the stale-WAIT shape. One row per `(board_id, column_id,
role_slug)` tuple in the `column_role_policies` table. Migration
`1760000000017-CreateColumnRolePolicies` seeds defaults for every
pre-existing board on first boot (`expected_action='move'`, gate
`["BLOCKED-*"]`, `max_cycles_without_progress=4`, `on_violation='alert'`).
The same seeder runs against the freshly-created default board in
`DatabaseModule.onModuleInit` so a brand-new workspace gets the alert
layer active without a second restart.

When the stuck detector confirms stale-WAIT shape, it calls
`ColumnRolePolicyService.evaluate(column, ticketLabels)` and inspects the
result:

  - If a configured `gate_labels` glob (case-insensitive, supports `*`)
    matches one of the ticket's attached labels, the WAIT is treated as
    legitimate — the stuck detector still emits its plain "Stale-WAIT
    detected" alert (the WAIT itself has crossed the cycle threshold).
  - Otherwise the alert is upgraded to **"Stale-WAIT + policy violation"**
    with the configured target column, role(s) responsible, gate labels
    configured vs. attached, and a `policy_violation` row gets written to
    `activity_logs` (encoded with the matched policy id(s), role slugs,
    cycle count, and gate labels). Re-uses the same `stuck_alerts` dedup
    row so the operator gets one notification per dedup window — not two.

Admin surface — `GET /api/admin/column-policies` lists every board's
policies + column metadata; `PUT /api/admin/column-policies/:id` edits a
single row's `gate_labels` / `max_cycles_without_progress` /
`on_violation` / `expected_action` / `enabled` toggle. Changes take effect
on the next sweep — the detector reads policies fresh each tick, no
restart required. The Admin UI tab lives at
`/admin/column-policies` (`ColumnPoliciesManager.tsx`).

No new env vars — every knob is per-policy in the DB. `auto_move` and
`escalate_meta_ticket` are accepted enum values on the row but PR #2
treats them identically to `alert`; the auto-move path lands in PR #4 of
the epic (ticket f886ada7).
