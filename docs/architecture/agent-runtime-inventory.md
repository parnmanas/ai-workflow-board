# Agent 런타임 inventory

## 실행 경로 기준선

- Ticket one-shot: `EventDispatcher → SubagentManager → RuntimeAdapterResolver → RuntimeExecutionFacade → capability 협상 → plugin adapter argv → spawn → parse/usage → dispatch ack`.
- Persistent chat/resume: `EventDispatcher → ChatSessionManager → BaseSessionManager → RuntimeAdapterResolver → RuntimeExecutionFacade → capability 협상 → session argv → stdin/stdout → outbox`.
- 제목 생성: `EventDispatcher → generateSessionTitle → SubagentManager → 동일 one-shot facade → Claude adapter/profile request`.
- Hermes: dispatcher가 `createRuntimeOwner`로 ACP process owner를 만들고 session store와 JSON-RPC peer를 사용한다.

상태·capacity·retry는 manager 계층, prompt/context와 profile은 dispatcher 및 `runtime-profiles`, MCP는 `mcp-client`, OS lifecycle은 spawn call site와 `process-tree`, provider error/usage는 `cli-error-signatures`와 `cli-usage-accumulator`에 분산돼 있다. 외부 SSE와 저장 세션 형식은 이번 전환에서 변경하지 않는다.

## 결합 및 중복 근거

기준 SHA `913bf6dc`에서 `event-dispatcher.ts` 4,704행, `base-session-manager.ts` 1,894행, `cli-adapters/base.ts` 742행이다. `runtime-registry.ts`는 descriptor map, `cli-adapters/index.ts`는 별도 provider switch를 가져 신규 provider마다 두 파일을 함께 고쳐야 했다. 이번 변경은 두 경로를 manifest registry로 수렴시켰다.

## 보존·이관·삭제 결정

- 보존: 외부 dispatcher/session API와 저장 형식, provider adapter의 argv·parse 구현, runtime profile/model chain 및 Hermes wire protocol은 기존 회귀 계약 때문에 유지한다. 이들은 코어 구현이 아니라 port 뒤 infrastructure 구현이다.
- 이관: descriptor, CLI adapter·ACP owner·LLM provider factory를 composition registry로 통합했다. `RuntimeExecutionFacade`가 production one-shot·persistent·resume·control 및 LLM 요청을 ports로 받아 capability를 협상한 뒤 최종 adapter argv/body builder를 호출한다. 실행 소유자별 adapter 수명·캐시는 `RuntimeAdapterResolver` 하나로 통합했다. session/prompt/tool/process/retry/telemetry 구현은 `RuntimeInfrastructurePorts`로 실제 주입되며 두 manager의 spawn은 process port를 통과한다. application/domain에는 Node process, SDK, provider 환경변수·argv import가 없다.
- 삭제: 중앙 provider switch와 중복 descriptor map, manager별 adapter cache 구현, dispatcher↔subagent 런타임 순환 의존. `mentionTriggerId`를 독립 모듈로 옮겨 실제 전체 import graph의 순환을 제거했다.
- 예외: process/session manager의 외부 공개 class 이름은 API 호환을 위해 유지하지만, provider 선택·요청 협상·argv 생성 책임은 facade/port로 제거했다. 얇은 공개 export 외 별도 실행 shim이나 이중 provider 경로는 없다.

## 테스트 매트릭스

- Claude/Codex/Antigravity/Pi: 각 adapter test가 argv, parse, usage, MCP, harness/profile 계약을 검증한다.
- Ticket/chat/session: `subagent-dedup`, `ticket-session-*`, `chat-*`, retry/silent-exit/circuit-breaker 테스트가 lifecycle을 검증한다.
- Hermes: `hermes-runtime`, `hermes-dispatch`, ACP client 테스트가 process/session 경로를 검증한다.
- 신규 계층: architecture boundary와 plugin registry contract가 역방향 의존, 실제 import graph 순환, adapter 간 결합, production port 사용, 중복 등록, CLI·LLM open-closed fixture, owner별 adapter 수명, 미지원 option 제거를 검증한다.
