// QA flow: in_progress / merging default prompt template refresh migration
// (ticket 3377b7e2 — "always start from latest tip" + Merging actively
// integrates instead of bouncing on first conflict).
//
// What this proves
// ────────────────
//
// The new git policy (in_progress_workflow: always fetch+pull/rebase before
// work; merging_workflow: relax strict ff-only → rebase & integrate
// same-meaning conflicts, escalate only on a genuinely big problem) is
// baked into `default-prompt-templates.ts`. New workspaces pick it up via
// the seed path, but existing workspaces keep their old rows because the
// seed/backfill paths are insert-only. Migration
// `1760000000030-RefreshDefaultPromptTemplatesIntegrate` closes that gap
// with the same operator-safe, byte-exact content match as the v0.34.3
// refresh.
//
// Acceptance:
//   1. A workspace whose in_progress + merging rows hold the pre-change
//      default content gets both refreshed to the current content (which
//      contains the new policy language).
//   2. An operator-customized row is left byte-for-byte intact.
//   3. A workspace missing the templates is skipped, not inserted.
//   4. Re-running the migration is a no-op (idempotent).

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootApp, exitAfterTests, step } from '../helpers/boot.mjs';
import { createWorkspace } from '../helpers/fixtures.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST_ROOT = path.resolve(__dirname, '..', '..', 'dist');

// Port 7840 — unique slot, doesn't collide with prompt-template-refresh
// (7838) or the other QA flows.
process.env.PORT = process.env.QA_PROMPT_REFRESH_INTEGRATE_PORT || '7840';

const CUSTOM_CONTENT = `# Merging — Custom workflow with operator tweaks

This row has been edited by the operator — content does NOT match the
pre-change default. The migration MUST leave this row alone.
`;

test('integrate-policy prompt template refresh migration updates stale defaults, preserves customizations, idempotent', async (t) => {
  step('Boot NestJS app on test port');
  const { app, modules } = await bootApp({ port: parseInt(process.env.PORT, 10) });
  t.after(() => app.close().catch(() => {}));
  const { getDataSourceToken } = modules;
  const ds = app.get(getDataSourceToken());
  const tplRepo = ds.getRepository('PromptTemplate');

  const migrationModule = await import(
    'file://' +
      path.join(
        DIST_ROOT,
        'database',
        'migrations',
        '1760000000030-RefreshDefaultPromptTemplatesIntegrate.js',
      )
  );
  const MigrationClass = migrationModule.RefreshDefaultPromptTemplatesIntegrate1760000000030;
  assert.ok(MigrationClass, 'migration class export missing — check dist build');

  const defaultsModule = await import(
    'file://' + path.join(DIST_ROOT, 'database', 'default-prompt-templates.js')
  );
  const DEFAULT_PROMPT_TEMPLATES = defaultsModule.DEFAULT_PROMPT_TEMPLATES;
  const currentByName = new Map(DEFAULT_PROMPT_TEMPLATES.map((d) => [d.name, d.content]));
  // Sanity: the current defaults must carry the new policy language, else
  // the code change was rolled back and this test would falsely pass.
  assert.ok(
    currentByName.get('in_progress_workflow').includes('always start from the latest tip'),
    'sanity — current in_progress_workflow must carry the "always start from the latest tip" rule',
  );
  assert.ok(
    currentByName.get('merging_workflow').includes('When to integrate vs. escalate'),
    'sanity — current merging_workflow must carry the integrate-vs-escalate boundary',
  );

  const REFRESHED = ['in_progress_workflow', 'merging_workflow'];

  step('Seed three workspaces: stale, customized, and missing');

  // Workspace A — stale: holds the byte-exact pre-change default content
  // for both refreshed templates (sourced from the migration's exported
  // PRIOR_INTEGRATE_CONTENTS so the fixture stays in lockstep). Migration
  // MUST refresh both.
  const wsStale = await createWorkspace(app, getDataSourceToken, 'stale-int');
  await tplRepo.save(
    REFRESHED.map((name) => {
      const prior = migrationModule.PRIOR_INTEGRATE_CONTENTS?.[name];
      assert.ok(
        prior && prior[0],
        `migration must export PRIOR_INTEGRATE_CONTENTS['${name}'] for this test`,
      );
      return tplRepo.create({
        workspace_id: wsStale.id,
        name,
        description: 'pre-3377b7e2',
        category: 'default_workflow',
        content: prior[0],
      });
    }),
  );

  // Workspace B — customized merging row: must be left alone.
  const wsCustom = await createWorkspace(app, getDataSourceToken, 'custom-int');
  await tplRepo.save([
    tplRepo.create({
      workspace_id: wsCustom.id,
      name: 'merging_workflow',
      description: 'operator-customized',
      category: 'default_workflow',
      content: CUSTOM_CONTENT,
    }),
  ]);

  // Workspace C — missing: holds none of the refreshed templates.
  const wsMissing = await createWorkspace(app, getDataSourceToken, 'missing-int');
  const missingBefore = await tplRepo.find({ where: { workspace_id: wsMissing.id } });
  assert.equal(missingBefore.length, 0, 'precondition — wsMissing must start with zero template rows');

  step('Run migration.up() — first pass');
  const queryRunner = { manager: ds.manager };
  const migration = new MigrationClass();
  await migration.up(queryRunner);

  step('Case 1 — stale workspace: both refreshed templates now hold current default content');
  for (const name of REFRESHED) {
    const row = await tplRepo.findOne({ where: { workspace_id: wsStale.id, name } });
    assert.ok(row, `wsStale must still have row ${name} after migration`);
    assert.equal(
      row.content,
      currentByName.get(name),
      `wsStale ${name} must hold current default content after refresh`,
    );
  }
  const refreshedMerging = await tplRepo.findOne({
    where: { workspace_id: wsStale.id, name: 'merging_workflow' },
  });
  assert.ok(
    refreshedMerging.content.includes('When to integrate vs. escalate'),
    'refreshed merging_workflow must surface the integrate-vs-escalate boundary the change added',
  );
  const refreshedInProgress = await tplRepo.findOne({
    where: { workspace_id: wsStale.id, name: 'in_progress_workflow' },
  });
  assert.ok(
    refreshedInProgress.content.includes('Never start work from a stale state'),
    'refreshed in_progress_workflow must surface the no-stale-start rule the change added',
  );

  step('Case 2 — customized workspace: operator edit preserved byte-for-byte');
  const customAfter = await tplRepo.findOne({
    where: { workspace_id: wsCustom.id, name: 'merging_workflow' },
  });
  assert.equal(
    customAfter.content,
    CUSTOM_CONTENT,
    'operator-customized template MUST be left alone — content drift means the safety match is broken',
  );

  step('Case 3 — missing workspace: no rows inserted by the refresh path');
  const missingAfter = await tplRepo.find({ where: { workspace_id: wsMissing.id } });
  assert.equal(
    missingAfter.length,
    0,
    'wsMissing must still have zero rows — the refresh migration must not insert (seed path owns that)',
  );

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
  assert.deepStrictEqual(
    afterStamps,
    beforeStamps,
    'idempotency — re-running the migration must not touch any row (updated_at unchanged)',
  );

  exitAfterTests(0);
});
