# CLI Memory (LLM CLI 메모리 파일)

Runtime Host 장비에 있는 LLM CLI 의 **메모리**를 AWB 화면에서 보고, 분석하고, 고치고, 다른 CLI·다른
장비로 옮기는 표면이다(Knowledge → Memory → **Host files**, `/memory?tab=hosts`). 메모리의 원본은 그 장비의
파일이고, AWB 는 아무것도 저장하지 않는다. 같은 화면의 Shared / Projects 탭은 AWB 가 저장하는 공용·프로젝트
메모리다(docs/skills.md "Knowledge") — 공용 메모리는 이 문서의 쓰기 경로로 호스트 CLI 파일에 동기화된다.

## CLI 마다 메모리는 어디에 있나

위치는 매니저의 CLI 모듈이 `memory` 슬라이스로 선언한다(`apps/agent-manager/src/lib/clis/<id>/memory.ts`).
소비자는 CLI 이름을 비교하지 않는다 — 새 CLI 는 슬라이스 하나만 더하면 화면에 나온다.

| CLI | 전역 | 프로젝트 | CLI 가 스스로 쌓는 것 |
|---|---|---|---|
| Claude Code | `~/.claude/CLAUDE.md`, `~/.claude/rules/*.md` | `<P>/CLAUDE.md`, `<P>/.claude/CLAUDE.md`, `<P>/CLAUDE.local.md`, `<P>/.claude/rules/*.md` | auto memory `~/.claude/projects/<key>/memory/` — `MEMORY.md` 색인(앞 **200줄**만 매 세션에 들어간다) + 주제 파일(필요할 때 읽는다) |
| Codex | `$CODEX_HOME/AGENTS.md` (`AGENTS.override.md` 가 대신한다) | `<P>/AGENTS.md`, `<P>/AGENTS.override.md` | `$CODEX_HOME/memories/` — `memory_summary.md`(매 세션) · `MEMORY.md` · `raw_memories.md` · `rollout_summaries/*.md`(필요할 때). Codex 가 다시 만든다 |
| Hermes | `$HERMES_HOME/memories/MEMORY.md`(에이전트 메모) · `USER.md`(사용자) — `\n§\n` 로 나뉜 항목, **글자 수 상한**(config.yaml) · `SOUL.md` | `<P>/.hermes.md`, `<P>/AGENTS.md` | 위 두 목록을 Hermes 가 직접 고친다 |
| OpenCode | `$XDG_CONFIG_HOME/opencode/AGENTS.md` | `<P>/AGENTS.md` | — (AGENTS.md 가 없으면 Claude 의 CLAUDE.md 를 읽는다) |
| Pi | `~/.pi/agent/AGENTS.md`, `SYSTEM.md` | `<P>/AGENTS.md` | — |
| Antigravity | `~/.gemini/GEMINI.md` | `<P>/.agent/rules/*.md` | knowledge items(`~/.gemini/antigravity*/knowledge/**`) |

`<P>` 는 **서버가 알려 준** 그 장비의 프로젝트 폴더(`ProjectHostFolder`, 사용자가 접근할 수 있는 계정의
것)다. 화면이 보낸 폴더를 매니저에 넘기지 않는다 — 그래야 임의의 폴더에 지침 파일을 만들 수 없다.

### 홈은 하나가 아니다

AWB 세션에 credential 을 묶으면 매니저는 `<AWB_AGENT_MANAGER_HOME>/session-homes/<cli>/<credential_id>` 를
그 세션의 CLI 홈으로 쓴다(docs/agent-sessions.md). 거기서 운영자 홈으로 링크하는 것은 **기록 디렉터리뿐**
(claude `projects`, codex `sessions`)이라서:

- Claude 의 auto memory 는 공유되지만 `CLAUDE.md`·rules 는 그 홈에 따로 있어야 보인다.
- Codex 는 그 홈이 곧 `CODEX_HOME` 이라 `AGENTS.md` 와 `memories/` 가 credential 마다 따로다.

그래서 스캔은 운영자 홈 + 세션 홈(credential id 이름의 디렉터리만) + Hermes 프로필(`profiles/<name>`)을
전부 본다. 같은 실제 파일(링크)은 처음 나온 홈에만 내용을 싣고 나머지는 `shared_with` 로 표시한다.
운영자의 전역 지침이 없는 세션 홈은 분석이 경고하고, **Link to operator copy** 로 그 자리를 운영자 파일에
심볼릭 링크한다(Windows 에서 링크를 못 만들면 복사하고 그렇게 알린다).

## 배선

- **매니저 `cli-memory-runner.ts`** — 상태 없는 파일 러너. `cli_memory_request` SSE 를 받아
  `POST /api/agent/cli-memory/rpc/:id` 로 답한다(큰 응답은 gzip). op: `scan` / `read` / `write` /
  `delete` / `history` / `read_version` / `restore` / `link` / `batch`. 지원 여부는 하트비트
  `manager_capabilities` 의 `cli_memory` 로 광고한다.
- **서버 `modules/cli-memory`** — 중계자. 사용자 REST `/api/cli-memory/hosts[/:managerId/(snapshot|file|
  file/delete|history[/:versionId]|restore|link|batch)]`, 권한 `cli_memory.use`(기본 admin 전용). 입력
  형식(cli id, 경로 길이, `base_hash`, 쓰기 크기)은 RPC 전에 거르고, 프로젝트 폴더를 붙이고, 세션 홈에
  credential 이름을 붙인다. 쓰기는 `LogService('Memory')` 에 남는다.
- **클라이언트 `components/memory`** — 분석·변환은 전부 화면의 순수 함수다(`memoryFormat.logic.ts`,
  `memoryAnalysis.logic.ts`, `memoryBundle.logic.ts`, `memoryState.logic.ts`). 서버에 분석 로직을 두지
  않는다 — 스냅샷이 모든 근거를 싣는다.

## 쓰기 규칙(매니저가 강제한다)

1. **선언된 위치만.** 선언된 파일이거나, 선언된 디렉터리(rules · auto memory) 바로 아래의 안전한 이름의
   새 `.md`(`[A-Za-z0-9가-힣][A-Za-z0-9가-힣._ -]*.md`). 그 밖은 `path_not_allowed`(403).
2. **동시 편집.** `base_hash` 는 내용 sha256 앞 16자다. 문자열이면 "지금 이 내용이어야", `null` 이면 "없어야",
   생략하면 확인하지 않는다. CLI 가 그 사이 자기 메모리를 고쳤으면 `conflict`(409, `detail.current_hash`) —
   화면은 비교 / 다시 읽기 / 덮어쓰기를 고르게 한다.
3. **백업.** 모든 쓰기·지우기·되돌리기·링크 직전 내용을 `<AWB_AGENT_MANAGER_HOME>/memory-backups/<cli>/
   <sha(path)>/` 에 떠 둔다(파일당 최근 30개, 0600). 같은 내용을 연달아 뜨지 않는다. index 에 그 파일의
   선언을 함께 적어, **지운 뒤 선언에서 빠진 파일도** History 에서 되돌릴 수 있다. CLI 가 직접 고친 것은
   버전이 없다.
4. **원자적 교체.** 같은 디렉터리의 임시 파일 → rename. 심볼릭 링크는 링크가 아니라 대상을 바꾼다(세션 홈
   링크가 끊어지지 않게). 대상이 메모리 위치 밖이면 따라가 쓰지 않는다. 지우기는 링크면 링크만 지운다.
5. **link** 는 세션·프로필 홈의 자리만, 운영자 홈 안의 같은 범위·같은 종류 파일로만 잇는다.

## 분석

화면이 스냅샷에서 계산한다. 지적은 "실제로 무엇이 일어나는가" 를 말한다:

| 지적 | 근거 |
|---|---|
| 비밀(critical) | API 키 · 토큰 · 개인 키 · password 패턴. 메모리는 매 세션 프롬프트로 붙여진다. 값은 가려서 보인다 |
| Codex 잘림(critical) | 프로젝트 지침 합이 `project_doc_max_bytes`(기본 32KiB)를 넘으면 뒷부분이 조용히 버려진다 |
| 색인 200줄(warning) | Claude 는 auto memory `MEMORY.md` 앞 200줄만 읽는다 |
| 색인 불일치(warning, 고침) | 없는 파일을 가리키는 줄 / 색인에 없는 주제 파일(Claude 가 존재를 모른다) |
| Hermes 상한 · 형식(critical/warning, 고침) | 상한을 넘으면 새 메모를 거부하고, `§` 목록으로 되돌아가지 않는 파일은 drift guard 가 쓰기를 거부한다 |
| 매 세션 비용(warning ≥ 8k, critical ≥ 20k 토큰) | 전역 + 프로젝트의 always 파일 + 색인 앞부분. 토큰은 추정치 |
| 세션 홈 누락(warning, 고침) | credential 세션이 운영자의 전역 지침을 못 본다 |
| 중복(warning) | 파일 안 반복 줄(고침), 파일 사이 같은 문단 |
| CLI 간 차이(info, 적용) | 다른 CLI 전역 지침에만 있는 문단 — 대상 CLI 마다 하나 |
| 없는 경로 · 상대 날짜 · frontmatter · `[[링크]]` · 오래된 주제 · override(info) | 매니저가 내용 속 경로를 장비에서 확인한다(`/api/...` 같은 경로는 첫 구간이 루트에 없으면 경로로 보지 않는다) |

같은 파일(여러 CLI 가 읽는 프로젝트 `AGENTS.md`)의 내용 지적은 한 번만 내고 `also_clis` 로 묶는다.
점수는 100 − (critical 15 · warning 5 · info 1). **Fix N safe issues** 는 내용을 잃지 않는 수정(색인
맞추기 · 링크 · 반복 줄 · 형식 정리)만 한 번에 한다. **Optimize with agent** 는 그 CLI 의 Agent Session 을
열어 분석 결과와 형식 규칙을 담은 지시를 보낸다 — 무엇이 낡았는지의 판단은 CLI 자신에게 맡긴다.

## 적용 · Import / Export

- **Apply to…** — 한 파일을 같은 장비의 다른 CLI 나 다른 Runtime Host 로. markdown 대상은 **관리 블록**
  (`<!-- awb-memory:begin from:<host>:<cli>:<file> -->` … `end`)으로 넣어 대상의 나머지를 건드리지 않고,
  다시 적용하면 그 블록만 바뀐다. Hermes 대상은 항목으로 바꿔 없는 것만 더한다. project 파일은 같은 project
  (id 로 대응)의 그 장비 폴더로 간다.
- **Export** — JSON 번들(`format: awb-cli-memory`, `version: 1`) 또는 읽기용 markdown. 번들은 절대 경로가
  아니라 **위치**로 적는다: `home`(CLI 홈 기준) / `project`(project id + 폴더 기준) / `claude_auto`(project
  id + 파일 이름 — key 는 대상 장비의 폴더로 다시 계산). 그래서 경로가 다른 장비(Windows 포함)로도 옮겨진다.
- **Import** — 계획(create / update / same / unmapped)을 먼저 보이고, 이미 있는 파일은 건너뛰기 · 덮어쓰기
  (이전 내용은 History) · 합치기(관리 블록 / 새 항목) 중 고른다. 그 장비의 선언 위치가 아니면 unmapped 로
  남기고 쓰지 않는다 — 매니저도 같은 판정을 한 번 더 한다. `..` 이 든 위치는 파싱 단계에서 버린다.

## agent-manager contract 변경 규칙

`cli_memory_request` payload(`CliMemoryRequestPayload`), `/api/agent/cli-memory/rpc` 바디, 하트비트
`manager_capabilities` 의 `cli_memory` 는 server·agent-manager 공동 contract — 변경은 같은 PR.
`MEMORY_REQUEST_OPS`(서버 `common/types/cli-memory.ts`)와 매니저 `MemoryRequest.op` 유니온은 사본이므로
op 추가는 양쪽을 같이 고친다. 클라이언트 `types.ts` 의 Memory* 타입도 미러다. 버전은 손으로 올리지 않는다.

## 테스트

- agent-manager `test/cli-memory-runner.test.mjs` — 실제 슬라이스(claude/codex/hermes)를 임시 홈에서: scan
  (세션 홈 공유 · conditional rules · auto memory key → 프로젝트 · 경로 검사 · Codex/Hermes 설정), 쓰기 경계,
  base_hash, 백업/복원(지운 파일 포함), 링크 쓰기·link op·링크 탈출 거부, batch, 오류 코드 전달.
- server `test/cli-memory.test.mjs` — 권한, 구버전 매니저, 프로젝트 폴더·credential 이름, 입력 검사가 RPC
  전에, conflict 409 + 현재 해시, 남의 RPC 거부, batch 중계.
- client `test/cli-memory-logic.test.mjs` — Hermes 직렬화(hermes-agent 와 같은 규칙), frontmatter 편집, 관리 블록
  멱등, 색인 재구성, diff, 분석 지적들, 번들 왕복(Windows 대상 · project id · Claude key), 적용.
