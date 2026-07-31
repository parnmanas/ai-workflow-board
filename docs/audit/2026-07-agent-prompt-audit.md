# 담당 Agent 프롬프트 전수 감사 (ticket ec498050, 2026-07-31)

전체 담당 Agent의 system/role/task prompt를 전수 감사하고, 과도한 제한과
잘못된 `pending_user_action` 전환을 코드 레벨에서 제거한 결과를 기록한다.
근본 원인 티켓: #[ticket:0709ea7c-a505-4fc5-929e-fdf673ced0a1|AI Agents
Mainframe의 Agents 목록 세로 스크롤 불가 수정](terminal 컬럼 티켓 오pend),
#[ticket:29ea479c-5536-4b9c-b783-67867f1485d5|[정정] AWB에 vLLM용 Claude
Backend Profile 생성 및 Agent 생성 선택 가능화](계획 없이는 구현 거부 반복).

이 문서는 **읽기 전용 감사 기록**이다 — 실제 롤백은 이 문서가 아니라 아래
언급된 마이그레이션의 `down()`이 담당한다(각 레이어 절에서 정확한 소스를
가리킨다).

## 최소 가드 기준 (이 티켓이 확정한 기준)

프롬프트에는 다음 4가지 범주만 가드로 남긴다:

1. **권한 경계** — 이 역할이 할 수 없는 작업(예: reviewer는 코드를 직접
   고치지 않는다, 사람 전용 REST 경로는 agent가 우회하지 않는다).
2. **비밀정보 / 자격증명** — credential이 없으면 진행할 수 없는 지점.
3. **파괴적·비가역 작업 승인** — 배포, 프로덕션 push, 강제 삭제 등 사람 승인이
   실제로 필요한 지점.
4. **실제 사용자 의사결정** — 코드·git 이력·티켓 코멘트로 답을 찾을 수 없는,
   사람만 답할 수 있는 질문.

이 4가지에 해당하지 않는 "질문하기 전에 물어봐라" 류 지시는 전부 제거하거나
"먼저 스스로 조사하라"로 뒤집는다. 내부 Agent 질문, 계획 부족, 도구/OAuth
실패, 저장소 탐색 실패는 `pending_user_action` 사유가 아니다 — 이는 프롬프트
문구가 아니라 코드의 `terminal-pend-gate.ts` + Action 우선 게이트가 강제한다.

## 레이어 구조 (6개, 서로 다른 저장 위치)

| # | 레이어 | 저장 위치 | 주입 시점 | 편집 경로 |
|---|---|---|---|---|
| 1 | 컬럼 워크플로 가이드 (7종) | `PromptTemplate` 테이블, `category='default_workflow'` | 태스크 턴 | `mcp__awb__save_prompt_template` |
| 2 | 티켓별 지시문 | `Ticket.prompt_text` | 태스크 턴 | 티켓별 동적 — 감사 대상 아님 |
| 3 | 워크스페이스 역할 프롬프트 | `WorkspaceRole.role_prompt` | 시스템 프롬프트(`--append-system-prompt`) | MCP 툴 없음, REST(사람 UI 전용)만 |
| 4 | Agent 개별 프롬프트 | `Agent.role_prompt` | 시스템 프롬프트, 레이어 3 뒤에 join | `mcp__awb__update_agent` |
| 5 | harness_config | `Board.harness_config` + 언어 지시 + Board Lessons | 시스템 프롬프트, 레이어 3+4 뒤에 join | `mcp__awb__update_board` |
| 6 | 채팅/멘션/Action룸 프롬프트 | DB 아님 — 하드코딩 조립 함수 | 채팅/Action 트리거 시 | `apps/agent-manager/src/lib/prompts.ts` 코드 수정 |

레이어 2(티켓별)는 매 티켓마다 다른 동적 콘텐츠라 "전수 감사표" 대상이 아니다
— 대신 이 감사가 확정한 최소 가드 기준을 새 티켓 작성 시 참고 원칙으로 삼는다.

---

## 레이어 1 — 컬럼 워크플로 가이드 (7종)

소스: `apps/server/src/database/default-prompt-templates.ts`.
백필 마이그레이션: `1760000000072-RefreshDefaultPromptTemplatesPromptAudit.ts`
(대칭 `down()` 포함 — 이 마이그레이션의 `PRIOR_DEFAULT_CONTENTS` 상수가 7개
템플릿의 **변경 전 원문 전문**을 담고 있다. 이 문서는 그것을 재인용하지
않는다 — 단일 소스는 마이그레이션 파일이다).

| 템플릿 | 판정 | 변경 요약 | 근거 |
|---|---|---|---|
| `backlog_workflow` | 과잉 아님, 보강 | 선(先) 조사 원칙 주입만 | reporter는 서버 주도 승격을 관찰·서술만 하는 역할이라 애초에 "물어봐라" 패턴이 없었음. Actions/Multi-holder 블록은 `pend_ticket`/`move_ticket` 결정 지점 자체가 없어 미적용(의도적 편차, 아래 참고). |
| `todo_workflow` | **자기모순 수정** | step4 "Wait" 브랜치와 "when in doubt…wait" Note가 같은 파일의 "Don't bounce back — `pend_ticket`" Note와 직접 충돌 — Wait 브랜치를 "동시작업 self-resolving, pend 불필요"로 명확화하고 "when in doubt" Note는 실제 질문 상황에서 `pend_ticket`을 가리키도록 정렬 | 선(先) 조사 원칙 주입(존재 시): `apps/server/src/database/default-prompt-templates.ts` `todo_workflow` 항목 |
| `plan_workflow` | 과잉 아님, 보강 | 선(先) 조사 원칙 주입만 | 이미 "reporter에게 focused question, do not guess"로 최소 가드였음 — 다만 명시적 "먼저 조사" 프레이밍이 없어 규칙 삽입 |
| `in_progress_workflow` | 과잉 아님, 보강 | 선(先) 조사 원칙 주입만 | 이미 완비된 pend/prerequisite 판단 기준(When to park 섹션) 보유 |
| `review_workflow` | **갭 해소** | (a) "Cannot decide on your own" 브랜치에 `pend_ticket` 참조 추가 (b) "When to park (reviewer)" 섹션 신설 (c) `ACTIONS_BEFORE_PENDING_RULE` 신규 적용 | 조사 시점 `pend_ticket`/`add_ticket_prerequisites` **0건** 확인 — reviewer가 막히면 코멘트만 남기고 대기하는 것 외 탈출구가 없었음. 이 티켓의 완료 조건과 직접 대응. |
| `merging_workflow` | **갭 해소** | 3개 human-stop 지점(push 거부/cleanup 삭제 거부/`gh` 미가용)에 `pend_ticket` 연결, `ACTIONS_BEFORE_PENDING_RULE` 신규 적용 | 기존엔 "record and stop, leave in Merging for a human"만 있고 실제 pend 호출이 없어 User 탭에 노출되지 않았음 |
| `done_workflow` | 과잉 아님, 보강 | 선(先) 조사 원칙 주입만. `pend_ticket` 미적용(의도적) | done_workflow의 유일한 "stop" 케이스(서버 승격 정체 의심)는 이미 terminal(Done) 컬럼에서 발생 — `terminal-pend-gate.ts`가 어차피 pend를 거부하므로 프롬프트에 pend 지시를 넣는 것 자체가 오도(misleading) |

**공유 상수 정리(중복 제거)**:
- `ARTIFACT_REFERENCE_RULE` — 이미 상수화돼 있었음(변경 없음, 감사만).
- `MULTI_HOLDER_CONSENSUS_GATE_RULE` + `CONSENSUS_GATE_MECHANICS` 신설 —
  기존 5회 중복 중 4회(todo/plan/in_progress/merging)는 byte-identical이라
  단일 상수로 교체. `review_workflow`는 "co-reviewer" 케이스를 명시하는 도입
  문장이 달라 그 문장만 인라인 유지, 이후 메커니즘(제안→투표→자동이동)만
  `CONSENSUS_GATE_MECHANICS`로 공유.
- `INVESTIGATE_BEFORE_ASKING_RULE` 신설 — 7/7 전체 주입.
- `ACTIONS_BEFORE_PENDING_RULE` — 기존 3개(todo/plan/in_progress)에서
  review/merging 2개 추가, **5개**로 확장(계획 대비 의도적 편차, 아래 참고).

---

## 레이어 2 — 티켓별 지시문 (`Ticket.prompt_text`)

감사 대상 아님(동적 콘텐츠). 이 티켓이 확정한 최소 가드 기준(문서 상단)을
향후 티켓 작성 시 참고 원칙으로 편입한다.

---

## 레이어 3 — 워크스페이스 역할 프롬프트 (`WorkspaceRole.role_prompt`)

소스(신규 워크스페이스 시드): `apps/server/src/db.ts` `BUILTIN_ROLES`
(4개 역할: planner `db.ts:196`, assignee `db.ts:223`, reporter `db.ts:248`,
reviewer `db.ts:269`). 백필 마이그레이션(기존 워크스페이스):
`1760000000071-RefreshBuiltinRolePrompts.ts` — **변경 전 원문 전문**은 이
마이그레이션의 `OLD_PLANNER`/`OLD_ASSIGNEE` 상수에 그대로 보존, 대칭
`down()`으로 정확히 복원 가능(단일 소스는 마이그레이션 파일).

| 역할 | 판정 | 변경 후 요지 | 근거 |
|---|---|---|---|
| `planner` | **과잉 → 수정** | "Resolve ambiguity by asking — do not guess" → "먼저 코드/git 이력/티켓 코멘트로 조사, 진짜 질문만 남으면 @mention" | 질문 즉시 위임 패턴이 조사 단계를 건너뜀 |
| `assignee` | **과잉 → 수정 (29ea479c 근본 원인)** | "if the plan is missing or stale, **ask the planner instead of improvising**" → "먼저 스스로 조사하고, 진짜 설계 판단이 남을 때만 planner에게 코멘트+멘션" | #[ticket:29ea479c-5536-4b9c-b783-67867f1485d5\|29ea479c] 티켓의 반복 거부는 코드 게이트가 아니라 **이 정확한 문구**가 원인이었음(코드 게이트 자체는 존재하지 않았음을 조사로 확인) |
| `reporter` | 감사 완료, 무변경 | — | "답을 모르면 모른다고 말하고 누가 알지 알려줘라" 등 이미 최소 가드. 질문 즉시 위임 패턴 없음. |
| `reviewer` | 감사 완료, 무변경 | — | "walk the diff, verify claims, leave actionable feedback" — 이미 자율 조사·검증 중심. 차단형 "ask before" 문구 없음. |

**정정**: 최초 조사는 이 레이어를 "git 미추적 라이브 DB 콘텐츠라 롤백이
어렵다"고 판단했으나, 실제로는 이 워크스페이스의 `WorkspaceRole.role_prompt`가
`BUILTIN_ROLES` 시드 문자열과 **정확히 일치**(커스터마이즈 이력 없음)했다 —
그래서 정확 일치 술어 기반 마이그레이션이 안전하게 성립한다.

---

## 레이어 4 — Agent 개별 프롬프트 (`Agent.role_prompt`)

감사만(Planner 결정 Q1) — 과잉 제약이 발견된 경우에만 기록.

이 워크스페이스의 활성 4개 역할 보유 agent를
`mcp__awb__get_agent`로 직접 조회(2026-07-31):

| Agent | 역할 | `role_prompt` |
|---|---|---|
| Rolf/AWB (`1b88dd21`) | reporter | `""` (공백) |
| Rolf/AWB.Planner (`04b70055`) | planner | `""` (공백) |
| Rolf/AWB.Programmer (`d84c48da`) | assignee | `""` (공백) |
| Rolf/AWB.Reviewer (`a429237c`) | reviewer | `""` (공백) |

**판정**: 4개 전부 공백 — 과잉 제약 없음, 변경 불필요. 레이어 3(워크스페이스
역할 프롬프트)이 사실상 이 워크스페이스의 유일한 활성 프롬프트 소스다.

---

## 레이어 5 — `harness_config` (+ 언어 지시 + Board Lessons)

AWB 보드(`428b0ddd`)의 `harness_config`는 `null`(보드 레벨 커스터마이즈
없음, 시스템 기본값 사용), `language: "Korean"`만 명시적으로 설정돼 있다.

**판정**: 과잉 제약 없음 — `language` 지시는 차단형 가드가 아니라 순수
출력 언어 지정이므로 이 티켓의 "질문 전 조사" 원칙과 무관하다.

**범위 결정(Planner Q2, 구속력 있음)**: `harness_config` 구조화 필드 확장
(예: verification 기대치, ask-user 기준을 스키마화)은 **이 티켓 범위 제외**.
이유: `composeTriggerPrompt`(레이어 5 조립부)는 `apps/agent-manager/`에
있어 매니저를 업그레이드한 호스트에만 도달하지만, 레이어 1/3 마이그레이션은
배포 즉시 전원에게 도달한다 — 자기참조적 변경에 배포 의존성을 얹을 이유가
없다. 실익 재판단은 후속 티켓
#[ticket:f3fc298a-da91-45d5-97a1-4536a9bde932|프롬프트 정비 효과 사후 측정 및
harness_config 구조화 필드 확장]으로 이관.

---

## 레이어 6 — 채팅/멘션/Action룸 프롬프트 (`apps/agent-manager/src/lib/prompts.ts`)

DB가 아닌 하드코딩 조립 함수(451줄). 코드 변경 없음(agent-manager 변경 →
Q2 결정에 따라 범위 제외 + 별도 릴리스 절차 필요), **읽기 전용 감사만
수행**.

**판정**: 변경 불필요 — 오히려 이 티켓이 레이어 1/3에 이식하려는 원칙의
**기존 모범 사례**다. 발췌(`prompts.ts:240-243`):

> "OPERATIONAL REQUEST POLICY: requests to deploy, upgrade, publish, restart,
> roll out, or run recurring operational work are capability-first. **Never
> ask the user** to run commands, install tooling, create a ticket, or
> otherwise carry out the operation for you." … "**Ask for user input only
> when** a concrete permission, approval, secret, or irreversible-risk gate
> requires it, and request only that minimum input."

이 문구는 이 티켓이 확정한 "최소 가드 기준"(문서 상단)과 자구 수준까지
일치한다 — capability-first, 사람에게는 권한/자격증명/비가역 위험만 묻는다.
레이어 1(`INVESTIGATE_BEFORE_ASKING_RULE`)과 레이어 3(planner/assignee 수정)은
사실상 이 레이어 6의 기존 원칙을 다른 두 레이어로 일반화한 것이다.

---

## 시스템發 `pending_user_action` pend 지점 (8곳) 감사표

조사 단계에서 6곳 → 정정 8곳으로 확정(원 조사가 `hard-budget-guard.ts`와
`respawn-storm-detector.service.ts`를 누락). 전부
`apps/server/src/modules/mcp/shared/terminal-pend-gate.ts`
(`evaluateTerminalPendGate` + `loadTicketColumnForPendGate`)를 통해
terminal-aware하게 재구성했다(코드 변경은 별도 커밋 `3208036`).

| # | 위치 | 게이트 적용 | 근거 |
|---|---|---|---|
| 1 | `common/agent-comment-pingpong.ts` → `comment-tools.ts:236`의 `pend` 콜백 | ✅ | 0709ea7c **직접 원인**. terminal이면 no-op + `logger.info` |
| 2 | `modules/agents/trigger-loop.service.ts:2952` `_pendForMissingBaseRepo` | ✅ | 호출부가 이미 컬럼을 해결해둬 재조회 없이 그대로 전달(로더 미사용, 순수 predicate만) |
| 3 | `modules/actions/actions.service.ts:665` `_parkForApproval` | ✅ | 최초 wiring이 bare `{id}` 객체를 로더에 넘겨 항상 fail-open되는 버그 — qa-flow CASE 16이 잡아 실 ticket row 선(先)조회로 수정 |
| 4 | `common/hard-budget-guard.ts:221` `pendTicketForHardBudget` | ✅ | 두 호출부(comment-tools, trigger-loop) 모두 `logger` 인자 추가 전달 |
| 5 | `modules/agents/respawn-storm-detector.service.ts:344` `_haltStorm` | ✅ | pend만 스킵, halt 이벤트 로그·알림은 유지(관측성 보존) |
| 6 | `modules/agents/claim-verification.service.ts` `_pendTicket` | 코드 변경 없음(주석만) | 호출 체인이 이미 sweep 쿼리의 `kind='active'` SQL 필터로 구조적 안전 — terminal 컬럼 티켓이 애초에 후보군에 안 들어옴 |
| 7 | `modules/mcp/tools/ticket-crud-tools.ts:800` `pend_ticket` MCP 툴 | ✅ | Action 게이트 직후. 사람 REST 경로(`tickets.controller.ts`)는 **의도적으로 미변경** — 사람은 Done 티켓도 의도적으로 park할 수 있어야 함 |
| 8 | (조사 정정) 벤치마크 draft 후보 auto-pend | 생성 시점 전용, 재검토 결과 terminal 개념과 무관 | 생성 직후 1회성 플래그로 이 gate의 대상이 아님 — 코드 변경 없음 |

**유지된 보안·권한 가드(회귀 없음 확인)**:
- `unpend_ticket` MCP 툴은 여전히 human-only(`HUMAN_ONLY_UNPEND_MESSAGE`).
- Action 승인 게이트(`actions.service.ts`의 `_parkForApproval`은 non-terminal
  티켓에서는 기존과 동일하게 동작 — 이번 변경은 terminal 케이스만 스킵).
- 사람 REST PATCH pend 경로(`tickets.controller.ts:779-798`) 미변경.
- `pend_ticket`의 Action-우선 게이트(`evaluatePendActionGate`) 미변경, 순서상
  terminal 게이트보다 먼저 평가됨(그대로 유지).

---

## 회귀 테스트 매핑

| 유형 | 파일 | 케이스 |
|---|---|---|
| 0709ea7c형(terminal 티켓 오pend) | `test/terminal-pend-gate.test.mjs` | 순수 predicate/로더 9케이스 |
| 〃 | `test/agent-comment-pingpong.test.mjs` | terminal 컬럼 반복대기 no-op + non-terminal 대조군 |
| 〃 | `test/hard-budget-guard.test.mjs` | `pendTicketForHardBudget` 직접 호출 + `enforceAutoResponseBudget` 경로 |
| 〃 | `test/respawn-storm-terminal-pend-gate.test.mjs` | halt는 유지, pend만 스킵 + non-terminal 대조군 |
| 〃 | `test/qa-flows/action-run-resume-mcp.test.mjs` CASE 16 | `_parkForApproval` — 실전 버그(bare id) 발견·수정 |
| 〃 | `test/qa-flows/base-repo-binding-dispatch.test.mjs` Scenario 4 | `_pendForMissingBaseRepo`, terminal+role-routed 컬럼 |
| 〃 | `test/qa-flows/pend-action-gate-mcp.test.mjs` | `pend_ticket` MCP 툴 terminal 거부 |
| 29ea479c형(금지 문구) | `test/prompt-audit-forbidden-phrases.test.mjs` | BUILTIN_ROLES + 7템플릿 금지문구 부재/신규문구 존재 8케이스 |
| 마이그레이션 무결성 | `test/qa-flows/prompt-audit-template-refresh.test.mjs` | up/down 왕복, 정확일치, 운영자 커스터마이즈 보존, 멱등 |

---

## 계획 대비 의도적 편차 (근거 명시, 계획의 "이의 제기 후 판단해서 진행" 조항 원용)

1. **`ACTIONS_BEFORE_PENDING_RULE` 3→5**(계획은 3→7 지시): backlog/done은
   `pend_ticket` 결정 지점 자체가 없다. backlog는 서버가 스케줄을 전담하는
   순수 관찰 역할이고, done은 이미 terminal이라 `terminal-pend-gate.ts`가
   pend 자체를 거부한다 — 두 컬럼에 Action-우선 안내를 넣는 것은 관련 없는
   내용을 추가하는 bloat다.
2. **템플릿 마이그레이션이 `1760000000070`(단일 마커 append) 대신
   `1760000000052`(PRIOR 정확일치 + CURRENT 동적조회) 패턴 채택**: 이번
   변경은 신규 섹션 추가와 기존 문구 수정이 혼재된 조합적 재작성이라, 070의
   "마커 없으면 끝에 append"로는 todo_workflow의 자기모순 수정 같은 인플레이스
   문구 교체를 표현할 수 없다. 052는 정확히 이 크기의 변경(524bb434)에
   이미 쓰인 전례라 그대로 재사용.

## 측정 스크립트 (Planner Q3)

`apps/server/scripts/measure-prompt-audit-effect.mjs` — 4개 지표(착수율/불필요
질문 수/pending 오분류율/완료율)를 ActivityLog + Comment + Ticket에서 계산하는
재사용 가능한 CLI 스크립트. 산식은 `computeReport()`로 export돼 있어 후속
티켓이 그대로 재실행(또는 import해서 재사용)할 수 있다.

```
node apps/server/scripts/measure-prompt-audit-effect.mjs \
  [--since 2026-07-01T00:00:00Z] [--until 2026-07-31T00:00:00Z] \
  [--workspace <workspace_id>] [--json]
```

**개발 중 발견한 스키마 함정 2건**(둘 다 최초 수기 스모크테스트에서는 안 잡히고,
정식 회귀테스트로 전환한 뒤에야 드러남 — `test/measure-prompt-audit-effect.test.mjs`
가 고정):
1. `field_changed='column'` ActivityLog 행은 `old_value`/`new_value`에 **컬럼
   ID가 아니라 컬럼 이름**을 담는다(`ticket-move.ts:93`). ID로 매칭하면 항상
   0건.
2. `ActivityLog.workspace_id`는 `moved`/`pending_user_action` 계열 쓰기 지점
   대부분에서 채워지지 않는다(기본값 `''`) — 이 컬럼으로 직접 필터링하면
   `--workspace` 지정 시 항상 0건이 나온다. 스크립트는 대신 `Ticket.workspace_id`
   로 조인해서 스코프를 건다(Ticket 쪽은 생성 시점에 항상 채워짐).

**정확성 검증**: `test/measure-prompt-audit-effect.test.mjs` — 각 지표의 분자/
분모를 직접 구성한 합성 fixture로 산식 자체를 고정(3케이스: 정상 계산, 빈
윈도우 0/0 안전 처리, 기본 30일 윈도우).

## 베이스라인 스냅샷 — 미실측(한계 명시)

Planner Q3는 "변경 전 베이스라인 스냅샷까지"를 이 티켓 범위로 정했으나, 이
세션에서 **실제 프로덕션 AWB 데이터에 대한 원시 DB 접근 권한이 없어 실측하지
못했다**. 이 세션의 유일한 프로덕션 데이터 경로는 MCP 툴(`get_ticket` 등
티켓 단위 조회)이며, 이 스크립트가 필요로 하는 워크스페이스 전체 집계
쿼리는 MCP로 노출돼 있지 않다. 직접 `DataSource`로 프로덕션 DB에 연결하는
것은 이 세션에 주어지지 않은 자격증명이 필요할 뿐 아니라, 승인 없이 공유
인프라에 연결을 시도하는 것 자체가 부적절한 행동이라 판단해 시도하지 않았다.

대신 **정확성은 합성 fixture로 검증**(위 "측정 스크립트" 절)했고, 스크립트는
바로 실행 가능한 상태로 커밋됐다. 실제 베이스라인 캡처는 다음 중 하나가
수행해야 한다:
- 프로덕션 DB 접근 권한이 있는 운영자가 배포 직전 1회 실행.
- 또는 후속 티켓 #[ticket:f3fc298a-da91-45d5-97a1-4536a9bde932|프롬프트 정비 효과
  사후 측정 및 harness_config 구조화 필드 확장]가 배포 파이프라인/Action을
  통해 실행.

## 미착수(범위 이관)

- 변경 전후 착수율/불필요 질문 수/pending 오분류율/완료율 **사후 비교**는
  후속 티켓 #[ticket:f3fc298a-da91-45d5-97a1-4536a9bde932|프롬프트 정비 효과
  사후 측정 및 harness_config 구조화 필드 확장]로 이관(Planner Q3 결정) —
  이 티켓은 스크립트 제공까지, 베이스라인 실측은 위 "베이스라인 스냅샷" 절의
  한계로 인해 다음 실행자에게 위임.
- `harness_config` 구조화 필드 확장은 같은 후속 티켓으로 이관(Q2 결정).
