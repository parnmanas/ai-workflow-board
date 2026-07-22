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
  validateHardBudgetConfigInput,
  serializeHardBudgetConfig,
} from '../dist/common/hard-budget-config.js';

test('defaults are the documented conservative safety-net baseline', () => {
  assert.deepEqual(DEFAULT_HARD_BUDGET, {
    enabled: true,
    maxAutoResponses: 100,
    windowMs: 60 * 60_000,
    maxDispatchesPerWindow: 30,
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

test('validateHardBudgetConfigInput: rejects unknown keys and out-of-range values (write-path 400)', () => {
  assert.equal(validateHardBudgetConfigInput({ typo_field: true }).ok, false);
  assert.equal(validateHardBudgetConfigInput({ max_auto_responses: 0 }).ok, false, 'must be positive');
  assert.equal(validateHardBudgetConfigInput({ window_minutes: 2000 }).ok, false, 'must be <= 1440 (24h)');
});

test('validateHardBudgetConfigInput: accepts a well-formed partial config', () => {
  const result = validateHardBudgetConfigInput({ max_auto_responses: 50, auto_pend: false });
  assert.equal(result.ok, true);
  assert.deepEqual(result.value, { max_auto_responses: 50, auto_pend: false });
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
    'auto_pend', 'enabled', 'max_auto_responses', 'max_dispatches_per_window', 'notify', 'window_minutes',
  ]);
});

test('hardBudgetDefaultsFromEnv: env overrides fold onto the built-in defaults', () => {
  const env = {
    HARD_BUDGET_ENABLED: 'false',
    HARD_BUDGET_MAX_AUTO_RESPONSES: '250',
    HARD_BUDGET_WINDOW_MINUTES: '10',
    HARD_BUDGET_MAX_DISPATCHES_PER_WINDOW: '3',
    HARD_BUDGET_AUTO_PEND: '0',
    HARD_BUDGET_NOTIFY: 'off',
  };
  assert.deepEqual(hardBudgetDefaultsFromEnv(env), {
    enabled: false,
    maxAutoResponses: 250,
    windowMs: 10 * 60_000,
    maxDispatchesPerWindow: 3,
    autoPend: false,
    notify: false,
  });
});

test('hardBudgetDefaultsFromEnv: unset/blank env falls back to DEFAULT_HARD_BUDGET', () => {
  assert.deepEqual(hardBudgetDefaultsFromEnv({}), DEFAULT_HARD_BUDGET);
});
