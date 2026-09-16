# Agent Sessions (CLI 직접 세션)

한 사용자가 한 CLI 에이전트(Claude Code / Codex / Hermes / ACP 를 말하는 사용자 지정
명령)의 세션을 **직접** 모는 표면이다. 기존 Chat(ChatRoom) 과는 별개의 기능이며,
앞으로의 주 작업 표면이다 — chat 모드의 기본 랜딩이 `/ws/:wsId/sessions` 다.

## 왜 Chat 을 개편하지 않고 따로 두는가

| | Chat (ChatRoom) | Agent Session |
|---|---|---|
| 단위 | 방(room) — DM/그룹 + Action/QA/Mission run 방 등 9종이 한 엔티티에 다중화 | (owner_user, agent) 1:1 세션 |
| 에이전트 답변 | `send_chat_room_message` MCP 툴 호출로만 | ACP 스트림(text/tool/permission) 그대로 |
| 프롬프트 | 매 턴 보드 정책 프롬프트로 래핑, DB 히스토리를 재조립 | 사용자 텍스트가 그대로 `session/prompt` |
| cwd | 방에서 파생(워크스페이스 opt-in `.awb/chat/<room8>`) | 세션의 1급 필드 |
| 권한 | CLI 어댑터는 사전 결정(tier), 대화형 승인 없음 | `session/request_permission` 을 사용자에게 릴레이 |
| 의존 모듈 | 16개 모듈이 dispatch 버스로 재사용 | 없음 — 독립 모듈 |

ChatRoom 은 채팅 제품이자 플랫폼 내부 메시지 버스라, "그룹 삭제/작업폴더 삭제" 식의
개편은 orchestration/action/QA 를 깨뜨리면서도 직접 세션이 필요로 하는 계약(스트리밍,
승인 릴레이, 세션 소유 cwd)을 주지 못한다. 그래서 새 표면으로 추가했다.

## 이름 규약 (헷갈리지 않게)

| 계층 | Chat | Session |
|---|---|---|
| 엔티티 | `ChatRoom` / `ChatRoomMessage` / `ChatRoomParticipant` | `AgentSession` / `AgentSessionEvent` |
| 서버 모듈 | `modules/chat-rooms` | `modules/agent-sessions` |
| 사용자 REST | `/api/chat-rooms/*` | `/api/agent-sessions/*` |
| agent-manager REST | `/api/agent/chat-rooms/*` | `/api/agent/sessions/*` |
| SSE | `chat_request`, `chat_room_message`, … | `agent_session_request`(→manager), `agent_session_update`/`agent_session_event`(→UI) |
| 권한 | `chat.view` / `chat.send` | `agent_sessions.use` |
| 클라이언트 | `components/chat/*`, `/ws/:wsId/chat/:roomId` | `components/sessions/*`, `/ws/:wsId/sessions/:sessionId` |
| 사이드바 | "Chat" 섹션 | "Sessions" 섹션 (Chat 위) |
| manager | `chat-session-manager.ts` | `agent-session-runner.ts` |

## 데이터 모델

- `agent_sessions` — `workspace_id`, `agent_id`, `owner_user_id`, `runtime`(생성 시 Agent.type 스냅샷),
  `title`, `cwd`, `status`, `native_session_id`(ACP 세션 id), `resume_supported`, `current_mode`,
  `available_modes`, `permission_policy`(`ask`|`auto_allow`), `last_error`, `last_event_seq`, `last_activity_at`.
- `agent_session_events` — append-only, 세션당 `seq` 단조 증가. `type` 은
  `user_prompt | text | reasoning | tool_call | tool_update | permission_request | permission_decision | usage | turn | error | system`.
  스트리밍 텍스트는 매니저가 ~150ms 로 합친 청크 한 행. UI 는 같은 turn 의 연속 `text` 를 하나로 병합한다.
- 상태: `starting → ready ⇄ busy ⇄ awaiting_permission`, `suspended`(프로세스 없음, 다음 prompt 가 재오픈),
  `closed`(종료, 열람만), `error`(마지막 동작 실패, 다음 prompt 로 재시도). 상수는
  `apps/server/src/common/types/agent-sessions.ts` 가 단일 원천이다.
- 세션은 소유자에게만 보인다. 남의 세션은 404.

## 흐름

1. **생성** `POST /api/agent-sessions {agent_id, cwd?, permission_policy?}` → `agent_session_request{op:'open'}`
   이 대상 agent 스코프로 매니저에 간다(매니저 identity 재작성은 `chat_request` 와 같은 `effectiveIdentity` 경로).
2. **프롬프트** `POST /:id/prompt {text}` → 서버가 `user_prompt` 행을 쓰고 `busy` 로 바꾼 뒤 `op:'prompt'`.
   진행 중이면 409 `session_busy`, 닫혔으면 409 `session_closed`.
3. **매니저** (`apps/agent-manager/src/lib/agent-session-runner.ts`)
   - 런타임별 ACP 어댑터 명령을 고른다: `runtime_config.extra.acp_command`(+`acp_args`) →
     env `AWB_ACP_COMMAND_<RUNTIME>` → 기본값(`claude-agent-acp` / `codex-acp` on PATH, 없으면
     `npx --yes @agentclientprotocol/claude-agent-acp` / `@zed-industries/codex-acp`; hermes 는 `hermes-acp`).
   - cwd = 세션 cwd || Agent.working_dir. 존재하지 않으면 `error` 행.
   - env: 매니저 env + CLI 홈(`CLAUDE_CONFIG_DIR`/`CODEX_HOME`/`HERMES_HOME`, 기존 managed-agent 규약 그대로)
     + per-agent credential env + `AWB_AGENT_ID`/`AWB_SESSION_ID`/`AWB_API_KEY`/`AWB_URL`.
   - `initialize` → `native_session_id` 가 있고 어댑터가 `loadSession` 을 지원하면 `session/load`, 아니면
     `session/new`(AWB MCP 서버 `awb` 를 http 로 주입, `Authorization: Bearer <agent api key>`).
   - 스트림 릴레이: `agent_message_chunk`→`text`, `agent_thought_chunk`→`reasoning`, `tool_call`→`tool_call`,
     `tool_call_update`→`tool_update`, `usage_update`→`usage`, `current_mode_update`→`current_mode` patch.
   - `session/request_permission` → `permission_request` 행 + `awaiting_permission`. 정책이 `auto_allow` 면
     allow 계열 옵션을 골라 `decided_by:'policy'` 로 즉시 답한다. 아니면 사용자 결정(`op:'permission'`)을
     기다린다(기본 15분 후 cancelled).
   - 턴 종료: `usage` + `turn{phase:'finished', stop_reason}` + `ready`. 오류면 `error` + `turn(error)` + `error` 상태.
   - 유휴 30분(`config.agent_sessions.idle_minutes`) 또는 프로세스 종료 → `suspended`. `close` → 프로세스 종료.
4. **UI** (`apps/client/src/components/sessions/`) — `agent_session_event` 를 seq 로 병합하고 갭이 보이면
   재조회한다. 권한 카드의 버튼이 `POST /:id/permission` 을 부른다. `session/set_mode` 는 헤더의 모드 셀렉트.

## agent-manager contract 변경 규칙

`agent_session_request` payload(`AgentSessionRequestPayload`)와 `/api/agent/sessions/*` 바디는 서버와
agent-manager 가 같은 contract 를 본다 — 변경은 **같은 PR** 로 묶는다(CLAUDE.md "Agent Manager sync").
버전은 손으로 올리지 않는다.

## 운영 메모

- 세션 프로세스는 매니저 self-update drain 카운트에 포함된다(`countInFlightSessions`).
- 매니저 종료(`SIGTERM`)는 모든 세션 프로세스를 멈추고 `suspended` 로 표시한다. 트랜스크립트는 서버에 있으므로
  재시작 뒤 다음 프롬프트가 `session/load`(지원 시)로 이어 붙는다.
- Windows 에서 `npx` 폴백은 `.cmd` shim 문제로 실패할 수 있다 — `AWB_ACP_COMMAND_CLAUDE` 등으로 절대 경로를 지정한다.
- 첨부/이미지, 세션 공유(다른 사용자 열람), 터미널(PTY) 모드는 v1 범위 밖이다.

## 테스트

- 서버: `apps/server/test/agent-sessions.test.mjs` — 생성/프롬프트/매니저 append/권한/키 경계/close/delete.
- agent-manager: `apps/agent-manager/test/agent-session-runner.test.mjs` — fake ACP 서버로 스트림 순서·권한 릴레이·resume.
- 클라이언트: `apps/client/test/agent-session-transcript.test.mjs`(트랜스크립트 접기), `sessions-navigation.test.mjs`(IA).
