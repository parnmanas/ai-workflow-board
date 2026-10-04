// DB fixture factories for QA tests. Uses TypeORM repositories directly so
// tests don't depend on admin REST plumbing (permissions, workspace guards,
// ReBAC) that the existing leak-test helpers exercise.
//
// Every factory accepts (app, getDataSourceToken, ...) so tests can reuse a
// single booted app across many fixtures.

import { randomUUID, createHash } from 'node:crypto';
import { runtimeIdentityKey } from '../../dist/common/runtime-spec.js';
import { traceEvent } from './trace.mjs';

const stamp = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const runtimeHostKeysByAgent = new Map();
const runtimeSpecsById = new Map();
// host agent id → its api key, so several agents under one host share one key
// (a real manager runs one SSE stream for all of them).
const hostKeysByHost = new Map();

export function runtimeHostKeyForAgent(agentId) {
  return runtimeHostKeysByAgent.get(agentId) || null;
}

/**
 * Register a Runtime Host api key for an agent this fixture did NOT create —
 * an identity AWB provisioned itself for an Orchestration team slot.
 *
 * `createAgent` mints the host + key together, but a provisioned identity
 * arrives already linked to a host the test made separately, so the map has no
 * entry and `VirtualAgent.start()` refuses to subscribe. Mints one key per host
 * and reuses it for every agent under that host, matching how a real manager
 * fans one SSE stream out to all its managed agents.
 */
// P4c-4: Agent 테이블 없음 — synthetic child id → host 매핑은 createAgent 가
// 채운다. 매핑에 없는 id 면 새 Host + 키를 만들어 매핑한다.
export async function registerRuntimeHostKeyFor(app, getDataSourceToken, agentId, { workspaceId = '', hostId = null, runtime = null } = {}) {
  if (runtime) { runtimeSpecsById.set(agentId, runtime); hostId ||= runtime.manager_agent_id; }
  if (!agentId || runtimeHostKeysByAgent.has(agentId)) return runtimeHostKeysByAgent.get(agentId) ?? null;
  const ds = app.get(getDataSourceToken());
  const host = (hostId && await ds.getRepository('RuntimeHost').findOneBy({ id: hostId })) || await ds.getRepository('RuntimeHost').save(
    ds.getRepository('RuntimeHost').create({
      name: `runtime-host-${agentId.slice(0, 8)}`,
      hostname: 'fixture',
      workspace_id: workspaceId || null,
      is_active: 1,
    }),
  );
  const minted = await createApiKey(app, getDataSourceToken, null, {
    workspaceId,
    label: `runtime-host-${agentId.slice(0, 8)}`,
    hostId: host.id,
  });
  runtimeHostKeysByAgent.set(agentId, minted.raw_key);
  hostKeysByHost.set(host.id, minted.raw_key);
  return minted.raw_key;
}

export async function createWorkspace(app, getDataSourceToken, name = 'qa') {
  const ds = app.get(getDataSourceToken());
  const repo = ds.getRepository('Workspace');
  const row = await repo.save(repo.create({ name: `ws-${name}-${stamp()}`, description: 'qa workspace' }));
  traceEvent('fixture', { kind: 'workspace', id: row.id, name: row.name });
  return row;
}

export async function createUser(
  app,
  getDataSourceToken,
  { name = 'user', role = 'admin' } = {},
) {
  const ds = app.get(getDataSourceToken());
  const repo = ds.getRepository('User');
  const row = await repo.save(
    repo.create({
      name: `${name}-${stamp()}`,
      email: `${name}-${stamp()}@awb.local`,
      role,
      status: 'active',
    }),
  );
  traceEvent('fixture', { kind: 'user', id: row.id, name: row.name, role: row.role });
  return row;
}

// Test actors are Host identities; runtime:true provisions an inline RuntimeSpec
// and its execution credential. No fixture creates a saved Agent row or alias.
export async function createAgent(
  app,
  getDataSourceToken,
  workspaceId,
  { name = 'agent', rolePrompt, type = 'custom', hosted = true, runtime = false } = {},
) {
  const ds = app.get(getDataSourceToken());
  const agentName = `${name}-${stamp()}`;
  if (type === 'manager') {
    const host = await ds.getRepository('RuntimeHost').save(
      ds.getRepository('RuntimeHost').create({
        name: agentName,
        hostname: 'fixture',
        workspace_id: null,
        is_active: 1,
      }),
    );
    const hostKey = await createApiKey(app, getDataSourceToken, null, {
      workspaceId: workspaceId || '',
      label: `runtime-host-${name}`,
      hostId: host.id,
    });
    runtimeHostKeysByAgent.set(host.id, hostKey.raw_key);
    hostKeysByHost.set(host.id, hostKey.raw_key);
    traceEvent('fixture', { kind: 'agent', id: host.id, name: host.name, workspace_id: null });
    return {
      id: host.id,
      name: host.name,
      description: 'qa Runtime Host',
      type: 'manager',
      is_active: 1,
      is_online: 0,
      workspace_id: null,
      role_prompt: rolePrompt || '',
    };
  }
  let id = randomUUID();
  let managerAgentId = null;
  let executionSpec = null;
  if (hosted) {
    const host = await ds.getRepository('RuntimeHost').save(
      ds.getRepository('RuntimeHost').create({
        name: agentName,
        hostname: 'fixture',
        workspace_id: workspaceId || null,
        is_active: 1,
      }),
    );
    managerAgentId = host.id;
    const spec = {
      manager_agent_id: host.id, cli: type === 'custom' ? 'codex' : type,
      model: null, working_dir: `/tmp/qa/${id}`, folder_scope: 'shared',
      credential_id: null, cli_runtime_profile: null, label: agentName,
      role_prompt: rolePrompt || `You are ${name}. Reply TEST_OK.`,
      runtime_config: { strategy: 'single', permission_mode: 'strict' },
    };
    executionSpec = spec;
    id = runtime ? runtimeIdentityKey(spec) : host.id;
    if (runtime) runtimeSpecsById.set(id, spec);
    const hostKey = await createApiKey(app, getDataSourceToken, null, {
      workspaceId: workspaceId || '',
      label: `runtime-host-${name}`,
      hostId: host.id,
    });
    runtimeHostKeysByAgent.set(id, hostKey.raw_key);
    hostKeysByHost.set(host.id, hostKey.raw_key);
    // Provision the same Host-bound runtime credential used by real dispatch.
    await createApiKey(app, getDataSourceToken, id, {
      workspaceId: workspaceId || '',
      label: `link-${name}`,
      hostId: host.id,
    });
  }
  const row = {
    id,
    name: agentName,
    description: 'qa agent',
    type,
    is_active: 1,
    is_online: 0,
    workspace_id: workspaceId,
    role_prompt: rolePrompt || `You are ${name}. Reply TEST_OK.`,
    manager_agent_id: managerAgentId,
    runtime_spec: executionSpec,
    runtime_config: managerAgentId
      ? { strategy: 'single', permission_mode: 'strict' }
      : null,
  };
  traceEvent('fixture', { kind: 'agent', id: row.id, name: row.name, workspace_id: workspaceId });
  return row;
}

export async function createApiKey(
  app,
  getDataSourceToken,
  agentId,
  { workspaceId = '', scope = 'full', label = 'key', hostId = null } = {},
) {
  const ds = app.get(getDataSourceToken());
  const repo = ds.getRepository('ApiKey');
  const runtime = runtimeSpecsById.get(agentId);
  if (!hostId && runtime) hostId = runtime.manager_agent_id;
  if (!hostId && agentId && /^[0-9a-f-]{36}$/i.test(agentId) && await ds.getRepository('RuntimeHost').existsBy({ id: agentId })) hostId = agentId;
  const rawKey = `qa-${label}-${randomUUID()}`;
  // Mirror ApiKeyService: persist the SHA-256 hash + a display prefix, never
  // the raw key (the prod storage model the hashing change enforces).
  const keyHash = createHash('sha256').update(rawKey, 'utf8').digest('hex');
  const keyPrefix = rawKey.length <= 12
    ? rawKey.slice(0, 4) + '***'
    : rawKey.slice(0, 8) + '***' + rawKey.slice(-4);
  const row = await repo.save(
    repo.create({
      name: runtime ? `runtime:${label}:${agentId}` : `qa-${label}`,
      key: keyHash,
      key_prefix: keyPrefix,
      ...(hostId ? { host_id: hostId } : {}),
      scope,
      is_active: 1,
      workspace_id: workspaceId,
    }),
  );
  row.raw_key = rawKey;
  traceEvent('fixture', { kind: 'api-key', id: row.id, agent_id: agentId, raw_key_prefix: rawKey.slice(0, 10) + '...' });
  return row;
}

/**
 * A project (repository) in a workspace, optionally with main clone folders
 * per Runtime Host: `hostFolders` = [{ hostId, path }].
 */
export async function createProject(
  app,
  getDataSourceToken,
  workspaceId,
  { name = 'project', repoUrl = 'https://github.com/example/repo.git', defaultBranch = 'main', usePr = false, instructions = '', defaultAssignee = null, hostFolders = [] } = {},
) {
  const ds = app.get(getDataSourceToken());
  const repo = ds.getRepository('Project');
  const row = await repo.save(repo.create({
    workspace_id: workspaceId,
    name: `${name}-${stamp()}`,
    description: '',
    repo_url: repoUrl,
    default_branch: defaultBranch,
    credential_id: null,
    clone_policy: null,
    use_pr: usePr,
    instructions,
    default_assignee: defaultAssignee,
  }));
  for (const folder of hostFolders) {
    await ds.getRepository('ProjectHostFolder').save(ds.getRepository('ProjectHostFolder').create({
      project_id: row.id, host_id: folder.hostId, path: folder.path,
    }));
  }
  traceEvent('fixture', { kind: 'project', id: row.id, name: row.name, workspace_id: workspaceId });
  return row;
}

/**
 * A ticket written straight to the table (no dispatch side effects — use the
 * REST/MCP surfaces when a test needs TicketService behaviour). `assignee` is a
 * fixture agent from createAgent({ runtime: true }) or a raw RuntimeSpec.
 */
export async function createTicket(
  app,
  getDataSourceToken,
  {
    workspaceId,
    title,
    status = 'todo',
    assignee = null,
    tags = [],
    projectId = null,
    baseBranch = '',
    parentId = null,
    depth = 0,
    position = 0,
    promptText = '',
    priority = 'medium',
  } = {},
) {
  const ds = app.get(getDataSourceToken());
  const repo = ds.getRepository('Ticket');
  const spec = assignee ? (assignee.runtime_spec || (assignee.manager_agent_id && assignee.cli ? assignee : runtimeSpecsById.get(assignee.id)) || null) : null;
  const row = await repo.save(
    repo.create({
      workspace_id: workspaceId,
      title,
      prompt_text: promptText,
      priority,
      status,
      tags: JSON.stringify(tags),
      project_id: projectId,
      base_branch: baseBranch,
      assignee: spec,
      assignee_key: spec ? runtimeIdentityKey(spec) : '',
      parent_id: parentId,
      depth,
      position,
      terminal_entered_at: status === 'done' ? new Date() : null,
    }),
  );
  traceEvent('fixture', { kind: 'ticket', id: row.id, title, status, assignee_key: row.assignee_key });
  return row;
}
