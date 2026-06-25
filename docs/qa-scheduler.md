# QA 스케줄러 — 시나리오 자동 실행

> Ticket b6bb7efd. 순차 batch(ticket daf06262) 위에 얹는 **자동 트리거 레이어**.
> 스케줄은 batch 오케스트레이터(`QaRunService.startBatch`)를 재사용한다 — 스케줄은
> "언제", batch 는 "무엇을". 별도의 실행 경로를 만들지 않는다.

예약된 시각이 되면 백그라운드 tick 이 due 한 스케줄을 찾아 순차 batch 를 시작한다:

```
스케줄이 due (next_run_at <= now)
  → QaScheduleService.runOnce() 가 next_run_at 을 다음 발화로 먼저 전진시키고 저장 (멱등)
    → 이전 batch 가 아직 running 이면 SKIP (중복 dispatch 방지)
      → 아니면 QaRunService.startBatch() 호출
        → scope='all'      → 실행 시점 scope 의 enabled 시나리오로 확장 (id 스냅샷 없음)
        → scope='selected' → scenario_ids 를 순서대로
      → last_run_at / last_batch_id 갱신
```

agent prompt 파싱은 없다. 트리거는 순수하게 시간 기반이고, batch 실행은 직접
`QaRunService.startBatch` 호출이다.

## Moving parts

| Piece | Where | Role |
|-------|-------|------|
| `QaSchedule` 엔티티 | `entities/QaSchedule.ts` | 스케줄 정의 (scope, cadence, next/last run) |
| `QaSchedule.scope` | entity | `'all'` (실행 시 resolve) \| `'selected'` (scenario_ids) |
| `QaSchedule.scenario_ids` | entity (simple-json) | scope='selected' 일 때 순서 있는 id 목록 |
| `QaSchedule.cron` / `interval_ms` | entity | **정확히 하나** 의 cadence (둘 다/둘 다 없음 → 거부) |
| `QaSchedule.next_run_at` | entity | tick 이 비교하는 다음 발화 시각 (disabled → null) |
| `QaScheduleService` | `modules/qa/qa-schedule.service.ts` | CRUD + 백그라운드 tick + dispatch |
| `qa-cron.ts` | `modules/qa/qa-cron.ts` | 의존성 없는 5-필드 cron 평가기 (UTC) |
| REST | `qa-scenario.controller.ts` | `/api/qa/schedules` CRUD + `:id/run-now` |
| MCP | `tools/qa-schedule-tools.ts` | `list/get/create/update/delete_qa_schedule` + `run_qa_schedule_now` |
| 클라 UI | `components/admin/QaManager.tsx` | QA 메뉴 "스케줄" 섹션 (목록 + 에디터) |

## Cadence — cron vs interval

정확히 하나만 설정한다.

- **`interval_ms`** — 고정 간격(ms). `next_run_at = now + interval_ms`. 단순/주기적.
- **`cron`** — 5-필드 표준 cron, **모두 UTC** 로 해석:
  `분(0-59) 시(0-23) 일(1-31) 월(1-12) 요일(0-6, 일=0)`.
  각 필드는 `*`, `a`, `a-b`, `a-b/n`, `*/n`, 콤마 목록 지원. 일요일은 `0` (7 불가).
  일/요일이 **둘 다** 제한되면 표준 Vixie-cron OR 규칙(둘 중 하나 매치).

cron 은 내재 시간대가 없으므로 UTC 고정으로 `next_run_at` 을 결정적 instant 로 만든다
(서버 로컬 TZ 무관). 에디터/문서에 UTC 임을 명시한다.

## 멱등 / 중복 방지

- 매 tick, due 한 스케줄의 `next_run_at` 을 **dispatch 전에** 다음 발화로 전진시켜
  저장한다 → 재진입/중첩 tick 은 커서가 이미 `now` 를 지난 것을 보고 no-op.
- `next_run_at` 은 옛 `next_run_at` 이 아니라 **`now`(발화 시점)** 기준으로 계산 →
  서버가 죽어 있던 동안 놓친 발화를 폭주로 backfill 하지 않는다 (한 번 발화 후 전진).
- **SKIP 정책** (queue 아님): 직전 batch(`last_batch_id`)가 아직 `running` 이면 이번
  발화는 드롭(`next_run_at` 은 이미 전진) + 로그. 느린 batch 가 중첩될 수 없다.
- 고아 자가치유: enabled 인데 `next_run_at` 이 null(레거시 row / disabled 중 cadence
  편집)이면 발화 없이 커서만 전진 — enable 이 깜짝 즉시 실행을 만들지 않는다.

## ⚠️ 배포 타이밍 (ticket 467dbc7a 와 같은 함정)

QA 는 **돌고 있는 서버** 를 검증한다. fix 머지(main) ≠ prod 배포
(`production.private` auto-deploy). fix 머지 직후 발화하는 스케줄은 **배포 전 옛 코드**
를 검증할 수 있다. rerun-on-fix 의 delay gate 와 달리 고정-cadence 스케줄에는 deferral
의 기준이 될 머지 edge 가 없다 — 완화책은 운영적이다:

> cadence 를 main→prod 배포 지연보다 **넉넉히** 잡거나(고정 wall-clock 시각 cron, 혹은
> 멀티 분 interval), 발화가 배포 이후에 떨어지게 한다.

## 환경 변수

| Var | 기본 | 설명 |
|-----|------|------|
| `QA_SCHEDULER_ENABLED` | `true` | `false` 면 백그라운드 tick 비활성 (CRUD/run-now 는 동작) |
| `QA_SCHEDULER_TICK_MS` | `30000` | sweep 주기 (clamp 5s–1h). 짧은 interval 스케줄의 해상도 |

tick 은 `QaRunReaperService`/`DbRetentionService` 패턴 그대로:
`OnModuleInit` + `setInterval` + `unref()` + env on/off + clamp 된 cadence.

## REST / MCP

```
GET    /api/qa/schedules?workspace_id=..[&board_id=..]
GET    /api/qa/schedules/:id?workspace_id=..
POST   /api/qa/schedules                     { workspace_id, name, scope, scenario_ids?, cron|interval_ms, .. }
PATCH  /api/qa/schedules/:id                 { workspace_id, ..부분 갱신.. }
DELETE /api/qa/schedules/:id?workspace_id=..
POST   /api/qa/schedules/:id/run-now         { workspace_id }   # enabled 무시, next_run_at 안 건드림
```

모든 엔드포인트는 컨트롤러 레벨 `MANAGE_ACTIONS` 권한(시나리오/batch 와 동일).
MCP 동등 툴: `list_qa_schedules`, `get_qa_schedule`, `create_qa_schedule`,
`update_qa_schedule`, `delete_qa_schedule`, `run_qa_schedule_now`.

## 검증 (자체 테스트)

- `test/qa-cron.test.mjs` — cron 파서/`nextCronAfter`/OR 규칙/불가능 표현식 null.
- `test/qa-schedule-behavior.test.mjs` — `runOnce()` 의 dispatch/멱등/SKIP-if-running/
  scope all·selected/disabled 음성 케이스/run-now/orphan 자가치유.
- `test/qa-flows/mcp-tools-surface.test.mjs` — 6개 신규 MCP 툴 등록 canary.
