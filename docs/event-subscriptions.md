# 세션·채팅 이벤트 구독

세션이나 채팅의 에이전트가 `subscribe_to_event`로 AWB 이벤트와 후속 지시를 등록한다. 구독은 즉시 반환한다. 현재 턴을 끝내면 서버가 조건에 맞는 이벤트를 받아 같은 세션/채팅에 새 프롬프트를 전달한다. 티켓은 만들지 않는다. CLI 종류나 Host가 달라도 같은 Account 안에서 동작한다.

예: Codex 세션에서 “다른 Host의 Claude 작업이 끝나면 결과를 검증해 줘”라고 요청한다. 에이전트는 `list_sessions`로 주소를 찾고 다음처럼 등록한다.

```json
{
  "event_type": "session.turn_completed",
  "source": {
    "manager_id": "<Claude가 실행 중인 Host UUID>",
    "cli": "claude",
    "session_id": "<Claude 네이티브 세션 ID>"
  },
  "prompt": "Claude가 완료한 변경을 확인하고 테스트를 실행해. 결과를 이 세션에 보고해."
}
```

이 호출의 수신자는 **호출한 Codex 세션 자신**이다. 채팅 runtime은 수신할 자신의 `room_id`도 넘긴다. 해당 방의 그 runtime 하나만 깨우며, 방에 자동 이벤트 메시지를 남긴다. 새 세션이나 새 방을 만들지 않는다. 네이티브 세션은 바쁜 동안 재시도하고, 닫혀 있으면 기존 실행 설정으로 다시 연다. 원래 진행 중인 작업에 steering을 보내거나 승인 질문에 답하지 않는다.

## 도구와 이벤트

- `list_event_types`: 이벤트 종류, 필수 주소, 선택 필터 안내.
- `subscribe_to_event`: 구독과 후속 지시 저장.
- `list_event_subscriptions`: 자신의 구독 100개와 최근 전달 200개. 채팅에서는 `room_id` 필요.
- `cancel_event_subscription`: 자신의 구독과 대기 전달 취소. 이미 제출된 프롬프트는 회수하지 않는다.

| 이벤트 | source의 필수 필드 | 선택 필터 | 의미 |
| --- | --- | --- | --- |
| `session.turn_completed` | `manager_id`, `cli`, `session_id` | `turn_id` | AWB가 연 네이티브 세션의 성공한 턴 종료 |
| `session.turn_failed` | 위와 같음 | `turn_id` | 실패 또는 취소로 턴 종료 |
| `ticket.changed` | `ticket_id` | `status`, `action` | 티켓·코멘트 activity. 예: `status: "done"`; 상태 이동은 `action: "moved"` |
| `chat.message` | `room_id` | `sender_type` (`user` / `agent`) | 일반 메시지. progress·system 알림·수신 runtime 자신의 응답 제외 |

모든 필터는 AND이며 정확히 일치해야 한다. 세션 이벤트는 **현재 턴이 끝났다**는 뜻이며, 프로젝트 전체 업무 완료를 뜻하지 않는다. AWB에 열리지 않은 외부 CLI의 실행 종료는 감시하지 않는다. 필요하면 `open_session`으로 먼저 연결한다. 이벤트에는 주소·턴 ID·종료 사유·상태 같은 메타데이터만 담으며, 전사·메시지 본문·자격 증명을 복제하지 않는다.

기본값은 1회(`max_triggers: 1`), 24시간 만료(`expires_in_seconds: 86400`)다. 반복은 최대 100회, 최대 7일이고, 같은 구독의 이벤트 간격은 기본 60초(`cooldown_seconds`, 최소 10초)다. 간격 안의 이벤트는 건너뛴다. Account당 활성 구독은 최대 200개다. 자기 세션의 종료로 자기 세션을 깨우는 구독은 거절한다.

일반 구독은 등록 시작 이후 관측한 이벤트만 받는다. 정확한 `turn_id`를 지정하면 보관 중인 그 턴의 완료 이벤트도 매칭하므로, 이미 끝났거나 등록 도중 끝나는 턴을 기다리는 경쟁을 피할 수 있다. 등록 뒤 작업을 시작하는 순서를 권장한다. 이벤트를 기다리는 동안 현재 턴을 계속 실행하거나 폴링할 필요는 없다.

## 권한과 전달 상태

DB의 full-scope Host 키로 연결된 네이티브 세션 또는 runtime 키로 연결된 채팅 에이전트만 등록·조회·취소한다. 수신 주소를 다른 세션/에이전트로 바꿀 수 없다. 원본과 수신 Host·티켓·방은 같은 Account여야 하며, 세션 이벤트에는 Account 소유자의 `agent_sessions.use` 권한이 필요하다. 채팅 원본은 호출 runtime이 참여한 방, 네이티브 호출이면 소유자가 참여한 방으로 제한한다. Host 소유권·참여·권한은 전달할 때도 확인한다. 관리자라는 이유로 다른 Account를 열람하거나 실행하지 않는다.

구독 상태는 `active` / `exhausted`(등록한 매칭 횟수를 모두 사용) / `cancelled` / `expired`다. `exhausted`여도 전달은 아직 대기 중일 수 있다. 별도의 전달 상태를 확인한다.

| 전달 상태 | 의미 |
| --- | --- |
| `pending` | 전달 대기 또는 재시도. `last_error`, `available_at` 확인 |
| `dispatching` | 워커가 lease를 잡고 전송 중 |
| `submitted` | 기존 세션 prompt / 채팅 dispatch 경로에 제출함. CLI 수신·작업 성공 확인은 아님 |
| `failed` | 권한 회수·대상 삭제 등 재시도하지 않는 실패 |
| `expired` / `cancelled` | 만료 / 취소로 전달 중지 |

일시적인 오프라인·busy·전송 오류는 만료까지 2초부터 최대 5분 간격으로 재시도한다. 이벤트·구독·전달 대기열은 DB에 있으며, 서버 재시작 뒤에도 처리한다. 같은 원본 이벤트는 고유 ID, 같은 구독/이벤트 쌍은 DB unique index로 중복 매칭을 막고, 워커 경쟁은 조건부 갱신과 트랜잭션으로 제어한다. 만료된 전송 lease는 복구한다. 기록은 최대 구독 기간보다 길게 14일 보관한 후 정리한다.

전송과 DB 완료 기록은 하나의 분산 트랜잭션이 아니다. 전송 직후 서버가 죽으면 재전달될 수 있다. 프롬프트에 포함한 **Delivery ID**를 확인해 배포 등 외부 부수효과를 중복 실행하지 않는다. 채팅 재전달은 같은 메시지 ID를 사용해 방 기록과 매니저의 중복 방지 경로를 재사용한다. 저장 이전의 서버 프로세스 장애나 AWB가 관측하지 못한 외부 이벤트까지 복구하는 보장은 없다.

자동 이벤트는 사용자 입력이나 새로운 승인으로 취급하지 않는다. operator 세션으로 전달된 턴도 자동 작업으로 표시해 사용자 승인 권한을 갖지 못하게 한다.

## 구현과 검증

- `modules/event-subscriptions/`: 이벤트 정규화, MCP 권한, 매칭, 만료, 전송 재시도.
- `WorkflowEvent`, `EventSubscription`, `EventDelivery`: SQLite/PostgreSQL 공통 엔티티; 이관 레지스트리에도 등록.
- 기존 `agent_session_request`와 `chat_request`를 사용한다. 새 SSE 이벤트나 CLI 전용 실행 분기는 없다. 채팅의 system 기록에는 기존 `dispatch_agent_ids`를 붙여 방 브로드캐스트로 다른 에이전트를 깨우지 않는다.
- `test/event-subscriptions.test.mjs`: 실제 MCP/HTTP, 서로 다른 Host·CLI, 일회성·반복·필터·등록 경쟁·동시 워커·재시작·오프라인·권한 회수·채팅 전달. SQLite와 PostgreSQL CI 양쪽에 등록한다. PostgreSQL 실행만 실제 병렬 트랜잭션 검증이다.
