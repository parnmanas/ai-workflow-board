# CLI 모듈 — LLM CLI 를 플러그인처럼 붙이는 구조

AWB 가 다루는 LLM CLI(Claude Code, Codex, OpenCode, Pi, Antigravity, DeepSeek, Hermes)는
세 앱에 걸쳐 **각각 하나의 선언**으로 존재한다. 소비자 코드는 CLI 이름을 비교하지
않고 그 선언을 조회한다.

| 앱 | 선언 위치 | 조회 API |
|---|---|---|
| agent-manager | `apps/agent-manager/src/lib/clis/<id>/index.ts` (`CliModule`) | `src/lib/clis/index.ts` — `cliModule()`, `findCliModule()`, `cliLogin()`, `cliSessions()`, `cliCredentials()`, `cliEffort()`, `cliDispatch()`, `cliModulesWith()` |
| server | `apps/server/src/common/cli-catalog.ts` (`CLI_CATALOG`, `CliDescriptor`) | `cliDescriptor()` + 파생 상수(`CLI_TYPES`, `EXECUTABLE_RUNTIMES`, `ACP_SESSION_CLIS`, `PROVIDER_FIELDS`, `EffortPresetSchema` …) |
| client | `apps/client/src/cli/catalog.ts` (`STATIC_CLI_CATALOG` + `GET /api/cli-catalog` 로 갱신) | `useCliCatalog()`, `cliLabel()`, `cliSupportsCredential()`, `cliEffortKeys()`, `cliLoginInfo()` … / 표현 전용은 `src/cli/presentation.ts` |

세 선언이 서로 어긋나면 테스트가 깨진다:
- `apps/agent-manager/test/cli-catalog-contract.test.mjs` — 매니저 모듈 ↔ 서버 카탈로그
- `apps/client/test/cli-catalog-contract.test.mjs` — 클라이언트 정적 미러 ↔ 서버 카탈로그
- `apps/agent-manager/test/cli-modules.test.mjs` — 모듈 선언 불변식 + 예전 손표와의 동치

## 왜 이렇게 나눴나

리팩토링 전에는 CLI 하나를 추가하려면 매니저 7~16개, 서버 7개, 클라이언트 14개 파일에
흩어진 `if (cli === 'claude')` 분기와 손으로 미러링한 표를 고쳐야 했다. 빠뜨린 분기는
컴파일 에러 없이 조용히 빠졌고(예: 서버 effort 스키마의 `.strict()` 가 새 CLI 의 preset
을 거부), 어느 표가 어느 표의 미러인지는 주석에만 적혀 있었다.

이제 **관심사별 슬라이스**를 CLI 가 선언하고, 슬라이스가 없으면 "그 기능을 지원하지
않는다"는 뜻이다. 소비자는 그 사실을 조용히 무시하지 않고 예전과 같은 오류 문구로
드러낸다.

## agent-manager: `CliModule`

`apps/agent-manager/src/lib/clis/cli-module.ts` 가 계약이다. 기존 런타임 플러그인
manifest(`RuntimePluginManifest` — id/transport/capabilities/어댑터 팩토리)의 **상위
집합**이라 같은 레지스트리(`runtime/composition/plugin-registry.ts`)에 그대로 등록된다.

| 슬라이스 | 담는 것 | 이걸 읽는 소비자 |
|---|---|---|
| (manifest) `createCliAdapter` / `createOwner` | spawn argv, stdout 파싱, cli-home 준비, `listModels`, `cliUpdate`/`updatePackage`(설치·업데이트), `configDirEnv`/`authEnvKeys`, 권한 등급, trust — **어댑터 클래스** (`cli-adapters/<id>.ts`) | subagent/base-session manager, cli-update, cli-latest, available-models, runtime-health |
| `binary` | 실행 파일 이름, well-known 설치 경로(unix/windows), 빌려 쓰는 CLI(`borrowsFrom`), `delegation.<key>` override, 부팅 버전 프로브 | `cli-resolver.ts`(등록은 `clis/builtin.ts` 가 함), `main.ts` 부팅 프로브 |
| `credentials` | provider 접두어, provider 별 필드/필수 필드/하트비트 kind | `agent-manager-commands.ts`(spawn 시 필수 필드 검사, `credentialKind`), `agent-session-runner.ts` |
| `login` | device-auth 로그인: 격리 홈 spawn 계획, stdout 줄 파서(URL/코드), 수확 파일 → credential 필드 | `cli-login.ts` |
| `sessions` | Agent Session: PATH 감지, ACP 명령, 운영자 홈, 기록 링크 디렉터리, env 보정, backend profile 지원, 기록 스캐너(`store`) | `agent-session-runner.ts`, `agent-session-store.ts`, `runtime/runtime-health.ts`(ACP 런타임 프로브) |
| `effort` | preset 슬라이스 키와 표현 가능한 키(`model`/`effort`/`ultracode`) | `clis/effort.ts` → spawn 사이트, `event-dispatcher.ts` preset 파서 |
| `dispatch` | 게이트 플래그: `ticketDispatch: 'blocked'`(pi), `inlineImages`(claude), `pluginUpdates`(claude), `cliHomePrepFatal`(codex), `runtimeProfile`(claude), `scanStderrForTools`(pi) | event-dispatcher, chat-session-manager, agent-manager-commands, subagent/base-session manager, launch-spec |
| `listProfiles` | 이름 붙은 프로필 열거(hermes) | runtime-health → 하트비트 `runtime_capabilities.<id>.profiles` |

규칙:
- `clis/<id>/index.ts` 는 어댑터 클래스를 **import** 한다(반대는 금지 — 어댑터는 `cli-resolver`, `self-path` 같은 leaf 만 본다).
- `cli-resolver.ts` 와 `agent-session-history.ts` 는 leaf 다. CLI 이름을 모르고, `clis/` 를 import 하지 않는다. 바이너리 표는 `clis/builtin.ts` 가 로드될 때 `registerCliBinarySpec()` 으로 넘긴다.
- 기본값이 필요하면 `constants.ts` 의 `DEFAULT_CLI_ID` 를 쓴다. "이 빌드가 아는 CLI 목록"은 `KNOWN_CLI_IDS`(레지스트리) 하나다.
- `transport: 'acp'` 런타임(hermes)은 CLI 어댑터 spawn 경로 대신 `RuntimeSupervisor` 가 맡는다 — 소비자는 `isAcpRuntime(cli)` 로 판정한다.

## server: `CliDescriptor`

`cli-catalog.ts` 의 한 항목이 CLI 하나다. 여기서 파생되는 것:

- `cli-types.ts` → `CLI_TYPES`, `CliType`, `ALLOWED_CLI_TYPES`
- `runtime-config.ts` → `EXECUTABLE_RUNTIMES`, `COLLABORATION`
- `effort-presets.ts` → `EffortPresetSchema`(effort 를 선언한 CLI 마다 `.strict()` 블록 하나)
- `types/agent-sessions.ts` → `ACP_SESSION_CLIS`; `agent-sessions.service.ts` → `SESSION_CLI_CREDENTIAL_PREFIX`, `BACKEND_PROFILE_CLIS`
- `credential-providers.ts` → `PROVIDER_FIELDS`, `REVEALABLE_OAUTH_FIELDS`(비-CLI provider github/gitlab/openai/custom 는 그 파일의 손표)
- `cli-login-session.service.ts` → `CLI_PROVIDER`, `PROVIDER_SCOPED_CLIS`, `REQUIRED_FIELD`
- `credential-fields.ts` → `MULTILINE_CREDENTIAL_FIELDS`
- `orchestration-member-spec.ts` → `TEAM_SLOT_CLIS`, CLI 변경 시 `runtime_config` 정리 규칙

`GET /api/cli-catalog` 가 로그인한 사용자에게 `{ clis: CliDescriptor[] }` 를 준다.

## client

`src/cli/catalog.ts` 는 서버와 같은 `CliDescriptor` 를 정적 미러로 갖고, 로그인 뒤
`loadCliCatalog()` 가 서버 값으로 바꿔 끼운다(`useSyncExternalStore`). 색·약어·빈
credential 안내문처럼 **표현만** 다루는 값은 `src/cli/presentation.ts` 에 두고 모르는 id
에는 중립 기본값을 준다 — 서버가 새 CLI 를 내려보내면 클라이언트 수정 없이도 picker,
credential 폼, 로그인 화면, effort 편집기가 그 CLI 를 그린다.

## 새 CLI 추가

절차는 [runbooks/cli-module-wiring.md](runbooks/cli-module-wiring.md).
