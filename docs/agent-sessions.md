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
  스트림) + 컴포저. 목록은 최근 3일(`SESSION_RECENCY_WINDOW_MS`)을 기준으로 접는다 — **세션 행과 작업 폴더 그룹이 같은 창**을
  쓴다(`splitRecentSessions` / `splitRecentCwdGroups`). 사이드바가 폴더는 전부 펼쳐 놓고 세션만 접던 어긋남을 없앤 것이고,
  둘 다 "전부 오래됐으면 가장 최신 하나는 남긴다" 를 지켜 빈 목록이 되지 않는다. 권한 카드 버튼이 `POST …/permission` 을 부른다. 라이브 행은 도착 순서로 붙이고 id 로만 중복을 거른다.

## 상호작용 (모델 선택 · slash command · 질문/폼 · plan)

ACP 가 규정한 상호작용을 그대로 옮긴다 — AWB 가 CLI 별 모델 목록이나 명령을 하드코딩하지 않고 **어댑터가 알려 준 것**을 보여 준다.

| ACP | AWB 상태/이벤트 | 사용자 조작 |
|---|---|---|
| `session/new`·`load` 응답의 `configOptions`, `config_option_update` | 스냅샷 `config_options[]` (`config_id, name, category, type: select\|boolean, current_value, options[]`) | 헤더의 셀렉트/체크박스 → `POST …/config-option {config_id, value}` → op `set_config_option` → `session/set_config_option` → 어댑터가 준 전체 목록으로 갱신 + system 행 |
| `available_commands_update` | 스냅샷 `available_commands[]` (`name, description, input_hint?`) | 컴포저에서 `/` 를 치면 자동완성(↑/↓, Enter/Tab 선택, Esc). 선택은 텍스트만 채우고 전송하지 않는다. 명령은 프롬프트 텍스트로 그대로 간다 |
| `session/request_permission` (`title`/`description`/`toolCall`, claude 의 `_meta.permission`) | `permission_request` 행 + `awaiting_permission` | 권한 카드 → `POST …/permission` |
| `elicitation/create` (form: JSON Schema, url) — claude 의 AskUserQuestion 등 | `elicitation_request` 행 + **`awaiting_input`** (form 만). url 은 링크 카드만 남기고 바로 accept, 완료는 `elicitation/complete` → `elicitation_decision{decided_by:'agent'}` | 폼 카드(문자열/숫자/불리언/단일·다중 선택, required 검사) → `POST …/elicitation {elicitation_id, action: accept\|decline\|cancel, content}` → op `elicitation` |
| `_auth/status_update` (claude-agent-acp · codex-acp 공통 `_meta` 확장, push 전용) | 스냅샷 `auth` — 어댑터가 준 신원(`kind`/`label`/`detail`/`account`)에 매니저가 아는 **출처**(`source`: 워크스페이스 Credential 인지 장비 운영자 로그인인지)를 더한 것 | 세션 헤더에 한 줄로 표시(🔑 = credential, 👤 = 운영자 로그인). 어댑터가 알려 주지 않으면 **아무것도 그리지 않는다** — "모른다" 와 "로그아웃(`kind:'none'`)" 은 다르다 |
| `plan` / `plan_update` | `plan` 행(`entries[{content, priority, status}]`) — 같은 turn 의 최신 것이 이전 것을 대체 | 체크리스트 카드 |
| `session_info_update` | 제목 패치 | — |

client capabilities 로 `elicitation: {form, url}`, `session.configOptions.boolean`, `plan` 을 광고하므로 어댑터가 이 기능을 켠다.
config option 의 id 키는 어댑터 세대에 따라 `id`(SDK 1.x 스키마 — codex-acp 1.12, claude-agent-acp 0.79 실측) 또는
`configId`(v2 초안) 로 오므로 매니저는 둘 다 받는다(요청 `session/set_config_option` 은 항상 `configId`).
**고른 설정은 기억된다.** 어댑터 프로세스는 매번 자기 기본값으로 시작하므로, 기억해 두지 않으면 유휴 회수·재접속마다
approval 모드와 모델이 어댑터 기본값으로 돌아간다. `agent_session_cli_settings.default_config` 에 워크스페이스 × 호스트 × CLI
로 `{ [configId]: value }` 를 남기고(레거시 `session/set_mode` 는 예약 키 `__mode`), open/prompt payload 의 `config_defaults`
로 매니저에 실어 보내 세션이 열린 직후 다시 건다. 이미 그 값이면 왕복하지 않고, 어댑터가 더는 제공하지 않는 키는 조용히 건너뛴다.
선택지 자체는 어댑터가 살아 있어야 알 수 있어 마지막 목록을 `known_config_options` 에 캐시한다(세션을 열 때 그 워크스페이스에
저장하고, 아직 비었으면 지금 살아 있는 세션의 목록으로 답한다 — credential 을 묶은 적 없는 호스트는 row 자체가 없어서 예전엔
캐시가 영영 비어 있었다). 덕분에 **세션을 열기 전에** approval 모드와 모델을 고를 수 있다: 새 세션 모달과 호스트 목록의
"CLI settings" 패널 두 곳에서. 그 둘만 여기 두고 나머지 설정은 세션 헤더에서 바꾼다.
`PUT …/settings` 의 `default_config` 는 부분 갱신이고 `null` 은 그 키를 지운다(= 어댑터 기본값으로).

설정 변경(`set_config_option` / `set_mode`)은 **언제든 된다**. 프로세스가 없으면 서버가 `starting` 으로 올리고 매니저가
prompt 와 같은 경로로 먼저 연 뒤 적용하므로 첫 프롬프트 전에도 고를 수 있고, **턴 중에도 승인 대기 중에도 바꿀 수 있다** —
어댑터가 그 상태에서도 받아들이고(codex-acp 1.12 실측: 턴 중 `set_config_option`·`set_mode` 모두 성공, 대기 중인 permission
도 그대로 유지), 오히려 그때가 가장 바꾸고 싶은 순간이다(계속 묻는 게 번거로워 "Approve for me" 로 옮기는 경우).
설정 목록 자체는 어댑터가 살아 있어야 오므로, 세션 페이지에 들어오면 `idle` 세션은 자동으로 한 번 연결한다(`POST …/sessions
{session_id}` → session/load, 터미널의 `--resume` 과 같다). `closed`/`error` 는 헤더의 Connect/Reconnect 버튼으로만 다시 연다.

codex-acp 1.12 실측(rolf): `session/new` 가 modes(read-only / agent / agent-full-access) 와 config options
Mode·Collaboration mode(default/plan)·Model(gpt-5.6-sol, gpt-6-astra, …)·Reasoning effort·Fast mode 를 준다. approval 은
`session/request_permission` 으로 온다(예: plan 확정 "Implement this plan?" 의 implement_plan/revise_plan). 질문은
Collaboration mode 가 plan 일 때 `elicitation/create` 폼(oneOf 선택지 + 메모)으로 온다. read-only 모드에서도 작업 폴더 안의
쓰기는 codex 샌드박스가 그냥 허용하므로 approval 이 뜨지 않는 게 codex 의 동작이다.
`awaiting_input` 은 `awaiting_permission` 과 같은 대기 상태다: prompt 는 409 `session_busy`, 유령 되돌림 대상, 프로세스 종료·close 때
미결 질문은 `elicitation_decision{action:'cancel', decided_by:'system'}` 으로 닫히고, history RPC 가 미결 질문을 같은 id 로 다시 실어 보낸다.

## CLI 설정 (credential · backend · 기본 설정)

Runtime Host × CLI 마다 **어떤 워크스페이스 Credential(Settings → Credentials)로 인증할지** 와 **세션마다 다시 걸 설정**
(`default_config`, 위 "상호작용" 절 참조)을 정한다
(`agent_session_cli_settings`, `GET/PUT /api/agent-sessions/hosts/:managerId/:cli/settings`, 화면은 호스트 세션
목록의 "CLI settings"). 비워 두면 장비 운영자의 CLI 로그인(`claude login` / `codex login`)을 그대로 쓴다.

- 후보는 워크스페이스 + global credential 중 provider 접두어가 CLI 와 맞는 것(`claude_*`, `codex_*`) — agents 화면의
  `CLI_TO_CREDENTIAL_PREFIX` 와 같은 규약. 불일치는 400, 다른 워크스페이스 것은 404, hermes 는 아직 미지원(409).
- 매니저는 open/prompt 요청에 실린 `credential_id` 로 `GET /api/agent/sessions/credential/:id?workspace_id=` 를 부른다.
  서버는 **그 매니저에 바인딩된 credential 만** 복호화해 준다(다른 매니저 키, 바인딩 없는 credential → 403).
- **기록 링크는 존재만으로 믿지 않는다.** 세션 전용 홈의 기록 디렉터리(`projects` / `sessions`)는 운영자 홈으로
  심볼릭 링크(Windows 는 junction)하는데, junction 은 끊어져도 경로가 남아 빈 디렉터리처럼 보인다. 그대로 두면
  codex 가 `no rollout found for thread id …` 로 재개를 거부하고, 그 credential 로 여는 **모든** 세션이 영영
  재개 불가가 된다(실측: ralf). 그래서 열 때마다 대상의 첫 항목이 링크를 통해 보이는지 확인하고, 안 보이면 다시 만든다.
  링크가 아니라 내용이 있는 진짜 디렉터리면 지우지 않고 로그만 남긴다.
- 적용 방식: 운영자 홈의 로그인 파일은 절대 건드리지 않는다. credential 이 묶이면
  `$AWB_AGENT_MANAGER_HOME/session-homes/<cli>/<credential_id>` 를 세션 전용 cli-home 으로 만들고, 기존 어댑터
  `prepareCliHome` 이 자격증명 파일(`.credentials.json` / `auth.json`) 또는 env(`CLAUDE_CODE_OAUTH_TOKEN`,
  `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`)를 만든다. `CLAUDE_CONFIG_DIR` / `CODEX_HOME` 을 그 홈으로 돌리고, 운영자
  셸의 API 키(`authEnvKeys`)는 걷어내며, 워크스페이스 trust 를 시드한다. **기록 디렉터리만**(`projects` / `sessions`)
  운영자 홈으로 심볼릭 링크해 장비의 기존 세션이 그대로 보이고 이어진다.
- **Backend(Claude backend profile)**: `agent_session_cli_settings.backend_profile_id` 로 이 호스트×CLI 세션이 말을 걸
  엔드포인트·모델을 고른다(Admin → Claude backends 의 인스턴스 전역 목록). 고르면 open/prompt payload 의 `runtime_profile`
  로 매니저에 실려 가고, 매니저가 디스패치와 **같은 기계**(`startRuntimeProfile` → `lease.claudeEnv()`)로 `ANTHROPIC_BASE_URL`·
  모델 env 를 세션 프로세스에 건다. 프로필이 어댑터 사이드카를 요구하면 그 프로세스도 lease 가 관리하고 세션이 닫힐 때 반납한다.
  claude 전용이다(Claude backend profile 이므로 codex 는 409). 비밀은 CLI 설정에 묶인 credential 에서 오며, 프로필이 특정
  credential 을 가리키는데 다른 것이 묶여 있으면 거부한다 — 조용히 엉뚱한 키로 붙는 것보다 낫다.
  **전역 기본값으로 떨어지지 않는다**: 디스패치 경로와 달리, 고르지 않았으면 CLI 기본 엔드포인트를 그대로 쓴다 —
  세션은 "그 장비의 CLI 를 그대로 몬다" 는 표면이라 조용히 다른 백엔드로 돌아가면 안 된다.
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

### 긴 세션 (기록 창과 라이브 창)

기록 파일은 수백 MB 까지 자란다(실측: rolf 의 codex rollout 353MB, ralf 176MB). 어느 쪽도 통째로 다루지 않는다.

- **매니저**: 파싱하면서 최근 `historyEventLimit`(4000) 건만 `BoundedHistory` 에 들고, 창 밖으로 나간 건 즉시 버린다.
  payload 크기(`boundHistoryPayload`)도 **담는 시점에** 자른다 — 나중에 한 번에 자르면 창 안에 원본 blob 이 남아
  파일 크기만큼 메모리를 먹는다(353MB 세션에서 최대 RSS 586MB → 293MB, 3.1s → 2.0s). 그 다음 바이트 상한
  (`HISTORY_BODY_MAX_BYTES` 6MB)에 맞춰 다시 오래된 것부터 버리고, `Earlier history omitted (N events)` 한 줄을 앞에 붙인다.
  `seq`/`id` 는 창 안 위치가 아니라 **절대 위치**다 — 앞부분이 그대로인 한 같은 이벤트가 같은 id 를 가져야 화면이
  라이브 행과 중복을 거를 수 있다.
- **화면**: 라이브 행도 `LIVE_EVENT_WINDOW`(4000)을 넘으면 앞에서 버리고 `Earlier messages trimmed (N events)` 한 줄을
  남긴다(마커는 항상 하나, 누적 개수만 올라간다). 상한이 없으면 오래 켜 둔 세션에서 배열이 무한히 자라고
  매 스트림 청크마다 전체를 다시 접느라(`buildTranscript`) 점점 느려진다.

### 어댑터의 MCP 연결 알림 (`mcp_startup.<server>`)

codex-acp 는 주입된 MCP 서버의 연결 결과를 **update 가 따라오지 않는 한 번짜리 `tool_call`** 로 알린다
(`toolCallId: 'mcp_startup.awb'`, `title: 'mcp__awb__startup'`, status 가 곧 결과). 게다가 이 알림은
`session/new` **응답보다 먼저** 온다. 그래서 두 가지가 겹쳐 있었다:

- 상태를 버리고 중계하면 update 가 영원히 오지 않으므로 카드가 계속 "running" 으로 남는다. 이건 에이전트가 한
  일이 아니라 세션이 열리는 과정이므로 **카드로 만들지 않는다** — 성공은 조용히 버리고, 실패만 "이 서버의 툴을
  못 쓴다" 는 사실이라 `system` 행으로 남긴다.
- 세션 id 를 알기 전의 행은 보낼 곳이 없다. 예전엔 seq 만 올리고 버려서 이후 행의 seq 가 한 칸씩 어긋났고,
  UI 의 유실 감지(`hasSeqGap`)가 계속 재조회를 돌게 했다. 지금은 `preSessionEvents` 에 모아 뒀다가 세션이 열리는
  즉시 순서대로 내보낸다.

그 실패의 실제 원인이었던 것: AWB 의 MCP 게이트가 `X-AWB-Client-Type: agent-session` 을 면제 목록에 넣지 않아
세션마다 handshake 가 `schemaVersion mismatch` 로 실패했다. CLI 네이티브 MCP 클라이언트는 AWB 확장 capability 를
모르므로 subagent / managed-subagent / runtime-child 와 같은 면제다(`mcp-schema-version.test.mjs` 가 네 종류를 모두 고정).

### 긴 기록 (history 응답 크기)

기록 응답은 서버의 JSON 본문 상한(10MB)을 넘으면 413 으로 버려지고, 화면은 40초 뒤 타임아웃 에러만 본다.
실측(ralf codex 세션): 응답이 **21.16MiB**, 개별 `tool_update` 하나가 1.37MB 였다. 원인은 codex 의 tool 출력이
문자열이 아니라 content block **배열**로 와서 `truncate(...)` 갈래를 비껴간 것이다. 그래서:

- payload 크기 정리는 CLI 별 파서가 아니라 `readHistory` **한 곳**에서 한다(`boundHistoryPayload`) — 갈래마다 자르면
  한 곳만 빠뜨려도 응답 전체가 죽는다. 문자열은 자르고, 배열·객체는 개수를 제한하고, 그래도 크면 미리보기로 대체한다.
- 마지막 방어선으로 응답 전체를 바이트로 자른다(`fitHistoryBytes`, 6MiB). **오래된 것부터** 버려 최근 대화를 지키고,
  한 건도 못 담을 만큼 큰 이벤트만 있어도 최소 한 건은 남긴다. 버린 건수는 기존 `Earlier history omitted` 안내에 합산된다.

같은 파일 기준 응답이 21.16MiB → 2.41MiB 로 줄고 786건이 모두 남는다.

### 거대한 메시지

어댑터가 tool 출력을 알림 **한 줄**로 보내는데, 큰 파일 읽기나 긴 명령 출력이면 기본 상한(4MiB)을 넘는다.
예전엔 그 줄 하나가 `acp_message_too_large` 로 스트림을 죽여 프로세스가 SIGTERM 으로 내려갔다(턴은 error 로 끝났다).
개행이 곧 재동기화 지점이므로 **그 줄만 버리면** 나머지는 멀쩡하다 — 세션 어댑터는 상한을 64MiB 로 올리고
`skipOversizedLines` 로 넘치는 줄을 건너뛴 뒤, 몇 MiB 를 버렸는지 `system` 행으로 알린다. 기본값은 예전대로
치명적 오류다(hermes 런타임의 엄격한 계약을 바꾸지 않는다). 청크로 쪼개져 오는 줄도 한 번만 보고한다.

일반 tool_call 도 초기 status 를 그대로 싣는다(`tool_call.payload.status`) — 기록(codex rollout)의 호출 행에도
자기 status 가 있으므로, 결과 행이 없는 호출(중단된 턴 등)이 "running" 으로 굳지 않는다.
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
- 세션 프로세스에는 `AWB_API_KEY`(매니저 키)가 들어간다. 세션 홈의 `config.toml` 이 awb MCP 서버를
  `bearer_token_env_var = "AWB_API_KEY"` + `required = true` 로 적기 때문이다 — 없으면 codex 가 세션 초기화를 통째로
  중단한다. **재개는 그 대화에 기록된 MCP 설정을 다시 띄우므로**, 지금 config 를 고쳐도 옛 대화는 이 env 없이는 계속 막힌다
  (실측: ralf 의 실제 thread 가 env 없이는 실패, 넣으면 12.8s 만에 로드). 같은 키가 이미 ACP `mcpServers` 의 Authorization
  헤더로 넘어가므로 새로 노출되는 비밀은 없다.
- 재개가 `Internal error` 로 실패하면 어댑터의 `data.details` 를 그대로 보여 준다 — 대개 `no rollout found for thread id …`
  이고, 그건 **계정 문제가 아니라** 세션 홈의 기록 링크가 끊어진 것이다(위 "CLI 설정" 참조). 매니저를 올리면 다음 open 에서 스스로 고친다.
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
