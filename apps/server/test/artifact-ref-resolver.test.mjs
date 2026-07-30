import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { ArtifactRefsService } from '../dist/modules/artifact-refs/artifact-refs.service.js';

const ws = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ids = {
  ticket: '11111111-1111-4111-8111-111111111111',
  agent: '22222222-2222-4222-8222-222222222222',
  board: '33333333-3333-4333-8333-333333333333',
  action: '44444444-4444-4444-8444-444444444444',
  function: '55555555-5555-4555-8555-555555555555',
  schedule: '66666666-6666-4666-8666-666666666666',
};

const repo = (rows) => ({
  findOne: async ({ where }) => rows.find(row => row.id === where.id) || null,
});

function service(access = true) {
  return new ArtifactRefsService(
    repo([{ id: ids.ticket, workspace_id: ws, column_id: 'column', title: 'Same name' }]),
    repo([{ id: ids.agent, workspace_id: ws, name: 'Same name' }]),
    repo([{ id: ids.board, workspace_id: ws, name: 'Same name' }]),
    repo([{ id: 'column', board_id: ids.board }]),
    repo([{ id: ids.action, workspace_id: ws, name: 'Same name' }]),
    repo([{ id: ids.function, workspace_id: ws, name: 'Same name' }]),
    repo([{ id: ids.schedule, workspace_id: ws, name: 'Same name' }]),
    repo([{ id: ws, name: 'Primary workspace' }]),
    { check: async () => access },
  );
}

test('resolves all six types by exact id with canonical links despite duplicate names', async () => {
  const refs = Object.entries(ids).map(([type, id]) => ({ type, id }));
  const rows = await service().resolveMany({ id: 'user', role: 'user' }, ws, refs);
  assert.equal(rows.length, 6);
  assert.ok(rows.every(row => row.available && row.label === 'Same name'));
  assert.equal(new Set(rows.map(row => row.id)).size, 6);
  assert.equal(rows.find(row => row.type === 'ticket').deepLink, `/ws/${ws}/boards/${ids.board}?ticket=${ids.ticket}`);
  assert.equal(rows.find(row => row.type === 'action').deepLink, `/ws/${ws}/actions?artifact=${ids.action}`);
  assert.equal(rows.find(row => row.type === 'function').deepLink, `/ws/${ws}/functions?artifact=${ids.function}`);
  assert.equal(rows.find(row => row.type === 'schedule').deepLink, `/ws/${ws}/schedules?artifact=${ids.schedule}`);
  assert.ok(rows.every(row => row.workspaceName === 'Primary workspace'));
  assert.equal(rows.find(row => row.type === 'ticket').boardName, 'Same name');
});

test('permission denial and missing ids never return links', async () => {
  const denied = await service(false).resolveMany(
    { id: 'user', role: 'user' }, ws, [{ type: 'ticket', id: ids.ticket }],
  );
  assert.equal(denied[0].available, false);
  assert.equal(denied[0].reason, 'workspace_access_denied');
  assert.equal(denied[0].deepLink, null);

  const missingId = '77777777-7777-4777-8777-777777777777';
  const missing = await service().resolveMany(
    { id: 'user', role: 'user' }, ws, [{ type: 'ticket', id: missingId }],
  );
  assert.equal(missing[0].reason, 'not_found');
  assert.equal(missing[0].deepLink, null);
});

test('no-detail fallback preserves canonical label and workspace/board context', async () => {
  const instance = service();
  instance.columns = repo([{ id: 'column', board_id: '' }]);
  const [row] = await instance.resolveMany(
    { id: 'user', role: 'user' }, ws, [{ type: 'ticket', id: ids.ticket }],
  );
  assert.equal(row.available, false);
  assert.equal(row.reason, 'no_detail_surface');
  assert.equal(row.label, 'Same name');
  assert.equal(row.workspaceName, 'Primary workspace');
  assert.equal(row.boardName, undefined);
});

test('storage normalization replaces forged labels and disables missing targets', async () => {
  const missingId = '77777777-7777-4777-8777-777777777777';
  const output = await service().normalizeStoredOutput(
    ws,
    `#[action:${ids.action}|Forged] #[ticket:${missingId}|Ghost]`,
  );
  assert.match(output, new RegExp(`#\\[action:${ids.action}\\|Same name\\]`));
  assert.doesNotMatch(output, /Forged|#\[ticket:/);
  assert.match(output, new RegExp(missingId));
  assert.match(output, /연결 불가/);
});
