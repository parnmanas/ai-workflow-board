// QA flow: base repo inheritance on READ (ticket 112ea3c5), verified through
// the REAL MCP get_ticket round-trip — not a synthetic loadTicketFull() call.
//
// base-repo-binding-dispatch.test.mjs already proves the board-env backfill
// reaches the DISPATCH wire (agent_trigger.base_repo). But `loadTicketFull`
// (apps/server/src/modules/mcp/shared/ticket-parsing.ts), which backs MCP
// get_ticket / REST ticket detail / agent-api's fetchTicketContext, had NO
// such fallback at all: an empty base_repo_resource_id read back as
// `base_repo: null` even when the board declared a perfectly good default.
// That gap meant an agent calling get_ticket mid-session (or a human reading
// the ticket panel) saw "no repository" while the dispatch prompt named a
// concrete one — the exact disagreement that let an assignee fall back into
// an unrelated resource's worktree (ticket 112ea3c5's reported incident).
//
// Proves, via a live get_ticket call for each precedence tier:
//   1. Ticket repo unset, board environment_config set → base_repo resolves
//      to the board's repo (the core fix).
//   2. Ticket repo EXPLICITLY set to a different resource than the board's
//      → base_repo still reflects the ticket's own resource (ticket > board
//      priority unchanged — no regression on the existing, tested path).
//   3. Board environment_config unset, WORKSPACE environment_config set →
//      base_repo resolves to the workspace default (board > workspace, the
//      workspace layer is the final fallback — mergeEnvironmentConfig).
//   4. Ticket, board, AND workspace all unset → base_repo stays null (no
//      invented default; matches the existing "none" contract).

import test from 'node:test';
import assert from 'node:assert/strict';
import { bootApp, exitAfterTests, step } from '../helpers/boot.mjs';
import {
  setupKanbanScene,
  createAgent,
  createApiKey,
  createTicket,
} from '../helpers/fixtures.mjs';
import { McpClient } from '../helpers/mcp-client.mjs';

// Unique port slot (above base-repo-binding-dispatch 7842; highest observed 7913).
process.env.PORT = process.env.QA_BASE_REPO_READ_PORT || '7920';

test('base repo inheritance on read: get_ticket resolves ticket > board > workspace, matching the dispatch-side backfill (ticket 112ea3c5)', async (t) => {
  step('Boot NestJS app on test port');
  const { app, port, modules } = await bootApp({ port: parseInt(process.env.PORT, 10) });
  t.after(() => { void app.close().catch(() => {}); });
  const { getDataSourceToken } = modules;
  const ds = app.get(getDataSourceToken());

  step('Seed workspace + kanban (no board env repo yet — configured per scenario below)');
  const { ws, columns } = await setupKanbanScene(app, getDataSourceToken, {
    workspaceName: 'base-repo-read',
  });
  const board = await ds.getRepository('BoardColumn').findOne({ where: { id: columns.inProgress.id } })
    .then((col) => ds.getRepository('Board').findOne({ where: { id: col.board_id } }));

  step('Create an agent + API key to drive get_ticket');
  const agent = await createAgent(app, getDataSourceToken, ws.id, { name: 'reader' });
  const key = await createApiKey(app, getDataSourceToken, agent.id, { workspaceId: ws.id, label: 'reader' });
  const mcp = new McpClient({ baseUrl: `http://localhost:${port}`, apiKey: key.raw_key, clientInfo: { name: 'reader', version: '1.0.0' } });
  t.after(() => { void mcp.close().catch(() => {}); });

  step('Seed two distinct repository Resources: the board/workspace default, and a ticket-own override');
  const boardRepo = await ds.getRepository('Resource').save(ds.getRepository('Resource').create({
    workspace_id: ws.id, name: 'board default repo', type: 'repository',
    url: 'https://github.com/parnmanas/board-default.git', default_branch: 'main',
  }));
  const ticketOwnRepo = await ds.getRepository('Resource').save(ds.getRepository('Resource').create({
    workspace_id: ws.id, name: 'ticket own repo', type: 'repository',
    url: 'https://github.com/parnmanas/ticket-own.git', default_branch: 'develop',
  }));
  const workspaceRepo = await ds.getRepository('Resource').save(ds.getRepository('Resource').create({
    workspace_id: ws.id, name: 'workspace default repo', type: 'repository',
    url: 'https://github.com/parnmanas/workspace-default.git', default_branch: 'trunk',
  }));

  step('Scenario 1 — ticket repo unset, board env set → base_repo resolves to the board repo');
  await ds.getRepository('Board').update(board.id, {
    environment_config: JSON.stringify({ repositories: [{ resource_id: boardRepo.id }] }),
  });
  const t1 = await createTicket(app, getDataSourceToken, {
    columnId: columns.todo.id, workspaceId: ws.id, title: 'inherits board repo',
  });
  const r1 = await mcp.callTool('get_ticket', { ticket_id: t1.id });
  assert.equal(r1.base_repo_resource_id, '', 'the raw column stays empty — this is a derived-field fallback, not a silent write');
  assert.ok(r1.base_repo, 'base_repo resolves instead of staying null');
  assert.equal(r1.base_repo.id, boardRepo.id);
  assert.equal(r1.base_repo.url, 'https://github.com/parnmanas/board-default.git');
  assert.equal(r1.base_repo.default_branch, 'main');

  step('Cross-check: REST GET /api/agent/tickets/:id (loadTicketFull\'s other caller, agent-manager\'s fetchTicketContext source) agrees with the MCP read for scenario 1 — before later scenarios mutate board/workspace config');
  const restResp = await fetch(`http://localhost:${port}/api/agent/tickets/${t1.id}`, {
    headers: { 'X-Agent-Key': key.raw_key },
  });
  const restBody = await restResp.json();
  assert.equal(restResp.status, 200, JSON.stringify(restBody));
  assert.equal(restBody.base_repo?.id, boardRepo.id, 'agent-api (fetchTicketContext\'s source) resolves the SAME repo as MCP get_ticket');

  step('Scenario 2 — ticket repo explicitly set to a DIFFERENT resource than the board\'s → ticket wins');
  const t2 = await createTicket(app, getDataSourceToken, {
    columnId: columns.todo.id, workspaceId: ws.id, title: 'ticket overrides board repo',
  });
  await ds.getRepository('Ticket').update(t2.id, { base_repo_resource_id: ticketOwnRepo.id });
  const r2 = await mcp.callTool('get_ticket', { ticket_id: t2.id });
  assert.equal(r2.base_repo.id, ticketOwnRepo.id, 'ticket-own repo wins over the board default');
  assert.equal(r2.base_repo.url, 'https://github.com/parnmanas/ticket-own.git');
  assert.equal(r2.base_repo.default_branch, 'develop');

  step('Scenario 3 — board env unset, workspace env set → base_repo falls all the way to the workspace default');
  await ds.getRepository('Board').update(board.id, { environment_config: null });
  await ds.getRepository('Workspace').update(ws.id, {
    environment_config: JSON.stringify({ repositories: [{ resource_id: workspaceRepo.id }] }),
  });
  const t3 = await createTicket(app, getDataSourceToken, {
    columnId: columns.todo.id, workspaceId: ws.id, title: 'inherits workspace repo',
  });
  const r3 = await mcp.callTool('get_ticket', { ticket_id: t3.id });
  assert.ok(r3.base_repo, 'workspace-level default resolves when the board sets nothing');
  assert.equal(r3.base_repo.id, workspaceRepo.id);
  assert.equal(r3.base_repo.url, 'https://github.com/parnmanas/workspace-default.git');
  assert.equal(r3.base_repo.default_branch, 'trunk');

  step('Scenario 4 — ticket, board, AND workspace all unset → base_repo stays null (no invented default)');
  await ds.getRepository('Workspace').update(ws.id, { environment_config: null });
  const t4 = await createTicket(app, getDataSourceToken, {
    columnId: columns.todo.id, workspaceId: ws.id, title: 'no repo anywhere',
  });
  const r4 = await mcp.callTool('get_ticket', { ticket_id: t4.id });
  assert.equal(r4.base_repo, null);

  await exitAfterTests(t);
});
