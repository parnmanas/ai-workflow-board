// Manager dispatch-capability gate — call-site/ordering guard (ticket
// c3b767c6). Same structural-guard technique as hard-budget-dispatch-gate.test.mjs:
// `_emitTrigger` has 9+ injected NestJS dependencies and touches ~10
// repositories before it reaches the emit — not cheaply bootable in isolation.
// This asserts `_checkManagerCapabilityGate` exists, is called EXACTLY ONCE,
// and sits AFTER `runtimeProfile` is resolved but BEFORE the `agent_trigger`
// SSE emit — so a refactor that drops the gate, duplicates it, or reorders it
// past the emit fails this test immediately instead of silently reproducing
// ticket 1af53029's incident (an old manager dispatched a context_window
// profile it cannot honor).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}
function code(relPath) {
  return stripComments(fs.readFileSync(path.join(ROOT, 'src', relPath), 'utf8'));
}

const SRC_PATH = 'modules/agents/trigger-loop.service.ts';
const EMIT_MARKER = "activityEvents.emit('agent_trigger'";
const RESOLVE_PROFILE_MARKER = 'runtimeProfile = await resolveClaudeBackendProfileForDispatch(';
const CAPABILITY_GATE_CALL_RE = /await this\._checkManagerCapabilityGate\(/g;

test('_checkManagerCapabilityGate helper exists and centralizes the drop-action logic', () => {
  const src = code(SRC_PATH);
  assert.match(src, /private async _checkManagerCapabilityGate\(/, '_checkManagerCapabilityGate helper must exist');

  const dropActionMentions = (src.match(/'agent_trigger_dropped_manager_incapable'/g) || []).length;
  assert.equal(dropActionMentions, 1, 'the manager-incapable drop action string must appear exactly once (inside the helper)');
});

test('_checkManagerCapabilityGate is called exactly once, after runtimeProfile is resolved and before the SSE emit', () => {
  const src = code(SRC_PATH);

  const gateCalls = [...src.matchAll(CAPABILITY_GATE_CALL_RE)];
  assert.equal(gateCalls.length, 1, `expected exactly 1 call site, found ${gateCalls.length}`);

  const resolveIdx = src.indexOf(RESOLVE_PROFILE_MARKER);
  const emitIdx = src.indexOf(EMIT_MARKER);
  assert.ok(resolveIdx > -1, 'runtimeProfile resolution call must exist');
  assert.ok(emitIdx > -1, 'agent_trigger SSE emit call must exist');

  const gateIdx = gateCalls[0].index;
  assert.ok(resolveIdx < gateIdx, 'capability gate must run AFTER runtimeProfile is resolved — it needs the profile to know what capability is required');
  assert.ok(gateIdx < emitIdx, 'capability gate must precede the SSE emit — the whole point is to never dispatch to an incompatible manager');
});

test('_checkManagerCapabilityGate exempts a profile that never requires anything (delegates entirely to requiredManagerCapability)', () => {
  const src = code(SRC_PATH);
  const match = src.match(/private async _checkManagerCapabilityGate\([\s\S]*?\r?\n  \}\r?\n/);
  assert.ok(match, 'could not isolate the _checkManagerCapabilityGate method body');
  const body = match[0];
  assert.match(body, /requiredManagerCapability\(profile\)/, 'must delegate capability resolution to the shared pure function');
  assert.match(body, /if \(!capability\) return false;/, 'must short-circuit to allow dispatch when the profile needs nothing');
});

test('_checkManagerCapabilityGate special-cases comment_summary the same way every sibling hard gate does', () => {
  const src = code(SRC_PATH);
  const match = src.match(/private async _checkManagerCapabilityGate\([\s\S]*?\r?\n  \}\r?\n/);
  assert.ok(match, 'could not isolate the _checkManagerCapabilityGate method body');
  const body = match[0];
  assert.match(body, /triggerSource === 'comment_summary'/, 'must give a synchronous caller (comment_summary) an explicit thrown error instead of a silent drop');
  assert.match(body, /status: 503/, 'must throw with the same 503 shape the sibling gates use');
});

test('_checkManagerCapabilityGate is scoped to Claude-type agents only (nested inside the same `agent?.type === \'claude\'` block as profile resolution)', () => {
  const src = code(SRC_PATH);
  const claudeBlockMatch = src.match(/if \(agent\?\.type === 'claude'\) \{[\s\S]*?\n    \}/);
  assert.ok(claudeBlockMatch, 'could not isolate the agent?.type === "claude" block');
  assert.match(claudeBlockMatch[0], /_checkManagerCapabilityGate\(/, 'the gate call must live inside the claude-only block — non-Claude CLIs never resolve a runtimeProfile and must not be gated by it');
});
