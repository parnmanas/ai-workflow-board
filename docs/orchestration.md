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

## 실행 그래프 (Graph mode, ticket 1ca9e49b)

기본 실행 모델은 `depends_on` 기반 DAG다 — 이미 fan-out/fan-in 과 병렬 실행을
표현한다. 없던 것은 **edge 라는 1급 개념**이었다: 무타입·무조건 의존성만으로는
조건 분기도, join policy 도, loop 재진입도 표현할 자리가 없다.

Graph mode 는 그 위에 버전된 `GraphSpec` 을 얹는다. **미션 단위 feature flag**
(`graph_enabled`, 기본 `false`)로 켜며, 꺼져 있는 미션의 동작은 이 기능 도입
전과 한 글자도 다르지 않다.

### GraphSpec v1

| 요소 | 값 | 의미 |
| --- | --- | --- |
| node `kind` | `task` / `evaluator` / `router` | `evaluator` 는 상류 작업을 판정해 verdict 를 낸다. `router` 는 분기만 고른다(나가는 edge 가 전부 조건부여야 하고 2개 이상). |
| node `join` | `all` / `any` | 들어오는 edge 를 어떻게 합칠지. `all`(기본) = fan-in, `any` = 조건 분기 합류점(한쪽 가지만 실행되므로 `all` 이면 영원히 대기한다). |
| node `max_visits` | 1..25 | 이 node 가 실행될 수 있는 최대 횟수. loop 밖은 1. |
| edge `kind` | `sequence` / `conditional` / `loop_back` | `sequence`(기본) = `depends_on` 과 같은 의미. `loop_back` 은 **순환을 만들 수 있는 유일한 edge** 다. |
| edge `when` | `{ status?, verdict? }` | 둘 다 주면 둘 다 맞아야 통과. `conditional`·`loop_back` 은 필수. |
| `max_total_visits` | 1..500 | 미션 전체 node 실행 횟수의 hard budget. loop 가 하나라도 있으면 필수. |

`entry` / `terminal` 은 입력받지 않고 계산된다(들어오는 forward edge 가 없는
node = entry, 나가는 edge 가 없는 node = terminal).

node 는 **step 과 1:1** 이다 — 별도 실행 단위를 만들지 않는다. 그래서 그래프에서
빠뜨린 step 은 자동으로 고립 node 로 채워지고, 존재하지 않는 step 을 가리키는
node/edge 는 거부된다.

### 실행 형태

```
     spec ──┬─→ api ──┐
            └─→ ui  ──┴─→ integrate ─→ review ─┬─(approve)→ ship
                          ▲                     ├─(reject) → abort
                          └────(revise, loop)───┘
```

| 형태 | 표현 |
| --- | --- |
| 선형 | `sequence` edge 하나 |
| 병렬 (fan-out) | 한 node 에서 나가는 `sequence` edge 여러 개 |
| fan-in | 한 node 로 들어오는 edge 여러 개 + `join: all` |
| 조건 분기 | 같은 node 에서 나가는 `conditional` edge 들 + evaluator 의 verdict |
| bounded loop | `loop_back` edge + 대상 node 의 `max_visits` + 미션의 `max_total_visits` |

조건 분기에서 **선택되지 않은 가지는 `blocked` 로 확정된다** — 영원히 `pending`
으로 남겨두면 미션이 조용히 멈춘다.

### loop 를 안전하게 만드는 규칙

`validateGraphSpec()` 이 실행 **전에** 강제한다:

1. `loop_back` 을 제거한 그래프는 반드시 DAG여야 한다 → 실수로 만든 순환은 여전히 거부된다.
2. `loop_back` edge 는 종료 조건(`when`)이 있어야 한다.
3. `loop_back` 대상 node 는 유한한 `max_visits >= 2` 를 **명시적으로** 선언해야 한다.
4. loop 가 하나라도 있으면 미션 단위 `max_total_visits` 가 필수다.
5. `loop_back` 은 실제로 순환을 닫아야 한다(`to` 에서 `from` 으로 가는 경로가 있어야 한다) — 일반 점프를 loop 로 위장할 수 없다.
6. 어느 entry 에서도 도달할 수 없는 node 는 거부된다(deadlock).

**재진입 범위**: `loop.to` 에서 도달 가능하면서 동시에 `loop.from` 에 도달할 수
있는 node 들(= loop 본문)만 리셋된다. loop 밖으로 갈라진 가지는 이미 확정된
결과이므로 다시 돌리면 중복 실행이 된다. 본문 node 는 저자가 개별 선언하지
않아도 loop 의 반복 상한을 물려받는다.

**상한 도달 시**: 재진입하지 않고 `loop_exhausted` 이벤트를 남긴다. evaluator 의
마지막 verdict 때문에 하류 분기는 이미 dead 이므로 `propagateBlocking` 이 하류를
`blocked` 로 확정하고 오케스트레이터가 깨어난다 — 조용히 도는 무한 loop 대신
명시적으로 멈춘 loop + 판단 요청으로 끝난다.

### 반복(visit)과 재시도(attempt)는 다른 축

| | 늘어나는 시점 | 초기화 |
| --- | --- | --- |
| `attempt` | 같은 pass 안에서 재디스패치될 때(재시도) | loop 재진입 시 0 |
| `visit` | `loop_back` 으로 재진입할 때 | 없음 (미션 내내 누적) |

`max_total_visits` 는 **재시도까지 포함해 node 실행 횟수**를 센다 — 위 GraphSpec 표의
정의(`미션 전체 node 실행 횟수의 hard budget`)와 같은 값이다. subagent 스폰 횟수가
아니다: 사람이 답하는 `confirm` 게이트는 subagent 를 띄우지 않지만 오픈할 때 예산을
1 소모한다(ticket 5dbe4aa2). node kind 모양의 구멍을 예산에 내면 "왜 이 미션은 예산이
안 깎이지"를 나중에 재구성할 수 없기 때문이고, 폭주 방지가 근거는 아니다 — loop 는
`node.max_visits` 로 이미 개별 상한이 걸려 있다. 소진되면 새 디스패치를 멈추고
`graph_budget_exhausted` 를 남긴다(step 을 `failed` 로 바꾸지는 않는다 — 운영자가
상한을 올리면 그대로 재개돼야 한다).

예산은 `pump()` 의 후보 루프 **안에서 매 반복마다** 다시 확인한다. 진입 시 한 번만
보면 fan-out 에서 상한을 넘긴다(남은 예산 1 + ready node 4개 + 병렬 슬롯 4개 →
네 개를 전부 띄움). `slots` 는 병렬 상한이지 예산이 아니다.

**디스패치 실패와 예산**: 예산은 work order 를 room 에 올리기 **직전**에 커밋된다.
따라서 그 지점 전에 던진 실패(assignee 가 사라졌거나 다른 workspace 로 옮겨진
경우)는 예산을 쓰지 않고, 그 뒤의 실패는 이미 쓴 것으로 남는다 — "subagent 가
떴을 수 있는가"를 기준으로 보수적으로 센다. 루프가 예산을 미리 깎지 않고 매
반복 실측을 다시 읽는 이유가 이 구분을 보존하기 위해서다.

### verdict 와 중복 실행 통제

evaluator/router node 의 step prompt 에는 그 node 에서 나가는 분기가 기대하는
verdict 목록이 실린다. 멤버는 `report_orchestration_step(verdict: "...")` 로
답하고, 그 값이 어느 edge 가 살아남는지를 결정한다.

loop 는 하나의 새로운 위험을 만든다: 같은 `step_id` 가 pass 2 로 다시 디스패치된
뒤, pass 1 의 subagent 가 뒤늦게 보고하면 status 가 terminal 이 아니라 기존
가드를 그냥 통과해 새 pass 의 결과를 덮어쓴다.

그래서 graph 모드 미션에서는 `report_orchestration_step` 의 **`visit` 이 필수**다.
graph 미션의 step prompt 는 어떤 node 든 항상 자기 `visit` 번호를 싣고 나가고,
보고에 실린 번호가 현재와 다르면 stale 로, **아예 빠져 있어도** 거부한다(409).
optional 로 두면 stale 한 pass 1 작업자가 `visit` 을 빼고 보내는 것만으로 가드를
우회할 수 있어 방어가 성립하지 않는다.

`graph_spec` 이 없는 기존 wave 미션은 그대로 optional 이다 — 재진입 자체가 없어
구분할 pass 가 없고, 기존 호출자를 깨뜨리지 않는다.

### lease fencing 과 heartbeat (ticket 4d065f82)

`visit` 은 **loop 재진입** 축만 막는다. 재시도는 `attempt` 만 올리고 `visit` 은 그대로
두므로, attempt 1 의 살아있는 subagent 가 뒤늦게 보고해 attempt 2 의 in-flight 상태를
덮어쓰는 경로는 wave·graph 미션 **양쪽 모두** 열려 있었다. 그 축을 `lease_token` 이 닫는다.

- `dispatchStep` 이 디스패치마다 새 토큰을 발급해 work order 에 싣는다. 재진입이든
  재시도든 **모든 재디스패치**에서 바뀌므로 두 축을 다 덮는다.
- step 이 토큰을 들고 있으면 보고에도 **반드시** 있어야 한다. `visit` 과 같은 이유로
  누락도 409 다 — optional 이면 stale 작업자가 빼는 것만으로 우회한다.
- 토큰이 빈 step(이 기능 배포 이전에 나간 work order)만 예외로 통과시킨다. 그렇지
  않으면 업그레이드 순간 진행 중이던 작업이 보고 자체를 못 하는 wedge 가 된다.
- 세션을 잃은 agent 는 `list_my_orchestration_steps` / `get_orchestration_step` 으로
  현재 토큰을 되찾는다. **이 두 경로가 토큰을 돌려주지 않으면 복구한 agent 가 영영
  보고할 수 없다** — 토큰을 요구하기로 한 이상 되찾을 길은 반드시 함께 있어야 한다.
- 거부는 `step_lease_rejected` 로 타임라인에 남는다. 이게 없으면 409 가 호출자에게만
  보이고 "왜 내 결과가 반영 안 됐나"를 사후에 설명할 근거가 사라진다.

heartbeat 는 `last_heartbeat_at` 을 **매 progress 호출마다** 갱신하고, 리퍼는
`last_heartbeat_at ?? started_at ?? dispatched_at` 을 기준선으로 쓴다. 예전에는
`started_at` 이 기준이었는데 그 값은 최초 progress 호출에서 한 번만 찍혀서, "heartbeat
가 inactivity timeout 을 리셋한다"는 문서상 계약이 두 번째 호출부터 거짓이었다.

### lease 만료 reconciliation — 유예 · 재연결 · 자동 재개

리퍼는 만료를 보자마자 step 을 죽이지 않는다. `reconcileStaleLease()` 하나가 두 단계로 처리한다:

1. **최초 관측** — `lease_stale_since` 를 찍고, 작업자의 online 상태를 조회해 trace 에 남기고,
   그 attempt 의 방에 재연결 요청을 포스트한다. 살아 있는 작업자가 heartbeat 하나만 보내도
   lease 가 되살아난다(`reportProgress` 가 `lease_stale_since` 를 지우고 `step_lease_recovered` 를 남긴다).
2. **유예 경과** — 그래도 답이 없으면 **새 attempt 로 자동 재디스패치**한다. `dispatchStep` 그대로라
   새 lease token 과 새 방을 받고, 이전 attempt 의 지각 결과는 fencing 이 이미 거부한다(= idempotent).
   `retry_policy='manual'` 이거나 재시도 예산이 없으면 재실행하지 않고 종결한다.

유예 길이는 `ORCHESTRATION_LEASE_GRACE_MS`(기본 5분). 이 경로는 **부팅 스윕과 주기 스윕이 같은
메서드**를 부르므로, 재시작 복구와 정상 운용 중 장애 감지가 구조적으로 하나의 경로다.

세 재시작 축(server / agent-manager / 작업자 세션)이 여기로 수렴한다 — orchestration 이 관측하는
것은 어느 축이든 "in-flight step 의 생존 신호가 끊긴다" 하나이기 때문이다. agent-manager 는
orchestration 상태를 들고 있지 않으므로 그 축의 효과도 "그 호스트의 작업자들이 동시에 조용해진다"로
나타날 뿐이다.

> **재시작 테스트 강도** (리뷰 라운드2 반영, 티켓 4d065f82): 서버 축은
> `qa-flows/orchestration-restart-recovery.test.mjs` 에서 **실제로** 앱을 종료(`app.close()` →
> onModuleDestroy 강제 flush)하고 같은 DB 파일 위에 새 NestFactory·새 DataSource 로 다시 부팅한 뒤,
> 새 프로세스의 `OnModuleInit` 부팅 스윕이 **테스트가 리퍼를 부르지 않아도** 만료된 lease 를 관측하는지
> 확인한다. orchestrator 세션 재시작(새 세션이 같은 미션 room 의 thread context 와 실행 상태를 되찾는지)도
> 같은 파일에 있다. `qa-flows/orchestration-recovery.test.mjs` 의 축1 은 같은 프로세스에서 판정 로직만
> 태우는 시뮬레이션이므로 그쪽을 재시작 근거로 인용하지 말 것.
>
> **테스트 강도에 대한 용어 구분** (reporter 확인, 티켓 4d065f82): agent-manager 축의 회귀 테스트는
> 실제 agent-manager 프로세스를 종료·재기동하는 통합 테스트가 **아니라**, 그 재시작이 orchestration
> 계층에 남기는 장애 상태를 재현하는 **시나리오 테스트**다. reporter 는 별도의 agent-manager 전용
> 복구 상태기계를 만드는 대신 이 관측값을 서버의 단일 `reconcileStaleLease()` 경로로 수렴시키는
> 설계를 수용했으나, 그 차이는 문서와 테스트 설명에 계속 명시적으로 남긴다.

### 재개 가능한 체크포인트

`report_orchestration_progress(checkpoint:)` 로 저장하는 구조화 상태다. timeline 의 progress 메시지와는
다른 축이다 — 그쪽은 사람이 읽는 서술이라 재시작한 작업자가 어디서부터 이어갈지 프로그램적으로
복원할 수 없다. 마지막 값만 step 에 보관하고(각 저장 시점은 `step_checkpoint` 이벤트로 append-only),
자동 재디스패치 때 **work order 에 그대로 실려 나간다**. 세션을 잃은 작업자는
`get_orchestration_step` / `list_my_orchestration_steps` 로 lease token 과 함께 되찾는다.

### 상류 복구와 하류 차단 해제

`propagateBlocking()` 은 원래 한 방향이었다 — pending → blocked 로만 가고 돌아오는 길이 없어서,
실패한 상류를 retry 로 되살려도 그때 딸려 막힌 하류가 영원히 blocked 로 남았다(`blocked` 는 두
판정기 모두에서 terminal 이라 다시 dispatchable 이 될 수도 없다). `unblockAutoBlockedDependents()` 가
그 역방향을 만든다.

**작업자가 스스로 보고한 blocked 는 절대 건드리지 않는다** — `auto_blocked` 플래그로 구분한다.
그건 "내가 할 수 없다"는 판정이라 상류 복구와 무관하다.

해제 여부는 직접 재계산하지 않고, 후보를 pending 으로 가정한 사본을 **같은 progress 판정기**에 다시
태워 묻는다. 그래야 wave 와 graph(조건 분기·join policy 포함)가 각자의 규칙으로 답하고 이 메서드가
세 번째 판정 분기가 되지 않는다.

### 복구 불가 작업 (needs_recovery)

`retry_policy: 'manual'` 로 선언된 step 은 lease 만료 시 `failed`(오케스트레이터가 정상
실패 처리로 다시 띄울 수 있는 상태)가 아니라 `needs_recovery` 로 가고 `recovery_reason`
에 사유가 남는다. 배포·결제·외부 게시처럼 "한 번 더 실행"이 그 자체로 피해인 작업용이다.

비멱등 여부는 step 의 instructions 안에만 있는 의미론이라 상태 머신이 사후에 알아낼 수
없다 — 그래서 계획 시점에 오케스트레이터가 선언하고, 선언이 없으면(`auto`, 기본값) 기존
동작 그대로다. 탈출구는 명시적 `update_orchestration_step(action:'retry')` 또는 재배정뿐이다.

**step 상태를 추가할 때는 판정기가 둘이라는 점을 반드시 볼 것.** wave 는
`computePlanProgress`, graph 는 `computeGraphProgress` 가 각자 판정하는데, 둘 다 예전에는
상태 목록을 **리터럴로 복제**해 갖고 있었다. 목록에 빠진 상태는 "pending / ready" 분기로 흘러
**dispatchable 로 집계**되므로, 자동 재실행을 금지하려고 만든 `needs_recovery` 가 오히려 즉시
재디스패치를 부르는 정반대 동작이 됐다 — wave 에서 한 번 겪고, 사본을 놓쳐 graph 에서 또 겪었다.
지금은 graph 쪽 `isTerminal`/분류가 `TERMINAL_STEP_STATUSES` 단일 출처를 참조한다.

새 상태를 추가하면 `TERMINAL_STEP_STATUSES` · `DEPENDENCY_POISONING_STATUSES` ·
`computePlanProgress` 의 terminal 분기 · 클라이언트 `STEP_STATUS_STYLES` 를 함께 확인하라
(마지막 것을 빠뜨리면 `stepStyle` fallback 이 걸려 가장 급한 상태가 muted "Waiting" 으로 조용히
오표시된다).

### wave adapter 와 하위 호환

`graphFromWavePlan()` 이 `depends_on` 을 forward edge 로 **전치**한다:

```
depends_on: { c: ['a','b'] }  ≡  edges: [a→c, b→c] (sequence) + node c 의 join='all'
```

조건도 loop 도 만들지 않으므로 `computeGraphProgress` 의 판정은
`computePlanProgress` 와 정확히 일치한다 — `orchestration-graph-spec.test.mjs`
가 324개 상태 조합으로 이 동치성을 직접 단언한다. 그래서 `graph_enabled` 를 켠
미션이 **최초** 계획을 `graph` 없이 제출하면 서버가 자동으로 승격하고, 실행 순서는
그대로다. 이미 그래프가 확정된 뒤의 재제출은 승격이 아니라 보존이다 —
"replan 과 그래프" 절 참고.

graph 모드가 **꺼진** 미션에 `graph` 를 보내면 조용히 무시하지 않고 **거부한다**
— 조용한 무시는 오케스트레이터가 분기/loop 가 실제로 걸린 줄 알고 계획을 세우게 만든다.

### 판정 분기는 한 곳에만

`computeMissionProgress(graph_spec, steps)` 가 graph/wave 분기를 담당하는 유일한
지점이다. `pump()` · `propagateBlocking()` · `decideWake()` · orchestrator 뷰가
서로 다른 판정을 보면 "디스패치는 됐는데 곧바로 blocked 로 뒤집히는" 모순이나
"오케스트레이터에게는 대기 중으로 보이는데 엔진은 죽은 것으로 아는" 상태가 생긴다.

### 실행 중 그래프 수정 (patch, ticket 2fc8f99a)

`submit_orchestration_plan` 의 `graph` 는 그래프를 **통째로** 교체한다. 실행 중인
미션에서 edge 하나를 고치려고 전체를 다시 쓰는 것은 위험하다 — 빠뜨린 node/edge 가
조용히 사라지고, `max_plan_versions` 예산까지 함께 탄다.

`patch_orchestration_graph` 는 **그래프만** 부분 수정한다. plan(step 집합)은 건드리지
않으므로 `plan_version` 을 소모하지 않고, 대신 `graph_revision` 이 1씩 오른다.

| 연산 | 의미 |
| --- | --- |
| `set_nodes` | **이미 존재하는** node 의 `kind` / `join` / `max_visits` 변경 |
| `add_edges` | edge 추가 (`submit` 과 동일한 규칙) |
| `remove_edges` | edge 제거. `kind` 를 생략하면 두 node 사이의 **모든** edge |
| `max_total_visits` | 미션 단위 실행 예산 변경 |

node 추가/삭제는 patch 에 **없다**. node 는 step 과 1:1 이므로 node 를 늘리려면 step 이
먼저 있어야 하고, 그건 `submit_orchestration_plan` 의 일이다.

**안전 규칙 — 이미 일어난 실행 이력을 소급해서 무효화할 수 없다**

1. node 의 `max_visits` 를 **이미 소진한 `visit` 아래로** 낮출 수 없다. 낮추면 "상한을
   넘긴 채 이미 실행된 node" 라는, 엔진이 표현할 수 없는 상태가 된다. 정확히 현재
   `visit` 으로 낮추는 것은 허용 — "이번 pass 가 마지막" 이라는 뜻이고, 폭주하는 loop 를
   세우는 정상적인 수단이다.
2. `max_total_visits` 를 **이미 소진한 `total_visits` 아래로** 낮출 수 없다(같은 이유).
   정확히 소진량으로 낮추면 추가 디스패치만 멈춘다.
3. **`loop_back` 제거는 진행 중이어도 항상 허용된다.** `loop_back` 은 의존성으로 세지
   않으므로(`computeGraphProgress` 가 건너뛴다) 제거해도 어떤 node 도 막지 않는다. 이미
   끝난 재진입은 그대로 남고 앞으로의 재진입만 사라진다 — 폭주 loop 의 탈출구다.
4. 이미 종료했거나 실행 중인 node 로 **들어가는** edge 추가는 허용하되, 그 edge 가 이번
   pass 에 효력이 없다는 사실을 응답의 `changes[].inert_reason` 으로 돌려준다(loop 로
   재진입하면 그때부터 적용된다). 조용히 받아들이면 걸지도 않은 게이트를 걸었다고
   착각하게 된다.

구조 불변식(순환·loop 규칙·고아 node·router/evaluator 규칙·예산 하한)은 patch 를 적용한
결과 **전체**를 `validateGraphSpec` 에 다시 통과시켜 재검증한다 — patch 전용 검증 경로를
따로 두지 않는다. 두 경로가 갈라지는 순간 "제출로는 거부되는데 patch 로는 통과하는"
그래프가 생긴다.

**patch 는 step 의 상태를 바꾸지 않는다.** 죽은 분기 때문에 이미 `blocked` 로 확정된
step 은 edge 를 고쳐도 스스로 되살아나지 않는다 — `update_orchestration_step
action:"retry"` 로 명시적으로 되살려야 한다. 상태 되돌리기를 patch 에 섞으면 "그래프를
고쳤더니 이미 실패 처리된 작업이 조용히 다시 뛰더라" 가 된다.

한 미션이 받을 수 있는 patch 총 횟수는 `MAX_GRAPH_PATCHES`(50)로 제한된다. 그래프가
`submit_orchestration_plan` 으로 **새로 확정되면**(`graph`/`graph_template`/`reset_graph`)
`graph_revision` 은 0 으로 되돌아간다 — 새 기준선이 이전 그래프의 patch 횟수를 물려받을
이유가 없다. 반대로 그래프를 **보존한** 재제출은 그 patch 들이 그대로 살아 있으므로
카운터도 이어간다.

> `GraphSpec.version` 은 **스키마** 버전이라 `validateGraphSpec` 이 상수와 엄격히
> 비교한다(`unsupported graph version N`). 그래서 수정 횟수를 거기에 실을 수 없고,
> `graph_revision` 을 별도 컬럼으로 둔다.

### replan 과 그래프 (ticket 301018c5)

`submit_orchestration_plan` 의 **step 병합은 additive** 다: 이번 입력에서 빠진
step_key 는 지워지지 않고 그대로 남는다. 그래프도 **같은 원칙을 따른다.**

| 재제출에 담긴 것 | 그래프 | `graph_revision` |
|---|---|---|
| `graph` | 보낸 그래프로 **교체** | 0 으로 리셋 |
| `graph_template` | 펼친 그래프로 **교체** | 0 으로 리셋 |
| `reset_graph: true` | `depends_on` 에서 **재유도**(평면 DAG) | 0 으로 리셋 |
| 셋 다 없음 (그래프 미확정) | `depends_on` 에서 유도 (wave adapter) | 0 |
| 셋 다 없음 (그래프 확정됨) | **보존** + 새 step 만 고립 node 로 편입 | 이어감 |

마지막 줄이 이 티켓이 고친 지점이다. 그전에는 `graph` 없는 재제출이 확정된 그래프를
`graphFromWavePlan` 으로 통째 재생성했다. `graphFromWavePlan` 은 `sequence` edge 만
만들므로 `conditional` 분기와 `loop_back` 이 **오류도 경고도 없이** 전부 사라졌고,
`patch_orchestration_graph` 로 그동안 쌓은 수정까지 함께 되돌아갔다. step 하나 추가하는
평범한 replan 이 실행 규칙을 조용히 날리는 셈이었다.

보존은 `carryGraphThroughReplan()` 이 한다. 별도 검증 경로를 만들지 않고 **기존 spec 을
입력 형태로 되돌려 `validateGraphSpec` 에 다시 통과시킨다** — patch 가 쓰는 것과 같은
방식이다. 새 step 을 고립 node 로 채우는 것은 검증기가 원래 하던 일이라(그래프에서 빠진
step 은 `entry` 이자 `terminal` 인 node 로 채워진다) 편입에 별도 코드가 필요 없다.

안전한 근거는 **plan 에서 step 이 사라지지 않는다**는 것이다. 재제출은 누락 키를
보존하고, `update_orchestration_step` 의 `cancel` 은 행을 지우지 않고 status 만 바꾸며,
`listSteps` 는 상태로 거르지 않는다. 그래서 확정된 그래프의 node 집합은 언제나 현재
step 집합의 부분집합이고, 보존이 고아 node 를 만들 수 없다. (step 을 실제로 **삭제**하는
경로가 생긴다면 사라진 key 를 참조하는 node/edge 를 걷어내는 처리가 함께 필요하다 —
지금은 `carryGraphThroughReplan` 이 그 경우를 조용히 넘기지 않고 거부한다.)

`max_total_visits` 는 **구조상 불가피할 때만** 새 node 수까지 최소로 올린다. loop 가
없는 그래프는 예산이 node 수로 자동 유도되는데(`maxTotalVisits = byKey.size`), 그
상태에서 step 이 하나만 늘어도 "예산이 node 수보다 작다" 로 재제출 자체가 거부되기
때문이다. 여유가 있으면 손대지 않는다 — 예산은 loop 폭주를 막는 안전 상한이므로 편의로
들어올리지 않는다.

**그래프를 정말 버리고 싶을 때**는 `reset_graph: true` 로 명시한다. `graph` ·
`graph_template` 과는 상호배타이고(어느 쪽이 이길지가 임의 규칙이 되므로 거부),
graph 모드가 꺼진 미션에서는 다른 그래프 입력과 마찬가지로 거부된다.

어느 재제출이 그래프를 갈았는지는 `plan_submitted` 이벤트의 `data.graph.carried` ·
`carried_nodes` · `graph_revision` 으로 추적한다.

> 분기 하나를 열거나 loop 상한만 고치려는 것이라면 재제출이 아니라
> `patch_orchestration_graph` 를 써라 — plan 버전을 태우지 않고, 실행 이력과의 정합성을
> 함께 검사한다.

### 그래프 템플릿 (ticket 2fc8f99a)

검토 루프 하나를 손으로 쓰려면 `loop_back` edge + 종료 조건 `when` + 대상 node 의
`max_visits >= 2` + 미션 단위 `max_total_visits` 를 **전부** 맞춰야 validation 을
통과한다. 그 조합이 곧 "검토 루프" 라는 하나의 형태다. 템플릿은 그 형태를 한 번만
정확히 적어두고 재사용한다.

`submit_orchestration_plan` 에 `graph` 대신 `graph_template: { name, params }` 를 준다
(둘을 함께 주면 거부된다 — 어느 쪽이 이기는지가 임의 규칙이 되기 때문).

| 템플릿 | 형태 | 주요 파라미터 |
| --- | --- | --- |
| `linear` | 순서대로 이어지는 사슬 | `steps[]` (2개 이상, 순서가 곧 실행 순서) |
| `review_loop` | 작업 → 검토 → (수정 필요 시) 작업 으로 되돌아가는 상한 있는 루프 | `work`, `review`, `max_passes`, `on_pass?`, `pass_verdict?`, `revise_verdict?` |
| `fan_out_aggregate` | 여러 갈래 병렬 실행 후 하나로 합류 | `branches[]` (2개 이상), `aggregate`, `source?` |

카탈로그는 `list_orchestration_graph_templates` 로 읽는다(용도·파라미터·예시 포함).

템플릿은 **저작 편의일 뿐 새로운 실행 개념이 아니다**: 펼친 결과도 손으로 쓴 그래프와
똑같이 `validateGraphSpec` 을 통과해야 하고, 실행 규칙도 완전히 동일하다. 템플릿은
이미 존재하는 `step_key` 만 엮으며 step 을 만들어내지 않는다 — 템플릿이 언급하지 않은
step 은 기존대로 고립 node 로 채워진다.

---

### 사용자 확인 노드 (Human Confirm, ticket 5dbe4aa2)

미션 도중 **사람에게 중간 결과물을 보여주고 명시적 판정을 받아** 다음 경로를 정한다.

```
build ──→ gate(confirm) ─(pass)────→ ship
   ▲            │
   └────────────┘  (fail, loop_back)
```

`kind: "confirm"` 은 **graph 모드 전용**이다. 새 분기 기계를 만들지 않고 기존
`evaluator` + `verdict` edge 를 그대로 쓴다 — 사람이 evaluator 자리에 앉는 것과 같다.
verdict 어휘는 `pass` / `fail` 고정.

**작성 규칙** (`validateGraphSpec` 이 실행 전에 강제):

- 나가는 edge 중 `when.verdict` 에 `pass` 를 포함한 것과 `fail` 을 포함한 것이 **각각
  최소 하나** 있어야 한다(`loop_back` 도 fail 경로로 인정된다 — 재작업 루프가 표준
  형태다). 한쪽만 라우팅하면 사용자가 그 답을 골랐을 때 나가는 edge 가 전부 dead 라
  미션이 조용히 선다 — 사람에게 물어놓고 답을 버리는 셈이다.
- 두 답이 **실행상 실제로 갈라져야** 한다. 다음 둘은 거부된다:
  - 한 edge 가 `{ verdict: ["pass","fail"] }` 로 둘을 함께 싣는 것 — 어느 답을 골라도
    같은 edge 를 타므로 분기가 존재하지 않는다. (`evaluator` 는 다르다: 거기서
    `["approve","ship-it"]` 은 동의어 묶음이라 정상이다. confirm 은 답이 정확히 둘뿐이고
    그 둘이 사람의 선택 그 자체라서 규칙이 다르다.)
  - pass 가 여는 node 와 fail 이 여는 node 가 겹치는 것 — 그 node 는 사람이 무엇을
    답하든 실행되므로 그 하류에 한해 확인이 아무 효과도 내지 않는데, 사용자는 그 사실을
    화면에서 알 방법이 없다. "어느 쪽이든 하는 일"은 분기 지점이 아니라 하류에서
    `join="any"` 로 표현한다.
  이 둘이 없으면 검증은 통과하는데 게이트가 분기가 아니라 단순 "확인 버튼"이 되어
  요구사항 5가 조용히 깨진다.
- assignee 가 **필요 없다**. 사람이 답하는 node 이므로 담당 에이전트가 없는 것이 정상이다.
- 미션의 `confirm_policy` 가 `none` 이면 노드의 존재 자체가 거부된다.

**실행**

| 단계 | 무슨 일이 일어나는가 |
| --- | --- |
| 열림 | step 이 `awaiting_user` 로 전이. 만족된 상류 edge 의 `artifacts`(스크린샷·동영상·URL·경로)를 **복사**해 판정 근거로 붙이고 `confirm_requested` 이벤트를 남긴다. subagent 는 뜨지 않지만 `total_visits` 를 1 소모한다 — 예산은 node 실행 횟수이지 스폰 횟수가 아니다 |
| 대기 | subagent 를 띄우지 않는다. **병렬 슬롯을 쓰지 않으므로** 다른 분기는 계속 진행된다. 타임아웃도 없다 |
| 판정 | `POST /api/orchestration/steps/:stepId/confirm` (사용자 세션 전용, body `{ workspace_id, verdict, visit, feedback? }`). verdict 를 `verdict` 컬럼에 실어 기존 edge 판정 기계를 그대로 태우고, `confirm_decided` 이벤트를 남긴 뒤 `reportStep` 과 **같은** 전이/차단/디스패치/wake 경로로 이어간다 |

`awaiting_user` 는 `IN_FLIGHT_STEP_STATUSES` 에도 `TERMINAL_STEP_STATUSES` 에도 **없다**.
in-flight 로 두면 병렬 슬롯을 먹고 `reapStuckSteps` 가 사람을 기다리는 노드를
타임아웃으로 죽이며, terminal 로 두면 판정 전에 하류 edge 가 열린다. 대신
`decideWake` 의 정지 판정과 리퍼의 `reapStalledRunning` 이 이 상태를 **명시적으로**
센다 — 그러지 않으면 게이트가 열릴 때마다 오케스트레이터가 "stalled" 로 깨어나고,
창이 지나면 리퍼가 답을 기다리던 미션을 `failed` 로 확정한다.

상태가 DB 컬럼에 있으므로 **서버 재시작을 견딘다**(durable pause). 재기동 후의 pump 는
위 명시 분기 때문에 게이트를 다시 열지 않는다.

**멱등성과 감사** — 중복 클릭·새로고침·재접속은 전부 같은 경로로 들어온다. 판정이 이미
있고 `(visit, verdict)` 가 같으면 재개하지 않고 기존 판정을 `already_decided: true` 로
돌려준다. 그 외의 불일치(다른 verdict, loop 재진입으로 stale 해진 `visit`)는 전부 409 다 —
조용히 덮어쓰면 사용자가 A 를 눌렀는데 B 로 진행되고 사후 재구성조차 되지 않는다.
`confirm_requested` / `confirm_decided` 두 이벤트가 감사 기록이다.

`visit` 은 **필수**이며 1 이상의 정수여야 한다(누락·`null`·`0`·소수·비수치는 400). optional
로 두면 loop 재진입으로 화면이 낡은 클라이언트가 값을 그냥 빼는 것만으로 위 stale 대조를
통째로 건너뛰고 새 pass 를 이전 pass 의 판단으로 확정한다 — 있으나 마나인 방어가 된다.
`reportStep` 이 graph 미션의 모든 보고에 `visit` 을 요구하는 것과 정확히 같은 이유다.
클라이언트 타입이 required 인 것은 서버 계약이 아니므로 검증은 서비스에 둔다(컨트롤러에
중복으로 두면 두 곳이 어긋난다).

**fail 피드백의 전달** — 사용자가 쓴 사유는 재실행되는 step 의 work order 에
`## User confirmation` 절로 실려 나간다. `depends_on` 으로는 도달할 수 없다는 점이
핵심이다: 표준 형태에서 `build` 의 `depends_on` 에는 `gate` 가 없다(있으면 순환이라
거부된다). 그래서 그래프에서 `loop_back` 을 포함해 "이 step 을 재실행시킬 수 있는
confirm 노드" 를 따라가 수집한다. 같은 이유로 loop 재진입 리셋은 `verdict` 만 지우고
`confirm_decision` 은 **보존**한다 — 지우면 피드백이 전달되기 직전에 사라진다. 다음
pass 의 답이 막히지 않는 것은 멱등 검사가 `prior.visit === step.visit` 일 때만 발동하고,
게이트가 실제로 다시 열릴 때 그 자리에서 초기화되기 때문이다.

**MCP 툴은 없다.** 에이전트가 사람 대신 confirm 에 답할 수 있으면 기능 자체가
무의미해지므로 판정 입구는 REST 하나뿐이다. 오케스트레이터가 게이트를 벗어나려면
`update_orchestration_step` 의 `skip` 을 쓸 수 있으나, verdict 가 없어 pass/fail edge 가
모두 dead 이므로 하류는 `blocked` 가 되고 오케스트레이터가 깨어난다(의도된 동작).

### 게이트 대기 알림 (ticket a78cb566)

게이트는 타임아웃 없이 멈추므로, **아무도 통보받지 않으면 미션은 며칠이고 선다.** 미션
목록·상세 헤더의 `n needs your decision` 배지는 이미 화면을 연 사람에게만 도달한다.
confirm 은 "가만히 두면 언젠가 진행된다" 가 성립하지 않는 유일한 상태라, 대기 사실을
화면 밖으로 밀어내는 것이 기능의 일부다.

| 언제 | 무엇이 나가는가 |
| --- | --- |
| 게이트가 열릴 때 | `(step, visit)` 당 **1회**. 제목에 미션명, 본문에 step 제목 + 질문(`instructions`), 링크는 판정 화면(`/ws/<ws>/orchestration/missions/<id>`) |
| N시간 무응답 | 같은 pass 에 **1회** 리마인더(`ORCHESTRATION_CONFIRM_REMINDER_MS`, 기본 24시간, `0` = 끔) |
| 판정 이후 | 없음 — `awaiting_user` 가 아니면 리마인더 대상이 아니다 |

**경로는 기존 UserChannel 팬아웃을 그대로 쓴다**(`UserChannelDispatcherService`) — 새 알림
채널을 만들지 않는다. discord 바인딩의 `target` 은 DM 뿐 아니라 채널 id 도 될 수 있어
"푸시" 와 "Discord 채널" 이 같은 한 경로로 커버된다. 플래그는 `notify_mention` 이다:
`notify_ticket` 은 UI 라벨이 "Ticket activity" 이고 Mission 은 의도적으로 Ticket 이 아니며,
기본값이 `0` 이라 그 키를 쓰면 기능이 기본 침묵으로 출시되어 이 절이 고치려는 실패가
그대로 남는다. 게이트는 시스템이 **당신을 콕 집어** 답을 요구하는 자리라 미션 쪽 @-mention 에
해당한다.

**수신자** — 미션 소유자(`created_by_type='user'` 인 미션의 `created_by`)가 1순위다. 에이전트가
`create_orchestration_mission` 으로 만든 미션은 사람 소유자가 없으므로 워크스페이스의
owner/member 로 넓힌다. 넓혀도 실제 소음은 작다 — 채널 바인딩이 없는 사용자는 팬아웃이
그 자리에서 no-op 이다. `AWB_PUBLIC_URL` 이 없으면 링크 없이 나간다(무엇이 왜 멈췄는지는
여전히 전달된다).

**중복 방지는 DB 가 판정하는 선점(claim)이다.** 승패를 애플리케이션이 아니라 **단일
UPDATE 의 `WHERE` 절**이 정한다 — 이긴 호출만 보내고, 진 호출은 아무것도 하지 않는다.

```
UPDATE orchestration_steps SET confirm_notified_visit = :visit, confirm_notified_at = now()
 WHERE id = :id AND visit = :visit AND status = 'awaiting_user'
   AND (confirm_notified_visit IS NULL OR confirm_notified_visit <> :visit)
```

읽고-판단하고-쓰기로는 안 된다. `missionLocks` 는 **프로세스 메모리**라 한 서버 안에서만
유효하고, 운영(PostgreSQL)에서 서버가 둘이면 두 pump 가 같은 pass 를 동시에 열어 둘 다
"아직 안 보냈다"를 읽고 둘 다 보낸다 — 사람에게 같은 질문이 두 번 울린다.

세부 규칙 셋:

- **발송 전에 선점한다.** 발송 성공을 기다렸다 쓰면 그 사이가 통째로 창이다. 먼저 커밋하면
  최악이 "발송 실패했는데 선점만 남는다"인데, 그건 리마인더 스윕이 뒤에서 주워 간다 —
  중복 발송보다 언제나 낫다.
- **실패하면 진다(fail-closed).** `affected` 가 없거나 UPDATE 가 던지면 졌다고 본다. 낡은
  스냅샷으로 이겼다고 추측하면 두 경쟁자가 모두 승자가 되어 단일 승자 보장이 깨진다
  (`ActionsService.completeRun` 이 같은 이유로 같은 선택을 한다).
- **판정 후 침묵도 같은 한 방이 보장한다.** `status = 'awaiting_user'` 가 선점 조건이라,
  그 사이 사람이 답했으면 선점 자체가 실패한다(요구사항 4).

키가 pass 번호(`visit`)라서 같은 pass 는 pump 가 몇 번을 돌든(서버가 재기동하든) 한 번이고,
loop 재진입으로 pass 가 올라가면 값이 달라져 새 알림이 나간다. 리마인더는 별도 컬럼
(`confirm_reminded_visit`)이라 최초 알림과 서로를 막지 않는다.

**JSON 한 덩어리가 아니라 스칼라 컬럼 셋인 이유**가 여기 있다 — JSON blob 은 `WHERE` 에서
이식성 있게 비교할 수도, 색인해 후보를 고를 수도 없다.

**발송은 미션 락 밖에서 배경으로 돈다.** 알림 provider 는 요청 타임아웃이 없는 raw
`fetch` 라, 응답하지 않는 엔드포인트를 `openConfirmGate` 안에서 기다리면 그 미션의 락
체인이 통째로 멈춰 **사용자가 판정을 제출하는 것조차 막힌다** — 알림을 못 보내는 것보다
나쁜 결과다. 그래서 발송은 `scheduleGateNotice()` 로 던져두고(개별 발송에는 15초 상한),
공개 메서드는 `recordEvent` 와 같이 **절대 던지지 않는다**. 발송 결과는 `confirm_notified`
이벤트로 남는다(실패도 `sent: 0` 으로 남는다).

**리마인더는 알림이지 상태 전이가 아니다.** 리퍼의 `remindAwaitingConfirm` 스윕은 미션·step
상태를 한 글자도 바꾸지 않고 선점 마커(`confirm_reminded_visit`)만 쓴다. `reapStalledRunning`
의 `isAwaitingUser` 가드 — 리퍼는 confirm 대기 미션을 죽이지 않는다 — 는 그대로다.

**후보는 SQL 이 직접 고른다 — 기아가 없어야 하기 때문이다.** 미션을 무순서로 잘라 온 뒤
애플리케이션에서 게이트를 거르면, 실행 중 미션이 창 크기를 넘는 순간 그 밖의 게이트는 아무리
오래 기다려도 **한 번도 검사되지 않는다**. 그래서 미션이 아니라 **만료된 게이트 자체**를
후보로 세고, 세 조건(`step.status='awaiting_user'` + `mission.status='running'` + 이 pass 를
아직 아무도 선점하지 않음 + 대기 시간이 창 초과)을 전부 SQL 안에서 판정한다.

`CONFIRM_REMINDERS_PER_SWEEP`(25)은 **선택 기준이 아니라 처리량 상한**이다. 후보를 오래
기다린 순(`COALESCE(confirm_notified_at, dispatched_at)` 오름차순)으로 가져가고 내보낸 것은
선점 마커가 찍혀 후보 집합에서 영구히 빠지므로, 이번 창에 못 든 후보는 다음 스윕에서 더
오래된 축이 되어 앞으로 당겨진다 — **모든 후보가 결국 검사된다**. `COALESCE` 로 한 식에
묶는 것은 NULL 정렬 순서가 백엔드마다 다르기 때문이기도 하다(SQLite 는 ASC 에서 NULL 이
먼저, PostgreSQL 은 나중). 인덱스는 `idx_orch_steps_confirm_gate`.

### 사용자 확인 강도 (confirm_policy, ticket 5dbe4aa2)

미션 단위 옵션. **기본값 `auto`.**

| 값 | 의미 |
| --- | --- |
| `none` | confirm 노드 금지 — 그래프 제출 자체가 거부된다 |
| `auto` | 위험·불확실·시각 검증이 필요한 지점만 오케스트레이터가 판단해 배치 |
| `key_steps` | 주요 산출물 확정 직전, 외부로 나가는 작업 직전 |
| `every_step` | 결과물이 생기는 단계마다 |

기본값을 `auto` 로 둬도 **기존 미션의 동작은 한 글자도 바뀌지 않는다**: confirm 노드는
graph 모드에서만 만들 수 있고 `graph_enabled` 기본값이 `false` 이므로, 기존 미션은
정책값과 무관하게 게이트를 가질 수 없다. `none` 을 기본으로 두면 하위호환에 아무 이득
없이 새 기능만 기본 off 가 된다.

서버가 **강제하는 것은 `none` 뿐이다.** 나머지는 미션 브리핑에 지시로 실려 나간다 —
"몇 개면 `key_steps` 를 만족하는가" 를 서버가 셀 방법이 없어 정량 강제는 정상 계획까지
막는 브리틀한 게이트가 된다. 대신 `key_steps`/`every_step` 인데 확정 그래프에 게이트가
0개면 거부 대신 timeline `note` 를 남겨 운영자가 미반영을 볼 수 있게 한다.

정책은 **brief-lock 대상**이다(`graph_enabled` 와 같은 급) — 미션이 시작된 뒤 바꾸면
오케스트레이터가 들은 계약과 어긋난다. 읽을 때는 항상 `normalizeConfirmPolicy()` 를
거친다: DDL 마이그레이션 없이 엔티티 default 로 추가된 컬럼이라 기존 행이 `''`/NULL 로
남을 수 있고, 그 값이 그대로 흐르면 어느 분기에도 걸리지 않아 기능이 영구 no-op 이 된다.

### 미션 대화의 사용자 chat 옵션 (user_chat_mode, ticket 9cfd8161)

미션 단위 옵션. **기본값 `open`.**

| 값 | 의미 |
| --- | --- |
| `open` | 워크스페이스 운영자면 참여자로 등록되지 않았어도 바로 발화 |
| `participants_only` | 참여자 명단에 있는 사람만 발화 |
| `off` | 사람은 아무도 발화 불가 — 읽기 전용(관전) |

**세 값 모두 읽기는 막지 않는다.** 관전 경로(`?observer=true`)는 참여자가 아니어도 읽을 수
있고 이 옵션을 보지 않는다 — 이 옵션이 닫는 것은 발화뿐이다.

**이 컬럼이 단일 기준이고 방의 `open_join` 은 그것의 파생 캐시다.** 발화 게이트도 자유 참여
완화도 방 플래그가 아니라 미션 값을 직접 읽는다(`resolveMissionChatPolicy`). 판정까지
캐시에 걸면 둘이 어긋난 순간(백필 이전 행, 수동 수정, 부분 실패) 사용자가 보는 옵션과 실제
동작이 갈린다. 방 플래그를 맞춰 두기는 한다 — 관전 없이 읽기를 허용하는 경로와 첫 발화 시
auto-join 이 그 플래그를 보기 때문이고, 방 생성·옵션 변경·백필 세 경로가 모두
`openJoinForUserChatMode()` 한 줄을 지난다.

기본값을 `open` 으로 둔 이유는 하위호환이다: 이 옵션 이전에도 새로 시작된 미션 방은 이미
`open_join: true` 로 만들어지고 있었다(ticket 995a9519). 기본을 좁히면 옵션을 추가했다는
이유만으로 이미 동작하던 방들의 계약이 바뀐다.

**brief-lock 대상이 아니다** — `confirm_policy`/`graph_enabled` 와 다른 점이다. 저 둘은
오케스트레이터가 브리핑에서 들은 실행 규칙이라 시작 뒤 바꾸면 계약과 어긋나지만, 이 옵션은
사람이 이 방에서 말할 수 있는지만 정할 뿐 오케스트레이터가 들은 내용을 바꾸지 않는다.
오히려 요구 자체가 실행 중 변경이므로 running 미션에서도 편집된다(종료 미션은
`updateMission` 이 409 — 그때는 모드와 무관하게 읽기 전용이라 바꿔도 의미가 없다).

읽을 때는 항상 `normalizeUserChatMode()` 를 거친다 — `confirm_policy` 와 같은 이유로 DDL
마이그레이션 없이 추가된 컬럼이라 기존 행이 `''`/NULL 로 남을 수 있고, 그 값이 그대로
흐르면 어느 분기에도 걸리지 않아 기존 미션의 대화가 영영 닫힌다.

**옵션 저장은 원자적이다** — `updateMission` 이 미션 행과 파생 캐시(방 `open_join`)를 한
트랜잭션으로 쓴다. 둘을 나눠 쓰면 두 번째가 실패했을 때 호출자는 실패 응답을 받는데 옵션만
바뀐 채 남아, 옵션과 방 플래그가 갈린 상태가 영속된다(리뷰 지적). SSE 는 커밋 뒤에 낸다.

**백필** — `1760000000084-BackfillMissionRoomUserChat` 이 기존 미션 방의 `open_join` 을 이
옵션에 맞추고, 미션 생성자(`created_by_type='user'`)를 참여자로 등록한다. 순회 대상이
`mission.room_id` 뿐이라 step 방에는 구조적으로 닿지 않는다. 재실행 안전 — 값이 같은 방은
쓰지 않고, 참여자는 (room, user) 행 **존재 여부**로 판정한다(활성 여부로 보면 의도적으로
나간 사람을 매 실행마다 되돌린다). 같은 순회에서 미션 chat 상태 전수 조사 결과를 한 줄
로그로 남긴다 — 워크스페이스 전체 미션을 열어 주는 표면이 에이전트 쪽에 없어 조사를 여기에
얹었다.

조사는 요구된 세 축을 **변경 전 값으로** 찍는다: 방 `open_join` 분포, 활성 **사람** 참여자
유무(의사 user `system` 은 사람으로 세지 않는다), 미션 상태. 생성자 행은 활성/탈퇴/없음으로
쪼개 센다 — 뭉뚱그리면 "이미 참여 중"과 "스스로 나감"이 한 수에 섞인다.
`before_open_join` 의 off 수와 `owner(absent=…)` 가 백필 대상 수이고, `mode_column_unset` 은
**대상 수가 아니다** — `synchronize` 가 컬럼을 default 로 추가하며 기존 행까지 채우므로 보통
0 이다(그 값을 레거시 미션 수로 읽으려던 초안이 틀렸다, 리뷰 지적).

정책 검사는 `validateGraphSpec` 안에 있고, `applyGraphPatch` 와
`carryGraphThroughReplan` 이 결과 전체를 그 함수에 다시 통과시킨다 — 그래서 patch 로
node kind 를 `confirm` 으로 바꾸거나 replan 으로 그래프를 이어받아도 정책을 우회할 수 없다.

---

## 디스패치가 채팅룸을 재사용하는 이유

QA 런·Action 런과 **동일한 파이프라인**을 쓴다: `ChatRoom` 생성 → 참여자 등록 →
`RoomMessagingService.sendMessage(..., sender_type:'user', sender_id:'system')` →
`chat_room_message` SSE → agent-manager 가 subagent 스폰.

결과적으로 **오케스트레이션 자체는 agent-manager 에 새 SSE contract 를 만들지
않았다** — 기존 `chat_room_message` / `run_provision` 필드를 QA/Action 이 이미
쓰는 그대로 재사용한다. 구체적으로:

- 룸은 `chat_rooms.orchestration_mission_id` / `orchestration_step_id` 로 표시되고,
  일반 채팅 목록(`listRooms` / `listAllWorkspaceRooms`)에서 제외된다 — Action 룸과 같은 처리.
  이 제외는 **사람이 참여자가 된 뒤에도 유지된다**: 미션 하나가 step 룸을 수십 개 열기
  때문에, 접근 경로는 사이드바가 아니라 미션 상세 화면이어야 한다.
- 같은 필드가 기존 `is_action_room` SSE 마커를 켠다. 오케스트레이션 룸은 대화가
  아니라 작업 실행이므로, subagent 는 "티켓을 만들어 미루지 말고 직접 하라" 지시를
  받아야 한다. 새 payload 필드를 만드는 대신 기존 플래그를 재사용해 contract 를 고정했다.
- Retry 는 **매 시도마다 새 룸**을 판다. 실패한 시도의 대화가 히스토리로 재생되면
  subagent 가 자기 막다른 길을 그대로 반복한다.

> **사람 참여자 (ticket f6a0de0e):** 룸 참여자는 원래 orchestrator agent 와 의사 user
> `system` 둘뿐이었다. `sendMessage` 는 active participant 가 아니면 403 이므로, 사람은
> 대화 UI 가 붙어 있어도 항상 관전으로 떨어졌다. 이제 **mission 룸에 한해** 미션
> 생성자(`created_by_type='user'`)가 시작 시 함께 등록되고, 그 외의 사람은
> `POST /orchestration/missions/:id/join-conversation`(멱등, `MANAGE_ACTIONS`)으로 들어온다
> — 이 라우트 하나가 자동 등록이 없던 시절의 **과거 미션 백필**과 생성자가 아닌 운영자의
> **초대**를 겸한다. 참여는 `chat_room_participants` 행이라 재시작·복구 뒤에도 유지된다.
>
> **참여 대상은 진행 중인 미션뿐이다.** 종료(`completed`/`failed`/`cancelled`)된 미션의
> join 은 서버가 409 로 거부하고 화면도 참여 버튼을 숨긴다 — 참여에 성공해도 말을 걸
> orchestrator 세션이 없어 아무 일도 일어나지 않으므로, 한쪽만 막으면 REST 를 직접 부르는
> 경로로 규칙이 샌다. 종료된 미션의 기록은 observer 경로로 그대로 읽을 수 있다. 즉 "과거
> 미션도 백필 후 대화 가능"은 **이전에 만들어졌지만 아직 진행 중인** 미션을 뜻한다.
>
> 그 "규칙이 새는 경로"가 실제로 열려 있었다(ticket 9cfd8161): join 과 화면은 막았지만
> **발화 자체**는 종료 여부를 보지 않아, 이미 참여자인 사람이 REST 로 끝난 미션에 새 지시를
> 넣을 수 있었다. 이제 `requireMissionRoomSpeaker` 가 종료 미션의 사람 발화를 403 으로
> 거부한다 — join·화면·발화 세 표면이 같은 규칙을 말한다. 읽기는 변함없이 열려 있다.
>
> **권한은 join 순간이 아니라 매 발화에 걸린다.** participant 행은 한 번 생기면 남으므로,
> join 시점 검사만으로는 강등되거나 권한이 회수된 계정이 계속 orchestrator 를 깨울 수
> 있었다(리뷰 지적). `RoomMembershipService.requireMissionRoomSpeaker` 가 orchestration
> 룸으로 가는 모든 사람 발화에 대해 `users` 행에서 `MANAGE_ACTIONS` 를 다시 읽는다 —
> 세션 스냅샷이 아니라 DB 를 보므로 회수가 즉시 반영된다. 게이트를 컨트롤러가 아니라
> 서비스에 둔 것은 REST·MCP·agent-api 어느 진입점이든 같은 판정을 받게 하기 위해서다.
> agent 발화와 의사 user `system` 은 통과시킨다: 전자는 런너가 lease/orchestrator id 로
> 신원을 따로 검사하고, 후자를 막으면 엔진 자신의 브리핑·wake 가 죽어 미션이 통째로 멈춘다.
>
> ticket 9cfd8161 이후 이 게이트는 권한 앞에 **미션 단위 규칙 둘**을 먼저 본다 — 미션이
> 종료됐는가, 그리고 `user_chat_mode` 가 `off` 인가(위의 「미션 대화의 사용자 chat 옵션」
> 절). 셋은 서로 다른 사유이므로 서로 다른 메시지를 던지고, 대화 패널이 그 순서 그대로
> 사유를 표시한다. 순서를 미션 규칙 →
> 개인 권한으로 둔 이유는 앞의 둘이 관리자에게도 똑같이 걸리는 방 전체의 상태라서
> "당신에게 권한이 없다"보다 사용자가 할 수 있는 행동을 정확히 알려주기 때문이다.
>
> **이 게이트 전체가 참여자 검사보다 먼저 돈다.** 세 사유는 전부 "참여자가 되어도 풀리지
> 않는" 것이라, 뒤에 두면 비참여자에게는 도달하지 못하고 "참여자가 아님"이 대신 나간다 —
> 사용자는 참여 버튼을 눌러 성공한 뒤 같은 자리에서 다시 막히고, 화면이 선언한 순서와
> 서버가 내는 사유가 갈린다. 초안이 실제로 그 상태였다(리뷰 지적). 참여로 **풀리는** 사유
> (참여자 아님)를 마지막에 두는 것이 이 순서의 규칙이다. auto-join 보다 앞이라는 기존
> 제약(티켓 995a9519)도 그대로 만족한다 — auto-join 은 더 뒤, 메시지 저장 트랜잭션 안이다.
>
> **step 룸에는 사람을 넣지 않는다.** attempt 마다 룸이 새로 열려 수가 불어나고, 그 룸의
> 보고는 `lease_token` 을 쥔 assignee 만 할 수 있어 사람이 끼어들어도 step 상태를 바꿀 수
> 없다. 사람의 지시는 mission 룸에서 orchestrator 에게 가고 step 을 통제하는 것은
> orchestrator 다 — 창구를 하나로 모아야 "누가 이 step 에 지시했나"가 추적된다. step 룸
> 열람은 기존 observer 경로(`?observer=true`)로 그대로 열려 있다.
>
> 사용자 발화가 orchestrator 를 깨우는 경로는 엔진 자신의 wake 와 **같다** — 둘 다
> `sender_type:'user'` 로 룸에 글을 쓰고, 같은 `chat_room_message` 이벤트가 같은
> `agent_member_ids` 로 나간다. 다른 것은 `sender_id` 가 `system` 이냐 실제 사용자
> UUID 냐뿐이라, agent-manager 디스패치 계약은 손대지 않았다.

> **Agent 작업공간 (ticket 2dc3c62f):** step 디스패치는 QA/Action 런과 동일한
> `run_provision` 힌트(`kind:'orchestration'`)를 실어 보낸다 — agent-manager 가
> subagent 스폰 전에 `<working_dir>/.awb/orch/<mission-leaf>/<step_key>` 를
> 프로비저닝(clone/fetch+ff-pull 또는 폴더만 생성)하고 그 경로를 cwd 로 고정한다.
> `OrchestrationMission.workspace_folder`(루트, 기본값 `<mission id 8자>`) /
> `repo_ref` / `checkout_mode` 로 제어한다. `RunProvisionKind` 화이트리스트와
> idle-sweep(`.awb/act`/`.awb/chat`와 동일한 정책)에 `'orchestration'` 이
> 추가됐다. Mission 은 `method`(수행 방식), 구조화된 `completion_criteria`
> 체크리스트(전원 met 이어야 `complete_orchestration_mission(status:"completed")`
> 통과 — `acceptance_criteria` prose 는 그대로 유지), `post_actions`(완료 후
> 조건부 Action 디스패치, on-ticket-done-action 과 동일하게 fire-and-forget)도
> 함께 갖는다. 진짜 `git worktree`(전용 브랜치)는 이번에도 범위 밖이다 — step
> 은 QA/Action 과 같은 clone 기반 "run" 이지, 자기 브랜치를 갖는 dev-loop 가
> 아니다.

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
| Running-stall 타임아웃 | 동상 | 전 step 종료 후 `complete_orchestration_mission` 을 안 부르는 오케스트레이터 → 2회 재브리핑 후 failed |
| 예산 상한 | `max_steps` / `max_plan_versions` / `max_attempts` | 계획 폭주·재계획 루프·무한 재시도 |
| 병렬 상한 | `max_parallel_steps` + 멤버별 `max_concurrent` | 한 번에 20개 subagent 스폰 |
| 그래프 검증 | `validateGraphSpec()` | 종료 조건·반복 상한·global budget 없는 loop, loop_back 아닌 순환, 도달 불가 node, 분기 없는 router |
| 반복 상한 | node 별 `max_visits` | evaluator→revision loop 가 영영 도는 것 (상한 도달 시 하류 blocked + 오케스트레이터 깨움) |
| 실행 예산 | `max_total_visits` vs `total_visits` | 재시도·재진입을 합친 총 subagent 스폰 횟수 폭주 |
| stale pass 거부 | `report_orchestration_step(visit:)` — graph 미션에서는 **필수** | 재진입으로 무효가 된 이전 pass 의 지각 보고가 새 pass 결과를 덮어쓰는 것 (누락도 409로 거부 — optional 이면 빼는 것만으로 우회된다) |
| stale attempt 거부 (lease fencing) | `lease_token` — 모든 보고에서 step 이 토큰을 들고 있으면 **필수** | 재시도로 밀려난 이전 attempt 의 지각 보고 (`visit` 은 재시도로 안 바뀌어 이 축을 못 막는다) |
| lease 유예 + 자동 재개 | `reconcileStaleLease()` (리퍼가 부르는 단일 진입점) | 세션이 죽은 step 이 orchestrator 의 수동 개입 전까지 멈춰 있는 것 |
| 하류 자동차단 해제 | `unblockAutoBlockedDependents()` | 상류를 복구해도 그때 자동 차단된 하류가 blocked 로 남아 미션이 영영 완료되지 않는 것 |
| heartbeat lease | `last_heartbeat_at` + 리퍼 기준선 | 살아있는 장기 작업이 timeout 으로 죽는 것 / 죽은 세션이 시계를 계속 되돌리는 것 |
| 비멱등 작업 자동 재실행 | `retry_policy='manual'` → `needs_recovery` | 배포·결제·게시처럼 "한 번 더"가 그 자체로 피해인 작업의 자동 재시도 |

### 권한

- REST(사람): `PERMISSIONS.MANAGE_ACTIONS` — Actions / QA / Security 와 같은
  "자동화 저작" 권한군. confirm 판정(`POST /steps/:stepId/confirm`)도 이 게이트를
  그대로 상속한다 — 아무도 가지지 않은 새 권한을 신설하면 기능이 기본 잠김으로 나간다.
- MCP(Agent): **스코프가 아니라 신원**으로 검사한다. 변경 툴은 호출 Agent 가
  `mission.orchestrator_agent_id` 인지, 또는 `step.assignee_agent_id` 인지를
  런너에서 확인한다. full-scope API 키를 가진 Agent 도 남의 step 을 보고할 수 없다.
  (그래서 `tool-authz-gate.ts` 의 `KNOWN_EXISTING_TOOLS` 에 등재만 하고 tier 는 두지 않았다.)
  이후 추가된 3종(아래 "미션 생성 주체" 참고)은 같은 논리를 `TOOL_AUTHZ_TABLE` 에
  `'caller'` 로 명시 등록해 표현한다 — `KNOWN_EXISTING_TOOLS` 는 게이트 작성 시점의
  동결 스냅샷이라 신규 도구의 자리가 아니다.

### 미션 생성 주체 (ticket b7127aae)

**"Team = 사람이 부여한 권한 grant, Mission = 그 권한의 행사"** 로 경계를 나눈다.

| 대상 | 생성 경로 | 비고 |
| --- | --- | --- |
| **Team**(로스터·오케스트레이터 지정) | **영구히 사람 전용** — UI/REST만 | 로스터는 "이 Agent 가 누구에게 일을 시켜도 되는가"라는 권한 범위 그 자체라, Agent 가 자기 지휘 범위를 스스로 넓히는 것은 어떤 가드로도 정당화하지 않는다. `create_orchestration_team` MCP 툴은 존재하지 않고, 앞으로도 추가하지 않는다. |
| **Mission** | 사람(UI, `start:true` 로 즉시 브리핑) **또는** 그 Team 의 오케스트레이터 Agent 자신(`create_orchestration_mission` MCP 툴) | 사람이 이미 Team 을 만들며 권한을 승인해 둔 상태이므로, 오케스트레이터의 Mission 자기-생성은 새 자율성 표면이 아니라 **이미 승인된 권한의 반복 행사**다. |

`create_orchestration_mission` 입력은 `team_id` / `title` / `objective` / `context?` /
`acceptance_criteria?` / `max_steps?` / `max_parallel_steps?` / `step_timeout_minutes?` /
`start?` 뿐이다. **`orchestrator_agent_id` · `members[]` · `team_name` 입력은 없다** —
오케스트레이터는 팀에서 파생되고(호출자 자신만 가능), 로스터는 여전히 사람의 것이다.
`list_orchestration_teams` / `list_orchestration_missions` 로 자기 소속 team_id·기존
미션을 먼저 조회한다.

에이전트 생성 경로는 사람(REST) 경로보다 좁은 가드 4종을 추가로 통과해야 한다 —
이 엔티티엔 `board_id`/`ticket` 이 없어 `hard_budget_config` 예산 가드를 못 걸기
때문에(스코프 설계는 별도 티켓), 대신 다음이 팬아웃 상한 역할을 한다:

| 가드 | 내용 |
| --- | --- |
| 소유권 | `team.orchestrator_agent_id` 가 호출자 자신이어야 함(null 팀 거부) |
| 비활성 팀 | `team.enabled === 0` 이면 거부 |
| 팀당 열린 미션 상한 | `OrchestrationTeam.max_open_missions`(기본 1) 초과 시 생성 대신 **409** — `existing_mission_id` / `existing_mission_status` / `open_step_count` 를 실어 반환한다. `status:"running"` 이면서 `open_step_count:0` 이면(전 step 종료 후 오케스트레이터가 `complete_orchestration_mission` 을 안 부른 상태) 409 메시지가 그 사실과 탈출 경로를 그대로 알려준다 — 이 상태는 `OrchestrationReaperService` 의 running-stall 분기가 최대 `ORCHESTRATION_RUNNING_STALL_TIMEOUT_MS`(기본 20분) 후 재브리핑, 2회 무응답 후 `failed` 로 자동 승격해 슬롯을 회수하므로 수동 개입은 그전에 쓸 수 있는 지름길일 뿐이다. |
| 재귀 차단 | 호출자가 어떤 미션에서든 `dispatched`/`running` step 을 보유 중이면 생성 거부(`listOpenStepsForAgent` 재사용) — orchestrator 가 자기 팀의 member 이기까지 한 것은 정상 패턴이라 막지 않는다(브리핑 재발행은 `startMission` 이 1회만 발행 + `updateMission` 이 `status≠draft` 이면 409 로 거부해 이미 구조적으로 불가능). |
| 낮은 기본값 | `max_steps` 기본/상한 20 (사람 경로 60/`MAX_STEPS_CEILING=200`), `max_parallel_steps` 기본/상한 `min(team.max_parallel_steps, 4)` — 명시 인자로도 이 상한을 못 넘는다. |

### 사람이 step 을 직접 못 만지는 이유

UI 에는 step 배정/완료 버튼이 없다. 계획은 오케스트레이터의 것이고, UI 가 계획을
직접 고치면 오케스트레이터가 가진 미션 모델과 DB 가 어긋나는데 이를 되맞출 채널이
없다. 사람의 개입 경로는 **Start / Pause / Resume / Cancel / Nudge** 다 — Nudge 는
미션 룸에 메모를 남기고 오케스트레이터를 깨우므로, 지시가 계획 소유자를 거쳐 반영된다.

**유일한 예외는 confirm 노드의 판정**이다(ticket 5dbe4aa2). 모순이 아닌 이유: 게이트를
세울지 말지는 여전히 오케스트레이터의 결정이고(정책은 그 결정의 상한일 뿐), 사람이
바꾸는 것은 계획이 아니라 **자기 자신에게 요청된 판정값**이다. 그 값도 그래프가 미리
선언한 `pass`/`fail` edge 로만 흐르므로 사람이 실행 경로를 즉흥적으로 만들어내지 못한다.

---

## MCP 툴

**오케스트레이터**

| 툴 | 용도 |
| --- | --- |
| `get_orchestration_mission` | 현재 계획·결과·타임라인·즉시 디스패치 가능 목록 |
| `submit_orchestration_plan` | 계획 제출/수정 (**병합**: 기존 키는 미시작 시에만 갱신, 누락 키는 보존) · graph 모드에서는 선택적 `graph`(node/edge/예산) 또는 `graph_template`(이름 있는 형태)을 함께 받는다. 셋 다 없으면 **확정된 그래프를 보존**하고 새 step 만 고립 node 로 편입한다 — 버리려면 `reset_graph: true` |
| `patch_orchestration_graph` | 실행 중인 그래프를 **부분** 수정 — 분기 열기/닫기, 의존 재배선, 반복 상한 조정, 폭주 loop 정지. plan 을 건드리지 않아 `plan_version` 을 소모하지 않는다 |
| `update_orchestration_step` | `retry` / `reassign` / `amend` / `skip` / `cancel` |
| `add_orchestration_note` | 타임라인에 판단 근거 기록 |
| `complete_orchestration_mission` | `completed` / `failed` — **미션을 끝내는 유일한 경로** |

**멤버**

| 툴 | 용도 |
| --- | --- |
| `get_orchestration_step` | 작업지시 + 의존 step 들의 결과 재조회 |
| `list_my_orchestration_steps` | 세션 유실 후 미보고 배정 복구 |
| `report_orchestration_progress` | 하트비트 (타임아웃 시계 리셋, step 을 끝내지 않음) |
| `report_orchestration_step` | **최종 보고** — 하위 step 을 여는 유일한 신호 · graph 모드에서는 `verdict`(분기 선택)와 `visit`(pass 번호, **필수**)를 함께 보낸다 |

**조회 / 자기-생성** (오케스트레이터 또는 멤버, ticket b7127aae)

| 툴 | 용도 |
| --- | --- |
| `list_orchestration_teams` | 내가 오케스트레이터·멤버로 속한 Team 목록 (`create_orchestration_mission` 의 `team_id` 발견 경로) |
| `list_orchestration_missions` | 내가 속한 Mission 목록·상태 (기본 non-terminal 만, `include_finished` 로 확장) |
| `create_orchestration_mission` | 내가 오케스트레이터인 Team 에 한해 Mission 생성(+즉시 브리핑) — "미션 생성 주체" 절 참고 |
| `list_orchestration_graph_templates` | 내장 실행 그래프 템플릿 카탈로그(용도·파라미터·예시). 읽기 전용이며 미션을 건드리지 않는다 |

`submit_orchestration_plan` 이 병합(추가적)인 이유: 누락 키를 삭제하면 이미 끝난
작업과 그 결과 컨텍스트가 조용히 사라진다. 제거는 `skip` 으로 명시해야 한다.
진행 중이거나 종료된 step 은 재계획이 **덮어쓰지 않는다** — 실행 중인 subagent 밑에서
지시가 바뀌거나, 끝난 작업의 지시가 소급 변조되는 것을 막는다.

---

## 관찰 (UI)

- **Missions**: 상태 배지 + 진행 바 + 카운트. `orchestration_update` SSE 로 행이 실시간 갱신.
- **Mission 상세**: 헤더(살아있나/얼마나), Plan 그래프(누가 뭘, 무엇에 막혔나),
  대화 패널(지금 방향을 바꾸거나 물어보기), 타임라인(무슨 일이 순서대로).
- **Plan 그래프**: step 을 **의존 깊이(wave)** 열로 배치한다. 같은 열 = 실제 병렬 작업.
  간선은 선 대신 `← key` 칩으로 그린다(step 10개 넘어가면 선은 읽을 수 없는 뭉치가 된다).
  graph 모드에서는 깊이를 `depends_on` 이 아니라 **forward edge** 로 계산한다 —
  조건 분기는 `depends_on` 에 나타나지 않으므로 그대로 두면 분기 하류가 전부
  "즉시 시작" 열로 접혀 보인다. 칩은 방향·종류·조건을 함께 싣고(`→ ship · looks good`,
  `↺ integrate · needs another pass`), 카드에 node 종류(`evaluator`), pass 카운터
  (`pass 2/3`), 마지막 `verdict` 가 함께 표시된다.
- **실행 trace**: 타임라인의 `edge_selected` 는 **선택된 edge 와 기각된 edge 를 각각
  이유와 함께** 남긴다(예: `"review" reported verdict "revise", not approve`).
  `node_revisited` 는 몇 번째 반복인지·상한이 얼마인지·무엇이 리셋됐는지를,
  `loop_exhausted` / `graph_budget_exhausted` 는 왜 멈췄는지를 남긴다.
- **확인 요청 패널** (ticket 5dbe4aa2): `awaiting_user` step 이 있으면 미션 상세 **맨
  위**에 카드로 뜬다 — 미션 전체가 거기서 멈춰 있으므로, 계획 그래프 아래로 내려가면
  "왜 아무것도 진행되지 않는가" 를 찾는 데 스크롤이 필요해진다. 증거는 링크 나열이
  아니라 판정 가능한 형태로 그린다(이미지는 인라인, 동영상은 재생 가능, 나머지 http(s)
  는 새 탭 링크). Pass/Fail + 선택 사유 입력이며, 제출 payload 에는 화면이 본 `visit`
  이 함께 실린다. 미션 목록·상세 헤더에도 `n needs your decision` 으로 노출된다 —
  사람이 열어보지 않으면 절대 진행되지 않는 미션이 조용한 카드와 구분되지 않으면
  방치되기 때문이다.

- **대화 패널** (ticket 4d065f82): 미션의 orchestrator ChatRoom(`mission.room_id`)에
  붙는다 — 새 채팅 구현이 아니라 기존 Chat 의 `MessageList` / `ChatMessageInput` 을 그대로
  재사용하므로 마크다운·첨부·멘션·ref 카드가 자동으로 따라온다. 여기서 보낸 지시는
  orchestrator 세션의 대화 맥락에 그대로 들어가고 서버에 영속되므로 재시작 뒤에도 기록과
  thread context 가 남는다.
  대화와 실행 이벤트는 한 스트림에 시간순으로 엮되 **서로 다른 렌더러**로 그린다 — 실행
  이벤트를 가짜 채팅 메시지로 만들어 `MessageList` 에 넣으면 첨부·발신자 그룹핑 같은 그
  컴포넌트의 계약이 전부 거짓이 되므로, 종류가 바뀌는 지점에서 구간을 끊는다.
  참여자가 아니면 observer 로 강등돼 읽기만 되지만, 거기서 끝나지 않는다 — 진행 중인
  미션이면 **"대화에 참여" 버튼**이 함께 뜨고(ticket f6a0de0e), 누르면 위의 join 라우트를
  거쳐 입력창이 열린다. 종료된 미션에는 그 버튼을 걸지 않는다: 참여에 성공해도 보낼
  orchestrator 세션이 없어 아무 일도 못 하는 버튼이 되기 때문이다(입력은 그대로 닫힌다).
  서버도 같은 규칙으로 종료 미션의 join 을 409 로 거부하므로, 화면을 우회해 REST 를 직접
  불러도 결과가 같다.
  긴 미션에서는 실행 이벤트를 창 크기(기본 200)로 bounded 하고, 위로 스크롤하면
  `GET /orchestration/missions/:id/events` 커서로 과거를 이어 붙인다 — 커서는
  `(created_at, write_seq)` 복합 keyset 이다. `created_at` 만으로는 fan-out 한 번에 수십 건이
  같은 타임스탬프를 갖는 이 테이블에서 페이지 경계가 이벤트를 통째로 건너뛴다.
  (미션 detail 응답 자체도 최신 N건만 싣는 bounded window 다 — 타임라인 섹션이 전체 이력을
  갖고 있다는 전제는 사실이 아니므로, 과거 접근 수단은 이 커서가 유일하다.)

`orchestration_update` 는 `consensus_update` 와 같은 **UI 전용** 이벤트다
(`filter: identity.type === 'user'`). 헤드라인(상태·카운트·마지막 이벤트)만 싣고,
상세는 클라이언트가 디바운스 후 REST 로 다시 당긴다. Agent 는 이 스트림을 소비하지
않으므로 agent-manager SSE contract 밖이다.

---

## 환경 변수

- `ORCHESTRATION_LEASE_GRACE_MS` — lease 만료 관측 후 새 attempt 를 띄우기까지의 유예 (기본 5분, 10초~1시간)

| 변수 | 기본 | 설명 |
| --- | --- | --- |
| `ORCHESTRATION_REAPER_ENABLED` | on | `false` 로 리퍼 비활성화 |
| `ORCHESTRATION_REAPER_SWEEP_MS` | 5m | 스윕 주기 (30s~1h clamp) |
| `ORCHESTRATION_PLANNING_TIMEOUT_MS` | 20m | 계획 미제출 재브리핑 간격 (1m~24h clamp) |
| `ORCHESTRATION_RUNNING_STALL_TIMEOUT_MS` | 20m | `running` + in-flight step 0개 재브리핑 간격 (1m~24h clamp) |

미션별 `step_timeout_minutes` (기본 90, `0` = 무제한)은 REST 로 조정한다.

---

## 트러블슈팅

**Mission 이 `planning` 에서 안 움직인다**
→ 오케스트레이터 Agent 가 online 인지(팀 화면의 점), agent-manager 가 붙어 있는지 확인.
리퍼가 20분마다 최대 2회 재브리핑 후 `failed` 로 떨군다. 즉시 재시도는 **Nudge**.

**Mission 이 `running` 인데 아무 step 도 안 움직인다**
→ 전 step 이 이미 terminal 인데 오케스트레이터가 `complete_orchestration_mission` 을 안 부른 경우다.
planning 과 동일하게 리퍼가 20분마다 최대 2회 재브리핑 후 `failed` 로 떨군다. 즉시 재시도는 **Nudge**.

**step 이 계속 `dispatched` 다**
→ subagent 가 `report_orchestration_step` 을 안 불렀다. step 룸을 열어(상세 → 룸)
subagent 출력을 확인. `step_timeout_minutes` 후 리퍼가 failed 로 만들고 오케스트레이터를 깨운다.

**전부 `pending` 인데 아무것도 안 나간다**
→ 대개 step 에 `assignee_agent_id` 가 없다. 이 경우 상태가 `ready` 로 남고 stalled
깨움이 오케스트레이터에게 미배정 키를 알려준다. 안 고쳐지면 Nudge 로 재배정을 지시.

**멤버가 남의 step 을 보고하려 한다**
→ 403. 정상이다. `list_my_orchestration_steps` 로 자기 배정을 확인시키면 된다.
