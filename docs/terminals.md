# Terminal (Runtime Host 셸)

Runtime Host 장비의 셸을 AWB 화면에서 직접 모는 표면이다. 단위는 **(Runtime Host,
매니저가 발급한 terminal id)** 이고, **살아 있는 터미널만 존재한다** — PTY 프로세스가 곧
터미널이라서 죽으면 그 터미널은 사라지고, 목록에도 남지 않는다.

Linux / macOS 는 일반 PTY, Windows 는 ConPTY 를 쓴다(`@lydell/node-pty`).

## Agent Session 과 무엇이 다른가

표면(호스트 → 목록 → 하나)과 배선(reverse RPC + driver SSE)은 Agent Session 을 그대로
따랐다. 다른 것은 **데이터의 수명** 하나이고, 화면 규칙이 거기서 갈린다.

| | Agent Session | Terminal |
|---|---|---|
| 단위 | (Host, CLI, CLI 네이티브 세션 id) | (Host, terminal id) |
| 원본 기록 | CLI 홈의 세션 파일(`~/.claude/projects` …) | **없다** — 살아 있는 프로세스가 전부 |
| 죽은 뒤 | 목록에 그대로 남고 다시 열 수 있다 | 목록에서 사라진다(다시 열 수 없다) |
| 다시 붙기 | history RPC 로 전문을 다시 읽는다 | attach RPC 로 **매니저가 들고 있던 스크롤백**(256KiB)만 |
| 스트림 | 트랜스크립트 이벤트(text/tool/permission …) | 원문 바이트 청크(base64, ANSI 포함) |
| 입력 | 프롬프트 한 덩어리 | 키 입력 그대로(Ctrl-C 는 `0x03`) |
| 권한 | `agent_sessions.use` | `terminals.use` (둘 다 기본 admin 전용) |

"살아 있는 것만" 이 단순한 필터가 아니라 **불변식**이다. 죽은 행을 남기면 눌러도 아무
일도 일어나지 않는 행이 되고(기록이 없으니 복원할 것도 없다), 그 순간 목록은 "지금 이
장비에서 무엇이 돌고 있는가" 라는 유일한 질문에 답하지 못하게 된다.

## 배선

- **서버 `modules/terminals`** — 상태 없는 중계자. `InstanceRegistryService`(하트비트)에서
  살아 있는 Runtime Host 와 그 장비의 셸(`terminal_shells`)을 읽고, list/open/attach 는
  `terminal_request{request_id}` → `POST /api/agent/terminals/rpc/:id` 로 왕복한다
  (agent-sessions·fs-browser 와 같은 패턴, 타임아웃 list 15s / open 30s / attach 20s).
  input/resize/close 는 답이 없는 op 이다 — 답은 출력 스트림으로 온다.
  라이브 상태(status/크기/driver)만 메모리에 두고, 매니저가 중계한 출력 청크를
  driver(마지막으로 열거나 attach 하거나 입력한 사용자)에게 SSE 로 흘린다. 다른 매니저
  키는 남의 RPC 를 풀거나 출력을 중계할 수 없다.
- **매니저 `terminal-runner.ts`** — PTY 테이블의 주인. 터미널마다 스크롤백
  (`scrollbackBytes`, 기본 256KiB)을 들고 있다가 attach 때 한 번 넘긴다. 출력은 40ms 간격
  또는 64KiB 마다 모아 보내고, 각 청크에 **절대 seq** 를 붙인다 — 화면이 스냅샷과 라이브
  청크의 중복을 거르는 근거가 이 번호다. 전송은 한 번에 하나만 돌려 순서를 지킨다.
- **매니저 `terminal-shells.ts`** — 이 장비에서 띄울 수 있는 셸 탐색. POSIX 는
  bash/zsh/fish/sh + `$SHELL`, Windows 는 pwsh / Windows PowerShell / cmd / Git Bash +
  `%COMSPEC%`. **찾지 못한 셸은 목록에 넣지 않는다** — 눌러도 열리지 않는 선택지를
  만들지 않기 위해서다.
- **클라이언트 `components/terminals`** — 호스트 목록 → 그 장비의 라이브 터미널 목록 →
  xterm.js 화면. xterm 은 그 화면에서만 동적으로 불러온다(별도 청크).

## PTY 모듈은 선택 의존성이다

`@lydell/node-pty` 는 agent-manager 의 `optionalDependencies` 다. 플랫폼별 prebuild 를
쓰므로 컴파일러가 필요 없지만, 설치에 실패한 장비(지원하지 않는 아키텍처 등)도 나머지
매니저 기능은 그대로 돌아야 한다. 그래서:

- 모듈 로드 실패는 **던지지 않고 기억만 한다**(`ptyUnavailableReason()`).
- 그 장비의 `availableShells()` 는 빈 배열이 되고, 하트비트에 `terminal_shells` 가 실리지
  않는다.
- 서버는 셸이 없는 매니저를 **터미널 호스트 목록에서 뺀다**. 그 장비로 들어오는 요청은
  409 `terminal_unsupported` 다.

구버전 매니저도 같은 경로로 접힌다(필드 자체를 보내지 않는다).

## 상태

`starting` → `live` → `exited`(exit_code) · `error`(last_error, 띄우지 못함).

**진실은 매니저 쪽 프로세스다.** 서버 메모리는 매니저의 마지막 패치에 의존하는데, 매니저가
self-update·SIGTERM 으로 재시작하면(systemd 는 cgroup 전체에 신호를 보내 PTY 가 먼저
죽는다) 그 패치가 오지 못한다. 그래서 두 경로로 되맞춘다 — agent-sessions 와 같은 규약이다.

- **list RPC 답에 없는 행은 그 자리에서 정리한다.** `starting` 만은 open RPC 가 도는 동안
  (30s) 지킨다.
- **하트비트가 살아 있는 터미널 전체를 싣는다**(`terminals: [{terminal_id, status}]`).
  서버는 매 하트비트(30초)마다 그 목록으로 메모리를 맞춘다 — 보고에 없는 살아 있는 행은
  `exited`. 매니저 인스턴스가 사라지면 그 장비의 터미널을 전부 정리한다.
- 끝난 행은 짧은 유예(서버 60초 / 매니저 30초) 뒤 메모리에서 지운다. 화면이 "Exited" 를
  한 번은 보게 하되, 목록에 남기지는 않기 위한 시간이다.

## 회수 (idle)

입력도 출력도 없이 `terminals.idle_hours`(기본 12시간) 가 지난 터미널은 매니저가 닫는다.
브라우저 탭을 닫아도 셸은 계속 돌기 때문에(그게 터미널이 기대되는 동작이다) 잊힌
프로세스가 장비에 영원히 남지 않도록 하는 뒷정리다. 출력이 있는 동안에는(예: `tail -f`)
회수되지 않는다.

## 보안

`terminals.use` 는 **기본 admin 전용**이다. 이 권한은 사실상 그 장비에서 Runtime Host 를
돌리는 사용자 권한으로 임의의 명령을 실행하는 것과 같다 — `agent_sessions.use` 보다도
넓다(세션은 CLI 의 승인 모델을 거치지만 셸은 거치지 않는다). 필요한 사용자에게만 부여한다.

- PTY 는 매니저 프로세스의 env 를 물려받고 `TERM`/`COLORTERM`/`AWB_TERMINAL=1` 만 더한다.
  AWB 의 매니저 API 키를 셸에 주입하지 **않는다** — 운영자의 셸이지 에이전트가 아니다.
- 작업 폴더가 없는 경로면 운영자 홈으로 떨어뜨린다(없는 폴더로 spawn 하면 PTY 가 통째로
  실패해 원인을 알기 어렵다).
- 한 장비당 동시 터미널은 16개(`TERMINAL_PER_HOST_MAX`, 서버·매니저 같은 값).

## agent-manager contract 변경 규칙

`terminal_request` payload(`TerminalRequestPayload`), `/api/agent/terminals/*` 바디,
하트비트 `terminal_shells` / `terminals` / `platform` 은 서버와 agent-manager 가 같은
contract 를 본다 — 변경은 **같은 PR**. `TERMINAL_REQUEST_OPS` 는 agent-manager 가 별도
패키지라 유니온 사본을 두므로, op 추가는 양쪽(`apps/server/src/common/types/terminals.ts`
와 `apps/agent-manager/src/lib/terminal-runner.ts` 의 `TerminalRequest`)을 같이 고친다.
버전은 손으로 올리지 않는다.

## 테스트

- 서버: `apps/server/test/terminals.test.mjs` — hosts(셸 없는 장비 제외) / RPC 왕복·소유권 /
  open·list·attach / input·resize·close op / 출력 중계가 driver 에게만 / 하트비트 유령 정리.
- agent-manager: `apps/agent-manager/test/terminal-runner.test.mjs` — 가짜 PTY 로
  open(기본 셸·미지원 셸 거부) / 출력 청크·절대 seq / attach 스냅샷·스크롤백 상한 /
  input·resize / 종료 시 목록에서 제거 / PTY 없는 장비의 빈 셸 목록.
- 클라이언트: `apps/client/test/terminal-list-logic.test.mjs` — 죽은 행이 목록에서 빠지는
  규칙, 제목 폴백(POSIX·Windows 경로), base64 디코드.

## 운영 메모

- 터미널이 안 보이면 그 장비의 매니저 로그에서 `terminals: shells on this host = …` 를
  본다. `(none — terminal support off)` 이면 PTY 모듈이 설치되지 않은 것이다:
  `npm i -g awb-agent-manager` 를 다시 돌려 optional dependency 를 받게 한다.
- 매니저를 재시작하면 그 장비의 터미널은 전부 사라진다. 세션과 달리 복원되지 않는다 —
  긴 작업은 `tmux` / `screen` 안에서 돌리고 그 안에 붙는 편이 안전하다.
- 같은 터미널을 여러 사람이 동시에 보지는 않는다(driver 는 한 명). 다른 사람이 열면
  출력이 그쪽으로 옮겨 간다.
