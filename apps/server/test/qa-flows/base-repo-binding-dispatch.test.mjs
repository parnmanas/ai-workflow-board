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
//   2. THE ACCEPTANCE (reviewer P1): a base-repo-less ticket on a board whose
//      environment (and workspace) declare NO repository — the both-empty case —
//      is pended on an assignee/active dispatch: no agent_trigger, plus a
//      pend_reason and a system comment. The old `repoWasExpected` gate let this
//      exact path emit; the literal guard now fails it closed, mirroring the
//      manager's own missing_repository_resource abort.
//   3. A ticket that declares an UNRESOLVABLE base repo (deleted Resource) on an
//      assignee/active dispatch is likewise pended — no agent_trigger — rather
//      than dispatched into a worktree it can't push from. Fail closed.
//   4. (ticket b5c1c080) GLOBAL(workspace_id=null, admin 공유) Resource도
//      workspace-scoped Resource와 동일하게 dispatch 시점에 resolve되어야
//      한다 — 티켓 자신의 base_repo_resource_id로 설정된 경우든, board의
//      environment_config를 통해서만 참조되는 경우든 마찬가지다. 이 티켓
//      이전에는 trigger-loop의 세 Resource 조회가 DB where절에 EXACT-match
//      workspace_id 필터를 걸어서, NULL 컬럼과는 절대 매치되지 않아 global
//      repo가 dispatch 시점에 조용히 사라졌다(base_repo와 environment_config
//      둘 다 비어 "repo 없음"으로 오탐 pend) — get_ticket/loadTicketFull,
//      resources REST API, ci-wait-resume 등 나머지 모든 reader는 이미
//      permissive한 id-only-fetch + 애플리케이션 코드 체크 패턴을 써서 정상
//      resolve하고 있었는데도 그랬다.

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

test('base repo binding: env backfill reaches the wire; repo-less + unresolvable dispatch pends (ticket 8c3befa8)', async (t) => {
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
  assert.equal(t1Fresh.base_repo_resource_id, resource.id, 'dispatch가 후속 CI/merge/QA용 유효 repo를 티켓에 백필해야 한다');
  assert.equal(t1Fresh.base_branch, 'main', 'Resource.default_branch도 티켓의 빈 branch에 백필해야 한다');

  // TXIV 회귀: board.workspace_id만 현재 소속이고 ticket/column workspace_id는
  // 과거 workspace를 가리킨다. 보드 repo/default_branch가 wire까지 유지돼야 한다.
  step('Scenario 1b: stale ticket/column workspace에서도 board repo/main으로 dispatch');
  const legacyWs = await ds.getRepository('Workspace').save(ds.getRepository('Workspace').create({
    name: 'legacy-txiv-workspace',
  }));
  const t1b = await createTicket(app, getDataSourceToken, {
    columnId: columns.inProgress.id, workspaceId: ws.id,
    title: 'TXIV legacy workspace mismatch', assigneeId: assignee.id,
  });
  await ds.getRepository('Ticket').update(t1b.id, { workspace_id: legacyWs.id });
  await ds.getRepository('BoardColumn').update(columns.inProgress.id, { workspace_id: legacyWs.id });
  await triggerLoop.dispatchCurrentColumn(t1b.id, 'qa-base-repo-legacy-workspace', 'qa-actor');
  const trig1b = await va.waitForTrigger((tr) => tr.ticket_id === t1b.id, 4000);
  assert.equal(trig1b._wire.base_repo?.id, resource.id, 'board repo가 stale ticket workspace 때문에 제거되면 안 된다');
  assert.equal(trig1b._wire.base_repo?.url, 'https://github.com/parnmanas/ai-workflow-board.git');
  assert.equal(trig1b._wire.base_branch, 'main');
  assert.equal(trig1b._wire.environment_config?.repositories?.[0]?.resource_id, resource.id);
  assert.equal(trig1b._wire.environment_config?.repositories?.[0]?.branch, 'main');
  const t1bFresh = await ds.getRepository('Ticket').findOne({ where: { id: t1b.id } });
  assert.equal(t1bFresh.base_repo_resource_id, resource.id);
  assert.equal(t1bFresh.base_branch, 'main');
  await ds.getRepository('BoardColumn').update(columns.inProgress.id, { workspace_id: ws.id });

  // ── Scenario 2: THE ACCEPTANCE — board AND ticket both declare NO repo ───────
  // ticket 8c3befa8 verification: "보드에 environment repo 가 없는 상태로 base_repo
  // 미지정 티켓 dispatch → 추정 없이 pend/차단 + 사유 코멘트". A fresh scene with NO
  // envRepo (board environment_config unset, workspace too) and its own single-
  // ticket assignee so the focus gate can't drop the ticket before the base-repo
  // guard runs. This is the exact regression the reviewer's P1 flagged — under the
  // old `repoWasExpected` gate this path emitted; now it must fail closed.
  step('Scenario 2: repo-less board + base-repo-less ticket → pend, emit nothing, reason comment');
  const sceneB = await setupKanbanScene(app, getDataSourceToken, { workspaceName: 'base-repo-none' });
  await ds.getRepository('Board').update(sceneB.board.id, { max_concurrent_tickets_per_agent: 5 });
  const boardBFresh = await ds.getRepository('Board').findOne({ where: { id: sceneB.board.id } });
  assert.ok(!boardBFresh.environment_config, 'scene B board must have no environment_config (both-empty acceptance)');

  const assigneeB = await createAgent(app, getDataSourceToken, sceneB.ws.id, { name: 'assignee-b' });
  const assigneeBKey = await createApiKey(app, getDataSourceToken, assigneeB.id, {
    workspaceId: sceneB.ws.id, label: 'assignee-b',
  });
  const vaB = new VirtualAgent({
    name: 'assignee-b', agentId: assigneeB.id, apiKey: assigneeBKey.raw_key, port,
  });
  await vaB.start();
  t.after(async () => { await vaB.stop(); });
  await new Promise((r) => setTimeout(r, 300));

  const t2 = await createTicket(app, getDataSourceToken, {
    columnId: sceneB.columns.inProgress.id, workspaceId: sceneB.ws.id,
    title: 'no base repo, no board env repo — must pend', assigneeId: assigneeB.id,
  });
  const beforeB = vaB.triggersFor(t2.id).length;
  await triggerLoop.dispatchCurrentColumn(t2.id, 'qa-base-repo', 'qa-actor');
  // Give any (wrongly) emitted trigger a beat to arrive over SSE — it must not.
  await new Promise((r) => setTimeout(r, 600));
  assert.equal(
    vaB.triggersFor(t2.id).length, beforeB,
    'an assignee/active dispatch with NO repo anywhere must NOT emit an agent_trigger',
  );
  const t2Fresh = await ds.getRepository('Ticket').findOne({ where: { id: t2.id } });
  assert.equal(!!t2Fresh.pending_user_action, true, 'the repo-less ticket must be pended (fail closed) — the acceptance');
  assert.match(t2Fresh.pending_reason || '', /base repo/i, 'the pend reason must explain the unresolved base repo');
  // The block must also leave a discoverable 사유 코멘트 in the thread.
  const t2Comments = await ds.getRepository('Comment').find({ where: { ticket_id: t2.id } });
  assert.ok(
    t2Comments.some((c) => /base repo 미해결/.test(c.content || '')),
    'a system comment must explain the dispatch block',
  );

  // ── Scenario 3: a ticket that DECLARES an unresolvable repo (deleted) → pend ──
  // Retains coverage of the "repo declared but the Resource is gone" failure shape
  // on the repo-configured board (scene A). Same literal guard, different cause.
  step('Scenario 3: ticket declaring a non-existent base repo also pends (fail closed)');
  const t3 = await createTicket(app, getDataSourceToken, {
    columnId: columns.inProgress.id, workspaceId: ws.id,
    title: 'declares a deleted base repo', assigneeId: assignee.id,
  });
  // A base_repo_resource_id that resolves to no Resource (deleted / cross-workspace).
  await ds.getRepository('Ticket').update(t3.id, {
    base_repo_resource_id: '00000000-0000-0000-0000-000000000000',
    base_branch: '',
  });
  const before3 = va.triggersFor(t3.id).length;
  await triggerLoop.dispatchCurrentColumn(t3.id, 'qa-base-repo', 'qa-actor');
  await new Promise((r) => setTimeout(r, 600));
  assert.equal(
    va.triggersFor(t3.id).length, before3,
    'an assignee dispatch with an unresolvable declared base repo must NOT emit an agent_trigger',
  );
  const t3Fresh = await ds.getRepository('Ticket').findOne({ where: { id: t3.id } });
  assert.equal(!!t3Fresh.pending_user_action, true, 'the ticket must be pended (fail closed)');
  assert.match(t3Fresh.pending_reason || '', /base repo/i, 'the pend reason must explain the unresolved base repo');

  // ── Scenario 4: THE TERMINAL-GATE ACCEPTANCE (ticket ec498050) ──────────────
  // Same repo-less "must block" shape as Scenario 2, but on a TERMINAL column
  // routed to assignee — mirroring how the production AWB board's real Done
  // column routes to assignee for post-Done self-improvement retrospectives
  // (root cause of ticket 0709ea7c on a sibling guard). The dispatch must
  // still be BLOCKED (no repo to push from, regardless of column), but
  // `_pendForMissingBaseRepo` must NOT set pending_user_action — a Done
  // ticket's User tab is never revisited by a human, so parking it here would
  // strand it invisibly forever.
  step('Scenario 4: repo-less board + terminal (Done) column routed to assignee → block emits nothing, but does NOT pend');
  await ds.getRepository('BoardColumn').update(sceneB.columns.done.id, {
    role_routing: JSON.stringify(['assignee']),
  });
  const t4 = await createTicket(app, getDataSourceToken, {
    columnId: sceneB.columns.done.id, workspaceId: sceneB.ws.id,
    title: 'terminal column, no base repo — must block but not pend', assigneeId: assigneeB.id,
  });
  const before4 = vaB.triggersFor(t4.id).length;
  await triggerLoop.dispatchCurrentColumn(t4.id, 'qa-base-repo', 'qa-actor');
  await new Promise((r) => setTimeout(r, 600));
  assert.equal(
    vaB.triggersFor(t4.id).length, before4,
    'a terminal-column dispatch with no resolvable repo must still NOT emit an agent_trigger',
  );
  const t4Fresh = await ds.getRepository('Ticket').findOne({ where: { id: t4.id } });
  assert.equal(!!t4Fresh.pending_user_action, false, 'a terminal-column ticket must NOT be pended by the base-repo guard');
  const pendActs4 = await ds.getRepository('ActivityLog').find({
    where: { ticket_id: t4.id, field_changed: 'pending_user_action' },
  });
  assert.equal(pendActs4.length, 0, 'no pending_user_action audit row for a skipped terminal pend');
  const t4Comments = await ds.getRepository('Comment').find({ where: { ticket_id: t4.id } });
  assert.equal(
    t4Comments.filter((c) => /base repo 미해결/.test(c.content || '')).length, 0,
    'the explanatory "dispatch blocked, pend for a human" comment is skipped too — there is no park to explain',
  );

  // ── Scenario 5: 티켓 자신의 base_repo_resource_id가 GLOBAL Resource인 경우
  // (ticket b5c1c080). 이 티켓 이전에는 trigger-loop.service.ts가 티켓 자신의
  // base repo를 `where: { id, workspace_id }`로 resolve했다 — workspace_id가
  // NULL인 Resource row와는 절대 매치되지 않는 정확일치 필터라, loadTicketFull은
  // get_ticket/REST로 정상 표시하는데도 실제 dispatch 시점엔 global(admin 공유)
  // repo가 조용히 resolve 실패했다.
  step('Scenario 5: ticket\'s own base_repo_resource_id points at a GLOBAL Resource — must resolve, not pend');
  const globalResource = await ds.getRepository('Resource').save(
    ds.getRepository('Resource').create({
      workspace_id: null,
      name: 'global shared repo',
      type: 'repository',
      url: 'https://github.com/parnmanas/global-shared.git',
      default_branch: 'main',
    }),
  );
  const t5 = await createTicket(app, getDataSourceToken, {
    columnId: columns.inProgress.id, workspaceId: ws.id,
    title: 'ticket base repo is a global Resource', assigneeId: assignee.id,
  });
  await ds.getRepository('Ticket').update(t5.id, {
    base_repo_resource_id: globalResource.id,
    base_branch: '',
  });
  await triggerLoop.dispatchCurrentColumn(t5.id, 'qa-base-repo', 'qa-actor');
  const trig5 = await va.waitForTrigger((tr) => tr.ticket_id === t5.id, 4000);
  assert.ok(trig5._wire.base_repo, 'a global Resource set as the ticket\'s own base repo must reach the flattened wire');
  assert.equal(trig5._wire.base_repo.id, globalResource.id, 'base_repo must be the global Resource');
  assert.equal(trig5._wire.base_repo.url, 'https://github.com/parnmanas/global-shared.git');
  const t5Fresh = await ds.getRepository('Ticket').findOne({ where: { id: t5.id } });
  assert.equal(!!t5Fresh.pending_user_action, false, 'a resolvable global base repo must NOT pend the ticket');

  // ── Scenario 6: board의 environment_config를 통해서만 참조되는 GLOBAL
  // Resource인 경우(티켓 자신은 base_repo_resource_id가 없음) — ticket
  // b5c1c080이 원래 지목한 나머지 두 지점, 즉 env-repo 목록 resolve
  // (environment_config.repositories로 이어짐)와 goal-1 base_repo 백필
  // (base_repo로 이어짐) 둘 다 이 global Resource를 resolve해야 하며,
  // 한쪽만 되어서는 안 된다.
  step('Scenario 6: board environment_config references ONLY a GLOBAL Resource — env repos + base_repo backfill must both resolve');
  await ds.getRepository('Board').update(board.id, {
    environment_config: JSON.stringify({ repositories: [{ resource_id: globalResource.id }] }),
  });
  const t6 = await createTicket(app, getDataSourceToken, {
    columnId: columns.inProgress.id, workspaceId: ws.id,
    title: 'board env repo is a global Resource, no ticket base repo', assigneeId: assignee.id,
  });
  await triggerLoop.dispatchCurrentColumn(t6.id, 'qa-base-repo', 'qa-actor');
  const trig6 = await va.waitForTrigger((tr) => tr.ticket_id === t6.id, 4000);
  assert.ok(trig6._wire.base_repo, 'base_repo must be backfilled from the board env\'s global Resource');
  assert.equal(trig6._wire.base_repo.id, globalResource.id, 'backfilled base_repo must be the global Resource');
  assert.ok(trig6._wire.environment_config, 'environment_config must reach the wire');
  assert.equal(
    trig6._wire.environment_config.repositories?.[0]?.url,
    'https://github.com/parnmanas/global-shared.git',
    'the global Resource must NOT be silently dropped from environment_config.repositories',
  );
  const t6Fresh = await ds.getRepository('Ticket').findOne({ where: { id: t6.id } });
  assert.equal(!!t6Fresh.pending_user_action, false, 'a resolvable global env repo must NOT pend the ticket');

  exitAfterTests(0);
});
