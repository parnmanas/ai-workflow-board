# 새 LLM CLI 붙이기

**When:** AWB 가 새 코딩 CLI(예: `gemini`)를 Runtime Host 에서 spawn 하고, credential 을
묶고, Agent Session 을 열고, 로그인 자동화를 지원해야 할 때. 배경은
[docs/cli-modules.md](../cli-modules.md).

원칙: **앱마다 선언 하나.** 아래 3+1 곳 외의 파일에 CLI 이름을 새로 적었다면 설계를
우회한 것이다 — 그 값은 슬라이스로 옮겨라.

## 1. agent-manager — `src/lib/clis/<id>/`

1. 어댑터: `src/lib/cli-adapters/<id>.ts` 에 `CliAdapter` 구현(spawn argv, stdout 파싱,
   `prepareCliHome`, `listModels`, `cliUpdate`/`updatePackage`, `configDirEnv`,
   `authEnvKeys`, `permissionCapabilities`). 기존 `codex.ts`(one-shot) / `claude.ts`
   (persistent) 를 본보기로.
2. 모듈: `src/lib/clis/<id>/index.ts` 에 `defineCliModule({...})`. `clis/claude/index.ts`
   가 참조 구현이다. 슬라이스는 **지원하는 것만** 쓴다:
   - `binary` — 실행 파일 이름 + well-known 경로. 없으면 PATH 와 표준 bin 디렉터리만 본다.
   - `credentials` — prefix 는 반드시 `<id>_`; provider id 도 그 접두어. 없으면 "credential 개념 없음"(pi).
   - `login` — `clis/<id>/login.ts` 에 `plan`/`createLineParser`/`harvest`. `harvestProvider` 는 위 provider 중 하나.
   - `sessions` — `detect`/`resolveAcpCommand`/`operatorHome`(+ `storeSubdir`, `adjustEnv`, `supportsBackendProfile`, `store`). 기록 스캐너는 `clis/<id>/sessions.ts` 에 `CliSessionStoreDriver` 로 — 공용 헬퍼는 `agent-session-history.ts`.
   - `effort` — `keys` 와(빌려 쓰면) `sliceKey`.
   - `dispatch` — 필요한 게이트 플래그만.
3. 등록: `src/lib/clis/builtin.ts` 의 `BUILTIN_CLI_MODULES` 에 한 줄.
4. 테스트: `test/<id>-adapter.test.mjs`(기존 5개 어댑터 테스트 참고). `test/cli-modules.test.mjs`
   의 id 목록·표 단언을 갱신한다 — 그 테스트가 "여기 하나 더 적으라" 고 알려 준다.

**손대지 않는 파일**: `cli-login.ts`, `agent-session-runner.ts`, `agent-session-store.ts`,
`cli-resolver.ts`, `agent-manager-commands.ts`, `event-dispatcher.ts`, `main.ts`,
`runtime/composition/builtin-plugins.ts`, `constants.ts`.

## 2. server — `src/common/cli-catalog.ts`

`CLI_CATALOG` 배열에 `CliDescriptor` 하나를 추가한다. 매니저 모듈과 같은 사실을 적는다
(transport, credential provider 의 id/fields/required, login harvest provider, sessions.acp,
effort keys). 모듈 로드 시 `validateCliCatalog()` 가 접두어·필드 불변식을 검사한다.

그 외 서버 파일은 건드리지 않는다 — zod 스키마, provider 표, 세션/로그인 표가 전부 파생이다.
`test/cli-catalog.test.mjs` 의 고정 집합(`CLI_TYPES` 목록 등)을 갱신한다.

## 3. client — `src/cli/catalog.ts`

`STATIC_CLI_CATALOG` 에 서버와 **동일한** 항목을 추가한다(`test/cli-catalog-contract.test.mjs`
가 deep-equal 로 강제). 색·약어·credential 안내문을 주고 싶으면 `src/cli/presentation.ts`
— 생략하면 중립 기본값으로 그려진다.

## 4. 확인

```
npm run build                              # 루트 — 세 앱 모두
cd apps/agent-manager && npm test          # cli-modules / cli-catalog-contract 포함
cd apps/server && node test/run-suite.mjs test/cli-catalog.test.mjs test/cli-login-session.test.mjs test/agent-sessions.test.mjs
cd apps/client && npm test
```

세 contract 테스트가 모두 녹색이면 세 앱이 같은 CLI 를 같은 모양으로 본다. SSE
payload 자체(`agent_trigger`, `agent_session_request` …)는 바뀌지 않았으므로
agent-manager 와 서버를 같은 PR 로 묶는 규칙은 그대로다(AGENTS.md → Agent Manager sync).
