// ticket c3b767c6 — dispatch-time manager-capability compatibility gate.
//
// Regression target: an agent-manager build that predates capability
// reporting (source incident, ticket 1af53029) must NOT silently pass a
// dispatch whose profile requires context_window clamping. These tests
// contrast an old-shaped manager instance snapshot (no manager_capabilities
// field, or the field present but missing the flag) against a new one (flag
// present) and assert the gate's verdict flips accordingly — the exact
// contrast the ticket asks for, at the pure-logic layer both dispatch call
// sites (TriggerLoopService, RoomMessagingService) share.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST_ROOT = path.resolve(__dirname, '..', 'dist');

const {
  MANAGER_CAPABILITY_CONTEXT_WINDOW_CLAMP,
  requiredManagerCapability,
  evaluateManagerCapability,
  checkManagerCapabilityForDispatch,
} = await import('file://' + path.join(DIST_ROOT, 'common', 'manager-capability-gate.js'));

const PROFILE_WITH_CLAMP = { id: 'vllm-qwen3-coder', context_window: 65536, safety_margin_tokens: 20000 };
const PROFILE_WITHOUT_CLAMP = { id: 'anthropic-default' };

const OLD_MANAGER_NO_FIELD = { plugin_version: '1.6.30' }; // predates this ticket entirely
const OLD_MANAGER_EMPTY_CAPS = { plugin_version: '1.6.93', manager_capabilities: [] }; // reports, has none
const OLD_MANAGER_OTHER_CAPS = { plugin_version: '1.6.93', manager_capabilities: ['some_other_flag'] };
const NEW_MANAGER = { plugin_version: '1.6.94', manager_capabilities: [MANAGER_CAPABILITY_CONTEXT_WINDOW_CLAMP] };

test('requiredManagerCapability: only a context_window-bearing profile opts in', () => {
  assert.equal(requiredManagerCapability(PROFILE_WITH_CLAMP), MANAGER_CAPABILITY_CONTEXT_WINDOW_CLAMP);
  assert.equal(requiredManagerCapability(PROFILE_WITHOUT_CLAMP), null);
  assert.equal(requiredManagerCapability(null), null);
  assert.equal(requiredManagerCapability(undefined), null);
});

test('evaluateManagerCapability: zero live instances fails OPEN (no telemetry to prove incompatibility)', () => {
  const verdict = evaluateManagerCapability([], MANAGER_CAPABILITY_CONTEXT_WINDOW_CLAMP);
  assert.equal(verdict.ok, true);
});

test('evaluateManagerCapability: an old manager (field entirely absent) fails CLOSED — the exact 1af53029 incident shape', () => {
  const verdict = evaluateManagerCapability([OLD_MANAGER_NO_FIELD], MANAGER_CAPABILITY_CONTEXT_WINDOW_CLAMP);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, 'manager_capability_missing');
  assert.match(verdict.detail, /1\.6\.30/);
  assert.match(verdict.detail, /context_window_clamp/);
});

test('evaluateManagerCapability: a manager that reports capabilities but omits this one still fails CLOSED', () => {
  const verdict = evaluateManagerCapability([OLD_MANAGER_EMPTY_CAPS], MANAGER_CAPABILITY_CONTEXT_WINDOW_CLAMP);
  assert.equal(verdict.ok, false);
  const verdict2 = evaluateManagerCapability([OLD_MANAGER_OTHER_CAPS], MANAGER_CAPABILITY_CONTEXT_WINDOW_CLAMP);
  assert.equal(verdict2.ok, false);
});

test('evaluateManagerCapability: a manager that declares the flag passes', () => {
  const verdict = evaluateManagerCapability([NEW_MANAGER], MANAGER_CAPABILITY_CONTEXT_WINDOW_CLAMP);
  assert.equal(verdict.ok, true);
});

test('evaluateManagerCapability: multi-instance agent — ANY incompatible instance fails the whole agent CLOSED (cannot control routing)', () => {
  const verdict = evaluateManagerCapability([NEW_MANAGER, OLD_MANAGER_NO_FIELD], MANAGER_CAPABILITY_CONTEXT_WINDOW_CLAMP);
  assert.equal(verdict.ok, false, 'one old instance behind the same agent identity must block dispatch even if a sibling instance is compatible');
});

test('evaluateManagerCapability: multi-instance agent — every instance compatible passes', () => {
  const verdict = evaluateManagerCapability([NEW_MANAGER, { ...NEW_MANAGER, plugin_version: '1.6.95' }], MANAGER_CAPABILITY_CONTEXT_WINDOW_CLAMP);
  assert.equal(verdict.ok, true);
});

test('checkManagerCapabilityForDispatch: old vs new manager contrast for the SAME profile (the ticket\'s literal regression ask)', () => {
  const oldVerdict = checkManagerCapabilityForDispatch(PROFILE_WITH_CLAMP, [OLD_MANAGER_NO_FIELD]);
  const newVerdict = checkManagerCapabilityForDispatch(PROFILE_WITH_CLAMP, [NEW_MANAGER]);
  assert.equal(oldVerdict.ok, false, 'old manager must be refused for a context_window-bearing profile');
  assert.equal(newVerdict.ok, true, 'new manager must be allowed for the identical profile');
});

test('checkManagerCapabilityForDispatch: a profile without context_window never gates, regardless of manager version', () => {
  assert.equal(checkManagerCapabilityForDispatch(PROFILE_WITHOUT_CLAMP, [OLD_MANAGER_NO_FIELD]).ok, true);
  assert.equal(checkManagerCapabilityForDispatch(PROFILE_WITHOUT_CLAMP, []).ok, true);
  assert.equal(checkManagerCapabilityForDispatch(null, [OLD_MANAGER_NO_FIELD]).ok, true);
});
