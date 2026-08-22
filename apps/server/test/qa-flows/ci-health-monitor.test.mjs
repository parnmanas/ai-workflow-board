// QA flow: CiHealthMonitorService — main CI red-streak alert + auto-ticket +
// dedup + recovery (ticket cc1c494e).
//
// What this proves
// ────────────────
// `CiHealthMonitorService.sweep()` is the in-process equivalent of one
// interval tick, exercised against a real (sqlite) app instance with a fake
// `globalThis.fetch` standing in for the GitHub REST API (no real network
// call — same pattern as outreach-publish-behavior.test.mjs).
//
//   1. A red streak (5 consecutive `failure` runs, ≥ CI_MONITOR_MIN_RUNS)
//      trips on the first sweep: one `ci_red_alerts` row is written, one
//      system chat alert is posted in the workspace's alerts room, and one
//      Backlog ticket is auto-created carrying the CI-red
//      `operational_dedupe_key`.
//   2. (dedup) A second sweep against the SAME still-red fixture updates the
//      existing row but creates NO second ticket and posts NO second chat
//      message (re-alert cooldown).
//   3. (recovery) The newest run flips to `success` → the next sweep posts a
//      one-shot recovery message, appends a recovery comment on the tracked
//      ticket WITHOUT closing it, and deletes the `ci_red_alerts` row.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootApp, exitAfterTests, step } from '../helpers/boot.mjs';
import { createWorkspace, createBoard, createColumn } from '../helpers/fixtures.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST_ROOT = path.resolve(__dirname, '..', '..', 'dist');

process.env.PORT = process.env.QA_CI_HEALTH_MONITOR_PORT || '7930';

// ─── fake GitHub REST API ───────────────────────────────────────────────

const REAL_FETCH = globalThis.fetch;
function restoreFetch() { globalThis.fetch = REAL_FETCH; }

function fakeResponse(json) {
  return { ok: true, status: 200, async json() { return json; }, async text() { return JSON.stringify(json); } };
}

function fakeErrorResponse(status, body) {
  // headers.get() must be present (even with nothing set) — assertGitHubOk
  // always reads 'retry-after' before branching on status, so a response
  // fixture without it would TypeError before ever reaching the intended
  // 401/403/429 branch (matches outreach-github-connector.test.mjs's fakeResponse).
  return {
    ok: false, status,
    async json() { try { return JSON.parse(body); } catch { return {}; } },
    async text() { return body; },
    headers: { get: () => null },
  };
}

/** Builds a fake `fetch` bound to a mutable `state.runs` array (newest-first)
 *  so a test can swap the fixture between sweeps without re-wiring anything. */
function makeFakeGitHubFetch(state) {
  return async (url) => {
    const u = String(url);
    if (u.includes('/actions/workflows/') && u.includes('/runs?')) {
      return fakeResponse({ workflow_runs: state.runs });
    }
    if (u.endsWith('/actions/workflows')) {
      return fakeResponse({ workflows: [{ id: 555, name: 'CI', path: '.github/workflows/ci.yml', state: 'active' }] });
    }
    if (u.includes('/actions/runs/') && u.endsWith('/jobs')) {
      return fakeResponse({ jobs: [{ name: 'agent-manager-tests (ubuntu-latest)', conclusion: 'failure' }, { name: 'server-tests', conclusion: 'failure' }] });
    }
    throw new Error(`unexpected GitHub URL in CiHealthMonitorService qa-flow test: ${u}`);
  };
}

/** Records the Authorization header of the last call so a test can prove
 *  which credential actually got used, on top of the usual fixture routing. */
function makeFakeGitHubFetchWithAuth(state) {
  return async (url, opts) => {
    state.lastAuthHeader = opts?.headers?.Authorization;
    const u = String(url);
    if (u.includes('/actions/workflows/') && u.includes('/runs?')) {
      return fakeResponse({ workflow_runs: state.runs });
    }
    if (u.endsWith('/actions/workflows')) {
      return fakeResponse({ workflows: [{ id: state.workflowId, name: 'CI', path: '.github/workflows/ci.yml', state: 'active' }] });
    }
    if (u.includes('/actions/runs/') && u.endsWith('/jobs')) {
      return fakeResponse({ jobs: [{ name: 'gizmo-job', conclusion: 'failure' }] });
    }
    throw new Error(`unexpected GitHub URL in credential-auth test: ${u}`);
  };
}

/** Routes STRICTLY by repo name (acme/broken → 401, acme/healthy2 → the red
 *  fixture) and throws for anything else — deliberately unrouted, so a call
 *  against any OTHER already-seeded board in this suite surfaces as its own
 *  fetch failure instead of accidentally being answered by this fixture and
 *  polluting this test's alert-count assertions. */
function makeFakeGitHubFetchMixed(state) {
  return async (url) => {
    const u = String(url);
    if (u.includes('acme/broken')) {
      if (u.endsWith('/actions/workflows')) return fakeErrorResponse(401, 'Bad credentials');
      throw new Error(`unexpected GitHub URL for broken repo: ${u}`);
    }
    if (u.includes('acme/healthy2')) {
      if (u.includes('/actions/workflows/') && u.includes('/runs?')) return fakeResponse({ workflow_runs: state.runs });
      if (u.endsWith('/actions/workflows')) return fakeResponse({ workflows: [{ id: state.workflowId, name: 'CI', path: '.github/workflows/ci.yml', state: 'active' }] });
      if (u.includes('/actions/runs/') && u.endsWith('/jobs')) return fakeResponse({ jobs: [{ name: 'healthy-job', conclusion: 'failure' }] });
      throw new Error(`unexpected GitHub URL for healthy repo: ${u}`);
    }
    throw new Error(`unrouted GitHub URL in mixed-failure isolation test (expected only acme/broken or acme/healthy2): ${u}`);
  };
}

/** Routes by Authorization header rather than by repo — both boards in the
 *  cache-collision test point at the SAME owner/repo/branch, so the only way
 *  to tell "which board's call is this" apart is which credential's token
 *  came through. Records every header seen so a test can assert BOTH
 *  credentials' calls actually fired against GitHub (a cache keyed only by
 *  owner/repo would serve the second board's call from the first board's
 *  cached promise and this header would never appear). */
function makeFakeGitHubFetchSharedRepoByCredential(state) {
  return async (url, opts) => {
    const auth = opts?.headers?.Authorization;
    state.authHeaders.push(auth);
    const u = String(url);
    if (auth === 'Bearer shared-bad-token') {
      if (u.endsWith('/actions/workflows')) return fakeErrorResponse(401, 'Bad credentials');
      throw new Error(`unexpected GitHub URL for bad-credential shared-repo call: ${u}`);
    }
    if (auth === 'Bearer shared-good-token') {
      if (u.includes('/actions/workflows/') && u.includes('/runs?')) return fakeResponse({ workflow_runs: state.runs });
      if (u.endsWith('/actions/workflows')) return fakeResponse({ workflows: [{ id: state.workflowId, name: 'CI', path: '.github/workflows/ci.yml', state: 'active' }] });
      if (u.includes('/actions/runs/') && u.endsWith('/jobs')) return fakeResponse({ jobs: [{ name: 'shared-job', conclusion: 'failure' }] });
      throw new Error(`unexpected GitHub URL for good-credential shared-repo call: ${u}`);
    }
    throw new Error(`unrouted Authorization header in shared-repo credential-isolation test: ${auth}`);
  };
}

// event 기본값 'push' — 실제 GitHub API는 모든 workflow run에 event를 채워 보낸다
// (ticket 654465c8: evaluateRedStreak가 event가 비어있는 run을 fail-closed로 신호에서
// 제외하므로, 이 기본값이 없으면 아래 모든 sweep 시나리오가 신호를 하나도 못 받는다).
function run(id, conclusion, isoTime, event = 'push') {
  return { id, status: 'completed', conclusion, event, html_url: `https://github.com/acme/widgets/actions/runs/${id}`, created_at: isoTime, updated_at: isoTime };
}

test('CiHealthMonitorService — red streak alert + auto-ticket, dedup, recovery', async (t) => {
  step('Boot NestJS app on test port');
  process.env.CI_MONITOR_ENABLED = 'true';
  process.env.CI_MONITOR_SWEEP_MS = '3600000'; // never fires on its own — we call sweep() directly
  process.env.CI_MONITOR_MIN_RUNS = '3';
  process.env.CI_MONITOR_MIN_AGE_MS = String(6 * 60 * 60_000);
  process.env.CI_MONITOR_REALERT_MS = String(24 * 60 * 60_000);
  process.env.CI_MONITOR_CREATE_TICKET = 'true';
  process.env.GITHUB_TOKEN = 'qa-fake-github-token';

  const { app, modules } = await bootApp({ port: parseInt(process.env.PORT, 10) });
  t.after(() => { void app.close().catch(() => {}); restoreFetch(); });
  const { getDataSourceToken } = modules;
  const ds = app.get(getDataSourceToken());

  const monitorModule = await import(
    'file://' + path.join(DIST_ROOT, 'modules', 'agents', 'ci-health-monitor.service.js')
  );
  const monitor = app.get(monitorModule.CiHealthMonitorService);
  const { encrypt } = await import('file://' + path.join(DIST_ROOT, 'services', 'encryption.service.js'));
  const { LogService } = await import('file://' + path.join(DIST_ROOT, 'services', 'log.service.js'));
  const logService = app.get(LogService);

  step('Seed workspace + alerts room + board (Backlog/active columns) + env-configured GitHub repo');
  const ws = await createWorkspace(app, getDataSourceToken, 'ci-health');
  const roomRepo = ds.getRepository('ChatRoom');
  const room = await roomRepo.save(roomRepo.create({ workspace_id: ws.id, type: 'group', name: 'qa-alerts' }));
  await ds.getRepository('Workspace').update(ws.id, { alerts_chat_room_id: room.id });

  const board = await createBoard(app, getDataSourceToken, ws.id, { name: 'ci-health-board' });
  const backlog = await createColumn(app, getDataSourceToken, board.id, { name: 'Backlog', position: 0, workspaceId: ws.id }); // kind auto-resolves to 'intake'
  await createColumn(app, getDataSourceToken, board.id, { name: 'To Do', position: 1, workspaceId: ws.id, kind: 'active' });

  const resourceRepo = ds.getRepository('Resource');
  const resource = await resourceRepo.save(resourceRepo.create({
    workspace_id: ws.id, name: 'widgets repo', type: 'repository',
    url: 'https://github.com/acme/widgets', default_branch: 'main',
  }));
  await ds.getRepository('Board').update(board.id, {
    environment_config: JSON.stringify({ repositories: [{ resource_id: resource.id }] }),
  });

  const NOW = new Date();
  const minutesAgo = (m) => new Date(NOW.getTime() - m * 60_000).toISOString();
  const redRuns = [
    run('run-5', 'failure', minutesAgo(5)),
    run('run-4', 'failure', minutesAgo(15)),
    run('run-3', 'failure', minutesAgo(25)),
    run('run-2', 'failure', minutesAgo(35)),
    run('run-1', 'failure', minutesAgo(45)),
  ]; // newest-first, 5 consecutive red — well past the 3-run threshold

  const fetchState = { runs: redRuns };
  globalThis.fetch = makeFakeGitHubFetch(fetchState);

  const alertRepo = ds.getRepository('CiRedAlert');
  const ticketRepo = ds.getRepository('Ticket');
  const messageRepo = ds.getRepository('ChatRoomMessage');
  const commentRepo = ds.getRepository('Comment');
  const dedupeKey = `ci_red:${board.id}:acme/widgets:main:555`;

  await t.test('1. first sweep trips the red streak: alert row + chat alert + auto-created Backlog ticket', async () => {
    const stats = await monitor.sweep(NOW);
    assert.equal(stats.alerts_created, 1);
    assert.equal(stats.tickets_created, 1);
    assert.equal(stats.delivery_failures, 0);

    const alert = await alertRepo.findOne({ where: { board_id: board.id, repo_full_name: 'acme/widgets', branch: 'main', workflow_id: '555' } });
    assert.ok(alert, 'CiRedAlert row must exist');
    assert.equal(alert.streak, 5);
    assert.equal(alert.first_failed_run_id, 'run-1');
    assert.equal(alert.last_run_id, 'run-5');
    assert.ok(alert.delivered_at, 'first delivery must have succeeded (alerts room exists)');
    assert.ok(alert.created_ticket_id, 'ticket id must be recorded on the alert row');

    const msgs = await messageRepo.find({ where: { room_id: room.id } });
    const systemMsgs = msgs.filter((m) => m.sender_type === 'system');
    assert.equal(systemMsgs.length, 1, 'exactly one system chat alert posted');
    assert.match(systemMsgs[0].content, /CI red/);
    assert.match(systemMsgs[0].content, /acme\/widgets/);
    assert.match(systemMsgs[0].content, /agent-manager-tests/, 'failed job names must be included in the alert body');

    const ticket = await ticketRepo.findOne({ where: { id: alert.created_ticket_id } });
    assert.ok(ticket, 'auto-created ticket must exist');
    assert.equal(ticket.operational_dedupe_key, dedupeKey);
    assert.equal(ticket.column_id, backlog.id, 'ticket must land in the intake/Backlog column');
    assert.match(ticket.title, /CI red/);
    assert.match(ticket.title, /acme\/widgets/);
  });

  await t.test('2. second sweep against the same still-red fixture: dedup — no second alert row, no second ticket, no second chat message', async () => {
    const stats = await monitor.sweep(NOW); // same NOW → still inside the re-alert cooldown
    assert.equal(stats.alerts_created, 0);
    assert.equal(stats.alerts_updated, 1);
    assert.equal(stats.tickets_created, 0, 'ticket creation must not run twice for the same episode');

    const alerts = await alertRepo.find({ where: { board_id: board.id, repo_full_name: 'acme/widgets', branch: 'main', workflow_id: '555' } });
    assert.equal(alerts.length, 1, 'still exactly one alert row');

    const tickets = await ticketRepo.find({ where: { operational_dedupe_key: dedupeKey } });
    assert.equal(tickets.length, 1, 'still exactly one ticket for this dedupe key');

    const systemMsgs = (await messageRepo.find({ where: { room_id: room.id } })).filter((m) => m.sender_type === 'system');
    assert.equal(systemMsgs.length, 1, 'no second chat alert inside the re-alert cooldown');
  });

  await t.test('3. recovery: newest run flips green — recovery message + ticket comment, alert row deleted, ticket left open', async () => {
    const priorAlert = await alertRepo.findOne({ where: { board_id: board.id, repo_full_name: 'acme/widgets', branch: 'main', workflow_id: '555' } });
    const trackedTicketId = priorAlert.created_ticket_id;

    fetchState.runs = [run('run-6', 'success', minutesAgo(1)), ...redRuns];
    const stats = await monitor.sweep(new Date(NOW.getTime() + 1000));
    assert.equal(stats.recovered, 1);

    const alert = await alertRepo.findOne({ where: { board_id: board.id, repo_full_name: 'acme/widgets', branch: 'main', workflow_id: '555' } });
    assert.equal(alert, null, 'alert row must be deleted on recovery (self-pruning, same as StuckTicketAlert unstuck)');

    const systemMsgs = (await messageRepo.find({ where: { room_id: room.id } })).filter((m) => m.sender_type === 'system');
    assert.equal(systemMsgs.length, 2, 'exactly one recovery message added');
    assert.match(systemMsgs[1].content, /CI 복구|recovered|recovery/i);

    const comments = await commentRepo.find({ where: { ticket_id: trackedTicketId } });
    const recoveryComment = comments.find((c) => /복구/.test(c.content) || /recovered/i.test(c.content));
    assert.ok(recoveryComment, 'a recovery comment must be appended to the tracked ticket');

    const ticket = await ticketRepo.findOne({ where: { id: trackedTicketId } });
    assert.ok(ticket, 'ticket must still exist');
    assert.equal(ticket.column_id, backlog.id, 'recovery must NOT move/close the ticket — that decision is left to whoever holds it');
  });

  await t.test('4. env GITHUB_TOKEN absent but this board\'s Resource carries its own credential: sweep must still call GitHub and detect the red streak (review blocker #1 — global env-only gate must not blind the sweep to a board credential)', async () => {
    const savedEnvToken = process.env.GITHUB_TOKEN;
    delete process.env.GITHUB_TOKEN;
    try {
      const credentialRepo = ds.getRepository('Credential');
      const credential = await credentialRepo.save(credentialRepo.create({
        workspace_id: ws.id, name: 'gizmos cred', provider: 'github',
        encrypted_data: encrypt(JSON.stringify({ token: 'cred-only-token' })),
      }));

      const board2 = await createBoard(app, getDataSourceToken, ws.id, { name: 'ci-health-board-cred' });
      await createColumn(app, getDataSourceToken, board2.id, { name: 'Backlog', position: 0, workspaceId: ws.id });
      await createColumn(app, getDataSourceToken, board2.id, { name: 'To Do', position: 1, workspaceId: ws.id, kind: 'active' });

      const resource2 = await resourceRepo.save(resourceRepo.create({
        workspace_id: ws.id, name: 'gizmos repo', type: 'repository',
        url: 'https://github.com/acme/gizmos', default_branch: 'main', credential_id: credential.id,
      }));
      await ds.getRepository('Board').update(board2.id, {
        environment_config: JSON.stringify({ repositories: [{ resource_id: resource2.id }] }),
      });

      const authState = {
        workflowId: 777,
        runs: [
          run('g-run-3', 'failure', minutesAgo(5)),
          run('g-run-2', 'failure', minutesAgo(15)),
          run('g-run-1', 'failure', minutesAgo(25)),
        ],
      };
      globalThis.fetch = makeFakeGitHubFetchWithAuth(authState);

      const stats = await monitor.sweep(NOW);

      assert.ok(authState.lastAuthHeader, 'a GitHub call must actually have fired this sweep');
      assert.equal(authState.lastAuthHeader, 'Bearer cred-only-token', 'must auth with the Resource credential, not env (which is unset for this test)');
      assert.equal(stats.alerts_created, 1, 'sweep must not globally skip when env token is absent but a board credential resolves');
      assert.equal(stats.tickets_created, 1);

      const credDedupeKey = `ci_red:${board2.id}:acme/gizmos:main:777`;
      const ticket = await ticketRepo.findOne({ where: { operational_dedupe_key: credDedupeKey } });
      assert.ok(ticket, 'auto-created ticket must exist for the credential-only board');
    } finally {
      if (savedEnvToken === undefined) delete process.env.GITHUB_TOKEN;
      else process.env.GITHUB_TOKEN = savedEnvToken;
    }
  });

  await t.test('5. one board\'s GitHub call 401s: sweep records the failure observably and keeps monitoring the other board in the same pass (review blocker #2 — a fetch failure must not be indistinguishable from "nothing to report")', async () => {
    const boardBroken = await createBoard(app, getDataSourceToken, ws.id, { name: 'ci-health-board-broken' });
    await createColumn(app, getDataSourceToken, boardBroken.id, { name: 'Backlog', position: 0, workspaceId: ws.id });
    const resourceBroken = await resourceRepo.save(resourceRepo.create({
      workspace_id: ws.id, name: 'broken repo', type: 'repository',
      url: 'https://github.com/acme/broken', default_branch: 'main',
    }));
    await ds.getRepository('Board').update(boardBroken.id, {
      environment_config: JSON.stringify({ repositories: [{ resource_id: resourceBroken.id }] }),
    });

    const boardHealthy = await createBoard(app, getDataSourceToken, ws.id, { name: 'ci-health-board-healthy2' });
    await createColumn(app, getDataSourceToken, boardHealthy.id, { name: 'Backlog', position: 0, workspaceId: ws.id });
    await createColumn(app, getDataSourceToken, boardHealthy.id, { name: 'To Do', position: 1, workspaceId: ws.id, kind: 'active' });
    const resourceHealthy = await resourceRepo.save(resourceRepo.create({
      workspace_id: ws.id, name: 'healthy2 repo', type: 'repository',
      url: 'https://github.com/acme/healthy2', default_branch: 'main',
    }));
    await ds.getRepository('Board').update(boardHealthy.id, {
      environment_config: JSON.stringify({ repositories: [{ resource_id: resourceHealthy.id }] }),
    });

    const mixedState = {
      workflowId: 888,
      runs: [
        run('h-run-3', 'failure', minutesAgo(5)),
        run('h-run-2', 'failure', minutesAgo(15)),
        run('h-run-1', 'failure', minutesAgo(25)),
      ],
    };
    globalThis.fetch = makeFakeGitHubFetchMixed(mixedState);

    const warnLogsBefore = logService.query({ level: 'warn', category: 'CI' }).length;
    const stats = await monitor.sweep(NOW);

    assert.ok(stats.fetch_failures >= 1, 'the broken board\'s 401 must be counted, not silently absorbed into "no signal"');
    const warnLogsAfter = logService.query({ level: 'warn', category: 'CI' });
    assert.ok(warnLogsAfter.length > warnLogsBefore, 'the fetch failure must be logged under the CI category, not silent');
    const brokenLog = warnLogsAfter.find((e) => JSON.stringify(e.meta || {}).includes('acme/broken'));
    assert.ok(brokenLog, 'the logged failure must identify which board/repo it came from');

    assert.equal(stats.alerts_created, 1, 'the OTHER board must still be evaluated and alerted in the same sweep');
    const healthyDedupeKey = `ci_red:${boardHealthy.id}:acme/healthy2:main:888`;
    const healthyTicket = await ticketRepo.findOne({ where: { operational_dedupe_key: healthyDedupeKey } });
    assert.ok(healthyTicket, 'the healthy board\'s ticket must still be auto-created despite the other board\'s GitHub call failing');

    const brokenAlert = await alertRepo.findOne({ where: { repo_full_name: 'acme/broken' } });
    assert.equal(brokenAlert, null, 'no alert row for the board whose GitHub call failed — there was nothing to evaluate');
  });

  await t.test('6. two boards watch the SAME owner/repo/branch with DIFFERENT credentials: an invalid credential on one board must not poison the sweep for the other board\'s valid credential (review blocker #3 — per-sweep cache keys must include credentialId)', async () => {
    const credentialRepo = ds.getRepository('Credential');
    const badCred = await credentialRepo.save(credentialRepo.create({
      workspace_id: ws.id, name: 'shared repo bad cred', provider: 'github',
      encrypted_data: encrypt(JSON.stringify({ token: 'shared-bad-token' })),
    }));
    const goodCred = await credentialRepo.save(credentialRepo.create({
      workspace_id: ws.id, name: 'shared repo good cred', provider: 'github',
      encrypted_data: encrypt(JSON.stringify({ token: 'shared-good-token' })),
    }));

    // Created in this order deliberately — the bad-credential board must be
    // the one whose (rejected) promise would land in the cache FIRST under
    // the old owner/repo-only key, so this reproduces the exact poisoning
    // order the reviewer described rather than relying on scan order luck.
    const boardBad = await createBoard(app, getDataSourceToken, ws.id, { name: 'ci-health-board-shared-bad' });
    await createColumn(app, getDataSourceToken, boardBad.id, { name: 'Backlog', position: 0, workspaceId: ws.id });
    const resourceBad = await resourceRepo.save(resourceRepo.create({
      workspace_id: ws.id, name: 'shared repo (bad cred)', type: 'repository',
      url: 'https://github.com/acme/shared', default_branch: 'main', credential_id: badCred.id,
    }));
    await ds.getRepository('Board').update(boardBad.id, {
      environment_config: JSON.stringify({ repositories: [{ resource_id: resourceBad.id }] }),
    });

    const boardGood = await createBoard(app, getDataSourceToken, ws.id, { name: 'ci-health-board-shared-good' });
    await createColumn(app, getDataSourceToken, boardGood.id, { name: 'Backlog', position: 0, workspaceId: ws.id });
    await createColumn(app, getDataSourceToken, boardGood.id, { name: 'To Do', position: 1, workspaceId: ws.id, kind: 'active' });
    const resourceGood = await resourceRepo.save(resourceRepo.create({
      workspace_id: ws.id, name: 'shared repo (good cred)', type: 'repository',
      url: 'https://github.com/acme/shared', default_branch: 'main', credential_id: goodCred.id,
    }));
    await ds.getRepository('Board').update(boardGood.id, {
      environment_config: JSON.stringify({ repositories: [{ resource_id: resourceGood.id }] }),
    });

    const sharedState = {
      workflowId: 999,
      authHeaders: [],
      runs: [
        run('s-run-3', 'failure', minutesAgo(5)),
        run('s-run-2', 'failure', minutesAgo(15)),
        run('s-run-1', 'failure', minutesAgo(25)),
      ],
    };
    globalThis.fetch = makeFakeGitHubFetchSharedRepoByCredential(sharedState);

    const stats = await monitor.sweep(NOW);

    assert.ok(sharedState.authHeaders.includes('Bearer shared-bad-token'), 'the bad-credential board\'s own call must fire');
    assert.ok(
      sharedState.authHeaders.includes('Bearer shared-good-token'),
      'the good-credential board\'s call must fire with ITS OWN credential — a cache keyed only by owner/repo would reuse the bad board\'s cached rejection and this header would never appear',
    );
    assert.ok(stats.fetch_failures >= 1, 'the bad-credential board\'s failure must still be counted');

    const goodDedupeKey = `ci_red:${boardGood.id}:acme/shared:main:999`;
    const goodTicket = await ticketRepo.findOne({ where: { operational_dedupe_key: goodDedupeKey } });
    assert.ok(goodTicket, 'the good-credential board must still get its own alert/ticket despite sharing owner/repo/branch/workflow with a board whose credential 401s');

    const badAlert = await alertRepo.findOne({ where: { repo_full_name: 'acme/shared', board_id: boardBad.id } });
    assert.equal(badAlert, null, 'no alert row for the bad-credential board — its call genuinely failed');
  });

});

test.after?.(() => exitAfterTests(0));
process.on('beforeExit', () => exitAfterTests(0));
