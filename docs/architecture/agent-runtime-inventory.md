# Agent 런타임 inventory

## 실행 경로 기준선

- Ticket one-shot: `EventDispatcher → SubagentManager → createAdapter → spawn → adapter parse/usage → dispatch ack`.
- Persistent chat/resume: `EventDispatcher → ChatSessionManager → BaseSessionManager → createAdapter → stdin/stdout session → outbox`.
- 제목 생성: `EventDispatcher → generateSessionTitle → Claude adapter/profile resolver → one-shot request`.
- Hermes: dispatcher가 `createRuntimeOwner`로 ACP process owner를 만들고 session store와 JSON-RPC peer를 사용한다.

상태·capacity·retry는 manager 계층, prompt/context와 profile은 dispatcher 및 `runtime-profiles`, MCP는 `mcp-client`, OS lifecycle은 spawn call site와 `process-tree`, provider error/usage는 `cli-error-signatures`와 `cli-usage-accumulator`에 분산돼 있다. 외부 SSE와 저장 세션 형식은 이번 전환에서 변경하지 않는다.

## 결합 및 중복 근거

기준 SHA `913bf6dc`에서 `event-dispatcher.ts` 4,704행, `base-session-manager.ts` 1,894행, `cli-adapters/base.ts` 742행이다. `runtime-registry.ts`는 descriptor map, `cli-adapters/index.ts`는 별도 provider switch를 가져 신규 provider마다 두 파일을 함께 고쳐야 했다. 이번 변경은 두 경로를 manifest registry로 수렴시켰다.

## 보존·이관·삭제 결정

- 보존: 외부 dispatcher/session API, adapter classes, runtime profile/effort/model chain, Hermes owner, error/usage parser. 기존 회귀 테스트의 계약 대상이다.
- 이관: descriptor, adapter factory, ACP owner factory를 composition registry로 통합했다. capability option 필터는 application 계층으로 이동했다.
- 삭제: 중앙 provider switch와 중복 descriptor map. `createAdapter` 및 registry 공개 함수가 대체하며 기존 adapter/runtime 테스트로 검증한다.
- 후속 추출 대상이지만 이번 삭제 대상 아님: process/session/telemetry의 큰 manager 구현. 참조가 광범위하고 외부 lifecycle을 보유하므로 테스트 없는 기계적 이동은 죽은 코드 제거 근거가 아니다.

## 테스트 매트릭스

- Claude/Codex/Antigravity/Pi: 각 adapter test가 argv, parse, usage, MCP, harness/profile 계약을 검증한다.
- Ticket/chat/session: `subagent-dedup`, `ticket-session-*`, `chat-*`, retry/silent-exit/circuit-breaker 테스트가 lifecycle을 검증한다.
- Hermes: `hermes-runtime`, `hermes-dispatch`, ACP client 테스트가 process/session 경로를 검증한다.
- 신규 계층: architecture boundary와 plugin registry contract가 역방향 의존, 중복 등록, open-closed fixture, 미지원 option 제거를 검증한다.
