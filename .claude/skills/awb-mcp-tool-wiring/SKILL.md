---
name: awb-mcp-tool-wiring
description: Checklist for adding a new MCP tool under apps/server/src/modules/mcp/tools/*-tools.ts — registration, the TOOL_AUTHZ_TABLE tier decision, service-layer ownership checks, description authoring, agent-manager ticket-ref-capture classification, and which tests to rerun. Use whenever a new server.tool(...) call is added, or an existing tool's authorization is revisited — skipping the tier-classification step ships a tool that always returns "Unauthorized", regardless of caller; skipping the capture-classification step ships one whose card silently vanishes from chat instead.
---

# MCP Tool Wiring Checklist

새 MCP 도구 하나를 추가하는 데 필요한 전부다. 특히 (b)를 빠뜨리면 그 도구는 **어떤 caller로도 절대 성공하지 않는다** — 그것도 빌드는 green인 채로, 조용히.

## 왜 이게 필요한가

`resolveAuthzTier`(`apps/server/src/modules/mcp/shared/tool-authz-gate.ts:281-286`)는 모든 `.tool()` 등록을 가로채 네 갈래로 분류한다:

1. `TOOL_AUTHZ_TABLE`에 있으면 → 그 티어(`'full'`/`'caller'`) 강제
2. 없지만 이름이 `delete_*`/`revoke_*` 패턴이면 → `'caller'` (fallback)
3. 그 외, `KNOWN_EXISTING_TOOLS`(게이트 작성 시점 **동결 스냅샷**)에 있으면 → 게이트 미적용(통과)
4. **어디에도 없으면 → `UNCLASSIFIED_TIER = 'deny'`, caller/scope 무관 무조건 거부**

새 도구를 등록만 하고 분류(b)를 빠뜨리면 4번 분기에 떨어진다. `test/mcp-tool-authz.test.mjs`의 완전성 가드가 이걸 CI에서 잡아주지만(아래 (f)), 그 실패를 무시하고 넘어가면 "런타임에서 caller/scope와 무관하게 무조건 deny"인 도구가 그대로 배포될 수 있다.

## 7-touch-point 체크리스트

| # | Touch point | 파일 | 빠뜨렸을 때 증상 |
|---|---|---|---|
| a | 도구 등록 | `apps/server/src/modules/mcp/tools/<domain>-tools.ts` | 도구 자체가 존재하지 않음 |
| b | authz 티어 부여 | `.../shared/tool-authz-gate.ts` → `TOOL_AUTHZ_TABLE` | 항상 `"Unauthorized: this tool is not classified"` |
| c | 티어 값 판단 | 위와 동일, `'full'`/`'caller'` 중 선택 | 너무 세면 정상 caller도 403, 너무 느슨하면 하한선이 무의미 |
| d | 소유권 검사 | 핸들러 또는 그 서비스 (게이트가 아님) | 게이트로는 표현 불가 — 빠뜨리면 아무나 남의 리소스 조작 |
| e | description 명시 | 같은 `server.tool()` 호출의 2번째 인자 | 호출자가 403을 실제로 받아보고서야 권한 경계를 앎 |
| f | 테스트 재실행 | `apps/server/test/mcp-tool-authz.test.mjs` 등 | 회귀를 CI가 못 잡음 |
| g | agent-manager 카드-캡처 분류 | `apps/agent-manager/src/lib/ticket-ref-capture.ts` → `TICKET_ACTION_TOOLS`/`TICKET_TOOL_EXCLUSIONS` | 도구 호출이 채팅에 카드로 조용히 드롭됨(authz와 무관한 별도 가드) |

### (a) `*-tools.ts` 등록

`apps/server/src/modules/mcp/tools/`에 `<domain>-tools.ts`를 새로 만들거나 기존 파일에 추가한다. `register<Domain>Tools(server, ctx)`를 export하면 `tools/index.ts`의 `discoverToolModules()`가 파일명 컨벤션(`/^(.+-tools)\.(ts|js)$/`)만으로 자동 발견한다 — `registerAllTools` 자체는 수정할 필요 없다.

```ts
import { z } from 'zod';
import { ok, err } from '../shared/helpers';
import { getCallerAgent } from '../shared/session-auth';
import type { ToolContext } from './context';

export function registerFooTools(server: McpServer, ctx: ToolContext): void {
  server.tool(
    'do_the_thing',                     // snake_case, /[a-zA-Z0-9_]+/ — (f)의 완전성 가드가 이 패턴으로 스캔한다
    'What it does, who may call it, what it touches.',   // (e) 참고
    { thing_id: z.string().describe('...') },
    async ({ thing_id }, extra) => {
      const caller = getCallerAgent(extra);
      if (!caller) return err('this tool requires an authenticated agent session');
      // ... 실제 로직 + (d) 소유권 검사 ...
      return ok({ /* ... */ });
    },
  );
}
```

한 줄로 등록(`server.tool('name', 'desc', {}, handler);` 전부 한 줄)해도 여러 줄로 나눠도 (f)의 스캐너는 동일하게 잡는다 — 다만 도구 이름은 반드시 `['"]`로 감싼 `[a-zA-Z0-9_]+` 문자열 리터럴이어야 한다(변수로 이름을 조립하지 말 것 — 스캐너가 정적 텍스트만 읽는다).

### (b) `TOOL_AUTHZ_TABLE`에 명시 티어 부여

새 도구 이름을 `tool-authz-gate.ts`의 `TOOL_AUTHZ_TABLE`에 `'full'` 또는 `'caller'`로 추가한다.

**`KNOWN_EXISTING_TOOLS`에 추가하지 마라.** 그 Set은 게이트가 작성된 시점에 이미 존재하던 도구의 **동결 스냅샷**이라고 파일 자체 docstring(`tool-authz-gate.ts:166-185`)에 명시돼 있다 — 신규 등록의 집이 아니다. 거기 넣는 건 "안전하다고 판단함"이 아니라 "판단 자체를 안 함"과 같다.

### (c) 티어 판단 기준

티어는 **위험도 등급이 아니라 "핸들러가 이미 스스로 강제하는 것의 하한선"**이다. 정하는 절차:

1. 핸들러(와 그 서비스)의 실제 소스를 직접 읽는다 — 테스트나 추측이 아니라 소스 그 자체로.
2. 핸들러가 **무조건** `requireFullScopeCaller`(또는 그걸 거치는 헬퍼)를 호출한다 → `'full'`.
3. 핸들러의 진짜 인가가 handler/service 내부의 identity/ownership 필터이고, 게이트는 그저 "세션리스 caller만 거른다"는 역할이면 → `'caller'`.
4. 기존 로직이 이미 더 좁은 스코프의 caller를 의도적으로 허용하고 있다면(예: write-스코프 키가 자기 몫의 read-스코프 키를 발급하는 경우) `'full'`을 선택해 그 기존 동작을 깨지 마라 — 게이트는 기존 caller/scope 로직 위에 얹는 **추가** 방어선이지, 그걸 대체하는 재설계가 아니다.

### (d) 소유권 검사는 서비스 레이어에 남긴다

게이트가 표현할 수 있는 건 정적으로 딱 두 단계뿐이다 — `'full'`(DB-backed full-scope caller) / `'caller'`(세션리스만 아니면 통과). **"이 caller가 이 특정 리소스의 소유자인가"는 게이트가 원천적으로 표현하지 못한다** — tool-name→tier 매핑은 호출마다 달라지는 리소스 컨텍스트(어떤 team_id, 어떤 mission_id)를 모른다.

실례 — `create_orchestration_mission`(`orchestration-tools.ts:527-534`): 게이트 티어는 `'caller'`(세션리스만 거름). 진짜 소유권 검사는 핸들러 안에서 직접:

```ts
const team = await teamSvc.requireTeamById(args.team_id);
if (!team.orchestrator_agent_id || team.orchestrator_agent_id !== agentId) {
  return err('you are not the orchestrator of this team — ...', { status: 403 });
}
```

새 도구가 특정 리소스(팀/미션/티켓 등)에 묶인다면 이 패턴을 그대로 따라라 — 게이트 티어를 올려서 때우려 하지 마라(그러면 정상 caller까지 막힌다).

### (e) 도구 description에 인가 경계·생성 주체 명시

`server.tool()`의 2번째 인자(description)는 MCP `tools/list`로 호출자에게 그대로 노출된다. 다음을 평문으로 박아라:

- 누가 성공적으로 호출할 수 있는지 (예: `"only the agent named as that team's orchestrator may call this"`)
- 이 도구가 다루는 리소스가 어디서/누구에 의해 생성되는지, 이 도구가 그걸 만들 수 없다면 그것도 명시 (예: `"Teams and their rosters are authored by humans in the AWB UI — this tool only reads them."`)

목적: 호출자가 403을 실제로 받아보기 전에 권한 경계를 알게 한다. `orchestration-tools.ts`의 `list_orchestration_teams` / `create_orchestration_mission` description이 실례.

### (f) 관련 테스트 재실행 목록

- **`apps/server/test/mcp-tool-authz.test.mjs`** — 필수. authz 게이트 동작 + 완전성 가드(새 도구가 `TOOL_AUTHZ_TABLE`/`KNOWN_EXISTING_TOOLS`/destructive-패턴 중 하나에 반드시 걸리는지) 둘 다 여기 있다. **먼저 빌드**해야 한다 — 이 테스트는 소스가 아니라 `../dist/...`(컴파일된 산출물)를 import한다:
  ```sh
  cd apps/server && npm run build && node --test --test-force-exit test/mcp-tool-authz.test.mjs
  ```
- 새 `*.test.mjs` **파일**을 추가했다면(기존 파일에 `it()`만 추가한 게 아니라) → `apps/server/test/test-registration-completeness.test.mjs`도 통과해야 한다. `apps/server/package.json`의 `test`(또는 `pretest`) 스크립트 인자 목록에 파일 경로를 직접 추가하지 않으면 `npm test`가 그 파일을 영원히 실행하지 않는다 — 등록을 빠뜨리면 이 가드 자체가 실패로 알려준다.
- 도구가 속한 도메인에 전용 테스트 파일이 있다면 그것도 같이 실행(예: orchestration 계열이면 `orchestration-plan-dag.test.mjs`).
- **`apps/agent-manager/test/tool-surface-parity.test.mjs`** — 필수, (g) 참고. authz와 별개인 agent-manager 카드-캡처 완전성 가드라 위 authz 테스트를 통과해도 이건 따로 돌려야 한다. 마찬가지로 **먼저 빌드**해야 한다.

### (g) agent-manager 카드-캡처 분류 (authz와 무관한 별도 가드)

`server.tool()`로 새 도구를 등록했다면 **도구 종류와 무관하게** `apps/agent-manager/src/lib/ticket-ref-capture.ts`에서 반드시 분류한다 — `TICKET_ACTION_TOOLS`(채팅에 카드로 캡처) 또는 `TICKET_TOOL_EXCLUSIONS`(캡처 제외, `read`/`non-ticket`/`orchestration` 등 기존 카테고리 중 하나로 사유 명시). **티켓을 만들거나 바꾸지 않는 도구도 예외가 아니다** — EXCLUDE에 사유를 달아 분류하는 것 자체가 "이 도구는 해당 없음"의 정식 표현이고, 분류 자체를 건너뛰는 것과는 다르다(실제로 전체 등록 도구의 대다수가 EXCLUDE다). (a)-(f)는 전부 **서버 authz 가드**고 이건 **agent-manager 쪽 카드-캡처 완전성 가드**로 완전히 별개다 — 도구가 (b)/(c)에서 authz 티어를 정상적으로 받아도 여기서 빠지면 그 도구 호출 결과가 채팅에서 카드로 조용히 드롭된다.

`apps/agent-manager/test/tool-surface-parity.test.mjs`가 **서버에 등록된 도구 전체**와 `classifiedToolNames()`(EMIT ∪ BATCH ∪ REJECT ∪ ARTIFACT ∪ AGENT ∪ BOARD ∪ EXCLUDE)가 정확히 일치하는지 검사해 미분류 도구를 CI에서 잡는다 — "티켓 관련 도구만 분류하면 된다"는 판단은 이 가드의 실제 조건과 다르다. 실제 사례 — 티켓을 전혀 만들거나 바꾸지 않는 신규 orchestration 도구 3종(`create_orchestration_mission`/`list_orchestration_missions`/`list_orchestration_teams`, 셋 다 결국 `TICKET_TOOL_EXCLUSIONS`의 `orchestration` 카테고리로 분류)조차 이 분류를 빠뜨려 CI가 7회 연속 red였다(#[ticket:c13db9e7-fec3-42e8-a7ef-36f784f2be8a|CI red: parnmanas/ai-workflow-board@main — CI]).

이 테스트는 소스가 아니라 `dist/lib/ticket-ref-capture.js`(컴파일된 산출물)를 import하므로 **먼저 빌드**해야 한다:

```sh
cd apps/agent-manager && npm run build && node --test --test-force-exit test/tool-surface-parity.test.mjs
```

## 컴패니언 stdio 플러그인 sync — 불필요 (단정)

새 MCP 도구를 추가/삭제/개명해도 별개 저장소 `claude-plugins`(subpath `ai-workflow-board/`)의 `plugin.json` 버전 범프나 `proxy.mjs` 수정은 **필요 없다.**

근거:

- 이 저장소 자체의 `CLAUDE.md`가 2026-07-28 커밋 `9c49910b`("refactor: remove obsolete companion plugin integration")에서 "Plugin version sync" 절차 조항, "Claude Plugin (stdio MCP forwarder)" 아키텍처 섹션, `awb-plugin-sync` 스킬 항목을 전부 의도적으로 삭제했다 — 더는 이 저장소 컨트리뷰션 절차의 일부가 아니다.
- 직접 확인(2026-08-18, `claude-plugins@main`, `ai-workflow-board/proxy.mjs`): 도구 이름을 하나도 하드코딩하지 않는 순수 stdio↔HTTP 포워더다. `initialize` 핸드셰이크만 가로채고 그 외 모든 JSON-RPC 메시지(`tools/list`, `tools/call` 포함)는 `McpForwardSession.forward()`로 그대로 위임한다 — 서버 쪽 도구 추가/삭제는 MCP 표준 capability discovery로 자동 반영되며 proxy.mjs가 알아야 할 것 자체가 없다.
- 따라서 #[ticket:b7127aae-0858-4d35-90df-828221c40cf5|오케스트레이션 미션 생성/팀 구성 MCP 도구 부재]가 추가한 3종(`list_orchestration_teams`, `list_orchestration_missions`, `create_orchestration_mission`)에 대한 소급 sync도 불필요하다 — 이미 아무 조치 없이 정상 동작 중이다.
- (참고) `claude-plugins` 저장소 자체가 사라진 건 아니다 — archived 상태가 아니고 `ai-workflow-board` 플러그인은 v0.40.0으로 살아있다. "저장소가 없다"가 아니라 "MCP 도구 표면 변경이라는 이 변경 종류 한정으로, 그 저장소를 손댈 이유가 구조적으로 없다"는 결론이다. proxy.mjs 자체의 프로토콜 처리 로직(포워딩 방식 등)을 바꾸는 상황이면 이건 이 스킬의 범위 밖이니 별도로 판단하라.

## Smell test

- 새 도구를 호출했는데 caller/scope와 무관하게 항상 `"Unauthorized: this tool is not classified"` → (b) 빠뜨림.
- 정상 권한의 caller가 403 → (c) 티어를 너무 세게 잡았거나, 원래 (d)에 있어야 할 소유권 검사가 게이트 티어로 잘못 새어 들어감.
- 아무나 남의 팀/미션/티켓을 조작할 수 있음 → (d) 빠뜨림. 게이트 티어를 올리는 걸로 때우려 하지 마라 — 위 항목과 정반대 실수다.
- `npm test`가 새 테스트 파일을 조용히 건너뜀 → (f)의 `test-registration-completeness.test.mjs` 참고.
- 도구 호출은 성공(200)했는데 채팅에 카드가 안 뜸 → (g) 빠뜨림. authz 문제가 아니므로 (b)/(c)를 아무리 봐도 원인이 안 보인다 — `ticket-ref-capture.ts`의 두 분류 테이블부터 확인.

## Related

- `.claude/skills/awb-agent-display-name/SKILL.md` — if the tool returns, stamps, or emits an agent name (`actor_name`, `agent_name`, `assignee_name`, `pending_set_by`, …), it must be the canonical `<Manager>/<Agent>` display, resolved through `apps/server/src/utils/agent-name.ts`. A bare `agent.name` is a bug.
