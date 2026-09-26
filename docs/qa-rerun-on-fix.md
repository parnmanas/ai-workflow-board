# QA → fix → QA closed loop (rerun-on-fix)

> Ticket 467dbc7a. Builds on the on-failure auto-ticket feature (ticket 52a93654,
> `docs`-less but see `qa-failure-ticket.service.ts`). Deployment awareness
> (ticket 8ce72b18) later added `QaScenario.target_environment` and the
> `deployment_gate` — see "Deployment timing" below, which is where the choice of
> rerun timing is actually made.

Closes the automation loop:

```
QA run fails
  → QaFailureTicketService files a fix ticket (labels: qa-failure, auto, qa-scenario:<id>[, qa-rerun:<n>])
    → a human/agent fixes it and moves the ticket to Done (terminal column)
      → QaRerunOnFixService re-runs the SAME scenario (server-side, deterministic)
        → pass  → loop ends naturally (no new ticket)
        → fail  → a new fix ticket is filed at generation n+1 … repeat
          → generation reaches max_rerun_attempts → loop HALTS with a "human intervention needed" comment
```

Nothing here parses an agent prompt. The trigger is a column move to a terminal
column, exactly like the on-ticket-done Action hook, and the rerun is a direct
`QaRunService.startQaRun` call.

## Moving parts

| Piece | Where | Role |
|-------|-------|------|
| `QaScenario.on_failure_ticket.rerun_on_fix` | entity (simple-json) | opt-in master switch (default **off**) |
| `QaScenario.on_failure_ticket.max_rerun_attempts` | entity | convergence cap (default **3**; `0` disables reruns) |
| `QaScenario.on_failure_ticket.deployment_gate` | entity | deploy-timing gate, **fact-based** — hold the rerun until the fix is actually live (default **off**; inert without `target_environment`) |
| `QaScenario.target_environment` | entity | the `Deployment.environment` this scenario validates (`''` = not env-bound) |
| `QaScenario.on_failure_ticket.rerun_delay_seconds` | entity | deploy-timing gate, **fixed delay** — the fallback, and the fact-gate's safety-net cap (default **0** = immediate) |
| `Deployment` | `entities/Deployment.ts` | the commit live in each environment — what the gate reads; `report_deployment` writes it |
| `QaRerunOnFixService` | `modules/qa/qa-rerun-on-fix.service.ts` | subscribes to `activityEvents` **and** deployment reports, fires the rerun |
| `Ticket.qa_rerun_dispatched_at` | entity | idempotency stamp (once per terminal entry) |
| `QaRun.rerun_generation` | entity | generation stamped on each rerun (0 = first run) |
| `QaRun.tested_commit` / `.tested_environment` | entity | server-authoritative evidence: what was live when the run was dispatched |
| `qa-rerun:<n>` ticket label | label convention | generation carrier: fix-ticket → run → next fix-ticket |
| `fix-commit:<sha>` ticket label | label convention | the commit the fact-gate looks for in the environment's deployment |

## Scope guard — what is eligible

`QaRerunOnFixService` only fires for a ticket that, on entering a terminal column,
carries **all** of:

- `qa-failure` **and** `auto` (the default markers `QaFailureTicketService` stamps), **and**
- a `qa-scenario:<id>` label (the scenario back-reference), **and**
- whose scenario still has `on_failure_ticket.enabled` **and** `rerun_on_fix === true`.

A human who happens to drag a hand-labelled ticket to Done can't trigger a run —
the scenario opt-in and the full marker set are both required.

## Idempotency

`qa_rerun_dispatched_at` is a **dedicated** stamp, separate from the on-done
Action hook's `on_done_dispatched_at`. Both hooks subscribe to the same
terminal-entry stream; sharing one claim column would let whichever fires first
starve the other. The claim is the same atomic conditional UPDATE:

```
terminal_entered_at IS NOT NULL
AND (qa_rerun_dispatched_at IS NULL OR qa_rerun_dispatched_at < terminal_entered_at)
```

So each distinct terminal **entry** fires at most once. Re-ordering a ticket
within Done does not re-fire (terminal_entered_at unchanged); leaving Done and
returning re-stamps terminal_entered_at and fires again — bounded only by the
generation cap below.

## Convergence

Each rerun carries a generation = `(fix-ticket generation) + 1`, read from the
Done ticket's highest `qa-rerun:<n>` label (absent = generation 0). The cap fires
when the generation **reaching Done** is `>= max_rerun_attempts`:

| Event | Ticket gen read | Action (max=3) |
|-------|-----------------|----------------|
| Original failure → fix ticket | (filed at gen 0, no label) | — |
| gen-0 fix ticket → Done | 0 | rerun at **gen 1** |
| gen-1 fix ticket → Done | 1 | rerun at **gen 2** |
| gen-2 fix ticket → Done | 2 | rerun at **gen 3** |
| gen-3 fix ticket → Done | 3 | **HALT** (3 ≥ 3) → human-intervention comment |

So `max_rerun_attempts = N` allows exactly **N** automatic reruns. A passing rerun
files no new ticket, so the loop just stops. Setting `max_rerun_attempts = 0`
disables reruns entirely (equivalent to leaving `rerun_on_fix` off).

## ⚠️ Deployment timing — the one real caveat

QA scenarios validate the **running** AWB server (the awb-mcp / browser drivers
hit the live host). `main` is the only branch that ships, but **landing on it is not the
same as serving it**: the deploy host re-checks-out `origin/main` into its own worktree
(detached), reinstalls dependencies, rebuilds and restarts the server before that commit
goes live — and that deploy is kicked by the pushing side, not by a daemon on a timer
(the agent-manager is a separate, lagging local piece — unrelated here). A fix ticket
reaching **Done** means *merged to main*, **not necessarily deployed**.

Therefore an **immediate** rerun (`rerun_delay_seconds = 0`) can re-validate the
**pre-fix** code and "fail again" even though the fix is correct — burning a
generation against stale binaries.

Mitigations, in order of preference. This order is the one the code declares —
`QaScenario.ts` marks the fixed delay **superseded** by the fact-gate, and
`QaRerunOnFixService` calls the gate "the DoD path":

1. **`deployment_gate` + `target_environment`** — the fact-based gate, and the
   preferred answer. Bind the scenario to a logical environment
   (`QaScenario.target_environment`, the join key into `Deployment.environment`)
   and set `on_failure_ticket.deployment_gate`. The rerun then does **not** fire on
   the fix ticket's Done edge: it waits until that environment's live deployment
   actually carries the fix, and fires the instant a matching `report_deployment`
   (or the server's own self-report) lands. "Carries the fix" means the deployment
   **includes** the sha from a `fix-commit:<sha>` ticket label — the deployed commit
   itself, or one of its recorded ancestors, matched prefix-wise so a short sha
   works. With no such label it falls back to deploy-freshness ordering: a
   deployment that went live at/after the fix's Done instant counts. Nothing here
   is a hardcoded duration, so it cannot drift when the real deploy time does.
   ⚠️ The gate is **inert without `target_environment`** — with the environment
   unset, `deployment_gate` alone changes nothing and the rerun takes the legacy
   immediate/delay path below.
2. **`rerun_delay_seconds`** — a fixed delay. Kept, but as the fallback rather than
   the first answer: a fixed delay re-breaks whenever the real deploy time drifts,
   which is exactly why the entity comment marks it superseded. ⚠️ Whichever of its
   two jobs it is doing, the wait is **best-effort / in-process** — a server restart
   during the window drops the pending rerun (the fix ticket is already Done, so it
   won't re-fire unless moved out of and back into Done), and a rerun parked by the
   gate has the same limitation. It is a timing nicety, not a durable scheduler. The
   two jobs:
    - *Without* the gate — the legacy path: the rerun is deferred in-process by N
      seconds so the deploy can land first. Set it to your typical main→deploy lag.
    - *With* the gate — a safety-net cap: if the deployment signal never arrives,
      the rerun still fires once after N seconds (logged as "fallback cap reached —
      firing without a confirmed deploy") instead of waiting forever.
3. **Trust Done = deployed** — an arrangement rather than a knob: only enable
   `rerun_on_fix` on boards/flows where a ticket reaches Done *after* deployment is
   confirmed. Then delay 0 with no gate is safe.
4. **Branch-scoped QA** (still future) — point the scenario driver at the fix's
   branch preview instead of the deployed environment. **This is not what
   `deployment_gate` does**: the gate keeps validating the deployed environment and
   only changes *when* the rerun runs, whereas this changes *what* it validates.
   Still unimplemented — and not merely unbuilt: there is no preview target to aim
   at, since `main` is the only branch that ships and `Deployment` is keyed by
   `(workspace_id, environment)` with no branch/ref column. Noted for completeness.

If you can't satisfy any of these, leave `rerun_on_fix` **off** and re-run QA
manually after you've confirmed the deploy.

## MCP / REST / UI surface

- `create_qa_scenario` / `update_qa_scenario` accept `target_environment` at the
  scenario level, plus `on_failure_ticket.rerun_on_fix`, `.max_rerun_attempts`,
  `.rerun_delay_seconds`, `.deployment_gate`. Same fields over REST
  (`POST /api/qa/scenarios`, `PATCH /api/qa/scenarios/:id`).
- `report_deployment` (MCP) / `POST /api/deployments/report` upsert the commit live
  in an environment — this is the signal that releases the fact-gate, so a scenario
  with `deployment_gate` on is only as timely as whatever reports its deploys.
  `GET /api/deployments` lists what each environment is currently on.
- `get_qa_run` / `list_qa_runs` expose `rerun_generation`, plus `tested_commit` /
  `tested_environment` — the server-authoritative record of the commit that was
  live in the scenario's `target_environment` when the run was dispatched
  (`''` when the scenario is not env-bound).
- QaManager scenario editor: **"Target environment (배포 인지 — Deployment.environment)"**
  field, and under "실패 시 → 수정 티켓 자동 생성" the
  **"수정 티켓 Done 시 → 시나리오 자동 재실행"** toggle + max-attempts / delay inputs
  and the **"배포 사실에 게이팅 (deployment_gate)"** checkbox (which warns inline when
  `target_environment` is empty).
- QA RunDetail shows a `🔁 재실행 #n` badge, a `🚀 tested @ <env>: <sha>` badge when
  the run was env-bound, plus the existing `→ 생성된 티켓` link.
