# Orchestration mode (팀 기반 자율 업무 오케스트레이션)

칸반 보드와 **같은 레벨**의 두 번째 작업 표면이다. 보드가 "티켓이 컬럼을 이동하며
역할별 Agent 를 깨우는" 모델이라면, 오케스트레이션은 **"업무 하나를 팀에 통째로
맡기면, 오케스트레이터 Agent 가 런타임에 계획을 세우고 팀원에게 나눠 실행한다"** 는
모델이다.

- UI: `/ws/:wsId/orchestration` (Missions) · `/ws/:wsId/orchestration/teams` (Teams)
- 서버: `apps/server/src/modules/orchestration/`
- MCP 툴: `apps/server/src/modules/mcp/tools/orchestration-tools.ts`
- 테스트: `test/orchestration-plan-dag.test.mjs`, `test/qa-flows/orchestration-lifecycle.test.mjs`

---

## 개념

| 개념 | 설명 |
| --- | --- |
| **Team** | Agent 로스터. **오케스트레이터 1명 필수** + 멤버 N명. |
| **Member** | 팀원 Agent. `capabilities` 문구가 오케스트레이터의 배정 판단에 그대로 쓰인다. |
| **Mission** | 팀에 맡기는 업무 한 건. objective / context / acceptance_criteria 로 기술. |
| **Step** | 오케스트레이터가 만든 계획의 노드. `depends_on` 으로 DAG 를 이룬다. |
| **Timeline** | Mission 안에서 일어난 모든 일의 append-only 기록 (UI 관찰 표면). |

Mission 은 **티켓이 아니다.** 티켓 수명주기는 컬럼 이동이 구동하지만 Mission 은
런타임에 작성·수정되는 계획이 구동한다. 두 모델을 한 엔티티에 욱여넣으면
"step 이 어느 컬럼에 있는가" 같은 답 없는 질문이 생기므로 별도 테이블로 둔다.

---

## 자동화 루프

```
사람: Mission 생성 + Team 지정 + Start
  │
  ├─▶ 서버: Mission 룸 생성 → 오케스트레이터에게 브리핑 posting (status=planning)
  │
  ├─▶ 오케스트레이터(Agent): get_orchestration_mission → submit_orchestration_plan
  │
  ├─▶ 서버: 의존성이 충족된 step 을 max_parallel_steps 까지 즉시 디스패치
  │         (step 당 룸 1개 · 담당 멤버 1명)   ← 오케스트레이터가 직접 보내지 않음
  │
  ├─▶ 멤버(Agent): 작업 수행 → report_orchestration_step(done|failed|blocked)
  │
  ├─▶ 서버: 결과 기록 → 하위 step 차단 전파 → 새로 준비된 step 자동 디스패치
  │         → 필요할 때만 오케스트레이터 깨움
  │
  └─▶ 오케스트레이터: complete_orchestration_mission  ← 이 호출만이 Mission 을 끝낸다
```

### 오케스트레이터를 언제 깨우는가

깨우는 조건은 **엔진이 스스로 진행할 수 없을 때뿐**이다.

| 상황 | 깨움 | 이유 |
| --- | --- | --- |
| step 이 failed / blocked 로 보고됨 | ✅ 즉시 | 판단이 필요하다 (재시도·재배정·우회·실패). |
| 모든 step 이 종료 상태 | ✅ | 완료 판정은 오케스트레이터의 몫. |
| 진행 중 0건 + 디스패치 가능 0건 | ✅ (stalled) | 미배정 step 이 있거나 남은 step 이 영영 못 돈다. |
| step 완료 후에도 다른 작업이 진행 중 | ❌ | 병렬 계획이 오케스트레이터 턴 대기로 직렬화되는 것을 막는다. |
| 진행 보고(progress) | ❌ | 타임아웃 시계만 리셋한다. |

---

## 디스패치가 채팅룸을 재사용하는 이유

QA 런·Action 런과 **동일한 파이프라인**을 쓴다: `ChatRoom` 생성 → 참여자 등록 →
`RoomMessagingService.sendMessage(..., sender_type:'user', sender_id:'system')` →
`chat_room_message` SSE → agent-manager 가 subagent 스폰.

결과적으로 **agent-manager 는 이 기능을 위해 한 줄도 바꾸지 않았고, SSE contract
도 건드리지 않았다.** 구체적으로:

- 룸은 `chat_rooms.orchestration_mission_id` / `orchestration_step_id` 로 표시되고,
  일반 채팅 목록(`listRooms` / `listAllWorkspaceRooms`)에서 제외된다 — Action 룸과 같은 처리.
- 같은 필드가 기존 `is_action_room` SSE 마커를 켠다. 오케스트레이션 룸은 대화가
  아니라 작업 실행이므로, subagent 는 "티켓을 만들어 미루지 말고 직접 하라" 지시를
  받아야 한다. 새 payload 필드를 만드는 대신 기존 플래그를 재사용해 contract 를 고정했다.
- Retry 는 **매 시도마다 새 룸**을 판다. 실패한 시도의 대화가 히스토리로 재생되면
  subagent 가 자기 막다른 길을 그대로 반복한다.

> **v1 범위 밖:** `run_provision`(레포 클론/체크아웃 힌트)은 붙이지 않았다. step 은
> Action 런과 똑같이 담당 Agent 의 `working_dir` 에서 실행된다. 붙이려면
> `RunProvision.kind` 유니온에 `'orchestration'` 을 추가해야 하고, 이는
> agent-manager 의 `run-provisioner.ts` 파서(`kind` 화이트리스트)와 같은 PR 로
> 묶어야 하는 SSE contract 변경이다.

---

## 안전장치

계획 기반 자율 실행의 실패 모드는 대부분 **조용하다** — 아무 에러 없이 미션이
멈춰 있는다. 그래서 방어는 전부 "멈춤을 소리나게 만드는" 쪽에 있다.

| 장치 | 위치 | 막는 것 |
| --- | --- | --- |
| DAG 검증 (Kahn) | `validatePlan()` | 사이클·자기참조·미존재 의존 → 영원히 디스패치 불가한 계획 |
| 차단 전파 | `propagateBlocking()` | 상위 실패 후 하위가 `pending` 으로 영원히 대기 |
| Mission 단위 뮤텍스 | `withMissionLock()` | 동시 report 가 병렬 슬롯을 중복 소비 / 같은 step 이중 디스패치 |
| Step 타임아웃 | `OrchestrationReaperService` | 보고 없이 죽은 subagent (기본 90분, progress 가 시계 리셋) |
| Planning 타임아웃 | 동상 | 계획을 끝내 제출하지 않는 오케스트레이터 → 2회 재브리핑 후 failed |
| 예산 상한 | `max_steps` / `max_plan_versions` / `max_attempts` | 계획 폭주·재계획 루프·무한 재시도 |
| 병렬 상한 | `max_parallel_steps` + 멤버별 `max_concurrent` | 한 번에 20개 subagent 스폰 |

### 권한

- REST(사람): `PERMISSIONS.MANAGE_ACTIONS` — Actions / QA / Security 와 같은
  "자동화 저작" 권한군.
- MCP(Agent): **스코프가 아니라 신원**으로 검사한다. 변경 툴은 호출 Agent 가
  `mission.orchestrator_agent_id` 인지, 또는 `step.assignee_agent_id` 인지를
  런너에서 확인한다. full-scope API 키를 가진 Agent 도 남의 step 을 보고할 수 없다.
  (그래서 `tool-authz-gate.ts` 의 `KNOWN_EXISTING_TOOLS` 에 등재만 하고 tier 는 두지 않았다.)

### 사람이 step 을 직접 못 만지는 이유

UI 에는 step 배정/완료 버튼이 없다. 계획은 오케스트레이터의 것이고, UI 가 계획을
직접 고치면 오케스트레이터가 가진 미션 모델과 DB 가 어긋나는데 이를 되맞출 채널이
없다. 사람의 개입 경로는 **Start / Pause / Resume / Cancel / Nudge** 다 — Nudge 는
미션 룸에 메모를 남기고 오케스트레이터를 깨우므로, 지시가 계획 소유자를 거쳐 반영된다.

---

## MCP 툴

**오케스트레이터**

| 툴 | 용도 |
| --- | --- |
| `get_orchestration_mission` | 현재 계획·결과·타임라인·즉시 디스패치 가능 목록 |
| `submit_orchestration_plan` | 계획 제출/수정 (**병합**: 기존 키는 미시작 시에만 갱신, 누락 키는 보존) |
| `update_orchestration_step` | `retry` / `reassign` / `amend` / `skip` / `cancel` |
| `add_orchestration_note` | 타임라인에 판단 근거 기록 |
| `complete_orchestration_mission` | `completed` / `failed` — **미션을 끝내는 유일한 경로** |

**멤버**

| 툴 | 용도 |
| --- | --- |
| `get_orchestration_step` | 작업지시 + 의존 step 들의 결과 재조회 |
| `list_my_orchestration_steps` | 세션 유실 후 미보고 배정 복구 |
| `report_orchestration_progress` | 하트비트 (타임아웃 시계 리셋, step 을 끝내지 않음) |
| `report_orchestration_step` | **최종 보고** — 하위 step 을 여는 유일한 신호 |

`submit_orchestration_plan` 이 병합(추가적)인 이유: 누락 키를 삭제하면 이미 끝난
작업과 그 결과 컨텍스트가 조용히 사라진다. 제거는 `skip` 으로 명시해야 한다.
진행 중이거나 종료된 step 은 재계획이 **덮어쓰지 않는다** — 실행 중인 subagent 밑에서
지시가 바뀌거나, 끝난 작업의 지시가 소급 변조되는 것을 막는다.

---

## 관찰 (UI)

- **Missions**: 상태 배지 + 진행 바 + 카운트. `orchestration_update` SSE 로 행이 실시간 갱신.
- **Mission 상세**: 3분할 — 헤더(살아있나/얼마나), Plan 그래프(누가 뭘, 무엇에 막혔나),
  타임라인(무슨 일이 순서대로).
- **Plan 그래프**: step 을 **의존 깊이(wave)** 열로 배치한다. 같은 열 = 실제 병렬 작업.
  간선은 선 대신 `← key` 칩으로 그린다(step 10개 넘어가면 선은 읽을 수 없는 뭉치가 된다).

`orchestration_update` 는 `consensus_update` 와 같은 **UI 전용** 이벤트다
(`filter: identity.type === 'user'`). 헤드라인(상태·카운트·마지막 이벤트)만 싣고,
상세는 클라이언트가 디바운스 후 REST 로 다시 당긴다. Agent 는 이 스트림을 소비하지
않으므로 agent-manager SSE contract 밖이다.

---

## 환경 변수

| 변수 | 기본 | 설명 |
| --- | --- | --- |
| `ORCHESTRATION_REAPER_ENABLED` | on | `false` 로 리퍼 비활성화 |
| `ORCHESTRATION_REAPER_SWEEP_MS` | 5m | 스윕 주기 (30s~1h clamp) |
| `ORCHESTRATION_PLANNING_TIMEOUT_MS` | 20m | 계획 미제출 재브리핑 간격 (1m~24h clamp) |

미션별 `step_timeout_minutes` (기본 90, `0` = 무제한)은 REST 로 조정한다.

---

## 트러블슈팅

**Mission 이 `planning` 에서 안 움직인다**
→ 오케스트레이터 Agent 가 online 인지(팀 화면의 점), agent-manager 가 붙어 있는지 확인.
리퍼가 20분마다 최대 2회 재브리핑 후 `failed` 로 떨군다. 즉시 재시도는 **Nudge**.

**step 이 계속 `dispatched` 다**
→ subagent 가 `report_orchestration_step` 을 안 불렀다. step 룸을 열어(상세 → 룸)
subagent 출력을 확인. `step_timeout_minutes` 후 리퍼가 failed 로 만들고 오케스트레이터를 깨운다.

**전부 `pending` 인데 아무것도 안 나간다**
→ 대개 step 에 `assignee_agent_id` 가 없다. 이 경우 상태가 `ready` 로 남고 stalled
깨움이 오케스트레이터에게 미배정 키를 알려준다. 안 고쳐지면 Nudge 로 재배정을 지시.

**멤버가 남의 step 을 보고하려 한다**
→ 403. 정상이다. `list_my_orchestration_steps` 로 자기 배정을 확인시키면 된다.
