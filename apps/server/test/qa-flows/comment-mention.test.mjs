// QA flow: comment_mention delivery is scoped to a single target agent.
//
// comment_mention is the SSE channel used when a comment author @-tags an
// agent. A ticket has exactly one agent — its assignee (RuntimeSpec,
// identified by `assignee_key`, docs/tickets.md) — so the only mention that
// can wake anything is `@[agent:<assignee_key>]`, and it reaches the Runtime
// Host named by the spec's `manager_agent_id`. Critical to verify, through
// the real REST comment path:
//   - The mentioned assignee receives the event (with its RuntimeSpec).
//   - No sibling agent in the same workspace receives it — not even when the
//     same comment @-tags the sibling (it is not on the ticket).
//   - No agent in a different workspace receives it (account-scope safety).
//   - The mention is the wake-up: the human comment does not ALSO re-send an
//     agent_trigger for the in_progress ticket (that would wake it twice).

import test from 'node:test';
import assert from 'node:assert/strict';
import { bootApp, exitAfterTests, step } from '../helpers/boot.mjs';
import {
  createAccount,
  createUser,
  createAgent,
  createTicket,
  runtimeHostKeyForAgent,
} from '../helpers/fixtures.mjs';
import { VirtualAgent } from '../helpers/virtual-agent.mjs';

process.env.PORT = process.env.QA_MENTION_PORT || '0';

test('comment_mention is delivered only to the mentioned assignee (account-scoped)', async (t) => {
  const { app, port, modules } = await bootApp({ port: parseInt(process.env.PORT, 10) });
  t.after(() => { void app.close().catch(() => {}); });
  const { getDataSourceToken, AuthService } = modules;

  const ws = await createAccount(app, getDataSourceToken, 'mention');
  const ws2 = await createAccount(app, getDataSourceToken, 'other-ws');
  const user = await createUser(app, getDataSourceToken, { name: 'mentioner' });
  const token = app.get(AuthService).createSession(user.id);

  const alphaAgent = await createAgent(app, getDataSourceToken, ws.id, { name: 'alpha', runtime: true });
  const betaAgent = await createAgent(app, getDataSourceToken, ws.id, { name: 'beta', runtime: true });
  const foreignAgent = await createAgent(app, getDataSourceToken, ws2.id, { name: 'foreign', runtime: true });

  const ticket = await createTicket(app, getDataSourceToken, {
    accountId: ws.id,
    title: 'Mention target',
    status: 'in_progress',
    assignee: alphaAgent,
  });
  assert.equal(ticket.assignee_key, alphaAgent.id, 'fixture agent id is the runtime identity key');

  const mkVA = (name, agent) => new VirtualAgent({
    name, agentId: agent.id, apiKey: runtimeHostKeyForAgent(agent.id), port,
  });
  const alphaVA = mkVA('alpha', alphaAgent);
  const betaVA = mkVA('beta', betaAgent);
  const foreignVA = mkVA('foreign', foreignAgent);
  await Promise.all([alphaVA.start(), betaVA.start(), foreignVA.start()]);
  t.after(async () => {
    await Promise.all([alphaVA.stop(), betaVA.stop(), foreignVA.stop()]);
  });
  await new Promise((r) => setTimeout(r, 250));

  step('A human comment @-tags the assignee (alpha) and a bystander (beta)');
  const res = await fetch(`http://localhost:${port}/api/tickets/${ticket.id}/comments`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'X-Account-Id': ws.id,
    },
    body: JSON.stringify({
      content: `@[agent:${alphaAgent.id}|alpha] please look at this — cc @[agent:${betaAgent.id}|beta]`,
    }),
  });
  assert.equal(res.status, 201, `comment create should succeed, got ${res.status}`);

  const mention = await alphaVA.waitForMention((m) => m.ticket_id === ticket.id, 4000);
  assert.equal(mention.agent_id, alphaAgent.id);
  assert.equal(mention.mention_source, 'direct');
  assert.equal(mention.actor_type, 'user');
  assert.equal(mention.actor_id, user.id);
  assert.match(mention.content || '', /please look at this/);
  assert.equal(mention.role_prompt, alphaAgent.runtime_spec.role_prompt);
  assert.equal(mention.runtime?.manager_agent_id, alphaAgent.runtime_spec.manager_agent_id,
    'the spec rides the event so the host can resolve the identity');
  assert.equal(mention.runtime?.working_dir, alphaAgent.runtime_spec.working_dir);

  await new Promise((r) => setTimeout(r, 400));
  assert.equal(alphaVA.mentionsFor(ticket.id).length, 1, 'alpha gets exactly one mention');
  assert.equal(betaVA.mentionsFor(ticket.id).length, 0, 'beta is not on the ticket — its tag wakes nothing');
  assert.equal(
    foreignVA.mentionsFor(ticket.id).length,
    0,
    'cross-workspace agent must not see mention',
  );
  assert.equal(
    alphaVA.triggersFor(ticket.id).filter((tr) => tr.trigger_source === 'comment').length,
    0,
    'the mention already wakes the assignee — no second agent_trigger for the comment',
  );

  exitAfterTests(0);
});
