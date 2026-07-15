// DB fixture factories for QA tests. Uses TypeORM repositories directly so
// tests don't depend on admin REST plumbing (permissions, workspace guards,
// ReBAC) that the existing leak-test helpers exercise.
//
// Every factory accepts (app, getDataSourceToken, ...) so tests can reuse a
// single booted app across many fixtures.

import { randomUUID, createHash } from 'node:crypto';
import { traceEvent } from './trace.mjs';

const stamp = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

// Built-in role slug list mirrored from server-side BUILTIN_ROLES — the
// fixture path bypasses the workspaces controller which would otherwise
// seed these via WorkspaceRolesService.seedBuiltinRoles. Without these
// rows the v0.34+ trigger-loop / ticket-role-assignment paths can't
// resolve role slugs for fixture-built workspaces.
const BUILTIN_ROLE_SLUGS = [
  { slug: 'planner', name: 'Planner', position: 0 },
  { slug: 'assignee', name: 'Assignee', position: 1 },
  { slug: 'reporter', name: 'Reporter', position: 2 },
  { slug: 'reviewer', name: 'Reviewer', position: 3 },
];

export async function createWorkspace(app, getDataSourceToken, name = 'qa') {
  const ds = app.get(getDataSourceToken());
  const repo = ds.getRepository('Workspace');
  const row = await repo.save(repo.create({ name: `ws-${name}-${stamp()}`, description: 'qa workspace' }));
  // Mirror seedBuiltinRoles — every WorkspaceRole.slug used by built-in
  // routing must exist before tickets bind role assignments to it.
  // Idempotent (find-or-create per slug) so a test that wants to seed
  // additional / overriding role rows on the same workspace doesn't trip
  // the (workspace_id, slug) unique index.
  const roleRepo = ds.getRepository('WorkspaceRole');
  for (const def of BUILTIN_ROLE_SLUGS) {
    const existing = await roleRepo.findOne({
      where: { workspace_id: row.id, slug: def.slug },
    });
    if (existing) continue;
    await roleRepo.save(roleRepo.create({
      workspace_id: row.id,
      slug: def.slug,
      name: def.name,
      role_prompt: '',
      description: `qa builtin ${def.slug}`,
      position: def.position,
      is_builtin: true,
    }));
  }
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

export async function createAgent(
  app,
  getDataSourceToken,
  workspaceId,
  { name = 'agent', rolePrompt, type = 'custom' } = {},
) {
  const ds = app.get(getDataSourceToken());
  const repo = ds.getRepository('Agent');
  const row = await repo.save(
    repo.create({
      name: `${name}-${stamp()}`,
      description: 'qa agent',
      type,
      is_active: 1,
      is_online: 0,
      workspace_id: workspaceId,
      role_prompt: rolePrompt || `You are ${name}. Reply TEST_OK.`,
    }),
  );
  traceEvent('fixture', { kind: 'agent', id: row.id, name: row.name, workspace_id: workspaceId });
  return row;
}

export async function createApiKey(
  app,
  getDataSourceToken,
  agentId,
  { workspaceId = '', scope = 'full', label = 'key' } = {},
) {
  const ds = app.get(getDataSourceToken());
  const repo = ds.getRepository('ApiKey');
  const rawKey = `qa-${label}-${randomUUID()}`;
  // Mirror ApiKeyService: persist the SHA-256 hash + a display prefix, never
  // the raw key (the prod storage model the hashing change enforces).
  const keyHash = createHash('sha256').update(rawKey, 'utf8').digest('hex');
  const keyPrefix = rawKey.length <= 12
    ? rawKey.slice(0, 4) + '***'
    : rawKey.slice(0, 8) + '***' + rawKey.slice(-4);
  const row = await repo.save(
    repo.create({
      name: `qa-${label}`,
      key: keyHash,
      key_prefix: keyPrefix,
      agent_id: agentId,
      scope,
      is_active: 1,
      workspace_id: workspaceId,
    }),
  );
  row.raw_key = rawKey;
  traceEvent('fixture', { kind: 'api-key', id: row.id, agent_id: agentId, raw_key_prefix: rawKey.slice(0, 10) + '...' });
  return row;
}

export async function createBoard(
  app,
  getDataSourceToken,
  workspaceId,
  { name = 'board', routingConfig = {}, maxConcurrent } = {},
) {
  const ds = app.get(getDataSourceToken());
  const repo = ds.getRepository('Board');
  const fields = {
    name: `${name}-${stamp()}`,
    description: 'qa',
    workspace_id: workspaceId,
    // Board.routing_config is stored as JSON string keyed by lowercase column name.
    routing_config: JSON.stringify(routingConfig),
  };
  // The production schema default for max_concurrent_tickets_per_agent is 1
  // (migration 1760000000012). Several QA flows (concurrency stress, multi-
  // ticket dispatch) need to fire >1 trigger per agent in parallel, so
  // tests that exercise those paths must opt into a higher cap. Tests that
  // care about the cap-skip → enqueue path leave this at 1.
  if (maxConcurrent !== undefined) {
    fields.max_concurrent_tickets_per_agent = maxConcurrent;
  }
  const row = await repo.save(repo.create(fields));
  traceEvent('fixture', {
    kind: 'board',
    id: row.id,
    name: row.name,
    routing_config: routingConfig,
    max_concurrent_tickets_per_agent: row.max_concurrent_tickets_per_agent,
  });
  return row;
}

export async function createColumn(
  app,
  getDataSourceToken,
  boardId,
  { name, position, isTerminal = false, workspaceId = '', kind, roleRouting } = {},
) {
  const ds = app.get(getDataSourceToken());
  const repo = ds.getRepository('BoardColumn');
  // v0.41 introduced BoardColumn.kind / role_routing as the canonical
  // routing-source-of-truth (replacing name-string lookups against the
  // legacy Board.routing_config blob). Default `kind` from is_terminal +
  // position so existing call sites that only pass name/position keep
  // routing through "active" columns; tests that need explicit
  // intake/review/merging classification can override.
  const resolvedKind =
    kind ||
    (isTerminal
      ? 'terminal'
      : position === 0
        ? 'intake'
        : 'active');
  const row = await repo.save(
    repo.create({
      board_id: boardId,
      workspace_id: workspaceId,
      name,
      position,
      is_terminal: isTerminal,
      kind: resolvedKind,
      role_routing: JSON.stringify(Array.isArray(roleRouting) ? roleRouting : []),
    }),
  );
  traceEvent('fixture', {
    kind: 'column',
    id: row.id,
    name,
    position,
    is_terminal: isTerminal,
    column_kind: resolvedKind,
    role_routing: roleRouting ?? [],
  });
  return row;
}

export async function createTicket(
  app,
  getDataSourceToken,
  {
    columnId,
    workspaceId,
    title,
    assigneeId = '',
    reporterId = '',
    reviewerId = '',
    parentId = null,
    depth = 0,
    position = 0,
    promptText = '',
    priority = 'medium',
  } = {},
) {
  const ds = app.get(getDataSourceToken());
  const repo = ds.getRepository('Ticket');
  const row = await repo.save(
    repo.create({
      column_id: columnId,
      workspace_id: workspaceId,
      title,
      prompt_text: promptText,
      priority,
      assignee_id: assigneeId,
      reporter_id: reporterId,
      reviewer_id: reviewerId,
      parent_id: parentId,
      depth,
      position,
      status: 'todo',
    }),
  );
  // Mirror the legacy assignee_id / reporter_id / reviewer_id columns onto
  // TicketRoleAssignment rows so the v0.34+ trigger-loop / allocation /
  // mention paths can resolve a holder. Production paths do this via
  // TicketRoleAssignmentService.syncBuiltinTrio in tickets.controller; the
  // raw-repo fixture has to do the same write or no trigger ever fires.
  if (workspaceId) {
    const roleRepo = ds.getRepository('WorkspaceRole');
    const assignRepo = ds.getRepository('TicketRoleAssignment');
    const slugs = [
      ['assignee', assigneeId],
      ['reporter', reporterId],
      ['reviewer', reviewerId],
    ];
    for (const [slug, agentId] of slugs) {
      if (!agentId) continue;
      const role = await roleRepo.findOne({ where: { workspace_id: workspaceId, slug } });
      if (!role) continue;
      await assignRepo.save(assignRepo.create({
        ticket_id: row.id,
        role_id: role.id,
        agent_id: agentId,
        user_id: null,
      }));
    }
  }
  traceEvent('fixture', {
    kind: 'ticket',
    id: row.id,
    title,
    column_id: columnId,
    assignee_id: assigneeId,
    reporter_id: reporterId,
    reviewer_id: reviewerId,
  });
  return row;
}

/**
 * Seed an ADDITIONAL holder onto an existing ticket role (다중담당자 — a
 * single routed role may be co-held by several agents since T1 relaxed the
 * TicketRoleAssignment uniqueness to (ticket, role, holder)). createTicket
 * already wrote the FIRST holder per builtin slug with holder_key='' (the
 * fixture default); a distinct holder_key ('agent:<id>') is required or the
 * second row collides on the uniq_ticket_role_holder index. Production sets
 * holder_key via TicketRoleAssignmentService; this raw-repo fixture mirrors
 * that so multi-holder QA flows (fan-out, consensus gate, mention exclusion)
 * can build a role with >1 agent holder. `slug` defaults to 'assignee' —
 * the role the multi-holder flows exercise — but any builtin slug works.
 */
export async function addRoleHolder(
  app,
  getDataSourceToken,
  { ticketId, workspaceId, agentId, slug = 'assignee' },
) {
  const ds = app.get(getDataSourceToken());
  const role = await ds.getRepository('WorkspaceRole').findOne({
    where: { workspace_id: workspaceId, slug },
  });
  if (!role) {
    throw new Error(`addRoleHolder: ${slug} WorkspaceRole must exist for workspace ${workspaceId}`);
  }
  const assignRepo = ds.getRepository('TicketRoleAssignment');
  const row = await assignRepo.save(assignRepo.create({
    ticket_id: ticketId,
    role_id: role.id,
    agent_id: agentId,
    user_id: null,
    holder_key: `agent:${agentId}`,
  }));
  traceEvent('fixture', {
    kind: 'role-holder',
    ticket_id: ticketId,
    role: slug,
    agent_id: agentId,
  });
  return row;
}

/**
 * Standard Kanban scene: workspace + board + 5 columns + routing_config.
 *
 * Routing:
 *   - "in progress" → assignee gets triggered on entry/comment/update
 *   - "review"      → reviewer
 *   - "blocked"     → reporter
 *   - "todo"        → (no routing; initial column)
 *   - "done"        → terminal (never triggers)
 *
 * Keys are lowercased because TriggerLoopService lowercases before lookup.
 */
export async function setupKanbanScene(
  app,
  getDataSourceToken,
  { workspaceName = 'scene', maxConcurrent, envRepo = false } = {},
) {
  const ws = await createWorkspace(app, getDataSourceToken, workspaceName);
  const routing = {
    'in progress': ['assignee'],
    review: ['reviewer'],
    blocked: ['reporter'],
  };
  const board = await createBoard(app, getDataSourceToken, ws.id, {
    name: 'kanban',
    routingConfig: routing,
    maxConcurrent,
  });
  // Per-column role_routing must mirror the board-level routing map —
  // since v0.41 every runtime read is from BoardColumn.role_routing only.
  const roleFor = (colName) => routing[colName.toLowerCase()] || [];
  const todo = await createColumn(app, getDataSourceToken, board.id, {
    name: 'Todo',
    position: 0,
    workspaceId: ws.id,
    kind: 'intake',
    roleRouting: roleFor('Todo'),
  });
  const inProgress = await createColumn(app, getDataSourceToken, board.id, {
    name: 'In Progress',
    position: 1,
    workspaceId: ws.id,
    kind: 'active',
    roleRouting: roleFor('In Progress'),
  });
  const review = await createColumn(app, getDataSourceToken, board.id, {
    name: 'Review',
    position: 2,
    workspaceId: ws.id,
    kind: 'review',
    roleRouting: roleFor('Review'),
  });
  const done = await createColumn(app, getDataSourceToken, board.id, {
    name: 'Done',
    position: 3,
    workspaceId: ws.id,
    isTerminal: true,
    kind: 'terminal',
    roleRouting: roleFor('Done'),
  });
  const blocked = await createColumn(app, getDataSourceToken, board.id, {
    name: 'Blocked',
    position: 4,
    workspaceId: ws.id,
    kind: 'active',
    roleRouting: roleFor('Blocked'),
  });
  // envRepo (opt-in): bind a repository Resource as the board's environment repo
  // so the board models a real CODE board. Since ticket 8c3befa8 an assignee
  // dispatched onto an active (branch-work) column with NO resolvable base repo
  // is PENDED (the manager fails such a dispatch closed anyway), so any scene
  // whose assignee actually expects an agent_trigger must declare a repo. Off by
  // default: scenes that only exercise non-pushing roles/columns (or that
  // deliberately test the no-repo pend) leave it unset.
  let envRepoResource = null;
  if (envRepo) {
    const ds = app.get(getDataSourceToken());
    envRepoResource = await ds.getRepository('Resource').save(
      ds.getRepository('Resource').create({
        workspace_id: ws.id,
        name: 'scene repo',
        type: 'repository',
        url: 'https://github.com/parnmanas/ai-workflow-board.git',
        default_branch: 'main',
      }),
    );
    await ds.getRepository('Board').update(board.id, {
      environment_config: JSON.stringify({ repositories: [{ resource_id: envRepoResource.id }] }),
    });
  }
  return {
    ws,
    board,
    columns: { todo, inProgress, review, done, blocked },
    routing,
    envRepo: envRepoResource,
  };
}

/**
 * Three-role agent trio (assignee, reporter, reviewer) + API keys.
 * Returns { assignee: {agent, key}, reporter: {agent, key}, reviewer: {agent, key} }.
 */
export async function createAgentTrio(app, getDataSourceToken, workspaceId) {
  const mk = async (role) => {
    const agent = await createAgent(app, getDataSourceToken, workspaceId, { name: role });
    const key = await createApiKey(app, getDataSourceToken, agent.id, {
      workspaceId,
      label: role,
    });
    return { agent, key };
  };
  return {
    assignee: await mk('assignee'),
    reporter: await mk('reporter'),
    reviewer: await mk('reviewer'),
  };
}
