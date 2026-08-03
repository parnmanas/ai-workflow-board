// QA flow — default column-workflow prompt template refresh for the
// prompt-audit change (1760000000072-RefreshDefaultPromptTemplatesPromptAudit,
// ticket ec498050).
//
// Seed/backfill is insert-only, so an existing workspace that already seeded
// its 7 default templates never gets the new sections just by upgrading the
// server — this migration is the gap-filler, same operator-safety contract
// as every prior refresh migration (byte-exact PRIOR match only, never
// touches customized/drifted rows, never inserts).
//
// Unlike 1760000000052 (whose down() is a no-op, matching every OTHER prior
// refresh migration), THIS migration has a real symmetric down() — this test
// pins the full round-trip (up → down → back to PRIOR byte-for-byte), not
// just the forward direction.
//
// Acceptance:
//   1. All 7 workflows carry the 선(先) 조사 원칙 (investigate-before-asking)
//      rule; only todo/plan/in_progress/review/merging carry the Actions
//      block (backlog/done deliberately excluded — see the migration's own
//      header comment for why).
//   2. A stale workspace (byte-exact PRIOR content) is refreshed to current.
//   3. An operator-customized row is left untouched, byte-for-byte.
//   4. A workspace missing the templates entirely is skipped (no insert).
//   5. Re-running up() is idempotent (no-op on already-current rows).
//   6. down() reverses a refreshed row back to byte-exact PRIOR content, and
//      re-running down() is idempotent too.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootApp, exitAfterTests, step } from '../helpers/boot.mjs';
import { createWorkspace } from '../helpers/fixtures.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST_ROOT = path.resolve(__dirname, '..', '..', 'dist');

process.env.PORT = process.env.QA_PROMPT_AUDIT_REFRESH_PORT || '7910';

const ALL_SEVEN = [
  'backlog_workflow', 'todo_workflow', 'plan_workflow', 'in_progress_workflow',
  'review_workflow', 'merging_workflow', 'done_workflow',
];
const ACTIONS_BLOCK_WORKFLOWS = ['todo_workflow', 'plan_workflow', 'in_progress_workflow', 'review_workflow', 'merging_workflow'];
const NO_ACTIONS_BLOCK_WORKFLOWS = ['backlog_workflow', 'done_workflow'];
const INVESTIGATE_MARKER = '선(先) 조사 원칙';
const ACTIONS_MARKER = 'Actions — run a registered Action before you Pending';

const CUSTOM_CONTENT = `# To Do — Custom workflow with operator tweaks

This row is operator-edited — it does NOT match the prior default. The migration MUST leave it alone.
`;

test('prompt-audit template refresh migration: updates stale defaults, preserves customizations, idempotent, reversible', async (t) => {
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
        '1760000000072-RefreshDefaultPromptTemplatesPromptAudit.js',
      )
  );
  const MigrationClass = migrationModule.RefreshDefaultPromptTemplatesPromptAudit1760000000072;
  assert.ok(MigrationClass, 'migration class export missing — check dist build');
  const PRIOR = migrationModule.PRIOR_DEFAULT_CONTENTS;
  assert.ok(PRIOR, 'migration must export PRIOR_DEFAULT_CONTENTS for this test');
  for (const name of ALL_SEVEN) {
    assert.ok(PRIOR[name] && PRIOR[name][0], `migration must export PRIOR_DEFAULT_CONTENTS['${name}']`);
  }

  const defaultsModule = await import(
    'file://' + path.join(DIST_ROOT, 'database', 'default-prompt-templates.js')
  );
  const currentByName = new Map(
    defaultsModule.DEFAULT_PROMPT_TEMPLATES.map((d) => [d.name, d.content]),
  );

  step('Sanity — current defaults carry the new guidance; PRIOR does not');
  for (const name of ALL_SEVEN) {
    assert.ok(
      currentByName.get(name).includes(INVESTIGATE_MARKER),
      `sanity — current ${name} must carry the 선(先) 조사 원칙 rule`,
    );
    assert.ok(
      !PRIOR[name][0].includes(INVESTIGATE_MARKER),
      `sanity — prior ${name} literal must be pre-change (no 선(先) 조사 원칙)`,
    );
  }
  for (const name of ACTIONS_BLOCK_WORKFLOWS) {
    assert.ok(
      currentByName.get(name).includes(ACTIONS_MARKER),
      `sanity — current ${name} must carry the Actions-before-Pending block`,
    );
  }
  for (const name of NO_ACTIONS_BLOCK_WORKFLOWS) {
    assert.ok(
      !currentByName.get(name).includes(ACTIONS_MARKER),
      `sanity — current ${name} must NOT carry the Actions-before-Pending block (no pend_ticket path there)`,
    );
  }

  step('Seed three workspaces: stale (all 7 at PRIOR), customized (one drifted row), missing (zero rows)');
  const wsStale = await createWorkspace(app, getDataSourceToken, 'stale');
  await tplRepo.save(
    ALL_SEVEN.map((name) =>
      tplRepo.create({
        workspace_id: wsStale.id,
        name,
        description: 'pre-ec498050',
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

  step('Case 1 — stale workspace: all 7 templates refreshed to current');
  for (const name of ALL_SEVEN) {
    const row = await tplRepo.findOne({ where: { workspace_id: wsStale.id, name } });
    assert.ok(row, `wsStale must still have row ${name}`);
    assert.equal(row.content, currentByName.get(name), `wsStale ${name} must hold current content`);
    assert.ok(row.content.includes(INVESTIGATE_MARKER), `refreshed ${name} must carry 선(先) 조사 원칙`);
  }

  step('Case 2 — customized workspace: operator edit preserved byte-for-byte');
  const customAfter = await tplRepo.findOne({
    where: { workspace_id: wsCustom.id, name: 'todo_workflow' },
  });
  assert.equal(customAfter.content, CUSTOM_CONTENT, 'operator-customized template MUST be left alone');

  step('Case 3 — missing workspace: no rows inserted by the refresh path');
  const missingAfter = await tplRepo.find({ where: { workspace_id: wsMissing.id } });
  assert.equal(missingAfter.length, 0, 'refresh migration must not insert (seed path owns that)');

  step('Case 4 — re-run up(): idempotent no-op on already-current rows');
  const beforeRerun = await tplRepo.find({ where: { workspace_id: wsStale.id }, order: { name: 'ASC' } });
  const stamp = (rows) => rows.map((r) => `${r.name}:${r.updated_at?.toISOString?.() ?? r.updated_at}`);
  const beforeStamps = stamp(beforeRerun);
  await new Promise((r) => setTimeout(r, 50));
  await migration.up(queryRunner);
  const afterRerunStamps = stamp(
    await tplRepo.find({ where: { workspace_id: wsStale.id }, order: { name: 'ASC' } }),
  );
  assert.deepStrictEqual(afterRerunStamps, beforeStamps, 'idempotency — re-run of up() must not touch any row');

  step('Case 5 — down(): reverses the refreshed rows back to byte-exact PRIOR content');
  await migration.down(queryRunner);
  for (const name of ALL_SEVEN) {
    const row = await tplRepo.findOne({ where: { workspace_id: wsStale.id, name } });
    assert.equal(row.content, PRIOR[name][0], `wsStale ${name} must round-trip back to byte-exact PRIOR content`);
  }
  // The customized row must still be untouched by the reversal too.
  const customAfterDown = await tplRepo.findOne({
    where: { workspace_id: wsCustom.id, name: 'todo_workflow' },
  });
  assert.equal(customAfterDown.content, CUSTOM_CONTENT, 'down() must also leave operator customizations alone');

  step('Case 6 — re-run down(): idempotent no-op once already at PRIOR content');
  const beforeRerunDown = stamp(
    await tplRepo.find({ where: { workspace_id: wsStale.id }, order: { name: 'ASC' } }),
  );
  await new Promise((r) => setTimeout(r, 50));
  await migration.down(queryRunner);
  const afterRerunDownStamps = stamp(
    await tplRepo.find({ where: { workspace_id: wsStale.id }, order: { name: 'ASC' } }),
  );
  assert.deepStrictEqual(afterRerunDownStamps, beforeRerunDown, 'idempotency — re-run of down() must not touch any row');

  exitAfterTests(0);
});
