// Real-boot supervisor liveness reclaim / exactly-once / restart (ticket 1fcba693).
//
// The reviewer rejected the fakes-only supervisor-liveness-redispatch.test.mjs
// because it injects hasLiveRoleStrand=false and a stub emitAgentTrigger, so it
// never exercises the REAL in-flight-strand gate, the REAL current_task
// registry, or an actual slot/claim cleanup. This boots the whole NestJS app
// and drives the genuine machinery:
//
//   • a live strand (real AgentStatusService.setCurrentTask) is NOT re-dispatched
//     even under the 4 h incident stale window — the real in-flight-strand gate
//     drops the supervisor's non-force nudge (no false restart of long work);
//   • a KILLED / leaked strand (current_task gone stale + a stale claim) is
//     re-dispatched EXACTLY once through the real emit path (observed over SSE by
//     a VirtualAgent), and the server ATOMICALLY reclaims the seat: the ghost
//     current_task is cleared and the DB claim is released;
//   • after the re-dispatch "spawns" a fresh strand, further ticks AND a
//     supervisor restart (in-memory state wiped) emit NOTHING more — durable
//     exactly-once via the shared AgentStatus registry, not the wiped Map.
//
// Harness: bootApp + VirtualAgent (SSE) + app.get(singletons). Staleness is
// data-driven (a fresh ticket has my_last_update_at=null → Infinity staleness),
// so every tick is "actionable"; the DIFFERENTIATOR under test is absentStrand
// (live current_task / recent output) → drop-vs-reclaim-vs-emit, which is
// exactly the liveness decoupling this ticket adds.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { bootApp } from '../helpers/boot.mjs';
import {
  setupKanbanScene, createUser, createAgent, createApiKey, createTicket,
} from '../helpers/fixtures.mjs';
import { VirtualAgent } from '../helpers/virtual-agent.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST_ROOT = path.join(__dirname, '..', '..', 'dist');
const loadDist = (...p) => import('file://' + path.join(DIST_ROOT, ...p));

const MIN = 60_000;
const FOUR_H_MS = 4 * 60 * MIN; // the incident supervisor_stale_ms
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, timeoutMs = 2500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return true;
    await sleep(40);
  }
  return false;
}

test('supervisor liveness reclaim: live strand protected, killed strand reclaimed+re-dispatched exactly once, durable across restart', async (t) => {
  const { app, port, modules } = await bootApp({ port: parseInt(process.env.PORT || '7867', 10) });
  t.after(() => { void app.close().catch(() => {}); });
  const { getDataSourceToken } = modules;
  const ds = app.get(getDataSourceToken());

  const { AgentStatusService, CURRENT_TASK_STALE_MS } = await loadDist('modules', 'agents', 'agent-status.service.js');
  const { TicketSupervisorService } = await loadDist('modules', 'agents', 'ticket-supervisor.service.js');
  const agentStatus = app.get(AgentStatusService);
  const supervisor = app.get(TicketSupervisorService);

  // 4 h incident window: proves recovery is decoupled from the stale window.
  const { ws, columns } = await setupKanbanScene(app, getDataSourceToken, {
    workspaceName: 'liveness-reclaim', maxConcurrent: 3, envRepo: true,
  });
  await ds.getRepository('Workspace').update(ws.id, { supervisor_stale_ms: FOUR_H_MS });

  const user = await createUser(app, getDataSourceToken, { name: 'driver' });
  const agent = await createAgent(app, getDataSourceToken, ws.id, { name: 'worker' });
  const key = await createApiKey(app, getDataSourceToken, agent.id, { workspaceId: ws.id, label: 'worker' });
  // Online gate: the supervisor skips agents whose DB last_seen_at is older than
  // 90 s. Fixtures leave it null — bump it so the tick considers this agent.
  await ds.getRepository('Agent').update(agent.id, { last_seen_at: new Date() });

  const ticket = await createTicket(app, getDataSourceToken, {
    columnId: columns.inProgress.id, workspaceId: ws.id,
    title: 'reclaim target', assigneeId: agent.id,
  });

  const va = new VirtualAgent({ name: 'worker', agentId: agent.id, apiKey: key.raw_key, port, boardId: undefined });
  await va.start();
  t.after(async () => { await va.stop(); });
  await sleep(400); // let SSE settle

  const ticketRepo = ds.getRepository('Ticket');
  const activityRepo = ds.getRepository('ActivityLog');
  const role = 'assignee';
  const dropRows = () => activityRepo.find({ where: { ticket_id: ticket.id, action: 'agent_trigger_dropped_inflight_strand' } });
  const activeTask = () => agentStatus.state.get(agent.id)?.active_tasks?.get(ticket.id);

  const key3 = `${agent.id}:${ticket.id}:${role}`;
  const outputKey = `${agent.id}:${ticket.id}:${role}`;

  // ── Phase 1: KILL a strand (leaked current_task + stale claim) → reclaim ────
  // Simulate a manager restart / reap that skipped clear_current_task +
  // release_ticket: current_task lingers (backdate past the 15 min TTL) and the
  // claim is still held by the dead agent (backdate past the reclaim grace).
  await agentStatus.setCurrentTask(agent.id, ticket.id, role);
  const stale = new Date(Date.now() - CURRENT_TASK_STALE_MS - MIN);
  activeTask().claimed_at = stale; // leaked ghost, now TTL-stale
  await ticketRepo.update(ticket.id, { locked_by_agent_id: agent.id, locked_at: stale });
  assert.equal(agentStatus.hasLiveRoleStrand(agent.id, ticket.id, role), false, 'TTL-stale strand reads as not-live (absent)');

  await supervisor._tick();
  const gotOne = await waitFor(() => va.triggersFor(ticket.id).length === 1);
  assert.equal(gotOne, true, 'absent strand re-dispatched EXACTLY once over the real SSE path (floor, not 4 h)');

  // Server ATOMICALLY reclaimed the seat (the reviewer's point 6):
  assert.equal(activeTask(), undefined, 'the ghost current_task was cleared by the server at re-dispatch');
  const afterKill = await ticketRepo.findOne({ where: { id: ticket.id } });
  assert.equal(afterKill.locked_by_agent_id, null, 'the stale claim/lock was released by the server at re-dispatch');
  assert.equal(afterKill.locked_at, null, 'locked_at cleared too');

  // ── Phase 2: a LIVE re-spawned strand is protected even under the 4 h window ─
  // The re-dispatch "spawned" a healthy strand: fresh current_task + output.
  // Past the resend cooldown the supervisor must NOT re-emit — the non-force
  // nudge is dropped by the REAL in-flight-strand gate and fresh output
  // suppresses any force escalation (no false restart of long work).
  // Token'd set — the real (new) manager stamps a per-session generation nonce so
  // the matching clear can prove it owns THIS generation of the seat (ticket
  // 1fcba693 CAS). Phase 4 releases with this same token.
  const LIVE_TOKEN = 'gen-live-1';
  await agentStatus.setCurrentTask(agent.id, ticket.id, role, LIVE_TOKEN);
  agentStatus.recordOutputLiveness(agent.id, ticket.id, role);
  const e2 = supervisor.state.get(key3);
  if (e2) e2.lastEmitAt = 0; // elapse the resend cooldown deterministically
  const dropsBefore = (await dropRows()).length;

  for (let i = 0; i < 3; i++) { await supervisor._tick(); await sleep(60); }
  assert.equal(va.triggersFor(ticket.id).length, 1, 'a live strand is never double-dispatched under the 4 h window (exactly once across ticks)');
  assert.equal((await dropRows()).length > dropsBefore, true, 'the live strand’s nudge was dropped by the REAL in-flight-strand gate');

  // ── Phase 3: supervisor RESTART (in-memory state wiped) → still no re-fire ──
  // The only durable dedup is the shared AgentStatus registry + DB, NOT the
  // supervisor's Map. A fresh supervisor must re-derive "this strand is live"
  // and stay silent — no ghost re-dispatch after restart.
  supervisor.state.clear();
  await supervisor._tick();
  await sleep(150);
  assert.equal(va.triggersFor(ticket.id).length, 1, 'after a supervisor restart, a live strand is left alone (durable exactly-once)');

  // ── Phase 4: exit→clear→reclaim (ticket 1fcba693 root fix, reviewer item 2) ──
  // The Phase-2 strand is still registered (current_task + fresh output from the
  // "healthy re-spawn"). Model its SILENT EXIT: the manager fires clearCurrentTask
  // on the seat release, which now ALSO drops the output-liveness badge. Before
  // this fix the badge lingered — keeping the seat counted as a live producer
  // (non-absent) for up to min(stale, retention) = 4 h — so recovery waited ~4 h,
  // NOT the floor. We prove the release makes the seat absent IMMEDIATELY (with
  // NO manual output aging, unlike the old workaround) and role-precisely, so the
  // fresh supervisor recovers it at the fast floor: exactly one MORE re-dispatch.
  supervisor.state.clear();
  // A sibling seat for a DIFFERENT role on the SAME ticket must survive the
  // assignee release — the clear is role-precise, not ticket-wide.
  const reviewerOutputKey = `${agent.id}:${ticket.id}:reviewer`;
  agentStatus.outputLiveness.set(reviewerOutputKey, Date.now());
  assert.notEqual(agentStatus.outputLiveness.get(outputKey), undefined, 'assignee output badge present just before the exit (produced right up to the end)');

  // Generation-verified clear: same token the live session was set with (the new
  // manager threads its per-session nonce to the seat release). Only a matching
  // token releases the output badge (ticket 1fcba693 CAS).
  agentStatus.clearCurrentTask(agent.id, ticket.id, LIVE_TOKEN); // clean/silent exit → seat release

  assert.equal(agentStatus.outputLiveness.get(outputKey), undefined, 'a matching-token clearCurrentTask ALSO cleared the assignee output-liveness badge (the root fix) — no lingering producer signal');
  assert.notEqual(agentStatus.outputLiveness.get(reviewerOutputKey), undefined, 'a sibling reviewer-seat badge on the same ticket is NOT cleared by the assignee release (role-precise)');
  assert.equal(agentStatus.hasLiveRoleStrand(agent.id, ticket.id, role), false, 'the released seat reads absent immediately — NOT held for the 4 h output gate');

  await supervisor._tick();
  const gotTwo = await waitFor(() => va.triggersFor(ticket.id).length === 2);
  assert.equal(gotTwo, true, 'a released seat is recovered at the fast floor — exactly one MORE re-dispatch, not after the 4 h output gate');
  await sleep(200);
  assert.equal(va.triggersFor(ticket.id).length, 2, 'still exactly two total (no respawn storm)');

  // ── Phase 5: generation CAS — set(A)→set(B same seat)→late clear(A) is a no-op
  //    against live B (ticket 1fcba693, reviewer item 2). active_tasks is keyed by
  //    ticket_id ALONE, so a respawn (B) overwrites A's entry in place; A's stale
  //    exit-clear must NOT wipe B's task OR its output badge — otherwise the live
  //    replacement is false-flagged absent on both signals and duplicate-re-
  //    dispatched, breaking the exactly-once / no-respawn-storm guarantee. Only
  //    B's OWN token'd clear releases the seat. This is the exact race the
  //    reviewer required a regression for. ──
  supervisor.state.clear();
  const TOKEN_A = 'gen-A';
  const TOKEN_B = 'gen-B';
  await agentStatus.setCurrentTask(agent.id, ticket.id, role, TOKEN_A); // session A claims the seat
  await agentStatus.setCurrentTask(agent.id, ticket.id, role, TOKEN_B); // respawn B overwrites the SAME (ticket,role) seat
  agentStatus.recordOutputLiveness(agent.id, ticket.id, role);          // B is producing output → live
  assert.equal(activeTask()?.task_token, TOKEN_B, 'the seat now stores the newest generation token (B overwrote A)');

  // A's LATE exit-clear arrives carrying A's (now-stale) token — must be a full no-op.
  agentStatus.clearCurrentTask(agent.id, ticket.id, TOKEN_A);
  assert.notEqual(activeTask(), undefined, "live B's task survives A's late clear (CAS skip on token mismatch)");
  assert.equal(activeTask()?.task_token, TOKEN_B, "B's task is untouched — still generation B");
  assert.notEqual(agentStatus.outputLiveness.get(outputKey), undefined, "live B's output badge survives A's late clear");
  assert.equal(agentStatus.hasLiveRoleStrand(agent.id, ticket.id, role), true, 'B is still counted live — no false-absent');

  // A fresh supervisor must therefore NOT re-dispatch while B is live.
  supervisor.state.clear();
  await supervisor._tick();
  await sleep(150);
  assert.equal(va.triggersFor(ticket.id).length, 2, "no extra re-dispatch while B is live (A's stale clear caused no duplicate) — still exactly two");

  // B's OWN token'd clear (its real exit) releases the task + badge → absent →
  // recovered exactly once more at the floor.
  agentStatus.clearCurrentTask(agent.id, ticket.id, TOKEN_B);
  assert.equal(activeTask(), undefined, "B's matching-token clear releases the task");
  assert.equal(agentStatus.outputLiveness.get(outputKey), undefined, "B's matching-token clear releases the output badge too");
  assert.equal(agentStatus.hasLiveRoleStrand(agent.id, ticket.id, role), false, "seat is absent after B's own release");

  supervisor.state.clear();
  await supervisor._tick();
  const gotThree = await waitFor(() => va.triggersFor(ticket.id).length === 3);
  assert.equal(gotThree, true, "after B's real release the seat is recovered at the floor — exactly one more (third) re-dispatch");
  await sleep(200);
  assert.equal(va.triggersFor(ticket.id).length, 3, 'still exactly three total (no respawn storm)');
});
