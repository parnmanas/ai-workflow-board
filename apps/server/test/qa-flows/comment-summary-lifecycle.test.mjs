import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootApp, exitAfterTests } from '../helpers/boot.mjs';
import { setupKanbanScene, createAgent, createApiKey, createTicket, createUser } from '../helpers/fixtures.mjs';
import { McpClient } from '../helpers/mcp-client.mjs';
import { apiRequest, makeBaseUrl } from '../test-helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST_ROOT = path.join(__dirname, '..', '..', 'dist');
process.env.PORT = process.env.QA_COMMENT_SUMMARY_PORT || '7898';

test('comment summary is workspace-scoped, idempotent, and preserves originals on every failure path', async (t) => {
  const { app, port, modules } = await bootApp({ port: Number(process.env.PORT) });
  t.after(() => { void app.close().catch(() => {}); });
  const { getDataSourceToken, AuthService } = modules;
  const ds = app.get(getDataSourceToken());
  const commentRepo = ds.getRepository('Comment');
  const runRepo = ds.getRepository('CommentSummaryRun');
  const sceneA = await setupKanbanScene(app, getDataSourceToken, { workspaceName: 'summary-a' });
  const sceneB = await setupKanbanScene(app, getDataSourceToken, { workspaceName: 'summary-b' });
  const agent = await createAgent(app, getDataSourceToken, sceneA.ws.id, { name: 'summarizer' });
  await ds.getRepository('Agent').update({ id: agent.id }, { is_online: 1 });
  const key = await createApiKey(app, getDataSourceToken, agent.id, { workspaceId: sceneA.ws.id, label: 'summarizer' });
  const admin = await createUser(app, getDataSourceToken, { name: 'summary-admin', role: 'admin' });
  const token = app.get(AuthService).createSession(admin.id);
  const baseUrl = makeBaseUrl(port);

  const triggerModule = await import('file://' + path.join(DIST_ROOT, 'modules', 'agents', 'trigger-loop.service.js'));
  const triggerLoop = app.get(triggerModule.TriggerLoopService);
  const ticketsModule = await import('file://' + path.join(DIST_ROOT, 'modules', 'tickets', 'tickets.controller.js'));
  const controllerRunRepo = app.get(ticketsModule.TicketsController).commentSummaryRepo;
  let dispatches = 0;
  triggerLoop.emitCommentSummaryTrigger = async () => { dispatches += 1; return 'summary-trigger'; };

  const seedTicket = async (title, contents = ['first', 'second']) => {
    const ticket = await createTicket(app, getDataSourceToken, {
      columnId: sceneA.columns.todo.id,
      workspaceId: sceneA.ws.id,
      title,
    });
    for (const content of contents) {
      await commentRepo.save(commentRepo.create({
        ticket_id: ticket.id,
        workspace_id: sceneA.ws.id,
        author_type: 'user',
        author_id: admin.id,
        author: admin.name,
        content,
        attachment_resource_ids: '[]',
        type: 'note',
        metadata: '{}',
      }));
    }
    return ticket;
  };
  const postSummary = (ticketId, workspaceId = sceneA.ws.id) => apiRequest(baseUrl, `/tickets/${ticketId}/comment-summary`, {
    token, workspaceId, method: 'POST',
  });

  const ticket = await seedTicket('concurrent completion');
  const deniedGet = await apiRequest(baseUrl, `/tickets/${ticket.id}/comment-summary`, { token, workspaceId: sceneB.ws.id });
  const deniedPost = await postSummary(ticket.id, sceneB.ws.id);
  assert.equal(deniedGet.status, 404);
  assert.equal(deniedPost.status, 404);
  await ds.getRepository('Ticket').update({ id: ticket.id }, {
    pending_user_action: true,
    pending_reason: 'waiting for a user while comments can still be summarized',
  });

  // Regression: exercise the real _emitTrigger gates. A pending ticket with a
  // live assignee strand must still accept one independent summary dispatch.
  const originalEmit = triggerModule.TriggerLoopService.prototype.emitCommentSummaryTrigger.bind(triggerLoop);
  let summaryDispatches = 0;
  await ds.getRepository('Ticket').update({ id: ticket.id }, { assignee_id: agent.id });
  await triggerLoop.agentStatus.setCurrentTask(agent.id, ticket.id, 'assignee', 'summary-live-assignee');
  triggerLoop.emitCommentSummaryTrigger = async (ticketId, agentId, runId) => {
    summaryDispatches += 1;
    return originalEmit(ticketId, agentId, runId);
  };
  const starts = await Promise.all([postSummary(ticket.id), postSummary(ticket.id)]);
  assert.deepEqual(starts.map(result => result.status).sort(), [200, 202]);
  assert.ok(starts.find(result => result.status === 202).data.dispatch_trigger_id);
  assert.equal(summaryDispatches, 1, 'concurrent starts dispatch exactly once');
  await triggerLoop.agentStatus.clearCurrentTask(agent.id, ticket.id, 'summary-live-assignee');
  triggerLoop.emitCommentSummaryTrigger = async () => { dispatches += 1; return 'summary-trigger'; };
  const run = await runRepo.findOneByOrFail({ ticket_id: ticket.id });
  const mcpA = new McpClient({ baseUrl: `http://localhost:${port}`, apiKey: key.raw_key });
  const mcpB = new McpClient({ baseUrl: `http://localhost:${port}`, apiKey: key.raw_key });
  await Promise.all([
    mcpA.callTool('complete_comment_summary', { run_id: run.id, ticket_id: ticket.id, status: 'succeeded', summary: 'one summary' }),
    mcpB.callTool('complete_comment_summary', { run_id: run.id, ticket_id: ticket.id, status: 'succeeded', summary: 'one summary' }),
  ]);
  const completedComments = await commentRepo.find({ where: { ticket_id: ticket.id } });
  assert.equal(completedComments.length, 1, 'concurrent completion leaves one comment');
  assert.equal(completedComments[0].content, 'one summary');

  const changedTicket = await seedTicket('snapshot mismatch');
  const changedStart = await postSummary(changedTicket.id);
  assert.equal(changedStart.status, 202);
  await commentRepo.save(commentRepo.create({
    ticket_id: changedTicket.id,
    workspace_id: sceneA.ws.id,
    author_type: 'user', author_id: admin.id, author: admin.name,
    content: 'arrived while summarizing', attachment_resource_ids: '[]', type: 'note', metadata: '{}',
  }));
  const changedRun = await runRepo.findOneByOrFail({ ticket_id: changedTicket.id });
  await mcpA.callTool('complete_comment_summary', {
    run_id: changedRun.id, ticket_id: changedTicket.id, status: 'succeeded', summary: 'stale summary',
  });
  assert.equal((await runRepo.findOneByOrFail({ id: changedRun.id })).status, 'failed');
  assert.equal(await commentRepo.count({ where: { ticket_id: changedTicket.id } }), 3, 'snapshot mismatch preserves every comment');

  const failedTicket = await seedTicket('dispatch failure');
  triggerLoop.emitCommentSummaryTrigger = async () => {
    dispatches += 1;
    throw Object.assign(new Error('dispatch unavailable'), { code: 'SUMMARY_DISPATCH_LIVE_STRAND' });
  };
  const failedStart = await postSummary(failedTicket.id);
  assert.equal(failedStart.status, 503);
  assert.equal(failedStart.data.error_code, 'SUMMARY_DISPATCH_LIVE_STRAND');
  assert.doesNotMatch(failedStart.data.error, /Summary agent dispatch was not accepted/);
  assert.equal(await commentRepo.count({ where: { ticket_id: failedTicket.id } }), 2);

  await commentRepo.save(commentRepo.create({
    ticket_id: failedTicket.id, workspace_id: sceneA.ws.id,
    author_type: 'user', author_id: admin.id, author: admin.name,
    content: 'new comment before retry', attachment_resource_ids: '[]', type: 'note', metadata: '{}',
  }));
  const failedRetry = await postSummary(failedTicket.id);
  assert.equal(failedRetry.status, 503);
  assert.equal(failedRetry.data.status, 'failed');
  assert.equal(failedRetry.data.source_comment_count, 3, 'failed retry keeps the new claimed snapshot');
  assert.equal(JSON.parse(failedRetry.data.source_comment_ids).length, 3);
  assert.equal(failedRetry.data.agent_id, agent.id);
  assert.equal(failedRetry.data.completed_at, null);
  assert.equal(await commentRepo.count({ where: { ticket_id: failedTicket.id } }), 3);

  const pausedTicket = await seedTicket('paused board dispatch failure');
  triggerLoop.emitCommentSummaryTrigger = originalEmit;
  await ds.getRepository('Board').update({ id: sceneA.board.id }, { paused_at: new Date() });
  const pausedStart = await postSummary(pausedTicket.id);
  assert.equal(pausedStart.status, 503);
  assert.equal(pausedStart.data.error_code, 'SUMMARY_DISPATCH_BOARD_PAUSED');
  assert.equal(pausedStart.data.error, 'The board is paused');
  assert.equal(await commentRepo.count({ where: { ticket_id: pausedTicket.id } }), 2, 'paused dispatch preserves originals');
  await ds.getRepository('Board').update({ id: sceneA.board.id }, { paused_at: null });

  triggerLoop.emitCommentSummaryTrigger = async () => { dispatches += 1; return 'summary-trigger'; };
  const timeoutTicket = await seedTicket('timeout');
  assert.equal((await postSummary(timeoutTicket.id)).status, 202);
  const timeoutRun = await runRepo.findOneByOrFail({ ticket_id: timeoutTicket.id });
  await runRepo.createQueryBuilder().update().set({ updated_at: new Date(Date.now() - 6 * 60_000) }).where('id = :id', { id: timeoutRun.id }).execute();
  const timedOut = await apiRequest(baseUrl, `/tickets/${timeoutTicket.id}/comment-summary`, { token, workspaceId: sceneA.ws.id });
  assert.equal(timedOut.status, 200);
  assert.equal(timedOut.data.status, 'failed');
  assert.equal(await commentRepo.count({ where: { ticket_id: timeoutTicket.id } }), 2, 'timeout preserves originals');

  const raceTicket = await seedTicket('completion wins timeout race');
  assert.equal((await postSummary(raceTicket.id)).status, 202);
  const raceRun = await runRepo.findOneByOrFail({ ticket_id: raceTicket.id });
  await runRepo.createQueryBuilder().update().set({ updated_at: new Date(Date.now() - 6 * 60_000) }).where('id = :id', { id: raceRun.id }).execute();
  const staleRun = await runRepo.findOneByOrFail({ id: raceRun.id });
  const originalFindOne = controllerRunRepo.findOne.bind(controllerRunRepo);
  let injectedCompletion = false;
  controllerRunRepo.findOne = async (options) => {
    if (!injectedCompletion && options?.where?.ticket_id === raceTicket.id) {
      injectedCompletion = true;
      await mcpA.callTool('complete_comment_summary', {
        run_id: raceRun.id, ticket_id: raceTicket.id, status: 'succeeded', summary: 'completion won',
      });
      assert.equal((await runRepo.findOneByOrFail({ id: raceRun.id })).status, 'completed');
      return { ...staleRun };
    }
    return originalFindOne(options);
  };
  const raced = await apiRequest(baseUrl, `/tickets/${raceTicket.id}/comment-summary`, { token, workspaceId: sceneA.ws.id });
  controllerRunRepo.findOne = originalFindOne;
  assert.equal(raced.status, 200);
  assert.equal(raced.data.status, 'completed', 'stale timeout cannot overwrite completed run');
  const racedComments = await commentRepo.find({ where: { ticket_id: raceTicket.id } });
  assert.equal(racedComments.length, 1);
  assert.equal(racedComments[0].content, 'completion won');

  await Promise.all([mcpA.close(), mcpB.close()]);
  exitAfterTests(0);
});
