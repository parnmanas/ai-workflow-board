// QA flow — Action-before-Pending 프롬프트 템플릿 refresh 마이그레이션
// (1760000000050-RefreshDefaultPromptTemplatesActionGate, 티켓 524bb434).
//
// 시드/backfill 은 insert-only 라 기존 워크스페이스에는 새 `## Actions` 섹션이
// 영영 안 들어간다. 이 마이그레이션이 갭을 메운다 — 운영자-안전(byte-exact 매칭만
// UPDATE), insert 안 함, 멱등. prompt-template-refresh.test.mjs 와 같은 계약을 고정.
//
// Acceptance:
//   1. 세 워크플로가 직전(prior) default 내용이면 → 모두 current(Actions 블록 포함)로 refresh.
//   2. 운영자 커스텀 행은 byte-for-byte 보존.
//   3. 템플릿이 없는 워크스페이스는 skip(insert 안 함).
//   4. 재실행은 no-op(멱등).

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootApp, exitAfterTests, step } from '../helpers/boot.mjs';
import { createWorkspace } from '../helpers/fixtures.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST_ROOT = path.resolve(__dirname, '..', '..', 'dist');

process.env.PORT = process.env.QA_ACTIONS_REFRESH_PORT || '7904';

const REFRESHED = ['todo_workflow', 'plan_workflow', 'in_progress_workflow'];
const CUSTOM_CONTENT = `# To Do — Custom workflow with operator tweaks

This row is operator-edited — it does NOT match the prior default. The migration MUST leave it alone.
`;

test('action-gate prompt refresh migration: updates stale defaults, preserves customizations, idempotent', async (t) => {
  step('Boot NestJS app on test port');
  const { app, modules } = await bootApp({ port: parseInt(process.env.PORT, 10) });
  t.after(() => {
    void app.close().catch(() => {});
  });
  const { getDataSourceToken } = modules;
  const ds = app.get(getDataSourceToken());
  const tplRepo = ds.getRepository('PromptTemplate');

  const migrationModule = await import(
    'file://' +
      path.join(
        DIST_ROOT,
        'database',
        'migrations',
        '1760000000052-RefreshDefaultPromptTemplatesActionGate.js',
      )
  );
  const MigrationClass =
    migrationModule.RefreshDefaultPromptTemplatesActionGate1760000000052;
  assert.ok(MigrationClass, 'migration class export missing — check dist build');
  const PRIOR = migrationModule.PRIOR_DEFAULT_CONTENTS;
  assert.ok(PRIOR, 'migration must export PRIOR_DEFAULT_CONTENTS for this test');

  const defaultsModule = await import(
    'file://' + path.join(DIST_ROOT, 'database', 'default-prompt-templates.js')
  );
  const currentByName = new Map(
    defaultsModule.DEFAULT_PROMPT_TEMPLATES.map((d) => [d.name, d.content]),
  );
  // Sanity: the current defaults must carry the new guidance (change not rolled back).
  for (const name of REFRESHED) {
    assert.ok(
      currentByName.get(name).includes('Actions — run a registered Action before you Pending'),
      `sanity — current ${name} default must contain the Action-before-Pending block`,
    );
    assert.ok(
      PRIOR[name] && PRIOR[name][0],
      `migration must export PRIOR_DEFAULT_CONTENTS['${name}']`,
    );
    assert.ok(
      !PRIOR[name][0].includes('Actions — run a registered Action before you Pending'),
      `prior ${name} literal must be the pre-change content (no Actions block)`,
    );
  }

  step('Seed three workspaces: stale, customized, missing');
  const wsStale = await createWorkspace(app, getDataSourceToken, 'stale');
  await tplRepo.save(
    REFRESHED.map((name) =>
      tplRepo.create({
        workspace_id: wsStale.id,
        name,
        description: 'pre-524bb434',
        category: 'default_workflow',
        content: PRIOR[name][0],
      }),
    ),
  );

  const wsCustom = await createWorkspace(app, getDataSourceToken, 'custom');
  await tplRepo.save(
    tplRepo.create({
      workspace_id: wsCustom.id,
      name: 'todo_workflow',
      description: 'operator-customized',
      category: 'default_workflow',
      content: CUSTOM_CONTENT,
    }),
  );

  const wsMissing = await createWorkspace(app, getDataSourceToken, 'missing');
  const missingBefore = await tplRepo.find({ where: { workspace_id: wsMissing.id } });
  assert.equal(missingBefore.length, 0, 'precondition — wsMissing starts with zero template rows');

  step('Run migration.up() — first pass');
  const queryRunner = { manager: ds.manager };
  const migration = new MigrationClass();
  await migration.up(queryRunner);

  step('Case 1 — stale workspace: all three templates refreshed to current (Actions block present)');
  for (const name of REFRESHED) {
    const row = await tplRepo.findOne({ where: { workspace_id: wsStale.id, name } });
    assert.ok(row, `wsStale must still have row ${name}`);
    assert.equal(row.content, currentByName.get(name), `wsStale ${name} must hold current content`);
    assert.ok(
      row.content.includes('Actions — run a registered Action before you Pending'),
      `refreshed ${name} must surface the Action-before-Pending guidance`,
    );
    assert.ok(row.content.includes('no_action_reason'), `refreshed ${name} must mention no_action_reason`);
  }

  step('Case 2 — customized workspace: operator edit preserved byte-for-byte');
  const customAfter = await tplRepo.findOne({
    where: { workspace_id: wsCustom.id, name: 'todo_workflow' },
  });
  assert.equal(customAfter.content, CUSTOM_CONTENT, 'operator-customized template MUST be left alone');

  step('Case 3 — missing workspace: no rows inserted by the refresh path');
  const missingAfter = await tplRepo.find({ where: { workspace_id: wsMissing.id } });
  assert.equal(missingAfter.length, 0, 'refresh migration must not insert (seed path owns that)');

  step('Case 4 — re-run migration: idempotent no-op on already-refreshed rows');
  const beforeRerun = await tplRepo.find({
    where: { workspace_id: wsStale.id },
    order: { name: 'ASC' },
  });
  const beforeStamps = beforeRerun.map(
    (r) => `${r.name}:${r.updated_at?.toISOString?.() ?? r.updated_at}`,
  );
  await new Promise((r) => setTimeout(r, 50));
  await migration.up(queryRunner);
  const afterRerun = await tplRepo.find({
    where: { workspace_id: wsStale.id },
    order: { name: 'ASC' },
  });
  const afterStamps = afterRerun.map(
    (r) => `${r.name}:${r.updated_at?.toISOString?.() ?? r.updated_at}`,
  );
  assert.deepStrictEqual(afterStamps, beforeStamps, 'idempotency — re-run must not touch any row');

  exitAfterTests(0);
});
