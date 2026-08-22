// Regression test — ticket ee26302d review rounds 1-2.
//
// Round 1 bug: a shared per-agent static mcp-config.json could carry a
// STALE X-AWB-Tool-Profile: compact header into a LATER session that
// resolved to 'full' — a chat session run after a compact session would
// silently inherit the compact header and lose most of its tools.
//
// Round 1 fix (content-comparison before reuse) closed the SEQUENTIAL case
// but left a round-2 TOCTOU gap: two sessions of DIFFERENT profiles for the
// SAME agent spawning close together could still race on the one shared
// mutable file — spawn() returns before the CLI has actually read
// `--mcp-config`, so a second spawn's rewrite can land before (or during)
// the first CLI's read.
//
// Round 2 fix: each profile gets its OWN path (mcpConfigPathFor(...,
// profile)) — concurrent spawns of different profiles for the same agent
// can never share a file to race on.
//
// This test drives the real compiled dist/ managers with a fixture `claude`
// binary that reports GROUND TRUTH — the fixture itself locates its
// `--mcp-config` argv, reads THAT file, and writes what it actually saw to
// a per-spawn capture file — rather than trusting the manager's internal
// state. Every spawn is awaited through to real child exit (code 0) before
// its capture is trusted, addressing review round 2's non-vacuousness
// finding (a prior version of this file deleted the fixture directory out
// from under still-running children, so its "4/4 pass" didn't mean what it
// looked like it meant).
//
// Covers, for BOTH BaseSessionManager#_spawnSession and
// SubagentManager#spawn:
//   - sequential full → compact → full
//   - sequential compact → full → compact
//   - CONCURRENT full + compact spawns for the same agent (the round-2 bug)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

process.env.AWB_AGENT_MANAGER_HOME = mkdtempSync(join(tmpdir(), 'awb-tool-profile-transitions-'));

const { BaseSessionManager } = await import('../dist/lib/base-session-manager.js');
const { SubagentManager } = await import('../dist/lib/subagent-manager.js');
const { mcpConfigPathFor } = await import('../dist/lib/managed-agent-store.js');

const fixtureRoot = join(process.cwd(), '.test-tool-profile-transitions');
let liveChildren = 0;

test.after(async () => {
  // Wait out any child this file's own bugs might still be racing (belt and
  // suspenders — every test below already awaits real exit before
  // returning) so a future run's fixture-directory rm() can never race a
  // still-alive descendant the way review round 2 found.
  const deadline = Date.now() + 5000;
  while (liveChildren > 0 && Date.now() < deadline) await delay(20);
  await rm(fixtureRoot, { recursive: true, force: true });
});

// The fixture reports GROUND TRUTH: it locates its OWN `--mcp-config` argv,
// reads THAT file itself (exactly what a real CLI does at startup), and
// writes what it found to CAPTURE_FILE — so assertions below are against
// what the child process actually observed, not against the parent
// manager's internal bookkeeping.
async function makeClaudeFixture(name) {
  await mkdir(fixtureRoot, { recursive: true });
  const path = join(fixtureRoot, name);
  await writeFile(
    path,
    `#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
const idx = process.argv.indexOf('--mcp-config');
const mcpConfigPath = idx >= 0 ? process.argv[idx + 1] : null;
let toolProfile = null;
let authorization = null;
try {
  const parsed = JSON.parse(readFileSync(mcpConfigPath, 'utf8'));
  toolProfile = parsed?.mcpServers?.awb?.headers?.['X-AWB-Tool-Profile'] ?? null;
  authorization = parsed?.mcpServers?.awb?.headers?.['Authorization'] ?? null;
} catch (e) {
  toolProfile = 'ERROR:' + e.message;
}
writeFileSync(process.env.CAPTURE_FILE, JSON.stringify({ pid: process.pid, mcpConfigPath, toolProfile, authorization }));
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
function fullProfile(extra = {}) {
  return {
    id: 'cloud-profile',
    kind: 'claude-backend',
    protocol: 'anthropic-compatible',
    base_url: 'http://127.0.0.1:1',
    model: 'cloud-model',
    context_window: 200_000,
    ...extra,
  };
}

// Below the tool-profile compact threshold (128,000) → opts into compact,
// but still comfortably above DEFAULT_SAFETY_MARGIN_TOKENS (40,000) +
// MIN_OUTPUT_TOKENS so the UNRELATED max_output_tokens budget clamp (ticket
// 7d8ea7c9) doesn't also trip. 65,536 is the real vLLM incident's
// context_window (runtime-profile-max-output-clamp.test.mjs's
// REAL_CONTEXT_WINDOW).
function compactProfile(extra = {}) {
  return {
    id: 'local-profile',
    kind: 'claude-backend',
    protocol: 'anthropic-compatible',
    base_url: 'http://127.0.0.1:1',
    model: 'local-model',
    context_window: 65_536,
    ...extra,
  };
}

async function readCapture(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

// ─── SubagentManager helpers ────────────────────────────────────────────
// manager.onExit is a single shared callback (not per-spawn), so route exit
// events by pid — and record an exit that arrives before its waiter is
// registered (spawn() resolving races the child's own near-instant exit
// for these fixtures) rather than assuming registration always wins.
function installExitRouter(manager) {
  const already = new Map();
  const waiters = new Map();
  manager.onExit = (info) => {
    liveChildren--;
    const w = waiters.get(info.pid);
    if (w) { waiters.delete(info.pid); w(info); }
    else already.set(info.pid, info);
  };
  return function waitForPidExit(pid, timeoutMs = 5000) {
    if (already.has(pid)) return Promise.resolve(already.get(pid));
    return Promise.race([
      new Promise((resolve) => waiters.set(pid, resolve)),
      delay(timeoutMs).then(() => assert.fail(`pid ${pid} did not exit within ${timeoutMs}ms`)),
    ]);
  };
}

async function spawnSubagentAndAwaitExit(manager, waitForPidExit, { agentContext, runtimeProfile, triggerId }) {
  liveChildren++;
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
  const exitInfo = await waitForPidExit(result.pid);
  assert.equal(exitInfo.code, 0, `fixture for ${triggerId} (pid ${result.pid}) must exit 0`);
  return exitInfo;
}

// ─── BaseSessionManager helpers ─────────────────────────────────────────
async function spawnBaseSessionAndAwaitExit(manager, { agentContext, runtimeProfile, sessionKey }) {
  liveChildren++;
  const sess = await manager._spawnSession(sessionKey, 'fixture role prompt', 'fixture first turn', {
    agentContext,
    runtimeProfile,
  });
  assert.ok(sess, `_spawnSession(${sessionKey}) must succeed`);
  const exitInfo = await Promise.race([
    new Promise((resolve) => sess.child.once('exit', (code, signal) => resolve({ code, signal }))),
    delay(5000).then(() => assert.fail(`${sessionKey} (pid ${sess.pid}) did not exit within 5000ms`)),
  ]);
  liveChildren--;
  assert.equal(exitInfo.code, 0, `fixture for ${sessionKey} (pid ${sess.pid}) must exit 0`);
  return exitInfo;
}

// ─── SubagentManager: sequential transitions ────────────────────────────

test('SubagentManager#spawn: sequential full → compact → full — fixture-observed header matches at every step', async () => {
  const claudeBin = await makeClaudeFixture('claude-sm-seq-fcf.mjs');
  const agentId = 'agent-sm-seq-fcf';
  const cwd = join(fixtureRoot, 'sm-seq-fcf-cwd');
  await mkdir(cwd, { recursive: true });
  const agentContext = { agent_id: agentId, api_key: 'agent-awb-key', cwd, mcp_config_path: mcpConfigPathFor(agentId), cli: 'claude' };
  const manager = new SubagentManager({ ...baseConfig, delegation: { ...baseConfig.delegation, claudeBin } });
  const waitForPidExit = installExitRouter(manager);

  async function step(profile, label, expectProfile) {
    const captureFile = join(fixtureRoot, `sm-seq-fcf-${label}.json`);
    await spawnSubagentAndAwaitExit(manager, waitForPidExit, {
      agentContext, triggerId: `trigger-sm-seq-fcf-${label}`,
      runtimeProfile: { ...profile, env: { ...(profile.env ?? {}), CAPTURE_FILE: captureFile } },
    });
    const capture = await readCapture(captureFile);
    assert.equal(capture.toolProfile, expectProfile, `${label}: fixture-observed header`);
  }

  await step(fullProfile(), '1-full', null);
  await step(compactProfile(), '2-compact', 'compact');
  await step(fullProfile(), '3-full', null); // the round-1 bug: this used to observe 'compact'
});

test('SubagentManager#spawn: sequential compact → full → compact — fixture-observed header matches at every step', async () => {
  const claudeBin = await makeClaudeFixture('claude-sm-seq-cfc.mjs');
  const agentId = 'agent-sm-seq-cfc';
  const cwd = join(fixtureRoot, 'sm-seq-cfc-cwd');
  await mkdir(cwd, { recursive: true });
  const agentContext = { agent_id: agentId, api_key: 'agent-awb-key', cwd, mcp_config_path: mcpConfigPathFor(agentId), cli: 'claude' };
  const manager = new SubagentManager({ ...baseConfig, delegation: { ...baseConfig.delegation, claudeBin } });
  const waitForPidExit = installExitRouter(manager);

  async function step(profile, label, expectProfile) {
    const captureFile = join(fixtureRoot, `sm-seq-cfc-${label}.json`);
    await spawnSubagentAndAwaitExit(manager, waitForPidExit, {
      agentContext, triggerId: `trigger-sm-seq-cfc-${label}`,
      runtimeProfile: { ...profile, env: { ...(profile.env ?? {}), CAPTURE_FILE: captureFile } },
    });
    const capture = await readCapture(captureFile);
    assert.equal(capture.toolProfile, expectProfile, `${label}: fixture-observed header`);
  }

  await step(compactProfile(), '1-compact', 'compact');
  await step(fullProfile(), '2-full', null);
  await step(compactProfile(), '3-compact', 'compact');
});

// ─── SubagentManager: concurrency (review round 2) ──────────────────────

test('SubagentManager#spawn: CONCURRENT full + compact spawns for the same agent never cross-contaminate', async () => {
  const claudeBin = await makeClaudeFixture('claude-sm-concurrent.mjs');
  const agentId = 'agent-sm-concurrent';
  const cwd = join(fixtureRoot, 'sm-concurrent-cwd');
  await mkdir(cwd, { recursive: true });
  const agentContext = { agent_id: agentId, api_key: 'agent-awb-key', cwd, mcp_config_path: mcpConfigPathFor(agentId), cli: 'claude' };
  const manager = new SubagentManager({ ...baseConfig, delegation: { ...baseConfig.delegation, claudeBin } });
  const waitForPidExit = installExitRouter(manager);

  const fullCapture = join(fixtureRoot, 'sm-concurrent-full.json');
  const compactCapture = join(fixtureRoot, 'sm-concurrent-compact.json');

  // Fired together (Promise.all, no await between them) — this is exactly
  // the round-2 scenario: two different-profile spawns for the SAME agent
  // racing each other, neither waiting for the other's CLI to have read
  // its config before proceeding.
  await Promise.all([
    spawnSubagentAndAwaitExit(manager, waitForPidExit, {
      agentContext, triggerId: 'trigger-sm-concurrent-full',
      runtimeProfile: { ...fullProfile(), env: { CAPTURE_FILE: fullCapture } },
    }),
    spawnSubagentAndAwaitExit(manager, waitForPidExit, {
      agentContext, triggerId: 'trigger-sm-concurrent-compact',
      runtimeProfile: { ...compactProfile(), env: { CAPTURE_FILE: compactCapture } },
    }),
  ]);

  const [fullCap, compactCap] = await Promise.all([readCapture(fullCapture), readCapture(compactCapture)]);
  assert.equal(fullCap.toolProfile, null, 'the full-profile child must never observe a compact header');
  assert.equal(compactCap.toolProfile, 'compact', 'the compact-profile child must never observe a missing header');
  assert.notEqual(fullCap.mcpConfigPath, compactCap.mcpConfigPath, 'the two profiles must resolve to DIFFERENT config paths');
});

// ─── BaseSessionManager: sequential transitions ─────────────────────────

test('BaseSessionManager#_spawnSession: sequential full → compact → full — fixture-observed header matches at every step', async () => {
  const claudeBin = await makeClaudeFixture('claude-bsm-seq-fcf.mjs');
  const agentId = 'agent-bsm-seq-fcf';
  const cwd = join(fixtureRoot, 'bsm-seq-fcf-cwd');
  await mkdir(cwd, { recursive: true });
  const agentContext = { agent_id: agentId, api_key: 'agent-awb-key', cwd, mcp_config_path: mcpConfigPathFor(agentId), cli: 'claude' };
  const manager = new BaseSessionManager(
    { ...baseConfig, delegation: { ...baseConfig.delegation, claudeBin } },
    { keyField: 'sessionKey', logTag: '[test-bsm-seq-fcf]', cfgPrefix: 'bsm-seq-fcf-', kindLabel: 'chat_session' },
  );

  async function step(profile, label, expectProfile) {
    const captureFile = join(fixtureRoot, `bsm-seq-fcf-${label}.json`);
    await spawnBaseSessionAndAwaitExit(manager, {
      agentContext, sessionKey: `sess-bsm-seq-fcf-${label}`,
      runtimeProfile: { ...profile, env: { ...(profile.env ?? {}), CAPTURE_FILE: captureFile } },
    });
    const capture = await readCapture(captureFile);
    assert.equal(capture.toolProfile, expectProfile, `${label}: fixture-observed header`);
  }

  await step(fullProfile(), '1-full', null);
  await step(compactProfile(), '2-compact', 'compact');
  await step(fullProfile(), '3-full', null); // the round-1 bug: this used to observe 'compact'
});

test('BaseSessionManager#_spawnSession: sequential compact → full → compact — fixture-observed header matches at every step', async () => {
  const claudeBin = await makeClaudeFixture('claude-bsm-seq-cfc.mjs');
  const agentId = 'agent-bsm-seq-cfc';
  const cwd = join(fixtureRoot, 'bsm-seq-cfc-cwd');
  await mkdir(cwd, { recursive: true });
  const agentContext = { agent_id: agentId, api_key: 'agent-awb-key', cwd, mcp_config_path: mcpConfigPathFor(agentId), cli: 'claude' };
  const manager = new BaseSessionManager(
    { ...baseConfig, delegation: { ...baseConfig.delegation, claudeBin } },
    { keyField: 'sessionKey', logTag: '[test-bsm-seq-cfc]', cfgPrefix: 'bsm-seq-cfc-', kindLabel: 'chat_session' },
  );

  async function step(profile, label, expectProfile) {
    const captureFile = join(fixtureRoot, `bsm-seq-cfc-${label}.json`);
    await spawnBaseSessionAndAwaitExit(manager, {
      agentContext, sessionKey: `sess-bsm-seq-cfc-${label}`,
      runtimeProfile: { ...profile, env: { ...(profile.env ?? {}), CAPTURE_FILE: captureFile } },
    });
    const capture = await readCapture(captureFile);
    assert.equal(capture.toolProfile, expectProfile, `${label}: fixture-observed header`);
  }

  await step(compactProfile(), '1-compact', 'compact');
  await step(fullProfile(), '2-full', null);
  await step(compactProfile(), '3-compact', 'compact');
});

// ─── BaseSessionManager: concurrency (review round 2) ───────────────────

test('BaseSessionManager#_spawnSession: CONCURRENT full + compact spawns for the same agent never cross-contaminate', async () => {
  const claudeBin = await makeClaudeFixture('claude-bsm-concurrent.mjs');
  const agentId = 'agent-bsm-concurrent';
  const cwd = join(fixtureRoot, 'bsm-concurrent-cwd');
  await mkdir(cwd, { recursive: true });
  const agentContext = { agent_id: agentId, api_key: 'agent-awb-key', cwd, mcp_config_path: mcpConfigPathFor(agentId), cli: 'claude' };
  const manager = new BaseSessionManager(
    { ...baseConfig, delegation: { ...baseConfig.delegation, claudeBin } },
    { keyField: 'sessionKey', logTag: '[test-bsm-concurrent]', cfgPrefix: 'bsm-concurrent-', kindLabel: 'chat_session' },
  );

  const fullCapture = join(fixtureRoot, 'bsm-concurrent-full.json');
  const compactCapture = join(fixtureRoot, 'bsm-concurrent-compact.json');

  await Promise.all([
    spawnBaseSessionAndAwaitExit(manager, {
      agentContext, sessionKey: 'sess-bsm-concurrent-full',
      runtimeProfile: { ...fullProfile(), env: { CAPTURE_FILE: fullCapture } },
    }),
    spawnBaseSessionAndAwaitExit(manager, {
      agentContext, sessionKey: 'sess-bsm-concurrent-compact',
      runtimeProfile: { ...compactProfile(), env: { CAPTURE_FILE: compactCapture } },
    }),
  ]);

  const [fullCap, compactCap] = await Promise.all([readCapture(fullCapture), readCapture(compactCapture)]);
  assert.equal(fullCap.toolProfile, null, 'the full-profile child must never observe a compact header');
  assert.equal(compactCap.toolProfile, 'compact', 'the compact-profile child must never observe a missing header');
  assert.notEqual(fullCap.mcpConfigPath, compactCap.mcpConfigPath, 'the two profiles must resolve to DIFFERENT config paths');
});

// ─── Workspace isolation (review round 3) ───────────────────────────────
//
// Round 2's profile-specific path fix (mcpConfigPathFor(..., profile))
// closed the profile dimension but dropped the workspace dimension —
// both managers passed `undefined` for workspaceId regardless of what
// agentContext/ctx actually carried. Two workspaces sharing an agent id
// would converge on the SAME unscoped path: whichever workspace's session
// spawned first "wins" the file (via the existsSync reuse fast path), and
// the other silently reuses it — wrong Authorization for that workspace,
// or a stale one, instead of getting its own workspace-scoped config.
//
// Deliberately sequential, not concurrent: this is a pure path-computation
// check on (agentId, workspaceId, profile). The concurrency dimension is
// already covered by the CONCURRENT tests above for the profile axis; nothing
// here depends on timing, so a race would only add noise.

test('SubagentManager#spawn: same agent id, different workspace ids resolve to different config paths and each observes its own Authorization', async () => {
  const claudeBin = await makeClaudeFixture('claude-sm-ws-iso.mjs');
  const agentId = 'agent-sm-ws-iso';
  const cwd = join(fixtureRoot, 'sm-ws-iso-cwd');
  await mkdir(cwd, { recursive: true });
  const manager = new SubagentManager({ ...baseConfig, delegation: { ...baseConfig.delegation, claudeBin } });
  const waitForPidExit = installExitRouter(manager);

  async function step(workspaceId, apiKey, label) {
    const captureFile = join(fixtureRoot, `sm-ws-iso-${label}.json`);
    const agentContext = {
      agent_id: agentId, workspace_id: workspaceId, api_key: apiKey, cwd,
      mcp_config_path: mcpConfigPathFor(agentId, workspaceId), cli: 'claude',
    };
    await spawnSubagentAndAwaitExit(manager, waitForPidExit, {
      agentContext, triggerId: `trigger-sm-ws-iso-${label}`,
      runtimeProfile: { ...fullProfile(), env: { CAPTURE_FILE: captureFile } },
    });
    return readCapture(captureFile);
  }

  const capA = await step('workspace-a', 'agent-awb-key-workspace-a', 'a');
  const capB = await step('workspace-b', 'agent-awb-key-workspace-b', 'b');

  assert.notEqual(capA.mcpConfigPath, capB.mcpConfigPath, 'workspace A and B must resolve to DIFFERENT config paths');
  assert.equal(capA.authorization, 'Bearer agent-awb-key-workspace-a', 'workspace A child must observe its own Authorization');
  assert.equal(capB.authorization, 'Bearer agent-awb-key-workspace-b', "workspace B child must observe its own Authorization — not workspace A's");
});

test('BaseSessionManager#_spawnSession: same agent id, different workspace ids resolve to different config paths and each observes its own Authorization', async () => {
  const claudeBin = await makeClaudeFixture('claude-bsm-ws-iso.mjs');
  const agentId = 'agent-bsm-ws-iso';
  const cwd = join(fixtureRoot, 'bsm-ws-iso-cwd');
  await mkdir(cwd, { recursive: true });
  const manager = new BaseSessionManager(
    { ...baseConfig, delegation: { ...baseConfig.delegation, claudeBin } },
    { keyField: 'sessionKey', logTag: '[test-bsm-ws-iso]', cfgPrefix: 'bsm-ws-iso-', kindLabel: 'chat_session' },
  );

  async function step(workspaceId, apiKey, label) {
    const captureFile = join(fixtureRoot, `bsm-ws-iso-${label}.json`);
    const agentContext = {
      agent_id: agentId, workspace_id: workspaceId, api_key: apiKey, cwd,
      mcp_config_path: mcpConfigPathFor(agentId, workspaceId), cli: 'claude',
    };
    await spawnBaseSessionAndAwaitExit(manager, {
      agentContext, sessionKey: `sess-bsm-ws-iso-${label}`,
      runtimeProfile: { ...fullProfile(), env: { CAPTURE_FILE: captureFile } },
    });
    return readCapture(captureFile);
  }

  const capA = await step('workspace-a', 'agent-awb-key-workspace-a', 'a');
  const capB = await step('workspace-b', 'agent-awb-key-workspace-b', 'b');

  assert.notEqual(capA.mcpConfigPath, capB.mcpConfigPath, 'workspace A and B must resolve to DIFFERENT config paths');
  assert.equal(capA.authorization, 'Bearer agent-awb-key-workspace-a', 'workspace A child must observe its own Authorization');
  assert.equal(capB.authorization, 'Bearer agent-awb-key-workspace-b', "workspace B child must observe its own Authorization — not workspace A's");
});
