// Test helper for building an Orchestration team.
//
// A roster slot is declared as Runtime Host + CLI + model (+ credential) — no
// folder. A mission names Projects, and a slot works in a project's folder on
// its own host; the execution identity a step runs as is (cli, that folder,
// credential). So a test cannot pre-create the agents and hand them to
// `createTeam` — it describes the slots, gets a project the team can work on,
// and reads the identities back out.
//
// `buildTeam` returns those identities in the shape `createAgent` used to return
// (`{ id, name }`), so a test can keep doing `mcpFor(backend)` /
// `assignee_agent_id: backend.id` (accepted as the slot it identifies) /
// `new RegExp(backend.name)`. It also registers a Runtime Host api key for each
// identity, so VirtualAgent can open an SSE stream as one (the manager key is
// how agent SSE is addressed — `runtimeHostKeyForAgent`).
//
// Missions must name the team's project: pass `...squad.missionDefaults` into
// `createMission` (or `squad.missionDefaultsFor(otherAccountId)` for a global
// team running in another account).

import { createHash } from 'node:crypto';
import { createAgent, createApiKey, createProject, registerRuntimeHostKeyFor } from './fixtures.mjs';
import { AgentManagerCommandService } from '../../dist/modules/agent-manager/agent-manager-command.service.js';

const virtualHosts = new WeakMap();

// These QA hosts run VirtualAgent rather than a real CLI manager. Simulate only
// the awaited host preparation; roster-edit commands still use the real service.
// Command/ack ordering and auth failures are tested in the runtime-preparation
// and agent-manager-slot-credential suites, and CLI materialization in manager tests.
function registerVirtualPreparation(app, hostId) {
  let hosts = virtualHosts.get(app);
  if (!hosts) {
    hosts = new Set();
    virtualHosts.set(app, hosts);
    const commands = app.get(AgentManagerCommandService);
    const original = commands.provisionSlotIdentity.bind(commands);
    commands.provisionSlotIdentity = (spec, opts) => {
      if (hosts.has(spec.manager_agent_id) && opts.waitForAckMs !== undefined) {
        return Promise.resolve({ ok: true, reason: 'virtual_host_prepared' });
      }
      return original(spec, opts);
    };
  }
  hosts.add(hostId);
}

/** Default project folder root for test slots. Absolute, as the folder validator requires. */
export const TEST_WORKING_DIR = '/srv/awb-test/account';

/**
 * A Runtime Host (manager identity) a slot can be placed on, plus its api key.
 * Tests that only need "somewhere to run" can let `buildTeam` make one.
 */
export async function createRuntimeHost(app, getDataSourceToken, accountId, { name = 'host' } = {}) {
  const host = await createAgent(app, getDataSourceToken, accountId, { name, type: 'manager' });
  const key = await createApiKey(app, getDataSourceToken, host.id, {
    accountId,
    label: `runtime-host-${name}`,
  });
  registerVirtualPreparation(app, host.id);
  return { ...host, api_key: key.raw_key };
}

/**
 * A slot spec: Runtime Host + CLI + execution config. `working_dir` /
 * `folder_scope` in `overrides` are dropped — a slot names no folder; `buildTeam`
 * reads them as "where this slot's project folder is" instead.
 */
export function slotSpec(managerAgentId, overrides = {}) {
  const { working_dir: _dir, folder_scope: _scope, ...rest } = overrides;
  return {
    manager_agent_id: managerAgentId,
    cli: 'claude',
    runtime_config: { strategy: 'single', permission_mode: 'strict' },
    ...rest,
  };
}

/**
 * The execution identity of a slot working in `folder` — the server's and the
 * manager's `runtimeIdentityKey` contract: `rt-` + sha256(`cli\0dir\0credential`)[0:16].
 */
export function identityIn(spec, folder) {
  const norm = (v) => String(v ?? '').trim();
  const digest = createHash('sha256')
    .update(`${norm(spec.cli).toLowerCase()}\0${norm(folder)}\0${norm(spec.credential_id)}`, 'utf8')
    .digest('hex')
    .slice(0, 16);
  return `rt-${digest}`;
}

/**
 * Create a team, its roster, and a project the team can work on.
 *
 * Placement: a project has ONE folder per host, and an execution identity is
 * (cli, folder, credential). A slot's `spec.working_dir` names its project
 * folder; slots naming the same folder share a host (and so one tree — the
 * "shared folder" shape), and every further distinct folder gets its own host.
 * The first folder lands on `opts.host` (or a host made for the team). Tests
 * that want distinct workers therefore keep giving slots distinct folders,
 * exactly as before.
 *
 * @param {object} opts
 * @param {string} opts.accountId
 * @param {string} opts.name
 * @param {object} [opts.host]          Runtime Host for the first folder; one is created if absent.
 * @param {object} [opts.orchestrator]  `{ spec?, host? }` — `spec` overrides merge into slotSpec.
 * @param {Array}  [opts.members]       `[{ role_label, capabilities, max_concurrent, spec?, host? }]`
 * @param {object} [opts.team]          Extra createTeam fields (orchestrator_prompt, max_parallel_steps, …).
 * @param {string} [opts.folderScope]   Mission folder scope for `missionDefaults` (default `isolated`,
 *                                      the behaviour the flow tests assert: one folder per step).
 */
export async function buildTeam(app, getDataSourceToken, teams, opts) {
  const { accountId, name, members = [], team: teamFields = {} } = opts;
  const teamHost = opts.host ?? (await createRuntimeHost(app, getDataSourceToken, accountId, { name: `host-${name}` }));
  // P4c-4: identity 는 spec 내용 주소다 — 기본 폴더를 팀·슬롯마다 다르게 둬야
  // 서로 다른 팀/슬롯이 같은 worker 로 합쳐지지 않는다 (in-flight 가드·cap 공유).
  const slug = String(name || 'team').replace(/[^a-zA-Z0-9_-]+/g, '-').slice(0, 40) || 'team';
  const dirFor = (slot) =>
    `/srv/awb-test/${slug}-${String(slot).replace(/[^a-zA-Z0-9_-]+/g, '-').slice(0, 40)}`;

  const hostByFolder = new Map();
  const folderByHost = new Map();
  let extraHosts = 0;
  const place = async (folder, explicitHost, label) => {
    if (explicitHost) {
      const existing = folderByHost.get(explicitHost.id);
      if (existing && existing !== folder) {
        throw new Error(`buildTeam: ${label} — host already has project folder ${existing}; one folder per host`);
      }
      folderByHost.set(explicitHost.id, folder);
      if (!hostByFolder.has(folder)) hostByFolder.set(folder, explicitHost);
      return explicitHost;
    }
    if (hostByFolder.has(folder)) return hostByFolder.get(folder);
    const host = folderByHost.has(teamHost.id)
      ? await createRuntimeHost(app, getDataSourceToken, accountId, { name: `host-${name}-${++extraHosts}` })
      : teamHost;
    hostByFolder.set(folder, host);
    folderByHost.set(host.id, folder);
    return host;
  };

  const orchFolder = opts.orchestrator?.spec?.working_dir ?? dirFor('orch');
  const orchHost = await place(orchFolder, opts.orchestrator?.host, 'orchestrator');
  const memberPlacements = [];
  for (const [i, m] of members.entries()) {
    const folder = m.spec?.working_dir ?? dirFor(`m${i}-${m.role_label || 'slot'}`);
    memberPlacements.push({ folder, host: await place(folder, m.host, m.role_label || `member ${i}`) });
  }

  const project = await createProject(app, getDataSourceToken, accountId, {
    name: `proj-${slug}`,
    hostFolders: [...folderByHost.entries()].map(([hostId, path]) => ({ hostId, path })),
  });

  const orchSpec = slotSpec(orchHost.id, opts.orchestrator?.spec ?? {});
  let view = await teams.createTeam({
    account_id: accountId,
    name,
    ...teamFields,
    orchestrator: orchSpec,
  });
  for (const [i, m] of members.entries()) {
    view = await teams.addMember(view.id, accountId, {
      runtime: slotSpec(memberPlacements[i].host.id, m.spec ?? {}),
      role_label: m.role_label,
      capabilities: m.capabilities,
      max_concurrent: m.max_concurrent,
    });
  }

  const folderScope = opts.folderScope ?? 'isolated';
  const execSpec = (spec, folder, scope) => ({ ...spec, working_dir: folder, folder_scope: scope });

  // Every identity needs a Runtime Host key registered before a VirtualAgent
  // can subscribe as it.
  const orchestratorId = identityIn(orchSpec, orchFolder);
  await registerRuntimeHostKeyFor(app, getDataSourceToken, orchestratorId, {
    accountId, hostId: orchHost.id, runtime: execSpec(orchSpec, orchFolder, 'shared'),
  });
  const memberRows = [];
  for (const [i, m] of view.members.entries()) {
    const spec = slotSpec(memberPlacements[i].host.id, members[i]?.spec ?? {});
    const folder = memberPlacements[i].folder;
    const id = identityIn(spec, folder);
    await registerRuntimeHostKeyFor(app, getDataSourceToken, id, {
      accountId, hostId: memberPlacements[i].host.id, runtime: execSpec(spec, folder, folderScope),
    });
    memberRows.push({
      id,
      slot_id: m.id,
      name: m.agent_name,
      role_label: m.role_label,
      host: memberPlacements[i].host,
      folder,
      runtime_spec: execSpec(spec, folder, folderScope),
    });
  }

  const orchestrator = {
    id: orchestratorId,
    name: view.orchestrator_name,
    host: orchHost,
    folder: orchFolder,
    runtime_spec: execSpec(orchSpec, orchFolder, 'shared'),
  };

  const hostFolders = [...folderByHost.entries()].map(([hostId, path]) => ({ hostId, path }));
  return {
    team: view,
    host: teamHost,
    project,
    projects: [{ project_id: project.id }],
    /** Spread into createMission: the team's project and the flow tests' folder scope. */
    missionDefaults: { projects: [{ project_id: project.id }], folder_scope: folderScope },
    /** Same, for a mission in another account (a global team): a project there with the same folders. */
    async missionDefaultsFor(otherAccountId) {
      if (otherAccountId === accountId) return { projects: [{ project_id: project.id }], folder_scope: folderScope };
      const other = await createProject(app, getDataSourceToken, otherAccountId, { name: `proj-${slug}`, hostFolders });
      return { projects: [{ project_id: other.id }], folder_scope: folderScope };
    },
    orchestrator,
    members: memberRows,
    member(roleLabel) {
      const found = memberRows.find((m) => m.role_label === roleLabel);
      if (!found) throw new Error(`no team member with role_label "${roleLabel}"`);
      return found;
    },
    async refresh() {
      return teams.getTeam(view.id, accountId);
    },
  };
}
