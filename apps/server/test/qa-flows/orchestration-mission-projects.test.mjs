// QA flow: 미션이 project 를 고른다 — 팀 슬롯은 "누가", 미션의 project 는 "어디서".
//
// 팀은 여러 미션에 재사용되는 로스터라 작업 폴더를 들 수 없다. 미션이 project 를 하나
// 이상 고르고, 시작할 때 서버가 슬롯 × project 를 풀어 실행 로스터를 확정한다
// (`OrchestrationMission.runtime_roster`, orchestration-roster.ts): 슬롯의 Host 에 그
// project 의 폴더(ProjectHostFolder — 그 장비의 main clone)가 있으면 그 폴더가 그 슬롯의
// 작업 폴더가 되고, 없으면 그 슬롯은 그 project 를 맡을 수 없다. 이 파일은 그 계약을 실제
// 엔진으로 끝까지 따라간다:
//
//   1. 두 project 미션에서 한 멤버의 Host 에는 project 하나만 있다 — 확정된 로스터, 브리핑,
//      미션 화면이 모두 "누가 어느 project 를 어느 폴더에서" 를 같은 답으로 말한다.
//      오케스트레이터는 자기 Host 에 폴더가 있는 첫 project 에서 돈다(primary 가 아닐 수 있다).
//   2. plan step 은 슬롯 + project 를 지목한다: project 하나뿐인 슬롯은 생략해도 추론되고,
//      Host 에 없는 project 는 그 슬롯이 맡을 수 있는 것을 알려 주며 400, project 가 여럿인
//      슬롯이 생략하면 400. 하나라도 틀리면 계획 전체가 거절된다(반쯤 적용 없음). 디스패치된
//      work order 와 방 참여자의 runtime_spec 은 그 project 의 그 Host 폴더다.
//   3. get_orchestration_mission 이 projects 와 로스터를 돌려준다 — 브리핑을 잃은
//      orchestrator 가 다시 읽는 곳이다.
//   4. create_orchestration_mission 의 "이 팀의 orchestrator 인가" 는 계산된다: orchestrator
//      슬롯이 자기 Host 의 어느 project 폴더에서 돌든 그 팀의 orchestrator 다. 멤버, 그리고
//      project 폴더가 아닌 곳의 같은 CLI 는 403. 이 툴은 projects 와 folder_scope 를 받는다.
//   5. projects·folder_scope 는 브리핑 계약이다 — draft 에서만 고칠 수 있고(검증 포함), 시작
//      뒤에는 409.
//   6. 시작 거절: 어떤 project 의 폴더도 없는 Host 의 멤버(409, 멤버·project 이름 — 그
//      멤버를 빼면 시작된다), project 없는 미션(409), 다른 account 의 project 와 URL 만 있는
//      repo_ref(400).
//   7. shared 미션 둘은 한 체크아웃을 같이 쓰지 못한다 — 진행 중인 shared 미션과 같은
//      (Host, 폴더)에 쓰는 두 번째 shared 미션은 409, isolated 는 시작된다.
//   8. 다시 열기(reopen)는 지금의 팀으로 멤버를 다시 푼다 — 끝난 뒤 슬롯을 고치고 다시 열면
//      재시도된 step 이 고친 슬롯(새 Host 의 그 project 폴더, 새 model)에서 돈다.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { bootApp, exitAfterTests, step } from '../helpers/boot.mjs';
import { createAccount, createApiKey, createProject, registerRuntimeHostKeyFor } from '../helpers/fixtures.mjs';
import { createRuntimeHost, identityIn, slotSpec } from '../helpers/orchestration-team.mjs';
import { McpClient } from '../helpers/mcp-client.mjs';

process.env.PORT = process.env.ORCHESTRATION_MISSION_PROJECTS_PORT || '0';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(__dirname, '..', '..', 'dist');

const HUMAN = { type: 'user', id: 'qa-operator', name: 'QA Operator' };

async function loadServices() {
  const load = async (rel) => import(pathToFileURL(path.join(DIST, ...rel)).href);
  const team = await load(['modules', 'orchestration', 'orchestration-team.service.js']);
  const mission = await load(['modules', 'orchestration', 'orchestration-mission.service.js']);
  const runner = await load(['modules', 'orchestration', 'orchestration-runner.service.js']);
  const commands = await load(['modules', 'agent-manager', 'agent-manager-command.service.js']);
  return {
    OrchestrationTeamService: team.OrchestrationTeamService,
    OrchestrationMissionService: mission.OrchestrationMissionService,
    OrchestrationRunnerService: runner.OrchestrationRunnerService,
    AgentManagerCommandService: commands.AgentManagerCommandService,
  };
}

let shared = null;
async function sharedApp() {
  if (!shared) {
    shared = await bootApp({ port: parseInt(process.env.PORT, 10) });
    shared.services = await loadServices();
    const { app } = shared;
    process.on('exit', () => {
      void app.close().catch(() => {});
    });
  }
  return shared;
}

async function context() {
  const { app, port, modules, services } = await sharedApp();
  const { getDataSourceToken } = modules;
  return {
    app,
    port,
    getDataSourceToken,
    ds: app.get(getDataSourceToken()),
    teams: app.get(services.OrchestrationTeamService),
    missions: app.get(services.OrchestrationMissionService),
    runner: app.get(services.OrchestrationRunnerService),
    commands: app.get(services.AgentManagerCommandService),
  };
}

/**
 * Every test here starts from the same shape — three Runtime Hosts, two
 * projects, one team:
 *
 *   host    slots                        app folder      docs folder
 *   ──────  ───────────────────────────  ──────────────  ─────────────
 *   o       orchestrator (claude)        <root>/o/app    <root>/o/docs
 *   a       builder (claude, opus)       <root>/a/app    <root>/a/docs
 *           reviewer (claude, sonnet)
 *   b       tester (codex)               <root>/b/app    —
 *
 * so on a mission over [app, docs] the builder and the reviewer can take either
 * project — one folder per project on host a, which the two of them share —
 * while the tester can only take `app`: host b has no docs checkout. Folders are
 * keyed by `label`, so scenes never meet in the shared-folder conflict check.
 */
async function buildScene(ctx, label) {
  const { app, getDataSourceToken, teams } = ctx;
  const ws = await createAccount(app, getDataSourceToken, `mission-projects-${label}`);
  const hosts = {
    o: await createRuntimeHost(app, getDataSourceToken, ws.id, { name: `${label}-host-o` }),
    a: await createRuntimeHost(app, getDataSourceToken, ws.id, { name: `${label}-host-a` }),
    b: await createRuntimeHost(app, getDataSourceToken, ws.id, { name: `${label}-host-b` }),
  };
  const root = `/srv/awb-test/mission-projects/${label}`;
  const folders = {
    o: { app: `${root}/o/app`, docs: `${root}/o/docs` },
    a: { app: `${root}/a/app`, docs: `${root}/a/docs` },
    b: { app: `${root}/b/app` },
  };
  const project = {
    app: await createProject(app, getDataSourceToken, ws.id, {
      name: `${label}-app`,
      repoUrl: 'https://github.com/example/app.git',
      hostFolders: [
        { hostId: hosts.o.id, path: folders.o.app },
        { hostId: hosts.a.id, path: folders.a.app },
        { hostId: hosts.b.id, path: folders.b.app },
      ],
    }),
    docs: await createProject(app, getDataSourceToken, ws.id, {
      name: `${label}-docs`,
      repoUrl: 'https://github.com/example/docs.git',
      hostFolders: [
        { hostId: hosts.o.id, path: folders.o.docs },
        { hostId: hosts.a.id, path: folders.a.docs },
      ],
    }),
  };
  const specs = {
    orchestrator: slotSpec(hosts.o.id),
    builder: slotSpec(hosts.a.id, { model: 'opus' }),
    reviewer: slotSpec(hosts.a.id, { model: 'sonnet' }),
    tester: slotSpec(hosts.b.id, { cli: 'codex' }),
  };
  let team = await teams.createTeam({
    account_id: ws.id,
    name: `Projects squad ${label}`,
    created_by: HUMAN.id,
    max_parallel_steps: 4,
    orchestrator: specs.orchestrator,
  });
  for (const role of ['builder', 'reviewer', 'tester']) {
    team = await teams.addMember(team.id, ws.id, { runtime: specs[role], role_label: role, capabilities: `${role} work` });
  }
  return {
    ws,
    hosts,
    root,
    folders,
    project,
    specs,
    team,
    /** role → the team view's member row (`id` is the slot address, `agent_name` is `<Host>/<role>`). */
    slot: Object.fromEntries(team.members.map((m) => [m.role_label, m])),
    /** The orchestrator runs in the first mission project its host has — `app`, on host o. */
    orchestratorId: identityIn(specs.orchestrator, folders.o.app),
  };
}

/** `projects` entries are Project rows or `{ project_id, branch }` refs. */
function newMission(ctx, scene, { title, projects, folderScope = 'shared', ...extra }) {
  return ctx.missions.createMission({
    account_id: scene.ws.id,
    team_id: scene.team.id,
    title,
    objective: `${title} — QA`,
    max_parallel_steps: 4,
    created_by_type: 'user',
    created_by: HUMAN.id,
    projects: projects.map((p) => (p.project_id ? p : { project_id: p.id })),
    folder_scope: folderScope,
    ...extra,
  });
}

const byKey = (steps) => Object.fromEntries(steps.map((s) => [s.step_key, s]));

/** Everything posted into a room, in order — a brief or a work order. */
async function roomText(ds, roomId) {
  if (!roomId) return '';
  const rows = await ds.getRepository('ChatRoomMessage').find({ where: { room_id: roomId }, order: { created_at: 'ASC' } });
  return rows.map((r) => r.content || '').join('\n');
}

/** The work order of a step's latest attempt (one room per attempt). */
async function workOrderFor(ds, step) {
  const fresh = await ds.getRepository('OrchestrationStep').findOne({ where: { id: step.id } });
  return roomText(ds, fresh?.room_id);
}

/** The runtime the dispatch handed the manager: the agent participant's spec in the step's latest room. */
async function participantSpec(ds, step) {
  const fresh = await ds.getRepository('OrchestrationStep').findOne({ where: { id: step.id } });
  const row = await ds.getRepository('ChatRoomParticipant').findOne({
    where: { room_id: fresh?.room_id, participant_type: 'agent' },
  });
  return row?.runtime_spec ?? null;
}

/** One member's entry in the brief's "Your team" list: its `- **name**` line and the indented lines under it. */
function rosterBlock(brief, name) {
  const lines = brief.split('\n');
  const start = lines.findIndex((l) => l.startsWith(`- **${name}**`));
  if (start < 0) return '';
  const out = [lines[start]];
  for (const line of lines.slice(start + 1)) {
    if (!line.startsWith('  - ')) break;
    out.push(line);
  }
  return out.join('\n');
}

/** An MCP session as one execution identity — its runtime key, bound to the host it runs on. */
async function mcpAs(ctx, t, { id, accountId, spec }) {
  await registerRuntimeHostKeyFor(ctx.app, ctx.getDataSourceToken, id, {
    accountId,
    hostId: spec.manager_agent_id,
    runtime: spec,
  });
  const key = await createApiKey(ctx.app, ctx.getDataSourceToken, id, { accountId, label: `mp-${id.slice(3, 11)}` });
  const client = new McpClient({ baseUrl: `http://127.0.0.1:${ctx.port}`, apiKey: key.raw_key });
  t.after(() => {
    void client.close().catch(() => {});
  });
  return client;
}

/**
 * Record every runtime preparation (`provisionSlotIdentity`) — what start and
 * reopen ask the host to bring up — while still letting the helper's
 * VirtualAgent hosts answer it.
 */
function recordPreparation(t, commands) {
  const calls = [];
  const current = commands.provisionSlotIdentity;
  commands.provisionSlotIdentity = (spec, opts) => {
    calls.push({ ...spec, agent_id: identityIn(spec, spec.working_dir), restart: !!opts?.restart });
    return current.call(commands, spec, opts);
  };
  t.after(() => {
    commands.provisionSlotIdentity = current;
  });
  return calls;
}

test('A mission places each slot in every project its host has — the roster, the brief and the mission screen say which, and where', async () => {
  const ctx = await context();
  const scene = await buildScene(ctx, 'roster');
  const { project, folders, hosts, slot } = scene;

  step('Start a mission over [app, docs] — the tester\'s host has only app');
  const mission = await newMission(ctx, scene, { title: 'Two projects', projects: [project.app, project.docs] });
  const started = await ctx.runner.startMission(mission.id, scene.ws.id, HUMAN);
  assert.equal(started.status, 'planning');

  step('The frozen roster: builder and reviewer on both projects, the tester on app only');
  const { runtime_roster: roster } = await ctx.missions.requireMission(mission.id, scene.ws.id);
  const placed = (s) => Object.fromEntries(
    roster.runtimes.filter((r) => r.slot_id === s.id).map((r) => [r.project_id, r.spec.working_dir]),
  );
  assert.deepEqual(placed(slot.builder), { [project.app.id]: folders.a.app, [project.docs.id]: folders.a.docs });
  assert.deepEqual(placed(slot.reviewer), { [project.app.id]: folders.a.app, [project.docs.id]: folders.a.docs });
  assert.deepEqual(placed(slot.tester), { [project.app.id]: folders.b.app },
    'a host without the project\'s folder cannot work on it — the tester gets app only');
  assert.equal(roster.folder_scope, 'shared');

  step('The orchestrator runs in the first project its host has a folder for');
  assert.equal(started.orchestrator_agent_id, scene.orchestratorId);
  assert.equal(started.orchestrator_spec.working_dir, folders.o.app);

  step('Slots that differ only by model are one identity per folder — and another folder is another identity');
  const runtime = (s, p) => roster.runtimes.find((r) => r.slot_id === s.id && r.project_id === p.id);
  assert.equal(runtime(slot.builder, project.app).agent_id, runtime(slot.reviewer, project.app).agent_id);
  assert.equal(runtime(slot.builder, project.app).agent_id, identityIn(scene.specs.builder, folders.a.app));
  assert.notEqual(runtime(slot.builder, project.app).agent_id, runtime(slot.builder, project.docs).agent_id);

  step('The brief lists, per member, the projects it can take and the folder on its host');
  const brief = await roomText(ctx.ds, started.room_id);
  const canWork = (p, folder) => `can work on **${p.name}** (\`${p.id}\`) — its folder on this host: \`${folder}\``;
  const builderBlock = rosterBlock(brief, slot.builder.agent_name);
  assert.ok(builderBlock.includes(`(slot: \`${slot.builder.id}\`)`), `builder entry:\n${builderBlock}`);
  assert.ok(builderBlock.includes(canWork(project.app, folders.a.app)), `builder entry:\n${builderBlock}`);
  assert.ok(builderBlock.includes(canWork(project.docs, folders.a.docs)), `builder entry:\n${builderBlock}`);
  const testerBlock = rosterBlock(brief, slot.tester.agent_name);
  assert.ok(testerBlock.includes(`runs: codex on host **${hosts.b.name}**`), `tester entry:\n${testerBlock}`);
  assert.ok(testerBlock.includes(canWork(project.app, folders.b.app)), `tester entry:\n${testerBlock}`);
  assert.ok(!testerBlock.includes(project.docs.name),
    'the tester must not be offered docs — its host has no docs folder, and the orchestrator plans from this list');

  step('...the projects themselves, and where the orchestrator runs');
  assert.match(brief, /## Projects \(2\)/);
  assert.ok(brief.includes(`- Project id: \`${project.app.id}\``) && brief.includes(`- Project id: \`${project.docs.id}\``));
  assert.ok(brief.includes(`You run on **${hosts.o.name}** in \`${folders.o.app}\` (${project.app.name}).`),
    'the orchestrator is told its own host and folder');

  step('...and who shares which folder on which host');
  for (const folder of [folders.a.app, folders.a.docs]) {
    assert.ok(
      brief.includes(`- \`${folder}\` on **${hosts.a.name}**: ${slot.builder.agent_name}, ${slot.reviewer.agent_name}`),
      `the brief must group the builder and the reviewer in ${folder}`,
    );
  }
  assert.ok(!brief.includes(`- \`${folders.b.app}\` on **`), 'a member alone in its folder is not listed as sharing it');

  step('The mission screen reads the same roster back');
  const detail = await ctx.missions.getMissionDetail(mission.id, scene.ws.id);
  assert.deepEqual(
    detail.projects.map((p) => [p.project_id, p.name]),
    [[project.app.id, project.app.name], [project.docs.id, project.docs.name]],
    'the projects, primary first',
  );
  assert.equal(detail.folder_scope, 'shared');
  assert.equal(detail.roster.orchestrator.working_dir, folders.o.app);
  assert.equal(detail.roster.orchestrator.project_id, project.app.id);
  const testerView = detail.roster.members.find((m) => m.slot_id === slot.tester.id);
  assert.equal(testerView.name, slot.tester.agent_name);
  assert.deepEqual(testerView.projects, [{ project_id: project.app.id, working_dir: folders.b.app }]);
});

test('The orchestrator runs in the first mission project its own host has a folder for', async () => {
  const ctx = await context();
  const scene = await buildScene(ctx, 'orchestrator');
  const { project, root, folders, hosts, slot } = scene;
  // host o 에는 tools 체크아웃이 없다 — primary project 라도 오케스트레이터는 건너뛴다.
  const tools = await createProject(ctx.app, ctx.getDataSourceToken, scene.ws.id, {
    name: 'orchestrator-tools',
    hostFolders: [
      { hostId: hosts.a.id, path: `${root}/a/tools` },
      { hostId: hosts.b.id, path: `${root}/b/tools` },
    ],
  });

  const mission = await newMission(ctx, scene, { title: 'Tools first', projects: [tools, project.app] });
  const started = await ctx.runner.startMission(mission.id, scene.ws.id, HUMAN);
  assert.equal(started.orchestrator_spec.working_dir, folders.o.app,
    'host o has no tools checkout, so the orchestrator runs in the next project it does have');
  assert.equal(started.orchestrator_agent_id, scene.orchestratorId);
  const brief = await roomText(ctx.ds, started.room_id);
  assert.ok(brief.includes(`You run on **${hosts.o.name}** in \`${folders.o.app}\` (${project.app.name}).`));

  step('...while every member still gets each project its own host has, the primary included');
  const { runtime_roster: roster } = await ctx.missions.requireMission(mission.id, scene.ws.id);
  const placed = (s) => Object.fromEntries(
    roster.runtimes.filter((r) => r.slot_id === s.id).map((r) => [r.project_id, r.spec.working_dir]),
  );
  assert.deepEqual(placed(slot.tester), { [tools.id]: `${root}/b/tools`, [project.app.id]: folders.b.app });
  assert.deepEqual(placed(slot.builder), { [tools.id]: `${root}/a/tools`, [project.app.id]: folders.a.app });
});

test('A plan step names a slot and a project — inferred for a one-project slot, refused when the host lacks it or the slot has several', async () => {
  const ctx = await context();
  const scene = await buildScene(ctx, 'plan');
  const { project, folders, hosts, slot, specs } = scene;
  const mission = await newMission(ctx, scene, { title: 'Plan on two projects', projects: [project.app, project.docs] });
  await ctx.runner.startMission(mission.id, scene.ws.id, HUMAN);
  const submit = (steps) => ctx.runner.submitPlan(mission.id, { agentId: scene.orchestratorId }, { steps });
  const work = (key, more) => ({ step_key: key, title: key, instructions: `do ${key}`, ...more });

  step('A step for the tester on docs is refused — and the message says what the tester CAN take');
  await assert.rejects(
    () => submit([work('test-docs', { assignee: slot.tester.id, project: project.docs.id })]),
    (e) => {
      assert.equal(e.status, 400);
      assert.match(e.message, /^step "test-docs": /, 'the message names the step');
      assert.ok(e.message.includes(`${slot.tester.agent_name} cannot work on ${project.docs.name}`), e.message);
      assert.ok(e.message.includes(`can work on: ${project.app.name} (${project.app.id})`), e.message);
      return true;
    },
  );

  step('A step for a two-project slot without a project is refused, asking for one');
  await assert.rejects(
    () => submit([work('build', { assignee: slot.builder.id })]),
    (e) => {
      assert.equal(e.status, 400);
      assert.ok(
        e.message.includes(`${slot.builder.agent_name} can work on more than one of this mission's projects — name the step's project`),
        e.message,
      );
      assert.ok(
        e.message.includes(`${project.app.name} (${project.app.id})`) && e.message.includes(`${project.docs.name} (${project.docs.id})`),
        e.message,
      );
      return true;
    },
  );

  step('A project the mission does not name is refused');
  await assert.rejects(
    () => submit([work('elsewhere', { assignee: slot.builder.id, project: 'not-a-mission-project' })]),
    (e) => {
      assert.equal(e.status, 400);
      assert.match(e.message, /"not-a-mission-project" is not one of this mission's projects/);
      return true;
    },
  );

  step('One bad step rejects the whole submission — nothing is half-applied');
  await assert.rejects(
    () => submit([
      work('fine', { assignee: slot.tester.id }),
      work('bad', { assignee: slot.tester.id, project: project.docs.id }),
    ]),
    (e) => e.status === 400,
  );
  assert.equal((await ctx.missions.listSteps(mission.id)).length, 0, 'the good step was not written either');
  assert.equal((await ctx.missions.requireMission(mission.id)).plan_version, 0, 'and no plan version was spent');

  step('The accepted plan: the tester\'s project is inferred, the builder names docs by name, the reviewer names app by id');
  const plan = await submit([
    work('test-app', { assignee: slot.tester.id }),
    work('write-docs', { assignee: slot.builder.id, project: project.docs.name }),
    work('review-app', { assignee: slot.reviewer.id, project: project.app.id }),
  ]);
  assert.deepEqual([...plan.dispatched].sort(), ['review-app', 'test-app', 'write-docs']);
  const steps = byKey(await ctx.missions.listSteps(mission.id));
  assert.equal(steps['test-app'].project_id, project.app.id, 'a slot that can take one project needs no `project`');
  assert.equal(steps['test-app'].assignee_slot, slot.tester.id);
  assert.equal(steps['test-app'].assignee_agent_id, identityIn(specs.tester, folders.b.app),
    'the step runs as the tester\'s identity in that project\'s folder on its host');
  assert.equal(steps['write-docs'].project_id, project.docs.id, 'an exact project name resolves too');
  assert.equal(steps['write-docs'].assignee_slot, slot.builder.id);
  assert.equal(steps['review-app'].project_id, project.app.id);
  assert.equal(steps['review-app'].assignee_slot, slot.reviewer.id);

  step('Each step runs in its project\'s folder on its assignee\'s host — the runtime the step room hands the manager');
  const expectations = [
    ['test-app', hosts.b, folders.b.app],
    ['write-docs', hosts.a, folders.a.docs],
    ['review-app', hosts.a, folders.a.app],
  ];
  for (const [key, host, folder] of expectations) {
    const spec = await participantSpec(ctx.ds, steps[key]);
    assert.ok(spec, `${key}: the step room must carry the assignee's runtime`);
    assert.equal(spec.manager_agent_id, host.id, `${key}: on the assignee's host`);
    assert.equal(spec.working_dir, folder, `${key}: in that project's folder on that host`);
    assert.equal(spec.folder_scope, 'shared');
    assert.equal(steps[key].assignee_spec.working_dir, folder, `${key}: the step's own snapshot agrees`);
  }

  step('The work order names that folder, the project, and who else works in it');
  const docsOrder = await workOrderFor(ctx.ds, steps['write-docs']);
  assert.ok(docsOrder.includes(`\`${folders.a.docs}\` — your current directory`), docsOrder.slice(0, 800));
  assert.ok(docsOrder.includes(`## Project: ${project.docs.name}`));
  assert.ok(docsOrder.includes(`You are sharing this folder with: ${slot.reviewer.agent_name}`),
    'the reviewer can take docs on host a as well, so it shares that folder');
  const testOrder = await workOrderFor(ctx.ds, steps['test-app']);
  assert.ok(testOrder.includes(`\`${folders.b.app}\` — your current directory`), testOrder.slice(0, 800));
  assert.ok(testOrder.includes(`Main clone on your host (**${hosts.b.name}**): \`${folders.b.app}\``));
  assert.match(testOrder, /No other team member currently shares this folder/);

  step('The legacy assignee_agent_id alias resolves an identity that maps to ONE slot — and refuses one two slots share');
  await submit([work('legacy-test', { assignee_agent_id: identityIn(specs.tester, folders.b.app), depends_on: ['test-app'] })]);
  const legacy = (await ctx.missions.listSteps(mission.id)).find((s) => s.step_key === 'legacy-test');
  assert.equal(legacy.assignee_slot, slot.tester.id);
  assert.equal(legacy.project_id, project.app.id, 'the identity also implies its project');
  await assert.rejects(
    () => submit([work('ambiguous', { assignee_agent_id: identityIn(specs.builder, folders.a.app) })]),
    (e) => {
      assert.equal(e.status, 400);
      assert.match(e.message, /is the execution identity of 2 slots on this roster/,
        'the builder and the reviewer share that identity — picking one of them would be a guess');
      assert.ok(e.message.includes(slot.builder.id) && e.message.includes(slot.reviewer.id),
        'the refusal names both slots so the orchestrator can pick one by slot id');
      return true;
    },
  );
});

test('get_orchestration_mission returns the mission\'s projects and the roster a lost brief would have shown', async (t) => {
  const ctx = await context();
  const scene = await buildScene(ctx, 'mcp');
  const { project, folders, slot, specs } = scene;
  const mission = await newMission(ctx, scene, {
    title: 'Read the roster back',
    projects: [{ project_id: project.app.id }, { project_id: project.docs.id, branch: 'release' }],
  });
  await ctx.runner.startMission(mission.id, scene.ws.id, HUMAN);
  const orchestrator = await mcpAs(ctx, t, {
    id: scene.orchestratorId,
    accountId: scene.ws.id,
    spec: { ...specs.orchestrator, working_dir: folders.o.app, folder_scope: 'shared' },
  });

  step('The orchestrator plans over MCP by slot id');
  const plan = await orchestrator.callTool('submit_orchestration_plan', {
    mission_id: mission.id,
    steps: [{ step_key: 'test-app', title: 'Test the app', instructions: 'test it', assignee: slot.tester.id }],
  });
  assert.ok(!plan.isError, `plan failed: ${JSON.stringify(plan)}`);
  assert.deepEqual(plan.dispatched_now, ['test-app']);

  step('Its view of the mission carries the projects, the folder scope and the per-slot roster');
  const view = await orchestrator.callTool('get_orchestration_mission', { mission_id: mission.id });
  assert.ok(!view.isError, `read failed: ${JSON.stringify(view)}`);
  assert.deepEqual(view.projects, [
    { project_id: project.app.id, name: project.app.name, branch: '' },
    { project_id: project.docs.id, name: project.docs.name, branch: 'release' },
  ]);
  assert.equal(view.folder_scope, 'shared');
  assert.ok(Array.isArray(view.roster), `the roster must be returned, got ${JSON.stringify(view.roster)}`);
  const rosterBySlot = Object.fromEntries(view.roster.map((m) => [m.slot_id, m]));
  assert.deepEqual(Object.keys(rosterBySlot).sort(), [slot.builder.id, slot.reviewer.id, slot.tester.id].sort(),
    'every assignable slot, and only those — the orchestrator is not a step assignee');
  assert.equal(rosterBySlot[slot.tester.id].name, slot.tester.agent_name);
  assert.equal(rosterBySlot[slot.tester.id].cli, 'codex');
  assert.deepEqual(rosterBySlot[slot.tester.id].projects, [
    { project_id: project.app.id, name: project.app.name, working_dir: folders.b.app },
  ]);
  assert.equal(rosterBySlot[slot.builder.id].model, 'opus');
  assert.deepEqual(
    rosterBySlot[slot.builder.id].projects.map((p) => [p.project_id, p.working_dir]),
    [[project.app.id, folders.a.app], [project.docs.id, folders.a.docs]],
  );
  assert.match(view.roster_note, /`assignee` = a slot_id from `roster`/, 'the note says how to address the roster');
  const testStep = view.steps.find((s) => s.step_key === 'test-app');
  assert.equal(testStep.assignee, slot.tester.id);
  assert.equal(testStep.project, project.app.id);
  assert.equal(testStep.assignee_name, slot.tester.agent_name);

  step('A member reading the same mission gets the objective — not the roster or the plan');
  const tester = await mcpAs(ctx, t, {
    id: identityIn(specs.tester, folders.b.app),
    accountId: scene.ws.id,
    spec: { ...specs.tester, working_dir: folders.b.app, folder_scope: 'shared' },
  });
  const memberView = await tester.callTool('get_orchestration_mission', { mission_id: mission.id });
  assert.ok(!memberView.isError, `member read failed: ${JSON.stringify(memberView)}`);
  assert.match(memberView.note, /not its orchestrator/);
  assert.equal(memberView.roster, undefined);
  assert.equal(memberView.steps, undefined);
});

test('create_orchestration_mission: the team\'s orchestrator is its slot in a project folder on its host — a member, or the same CLI outside every project folder, is refused', async (t) => {
  const ctx = await context();
  const scene = await buildScene(ctx, 'create');
  const { project, folders, slot, specs } = scene;
  const asOrchestratorIn = (folder) => mcpAs(ctx, t, {
    id: identityIn(specs.orchestrator, folder),
    accountId: scene.ws.id,
    spec: { ...specs.orchestrator, working_dir: folder, folder_scope: 'shared' },
  });
  const onTeam = async (client) => {
    const listed = await client.callTool('list_orchestration_teams', {});
    assert.ok(!listed.isError, JSON.stringify(listed));
    return listed.teams.some((tm) => tm.id === scene.team.id);
  };

  step('Membership is computed: the orchestrator slot running in ANY project folder on its host is the team\'s orchestrator');
  const inDocs = await asOrchestratorIn(folders.o.docs);
  assert.ok(await onTeam(inDocs), 'the team is found from the docs folder as well as from the app folder');

  step('...so it may create a mission for the team — here a draft over [app], isolated');
  const draft = await inDocs.callTool('create_orchestration_mission', {
    team_id: scene.team.id,
    title: 'Drafted from docs',
    objective: 'Plan the app work.',
    projects: [{ project_id: project.app.id }],
    folder_scope: 'isolated',
    start: false,
  });
  assert.ok(!draft.isError, `create failed: ${JSON.stringify(draft)}`);
  assert.equal(draft.status, 'draft');
  const draftDetail = await ctx.missions.getMissionDetail(draft.mission_id, scene.ws.id);
  assert.deepEqual(draftDetail.projects.map((p) => p.project_id), [project.app.id], 'the tool takes `projects`');
  assert.equal(draftDetail.folder_scope, 'isolated', '...and `folder_scope`');

  step('The draft is pre-stamped with its creator, so the creator can still close it');
  const closed = await inDocs.callTool('complete_orchestration_mission', {
    mission_id: draft.mission_id, status: 'failed', summary: 'qa: a draft only',
  });
  assert.ok(!closed.isError, `close failed: ${JSON.stringify(closed)}`);
  assert.equal(closed.status, 'failed');

  step('Started from docs over [app, docs], the creator keeps orchestrating — its folder is one of the mission\'s');
  // 오케스트레이터는 기본적으로 자기 Host 에 폴더가 있는 첫 project(app)에서 돈다. 그러나 미션을
  // 만든 agent 가 미션 project 의 폴더(docs)에서 돌고 있으면 그 자리를 지킨다 — 아니면 다른 세션이
  // 브리핑되고, 만든 쪽은 자기 미션에 403 을 받는다.
  const docsLed = await inDocs.callTool('create_orchestration_mission', {
    team_id: scene.team.id, title: 'Docs-led', objective: 'x',
    projects: [{ project_id: project.app.id }, { project_id: project.docs.id }],
  });
  assert.ok(!docsLed.isError, `create failed: ${JSON.stringify(docsLed)}`);
  assert.equal(docsLed.status, 'planning');
  assert.match(docsLed.note, /You are now briefed/);
  const docsLedMission = await ctx.missions.requireMission(docsLed.mission_id, scene.ws.id);
  assert.equal(docsLedMission.orchestrator_agent_id, identityIn(specs.orchestrator, folders.o.docs));
  const docsLedRead = await inDocs.callTool('get_orchestration_mission', { mission_id: docsLed.mission_id });
  assert.ok(!docsLedRead.isError && Array.isArray(docsLedRead.steps), 'the creator reads its mission as orchestrator');
  await inDocs.callTool('complete_orchestration_mission', { mission_id: docsLed.mission_id, status: 'failed', summary: 'qa' });

  step('Started from docs over [app] only, a separate orchestrator session is briefed — and the reply says so');
  const appOnly = await inDocs.callTool('create_orchestration_mission', {
    team_id: scene.team.id, title: 'App only, from docs', objective: 'x', projects: [{ project_id: project.app.id }],
  });
  assert.ok(!appOnly.isError, `create failed: ${JSON.stringify(appOnly)}`);
  assert.equal(appOnly.status, 'planning');
  assert.doesNotMatch(appOnly.note, /You are now briefed/);
  assert.match(appOnly.note, /separate orchestrator session was briefed/);
  assert.ok(appOnly.note.includes(folders.o.app), 'the reply names the folder the orchestrator runs in');
  const appOnlyMission = await ctx.missions.requireMission(appOnly.mission_id, scene.ws.id);
  assert.equal(appOnlyMission.orchestrator_agent_id, scene.orchestratorId);
  const inAppCloser = await asOrchestratorIn(folders.o.app);
  await inAppCloser.callTool('complete_orchestration_mission', { mission_id: appOnly.mission_id, status: 'failed', summary: 'qa' });

  step('A member is on the team, but it is not the orchestrator');
  const tester = await mcpAs(ctx, t, {
    id: identityIn(specs.tester, folders.b.app),
    accountId: scene.ws.id,
    spec: { ...specs.tester, working_dir: folders.b.app, folder_scope: 'shared' },
  });
  assert.ok(await onTeam(tester), 'a member finds its team');
  const byMember = await tester.callTool('create_orchestration_mission', {
    team_id: scene.team.id, title: 'By a member', objective: 'x', projects: [{ project_id: project.app.id }],
  });
  assert.equal(byMember.isError, true);
  assert.equal(byMember.error.status, 403);
  assert.match(byMember.error.error, /not the orchestrator of this team/);

  step('Nor is the orchestrator\'s CLI in a folder that is no project\'s folder on its host');
  const outside = await asOrchestratorIn(`${scene.root}/o/scratch`);
  assert.equal(await onTeam(outside), false, 'an identity in an unregistered folder is no slot of this team');
  const byOutsider = await outside.callTool('create_orchestration_mission', {
    team_id: scene.team.id, title: 'From nowhere', objective: 'x', projects: [{ project_id: project.app.id }],
  });
  assert.equal(byOutsider.isError, true);
  assert.equal(byOutsider.error.status, 403);

  step('From the mission\'s own project folder the orchestrator creates the mission, is briefed, and plans');
  const inApp = await asOrchestratorIn(folders.o.app);
  const created = await inApp.callTool('create_orchestration_mission', {
    team_id: scene.team.id, title: 'Created in app', objective: 'Run the app work.', projects: [{ project_id: project.app.id }],
  });
  assert.ok(!created.isError, `create failed: ${JSON.stringify(created)}`);
  assert.equal(created.status, 'planning');
  const mission = await ctx.missions.requireMission(created.mission_id, scene.ws.id);
  assert.equal(mission.orchestrator_agent_id, scene.orchestratorId);
  assert.equal(mission.folder_scope, 'shared', 'folder_scope defaults to shared');
  const plan = await inApp.callTool('submit_orchestration_plan', {
    mission_id: created.mission_id,
    steps: [{ step_key: 'test', title: 'Test', instructions: 'test it', assignee: slot.tester.id }],
  });
  assert.ok(!plan.isError, `plan failed: ${JSON.stringify(plan)}`);
  assert.deepEqual(plan.dispatched_now, ['test']);
});

test('Projects and folder scope are part of the brief — validated while a draft, locked once the orchestrator is briefed', async () => {
  const ctx = await context();
  const scene = await buildScene(ctx, 'draft');
  const { project } = scene;
  const base = { account_id: scene.ws.id, team_id: scene.team.id, created_by_type: 'user', created_by: HUMAN.id };

  step('folder_scope defaults to shared, and only the two known values are accepted');
  const draft = await ctx.missions.createMission({
    ...base, title: 'Draft', objective: 'Edit me first.', projects: [{ project_id: project.app.id }],
  });
  assert.equal(draft.folder_scope, 'shared');
  await assert.rejects(
    () => ctx.missions.createMission({ ...base, title: 'Bad scope', objective: 'x', folder_scope: 'sideways' }),
    (e) => {
      assert.equal(e.status, 400);
      assert.match(e.message, /folder_scope must be "shared" or "isolated"/);
      return true;
    },
  );

  step('A draft takes new projects (order kept, primary first) and a new scope');
  await ctx.missions.updateMission(draft.id, scene.ws.id, {
    projects: [{ project_id: project.docs.id, branch: 'release' }, { project_id: project.app.id }],
    folder_scope: 'isolated',
  });
  const edited = await ctx.missions.getMissionDetail(draft.id, scene.ws.id);
  assert.deepEqual(edited.projects.map((p) => [p.project_id, p.branch]), [[project.docs.id, 'release'], [project.app.id, '']]);
  assert.equal(edited.folder_scope, 'isolated');

  step('...but not a project listed twice, nor an unknown scope');
  await assert.rejects(
    () => ctx.missions.updateMission(draft.id, scene.ws.id, {
      projects: [{ project_id: project.app.id }, { project_id: project.app.id, branch: 'other' }],
    }),
    (e) => {
      assert.equal(e.status, 400);
      assert.match(e.message, /listed twice/, 'two entries for one project would leave its branch ambiguous');
      return true;
    },
  );
  await assert.rejects(
    () => ctx.missions.updateMission(draft.id, scene.ws.id, { folder_scope: 'sideways' }),
    (e) => e.status === 400,
  );

  step('Once the orchestrator is briefed, projects and scope are locked');
  await ctx.runner.startMission(draft.id, scene.ws.id, HUMAN);
  for (const patch of [
    { projects: [{ project_id: project.app.id }] },
    { repo_ref: { project_id: project.app.id } },
    { folder_scope: 'shared' },
  ]) {
    await assert.rejects(
      () => ctx.missions.updateMission(draft.id, scene.ws.id, patch),
      (e) => {
        assert.equal(e.status, 409, `${JSON.stringify(patch)} must be refused after the start`);
        assert.match(e.message, /only be edited while the mission is a draft/);
        return true;
      },
    );
  }
  const locked = await ctx.missions.getMissionDetail(draft.id, scene.ws.id);
  assert.equal(locked.folder_scope, 'isolated');
  assert.deepEqual(locked.projects.map((p) => p.project_id), [project.docs.id, project.app.id]);
});

test('Starting is refused when a member\'s host has none of the projects — and leaving that member out fixes it', async () => {
  const ctx = await context();
  const scene = await buildScene(ctx, 'start');
  const { project, hosts, slot } = scene;
  const missionBase = {
    account_id: scene.ws.id, team_id: scene.team.id, created_by_type: 'user', created_by: HUMAN.id,
  };

  step('A docs-only mission: the tester\'s host has no docs folder, so the start is refused, naming the member and the project');
  const docsOnly = await newMission(ctx, scene, { title: 'Docs only', projects: [project.docs] });
  await assert.rejects(
    () => ctx.runner.startMission(docsOnly.id, scene.ws.id, HUMAN),
    (e) => {
      assert.equal(e.status, 409);
      assert.ok(
        e.message.includes(
          `${slot.tester.agent_name} runs on ${hosts.b.name}, which has no folder registered for any of this ` +
            `mission's projects (${project.docs.name})`,
        ),
        e.message,
      );
      assert.match(e.message, /leave this member out of the mission/, 'the message offers the way out');
      return true;
    },
  );
  const refused = await ctx.missions.requireMission(docsOnly.id, scene.ws.id);
  assert.equal(refused.status, 'draft', 'a refused start leaves the draft as it was');
  assert.equal(refused.room_id, null);
  assert.equal(refused.runtime_roster, null, 'and stores no roster');

  step('Leaving the tester out of this mission — the fix the message offers — lets it start');
  const without = await newMission(ctx, scene, {
    title: 'Docs without the tester', projects: [project.docs], excluded_member_ids: [slot.tester.id],
  });
  const started = await ctx.runner.startMission(without.id, scene.ws.id, HUMAN);
  assert.equal(started.status, 'planning');
  assert.deepEqual(
    started.runtime_roster.members.map((m) => m.slot_id).sort(),
    [slot.builder.id, slot.reviewer.id].sort(),
    'the excluded slot is not on this mission\'s roster',
  );
  assert.equal((await ctx.teams.getTeam(scene.team.id, scene.ws.id)).members.length, 3, 'the team itself keeps it');

  step('A mission with no project cannot start at all');
  const nowhere = await newMission(ctx, scene, { title: 'Nowhere', projects: [] });
  await assert.rejects(
    () => ctx.runner.startMission(nowhere.id, scene.ws.id, HUMAN),
    (e) => {
      assert.equal(e.status, 409);
      assert.match(e.message, /names no project/);
      return true;
    },
  );

  step('A project of another account is refused when the mission is written');
  const other = await createAccount(ctx.app, ctx.getDataSourceToken, 'mission-projects-other');
  const foreign = await createProject(ctx.app, ctx.getDataSourceToken, other.id, {
    name: 'foreign',
    hostFolders: [{ hostId: hosts.b.id, path: '/srv/awb-test/mission-projects/foreign' }],
  });
  await assert.rejects(
    () => newMission(ctx, scene, { title: 'Foreign', projects: [foreign] }),
    (e) => {
      assert.equal(e.status, 400);
      assert.ok(e.message.includes(`project(s) not found in this mission's account: ${foreign.id}`), e.message);
      return true;
    },
  );

  step('A bare repository URL is not a project — refused, with the way to make one');
  await assert.rejects(
    () => ctx.missions.createMission({
      ...missionBase, title: 'URL only', objective: 'URL only', repo_ref: { url: 'https://github.com/example/app.git' },
    }),
    (e) => {
      assert.equal(e.status, 400);
      assert.match(e.message, /needs a Project, not a bare repository URL/);
      return true;
    },
  );

  step('The legacy repo_ref naming a project is read as a one-project mission');
  const legacy = await ctx.missions.createMission({
    ...missionBase, title: 'Legacy repo_ref', objective: 'Legacy repo_ref', repo_ref: { project_id: project.app.id, branch: 'main' },
  });
  const legacyDetail = await ctx.missions.getMissionDetail(legacy.id, scene.ws.id);
  assert.deepEqual(legacyDetail.projects, [{ project_id: project.app.id, branch: 'main', name: project.app.name }]);
});

test('Two shared missions never share a checkout — a second one over the same folders is refused while the first is live; an isolated one starts', async () => {
  const ctx = await context();
  const scene = await buildScene(ctx, 'conflict');
  const { project, folders, hosts, slot } = scene;

  const first = await newMission(ctx, scene, { title: 'First shared', projects: [project.app] });
  await ctx.runner.startMission(first.id, scene.ws.id, HUMAN);

  step('A second shared mission over the same project is refused — it would write into the same folders');
  const second = await newMission(ctx, scene, { title: 'Second shared', projects: [project.app] });
  await assert.rejects(
    () => ctx.runner.startMission(second.id, scene.ws.id, HUMAN),
    (e) => {
      assert.equal(e.status, 409);
      assert.ok(
        e.message.includes(`mission "First shared" (planning) is already working in ${folders.a.app} on ${hosts.a.name} with shared folders`),
        e.message,
      );
      assert.match(e.message, /run this mission with isolated folders/, 'the message offers the way out');
      return true;
    },
  );
  const refused = await ctx.missions.requireMission(second.id, scene.ws.id);
  assert.equal(refused.status, 'draft');
  assert.equal(refused.runtime_roster, null, 'a refused start stores no roster');

  step('An isolated mission over the same project starts — each of its steps gets its own checkout');
  const isolated = await newMission(ctx, scene, { title: 'Isolated alongside', projects: [project.app], folderScope: 'isolated' });
  assert.equal((await ctx.runner.startMission(isolated.id, scene.ws.id, HUMAN)).status, 'planning');

  step('A shared mission over a different folder is not in the way either');
  const docs = await newMission(ctx, scene, {
    title: 'Docs shared', projects: [project.docs], excluded_member_ids: [slot.tester.id],
  });
  assert.equal((await ctx.runner.startMission(docs.id, scene.ws.id, HUMAN)).status, 'planning',
    'the conflict is per (host, folder) — not per team, not per host');

  step('Once the first mission ends, the second one may start');
  await ctx.runner.cancelMission(first.id, scene.ws.id, HUMAN, 'qa: free the folder');
  assert.equal((await ctx.runner.startMission(second.id, scene.ws.id, HUMAN)).status, 'planning');
});

test('Reopen re-resolves the roster from the current team — a retried step runs on the edited slot', async (t) => {
  const ctx = await context();
  const scene = await buildScene(ctx, 'reopen');
  const { project, folders, hosts, slot, specs } = scene;
  const orchestrator = { agentId: scene.orchestratorId };

  const mission = await newMission(ctx, scene, { title: 'Reopen with an edited slot', projects: [project.app, project.docs] });
  await ctx.runner.startMission(mission.id, scene.ws.id, HUMAN);
  await ctx.runner.submitPlan(mission.id, orchestrator, {
    steps: [{ step_key: 'test-app', title: 'Test the app', instructions: 'test it', assignee: slot.tester.id }],
  });
  const [first] = await ctx.missions.listSteps(mission.id);
  assert.equal(first.status, 'dispatched');
  assert.equal(first.assignee_spec.manager_agent_id, hosts.b.id, 'sanity: the first attempt ran on host b');
  assert.equal(first.assignee_spec.working_dir, folders.b.app);

  step('The mission ends; the operator moves the tester to host a and changes its model');
  await ctx.runner.cancelMission(mission.id, scene.ws.id, HUMAN, 'qa: fix the roster, then carry on');
  const edited = await ctx.teams.updateMember(scene.team.id, scene.ws.id, slot.tester.id, {
    runtime: { manager_agent_id: hosts.a.id, model: 'gpt-5.6-terra' },
  });
  assert.equal(edited.members.find((m) => m.id === slot.tester.id).agent_name, `${hosts.a.name}/tester`);
  const before = (await ctx.missions.requireMission(mission.id, scene.ws.id)).runtime_roster;
  assert.equal(before.members.find((m) => m.slot_id === slot.tester.id).spec.manager_agent_id, hosts.b.id,
    'a finished mission keeps the roster it ran with until it is reopened');

  step('Reopening re-resolves the members from the current team and restarts their runtimes');
  const prepared = recordPreparation(t, ctx.commands);
  await ctx.runner.reopenMission(mission.id, scene.ws.id, HUMAN);
  const roster = (await ctx.missions.requireMission(mission.id, scene.ws.id)).runtime_roster;
  const testerRuntimes = roster.runtimes.filter((r) => r.slot_id === slot.tester.id);
  assert.deepEqual(
    Object.fromEntries(testerRuntimes.map((r) => [r.project_id, r.spec.working_dir])),
    { [project.app.id]: folders.a.app, [project.docs.id]: folders.a.docs },
    'on host a the tester can now take both projects, in host a\'s folders',
  );
  assert.ok(testerRuntimes.every((r) => r.spec.model === 'gpt-5.6-terra'), 'with the edited model');
  assert.equal(roster.members.find((m) => m.slot_id === slot.tester.id).name, `${hosts.a.name}/tester`);
  const testerAppId = identityIn(specs.tester, folders.a.app);
  const restarted = prepared.find((p) => p.agent_id === testerAppId);
  assert.ok(restarted, `the edited slot's runtime must be prepared, got ${JSON.stringify(prepared.map((p) => p.agent_id))}`);
  assert.equal(restarted.restart, true, 'a reopen restarts — a live CLI process may still hold the old launch context');
  assert.equal(restarted.manager_agent_id, hosts.a.id);
  assert.equal(restarted.model, 'gpt-5.6-terra');

  step('Retrying the step runs it on the edited slot: the new host, that host\'s folder for the project, the new model');
  const { step: retried } = await ctx.runner.updateStep(first.id, orchestrator, { action: 'retry' });
  assert.equal(retried.status, 'dispatched');
  assert.equal(retried.attempt, 2);
  assert.equal(retried.project_id, project.app.id, 'the step keeps its project');
  assert.equal(retried.assignee_agent_id, testerAppId);
  assert.equal(retried.assignee_spec.manager_agent_id, hosts.a.id);
  assert.equal(retried.assignee_spec.working_dir, folders.a.app);
  assert.equal(retried.assignee_spec.model, 'gpt-5.6-terra');
  const spec = await participantSpec(ctx.ds, retried);
  assert.equal(spec.working_dir, folders.a.app, 'the new attempt\'s room hands the manager the edited runtime');
  assert.equal(spec.model, 'gpt-5.6-terra');
  const order = await workOrderFor(ctx.ds, retried);
  assert.ok(order.includes(`\`${folders.a.app}\` — your current directory`), order.slice(0, 800));
  assert.ok(order.includes(slot.builder.agent_name) && order.includes(slot.reviewer.agent_name),
    'on host a the tester now shares the app folder with the builder and the reviewer — the work order says so');
});

exitAfterTests();
