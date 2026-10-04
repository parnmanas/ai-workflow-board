# Agent Sessions (CLI 직접 세션)

Runtime Host 장비에 있는 CLI(Claude Code / Codex / Hermes)의 세션을 AWB 화면에서 직접 모는 표면이다.
세션의 단위는 **(Runtime Host, CLI, CLI 네이티브 세션 id)** 이고, **AWB 는 세션 내용을 저장하지 않는다.**
Claude Code 는 `~/.claude/projects/<cwd>/<id>.jsonl`, Codex 는 `~/.codex/sessions/…/rollout-*.jsonl`, opencode 는
`~/.local/share/opencode/opencode.db`(SQLite) 에
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
  라이브 상태(status/mode/driver)만 메모리에 두고, 매니저가 중계한 이벤트를 driver(마지막으로 그 세션을 **연**
  사용자 — history 로 읽은 것도 포함, open/prompt 같은 쓰기뿐 아니라)에게 SSE 로 흘린다. 다른 매니저 키는 남의 RPC 를 풀거나 이벤트를 중계할 수 없다.
  **서버 재시작 직후**: 매니저는 하트비트(HTTP)와 SSE 를 따로 다시 붙이므로, 호스트가 "연결됨" 인데 스트림은 아직
  없을 수 있다. 그때 보낸 요청은 SSE 로 가므로 사라진다. 그래서 스트림이 없을 때 보낸 **읽기** RPC(list/history/image/
  local_image — `open` 은 중복 실행 위험으로 제외)는 그 매니저 스트림이 붙으면(`AgentConnectivityRegistry.onBecameReachable`)
  같은 request_id 로 다시 보내고 타임아웃도 새로 잰다. 사이드바도 목록 실패를 "세션 없음" 으로 저장하지 않고 마지막
  목록을 유지한 채 다시 묻는다(`Sidebar.tsx` `loadHostSessions`).
- **매니저 `agent-session-store.ts`** — CLI 홈 리더. Claude: `projects/*/*.jsonl` (`agent-*.jsonl` 서브에이전트 파일과
  프롬프트 없는 빈 세션 제외, `custom-title` 우선, sidechain 행 제외). Codex: `sessions/**/rollout-*.jsonl`
  (`session_meta` → id/cwd, developer/environment_context 메시지는 제목에서 제외). 기록은 같은 파일을 트랜스크립트
  이벤트(`user_prompt / text / reasoning / tool_call / tool_update / turn`)로 접는다. opencode 는 파일이 아니라
  **SQLite**(`~/.local/share/opencode/opencode.db`, WAL)에 세션을 넣으므로 그 파일을 직접 열지 않고 opencode 자신의
  `opencode db "<SQL>" --format json` 에 질의한다 — 스키마의 주인이 opencode 이고 WAL 락도 그쪽이 관리하게 두는 편이
  안전하며, 매니저에 sqlite 의존성을 새로 들이지 않아도 된다. `session` 테이블에서 `time_archived IS NULL AND
  parent_id IS NULL` 만 가져온다(보관됨·하위 세션은 사용자가 열 수 없다). 질의 실패(미설치·스키마 변경·타임아웃 10초)는
  **빈 목록으로 접는다** — 목록 하나가 세션 화면 전체를 못 쓰게 만들면 안 된다. Hermes 는 AWB 가 만든 세션만
  로컬 인덱스(`$AWB_AGENT_MANAGER_HOME/agent-sessions.json`)로 기억한다.
  - **opencode 출력은 파이프가 아니라 temp 파일로 받는다** (`runToFile`, 2026-09-30 실측). `opencode db` 는 결과가
    파이프 버퍼(64KB)를 넘기면 stdout 플러시를 기다리지 않고 종료해 잘린 JSON 을 내놓고도 exit 0 으로 끝난다
    (파이프 5회 중 4회 잘림, 파일 리다이렉트는 항상 온전). 잘린 JSON 은 파싱이 깨져 `[]` 로 접히므로, 일 좀 시킨
    세션(기록 수십 KB 이상)의 history 가 통째로 비어 보이는 사고가 났다 — 새 세션(작은 출력)에서는 정상이라
    "가끔 된다" 처럼 보였다. 작은 출력·테스트 seam 은 기존 pipe(`exec`) 그대로다.
- **매니저 `agent-session-runner.ts`** — 세션당 ACP 어댑터 프로세스. 명령 우선순위(`clis/bundled-acp.ts`):
  env `AWB_ACP_COMMAND_<CLI>` → **managed / bundled 중 더 새 것** → PATH 의 `claude-agent-acp` / `codex-acp` /
  `hermes-acp` → `npx --yes <pkg>`. 어댑터는 모델 id 를 **자기 번들에 하드코딩**하므로 어댑터 버전이 세션의
  모델 목록·capability 를 정한다(0.79.0 이 세 호스트에서 조용히 5버전 썩어 Opus 5.5 가 세션에 안 뜬 적이 있다).
  - **bundled** — `awb-agent-manager` 의존성(`^0.84.0` / `^1.12.0`). 매니저와 함께 깔리지만 범위에 묶여, 새 어댑터가
    나와도 매니저를 다시 깔아서는 따라오지 않는다.
  - **managed** — 운영자가 Runtime Hosts 의 어댑터 줄 **Update**(`update_acp_adapter`, "전부 업데이트" 에도 포함)로
    매니저 홈 `acp-adapters/` 에 `npm install --prefix … <pkg>@latest` 한 것. 홈에 두므로 **매니저 업데이트에도
    살아남고**, 전역 prefix 를 건드리지 않아 권한 상승이 필요 없다. 둘 다 있으면 더 새 쪽을 쓴다 — 운영자가 올린 것이
    매니저 재설치로 되돌아가지 않고, 나중에 번들이 더 새 걸 가져오면 낡은 홈 설치본이 그것을 가리지도 않는다.
  - 전역 `npm i -g <adapter>` 는 **효과가 없다**(번들이 PATH 보다 앞이다). 이미 열린 세션은 옛 어댑터 프로세스를 그대로
    쓰므로 업데이트 후 세션 Restart 가 필요하다. 하트비트 `acp_adapters[].source` 가 지금 무엇이 쓰이는지 알려 준다.
  - **어댑터는 두 패키지 모두 `@agentclientprotocol/*`** — zed-industries 의 codex-acp 는 2026-07 에 archive 됐고 옛 Codex
    코어(rust-v0.137)라 새 모델을 "requires a newer version of Codex" 로 거부한다. `@agentclientprotocol/codex-acp` 는
    설치된 codex CLI 와 같은 세대의 `@openai/codex` 를 번들한다.
  env 는 매니저 프로세스 그대로(운영자 CLI 홈), AWB MCP 서버는 매니저 키로 주입. codex 에는 `NO_BROWSER=1` 을 더해
  브라우저 로그인 auth method 를 숨긴다. `session/new`/`load` 가 auth required(-32000) 로 거부되면 환경에 API 키가 있을 때
  api-key 계열 ACP `authenticate` 를 한 번 시도하고, 아니면 "장비에서 `<cli> login` 하거나 credential 을 묶으라" 는 오류를 낸다.
  **opencode 만 예외로 사이드카가 없다** — ACP 서버를 자기 안에 갖고 있어 `opencode acp` 를 그대로 띄운다. 어댑터와
  CLI 코어의 세대가 어긋나는 문제(codex-acp 전례)가 원천적으로 없고 별도 설치도 필요 없다. rolf 실측(opencode 1.18.32):
  `initialize` 가 `loadSession:true` + `sessionCapabilities{close,fork,list,resume}` 를 주고, `session/new` 가
  `configOptions`(모델 select, `id` 키)와 `available_commands_update` 를 준다 — 모델 선택·슬래시 커맨드·재개가 모두
  기존 경로 그대로 동작한다. credential 을 안 묶으면 세션은 운영자 홈에서 돌고, 그 홈의 DB 가 위 목록 조회가 읽는
  바로 그 DB 다(같은 세션이 양쪽에 보인다). `opencode_auth` credential 을 묶으면 전용 홈이 생기므로 그때는 데이터
  디렉터리(`.local/share/opencode`, DB 가 그 안에 있다)를 운영자 홈으로 링크한다(모듈의 `sessions.storeSubdir`) — 계정
  격리는 그 디렉터리가 아니라 `OPENCODE_AUTH_CONTENT` env 가 맡으므로(cli-adapters/opencode.ts) 기록을 공유해도
  자격증명은 섞이지 않는다.
  기존 세션은 `session/load`(cwd 는 기록에서), 새 세션은 `session/new`. load 재생분은 버린다(UI 가 history 로 이미 가짐).
  프로세스 회수는 close, 또는 **진행 증거가 없는 유휴**(`agent_sessions.idle_minutes` 기본 180분, 0 이하면 끔).
  예전 기본값 30분은 `live.turn` 과 대기 중 권한/질문만 보고 판정했는데, 세션이 내부적으로 띄운 서브에이전트·
  백그라운드 셸·긴 빌드는 ACP 턴 경계와 일치하지 않는다 — 턴이 끝난 뒤에도 도는 자식이 있고, 그걸 모른 채
  세션을 죽이며 같이 날렸다. 지금은 chat/ticket 세션과 **같은 3-신호 진행 gate**(`session-progress.ts`)를 쓴다:
  타이머 만료는 **CHECK 이고 KILL 이 아니다**. ①어댑터 출력 ②살아있는 비-benign 자손 프로세스 ③이 세션 cwd
  서브트리의 cli-home mtime — 하나라도 신선하면 재무장한다. gate 판정 자체가 실패하면 죽이지 않는다(증거 없음과
  확인 실패는 다르다). 타이머는 턴이 도는 동안 아예 걸리지 않으므로, 회수 후보는 "턴도 없고 세 신호도 없는"
  세션뿐이다. 회수되면 전사는 디스크에 남아 다음 prompt 가 `--resume` 으로 이어 붙인다(따뜻한 컨텍스트만 잃는다).
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

재접속 시 작업 폴더 전달 여부와 관계없이 기존 저장소의 제목을 복원한다. 입력문으로 제목을 만드는 것은 새로 만든 무제목 세션의 첫 입력에만 적용하며, 기존 세션의 제목을 읽지 못한 경우에도 후속 입력으로 대체하지 않는다. CLI의 `session_info_update`는 `session/new`·`session/load` 응답 전과 라이브 턴 중 모두 반영하고, AWB 인덱스가 있는 세션은 갱신된 제목을 보존한다.

client capabilities 로 `elicitation: {form, url}`, `session.configOptions.boolean`, `plan` 을 광고하므로 어댑터가 이 기능을 켠다.
**모델 선택지의 출처는 셋이고, 아래로 갈수록 덜 구체적이다.** (1) 이 호스트×CLI 로 세션을 열었을 때 캐시해 둔 ACP
`configOptions` — 표시 이름·현재값까지 있어 가장 정확하다. (2) 지금 살아 있는 세션이 아는 선택지(서버 재시작 직후).
(3) 하트비트 `available_models[cli]` 로 합성한 model 옵션 — **세션을 한 번도 연 적 없는 조합**에서도 고를 수 있게 한다.
3번이 없던 동안에는 처음 쓰는 호스트×CLI 면 모델을 아예 못 골랐고, 사용자 눈에는 되는 조합과 안 되는 조합이
뒤섞인 것처럼 보였다. 합성은 **덧붙이기만 하고 덮어쓰지 않는다** — 실제 세션이 보고한 목록이 항상 더 정확하다.
두 출처의 id 형식이 같기 때문에 성립한다(rolf 실측: claude `opus/sonnet/haiku`, codex `gpt-6-astra…`,
opencode `opencode/big-pickle` — ACP 값과 어댑터 `listModels()` 값이 일치).

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

- 후보는 워크스페이스 + global credential 중 provider 접두어가 CLI 와 맞는 것(`claude_*`, `codex_*`, `opencode_*`) —
  agents 화면의 `CLI_TO_CREDENTIAL_PREFIX` 와 같은 규약. 불일치는 400, 다른 워크스페이스 것은 404, hermes 는 아직 미지원(409).
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
- **MCP 연결의 세션 식별** — 매니저가 세션 프로세스에 주입하는 AWB MCP 연결은 `X-AWB-Session-Id` 를 싣는다(operator 판정의
  근거, `docs/voice-operator.md` "권한"). 불러온 세션은 세션 id 를 그대로 싣지만, **새 세션은 프로세스를 띄울 때 id 를 아직
  모른다** — 매니저는 고유 참조값(`pending-<uuid>`)을 싣고, 하트비트 `agent_sessions[].mcp_session_ref` 로 "이 참조는 이 세션"
  을 알린다. 서버는 그 대응으로 바꿔 본다(`AgentSessionsService.resolveMcpSessionRef`). 예전 매니저는 글자 그대로 `'new'` 를
  실어, AWB 에서 새로 연 세션은 Restart 전까지 어느 세션의 연결인지 알 수 없었다(실측: 운영 operator 가 도구를 못 썼다).
- 서버가 처음 보는 세션에 매니저가 먼저 이벤트를 보내면(서버 재시작 뒤) 상태를 배치에서 읽는다 — 패치가 있으면 그것,
  턴 중에만 나오는 행(text/tool/permission …)이 있으면 busy, system 행뿐이면 idle. 예전엔 무조건 busy 로 심었다.
- **driver 도 메모리에만 있다 — 그래서 세션을 읽는 것 자체가 driver 를 (다시) 잡는다.** 서버가 재시작하면 driver 가
  사라지고, 그 뒤 매니저가 보내오는 이벤트는 받을 사람이 없다는 이유로 조용히 버려진다(서버는 세션을 저장하지 않는다).
  진행 중이던 세션은 busy 라 prompt 가 409 이고 Connect 버튼도 나오지 않아, driver 를 쓰기 동작으로만 잡던 예전
  규칙 아래서는 되찾을 길이 아예 없었다 — 화면은 이미 끝난 작업을 "Working" 인 채로 붙들고 그 뒤 대화가 하나도
  흐르지 않았다. 화면 쪽도 짝을 이룬다: SSE 가 끊겼다 붙으면 세션 화면이 스스로 다시 읽어(`isConnected` 전이) 끊긴
  동안의 기록을 매니저에서 메꾸고 driver 를 되찾는다.
- 사이드바·호스트 목록은 driver 전용 `agent_session_update` 로 행을 고치고, 매니저 인스턴스가 등록/제거되면 그 장비 목록을 다시 묻는다.

### 세션 잠금 (`already has an active writer`)

codex 는 스레드마다 writer 잠금을 건다(`<CODEX_HOME>/thread-writer-locks/<thread-id>.lock`). 그 스레드가
장비의 터미널이나 Codex 데스크톱 앱에서 열려 있으면 AWB 의 재개는 `thread … already has an active writer`
로 거절된다. 잠금 파일은 **0바이트**라 안에 주인 정보가 없다 — 그래서 매니저가 OS 에 직접 묻는다
(`apps/agent-manager/src/lib/file-lock-holders.ts`: Windows 는 Restart Manager `rstrtmgr.dll`, POSIX 는
`lsof` + `ps`). 조회는 절대 던지지 않는다: 못 알아내면 빈 목록이고, 그것은 "아무도 안 쥐었다" 가 아니라
**"모른다"** 로 취급한다.

잠금 파일의 위치는 CLI 모듈이 선언한다(`CliSessionSpec.lockRelativePath`) — 러너에 `if (cli === 'codex')`
를 두지 않는다. 선언하지 않은 CLI 에는 잠금 주인이라는 개념이 없다고 보고 강제 열기를 제공하지 않는다.

회복 정책은 **기본 안전 + 확인 후 강제** 다 (`selectKillTargets()` 한 곳에 있다):

| 잠금 주인 | 기본 Connect | 확인을 거친 `force` |
| --- | --- | --- |
| AWB 가 띄운 ACP 어댑터 (`codex-acp` 등) | 묻지 않고 정리하고 **한 번** 재시도 | 같음 |
| 그 밖의 프로세스 (Codex 앱, 터미널 codex) | 건드리지 않는다. 이름·PID 를 오류 문구에 실어 보낸다 (`resume_locked_external`) | 종료하고 재시도 |
| 매니저 자신 | 대상 아님 | 대상 아님 |
| 못 알아냄 | `resume_locked` — "그 장비에서 닫아라". 강제 열기를 내놓지 않는다 | — |

외부 프로세스를 자동으로 죽이지 않는 이유는 측정된 사실이다: ralf 에서 잠금 주인은 스레드 전용 프로세스가
아니라 Codex 앱의 공용 `codex.exe … app-server` 였다. 죽이면 이 세션 하나가 아니라 그 앱의 **다른 대화까지**
끊긴다. 그래서 화면(`SessionsPage`)은 `resume_locked_external` 일 때만 "강제로 열기…" 를 띄우고, 매니저가
말한 주인의 이름·PID 를 그대로 담은 확인 대화상자를 거친 뒤에야 `force: true` 를 보낸다. 자동 연결과 평범한
Connect 는 절대 `force` 를 켜지 않는다 — 페이지를 여는 것만으로 운영자의 앱이 죽으면 안 된다.

잠금 조회는 재개가 실제로 거절된 뒤에만 돈다(Windows 의 PowerShell 왕복이 1초 가까이 걸린다). 정상 Connect
경로에는 비용이 없다.

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

## 이미지 (`image` 이벤트 · `image` RPC)

에이전트가 내보낸 이미지를 전사에 그린다. ACP 는 이미 실어 보내고 있었고 AWB 가 버렸다 —
`acp-client.ts` 가 content block 에서 `.text` 만 읽었기 때문에 **이미지 블록은 조용히
사라졌다**(실측: "이미지를 보여달라" 고 해도 아무것도 안 나왔다). 어댑터가 실제로 보내는
모양은 `agent_message_chunk` 의 `content: {type:'image', data:<base64>, mimeType}` 이고,
tool 결과 이미지(PNG 를 Read 한 경우)도 같은 모양으로 변환된다. **MCP 를 따로 만들 필요가
없다** — 파이프라인을 고치면 어댑터가 이미지를 내보내는 모든 CLI 에 공통으로 적용되고,
에이전트가 "표시 툴을 부르기로 선택" 할 필요도 없다.

이미지는 **세 군데**에서 온다 — 셋 다 같은 `image` 이벤트로 접힌다:
- `agent_message_chunk` 의 `{type:'image'}` content (에이전트가 직접 내보낸 이미지)
- **tool 결과** — `tool_call_update.content[]` 의 `{type:'content', content:{type:'image', data, mimeType}}`.
  PNG 를 Read 한 경우가 이것이다. 예전에는 `rawOutput` 만 읽어 이미지가 사라지고 옆의 모델용 주석
  (`[Image: original 3437x674, displayed at 2000x392 …]`)만 보였다. 이미지는 그 tool 카드 **바로 뒤**에
  그리고(`tool_call_id` 를 싣는다), `rawOutput` 의 base64 는 걷어내 출력이 상한에 걸리지 않게 한다.
- **기록** — 세션을 다시 열면 전사는 CLI 홈의 기록 파일에서 다시 만들어진다. claude 파서가 tool_result·
  사용자 메시지의 이미지 블록을 store 컨텍스트의 `storeImage` 통로(런너가 건다)로 보관하고 참조만 낸다.

참조는 **내용 주소**(base64 의 sha256 앞 32자)다 — 라이브로 받은 것과 기록에서 다시 읽은 것이 같은
참조가 되어 두 번 저장하지 않고, 같은 tool 결과가 업데이트로 다시 와도 한 번만 그린다.

**바이트는 이벤트에 싣지 않는다.** base64 는 원본의 1.33배라 스크린샷 한 장이 payload
상한(`AGENT_SESSION_EVENT_PAYLOAD_MAX_CHARS`)을 넘기고, 넘기면 `{truncated:true}` 로 바뀌어
또 사라진다. 그래서 흐름은 이렇다:

1. 매니저가 바이트를 자기 scratch(`session-images/<cli>/<sessionId>/<ref>`)에 쓰고,
   이벤트는 `{image_ref, mime_type, size}` 만 싣는다. 어댑터가 URL 로 준 외부 이미지는
   `{uri}` 만 싣는다(가져올 바이트가 없다). 상한(8MB) 초과는 **버리되 조용히 버리지 않고**
   system 줄로 알린다 — 조용한 소실이 이 버그의 본질이었다.
2. **이벤트는 동기로 찍는다.** 파일 쓰기를 await 한 뒤 enqueue 하면 seq 가 늦게 매겨져
   이미지가 전사 맨 뒤로 밀린다(문장 중간의 그림이 대화 끝에 붙는다 — 회귀 테스트가 고정).
   쓰기 완료 전에 화면이 요청할 수 있으므로 `readStoredImage` 가 그 약속을 기다린다.
3. 화면은 `GET /api/agent-sessions/hosts/:managerId/:cli/sessions/:sessionId/image/:ref` 로
   바이트를 받는다. 서버는 `image` RPC 로 매니저에서 읽어 와 **저장하지 않고** 흘려보낸다.
4. 클라이언트는 그 응답을 **Blob URL** 로 바꿔 `<img>` 에 쓴다. `<img src>` 는 Authorization
   헤더를 못 보내는데, `rawResourceUrl` 처럼 토큰을 쿼리에 싣는 두 번째 인증 경로는 만들지
   않았다(로그·referrer 로 샌다) — 엔드포인트는 기존 가드(`agent_sessions.use`)를 그대로
   통과하고, Blob URL 은 컴포넌트 unmount 때 revoke 한다.

### 답에 경로로 적은 미리보기 파일 (`local_image` RPC)

위 세 출처와 달리 바이트가 **아예 오지 않는** 경우다. Codex 는 그림을 보여 줄 때 답 텍스트에
`![변경된 대장간 UI](E:/Repository/…/town_forge_weapons.png)` 처럼 **장비의 로컬 경로**를 적고,
Codex 데스크톱 앱은 그 경로를 자기 장비 파일로 읽어 그린다 — 앱이 곧 에이전트 장비라서다.
html/md 보고서(`[결과](./report.html)`, `![결과](./notes.md)` — `!` 유무와 무관)도 같은 모양으로
온다. AWB 화면은 다른 장비에 있으므로 경로만으로는 아무것도 못 그리고, 예전에는 문법 그대로 글자로 보였다.
이 갈래는 특정 CLI 분기가 아니라 assistant 텍스트 공통 처리라 codex·claude·opencode 모두에 적용된다.

1. 클라이언트 `sessions/markdownImages.ts` 가 assistant 답에서 미리보기 참조를 떼어 낸다
   (공통 `renderMarkdown` 은 이미지·파일 문법을 모른다 — 채팅방은 건드리지 않으려고 세션 전사에서만).
   이미지(`![alt](target)`)는 기존대로, html/md 로컬 경로는 `file` 세그먼트로 떼어 낸다.
   코드 펜스·인라인 코드 안은 예시라 건너뛰고, 닫히지 않은(스트리밍 중) 문법은 아직 글이다.
   에이전트가 실제로 쓰는 모양을 다 받는다 — 드라이브 문자, `\`, 공백(그대로/`%20`/`<…>`),
   `"title"`, 괄호 든 파일명, `file://`, `/E:/`. http(s) 는 그대로 `<img>`, 그 밖의 스킴은 글로 둔다.
   원격 http(s) 의 html/md 는 떼지 않는다(브라우저 직접 fetch 의 CORS·프레이밍 문제로 세션 전사 범위 밖).
2. 로컬 경로는 `GET …/sessions/:sessionId/local-image?path=&cwd=` → 서버가 `local_image` RPC
   (`{image_path, cwd}`)로 매니저에 묻는다. 상대 경로의 기준은 살아 있는 세션의 cwd, 없으면 화면이 아는 cwd.
3. 매니저(`session-local-image.ts`)는 **미리보기 파일만** 읽는다 — 이미지(확장자 화이트리스트와 매직 바이트를
   둘 다 통과해야 하고, 이름만 `.png` 인 텍스트는 거절)와 html/md(확장자 + 텍스트 확인 — NUL 바이트가
   있으면 바이너리로 보고 거절). 8MB 상한은 이미지와 같다. SVG 는 받지 않는다: Blob URL 은
   AWB origin 을 물려받으므로 새 탭에서 연 SVG 의 스크립트가 AWB origin 으로 돈다. 임의 파일 읽기
   통로가 아니다. 실패는 코드로 답하고(`not_found` 404 · `not_image` 415 · `too_large` 413 ·
   `invalid_path` 400) 화면은 그 사유와 경로를 그 자리에 그대로 보인다 — 미리보기가 조용히 빠지면
   에이전트가 무엇을 보여 주려 했는지조차 사라진다. 이 op 을 모르는 구버전 매니저는 501 `manager_outdated`.
   같은 `local_image` op·같은 에러 코드를 쓰므로, 낡은 매니저는 html/md 를 `not_image` 로 거절할 뿐 깨지지 않는다.
4. 응답은 `Cache-Control: no-store` — `image/:ref` 와 달리 내용 주소가 아니다. 같은 경로의 파일은
   다시 그려질 수 있고, Codex 앱은 경로로 캐시해 덮어쓴 스크린샷을 옛 그림으로 보여 준 버그가 있었다.
5. 화면(`SessionTranscript`): html 은 `sandbox=""` iframe(높이 480, 스크립트·같은-origin 전부 차단) +
   다운로드 링크(새 탭 Blob URL 은 샌드박스가 안 걸리므로 "새 탭에서 열기"를 두지 않는다). md 는 텍스트로
   받아 기존 XSS-safe `renderMarkdown` 으로 카드에 그린다(새 마크다운 파서 없음). 서버는 `text/html`
   응답에 `Content-Security-Policy: sandbox` 를 덧붙여 URL 직접 열기까지 막는다.

## 프롬프트에 이미지 첨부 (사용자 → 에이전트)

세션 컴포저의 📎·붙여넣기로 그림을 함께 보내면 ACP Image 블록으로 에이전트에 간다.
opencode 가 `promptCapabilities.image` 를 광고하는(1.18.34 실측) 네이티브 경로라 MCP 같은
우회가 필요 없다 — 채팅의 Claude 전용 vision 블록과 달리 세션은 CLI 분기 없이 전 CLI 에
같은 모양으로 보낸다. vision 을 모르는 모델은 어댑터·모델이 직접 거절한다(실측: opencode
비-vision 모델이 "this model doesn't support image input" 으로 답하고 턴은 산다).

1. 화면(`SessionComposer`)이 파일·붙여넣기를 받아 썸네일로 보여 준다(png/jpeg/gif/webp/bmp/avif,
   SVG 제외, 장당 8MB·최대 5장 — 서버가 최종 판정). 텍스트 없이 그림만 보내도 턴이 열린다.
2. `POST …/sessions/:sessionId/prompt { text, images: [{ base64, mime_type }] }` —
   서버는 검증만 하고 저장하지 않은 채 매니저로 흘려보낸다.
3. 매니저(`#runPrompt`)가 `[{text}, {type:'image', data, mimeType}…]` 로 `session/prompt` 를
   부른다. 깨진 1장은 턴을 죽이지 않고 `prompt_image_skipped` 로 알린다.
4. 보낸 그림은 에코로 전사에 남는다 — 받은 이미지와 같은 `image` 이벤트라 다시열기·이미지 RPC 가
   그대로 동작한다. 다시열기는 opencode `file` 파트(data URL·`file://`·상대경로, 매직 바이트
   확인)에서 같은 그림을 복원한다.

## 토큰 사용량 (`usage` 이벤트)

전사의 턴마다 붙는 작은 회색 줄이다. **출처가 두 개**이고, 둘 다 CLI 별 매핑을 거친 뒤
하나의 계약으로 정규화된다(`apps/agent-manager/src/lib/session-usage.ts`).

계약: **`input_tokens` 는 캐시 히트를 제외한 신규 입력이다.** 네이티브 값이 캐시를
포함하는 CLI 는 자기 매핑에서 빼고 넘긴다. `reasoning_tokens` 는 `output_tokens` 의
내역이라 합에 더하지 않는다. `total_tokens` 가 없으면 `input + output + cache_read +
cache_write` 로 계산한다.

| CLI | 네이티브 `input` | 매핑 위치 | 기록의 출처 |
| --- | --- | --- | --- |
| claude | 캐시 **제외**(보통 1~5) | `clis/claude/sessions.ts` `claudeUsageFromMessage` | `projects/**/<id>.jsonl` 의 `message.usage` |
| codex | 캐시 **포함**(`cached_input_tokens` 가 내역) | `clis/codex/sessions.ts` `codexUsageFromInfo` | rollout 의 `token_count` / `token_usage_record` |
| opencode | 캐시 제외 | `clis/opencode/sessions.ts` `opencodeUsageFromPart` | `part` 의 `step-finish`(`tokens`/`cost`) |
| hermes | — | 없음 | 기록 저장소 자체가 없다 — ACP 어댑터가 보고하면 그것만 쓴다 |

출처 두 개:

1. **라이브** — ACP 어댑터가 주는 값(prompt 응답의 `usage`, 또는 `session/update`
   `usage_update`). 어댑터가 **주지 않는 경우가 있다**(`claude-agent-acp` 가 그렇다).
   그래서 턴이 끝날 때 usage 가 하나도 안 왔으면 매니저가 CLI 자신의 기록 꼬리에서
   마지막 usage 를 읽어 메꾼다(`CliSessionStoreDriver.readLatestUsage`).
2. **기록(history)** — 세션을 다시 열었을 때. 각 CLI 의 파서가 턴 경계에서 한 줄씩
   낸다(한 턴의 여러 API 호출은 합쳐서 한 줄).

화면(`SessionTranscript`)은 합계를 먼저 쓰고 괄호로 내역을 붙인다 —
`36.1k tokens · (in 2 · out 346 · cache 35.8k) · ctx 15.6k/258k · $0.012`. **모르는 값은
찍지 않는다**: 예전 화면이 `total 0` 을 찍어 claude 가 "토큰을 안 쓴 것"처럼 보였고,
`in 2` 만 보여 실제로 쓴 3.6만 토큰이 화면에서 사라져 있었다(운영 보고 2026-09-26).

주의: 보드/채팅 subagent 실행의 사용량 집계(`subagents` 테이블 → 관리자 워크플로
헬스)는 **다른 경로**다(`lib/cli-adapters/*.extractUsage`). 그쪽은 아직 이 정규화를
쓰지 않아 codex 의 `input_tokens` 가 캐시를 포함한 채 저장된다 — 필드를 각각 따로
보여 주므로 화면상 오류는 없지만, 두 경로를 합산하려면 먼저 통일해야 한다.

회귀: `apps/agent-manager/test/session-usage.test.mjs`(실측 레코드 모양으로 매핑·기록·
메꿈), `apps/client/test/agent-session-transcript.test.mjs`(표시 규칙).

## agent-manager contract 변경 규칙

`agent_session_request` payload(`AgentSessionRequestPayload`, `credential_id`·`force` 포함), `/api/agent/sessions/*` 바디·credential 응답, 하트비트 `acp_session_clis`·`agent_sessions[]`(`mcp_session_ref` 포함)
는 서버와 agent-manager 가 같은 contract 를 본다 — 변경은 **같은 PR**. 버전은 손으로 올리지 않는다.
`usage` 이벤트 payload 의 키도 같은 계약이다(서버 `common/types/agent-sessions.ts` 의 주석 ↔ 매니저
`session-usage.ts` 의 `usageEventPayload`) — 키를 늘리면 화면(`sessionTranscript.logic.ts`)까지 한 PR 로 묶는다.

## 운영 메모

- 슬래시 명령은 각 CLI의 `available_commands_update` 목록으로 표시하고 `session/prompt`에 이름·인자를 그대로 보낸다.
  Claude/Codex/OpenCode/Hermes 사이에 명령을 번역하거나 공통 목록을 하드코딩하지 않는다. 터미널 전용 명령까지 지원한다는 의미는 아니다.
  `session/load` 도중 오는 명령 목록도 제어 상태로 보존한다(과거 메시지 재생만 숨김). 이후 업데이트가 빈 목록이면 기존 목록을 지운다.
  입력창 `/` 버튼 또는 `/` 입력으로 목록을 열고, ↑/↓ 및 Tab/클릭으로 선택한다. 완성된 명령은 Enter로 전송하고 Shift+Enter는 줄바꿈한다.
  실행 중에는 일반 메시지처럼 큐에 들어가므로 현재 턴이 끝난 후 실행된다. `/steer` 같은 실행 중 전용 명령을 즉시 실행하는 경로는 제공하지 않는다.
- 프롬프트 실패는 원문과 함께 ACP 코드, 제공자가 알려 준 HTTP 상태·오류 코드·문제 파라미터 및 복구 안내를 표시한다.
  OpenCode는 해당 턴이 시작된 뒤의 최신 assistant 오류만 네이티브 DB에서 읽고, 같은 모델의 마지막 성공 요청 토큰 수(캐시 포함)를 덧붙인다.
  이 수치는 실패한 요청의 크기가 아니다. `invalid parameters`/HTTP 400만으로 컨텍스트 초과를 단정하지 않으며,
  긴 대화라면 `/compact` 또는 새 세션, 새 세션에서도 실패하면 모델 설정·첨부를 확인하도록 안내한다.
  제공자가 명시한 컨텍스트 초과·인증/권한·사용량 제한·서버 오류는 각각 다른 안내를 사용한다.
  기록을 못 읽으면 ACP 정보로 표시하며, 원문 응답 본문·헤더는 전송하지 않는다. 기존 error 이벤트의 message만 확장하므로 SSE 스키마 변경은 없다.
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
- 첨부/이미지, 여러 사용자 동시 관람은 범위 밖이다. 터미널(PTY)은 별도 표면으로 갈라져 나갔다 — `docs/terminals.md`.

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

## 세션 프로세스 재시작 (`restart`)

살아 있는 세션 프로세스는 **기동 시점의 CLI 상태**를 물고 있다. 그 사이에 CLI 를
업그레이드해도 그 프로세스가 아는 모델 목록·기능은 옛 바이너리의 것이고, 다시 띄우기
전에는 바뀌지 않는다 — 실측: claude 를 2.1.281 로 올린 뒤에도 돌고 있던 세션에는 새
모델(Fable 5.1)이 끝내 나타나지 않았고, 프로세스를 죽였다 다시 띄우자 나왔다.

`POST /api/agent-sessions/hosts/:managerId/:cli/sessions/:sessionId/restart` → 서버가
`agent_session_request` 를 op `restart` 로 보내고, 매니저는 살아 있는 프로세스를 닫은 뒤
**같은 세션 id 로** 곧바로 다시 연다.

- `close` 와 다른 점은 **다음 프롬프트를 기다리지 않는다**는 것이다. 운영자가 재시작을
  누르는 이유는 보통 "방금 CLI 를 올렸으니 새 바이너리로 다시 띄워라" 이고, 그때 원하는
  것은 지금 살아 있는 새 프로세스다.
- 기록은 CLI 홈에 있으므로 **대화는 이어진다**. 죽는 것은 프로세스뿐이다.
- 서버는 요청 즉시 상태를 `starting` 으로 옮긴다 — 그 사이 프롬프트가 끼어들지 못하게
  하는 것이 `agentSessionAcceptsPrompt` 의 기존 계약이다.
- 진행 중인 턴이 있으면 끊긴다. UI 는 `starting` 일 때만 버튼을 잠근다: 턴 중이라도
  운영자가 일부러 죽이려는 것일 수 있고, 그걸 막으면 멈춘 세션을 되살릴 길이 없어진다.

### 다시 여는 op 은 개설 컨텍스트를 반드시 싣는다

`restart` 는 세션을 **다시 여는** 요청이므로 `open`/`prompt` 와 똑같이 `cwd`·`title`·
`credential_id`·`config_defaults`·`runtime_profile` 을 실어야 한다. 특히
`credential_id` 를 빠뜨리면 세션이 **운영자 로그인**으로 열리고, 바로 다음 op 가
바인딩된 credential 을 싣고 오는 순간 매니저의 `#ensureLive` 가 "binding changed" 로
판단해 또 한 번 다시 연다.

그 두 번의 열기는 **서로 다른 계정**이고, 계정이 다르면 어댑터가 광고하는 모델 목록도
다르다. 실측된 증상: restart 직후에는 Fable 5.1 이 목록에 보이는데(운영자 로그인 계정의
권한) 그것을 고르는 순간 세션이 credential 계정으로 다시 열리면서 그 모델이 사라지고
`set_config_option failed: Internal error` 로 떨어졌다. 화면에서는 "됐다가 안 되는"
것처럼 보이지만, 실제로는 **고르는 순간 계정이 바뀐 것**이다.

`close` 는 다시 열지 않으므로 이 컨텍스트가 필요 없다 — 다시 여는 op 인지가 기준이다.

`AGENT_SESSION_REQUEST_OPS` 는 서버·agent-manager 공동 contract 다. agent-manager 는
별도 패키지라 그 타입을 import 할 수 없어 유니온 사본을 두므로, op 추가는 **양쪽을 같은
PR 로** 고친다(`agent-session-runner.ts` 의 `AgentSessionRequest`).

## 모델 선택지의 출처

CLI 설정 패널과 새 세션 모달의 `model` 선택지는 두 출처를 합친다: (1) 그 host×CLI 로 세션을 열었을
때 ACP 가 보고해 캐시한 configOptions(표시 이름·현재값), (2) 호스트 하트비트의 `available_models`
(캐시에 없는 id 를 덧붙인다 — 서버 `withModelFallback`, 클라이언트 `withHostModelOption`). 갱신은
모든 모델 화면과 같은 `useHostModels()` 훅 / `POST /api/agent-manager/hosts/:id/models/refresh`
경로다. 세션을 다시 열어야만 목록이 바뀌던 동작은 없어졌다. 자세한 규칙은 `docs/cli-modules.md`
→ "모델 목록".


### OpenCode history query size and failures

OpenCode history queries project only transcript fields inside SQLite before `opencode db` serializes them. Tool metadata and attachments that the transcript does not consume must not cross this boundary; tool input/output and text are bounded for display. Message rows contribute only their role. This preserves the native database, image-part handling, tool status, usage and conversation text while avoiding large irrelevant payloads (Ralf: 691 parts, about 80 MB, mostly tool metadata, exceeded the 10-second command limit).

A requested history query that times out, cannot launch OpenCode, or returns invalid JSON reports `history_read_failed` through the existing RPC error path. It must never return a successful empty transcript or a cached title with zero events after a query failure. Listing and optional usage/error diagnostics remain best-effort.
