// Guard — activity actor-name enrichment must not pass non-UUID actor ids to
// the `Agent.id IN (...)` lookup (ticket e7c87517). On Postgres Agent.id is a
// real `uuid` column, so a stray 'system' / 'auto-advance' / 'manual by …'
// actor id in the IN list throws `invalid input syntax for type uuid` and takes
// down the ENTIRE activity-feed read (get_ticket_activity / get_recent_activity
// / the Activity tab) — precisely the audit surface this trigger-loss work
// relies on to surface reason-audit rows. resolveAgentDisplayNamesByIds must
// filter to UUID-shaped ids before the query (non-agent ids are documented to
// be simply absent from the returned map). Joins the family of *-uuid-guard
// tests already in this suite.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(__dirname, '..', 'dist');

const { resolveAgentDisplayNamesByIds } = await import(
  'file://' + path.join(DIST, 'utils', 'agent-name.js')
);

const AGENT_UUID = '11111111-1111-4111-8111-111111111111';

function fakeAgentRepo(captured) {
  return {
    async find(opts) {
      // Capture the id IN(...) array TypeORM would send to the DB. In() yields a
      // FindOperator whose `.value` is the array; fall back to the raw value.
      const op = opts?.where?.id;
      const arr = op && typeof op === 'object' && 'value' in op ? op.value : op;
      captured.push(arr);
      const ids = Array.isArray(arr) ? arr : [arr];
      // Only the real agent uuid resolves to a row (others absent, as prod).
      return ids
        .filter((id) => id === AGENT_UUID)
        .map((id) => ({ id, name: 'Bob', manager_agent_id: null }));
    },
  };
}

test('resolveAgentDisplayNamesByIds filters non-UUID actor ids before the Agent.id IN query', async () => {
  const captured = [];
  const repo = fakeAgentRepo(captured);
  const map = await resolveAgentDisplayNamesByIds(repo, [
    'system', 'auto-advance', 'manual by Parn', '', null, undefined, AGENT_UUID,
  ]);

  assert.ok(captured.length >= 1, 'the agent lookup ran');
  const idArr = captured[0];
  assert.ok(Array.isArray(idArr), 'ids passed as an array to In()');
  assert.ok(!idArr.includes('system'), "'system' must NOT reach the uuid column (Postgres would throw)");
  assert.ok(!idArr.includes('auto-advance'), "'auto-advance' must be filtered out");
  assert.ok(!idArr.includes('manual by Parn'), 'non-uuid labels filtered out');
  assert.ok(idArr.includes(AGENT_UUID), 'the real agent uuid IS looked up');
  assert.equal(map.get(AGENT_UUID), 'Bob', 'the real agent still resolves to its display name');
  assert.equal(map.has('system'), false, 'non-agent actor id is simply absent from the map (documented contract)');
});

test('all-non-uuid ids → empty map, no DB query at all (no throw)', async () => {
  const captured = [];
  const repo = fakeAgentRepo(captured);
  const map = await resolveAgentDisplayNamesByIds(repo, ['system', '', 'auto-advance']);
  assert.equal(map.size, 0, 'no agents to resolve');
  assert.equal(captured.length, 0, 'short-circuits before hitting the DB when nothing is uuid-shaped');
});
