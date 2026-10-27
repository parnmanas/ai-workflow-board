# QA Scenario Catalogue

The scenario-QA feature (`QaScenario` / `QaRun`, `apps/server/src/modules/qa/`,
MCP `qa-tools.ts`) shipped with an empty catalogue — `list_qa_scenarios` returned
`[]`. This document is the coverage map for the **starter catalogue** (ticket
`026e3321`) that fills it, distilled from the admin self-test harness
(`test/qa-flows/*.test.mjs` + `qa.controller.ts`).

The catalogue itself is data, defined once in
[`apps/server/src/modules/qa/qa-seed-scenarios.ts`](../apps/server/src/modules/qa/qa-seed-scenarios.ts)
and seeded into an owning account with
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
automation schedules, Postgres race tests …) are service-level regressions rather
than user journeys.

## Seeding (reproducibility)

The catalogue is reproducible across environments. Build the server first so the
compiled catalogue exists, then run the seeder against a live AWB:

```bash
(cd apps/server && npm run build)

node apps/server/scripts/seed-qa-scenarios.mjs \
  --base-url http://localhost:7701 \
  --account <account_id> \
  --runtime <runtime-spec.json>   # the QA agent's RuntimeSpec (target_runtime)
  # --api-key <agent_key>         # or run against MCP_DEV_MODE
  # --only ticket-lifecycle,chat-room-messaging
  # --dry-run
```

The seeder is **idempotent**: each scenario carries a stable `key:<key>` tag, so
re-running matches the existing row and `update_qa_scenario`s it in place rather
than duplicating. `--dry-run` prints the CREATE/UPDATE plan without writing.
The seeder's `--account` flag is its retained compatibility name for an account
UUID; new MCP calls use `account_id`. The QA work list aggregates accessible
accounts and de-duplicates Global scenarios by ID.

### Documented MCP-call bundle (manual alternative)

Without the script, the same result is a loop of MCP calls — for each catalogue
entry: `list_qa_scenarios(account_id)` to find a row whose `tags`
contain `key:<key>`, then `update_qa_scenario(scenario_id, …)` if found else
`create_qa_scenario(account_id, name, description, steps, target_runtime, qa_driver, qa_driver_config, tags, max_runs)`.
The `steps`, `tags`, and `qa_driver*` values come straight from
`QA_SEED_SCENARIOS` in `qa-seed-scenarios.ts`.

## Running a scenario

### 프로젝트와 결과 처리

QA 시나리오의 `project_id`는 같은 Account의 기존 Project를 가리킨다. QA 화면에서
프로젝트·이름/설명/태그·활성 여부로 필터링하고 **필터 결과 실행** 또는 **선택 순차 실행**을
누르면 현재 보이는 활성 시나리오만 실행한다. 숨겨진 선택 항목과 비활성 시나리오는 실행하지 않는다.
기존 시나리오는 프로젝트 미지정으로 유지되며 편집 화면에서 연결할 수 있다.

별도 `repo_ref`가 없으면 선택한 프로젝트의 저장소와 기본 브랜치를 검증에 사용한다.
실패 티켓의 프로젝트는 `on_failure_ticket.project_id` → 시나리오 `project_id` 순서로 정한다.
프로젝트를 연결한 시나리오의 수정 담당자는 명시한 `assignee_runtime` → 티켓 프로젝트의
`default_assignee` → QA 실행 담당자 순서다. 프로젝트 미지정 시나리오는 기존 배정 순서를 유지한다.
프로젝트를 바꾸면 이전 빌드의 warm 상태를 초기화한다.

결과는 항상 실행 기록에 저장된다. 시나리오마다 다음 옵션을 독립적으로 선택할 수 있다.

- **실패 티켓 자동 생성**: 기존 `on_failure_ticket.enabled`. 생성 상태(todo/backlog),
  우선순위, 태그, 프로젝트 재정의, 담당자, 중복 방지와 수정 후 재실행을 설정한다.
  `failed`, `error`, `build_failed` 결과를 처리한다.
- **내용을 채널에 공유**: `result_delivery.channel_ids`로 같은 Account의 활성 Discord 채널을 선택한다.
  채널 설정에 봇 토큰과 대상 채널이 등록되어 있어야 한다.
- **결과를 메일로 보내기**: `result_delivery.email`에 기존 비즈니스 메일의
  `connection_id`, 등록된 발신 주소 `from`, 최대 10개의 수신 주소 `to`를 지정한다.
  발신 가능한 활성 SMTP/JMAP 연결과 같은 Account의 서버 전용 Mail credential,
  소유자의 비즈니스 권한이 필요하다. 인증 정보를 시나리오에 복사하지 않는다.
- 공유·메일 전달 시점은 `result_delivery.when`의 `failure`(실패만, 기본값) 또는 `always`(모든 종료 결과)다.
  티켓을 끄고 공유나 메일만 선택할 수 있고, 전부 끄면 실행 기록만 남긴다.

예시 (REST와 MCP 생성/수정에서 같은 필드를 사용):

```json
{
  "project_id": "<project-id>",
  "on_failure_ticket": { "enabled": false },
  "result_delivery": {
    "when": "always",
    "channel_ids": ["<channel-id>"],
    "email": { "connection_id": "<mail-connection-id>", "from": "qa@example.com", "to": ["owner@example.com"] }
  }
}
```

`result_delivery: null`로 전송을 끈다. 시작 시 프로젝트·티켓·공유·메일 설정을
`QaRun.result_policy_snapshot`에 고정하므로 실행 도중 편집해도 이미 시작한 결과의 수신처는 바뀌지 않는다.
전송 직전에도 소유권과 연결 상태를 재확인한다. 결과의 `delivery_status`와 `delivery_results`에서
완료·실패·일부 실패를 확인할 수 있다. 같은 run을 다시 완료해도 재전송하지 않으며,
SMTP 응답 불명이나 프로세스 중단으로 전송이 불확실하면 발신 기록을 확인한다(자동 재시도 없음).
공유·메일 오류는 QA 판정이나 다음 시나리오 실행을 실패시키지 않는다.

`GET /api/qa/scenarios?project_id=...` 및 `list_qa_scenarios`는 프로젝트 필터를 지원한다.
`POST /api/qa/batches`와 `start_qa_batch`도 `project_id`를 받으며, 명시적 `scenario_ids`와 함께
보내면 같은 프로젝트의 활성 시나리오만 실행한다. 프로젝트별 예약 실행은 [QA 스케줄러](./qa-scheduler.md)를 따른다.

### 실행 흐름

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
