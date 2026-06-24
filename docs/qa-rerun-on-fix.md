# QA → fix → QA closed loop (rerun-on-fix)

> Ticket 467dbc7a. Builds on the on-failure auto-ticket feature (ticket 52a93654,
> `docs`-less but see `qa-failure-ticket.service.ts`).

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
| `QaScenario.on_failure_ticket.rerun_delay_seconds` | entity | deploy-timing gate (default **0** = immediate) |
| `QaRerunOnFixService` | `modules/qa/qa-rerun-on-fix.service.ts` | subscribes to `activityEvents`, fires the rerun |
| `Ticket.qa_rerun_dispatched_at` | entity | idempotency stamp (once per terminal entry) |
| `QaRun.rerun_generation` | entity | generation stamped on each rerun (0 = first run) |
| `qa-rerun:<n>` ticket label | label convention | generation carrier: fix-ticket → run → next fix-ticket |

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
hit the live host). The AWB server **auto-deploys from `production.private` only
*after* `main` merges** (the agent-manager is a separate, lagging local piece —
unrelated here). A fix ticket reaching **Done** means *merged to main*, **not
necessarily deployed**.

Therefore an **immediate** rerun (`rerun_delay_seconds = 0`) can re-validate the
**pre-fix** code and "fail again" even though the fix is correct — burning a
generation against stale binaries.

Mitigations, in order of preference:

1. **`rerun_delay_seconds`** — set it to your typical main→prod deploy lag. The
   rerun is deferred in-process so the deploy can land first. This is the default
   knob and the reason reruns are designed to be gate-able. ⚠️ The delay is
   **best-effort / in-process**: a server restart during the window drops the
   pending rerun (the fix ticket is already Done, so it won't re-fire unless moved
   out of and back into Done). It is a timing nicety, not a durable scheduler.
2. **Trust Done = deployed** — only enable `rerun_on_fix` on boards/flows where a
   ticket reaches Done *after* deployment is confirmed. Then delay 0 is safe.
3. **Branch-scoped QA** (future) — point the scenario driver at the fix's branch
   preview instead of prod. Out of scope for this ticket; noted for completeness.

If you can't satisfy any of these, leave `rerun_on_fix` **off** and re-run QA
manually after you've confirmed the deploy.

## MCP / REST / UI surface

- `create_qa_scenario` / `update_qa_scenario` accept `on_failure_ticket.rerun_on_fix`,
  `.max_rerun_attempts`, `.rerun_delay_seconds`.
- `get_qa_run` / `list_qa_runs` expose `rerun_generation`.
- QaManager scenario editor: **"수정 티켓 Done 시 → 시나리오 자동 재실행"** toggle +
  max-attempts / delay inputs (under "실패 시 → 수정 티켓 자동 생성").
- QA RunDetail shows a `🔁 재실행 #n` badge plus the existing `→ 생성된 티켓` link.

The companion stdio MCP plugin must be version-bumped whenever this schema
changes (see CLAUDE.md → "Plugin version sync" / the `awb-plugin-sync` skill).
