import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const dist = path.resolve(dir, '..', 'dist');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awb-duplicate-correction-'));
process.env.DB_TYPE = 'sqlite';
process.env.SQLJS_DB_PATH = path.join(tempDir, 'test.db');
process.env.NODE_ENV = 'test';

const { buildDataSourceOptions } = await import('file://' + path.join(dist, 'db.js'));
const entities = await import('file://' + path.join(dist, 'entities', 'index.js'));
const { TicketDuplicateService } = await import('file://' + path.join(dist, 'modules', 'tickets', 'ticket-duplicate.service.js'));
const { DataSource, In } = await import('typeorm');
const ds = new DataSource(buildDataSourceOptions());
await ds.initialize();

after(async () => {
  await ds.destroy();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('확정 오탐 정정은 관계와 stale intent를 원자적으로 교체하고 재실행은 거절한다', async () => {
  const workspace = await ds.getRepository(entities.Workspace).save({ name: 'ws' });
  const board = await ds.getRepository(entities.Board).save({ workspace_id: workspace.id, name: 'board' });
  const column = await ds.getRepository(entities.BoardColumn).save({
    workspace_id: workspace.id, board_id: board.id, name: 'To Do', position: 0,
    kind: 'active', role_routing: '["assignee"]',
  });
  const canonical = await ds.getRepository(entities.Ticket).save({
    workspace_id: workspace.id, column_id: column.id, title: '무관한 완료 티켓',
  });
  const report = await ds.getRepository(entities.Ticket).save({
    workspace_id: workspace.id, column_id: column.id, title: '독립 작업 티켓',
    canonical_ticket_id: canonical.id, assignee_id: 'agent-1',
  });
  const oldIntent = await ds.getRepository(entities.DispatchIntent).save({
    workspace_id: workspace.id, board_id: board.id, ticket_id: report.id,
    role: 'assignee', agent_id: 'agent-1', trigger_source: 'reconcile_seed',
    status: 'in_flight', attempts: 209, dispatch_generation: 209, next_attempt_at: new Date(),
  });

  const service = new TicketDuplicateService(ds);
  const corrected = await service.correctConfirmedLink(report.id, 'assignee', 'operator', 'operator-1');
  assert.equal(corrected.previousCanonicalId, canonical.id);
  assert.equal((await ds.getRepository(entities.Ticket).findOneByOrFail({ id: report.id })).canonical_ticket_id, null);
  assert.equal((await ds.getRepository(entities.Ticket).findOneByOrFail({ id: canonical.id })).title, '무관한 완료 티켓');

  const intents = await ds.getRepository(entities.DispatchIntent).find({
    where: { ticket_id: report.id, role: 'assignee' }, order: { created_at: 'ASC' },
  });
  assert.equal(intents.length, 2);
  assert.equal(intents.find(row => row.id === oldIntent.id)?.status, 'resolved');
  const open = intents.filter(row => ['pending', 'in_flight'].includes(row.status));
  assert.equal(open.length, 1);
  assert.equal(open[0].id, corrected.intentId);
  assert.equal(open[0].attempts, 0);
  assert.equal(open[0].trigger_source, 'duplicate_correction');

  const decision = await ds.getRepository(entities.TicketDuplicateDecision).findOneByOrFail({
    report_ticket_id: report.id, outcome: 'corrected_independent',
  });
  assert.equal(decision.candidate_ticket_id, canonical.id);
  const audit = await ds.getRepository(entities.ActivityLog).findOneByOrFail({
    ticket_id: report.id, action: 'duplicate_link_corrected',
  });
  assert.equal(audit.old_value, canonical.id);
  assert.equal(audit.new_value, '');

  await assert.rejects(
    () => service.correctConfirmedLink(report.id, 'assignee', 'operator', 'operator-1'),
    /no confirmed canonical link/,
  );
  const stillOpen = await ds.getRepository(entities.DispatchIntent).count({
    where: { ticket_id: report.id, role: 'assignee', status: In(['pending', 'in_flight']) },
  });
  assert.equal(stillOpen, 1, '중복 정정 호출이 두 번째 open intent를 만들지 않는다');
});
