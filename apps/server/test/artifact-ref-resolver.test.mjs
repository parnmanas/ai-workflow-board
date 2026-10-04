import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { ArtifactRefsService } from '../dist/modules/artifact-refs/artifact-refs.service.js';

const ws = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ids = {
  ticket: '11111111-1111-4111-8111-111111111111',
  agent: '22222222-2222-4222-8222-222222222222',
  action: '44444444-4444-4444-8444-444444444444',
  function: '55555555-5555-4555-8555-555555555555',
  schedule: '66666666-6666-4666-8666-666666666666',
};

const repo = (rows) => ({
  findOne: async ({ where }) => rows.find(row => row.id === where.id) || null,
});

function service(access = true) {
  const hosts = repo([{ id: ids.agent, workspace_id: ws, name: 'Same name' }]);
  return new ArtifactRefsService(
    repo([{ id: ids.ticket, workspace_id: ws, status: 'todo', title: 'Same name' }]),
    { getRepository: () => hosts },
    repo([{ id: ids.action, workspace_id: ws, name: 'Same name' }]),
    repo([{ id: ids.function, workspace_id: ws, name: 'Same name' }]),
    repo([{ id: ids.schedule, workspace_id: ws, name: 'Same name' }]),
    repo([{ id: ws, name: 'Primary workspace' }]),
    { check: async () => access },
  );
}

test('resolves exact ids and keeps retired Agent detail links unavailable', async () => {
  const refs = Object.entries(ids).map(([type, id]) => ({ type, id }));
  const rows = await service().resolveMany({ id: 'user', role: 'user' }, ws, refs);
  assert.equal(rows.length, 5);
  assert.ok(rows.every(row => row.label === 'Same name'));
  assert.ok(rows.filter(row => row.type !== 'agent').every(row => row.available));
  const host = rows.find(row => row.type === 'agent');
  assert.equal(host.available, false);
  assert.equal(host.reason, 'no_detail_surface');
  assert.equal(host.deepLink, null);
  assert.equal(new Set(rows.map(row => row.id)).size, 5);
  // Tickets open in the workspace ticket pool (no board in the path any more).
  assert.equal(rows.find(row => row.type === 'ticket').deepLink, `/ws/${ws}/tickets?ticket=${ids.ticket}`);
  assert.equal(rows.find(row => row.type === 'action').deepLink, `/ws/${ws}/actions?artifact=${ids.action}`);
  assert.equal(rows.find(row => row.type === 'function').deepLink, `/ws/${ws}/functions?artifact=${ids.function}`);
  assert.equal(rows.find(row => row.type === 'schedule').deepLink, `/ws/${ws}/schedules?artifact=${ids.schedule}`);
  assert.ok(rows.every(row => row.workspaceName === 'Primary workspace'));
  assert.ok(rows.every(row => !('boardName' in row)), 'no board context is reported any more');
});

test('a board ref is not a supported type and resolves to malformed, never a link', async () => {
  const [row] = await service().resolveMany(
    { id: 'user', role: 'user' }, ws, [{ type: 'board', id: '33333333-3333-4333-8333-333333333333' }],
  );
  assert.equal(row.available, false);
  assert.equal(row.reason, 'malformed_id');
  assert.equal(row.deepLink, null);
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

test('no-detail fallback preserves canonical label and workspace context', async () => {
  // Every ticket now has a detail surface (the ticket pool), so the no-detail
  // fallback is the Runtime Host identity behind an `agent` ref.
  const [row] = await service().resolveMany(
    { id: 'user', role: 'user' }, ws, [{ type: 'agent', id: ids.agent }],
  );
  assert.equal(row.available, false);
  assert.equal(row.reason, 'no_detail_surface');
  assert.equal(row.label, 'Same name');
  assert.equal(row.workspaceName, 'Primary workspace');
  assert.equal(row.deepLink, null);
});

test('outside-workspace targets never expose canonical labels, context, or links', async () => {
  const foreignWorkspace = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const instance = service();
  for (const repository of [
    instance.tickets,
    instance.dataSource.getRepository(),
    instance.actions,
    instance.functions,
    instance.schedules,
  ]) {
    const originalFindOne = repository.findOne;
    repository.findOne = async (query) => {
      const entity = await originalFindOne(query);
      return entity ? { ...entity, workspace_id: foreignWorkspace } : null;
    };
  }

  const refs = Object.entries(ids).map(([type, id]) => ({ type, id }));
  const rows = await instance.resolveMany({ id: 'user', role: 'user' }, ws, refs);

  assert.equal(rows.length, refs.length);
  for (const row of rows) {
    assert.equal(row.available, false);
    assert.equal(row.reason, 'outside_workspace');
    assert.equal(row.label, row.type);
    assert.equal(row.workspaceName, undefined);
    assert.equal(row.deepLink, null);
  }
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
