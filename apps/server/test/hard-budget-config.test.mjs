// Hard-budget ceiling — config module (ticket a940d75b).
//
// Covers the pure schema/parse/resolve/serialize contract, mirroring
// respawn-storm-config.test.mjs-shape coverage (there isn't a standalone one
// of those, so this follows worktree-config.test.mjs's pattern instead):
//   (a) defaults are the documented conservative safety-net baseline
//   (b) parse degrades to null on malformed/empty/schema-violating input —
//       never throws on a read path
//   (c) resolve folds a per-board override onto the baseline, key-by-key
//   (d) validate REJECTS unknown keys / bad types so a write-path 400s
//   (e) serialize collapses an empty config to null (board reverts to
//       "inherit the baseline")
//   (f) env overrides fold onto the built-in defaults
//
// Imports the compiled module from dist/ (built by `npm run build`).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  HARD_BUDGET_CONFIG_KEYS,
  DEFAULT_HARD_BUDGET,
  hardBudgetDefaultsFromEnv,
  parseHardBudgetConfig,
  resolveHardBudgetConfig,
  resolveHardBudget,
  validateHardBudgetConfigInput,
  validateBoardHardBudgetConfigInput,
  serializeHardBudgetConfig,
} from '../dist/common/hard-budget-config.js';

test('defaults are the documented conservative safety-net baseline', () => {
  assert.deepEqual(DEFAULT_HARD_BUDGET, {
    enabled: true,
    maxAutoResponses: 100,
    windowMs: 60 * 60_000,
    maxDispatchesPerWindow: 30,
    maxTokensPerWindow: 2_000_000,
    maxRunsPerWindow: 50,
    autoPend: true,
    notify: true,
  });
});

test('parseHardBudgetConfig degrades to null on null/empty/malformed/unknown-key input', () => {
  assert.equal(parseHardBudgetConfig(null), null);
  assert.equal(parseHardBudgetConfig(undefined), null);
  assert.equal(parseHardBudgetConfig(''), null);
  assert.equal(parseHardBudgetConfig('not json'), null);
  assert.equal(parseHardBudgetConfig('{}'), null, 'an empty object collapses to null (inherit baseline)');
  assert.equal(parseHardBudgetConfig(JSON.stringify({ max_auto_responses: -5 })), null, 'schema violation (negative) degrades to null, never throws');
  assert.equal(parseHardBudgetConfig(JSON.stringify({ unknown_key: true })), null, 'strict schema rejects unknown keys on the read path too');
});

test('parseHardBudgetConfig accepts a valid partial override', () => {
  const parsed = parseHardBudgetConfig(JSON.stringify({ max_auto_responses: 50 }));
  assert.deepEqual(parsed, { max_auto_responses: 50 });
});

test('resolveHardBudgetConfig: null/corrupt raw inherits the baseline verbatim', () => {
  const base = hardBudgetDefaultsFromEnv({});
  assert.deepEqual(resolveHardBudgetConfig(null, base), base);
  assert.deepEqual(resolveHardBudgetConfig('not json', base), base);
});

test('resolveHardBudgetConfig: a board override replaces only the keys it sets', () => {
  const base = DEFAULT_HARD_BUDGET;
  const resolved = resolveHardBudgetConfig(JSON.stringify({ max_auto_responses: 200, notify: false }), base);
  assert.deepEqual(resolved, {
    enabled: true,
    maxAutoResponses: 200,
    windowMs: base.windowMs,
    maxDispatchesPerWindow: base.maxDispatchesPerWindow,
    maxTokensPerWindow: base.maxTokensPerWindow,
    maxRunsPerWindow: base.maxRunsPerWindow,
    autoPend: true,
    notify: false,
  });
});

test('resolveHardBudgetConfig: enabled:false opts a board out', () => {
  const resolved = resolveHardBudgetConfig(JSON.stringify({ enabled: false }), DEFAULT_HARD_BUDGET);
  assert.equal(resolved.enabled, false);
});

test('resolveHardBudgetConfig: window_minutes/max_dispatches_per_window convert to ms / stay as counts', () => {
  const resolved = resolveHardBudgetConfig(JSON.stringify({ window_minutes: 15, max_dispatches_per_window: 5 }), DEFAULT_HARD_BUDGET);
  assert.equal(resolved.windowMs, 15 * 60_000);
  assert.equal(resolved.maxDispatchesPerWindow, 5);
});

test('resolveHardBudgetConfig: max_tokens_per_window overrides independently and shares window_minutes with (c), not its own window (ticket ef53fdf4)', () => {
  const resolved = resolveHardBudgetConfig(
    JSON.stringify({ window_minutes: 15, max_dispatches_per_window: 5, max_tokens_per_window: 12345 }),
    DEFAULT_HARD_BUDGET,
  );
  assert.equal(resolved.windowMs, 15 * 60_000, 'the token ceiling has no separate window field — it reads the same windowMs');
  assert.equal(resolved.maxTokensPerWindow, 12345);

  const tokenOnly = resolveHardBudgetConfig(JSON.stringify({ max_tokens_per_window: 999 }), DEFAULT_HARD_BUDGET);
  assert.equal(tokenOnly.maxTokensPerWindow, 999);
  assert.equal(tokenOnly.maxDispatchesPerWindow, DEFAULT_HARD_BUDGET.maxDispatchesPerWindow, 'unset keys keep the baseline');
  assert.equal(tokenOnly.windowMs, DEFAULT_HARD_BUDGET.windowMs);
});

test('validateHardBudgetConfigInput: rejects unknown keys and out-of-range values (write-path 400)', () => {
  assert.equal(validateHardBudgetConfigInput({ typo_field: true }).ok, false);
  assert.equal(validateHardBudgetConfigInput({ max_auto_responses: 0 }).ok, false, 'must be positive');
  assert.equal(validateHardBudgetConfigInput({ window_minutes: 2000 }).ok, false, 'must be <= 1440 (24h)');
  assert.equal(validateHardBudgetConfigInput({ max_tokens_per_window: 0 }).ok, false, 'must be positive');
  assert.equal(validateHardBudgetConfigInput({ max_tokens_per_window: 200_000_000 }).ok, false, 'must be <= 100,000,000');
  assert.equal(validateHardBudgetConfigInput({ max_runs_per_window: 0 }).ok, false, 'must be positive');
  assert.equal(validateHardBudgetConfigInput({ max_runs_per_window: 1001 }).ok, false, 'must be <= 1000');
});

test('validateHardBudgetConfigInput: accepts a well-formed partial config', () => {
  const result = validateHardBudgetConfigInput({ max_auto_responses: 50, auto_pend: false });
  assert.equal(result.ok, true);
  assert.deepEqual(result.value, { max_auto_responses: 50, auto_pend: false });
});

// ── BoardHardBudgetConfigSchema / validateBoardHardBudgetConfigInput (티켓
//    73b92d23) — update_board(MCP)와 boards.controller.ts의 PATCH가 쓰는
//    board-scope 서브셋. max_runs_per_window는 워크스페이스 전용
//    (resolveHardBudgetForWorkspace, run-budget-guard.ts)이고,
//    resolveHardBudgetForTicket(board의 hard_budget_config가 실제로 흘러가는
//    곳)은 이 필드를 전혀 읽지 않는다 — 그래서 board scope에서 이 필드를
//    받아주면 조용히 validation을 통과해 저장되는 no-op이었다. ──────────────
test('validateBoardHardBudgetConfigInput: max_runs_per_window를 거부한다 (워크스페이스 전용, board 레이어 없음)', () => {
  const result = validateBoardHardBudgetConfigInput({ max_runs_per_window: 10 });
  assert.equal(result.ok, false);
  assert.match(result.error, /max_runs_per_window/);
});

test('validateBoardHardBudgetConfigInput: 나머지 board-scope 키는 그대로 허용한다', () => {
  const input = {
    enabled: true,
    max_auto_responses: 50,
    window_minutes: 15,
    max_dispatches_per_window: 5,
    max_tokens_per_window: 12345,
    auto_pend: false,
    notify: false,
  };
  const result = validateBoardHardBudgetConfigInput(input);
  assert.equal(result.ok, true);
  assert.deepEqual(result.value, input);
});

test('validateBoardHardBudgetConfigInput: 알 수 없는 키·범위 초과 값은 ticket-scope validator와 동일하게 거부한다', () => {
  assert.equal(validateBoardHardBudgetConfigInput({ typo_field: true }).ok, false);
  assert.equal(validateBoardHardBudgetConfigInput({ max_auto_responses: 0 }).ok, false, '양수여야 함');
  assert.equal(validateBoardHardBudgetConfigInput({ window_minutes: 2000 }).ok, false, '1440(24시간) 이하여야 함');
});

test('validateHardBudgetConfigInput(워크스페이스 스코프)은 max_runs_per_window를 계속 허용한다 — 거부는 board 스코프에만 적용', () => {
  const result = validateHardBudgetConfigInput({ max_runs_per_window: 10 });
  assert.equal(result.ok, true);
  assert.deepEqual(result.value, { max_runs_per_window: 10 });
});

test('serializeHardBudgetConfig: empty/undefined collapses to null; a real value round-trips', () => {
  assert.equal(serializeHardBudgetConfig(null), null);
  assert.equal(serializeHardBudgetConfig(undefined), null);
  assert.equal(serializeHardBudgetConfig({}), null);
  const serialized = serializeHardBudgetConfig({ max_auto_responses: 50 });
  assert.equal(serialized, JSON.stringify({ max_auto_responses: 50 }));
  assert.deepEqual(parseHardBudgetConfig(serialized), { max_auto_responses: 50 });
});

test('HARD_BUDGET_CONFIG_KEYS matches the schema surface (drift guard)', () => {
  assert.deepEqual([...HARD_BUDGET_CONFIG_KEYS].sort(), [
    'auto_pend', 'enabled', 'max_auto_responses', 'max_dispatches_per_window', 'max_runs_per_window', 'max_tokens_per_window', 'notify', 'window_minutes',
  ]);
});

test('hardBudgetDefaultsFromEnv: env overrides fold onto the built-in defaults', () => {
  const env = {
    HARD_BUDGET_ENABLED: 'false',
    HARD_BUDGET_MAX_AUTO_RESPONSES: '250',
    HARD_BUDGET_WINDOW_MINUTES: '10',
    HARD_BUDGET_MAX_DISPATCHES_PER_WINDOW: '3',
    HARD_BUDGET_MAX_TOKENS_PER_WINDOW: '500000',
    HARD_BUDGET_MAX_RUNS_PER_WINDOW: '4',
    HARD_BUDGET_AUTO_PEND: '0',
    HARD_BUDGET_NOTIFY: 'off',
  };
  assert.deepEqual(hardBudgetDefaultsFromEnv(env), {
    enabled: false,
    maxAutoResponses: 250,
    windowMs: 10 * 60_000,
    maxDispatchesPerWindow: 3,
    maxTokensPerWindow: 500000,
    maxRunsPerWindow: 4,
    autoPend: false,
    notify: false,
  });
});

test('hardBudgetDefaultsFromEnv: unset/blank env falls back to DEFAULT_HARD_BUDGET', () => {
  assert.deepEqual(hardBudgetDefaultsFromEnv({}), DEFAULT_HARD_BUDGET);
});

// ── (d) max_runs_per_window (ticket a51ec6d9) ───────────────────────────────
test('resolveHardBudgetConfig: max_runs_per_window overrides independently and shares window_minutes, not its own window', () => {
  const resolved = resolveHardBudgetConfig(
    JSON.stringify({ window_minutes: 20, max_runs_per_window: 2 }),
    DEFAULT_HARD_BUDGET,
  );
  assert.equal(resolved.windowMs, 20 * 60_000, 'the run-rate ceiling has no separate window field — it reads the same windowMs');
  assert.equal(resolved.maxRunsPerWindow, 2);

  const untouched = resolveHardBudgetConfig(JSON.stringify({ max_auto_responses: 5 }), DEFAULT_HARD_BUDGET);
  assert.equal(untouched.maxRunsPerWindow, DEFAULT_HARD_BUDGET.maxRunsPerWindow, 'unset keeps the baseline');
});

// ── resolveHardBudget: workspace→board→base precedence (ticket a51ec6d9) ───
// The `hard_budget_config` analogue of harness-config.ts's resolveHarnessConfig
// — a board wins per key it sets, unset keys fall to the workspace, both unset
// fall to `base` (the env-folded baseline).
test('resolveHardBudget: both workspace and board null inherits base verbatim', () => {
  const base = hardBudgetDefaultsFromEnv({});
  assert.deepEqual(resolveHardBudget(null, null, base), base);
});

test('resolveHardBudget: a workspace-only override applies when the board is null (the ActionRun/OrchestrationMission shape — no board layer)', () => {
  const resolved = resolveHardBudget(JSON.stringify({ max_runs_per_window: 3 }), null, DEFAULT_HARD_BUDGET);
  assert.equal(resolved.maxRunsPerWindow, 3);
  assert.equal(resolved.maxAutoResponses, DEFAULT_HARD_BUDGET.maxAutoResponses, 'keys the workspace does not set keep the base');
});

test('resolveHardBudget: a board-only override applies when the workspace is null', () => {
  const resolved = resolveHardBudget(null, JSON.stringify({ notify: false }), DEFAULT_HARD_BUDGET);
  assert.equal(resolved.notify, false);
});

test('resolveHardBudget: the board wins per key over the workspace; unset board keys fall through to the workspace', () => {
  const resolved = resolveHardBudget(
    JSON.stringify({ max_auto_responses: 55, notify: true }),
    JSON.stringify({ notify: false }),
    DEFAULT_HARD_BUDGET,
  );
  assert.equal(resolved.notify, false, 'board explicitly sets notify — board wins');
  assert.equal(resolved.maxAutoResponses, 55, 'board leaves max_auto_responses unset — inherits from the workspace layer');
});
