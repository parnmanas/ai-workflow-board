// QA flow: server merge/integration gate on the Merging boundary (ticket
// c806bad3).
//
// A board opts into a mechanical integration gate via merge_gate_config. The
// server then blocks:
//   - Review→Merging  when the feature branch is BEHIND base   (stale-base)
//   - Merging→Done    when it still carries commits NOT in base (partial-merge)
// and leaves a structured rebase/merge comment so the next agent turn can self-
// resolve. force=true overrides, same as the review-approval / terminal-reopen
// guards. A board that never enabled it is byte-for-byte unchanged.
//
// The behind/ahead counts normally come from a per-Resource cache clone (real
// git). This test boots the app IN-PROCESS from the same compiled module, so it
// injects a deterministic probe via the module's test seam and then drives the
// REAL MCP move_ticket tool — the gate's DB resolution, decision, block comment
// and force override all run through the production path, only the git numbers
// are stubbed.
//
//   1. gate ON, stub behind=2  : Review→Merging  → REJECTED + MergeGate comment
//   2. gate ON, stub clean     : Review→Merging  → ALLOWED (lands in Merging)
//   3. gate ON, stub ahead=3   : Merging→Done    → REJECTED (partial merge)
//   4. gate ON, stub clean     : Merging→Done    → ALLOWED (lands in Done)
//   5. gate ON, stub behind=9  : Review→Merging + force=true → ALLOWED (override)
//   6. gate OFF (other board)  : Review→Merging  → ALLOWED despite a dirty stub
//
// Cases 1–6 drive the MCP move_ticket tool. The gate is also wired on the legacy
// agent-api surface (single + batch). The batch loop is the known backdoor risk
// (it moves inside one transaction), so cases 7–8 drive the REAL agent-api
// /api/agent/batch endpoint over HTTP to prove the gate isn't bypassable there:
//   7. gate ON, stub behind=5  : BATCH Review→Merging → REJECTED (stays in Review)
//   8. gate ON, stub behind=7  : BATCH Review→Merging + force=true → ALLOWED

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootApp, step } from '../helpers/boot.mjs';
import {
  setupKanbanScene,
  createColumn,
  createAgent,
  createApiKey,
  createTicket,
} from '../helpers/fixtures.mjs';
import { VirtualAgent } from '../helpers/virtual-agent.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
process.env.PORT = process.env.QA_MERGE_GATE_PORT || '7861';

const DIST_MERGE_GATE = 'file://' + path.resolve(
  __dirname, '..', '..', 'dist', 'modules', 'mcp', 'shared', 'merge-gate.js',
);

async function setStub(behind, ahead) {
  const mod = await import(DIST_MERGE_GATE);
  mod.__setMergeGateProbeForTests(async () => ({ behind, ahead }));
}
async function resetStub() {
  const mod = await import(DIST_MERGE_GATE);
  mod.__setMergeGateProbeForTests(null);
}

test('merge gate blocks stale-base / partial-merge and passes clean / forced / disabled', async (t) => {
  step('Boot NestJS app on test port');
  const { app, port, modules } = await bootApp({ port: parseInt(process.env.PORT, 10) });
  t.after(() => { void app.close().catch(() => {}); });
  t.after(() => resetStub());
  const { getDataSourceToken } = modules;
  const ds = app.get(getDataSourceToken());

  step('Seed a gated board: kanban scene + Merging column (kind=merging)');
  const { ws, board, columns } = await setupKanbanScene(app, getDataSourceToken, {
    workspaceName: 'merge-gate',
  });
  const merging = await createColumn(app, getDataSourceToken, board.id, {
    name: 'Merging', position: 5, workspaceId: ws.id, kind: 'merging', roleRouting: ['assignee'],
  });

  step('Enable merge_gate_config on the board (opt-in) + seed a repo Resource');
  await ds.getRepository('Board').update(board.id, {
    merge_gate_config: JSON.stringify({ enabled: true }),
  });
  const resource = await ds.getRepository('Resource').save(
    ds.getRepository('Resource').create({
      workspace_id: ws.id, name: 'repo', type: 'repository',
      url: 'https://example.com/merge-gate.git', default_branch: 'main',
    }),
  );

  const worker = await createAgent(app, getDataSourceToken, ws.id, { name: 'worker' });
  const workerKey = await createApiKey(app, getDataSourceToken, worker.id, {
    workspaceId: ws.id, label: 'worker',
  });

  step('Create ticket in Review (worker holds all roles), point it at the repo');
  const ticket = await createTicket(app, getDataSourceToken, {
    columnId: columns.review.id, workspaceId: ws.id,
    title: 'Merge-gate ticket',
    assigneeId: worker.id, reporterId: worker.id, reviewerId: worker.id,
  });
  const ticketRepo = ds.getRepository('Ticket');
  await ticketRepo.update(ticket.id, {
    base_repo_resource_id: resource.id, base_branch: 'main',
  });

  const va = new VirtualAgent({ name: 'worker', agentId: worker.id, apiKey: workerKey.raw_key, port });
  await va.start();
  t.after(() => va.stop());

  // A reviewer-authored comment so the review-approval gate is satisfied and we
  // isolate the merge gate as the reason for any Review→Merging block.
  const reviewerLgtm = await va.mcp.callTool('add_comment', {
    ticket_id: ticket.id, content: 'LGTM — reviewed.', author_role: 'reviewer',
  });
  assert.ok(!reviewerLgtm?.isError, `reviewer comment must post: ${JSON.stringify(reviewerLgtm)}`);

  const commentRepo = ds.getRepository('Comment');
  const moveTo = (name) => va.mcp.callTool('move_ticket', {
    ticket_id: ticket.id, target_column_name: name, board_id: board.id,
  });
  // Drive the legacy agent-api batch move surface over real HTTP (X-Agent-Key).
  const batchMove = (operations) => fetch(`http://127.0.0.1:${port}/api/agent/batch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Agent-Key': workerKey.raw_key },
    body: JSON.stringify({ operations }),
  });

  step('CASE 1: stub behind=2 — Review→Merging REJECTED, stays in Review, MergeGate comment');
  await setStub(2, 0);
  const stale = await moveTo('Merging');
  assert.equal(stale?.isError, true, 'stale-base Review→Merging must be rejected');
  assert.match(
    JSON.stringify(stale?.error ?? stale),
    /stale_base|뒤처|stale/i,
    'rejection names the stale-base reason',
  );
  let row = await ticketRepo.findOne({ where: { id: ticket.id } });
  assert.equal(row?.column_id, columns.review.id, 'ticket STAYS in Review (case 1)');
  const gateComments = await commentRepo.find({ where: { ticket_id: ticket.id, author: 'MergeGate' } });
  assert.ok(gateComments.length >= 1, 'a MergeGate block comment must be written');
  assert.match(gateComments[0].content, /rebase/i, 'block comment gives the rebase instruction');

  step('CASE 2: stub clean — Review→Merging ALLOWED (lands in Merging)');
  await setStub(0, 0);
  const fresh = await moveTo('Merging');
  assert.ok(!fresh?.isError, `clean Review→Merging must pass: ${JSON.stringify(fresh)}`);
  row = await ticketRepo.findOne({ where: { id: ticket.id } });
  assert.equal(row?.column_id, merging.id, 'ticket lands in Merging (case 2)');

  step('CASE 3: stub ahead=3 — Merging→Done REJECTED (partial merge), stays in Merging');
  await setStub(0, 3);
  const partial = await moveTo('Done');
  assert.equal(partial?.isError, true, 'partial-merge Merging→Done must be rejected');
  assert.match(
    JSON.stringify(partial?.error ?? partial),
    /partial_merge|부분|남아/i,
    'rejection names the partial-merge reason',
  );
  row = await ticketRepo.findOne({ where: { id: ticket.id } });
  assert.equal(row?.column_id, merging.id, 'ticket STAYS in Merging (case 3)');

  step('CASE 4: stub clean — Merging→Done ALLOWED (lands in Done)');
  await setStub(0, 0);
  const merged = await moveTo('Done');
  assert.ok(!merged?.isError, `full-merge Merging→Done must pass: ${JSON.stringify(merged)}`);
  row = await ticketRepo.findOne({ where: { id: ticket.id } });
  assert.equal(row?.column_id, columns.done.id, 'ticket lands in Done (case 4)');

  step('CASE 5: force=true overrides the gate even with a dirty stub');
  const ticket2 = await createTicket(app, getDataSourceToken, {
    columnId: columns.review.id, workspaceId: ws.id, title: 'Merge-gate force',
    assigneeId: worker.id, reporterId: worker.id, reviewerId: worker.id,
  });
  await ticketRepo.update(ticket2.id, { base_repo_resource_id: resource.id, base_branch: 'main' });
  await va.mcp.callTool('add_comment', { ticket_id: ticket2.id, content: 'LGTM', author_role: 'reviewer' });
  await setStub(9, 0);
  const forced = await va.mcp.callTool('move_ticket', {
    ticket_id: ticket2.id, target_column_name: 'Merging', board_id: board.id, force: true,
  });
  assert.ok(!forced?.isError, `force=true must override the gate: ${JSON.stringify(forced)}`);
  const row2 = await ticketRepo.findOne({ where: { id: ticket2.id } });
  assert.equal(row2?.column_id, merging.id, 'forced move lands in Merging (case 5)');

  step('CASE 7: agent-api BATCH surface — stale-base Review→Merging REJECTED (batch is not a backdoor)');
  const ticketBatch = await createTicket(app, getDataSourceToken, {
    columnId: columns.review.id, workspaceId: ws.id, title: 'Merge-gate batch',
    assigneeId: worker.id, reporterId: worker.id, reviewerId: worker.id,
  });
  await ticketRepo.update(ticketBatch.id, { base_repo_resource_id: resource.id, base_branch: 'main' });
  await va.mcp.callTool('add_comment', { ticket_id: ticketBatch.id, content: 'LGTM', author_role: 'reviewer' });
  await setStub(5, 0);
  const batchBlocked = await batchMove([
    { action: 'move-ticket', ticketId: ticketBatch.id, toColumn: 'Merging', boardId: board.id },
  ]);
  assert.ok(batchBlocked.ok, `batch endpoint returns a 2xx with per-op results (got ${batchBlocked.status})`);
  const batchBlockedBody = await batchBlocked.json();
  assert.match(
    JSON.stringify(batchBlockedBody.results),
    /merge_gate_stale_base/,
    `batch move-ticket must carry the stale-base merge-gate error (gate wired on batch): ${JSON.stringify(batchBlockedBody)}`,
  );
  let rowBatch = await ticketRepo.findOne({ where: { id: ticketBatch.id } });
  assert.equal(rowBatch?.column_id, columns.review.id, 'batch-blocked ticket STAYS in Review (case 7)');

  step('CASE 8: agent-api BATCH surface — force=true overrides the gate');
  await setStub(7, 0);
  const batchForced = await batchMove([
    { action: 'move-ticket', ticketId: ticketBatch.id, toColumn: 'Merging', boardId: board.id, force: true },
  ]);
  const batchForcedBody = await batchForced.json();
  assert.match(
    JSON.stringify(batchForcedBody.results),
    /"success":true/,
    `batch force=true must move the ticket: ${JSON.stringify(batchForcedBody)}`,
  );
  rowBatch = await ticketRepo.findOne({ where: { id: ticketBatch.id } });
  assert.equal(rowBatch?.column_id, merging.id, 'batch force=true lands in Merging (case 8)');

  step('CASE 6: a board WITHOUT merge_gate_config is unaffected (no regression)');
  const scene2 = await setupKanbanScene(app, getDataSourceToken, { workspaceName: 'merge-gate-off' });
  const merging2 = await createColumn(app, getDataSourceToken, scene2.board.id, {
    name: 'Merging', position: 5, workspaceId: scene2.ws.id, kind: 'merging', roleRouting: ['assignee'],
  });
  const worker2 = await createAgent(app, getDataSourceToken, scene2.ws.id, { name: 'worker2' });
  const worker2Key = await createApiKey(app, getDataSourceToken, worker2.id, { workspaceId: scene2.ws.id, label: 'worker2' });
  const ticket3 = await createTicket(app, getDataSourceToken, {
    columnId: scene2.columns.review.id, workspaceId: scene2.ws.id, title: 'No-gate ticket',
    assigneeId: worker2.id, reporterId: worker2.id, reviewerId: worker2.id,
  });
  await ticketRepo.update(ticket3.id, { base_repo_resource_id: resource.id, base_branch: 'main' });
  const va2 = new VirtualAgent({ name: 'worker2', agentId: worker2.id, apiKey: worker2Key.raw_key, port });
  await va2.start();
  t.after(() => va2.stop());
  await va2.mcp.callTool('add_comment', { ticket_id: ticket3.id, content: 'LGTM', author_role: 'reviewer' });
  await setStub(9, 9); // dirty — but the gate is OFF on this board, so it's never consulted
  const ungated = await va2.mcp.callTool('move_ticket', {
    ticket_id: ticket3.id, target_column_name: 'Merging', board_id: scene2.board.id,
  });
  assert.ok(!ungated?.isError, `un-gated board must move freely: ${JSON.stringify(ungated)}`);
  const row3 = await ticketRepo.findOne({ where: { id: ticket3.id } });
  assert.equal(row3?.column_id, merging2.id, 'un-gated ticket lands in Merging (case 6)');
});
