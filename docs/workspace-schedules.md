# Workspace Schedules

AWB 에서 **"언제"** 를 정하는 단 하나의 표면. 워크스페이스 단위로 "이 시각에 이걸
해라" 를 등록한다.

무엇을 할지는 **정확히 하나**를 고른다:

| 형태 | 설정하는 값 | 실행 방식 |
| --- | --- | --- |
| 인라인 프롬프트 | `task_prompt` + `target_agent_id` | 새 채팅방을 열고 대상 에이전트를 앉힌 뒤 프롬프트를 첫 메시지로 보낸다 (QA/Security run dispatch 와 같은 모양) |
| **Action 실행** | `action_id` | 등록된 Action 을 `ActionsService.dispatch` 로 발화한다 |

둘 다 설정하면 저장이 거부된다. 허용하면 "어느 쪽이 이기는가" 가 dispatch 구현
세부에 숨고, 스케줄을 편집한 사람이 자기가 무엇을 예약했는지 화면만 보고 알 수
없게 된다.

## Action 형태

대상 에이전트 · 작업 폴더 · repo · 승인(`high_impact`) · fan-out · run 기록은 전부
**Action 이 정의**한다. 스케줄은 시각만 정한다. 그래서 `target_agent_id` 와
`task_prompt` 는 비어 있다 — 남겨 두면 화면에 실행되지 않을 값이 계속 보인다.

발화는 **수동 Run 버튼과 완전히 같은 경로**다(`ActionsService.dispatch`). 스케줄러가
방을 직접 만들지 않는 이유가 이것이다: 직접 만들면 ActionRun 기록 · batch · 승인
게이트가 예약 실행에서만 조용히 빠져, 같은 Action 이 어떻게 시작됐는지에 따라 다르게
동작한다.

Action 이 삭제되면 그 스케줄은 **스스로 비활성화**된다. 영영 성공할 수 없는 것이
확정이라 재시도에 의미가 없고, 매 틱 실패 로그를 쌓는 것보다 꺼진 줄이 목록에 남아
운영자 눈에 띄는 편이 낫다.

## Cadence

`cron`(5-field **UTC**, `modules/qa/qa-cron.ts`) 또는 `interval_ms` 중 하나.
`next_run_at` 이 다음 발화 시각 커서이고, 발화 **전에** 먼저 전진·저장되므로 겹친
틱은 no-op 이 된다.

**UTC 다.** 한국에서 04:00 에 돌리려면 `0 19 * * *` 이다.

## Action 의 cron 이 여기로 옮겨 온 이유 (2026-09-27)

예전에는 `actions.schedule_cron` 이 따로 있었고, 크론 구현이 **두 벌**이었다:

| | Action 쪽 (삭제됨) | Schedule 쪽 (남은 것) |
| --- | --- | --- |
| 시간대 | 서버 **로컬시간** | **UTC** |
| 방식 | 매 분 tick-match | `next_run_at` 커서 |
| 놓친 실행 | **조용히 사라짐** — 그 1분에 서버가 죽어 있으면 그날 실행 없음 | 따라잡음 |
| 문법 | `*`·정수만 | 범위·목록도 |

같은 개념이 두 곳에서 다르게 동작했고, 어느 화면에서 예약을 걸었는지에 따라 운영자가
받는 보장이 달랐다. 따라잡는 쪽으로 합쳤다.

이관은 `1760000000088-MoveActionCronToWorkspaceSchedules`:

- **벽시계 시각을 보존한다** — 서버의 UTC 오프셋만큼 시를 되돌리고, 날짜가 넘어가면
  요일도 함께 민다(`0 4 * * *` KST → `0 19 * * *` UTC, `0 5 * * 1` → `0 20 * * 0`).
  한 식으로 옮길 수 없는 조합(날짜가 넘어가는데 dom 고정, 분 단위 오프셋)은 원문을
  남긴 채 **꺼 둔다** — 조용히 틀린 시각에 도는 것보다 낫다.
- **한 번도 성공한 적 없는 Action 의 스케줄은 꺼서 옮긴다.** 실측(2026-09-27) 크론 4건
  중 2건이 6일 연속 6/6 실패 중이었고 아무도 몰랐다 — 매일 에이전트 세션만 태우고
  산출물이 없었다. 살아 있는 채로 옮기면 같은 낭비가 이어진다. 지우지 않고 끄는
  이유는 크론 식이 사람이 정한 값이라 버리면 복원할 근거가 없기 때문이다.
- 이관 뒤 모든 `actions.schedule_cron` 을 비운다. 값이 남아 있으면 UI·MCP 응답에
  "이 Action 은 매일 04시에 돕니다" 라는 거짓말이 계속 보인다.

`Action.schedule_cron` **컬럼 자체는 이번 릴리스에 아직 남아 있다.** `synchronize: true`
가 마이그레이션보다 먼저 돌기 때문에, 엔티티에서 빼면 이관이 읽기도 전에 컬럼이
사라진다. 이관이 끝난 다음 릴리스에서 컬럼째 제거할 것. 그 사이 저장을 시도하면
`ActionsService` 가 400 으로 거부하고 갈 곳을 알려 준다.

## 이름 규약

엔티티 `WorkspaceSchedule`(`workspace_schedules`), 모듈
`apps/server/src/modules/workspace-schedule/`, REST `/api/workspace-schedules`,
MCP `create_workspace_schedule` / `update_workspace_schedule` /
`list_workspace_schedules` / `run_workspace_schedule_now`, 클라이언트
`components/WorkspaceSchedulesEditor.tsx`.

회귀: `apps/server/test/workspace-schedule-action-dispatch.test.mjs`(발화 경로·택일
검증), `apps/server/test/action-cron-moved-to-schedules.test.mjs`(시간대 변환·옛 구현
제거).
