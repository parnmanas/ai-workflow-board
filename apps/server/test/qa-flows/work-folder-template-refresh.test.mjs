// QA flow: worktree 규약 ④-후속 — 작업 폴더 규약 프롬프트 템플릿 refresh 마이그레이션
// (1760000000049-RefreshDefaultPromptTemplatesWorkFolder).
//
// What this proves
// ────────────────
//
// ④(cd7fc2c6)가 backlog/todo/plan/in_progress/review/done 6개 컬럼 워크플로 상단에
// "🗂️ 작업 폴더 규약" 블록(`{{AWB_WORK_FOLDER}}` placeholder)을 주입했지만, refresh
// 마이그레이션 없이 소스만 바꿨다. 시드/backfill 은 insert-only 라 **이미 default 를
// seed 받은 기존 워크스페이스에는 placeholder 가 영영 안 들어간다** → ④ 기능이 기존
// 보드에서 inert. 49번 마이그레이션이 prompt-template-refresh(22/30/31/36/42/44/46)와
// 동일한 운영자-안전 계약으로 6개 컬럼 워크플로를 갱신한다.
//
// Acceptance:
//   1. 이전 기본값(byte-exact)을 든 워크스페이스 → 6개 전부 현재 기본값으로 갱신되고,
//      갱신본에 "작업 폴더 규약" 안내 + `{{AWB_WORK_FOLDER}}` 토큰이 실제로 존재.
//   2. 운영자 커스텀 행은 byte-for-byte 보존.
//   3. 템플릿이 아예 없는 워크스페이스에는 INSERT 하지 않음.
//   4. 재실행은 no-op (멱등 — updated_at 불변).
//   5. pre-④ 다세대 케이스(각 템플릿 priorList[1..] — c02a927~dfc86a2 세대 전량)도
//      전부 현재 기본값으로 lift (전세대×체인 시뮬로 확정한 setB).

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootApp, exitAfterTests, step } from '../helpers/boot.mjs';
import { createWorkspace } from '../helpers/fixtures.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST_ROOT = path.resolve(__dirname, '..', '..', 'dist');

// 포트 7883 — 다른 QA flow 와 미충돌(7877 consensus-refresh, 7881, 7899 등).
process.env.PORT = process.env.QA_WORK_FOLDER_TPL_REFRESH_PORT || '7883';

const REFRESHED_NAMES = [
  'backlog_workflow',
  'todo_workflow',
  'plan_workflow',
  'in_progress_workflow',
  'review_workflow',
  'done_workflow',
];

const RULE_MARKER = '작업 폴더 규약 (worktree 규약 ④)';
const TOKEN = '{{AWB_WORK_FOLDER}}';

const CUSTOM_CONTENT = `# Backlog — operator-customized workflow

운영자가 손댄 행 — 이전 기본값과 일치하지 않으므로 마이그레이션이 절대 건드리면
안 된다.
`;

test('work-folder prompt template refresh migration updates stale defaults, preserves customizations, idempotent', async (t) => {
  step('Boot NestJS app on test port');
  const { app, modules } = await bootApp({ port: parseInt(process.env.PORT, 10) });
  t.after(() => { void app.close().catch(() => {}); });
  const { getDataSourceToken } = modules;
  const ds = app.get(getDataSourceToken());
  const tplRepo = ds.getRepository('PromptTemplate');

  // 마이그레이션 클래스 + PRIOR 픽스처를 dist 에서 직접 로드 — 픽스처가 마이그레이션의
  // byte-match 기준과 lockstep 으로 유지되게 한다(리터럴 중복 0).
  const migrationModule = await import(
    'file://' +
      path.join(
        DIST_ROOT,
        'database',
        'migrations',
        '1760000000049-RefreshDefaultPromptTemplatesWorkFolder.js',
      )
  );
  const MigrationClass = migrationModule.RefreshDefaultPromptTemplatesWorkFolder1760000000049;
  assert.ok(MigrationClass, 'migration class export missing — check dist build');
  const PRIORS = migrationModule.PRIOR_WORK_FOLDER_CONTENTS;
  assert.ok(PRIORS, 'migration must export PRIOR_WORK_FOLDER_CONTENTS for this test');

  const defaultsModule = await import(
    'file://' + path.join(DIST_ROOT, 'database', 'default-prompt-templates.js')
  );
  const currentByName = new Map(
    defaultsModule.DEFAULT_PROMPT_TEMPLATES.map((d) => [d.name, d.content]),
  );

  // 의미 sanity: PRIOR 에는 작업 폴더 규약(토큰)이 없고 현재 기본값에는 있어야 이
  // refresh 가 "④ 규약 배포" 라는 목적을 실제로 달성한다. merging 은 대상 아님.
  assert.ok(!PRIORS.merging_workflow,
    'merging_workflow must NOT be a refresh target (④는 merging 의도적 제외)');
  for (const name of REFRESHED_NAMES) {
    const prior = PRIORS[name];
    assert.ok(Array.isArray(prior) && prior[0], `PRIORS['${name}'] must be a non-empty list`);
    for (const [i, p] of prior.entries()) {
      assert.ok(!p.includes(TOKEN),
        `prior ${name}[${i}] must NOT contain the work-folder token (fixture drift?)`);
      assert.ok(!p.includes(RULE_MARKER),
        `prior ${name}[${i}] must NOT contain the work-folder rule (fixture drift?)`);
    }
    const current = currentByName.get(name);
    assert.ok(current && current.includes(RULE_MARKER),
      `current ${name} default must contain the work-folder rule (was ④ rolled back?)`);
    assert.ok(current && current.includes(TOKEN),
      `current ${name} default must contain the ${TOKEN} placeholder`);
  }

  step('Seed three workspaces: stale, customized, and missing');

  // Workspace A — stale: 6개 전부 이전 기본값(byte-exact, priorList[0]).
  const wsStale = await createWorkspace(app, getDataSourceToken, 'work-folder-stale');
  await tplRepo.save(REFRESHED_NAMES.map((name) => tplRepo.create({
    workspace_id: wsStale.id, name,
    description: 'pre-work-folder', category: 'default_workflow',
    content: PRIORS[name][0],
  })));

  // Workspace B — customized: backlog_workflow 를 운영자가 수정.
  const wsCustom = await createWorkspace(app, getDataSourceToken, 'work-folder-custom');
  await tplRepo.save([
    tplRepo.create({
      workspace_id: wsCustom.id, name: 'backlog_workflow',
      description: 'operator-customized', category: 'default_workflow',
      content: CUSTOM_CONTENT,
    }),
  ]);

  // Workspace C — missing: 템플릿 행 0개.
  const wsMissing = await createWorkspace(app, getDataSourceToken, 'work-folder-missing');
  const missingBefore = await tplRepo.find({ where: { workspace_id: wsMissing.id } });
  assert.equal(missingBefore.length, 0,
    'precondition — wsMissing must start with zero template rows');

  step('Run migration.up() — first pass');
  // 마이그레이션은 queryRunner.manager 만 쓴다 — ds.manager 를 감싼 synthetic runner.
  const queryRunner = { manager: ds.manager };
  const migration = new MigrationClass();
  await migration.up(queryRunner);

  step('Case 1 — stale workspace: all six workflows refreshed to current default');
  for (const name of REFRESHED_NAMES) {
    const row = await tplRepo.findOne({ where: { workspace_id: wsStale.id, name } });
    assert.ok(row, `wsStale must still have row ${name} after migration`);
    assert.equal(row.content, currentByName.get(name),
      `wsStale ${name} must hold current default content after refresh`);
    assert.ok(row.content.includes(RULE_MARKER) && row.content.includes(TOKEN),
      `refreshed ${name} must surface the work-folder rule + token`);
  }

  step('Case 2 — customized workspace: operator edit preserved byte-for-byte');
  const customAfter = await tplRepo.findOne({
    where: { workspace_id: wsCustom.id, name: 'backlog_workflow' },
  });
  assert.equal(customAfter.content, CUSTOM_CONTENT,
    'operator-customized template MUST be left alone');

  step('Case 3 — missing workspace: no rows inserted by the refresh path');
  const missingAfter = await tplRepo.find({ where: { workspace_id: wsMissing.id } });
  assert.equal(missingAfter.length, 0,
    'wsMissing must still have zero rows — refresh must not insert (seed path owns that)');

  step('Case 4 — re-run migration: idempotent no-op on already-refreshed rows');
  const beforeRerun = await tplRepo.find({
    where: { workspace_id: wsStale.id },
    order: { name: 'ASC' },
  });
  const beforeStamps = beforeRerun.map((r) => `${r.name}:${r.updated_at?.toISOString?.() ?? r.updated_at}`);
  await new Promise((r) => setTimeout(r, 50));

  await migration.up(queryRunner);

  const afterRerun = await tplRepo.find({
    where: { workspace_id: wsStale.id },
    order: { name: 'ASC' },
  });
  const afterStamps = afterRerun.map((r) => `${r.name}:${r.updated_at?.toISOString?.() ?? r.updated_at}`);
  assert.deepStrictEqual(afterStamps, beforeStamps,
    'idempotency — re-running the migration must not touch any row (updated_at unchanged)');

  step('Case 5 — pre-④ 다세대(priorList[1..]): 모든 이전 세대 행이 현재 기본값으로 lift');
  // 전세대×체인 시뮬로 확정한 setB 에는 각 템플릿의 distinct pre-④ 세대가 여러 개
  // 들어있다(backlog=2, todo=4, plan=5, in_progress=10, review=6, done=4). priorList[0]
  // 은 Case 1 이 이미 커버 — 여기서는 [1..] 세대를 각각 별도 워크스페이스에 심고
  // 마이그레이션이 전부 현재 기본값으로 올리는지 확인한다.
  const ancientEntries = [];
  for (const name of REFRESHED_NAMES) {
    for (let i = 1; i < PRIORS[name].length; i++) ancientEntries.push({ name, idx: i });
  }
  // in_progress 가 세대 갭이 가장 커 다세대 lift 의 핵심 케이스 — 최소한 이 정도는 있어야 함.
  assert.ok(
    ancientEntries.filter((e) => e.name === 'in_progress_workflow').length >= 5 &&
      ancientEntries.some((e) => e.name === 'plan_workflow') &&
      ancientEntries.some((e) => e.name === 'review_workflow'),
    'priorList 다세대(in_progress ≥5, plan/review ≥1)가 빠졌다 — 마이그레이션 49 setB 확인',
  );
  const ancientRows = [];
  for (const { name, idx } of ancientEntries) {
    const ws = await createWorkspace(app, getDataSourceToken, `work-folder-gen-${name}-${idx}`);
    await tplRepo.save([tplRepo.create({
      workspace_id: ws.id, name,
      description: `pre4-generation-${idx}`, category: 'default_workflow',
      content: PRIORS[name][idx],
    })]);
    ancientRows.push({ wsId: ws.id, name, idx });
  }
  await migration.up(queryRunner);
  for (const { wsId, name, idx } of ancientRows) {
    const row = await tplRepo.findOne({ where: { workspace_id: wsId, name } });
    assert.equal(row.content, currentByName.get(name),
      `pre-④ 세대 ${name}[${idx}] 행이 현재 기본값으로 lift 되어야 함`);
    assert.ok(row.content.includes(RULE_MARKER) && row.content.includes(TOKEN),
      `lift 된 ${name} 행은 작업 폴더 규약 + 토큰을 포함해야 함`);
  }

  exitAfterTests(0);
});
