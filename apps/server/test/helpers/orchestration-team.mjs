// Test helper for building an Orchestration team.
//
// A roster slot is declared as Runtime Host + CLI + model + working folder, and
// AWB provisions the backing Agent identity from it (see
// modules/orchestration/orchestration-agent-provisioner.service.ts). So a test
// cannot pre-create the agents and hand them to `createTeam` any more — it
// describes the slots and reads the identities back out.
//
// `buildTeam` returns those identities in the shape `createAgent` used to return
// (`{ id, name }`), so a test can keep doing `mcpFor(backend)` /
// `assignee_agent_id: backend.id` / `new RegExp(backend.name)` unchanged. It also
// registers a Runtime Host api key for each provisioned identity, so VirtualAgent
// can open an SSE stream as one (the manager key is how agent SSE is addressed —
// `runtimeHostKeyForAgent`).

import { createAgent, createApiKey, registerRuntimeHostKeyFor } from './fixtures.mjs';

/** Default working folder for a slot. Absolute, as the spec validator requires. */
export const TEST_WORKING_DIR = '/srv/awb-test/workspace';

/**
 * A Runtime Host (manager identity) a slot can be placed on, plus its api key.
 * Tests that only need "somewhere to run" can let `buildTeam` make one.
 */
export async function createRuntimeHost(app, getDataSourceToken, workspaceId, { name = 'host' } = {}) {
  const host = await createAgent(app, getDataSourceToken, workspaceId, { name, type: 'manager' });
  const key = await createApiKey(app, getDataSourceToken, host.id, {
    workspaceId,
    label: `runtime-host-${name}`,
  });
  return { ...host, api_key: key.raw_key };
}

/**
 * A slot runtime spec. `folder_scope` defaults to `isolated` here — NOT to the
 * product default `shared` — because that is the behaviour the existing
 * orchestration flow tests assert (each step provisioned into its own
 * `.awb/orch/<mission>/<step>` folder). A test that wants to exercise sharing
 * asks for it explicitly, so nothing about folder scope is implicit in a suite
 * that predates the option.
 */
export function slotSpec(managerAgentId, overrides = {}) {
  return {
    manager_agent_id: managerAgentId,
    cli: 'claude',
    working_dir: TEST_WORKING_DIR,
    folder_scope: 'isolated',
    runtime_config: { strategy: 'single', permission_mode: 'strict' },
    ...overrides,
  };
}

/**
 * Create a team and its roster from slot specs.
 *
 * @param {object} opts
 * @param {string} opts.workspaceId
 * @param {string} opts.name
 * @param {object} [opts.host]          Runtime Host to place every slot on; one is created if absent.
 * @param {object} [opts.orchestrator]  `{ spec?, ...teamFields }` — `spec` overrides merge into slotSpec.
 * @param {Array}  [opts.members]       `[{ role_label, capabilities, max_concurrent, spec? }]`
 * @param {object} [opts.team]          Extra createTeam fields (orchestrator_prompt, max_parallel_steps, …).
 * @returns {Promise<{
 *   team: object, host: object,
 *   orchestrator: { id: string, name: string },
 *   members: Array<{ id: string, name: string, role_label: string }>,
 *   member(roleLabel: string): { id: string, name: string },
 *   refresh(): Promise<object>,
 * }>}
 */
export async function buildTeam(app, getDataSourceToken, teams, opts) {
  const { workspaceId, name, members = [], team: teamFields = {} } = opts;
  const host = opts.host ?? (await createRuntimeHost(app, getDataSourceToken, workspaceId, { name: `host-${name}` }));

  let view = await teams.createTeam({
    workspace_id: workspaceId,
    name,
    ...teamFields,
    orchestrator: slotSpec(host.id, opts.orchestrator?.spec ?? {}),
  });

  for (const m of members) {
    view = await teams.addMember(view.id, workspaceId, {
      runtime: slotSpec(m.host?.id ?? host.id, m.spec ?? {}),
      role_label: m.role_label,
      capabilities: m.capabilities,
      max_concurrent: m.max_concurrent,
    });
  }

  // Every provisioned identity needs a Runtime Host key registered before a
  // VirtualAgent can subscribe as it.
  await registerRuntimeHostKeyFor(app, getDataSourceToken, view.orchestrator_agent_id, { workspaceId });
  for (const m of view.members) {
    await registerRuntimeHostKeyFor(app, getDataSourceToken, m.agent_id, { workspaceId });
  }

  const ds = app.get(getDataSourceToken());
  const agentRepo = ds.getRepository('Agent');
  const nameOf = async (id) => (await agentRepo.findOne({ where: { id } }))?.name ?? '';

  const orchestrator = { id: view.orchestrator_agent_id, name: await nameOf(view.orchestrator_agent_id) };
  const memberRows = [];
  for (const m of view.members) {
    memberRows.push({ id: m.agent_id, name: await nameOf(m.agent_id), role_label: m.role_label });
  }

  return {
    team: view,
    host,
    orchestrator,
    members: memberRows,
    member(roleLabel) {
      const found = memberRows.find((m) => m.role_label === roleLabel);
      if (!found) throw new Error(`no team member with role_label "${roleLabel}"`);
      return found;
    },
    async refresh() {
      return teams.getTeam(view.id, workspaceId);
    },
  };
}
