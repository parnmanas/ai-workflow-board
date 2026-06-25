# 보안 점검 스케줄러 + 수동 전체 점검

> Ticket 7c07c19d. QA 스케줄러/batch 패턴(ticket b6bb7efd / daf06262)을 보안 점검에
> 이식. 순차 batch(`SecurityRunBatch`) 위에 얹는 **자동 트리거 레이어**.
> 스케줄은 batch 오케스트레이터(`SecurityRunService.startBatch`)를 재사용한다 —
> 스케줄은 "언제", batch 는 "무엇을". 별도의 실행 경로를 만들지 않는다.

"주기적으로 혹은 필요할 때 보안 점검을 할 수 있게" 두 가지를 제공한다:

1. **수동 전체 점검** (필요할 때) — enabled 프로파일들을 **순차** 실행하는 batch.
   `SecurityRun` 은 비동기로 종결되므로(start 는 즉시 반환, 종결은 한참 뒤
   `complete_security_run`/reaper) for-loop 으로 돌리면 전부 동시에 뜬다. 그래서 batch 는
   **현재 인덱스 하나만** dispatch 하고, 그 run 이 종결될 때 `onRunFinalized()` 가 다음
   인덱스를 dispatch 한다 → run 이 겹치지 않는다(동시 금지).
2. **스케줄러** (주기적) — `SecuritySchedule` 이 due 하면 백그라운드 tick 이 발화한다.
   `kind='scan'` 은 같은 batch 오케스트레이터를 kick 하고, `kind='checklist_refresh'` 는
   대상 프로파일의 체크리스트 갱신을 디스패치한다 (아래 "종류(kind)" 절).

```
스케줄이 due (next_run_at <= now)
  → SecurityScheduleService.runOnce() 가 next_run_at 을 다음 발화로 먼저 전진시키고 저장 (멱등)
    → kind 로 분기:
       ├─ kind='scan' (기본)
       │   → 이전 batch 가 아직 running 이면 SKIP (중복 dispatch 방지)
       │     → 아니면 SecurityRunService.startBatch() 호출
       │       → scope='all'      → 실행 시점 scope 의 enabled 프로파일로 확장 (id 스냅샷 없음)
       │       → scope='selected' → profile_ids 를 순서대로
       │     → last_run_at / last_batch_id 갱신
       └─ kind='checklist_refresh'
           → SecurityRunService.refreshChecklistsForScope() 호출 (SKIP-if-running 가드 없음)
             → scope 규칙은 scan 과 동일하게 프로파일 resolve
             → 각 프로파일에 refresh_security_checklist 디스패치 (run/batch row 미생성)
           → last_run_at 만 갱신 (batch 없음 → last_batch_id 그대로)
```

## 종류 (kind) — 점검(scan) vs 체크리스트 갱신(checklist_refresh)

`SecuritySchedule.kind` (ticket e07ea821) 가 스케줄이 발화할 때 **무엇을** 할지 정한다.
체크리스트 **갱신**(`refresh_security_checklist`)은 원래 수동만 가능했는데, 이 kind 로
주기/수동 둘 다 채운다. **점검(scan)** 과 **갱신(refresh)** 은 끝까지 분리된다 — 점검 run 은
저장된 체크리스트를 **고정 적용**(결정적), 갱신은 체크리스트 항목 자체를 update.

| kind | 발화 시 동작 | run/batch row | 동시성 가드 | 배포 타이밍 함정 |
|------|-------------|---------------|-------------|------------------|
| `'scan'` (기본, 기존/NULL 행) | 순차 점검 batch (`startBatch`) | SecurityRun + SecurityRunBatch 생성 | SKIP-if-running (직전 batch running 이면 드롭) | **있음** — 옛 코드 가짜 그린 (아래 ⚠️) |
| `'checklist_refresh'` | 각 프로파일에 체크리스트 갱신 디스패치 (`refreshChecklistsForScope`) | **생성 안 함** (체크리스트 update, findings 아님) | **없음** (scan batch running 과 독립) | **없음** — 코드를 점검하지 않고 항목만 갱신 |

- **scope 규칙은 두 kind 가 동일** — `scope='all'` 은 실행 시점 scope 의 enabled 프로파일을
  resolve(시나리오 추가/삭제 자동 반영, id 스냅샷 없음), `scope='selected'` 는 `profile_ids`.
- **갱신은 run row 를 안 만든다** → 점검 히스토리/배치 커서/증분 baseline 을 더럽히지 않는다.
  그래서 scan 의 순차 종결 오케스트레이션(`onRunFinalized`)이 불필요 — 한 번에 전부 디스패치하고,
  한 프로파일 실패(삭제/disabled)는 로그 후 skip 하여 나머지를 막지 않는다.
- **비파괴적** — 갱신은 agent 가 WebSearch 한 결과를 `update_security_profile` 로 써넣는 흐름이라,
  WebSearch 실패/레이트리밋 시 기존 체크리스트는 그대로 유지된다(파괴적 덮어쓰기 없음).
- **별개 주기 권고** — 점검은 코드 변경에 맞춰 자주, 갱신은 보안 지식의 변화 속도에 맞춰 드물게
  (예: 주 1회) 도는 게 자연스럽다. 두 목적을 **별도 스케줄**(서로 다른 kind/cadence)로 두는 걸 권장.
- **backward-compat** — 기존 scan 스케줄이 NULL `kind` 로 와도 `'scan'` 으로 취급
  (`normalizeScheduleKind`). 마이그레이션은 synchronize 가 default `'scan'` 컬럼을 자동 추가.

## Moving parts

| Piece | Where | Role |
|-------|-------|------|
| `SecurityRunBatch` 엔티티 | `entities/SecurityRunBatch.ts` | 순차 batch 커서 (profile_ids, run_ids, current_index, rollup) |
| `SecuritySchedule` 엔티티 | `entities/SecuritySchedule.ts` | 스케줄 정의 (kind, scope, cadence, next/last run) |
| `SecuritySchedule.kind` | entity | `'scan'` (기본, 점검 batch) \| `'checklist_refresh'` (항목 갱신, run 미생성) |
| `SecuritySchedule.scope` | entity | `'all'` (실행 시 resolve) \| `'selected'` (profile_ids) — 두 kind 공통 |
| 체크리스트 갱신 (scope 일괄) | `security-run.service.ts` | `refreshChecklistsForScope` (각 프로파일 `startChecklistRefresh`, run 미생성) |
| `SecuritySchedule.profile_ids` | entity (simple-json) | scope='selected' 일 때 순서 있는 id 목록 |
| `SecuritySchedule.cron` / `interval_ms` | entity | **정확히 하나** 의 cadence (둘 다/둘 다 없음 → 거부) |
| `SecurityRun.batch_id` / `batch_index` | entity | batch 멤버십 — 종결 시 batch 전진의 키 |
| 배치 오케스트레이션 | `security-run.service.ts` | `startBatch` / `getBatch` / `onRunFinalized` |
| `SecurityScheduleService` | `modules/security/security-schedule.service.ts` | CRUD + 백그라운드 tick + dispatch |
| `qa-cron.ts` | `modules/qa/qa-cron.ts` | 의존성 없는 5-필드 cron 평가기 (UTC) — **재사용** |
| REST | `security-profile.controller.ts` | `/api/security/batches` + `/api/security/schedules` CRUD + `:id/run-now` + `tick` |
| MCP | `tools/security-tools.ts`, `tools/security-schedule-tools.ts` | batch + schedule 툴 |

## Cadence — cron vs interval

정확히 하나만 설정한다. (qa-cron.ts 를 그대로 재사용 — 새 의존성 추가는 lockfile 재생성
footgun 이고, 두 번째 사본은 drift 만 만든다.)

- **`interval_ms`** — 고정 간격(ms). `next_run_at = now + interval_ms`. 단순/주기적.
- **`cron`** — 5-필드 표준 cron, **모두 UTC** 로 해석:
  `분(0-59) 시(0-23) 일(1-31) 월(1-12) 요일(0-6, 일=0)`.
  각 필드는 `*`, `a`, `a-b`, `a-b/n`, `*/n`, 콤마 목록 지원. 일요일은 `0` (7 불가).
  일/요일이 **둘 다** 제한되면 표준 Vixie-cron OR 규칙(둘 중 하나 매치).

## 멱등 / 중복 방지

- 매 tick, due 한 스케줄의 `next_run_at` 을 **dispatch 전에** 다음 발화로 전진시켜
  저장한다 → 재진입/중첩 tick 은 커서가 이미 `now` 를 지난 것을 보고 no-op.
- `next_run_at` 은 옛 값이 아니라 **`now`(발화 시점)** 기준으로 계산 → 서버가 죽어 있던
  동안 놓친 발화를 폭주로 backfill 하지 않는다 (한 번 발화 후 전진).
- **SKIP 정책** (queue 아님): 직전 batch(`last_batch_id`)가 아직 `running` 이면 이번
  발화는 드롭(`next_run_at` 은 이미 전진) + 로그. 느린 batch 가 중첩될 수 없다.
- 고아 자가치유: enabled 인데 `next_run_at` 이 null 이면 발화 없이 커서만 전진.
- batch 전진도 같은 순서: `onRunFinalized` 는 `batch_index === current_index` 일 때만
  동작하고, dispatch 전에 커서를 먼저 전진/저장한다 → run 의 재종결(complete 재호출 /
  reaper 중복)이 다음 프로파일을 이중 dispatch 하지 않는다.

## ⚠️ 배포 타이밍 (ticket 467dbc7a / #autoticket 과 같은 함정)

보안 점검은 **돌고 있는(배포된) 서버** 의 코드를 친다. fix 머지(main) ≠ prod 배포
(`production.private` auto-deploy). fix 머지 직후 발화하는 스케줄은 **배포 전 옛 코드**
를 점검해 "가짜 그린" 을 만들 수 있다. 두 겹의 완화책:

1. **점검 대상 commit 의 명시 기록** — 모든 `SecurityRun` 은 agent 가 실제로 검사한
   worktree HEAD SHA 를 `scanned_commit` 에 기록한다(#foundation cfd74638). 스케줄이
   *어떤 commit* 을 점검했는지는 run 에서 항상 복원 가능하다 — 스케줄이 점검 대상을
   숨기지 않는다.
2. **운영적 cadence** — rerun-on-fix 의 delay gate 와 달리 고정-cadence 스케줄에는
   deferral 의 기준이 될 머지 edge 가 없다:

   > cadence 를 main→prod 배포 지연보다 **넉넉히** 잡거나(고정 wall-clock 시각 cron, 혹은
   > 멀티 분 interval), 발화가 배포 이후에 떨어지게 한다.

## 환경 변수

| Var | 기본 | 설명 |
|-----|------|------|
| `SECURITY_SCHEDULER_ENABLED` | `true` | `false` 면 백그라운드 tick 비활성 (CRUD/run-now/batch 는 동작) |
| `SECURITY_SCHEDULER_TICK_MS` | `30000` | sweep 주기 (clamp 5s–1h). 짧은 interval 스케줄의 해상도 |

tick 은 `SecurityRunReaperService`/`QaScheduleService` 패턴 그대로:
`OnModuleInit` + `setInterval` + `unref()` + env on/off + clamp 된 cadence.

## REST / MCP

```
# 수동 전체 점검 (batch)
POST   /api/security/batches                  { workspace_id, board_id?, profile_ids?[], all?, stop_on_fail? }
GET    /api/security/batches/:id?workspace_id=..

# 스케줄
GET    /api/security/schedules?workspace_id=..[&board_id=..]
GET    /api/security/schedules/:id?workspace_id=..
POST   /api/security/schedules                { workspace_id, name, kind?, scope, profile_ids?, cron|interval_ms, .. }
PATCH  /api/security/schedules/:id            { workspace_id, ..부분 갱신(kind 포함).. }
DELETE /api/security/schedules/:id?workspace_id=..
POST   /api/security/schedules/:id/run-now    { workspace_id }   # enabled 무시, next_run_at 안 건드림
                                              # 응답은 kind 로 분기: scan→{kind:'scan', batch, refreshes:null},
                                              #                      checklist_refresh→{kind:'checklist_refresh', batch:null, refreshes:[{profile_id,room_id}]}
POST   /api/security/schedules/tick           # 운영 lever / 결정적 테스트 — sweep 1회 즉시
```

모든 엔드포인트는 컨트롤러 레벨 `MANAGE_ACTIONS` 권한(프로파일/QA 와 동일).
MCP 동등 툴: `start_security_batch`, `get_security_batch`, `list_security_schedules`,
`get_security_schedule`, `create_security_schedule`, `update_security_schedule`,
`delete_security_schedule`, `run_security_schedule_now`.

## 검증 (자체 테스트)

- `test/security-schedule-behavior.test.mjs` — `runOnce()` 의 dispatch/멱등/
  SKIP-if-running/scope all·selected/disabled 음성 케이스/run-now/orphan 자가치유.
  **+ kind='checklist_refresh'**: refresh 디스패치(batch 아님)/scope all·selected/
  SKIP-if-running 가드 없음/run-now 분기/NULL kind=scan backward-compat.
- `test/qa-flows/security-schedule-checklist-refresh.test.mjs` — kind='checklist_refresh'
  스케줄 e2e: 실 scheduler tick 으로 발화 → 프로파일 refresh + **run row 0건** 확인,
  scope=all 이 disabled 프로파일 skip, run-now 의 kind 분기, scan 스케줄 회귀(여전히 batch).
- `test/qa-flows/security-batch-sequencing.test.mjs` — 프로파일 3개 batch 의 순차
  dispatch(동시 금지)/실패-계속/멱등 전진/종결 rollup (MCP e2e).
- `test/qa-flows/mcp-tools-surface.test.mjs` — 8개 신규 MCP 툴 등록 canary.
