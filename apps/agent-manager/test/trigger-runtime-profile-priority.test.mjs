// resolveTriggerRuntimeProfile (ticket 0fbe802c, 7d8ea7c9 root cause C
// follow-up) — the ticket-dispatch path (#dispatchTriggerBody) used to let
// the instance-wide `--runtime-profile <file>` override always win whenever
// it was set:
//
//   const runtimeProfile = this.#runtimeProfileOverride !== undefined
//     ? this.#runtimeProfileOverride
//     : parseRuntimeProfile(ev.cli_runtime_profile);
//
// On a manager instance hosting multiple agents (e.g. one Manager agent plus
// one dedicated vLLM agent) with the override flag set for the vLLM agent,
// EVERY agent doing ticket work — Manager included — got force-routed to the
// override backend regardless of its own per-agent cli_runtime_profile. This
// is the same cross-contamination ticket 7d8ea7c9 already fixed for the chat
// path (which ignores the override entirely). The ticket-dispatch path keeps
// the override as a fallback (unlike chat) so a single-agent host can still
// use `--runtime-profile <file>` to force a backend without a DB profile —
// it just no longer wins over an agent that DOES have its own profile.
//
// Covers:
//   - a valid per-agent profile always wins, regardless of what the
//     instance override is (unset / a different profile / explicit `none`)
//   - the instance override is still used as a fallback when there's no
//     per-agent profile (unset OR malformed raw input)
//   - no per-agent profile and no override -> null (CLI default)

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { resolveTriggerRuntimeProfile } from '../dist/lib/event-dispatcher.js';

// `provider` is carried on both fixtures purely so they parse successfully
// under parseRuntimeProfile() regardless of whether ticket 7d8ea7c9 (which
// drops the `provider` requirement — root cause B, a separate bug from the
// priority-ordering issue this file covers) has merged yet. These tests
// exercise resolveTriggerRuntimeProfile's fallback ordering only; they don't
// care about parseRuntimeProfile's exact validation rules.
const AGENT_PROFILE = {
  id: 'agent-db-profile',
  provider: 'anthropic',
  protocol: 'anthropic-compatible',
  base_url: 'http://192.168.0.6:8000',
  model: 'qwen3-coder-next',
};

const INSTANCE_OVERRIDE_PROFILE = {
  id: 'instance-cli-override',
  provider: 'anthropic',
  protocol: 'anthropic-compatible',
  base_url: 'http://127.0.0.1:8000',
  model: 'some-other-model',
};

test('resolveTriggerRuntimeProfile: valid per-agent profile wins when no instance override is set', () => {
  const out = resolveTriggerRuntimeProfile(AGENT_PROFILE, undefined);
  assert.deepEqual(out, AGENT_PROFILE);
});

test('resolveTriggerRuntimeProfile: valid per-agent profile wins over a DIFFERENT instance override (the cross-contamination fix)', () => {
  const out = resolveTriggerRuntimeProfile(AGENT_PROFILE, INSTANCE_OVERRIDE_PROFILE);
  assert.deepEqual(out, AGENT_PROFILE);
});

test('resolveTriggerRuntimeProfile: valid per-agent profile wins over an explicit `--runtime-profile none` (instanceOverride === null)', () => {
  const out = resolveTriggerRuntimeProfile(AGENT_PROFILE, null);
  assert.deepEqual(out, AGENT_PROFILE);
});

test('resolveTriggerRuntimeProfile: no per-agent profile (null) falls back to the instance override', () => {
  const out = resolveTriggerRuntimeProfile(null, INSTANCE_OVERRIDE_PROFILE);
  assert.deepEqual(out, INSTANCE_OVERRIDE_PROFILE);
});

test('resolveTriggerRuntimeProfile: no per-agent profile (undefined) falls back to the instance override', () => {
  const out = resolveTriggerRuntimeProfile(undefined, INSTANCE_OVERRIDE_PROFILE);
  assert.deepEqual(out, INSTANCE_OVERRIDE_PROFILE);
});

test('resolveTriggerRuntimeProfile: malformed per-agent raw input is treated as absent and falls back to the instance override', () => {
  const out = resolveTriggerRuntimeProfile({ id: 'incomplete' }, INSTANCE_OVERRIDE_PROFILE);
  assert.deepEqual(out, INSTANCE_OVERRIDE_PROFILE);
});

test('resolveTriggerRuntimeProfile: no per-agent profile and no instance override (unset) -> null (CLI default)', () => {
  const out = resolveTriggerRuntimeProfile(null, undefined);
  assert.equal(out, null);
});

test('resolveTriggerRuntimeProfile: no per-agent profile and explicit `--runtime-profile none` -> null (CLI default)', () => {
  const out = resolveTriggerRuntimeProfile(undefined, null);
  assert.equal(out, null);
});
