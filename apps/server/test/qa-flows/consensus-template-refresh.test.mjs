// QA flow: 다중담당자·합의 T7 — 합의 게이트 프롬프트 템플릿 refresh 마이그레이션
// (1760000000046-RefreshDefaultPromptTemplatesConsensusGate).
//
// What this proves
// ────────────────
//
// T1~T6 가 서버에 합의 게이트를 깔았지만, 기본 워크플로 프롬프트는 insert-only
// 시드/backfill 이라 **기존 워크스페이스의 에이전트는 합의 규약(직접 move_ticket
// 거부 → propose_move + 전원 record_agreement)을 영영 배우지 못한다**. 46번
// 마이그레이션이 prompt-template-refresh(22/30/31/36/42/44)와 동일한 운영자-안전
// 계약으로 5개 컬럼 워크플로(todo/plan/in_progress/review/merging)를 갱신한다.
//
// Acceptance:
//   1. 이전 기본값(byte-exact)을 든 워크스페이스 → 5개 전부 현재 기본값으로
//      갱신되고, 갱신본에 "Multi-holder consensus gate" 안내가 실제로 존재.
//   2. 운영자 커스텀 행은 byte-for-byte 보존.
//   3. 템플릿이 아예 없는 워크스페이스에는 INSERT 하지 않음.
//   4. 재실행은 no-op (멱등 — updated_at 불변).

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootApp, exitAfterTests, step } from '../helpers/boot.mjs';
import { createWorkspace } from '../helpers/fixtures.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST_ROOT = path.resolve(__dirname, '..', '..', 'dist');

// 포트 7877 — 다른 QA flow 와 미충돌(7871 consensus-gate, 7838 prompt-refresh 등).
process.env.PORT = process.env.QA_CONSENSUS_TPL_REFRESH_PORT || '7877';

const REFRESHED_NAMES = [
  'todo_workflow',
  'plan_workflow',
  'in_progress_workflow',
  'review_workflow',
  'merging_workflow',
];

const GATE_MARKER = 'Multi-holder consensus gate';

const CUSTOM_CONTENT = `# To Do — operator-customized workflow

운영자가 손댄 행 — 이전 기본값과 일치하지 않으므로 마이그레이션이 절대 건드리면
안 된다.
`;

test('consensus-gate prompt template refresh migration updates stale defaults, preserves customizations, idempotent', async (t) => {
  step('Boot NestJS app on test port');
  const { app, modules } = await bootApp({ port: parseInt(process.env.PORT, 10) });
  t.after(() => { void app.close().catch(() => {}); });
  const { getDataSourceToken } = modules;
  const ds = app.get(getDataSourceToken());
  const tplRepo = ds.getRepository('PromptTemplate');

  // 마이그레이션 클래스 + PRIOR 픽스처를 dist 에서 직접 로드 — 픽스처가
  // 마이그레이션의 byte-match 기준과 lockstep 으로 유지되게 한다(리터럴 중복 0).
  const migrationModule = await import(
    'file://' +
      path.join(
        DIST_ROOT,
        'database',
        'migrations',
        '1760000000046-RefreshDefaultPromptTemplatesConsensusGate.js',
      )
  );
  const MigrationClass = migrationModule.RefreshDefaultPromptTemplatesConsensusGate1760000000046;
  assert.ok(MigrationClass, 'migration class export missing — check dist build');
  const PRIORS = migrationModule.PRIOR_CONSENSUS_GATE_CONTENTS;
  assert.ok(PRIORS, 'migration must export PRIOR_CONSENSUS_GATE_CONTENTS for this test');

  const defaultsModule = await import(
    'file://' + path.join(DIST_ROOT, 'database', 'default-prompt-templates.js')
  );
  const currentByName = new Map(
    defaultsModule.DEFAULT_PROMPT_TEMPLATES.map((d) => [d.name, d.content]),
  );

  // 의미 sanity: PRIOR 에는 게이트 안내가 없고 현재 기본값에는 있어야 이
  // refresh 가 "합의 규약 배포" 라는 목적을 실제로 달성한다.
  for (const name of REFRESHED_NAMES) {
    const prior = PRIORS[name];
    assert.ok(Array.isArray(prior) && prior[0], `PRIORS['${name}'] must be a non-empty list`);
    assert.ok(!prior[0].includes(GATE_MARKER),
      `prior ${name} must NOT contain the consensus gate section (fixture drift?)`);
    const current = currentByName.get(name);
    assert.ok(current && current.includes(GATE_MARKER),
      `current ${name} default must contain the consensus gate section (was the change rolled back?)`);
    assert.ok(current.includes('record_agreement') && current.includes('propose_move'),
      `current ${name} default must name the consensus tools`);
  }

  step('Seed three workspaces: stale, customized, and missing');

  // Workspace A — stale: 5개 전부 이전 기본값(byte-exact).
  const wsStale = await createWorkspace(app, getDataSourceToken, 'consensus-stale');
  await tplRepo.save(REFRESHED_NAMES.map((name) => tplRepo.create({
    workspace_id: wsStale.id, name,
    description: 'pre-consensus-gate', category: 'default_workflow',
    content: PRIORS[name][0],
  })));

  // Workspace B — customized: todo_workflow 를 운영자가 수정.
  const wsCustom = await createWorkspace(app, getDataSourceToken, 'consensus-custom');
  await tplRepo.save([
    tplRepo.create({
      workspace_id: wsCustom.id, name: 'todo_workflow',
      description: 'operator-customized', category: 'default_workflow',
      content: CUSTOM_CONTENT,
    }),
  ]);

  // Workspace C — missing: 템플릿 행 0개.
  const wsMissing = await createWorkspace(app, getDataSourceToken, 'consensus-missing');
  const missingBefore = await tplRepo.find({ where: { workspace_id: wsMissing.id } });
  assert.equal(missingBefore.length, 0,
    'precondition — wsMissing must start with zero template rows');

  step('Run migration.up() — first pass');
  // 마이그레이션은 queryRunner.manager 만 쓴다 — ds.manager 를 감싼 synthetic runner.
  const queryRunner = { manager: ds.manager };
  const migration = new MigrationClass();
  await migration.up(queryRunner);

  step('Case 1 — stale workspace: all five workflows refreshed to current default');
  for (const name of REFRESHED_NAMES) {
    const row = await tplRepo.findOne({ where: { workspace_id: wsStale.id, name } });
    assert.ok(row, `wsStale must still have row ${name} after migration`);
    assert.equal(row.content, currentByName.get(name),
      `wsStale ${name} must hold current default content after refresh`);
    assert.ok(row.content.includes(GATE_MARKER),
      `refreshed ${name} must surface the consensus gate guidance`);
  }

  step('Case 2 — customized workspace: operator edit preserved byte-for-byte');
  const customAfter = await tplRepo.findOne({
    where: { workspace_id: wsCustom.id, name: 'todo_workflow' },
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

  exitAfterTests(0);
});
