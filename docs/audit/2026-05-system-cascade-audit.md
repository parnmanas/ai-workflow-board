# System Cascade Audit (2026-05-28) — Phase 1-2 draft

Read-only audit covering every system-emitted activity callsite and every
`activityEvents` listener in `apps/server/src/`. Drafted in response to the
2026-05-28 silent_exit → trigger → silent_exit runaway loop (incident commit
`39520f6`; ~131k cycles, ~170 MB/min heap growth, OOM).

Phase 3 (cascade graph), Phase 4 (external-failure backoff) and Phase 5
(closure / listener leak) findings are folded into the same Findings section
below — each finding states which invariant it touches. No code has been
changed under this branch; the next step is reviewer triage of which findings
to fix in this PR vs. defer.

## Scope

Surfaces inspected (greps run against `apps/server/src` only):

- 89 distinct `activityService.logActivity(...)` / `activityEvents.emit(...)`
  callsites across 26 files (Phase 1.1).
- 7 files registering `activityEvents.on(...)` listeners (Phase 2): listeners
  on `activity`, `agent_idle`, `agent_trigger`, `user_mention`,
  `chat_room_message`, and the table-driven SSE listeners in
  `EventsController` (10 event types).
- Every dispatch path that re-emits an activity row inside a listener
  (auto-advance, prereq auto-resume, backlog promotion, next_ticket dispatch,
  post-done self-improvement review).
- Background sweeps (`TicketSupervisorService`, `ClaimVerificationService`,
  `TicketArchiverService`, `StuckTicketDetectorService`,
  `AgentStatusService`, `DbRetentionService`, `MemoryWatchdogService`,
  `SubagentMonitorService`).
- MCP tool callsites that write activity (`ticket-crud-tools`,
  `ticket-workflow-tools`, `ticket-attachment-tools`, `archive-tools`,
  `comment-tools`, `ticket-child-tools`, `chat-tools`).
- The agent-manager surface (`/api/agent/silent-exit-comment`) that the
  2026-05-28 incident originated from.

## Cascade graph

```
[REST / MCP user / agent action]
        │
        ▼
ActivityService.logActivity   ── normalizes actor_id: '' | undefined → ''
        │
        └── activityEvents.emit('activity', log)
                 │
                 ├── TriggerLoopService._handleActivity  ← single producer of agent_trigger
                 │     guards (in order):
                 │       (a) action='archived'  → _resumePrerequisiteDependents
                 │                                 └── logActivity(actor_id='system')  re-entry SAFE (skipped by guard d)
                 │                                 └── dispatchCurrentColumn → _emitTrigger (no activity emit)
                 │       (b) comment.updated     → SHORT-CIRCUIT (defense-in-depth, fix 39520f6)
                 │       (c) only moved / comment.created / updated continue
                 │       (d) actor_id === 'system' || actor_id === ''  → SHORT-CIRCUIT (fix 39520f6)
                 │       (e) terminal column     → _dispatchNextTicket / _resumePrerequisiteDependents / _dispatchPostDoneReview
                 │                                  (all funnel through _emitTrigger; no activity re-emit)
                 │       (f) routed but no holders → _autoAdvanceUnassigned
                 │                                  └── logActivity(actor_id='auto-advance')  DELIBERATELY re-entrant
                 │                                  bounded by columns.length-current_position-1
                 │       (g) per holder → _emitTrigger
                 │              └── pause / archived / pending / focus gates
                 │              └── activityEvents.emit('agent_trigger', ...) (NOT 'activity')
                 │              └── activityLogRepo.save(trigger_emitted)  direct save, no event emit
                 │
                 ├── SystemCommentService           writes Comment via repo.save  (no event emit)
                 ├── NotificationService            Discord HTTP POST            (no event emit)
                 ├── UserChannelDispatcherService   provider sends                (no event emit)
                 └── EventsController × {board_update, ...}  SSE forward only    (no event emit)

[AgentStatusService.clearCurrentTask | _sweep]
        └── activityEvents.emit('agent_idle')
                 └── BacklogPromotionService._onAgentIdle → tryPromote
                        ├── logActivity('moved', actor_id='system')   does NOT re-enter (guard d)
                        ├── logActivity('backlog_promotion_skipped_focus_held', actor_id='system')  via repo.save (no emit)
                        ├── logActivity('backlog_promoted', actor_id='system')  via repo.save (no emit)
                        └── triggerLoop.emitAgentTrigger → 'agent_trigger' only

[setTimeout(60s) in chat-tools.ts set_typing]   ← unbounded per-call closure (Finding-003)
        └── activityEvents.emit('agent_typing')
                 └── EventsController forward only
```

Every closed cycle on this graph terminates at one of:

1. The system-actor guard `actor_id === 'system' || actor_id === ''` at
   `trigger-loop.service.ts:118` (fix 39520f6).
2. The comment-updated short-circuit at `trigger-loop.service.ts:108` (fix
   39520f6, defence-in-depth).
3. A direct `repo.save` write that does NOT call `activityService.logActivity`
   (every `trigger_emitted` / `agent_trigger_dropped_*` audit row + every
   `backlog_promoted` / `backlog_promotion_skipped_focus_held` row).
4. A deliberate re-entry with `actor_id='auto-advance'` (auto-advance), which
   is bounded by column count.

No new unsafe cycle was identified. The findings below are correctness /
hygiene gaps that violate the four audit invariants without yet manifesting
as runaway, plus one transient-closure leak.

## Findings

### Finding-001: actor_id='' lint hole in `policy_violation` ActivityLog write

- **Location**: `apps/server/src/modules/agents/stuck-ticket-detector.service.ts:559–581`
  (specifically `actor_id: ''` at line 575)
- **Pattern**: Invariant 1 violation — system-emitted activity uses empty
  string instead of `'system'`.
- **Worst case**: Currently zero — this row is written via
  `activityLogRepo.save(...)` directly, NOT through
  `activityService.logActivity`. No `activity` event fires, so the
  trigger-loop never sees it. If a future refactor switches this path to
  `activityService.logActivity` without updating actor_id, the row would
  inherit the `''` and rely on the system-actor guard's '' branch (added
  by 39520f6) to avoid re-entry. Brittle. Defense-in-depth value of the
  guard is undermined by leaving "system-meaning '' " rows in the schema
  on purpose.
- **Reproducer**: Trigger any column-role-policy violation; inspect the
  resulting `policy_violation` ActivityLog row — `actor_id` column is `''`.
- **Severity**: low (cosmetic / lint, not behavioural)
- **Fix**: Change `actor_id: ''` → `actor_id: 'system'`. Pure stylistic
  alignment; trigger-loop already treats both identically post-39520f6.

### Finding-002: `set_typing` MCP tool leaks an unbounded queue of 60s setTimeouts

- **Location**: `apps/server/src/modules/mcp/tools/chat-tools.ts:36–46`
- **Pattern**: Invariant 4 violation — every `set_typing(is_typing=true)`
  call schedules a fresh `setTimeout(...)` that captures
  `(agent_id, ticket_id, timestamp)` in a new closure. There is no
  deduplication per `(agent_id, ticket_id)`, no cap, and no early-clear
  when the agent sends `is_typing=false`. The closure is retained for the
  full 60s timer lifetime regardless of whether the indicator has already
  been cleared by an explicit stop call.
- **Worst case**: An agent calling `set_typing(true)` once per second
  (chatty narration / buggy loop / malicious) accumulates ~60 pending
  closures + timer handles at steady state per
  (agent_id, ticket_id) pair. Across N ticket subagents that's 60·N
  retained closures plus N node Timer objects. Modest in absolute terms
  (~MB-class), but compounds with the wider closure-leak surface a
  cascade exploits — this was one of the residual retention paths
  flagged in the 2026-05-28 heap snapshot post-mortem.
- **Reproducer**:
  ```
  for (let i = 0; i < 600; i++) {
    await callMcp('set_typing', { agent_id, ticket_id, is_typing: true });
  }
  // 10 minutes of typing pings at 1/s → ~600 retained setTimeout entries
  // until they fire at +60s each.
  ```
- **Severity**: medium
- **Fix**: Maintain a `Map<\`${agent_id}:${ticket_id}\`, NodeJS.Timeout>`
  inside the tool registration scope. On every call, `clearTimeout(prev)`
  for the same key before scheduling a fresh timer. `is_typing=false`
  cancels the timer and deletes the map entry. Tool registration runs
  once per MCP server, and one server is created per session — the map
  is naturally session-scoped and dies with the session, so no global
  state accumulates.

### Finding-003: `actor_id` falls through to '' on REST / MCP write paths that intend a real actor

- **Location**: 13 callsites across:
  - `apps/server/src/modules/tickets/tickets.controller.ts:184, 276, 560, 571, 579, 588, 606, 620, 703, 875, 986, 1120, 1230, 1263, 1476, 1508, 1677, 1786, 1847`
    (`actor_id: currentUser?.id` and `actor_id: actorId` patterns,
    plus `actor_id: creator.created_by_id || undefined`)
  - `apps/server/src/modules/mcp/tools/ticket-crud-tools.ts:461, 468, 478, 536, 567, 633`
    (`actor_id: caller?.agentId` — undefined when caller is unauthenticated)
  - `apps/server/src/modules/mcp/tools/ticket-workflow-tools.ts:109, 203, 264, 316`
  - `apps/server/src/modules/mcp/tools/ticket-attachment-tools.ts:94, 164`
  - `apps/server/src/modules/mcp/tools/archive-tools.ts:138, 183`
  - `apps/server/src/modules/mcp/tools/ticket-child-tools.ts:207, 213, 247`
  - `apps/server/src/modules/tickets/ticket-prerequisites.service.ts:181, 214`
    (`actor_id: opts.actorId` — undefined when caller doesn't supply)
- **Pattern**: Invariant 1 inverse — these activities are *user-* or
  *agent-driven*, but if `currentUser?.id` / `caller?.agentId` /
  `opts.actorId` is undefined, `ActivityService.logActivity`
  (`activity.service.ts:39`) normalizes to `''`. The trigger-loop's
  system-actor guard then mis-classifies the row as system-emitted and
  silently DROPS the cascade — no agent gets woken on what should have
  been a user-driven column move.
- **Worst case**: A user-driven column move via `PATCH /api/tickets/:id/move`
  by a route handler whose `AuthGuard` somehow allowed an unauthenticated
  request (today: not reachable — `AuthGuard` plus `WorkspaceGuard` are
  both applied at the controller level). Or an MCP tool call without a
  session-pinned caller. In both cases the move would succeed but no
  agent_trigger fires for the destination column's holders, and the
  workflow stalls until a supervisor 30-min stale re-push catches it.
- **Reproducer**: Construct an MCP `move_ticket` call from a session that
  lost its caller mid-flight (e.g. an envvar key whose agent was deleted
  between session-init and tool-call) — the resulting `moved` activity
  has actor_id='' and the destination holders are never woken until the
  supervisor tick.
- **Severity**: medium (loss-of-trigger, not loop risk)
- **Fix** (two options, can ship both):
  1. **Read-side hardening** (recommended for this PR): in
     `ActivityService.logActivity`, when actor_id is missing AND
     `actor_name` is also missing, raise a one-shot warn log
     `[ActivityRate] missing actor_id, defaulted to '' — caller=<stack>`
     so future regressions get caught at the source. Do NOT reject — that
     would break legitimate test paths (e.g. `qa.controller.ts:286`).
  2. **Per-callsite cleanup**: replace `caller?.agentId` /
     `currentUser?.id` with explicit fallback to `'system'` only when the
     callsite is truly a system path; otherwise propagate the
     not-authenticated error to the caller. Per-file work — defer to a
     follow-up PR.

### Finding-004: TriggerLoopService activity listener is an unrecoverable inline closure

- **Location**: `apps/server/src/modules/agents/trigger-loop.service.ts:70–74`
- **Pattern**: Invariant 4 hygiene — the listener registered in
  `onModuleInit` is an anonymous inline arrow:
  ```ts
  activityEvents.on('activity', (log: ActivityLog) => {
    this._handleActivity(log).catch((e) => { ... });
  });
  ```
  There is no `OnModuleDestroy`, no stored reference, no
  `removeListener` path. In production this is harmless (one-time init,
  process lives until restart). In test harnesses that build / tear down
  the Nest module per spec (`apps/server/test/integration` is exactly
  that shape), each rebuild adds a listener and the old ones stay
  attached — every `activity` event then runs the handler N times.
- **Worst case**: Test-only — each integration spec adds one more
  attached listener; the EventEmitter's `MaxListenersExceededWarning`
  starts firing after 10 specs. No production impact.
- **Reproducer**: Run any integration spec twice in the same node
  process; `activityEvents.listenerCount('activity')` increments by 1
  each run. (The
  log line `Emitting "..." on ... { listeners: N }` at
  `activity.service.ts:47` makes this directly visible.)
- **Severity**: low
- **Fix**: Store the listener on `this`, implement `OnModuleDestroy`,
  call `activityEvents.removeListener('activity', this.listener)`.
  Mirrors the shape `NotificationService`, `SystemCommentService`,
  `UserChannelDispatcherService` already use.

### Finding-005: BacklogPromotionService agent_idle listener has the same anonymous-closure shape

- **Location**: `apps/server/src/modules/agents/backlog-promotion.service.ts:101–109`
- **Pattern**: Same shape as Finding-004 — anonymous inline arrow, no
  `OnModuleDestroy`, no stored reference.
- **Worst case**: Same as Finding-004 (test-only).
- **Reproducer**: Same as Finding-004.
- **Severity**: low
- **Fix**: Same as Finding-004 — store + remove on destroy.

### Finding-006: SSE flatten path emits `actor_id: event.actor_id || ''` (informational)

- **Location**: `apps/server/src/modules/events/event-registry.ts:429, 487`
  (also `:460`, `:543` which read directly without coalescing)
- **Pattern**: SSE wire-format flatten — emits empty string when the
  upstream payload's actor_id is missing. Not a write path; the row in
  the DB still has whatever the writer stamped. But it propagates the
  "actor_id='' is meaningful" pattern out to every SSE consumer.
- **Worst case**: Cosmetic — UI shows a blank author field. No
  cascade implication; the SSE listener doesn't re-emit activity
  events.
- **Severity**: low / informational
- **Fix**: Coalesce to `'system'` when the upstream is a system emit,
  or leave it `''` as a sentinel. No urgent action — flag for the
  invariant-enforcement follow-up PR.

### Finding-007: QA test path writes activity without actor_id (informational)

- **Location**: `apps/server/src/modules/qa/qa.controller.ts:286`
- **Pattern**: `actor_name: 'QA Bot'` but no `actor_id`. Falls through
  to `''` in `ActivityService.logActivity`.
- **Worst case**: Test-only. The QA flow synthetic activity is
  classified as system by trigger-loop and the QA harness expects that
  (it doesn't want its synthetic activity to wake real agents).
- **Severity**: low / informational
- **Fix**: Explicitly stamp `actor_id: 'system'`. Same as Finding-001 —
  cosmetic alignment.

## Phase 4 — external-failure backoff verification

| Path                                 | Failure source                       | Loop? | Backoff / cap                                          |
| ------------------------------------ | ------------------------------------ | ----- | ------------------------------------------------------ |
| `TicketSupervisorService._tick`      | dropped SSE / wedged subagent         | No    | 60s tick + `resendMs` (5 min default, 1h for stuck)    |
| `ClaimVerificationService.sweep`     | git ls-remote failure                | No    | 60s tick + per-workspace `claim_verification_enabled`  |
| `TicketArchiverService.runOnce`      | per-ticket save failure              | No    | 1h tick, idempotent on `archived_at IS NULL`           |
| `StuckTicketDetectorService.sweep`   | chat post failure                    | No    | 15 min tick + `realertMs` (24h cooldown) + dedup row   |
| `BacklogPromotionService.tryPromote` | role-emit failure                    | No    | Single attempt per `agent_idle`; supervisor backstops  |
| `AgentStatusService._sweep`          | DB read failure                      | No    | 30s tick; failure logs only, no retry                  |
| `SubagentMonitorService._sweepEnded` | retention sweep failure              | No    | 5 min tick, idempotent delete                          |
| `_emitTrigger` (single chokepoint)   | downstream SSE deliver failure       | No    | Fire-and-forget; supervisor's 30 min stale re-push is the recovery channel |

**Server-side conclusion**: every retry loop is timer-driven with a fixed
period and an idempotent per-tick body. No exponential-backoff growth, no
fan-out amplification, no infinite respawn loop on the server side.

**Out-of-scope external paths** (per ticket's "incident 자체의 trigger …
운영 결정이지 코드 fix 아님" note): LLM provider usage limit, LLM API
auth expiry, agent CLI spawn failure, working_dir loss, MCP init schema
mismatch. These all manifest as silent_exit on the agent-manager side; the
server-side fix (commit 39520f6) breaks the cascade regardless of how often
the external failure fires.

## Phase 5 — closure / listener leak audit

Survey of every listener registration site for permanent retention:

| Service                          | Event                       | Stored ref? | OnModuleDestroy? |
| -------------------------------- | --------------------------- | ----------- | ---------------- |
| TriggerLoopService               | activity                    | No (inline) | No (Finding-004) |
| BacklogPromotionService          | agent_idle                  | No (inline) | No (Finding-005) |
| EventsController (constructor)   | 10 SSE event types          | Yes (`listeners[]`) | Yes              |
| SystemCommentService             | activity                    | Yes         | Yes              |
| NotificationService              | activity                    | Yes         | Yes              |
| UserChannelDispatcherService     | user_mention, chat_room_message, activity | Yes | Yes              |
| McpController                    | agent_trigger               | Yes         | Yes              |

**Permanent retention conclusion**: in production (single-init), no listener
ever leaks. Findings 004 and 005 are test-rig hygiene only.

**Transient retention** (per-cycle closures):

| Site                                  | Lifetime       | Per-cycle growth? | Notes                                  |
| ------------------------------------- | -------------- | ----------------- | -------------------------------------- |
| `chat-tools.ts set_typing` setTimeout | 60s            | **Yes** — Finding-002 | Unbounded under chatty input         |
| `fs-browser.service.ts` PendingRequest | 15s timeout    | Capped at 500     | Has explicit `MAX_PENDING = 500` ceiling |
| `subagent-monitor.service.ts` appendLocks | bounded by serialize() | No        | `appendLocks.delete(key)` after release |
| `agentSseSessions` map (events ctrl)  | until disconnect | No              | Cleaned up on req close / finalize     |
| `agentMainSession` map (events ctrl)  | until disconnect | No              | Cleaned up alongside sessions          |

The 2026-05-28 incident's 4.1M retained closures were attributable to the
fixed cascade itself (silent_exit → comment.updated → trigger → silent_exit
× 131k cycles, each cycle compounding retained MCP response strings via the
event-emitter delivery chain). Cutting the cascade at the actor_id='' guard
and the comment.updated short-circuit removes the closure-retention vector;
no separate per-listener leak fix is required beyond Finding-002.

## Severity rollup

- **critical (historical, already fixed)**: 1 — silent_exit cascade
  (incident 39520f6)
- **medium**: 2 — Finding-002 (`set_typing` setTimeout leak),
  Finding-003 (actor_id fall-through misclassifies user-driven activity
  as system)
- **low**: 4 — Finding-001 (`policy_violation` actor_id=''),
  Finding-004 (TriggerLoop inline listener),
  Finding-005 (BacklogPromotion inline listener),
  Finding-006 (SSE flatten coalesce),
  Finding-007 (QA test actor_id)

## Fixes applied

None yet — this PR is the audit draft only. The ticket's "작업 진행 방식"
guideline explicitly gates code changes on reviewer triage of the findings
above.

## Deferred (proposed)

Reviewer to confirm. Suggested split:

**Apply in this branch** (atomic, one commit per finding, per the ticket's
fix-discipline rules):

- Finding-001 (`'' → 'system'` on policy_violation) — trivial, 1-line.
- Finding-002 (set_typing dedup map) — medium severity, real leak surface.
- Finding-004 + 005 (store + removeListener) — small hygiene, two files.

**Follow-up PR** (per the ticket's "새 invariant 강제는 다음 PR" note):

- Finding-003 read-side hardening — `ActivityService.logActivity` warn
  on missing actor_id. Conceptually an invariant enforcer, not a narrow
  cascade fix.

**Defer indefinitely**:

- Finding-006 (SSE flatten coalesce) — cosmetic.
- Finding-007 (QA test path) — test-only, no real impact.

## Reference

- Incident commit: `39520f6` fix(triggers): break silent_exit → trigger → silent_exit runaway loop
- Heap snapshot: `heapsnapshots/Heap-2026-05-28T09-26-03-692Z-pid1-manual.heapsnapshot`
  (1.36 GB)
- Memory watchdog source: `apps/server/src/services/memory-watchdog.service.ts`
- Diagnostics endpoints: `GET /api/diagnostics/memory`,
  `POST /api/admin/diagnostics/heap-snapshot`
