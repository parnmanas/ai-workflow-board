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
const { DataSource } = await import('typeorm');
const ds = new DataSource(buildDataSourceOptions());
await ds.initialize();

after(async () => {
  await ds.destroy();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

// correctConfirmedLink() is the data-correction half of
// correct_confirmed_ticket_duplicate: it clears the false-positive canonical
// link with a compare-and-swap and writes the audit trail (decision row,
// system comment, activity) in the same transaction. Re-waking the assignee is
// the caller's job (TicketDispatchService.resumeTicket) — see
// qa-flows/confirmed-duplicate-correction-wire.test.mjs.
test('확정 오탐 정정은 관계를 원자적으로 해제하고 감사 기록을 남기며 재실행은 거절한다', async () => {
  const workspace = await ds.getRepository(entities.Account).save({ name: 'ws' });
  const canonical = await ds.getRepository(entities.Ticket).save({
    account_id: workspace.id, status: 'done', title: '무관한 완료 티켓',
  });
  const report = await ds.getRepository(entities.Ticket).save({
    account_id: workspace.id, status: 'in_progress', title: '독립 작업 티켓',
    canonical_ticket_id: canonical.id,
  });

  const service = new TicketDuplicateService(ds);
  const corrected = await service.correctConfirmedLink(report.id, 'operator', 'operator-1');
  assert.equal(corrected.previousCanonicalId, canonical.id);
  assert.equal(corrected.ticket.id, report.id);
  assert.equal(corrected.ticket.canonical_ticket_id, null);
  assert.equal((await ds.getRepository(entities.Ticket).findOneByOrFail({ id: report.id })).canonical_ticket_id, null);
  const untouchedCanonical = await ds.getRepository(entities.Ticket).findOneByOrFail({ id: canonical.id });
  assert.equal(untouchedCanonical.title, '무관한 완료 티켓');
  assert.equal(untouchedCanonical.status, 'done', 'canonical 티켓은 절대 수정하지 않는다');

  const decision = await ds.getRepository(entities.TicketDuplicateDecision).findOneByOrFail({
    report_ticket_id: report.id, outcome: 'corrected_independent',
  });
  assert.equal(decision.candidate_ticket_id, canonical.id);
  assert.equal(decision.actor_id, 'operator-1');
  const audit = await ds.getRepository(entities.ActivityLog).findOneByOrFail({
    ticket_id: report.id, action: 'duplicate_link_corrected',
  });
  assert.equal(audit.old_value, canonical.id);
  assert.equal(audit.new_value, '');
  assert.equal(audit.trigger_source, 'duplicate_correction');
  assert.equal(await ds.getRepository(entities.Comment).count({
    where: { ticket_id: report.id, author: 'Duplicate correction' },
  }), 1);

  await assert.rejects(
    () => service.correctConfirmedLink(report.id, 'operator', 'operator-1'),
    /no confirmed canonical link/,
  );
  assert.equal(await ds.getRepository(entities.TicketDuplicateDecision).count({
    where: { report_ticket_id: report.id, outcome: 'corrected_independent' },
  }), 1, '거절된 재실행은 감사 기록을 더 남기지 않는다');
});
