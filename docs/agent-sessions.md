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
  `@zed-industries/codex-acp`. env 는 매니저 프로세스 그대로(운영자 CLI 홈), AWB MCP 서버는 매니저 키로 주입.
  기존 세션은 `session/load`(cwd 는 기록에서), 새 세션은 `session/new`. load 재생분은 버린다(UI 가 history 로 이미 가짐).
  유휴 30분(`config.agent_sessions.idle_minutes`) 또는 close 로 프로세스 회수 → 상태 idle/closed, 다음 prompt 가 다시 연다.
- **클라이언트 `components/sessions`** — 호스트 목록 → 호스트×CLI 세션 목록(장비의 기록) → 트랜스크립트(history + 라이브
  스트림) + 컴포저. 권한 카드 버튼이 `POST …/permission` 을 부른다. 라이브 행은 도착 순서로 붙이고 id 로만 중복을 거른다.

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

`idle`(프로세스 없음) → `starting` → `ready` ⇄ `busy` ⇄ `awaiting_permission`; `error`(last_error); `closed`(사용자가 멈춤).
idle / closed / error 에서 prompt 하면 매니저가 다시 연다. 진행 중(busy / awaiting_permission / starting)에는 409 `session_busy`.
상수는 `apps/server/src/common/types/agent-sessions.ts` 가 단일 원천이다.

## agent-manager contract 변경 규칙

`agent_session_request` payload(`AgentSessionRequestPayload`, `credential_id` 포함), `/api/agent/sessions/*` 바디·credential 응답, 하트비트 `acp_session_clis`
는 서버와 agent-manager 가 같은 contract 를 본다 — 변경은 **같은 PR**. 버전은 손으로 올리지 않는다.

## 운영 메모

- `agent_sessions.use` 는 기본 admin 전용이다 — 장비 운영자의 개인 CLI 기록이 그대로 보이기 때문이다. 필요한 사용자에게만 부여한다.
- 세션이 "Authentication required" 로 실패하면 장비에서 `claude login` 을 하거나 CLI 설정에 credential 을 묶는다.
- 같은 세션을 터미널과 AWB 에서 동시에 쓰지 말 것 — 두 프로세스가 같은 JSONL 에 쓴다.
- Codex 는 어댑터가 `loadSession` 을 지원할 때만 기존 세션을 이어 쓸 수 있다(미지원이면 open 이 `resume_unsupported` 로 실패).
- 세션 프로세스는 매니저 self-update drain 카운트에 포함되고, 매니저 종료(SIGTERM)는 모든 세션 프로세스를 멈춘다(상태 idle).
- Windows 에서 `npx` 폴백은 `.cmd` shim 문제로 실패할 수 있다 — `AWB_ACP_COMMAND_CLAUDE` 등으로 절대 경로를 지정한다.
- 첨부/이미지, 여러 사용자 동시 관람, 터미널(PTY) 모드는 범위 밖이다.

## 테스트

- 서버: `apps/server/test/agent-sessions.test.mjs` — hosts / RPC 왕복·소유권 / prompt·stream·permission / close / CLI 설정·credential 전달.
- agent-manager: `apps/agent-manager/test/agent-session-store.test.mjs`(합성 Claude·Codex 파일 파싱),
  `agent-session-runner.test.mjs`(fake ACP 로 list·history·open·prompt·permission·resume, credential 별 세션 cli-home 적용).
- 클라이언트: `apps/client/test/agent-session-transcript.test.mjs`, `sessions-navigation.test.mjs`.
