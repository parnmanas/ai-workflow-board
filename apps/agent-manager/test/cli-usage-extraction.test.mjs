// extractUsage() per adapter + the cross-turn accumulator (ticket 6dd3f968).
// Fixtures below are captured REAL CLI output, not guessed shapes:
//   - claude: `claude --print --output-format json` (auth-failure sample —
//     all-zero but structurally identical to a priced success; `result` type,
//     usage nested, total_cost_usd top-level).
//   - codex: `codex exec --json` (authenticated, successful "OK" reply) —
//     `turn.completed` type, usage nested, no cost field at all.

import test from 'node:test';
import assert from 'node:assert/strict';

import { ClaudeCliAdapter } from '../dist/lib/cli-adapters/claude.js';
import { CodexCliAdapter } from '../dist/lib/cli-adapters/codex.js';
import { AntigravityCliAdapter } from '../dist/lib/cli-adapters/antigravity.js';
import { DeepSeekCliAdapter } from '../dist/lib/cli-adapters/deepseek.js';
import { accumulateUsage } from '../dist/lib/cli-usage-accumulator.js';

// Real sample captured via `claude --print --output-format json "..."` in this
// sandbox (unauthenticated — is_error:true, all usage zeroed — but the SHAPE is
// what matters: total_cost_usd top-level, usage nested with these exact keys).
const CLAUDE_RESULT_EVENT = {
  type: 'result',
  subtype: 'success',
  is_error: true,
  api_error_status: null,
  duration_ms: 187,
  duration_api_ms: 0,
  num_turns: 1,
  result: 'Not logged in · Please run /login',
  stop_reason: 'stop_sequence',
  session_id: '00bdabbd-a25c-4b26-b098-b1c7be5a15ed',
  total_cost_usd: 0,
  usage: {
    input_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    output_tokens: 0,
    server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 },
    service_tier: 'standard',
  },
  modelUsage: {},
  permission_denials: [],
  terminal_reason: 'api_error',
  fast_mode_state: 'off',
  uuid: 'eeb6d174-f46f-4d1f-857e-abcedda52bd3',
};

// Real sample captured via `codex exec --json` in this sandbox (authenticated,
// successful "OK" reply).
const CODEX_TURN_COMPLETED_EVENT = {
  type: 'turn.completed',
  usage: {
    input_tokens: 12437,
    cached_input_tokens: 9984,
    output_tokens: 5,
    reasoning_output_tokens: 0,
  },
};

test('ClaudeCliAdapter.extractUsage reads the real result-event shape', () => {
  const adapter = new ClaudeCliAdapter();
  assert.deepEqual(adapter.extractUsage(CLAUDE_RESULT_EVENT), {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
    total_cost_usd: 0,
  });
});

test('ClaudeCliAdapter.extractUsage reads a priced result event', () => {
  const adapter = new ClaudeCliAdapter();
  const priced = {
    ...CLAUDE_RESULT_EVENT,
    is_error: false,
    total_cost_usd: 0.0421,
    usage: {
      input_tokens: 1500,
      cache_creation_input_tokens: 200,
      cache_read_input_tokens: 8000,
      output_tokens: 340,
    },
  };
  assert.deepEqual(adapter.extractUsage(priced), {
    input_tokens: 1500,
    output_tokens: 340,
    cache_read_input_tokens: 8000,
    cache_creation_input_tokens: 200,
    total_cost_usd: 0.0421,
  });
});

test('ClaudeCliAdapter.extractUsage returns null for non-result events', () => {
  const adapter = new ClaudeCliAdapter();
  assert.equal(adapter.extractUsage({ type: 'assistant', message: {} }), null);
  assert.equal(adapter.extractUsage(null), null);
  assert.equal(adapter.extractUsage('not an object'), null);
});

test('ClaudeCliAdapter.extractUsage returns null when result has no usage object', () => {
  const adapter = new ClaudeCliAdapter();
  assert.equal(adapter.extractUsage({ type: 'result', total_cost_usd: 0 }), null);
});

test('CodexCliAdapter.extractUsage reads the real turn.completed shape, mapping cached_input_tokens to cache_read', () => {
  const adapter = new CodexCliAdapter();
  assert.deepEqual(adapter.extractUsage(CODEX_TURN_COMPLETED_EVENT), {
    input_tokens: 12437,
    output_tokens: 5,
    cache_read_input_tokens: 9984,
    cache_creation_input_tokens: null,
    total_cost_usd: null,
  });
});

test('CodexCliAdapter.extractUsage never reports a cost (Codex has no cost concept)', () => {
  const adapter = new CodexCliAdapter();
  const snap = adapter.extractUsage(CODEX_TURN_COMPLETED_EVENT);
  assert.equal(snap.total_cost_usd, null);
});

test('CodexCliAdapter.extractUsage returns null for non-turn.completed events', () => {
  const adapter = new CodexCliAdapter();
  assert.equal(adapter.extractUsage({ type: 'item.completed', item: {} }), null);
  assert.equal(adapter.extractUsage(null), null);
});

test('AntigravityCliAdapter.extractUsage is unconditionally null (v1: no structured usage)', () => {
  const adapter = new AntigravityCliAdapter();
  assert.equal(adapter.extractUsage({ type: 'result', usage: { input_tokens: 1 } }), null);
  assert.equal(adapter.extractUsage('plain text output'), null);
});

test('DeepSeekCliAdapter.extractUsage inherits Claude token parsing but nulls total_cost_usd', () => {
  const adapter = new DeepSeekCliAdapter();
  const priced = {
    ...CLAUDE_RESULT_EVENT,
    total_cost_usd: 0.0421, // computed by the claude binary against ANTHROPIC pricing — bogus for DeepSeek
    usage: { input_tokens: 500, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 120 },
  };
  assert.deepEqual(adapter.extractUsage(priced), {
    input_tokens: 500,
    output_tokens: 120,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
    total_cost_usd: null,
  });
});

test('DeepSeekCliAdapter.extractUsage stays null when the underlying Claude parse is null', () => {
  const adapter = new DeepSeekCliAdapter();
  assert.equal(adapter.extractUsage({ type: 'assistant' }), null);
});

// ─── accumulateUsage ────────────────────────────────────────────────────────

test('accumulateUsage sums numeric fields across turns', () => {
  const turn1 = { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 500, total_cost_usd: 0.01 };
  const turn2 = { input_tokens: 150, output_tokens: 30, cache_read_input_tokens: 500, cache_creation_input_tokens: 0, total_cost_usd: 0.015 };
  let acc = null;
  acc = accumulateUsage(acc, turn1);
  acc = accumulateUsage(acc, turn2);
  assert.deepEqual(acc, {
    input_tokens: 250,
    output_tokens: 50,
    cache_read_input_tokens: 500,
    cache_creation_input_tokens: 500,
    total_cost_usd: 0.025,
  });
});

test('accumulateUsage keeps a field null when every observed turn was null for it (Codex cost)', () => {
  const turn1 = { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: null, total_cost_usd: null };
  const turn2 = { input_tokens: 50, output_tokens: 5, cache_read_input_tokens: 40, cache_creation_input_tokens: null, total_cost_usd: null };
  let acc = null;
  acc = accumulateUsage(acc, turn1);
  acc = accumulateUsage(acc, turn2);
  assert.equal(acc.total_cost_usd, null);
  assert.equal(acc.cache_creation_input_tokens, null);
  assert.equal(acc.input_tokens, 150);
});

test('accumulateUsage is a no-op when next is null, and seeds from the first non-null snapshot', () => {
  const turn1 = { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, total_cost_usd: 0 };
  assert.equal(accumulateUsage(null, null), null);
  assert.deepEqual(accumulateUsage(null, turn1), turn1);
  assert.deepEqual(accumulateUsage(turn1, null), turn1);
});
