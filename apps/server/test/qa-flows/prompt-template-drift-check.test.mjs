// QA flow: prompt template drift check (ticket 4a48a0b8, 623400e7 follow-up).
//
// What this proves
// ────────────────
//
// 623400e7's migration 1760000000076 landed on `main`, but this workspace's
// serving deployment was 21 minutes behind, so the migration file didn't
// exist in the running code yet and `merging_workflow` stayed on its
// pre-gate content for at least a day. That specific gap was ordinary
// deploy lag (self-resolving on the next redeploy), not a bug — but it
// exposed a DIFFERENT silent-failure class this check targets: a
// content-refresh migration recorded as applied (present in the `migrations`
// history table) while a workspace's template row is somehow still
// byte-exact stuck on the pre-migration snapshot.
//
// Acceptance:
//   1. Fresh boot-seeded workspace (current content, migration 076 applied
//      per history) → zero drift. The check must not cry wolf on the
//      ordinary, healthy state.
//   2. A row artificially rolled back to migration 076's PRIOR snapshot,
//      with the migration still recorded as applied → flagged as drifted.
//   3. Same rolled-back row, but with migration 076's history row deleted
//      (simulating "migration hasn't actually run yet" — the real
//      deploy-lag incident this ticket investigated) → NOT flagged. This is
//      the case that must never false-positive.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootApp, exitAfterTests, step } from '../helpers/boot.mjs';
import { createWorkspace } from '../helpers/fixtures.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST_ROOT = path.resolve(__dirname, '..', '..', 'dist');

// 포트 7931 — 기존 qa-flow 최대치(7930) 다음 번호, 미충돌.
process.env.PORT = process.env.QA_PROMPT_TEMPLATE_DRIFT_PORT || '7931';

const MIGRATION_NAME = 'RefreshDefaultPromptTemplatesCiDispatchGate1760000000076';
const TEMPLATE_NAME = 'merging_workflow';

test('prompt template drift check flags a row stuck on an applied migration\'s PRIOR content, but not on deploy-lag (migration not yet applied)', async (t) => {
  step('Boot NestJS app on test port');
  const { app, modules } = await bootApp({ port: parseInt(process.env.PORT, 10) });
  t.after(() => { void app.close().catch(() => {}); });
  const { getDataSourceToken } = modules;
  const ds = app.get(getDataSourceToken());
  const tplRepo = ds.getRepository('PromptTemplate');

  const driftModule = await import(
    'file://' + path.join(DIST_ROOT, 'database', 'prompt-template-drift-check.js')
  );
  const { checkPromptTemplateDrift, DRIFT_REGISTRY } = driftModule;
  assert.ok(typeof checkPromptTemplateDrift === 'function', 'checkPromptTemplateDrift export missing — check dist build');

  const registryEntry = DRIFT_REGISTRY.find((e) => e.migrationName === MIGRATION_NAME);
  assert.ok(registryEntry, `DRIFT_REGISTRY must include ${MIGRATION_NAME}`);
  const priorContent = registryEntry.priorContents[TEMPLATE_NAME]?.[0];
  assert.ok(priorContent, `${MIGRATION_NAME} must capture a PRIOR snapshot for ${TEMPLATE_NAME}`);

  step('Case 1 — fresh boot-seeded default workspace: zero drift');
  // DatabaseModule.onModuleInit() only auto-seeds PromptTemplate rows for the
  // FIRST workspace (wsCount===0 path) — createWorkspace() fixture rows below
  // deliberately do NOT get that seeding, matching prompt-template-refresh
  // sibling tests, which create rows by hand for the same reason.
  const baseline = await checkPromptTemplateDrift(ds);
  assert.equal(baseline.migrations_registered, DRIFT_REGISTRY.length,
    'migrations_registered must equal the full registry size');
  assert.ok(baseline.migrations_applied > 0,
    'a fresh DB runs every migration at boot — migrations_applied must be > 0');
  assert.deepEqual(baseline.drifted, [],
    'the boot-seeded default workspace on current content must never be reported as drifted');

  step('Case 2 — row rolled back to migration 076\'s PRIOR content, migration still recorded as applied → flagged');
  const ws = await createWorkspace(app, getDataSourceToken, 'drift-check');
  const row = await tplRepo.save(tplRepo.create({
    workspace_id: ws.id,
    name: TEMPLATE_NAME,
    description: 'drift-check fixture',
    category: 'default_workflow',
    content: priorContent,
  }));

  const withDrift = await checkPromptTemplateDrift(ds);
  const hit = withDrift.drifted.find(
    (d) => d.workspace_id === ws.id && d.template_name === TEMPLATE_NAME && d.migration_name === MIGRATION_NAME,
  );
  assert.ok(hit, `expected a drift entry for ws=${ws.id} template=${TEMPLATE_NAME} migration=${MIGRATION_NAME}, got: ${JSON.stringify(withDrift.drifted)}`);

  step('Case 3 — same stale row, but migration 076 NOT recorded as applied (deploy lag) → must NOT be flagged');
  // MIGRATION_NAME is a hardcoded local constant (not external input) — plain
  // interpolation is safe and avoids dialect-specific placeholder syntax
  // (sqlite/mysql `?` vs postgres `$1`) for this one-off test-only DELETE.
  await ds.query(`DELETE FROM migrations WHERE name = '${MIGRATION_NAME}'`);
  const afterUnapply = await checkPromptTemplateDrift(ds);
  assert.equal(afterUnapply.migrations_applied, withDrift.migrations_applied - 1,
    'migrations_applied must drop by exactly one once the migration history row is removed');
  const falsePositive = afterUnapply.drifted.find(
    (d) => d.workspace_id === ws.id && d.template_name === TEMPLATE_NAME && d.migration_name === MIGRATION_NAME,
  );
  assert.equal(falsePositive, undefined,
    'a migration that has not run yet must never be reported as drift — this is the deploy-lag case ticket 4a48a0b8 investigated');

  exitAfterTests(0);
});
