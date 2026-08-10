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

function run(id, conclusion, isoTime) {
  return { id, status: 'completed', conclusion, html_url: `https://github.com/acme/widgets/actions/runs/${id}`, created_at: isoTime, updated_at: isoTime };
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

});

test.after?.(() => exitAfterTests(0));
process.on('beforeExit', () => exitAfterTests(0));
