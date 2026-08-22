// Behavioral test for ActionRunReaperService.runOnce() — drives the reaper
// against an in-memory fake ActionRun repository (no DB) plus fake
// ActionsService / TriggerLoopService collaborators, with a fixed `now`.
//
// The reaper's OWN job is narrow: select stale 'running' rows (age gate off
// created_at, ActionRun has no started_at) and delegate the actual completion
// to ActionsService.completeRun() — reusing its idempotent guarded transition,
// bounded retry, and audit-comment logic rather than duplicating any of it.
// completeRun's own retry/high-impact/idempotency behavior is ActionsService's
// responsibility and is exercised by its own tests; this file fakes that
// collaborator and asserts only how the reaper WIRES to it:
//
//   - age < TTL                                    -> spared, completeRun not called
//   - terminal status (never 'running')             -> never selected
//   - age >= TTL, has source ticket, retries exhausted (shouldResume=true)
//                                                    -> reaped AND source ticket resumed
//   - age >= TTL, has source ticket, mid-retry (shouldResume=false)
//                                                    -> reaped, ticket NOT resumed (retry run owns it)
//   - source ticket 없음, completion_contract_injected=false (pre-fix
//     orphan — 티켓 b273d603이 standalone 완료 계약을 추가하기 전에
//     디스패치돼, 대상 에이전트가 애초에 complete_action_run을 호출할
//     방법이 없었음) -> 나이와 무관하게 영구 보존(티켓 2fa5312b: 스윕
//     범위가 의도적으로 계속 제외하는 유일한 케이스 — 정상일 수도 있는
//     run을 거짓 'failed'로 만들지 않기 위함)
//   - source ticket 없음, completion_contract_injected=true (post-fix
//     standalone dispatch — 대상 에이전트가 완료 계약을 실제로 받음) ->
//     다른 좀비와 동일하게 TTL 초과 시 reap되지만, shouldResume은 계속
//     false(resume할 source ticket이 없음)(티켓 2fa5312b)
//   - age >= TTL, but completeRun reports previouslyCompleted (a real
//     complete_action_run raced the sweep)           -> NOT counted as reaped, no resume
//   - a second sweep after a reap is idempotent (row already terminal)
//   - a batch full of contract-less running rows never starves out a real,
//     newer zombie ordered after them (ticket 23dfc38a — the exclusion must
//     live in the candidate QUERY, before take(), not a JS-loop skip after)
//
// Imports the compiled service from dist/ (built by `npm run build` in the
// test script), matching the qa-run-reaper-behavior.test.mjs precedent.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ActionRunReaperService } from '../dist/modules/actions/action-run-reaper.service.js';

const HOUR = 60 * 60_000;
const MIN = 60_000;
const NOW = new Date('2026-08-18T12:00:00Z');

// 페이크 TypeORM 쿼리 빌더 — runOnce()가 호출하는 where/orderBy/take
// 체인만 정확히 커버한다. getMany()는 status + source_ticket_id-OR-
// completion_contract_injected 필터링을 take() 이전에 적용해 실제 SQL
// 동작(WHERE가 LIMIT보다 먼저 실행됨)을 그대로 흉내낸다 — 아래
// batch-starvation 회귀 테스트가 바로 이 성질에 의존한다.
//
// 실제 쿼리는 where(status).andWhere(OR ...) 대신 status와 OR 그룹을
// 하나의 where() 호출로 합친다(action-run-reaper.service.ts) — TypeORM은
// `isolateWhereStatements`가 켜져 있지 않으면 andWhere() 절을 괄호로
// 감싸주지 않으므로(이 프로젝트는 꺼져 있음), 분리해서 호출하면
// `status = ? AND A OR B`가 나가고 SQL은 이를 `(status = ? AND A) OR B`로
// 해석해 terminal row까지 조용히 들여보낸다. 이 페이크의 where()는 그
// 단일-호출 형태를 그대로 흉내내고, andWhere()는 실수로 호출돼도 테스트가
// 죽지 않도록 그냥 통과시키는 용도로만 남겨뒀다.
function makeRunRepo(rows) {
  return {
    rows,
    createQueryBuilder() {
      let status = null;
      let requireCompletableGate = false;
      let takeN = rows.length;
      const qb = {
        where(expr, params) {
          if (params && 'status' in params) status = params.status;
          if (typeof expr === 'string' && expr.includes('source_ticket_id') && expr.includes('completion_contract_injected')) {
            requireCompletableGate = true;
          }
          return qb;
        },
        andWhere() { return qb; },
        orderBy() { return qb; },
        take(n) { takeN = n; return qb; },
        async getMany() {
          let out = rows.filter((r) => r.status === status);
          if (requireCompletableGate) {
            out = out.filter((r) =>
              (r.source_ticket_id != null && r.source_ticket_id !== '') || r.completion_contract_injected === true,
            );
          }
          out = out.slice().sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
          return out.slice(0, takeN);
        },
      };
      return qb;
    },
  };
}

// Fake ActionsService.completeRun — mutates the row (mirroring the real
// guarded status='running' -> terminal transition) and returns exactly the
// fields the reaper reads, driven by per-row test fixtures rather than
// re-implementing the real retry/high-impact decision tree.
function makeActionsService(rows) {
  const calls = [];
  return {
    calls,
    async completeRun(runId, workspaceId, args) {
      calls.push({ runId, workspaceId, args });
      const row = rows.find((r) => r.id === runId);
      if (!row) throw new Error(`no such run ${runId}`);
      if (row.status !== 'running') {
        return {
          run: row, sourceTicketId: row.source_ticket_id || '', status: row.status,
          previouslyCompleted: true, retried: false, retryRunId: '', exhausted: false, shouldResume: false,
        };
      }
      row.status = args.status;
      row.result_summary = args.summary;
      row.completed_at = NOW;
      const sourceTicketId = row.source_ticket_id || '';
      const shouldResume = sourceTicketId ? !!row._shouldResume : false;
      return {
        run: row, sourceTicketId, status: args.status,
        previouslyCompleted: false, retried: !shouldResume && !!sourceTicketId, retryRunId: '',
        exhausted: shouldResume, shouldResume,
      };
    },
  };
}

function makeTriggerLoopService() {
  const calls = [];
  return {
    calls,
    async dispatchCurrentColumn(ticketId, triggerSource, triggeredBy) {
      calls.push({ ticketId, triggerSource, triggeredBy });
      return { emitted: 1 };
    },
  };
}

const noopLog = { info() {}, warn() {}, error() {} };

// NOW로부터 ageMs만큼 과거. completionContractInjected는 ActionRun
// 엔티티의 스키마 기본값(ActionRun.ts)과 동일하게 false가 기본이다 —
// post-b273d603 standalone dispatch를 나타내려면 픽스처가 명시적으로
// opt-in해야 한다.
function makeRun(id, {
  ageMs, status = 'running', sourceTicketId = '', shouldResume = false, workspaceId = 'ws1',
  completionContractInjected = false,
} = {}) {
  return {
    id,
    status,
    workspace_id: workspaceId,
    source_ticket_id: sourceTicketId,
    completion_contract_injected: completionContractInjected,
    created_at: new Date(NOW.getTime() - ageMs),
    completed_at: null,
    result_summary: '',
    _shouldResume: shouldResume,
  };
}

test('zombie round-trip: a stuck ticket-driven run past the TTL is reaped and its source ticket is resumed', async () => {
  const rows = [
    makeRun('zombie-1', { ageMs: 3 * HOUR, sourceTicketId: 'tkt-1', shouldResume: true }), // 2h default TTL exceeded, retries exhausted
  ];
  const runRepo = makeRunRepo(rows);
  const actionsService = makeActionsService(rows);
  const triggerLoop = makeTriggerLoopService();
  const svc = new ActionRunReaperService(runRepo, actionsService, triggerLoop, noopLog);

  const { reaped, details } = await svc.runOnce(NOW);

  assert.deepEqual(reaped, ['zombie-1'], 'the stuck run escapes running via the reaper sweep');
  assert.equal(details[0].id, 'zombie-1');
  assert.ok(details[0].age_min >= 179, 'age_min reflects the ~3h staleness');
  assert.equal(rows[0].status, 'failed', 'completeRun closed the run as failed (not a direct status mutation)');
  assert.equal(actionsService.calls.length, 1);
  assert.equal(actionsService.calls[0].args.status, 'failed');
  assert.match(actionsService.calls[0].args.summary, /auto-reaped by ActionRunReaperService/);
  assert.deepEqual(
    triggerLoop.calls,
    [{ ticketId: 'tkt-1', triggerSource: 'action_run_reaped', triggeredBy: '' }],
    'source ticket is resumed via dispatchCurrentColumn exactly once',
  );
});

test('fresh run under the TTL is spared — completeRun is never called', async () => {
  const rows = [makeRun('fresh', { ageMs: 10 * MIN, sourceTicketId: 'tkt-2', shouldResume: true })];
  const runRepo = makeRunRepo(rows);
  const actionsService = makeActionsService(rows);
  const triggerLoop = makeTriggerLoopService();
  const svc = new ActionRunReaperService(runRepo, actionsService, triggerLoop, noopLog);

  const { reaped } = await svc.runOnce(NOW);

  assert.deepEqual(reaped, []);
  assert.equal(actionsService.calls.length, 0, 'completeRun must not be called for a run within the TTL window');
  assert.equal(triggerLoop.calls.length, 0);
  assert.equal(rows[0].status, 'running', 'untouched');
});

test('terminal runs are never selected regardless of age', async () => {
  const rows = [
    makeRun('done-ok', { ageMs: 8 * HOUR, status: 'succeeded' }),
    makeRun('done-fail', { ageMs: 8 * HOUR, status: 'failed' }),
  ];
  const runRepo = makeRunRepo(rows);
  const actionsService = makeActionsService(rows);
  const triggerLoop = makeTriggerLoopService();
  const svc = new ActionRunReaperService(runRepo, actionsService, triggerLoop, noopLog);

  const { reaped } = await svc.runOnce(NOW);
  assert.deepEqual(reaped, []);
  assert.equal(actionsService.calls.length, 0, 'find() only ever asks for status=running, so terminal rows are never fetched');
});

test('precedence regression: a terminal run with completion_contract_injected=true is still never selected (status gate must AND with the OR-group, not be split apart by it)', async () => {
  // 이 OR-확장을 구현하던 중 실제로 겪은 near-miss를 잠근다(티켓
  // 2fa5312b): TypeORM은 `isolateWhereStatements`가 켜져 있지 않으면
  // where()/andWhere() 절을 괄호로 감싸주지 않는다(이 프로젝트는 꺼져
  // 있음 — db.ts 참고). 그래서 `.where(status).andWhere("A OR B")`는
  // `status = ? AND A OR B`를 내보내고, SQL의 AND-먼저-OR-나중 우선순위
  // 규칙상 이는 `(status = ? AND A) OR B`로 해석되어
  // B(completion_contract_injected)가 참이기만 하면 'running'이 아닌
  // row까지 조용히 들여보낸다. 실제 쿼리는 이를 피하려고 모든 조건을
  // 하나의 where() 호출에 OR 그룹 바깥 괄호로 명시해 합친다.
  // completion_contract_injected=true인 succeeded run이 분리된 형태로의
  // 회귀를 잡아내는 가장 예리한 픽스처다.
  const rows = [
    makeRun('done-but-contracted', { ageMs: 8 * HOUR, status: 'succeeded', sourceTicketId: '', completionContractInjected: true }),
  ];
  const runRepo = makeRunRepo(rows);
  const actionsService = makeActionsService(rows);
  const triggerLoop = makeTriggerLoopService();
  const svc = new ActionRunReaperService(runRepo, actionsService, triggerLoop, noopLog);

  const { reaped } = await svc.runOnce(NOW);

  assert.deepEqual(reaped, [], 'a succeeded run must never be reaped, even with completion_contract_injected=true');
  assert.equal(actionsService.calls.length, 0, 'the status=running gate must AND with the OR-group, not be split apart by operator precedence');
});

test('stuck run mid-retry (shouldResume=false) is reaped but its ticket is NOT resumed — the retry run owns it', async () => {
  const rows = [makeRun('mid-retry', { ageMs: 3 * HOUR, sourceTicketId: 'tkt-3', shouldResume: false })];
  const runRepo = makeRunRepo(rows);
  const actionsService = makeActionsService(rows);
  const triggerLoop = makeTriggerLoopService();
  const svc = new ActionRunReaperService(runRepo, actionsService, triggerLoop, noopLog);

  const { reaped } = await svc.runOnce(NOW);

  assert.deepEqual(reaped, ['mid-retry'], 'this row is closed (completeRun already dispatched the retry run internally)');
  assert.equal(rows[0].status, 'failed');
  assert.equal(triggerLoop.calls.length, 0, 'no resume dispatch — completeRun said shouldResume=false');
});

test('pre-fix orphan (no source ticket, no completion contract) is preserved forever, even past the TTL', async () => {
  // 티켓 b273d603 이전에 디스패치된 run을 나타낸다 — 그땐
  // completion_contract_injected 컬럼 자체가 없었으므로 스키마 기본값인
  // false로 읽힌다. 이 run의 대상 에이전트는 run_id도, complete_action_run을
  // 호출하라는 안내도 받은 적이 없다 — reap하면 정상일 수도 있는 run을
  // 거짓 'failed'로 만들어버린다.
  const rows = [makeRun('cron-stuck', { ageMs: 3 * HOUR, sourceTicketId: '', completionContractInjected: false })];
  const runRepo = makeRunRepo(rows);
  const actionsService = makeActionsService(rows);
  const triggerLoop = makeTriggerLoopService();
  const svc = new ActionRunReaperService(runRepo, actionsService, triggerLoop, noopLog);

  const { reaped } = await svc.runOnce(NOW);

  assert.deepEqual(reaped, [], 'no source ticket and no completion contract -> never a reap candidate, regardless of age');
  assert.equal(actionsService.calls.length, 0, 'completeRun must never be called for a run that can never complete on its own');
  assert.equal(triggerLoop.calls.length, 0, 'no source ticket to resume');
  assert.equal(rows[0].status, 'running', 'untouched');
});

test('post-fix standalone run (no source ticket, but completion contract was injected) IS reaped past the TTL — nothing to resume', async () => {
  // 티켓 b273d603 이후에 디스패치된 run을 나타낸다 — 프롬프트에 standalone
  // 완료 계약이 실렸으므로 dispatch()가 completion_contract_injected=true를
  // 세팅했고, 대상 에이전트는 실제로 complete_action_run을 호출할 방법이
  // 있었는데도 그냥 안 한 것(죽었거나, TTL을 넘겨서도 정말 실행 중이거나).
  // 티켓 2fa5312b는 정확히 이 케이스를 스윕에 포함하도록 넓힌다.
  const rows = [makeRun('standalone-stuck', { ageMs: 3 * HOUR, sourceTicketId: '', completionContractInjected: true })];
  const runRepo = makeRunRepo(rows);
  const actionsService = makeActionsService(rows);
  const triggerLoop = makeTriggerLoopService();
  const svc = new ActionRunReaperService(runRepo, actionsService, triggerLoop, noopLog);

  const { reaped, details } = await svc.runOnce(NOW);

  assert.deepEqual(reaped, ['standalone-stuck'], 'a source_ticket_id-less run that received a completion contract is now reapable');
  assert.equal(details[0].id, 'standalone-stuck');
  assert.equal(rows[0].status, 'failed', 'completeRun closed the run as failed');
  assert.equal(actionsService.calls.length, 1);
  assert.equal(actionsService.calls[0].args.status, 'failed');
  assert.equal(triggerLoop.calls.length, 0, 'no source ticket -> nothing to resume, even though the run was reaped');
});

test('fresh post-fix standalone run under the TTL is spared', async () => {
  const rows = [makeRun('standalone-fresh', { ageMs: 10 * MIN, sourceTicketId: '', completionContractInjected: true })];
  const runRepo = makeRunRepo(rows);
  const actionsService = makeActionsService(rows);
  const triggerLoop = makeTriggerLoopService();
  const svc = new ActionRunReaperService(runRepo, actionsService, triggerLoop, noopLog);

  const { reaped } = await svc.runOnce(NOW);

  assert.deepEqual(reaped, [], 'under the TTL -> spared regardless of completion_contract_injected');
  assert.equal(actionsService.calls.length, 0);
  assert.equal(rows[0].status, 'running', 'untouched');
});

test('a run completed by a real concurrent complete_action_run between SELECT and reap is not double-counted', async () => {
  const rows = [makeRun('raced', { ageMs: 3 * HOUR, sourceTicketId: 'tkt-4', shouldResume: true })];
  // Simulate the race: by the time completeRun runs, the row is already terminal.
  rows[0].status = 'succeeded';
  const runRepo = {
    // getMany() still returns it (it was 'running' at SELECT time in the real
    // DB race window) — the guard lives in completeRun's previouslyCompleted path.
    createQueryBuilder() {
      const qb = { where: () => qb, andWhere: () => qb, orderBy: () => qb, take: () => qb, getMany: async () => rows };
      return qb;
    },
  };
  const actionsService = makeActionsService(rows);
  const triggerLoop = makeTriggerLoopService();
  const svc = new ActionRunReaperService(runRepo, actionsService, triggerLoop, noopLog);

  const { reaped } = await svc.runOnce(NOW);

  assert.deepEqual(reaped, [], 'previouslyCompleted runs are not counted as reaped by us');
  assert.equal(triggerLoop.calls.length, 0, 'the real completion already owns any resume decision');
});

test('runOnce is idempotent — a second sweep reaps nothing once the row is terminal', async () => {
  const rows = [makeRun('zombie-2', { ageMs: 3 * HOUR, sourceTicketId: 'tkt-5', shouldResume: true })];
  const runRepo = makeRunRepo(rows);
  const actionsService = makeActionsService(rows);
  const triggerLoop = makeTriggerLoopService();
  const svc = new ActionRunReaperService(runRepo, actionsService, triggerLoop, noopLog);

  const first = await svc.runOnce(NOW);
  assert.deepEqual(first.reaped, ['zombie-2']);

  const second = await svc.runOnce(NOW);
  assert.deepEqual(second.reaped, [], 'row is now status=failed, so the running-only candidate query no longer selects it');
  assert.equal(triggerLoop.calls.length, 1, 'no duplicate resume on the second, no-op sweep');
});

test('batch starvation regression: 200 contract-less running rows ahead of a real zombie in created_at order do not starve it out of the sweep', async () => {
  // Mirrors the private ACTION_RUN_REAPER_BATCH=200 in
  // action-run-reaper.service.ts. Before ticket 23dfc38a, the contract-less
  // gate was a skip INSIDE the loop, after take(200) had already run — so
  // once contract-less (cron/manual/on-ticket-done) running rows outnumbered
  // the batch size, the oldest-first candidate batch filled entirely with
  // rows that are always skipped, and a real, newer ticket-driven zombie was
  // never even fetched. The fix excludes them in the candidate query itself,
  // before take() spends its budget — this test proves that ordering holds
  // by placing 200 contract-less rows, all older than the one real zombie,
  // ahead of it in created_at ASC order.
  const BATCH = 200;
  const rows = [];
  for (let i = 0; i < BATCH; i++) {
    rows.push(makeRun(`cron-${i}`, { ageMs: (10 + i) * HOUR, sourceTicketId: '' }));
  }
  rows.push(makeRun('real-zombie', { ageMs: 3 * HOUR, sourceTicketId: 'tkt-starved', shouldResume: true }));

  const runRepo = makeRunRepo(rows);
  const actionsService = makeActionsService(rows);
  const triggerLoop = makeTriggerLoopService();
  const svc = new ActionRunReaperService(runRepo, actionsService, triggerLoop, noopLog);

  const { reaped } = await svc.runOnce(NOW);

  assert.deepEqual(
    reaped,
    ['real-zombie'],
    'the real zombie must still be reaped even though 200 older contract-less rows precede it in created_at order',
  );
  assert.deepEqual(
    triggerLoop.calls,
    [{ ticketId: 'tkt-starved', triggerSource: 'action_run_reaped', triggeredBy: '' }],
    'source ticket is resumed exactly once, unblocked by the contract-less rows ahead of it',
  );
});
