// QA flow: 타임라인 커서의 마지막 키가 **REST 경로로도** 실제로 전달되는가 (티켓 7b679009).
//
// 왜 서비스 테스트로 부족한가
// ──────────────────────────
//
// `listMissionEvents()` 를 직접 부르는 테스트는 서비스가 `before_id` 를 받으면 옳게 쓴다는
// 것만 보인다. 그런데 이 값이 화면까지 가려면 컨트롤러가 `@Query('before_id')` 로 받아
// 서비스 opts 에 실어 줘야 하고, 그 두 줄은 **어떤 서비스 테스트도 지나가지 않는다.**
// 이름을 오타 내거나 forwarding 을 빠뜨려도 서비스 테스트·클라이언트 테스트는 둘 다
// green 이고, 서버는 조용히 예전 2단 술어로 degrade 해 손실이 그대로 돌아온다 — 한 층을
// 고치고 옆 층을 안 고쳐 결함이 남는 것이 이 티켓 계보가 반복해 겪은 실패다(티켓 85efcb69).
//
// 그래서 여기서는 인증·권한 가드·쿼리 파싱·컨트롤러 배선을 전부 포함한 **진짜 HTTP**로
// 커서를 끝까지 돌린다.
//
// 비공허성: 같은 픽스처를 `before_id` **없이도** 한 번 돌려 실제로 이벤트를 잃는 것을
// 보인다. 그래야 위의 green 이 "파라미터가 경로에 실제로 실렸다" 를 뜻하게 된다 —
// 파라미터가 무시되고 있어도 통과하는 테스트는 아무것도 증명하지 못한다.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { bootApp, exitAfterTests, step } from '../helpers/boot.mjs';
import { createAgent, createUser, createWorkspace } from '../helpers/fixtures.mjs';

process.env.PORT = process.env.ORCHESTRATION_EVENTS_CURSOR_PORT || '0';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(__dirname, '..', '..', 'dist');

/** 초 단위, 소수점 없음 — sqljs 의 `datetime('now')` 와 같은 형식이어야 tied 등호가 선다. */
const SECOND_BEFORE = '2026-09-20 05:00:01';
const SECOND_FAIL_OPEN = '2026-09-20 05:00:02';
const SECOND_AFTER = '2026-09-20 05:00:03';

async function loadServices() {
  const team = await import(
    pathToFileURL(path.join(DIST, 'modules', 'orchestration', 'orchestration-team.service.js')).href
  );
  const mission = await import(
    pathToFileURL(path.join(DIST, 'modules', 'orchestration', 'orchestration-mission.service.js')).href
  );
  return {
    OrchestrationTeamService: team.OrchestrationTeamService,
    OrchestrationMissionService: mission.OrchestrationMissionService,
  };
}

test('타임라인 커서의 마지막 키가 REST 경로로 전달되어 seq 동률에서도 전량을 덮는다', async (t) => {
  const { app, port, modules } = await bootApp({ port: parseInt(process.env.PORT, 10) });
  t.after(() => { void app.close().catch(() => {}); });
  const { getDataSourceToken, AuthService } = modules;
  const ds = app.get(getDataSourceToken());
  const services = await loadServices();
  const teams = app.get(services.OrchestrationTeamService);
  const missions = app.get(services.OrchestrationMissionService);
  const base = `http://127.0.0.1:${port}`;

  const ws = await createWorkspace(app, getDataSourceToken, 'events-cursor-rest');
  const lead = await createAgent(app, getDataSourceToken, ws.id, { name: 'lead' });
  // MANAGE_ACTIONS 가 필요하다 — 이 컨트롤러 전체가 그 권한 뒤에 있다.
  const operator = await createUser(app, getDataSourceToken, { name: 'events-cursor-operator' });
  const token = app.get(AuthService).createSession(operator.id);

  const team = await teams.createTeam({
    workspace_id: ws.id,
    name: 'Cursor squad',
    orchestrator_agent_id: lead.id,
    max_parallel_steps: 2,
    created_by: operator.id,
  });
  const mission = await missions.createMission({
    workspace_id: ws.id,
    team_id: team.id,
    title: 'Cursor fixture',
    objective: 'fail-open 이 두 번 난 타임라인',
    created_by_type: 'user',
    created_by: operator.id,
  });

  const eventRepo = ds.getRepository('OrchestrationEvent');
  const record = async (message) => {
    await missions.recordEvent(mission, { type: 'note', message });
    const row = await eventRepo.findOne({ where: { mission_id: mission.id, message } });
    assert.ok(row, `"${message}" 이벤트가 저장돼야 한다`);
    return row;
  };

  // `createMission` 자신이 `mission_created` 를 한 줄 남긴다 — 픽스처 목록을 손으로
  // 세지 않고 미션의 전체 행을 DB 에서 읽어 기대값으로 쓴다.
  step('정상 기록 3건 — write_seq 가 단조 증가한다');
  const before = [];
  for (const n of [1, 2, 3]) before.push(await record(`before ${n}`));
  const beforeSeqs = before.map((e) => e.write_seq);
  assert.deepEqual(
    beforeSeqs, [beforeSeqs[0], beforeSeqs[0] + 1, beforeSeqs[0] + 2],
    `정상 경로는 MAX + 1 로 증가해야 한다 (관측 ${JSON.stringify(beforeSeqs)})`,
  );
  assert.ok(beforeSeqs[0] > 0, '정상 경로의 write_seq 는 양수여야 한다');

  step('직렬화 트랜잭션만 실패시켜 fail-open 을 두 번 태운다');
  const originalTransaction = ds.transaction;
  const failOpen = [];
  try {
    ds.transaction = async () => { throw new Error('injected: serialized event write failed'); };
    for (const m of ['fail-open A', 'fail-open B']) failOpen.push(await record(m));
  } finally {
    ds.transaction = originalTransaction;
  }
  assert.deepEqual(
    failOpen.map((e) => e.write_seq), [0, 0],
    'fail-open 은 write_seq 0 으로라도 행을 남겨야 한다 — 픽스처가 동률 군집을 만들지 못하면 이 flow 는 공허하다',
  );

  const resumed = await record('after 1');
  assert.equal(
    resumed.write_seq, beforeSeqs[2] + 1,
    'seq 0 이 섞여도 다음 정상 기록은 MAX + 1 이어야 한다',
  );

  // created_at 을 고정해 두 fail-open 행을 같은 tied group 에 둔다(러너 속도 의존 제거).
  // fail-open 이 아닌 행은 전부 그 앞뒤 초로 밀어내, 경계가 반드시 동률 군집 안에 떨어지게 한다.
  const failOpenIds = new Set(failOpen.map((e) => e.id));
  const rows = await eventRepo.find({ where: { mission_id: mission.id } });
  for (const row of rows) {
    if (failOpenIds.has(row.id)) continue;
    const at = row.id === resumed.id ? SECOND_AFTER : SECOND_BEFORE;
    await ds.query('UPDATE orchestration_events SET created_at = ? WHERE id = ?', [at, row.id]);
  }
  for (const e of failOpen) {
    await ds.query('UPDATE orchestration_events SET created_at = ? WHERE id = ?', [SECOND_FAIL_OPEN, e.id]);
  }

  const all = rows.map((e) => e.id);
  assert.ok(all.length >= 6, `픽스처가 최소 6행이어야 한다 (관측 ${all.length}행)`);

  /** 진짜 HTTP 로 커서를 끝까지 돌린다. `withId=false` 는 고치기 전 2단 커서 모양이다. */
  async function walkOverHttp(limit, withId) {
    const seen = [];
    let cursor = null;
    let sawCursorId = false;
    for (let page = 0; page < 30; page += 1) {
      const qs = [`workspace_id=${encodeURIComponent(ws.id)}`, `limit=${limit}`];
      if (cursor) {
        qs.push(`before_at=${encodeURIComponent(cursor.at)}`);
        qs.push(`before_seq=${cursor.seq}`);
        if (withId) qs.push(`before_id=${encodeURIComponent(cursor.id)}`);
      }
      const res = await fetch(`${base}/api/orchestration/missions/${mission.id}/events?${qs.join('&')}`, {
        headers: { Authorization: `Bearer ${token}`, 'X-Workspace-Id': ws.id },
      });
      // 본문은 **한 번만** 읽는다 — assert 메시지 자리에서 `await res.text()` 를 부르면
      // 템플릿 리터럴이 즉시 평가되어 성공 경로에서도 body 가 소모되고, 뒤의 json() 이
      // "Body is unusable" 로 죽는다.
      const raw = await res.text();
      assert.equal(res.status, 200, `이벤트 조회가 200 이어야 한다 (${raw})`);
      const body = JSON.parse(raw);
      for (const e of body.events) seen.push(e.id);
      cursor = body.next_cursor;
      if (cursor && typeof cursor.id === 'string' && cursor.id) sawCursorId = true;
      if (!body.has_more) break;
    }
    return { seen, sawCursorId };
  }

  step('응답의 next_cursor 가 마지막 키를 싣는지, 3단 커서가 전량을 덮는지 확인한다');
  const fixed = await walkOverHttp(1, true);
  assert.ok(
    fixed.sawCursorId,
    'next_cursor 에 id 가 없으면 클라이언트가 마지막 키를 되돌려 보낼 방법이 없다 — API 계약 위반이다',
  );
  assert.equal(
    new Set(fixed.seen).size, fixed.seen.length,
    `커서가 같은 이벤트를 두 번 돌려줬다 (중복 ${fixed.seen.length - new Set(fixed.seen).size}건)`,
  );
  assert.deepEqual(
    [...fixed.seen].sort(), [...all].sort(),
    `REST 커서 순회가 ${fixed.seen.length}/${all.length} 건만 덮었다 — 컨트롤러가 before_id 를 서비스로 ` +
    '넘기지 않으면 서버가 조용히 2단 술어로 degrade 해 같은 시각의 나머지가 사라진다',
  );

  step('비공허성 — before_id 를 빼면 같은 픽스처에서 실제로 잃는다');
  const legacy = await walkOverHttp(1, false);
  assert.ok(
    legacy.seen.length < all.length,
    'before_id 없는 호출이 전량을 덮어 버리면 이 flow 는 그 파라미터가 실제로 쓰였는지 증명하지 못한다 ' +
    `(순회 ${legacy.seen.length} / 전체 ${all.length})`,
  );
});

exitAfterTests();
