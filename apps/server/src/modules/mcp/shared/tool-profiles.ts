/**
 * Tool profile — opt-in reduced MCP tool surface for small-context backends.
 *
 * 티켓 ee26302d(faa32380 감사 후속). 205개 tool 전체의 tools/list wire size가
 * 253,638 bytes(≈57,000~67,500 실제 BPE 토큰, 소스 파일 apps/server/test/
 * mcp-tool-schema-budget.test.mjs 참고)인데, 65,536 토큰 같은 소형 컨텍스트
 * 백엔드에서는 이 raw 크기 하나만으로 여유가 거의 없다. 이 모듈은 caller가
 * `X-AWB-Tool-Profile: compact` 헤더로 옵트인했을 때만 축소된 표면을 보낸다.
 *
 * 설계 — omit (당초 "이름 보존 stub" 계획에서 실측 후 전환, 근거는 아래).
 * allowlist 밖 tool은 이 profile의 McpServer에 아예 등록되지 않는다 — SDK의
 * `tools/list`에도, `tools/call` 라우팅에도 존재하지 않는다.
 *
 * stub → omit 전환 근거 (실측, ticket ee26302d 코멘트에도 동일 수치 기록):
 * 처음 설계는 allowlist 밖 tool을 빼지 않고 "이름 보존 + 1줄 description +
 * 빈 schema + 에러 핸들러" stub으로 등록해 60,000 bytes 이하를 노렸다. 실제로
 * 등록해 측정하니 compact tools/list가 **100,704 bytes**였다 — SDK가 tool마다
 * 무조건 붙이는 고정 오버헤드(`inputSchema.$schema`, `execution.taskSupport`
 * 필드 등)만으로 빈 description stub 하나가 최소 ~180 bytes이고, 이걸 186개
 * (205 - allowlist 19개) 곱하면 그것만으로 33,480 bytes — 여기에 allowlist
 * 19개 tool 자체의 실측 크기 37,608 bytes(update_ticket류처럼 필드가 많은
 * ticket-workflow tool 위주라 205개 전체 평균 1,237B보다 60% 무겁다)를
 * 더하면 stub description을 완전히 비워도 최소 71,088 bytes로, 60,000
 * 목표를 구조적으로 달성할 수 없다(콘텐츠 튜닝 문제가 아니라 SDK 직렬화
 * 오버헤드 문제). 티켓의 명시적 2단계 조건("stub으로 목표 미달이면 omit으로
 * 전환하고 근거를 남길 것")에 따라 omit으로 전환 — 실측 37,608 bytes(≈85%
 * 감소, 60,000 목표를 여유 있게 하회)로 확정. apps/server/test/
 * mcp-tool-schema-budget.test.mjs가 이 수치를 회귀 가드로 고정한다.
 *
 * omit의 트레이드오프(문서화, 나중에 stub으로 되돌릴 근거 필요시 참고):
 *   - 완전성 가드(qa-flows/mcp-tools-surface.test.mjs의 EXPECTED_TOOLS,
 *     mcp-tool-authz.test.mjs의 KNOWN_EXISTING_TOOLS)는 영향 없음 — 둘 다
 *     기본 profile('full')로 뜬 서버를 검사하고, compact는 옵트인 헤더를
 *     보낸 세션에만 적용되므로 이 가드들이 도는 경로 자체를 타지 않는다.
 *   - allowlist 밖 이름을 호출하면 AWB 핸들러가 아니라 MCP SDK 자체가
 *     "Unknown tool" 류 프로토콜 에러로 응답한다(이 모듈의 코드가 개입할
 *     지점이 없다 — 애초에 등록이 없으므로). stub 설계가 주려던 "이 세션의
 *     compact profile에는 없다"는 AWB 문구는 없다 — 모델 입장에선 존재하지
 *     않는 tool 이름을 부른 것과 구분되지 않는다.
 *   - 그래도 관측성은 남는다: mcp.controller.ts가 모든 /mcp POST 요청을
 *     이미 tool 이름이 담긴 bodyPreview와 함께 로그로 남기므로(mcpLog 호출,
 *     tools/call 포함), allowlist 밖 호출 시도는 별도 코드 없이 그 로그에서
 *     그대로 보인다 — allowlist 튜닝 근거가 여전히 확보된다.
 *
 * 보안 — 프로파일은 authz 경계가 아니다. `X-AWB-Tool-Profile` 헤더는
 * 클라이언트가 보내므로 위조 가능하지만, compact는 tool 노출을 *줄이기만*
 * 하므로 위조해도 권한 상승 경로가 없다(단지 tool을 덜 받을 뿐). 반대로
 * 위조로 `full`을 요청해도(또는 헤더 자체를 생략해도, 기본값이 full이므로)
 * `tool-authz-gate.ts`의 authz 티어 체크가 평소처럼 그대로 적용된다. 이
 * 모듈을 caller 권한을 좁히는 용도로 기대하지 말 것 — 그건 tool-authz-gate.ts의
 * 몫이다.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

export type ToolProfile = 'full' | 'compact';

/**
 * 출발점 allowlist(19개) — 칸반 컬럼 workflow 가이드가 실제로 호출하는
 * 도구들. 실측(2026-08-22): 이 19개만으로 compact tools/list가 37,608
 * bytes(전체 205개 253,638 bytes 대비 ≈85% 감소). 목표 재상향/재조정이
 * 필요해지면 이 목록을 조정할 것 — allowlist 밖 호출 시도의 요청 로그
 * (mcp.controller.ts의 기존 bodyPreview 로그)가 튜닝 근거를 제공한다.
 */
export const COMPACT_TOOL_ALLOWLIST: ReadonlySet<string> = new Set([
  'whoami',
  'ping',
  'get_ticket',
  'get_my_tickets',
  'get_allocated_tickets',
  'claim_ticket',
  'release_ticket',
  'add_comment',
  'move_ticket',
  'propose_move',
  'record_agreement',
  'update_ticket',
  'create_child_ticket',
  'update_child_ticket',
  'pend_ticket',
  'add_ticket_prerequisites',
  'list_board_lessons',
  'set_current_task',
  'clear_current_task',
]);

type ToolMethod = McpServer['tool'];

/**
 * Wraps `server.tool()` in place so every registration made through this
 * `server` instance from this call forward is checked against
 * COMPACT_TOOL_ALLOWLIST — a name NOT in the allowlist is silently never
 * registered (omitted from both `tools/list` and `tools/call` routing).
 * Must be installed BEFORE `installToolAuthzGate` (see `registerAllTools` in
 * `tools/index.ts`) so an omitted tool never reaches the authz wrapper at
 * all — there is nothing to gate for a tool this server never registers.
 *
 * Mutates `server`, same pattern and same safety rationale as
 * `installToolAuthzGate` — `registerAllTools` builds a brand-new McpServer
 * per MCP session, so there is never a shared instance to double-wrap.
 */
export function installToolProfileGate(server: McpServer): void {
  const originalTool = server.tool.bind(server) as (...args: unknown[]) => unknown;

  (server as unknown as { tool: ToolMethod }).tool = ((...args: unknown[]) => {
    const name = args[0];
    if (typeof name === 'string' && !COMPACT_TOOL_ALLOWLIST.has(name)) {
      return undefined;
    }
    return originalTool(...args);
  }) as ToolMethod;
}
