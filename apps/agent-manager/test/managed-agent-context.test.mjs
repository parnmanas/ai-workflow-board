// Managed-agent CONTEXT registry (the hot-path cwd/apiKey/mcp-config cache the
// EventDispatcher reads per SSE event). Covers the in-place working_dir heal
// (ticket 90ebb09a) that keeps a set_working_dir / run-dispatch re-validation
// from leaving the cache stale until the next spawn_agent — the drift that placed
// GameClient QA runs at the wrong 규약 ③ base.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { ManagedAgentContextRegistry } = await import('../dist/lib/managed-agent-context.js');

function ctx(overrides = {}) {
  return {
    agent_id: 'a1',
    name: 'Agent One',
    cli: 'claude',
    working_dir: '/old/ws',
    mcp_config_path: '/cfg/mcp.json',
    api_key: 'k',
    subagent_log_path: '/log/a1.log',
    cli_home_dir: '/cli-home/a1',
    registered_at: new Date().toISOString(),
    ...overrides,
  };
}

test('setWorkingDir heals the cached cwd in place for a registered context', () => {
  const reg = new ManagedAgentContextRegistry();
  reg.upsert(ctx());
  assert.equal(reg.get('a1').working_dir, '/old/ws');

  const healed = reg.setWorkingDir('a1', '/new/ws');
  assert.equal(healed, true, 'returns true when a context existed');
  assert.equal(reg.get('a1').working_dir, '/new/ws', 'cwd updated in place');

  // Other fields must be preserved (only working_dir changes).
  const after = reg.get('a1');
  assert.equal(after.api_key, 'k');
  assert.equal(after.mcp_config_path, '/cfg/mcp.json');
  assert.equal(after.name, 'Agent One');
});

test('setWorkingDir is a no-op returning false when no context exists yet', () => {
  const reg = new ManagedAgentContextRegistry();
  const healed = reg.setWorkingDir('ghost', '/whatever');
  assert.equal(healed, false, 'no-op for an agent never spawned since boot');
  assert.equal(reg.get('ghost'), null, 'does NOT create a partial context');
});
