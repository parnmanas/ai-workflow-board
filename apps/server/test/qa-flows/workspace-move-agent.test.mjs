// QA: cross-workspace agent move (ticket 868ead64 — companion to the board
// move 8882056b).
//
// Exercises WorkspaceMoveService.{preview,commit}AgentMove end-to-end against a
// real booted app + SQLite:
//   (B) credential carry — the agent's source-ws Credential is COPIED into the
//       destination by name (non-destructive) and the agent re-pointed at it.
//   (C) api-key migrate — ApiKey.workspace_id re-stamped to dest (default policy).
//   (E) cross-workspace refs — a role assignment + denormalized assignee_id on a
//       SOURCE-ws ticket block the move under cross_ref_policy=block, and a
//       blocked commit applies NOTHING (atomicity); under cross_ref_policy=clear
//       the move succeeds and those refs are cleared.
//   (A) manager-type agents are workspace-less → the move is refused outright.
//
// Run isolated: bootApp uses sqlite; set a unique PORT so it never collides
// with sibling qa-flows.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';
import { bootApp, exitAfterTests, step } from '../helpers/boot.mjs';
import {
  createWorkspace,
  createBoard,
  createColumn,
  createTicket,
  createAgent,
  createApiKey,
} from '../helpers/fixtures.mjs';

process.env.PORT = process.env.QA_WS_MOVE_AGENT_PORT || '7843';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST_ROOT = path.join(__dirname, '..', '..', 'dist');

async function loadMover(app, getDataSourceToken) {
  const { WorkspaceMoveService, WorkspaceMoveBlockedError } = await import(
    'file://' + path.join(DIST_ROOT, 'services', 'workspace-move.service.js')
  );
  const { ActivityService } = await import(
    'file://' + path.join(DIST_ROOT, 'services', 'activity.service.js')
  );
  const ds = app.get(getDataSourceToken());
  const activity = app.get(ActivityService);
  return { mover: new WorkspaceMoveService(ds, activity), WorkspaceMoveBlockedError, ds };
}

// Agent in `sourceWs` with: a credential, an api key, and an assignee role on a
// ticket that LIVES in the source ws (so it becomes cross-workspace after the
// move). Returns every id the assertions need.
async function buildScene(app, getDataSourceToken, sourceWs, label) {
  const ds = app.get(getDataSourceToken());

  const credRepo = ds.getRepository('Credential');
  const cred = await credRepo.save(credRepo.create({
    workspace_id: sourceWs.id, name: `qa-cred-${label}`, description: 'qa',
    provider: 'anthropic', encrypted_data: 'ENC',
  }));

  const agent = await createAgent(app, getDataSourceToken, sourceWs.id, { name: `mover-${label}` });
  await ds.getRepository('Agent').update({ id: agent.id }, { credential_id: cred.id });
  const key = await createApiKey(app, getDataSourceToken, agent.id, { workspaceId: sourceWs.id, label });

  const board = await createBoard(app, getDataSourceToken, sourceWs.id, { name: `b-${label}` });
  const todo = await createColumn(app, getDataSourceToken, board.id, {
    name: 'Todo', position: 0, workspaceId: sourceWs.id, kind: 'intake',
  });
  // Ticket in the SOURCE ws assigned to the agent → role assignment + denorm
  // assignee_id reference that would straddle the boundary post-move.
  const ticket = await createTicket(app, getDataSourceToken, {
    columnId: todo.id, workspaceId: sourceWs.id, title: `t-${label}`, assigneeId: agent.id,
  });

  return { ds, cred, agent, key, board, todo, ticket };
}

test('agent cross-workspace move: credential carry + api-key migrate + cross-ref block/clear', async (t) => {
  const { app, modules } = await bootApp({ port: parseInt(process.env.PORT, 10) });
  t.after(() => app.close().catch(() => {}));
  const { getDataSourceToken } = modules;
  const { mover, WorkspaceMoveBlockedError, ds } = await loadMover(app, getDataSourceToken);

  const agentRepo = ds.getRepository('Agent');
  const credRepo = ds.getRepository('Credential');
  const keyRepo = ds.getRepository('ApiKey');
  const assignRepo = ds.getRepository('TicketRoleAssignment');
  const ticketRepo = ds.getRepository('Ticket');

  const sourceWs = await createWorkspace(app, getDataSourceToken, 'amove-src');
  const destWs = await createWorkspace(app, getDataSourceToken, 'amove-dst');
  const scene = await buildScene(app, getDataSourceToken, sourceWs, 'main');

  // ── (d) preview writes nothing + surfaces the cross-ref blocker ──────────
  step('dry-run preview must not mutate anything, and reports the cross-ws blocker');
  const preview = await mover.previewAgentMove(scene.agent.id, destWs.id, {});
  assert.equal(preview.committed, false, 'preview is not committed');
  assert.ok(preview.blockers.length > 0, 'source-ws assignment surfaces a blocker (default cross_ref_policy=block)');

  // ── (ticket 9efa643b) structured cross-ref blocker + inline remedies ─────
  step('cross-ref blocker is structured with policy-switch + unassign remedies');
  const xref = preview.blockers.find((b) => b.code === 'cross_ref_block' || b.code === 'denorm_ref_block');
  assert.ok(xref, 'a cross_ref_block / denorm_ref_block blocker is present');
  assert.equal(xref.agent_id, scene.agent.id, 'blocker names the offending agent');
  assert.ok(Array.isArray(xref.ticket_ids) && xref.ticket_ids.includes(scene.ticket.id), 'blocker lists the foreign ticket');
  assert.ok(typeof xref.message === 'string' && xref.message.length > 0, 'string fallback message present');
  const xrefActions = xref.remedies.map((r) => r.action);
  assert.ok(xrefActions.includes('set_cross_ref_policy'), 'policy-switch remedy offered');
  assert.ok(xrefActions.includes('unassign_from_tickets'), 'unassign remedy offered');
  assert.equal(xref.remedies.find((r) => r.action === 'set_cross_ref_policy').kind, 'repreview',
    'policy switch is a write-free repreview remedy');
  assert.equal((await agentRepo.findOne({ where: { id: scene.agent.id } })).workspace_id, sourceWs.id,
    'agent workspace unchanged after preview');
  assert.equal(await credRepo.findOne({ where: { workspace_id: destWs.id, name: scene.cred.name } }), null,
    'no credential copied during preview');
  assert.equal((await keyRepo.findOne({ where: { id: scene.key.id } })).workspace_id, sourceWs.id,
    'api key workspace unchanged after preview');

  // ── (d) blocked commit applies nothing (atomicity) ──────────────────────
  step('block-policy commit throws and rolls everything back');
  await assert.rejects(
    () => mover.commitAgentMove(scene.agent.id, destWs.id, { cross_ref_policy: 'block' }),
    (e) => e instanceof WorkspaceMoveBlockedError,
    'blocked commit throws WorkspaceMoveBlockedError',
  );
  assert.equal((await agentRepo.findOne({ where: { id: scene.agent.id } })).workspace_id, sourceWs.id,
    'blocked commit left the agent in source ws');
  assert.equal(await credRepo.findOne({ where: { workspace_id: destWs.id, name: scene.cred.name } }), null,
    'blocked commit copied no credential (rolled back)');
  assert.equal((await keyRepo.findOne({ where: { id: scene.key.id } })).workspace_id, sourceWs.id,
    'blocked commit left the api key in source ws');

  // ── (B)+(C)+(E) commit with cross_ref_policy=clear ──────────────────────
  step('clear-policy commit moves the agent, carries auth, clears cross-ws refs');
  const committed = await mover.commitAgentMove(scene.agent.id, destWs.id, { cross_ref_policy: 'clear' });
  assert.equal(committed.committed, true, 'commit reports committed');

  // (A) agent re-stamped
  assert.equal((await agentRepo.findOne({ where: { id: scene.agent.id } })).workspace_id, destWs.id,
    'agent re-stamped to dest');

  // (B) credential copied into dest (distinct row) + agent re-pointed; source intact
  const destCred = await credRepo.findOne({ where: { workspace_id: destWs.id, name: scene.cred.name } });
  assert.ok(destCred, 'credential copied into dest');
  assert.notEqual(destCred.id, scene.cred.id, 'dest credential is a distinct row (non-destructive copy)');
  assert.equal((await agentRepo.findOne({ where: { id: scene.agent.id } })).credential_id, destCred.id,
    'agent re-pointed at the dest credential');
  assert.ok(await credRepo.findOne({ where: { id: scene.cred.id } }), 'source credential left intact');

  // (C) api key migrated to dest
  assert.equal((await keyRepo.findOne({ where: { id: scene.key.id } })).workspace_id, destWs.id,
    'api key re-stamped to dest (policy=migrate default)');

  // (E) cross-ws role assignment deleted + denorm assignee_id blanked
  assert.equal(await assignRepo.findOne({ where: { ticket_id: scene.ticket.id, agent_id: scene.agent.id } }), null,
    'cross-ws role assignment cleared');
  assert.equal((await ticketRepo.findOne({ where: { id: scene.ticket.id } })).assignee_id, '',
    'denormalized assignee_id blanked on the foreign ticket');
});

test('agent move remedies: unassign_from_tickets + clear_credential clear blockers (ticket 9efa643b)', async (t) => {
  const { app, modules } = await bootApp({ port: parseInt(process.env.PORT, 10) });
  t.after(() => app.close().catch(() => {}));
  const { getDataSourceToken } = modules;
  const { mover, ds } = await loadMover(app, getDataSourceToken);

  const agentRepo = ds.getRepository('Agent');
  const assignRepo = ds.getRepository('TicketRoleAssignment');
  const ticketRepo = ds.getRepository('Ticket');

  const sourceWs = await createWorkspace(app, getDataSourceToken, 'rem-src');
  const destWs = await createWorkspace(app, getDataSourceToken, 'rem-dst');
  const scene = await buildScene(app, getDataSourceToken, sourceWs, 'rem');

  // ── unassign_from_tickets remedy detaches the agent from the foreign ticket ─
  step('runMoveRemedy(unassign_from_tickets) clears the cross-ref blocker without policy=clear');
  const before = await mover.previewAgentMove(scene.agent.id, destWs.id, {});
  assert.ok(before.blockers.length > 0, 'cross-ref blocker present before remedy');

  const res = await mover.runMoveRemedy('unassign_from_tickets', {
    agent_id: scene.agent.id, ticket_ids: [scene.ticket.id],
  });
  assert.ok(res.ok && res.affected > 0, 'remedy reports rows affected');
  assert.equal(await assignRepo.findOne({ where: { ticket_id: scene.ticket.id, agent_id: scene.agent.id } }), null,
    'role assignment cleared');
  assert.equal((await ticketRepo.findOne({ where: { id: scene.ticket.id } })).assignee_id, '',
    'denormalized assignee_id blanked');
  const after = await mover.previewAgentMove(scene.agent.id, destWs.id, {});
  assert.equal(after.blockers.length, 0, 'cross-ref blocker gone after unassign remedy (default block policy)');

  // ── clear_credential remedy resolves a dangling credential blocker ──────────
  step('runMoveRemedy(clear_credential) resolves a dangling-credential blocker');
  // point the agent at a credential id that does not exist → dangling blocker.
  await agentRepo.update({ id: scene.agent.id }, { credential_id: 'does-not-exist-0000' });
  const dangling = await mover.previewAgentMove(scene.agent.id, destWs.id, {});
  const credBlocker = dangling.blockers.find((b) => b.code === 'dangling_credential');
  assert.ok(credBlocker, 'dangling_credential blocker present');
  assert.ok(credBlocker.remedies.some((r) => r.action === 'clear_credential' && r.kind === 'mutation'),
    'clear_credential mutation remedy offered');

  await mover.runMoveRemedy('clear_credential', { agent_id: scene.agent.id });
  assert.equal((await agentRepo.findOne({ where: { id: scene.agent.id } })).credential_id, null,
    'agent credential_id nulled by remedy');
  const afterCred = await mover.previewAgentMove(scene.agent.id, destWs.id, {});
  assert.ok(!afterCred.blockers.some((b) => b.code === 'dangling_credential'),
    'dangling_credential blocker gone after clear_credential remedy');
});

test('agent move: manager-type agents are workspace-less → refused', async (t) => {
  const { app, modules } = await bootApp({ port: parseInt(process.env.PORT, 10) });
  t.after(() => app.close().catch(() => {}));
  const { getDataSourceToken } = modules;
  const { mover, ds } = await loadMover(app, getDataSourceToken);

  const destWs = await createWorkspace(app, getDataSourceToken, 'amove-mgr-dst');
  const agentRepo = ds.getRepository('Agent');
  const manager = await agentRepo.save(agentRepo.create({
    name: `mgr-${Date.now()}`, type: 'manager', is_active: 1, workspace_id: null,
  }));

  await assert.rejects(
    () => mover.previewAgentMove(manager.id, destWs.id, {}),
    /workspace-less|cannot be moved/i,
    'manager-type agent move is refused',
  );
});

test.after(() => exitAfterTests(0));
