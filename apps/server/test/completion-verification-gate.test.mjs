import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { DataSource } from 'typeorm';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.resolve(here, '..', 'dist');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'awb-completion-verification-'));
process.env.DB_TYPE = 'sqlite';
process.env.SQLJS_DB_PATH = path.join(temp, 'test.db');
process.env.NODE_ENV = 'test';

const { buildDataSourceOptions } = await import('file://' + path.join(dist, 'db.js'));
const { Ticket } = await import('file://' + path.join(dist, 'entities/Ticket.js'));
const { BoardColumn } = await import('file://' + path.join(dist, 'entities/BoardColumn.js'));
const { Board } = await import('file://' + path.join(dist, 'entities/Board.js'));
const { Workspace } = await import('file://' + path.join(dist, 'entities/Workspace.js'));
const { Comment } = await import('file://' + path.join(dist, 'entities/Comment.js'));
const { TicketCompletionVerification } = await import('file://' + path.join(dist, 'entities/TicketCompletionVerification.js'));
const { TicketCompletionVerificationAttempt } = await import('file://' + path.join(dist, 'entities/TicketCompletionVerificationAttempt.js'));
const { registerCompletionVerificationTools } = await import('file://' + path.join(dist, 'modules/mcp/tools/completion-verification-tools.js'));
const { applyTerminalEnteredAtForMove } = await import('file://' + path.join(dist, 'modules/mcp/shared/archive-helpers.js'));
const { CompletionVerificationResumeService } = await import('file://' + path.join(dist, 'modules/agents/completion-verification-resume.service.js'));

const ds = new DataSource(buildDataSourceOptions());
await ds.initialize();
const server = new McpServer({ name: '완료 검증 테스트 서버', version: '1' });
registerCompletionVerificationTools(server, { dataSource: ds });
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
const client = new Client({ name: '완료 검증 테스트 클라이언트', version: '1' });
await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

after(async () => {
  await client.close();
  await server.close();
  await ds.destroy();
  fs.rmSync(temp, { recursive: true, force: true });
});

const fixtureKeys = [
  'production-refresh-1', 'production-refresh-2', 'stable-key-count-comparison',
  'previous-snapshot-preserved', 'related-ticket-and-chat-report',
];

async function scene() {
  const workspaces = ds.getRepository(Workspace);
  const workspace = await workspaces.save(workspaces.create({ name: `워크스페이스-${crypto.randomUUID()}` }));
  const boards = ds.getRepository(Board);
  const board = await boards.save(boards.create({ name: `보드-${crypto.randomUUID()}`, workspace_id: workspace.id }));
  const columns = ds.getRepository(BoardColumn);
  const active = await columns.save(columns.create({ name: `검증-${crypto.randomUUID()}`, workspace_id: workspace.id, board_id: board.id, kind: 'active', position: 0 }));
  const terminal = await columns.save(columns.create({ name: `완료-${crypto.randomUUID()}`, workspace_id: workspace.id, board_id: board.id, kind: 'terminal', is_terminal: true, position: 1 }));
  const tickets = ds.getRepository(Ticket);
  const ticket = await tickets.save(tickets.create({ title: 'Source 회귀', workspace_id: workspace.id, column_id: active.id, status: 'todo' }));
  return { ticket, active, terminal };
}

async function call(name, args) {
  const result = await client.callTool({ name, arguments: args });
  return { result, body: JSON.parse(result.content[0].text) };
}

test('Source 5개 fixture를 실제 MCP wire로 등록하고 판정한다', async () => {
  const { ticket } = await scene();
  for (const key of fixtureKeys) {
    const registered = await call('register_completion_verification', { ticket_id: ticket.id, dedupe_key: key, description: key });
    assert.equal(registered.result.isError, undefined);
    await call('record_completion_verification', {
      ticket_id: ticket.id, dedupe_key: key, attempt_key: `${key}-1`, status: 'passed', evidence: { summary: `${key} 확인` },
    });
  }
  const rows = await ds.getRepository(TicketCompletionVerification).find({ where: { ticket_id: ticket.id } });
  assert.equal(rows.length, 5);
  assert.ok(rows.every(row => row.status === 'passed' && row.completed_at && row.next_dispatch_at === null));
  assert.equal(await ds.getRepository(Comment).count({ where: { ticket_id: ticket.id } }), 5);
});

test('pending/failed는 terminal을 차단하고 passed는 통과한다', async () => {
  const { ticket, active, terminal } = await scene();
  await call('register_completion_verification', { ticket_id: ticket.id, dedupe_key: 'gate', description: '게이트' });
  await assert.rejects(() => ds.transaction(m => applyTerminalEnteredAtForMove(m.getRepository(Ticket), ticket.id, active, terminal)), /durable 검증/);
  await call('record_completion_verification', { ticket_id: ticket.id, dedupe_key: 'gate', attempt_key: '실패-1', status: 'failed', evidence: { summary: '실패' } });
  await assert.rejects(() => ds.transaction(m => applyTerminalEnteredAtForMove(m.getRepository(Ticket), ticket.id, active, terminal)), /durable 검증/);
  await call('record_completion_verification', { ticket_id: ticket.id, dedupe_key: 'gate', attempt_key: '통과-1', status: 'passed', evidence: { summary: '통과' } });
  await ds.transaction(m => applyTerminalEnteredAtForMove(m.getRepository(Ticket), ticket.id, active, terminal));
});

test('동일 attempt는 증거를 중복 기록하지 않고 상이 attempt는 반영한다', async () => {
  const { ticket } = await scene();
  await call('register_completion_verification', { ticket_id: ticket.id, dedupe_key: 'retry', description: '재시도' });
  const args = { ticket_id: ticket.id, dedupe_key: 'retry', attempt_key: '같은키', status: 'failed', evidence: { summary: '실패' } };
  await call('record_completion_verification', args);
  await call('record_completion_verification', args);
  await call('record_completion_verification', { ...args, attempt_key: '다른키', status: 'passed', evidence: { summary: '통과' } });
  const row = await ds.getRepository(TicketCompletionVerification).findOneByOrFail({ ticket_id: ticket.id, dedupe_key: 'retry' });
  assert.equal(row.attempt_count, 2);
  assert.equal(await ds.getRepository(TicketCompletionVerificationAttempt).count({ where: { verification_id: row.id } }), 2);
  assert.equal(await ds.getRepository(Comment).count({ where: { ticket_id: ticket.id } }), 2);
});

test('not_before 이전 판정과 terminal 티켓의 늦은 등록을 거절한다', async () => {
  const { ticket, terminal } = await scene();
  const future = new Date(Date.now() + 60_000).toISOString();
  await call('register_completion_verification', { ticket_id: ticket.id, dedupe_key: 'delay', description: '지연', not_before: future });
  const early = await call('record_completion_verification', { ticket_id: ticket.id, dedupe_key: 'delay', attempt_key: 'early', status: 'passed', evidence: { summary: '너무 이름' } });
  assert.equal(early.result.isError, true);
  await ds.getRepository(Ticket).update(ticket.id, { column_id: terminal.id });
  const late = await call('register_completion_verification', { ticket_id: ticket.id, dedupe_key: 'late', description: '늦은 등록' });
  assert.equal(late.result.isError, true);
  assert.match(late.result.content[0].text, /다시 여세요/);
});

test('동시 등록과 terminal 전이는 직렬화되어 terminal+pending 상태가 남지 않는다', async () => {
  const { ticket, active, terminal } = await scene();
  await Promise.allSettled([
    call('register_completion_verification', { ticket_id: ticket.id, dedupe_key: 'race', description: '경쟁' }),
    ds.transaction(async manager => {
      const repo = manager.getRepository(Ticket);
      await repo.update(ticket.id, { column_id: terminal.id });
      await applyTerminalEnteredAtForMove(repo, ticket.id, active, terminal);
    }),
  ]);
  const finalTicket = await ds.getRepository(Ticket).findOneByOrFail({ id: ticket.id });
  const pending = await ds.getRepository(TicketCompletionVerification).count({ where: { ticket_id: ticket.id, status: 'pending' } });
  assert.ok(finalTicket.column_id !== terminal.id || pending === 0, 'terminal 티켓에 pending 조건이 남으면 안 된다');
});

test('due 작업은 DB 임대로 한 번만 재디스패치되고 임대 만료 뒤 재시도된다', async () => {
  const { ticket } = await scene();
  await ds.getRepository(TicketCompletionVerification).createQueryBuilder().update()
    .set({ next_dispatch_at: null }).where('ticket_id != :ticketId', { ticketId: ticket.id }).execute();
  await call('register_completion_verification', { ticket_id: ticket.id, dedupe_key: 'resume', description: '재개' });
  let dispatches = 0;
  const service = new CompletionVerificationResumeService(
    ds,
    { dispatchCurrentColumn: async () => { dispatches += 1; return { emitted: 1 }; } },
    { warn() {}, info() {}, error() {} },
  );
  const now = new Date(Date.now() + 1_000);
  const [a, b] = await Promise.all([service.runOnce(now), service.runOnce(now)]);
  assert.equal(a.claimed.length + b.claimed.length, 1);
  assert.equal(dispatches, 1);
  assert.equal((await service.runOnce(new Date(now.getTime() + 60_000))).claimed.length, 0);
  assert.equal((await service.runOnce(new Date(now.getTime() + 11 * 60_000))).claimed.length, 1);
  assert.equal(dispatches, 2);
});

test('판정과 증거 코멘트는 오류 시 함께 롤백된다', async () => {
  const { ticket } = await scene();
  await call('register_completion_verification', { ticket_id: ticket.id, dedupe_key: 'atomic', description: '원자성' });
  await ds.query("CREATE TRIGGER completion_comment_failure BEFORE INSERT ON comments BEGIN SELECT RAISE(ABORT, '주입 오류'); END");
  const failed = await call('record_completion_verification', {
    ticket_id: ticket.id, dedupe_key: 'atomic', attempt_key: '원자-1', status: 'passed', evidence: { summary: '통과' },
  });
  assert.equal(failed.result.isError, true);
  await ds.query('DROP TRIGGER completion_comment_failure');
  const row = await ds.getRepository(TicketCompletionVerification).findOneByOrFail({ ticket_id: ticket.id, dedupe_key: 'atomic' });
  assert.equal(row.attempt_count, 0);
  assert.equal(await ds.getRepository(TicketCompletionVerificationAttempt).count({ where: { verification_id: row.id } }), 0);
  assert.equal(await ds.getRepository(Comment).count({ where: { ticket_id: ticket.id } }), 0);
});
