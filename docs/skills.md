# Skills

AWB의 skill은 **거버넌스가 붙은 불변 프롬프트 자산**이다. 에이전트가 런타임에
읽는 텍스트이므로, 누가 쓸 수 있는지 / 언제 바뀌는지 / 실행 중인 런에 어떤 영향을
주는지가 전부 명시적으로 고정되어 있다.

## 스코프

`docs/catalog-scopes.md`의 카탈로그 모델을 그대로 따른다.

| Scope | `workspace_id` | 우선순위 |
| --- | --- | --- |
| Global | `NULL` | 1 (fallback) |
| Workspace | workspace UUID | 2 (global을 shadow) |

- Workspace에서 조회하면 **global + 해당 workspace** 행이 함께 나온다.
- 같은 `slug`가 양쪽에 있으면 workspace가 이긴다(Function의 key와 같은 규칙).
- 관리 UI는 `?include_shadowed=1` 로 가려진 global 행까지 받아
  `shadowed: true` 로 표시한다. 이게 없으면 "built-in이 왜 안 먹지"에 답할 수 없다.

### 쓰기 권한

| 대상 | Workspace 사용자 (`MANAGE_AGENTS`) | Admin (`ADMIN_ACCESS`) |
| --- | --- | --- |
| Workspace skill | 생성 / publish / assign / quarantine | 동일 |
| Global skill | **읽기 + assign 만** | 생성 / publish / quarantine |

Global 정의는 모든 workspace가 상속하므로, 한 테넌트가 전 테넌트의 정의를 바꿀 수
없어야 한다. Workspace 라우트에서 global에 publish/quarantine을 시도하면 403
(`skill_scope_readonly`)이고, 안내는 "fork 해서 쓰라"이다.

### Fork

`POST /api/workspaces/:wsId/skills/:skillId/fork` 는 global skill을 같은 slug로
workspace에 복사한다. 그 순간부터 fork가 shadow하고, **그 아래의 global은 업스트림
갱신을 계속 받는다.** global을 직접 고치는 것이 아니라 이게 커스터마이즈 경로다.

## 불변성과 런 고정

- `SkillVersion`은 불변이다. 변경은 **새 버전 append**이며 기존 버전을 수정하거나
  삭제하지 않는다.
- `AgentSkillAssignment`는 특정 `skill_version_id`를 **핀** 한다.
- 런 시작 시 `RunSkillSnapshot`이 manifest를 고정(pinned → locked)한다.

따라서 **어떤 동기화도 이미 배정된 에이전트가 읽는 내용을 바꾸지 못한다.** 새
버전을 쓰려면 운영자가 assignment를 다시 가리켜야 한다.

## Global skill을 채우는 두 소스

### 1. 내장 팩 (`skills/`) — 기본, 네트워크 불필요

AWB 저장소 안의 `skills/<category>/<slug>/SKILL.md`. 서버 부팅 때
`BuiltinSkillPackService`가 global 스코프로 시드한다. 신규 설치가 네트워크도
운영자 조작도 없이 바로 쓸 만한 skill 세트를 갖는 이유다.

**"항상 최신"은 서버를 업그레이드하면 따라오는 성질이지, 부팅 시 원격을 당겨오는
동작이 아니다.** 부팅 경로에 외부 의존이 없다.

| 환경변수 | 의미 |
| --- | --- |
| `AWB_BUILTIN_SKILLS_DIR` | 팩 디렉터리 override. 운영자가 **자기 git 체크아웃**을 마운트해 직접 관리할 때 사용 |
| `AWB_SKIP_BUILTIN_SKILLS=1` | 시드 완전 비활성화 |

Docker 이미지는 `COPY skills ./skills` 로 팩을 함께 담는다.

### 2. Tap (외부 git 레지스트리) — 옵트인

`SkillTap` = `{ repo_url, ref, path, allowed_licenses }`. Hermes skill hub의 tap
모델(`~/.hermes/skills/.hub/taps.json`)과 같은 형태이고, 같은 디렉터리 레이아웃을
쓰기 때문에 **다른 런타임용으로 배포된 저장소를 그대로 소비**할 수 있다.

- 신규 tap은 `enabled = 0`으로 생성되고 **부팅 시 절대 동기화하지 않는다.** skill
  본문은 곧 에이전트 프롬프트이므로, 서드파티 저장소에서 당겨오는 것은 부팅 부수효과가
  아니라 운영자의 명시적 결정이어야 한다.
- `dry_run` 으로 무엇이 바뀌는지 먼저 본다.
- `allowed_licenses`(기본 `["MIT","Apache-2.0"]`)에 없는 `license:` frontmatter는
  **건너뛰고 보고**한다. 라이선스가 섞인 저장소(Hermes hub가 그렇다 — MIT/Apache와
  proprietary가 공존)에서 재배포 가능한 부분만 가져오기 위한 장치다.
- URL은 `https://` 만 허용하고, userinfo(토큰) 포함을 거부하며, 공용 SSRF 가드를
  통과해야 한다(localhost/사설망 금지). `ssh://`·`git@` 는 서버에 키를 두어야 하므로
  지원하지 않는다.
- tap을 삭제해도 **이미 동기화된 skill은 남긴다.** 지우면 그 버전을 배정받은
  에이전트의 정의가 사라진다. 내용을 없애려면 quarantine 한다.

## 동기화 조정 규칙 (`SkillSyncService`)

두 소스가 공유한다 — 규칙이 갈라지면 안 되기 때문이다.

| 상황 | 동작 |
| --- | --- |
| 같은 digest | 아무것도 쓰지 않음 (**멱등** — 매 부팅 재시드가 공짜인 이유) |
| 내용 변경 | **새 버전 append**. 기존 버전 보존 |
| digest 되돌림(revert) | 기존 버전 재사용 — `(skill_id, digest)` unique 충돌 회피 |
| `quarantined` | **건너뜀.** quarantine은 운영자 거부권이고, 업스트림 push가 이를 되살리면 안 된다 |
| 다른 소스가 소유한 slug | **conflict 보고 후 무시.** tap이 built-in이나 손으로 만든 global의 slug를 가로챌 수 없다 |
| `source_kind: 'local'` | 영구히 동기화 대상 아님 |

Workspace skill은 어떤 경우에도 건드리지 않는다.

## SKILL.md 형식

```
skills/<category>/<slug>/SKILL.md      ← 본문 (필수)
skills/<category>/<slug>/<anything>    ← 지원 파일 (선택)
```

디렉터리 이름이 slug이며 `[a-z0-9][a-z0-9-]{0,63}` 를 만족해야 한다. Claude Code
(`.claude/skills/`), Hermes hub, Warp 번들 skill이 모두 쓰는 레이아웃을 **의도적으로**
따른다 — 이게 tap 호환의 근거다.

frontmatter에서 읽는 값은 `name` / `description` / `version` / `author` / `license`
다섯 개 스칼라뿐이다. 나머지(`platforms:`, `metadata:` …)는 거부하지 않고 무시한다.

**YAML 파서를 쓰지 않는다.** 서드파티 저장소의 frontmatter를 읽자고 alias·merge
key·custom tag가 포함된 임의 YAML을 실행할 이유가 없다. 최상위 스칼라만 정규식으로
읽는다.

로드된 내용은 REST/MCP 쓰기 경로와 **같은** `canonicalizeSkillContent()`를 통과하므로
크기 상한과 시크릿 스캔을 우회할 수 없다.

## 관련 코드

| 관심사 | 위치 |
| --- | --- |
| 스코프 헬퍼 | `apps/server/src/modules/skills/skill-scope.ts` |
| 디스크 트리 로더 | `.../skill-source.ts` |
| 조정 규칙 | `.../skill-sync.service.ts` |
| 내장 팩 시드 | `.../builtin-skill-pack.service.ts` |
| tap 동기화 | `.../skill-tap.service.ts` |
| Workspace REST | `.../skills.controller.ts` |
| Admin REST | `.../skill-registry.controller.ts` |
| 런 manifest 고정 | `.../run-skill-snapshot.service.ts` |
| 마이그레이션 | `apps/server/src/database/migrations/1760000000077-GlobalSkillScope.ts` |

## 테스트

```bash
npm run build
cd apps/server
node test/run-suite.mjs test/skill-global-scope.test.mjs \
  test/skill-lifecycle.test.mjs test/run-skill-snapshot.test.mjs
# Postgres partial unique index (sql.js로는 검증 불가)
npm run test:qa:pg        # CI job: postgres-dialect-matrix
```
