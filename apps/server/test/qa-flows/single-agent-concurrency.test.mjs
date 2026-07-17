// Single-agent parallelism (ticket 1fcba693 — completion condition:
// "최소 3개 티켓을 동일 assignee에 배정하고 concurrency>=3에서 독립 strand 3개가
// 실제 동시 실행되는 통합 테스트").
//
// The incident report claimed one assignee with several tickets processed them
// ~one every 3-4 h with no parallelism. The manager-side investigation showed
// the manager DOES run concurrent ticket sessions (distinct ticket:role:agent
// keys, no per-agent mutex) — so the server MUST emit up to N=cap concurrent
// triggers for a single agent. This test pins that server-side guarantee for
// ONE assignee (the multi-agent-concurrency test covers the same invariant
// across 5 agents; this is the focused single-agent restatement for this ticket).
//
// Board cap = 3, one assignee owns 3 tickets all in In Progress. Firing all 3
// column_moves in parallel must deliver exactly 3 DISTINCT triggers to that one
// agent — proving the top-N focus window admits N independent strands at once,
// not one serialized ticket.

import test from 'node:test';
import assert from 'node:assert/strict';
import { bootApp } from '../helpers/boot.mjs';
import {
  setupKanbanScene,
  createAgent,
  createApiKey,
  createTicket,
  createUser,
} from '../helpers/fixtures.mjs';
import { VirtualAgent } from '../helpers/virtual-agent.mjs';

process.env.PORT = process.env.QA_SINGLE_CONCURRENCY_PORT || '7806';

const TICKETS = 3;
const CAP = 3;

test(`1 assignee owns ${TICKETS} tickets, cap=${CAP}: all ${TICKETS} triggers land concurrently at the one agent`, async (t) => {
  const { app, port, modules } = await bootApp({ port: parseInt(process.env.PORT, 10) });
  t.after(() => { void app.close().catch(() => {}); });
  const { getDataSourceToken, ActivityService } = modules;

  const { ws, columns } = await setupKanbanScene(app, getDataSourceToken, {
    workspaceName: 'single-concurrency',
    maxConcurrent: CAP,
    envRepo: true,
  });
  const user = await createUser(app, getDataSourceToken, { name: 'driver' });

  const agent = await createAgent(app, getDataSourceToken, ws.id, { name: 'solo' });
  const key = await createApiKey(app, getDataSourceToken, agent.id, { workspaceId: ws.id, label: 'solo' });
  const va = new VirtualAgent({ name: 'solo', agentId: agent.id, apiKey: key.raw_key, port });
  await va.start();
  t.after(async () => { await va.stop(); });
  await new Promise((r) => setTimeout(r, 400));

  // Three tickets, all owned by the one assignee, all in In Progress so each
  // move-emit triggers its owner and every ticket fits inside the cap=3 window.
  const owned = [];
  for (let j = 0; j < TICKETS; j++) {
    owned.push(await createTicket(app, getDataSourceToken, {
      columnId: columns.inProgress.id,
      workspaceId: ws.id,
      title: `solo-t-${j}`,
      assigneeId: agent.id,
      position: j,
    }));
  }

  // Fire all three column_move activities in parallel — no mutex between them.
  const activityService = app.get(ActivityService);
  await Promise.all(owned.map((ticket) =>
    activityService.logActivity({
      entity_type: 'ticket',
      entity_id: ticket.id,
      action: 'moved',
      ticket_id: ticket.id,
      new_value: 'In Progress',
      old_value: 'Todo',
      actor_id: user.id,
      actor_name: user.name,
    }),
  ));

  // Wait for all 3 to arrive, then a settle window so a (buggy) surplus /
  // serialized-drop would also have shown up.
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (va.triggers.length >= TICKETS) break;
    await new Promise((r) => setTimeout(r, 80));
  }
  await new Promise((r) => setTimeout(r, 300));

  // Concurrency: exactly 3 triggers — one per owned ticket, all inside the cap=3
  // window. Not 1 (the incident's "serialized to one ticket") and not >3.
  assert.equal(
    va.triggers.length,
    TICKETS,
    `expected ${TICKETS} concurrent window triggers for the single assignee, got ${va.triggers.length}`,
  );
  const ownedIds = new Set(owned.map((o) => o.id));
  const seen = new Set();
  for (const tr of va.triggers) {
    assert.ok(ownedIds.has(tr.ticket_id), `unexpected ticket ${tr.ticket_id}`);
    assert.ok(!seen.has(tr.ticket_id), `duplicate trigger for ${tr.ticket_id}`);
    seen.add(tr.ticket_id);
    assert.equal(tr.role, 'assignee');
    assert.equal(tr.agent_id, agent.id);
    assert.equal(tr.trigger_source, 'column_move');
  }
  assert.equal(seen.size, TICKETS, 'three DISTINCT tickets triggered — three independent strands, not one');
});
