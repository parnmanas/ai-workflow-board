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

const { resolveAgentDisplayNamesByIds, resolveAgentDisplayName } = await import(
  'file://' + path.join(DIST, 'utils', 'agent-name.js')
);

const AGENT_UUID = '11111111-1111-4111-8111-111111111111';
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

// P4c-4: scope 는 getRepository 를 가진 DataSource/EntityManager 다 (Agent repo 직접 전달 불가).
const asScope = (repo) => ({ getRepository: () => repo });

test('resolveAgentDisplayNamesByIds filters non-UUID actor ids before the Agent.id IN query', async () => {
  const captured = [];
  const repo = fakeAgentRepo(captured);
  const map = await resolveAgentDisplayNamesByIds(asScope(repo), [
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
  const map = await resolveAgentDisplayNamesByIds(asScope(repo), ['system', '', 'auto-advance']);
  assert.equal(map.size, 0, 'no agents to resolve');
  assert.equal(captured.length, 0, 'short-circuits before hitting the DB when nothing is uuid-shaped');
});

// ── 단일 id 경로 (티켓 dedff9a3) ────────────────────────────────────────────
// 위의 배치 형제만 고쳐졌고(e7c87517 / 커밋 d9f2a177) 같은 파일의 단일 id 버전
// resolveAgentDisplayName() 은 가드 없이 findOne 을 쳤다. Postgres 에서는 그게
// null 이 아니라 **throw** 이고, board_update SSE 매핑이 그 throw 를 먹어
// 프레임을 통째로 유실시켰다(그 회귀는 board-update-sentinel-actor-frame).
//
// fake repo 가 Postgres 처럼 **던지도록** 만든 것이 핵심이다 — 가드를 되돌리면
// 여기서 "null 아님" 이 아니라 예외로 깨지므로 공허하게 통과할 수 없다.
function pgLikeSingleAgentRepo(calls) {
  return {
    async findOne(opts) {
      const id = opts?.where?.id;
      calls.push(id);
      if (!UUID_SHAPE.test(String(id ?? ''))) {
        throw new Error(`invalid input syntax for type uuid: "${id}"`);
      }
      return id === AGENT_UUID ? { id, name: 'Bob', manager_agent_id: null } : null;
    },
    // P4c-4: 단일 조회도 hostNameById 의 find(In) 경로를 탄다 — 같은 pg 엄격함으로 답한다.
    // ApiKey 조회는 where 배열(OR 분기)이라 분기마다 agent_id/host_id 를 꺼낸다.
    async find(opts) {
      const unwrap = (v) => (v && typeof v === 'object' && 'value' in v ? v.value : v);
      const wheres = Array.isArray(opts?.where) ? opts.where : [opts?.where];
      const ids = wheres.flatMap((w) => [unwrap(w?.id), unwrap(w?.agent_id), unwrap(w?.host_id)]
        .flatMap((v) => (Array.isArray(v) ? v : [v]))
        .filter((v) => v !== undefined));
      for (const id of ids) {
        if (!UUID_SHAPE.test(String(id ?? ''))) {
          throw new Error(`invalid input syntax for type uuid: "${id}"`);
        }
      }
      return ids.filter((id) => id === AGENT_UUID).map((id) => ({ id, name: 'Bob' }));
    },
  };
}

test('resolveAgentDisplayName 은 비-uuid actor id 를 쿼리 전에 걸러낸다 (Postgres uuid throw 회피)', async () => {
  const calls = [];
  const repo = pgLikeSingleAgentRepo(calls);

  // 티켓에 실측으로 기록된 세 sentinel. 전부 쿼리 없이 null 이어야 한다.
  for (const sentinel of ['system', 'auto-advance', 'test-user']) {
    assert.equal(
      await resolveAgentDisplayName(asScope(repo), sentinel), null,
      `'${sentinel}' 는 Agent 가 아니므로 null 이어야 한다`,
    );
  }
  // 'manual by …' 류 라벨과 빈 값도 같은 취급.
  assert.equal(await resolveAgentDisplayName(asScope(repo), 'manual by Parn'), null);
  assert.equal(await resolveAgentDisplayName(asScope(repo), ''), null);

  assert.deepEqual(calls, [], 'findOne 이 한 번도 호출되지 않았다 (가드가 쿼리 앞에 선다)');
});

test('resolveAgentDisplayName 의 실제 agent uuid 는 그대로 조회된다 (가드가 공허하지 않다)', async () => {
  const calls = [];
  const lookedUp = [];
  const repo = pgLikeSingleAgentRepo(calls);
  // P4c-4: 단일 조회도 find(In) 경로다 — findOne 호출이 아니라 find 도달로 단언한다.
  const tracking = new Proxy(repo, {
    get(t, prop) {
      if (prop === 'find') {
        return async (opts) => {
          lookedUp.push(opts);
          return t.find(opts);
        };
      }
      const v = t[prop];
      return typeof v === 'function' ? v.bind(t) : v;
    },
  });
  assert.equal(await resolveAgentDisplayName({ getRepository: () => tracking }, AGENT_UUID), 'Bob');
  assert.ok(lookedUp.length > 0, 'uuid 모양 id 는 가드를 통과해 조회된다');
});
