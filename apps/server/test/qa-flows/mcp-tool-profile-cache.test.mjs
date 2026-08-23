// QA: MCP tool profile (ticket ee26302d, faa32380 감사 후속) — compact
// opt-in reduces the tool surface AND its tools/list cache never leaks one
// profile's response into another session's.
//
// Highest risk called out by the design: mcp.controller.ts caches the
// tools/list JSON-RPC body keyed by ToolProfile ('full' | 'compact'). If the
// cache-read and cache-fill sites ever used different keys (or read the
// wrong session's resolved profile), a compact session could be served the
// full ~205-tool body (silently defeating the reduction for a small-context
// backend) or a full session could be served the ~19-tool compact body (a
// cloud agent silently losing every non-allowlisted tool). This alternates
// session init order in both directions so the Map keying is proven correct
// regardless of which profile connects first — exactly the scenario a
// naive single-slot cache (the pre-ticket implementation) would get wrong.
//
// Exact tool-name/byte-size assertions for each profile live in
// test/mcp-tool-schema-budget.test.mjs; this file only cares about which of
// the two distinct bodies a session receives, and when.

import test from 'node:test';
import assert from 'node:assert/strict';
import { bootApp, exitAfterTests, step } from '../helpers/boot.mjs';
import { setupKanbanScene, createAgent, createApiKey } from '../helpers/fixtures.mjs';
import { McpClient } from '../helpers/mcp-client.mjs';

process.env.PORT = process.env.QA_MCP_TOOL_PROFILE_PORT || '7945';

// Mirrors the >=150 floor already used by mcp-tool-schema-budget.test.mjs /
// qa-flows/mcp-tools-surface.test.mjs's completeness guards — catches the
// full profile silently degrading to the compact one.
const FULL_FLOOR = 150;
// A compact session must be well under the full floor — the exact count
// (COMPACT_TOOL_ALLOWLIST.size) is asserted in mcp-tool-schema-budget.test.mjs;
// hardcoding it again here would make this file break every time the
// allowlist is deliberately re-tuned for reasons unrelated to cache keying.
const COMPACT_CEILING = 50;

async function makeClient(baseUrl, apiKey, extraHeaders) {
  const client = new McpClient({ baseUrl, apiKey, extraHeaders });
  await client.initialize();
  return client;
}

test('MCP tool profile: compact/full tools/list cache keying survives alternating session init order', async (t) => {
  const { app, port, modules } = await bootApp({ port: parseInt(process.env.PORT, 10) });
  t.after(() => { void app.close().catch(() => {}); });
  const { getDataSourceToken } = modules;

  const { ws } = await setupKanbanScene(app, getDataSourceToken, { workspaceName: 'tool-profile' });
  const agent = await createAgent(app, getDataSourceToken, ws.id, { name: 'tool-profile-tester' });
  const key = await createApiKey(app, getDataSourceToken, agent.id, {
    workspaceId: ws.id,
    label: 'tool-profile-tester',
  });
  const baseUrl = `http://localhost:${port}`;

  step('compact-first: a compact session initializes before any full session fills the cache');
  const compact1 = await makeClient(baseUrl, key.raw_key, { 'X-AWB-Tool-Profile': 'compact' });
  t.after(() => compact1.close());
  const compactTools1 = await compact1.listTools();
  assert.ok(
    compactTools1.length > 0 && compactTools1.length <= COMPACT_CEILING,
    `compact session (initialized first) must get the small allowlist surface — got ${compactTools1.length} tools`,
  );
  assert.ok(!compactTools1.some((tl) => tl.name === 'update_board'), 'compact session never sees update_board');

  step('a full session initializes second — must NOT inherit the compact cache entry');
  const full1 = await makeClient(baseUrl, key.raw_key, {});
  t.after(() => full1.close());
  const fullTools1 = await full1.listTools();
  assert.ok(
    fullTools1.length >= FULL_FLOOR,
    `full session (initialized second, no header) must not inherit the compact cache — got ${fullTools1.length} tools`,
  );
  assert.ok(fullTools1.some((tl) => tl.name === 'update_board'), 'full session sees update_board (compact-omitted tool)');

  step('re-querying the FIRST (compact) session must still hit its own cached body');
  const compactToolsAgain = await compact1.listTools();
  assert.equal(
    compactToolsAgain.length,
    compactTools1.length,
    'a second tools/list on the compact session must return the same body, unaffected by the full session that connected in between',
  );

  step('full-first: reverse the order — a full session initializes before any compact session');
  const full2 = await makeClient(baseUrl, key.raw_key, {});
  t.after(() => full2.close());
  const fullTools2 = await full2.listTools();
  assert.ok(
    fullTools2.length >= FULL_FLOOR,
    `full session (initialized first, reversed order) — got ${fullTools2.length} tools`,
  );

  const compact2 = await makeClient(baseUrl, key.raw_key, { 'X-AWB-Tool-Profile': 'compact' });
  t.after(() => compact2.close());
  const compactTools2 = await compact2.listTools();
  assert.ok(
    compactTools2.length > 0 && compactTools2.length <= COMPACT_CEILING,
    `compact session (initialized second, reversed order) must still get the allowlist, not the full cache — got ${compactTools2.length} tools`,
  );
  assert.ok(!compactTools2.some((tl) => tl.name === 'update_board'), 'compact session (reversed order) never sees update_board');

  step('an allowlist-omitted tool call on a compact session gets a clean "not found" error');
  const omittedResult = await compact2.callTool('update_board', { board_id: 'does-not-matter' });
  assert.equal(omittedResult?.isError, true, 'calling a compact-omitted tool must be an error result, not a silent success');
  const omittedMessage = omittedResult?.raw || JSON.stringify(omittedResult?.error || '');
  assert.match(omittedMessage, /not found/i, 'the SDK-level "not found" error, since the tool was never registered — not an AWB handler error');

  step('an allowlisted tool still works normally on a compact session');
  const whoamiResult = await compact2.callTool('whoami', {});
  assert.equal(whoamiResult?.authenticated, true, 'whoami on a compact session must still resolve the real caller identity');

  exitAfterTests(0);
});
