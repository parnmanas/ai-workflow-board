// ticket c3b767c6 review (Rolf/AWB.Reviewer) — listForAgent() wiring
// regression. The dispatch-capability gate tests (manager-capability-*,
// room-messaging-manager-capability-gate) all stub `listForAgent` directly,
// which hid a real bug: InstanceRegistryService.listForAgent() filtered on
// `i.agent_id === agentId`, but per the real heartbeat wire shape (see
// instance-heartbeat.ts / managed-agents.ts), `agent_id` is the identity of
// the MANAGER host itself, while agents it supervises beyond that primary
// identity (ST-5b spawn_agent) show up only in `agent_ids`. Looking a
// supervised (non-primary) agent up by `agent_id` alone always returned `[]`,
// which routes straight into evaluateManagerCapability's zero-instance
// fail-open branch — silently defeating the whole gate for that agent.
//
// This drives the REAL InstanceRegistryService through the real HTTP
// heartbeat endpoint (same technique as manager-capabilities-heartbeat.test)
// with a record shaped like an actual multi-agent-supervision heartbeat
// (`agent_id` = manager identity, `agent_ids` = [target agent]), then calls
// the real listForAgent()/evaluateManagerCapability() — not a stub — so the
// old-manager/new-manager capability verdicts flip only if the wiring is
// actually correct.

import assert from 'node:assert/strict';
import test from 'node:test';

import { bootApp, exitAfterTests } from './helpers/boot.mjs';
import {
  createAgent,
  createApiKey,
  createWorkspace,
} from './helpers/fixtures.mjs';
import { InstanceRegistryService } from '../dist/modules/agent-manager/instance-registry.service.js';
import { evaluateManagerCapability } from '../dist/common/manager-capability-gate.js';

process.env.PORT = process.env.INSTANCE_REGISTRY_LIST_FOR_AGENT_PORT || '7919';

async function heartbeat(port, key, body) {
  const response = await fetch(
    `http://127.0.0.1:${port}/api/agent/instance-heartbeat`,
    {
      method: 'POST',
      headers: { 'X-Agent-Key': key.raw_key, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
  );
  assert.equal(response.status, 201, await response.text());
}

test('listForAgent(targetAgentId) finds a manager supervising it only through agent_ids (real heartbeat shape, not a stub)', async (t) => {
  const { app, port, modules } = await bootApp({
    port: Number.parseInt(process.env.PORT, 10),
  });
  t.after(async () => { await app.close(); });

  const { getDataSourceToken } = modules;
  const workspace = await createWorkspace(app, getDataSourceToken, 'list-for-agent');
  // The manager's OWN identity — distinct from any agent it supervises.
  const manager = await createAgent(app, getDataSourceToken, null, {
    name: 'list-for-agent-manager',
    type: 'manager',
  });
  // The executable agent TriggerLoop/DM/@mention dispatch is actually
  // gating for. Must be a different id than `manager` to reproduce the bug.
  const target = await createAgent(app, getDataSourceToken, workspace.id, {
    name: 'list-for-agent-target',
  });
  const key = await createApiKey(app, getDataSourceToken, manager.id, {
    workspaceId: workspace.id,
    label: 'list-for-agent',
  });

  await heartbeat(port, key, {
    instance_id: 'list-for-agent-old',
    agent_id: manager.id,
    agent_ids: [target.id],
    workspace_id: workspace.id,
    mode: 'manager',
    hostname: 'test-host',
    plugin_version: '1.6.30', // predates capability reporting
    cli: 'mixed',
    cli_adapters: [],
    pid: 111,
    started_at: new Date().toISOString(),
  });

  const registry = app.get(InstanceRegistryService);

  // The core wiring bug: looking the record up by the SUPERVISED agent's id
  // (not the manager's own id) must still find it.
  const foundByTarget = registry.listForAgent(target.id);
  assert.equal(foundByTarget.length, 1, 'a manager reporting agent_ids must be discoverable by a supervised agent id, not just its own agent_id');
  assert.equal(foundByTarget[0].instance_id, 'list-for-agent-old');

  // The manager's own identity must ALSO still resolve (common
  // single-agent-per-host pairing — must not regress while fixing the above).
  const foundByManagerId = registry.listForAgent(manager.id);
  assert.equal(foundByManagerId.length, 1, 'the manager\'s own paired identity must still resolve directly by agent_id');

  // Old manager (no manager_capabilities): gate must fail CLOSED for the
  // supervised target, using the SAME lookup path the real dispatch call
  // sites use (trigger-loop.service.ts / room-messaging.service.ts).
  const oldVerdict = evaluateManagerCapability(registry.listForAgent(target.id), 'context_window_clamp');
  assert.equal(oldVerdict.ok, false, 'an old manager supervising the target only via agent_ids must still gate the dispatch closed');
  assert.match(oldVerdict.detail, /1\.6\.30/);

  // Replace with a NEW manager heartbeat (same instance_id, capability
  // declared) supervising the same target — verdict must flip to allow.
  await heartbeat(port, key, {
    instance_id: 'list-for-agent-old',
    agent_id: manager.id,
    agent_ids: [target.id],
    workspace_id: workspace.id,
    mode: 'manager',
    hostname: 'test-host',
    plugin_version: '1.6.94',
    cli: 'mixed',
    cli_adapters: [],
    manager_capabilities: ['context_window_clamp'],
    pid: 111,
    started_at: new Date().toISOString(),
  });

  const newVerdict = evaluateManagerCapability(registry.listForAgent(target.id), 'context_window_clamp');
  assert.equal(newVerdict.ok, true, 'a new manager declaring the capability while supervising the target via agent_ids must gate the dispatch open');
});

exitAfterTests();
