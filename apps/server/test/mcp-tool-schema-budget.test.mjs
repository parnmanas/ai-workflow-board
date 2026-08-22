// 티켓 faa32380 — AWB MCP tool schema 크기 감사.
//
// 배경: 7d8ea7c9 사고에서 vLLM 백엔드(context_window 65,536)로 첫 채팅
// 메시지를 보낼 때 system prompt + AWB/agent/board/workspace instructions +
// MCP tool schema + session metadata를 합쳐 실측 33,537 input tokens가
// 됐고, CLI 고정 max_output_tokens(32,000)를 더해 정확히 1 token 초과,
// HTTP 500이 났다(백엔드 tokenizer가 그 요청에 실제로 청구한 값).
//
// 이 티켓에서 실측한 건 그 33,537과는 다른 지점의 숫자다 — AWB MCP
// 서버가 CLI에 내려주는 raw `tools/list` 응답 자체의 크기(2026-08-22,
// 진짜 McpServer + InMemoryTransport로 실제 JSON-RPC 왕복을 재현):
//   - 205개 tool, tools[] 배열 JSON 253,638 bytes
//   - 실제 BPE 토크나이저(tiktoken o200k_base/cl100k_base) 기준 약
//     57,000~67,500 tokens (전체를 한 번에 토크나이즈 vs tool별 합산의
//     차이) — codebase 자체의 char/4 휴리스틱은 63,117로 그 사이.
//   - 2026-04-28 커밋 bf8de6c2의 캐시 도입 당시 주석은 "79-tool registry
//     ... ~59KB"라고 기록했다 — 약 4개월 만에 tool 수 2.6배, 바이트
//     4.3배 증가.
//
// 이 두 숫자(raw tools/list 57,000~67,500 vs 사고의 총 input 33,537)를
// 같은 것으로 취급하지 말 것 — raw MCP JSON, CLI가 실제로 모델
// 백엔드에 보내는 tool payload(변환/압축/지연로딩 여부는 CLI 내부
// 동작이라 이 저장소 조사만으로는 확정할 수 없음), 백엔드 tokenizer가
// 청구한 input은 서로 다른 지점의 서로 다른 측정이다. raw 크기가 사고의
// 총 input보다 큰 것 자체가 흥미로운 미해결 질문이지, "이게 사고 원인의
// N%를 차지했다"고 결론 내릴 근거는 아니다(과거 버전의 이 주석/관련
// 티켓 코멘트가 이렇게 과대 서술했었다 — 리뷰 지적으로 수정).
//
// 확실한 사실만 남기면: (1) AWB가 내보내는 raw schema 자체가 크고 계속
// 빠르게 커지고 있고, (2) 65,536처럼 작은 컨텍스트에서는 이 raw 크기
// 하나만으로도 여유가 거의 없다 — 1M 컨텍스트인 Anthropic 클라우드
// tier(Opus/Sonnet 5)에서는 5.7~6.75%, 가장 작은 상용 tier인 200K
// (Haiku 4.5)에서도 28.5~33.75%에 불과하다. CLI가 이 raw schema를
// 실제로 얼마나 그대로/변형해서 백엔드에 보내는지는 별도 질문이며,
// 실제 축소/lazy-load 방향 결정은 후속 티켓(ee26302d)에서 다룬다.
//
// 이 테스트는 raw schema 크기 실측을 "한 번 보고 끝"이 아니라 CI에서
// 상시 추적되는 회귀 가드로 만든다. 목적은 성장 자체를 막는 게
// 아니라(정상적인 기능 추가로 계속 늘어날 것) 조용한 폭주(스캔 로직
// 깨짐, 실수로 중복 삽입된 blob, 통제 안 된 재귀적 스키마 등)를 CI에서
// 잡는 것이다 — 이 가드를 통과한다고 "소형 컨텍스트에 안전하다"는
// 뜻은 전혀 아니다(현재 크기조차 이미 그 예산 대부분을 차지한다).
// 문턱을 올려야 한다면 그 자체가 "이 정도 성장은 의식적으로
// 받아들인다"는 코드 리뷰 대상이 되도록 한다(TOOL_AUTHZ_TABLE/
// KNOWN_EXISTING_TOOLS 등 이 저장소의 기존 완전성 가드들과 동일한
// 철학).
//
// 실측 방법: 진짜 McpServer + registerAllTools(전체 40개 *-tools.ts 도메인,
// tools/index.ts의 파일명 컨벤션 자동 발견 그대로) + SDK 제공
// InMemoryTransport로 진짜 Client가 실제 `tools/list` JSON-RPC 왕복을
// 수행한다 — 정적 소스 스캔이 아니라 CLI가 실제로 받는 바이트 그대로.
// registerAllTools 자체는 등록 시점에 ctx의 서비스 메서드를 동기 호출하지
// 않는다(모든 실제 작업은 handler 안에서만) — makeStubCtx()의 Proxy가
// 이 가정이 깨지면 조용히 undefined를 반환하는 대신 즉시 던져 잡아낸다.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { registerAllTools } from '../dist/modules/mcp/tools/index.js';

/** registerAllTools가 등록 시점에 ctx.<service>를 동기 호출하면(핸들러
 *  안에서만 쓰는 이 저장소의 확립된 관례 위반) 조용히 undefined를 넘기는
 *  대신 즉시 던져, 이 테스트가 "통과했지만 사실 일부 도메인을 건너뛴"
 *  상태가 되는 걸 막는다. */
function makeStubCtx() {
  const throwingService = new Proxy({}, {
    get(_t, prop) {
      if (prop === 'then' || typeof prop === 'symbol') return undefined;
      return (...args) => {
        throw new Error(
          `mcp-tool-schema-budget: stub ctx.<service>.${String(prop)}(${args.length} args) called ` +
          'during tool REGISTRATION, not inside a handler — this test\'s stub ctx assumes registration ' +
          'never touches services synchronously (only wires handlers). If a new *-tools.ts file needs ' +
          'this, this stub needs a real implementation for it.'
        );
      };
    },
  });
  return new Proxy({ logger: { info() {}, warn() {}, error() {} } }, {
    get(target, prop) {
      if (prop in target) return target[prop];
      return throwingService;
    },
  });
}

describe('MCP tool schema wire-size budget (ticket faa32380)', () => {
  it('tracks the real tools/list wire size — floor + ceiling + named per-tool outlier', async () => {
    const server = new McpServer({ name: 'schema-budget-test', version: '0.0.0' }, { capabilities: { tools: {} } });
    registerAllTools(server, makeStubCtx());

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'schema-budget-test-client', version: '0.0.0' });
    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);

    let tools;
    try {
      ({ tools } = await client.listTools());
    } finally {
      await client.close();
      await server.close();
    }

    // Floor: catches the discovery/registration mechanism silently breaking
    // (e.g. a tools/index.ts convention regression) and under-reporting —
    // mirrors the >=150 floor already used by
    // apps/agent-manager/test/tool-surface-parity.test.mjs and
    // mcp-tool-authz.test.mjs's completeness guard.
    assert.ok(
      tools.length >= 150,
      `expected 150+ registered MCP tools, found ${tools.length} — discovery broken?`,
    );

    const totalBytes = Buffer.byteLength(JSON.stringify(tools), 'utf8');
    // Growth-sentinel ceiling, NOT a small-context safety budget — the
    // baseline itself already consumes most of a 65,536-token local
    // backend's window (see the file header), so staying under this
    // ceiling says nothing about small-context safety. It exists only to
    // separate ordinary feature-driven growth from a runaway (duplicated
    // blob, unbounded recursive schema, scan regex drift): +25% headroom
    // over the last-measured baseline, tight enough to actually catch a
    // careless blow-up. If organic tool additions genuinely need more,
    // raise CURRENT_BASELINE_BYTES in the SAME PR as the addition (a
    // conscious, reviewed decision), not silently.
    const CURRENT_BASELINE_BYTES = 253_638; // 205 tools, 2026-08-22 실측
    const TOTAL_BYTES_CEILING = Math.ceil(CURRENT_BASELINE_BYTES * 1.25);
    assert.ok(
      totalBytes <= TOTAL_BYTES_CEILING,
      `tools/list wire size grew to ${totalBytes} bytes (growth-sentinel ceiling ${TOTAL_BYTES_CEILING}, ` +
      `+25% over the ${CURRENT_BASELINE_BYTES}-byte baseline) across ${tools.length} tools. This is a ` +
      'runaway-bloat tripwire, not a small-context safety budget — the actual reduction/lazy-load design ' +
      'decision is ticket ee26302d. If this growth is deliberate, raise CURRENT_BASELINE_BYTES here.',
    );

    // Named per-tool outlier: update_board was ~13.4-14.0KB at audit time
    // (faa32380) — by far the largest single tool (16 board-level config
    // knobs, each carrying a full paragraph description, accreted across
    // many separate tickets: harness_config, effort_presets,
    // environment_config, liveness_policy, qa_phases, merge_gate_config,
    // respawn_storm_config, hard_budget_config, default_role_assignments,
    // ...). Tracked explicitly (generous headroom) rather than silently
    // exempted, so continued unchecked growth is visible.
    const PER_TOOL_CEILING = 10_000;
    const KNOWN_OUTLIERS = { update_board: 25_000 };

    const oversized = [];
    for (const t of tools) {
      const bytes = Buffer.byteLength(JSON.stringify(t), 'utf8');
      const ceiling = KNOWN_OUTLIERS[t.name] ?? PER_TOOL_CEILING;
      if (bytes > ceiling) oversized.push(`${t.name}: ${bytes} bytes (ceiling ${ceiling})`);
    }
    assert.deepEqual(
      oversized,
      [],
      `tool(s) exceeded their per-tool schema-size ceiling — a new "god tool" accreting unbounded ` +
      `config surface? ${oversized.join('; ')}`,
    );
  });
});
