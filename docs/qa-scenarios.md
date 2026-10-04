# QA Scenario Catalogue

The scenario-QA feature (`QaScenario` / `QaRun`, `apps/server/src/modules/qa/`,
MCP `qa-tools.ts`) shipped with an empty catalogue — `list_qa_scenarios` returned
`[]`. This document is the coverage map for the **starter catalogue** (ticket
`026e3321`) that fills it, distilled from the admin self-test harness
(`test/qa-flows/*.test.mjs` + `qa.controller.ts`).

The catalogue itself is data, defined once in
[`apps/server/src/modules/qa/qa-seed-scenarios.ts`](../apps/server/src/modules/qa/qa-seed-scenarios.ts)
and seeded into a live workspace with
[`apps/server/scripts/seed-qa-scenarios.mjs`](../apps/server/scripts/seed-qa-scenarios.mjs).

> **Driver.** Most starter scenarios use the `awb-mcp` driver (the two `visual-*`
> scenarios use `browser`): the QA agent drives AWB's own MCP/REST surface (the `http-api` driver contract in
> [`docs/qa-driver-guide.md`](./qa-driver-guide.md) §6) and records evidence with
> `save_resource` + `record_qa_step`. The step `mcp_tool` fields are real AWB MCP
> tool names so the agent runs them verbatim; `params` carry `{{placeholder}}`
> tokens the agent fills from run context.

## Coverage map (scenario → feature → backing test)

| # | Scenario `key` | Driver | Feature area | Backing test / recipe |
|---|---|---|---|---|
| 1 | `ticket-lifecycle` | `awb-mcp` | Fixed status lanes (`todo → in_progress → review → done`), terminal stamp set on entering `done` and cleared on reopen; the probe has no assignee so it is never dispatched | `ticket-lifecycle` |
| 2 | `chat-room-messaging` | `awb-mcp` | Chat rooms: participants, messages, attachment, cursor paging, search | `multi-user-chat`, `chat-message-read`, `chat-attachments` |
| 3 | `mcp-agent-roundtrip` | `awb-mcp` | Closed loop: a `todo` ticket with a live assignee is dispatched (`agent_trigger`) → the agent calls MCP tools (`add_comment` + `move_ticket`) | `mcp-agent-roundtrip` |
| 4 | `action-run` | `awb-mcp` | Action authoring + dispatch + FIFO run history | `on-ticket-done-hook` |
| 5 | `archive-unarchive` | `awb-mcp` | Archive removes a ticket from the live ticket list; unarchive restores it | `archive-edge-paths` |
| 6 | `resource-media-attachment` | `awb-mcp` | Resource upload + comment media attachment (evidence path) | `comment-media-e2e` |
| 7 | `visual-core-screens` | `browser` | Screenshots of the core screens (login → Tickets → ticket panel → chat → QA → Resources → Projects) | `apps/server/scripts/qa-visual-capture.mjs` |
| 8 | `visual-ticket-journey-video` | `browser` | mp4 recording of a ticket journey; exercises the `/api/resources/:id/raw` Range-streaming path | `apps/server/scripts/qa-visual-capture.mjs --record-video` |
| 9 | `hermes-live-chat-delivery` | `awb-mcp` | Live-host smoke test: one real chat message to the deployed Hermes Agent, graded for genuine reply vs. allowlisted fail-closed notice (ticket 7a4b14b4, hardening from a837879c) | `apps/agent-manager/test/hermes-chat-dispatch-success.test.mjs` / `-failure.test.mjs` |

Names in the last column without a path are `apps/server/test/qa-flows/<name>.test.mjs`.

### Self-test coverage NOT yet mirrored as a scenario

These self-tests stay unit-level for now (they exercise internal services
directly or are scale/protocol probes that don't map cleanly to a user-journey
scenario). Listed so the gap is explicit, not silently dropped:

- `large-data` — scale budget.
- `comment-mention`, `comment-content-projection`, `comment-pagination` —
  comment internals.
- `mcp-schema-version`, `mcp-tools-surface` — MCP protocol surface.

Most other `test/qa-flows/*` files (orchestration, QA/Security batches,
workspace schedules, Postgres race tests …) are service-level regressions rather
than user journeys.

## Seeding (reproducibility)

The catalogue is reproducible across environments. Build the server first so the
compiled catalogue exists, then run the seeder against a live AWB:

```bash
(cd apps/server && npm run build)

node apps/server/scripts/seed-qa-scenarios.mjs \
  --base-url http://localhost:7701 \
  --workspace <workspace_id> \
  --runtime <runtime-spec.json>   # the QA agent's RuntimeSpec (target_runtime)
  # --api-key <agent_key>         # or run against MCP_DEV_MODE
  # --only ticket-lifecycle,chat-room-messaging
  # --dry-run
```

The seeder is **idempotent**: each scenario carries a stable `key:<key>` tag, so
re-running matches the existing row and `update_qa_scenario`s it in place rather
than duplicating. `--dry-run` prints the CREATE/UPDATE plan without writing.

### Documented MCP-call bundle (manual alternative)

Without the script, the same result is a loop of MCP calls — for each catalogue
entry: `list_qa_scenarios(workspace_id)` to find a row whose `tags`
contain `key:<key>`, then `update_qa_scenario(scenario_id, …)` if found else
`create_qa_scenario(workspace_id, name, description, steps, target_runtime, qa_driver, qa_driver_config, tags, max_runs)`.
The `steps`, `tags`, and `qa_driver*` values come straight from
`QA_SEED_SCENARIOS` in `qa-seed-scenarios.ts`.

## Running a scenario

`start_qa_run(scenario_id)` creates a `QaRun` + a `ChatRoom`, adds the scenario's
target agent (`target_runtime`), and posts the rendered step prompt (`qa-prompt.ts`). The agent
then, per step: drives the `awb-mcp` driver, uploads evidence with `save_resource`,
and calls `record_qa_step(run_id, idx, status, log, artifact_resource_ids)`. It
finishes with `complete_qa_run(run_id, status, summary)`. Re-running is just
another `start_qa_run` → a fresh `QaRun`, so history accumulates (FIFO-capped at
`max_runs`).

The run loop (render → start → record → complete, including step upsert + artifact
accumulation) is regression-guarded by
[`test/qa-flows/qa-run-lifecycle.test.mjs`](../apps/server/test/qa-flows/qa-run-lifecycle.test.mjs),
registered in the admin `run-flows` harness under category `Flow-QA`.

## Multi-phase scenarios (per-phase timeouts)

A scenario whose stages have wildly different normal durations — a Unity drive is
`import` (seconds) → `build` (minutes) → `run` (hours) — should NOT live under a
single run-wide timeout. Define an ordered **phase model** on the scenario and
the run's stages each get their own timeout. Full
reference: [`docs/qa-phases.md`](./qa-phases.md).

Authoring such a scenario adds two things on top of the normal loop:

1. **Declare the phases** — via `create_qa_scenario` / `update_qa_scenario(qa_phases)`:

   ```jsonc
   { "phases": [
       { "id": "import", "label": "Import", "timeout_sec": 600  },
       { "id": "build",  "label": "Build",  "timeout_sec": 1800 },
       { "id": "run",    "label": "Run",    "timeout_sec": 3600 } ] }
   ```

   Defining phases is enough — the reaper auto-selects the `phase_timeouts`
   detector (no separate `liveness_policy` write).

2. **Author phase-transition steps** — start the run on the opening phase, then
   add a `set_qa_phase` call as the agent crosses each stage boundary, so each
   phase's timeout clock starts when the run actually enters it:

   ```
   start_qa_run   { scenario_id, initial_phase: "import" }
     step: import the project              → record_qa_step
   set_qa_phase   { run_id, phase: "build" }   # build budget starts HERE
     step: build the player                → record_qa_step
   set_qa_phase   { run_id, phase: "run" }     # run budget starts HERE
     step: drive the running client        → record_qa_step
   complete_qa_run { run_id, status, summary }
   ```

   Entering a phase resets its deadline baseline, so a slow `import` never eats
   into the `build` budget. If the agent dies mid-stage, the reaper reaps the run
   on **that stage's** timeout and the summary names the overran phase. A scenario
   with no `qa_phases` keeps the legacy single-`running` behavior unchanged.
