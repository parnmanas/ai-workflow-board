// QA flow: base repo binding on dispatch (ticket 8c3befa8), verified end-to-end
// through the REAL _emitTrigger → event-registry.flatten() → SSE path with a
// VirtualAgent capturing the wire frame (board lesson: verify event changes
// with the actual wire payload + the fail-closed branch, not a synthetic object).
//
// Proves:
//   1. A base-repo-less assignee ticket on a board whose environment_config
//      declares a repository is auto-bound to that repo, and the resolved
//      base_repo / base_branch reach the FLATTENED wire (what agent-manager
//      JSON.parses to pick the worktree checkout). Before this ticket flatten()
//      dropped base_repo, so it never crossed the wire.
//   2. A ticket that declares an UNRESOLVABLE base repo (deleted Resource) on an
//      assignee/active dispatch is pended — no agent_trigger is emitted — rather
//      than dispatched into a worktree it can't push from. Fail closed.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootApp, exitAfterTests, step } from '../helpers/boot.mjs';
import {
  setupKanbanScene,
  createAgent,
  createApiKey,
  createTicket,
} from '../helpers/fixtures.mjs';
import { VirtualAgent } from '../helpers/virtual-agent.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST_ROOT = path.resolve(__dirname, '..', '..', 'dist');

// Unique port slot (above unpend-emits-trigger 7836).
process.env.PORT = process.env.QA_BASE_REPO_BIND_PORT || '7842';

test('base repo binding: env backfill reaches the wire; unresolvable repo pends (ticket 8c3befa8)', async (t) => {
  step('Boot NestJS app on test port');
  const { app, port, modules } = await bootApp({ port: parseInt(process.env.PORT, 10) });
  t.after(() => { void app.close().catch(() => {}); });
  const { getDataSourceToken } = modules;
  const ds = app.get(getDataSourceToken());

  const triggerLoopModule = await import(
    'file://' + path.join(DIST_ROOT, 'modules', 'agents', 'trigger-loop.service.js'),
  );
  const triggerLoop = app.get(triggerLoopModule.TriggerLoopService);

  step('Seed workspace + kanban; bind a repo Resource as the board environment repo');
  const { ws, board, columns } = await setupKanbanScene(app, getDataSourceToken, {
    workspaceName: 'base-repo-bind',
  });
  const resource = await ds.getRepository('Resource').save(
    ds.getRepository('Resource').create({
      workspace_id: ws.id,
      name: 'AWB repo',
      type: 'repository',
      url: 'https://github.com/parnmanas/ai-workflow-board.git',
      default_branch: 'main',
    }),
  );
  // Board environment declares the repo; raise max_concurrent so both scenario
  // tickets stay inside the assignee's focus window (the focus gate runs before
  // the base-repo guard inside _emitTrigger).
  await ds.getRepository('Board').update(board.id, {
    environment_config: JSON.stringify({ repositories: [{ resource_id: resource.id }] }),
    max_concurrent_tickets_per_agent: 5,
  });

  const assignee = await createAgent(app, getDataSourceToken, ws.id, { name: 'assignee' });
  const assigneeKey = await createApiKey(app, getDataSourceToken, assignee.id, {
    workspaceId: ws.id, label: 'assignee',
  });
  const va = new VirtualAgent({
    name: 'assignee', agentId: assignee.id, apiKey: assigneeKey.raw_key, port,
  });
  await va.start();
  t.after(async () => { await va.stop(); });
  await new Promise((r) => setTimeout(r, 300));

  // ── Scenario 1: env backfill → base_repo on the flattened wire ──────────────
  step('Scenario 1: dispatch a base-repo-less ticket; env repo must reach the flattened wire');
  const t1 = await createTicket(app, getDataSourceToken, {
    columnId: columns.inProgress.id, workspaceId: ws.id,
    title: 'no base repo — inherit board env', assigneeId: assignee.id,
  });
  await triggerLoop.dispatchCurrentColumn(t1.id, 'qa-base-repo', 'qa-actor');

  const trig = await va.waitForTrigger((tr) => tr.ticket_id === t1.id, 4000);
  // The crux — the LEGACY flattened frame (agent-manager consumes this) carries
  // the backfilled base_repo. `_wire` is the raw flatten() output.
  assert.ok(trig._wire.base_repo, 'flattened wire must carry base_repo (backfilled from board env)');
  assert.equal(trig._wire.base_repo.id, resource.id, 'base_repo must be the board environment repo');
  assert.equal(
    trig._wire.base_repo.url,
    'https://github.com/parnmanas/ai-workflow-board.git',
    'base_repo.url must be the resolved Resource url',
  );
  assert.equal(trig._wire.base_branch, 'main', 'base_branch must fall back to the Resource default_branch');

  const t1Fresh = await ds.getRepository('Ticket').findOne({ where: { id: t1.id } });
  assert.equal(!!t1Fresh.pending_user_action, false, 'a resolvable env repo must NOT pend the ticket');

  // ── Scenario 2: unresolvable declared repo → pend, no trigger (fail closed) ──
  step('Scenario 2: dispatch a ticket declaring a non-existent base repo; must pend, emit nothing');
  const t2 = await createTicket(app, getDataSourceToken, {
    columnId: columns.inProgress.id, workspaceId: ws.id,
    title: 'declares a deleted base repo', assigneeId: assignee.id,
  });
  // A base_repo_resource_id that resolves to no Resource (deleted / cross-workspace).
  await ds.getRepository('Ticket').update(t2.id, {
    base_repo_resource_id: '00000000-0000-0000-0000-000000000000',
    base_branch: '',
  });

  const before = va.triggersFor(t2.id).length;
  await triggerLoop.dispatchCurrentColumn(t2.id, 'qa-base-repo', 'qa-actor');
  // Give any (wrongly) emitted trigger a beat to arrive over SSE — it must not.
  await new Promise((r) => setTimeout(r, 600));
  assert.equal(
    va.triggersFor(t2.id).length, before,
    'an assignee dispatch with an unresolvable base repo must NOT emit an agent_trigger',
  );

  const t2Fresh = await ds.getRepository('Ticket').findOne({ where: { id: t2.id } });
  assert.equal(!!t2Fresh.pending_user_action, true, 'the ticket must be pended (fail closed)');
  assert.match(
    t2Fresh.pending_reason || '', /base repo/i,
    'the pend reason must explain the unresolved base repo',
  );

  exitAfterTests(0);
});
