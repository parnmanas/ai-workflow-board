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
import { Agent } from '../dist/entities/Agent.js';
import { Workspace } from '../dist/entities/Workspace.js';
// 엔티티 전체를 등록한다. Workspace→Board→BoardColumn→Ticket→Comment… 로
// 역참조 관계가 줄줄이 이어져 부분 집합으로는 metadata 빌드가 통과하지 않고,
// run-budget 가드가 Workspace 행을 진짜로 읽어야 해서 스텁으로 대체할 수도 없다.
import * as ALL_ENTITIES from '../dist/entities/index.js';
import { ActionsService } from '../dist/modules/actions/actions.service.js';
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
      'chat_room_participants', 'chat_room_messages', 'action_runs',
      'chat_rooms', 'actions', 'agents', 'workspaces',
    ]) {
      await dataSource.query(`DELETE FROM "${table}"`);
    }

    const agentRepo = dataSource.getRepository(Agent);
    await agentRepo.save([
      agentRepo.create({ id: MGR_1, name: 'rolf', workspace_id: WS, manager_agent_id: null }),
      agentRepo.create({ id: MGR_2, name: 'ragnar', workspace_id: WS, manager_agent_id: null }),
      agentRepo.create({ id: AGENT_A, name: 'deployer', workspace_id: WS, manager_agent_id: MGR_1 }),
      agentRepo.create({ id: AGENT_B, name: 'deployer', workspace_id: WS, manager_agent_id: MGR_2 }),
      agentRepo.create({ id: AGENT_C, name: 'other', workspace_id: 'ws-other', manager_agent_id: null }),
    ]);

    const realRunRepo = dataSource.getRepository(ActionRun);
    // run 저장만 대상별로 실패시킬 수 있는 얇은 프록시 — dispatch 의 per-agent
    // try/catch 가 진짜로 그 한 명만 격리하는지 보려면 _dispatchOne 안쪽에서
    // 실패해야 한다.
    const runRepoProxy = new Proxy(realRunRepo, {
      get(target, prop, receiver) {
        if (prop === 'save') {
          return async (entity) => {
            if (failRunSaveFor && entity?.agent_id === failRunSaveFor) {
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
      sendMessage: async (roomId, workspaceId, senderType, senderId, senderName, content, _a, _b, _t, extra) => {
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
      dataSource.getRepository(Agent),         // agentRepo
      inertRepo(),                             // boardRepo
      dataSource.getRepository(Workspace),     // workspaceRepo
      inertRepo(),                             // userRepo
      commentRepo,                             // commentRepo
      inertRepo(),                             // activityRepo
      // Ticket 엔티티는 BoardColumn 관계(Ticket#column)를 끌고 오므로 이
      // 스위트에 등록하지 않는다. dispatch 가 티켓에서 읽는 것은 워크스페이스
      // 경계 검사용 findOne 하나뿐이라 스텁으로 충분하다.
      { findOne: async ({ where }) => tickets.get(where.id) ?? null }, // ticketRepo
      inertRepo(),                             // columnRepo
      dataSource,                              // dataSource
      {},                                      // membership
      messaging,                               // messaging
      logService,                              // logService
    );
  });

  // ── 1. 대상 저장 ────────────────────────────────────────────────────────

  it('2개 이상의 대상 에이전트를 저장하고, 레거시 단일 컬럼은 첫 원소를 미러링한다', async () => {
    const created = await service.create({
      workspace_id: WS,
      name: 'CLI 최신화',
      target_agent_ids: [AGENT_A, AGENT_B],
    });
    assert.deepEqual(actionTargetAgentIds(created), [AGENT_A, AGENT_B]);
    assert.equal(created.target_agent_id, AGENT_A, '레거시 컬럼은 대표 대상을 담아야 한다');

    const reloaded = await service.get(created.id);
    assert.deepEqual(actionTargetAgentIds(reloaded), [AGENT_A, AGENT_B], 'DB 왕복 후에도 유지');
  });

  it('레거시 단일 필드만 줘도 생성되고 배열 표현으로 수렴한다 (하위 호환)', async () => {
    const created = await service.create({ workspace_id: WS, name: '단일', target_agent_id: AGENT_A });
    assert.deepEqual(actionTargetAgentIds(created), [AGENT_A]);
    assert.equal(created.target_agent_id, AGENT_A);
  });

  it('대상 중 하나라도 타 워크스페이스면 저장 전체를 거부한다', async () => {
    await assert.rejects(
      service.create({ workspace_id: WS, name: 'bad', target_agent_ids: [AGENT_A, AGENT_C] }),
      /different workspace/,
    );
    assert.equal(await dataSource.getRepository(Action).count(), 0, '부분 저장이 남으면 안 된다');
  });

  it('update 로 대상을 늘리면 두 컬럼이 함께 갱신된다', async () => {
    const created = await service.create({ workspace_id: WS, name: 'x', target_agent_id: AGENT_B });
    const updated = await service.update(created.id, WS, { target_agent_ids: [AGENT_A, AGENT_B] });
    assert.deepEqual(actionTargetAgentIds(updated), [AGENT_A, AGENT_B]);
    assert.equal(updated.target_agent_id, AGENT_A, '대표 대상 미러가 stale 하면 레거시 독자가 지워진 대상을 본다');
  });

  it('대상을 0개로 만드는 update 는 거부된다', async () => {
    const created = await service.create({ workspace_id: WS, name: 'x', target_agent_id: AGENT_A });
    await assert.rejects(service.update(created.id, WS, { target_agent_ids: [] }), /at least one target/);
  });

  it('REST 로 내보내는 형태는 JSON 문자열이 아니라 진짜 배열이다', async () => {
    const created = await service.create({
      workspace_id: WS, name: 'x', target_agent_ids: [AGENT_A, AGENT_B],
    });
    // 엔티티 자체는 JSON 문자열을 들고 있다 (SQLite/Postgres 패리티 관례).
    assert.equal(typeof created.target_agent_ids, 'string');
    // 그대로 res.json() 하면 클라이언트가 배열 대신 '["a","b"]' 를 받아
    // .filter 호출 시 화면이 터진다 — 모든 REST 읽기 경로가 이 정규화를 탄다.
    const wire = actionToWireJson(created);
    assert.ok(Array.isArray(wire.target_agent_ids));
    assert.deepEqual(wire.target_agent_ids, [AGENT_A, AGENT_B]);
    assert.equal(wire.target_agent_id, AGENT_A, '레거시 키도 대표 대상으로 정규화된다');
  });

  it('REST 정규화는 배열이 빈 레거시 행도 단일 대상 배열로 채운다', () => {
    const wire = actionToWireJson({ target_agent_id: AGENT_B, target_agent_ids: '[]' });
    assert.deepEqual(wire.target_agent_ids, [AGENT_B]);
  });

  it('actions.controller 의 모든 Action 읽기 경로가 정규화를 통과한다', () => {
    // awb-field-wiring 이 경고하는 "한 셀만 빠뜨림" 회귀 가드 — 새 읽기 경로를
    // 추가하면서 정규화를 빼먹으면 여기서 걸린다.
    const src = readFileSync(
      new URL('../src/modules/actions/actions.controller.ts', import.meta.url),
      'utf8',
    );
    const actionReads = [
      'const rows = await this.actionsService.list(workspaceId);',
      'const row = await this.actionsService.get(id);',
      'const row = await this.actionsService.create(body);',
      'const row = await this.actionsService.update(id, body?.workspace_id, body);',
    ];
    for (const read of actionReads) {
      const idx = src.indexOf(read);
      assert.ok(idx > -1, `읽기 경로가 사라졌다(테스트를 갱신할 것): ${read}`);
      // 그 직후 응답 구문이 actionToWireJson 을 거쳐야 한다.
      const after = src.slice(idx, idx + 400);
      assert.match(after, /actionToWireJson/, `정규화를 거치지 않는 읽기 경로: ${read}`);
    }
  });

  it('workspace-move 는 다중 대상을 두 컬럼 모두 복사하고, 비대표 대상도 경고 대상으로 잡는다', () => {
    // 정적 가드 — 이 두 곳은 fan-out 이전 형태(단일 컬럼 매칭)로 되돌아가기 쉬운
    // 지점이고, 되돌아가면 (1) 복사된 Action 이 조용히 대상 1개로 줄고
    // (2) 대표가 아닌 대상으로 걸린 에이전트의 cross-workspace 경고가 사라진다.
    const src = readFileSync(
      new URL('../src/services/workspace-move.service.ts', import.meta.url),
      'utf8',
    );
    const copyBlock = src.slice(src.indexOf('copy ws-level action'), src.indexOf('copy ws-level action') + 1200);
    assert.match(copyBlock, /target_agent_ids: src\.target_agent_ids/, 'Action 복사가 대상 배열을 빠뜨렸다');

    const warnBlock = src.slice(src.indexOf('warnForeignAgentActions'));
    assert.match(
      warnBlock.slice(0, 2000),
      /actionTargetAgentIds\(a\)\.includes\(agent\.id\)/,
      'cross-workspace 경고가 대표 대상만 보고 있다 — 비대표 대상이 누락된다',
    );
    assert.doesNotMatch(
      warnBlock.slice(0, 2000),
      /find\(\{ where: \{ target_agent_id: agent\.id \} \}\)/,
      '컬럼 매칭으로 되돌아가면 다중 대상 Action 이 안 잡힌다',
    );
  });

  // ── 2. fan-out 실행 ─────────────────────────────────────────────────────

  it('실행 1회가 대상 수만큼 run 을 만들고 각 run 이 자기 방을 쓴다', async () => {
    const action = await service.create({
      workspace_id: WS, name: 'CLI 최신화', prompt: 'upgrade', target_agent_ids: [AGENT_A, AGENT_B],
    });

    const result = await service.dispatch({ actionId: action.id, triggeredByType: 'system', triggeredById: '' });

    assert.equal(result.runs.length, 2, '대상 수만큼 run 이 생겨야 한다');
    assert.equal(result.failures.length, 0);
    assert.deepEqual(result.runs.map((r) => r.agent_id), [AGENT_A, AGENT_B]);

    const roomIds = new Set(result.runs.map((r) => r.room_id));
    assert.equal(roomIds.size, 2, '각 run 은 독립된 방을 가져야 한다');

    const rows = await dataSource.getRepository(ActionRun).find({ where: { action_id: action.id } });
    assert.equal(rows.length, 2);
    assert.equal(new Set(rows.map((r) => r.batch_id)).size, 1, '같은 트리거의 run 은 한 배치');
    assert.ok(rows.every((r) => r.batch_id), 'batch_id 가 비어 있으면 배치 판정이 불가능하다');
    assert.deepEqual(rows.map((r) => r.agent_id).sort(), [AGENT_A, AGENT_B].sort());

    assert.equal(sent.length, 2, '대상마다 첫 메시지가 각자의 방으로 나가야 한다');
  });

  it('하위 호환: 반환값의 run/room_id/prompt 는 첫 run 을 가리킨다', async () => {
    const action = await service.create({ workspace_id: WS, name: 'x', target_agent_ids: [AGENT_A, AGENT_B] });
    const result = await service.dispatch({ actionId: action.id, triggeredByType: 'system', triggeredById: '' });
    assert.equal(result.run.id, result.runs[0].run.id);
    assert.equal(result.room_id, result.runs[0].room_id);
    assert.equal(result.prompt, result.runs[0].prompt);
  });

  it('회귀: 단일 대상 Action 은 예전과 같이 run 1건 + 방 1개만 만든다', async () => {
    const action = await service.create({ workspace_id: WS, name: '단일', target_agent_id: AGENT_A });
    const result = await service.dispatch({ actionId: action.id, triggeredByType: 'system', triggeredById: '' });

    assert.equal(result.runs.length, 1);
    assert.equal(result.failures.length, 0);
    assert.equal(result.run.agent_id, AGENT_A);
    assert.equal(await dataSource.getRepository(ChatRoom).count(), 1);
  });

  it('회귀: target_agent_ids 가 비어 있는 레거시 행도 단일 대상으로 정상 실행된다', async () => {
    // 마이그레이션 백필이 아직 돌지 않은 DB 를 재현한다 — create() 를 우회해
    // 배열 컬럼을 '[]' 로 둔 행을 직접 넣는다.
    const repo = dataSource.getRepository(Action);
    const legacy = await repo.save(repo.create({
      workspace_id: WS, name: 'legacy', prompt: 'p',
      target_agent_id: AGENT_B, target_agent_ids: '[]',
    }));
    assert.deepEqual(actionTargetAgentIds(legacy), [AGENT_B], '읽기 경로가 레거시 컬럼으로 폴백해야 한다');

    const result = await service.dispatch({ actionId: legacy.id, triggeredByType: 'system', triggeredById: '' });
    assert.equal(result.runs.length, 1);
    assert.equal(result.run.agent_id, AGENT_B);
  });

  // ── 3. 부분 실패 격리 ───────────────────────────────────────────────────

  it('한 대상이 실패해도 나머지 대상의 run 은 정상 생성된다', async () => {
    const action = await service.create({
      workspace_id: WS, name: 'x', target_agent_ids: [AGENT_A, AGENT_B],
    });
    failRunSaveFor = AGENT_A; // 첫 대상이 죽어도 뒤가 이어져야 한다

    const result = await service.dispatch({ actionId: action.id, triggeredByType: 'system', triggeredById: '' });

    assert.equal(result.runs.length, 1);
    assert.equal(result.runs[0].agent_id, AGENT_B);
    assert.equal(result.failures.length, 1);
    assert.equal(result.failures[0].agent_id, AGENT_A);
    assert.match(result.failures[0].error, /injected run-save failure/);
    // 하위 호환 키는 살아남은 run 을 가리킨다.
    assert.equal(result.run.agent_id, AGENT_B);
  });

  it('전원 실패면 던진다 — 호출부의 "디스패치 실패는 throw" 계약을 유지한다', async () => {
    const action = await service.create({ workspace_id: WS, name: 'x', target_agent_id: AGENT_A });
    failRunSaveFor = AGENT_A;
    await assert.rejects(
      service.dispatch({ actionId: action.id, triggeredByType: 'system', triggeredById: '' }),
      /injected run-save failure/,
    );
  });

  // ── 4. 작업폴더 분리 ────────────────────────────────────────────────────

  it('같은 매니저 아래 2개 에이전트로 fan-out 해도 작업폴더가 겹치지 않는다', async () => {
    const action = await service.create({
      workspace_id: WS, name: 'x', target_agent_ids: [AGENT_A, AGENT_B],
    });
    await service.dispatch({ actionId: action.id, triggeredByType: 'system', triggeredById: '' });

    const folders = sent.map((s) => s.runProvision?.workspace_folder);
    assert.equal(folders.length, 2);
    assert.ok(folders.every(Boolean), 'run provision 이 작업폴더를 실어야 한다');
    assert.equal(new Set(folders).size, 2, `fan-out 대상이 같은 체크아웃을 공유하면 안 된다: ${folders.join(', ')}`);
    assert.ok(folders.every((f) => f.startsWith('.awb/act/')), 'act 루트는 유지되어야 한다');
  });

  it('회귀: 단일 대상 Action 의 작업폴더는 글자 하나 바뀌지 않는다 (warm checkout 보존)', async () => {
    const action = await service.create({ workspace_id: WS, name: 'x', target_agent_id: AGENT_A });
    await service.dispatch({ actionId: action.id, triggeredByType: 'system', triggeredById: '' });
    assert.equal(sent[0].runProvision.workspace_folder, `.awb/act/${action.id.slice(0, 8)}`);
  });

  it('명시적 workspace_folder 도 fan-out 시에만 에이전트별로 갈라진다', async () => {
    const single = await service.create({
      workspace_id: WS, name: 's', target_agent_id: AGENT_A, workspace_folder: 'ops/cli',
    });
    await service.dispatch({ actionId: single.id, triggeredByType: 'system', triggeredById: '' });
    assert.equal(sent[0].runProvision.workspace_folder, '.awb/act/ops/cli', '단일 대상은 그대로');

    sent = [];
    const multi = await service.create({
      workspace_id: WS, name: 'm', target_agent_ids: [AGENT_A, AGENT_B], workspace_folder: 'ops/cli',
    });
    await service.dispatch({ actionId: multi.id, triggeredByType: 'system', triggeredById: '' });
    const folders = sent.map((s) => s.runProvision.workspace_folder);
    assert.equal(new Set(folders).size, 2);
    // 마지막 세그먼트에만 접미사가 붙어 경로 모양이 보존된다.
    assert.ok(folders.every((f) => f.startsWith('.awb/act/ops/cli-')), folders.join(', '));
  });

  // ── 5. 배치 재개 게이트 ─────────────────────────────────────────────────

  function seedTicket(id) {
    tickets.set(id, { id, workspace_id: WS, title: 't' });
    return id;
  }

  it('source_ticket_id 가 있으면 전원 종료 뒤 한 번만 재개한다', async () => {
    const ticketId = seedTicket('44444444-4444-4444-8444-444444444444');
    const action = await service.create({ workspace_id: WS, name: 'x', target_agent_ids: [AGENT_A, AGENT_B] });
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
      workspace_id: WS, name: 'deploy', target_agent_ids: [AGENT_A, AGENT_B], high_impact: true,
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
      workspace_id: WS, name: 'deploy', target_agent_ids: [AGENT_A, AGENT_B], high_impact: true,
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
      workspace_id: WS, name: 'deploy', target_agent_id: AGENT_A, high_impact: true,
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
    const action = await service.create({ workspace_id: WS, name: 'x', target_agent_id: AGENT_A });
    const runRepo = dataSource.getRepository(ActionRun);
    const legacyRun = await runRepo.save(runRepo.create({
      action_id: action.id, workspace_id: WS, room_id: 'room-legacy',
      source_ticket_id: ticketId, status: 'running', attempt: 1,
      agent_id: '', batch_id: '',
    }));
    const done = await service.completeRun(legacyRun.id, WS, { status: 'succeeded', summary: 'ok' });
    assert.equal(done.shouldResume, true);
  });

  // ── 6. 재시도 대상 한정 ─────────────────────────────────────────────────

  it('실패한 대상만 재시도되고 원래 배치를 승계한다', async () => {
    const ticketId = seedTicket('99999999-9999-4999-8999-999999999999');
    const action = await service.create({ workspace_id: WS, name: 'x', target_agent_ids: [AGENT_A, AGENT_B] });
    const result = await service.dispatch({
      actionId: action.id, triggeredByType: 'agent', triggeredById: AGENT_A, sourceTicketId: ticketId,
    });
    const failing = result.runs.find((r) => r.agent_id === AGENT_A);

    const outcome = await service.completeRun(failing.run.id, WS, { status: 'failed', summary: 'boom' });
    assert.equal(outcome.retried, true, 'high_impact 아닌 Action 은 자동 재시도한다');

    const runRepo = dataSource.getRepository(ActionRun);
    const retry = await runRepo.findOne({ where: { id: outcome.retryRunId } });
    assert.equal(retry.agent_id, AGENT_A, '재시도가 배치 전체를 다시 돌리면 성공한 대상에서 작업이 두 번 실행된다');
    assert.equal(retry.batch_id, failing.run.batch_id, '새 배치로 떨어지면 원래 배치가 전원 종료로 보인다');
    assert.equal(retry.attempt, 2);
    assert.equal(retry.idempotency_key, failing.run.idempotency_key, '재시도 체인은 키를 공유해야 대상이 dedupe 할 수 있다');

    // AGENT_B 는 재시도로 새 run 을 얻지 않는다.
    const bRuns = await runRepo.find({ where: { action_id: action.id, agent_id: AGENT_B } });
    assert.equal(bRuns.length, 1);
  });

  it('재시도가 떠 있는 동안 배치는 미완으로 취급된다', async () => {
    const ticketId = seedTicket('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
    const action = await service.create({ workspace_id: WS, name: 'x', target_agent_ids: [AGENT_A, AGENT_B] });
    const result = await service.dispatch({
      actionId: action.id, triggeredByType: 'agent', triggeredById: AGENT_A, sourceTicketId: ticketId,
    });
    const a = result.runs.find((r) => r.agent_id === AGENT_A);
    const b = result.runs.find((r) => r.agent_id === AGENT_B);

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

  // ── 7. 예산 ─────────────────────────────────────────────────────────────

  it('예산은 run 단위로 소모된다 — fan-out 이 상한을 넘어서 계속 만들지 않는다', async () => {
    const wsRepo = dataSource.getRepository(Workspace);
    await wsRepo.save(wsRepo.create({
      id: WS, name: 'ws',
      // text 컬럼이라 JSON 문자열로 넣는다 (common/hard-budget-config.ts 가 파싱).
      hard_budget_config: JSON.stringify({ enabled: true, max_runs_per_window: 2, notify: false }),
    }));
    const action = await service.create({
      workspace_id: WS, name: 'x', target_agent_ids: [AGENT_A, AGENT_B],
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
    const wsRepo = dataSource.getRepository(Workspace);
    await wsRepo.save(wsRepo.create({
      id: WS, name: 'ws',
      hard_budget_config: JSON.stringify({ enabled: true, max_runs_per_window: 1, notify: false }),
    }));
    const action = await service.create({
      workspace_id: WS, name: 'x', target_agent_ids: [AGENT_A, AGENT_B],
    });

    const result = await service.dispatch({ actionId: action.id, triggeredByType: 'system', triggeredById: '' });
    assert.equal(result.runs.length, 1, '첫 대상만 예산 안에 들어간다');
    assert.equal(result.failures.length, 1);
    assert.equal(result.failures[0].agent_id, AGENT_B);
    assert.match(result.failures[0].error, /run budget exceeded/);
  });

  // ── 8. 프루닝 ───────────────────────────────────────────────────────────

  it('max_runs 프루닝은 에이전트별로 적용된다', async () => {
    const action = await service.create({
      workspace_id: WS, name: 'x', target_agent_ids: [AGENT_A, AGENT_B], max_runs: 2,
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
    const aRuns = await runRepo.count({ where: { action_id: action.id, agent_id: AGENT_A } });
    const bRuns = await runRepo.count({ where: { action_id: action.id, agent_id: AGENT_B } });
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
