// Harness-config spawn application (ticket e9c7a896) — the board/workspace
// harness shipped on agent_trigger must map onto CLI flags without changing
// any spawn that carries no harness. Covers:
//   - parseHarnessConfig: defensive event-field parse (object / JSON string /
//     malformed / unknown keys → null or pruned)
//   - partitionHarness: claude takes all keys, model-only adapters keep model
//     and skip the rest
//   - ClaudeCliAdapter argv: append-system-prompt MERGE (role prompt always
//     survives), allowedTools APPEND to the AWB baseline, disallowedTools,
//     permission-mode REPLACING --dangerously-skip-permissions
//   - no-harness argv is byte-identical to the pre-harness shape (null-safe
//     regression contract)
//   - deepseek harnessEnv mirrors harness.model into ANTHROPIC_MODEL

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseHarnessConfig } from '../dist/lib/event-dispatcher.js';
import { partitionHarness } from '../dist/lib/cli-adapters/base.js';
import { ClaudeCliAdapter } from '../dist/lib/cli-adapters/claude.js';
import { AntigravityCliAdapter } from '../dist/lib/cli-adapters/antigravity.js';
import { DeepSeekCliAdapter } from '../dist/lib/cli-adapters/deepseek.js';

const FULL_HARNESS = {
  system_prompt_append: 'Always run the linter before committing.',
  allowed_tools: ['Bash(npm run lint)', 'WebSearch'],
  disallowed_tools: ['WebFetch'],
  model: 'claude-sonnet-4-6',
  permission_mode: 'acceptEdits',
};

// ─── parseHarnessConfig (event field → HarnessSpec) ───────────────────────

test('parseHarnessConfig accepts a plain object and keeps known keys', () => {
  const out = parseHarnessConfig({ ...FULL_HARNESS, unknown_key: 'x' });
  assert.deepEqual(out, FULL_HARNESS);
});

test('parseHarnessConfig accepts a JSON string', () => {
  const out = parseHarnessConfig(JSON.stringify({ model: 'opus' }));
  assert.deepEqual(out, { model: 'opus' });
});

test('parseHarnessConfig degrades to null on garbage', () => {
  assert.equal(parseHarnessConfig(undefined), null);
  assert.equal(parseHarnessConfig(null), null);
  assert.equal(parseHarnessConfig(''), null);
  assert.equal(parseHarnessConfig('not json'), null);
  assert.equal(parseHarnessConfig([1, 2]), null);
  assert.equal(parseHarnessConfig({ unknown: true }), null);
  // wrong runtime types are pruned, empty result collapses to null
  assert.equal(parseHarnessConfig({ model: 42, allowed_tools: 'oops' }), null);
});

test('parseHarnessConfig prunes empty strings / empty arrays', () => {
  const out = parseHarnessConfig({
    system_prompt_append: '   ',
    allowed_tools: [],
    disallowed_tools: ['', '  '],
    model: ' fable ',
  });
  assert.deepEqual(out, { model: 'fable' });
});

// ─── partitionHarness (adapter capability split) ───────────────────────────

test('partitionHarness: claude applies the full key set', () => {
  const { applied, skipped } = partitionHarness(new ClaudeCliAdapter(), FULL_HARNESS);
  assert.deepEqual(applied, FULL_HARNESS);
  assert.deepEqual(skipped, []);
});

test('partitionHarness: model-only adapter keeps model, skips the rest', () => {
  const { applied, skipped } = partitionHarness(new AntigravityCliAdapter(), FULL_HARNESS);
  assert.deepEqual(applied, { model: 'claude-sonnet-4-6' });
  assert.deepEqual(skipped.sort(), [
    'allowed_tools',
    'disallowed_tools',
    'permission_mode',
    'system_prompt_append',
  ]);
});

test('partitionHarness: null harness stays null with no skips', () => {
  const { applied, skipped } = partitionHarness(new ClaudeCliAdapter(), null);
  assert.equal(applied, null);
  assert.deepEqual(skipped, []);
});

// ─── ClaudeCliAdapter argv application ─────────────────────────────────────

function oneshotArgs(harness) {
  return new ClaudeCliAdapter().buildOneshotSpawn({
    rolePrompt: 'You are the assignee.',
    taskText: 'do the work',
    mcpConfigPath: '/tmp/cfg.json',
    model: harness?.model ?? null,
    harness,
  }).args;
}

function flagValue(args, flag) {
  const i = args.indexOf(flag);
  return i === -1 ? undefined : args[i + 1];
}

test('claude oneshot WITHOUT harness keeps the pre-harness argv shape', () => {
  const args = oneshotArgs(null);
  assert.equal(flagValue(args, '--append-system-prompt'), 'You are the assignee.');
  assert.equal(flagValue(args, '--allowedTools'), 'mcp__awb__*,mcp__host__*');
  assert.ok(args.includes('--dangerously-skip-permissions'));
  assert.ok(!args.includes('--disallowedTools'));
  assert.ok(!args.includes('--permission-mode'));
  assert.ok(!args.includes('--model'));
});

test('claude oneshot WITH harness maps every key onto flags', () => {
  const args = oneshotArgs(FULL_HARNESS);
  // system_prompt_append is APPENDED after the role prompt, never replaces it
  assert.equal(
    flagValue(args, '--append-system-prompt'),
    'You are the assignee.\n\nAlways run the linter before committing.',
  );
  // allowed_tools APPEND to the AWB baseline (replacing would cut MCP off)
  assert.equal(
    flagValue(args, '--allowedTools'),
    'mcp__awb__*,mcp__host__*,Bash(npm run lint),WebSearch',
  );
  assert.equal(flagValue(args, '--disallowedTools'), 'WebFetch');
  // permission_mode REPLACES the skip flag (skip pins bypassPermissions)
  assert.equal(flagValue(args, '--permission-mode'), 'acceptEdits');
  assert.ok(!args.includes('--dangerously-skip-permissions'));
  assert.equal(flagValue(args, '--model'), 'claude-sonnet-4-6');
  // task text stays the trailing positional arg
  assert.equal(args[args.length - 1], 'do the work');
});

test('claude session spawn applies the same harness flags', () => {
  const args = new ClaudeCliAdapter().buildSessionSpawn({
    rolePrompt: 'role',
    mcpConfigPath: '/tmp/cfg.json',
    model: FULL_HARNESS.model,
    harness: FULL_HARNESS,
  }).args;
  assert.equal(flagValue(args, '--append-system-prompt'), 'role\n\nAlways run the linter before committing.');
  assert.equal(flagValue(args, '--permission-mode'), 'acceptEdits');
  assert.ok(!args.includes('--dangerously-skip-permissions'));
  assert.equal(flagValue(args, '--disallowedTools'), 'WebFetch');
});

test('claude harness with only system_prompt_append leaves permissions/tools untouched', () => {
  const args = oneshotArgs({ system_prompt_append: 'extra' });
  assert.ok(args.includes('--dangerously-skip-permissions'));
  assert.equal(flagValue(args, '--allowedTools'), 'mcp__awb__*,mcp__host__*');
  assert.equal(flagValue(args, '--append-system-prompt'), 'You are the assignee.\n\nextra');
});

// ─── deepseek flag/env agreement ───────────────────────────────────────────

test('deepseek harnessEnv mirrors harness.model into ANTHROPIC_MODEL', () => {
  const a = new DeepSeekCliAdapter();
  assert.deepEqual(a.harnessEnv({ model: 'deepseek-reasoner' }), {
    ANTHROPIC_MODEL: 'deepseek-reasoner',
  });
  assert.deepEqual(a.harnessEnv({ system_prompt_append: 'x' }), {});
  assert.deepEqual(a.harnessEnv(null), {});
});

test('claude harnessEnv stays empty (flag is authoritative on the real backend)', () => {
  assert.deepEqual(new ClaudeCliAdapter().harnessEnv(FULL_HARNESS), {});
});
