// Action fan-out — 다중 에이전트 대상 (티켓 fc3906c5).
//
// 한 Action 이 N개 에이전트를 대상으로 가질 수 있고, 트리거 1회가 대상마다
// 독립적인 ActionRun 을 만든다. 이 스위트는 티켓의 완료 기준을 그대로 케이스로
// 옮긴다:
//
//   1. 2개 이상의 대상을 저장할 수 있다 (+ 레거시 단일 필드와의 상호 변환).
//   2. 실행 1회가 대상 수만큼 run 을 만들고 각자 다른 방을 쓴다.
//   3. 한 대상이 실패해도 나머지 run 은 정상 생성된다.
//   4. 기존 단일 대상 Action 은 코드 변경 후에도 그대로 동작한다(회귀).
//   5. 같은 매니저 아래 2개 에이전트로 fan-out 해도 작업폴더가 충돌하지 않는다.
//   6. source_ticket_id 가 있으면 전원 종료 뒤 한 번만 재개하고, 부분 실패를
//      요약에 명시한다.
//   7. 재시도는 실패한 그 에이전트만 다시 돌리고 원래 배치를 승계한다.
//   8. 예산은 run 단위로 소모된다.
//
// 실제 sql.js DataSource 위에서 production ActionsService 를 돌린다 — 방/run/
// 참여자 저장과 배치 조회가 전부 진짜 쿼리를 타야 "run 이 몇 건 생겼나" 같은
// 단언이 의미를 갖는다.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, before, beforeEach, describe, it } from 'node:test';
import { DataSource } from 'typeorm';
import { Action } from '../dist/entities/Action.js';
import { ActionRun } from '../dist/entities/ActionRun.js';
import { ChatRoom } from '../dist/entities/ChatRoom.js';
import { ChatRoomParticipant } from '../dist/entities/ChatRoomParticipant.js';
import { RuntimeHost } from '../dist/entities/RuntimeHost.js';
import { ApiKey } from '../dist/entities/ApiKey.js';
import { runtimeIdentityKey } from '../dist/common/runtime-spec.js';
import { Account } from '../dist/entities/Account.js';
// 엔티티 전체를 등록한다. 엔티티 간 역참조 관계가 줄줄이 이어져 부분
// 집합으로는 metadata 빌드가 통과하지 않고,
// run-budget 가드가 Account 행을 진짜로 읽어야 해서 스텁으로 대체할 수도 없다.
import * as ALL_ENTITIES from '../dist/entities/index.js';
import { ActionsService } from '../dist/modules/actions/actions.service.js';
import { ActionsController } from '../dist/modules/actions/actions.controller.js';
import {
  actionTargetAgentIds,
  actionToWireJson,
  agentScopedWorkspaceFolder,
  normalizeTargetAgentIds,
} from '../dist/common/action-targets.js';

const WS = 'ws-fanout';
// 두 매니저 아래 **같은 leaf 이름**('deployer')을 가진 에이전트 두 개 — 이
// 티켓이 겨냥하는 "모든 매니저 호스트에서 같은 작업" 형상이자, bare name 으로는
// 구분이 불가능해 `<Manager>/<Agent>` 계약이 실제로 필요한 상황이다.
const MGR_1 = 'aaaaaaa1-0000-4000-8000-000000000001';
const MGR_2 = 'aaaaaaa2-0000-4000-8000-000000000002';
const AGENT_A = '11111111-1111-4111-8111-111111111111';
const AGENT_B = '22222222-2222-4222-8222-222222222222';
const AGENT_C = '33333333-3333-4333-8333-333333333333';

// P4c-4: dispatch 는 저장된 target_runtimes 스냅샷에서만 해소한다.
// uuid 타겟은 스냅샷이 없어 missing 취급(삭제된 대상과 동일)이다.
const SPECA = {
  manager_agent_id: MGR_1, cli: 'hermes', model: null, working_dir: '/srv/a',
  credential_id: null, label: 'deployer-a', role_prompt: '',
  runtime_config: { strategy: 'single', permission_mode: 'strict' },
};
const SPECB = {
  manager_agent_id: MGR_2, cli: 'hermes', model: null, working_dir: '/srv/b',
  credential_id: null, label: 'deployer-b', role_prompt: '',
  runtime_config: { strategy: 'single', permission_mode: 'strict' },
};
const KEYA = runtimeIdentityKey(SPECA);
const KEYB = runtimeIdentityKey(SPECB);

/** 아무것도 하지 않는 저장소 스텁 — 이 스위트가 검증하지 않는 부수 효과용. */
function inertRepo() {
  const rows = [];
  return {
    rows,
    create: (v) => ({ ...v }),
    save: async (v) => { rows.push(v); return v; },
    find: async () => [],
    findOne: async () => null,
    delete: async () => ({ affected: 0 }),
    update: async () => ({ affected: 0 }),
  };
}

describe('Action fan-out (다중 에이전트 대상)', () => {
  let dataSource;
  let service;
  let sent;          // messaging.sendMessage 호출 캡처
  let comments;      // 티켓에 남긴 코멘트 캡처
  let failRunSaveFor; // 이 agent_id 의 run 저장을 실패시킨다(대상별 실패 주입)
  let tickets;       // 소스 티켓 스텁 저장소 (id -> row)

  before(async () => {
    dataSource = new DataSource({
      type: 'sqljs',
      entities: Object.values(ALL_ENTITIES).filter((e) => typeof e === 'function'),
      synchronize: true,
      logging: false,
    });
    await dataSource.initialize();
  });

  after(async () => {
    if (dataSource?.isInitialized) await dataSource.destroy();
  });

  beforeEach(async () => {
    sent = [];
    comments = [];
    failRunSaveFor = null;
    tickets = new Map();

    // FK 순서대로 자식부터 지운다 — repo.clear() 는 TRUNCATE 성격이라
    // chat_room_participants 가 chat_rooms 를 참조하는 상태에서 실패한다.
    for (const table of [
      // P4c-4: agents 테이블 없음. api_keys 는 링크 시드 때문에 매번 비운다.
      'chat_room_participants', 'chat_room_messages', 'action_runs',
      'chat_rooms', 'actions', 'api_keys', 'accounts',
    ]) {
      await dataSource.query(`DELETE FROM "${table}"`);
    }

    // P4c-4: MGR_* 는 Host 행, AGENT_* 는 api_keys 페어링 링크다.
    // AGENT_C 의 링크는 ws-other 소속이라 cross-workspace 거부 계약을 탄다.
    const hostRepo = dataSource.getRepository(RuntimeHost);
    await hostRepo.save([
      hostRepo.create({ id: MGR_1, name: 'rolf', hostname: 'rolf', account_id: WS }),
      hostRepo.create({ id: MGR_2, name: 'ragnar', hostname: 'ragnar', account_id: WS }),
    ]);
    const keyRepo = dataSource.getRepository(ApiKey);
    // key/key_prefix 는 NOT NULL 이라 더미 해시를 넣는다 (해석은 agent_id/host_id 만 본다).
    const link = (name, agent_id, host_id, account_id) =>
      keyRepo.create({ name, key: `hash-${name}`, key_prefix: 'test***', agent_id, host_id, scope: 'full', account_id });
    await keyRepo.save([
      link('link-a', AGENT_A, MGR_1, WS),
      link('link-b', AGENT_B, MGR_2, WS),
      link('link-c', AGENT_C, MGR_1, 'ws-other'),
    ]);

    const realRunRepo = dataSource.getRepository(ActionRun);
    // run 저장만 대상별로 실패시킬 수 있는 얇은 프록시 — dispatch 의 per-agent
    // try/catch 가 진짜로 그 한 명만 격리하는지 보려면 _dispatchOne 안쪽에서
    // 실패해야 한다.
    const runRepoProxy = new Proxy(realRunRepo, {
      get(target, prop, receiver) {
        if (prop === 'save') {
          return async (entity) => {
            // 디스패치 경로의 run 삽입(status='running')만 실패시킨다.
            // 실패 대상을 기록하는 감사 행(status='failed')까지 막으면 DB 전체가
            // 죽은 상황을 흉내내는 셈이라, 검증하려는 "디스패치 실패" 시나리오와
            // 다르다 — 그 경우 감사 행 기록은 의도적으로 best-effort 다.
            const isDispatchInsert = (entity?.status ?? 'running') === 'running';
            if (failRunSaveFor && entity?.agent_id === failRunSaveFor && isDispatchInsert) {
              throw new Error(`injected run-save failure for ${entity.agent_id}`);
            }
            return realRunRepo.save(entity);
          };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });

    const commentRepo = {
      create: (v) => ({ ...v }),
      save: async (v) => { comments.push(v); return v; },
    };
    const messaging = {
      sendMessage: async (roomId, accountId, senderType, senderId, senderName, content, _a, _b, _t, extra) => {
        sent.push({ roomId, content, runProvision: extra?.runProvision ?? null });
      },
      sendSystemMessage: async () => {},
    };
    const logService = { info() {}, warn() {}, error() {}, debug() {} };

    service = new ActionsService(
      dataSource.getRepository(Action),        // actionRepo
      runRepoProxy,                            // runRepo
      inertRepo(),                             // approvalRepo
      dataSource.getRepository(ChatRoom),      // roomRepo
      dataSource.getRepository(ChatRoomParticipant), // participantRepo
      inertRepo(),                             // messageRepo
      inertRepo(),                             // attachmentRepo
      dataSource.getRepository(RuntimeHost),   // hostRepo (P4c-4: agentRepo 삭제)
      dataSource.getRepository(Account),     // accountRepo
      inertRepo(),                             // userRepo
      commentRepo,                             // commentRepo
      inertRepo(),                             // activityRepo
      // dispatch 가 티켓에서 읽는 것은 워크스페이스 경계 검사용 findOne
      // 하나뿐이라, 소스 티켓은 스텁 Map 으로 둔다 (행 전체를 심을 필요 없음).
      { findOne: async ({ where }) => tickets.get(where.id) ?? null, update: async () => ({ affected: 1 }) }, // ticketRepo
      dataSource,                              // dataSource
      {},                                      // membership
      messaging,                               // messaging
      logService,                              // logService
      { getInWorkspace: async () => null },    // projects (훅 경로 전용)
    );
  });

  // ── 1. 대상 저장 ────────────────────────────────────────────────────────

  it('2개 이상의 대상 에이전트를 저장하고, 레거시 단일 컬럼은 첫 원소를 미러링한다', async () => {
    const created = await service.create({
      account_id: WS,
      name: 'CLI 최신화',
      target_runtimes: [SPECA, SPECB],
    });
    assert.deepEqual(actionTargetAgentIds(created), [KEYA, KEYB]);
    assert.equal(created.target_agent_id, KEYA, '레거시 컬럼은 대표 대상을 담아야 한다');

    const reloaded = await service.get(created.id);
    assert.deepEqual(actionTargetAgentIds(reloaded), [KEYA, KEYB], 'DB 왕복 후에도 유지');
  });

  it('단일 Runtime 설정도 생성되고 배열 표현으로 수렴한다', async () => {
    const created = await service.create({ account_id: WS, name: '단일', target_runtimes: [SPECA] });
    assert.deepEqual(actionTargetAgentIds(created), [KEYA]);
    assert.equal(created.target_agent_id, KEYA);
  });

  it('대상 중 하나라도 Host가 없으면 저장 전체를 거부한다', async () => {
    await assert.rejects(
      service.create({ account_id: WS, name: 'bad', target_runtimes: [SPECA, { ...SPECB, manager_agent_id: 'missing-host' }] }),
      /unknown Runtime Host/,
    );
    assert.equal(await dataSource.getRepository(Action).count(), 0, '부분 저장이 남으면 안 된다');
  });

  it('update 로 대상을 늘리면 두 컬럼이 함께 갱신된다', async () => {
    const created = await service.create({ account_id: WS, name: 'x', target_runtimes: [SPECB] });
    const updated = await service.update(created.id, WS, { target_runtimes: [SPECA, SPECB] });
    assert.deepEqual(actionTargetAgentIds(updated), [KEYA, KEYB]);
    assert.equal(updated.target_agent_id, KEYA, '대표 대상 미러가 stale 하면 레거시 독자가 지워진 대상을 본다');
  });

  it('대상을 0개로 만드는 update 는 거부된다', async () => {
    const created = await service.create({ account_id: WS, name: 'x', target_runtimes: [SPECA] });
    await assert.rejects(service.update(created.id, WS, { target_runtimes: [] }), /at least one target/);
  });

  it('REST 로 내보내는 형태는 JSON 문자열이 아니라 진짜 배열이다', async () => {
    const created = await service.create({
      account_id: WS, name: 'x', target_runtimes: [SPECA, SPECB],
    });
    // 엔티티 자체는 JSON 문자열을 들고 있다 (SQLite/Postgres 패리티 관례).
    assert.equal(typeof created.target_agent_ids, 'string');
    // 그대로 res.json() 하면 클라이언트가 배열 대신 '["a","b"]' 를 받아
    // .filter 호출 시 화면이 터진다 — 모든 REST 읽기 경로가 이 정규화를 탄다.
    const wire = actionToWireJson(created);
    assert.ok(Array.isArray(wire.target_agent_ids));
    assert.deepEqual(wire.target_agent_ids, [KEYA, KEYB]);
    assert.equal(wire.target_agent_id, KEYA, '레거시 키도 대표 대상으로 정규화된다');
  });

  it('REST 정규화는 배열이 빈 레거시 행도 단일 대상 배열로 채운다', () => {
    const wire = actionToWireJson({ target_agent_id: AGENT_B, target_agent_ids: '[]' });
    assert.deepEqual(wire.target_agent_ids, [AGENT_B]);
  });

  it('actions.controller 의 모든 Action 읽기 경로가 정규화를 통과한다', async () => {
    const controller = new ActionsController(service, {});
    const responses = [];
    const res = { status() { return this; }, json(body) { responses.push(body); return this; } };
    await controller.create({ account_id: WS, name: 'wire', target_runtimes: [SPECA, SPECB] }, res);
    const created = responses.pop();
    assert.deepEqual(created.target_agent_ids, [KEYA, KEYB]);
    await controller.get(created.id, res);
    assert.deepEqual(responses.pop().target_agent_ids, [KEYA, KEYB]);
    await controller.list(WS, res, { accessibleAccountIds: [WS] });
    assert.deepEqual(responses.pop().map(row => row.target_agent_ids), [[KEYA, KEYB]]);
    await controller.update(created.id, { account_id: WS, target_runtimes: [SPECB] }, res);
    assert.deepEqual(responses.pop().target_agent_ids, [KEYB]);
  });

  it('예약 실행과 on_ticket_done 훅이 같은 dispatch() 를 거쳐 fan-out 을 상속한다', () => {
    // 두 트리거는 대상 순회를 스스로 하지 않고 dispatch() 에 위임한다 — 그래서
    // fan-out 이 자동으로 적용된다. 어느 한쪽이 자체 경로로 갈라지면 그 트리거만
    // 조용히 단일 대상으로 되돌아가므로 호출 형태를 고정한다.
    //
    // 예약 경로는 ActionSchedulerService 가 아니라 WorkspaceScheduleService 다 —
    // Action 의 cron 이 Account Schedule 로 옮겨 갔다(docs/automation-schedules.md).
    // 그 파일은 인라인 프롬프트 형태 때문에 방을 만드는 코드도 함께 갖고 있으므로,
    // Action 발화 함수(`#dispatchAction`) 안만 떼어 본다.
    const scheduleSrc = readFileSync(
      new URL('../src/modules/automation-schedule/automation-schedule.service.ts', import.meta.url),
      'utf8',
    );
    const start = scheduleSrc.indexOf('private async _dispatchAction(');
    assert.ok(start > -1, 'Action 발화 함수를 찾지 못했다 — 이름이 바뀌었으면 이 가드도 따라가야 한다');
    const actionDispatch = scheduleSrc.slice(start, scheduleSrc.indexOf('private async _dispatch(', start));
    assert.match(
      actionDispatch,
      /await this\.actions\.dispatch\(\{/,
      '예약 실행이 ActionsService.dispatch() 를 거치지 않는다 — fan-out 을 상속하지 못한다',
    );
    assert.doesNotMatch(
      actionDispatch,
      /roomRepo\.save\(|participantRepo\.save\(|messaging\.sendMessage\(/,
      '예약 실행이 방을 직접 만들고 있다 — ActionRun 기록·batch·승인 게이트가 예약 실행에서만 빠진다',
    );

    const hookRel = '../src/modules/actions/on-ticket-done-action.service.ts';
    const hookSrc = readFileSync(new URL(hookRel, import.meta.url), 'utf8');
    assert.match(
      hookSrc,
      /await this\.actionsService\.dispatch\(\{/,
      `${hookRel} 이 actionsService.dispatch() 를 거치지 않는다 — fan-out 을 상속하지 못한다`,
    );
    assert.doesNotMatch(
      hookSrc,
      /roomRepo\.save\(|runRepo\.save\(/,
      `${hookRel} 이 run/방을 직접 만들고 있다 — dispatch() 우회는 fan-out 과 예산 가드를 모두 건너뛴다`,
    );
  });

  it('MCP run_action 응답이 레거시 키와 신규 배치 키를 모두 싣는다', () => {
    const src = readFileSync(
      new URL('../src/modules/mcp/tools/action-tools.ts', import.meta.url),
      'utf8',
    );
    const runActionIdx = src.indexOf("'run_action'");
    assert.ok(runActionIdx > -1, 'run_action 도구를 찾지 못했다');
    const block = src.slice(runActionIdx, src.indexOf("'complete_action_run'"));
    // 하위 호환 키 — 이게 빠지면 기존 에이전트 호출자가 run 을 못 찾는다.
    for (const legacy of ['run_id: result.run.id', 'room_id: result.room_id', 'prompt: result.prompt']) {
      assert.ok(block.includes(legacy), `run_action 이 하위 호환 키를 잃었다: ${legacy}`);
    }
    // 신규 배치 키.
    for (const added of ['batch_id: result.batch_id', 'runs: result.runs.map', 'failures: result.failures']) {
      assert.ok(block.includes(added), `run_action 이 fan-out 필드를 노출하지 않는다: ${added}`);
    }
  });

  it('MCP list_action_runs 가 에이전트 표시명과 배치 키를 노출한다', () => {
    const src = readFileSync(
      new URL('../src/modules/mcp/tools/action-tools.ts', import.meta.url),
      'utf8',
    );
    const idx = src.indexOf("'list_action_runs'");
    assert.ok(idx > -1, 'list_action_runs 도구를 찾지 못했다');
    const block = src.slice(idx, idx + 3000);
    for (const field of ['agent_id:', 'agent_name:', 'batch_id:']) {
      assert.ok(block.includes(field), `list_action_runs 프로젝션에 ${field} 가 없다`);
    }
    // 표시명은 반드시 해석기를 거쳐야 한다 — bare name 은 같은 leaf 이름을 쓰는
    // 두 호스트를 구분하지 못해 이 티켓의 감사 요구사항 자체를 못 채운다.
    assert.match(
      block,
      /resolveAgentDisplayNamesByIds/,
      'agent_name 이 <Manager>/<Agent> 해석기를 거치지 않는다',
    );
  });

  // ── 2. fan-out 실행 ─────────────────────────────────────────────────────

  it('실행 1회가 대상 수만큼 run 을 만들고 각 run 이 자기 방을 쓴다', async () => {
    const action = await service.create({
      account_id: WS, name: 'CLI 최신화', prompt: 'upgrade', target_runtimes: [SPECA, SPECB],
    });

    const result = await service.dispatch({ actionId: action.id, triggeredByType: 'system', triggeredById: '' });

    assert.equal(result.runs.length, 2, '대상 수만큼 run 이 생겨야 한다');
    assert.equal(result.failures.length, 0);
    assert.deepEqual(result.runs.map((r) => r.agent_id), [KEYA, KEYB]);

    const roomIds = new Set(result.runs.map((r) => r.room_id));
    assert.equal(roomIds.size, 2, '각 run 은 독립된 방을 가져야 한다');

    const rows = await dataSource.getRepository(ActionRun).find({ where: { action_id: action.id } });
    assert.equal(rows.length, 2);
    assert.equal(new Set(rows.map((r) => r.batch_id)).size, 1, '같은 트리거의 run 은 한 배치');
    assert.ok(rows.every((r) => r.batch_id), 'batch_id 가 비어 있으면 배치 판정이 불가능하다');
    assert.deepEqual(rows.map((r) => r.agent_id).sort(), [KEYA, KEYB].sort());

    assert.equal(sent.length, 2, '대상마다 첫 메시지가 각자의 방으로 나가야 한다');
  });

  it('하위 호환: 반환값의 run/room_id/prompt 는 첫 run 을 가리킨다', async () => {
    const action = await service.create({ account_id: WS, name: 'x', target_runtimes: [SPECA, SPECB] });
    const result = await service.dispatch({ actionId: action.id, triggeredByType: 'system', triggeredById: '' });
    assert.equal(result.run.id, result.runs[0].run.id);
    assert.equal(result.room_id, result.runs[0].room_id);
    assert.equal(result.prompt, result.runs[0].prompt);
  });

  it('회귀: 단일 대상 Action 은 예전과 같이 run 1건 + 방 1개만 만든다', async () => {
    const action = await service.create({ account_id: WS, name: '단일', target_runtimes: [SPECA] });
    const result = await service.dispatch({ actionId: action.id, triggeredByType: 'system', triggeredById: '' });

    assert.equal(result.runs.length, 1);
    assert.equal(result.failures.length, 0);
    assert.equal(result.run.agent_id, KEYA);
    assert.equal(await dataSource.getRepository(ChatRoom).count(), 1);
  });

  it('회귀: target_agent_ids 가 비어 있는 레거시 행도 단일 대상으로 정상 실행된다', async () => {
    // 마이그레이션 백필이 아직 돌지 않은 DB 를 재현한다 — create() 를 우회해
    // 배열 컬럼을 '[]' 로 둔 행을 직접 넣는다. P4c-4: dispatch 는 spec
    // 스냅샷에서 해소하므로 스냅샷도 함께 둔다.
    const repo = dataSource.getRepository(Action);
    const legacy = await repo.save(repo.create({
      account_id: WS, name: 'legacy', prompt: 'p',
      target_agent_id: KEYB, target_agent_ids: '[]', target_runtimes: [SPECB],
    }));
    assert.deepEqual(actionTargetAgentIds(legacy), [KEYB], '읽기 경로가 레거시 컬럼으로 폴백해야 한다');

    const result = await service.dispatch({ actionId: legacy.id, triggeredByType: 'system', triggeredById: '' });
    assert.equal(result.runs.length, 1);
    assert.equal(result.run.agent_id, KEYB);
  });

  // ── 3. 부분 실패 격리 ───────────────────────────────────────────────────

  it('한 대상이 실패해도 나머지 대상의 run 은 정상 생성된다', async () => {
    const action = await service.create({
      account_id: WS, name: 'x', target_runtimes: [SPECA, SPECB],
    });
    failRunSaveFor = KEYA; // P4c-4: run 의 agent_id 는 rt 키다 // 첫 대상이 죽어도 뒤가 이어져야 한다

    const result = await service.dispatch({ actionId: action.id, triggeredByType: 'system', triggeredById: '' });

    assert.equal(result.runs.length, 1);
    assert.equal(result.runs[0].agent_id, KEYB);
    assert.equal(result.failures.length, 1);
    assert.equal(result.failures[0].agent_id, KEYA);
    assert.match(result.failures[0].error, /injected run-save failure/);
    // 하위 호환 키는 살아남은 run 을 가리킨다.
    assert.equal(result.run.agent_id, KEYB);
  });

  it('전원 실패면 던진다 — 호출부의 "디스패치 실패는 throw" 계약을 유지한다', async () => {
    const action = await service.create({ account_id: WS, name: 'x', target_runtimes: [SPECA] });
    failRunSaveFor = KEYA; // P4c-4: run 의 agent_id 는 rt 키다
    await assert.rejects(
      service.dispatch({ actionId: action.id, triggeredByType: 'system', triggeredById: '' }),
      /injected run-save failure/,
    );
  });

  // ── 4. 작업폴더 분리 ────────────────────────────────────────────────────

  it('같은 매니저 아래 2개 에이전트로 fan-out 해도 작업폴더가 겹치지 않는다', async () => {
    const action = await service.create({
      account_id: WS, name: 'x', target_runtimes: [SPECA, SPECB],
    });
    await service.dispatch({ actionId: action.id, triggeredByType: 'system', triggeredById: '' });

    const folders = sent.map((s) => s.runProvision?.workspace_folder);
    assert.equal(folders.length, 2);
    assert.ok(folders.every(Boolean), 'run provision 이 작업폴더를 실어야 한다');
    assert.equal(new Set(folders).size, 2, `fan-out 대상이 같은 체크아웃을 공유하면 안 된다: ${folders.join(', ')}`);
    assert.ok(folders.every((f) => f.startsWith('.awb/act/')), 'act 루트는 유지되어야 한다');
  });

  it('회귀: 단일 대상 Action 의 작업폴더는 글자 하나 바뀌지 않는다 (warm checkout 보존)', async () => {
    const action = await service.create({ account_id: WS, name: 'x', target_runtimes: [SPECA] });
    await service.dispatch({ actionId: action.id, triggeredByType: 'system', triggeredById: '' });
    assert.equal(sent[0].runProvision.workspace_folder, `.awb/act/${action.id.slice(0, 8)}`);
  });

  it('명시적 workspace_folder 도 fan-out 시에만 에이전트별로 갈라진다', async () => {
    const single = await service.create({
      account_id: WS, name: 's', target_runtimes: [SPECA], workspace_folder: 'ops/cli',
    });
    await service.dispatch({ actionId: single.id, triggeredByType: 'system', triggeredById: '' });
    assert.equal(sent[0].runProvision.workspace_folder, '.awb/act/ops/cli', '단일 대상은 그대로');

    sent = [];
    const multi = await service.create({
      account_id: WS, name: 'm', target_runtimes: [SPECA, SPECB], workspace_folder: 'ops/cli',
    });
    await service.dispatch({ actionId: multi.id, triggeredByType: 'system', triggeredById: '' });
    const folders = sent.map((s) => s.runProvision.workspace_folder);
    assert.equal(new Set(folders).size, 2);
    // 마지막 세그먼트에만 접미사가 붙어 경로 모양이 보존된다.
    assert.ok(folders.every((f) => f.startsWith('.awb/act/ops/cli-')), folders.join(', '));
  });

  // ── 5. 배치 재개 게이트 ─────────────────────────────────────────────────

  function seedTicket(id) {
    tickets.set(id, { id, account_id: WS, title: 't' });
    return id;
  }

  it('source_ticket_id 가 있으면 전원 종료 뒤 한 번만 재개한다', async () => {
    const ticketId = seedTicket('44444444-4444-4444-8444-444444444444');
    const action = await service.create({ account_id: WS, name: 'x', target_runtimes: [SPECA, SPECB] });
    const result = await service.dispatch({
      actionId: action.id, triggeredByType: 'agent', triggeredById: AGENT_A, sourceTicketId: ticketId,
    });
    const [first, second] = result.runs;

    const r1 = await service.completeRun(first.run.id, WS, { status: 'succeeded', summary: 'A ok' });
    assert.equal(r1.shouldResume, false, '형제 run 이 아직 도는 동안 재개하면 티켓이 여러 번 깨어난다');

    const r2 = await service.completeRun(second.run.id, WS, { status: 'succeeded', summary: 'B ok' });
    assert.equal(r2.shouldResume, true, '마지막 run 이 재개를 책임진다');

    const summary = comments.at(-1).content;
    assert.match(summary, /전체 성공/);
    assert.match(summary, /2개 에이전트/);
  });

  it('부분 실패는 요약에 x/N 로 명시되고 그래도 재개된다', async () => {
    const ticketId = seedTicket('55555555-5555-4555-8555-555555555555');
    // high_impact 면 실패해도 자동 재시도하지 않으므로 배치가 곧장 확정된다.
    const action = await service.create({
      account_id: WS, name: 'deploy', target_runtimes: [SPECA, SPECB], high_impact: true,
    });
    const result = await service.dispatch({
      actionId: action.id, triggeredByType: 'user', triggeredById: 'u1', sourceTicketId: ticketId,
    });
    const [first, second] = result.runs;

    await service.completeRun(first.run.id, WS, { status: 'succeeded', summary: 'A ok' });
    const r2 = await service.completeRun(second.run.id, WS, { status: 'failed', summary: 'B 실패' });

    assert.equal(r2.shouldResume, true);
    const summary = comments.at(-1).content;
    assert.match(summary, /부분 실패 \(1\/2 성공\)/);
    assert.match(summary, /B 실패/);
    // 같은 leaf 이름을 쓰는 두 호스트가 요약에서 구분돼야 한다 — bare name 이면
    // 'deployer' 두 줄이 나와 어느 호스트가 실패했는지 알 수 없다.
    assert.match(summary, /rolf\/deployer/);
    assert.match(summary, /ragnar\/deployer/);
  });

  it('배치 재개는 1회성이다 — 이미 클레임된 배치는 다시 재개하지 않는다', async () => {
    const ticketId = seedTicket('66666666-6666-4666-8666-666666666666');
    const action = await service.create({
      account_id: WS, name: 'deploy', target_runtimes: [SPECA, SPECB], high_impact: true,
    });
    const result = await service.dispatch({
      actionId: action.id, triggeredByType: 'user', triggeredById: 'u1', sourceTicketId: ticketId,
    });

    await service.completeRun(result.runs[0].run.id, WS, { status: 'succeeded' });
    const claimer = await service.completeRun(result.runs[1].run.id, WS, { status: 'succeeded' });
    assert.equal(claimer.shouldResume, true);

    // 이미 terminal 인 run 을 다시 완료해도 재개가 두 번 일어나선 안 된다.
    const dup = await service.completeRun(result.runs[1].run.id, WS, { status: 'succeeded' });
    assert.equal(dup.previouslyCompleted, true);
    assert.equal(dup.shouldResume, false);
  });

  it('회귀: 단일 대상 run 은 배치 로직을 타지 않고 즉시 재개한다', async () => {
    const ticketId = seedTicket('77777777-7777-4777-8777-777777777777');
    const action = await service.create({
      account_id: WS, name: 'deploy', target_runtimes: [SPECA], high_impact: true,
    });
    const result = await service.dispatch({
      actionId: action.id, triggeredByType: 'user', triggeredById: 'u1', sourceTicketId: ticketId,
    });
    const done = await service.completeRun(result.run.id, WS, { status: 'succeeded', summary: 'ok' });
    assert.equal(done.shouldResume, true);
    assert.match(comments.at(-1).content, /Resuming this ticket/);
  });

  it('batch_id 가 없는 레거시 run 도 즉시 재개한다', async () => {
    const ticketId = seedTicket('88888888-8888-4888-8888-888888888888');
    const action = await service.create({ account_id: WS, name: 'x', target_runtimes: [SPECA] });
    const runRepo = dataSource.getRepository(ActionRun);
    const legacyRun = await runRepo.save(runRepo.create({
      action_id: action.id, account_id: WS, room_id: 'room-legacy',
      source_ticket_id: ticketId, status: 'running', attempt: 1,
      agent_id: '', batch_id: '',
    }));
    const done = await service.completeRun(legacyRun.id, WS, { status: 'succeeded', summary: 'ok' });
    assert.equal(done.shouldResume, true);
  });

  // ── 6. 재시도 대상 한정 ─────────────────────────────────────────────────

  it('실패한 대상만 재시도되고 원래 배치를 승계한다', async () => {
    const ticketId = seedTicket('99999999-9999-4999-8999-999999999999');
    const action = await service.create({ account_id: WS, name: 'x', target_runtimes: [SPECA, SPECB] });
    const result = await service.dispatch({
      actionId: action.id, triggeredByType: 'agent', triggeredById: AGENT_A, sourceTicketId: ticketId,
    });
    const failing = result.runs.find((r) => r.agent_id === KEYA);

    const outcome = await service.completeRun(failing.run.id, WS, { status: 'failed', summary: 'boom' });
    assert.equal(outcome.retried, true, 'high_impact 아닌 Action 은 자동 재시도한다');

    const runRepo = dataSource.getRepository(ActionRun);
    const retry = await runRepo.findOne({ where: { id: outcome.retryRunId } });
    assert.equal(retry.agent_id, KEYA, '재시도가 배치 전체를 다시 돌리면 성공한 대상에서 작업이 두 번 실행된다');
    assert.equal(retry.batch_id, failing.run.batch_id, '새 배치로 떨어지면 원래 배치가 전원 종료로 보인다');
    assert.equal(retry.attempt, 2);
    assert.equal(retry.idempotency_key, failing.run.idempotency_key, '재시도 체인은 키를 공유해야 대상이 dedupe 할 수 있다');

    // AGENT_B 는 재시도로 새 run 을 얻지 않는다.
    const bRuns = await runRepo.find({ where: { action_id: action.id, agent_id: KEYB } });
    assert.equal(bRuns.length, 1);
  });

  it('재시도가 떠 있는 동안 배치는 미완으로 취급된다', async () => {
    const ticketId = seedTicket('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
    const action = await service.create({ account_id: WS, name: 'x', target_runtimes: [SPECA, SPECB] });
    const result = await service.dispatch({
      actionId: action.id, triggeredByType: 'agent', triggeredById: AGENT_A, sourceTicketId: ticketId,
    });
    const a = result.runs.find((r) => r.agent_id === KEYA);
    const b = result.runs.find((r) => r.agent_id === KEYB);

    const failed = await service.completeRun(a.run.id, WS, { status: 'failed', summary: 'boom' });
    assert.equal(failed.retried, true);

    // B 가 성공해도 A 의 재시도가 아직 도는 중이라 재개하면 안 된다.
    const bDone = await service.completeRun(b.run.id, WS, { status: 'succeeded', summary: 'B ok' });
    assert.equal(bDone.shouldResume, false);

    // A 의 재시도가 끝나야 비로소 재개된다.
    const retryDone = await service.completeRun(failed.retryRunId, WS, { status: 'succeeded', summary: 'A 재시도 ok' });
    assert.equal(retryDone.shouldResume, true);
    const summary = comments.at(-1).content;
    assert.match(summary, /전체 성공/, '에이전트별 최종 결과는 마지막 시도 기준이어야 한다');
    assert.match(summary, /2회 시도/);
  });

  // ── 6b. 리뷰 P1 회귀 ────────────────────────────────────────────────────

  it('P1-1: 재시도 행이 삽입되기 전에 형제가 끝나도 배치가 조기 재개되지 않는다', async () => {
    const ticketId = seedTicket('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
    const action = await service.create({ account_id: WS, name: 'x', target_runtimes: [SPECA, SPECB] });
    const result = await service.dispatch({
      actionId: action.id, triggeredByType: 'agent', triggeredById: AGENT_A, sourceTicketId: ticketId,
    });
    const a = result.runs.find((r) => r.agent_id === KEYA);
    const b = result.runs.find((r) => r.agent_id === KEYB);

    // A 의 실패 처리 도중, 재시도 run 이 저장되기 **직전** 에 B 를 완료시킨다 —
    // 리뷰가 지적한 정확히 그 창이다. dispatch 를 가로채 그 틈을 재현한다.
    const realDispatch = service.dispatch.bind(service);
    let bOutcome = null;
    service.dispatch = async (dispatchArgs) => {
      // 재시도 호출 시점: A 는 이미 failed 로 커밋됐고 재시도 행은 아직 없다.
      bOutcome = await service.completeRun(b.run.id, WS, { status: 'succeeded', summary: 'B ok' });
      return realDispatch(dispatchArgs);
    };
    let aOutcome;
    try {
      aOutcome = await service.completeRun(a.run.id, WS, { status: 'failed', summary: 'A boom' });
    } finally {
      service.dispatch = realDispatch;
    }

    assert.equal(
      bOutcome.shouldResume, false,
      '재시도가 예약된 상태에서 형제 완료가 배치를 끝내면 재시도 결과가 재개에 영영 반영되지 않는다',
    );
    assert.equal(aOutcome.retried, true, 'A 는 재시도되어야 한다');

    // 재시도가 끝나야 비로소 재개된다 — 그리고 그 재개는 A 의 최종 결과를 담는다.
    const retryDone = await service.completeRun(aOutcome.retryRunId, WS, { status: 'succeeded', summary: 'A 재시도 ok' });
    assert.equal(retryDone.shouldResume, true, '마지막 run 이 재개를 책임져야 한다');
    assert.match(comments.at(-1).content, /전체 성공/);
  });

  it('P1-1: 재시도가 아예 못 뜨면 예약이 풀려 배치가 종료된다', async () => {
    const ticketId = seedTicket('cccccccc-cccc-4ccc-8ccc-cccccccccccc');
    const action = await service.create({ account_id: WS, name: 'x', target_runtimes: [SPECA, SPECB] });
    const result = await service.dispatch({
      actionId: action.id, triggeredByType: 'agent', triggeredById: AGENT_A, sourceTicketId: ticketId,
    });
    const a = result.runs.find((r) => r.agent_id === KEYA);
    const b = result.runs.find((r) => r.agent_id === KEYB);

    await service.completeRun(b.run.id, WS, { status: 'succeeded', summary: 'B ok' });

    // 재시도 디스패치가 실패하는 상황(예: Action 이 그 사이 삭제됨)을 주입한다.
    const realDispatch = service.dispatch.bind(service);
    service.dispatch = async () => { throw new Error('injected retry dispatch failure'); };
    let aOutcome;
    try {
      aOutcome = await service.completeRun(a.run.id, WS, { status: 'failed', summary: 'A boom' });
    } finally {
      service.dispatch = realDispatch;
    }

    assert.equal(aOutcome.retried, false);
    assert.equal(aOutcome.exhausted, true);
    assert.equal(aOutcome.shouldResume, true, '예약이 안 풀리면 배치가 영영 미완으로 남는다');

    const rows = await dataSource.getRepository(ActionRun).find({ where: { batch_id: a.run.batch_id } });
    assert.ok(rows.every((r) => r.retry_pending === false), 'retry_pending 이 남아 있으면 안 된다');
  });

  it('P1-2: 디스패치에 실패한 대상도 terminal ActionRun 으로 남는다', async () => {
    const action = await service.create({
      account_id: WS, name: 'x', target_runtimes: [SPECA, SPECB],
    });
    failRunSaveFor = KEYA; // P4c-4: run 의 agent_id 는 rt 키다

    const result = await service.dispatch({ actionId: action.id, triggeredByType: 'system', triggeredById: '' });
    assert.equal(result.runs.length, 1);
    assert.equal(result.failures.length, 1);

    const rows = await dataSource.getRepository(ActionRun).find({ where: { action_id: action.id } });
    assert.equal(rows.length, 2, '실패 대상이 DB 에 없으면 이력이 부분 실패를 "전체 성공" 으로 집계한다');

    const failed = rows.find((r) => r.agent_id === KEYA);
    assert.ok(failed, '실패 대상의 run 행이 없다');
    assert.equal(failed.status, 'failed');
    assert.equal(failed.batch_id, result.batch_id, '실패 행도 같은 배치에 속해야 x/N 분모가 맞는다');
    assert.equal(failed.room_id, null, '방이 만들어지기 전에 끝났으므로 room_id 는 null');
    assert.ok(failed.completed_at, 'terminal 행이므로 completed_at 이 있어야 한다');
    assert.match(failed.result_summary, /dispatch failed/);
  });

  // P4c-4: dispatch 는 저장된 spec 스냅샷에서만 해소한다 — "사라진 대상"은
  // 스냅샷에서 spec 이 빠진 상태다 (target_agent_ids 에는 키가 남아 있다).
  async function stripSpecs(actionId, keepSpecs) {
    await dataSource.getRepository(Action).update({ id: actionId }, { target_runtimes: keepSpecs });
  }

  it('대상 설정 하나를 제거하면 남은 Runtime만 실행한다', async () => {
    const action = await service.create({
      account_id: WS, name: 'x', target_runtimes: [SPECA, SPECB],
    });
    // KEYA 의 스냅샷이 사라진 상황을 만든다.
    await stripSpecs(action.id, [SPECB]);

    const result = await service.dispatch({ actionId: action.id, triggeredByType: 'system', triggeredById: '' });

    assert.equal(result.runs.length, 1, '남은 대상은 정상 실행되어야 한다');
    assert.equal(result.runs[0].agent_id, KEYB);
    assert.equal(result.failures.length, 0);

    const rows = await dataSource.getRepository(ActionRun).find({ where: { action_id: action.id } });
    assert.equal(rows.length, 1, '제거한 설정은 새 실행의 대상이 아니다');
  });

  it('P1-2: 대상이 모두 사라졌으면 던진다 (승인 grant 를 태우기 전 fail-fast)', async () => {
    const action = await service.create({ account_id: WS, name: 'x', target_runtimes: [SPECA, SPECB] });
    await stripSpecs(action.id, []);

    await assert.rejects(
      service.dispatch({ actionId: action.id, triggeredByType: 'system', triggeredById: '' }),
      /Action has no target agent set/,
    );
    assert.equal(await dataSource.getRepository(ActionRun).count(), 0, '할 일이 없으면 감사 행도 만들지 않는다');
  });

  it('P1-2: 실패 대상이 배치 재개의 x/N 분모에 포함된다', async () => {
    const ticketId = seedTicket('dddddddd-dddd-4ddd-8ddd-dddddddddddd');
    const action = await service.create({
      account_id: WS, name: 'deploy', target_runtimes: [SPECA, SPECB], high_impact: true,
    });
    failRunSaveFor = KEYA; // P4c-4: run 의 agent_id 는 rt 키다
    const result = await service.dispatch({
      actionId: action.id, triggeredByType: 'user', triggeredById: 'u1', sourceTicketId: ticketId,
    });
    assert.equal(result.runs.length, 1);

    const done = await service.completeRun(result.runs[0].run.id, WS, { status: 'succeeded', summary: 'B ok' });
    assert.equal(done.shouldResume, true);
    const summary = comments.at(-1).content;
    assert.match(summary, /부분 실패 \(1\/2 성공\)/, '실패 대상이 분모에서 빠지면 "전체 성공" 으로 보고된다');
  });

  // ── 7. 예산 ─────────────────────────────────────────────────────────────

  it('예산은 run 단위로 소모된다 — fan-out 이 상한을 넘어서 계속 만들지 않는다', async () => {
    const wsRepo = dataSource.getRepository(Account);
    await wsRepo.save(wsRepo.create({
      id: WS, name: 'ws',
      // text 컬럼이라 JSON 문자열로 넣는다 (common/hard-budget-config.ts 가 파싱).
      hard_budget_config: JSON.stringify({ enabled: true, max_runs_per_window: 2, notify: false }),
    }));
    const action = await service.create({
      account_id: WS, name: 'x', target_runtimes: [SPECA, SPECB],
    });

    // 첫 트리거로 run 2건 — 여기서 상한(2)에 도달한다.
    const first = await service.dispatch({ actionId: action.id, triggeredByType: 'system', triggeredById: '' });
    assert.equal(first.runs.length, 2);

    // 두 번째 트리거는 헤드 체크에서 막힌다.
    await assert.rejects(
      service.dispatch({ actionId: action.id, triggeredByType: 'system', triggeredById: '' }),
      /run budget exceeded/,
    );
    assert.equal(await dataSource.getRepository(ActionRun).count(), 2, '상한을 넘겨 run 이 더 생기면 안 된다');
  });

  it('배치 도중 상한에 걸리면 그 대상만 실패하고 이미 만든 run 은 남는다', async () => {
    const wsRepo = dataSource.getRepository(Account);
    await wsRepo.save(wsRepo.create({
      id: WS, name: 'ws',
      hard_budget_config: JSON.stringify({ enabled: true, max_runs_per_window: 1, notify: false }),
    }));
    const action = await service.create({
      account_id: WS, name: 'x', target_runtimes: [SPECA, SPECB],
    });

    const result = await service.dispatch({ actionId: action.id, triggeredByType: 'system', triggeredById: '' });
    assert.equal(result.runs.length, 1, '첫 대상만 예산 안에 들어간다');
    assert.equal(result.failures.length, 1);
    assert.equal(result.failures[0].agent_id, KEYB);
    assert.match(result.failures[0].error, /run budget exceeded/);
  });

  // ── 8. 프루닝 ───────────────────────────────────────────────────────────

  it('max_runs 프루닝은 에이전트별로 적용된다', async () => {
    const action = await service.create({
      account_id: WS, name: 'x', target_runtimes: [SPECA, SPECB], max_runs: 2,
    });
    // 3회 트리거 → 에이전트당 3건. 상한 2 이므로 에이전트별로 1건씩 잘린다.
    for (let i = 0; i < 3; i++) {
      const r = await service.dispatch({ actionId: action.id, triggeredByType: 'system', triggeredById: '' });
      // 프루닝은 terminal run 만 자르므로 매 라운드 종결시킨다.
      for (const one of r.runs) await service.completeRun(one.run.id, WS, { status: 'succeeded' });
    }
    // 마지막 라운드의 프루닝은 그 라운드 run 이 아직 running 일 때 돌았으므로
    // 한 번 더 트리거해 종결된 이력 위에서 프루닝이 돌게 한다.
    const last = await service.dispatch({ actionId: action.id, triggeredByType: 'system', triggeredById: '' });
    for (const one of last.runs) await service.completeRun(one.run.id, WS, { status: 'succeeded' });

    const runRepo = dataSource.getRepository(ActionRun);
    const aRuns = await runRepo.count({ where: { action_id: action.id, agent_id: KEYA } });
    const bRuns = await runRepo.count({ where: { action_id: action.id, agent_id: KEYB } });
    assert.ok(aRuns >= 2, `A 의 이력이 에이전트별 상한 미만으로 잘리면 안 된다: ${aRuns}`);
    assert.ok(bRuns >= 2, `B 의 이력이 에이전트별 상한 미만으로 잘리면 안 된다: ${bRuns}`);
    // 결정적 판별: action 단위로 셌다면 총합이 max_runs(2)를 넘을 수 없다.
    assert.ok(
      aRuns + bRuns > action.max_runs,
      `프루닝이 여전히 action 단위다 — 총 ${aRuns + bRuns}건은 max_runs=${action.max_runs} 를 넘지 못했다`,
    );
  });
});

// ── 순수 헬퍼 ─────────────────────────────────────────────────────────────

describe('action-targets 순수 헬퍼', () => {
  it('normalizeTargetAgentIds 는 순서를 보존하며 중복/공백을 제거한다', () => {
    assert.deepEqual(normalizeTargetAgentIds(['b', ' a ', 'b', '']), ['b', 'a']);
    assert.deepEqual(normalizeTargetAgentIds('["x","y"]'), ['x', 'y']);
    assert.deepEqual(normalizeTargetAgentIds('not json'), []);
    assert.deepEqual(normalizeTargetAgentIds(null), []);
  });

  it('actionTargetAgentIds 는 배열이 비면 레거시 단일 컬럼으로 폴백한다', () => {
    assert.deepEqual(actionTargetAgentIds({ target_agent_id: 'a', target_agent_ids: '[]' }), ['a']);
    assert.deepEqual(actionTargetAgentIds({ target_agent_id: 'a', target_agent_ids: '["b","c"]' }), ['b', 'c']);
    assert.deepEqual(actionTargetAgentIds({ target_agent_id: '', target_agent_ids: '[]' }), []);
    assert.deepEqual(actionTargetAgentIds(null), []);
  });

  it('agentScopedWorkspaceFolder 는 마지막 세그먼트에만 접미사를 붙인다', () => {
    // 폴더가 비면 action id 앞 8자가 base, agent id 앞 8자가 접미사가 된다.
    assert.equal(agentScopedWorkspaceFolder('', 'action-id-1234', 'agent-id-5678'), 'action-i-agent-id');
    assert.equal(agentScopedWorkspaceFolder('ops/cli', 'a', 'agent-id-5678'), 'ops/cli-agent-id');
    // 경로 이탈 방지는 normalizeWorkspaceFolder 가 이미 담당한다.
    assert.equal(agentScopedWorkspaceFolder('../escape', 'a', 'agentxxxx'), 'escape-agentxxx');
  });
});
