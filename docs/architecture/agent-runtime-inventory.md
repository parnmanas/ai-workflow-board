# Agent 런타임 inventory

## 실행 경로 기준선

- Ticket one-shot: `EventDispatcher → SubagentManager → RuntimeAdapterResolver → RuntimeExecutionFacade → capability 협상 → plugin adapter argv → spawn → parse/usage → dispatch ack`.
- Persistent chat/resume: `EventDispatcher → ChatSessionManager → BaseSessionManager → RuntimeAdapterResolver → RuntimeExecutionFacade → capability 협상 → session argv → stdin/stdout → outbox`.
- 제목 생성: `EventDispatcher → generateSessionTitle → SubagentManager → 동일 one-shot facade → Claude adapter/profile request`.
- Hermes: dispatcher가 `createRuntimeOwner`로 ACP process owner를 만들고 session store와 JSON-RPC peer를 사용한다.

상태·capacity는 manager 계층, profile은 `runtime-profiles`, MCP 설정 파일 생성과 credential header 구성은 manager infrastructure, OS 종료 정리는 spawn lifecycle과 `process-tree`, provider usage는 `cli-usage-accumulator`가 담당한다. 최종 prompt/session id/MCP 경로 변환과 process spawn, error normalization/retry 승인만 runtime port 경계로 수렴했다. 외부 SSE와 저장 세션 형식은 이번 전환에서 변경하지 않는다.

## 결합 및 중복 근거

기준 SHA `913bf6dc`에서 `event-dispatcher.ts` 4,704행, `base-session-manager.ts` 1,894행, `cli-adapters/base.ts` 742행이다. `runtime-registry.ts`는 descriptor map, `cli-adapters/index.ts`는 별도 provider switch를 가져 신규 provider마다 두 파일을 함께 고쳐야 했다. 이번 변경은 두 경로를 manifest registry로 수렴시켰다.

## 보존·이관·삭제 결정

- 보존: 외부 dispatcher/session API와 저장 형식, provider adapter의 argv·parse 구현, runtime profile/model chain 및 Hermes wire protocol은 기존 회귀 계약 때문에 유지한다. 이들은 코어 구현이 아니라 port 뒤 infrastructure 구현이다.
- 이관: descriptor, CLI adapter·ACP owner·LLM provider factory를 composition registry로 통합했다. `RuntimeExecutionFacade`가 production one-shot·persistent·resume·control 및 LLM 요청을 ports로 받아 capability를 협상한 뒤 최종 adapter argv/body builder를 호출한다. prompt port의 문자열, session port의 id, tool port의 MCP 경로가 실제 normalized request를 다시 구성하고 최종 argv/body를 바꾸며, 변환 뒤 capability를 재협상한다. 실행 소유자별 adapter 수명·캐시는 `RuntimeAdapterResolver` 하나로 통합했다. 두 manager의 spawn은 process port를 통과하고, one-shot/persistent 모델 fallback과 LLM `complete()`는 같은 error normalization/retry policy를 사용한다. application/domain에는 Node process, SDK, provider 환경변수·argv import가 없다.
- 삭제: 중앙 provider switch와 중복 descriptor map, manager별 adapter cache 구현, dispatcher↔subagent 런타임 순환 의존. `mentionTriggerId`를 독립 모듈로 옮겨 실제 전체 import graph의 순환을 제거했다.
- 예외: process/session manager의 외부 공개 class 이름과 MCP config tempfile 생성은 lifecycle·attribution 호환을 위해 infrastructure에 유지한다. 다만 생성된 경로는 tool port 산출물로 facade에 다시 들어가 최종 argv를 구동하며, provider 선택·요청 협상·argv 생성·재시도 승인에 별도 우회 경로는 없다.

## 테스트 매트릭스

- Claude/Codex/Antigravity/Pi: 각 adapter test가 argv, parse, usage, MCP, harness/profile 계약을 검증한다.
- Ticket/chat/session: `subagent-dedup`, `ticket-session-*`, `chat-*`, retry/silent-exit/circuit-breaker 테스트가 lifecycle을 검증한다.
- Hermes: `hermes-runtime`, `hermes-dispatch`, ACP client 테스트가 process/session 경로를 검증한다.
- 신규 계층: architecture boundary는 역방향 의존, 실제 import graph 순환, adapter 간 결합을 검사한다. plugin registry contract는 주입한 prompt/session/tool 산출물이 one-shot·persistent·resume·title의 최종 argv를 바꾸는지, error/retry policy가 두 번째 provider 실행을 실제 구동하는지, 중복 등록, CLI·LLM open-closed fixture, owner별 adapter 수명, 미지원 option 제거를 동적으로 검증한다.
