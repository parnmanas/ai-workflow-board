// QA flow: READ 경로에서의 base repo 상속(ticket 112ea3c5) — synthetic한
// loadTicketFull() 직접호출이 아니라 REAL MCP get_ticket 라운드트립으로 검증.
//
// base-repo-binding-dispatch.test.mjs는 board-env 백필이 DISPATCH wire
// (agent_trigger.base_repo)에 도달함을 이미 증명한다. 하지만 MCP get_ticket
// / REST 티켓 상세 / agent-api의 fetchTicketContext를 떠받치는
// `loadTicketFull`(apps/server/src/modules/mcp/shared/ticket-parsing.ts)에는
// 그런 폴백이 전혀 없었다: base_repo_resource_id가 비어 있으면 board가
// 완벽한 기본값을 선언해뒀어도 `base_repo: null`로 읽혔다. 이 간극 때문에
// 세션 중 get_ticket을 호출하는 에이전트(또는 티켓 패널을 보는 사람)는
// dispatch prompt가 구체적인 repo를 명시하는데도 "repo 없음"으로 보게
// 됐다 — assignee가 무관한 resource의 worktree로 빠졌던(ticket 112ea3c5의
// 보고 사고) 바로 그 불일치다.
//
// 우선순위 단계마다 실제 get_ticket 호출로 증명한다:
//   1. 티켓 repo 미설정, board environment_config 설정 → base_repo가
//      board의 repo로 resolve(핵심 수정).
//   1b. 위와 같지만 board entry 자체의 branch가 resource의 default_branch와
//       다름 → 유효 branch는 board가 지정한 값이어야 한다(리뷰 지적).
//   2. 티켓 repo가 board와 DIFFERENT한 resource로 EXPLICIT하게 설정됨
//      → base_repo는 여전히 티켓 자신의 resource를 반영(ticket > board
//      우선순위 불변 — 기존 테스트된 경로에 회귀 없음).
//   3. board environment_config 미설정, WORKSPACE environment_config 설정
//      → base_repo가 workspace 기본값으로 resolve(board > workspace,
//      workspace 레이어가 최종 폴백 — mergeEnvironmentConfig).
//   4. 티켓·board·workspace 전부 미설정 → base_repo는 null 유지(임의
//      기본값을 만들어내지 않음 — 기존 "none" 계약과 일치).

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

// 고유 port 슬롯(base-repo-binding-dispatch 7842보다 위; 관측된 최고값 7913).
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

  step('Scenario 1b — board entry\'s OWN branch (legacy-shaped config) differs from the resource\'s default_branch → the board branch wins (리뷰 지적, ticket 112ea3c5)');
  // 레거시 저장 row를 직접 시뮬레이션: write 경로(EnvironmentConfigInputSchema)는
  // 이제 resource_id만 받지만, read 경로는 여전히 permissive해 이런 shape도
  // 파싱한다(environment-config-repo-only.test.mjs의 backcompat 케이스와 동일 전제).
  await ds.getRepository('Board').update(board.id, {
    environment_config: JSON.stringify({ repositories: [{ resource_id: boardRepo.id, branch: 'release' }] }),
  });
  const t1b = await createTicket(app, getDataSourceToken, {
    columnId: columns.todo.id, workspaceId: ws.id, title: 'inherits board repo with board-specified branch',
  });
  const r1b = await mcp.callTool('get_ticket', { ticket_id: t1b.id });
  assert.equal(r1b.base_repo.id, boardRepo.id);
  assert.equal(
    r1b.base_repo.default_branch,
    'release',
    'board entry가 지정한 branch가 resource 고유 default_branch("main")보다 우선해야 한다',
  );
  assert.notEqual(r1b.base_repo.default_branch, boardRepo.default_branch);
  // 원본 base_branch 컬럼은 그대로 빈 값 — 상속된 값을 여기 써넣지 않는다
  // (클라이언트 편집 폼이 이 필드를 그대로 바인딩하므로, 명시적으로 지정한
  // 것처럼 보이면 안 된다). 유효 branch는 base_repo.default_branch로만 노출.
  assert.equal(r1b.base_branch, '');

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
