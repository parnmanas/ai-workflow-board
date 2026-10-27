import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { QaScenario } from '../dist/entities/QaScenario.js';
import { QaRun } from '../dist/entities/QaRun.js';
import { QaSchedule } from '../dist/entities/QaSchedule.js';
import { RuntimeHost } from '../dist/entities/RuntimeHost.js';
import { Project } from '../dist/entities/Project.js';
import { Channel } from '../dist/entities/Channel.js';
import { BusinessMailConnection } from '../dist/entities/BusinessMailConnection.js';
import { Credential } from '../dist/entities/Credential.js';
import { QaService } from '../dist/modules/qa/qa.service.js';
import { QaRunService } from '../dist/modules/qa/qa-run.service.js';
import { QaScheduleService } from '../dist/modules/qa/qa-schedule.service.js';
import { QaFailureTicketService } from '../dist/modules/qa/qa-failure-ticket.service.js';
import { QaResultDeliveryService } from '../dist/modules/qa/qa-result-delivery.service.js';
import { ProjectsService } from '../dist/modules/projects/projects.service.js';
import { encrypt } from '../dist/services/encryption.service.js';
import { normalizeResultDelivery } from '../dist/modules/qa/qa-result-policy.js';

process.env.ENCRYPTION_KEY = 'qa-result-delivery-test-key';
const log = { info() {}, warn() {}, error() {} };
let ds, dir, service, projectA, projectB, channelA, channelB, mailA, runtime;
before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'awb-qa-results-'));
  ds = new DataSource({ type: 'sqljs', location: join(dir, 'test.db'), synchronize: true,
    entities: [QaScenario, QaRun, QaSchedule, RuntimeHost, Project, Channel, BusinessMailConnection, Credential] });
  await ds.initialize();
  const host = await ds.getRepository(RuntimeHost).save({ name: 'QA', account_id: 'a' });
  runtime = { manager_agent_id: host.id, cli: 'codex', working_dir: '/tmp/qa', runtime_config: { strategy: 'single', permission_mode: 'approve' } };
  projectA = await ds.getRepository(Project).save({ account_id: 'a', name: 'Project A', default_assignee: { ...runtime, working_dir: '/tmp/project-a' } });
  projectB = await ds.getRepository(Project).save({ account_id: 'b', name: 'Private project' });
  channelA = await ds.getRepository(Channel).save({ account_id: 'a', name: 'Reports', bot_token: 'test', channel_id: 'test' });
  channelB = await ds.getRepository(Channel).save({ account_id: 'b', name: 'Private reports', bot_token: 'test', channel_id: 'test' });
  const credential = await ds.getRepository(Credential).save({ account_id: 'a', name: 'Mail', provider: 'mail', encrypted_data: encrypt('{}') });
  mailA = await ds.getRepository(BusinessMailConnection).save({ account_id: 'a', company_id: null, name: 'Mail', provider: 'smtp_imap', credential_id: credential.id,
    encrypted_data: encrypt(JSON.stringify({ config: { addresses: ['qa@example.test'], smtp: { host: 'mail.example.test', port: 465, tls: 'implicit', username: 'qa' } } })) });
  service = new QaService(ds.getRepository(QaScenario), ds.getRepository(QaRun), ds, ds.getRepository(RuntimeHost), {});
});
after(async () => { await ds?.destroy(); await rm(dir, { recursive: true, force: true }); });
const create = (patch = {}) => service.create({ account_id: 'a', name: `Scenario ${randomUUID()}`, target_runtime: runtime, ...patch });
const email = () => ({ connection_id: mailA.id, from: 'qa@example.test', to: ['owner@example.test'] });

async function runFor(scenario, status = 'failed') {
  return ds.getRepository(QaRun).save({ scenario_id: scenario.id, account_id: 'a', status, summary: 'Failure evidence',
    result_policy_snapshot: { name: scenario.name, project_id: scenario.project_id, on_failure_ticket: scenario.on_failure_ticket, result_delivery: scenario.result_delivery } });
}
function deliveryHarness({ failChannel = false, failEmail = false } = {}) {
  const calls = [];
  const delivery = new QaResultDeliveryService(ds, { async sendDiscordMessage(channel, message) { calls.push(['share', channel.id, message]); return !failChannel; } }, {
    async activeOwner() {}, async send(accounts, id, body) { calls.push(['email', id, body]); return { status: failEmail ? 'uncertain' : 'accepted' }; },
  }, log);
  return { delivery, calls };
}

test('scenario project and result settings round trip; foreign references rejected on create and update', async () => {
  const scenario = await create({ project_id: projectA.id, result_delivery: { when: 'always', channel_ids: [channelA.id], email: email() } });
  assert.equal((await service.get(scenario.id)).project_id, projectA.id);
  assert.equal((await service.list('a', projectA.id)).some(s => s.id === scenario.id), true);
  assert.equal((await service.list('a', projectB.id)).length, 0);
  await assert.rejects(create({ project_id: projectB.id }), /같은 계정/);
  await assert.rejects(service.update(scenario.id, 'a', { project_id: projectB.id }), /같은 계정/);
  await assert.rejects(create({ result_delivery: { channel_ids: [channelB.id] } }), /같은 계정/);
  await assert.rejects(create({ result_delivery: { email: { ...email(), from: 'outsider@example.test' } } }), /발신 주소/);
  await assert.rejects(create({ result_delivery: { email: { ...email(), connection_id: randomUUID() } } }), /같은 계정/);
  await assert.rejects(create({ on_failure_ticket: { enabled: true, project_id: projectB.id } }), /같은 계정/);
  const cleared = await service.update(scenario.id, 'a', { result_delivery: null, project_id: null });
  assert.equal(cleared.project_id, null);
  assert.equal(cleared.result_delivery, null);
});

test('batch filtering intersects explicit selection with project, account and enabled state', async () => {
  const a = await create({ project_id: projectA.id });
  const b = await create();
  const disabled = await create({ project_id: projectA.id, enabled: false });
  const runService = new QaRunService(ds.getRepository(QaScenario));
  assert.deepEqual(await runService._resolveBatchScenarioIds({ accountId: 'a', projectId: projectA.id, scenarioIds: [b.id, a.id, disabled.id, a.id] }), [a.id]);
  const all = await runService._resolveBatchScenarioIds({ accountId: 'a', projectId: projectA.id, all: true });
  assert.ok(all.includes(a.id)); assert.ok(!all.includes(b.id)); assert.ok(!all.includes(disabled.id));
  assert.deepEqual(await runService._resolveBatchScenarioIds({ accountId: 'b', projectId: projectA.id, all: true }), []);
});

test('schedule stores project filter and forwards it for both all and selected execution', async () => {
  const calls = [];
  const schedules = new QaScheduleService(ds.getRepository(QaSchedule), {}, { async startBatch(args) { calls.push(args); return { id: 'batch' }; } }, log, {});
  const schedule = await schedules.create({ accountId: 'a', name: 'Project checks', projectId: projectA.id, intervalMs: 60000 });
  await schedules._dispatchBatch(schedule, 'owner');
  assert.equal(calls[0].projectId, projectA.id); assert.equal(calls[0].all, true);
  await schedules._dispatchBatch({ ...schedule, scope: 'selected', scenario_ids: ['scenario'] }, 'owner');
  assert.equal(calls[1].projectId, projectA.id);
  await assert.rejects(schedules.create({ accountId: 'a', name: 'Foreign', projectId: projectB.id, intervalMs: 60000 }), /같은 계정/);
});

test('failure tickets inherit project and its default assignee; explicit override wins', async () => {
  const calls = [];
  const tickets = new QaFailureTicketService(ds, { async create(accountId, payload) { calls.push(payload); return { ticket: { id: randomUUID() } }; } }, new ProjectsService(ds), log);
  const scenario = await create({ project_id: projectA.id, on_failure_ticket: { enabled: true, dedupe: 'per_run' } });
  const run = await runFor(scenario);
  assert.ok(await tickets.maybeCreateOnFailure(run, scenario));
  assert.equal(calls[0].project_id, projectA.id);
  assert.equal(calls[0].assignee.working_dir, '/tmp/project-a');
  scenario.on_failure_ticket.assignee_runtime = runtime;
  assert.ok(await tickets.maybeCreateOnFailure(await runFor(scenario), scenario));
  assert.equal(calls[1].assignee.working_dir, '/tmp/qa');
  const recordOnly = await create({ project_id: projectA.id });
  assert.equal(await tickets.maybeCreateOnFailure(await runFor(recordOnly), recordOnly), null);
  assert.equal(calls.length, 2);
});

test('share and email are independent from ticket creation and persist outcome; repeat/concurrent completion does not resend', async () => {
  const scenario = await create({ project_id: projectA.id, result_delivery: { when: 'always', channel_ids: [channelA.id], email: email() } });
  const run = await runFor(scenario, 'passed');
  const { delivery, calls } = deliveryHarness();
  await Promise.all([delivery.deliver(run), delivery.deliver({ ...run })]);
  await delivery.deliver(await ds.getRepository(QaRun).findOneByOrFail({ id: run.id }));
  assert.deepEqual(calls.map(c => c[0]), ['share', 'email']);
  assert.equal(calls[1][2].request_id, run.id);
  assert.match(calls[1][2].text, /Project A/);
  const saved = await ds.getRepository(QaRun).findOneByOrFail({ id: run.id });
  assert.equal(saved.delivery_status, 'sent'); assert.equal(saved.auto_ticket_id, null);
});

test('failure-only delivery includes build errors and excludes passed/nonterminal results', async () => {
  const scenario = await create({ result_delivery: { when: 'failure', channel_ids: [channelA.id] } });
  const { delivery, calls } = deliveryHarness();
  for (const status of ['passed', 'running', 'pending']) await delivery.deliver(await runFor(scenario, status));
  assert.equal(calls.length, 0);
  for (const status of ['failed', 'error', 'build_failed']) await delivery.deliver(await runFor(scenario, status));
  assert.equal(calls.length, 3);
});

test('in-flight delivery uses snapshot, rejects channel transferred to another account, and still sends email', async () => {
  const scenario = await create({ result_delivery: { when: 'always', channel_ids: [channelA.id], email: email() } });
  const run = await runFor(scenario);
  await service.update(scenario.id, 'a', { result_delivery: null });
  await ds.getRepository(Channel).update(channelA.id, { account_id: 'b' });
  try {
    const { delivery, calls } = deliveryHarness();
    await delivery.deliver(run);
    assert.deepEqual(calls.map(c => c[0]), ['email']);
    assert.equal(run.delivery_status, 'partial');
    assert.equal(run.delivery_results[0].status, 'failed');
  } finally { await ds.getRepository(Channel).update(channelA.id, { account_id: 'a' }); }
});

test('record-only runs do not deliver; mail uncertainty is recorded without automatic resend', async () => {
  const { delivery, calls } = deliveryHarness({ failEmail: true });
  await delivery.deliver(await runFor(await create()));
  assert.equal(calls.length, 0);
  const scenario = await create({ result_delivery: { email: email() } });
  const run = await runFor(scenario);
  await delivery.deliver(run); await delivery.deliver(run);
  assert.equal(calls.length, 1); assert.equal(run.delivery_status, 'failed');
});

test('delivery configuration rejects invalid modes, email addresses and unbounded recipient lists', () => {
  assert.throws(() => normalizeResultDelivery({ when: 'sometimes' }), /Invalid result_delivery/);
  assert.throws(() => normalizeResultDelivery({ email: { ...email(), to: ['bad'] } }), /Invalid result_delivery/);
  assert.throws(() => normalizeResultDelivery({ email: { ...email(), to: Array(11).fill('a@example.test') } }), /Invalid result_delivery/);
});

test('timeout finalization applies the dispatch snapshot, creates the configured ticket and shares once', async () => {
  const scenario = await create({ project_id: projectA.id, on_failure_ticket: { enabled: true }, result_delivery: { when: 'failure', channel_ids: [channelA.id] } });
  const run = await runFor(scenario);
  await service.update(scenario.id, 'a', { project_id: null, on_failure_ticket: { enabled: false }, result_delivery: null });
  const { delivery, calls } = deliveryHarness();
  let routed;
  const ticketId = randomUUID();
  const runService = new QaRunService(ds.getRepository(QaScenario), ds.getRepository(QaRun), {}, {}, {}, {}, {}, {}, ds, {}, log, {
    async maybeCreateOnFailure(_run, effective) { routed = effective; return ticketId; },
  }, delivery);
  await runService.onRunFinalized(run);
  assert.equal(routed.project_id, projectA.id);
  assert.equal(routed.on_failure_ticket.enabled, true);
  assert.equal(run.auto_ticket_id, ticketId);
  assert.equal(calls.length, 1);
  assert.match(calls[0][2].embeds[0].description, new RegExp(ticketId));
});

test('completion does not overwrite delivery claims or warm a different project after an edit', async () => {
  const scenario = await create({ project_id: projectA.id });
  const run = await runFor(scenario, 'running');
  await ds.getRepository(QaRun).update(run.id, { delivery_status: 'sent', delivery_results: [{ target: 'email', status: 'sent' }] });
  await service.update(scenario.id, 'a', { project_id: null });
  const runService = new QaRunService(ds.getRepository(QaScenario), ds.getRepository(QaRun), {}, {}, {}, {}, {}, {}, ds, {}, log, {
    async maybeCloseSiblingsOnPass() {},
  });
  const completed = await runService.completeRun(run.id, 'a', 'passed', 'Passed', 'abc123');
  assert.equal(completed.delivery_status, 'sent');
  assert.equal((await service.get(scenario.id)).last_built_commit, null);
});

test('late step, artifact, heartbeat and phase writes cannot clear a concurrent delivery claim', async () => {
  const scenario = await create();
  const runService = new QaRunService(null, ds.getRepository(QaRun));
  for (const kind of ['step', 'artifact', 'heartbeat', 'phase']) {
    const run = await runFor(scenario, 'running');
    const stale = await ds.getRepository(QaRun).findOneByOrFail({ id: run.id });
    await ds.getRepository(QaRun).update(run.id, { delivery_status: 'sent' });
    runService.getRun = async () => stale;
    if (kind === 'step') await runService.recordStep({ runId: run.id, accountId: 'a', idx: 0, status: 'passed' });
    if (kind === 'artifact') await runService.attachArtifact(run.id, 'a', ['artifact']);
    if (kind === 'heartbeat') await runService.recordHeartbeat({ runId: run.id, accountId: 'a', progressToken: 1 });
    if (kind === 'phase') await runService.setPhase(run.id, 'a', 'test');
    assert.equal((await ds.getRepository(QaRun).findOneByOrFail({ id: run.id })).delivery_status, 'sent', kind);
  }
});
