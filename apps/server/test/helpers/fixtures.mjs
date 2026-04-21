// DB fixture factories for QA tests. Uses TypeORM repositories directly so
// tests don't depend on admin REST plumbing (permissions, workspace guards,
// ReBAC) that the existing leak-test helpers exercise.
//
// Every factory accepts (app, getDataSourceToken, ...) so tests can reuse a
// single booted app across many fixtures.

import { randomUUID } from 'node:crypto';
import { traceEvent } from './trace.mjs';

const stamp = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

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

export async function createAgent(
  app,
  getDataSourceToken,
  workspaceId,
  { name = 'agent', rolePrompt } = {},
) {
  const ds = app.get(getDataSourceToken());
  const repo = ds.getRepository('Agent');
  const row = await repo.save(
    repo.create({
      name: `${name}-${stamp()}`,
      description: 'qa agent',
      type: 'custom',
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
  const row = await repo.save(
    repo.create({
      name: `qa-${label}`,
      key: rawKey,
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
  { name = 'board', routingConfig = {} } = {},
) {
  const ds = app.get(getDataSourceToken());
  const repo = ds.getRepository('Board');
  const row = await repo.save(
    repo.create({
      name: `${name}-${stamp()}`,
      description: 'qa',
      workspace_id: workspaceId,
      // Board.routing_config is stored as JSON string keyed by lowercase column name.
      routing_config: JSON.stringify(routingConfig),
    }),
  );
  traceEvent('fixture', { kind: 'board', id: row.id, name: row.name, routing_config: routingConfig });
  return row;
}

export async function createColumn(
  app,
  getDataSourceToken,
  boardId,
  { name, position, isTerminal = false, workspaceId = '' } = {},
) {
  const ds = app.get(getDataSourceToken());
  const repo = ds.getRepository('BoardColumn');
  const row = await repo.save(
    repo.create({
      board_id: boardId,
      workspace_id: workspaceId,
      name,
      position,
      is_terminal: isTerminal,
    }),
  );
  traceEvent('fixture', { kind: 'column', id: row.id, name, position, is_terminal: isTerminal });
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
export async function setupKanbanScene(app, getDataSourceToken, { workspaceName = 'scene' } = {}) {
  const ws = await createWorkspace(app, getDataSourceToken, workspaceName);
  const routing = {
    'in progress': ['assignee'],
    review: ['reviewer'],
    blocked: ['reporter'],
  };
  const board = await createBoard(app, getDataSourceToken, ws.id, {
    name: 'kanban',
    routingConfig: routing,
  });
  const todo = await createColumn(app, getDataSourceToken, board.id, {
    name: 'Todo',
    position: 0,
    workspaceId: ws.id,
  });
  const inProgress = await createColumn(app, getDataSourceToken, board.id, {
    name: 'In Progress',
    position: 1,
    workspaceId: ws.id,
  });
  const review = await createColumn(app, getDataSourceToken, board.id, {
    name: 'Review',
    position: 2,
    workspaceId: ws.id,
  });
  const done = await createColumn(app, getDataSourceToken, board.id, {
    name: 'Done',
    position: 3,
    workspaceId: ws.id,
    isTerminal: true,
  });
  const blocked = await createColumn(app, getDataSourceToken, board.id, {
    name: 'Blocked',
    position: 4,
    workspaceId: ws.id,
  });
  return {
    ws,
    board,
    columns: { todo, inProgress, review, done, blocked },
    routing,
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
