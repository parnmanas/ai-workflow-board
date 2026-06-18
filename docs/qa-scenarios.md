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

> **Driver.** Every starter scenario uses the `awb-mcp` driver: the QA agent
> drives AWB's own MCP/REST surface (the `http-api` driver contract in
> [`docs/qa-driver-guide.md`](./qa-driver-guide.md) §6) and records evidence with
> `save_resource` + `record_qa_step`. The step `mcp_tool` fields are real AWB MCP
> tool names so the agent runs them verbatim; `params` carry `{{placeholder}}`
> tokens the agent fills from run context.

## Coverage map (scenario → feature → admin self-test source)

| # | Scenario `key` | Feature area | Backing self-test(s) |
|---|---|---|---|
| 1 | `ticket-lifecycle` | Ticket lifecycle + role-routed triggers + terminal stamp + auto-advance | `ticket-lifecycle`, `auto-advance-unassigned` |
| 2 | `comment-mention-trigger` | Comment triggers + scoped `@[role:…]` mentions | `comment-trigger`, `comment-mention` |
| 3 | `chat-room-messaging` | Chat rooms: participants, messages, attachment, cursor paging, search | `multi-user-chat`, `chat-message-read`, `chat-attachments` |
| 4 | `mcp-agent-roundtrip` | Closed loop: SSE trigger → agent calls MCP tools | `mcp-agent-roundtrip` |
| 5 | `action-run` | Action authoring + dispatch + FIFO run history | `on-ticket-done-hook` |
| 6 | `benchmark-lifecycle` | Benchmark run → per-dimension score upsert → leaderboards | `benchmark-scoring`, `benchmark-lifecycle`, `benchmark-dispatch` |
| 7 | `board-pause-resume` | Board pause gate drops triggers; resume restores | `board-pause` |
| 8 | `archive-unarchive` | Archive removes from reads + detector; unarchive restores | `archive-edge-paths` |
| 9 | `workspace-board-move` | Cross-workspace board move re-stamps board/columns/tickets | `workspace-move-board` |
| 10 | `column-role-policy-auto-advance` | Column role routing + auto-advance vs HALT-unassigned | `auto-advance-unassigned`, `auto-advance-halt-unassigned`, `column-role-policy` |
| 11 | `backlog-promotion` | Focus-gated, chain-aware backlog promotion | `backlog-promotion-chain`, `workflow-state-cap`, `focus-selector-chain-head` |
| 12 | `resource-media-attachment` | Resource upload + comment media attachment (evidence path) | `comment-media-e2e` |

### Self-test coverage NOT yet mirrored as a scenario

These admin self-tests stay unit-level for now (they exercise internal services
directly or are scale/security probes that don't map cleanly to a
user-journey scenario). Listed so the gap is explicit, not silently dropped:

- `large-data`, `multi-agent-concurrency` — scale / concurrency budgets.
- `stuck-ticket-detector`, `column-role-policy` (enrichment half) — detector sweeps.
- `focus-collapse-per-agent`, `workflow-focus-selector` — focus-selector internals.
- `self-improvement-remote-auth` — spoofed-header auth gate.
- `prompt-template-refresh`, `prompt-template-refresh-integrate` — migrations.
- `workspace-move-agent` — agent move (credential/api-key carry).
- `terminal-reopen-guard`, `unpend-emits-trigger`, `self-trigger-guard`,
  `comment-content-projection`, `mcp-schema-version`, `mcp-tools-surface`.

## Seeding (reproducibility)

The catalogue is reproducible across environments. Build the server first so the
compiled catalogue exists, then run the seeder against a live AWB:

```bash
(cd apps/server && npm run build)

node apps/server/scripts/seed-qa-scenarios.mjs \
  --base-url http://localhost:7701 \
  --workspace <workspace_id> \
  --agent <target_qa_agent_id> \
  --board <board_id>            # optional; omit for workspace-scope
  # --api-key <agent_key>       # or run against MCP_DEV_MODE
  # --only ticket-lifecycle,chat-room-messaging
  # --dry-run
```

The seeder is **idempotent**: each scenario carries a stable `key:<key>` tag, so
re-running matches the existing row and `update_qa_scenario`s it in place rather
than duplicating. `--dry-run` prints the CREATE/UPDATE plan without writing.

### Documented MCP-call bundle (manual alternative)

Without the script, the same result is a loop of MCP calls — for each catalogue
entry: `list_qa_scenarios(workspace_id, board_id)` to find a row whose `tags`
contain `key:<key>`, then `update_qa_scenario(scenario_id, …)` if found else
`create_qa_scenario(workspace_id, board_id, name, description, steps, target_agent_id, qa_driver, qa_driver_config, tags, max_runs)`.
The `steps`, `tags`, and `qa_driver*` values come straight from
`QA_SEED_SCENARIOS` in `qa-seed-scenarios.ts`.

## Running a scenario

`start_qa_run(scenario_id)` creates a `QaRun` + a `ChatRoom`, adds the scenario's
`target_agent_id`, and posts the rendered step prompt (`qa-prompt.ts`). The agent
then, per step: drives the `awb-mcp` driver, uploads evidence with `save_resource`,
and calls `record_qa_step(run_id, idx, status, log, artifact_resource_ids)`. It
finishes with `complete_qa_run(run_id, status, summary)`. Re-running is just
another `start_qa_run` → a fresh `QaRun`, so history accumulates (FIFO-capped at
`max_runs`).

The run loop (render → start → record → complete, including step upsert + artifact
accumulation) is regression-guarded by
[`test/qa-flows/qa-run-lifecycle.test.mjs`](../apps/server/test/qa-flows/qa-run-lifecycle.test.mjs),
registered in the admin `run-flows` harness under category `Flow-QA`.
