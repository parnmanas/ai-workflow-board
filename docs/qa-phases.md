# QA multi-phase model (per-phase timeouts)

> Ticket chain `90cc22f7` (server foundation) → `38192044` (MCP/REST surface) →
> `6b78051a` (client UI) → `454e6bd0` (E2E + this doc). Builds directly on the
> registered **liveness policy** model ([`qa-liveness-policy.ts`](../apps/server/src/modules/qa/qa-liveness-policy.ts),
> see [docs below](#relationship-to-liveness_policy)).

## The problem it solves

A `QaRun` is created `running` and only reaches a terminal status when the QA
agent calls `complete_qa_run`. If the agent — or the headless build/drive job it
waits on — dies, nothing stamps a terminal status, so the
[`QaRunReaperService`](../apps/server/src/modules/qa/qa-run-reaper.service.ts)
fails it after a deadline.

The default `zero_progress` policy applies **one** deadline to the **whole run**.
That is wrong for a workload with stages of wildly different normal duration. The
canonical example is a Unity drive:

```
import  (tens of seconds)  →  build  (tens of minutes)  →  run  (hours)
```

A single timeout either false-reaps the long `run` stage or never catches a hang
in the short `import` stage. The **phase model** lets a board (or, overriding it,
a scenario) declare an ordered list of phases, each with its **own**
`timeout_sec`, so the reaper judges *"is THIS phase overdue?"* instead of *"is the
whole run overdue?"*.

`qa_phases = null` everywhere → no phase model → legacy single-`running`
behavior, fully regression-safe.

## The config shape

Stored as a JSON text column on **Board** and **QaScenario** (`qa_phases`). The
write schema is [`QaPhasesSchema`](../apps/server/src/modules/qa/qa-phases.ts):

```jsonc
{
  "phases": [
    { "id": "import", "label": "Import", "timeout_sec": 600  },  // 10 min
    { "id": "build",  "label": "Build",  "timeout_sec": 1800 },  // 30 min
    { "id": "run",    "label": "Run",    "timeout_sec": 3600 }   // 60 min
  ]
}
```

- **Array order *is* phase order.** The first phase is the opening phase.
- `id` — stable phase id (unique, non-empty). The run stamps it as `current_phase`.
- `label` — optional human label for the timeline UI (defaults to `id`).
- `timeout_sec` — positive integer; seconds the phase may run from when it was
  entered before the reaper treats it as a hung/dead phase.

The read path ([`parseQaPhases`](../apps/server/src/modules/qa/qa-phases.ts))
**fails safe**: a malformed/empty/unparseable config falls back to `null` (never
throws mid-sweep, so one bad board can't break reaping for everyone), and
malformed individual phase entries are dropped; duplicate ids collapse to the
first occurrence.

### Precedence — scenario ?? board ?? null

`resolveQaPhases(scenario.qa_phases, board.qa_phases)` returns the **scenario**
config when set, else the **board** config, else `null` — mirroring
`resolveLivenessPolicy`. A scenario can therefore narrow or replace the board's
phases for one specific run shape.

## Relationship to `liveness_policy`

Phases and the liveness policy are **two layers of the same registry**, resolved
together per run by the reaper:

1. **An explicit `liveness_policy` always wins.** If a board/scenario set
   `heartbeat_deadline` (or any explicit policy), that policy is used even when
   phases are defined.
2. **Otherwise, defining `qa_phases` is enough.** When no explicit policy is set
   but phases resolve, `resolveLivenessPolicy` **auto-selects** the
   `phase_timeouts` detector — no separate policy write needed.
3. **Otherwise** → the built-in `zero_progress` default (legacy behavior).

```
explicit liveness_policy (scenario ?? board)
  └─ none → qa_phases defined?  → phase_timeouts
              └─ no             → zero_progress (default)
```

`phase_timeouts` is registered in the same detector registry as `zero_progress`
and `heartbeat_deadline`; the reaper core just dispatches on `policy.type`.

## How the reaper judges a phase

The [`phase_timeouts` detector](../apps/server/src/modules/qa/qa-liveness-policy.ts)
measures the **active** phase against **its own** `timeout_sec`, from the instant
the run entered it (`current_phase_at`):

- **Active phase matched** (`current_phase` exists in the resolved model) — reap
  when `now - current_phase_at > timeout_sec`. The reaped run's `summary` names
  the phase, e.g. `phase timeout — phase 'Build' has run ~1900s (timeout 1800s) …
  NOT a tested failure — re-run the scenario.`
- **Entering a phase RESETS its clock.** `current_phase_at` is re-stamped on every
  transition, so time spent in the *previous* phase never counts against the next
  one. (This is the key E2E property — a run that sat an hour in `import` gets a
  full fresh `build` budget the moment it transitions.)
- **No / unmatched `current_phase`** (never transitioned, or a stale/renamed
  phase id) — fall back to a single deadline from run start: the policy's optional
  `fallback_sec`, else the **first** phase's `timeout_sec` (a sane "still in the
  opening phase" guess), else the global `QA_RUN_TTL_MS` backstop so the run is
  never immortal. The summary reads `no phase set` / `unmatched phase '<id>'`.

> Seed the opening phase at dispatch (`start_qa_run` `initial_phase`) so even a
> run that dies *before* its first `set_qa_phase` is judged against the opening
> phase's short timeout rather than the fallback.

## The run lifecycle (MCP / REST surface)

| Step | Tool | Effect on the run |
|---|---|---|
| Define phases (board) | `update_board` `qa_phases` | Board-level model; auto-selects `phase_timeouts` |
| Define/override (scenario) | `create_qa_scenario` / `update_qa_scenario` `qa_phases` | Scenario model wins over board |
| Start, stamp opening phase | `start_qa_run` `initial_phase: "import"` | `current_phase`/`current_phase_at` + first `phase_history` entry seeded at dispatch |
| Transition | `set_qa_phase` `{ run_id, phase: "build" }` | Re-stamps `current_phase`/`current_phase_at` (resets the clock), closes the prior `phase_history` entry's `left_at`, appends the new one |
| Finalize | `complete_qa_run` `{ status, summary }` | Terminal status; transitions rejected afterward |
| Inspect | `get_qa_run` | Projects `current_phase`, `current_phase_at`, `phase_history[]` |

`set_qa_phase` stores the phase id **verbatim** — it need not exist in the
resolved model (an unmatched id simply falls back in the reaper). Transitions are
rejected once the run is terminal (`409`), and an empty phase is rejected (`400`).

`phase_history` entries are `{ phase, entered_at, left_at }` (ISO timestamps);
`left_at` is `null` for the currently-open phase and closed on the next
transition — that's what the RunDetail timeline renders.

### Worked MCP flow

```
update_board        { board_id, qa_phases: { phases: [import 600, build 1800, run 3600] } }
start_qa_run        { scenario_id, initial_phase: "import" }            → run_id
  … import work …
set_qa_phase        { run_id, phase: "build" }     # build clock starts here, not at run start
  … build work …
set_qa_phase        { run_id, phase: "run" }       # run clock starts here
  … drive …
complete_qa_run     { run_id, status: "passed", summary: "…" }
```

If the agent dies during `build`, the reaper reaps the run once it overruns
**build's** 1800s — independent of how long `import` took and of the 3600s `run`
budget it never reached.

## Verification

The end-to-end behavior is locked down by deterministic tests that drive the
**real** services (no mocked time logic):

- [`test/qa-phases.test.mjs`](../apps/server/test/qa-phases.test.mjs) — foundation
  units: parse/normalize/fail-safe, resolve precedence, `phase_timeouts`
  auto-selection, per-phase reap decision, fallback, `setPhase` bookkeeping.
- [`test/qa-phases-e2e.test.mjs`](../apps/server/test/qa-phases-e2e.test.mjs) —
  stitches `QaRunService.setPhase` → `QaRunReaperService.runOnce` over a shared
  run with a controlled clock, proving the ticket's four points: (1) independent
  per-phase timeouts, (2) a **real import→build transition resets the deadline
  baseline** (prior-phase time does not kill the next phase), (3) the reap summary
  records which phase overran, (4) no regression for a phases-undefined run
  (still `zero_progress`).

Both are wired into `npm test` (`apps/server`).

### Live-MCP E2E playbook (run after deploy)

The phase stack is on `origin/main`; the live server auto-deploys from
`production.private`, which lags. Once a `main → production.private` deploy lands
(confirm the live MCP surface exposes `set_qa_phase`, `start_qa_run.initial_phase`,
and `update_board.qa_phases`), this is the on-a-real-board replay:

1. `update_board { board_id, qa_phases: { phases: [{id:"import",timeout_sec:30},{id:"build",timeout_sec:120},{id:"run",timeout_sec:600}] } }`
   — short `import` so a reap is observable without a long wait.
2. `create_qa_scenario` (or reuse one) pinned to the board.
3. `start_qa_run { scenario_id, initial_phase: "import" }` → note `run_id`.
4. `get_qa_run` → assert `current_phase: "import"`, `phase_history[0].left_at: null`.
5. **Reset proof:** wait > 30s (past `import`), then `set_qa_phase { run_id, phase: "build" }`.
   `get_qa_run` → `current_phase: "build"`, `current_phase_at` fresh,
   `phase_history[0].left_at` closed. The run is **not** reaped though `import`
   overran — the transition reset the clock.
6. **Independent-timeout proof:** leave it in `build` past 120s without
   transitioning (or `POST /api/qa/runs/reap` to force a sweep). The run goes
   `error` with a summary naming **phase 'Build'**.
7. **Regression:** a scenario/board with `qa_phases: null` behaves exactly as
   before (single `running`, `zero_progress` fuses).

> Reaper cadence: `QA_RUN_REAPER_SWEEP_MS` (default 30m). For a live replay either
> set it low on the instance or hit the on-demand `POST /api/qa/runs/reap`
> endpoint so you don't wait a full sweep.
