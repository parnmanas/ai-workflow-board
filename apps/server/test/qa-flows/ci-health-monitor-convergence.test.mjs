// QA flow: CiHealthMonitorService — 교차 프로젝트 incident 수렴 (ticket 3886473a).
//
// 무엇을 증명하는가
// ────────────────
// CiHealthMonitor 의 `operational_dedupe_key` 에 감시 단위(예전엔 board id)가 들어 있던
// 시절, 같은 저장소를 감시하는 단위가 둘이면 같은 실패 run 에 대해 **실행 티켓이 2건**
// 열렸다. 같은 assignee 가 양쪽에 붙어 같은 한 줄 수정을 두 번 dispatch 받았고, 사람이
// 선행조건을 걸었다 풀었다 하며 손으로 조정해야 했다(실측: 같은 run 36399667881 로 쌍둥이
// 티켓이 열렸다). 지금 감시 단위는 Project 이고 키는 workspace 스코프다.
//
// 아래는 그 수렴을 **production 경로(`sweep()`)** 에서 본다 — DB 를 직접 만져 만든 상태가
// 아니라, GitHub 응답만 가짜로 두고 실제 sweep 이 만들어 낸 행·티켓·코멘트·채팅 메시지로
// 단언한다.
//
//   1. (수렴) 같은 workspace 의 프로젝트 2개가 같은 repo/branch/workflow 를 감시 →
//      실행 티켓은 **1건**. 두 프로젝트의 `ci_red_alerts` 행은 모두 그 canonical 티켓을
//      가리키고(관계), 두 프로젝트의 채팅 알림이 모두 그 티켓을 링크하며(알림 — 프로젝트별
//      가시성 유지), 채택 사실이 canonical 티켓에 코멘트로 남는다. project default_assignee
//      도 그 티켓에만 붙는다 — 같은 수정이 두 번 dispatch 되지 않는다는 뜻.
//   2. (비수렴 — 다른 저장소) 다른 repo 를 감시하는 세 번째 프로젝트는 자기 incident 티켓을
//      따로 받는다.
//   3. (done 이후 새 incident) canonical 이 done 이 된 뒤 새 실패가 오면, 끝난 티켓을
//      재사용하지 않고 **새 티켓**을 연다. 복구 코멘트는 프로젝트 수와 무관하게 incident 당
//      1회만 남는다.
//   4. (비수렴 — 다른 workflow) 같은 저장소라도 workflow 가 다르면 별개 incident 다.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootApp, exitAfterTests, step } from '../helpers/boot.mjs';
import { createWorkspace, createProject, createAgent } from '../helpers/fixtures.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST_ROOT = path.resolve(__dirname, '..', '..', 'dist');

process.env.PORT = process.env.QA_CI_CONVERGENCE_PORT || '0';

const REAL_FETCH = globalThis.fetch;
function restoreFetch() { globalThis.fetch = REAL_FETCH; }

function fakeResponse(json) {
  return { ok: true, status: 200, async json() { return json; }, async text() { return JSON.stringify(json); } };
}

/** repo 이름으로 라우팅하고 run 목록은 **workflow 별로** 돌려준다. 한 배열을 모든
 *  workflow 에 답하면 안 된다 — `listWorkflowRuns` 가 요청한 workflow 밖의 run 을 버리므로
 *  (ticket 0ef405f9) 두 번째 workflow 는 신호를 하나도 못 받고, 그러면 "workflow 가 다르면
 *  별개 incident" 를 시험하는 시나리오가 조용히 공허해진다.
 *  이 파일이 세우지 않은 저장소 호출은 던진다 — 픽스처가 조용히 답해 카운터를 오염시키는
 *  대신 그 자리에서 드러나게. */
function makeFakeGitHubFetch(state) {
  return async (url) => {
    const u = String(url);
    for (const [repo, slice] of Object.entries(state.repos)) {
      if (!u.includes(repo)) continue;
      if (u.endsWith('/actions/workflows')) return fakeResponse({ workflows: slice.workflows });
      const runsMatch = u.match(/\/actions\/workflows\/([^/]+)\/runs\?/);
      if (runsMatch) return fakeResponse({ workflow_runs: slice.runsByWorkflow[runsMatch[1]] || [] });
      if (u.includes('/actions/runs/') && u.endsWith('/jobs')) return fakeResponse({ jobs: [{ name: 'server-tests', conclusion: 'failure' }] });
      throw new Error(`라우팅되지 않은 ${repo} URL: ${u}`);
    }
    throw new Error(`이 테스트가 세우지 않은 저장소로 GitHub 호출이 나갔다: ${u}`);
  };
}

// event 기본값 'push' — evaluateRedStreak 는 event 가 비어 있는 run 을 fail-closed 로
// 신호에서 제외하므로(ticket 654465c8) 이 기본값이 없으면 어떤 시나리오도 신호를 못 받는다.
function run(id, conclusion, isoTime, workflowId, event = 'push') {
  return {
    id, status: 'completed', conclusion, event, workflow_id: workflowId,
    html_url: `https://github.com/acme/x/actions/runs/${id}`, created_at: isoTime, updated_at: isoTime,
  };
}

test('CiHealthMonitorService — 교차 프로젝트 incident 수렴 / 비수렴 / done 이후 재개시', async (t) => {
  step('Boot NestJS app on test port');
  process.env.CI_MONITOR_ENABLED = 'true';
  process.env.CI_MONITOR_SWEEP_MS = '3600000'; // 스스로 돌지 않는다 — sweep() 을 직접 부른다
  process.env.CI_MONITOR_MIN_RUNS = '3';
  process.env.CI_MONITOR_MIN_AGE_MS = String(6 * 60 * 60_000);
  process.env.CI_MONITOR_REALERT_MS = String(24 * 60 * 60_000);
  process.env.CI_MONITOR_CREATE_TICKET = 'true';
  process.env.GITHUB_TOKEN = 'qa-fake-github-token';

  const { app, modules } = await bootApp({ port: parseInt(process.env.PORT, 10) });
  t.after(() => { void app.close().catch(() => {}); restoreFetch(); });
  const { getDataSourceToken } = modules;
  const ds = app.get(getDataSourceToken());

  const monitorModule = await import(
    'file://' + path.join(DIST_ROOT, 'modules', 'agents', 'ci-health-monitor.service.js')
  );
  const monitor = app.get(monitorModule.CiHealthMonitorService);
  const { ciIncidentDedupeKey } = monitorModule;
  const { TicketService, SYSTEM_ACTOR } = await import(
    'file://' + path.join(DIST_ROOT, 'modules', 'tickets', 'ticket.service.js')
  );
  const ticketService = app.get(TicketService, { strict: false });

  step('Seed workspace + alerts room + 같은 저장소를 보는 프로젝트 2개');
  const ws = await createWorkspace(app, getDataSourceToken, 'ci-converge');
  const roomRepo = ds.getRepository('ChatRoom');
  const room = await roomRepo.save(roomRepo.create({ workspace_id: ws.id, type: 'group', name: 'qa-alerts' }));
  await ds.getRepository('Workspace').update(ws.id, { alerts_chat_room_id: room.id });

  // 프로젝트 default_assignee — 수렴의 목적이 "같은 수정이 두 번 dispatch 되지 않는 것"
  // 이므로, dispatch 표면인 assignee 가 실제로 한 티켓에만 붙는지까지 본다.
  const agent = await createAgent(app, getDataSourceToken, ws.id, { name: 'ci-fixer', runtime: true });

  async function seedProject(name, repoUrl) {
    return createProject(app, getDataSourceToken, ws.id, {
      name, repoUrl, defaultBranch: 'main', defaultAssignee: agent.runtime_spec,
    });
  }

  const projectA = await seedProject('ci-converge-A', 'https://github.com/acme/converge');
  const projectB = await seedProject('ci-converge-B', 'https://github.com/acme/converge');

  const NOW = new Date();
  const minutesAgo = (m) => new Date(NOW.getTime() - m * 60_000).toISOString();
  const CONVERGE_WF = '1101';
  const OTHER_WF = '1102';
  const SOLO_WF = '2201';

  const redRuns = (wf, base) => [
    run(`${base}3`, 'failure', minutesAgo(5), wf),
    run(`${base}2`, 'failure', minutesAgo(15), wf),
    run(`${base}1`, 'failure', minutesAgo(25), wf),
  ];

  const fetchState = {
    repos: {
      'acme/converge': {
        workflows: [{ id: CONVERGE_WF, name: 'CI', path: '.github/workflows/ci.yml', state: 'active' }],
        runsByWorkflow: { [CONVERGE_WF]: redRuns(CONVERGE_WF, '9100') },
      },
    },
  };
  globalThis.fetch = makeFakeGitHubFetch(fetchState);

  const alertRepo = ds.getRepository('CiRedAlert');
  const ticketRepo = ds.getRepository('Ticket');
  const commentRepo = ds.getRepository('Comment');
  const messageRepo = ds.getRepository('ChatRoomMessage');

  const convergeKey = ciIncidentDedupeKey(ws.id, 'acme/converge', 'main', CONVERGE_WF);
  const systemMessages = async () =>
    (await messageRepo.find({ where: { room_id: room.id } })).filter((m) => m.sender_type === 'system');

  let canonicalId = '';
  let reopenedId = '';
  let projectC = null;

  await t.test('1. 같은 workspace 의 두 프로젝트가 같은 repo/branch/workflow 를 감시하면 실행 티켓은 1건이다', async () => {
    const stats = await monitor.sweep(NOW);

    assert.equal(stats.alerts_created, 2, '감시 행은 프로젝트별로 남는다 — 수렴은 티켓 쪽이지 감시 쪽이 아니다');
    assert.equal(stats.tickets_created, 1, '실제로 INSERT 된 incident 티켓은 1건이어야 한다');
    assert.equal(stats.tickets_linked, 1, '나머지 프로젝트는 새 티켓 대신 canonical 을 채택해야 한다');

    const tickets = await ticketRepo.find({ where: { operational_dedupe_key: convergeKey } });
    assert.equal(tickets.length, 1, 'incident 키를 가진 티켓은 정확히 1건');
    const canonical = tickets[0];
    canonicalId = canonical.id;

    // 어느 프로젝트로 filing 됐든 좋다 — 정해진 것은 "한 곳뿐" 이라는 사실이다.
    assert.ok(
      [projectA.id, projectB.id].includes(canonical.project_id),
      'canonical 은 두 프로젝트 중 한쪽에 filing 돼야 한다',
    );

    // 이 workspace 를 통틀어 이 저장소의 CI-red 실행 티켓이 1건뿐이어야 한다 — 예전에는
    // 감시 단위마다 1건씩 2건이 열렸고 그게 이 티켓의 원인이다.
    const wsTickets = await ticketRepo.find({ where: { workspace_id: ws.id } });
    const convergeTickets = wsTickets.filter((tk) => tk.title.includes('acme/converge'));
    assert.equal(convergeTickets.length, 1, '프로젝트 수만큼 실행 티켓이 열리면 안 된다');

    // 관계 — 두 프로젝트의 감시 행이 모두 같은 canonical 을 가리킨다.
    const rows = await alertRepo.find({ where: { repo_full_name: 'acme/converge' } });
    assert.equal(rows.length, 2, '프로젝트별 감시 행 2건');
    assert.deepEqual(
      [...new Set(rows.map((r) => r.created_ticket_id))],
      [canonical.id],
      '두 프로젝트의 감시 행이 모두 같은 canonical 티켓을 가리켜야 한다',
    );

    // 알림 — 프로젝트별로 나가되 둘 다 canonical 을 링크한다(프로젝트별 가시성 유지).
    const msgs = await systemMessages();
    assert.equal(msgs.length, 2, '채팅 알림은 프로젝트별로 나간다 — 수렴이 프로젝트 가시성을 없애면 안 된다');
    for (const m of msgs) {
      assert.ok(m.content.includes(`ticket=${canonical.id}`), '모든 프로젝트의 알림이 canonical 티켓을 링크해야 한다');
    }

    // 채택 사실이 티켓 자체에 남는다 — 지난번에 사람이 손으로 조정해야 했던 정보다.
    const adoption = (await commentRepo.find({ where: { ticket_id: canonical.id } }))
      .filter((c) => c.content.includes('에서도 감지됐습니다'));
    assert.equal(adoption.length, 1, '채택 코멘트는 채택한 프로젝트당 1회');
    const followerName = canonical.project_id === projectA.id ? projectB.name : projectA.name;
    assert.ok(adoption[0].content.includes(followerName), '어느 프로젝트가 채택했는지 코멘트에서 식별 가능해야 한다');

    // dispatch 표면 — project default_assignee 가 이 한 티켓에만 붙는다.
    assert.ok(canonical.assignee_key, 'incident 티켓은 프로젝트 default_assignee 를 받아야 한다');
    const assigned = (await ticketRepo.find({ where: { assignee_key: canonical.assignee_key } }))
      .filter((tk) => tk.title.includes('acme/converge'));
    assert.equal(assigned.length, 1, '같은 수정이 두 티켓에 배정되면 안 된다 — dispatch 는 티켓 단위다');
    assert.equal(assigned[0].id, canonical.id);
  });

  await t.test('2. 다른 저장소의 장애는 합쳐지지 않고 자기 incident 티켓을 받는다', async () => {
    projectC = await seedProject('ci-converge-C', 'https://github.com/acme/solo');
    fetchState.repos['acme/solo'] = {
      workflows: [{ id: SOLO_WF, name: 'CI', path: '.github/workflows/ci.yml', state: 'active' }],
      runsByWorkflow: { [SOLO_WF]: redRuns(SOLO_WF, '9200') },
    };

    const stats = await monitor.sweep(new Date(NOW.getTime() + 1000));
    assert.equal(stats.tickets_created, 1, '다른 저장소는 자기 티켓을 새로 받아야 한다');
    assert.equal(stats.tickets_linked, 0, '다른 저장소가 기존 incident 에 흡수되면 안 된다');

    const soloKey = ciIncidentDedupeKey(ws.id, 'acme/solo', 'main', SOLO_WF);
    const soloTickets = await ticketRepo.find({ where: { operational_dedupe_key: soloKey } });
    assert.equal(soloTickets.length, 1);
    assert.notEqual(soloTickets[0].id, canonicalId, '다른 저장소의 장애가 같은 티켓으로 합쳐지면 안 된다');
    assert.equal(soloTickets[0].project_id, projectC.id);

    const stillOne = await ticketRepo.find({ where: { operational_dedupe_key: convergeKey } });
    assert.equal(stillOne.length, 1, '기존 incident 티켓은 그대로 1건');
  });

  // ─── 리뷰 지적 (ticket 3886473a): red 인 채로 벌어지는 done 전이 ─────────────
  // 여기가 이 티켓의 진짜 상태 전이다. 복구를 먼저 거치면 감시 행이 **삭제되므로**,
  // "연결이 남아 있어서 재평가를 건너뛴다" 는 결함이 가려진다. 아래는 복구 없이 —
  // 즉 두 프로젝트의 `ci_red_alerts` 행이 살아서 끝난 티켓을 가리키는 상태에서 — 더 최신
  // 실패 run 이 도착했을 때를 공개 `sweep()` 으로 본다.

  await t.test('3. 복구 없이 canonical 이 done 으로 옮겨진 뒤 새 실패가 오면, 살아 있는 감시 행이 있어도 새 incident 를 연다 (리뷰 지적)', async () => {
    // 운영자가 하듯 TicketService 로 done 으로 옮긴다 — 모니터가 읽는 것은 티켓의 status 가
    // done 인지 하나뿐이다. CI 는 건드리지 않는다: 여전히 red 다.
    await ticketService.move(canonicalId, 'done', SYSTEM_ACTOR);

    // 사전 조건 — 복구가 없었으므로 두 프로젝트의 감시 행이 그대로 살아 있고, 둘 다 이제
    // 끝나 버린 티켓을 가리킨다. 이 상태가 결함이 드러나는 유일한 상태다.
    const before = await alertRepo.find({ where: { repo_full_name: 'acme/converge' } });
    assert.equal(before.length, 2, '사전 조건: 감시 행이 프로젝트별로 살아 있어야 한다');
    assert.deepEqual(
      [...new Set(before.map((r) => r.created_ticket_id))], [canonicalId],
      '사전 조건: 두 행 모두 방금 done 으로 옮긴 티켓을 가리켜야 한다',
    );

    // 더 최신 실패 run 이 추가된다 — 복구 신호는 없다.
    const laterMinutesAgo = (m) => new Date(NOW.getTime() + 600_000 - m * 60_000).toISOString();
    fetchState.repos['acme/converge'].runsByWorkflow[CONVERGE_WF] = [
      run('93003', 'failure', laterMinutesAgo(1), CONVERGE_WF),
      run('93002', 'failure', laterMinutesAgo(2), CONVERGE_WF),
      run('93001', 'failure', laterMinutesAgo(3), CONVERGE_WF),
    ];

    const stats = await monitor.sweep(new Date(NOW.getTime() + 660_000));
    assert.equal(stats.recovered, 0, '이 전이는 CI 가 red 인 채로 벌어진다 — 복구가 끼면 시나리오가 공허해진다');
    assert.equal(stats.tickets_created, 1, 'done 으로 끝난 티켓을 재사용하지 않고 새 티켓을 열어야 한다');
    assert.equal(stats.tickets_linked, 1, '나머지 프로젝트는 그 새 티켓을 채택한다 — 수렴은 유지된다');

    const holder = await ticketRepo.findOne({ where: { operational_dedupe_key: convergeKey } });
    assert.ok(holder, '새 incident 가 키를 들고 있어야 한다');
    assert.notEqual(holder.id, canonicalId, '끝난 canonical 을 재사용하면 안 된다');
    reopenedId = holder.id;

    const oldCanonical = await ticketRepo.findOne({ where: { id: canonicalId } });
    assert.equal(oldCanonical.status, 'done', '끝난 티켓은 done 에 그대로 남는다');
    assert.equal(oldCanonical.operational_dedupe_key, null, '끝난 티켓은 incident 키를 반납해야 한다');

    // 두 프로젝트의 감시 행이 **재연결**돼야 한다 — 하나라도 옛 Done 티켓을 계속 가리키면
    // 그 프로젝트의 새 실패는 영영 아무도 보지 않는 티켓에 매달린다.
    const rows = await alertRepo.find({ where: { repo_full_name: 'acme/converge' } });
    assert.equal(rows.length, 2, '감시 행은 그대로 프로젝트별 2건');
    assert.deepEqual(
      [...new Set(rows.map((r) => r.created_ticket_id))], [holder.id],
      '두 프로젝트 모두 새 canonical 로 재연결돼야 한다',
    );

    // 새 canonical 에도 교차 프로젝트 채택 기록이 남는다.
    const adoption = (await commentRepo.find({ where: { ticket_id: holder.id } }))
      .filter((c) => c.content.includes('에서도 감지됐습니다'));
    assert.equal(adoption.length, 1, '채택 코멘트는 채택한 프로젝트당 1회');

    // dispatch 표면 — 열린 실행 티켓은 여전히 1건이다(새 incident 도 프로젝트마다 열리지 않는다).
    const openConverge = (await ticketRepo.find({ where: { workspace_id: ws.id } }))
      .filter((tk) => tk.title.includes('acme/converge') && tk.status !== 'done');
    assert.equal(openConverge.length, 1, '열린 실행 티켓은 1건이어야 한다');
    assert.equal(openConverge[0].id, holder.id);
  });

  await t.test('4. 그 뒤 CI 가 복구되면 감시 행이 프로젝트별로 모두 삭제되고, 복구 코멘트는 incident 당 1회만 남는다', async () => {
    const recoveredRun = run('93009', 'success', new Date(NOW.getTime() + 720_000).toISOString(), CONVERGE_WF);
    fetchState.repos['acme/converge'].runsByWorkflow[CONVERGE_WF] = [
      recoveredRun,
      run('93003', 'failure', new Date(NOW.getTime() + 540_000).toISOString(), CONVERGE_WF),
    ];

    const stats = await monitor.sweep(new Date(NOW.getTime() + 780_000));
    assert.equal(stats.recovered, 2, '두 프로젝트가 각각 복구를 인지한다');
    assert.equal(
      (await alertRepo.find({ where: { repo_full_name: 'acme/converge' } })).length, 0,
      '복구 시 감시 행은 프로젝트별로 모두 삭제된다',
    );

    const recoveryComments = (await commentRepo.find({ where: { ticket_id: reopenedId } }))
      .filter((c) => c.content.includes('CI가 복구됐습니다'));
    assert.equal(recoveryComments.length, 1, '복구 코멘트는 incident 당 1회 — 프로젝트마다 쌓이면 안 된다');

    // 이미 done 으로 보낸 옛 티켓에는 이 incident 의 복구 코멘트가 가면 안 된다 —
    // 그 티켓을 가리키는 감시 행은 3번에서 이미 사라졌다.
    const staleComments = (await commentRepo.find({ where: { ticket_id: canonicalId } }))
      .filter((c) => c.content.includes('CI가 복구됐습니다'));
    assert.equal(staleComments.length, 0, '끝난 옛 티켓에 복구 코멘트가 붙으면 안 된다');
  });

  await t.test('5. 같은 저장소라도 workflow 가 다르면 별개 incident 다', async () => {
    const currentHolder = await ticketRepo.findOne({ where: { operational_dedupe_key: convergeKey } });
    fetchState.repos['acme/converge'].workflows = [
      { id: CONVERGE_WF, name: 'CI', path: '.github/workflows/ci.yml', state: 'active' },
      { id: OTHER_WF, name: 'Publish', path: '.github/workflows/publish.yml', state: 'active' },
    ];
    const publishAt = (m) => new Date(NOW.getTime() + 840_000 - m * 60_000).toISOString();
    fetchState.repos['acme/converge'].runsByWorkflow[OTHER_WF] = [
      run('94003', 'failure', publishAt(1), OTHER_WF),
      run('94002', 'failure', publishAt(2), OTHER_WF),
      run('94001', 'failure', publishAt(3), OTHER_WF),
    ];

    const stats = await monitor.sweep(new Date(NOW.getTime() + 900_000));
    assert.equal(stats.tickets_created, 1, '새 workflow 의 장애는 자기 티켓을 새로 받아야 한다');
    assert.equal(stats.tickets_linked, 1, '그 새 incident 도 두 프로젝트에 걸쳐 1건으로 수렴한다');

    const otherKey = ciIncidentDedupeKey(ws.id, 'acme/converge', 'main', OTHER_WF);
    const otherTickets = await ticketRepo.find({ where: { operational_dedupe_key: otherKey } });
    assert.equal(otherTickets.length, 1);
    assert.notEqual(otherTickets[0].id, currentHolder.id, '다른 workflow 의 장애가 같은 티켓으로 합쳐지면 안 된다');

    const sameKeyTickets = await ticketRepo.find({ where: { operational_dedupe_key: convergeKey } });
    assert.equal(sameKeyTickets.length, 1, '기존 workflow 의 incident 는 영향받지 않는다');
    assert.equal(sameKeyTickets[0].id, currentHolder.id);
  });
});

test.after?.(() => exitAfterTests(0));
process.on('beforeExit', () => exitAfterTests(0));
