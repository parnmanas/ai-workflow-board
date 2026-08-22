// Regression test — ticket ee26302d review round 1 (P1).
//
// Bug: a shared per-agent static mcp-config.json can carry a STALE
// X-AWB-Tool-Profile: compact header into a LATER session that resolves to
// 'full'. The pre-fix reuse-fast-path in both BaseSessionManager#_spawnSession
// and SubagentManager#spawn only rewrote the shared file when the CURRENT
// session wanted compact — never when it wanted full but the on-disk file was
// already stamped compact by an earlier session for the same agent. A chat
// session (or any non-ticket-pinned spawn) that ran after a compact session
// would silently inherit the compact header and lose most of its tools,
// exactly backwards from the "next spawn corrects it" claim the pre-fix code
// comments made.
//
// Fix: compare the file's ACTUAL on-disk X-AWB-Tool-Profile value (via
// readMcpConfigToolProfile) against what THIS session wants before deciding
// to reuse-as-is vs rewrite — fixes both directions, not just one.
//
// This drives the real compiled dist/ managers with a fixture `claude`
// binary and asserts on the actual mcp-config.json file content (the same
// file the real CLI would read via --mcp-config) after each spawn — not on
// internal in-memory state — for full → compact → full and
// compact → full → compact, through BOTH manager classes.
//
// AWB_AGENT_MANAGER_HOME must be set to an isolated temp dir BEFORE the
// dist modules are imported (managed-agent-store.js reads it once at module
// load to compute MANAGED_AGENTS_DIR) — same convention as
// agent-manager-commands.test.mjs. writeMcpConfig()'s write target is
// ALWAYS mcpConfigPathFor(agentId) regardless of what an `agentContext.
// mcp_config_path` field happens to say, so the assertions below read back
// through that same real, computed path rather than an invented one.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { chmod, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.AWB_AGENT_MANAGER_HOME = mkdtempSync(join(tmpdir(), 'awb-tool-profile-transitions-'));

const { BaseSessionManager } = await import('../dist/lib/base-session-manager.js');
const { SubagentManager } = await import('../dist/lib/subagent-manager.js');
const { readMcpConfigToolProfile, mcpConfigPathFor } = await import('../dist/lib/managed-agent-store.js');

const fixtureRoot = join(process.cwd(), '.test-tool-profile-transitions');

test.after(async () => {
  await rm(fixtureRoot, { recursive: true, force: true });
});

async function makeClaudeFixture(name) {
  await mkdir(fixtureRoot, { recursive: true });
  const path = join(fixtureRoot, name);
  await writeFile(
    path,
    `#!/usr/bin/env node
process.stdout.write(JSON.stringify({type:'result', subtype:'success', result:'ok'}) + '\\n');
`,
  );
  await chmod(path, 0o755);
  return path;
}

const baseConfig = {
  url: 'http://127.0.0.1:0',
  apiKey: 'test-awb-key',
  silentExitVerifyDelayMs: 0,
  delegation: { enabled: true, persistentTicketSessions: false, maxConcurrent: 5, ttlMinutes: 1 },
};

// context_window >= TOOL_PROFILE_COMPACT_THRESHOLD_TOKENS (128,000) → {} (full).
function fullProfile() {
  return {
    id: 'cloud-profile',
    kind: 'claude-backend',
    protocol: 'anthropic-compatible',
    base_url: 'http://127.0.0.1:1',
    model: 'cloud-model',
    context_window: 200_000,
  };
}

// Below the tool-profile compact threshold (128,000) → opts into compact,
// but still comfortably above DEFAULT_SAFETY_MARGIN_TOKENS (40,000) +
// MIN_OUTPUT_TOKENS so the UNRELATED max_output_tokens budget clamp (ticket
// 7d8ea7c9) doesn't also trip and mask this test's actual target. 65,536 is
// the real vLLM incident's context_window (see runtime-profile-max-output-
// clamp.test.mjs's REAL_CONTEXT_WINDOW) — a realistic small-context value.
function compactProfile() {
  return {
    id: 'local-profile',
    kind: 'claude-backend',
    protocol: 'anthropic-compatible',
    base_url: 'http://127.0.0.1:1',
    model: 'local-model',
    context_window: 65_536,
  };
}

test('SubagentManager#spawn: full → compact → full does not leave a stale compact header on the third (full) spawn', async () => {
  const claudeBin = await makeClaudeFixture('claude-sm-full-compact-full.mjs');
  const agentId = 'agent-sm-fcf';
  const cwd = join(fixtureRoot, 'sm-fcf-cwd');
  await mkdir(cwd, { recursive: true });
  const mcpConfigPath = mcpConfigPathFor(agentId);

  const manager = new SubagentManager({ ...baseConfig, delegation: { ...baseConfig.delegation, claudeBin } });
  const agentContext = {
    agent_id: agentId,
    api_key: 'agent-awb-key',
    cwd,
    mcp_config_path: mcpConfigPath,
    cli: 'claude',
  };

  async function spawnOnce(runtimeProfile, triggerId) {
    const result = await manager.spawn({
      kind: 'trigger',
      taskText: 'fixture task',
      rolePrompt: 'fixture role',
      triggerId,
      ticketId: '',
      agentId: agentContext.agent_id,
      runtimeProfile,
      agentContext,
    });
    assert.equal(result.spawned, true, `spawn(${triggerId}) must succeed: ${JSON.stringify(result)}`);
  }

  await spawnOnce(fullProfile(), 'trigger-sm-fcf-1-full');
  assert.equal(
    await readMcpConfigToolProfile(mcpConfigPath), undefined,
    'first (full) spawn: no X-AWB-Tool-Profile header on disk',
  );

  await spawnOnce(compactProfile(), 'trigger-sm-fcf-2-compact');
  assert.equal(
    await readMcpConfigToolProfile(mcpConfigPath), 'compact',
    'second (compact) spawn: header written to the shared file',
  );

  await spawnOnce(fullProfile(), 'trigger-sm-fcf-3-full');
  assert.equal(
    await readMcpConfigToolProfile(mcpConfigPath), undefined,
    'third (full) spawn must NOT inherit the stale compact header the second spawn left — this is the bug the fix closes',
  );
});

test('SubagentManager#spawn: compact → full → compact correctly re-applies compact after an intervening full spawn', async () => {
  const claudeBin = await makeClaudeFixture('claude-sm-compact-full-compact.mjs');
  const agentId = 'agent-sm-cfc';
  const cwd = join(fixtureRoot, 'sm-cfc-cwd');
  await mkdir(cwd, { recursive: true });
  const mcpConfigPath = mcpConfigPathFor(agentId);

  const manager = new SubagentManager({ ...baseConfig, delegation: { ...baseConfig.delegation, claudeBin } });
  const agentContext = {
    agent_id: agentId,
    api_key: 'agent-awb-key',
    cwd,
    mcp_config_path: mcpConfigPath,
    cli: 'claude',
  };

  async function spawnOnce(runtimeProfile, triggerId) {
    const result = await manager.spawn({
      kind: 'trigger',
      taskText: 'fixture task',
      rolePrompt: 'fixture role',
      triggerId,
      ticketId: '',
      agentId: agentContext.agent_id,
      runtimeProfile,
      agentContext,
    });
    assert.equal(result.spawned, true, `spawn(${triggerId}) must succeed: ${JSON.stringify(result)}`);
  }

  await spawnOnce(compactProfile(), 'trigger-sm-cfc-1-compact');
  assert.equal(await readMcpConfigToolProfile(mcpConfigPath), 'compact');

  await spawnOnce(fullProfile(), 'trigger-sm-cfc-2-full');
  assert.equal(await readMcpConfigToolProfile(mcpConfigPath), undefined);

  await spawnOnce(compactProfile(), 'trigger-sm-cfc-3-compact');
  assert.equal(
    await readMcpConfigToolProfile(mcpConfigPath), 'compact',
    'third (compact) spawn must re-apply compact, not inherit the full spawn\'s cleared header',
  );
});

test('BaseSessionManager#_spawnSession: full → compact → full does not leave a stale compact header on the third (full) spawn', async () => {
  const claudeBin = await makeClaudeFixture('claude-bsm-full-compact-full.mjs');
  const agentId = 'agent-bsm-fcf';
  const cwd = join(fixtureRoot, 'bsm-fcf-cwd');
  await mkdir(cwd, { recursive: true });
  const mcpConfigPath = mcpConfigPathFor(agentId);

  const manager = new BaseSessionManager(
    { ...baseConfig, delegation: { ...baseConfig.delegation, claudeBin } },
    { keyField: 'sessionKey', logTag: '[test-bsm-fcf]', cfgPrefix: 'bsm-fcf-', kindLabel: 'chat_session' },
  );
  const agentContext = {
    agent_id: agentId,
    api_key: 'agent-awb-key',
    cwd,
    mcp_config_path: mcpConfigPath,
    cli: 'claude',
  };

  async function spawnOnce(runtimeProfile, sessionKey) {
    const sess = await manager._spawnSession(sessionKey, 'fixture role prompt', 'fixture first turn', {
      agentContext,
      runtimeProfile,
    });
    assert.ok(sess, `_spawnSession(${sessionKey}) must succeed`);
  }

  await spawnOnce(fullProfile(), 'sess-bsm-fcf-1');
  assert.equal(
    await readMcpConfigToolProfile(mcpConfigPath), undefined,
    'first (full) spawn: no X-AWB-Tool-Profile header on disk',
  );

  await spawnOnce(compactProfile(), 'sess-bsm-fcf-2');
  assert.equal(
    await readMcpConfigToolProfile(mcpConfigPath), 'compact',
    'second (compact) spawn: header written to the shared file',
  );

  await spawnOnce(fullProfile(), 'sess-bsm-fcf-3');
  assert.equal(
    await readMcpConfigToolProfile(mcpConfigPath), undefined,
    'third (full) spawn must NOT inherit the stale compact header the second spawn left — this is the bug the fix closes',
  );
});

test('BaseSessionManager#_spawnSession: compact → full → compact correctly re-applies compact after an intervening full spawn', async () => {
  const claudeBin = await makeClaudeFixture('claude-bsm-compact-full-compact.mjs');
  const agentId = 'agent-bsm-cfc';
  const cwd = join(fixtureRoot, 'bsm-cfc-cwd');
  await mkdir(cwd, { recursive: true });
  const mcpConfigPath = mcpConfigPathFor(agentId);

  const manager = new BaseSessionManager(
    { ...baseConfig, delegation: { ...baseConfig.delegation, claudeBin } },
    { keyField: 'sessionKey', logTag: '[test-bsm-cfc]', cfgPrefix: 'bsm-cfc-', kindLabel: 'chat_session' },
  );
  const agentContext = {
    agent_id: agentId,
    api_key: 'agent-awb-key',
    cwd,
    mcp_config_path: mcpConfigPath,
    cli: 'claude',
  };

  async function spawnOnce(runtimeProfile, sessionKey) {
    const sess = await manager._spawnSession(sessionKey, 'fixture role prompt', 'fixture first turn', {
      agentContext,
      runtimeProfile,
    });
    assert.ok(sess, `_spawnSession(${sessionKey}) must succeed`);
  }

  await spawnOnce(compactProfile(), 'sess-bsm-cfc-1');
  assert.equal(await readMcpConfigToolProfile(mcpConfigPath), 'compact');

  await spawnOnce(fullProfile(), 'sess-bsm-cfc-2');
  assert.equal(await readMcpConfigToolProfile(mcpConfigPath), undefined);

  await spawnOnce(compactProfile(), 'sess-bsm-cfc-3');
  assert.equal(
    await readMcpConfigToolProfile(mcpConfigPath), 'compact',
    'third (compact) spawn must re-apply compact, not inherit the full spawn\'s cleared header',
  );
});
