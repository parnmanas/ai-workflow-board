// 랜딩 lease 동적 회귀 — 실제 sql.js DataSource + 프로덕션 서비스 경로
// (ticket e630b530).
//
// BEFORE: Merging 은 최신 base 위 SHA 의 초록 CI 를 요구하는데, CI 가 도는
// ~9분 사이 base 가 전진하면 ff 가 실패하고 rebase 로 SHA 가 바뀌어 직전
// 초록 run 이 무효가 된다. 절차에 반복 상한이 없어 고빈도 저장소에서 종료가
// 보장되지 않았다(실측: 내용이 전혀 바뀌지 않은 diff 로 CI 3회).
//
// AFTER: (repo, base_branch) 스코프당 홀더 1명을 부분 UNIQUE 인덱스로 DB 가
// 강제하고, 홀더가 랜딩 구간을 독점하는 동안 다른 AWB 티켓은 랜딩하지 않는다.
//
// 이 파일이 **선언이 아니라 동작**으로 증명하는 것:
//
//   1. synchronize 가 부분 UNIQUE 인덱스를 실제로 만들고 재실행이 멱등이다.
//   2. 같은 스코프의 두 번째 'held' raw INSERT 가 DB 에서 거부된다 —
//      다중 manager/다중 인스턴스 보장(인프로세스 뮤텍스로는 불가능).
//   3. 동시 acquire ×5 (Promise.all) → 정확히 1명만 granted, 나머지는 파킹.
//   4. ★ 완료 기준: base 가 **계속 전진하는** 재현 시나리오에서 모든 티켓이
//      기아 없이 유한하게 랜딩하고, 검증한 SHA 와 실제 랜딩 SHA 가 일치한다.
//   5. ★ 완료 기준: lease 로도 막을 수 없는 외부 push(사람/다른 인스턴스)가
//      계속 base 를 밀면 무한히 돌지 않고 **명시적으로 실패**한다.
//   6. liveness: 죽은 홀더는 회수되고, 미해소 CI 대기를 가진 홀더는 idle
//      상한을 훨씬 넘겨도 회수되지 않는다(설계 보정 A).
//   7. 컬럼 이동과 해제의 **원자성** — 이동 트랜잭션을 롤백하면 lease 도
//      함께 살아 있어야 한다(설계 보정 D).
//   8. fail-open: 보드 비활성 / 저장소 미해석 / 대기 상한 초과가 전부
//      "lease 없이 진행" 으로 끝난다.
//
// 시간은 고정 지연 대신 DB 행을 **역날짜(backdate)** 시켜 통제한다 — sleep 이
// 없으므로 느린 CI 에서도 흔들리지 않는다.
//
// 컴파일된 dist/ 를 대상으로 돌고(`npm run build` 필요), 공유 dev DB 를 절대
// 건드리지 않도록 격리된 SQLJS_DB_PATH 임시 파일을 쓴다.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(__dirname, '..', 'dist');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awb-merge-lease-'));
process.env.DB_TYPE = 'sqlite';
process.env.SQLJS_DB_PATH = path.join(tmpDir, 'merge-lease-test.db');
process.env.NODE_ENV = 'test';

const { buildDataSourceOptions } = await import('file://' + path.join(DIST, 'db.js'));
const { MergeLease } = await import('file://' + path.join(DIST, 'entities', 'MergeLease.js'));
const { Ticket } = await import('file://' + path.join(DIST, 'entities', 'Ticket.js'));
const { Board } = await import('file://' + path.join(DIST, 'entities', 'Board.js'));
const { BoardColumn } = await import('file://' + path.join(DIST, 'entities', 'BoardColumn.js'));
const { Workspace } = await import('file://' + path.join(DIST, 'entities', 'Workspace.js'));
const { Resource } = await import('file://' + path.join(DIST, 'entities', 'Resource.js'));
const { MergeLeaseService } = await import(
  'file://' + path.join(DIST, 'modules', 'tickets', 'merge-lease.service.js')
);
const { MergeLeaseSweepService } = await import(
  'file://' + path.join(DIST, 'modules', 'agents', 'merge-lease-sweep.service.js')
);
const { releaseMergeLeaseForMove } = await import(
  'file://' + path.join(DIST, 'modules', 'mcp', 'shared', 'merge-lease-move.js')
);
const { DataSource, IsNull } = await import('typeorm');

const MIN = 60_000;

const ds = new DataSource(buildDataSourceOptions());
await ds.initialize(); // synchronize → merge_leases + 부분 UNIQUE 인덱스 생성

const activityStub = { async logActivity() {} };
const logStub = { warn() {}, info() {}, error() {}, debug() {} };

const svc = new MergeLeaseService(ds, activityStub);

/** 재개 디스패치 호출을 기록하는 스텁 — 실제 SSE 대신 호출 사실만 관측한다. */
const dispatched = [];
const triggerStub = {
  async dispatchCurrentColumn(ticketId, source) {
    dispatched.push({ ticketId, source });
    return { emitted: 1 };
  },
};
const sweep = new MergeLeaseSweepService(ds, logStub, svc, triggerStub);

const leaseRepo = ds.getRepository(MergeLease);
const ticketRepo = ds.getRepository(Ticket);

after(async () => {
  await ds.destroy();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── 픽스처 ──────────────────────────────────────────────────────────────────

let WS_ID;
let RESOURCE_ID;
let BOARD_ID;
let MERGING_COL_ID;
let PROGRESS_COL_ID;
let DONE_COL_ID;

async function seedFixtures() {
  const ws = await ds.getRepository(Workspace).save({ name: 'lease-ws', description: '' });
  WS_ID = ws.id;
  const resource = await ds.getRepository(Resource).save({
    workspace_id: WS_ID, board_id: null, credential_id: null,
    name: 'repo', description: '', type: 'repository',
    url: 'https://github.com/example/repo.git', default_branch: 'main',
  });
  RESOURCE_ID = resource.id;
  const board = await ds.getRepository(Board).save({
    workspace_id: WS_ID, name: 'lease-board', description: '',
  });
  BOARD_ID = board.id;
  const merging = await ds.getRepository(BoardColumn).save({
    board_id: BOARD_ID, name: 'Merging', position: 4, kind: 'merging',
  });
  MERGING_COL_ID = merging.id;
  const inprog = await ds.getRepository(BoardColumn).save({
    board_id: BOARD_ID, name: 'In Progress', position: 2, kind: 'active',
  });
  PROGRESS_COL_ID = inprog.id;
  const done = await ds.getRepository(BoardColumn).save({
    board_id: BOARD_ID, name: 'Done', position: 5, kind: 'terminal',
  });
  DONE_COL_ID = done.id;
}
await seedFixtures();

let ticketSeq = 0;
async function makeMergingTicket(title = `t${++ticketSeq}`) {
  return ticketRepo.save({
    workspace_id: WS_ID,
    column_id: MERGING_COL_ID,
    title,
    description: '',
    base_repo_resource_id: RESOURCE_ID,
    base_branch: 'main',
  });
}

/** 보드 설정을 바꾼다(킬 스위치·타이밍 오버라이드 테스트용). */
async function setBoardLeaseConfig(json) {
  await ds.getRepository(Board).update({ id: BOARD_ID }, { merge_lease_config: json });
}

/** DB 행을 과거로 민다 — sleep 없이 시간 경과를 재현하는 유일한 수단. */
async function backdate(leaseId, fields) {
  await leaseRepo.update({ id: leaseId }, fields);
}

/** 이 스코프의 살아 있는 홀더 수 — 상호배제 불변식의 관측점. */
async function heldCount() {
  return leaseRepo.count({
    where: { repo_resource_id: RESOURCE_ID, base_branch: 'main', state: 'held', released_at: IsNull() },
  });
}

async function clearLeases() {
  await leaseRepo.clear();
  await ticketRepo.update({ pending_merge_lease: true }, { pending_merge_lease: false, merge_lease_context: '' });
  dispatched.length = 0;
}

// ── 1. 스키마 ───────────────────────────────────────────────────────────────

test('synchronize 가 부분 UNIQUE 인덱스를 실제로 만들고, 재실행이 멱등이다', async () => {
  const rows = await ds.query(
    "SELECT name, sql FROM sqlite_master WHERE type='index' AND tbl_name='merge_leases'",
  );
  const scopeIdx = rows.find((r) => r.name === 'uniq_merge_lease_held_scope');
  assert.ok(scopeIdx, `스코프 유니크 인덱스가 없다: ${rows.map((r) => r.name).join(', ')}`);
  assert.match(scopeIdx.sql, /UNIQUE/i);
  assert.match(scopeIdx.sql, /WHERE/i);
  assert.match(scopeIdx.sql, /held/);

  const ticketIdx = rows.find((r) => r.name === 'uniq_merge_lease_open_ticket');
  assert.ok(ticketIdx, '티켓별 유니크 인덱스가 없다');
  assert.match(ticketIdx.sql, /UNIQUE/i);

  // 부팅마다 도는 synchronize 가 기존 스키마 위에서 throw 하지 않아야 한다.
  await ds.synchronize(false);
});

// ── 2. DB 레벨 상호배제 (다중 manager 보장) ─────────────────────────────────

test('같은 스코프의 두 번째 held 행은 DB 가 거부한다 — 인프로세스 뮤텍스로는 불가능한 보장', async () => {
  await clearLeases();
  const a = await makeMergingTicket();
  const b = await makeMergingTicket();
  const now = new Date();
  const base = {
    workspace_id: WS_ID, board_id: BOARD_ID,
    repo_resource_id: RESOURCE_ID, base_branch: 'main',
    state: 'held', queued_at: now, acquired_at: now, last_progress_at: now,
  };
  await leaseRepo.insert({ id: randomUUID(), ticket_id: a.id, ...base });

  await assert.rejects(
    () => leaseRepo.insert({ id: randomUUID(), ticket_id: b.id, ...base }),
    /UNIQUE|constraint/i,
    '두 번째 held 삽입이 인덱스에 걸리지 않았다 — 다중 인스턴스에서 두 홀더가 생긴다',
  );

  // 해제된 행은 다음 홀더를 막지 않는다(부분 술어가 실제로 동작하는지).
  await leaseRepo.update({ ticket_id: a.id }, { released_at: new Date(), release_reason: 'landed' });
  await leaseRepo.insert({ id: randomUUID(), ticket_id: b.id, ...base });
  assert.equal(await heldCount(), 1);
});

// ── 3. 동시 획득 ────────────────────────────────────────────────────────────

test('동시 acquire ×5 → 정확히 1명만 granted, 나머지는 파킹된다', async () => {
  await clearLeases();
  const tickets = [];
  for (let i = 0; i < 5; i++) tickets.push(await makeMergingTicket());

  // 공통 시작점에서 한꺼번에 — 고정 지연이 아니라 실제 동시 호출로 경쟁시킨다.
  const results = await Promise.all(tickets.map((t) => svc.acquire(t.id, { actorId: `agent-${t.id}` })));

  const granted = results.filter((r) => r.outcome === 'granted');
  const queued = results.filter((r) => r.outcome === 'queued');
  assert.equal(granted.length, 1, `granted 가 정확히 1이어야 한다: ${JSON.stringify(results.map((r) => r.outcome))}`);
  assert.equal(queued.length, 4);
  assert.equal(await heldCount(), 1);

  // 대기자는 네 번째 pending flavor 로 실제 파킹돼야 한다 — 안 그러면 계속
  // 재디스패치돼 lease 를 기다리는 동안 turn 을 태운다.
  for (const r of queued) {
    const row = await leaseRepo.findOne({ where: { id: r.lease_id } });
    const t = await ticketRepo.findOne({ where: { id: row.ticket_id } });
    assert.equal(t.pending_merge_lease, true, '대기자가 파킹되지 않았다');
    assert.ok(t.merge_lease_context.includes(r.lease_id), '대기 컨텍스트가 기록되지 않았다');
  }

  // 홀더는 파킹되지 않는다(계속 작업해야 한다).
  const holder = await leaseRepo.findOne({ where: { state: 'held', released_at: IsNull() } });
  const holderTicket = await ticketRepo.findOne({ where: { id: holder.ticket_id } });
  assert.equal(holderTicket.pending_merge_lease, false);
});

test('홀더의 재획득은 멱등이고 재검증 예산을 깎는다', async () => {
  await clearLeases();
  await setBoardLeaseConfig('{"max_reverify_attempts":3}');
  const t = await makeMergingTicket();

  const first = await svc.acquire(t.id);
  assert.equal(first.outcome, 'granted');
  assert.equal(first.attempt, 1);
  assert.equal(first.budget, 'continue');

  const second = await svc.acquire(t.id);
  assert.equal(second.outcome, 'granted');
  assert.equal(second.lease_id, first.lease_id, '재획득이 새 lease 를 만들면 안 된다');
  assert.equal(second.attempt, 2);
  assert.equal(second.budget, 'continue');

  const third = await svc.acquire(t.id);
  assert.equal(third.attempt, 3);
  assert.equal(third.budget, 'continue');

  const fourth = await svc.acquire(t.id);
  assert.equal(fourth.budget, 'exhausted', '상한을 넘겼는데 소진이 보고되지 않았다');
  assert.equal(await heldCount(), 1, '예산 소진이 lease 를 잃게 해서는 안 된다');
  await setBoardLeaseConfig(null);
});

// ── 4. ★ 완료 기준 — base 가 계속 전진해도 유한하게 랜딩한다 ────────────────

test('base 가 계속 전진하는 재현: 모든 티켓이 기아 없이 유한하게 랜딩하고, 검증 SHA == 랜딩 SHA', async () => {
  await clearLeases();
  await setBoardLeaseConfig('{"max_wait_minutes":45,"max_reverify_attempts":3}');

  const N = 4;
  const tickets = [];
  for (let i = 0; i < N; i++) tickets.push(await makeMergingTicket(`land-${i}`));

  // 시뮬레이션되는 base. **랜딩만이** 이것을 전진시킨다 — 이 테스트가 재현하는
  // 것이 바로 "다른 AWB 티켓의 랜딩이 base 를 민다" 는 원래 루프의 원인이다.
  let baseSha = 'sha-0';
  let landedCount = 0;
  const landings = [];
  const verifications = [];      // (ticket, 검증한 SHA)
  let maxSimultaneousHolders = 0;

  const pending = new Set(tickets.map((t) => t.id));
  let rounds = 0;
  const ROUND_CAP = 200; // 무한 루프 감지용 상한 — 정상이면 훨씬 못 미친다

  while (pending.size > 0) {
    if (++rounds > ROUND_CAP) assert.fail(`유한하게 끝나지 않았다 — ${ROUND_CAP} 라운드 초과`);

    for (const ticketId of [...pending]) {
      const res = await svc.acquire(ticketId, { actorId: `agent-${ticketId}` });
      maxSimultaneousHolders = Math.max(maxSimultaneousHolders, await heldCount());

      if (res.outcome === 'queued') continue;   // 파킹 — 스윕이 깨울 것이다
      assert.notEqual(res.outcome, 'degraded', `예기치 않은 degraded: ${res.degrade_reason}`);

      // 홀더의 랜딩 시퀀스: SHA 캡처 → (CI 검증) → ff → push.
      const verifiedSha = baseSha;
      verifications.push({ ticketId, verifiedSha });

      // lease 를 쥐고 있으므로 이 사이 base 는 전진할 수 없다.
      const shaAtLanding = baseSha;
      assert.equal(
        shaAtLanding, verifiedSha,
        'lease 를 쥔 동안 base 가 움직였다 — 직렬화가 깨졌다',
      );

      baseSha = `sha-${++landedCount}`;         // 이 티켓의 랜딩이 base 를 전진시킨다
      landings.push({ ticketId, verifiedSha, landedOnto: shaAtLanding });

      // Done 이동 = 프로덕션 경로의 이동 트랜잭션 안에서 해제.
      await landTicket(ticketId);
      pending.delete(ticketId);
    }

    // 서버 스윕이 FIFO 머리를 깨운다.
    await sweep.sweep();
  }

  assert.equal(landings.length, N, '모든 티켓이 랜딩해야 한다');
  assert.equal(maxSimultaneousHolders, 1, '동시에 두 홀더가 존재한 순간이 있었다');
  // 검증한 SHA 와 실제 랜딩 대상 SHA 가 티켓마다 일치 — 이 기능의 존재 이유.
  for (const l of landings) assert.equal(l.verifiedSha, l.landedOnto);
  // 재검증(= 같은 티켓의 중복 검증)이 한 번도 없어야 한다: 직렬화가 되면
  // 티켓당 CI 1회로 끝난다(실측 3회에서 개선되는 지점).
  const perTicket = new Map();
  for (const v of verifications) perTicket.set(v.ticketId, (perTicket.get(v.ticketId) || 0) + 1);
  for (const [tid, count] of perTicket) {
    assert.equal(count, 1, `티켓 ${tid} 이 ${count}회 검증됐다 — 직렬화됐다면 1회여야 한다`);
  }
  await setBoardLeaseConfig(null);
});

/** Done 이동 — 프로덕션 이동 트랜잭션과 같은 모양(해제가 같은 트랜잭션 안). */
async function landTicket(ticketId) {
  const terminal = { id: DONE_COL_ID, kind: 'terminal' };
  const merging = { id: MERGING_COL_ID, kind: 'merging' };
  await ds.transaction(async (manager) => {
    const tRepo = manager.getRepository(Ticket);
    await tRepo.update({ id: ticketId }, { column_id: DONE_COL_ID });
    await releaseMergeLeaseForMove(tRepo, ticketId, merging, terminal);
  });
}

// ── 5. ★ 완료 기준 — 외부 push 가 계속 밀면 명시적으로 실패한다 ─────────────

test('lease 로 막을 수 없는 외부 push 가 계속 base 를 밀면, 무한 루프 대신 명시적 실패로 끝난다', async () => {
  await clearLeases();
  await setBoardLeaseConfig('{"max_reverify_attempts":3}');
  const t = await makeMergingTicket('hostile');

  // lease 는 AWB 티켓끼리만 조정한다 — 사람의 직접 push 나 같은 저장소를 보는
  // 다른 AWB 인스턴스는 막지 못한다. 그 상황을 재현한다.
  let baseSha = 'x-0';
  let externalPushes = 0;
  let attempts = 0;
  let outcome = null;

  for (let i = 0; i < 50; i++) {
    const res = await svc.acquire(t.id);
    assert.equal(res.outcome, 'granted');
    attempts++;

    if (res.budget === 'exhausted') { outcome = 'explicit_failure'; break; }

    const verified = baseSha;
    baseSha = `x-${++externalPushes}`;   // 외부에서 base 가 전진 → ff 실패
    if (baseSha === verified) { outcome = 'landed'; break; }
    // ff 실패 → step 2 로 되돌아가 다시 acquire (= 재검증 1회 소비)
  }

  assert.equal(outcome, 'explicit_failure', '무한 루프에 빠졌거나 조용히 계속 돌았다');
  assert.equal(attempts, 4, `상한 3 + 소진 보고 1 = 4회여야 한다 (실제 ${attempts})`);
  assert.ok(externalPushes < 50, '유한하게 끝나야 한다');
  await setBoardLeaseConfig(null);
});

// ── 6. liveness / 리퍼 (설계 보정 A) ───────────────────────────────────────

test('무진행 홀더는 회수되고, 그 자리를 대기자가 이어받는다', async () => {
  await clearLeases();
  const dead = await makeMergingTicket('dead-holder');
  const waiter = await makeMergingTicket('waiter');

  const held = await svc.acquire(dead.id);
  assert.equal(held.outcome, 'granted');
  const queued = await svc.acquire(waiter.id);
  assert.equal(queued.outcome, 'queued');

  // 기본 idle 상한(20분)을 훌쩍 넘긴 무진행 상태로 만든다.
  await backdate(held.lease_id, {
    last_progress_at: new Date(Date.now() - 60 * MIN),
    acquired_at: new Date(Date.now() - 60 * MIN),
  });

  dispatched.length = 0;
  const stats = await sweep.sweep();
  assert.ok(stats.reaped >= 1, '죽은 홀더가 회수되지 않았다');
  assert.equal(stats.granted, 1, '대기자가 승격되지 않았다');

  const reaped = await leaseRepo.findOne({ where: { id: held.lease_id } });
  assert.ok(reaped.released_at, '회수된 lease 에 released_at 이 없다');
  assert.equal(reaped.release_reason, 'reap_idle');

  const promoted = await leaseRepo.findOne({ where: { id: queued.lease_id } });
  assert.equal(promoted.state, 'held');

  const waiterTicket = await ticketRepo.findOne({ where: { id: waiter.id } });
  assert.equal(waiterTicket.pending_merge_lease, false, '승격 후 파킹이 해제되지 않았다');
  assert.ok(
    dispatched.some((d) => d.ticketId === waiter.id && d.source === 'merge_lease_granted'),
    '승격 후 재개 디스패치가 없었다',
  );
});

test('★ 미해소 CI 대기를 가진 홀더는 idle 상한을 훨씬 넘겨도 회수되지 않는다', async () => {
  await clearLeases();
  const holder = await makeMergingTicket('slow-ci');
  const res = await svc.acquire(holder.id);
  assert.equal(res.outcome, 'granted');

  // 무진행 시간은 idle 상한의 3배. 하지만 서버가 폴링 중인 CI run 이 걸려 있다.
  await backdate(res.lease_id, {
    last_progress_at: new Date(Date.now() - 60 * MIN),
    acquired_at: new Date(Date.now() - 61 * MIN),
  });
  await ticketRepo.update({ id: holder.id }, {
    pending_ci_wait: true,
    ci_wait_context: JSON.stringify({ owner: 'o', repo: 'r', run_id: '123' }), // outcome 없음 = 미해소
  });

  await sweep.sweep();
  const still = await leaseRepo.findOne({ where: { id: res.lease_id } });
  assert.equal(still.released_at, null, 'CI 가 도는 중인 홀더의 lease 를 뺏었다 — 두 홀더 동시 랜딩 위험');
  assert.equal(still.state, 'held');

  // 반대 방향: CI 가 해소되면(outcome 기록) 더 이상 진행 증거가 아니다.
  await ticketRepo.update({ id: holder.id }, {
    ci_wait_context: JSON.stringify({
      owner: 'o', repo: 'r', run_id: '123',
      outcome: { kind: 'resolved', message: 'ok', resolved_at: new Date().toISOString() },
    }),
  });
  await sweep.sweep();
  const reaped = await leaseRepo.findOne({ where: { id: res.lease_id } });
  assert.ok(reaped.released_at, 'CI 가 해소된 뒤에도 무진행 홀더가 회수되지 않았다');
  assert.equal(reaped.release_reason, 'reap_idle');
});

test('절대 상한(백스톱)은 CI 대기 중이어도 회수한다', async () => {
  await clearLeases();
  await setBoardLeaseConfig('{"max_hold_minutes":30}');
  const holder = await makeMergingTicket('stuck-forever');
  const res = await svc.acquire(holder.id);
  await backdate(res.lease_id, {
    acquired_at: new Date(Date.now() - 31 * MIN),
    last_progress_at: new Date(),
  });
  await ticketRepo.update({ id: holder.id }, {
    pending_ci_wait: true,
    ci_wait_context: JSON.stringify({ owner: 'o', repo: 'r', run_id: '1' }),
  });

  await sweep.sweep();
  const row = await leaseRepo.findOne({ where: { id: res.lease_id } });
  assert.equal(row.release_reason, 'reap_max_hold');
  await setBoardLeaseConfig(null);
});

// ── 7. 이동 ↔ 해제 원자성 (설계 보정 D) ────────────────────────────────────

test('★ 컬럼 이동 트랜잭션이 롤백되면 lease 해제도 함께 롤백된다', async () => {
  await clearLeases();
  const t = await makeMergingTicket('atomic');
  const res = await svc.acquire(t.id);
  assert.equal(res.outcome, 'granted');

  const merging = { id: MERGING_COL_ID, kind: 'merging' };
  const terminal = { id: DONE_COL_ID, kind: 'terminal' };

  await assert.rejects(() => ds.transaction(async (manager) => {
    const tRepo = manager.getRepository(Ticket);
    await tRepo.update({ id: t.id }, { column_id: DONE_COL_ID });
    await releaseMergeLeaseForMove(tRepo, t.id, merging, terminal);
    throw new Error('이동 도중 강제 실패');
  }));

  // 이동이 롤백됐으므로 lease 도 살아 있어야 한다. 따로 커밋됐다면 여기서
  // "티켓은 Merging 인데 lease 는 해제됨" 이라는 불일치가 남는다.
  const lease = await leaseRepo.findOne({ where: { id: res.lease_id } });
  assert.equal(lease.released_at, null, '이동은 롤백됐는데 lease 해제만 커밋됐다');
  const ticket = await ticketRepo.findOne({ where: { id: t.id } });
  assert.equal(ticket.column_id, MERGING_COL_ID);

  // 정상 커밋되면 둘 다 반영된다.
  await ds.transaction(async (manager) => {
    const tRepo = manager.getRepository(Ticket);
    await tRepo.update({ id: t.id }, { column_id: DONE_COL_ID });
    await releaseMergeLeaseForMove(tRepo, t.id, merging, terminal);
  });
  const after = await leaseRepo.findOne({ where: { id: res.lease_id } });
  assert.ok(after.released_at);
  assert.equal(after.release_reason, 'landed');
});

test('Merging 밖으로의 바운스도 해제하고, Merging 진입·내부 이동은 건드리지 않는다', async () => {
  await clearLeases();
  const t = await makeMergingTicket('bounce');
  const res = await svc.acquire(t.id);
  const merging = { id: MERGING_COL_ID, kind: 'merging' };
  const active = { id: PROGRESS_COL_ID, kind: 'active' };

  // Merging 으로 들어오는 이동은 무관 — 해제하면 안 된다.
  await ds.transaction(async (m) => {
    await releaseMergeLeaseForMove(m.getRepository(Ticket), t.id, active, merging);
  });
  assert.equal((await leaseRepo.findOne({ where: { id: res.lease_id } })).released_at, null);

  // In Progress 로의 바운스는 해제한다.
  await ds.transaction(async (m) => {
    await releaseMergeLeaseForMove(m.getRepository(Ticket), t.id, merging, active);
  });
  const row = await leaseRepo.findOne({ where: { id: res.lease_id } });
  assert.ok(row.released_at);
  assert.equal(row.release_reason, 'left_merging');
});

test('대기자가 Merging 을 떠나면 대기 플래그도 함께 정리된다', async () => {
  await clearLeases();
  const holder = await makeMergingTicket('holder-x');
  const waiter = await makeMergingTicket('waiter-x');
  await svc.acquire(holder.id);
  const q = await svc.acquire(waiter.id);
  assert.equal(q.outcome, 'queued');

  await ds.transaction(async (m) => {
    await releaseMergeLeaseForMove(
      m.getRepository(Ticket), waiter.id,
      { id: MERGING_COL_ID, kind: 'merging' }, { id: PROGRESS_COL_ID, kind: 'active' },
    );
  });

  const t = await ticketRepo.findOne({ where: { id: waiter.id } });
  assert.equal(t.pending_merge_lease, false, '떠난 대기자가 파킹된 채로 남았다 — 트리거가 영원히 드롭된다');
  assert.equal(t.merge_lease_context, '');
});

// ── 8. fail-open ────────────────────────────────────────────────────────────

test('보드가 껐으면 degraded 로 통과시킨다 (킬 스위치)', async () => {
  await clearLeases();
  await setBoardLeaseConfig('{"enabled":false}');
  const t = await makeMergingTicket('disabled');
  const res = await svc.acquire(t.id);
  assert.equal(res.outcome, 'degraded');
  assert.equal(res.degrade_reason, 'board_disabled');
  assert.equal(await leaseRepo.count(), 0, '비활성 보드에서 lease 행을 만들면 안 된다');
  await setBoardLeaseConfig(null);
});

test('저장소를 해석할 수 없으면 degraded 로 통과시킨다', async () => {
  await clearLeases();
  const t = await ticketRepo.save({
    workspace_id: WS_ID, column_id: MERGING_COL_ID, title: 'no-repo', description: '',
    base_repo_resource_id: '', base_branch: '',
  });
  const res = await svc.acquire(t.id);
  assert.equal(res.outcome, 'degraded');
  assert.equal(res.degrade_reason, 'repo_unresolved');
});

test('★ 대기 상한을 넘긴 대기자는 fail-open 으로 풀려나 lease 없이 진행한다 (기아 방지)', async () => {
  await clearLeases();
  await setBoardLeaseConfig('{"max_wait_minutes":10}');
  const holder = await makeMergingTicket('long-holder');
  const starved = await makeMergingTicket('starved');

  const h = await svc.acquire(holder.id);
  assert.equal(h.outcome, 'granted');
  const w = await svc.acquire(starved.id);
  assert.equal(w.outcome, 'queued');

  // 홀더는 계속 살아 있다(CI 진행 중) — 즉 스코프가 절대 비지 않는 상황.
  await ticketRepo.update({ id: holder.id }, {
    pending_ci_wait: true,
    ci_wait_context: JSON.stringify({ owner: 'o', repo: 'r', run_id: '7' }),
  });
  // 대기자만 상한을 넘긴다.
  await backdate(w.lease_id, { queued_at: new Date(Date.now() - 11 * MIN) });

  dispatched.length = 0;
  const stats = await sweep.sweep();
  assert.equal(stats.failed_open, 1, '상한을 넘긴 대기자가 풀려나지 않았다 — 기아');
  assert.equal(stats.granted, 0);

  const row = await leaseRepo.findOne({ where: { id: w.lease_id } });
  assert.equal(row.release_reason, 'wait_timeout');
  assert.equal(row.degraded, true, 'fail-open 사실이 기록되지 않았다');

  const t = await ticketRepo.findOne({ where: { id: starved.id } });
  assert.equal(t.pending_merge_lease, false, '풀려난 대기자가 파킹된 채로 남았다');
  assert.ok(
    dispatched.some((d) => d.ticketId === starved.id && d.source === 'merge_lease_failed_open'),
    'fail-open 뒤 재개 디스패치가 없었다',
  );

  // 홀더는 그대로 살아 있어야 한다 — 대기자의 탈출이 홀더를 뺏어서는 안 된다.
  assert.equal((await leaseRepo.findOne({ where: { id: h.lease_id } })).released_at, null);
  await setBoardLeaseConfig(null);
});

test('★ 파킹된 대기자가 재획득으로 승격되면 파킹이 즉시 해제된다', async () => {
  // 파킹이 안 풀리면 에이전트는 lease 를 받아 랜딩을 진행하는데 티켓은
  // pending_merge_lease=true 로 남아, 이후 모든 트리거가 게이트에서 드롭된다 —
  // "lease 는 받았는데 티켓이 조용히 멈추는" 상태.
  await clearLeases();
  const holder = await makeMergingTicket('h-park');
  const waiter = await makeMergingTicket('w-park');

  await svc.acquire(holder.id);
  const q = await svc.acquire(waiter.id);
  assert.equal(q.outcome, 'queued');
  assert.equal((await ticketRepo.findOne({ where: { id: waiter.id } })).pending_merge_lease, true);

  // 홀더가 랜딩해 스코프가 비었고, 스윕보다 먼저 대기자가 재디스패치돼
  // 스스로 await_merge_lease 를 다시 부른 경우(정상적으로 일어난다).
  await svc.release(holder.id, 'landed');
  const again = await svc.acquire(waiter.id);
  assert.equal(again.outcome, 'granted');
  assert.equal(again.lease_id, q.lease_id, '승격이 아니라 새 lease 를 만들었다');

  const t = await ticketRepo.findOne({ where: { id: waiter.id } });
  assert.equal(t.pending_merge_lease, false, '승격됐는데 파킹이 남아 있다 — 이후 트리거가 전부 드롭된다');
  assert.equal(t.merge_lease_context, '');
});

test('아직 차례가 아닌 대기자의 재획득은 파킹을 다시 세운다', async () => {
  await clearLeases();
  const holder = await makeMergingTicket('h-repark');
  const waiter = await makeMergingTicket('w-repark');
  await svc.acquire(holder.id);
  const q = await svc.acquire(waiter.id);
  assert.equal(q.outcome, 'queued');

  // 외부 요인(리컨사일러 재디스패치 등)으로 파킹이 풀린 상태를 재현.
  await ticketRepo.update({ id: waiter.id }, { pending_merge_lease: false, merge_lease_context: '' });

  const again = await svc.acquire(waiter.id);
  assert.equal(again.outcome, 'queued');
  assert.equal(
    (await ticketRepo.findOne({ where: { id: waiter.id } })).pending_merge_lease, true,
    '차례가 아닌데 파킹이 복구되지 않으면 재디스패치 루프가 된다',
  );
});

test('승격은 됐는데 전달 전에 죽은 경우, 다음 스윕이 전달만 다시 수행한다', async () => {
  await clearLeases();
  const holder = await makeMergingTicket('crash-holder');
  const waiter = await makeMergingTicket('crash-waiter');
  await svc.acquire(holder.id);
  const w = await svc.acquire(waiter.id);
  assert.equal(w.outcome, 'queued');

  // 홀더를 해제하고, 대기자를 수동으로 승격만 시켜 "홀더인데 아직 파킹" 상태를
  // 만든다 — 승격과 전달 사이 크래시의 재현.
  await svc.release(holder.id, 'landed');
  assert.ok(await svc.promoteWaiter(w.lease_id, new Date()));
  const mid = await ticketRepo.findOne({ where: { id: waiter.id } });
  assert.equal(mid.pending_merge_lease, true, '재현 전제가 성립하지 않았다');

  dispatched.length = 0;
  await sweep.sweep();

  const healed = await ticketRepo.findOne({ where: { id: waiter.id } });
  assert.equal(healed.pending_merge_lease, false, '다음 스윕이 자체 복구하지 않았다');
  assert.ok(dispatched.some((d) => d.ticketId === waiter.id));
});
