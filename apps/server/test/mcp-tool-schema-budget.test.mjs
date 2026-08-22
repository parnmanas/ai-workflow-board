// 티켓 faa32380 — AWB MCP tool schema 크기 감사.
//
// 배경: 7d8ea7c9 사고에서 vLLM 백엔드(context_window 65,536)로 첫 채팅
// 메시지를 보낼 때 system prompt + AWB/agent/board/workspace instructions +
// MCP tool schema + session metadata만으로 33,537 input tokens가 됐고,
// CLI 고정 max_output_tokens(32,000)를 더해 정확히 1 token 초과, HTTP 500이
// 났다. 이 티켓에서 AWB MCP 서버가 실제로 `tools/list`에 태우는 바이트를
// 실측한 결과(2026-08-22 기준, 실제 InMemoryTransport 왕복):
//   - 205개 tool, tools[] 배열 JSON 253,638 bytes
//   - 실제 BPE 토크나이저(o200k_base) 기준 약 57,000~67,500 tokens
//     (전체를 한 번에 토크나이즈 vs tool별 합산의 차이) — 65,536 컨텍스트의
//     로컬 백엔드에서는 이것만으로 예산 전체를 거의 다 태운다.
//   - 2026-04-28 커밋 bf8de6c2의 캐시 도입 당시 주석은 "79-tool registry ...
//     ~59KB"라고 기록했다 — 약 4개월 만에 tool 수 2.6배, 바이트 4.3배 증가.
//
// 이 테스트는 그 실측을 "한 번 보고 끝"이 아니라 CI에서 상시 추적되는
// 회귀 가드로 만든다. 목적은 성장 자체를 막는 게 아니라(정상적인 기능
// 추가로 계속 늘어날 것) 조용한 폭주(스캔 로직 깨짐, 실수로 중복 삽입된
// blob, 통제 안 된 재귀적 스키마 등)를 CI에서 잡는 것 — 문턱을 올려야
// 한다면 그 자체가 "이 정도 성장은 의식적으로 받아들인다"는 코드 리뷰
// 대상이 되도록 한다(TOOL_AUTHZ_TABLE/KNOWN_EXISTING_TOOLS 등 이 저장소의
// 기존 완전성 가드들과 동일한 철학).
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
    // Ceiling: current measured baseline is 253,638 bytes (205 tools,
    // 2026-08-22). ~1.6x headroom over that for ordinary feature growth —
    // if organic tool additions genuinely need more, raise this number in
    // the SAME PR as the addition (a conscious, reviewed decision), not
    // silently. This exists to catch runaway/accidental bloat (duplicated
    // blob, unbounded recursive schema, scan regex drift), not to gate
    // normal growth.
    const TOTAL_BYTES_CEILING = 400_000;
    assert.ok(
      totalBytes <= TOTAL_BYTES_CEILING,
      `tools/list wire size grew to ${totalBytes} bytes (ceiling ${TOTAL_BYTES_CEILING}) across ` +
      `${tools.length} tools — see ticket faa32380 for why this budget matters on small-context local ` +
      'backends (e.g. 65,536-token vLLM). If this is deliberate growth, raise TOTAL_BYTES_CEILING here.',
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
