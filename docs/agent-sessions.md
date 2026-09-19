# Agent Sessions (CLI 직접 세션)

Runtime Host 장비에 있는 CLI(Claude Code / Codex / Hermes)의 세션을 AWB 화면에서 직접 모는 표면이다.
세션의 단위는 **(Runtime Host, CLI, CLI 네이티브 세션 id)** 이고, **AWB 는 세션 내용을 저장하지 않는다.**
Claude Code 는 `~/.claude/projects/<cwd>/<id>.jsonl`, Codex 는 `~/.codex/sessions/…/rollout-*.jsonl` 에
전문을 이미 갖고 있으므로, 서버는 매니저에게 reverse RPC 로 "이 장비의 이 CLI 에 어떤 세션이 있는가 /
이 세션의 기록은 무엇인가" 를 묻고, 살아 있는 턴의 스트림만 브라우저로 중계한다. 그 장비에서 터미널로
쓰던 기존 세션도 그대로 목록에 뜨고 이어서 쓸 수 있다.

기존 Chat(ChatRoom) 과는 별개의 기능이며, chat 모드의 기본 랜딩이 `/ws/:wsId/sessions` 다.

## 왜 Chat 을 개편하지 않고 따로 두는가

| | Chat (ChatRoom) | Agent Session |
|---|---|---|
| 단위 | 방(room) — DM/그룹 + Action/QA/Mission run 방 등 9종이 한 엔티티에 다중화 | (Runtime Host, CLI, 네이티브 세션 id) |
| 저장 | AWB DB (chat_room_messages) | 없음 — CLI 홈의 세션 파일이 원본 |
| 에이전트 답변 | `send_chat_room_message` MCP 툴 호출로만 | ACP 스트림(text/tool/permission) 그대로 |
| 프롬프트 | 매 턴 보드 정책 프롬프트로 래핑, DB 히스토리를 재조립 | 사용자 텍스트가 그대로 `session/prompt` |
| 실행 identity | AWB Agent(격리 cli-home, per-agent 키) | 장비 운영자의 CLI 홈 그대로 |
| 권한 | CLI 어댑터는 사전 결정(tier) | `session/request_permission` 을 사용자에게 릴레이 |
| 의존 모듈 | 16개 모듈이 dispatch 버스로 재사용 | 없음 — 독립 모듈 |

## 이름 규약 (헷갈리지 않게)

| 계층 | Chat | Session |
|---|---|---|
| 엔티티 | `ChatRoom` / `ChatRoomMessage` / `ChatRoomParticipant` | 없음 (메모리 라이브 상태만) |
| 서버 모듈 | `modules/chat-rooms` | `modules/agent-sessions` |
| 사용자 REST | `/api/chat-rooms/*` | `/api/agent-sessions/hosts/:managerId/:cli/sessions[/:id/...]` |
| agent-manager REST | `/api/agent/chat-rooms/*` | `/api/agent/sessions/rpc/:requestId`, `/api/agent/sessions/:managerId/:cli/:id[/events]` |
| SSE | `chat_request`, `chat_room_message`, … | `agent_session_request`(→manager, scope=manager_id), `agent_session_update` / `agent_session_event`(→driver UI) |
| 권한 | `chat.view` / `chat.send` | `agent_sessions.use` (기본 admin 전용) |
| 클라이언트 | `components/chat/*`, `/ws/:wsId/chat/:roomId` | `components/sessions/*`, `/ws/:wsId/sessions/:managerId/:cli/:id` |
| 사이드바 | "Chat" 섹션 | "Sessions" 섹션 (Chat 위) — 행은 Runtime Host × CLI |
| manager | `chat-session-manager.ts` | `agent-session-runner.ts` + `agent-session-store.ts` |

## 구성 요소

- **서버 `modules/agent-sessions`** — 상태 없는 중계자. `InstanceRegistryService`(하트비트)에서 살아 있는
  Runtime Host 와 그 장비의 세션 CLI(`acp_session_clis`)를 읽고, list/history/open 은 `agent_session_request{request_id}`
  → `POST /api/agent/sessions/rpc/:id` 로 왕복한다(fs-browser 와 같은 패턴, 타임아웃 list 20s / history 40s / open 120s).
  라이브 상태(status/mode/driver)만 메모리에 두고, 매니저가 중계한 이벤트를 driver(마지막으로 open/prompt 한 사용자)에게
  SSE 로 흘린다. 다른 매니저 키는 남의 RPC 를 풀거나 이벤트를 중계할 수 없다.
- **매니저 `agent-session-store.ts`** — CLI 홈 리더. Claude: `projects/*/*.jsonl` (`agent-*.jsonl` 서브에이전트 파일과
  프롬프트 없는 빈 세션 제외, `custom-title` 우선, sidechain 행 제외). Codex: `sessions/**/rollout-*.jsonl`
  (`session_meta` → id/cwd, developer/environment_context 메시지는 제목에서 제외). 기록은 같은 파일을 트랜스크립트
  이벤트(`user_prompt / text / reasoning / tool_call / tool_update / turn`)로 접는다. Hermes 는 AWB 가 만든 세션만
  로컬 인덱스(`$AWB_AGENT_MANAGER_HOME/agent-sessions.json`)로 기억한다.
- **매니저 `agent-session-runner.ts`** — 세션당 ACP 어댑터 프로세스. 명령 우선순위: env `AWB_ACP_COMMAND_<CLI>` →
  PATH 의 `claude-agent-acp` / `codex-acp` / `hermes-acp` → `npx --yes @agentclientprotocol/claude-agent-acp` /
  `@agentclientprotocol/codex-acp`. **어댑터는 두 패키지 모두 `@agentclientprotocol/*`** — zed-industries 의 codex-acp 는
  2026-07 에 archive 됐고 옛 Codex 코어(rust-v0.137)라 새 모델을 "requires a newer version of Codex" 로 거부한다.
  `@agentclientprotocol/codex-acp` 는 설치된 codex CLI 와 같은 세대의 `@openai/codex` 를 번들한다. 장비에는
  `npm i -g @agentclientprotocol/codex-acp @agentclientprotocol/claude-agent-acp` 로 미리 설치해 둔다(npx 폴백은 첫 실행이 느리다).
  env 는 매니저 프로세스 그대로(운영자 CLI 홈), AWB MCP 서버는 매니저 키로 주입. codex 에는 `NO_BROWSER=1` 을 더해
  브라우저 로그인 auth method 를 숨긴다. `session/new`/`load` 가 auth required(-32000) 로 거부되면 환경에 API 키가 있을 때
  api-key 계열 ACP `authenticate` 를 한 번 시도하고, 아니면 "장비에서 `<cli> login` 하거나 credential 을 묶으라" 는 오류를 낸다.
  기존 세션은 `session/load`(cwd 는 기록에서), 새 세션은 `session/new`. load 재생분은 버린다(UI 가 history 로 이미 가짐).
  유휴 30분(`config.agent_sessions.idle_minutes`) 또는 close 로 프로세스 회수 → 상태 idle/closed, 다음 prompt 가 다시 연다.
- **클라이언트 `components/sessions`** — 호스트 목록 → 호스트×CLI 세션 목록(장비의 기록) → 트랜스크립트(history + 라이브
  스트림) + 컴포저. 권한 카드 버튼이 `POST …/permission` 을 부른다. 라이브 행은 도착 순서로 붙이고 id 로만 중복을 거른다.

## 상호작용 (모델 선택 · slash command · 질문/폼 · plan)

ACP 가 규정한 상호작용을 그대로 옮긴다 — AWB 가 CLI 별 모델 목록이나 명령을 하드코딩하지 않고 **어댑터가 알려 준 것**을 보여 준다.

| ACP | AWB 상태/이벤트 | 사용자 조작 |
|---|---|---|
| `session/new`·`load` 응답의 `configOptions`, `config_option_update` | 스냅샷 `config_options[]` (`config_id, name, category, type: select\|boolean, current_value, options[]`) | 헤더의 셀렉트/체크박스 → `POST …/config-option {config_id, value}` → op `set_config_option` → `session/set_config_option` → 어댑터가 준 전체 목록으로 갱신 + system 행 |
| `available_commands_update` | 스냅샷 `available_commands[]` (`name, description, input_hint?`) | 컴포저에서 `/` 를 치면 자동완성(↑/↓, Enter/Tab 선택, Esc). 선택은 텍스트만 채우고 전송하지 않는다. 명령은 프롬프트 텍스트로 그대로 간다 |
| `session/request_permission` (`title`/`description`/`toolCall`, claude 의 `_meta.permission`) | `permission_request` 행 + `awaiting_permission` | 권한 카드 → `POST …/permission` |
| `elicitation/create` (form: JSON Schema, url) — claude 의 AskUserQuestion 등 | `elicitation_request` 행 + **`awaiting_input`** (form 만). url 은 링크 카드만 남기고 바로 accept, 완료는 `elicitation/complete` → `elicitation_decision{decided_by:'agent'}` | 폼 카드(문자열/숫자/불리언/단일·다중 선택, required 검사) → `POST …/elicitation {elicitation_id, action: accept\|decline\|cancel, content}` → op `elicitation` |
| `plan` / `plan_update` | `plan` 행(`entries[{content, priority, status}]`) — 같은 turn 의 최신 것이 이전 것을 대체 | 체크리스트 카드 |
| `session_info_update` | 제목 패치 | — |

client capabilities 로 `elicitation: {form, url}`, `session.configOptions.boolean`, `plan` 을 광고하므로 어댑터가 이 기능을 켠다.
config option 의 id 키는 어댑터 세대에 따라 `id`(SDK 1.x 스키마 — codex-acp 1.12, claude-agent-acp 0.79 실측) 또는
`configId`(v2 초안) 로 오므로 매니저는 둘 다 받는다(요청 `session/set_config_option` 은 항상 `configId`).
설정 변경(`set_config_option` / `set_mode`)은 프로세스가 없는 세션에도 된다 — 서버가 `starting` 으로 올리고 매니저가
prompt 와 같은 경로로 먼저 연 뒤 적용하므로 **첫 프롬프트 전에 모델·approval 모드를 고를 수 있다**. 턴 중·대기 중에는 409.
설정 목록 자체는 어댑터가 살아 있어야 오므로, 세션 페이지에 들어오면 `idle` 세션은 자동으로 한 번 연결한다(`POST …/sessions
{session_id}` → session/load, 터미널의 `--resume` 과 같다). `closed`/`error` 는 헤더의 Connect/Reconnect 버튼으로만 다시 연다.

codex-acp 1.12 실측(rolf): `session/new` 가 modes(read-only / agent / agent-full-access) 와 config options
Mode·Collaboration mode(default/plan)·Model(gpt-5.6-sol, gpt-6-astra, …)·Reasoning effort·Fast mode 를 준다. approval 은
`session/request_permission` 으로 온다(예: plan 확정 "Implement this plan?" 의 implement_plan/revise_plan). 질문은
Collaboration mode 가 plan 일 때 `elicitation/create` 폼(oneOf 선택지 + 메모)으로 온다. read-only 모드에서도 작업 폴더 안의
쓰기는 codex 샌드박스가 그냥 허용하므로 approval 이 뜨지 않는 게 codex 의 동작이다.
`awaiting_input` 은 `awaiting_permission` 과 같은 대기 상태다: prompt 는 409 `session_busy`, 유령 되돌림 대상, 프로세스 종료·close 때
미결 질문은 `elicitation_decision{action:'cancel', decided_by:'system'}` 으로 닫히고, history RPC 가 미결 질문을 같은 id 로 다시 실어 보낸다.

## CLI 설정 (credential 바인딩)

Runtime Host × CLI 마다 **어떤 워크스페이스 Credential(Settings → Credentials)로 인증할지** 를 정한다
(`agent_session_cli_settings`, `GET/PUT /api/agent-sessions/hosts/:managerId/:cli/settings`, 화면은 호스트 세션
목록의 "CLI settings"). 비워 두면 장비 운영자의 CLI 로그인(`claude login` / `codex login`)을 그대로 쓴다.

- 후보는 워크스페이스 + global credential 중 provider 접두어가 CLI 와 맞는 것(`claude_*`, `codex_*`) — agents 화면의
  `CLI_TO_CREDENTIAL_PREFIX` 와 같은 규약. 불일치는 400, 다른 워크스페이스 것은 404, hermes 는 아직 미지원(409).
- 매니저는 open/prompt 요청에 실린 `credential_id` 로 `GET /api/agent/sessions/credential/:id?workspace_id=` 를 부른다.
  서버는 **그 매니저에 바인딩된 credential 만** 복호화해 준다(다른 매니저 키, 바인딩 없는 credential → 403).
- 적용 방식: 운영자 홈의 로그인 파일은 절대 건드리지 않는다. credential 이 묶이면
  `$AWB_AGENT_MANAGER_HOME/session-homes/<cli>/<credential_id>` 를 세션 전용 cli-home 으로 만들고, 기존 어댑터
  `prepareCliHome` 이 자격증명 파일(`.credentials.json` / `auth.json`) 또는 env(`CLAUDE_CODE_OAUTH_TOKEN`,
  `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`)를 만든다. `CLAUDE_CONFIG_DIR` / `CODEX_HOME` 을 그 홈으로 돌리고, 운영자
  셸의 API 키(`authEnvKeys`)는 걷어내며, 워크스페이스 trust 를 시드한다. **기록 디렉터리만**(`projects` / `sessions`)
  운영자 홈으로 심볼릭 링크해 장비의 기존 세션이 그대로 보이고 이어진다.
- 권장 credential 은 `claude_oauth_token`(`claude setup-token`, 1년, 회전 없음). `claude_subscription` 은 회전하는
  토큰이라 여러 장비에서 쓰면 재로그인이 잦다(docs/managed-agent-relogin.md).

## 상태

`idle`(프로세스 없음) → `starting` → `ready` ⇄ `busy` ⇄ `awaiting_permission` / `awaiting_input`; `error`(last_error); `closed`(사용자가 멈춤).
idle / closed / error 에서 prompt 하면 매니저가 다시 연다. 진행 중(busy / awaiting_* / starting)에는 409 `session_busy`.
상수는 `apps/server/src/common/types/agent-sessions.ts` 가 단일 원천이다.

**진실은 매니저 쪽 프로세스다.** 서버 메모리의 상태는 매니저의 마지막 상태 패치에 의존하는데, 매니저가
self-update·SIGTERM 으로 재시작하면(systemd 는 cgroup 전체에 신호를 보내 세션 프로세스가 먼저 죽는다) 그 패치가
오지 못해 목록에 "Needs your approval" 유령이 남고 prompt 가 409 로 막히던 문제가 있었다. 그래서:

- `list` RPC 답의 세션별 `live_status`, `history` RPC 답의 `live`(프로세스가 없으면 `null`)로 서버가 메모리를 **되맞춘다**.
  매니저가 "없다" 고 하면 진행 중 상태는 idle 로 — `starting` 만은 open RPC 타임아웃(120s) 동안 지킨다.
- 매니저 인스턴스가 사라지면(`agent_instance_update` action=removed, 같은 identity 의 다른 인스턴스 없음) 그 장비의 진행 중
  세션을 모두 idle 로 되돌리고 driver 에게 `agent_session_update{reason:'host_offline'}` 를 보낸다.
- **하트비트가 살아 있는 세션 전체를 싣는다** (`agent_sessions: [{cli, session_id, status}]`, 매니저 `InstanceMeta.agentSessionsProvider`
  → `AgentSessionRunner.liveStates()`). 서버는 매 하트비트(30초)마다 그 목록으로 메모리를 맞춘다 — 보고된 세션은 그 상태로,
  보고에 없는 진행 중 세션은 idle 로(`reason:'heartbeat'`). 매니저 업데이트·재부팅·연결 단절·프로세스 사망 어느 경우든 30초
  안에 화면이 실제와 같아진다. 비어 있어도 `[]` 를 보내는 이유가 이것이다(구버전 매니저는 필드가 없어 아무것도 바꾸지 않는다).
- 서버가 처음 보는 세션에 매니저가 먼저 이벤트를 보내면(서버 재시작 뒤) 상태를 배치에서 읽는다 — 패치가 있으면 그것,
  턴 중에만 나오는 행(text/tool/permission …)이 있으면 busy, system 행뿐이면 idle. 예전엔 무조건 busy 로 심었다.
- 사이드바·호스트 목록은 driver 전용 `agent_session_update` 로 행을 고치고, 매니저 인스턴스가 등록/제거되면 그 장비 목록을 다시 묻는다.
- 매니저는 프로세스가 죽으면 턴 중이었어도 무조건 `status: idle` 을 보내고, 미결 permission 은
  `permission_decision{outcome:'cancelled', decided_by:'system'}` 로 닫는다(close 도 같다). `stopAll` 은 이미 죽은
  세션의 마지막 전송을 최대 3s 기다린다.
- 미결 permission 요청은 CLI 홈 파일에 없으므로(SSE 로만 흘렀다) `history` RPC 가 기록 끝에 **같은 id** 로 다시 실어 보낸다.
  화면은 "승인 대기" 인데 카드가 없으면 한 번 다시 읽고(`SessionView`), 매니저 답에 따라 카드가 생기거나 idle 이 된다.
- 새 세션 모달은 **열릴 때만** 기본 호스트/CLI/cwd 를 채운다. `hosts` 는 매니저 하트비트마다 새 배열로 내려오므로 그것을
  초기화 트리거로 쓰면 사용자가 고르던 호스트·cwd·제목이 30초 간격으로 되돌아간다(`new-session-modal-host-refresh.test.mjs`).

## agent-manager contract 변경 규칙

`agent_session_request` payload(`AgentSessionRequestPayload`, `credential_id` 포함), `/api/agent/sessions/*` 바디·credential 응답, 하트비트 `acp_session_clis`
는 서버와 agent-manager 가 같은 contract 를 본다 — 변경은 **같은 PR**. 버전은 손으로 올리지 않는다.

## 운영 메모

- `agent_sessions.use` 는 기본 admin 전용이다 — 장비 운영자의 개인 CLI 기록이 그대로 보이기 때문이다. 필요한 사용자에게만 부여한다.
- 세션이 "Authentication required" 로 실패하면 장비에서 `claude login` / `codex login` 을 하거나 CLI 설정에 credential 을 묶는다.
- Codex 세션이 "Model metadata for … not found" / "requires a newer version of Codex" 를 내면 어댑터가 옛 zed-industries 것이다 —
  `npm uninstall -g @zed-industries/codex-acp && npm i -g @agentclientprotocol/codex-acp` 로 바꾼다. 모델은 세션 헤더의 Model 셀렉트에서 고른다.
- 같은 세션을 터미널과 AWB 에서 동시에 쓰지 말 것 — 두 프로세스가 같은 JSONL 에 쓴다.
- Codex 는 어댑터가 `loadSession` 을 지원할 때만 기존 세션을 이어 쓸 수 있다(미지원이면 open 이 `resume_unsupported` 로 실패).
- 세션 프로세스는 매니저 self-update drain 카운트에 포함되고, 매니저 종료(SIGTERM)는 모든 세션 프로세스를 멈춘다(상태 idle).
- Windows: 어댑터 프로세스는 cross-spawn 으로 띄우므로 npm 배치 shim(`codex-acp.cmd`)과 `npx` 폴백이 모두 동작한다
  (예전엔 node 의 spawn() 이 `spawn npx ENOENT` / `spawn EINVAL` 로 죽어 ralf 에서 세션이 열리지 않았다). 다만 `npx --yes`
  폴백은 첫 실행에 패키지를 내려받느라 initialize 타임아웃(60s)을 넘길 수 있으니 장비에
  `npm i -g @zed-industries/codex-acp @agentclientprotocol/claude-agent-acp` 로 미리 설치해 두는 편이 낫다.
  특수한 레이아웃은 `AWB_ACP_COMMAND_CLAUDE` 등으로 절대 경로를 지정한다.
- 첨부/이미지, 여러 사용자 동시 관람, 터미널(PTY) 모드는 범위 밖이다.

## 테스트

- 서버: `apps/server/test/agent-sessions.test.mjs` — hosts / RPC 왕복·소유권 / prompt·stream·permission / close / CLI 설정·credential 전달 /
  유령 상태 되돌림(list·history·인스턴스 제거·하트비트) / config option·elicitation op 과 awaiting_input / 첫 이벤트의 상태 추정.
- agent-manager: `agent-session-heartbeat.test.mjs` — 하트비트 `agent_sessions` 필드와 `liveStates()`.
- agent-manager: `apps/agent-manager/test/agent-session-store.test.mjs`(합성 Claude·Codex 파일 파싱),
  `agent-session-runner.test.mjs`(fake ACP 로 list·history·open·prompt·permission·resume, credential 별 세션 cli-home 적용,
  미결 permission/질문 재전송·취소, config option·slash command·plan·elicitation 왕복).
- 클라이언트: `apps/client/test/agent-session-transcript.test.mjs`(접기 규칙·slash 매칭·schema 정규화), `sessions-navigation.test.mjs`,
  `new-session-modal-host-refresh.test.mjs`(호스트 목록 갱신이 열린 모달을 되돌리지 않는다),
  `session-interactive-ui.test.mjs`(컴포저 자동완성, 질문 폼 렌더·제출).
