// QA flow: v0.34.3 prompt template refresh migration
// (ticket a57517be — Ticket Blocking 개선, reviewer Finding B).
//
// What this proves
// ────────────────
//
// Before this fix, the v0.34.3 "park instead of ping-pong" guidance only
// landed on freshly-created workspaces. The existing
// `1760000000010-BackfillDefaultPromptTemplates` migration inserts
// missing templates by `name` but never touches existing rows — every
// upgraded install keeps the v0.34.2 prompt content, so agents on those
// boards never learn `pend_ticket` / `create_ticket` and the
// System ↔ Agent loop the ticket exists to kill stays open.
//
// The fix is `1760000000022-RefreshDefaultPromptTemplatesV0_34_3`: a
// content-driven, operator-safe data migration that updates any
// workspace's todo / plan / in-progress workflow rows whose content
// matches the byte-exact v0.34.2 default, while leaving customized rows
// alone.
//
// Acceptance:
//
//   1. A workspace whose three workflow templates hold the v0.34.2
//      default content gets all three refreshed to the v0.34.3 content
//      (which contains the pend_ticket / create_ticket guidance).
//   2. A workspace whose templates have been operator-customized keeps
//      its custom content byte-for-byte intact.
//   3. A workspace missing a template entirely is skipped, not inserted.
//   4. Re-running the migration on a fully-refreshed workspace is a
//      no-op (idempotent — the row is now at current content, so the
//      prior-content match fails).

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootApp, exitAfterTests, step } from '../helpers/boot.mjs';
import { createWorkspace } from '../helpers/fixtures.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST_ROOT = path.resolve(__dirname, '..', '..', 'dist');

// Port 7838 — unique slot, doesn't collide with unpend-emits-trigger (7836),
// backlog-promotion-pending (7834), or other QA flows.
process.env.PORT = process.env.QA_PROMPT_REFRESH_PORT || '7838';

// Exact v0.34.2 (pre-7722527) content for one of the refreshed templates.
// Match must be byte-exact, so reproduced verbatim from
// `default-prompt-templates.ts` at commit 7722527~1 — the same string the
// migration's PRIOR_TODO_WORKFLOW constant carries.
const V0_34_2_TODO_WORKFLOW = `# To Do — Start-or-Wait Decision (assignee)

This ticket is in the To Do column and you are its assignee. Decide whether to start now or wait.

> **Environment**: assignee has a local repo and will do real development. No git commands yet — those begin in \`in_progress_workflow\`. This prompt is purely a decision step.

## Steps

1. **Read the ticket** — \`mcp__awb__get_ticket\` to load body, comments, assignee / reporter / reviewer, priority, and any attached context. If requirements are unclear, leave a question comment and stop (do not \`move_ticket\`).

2. **List your in-progress work** — \`mcp__awb__get_my_tickets\` with \`status="in_progress"\` to see everything you are currently working on.

3. **Concurrent-work check**:
   - **No active work** → safe to start immediately.
   - **Active work exists** → for each in-progress ticket, evaluate:
     - **File / module overlap** — will this ticket touch the same files, modules, or packages?
     - **Dependency** — does this ticket need output (API, entity, migration, schema) from the in-progress ticket?
     - **Shared resources** — DB migrations, CI pipelines, or shared config files that are hard to isolate.
   - If *every* in-progress ticket is independent, parallel is OK. A single overlap means **wait**.

4. **Decision**:
   - **Start** → \`add_comment\` with:
     - A one-line "starting" declaration.
     - If running in parallel: list concurrent ticket ids and the independence rationale (e.g., \`"touching apps/client/src/components/chat/* only — no overlap with ticket 1f92d68"\`).
     Then \`move_ticket\` to **In Progress**.
   - **Wait** → \`add_comment\` with the waiting reason and which ticket you are waiting on. Do **not** \`move_ticket\`.

5. **After In Progress** — \`in_progress_workflow\` takes over with the branch → work → push → Review hand-off flow.

## Notes

- If you already have **3 or more in-progress tickets**, finish one before starting a new one. Context-switch cost outweighs concurrency.
- Never start a ticket whose file / module scope overlaps with an active one. Sequential is the default.
- When in doubt, ask the reviewer or reporter via \`add_comment\` and wait — never start on a guess.
- If a \`priority: critical\` ticket enters the queue, finish the current commit boundary (commit + push) on your non-critical work cleanly, then pick the critical. Never abandon mid-file.
- If you are not the assignee, do not \`move_ticket\`. If this looks like a misassignment, leave a comment and stop.
`;

const CUSTOM_CONTENT = `# To Do — Custom workflow with operator tweaks

This row has been edited by the operator — content does NOT match the
v0.34.2 default. The migration MUST leave this row alone.
`;

test('v0.34.3 prompt template refresh migration updates stale defaults, preserves customizations, idempotent', async (t) => {
  step('Boot NestJS app on test port');
  const { app, modules } = await bootApp({ port: parseInt(process.env.PORT, 10) });
  t.after(() => app.close().catch(() => {}));
  const { getDataSourceToken } = modules;
  const ds = app.get(getDataSourceToken());
  const tplRepo = ds.getRepository('PromptTemplate');

  // Import the migration class directly from dist — we'll invoke up()
  // against a synthetic queryRunner so we can test the refresh logic
  // post-fixture-setup, not as part of the bootApp migration pass that
  // already ran (and would have hit empty workspace state).
  const migrationModule = await import(
    'file://' +
      path.join(
        DIST_ROOT,
        'database',
        'migrations',
        '1760000000022-RefreshDefaultPromptTemplatesV0_34_3.js',
      )
  );
  const MigrationClass = migrationModule.RefreshDefaultPromptTemplatesV0_34_31760000000022;
  assert.ok(MigrationClass, 'migration class export missing — check dist build');

  // Also load the current default content so the assertions can reference
  // it without re-encoding the full template literal in this test file.
  const defaultsModule = await import(
    'file://' + path.join(DIST_ROOT, 'database', 'default-prompt-templates.js')
  );
  const DEFAULT_PROMPT_TEMPLATES = defaultsModule.DEFAULT_PROMPT_TEMPLATES;
  const currentByName = new Map(DEFAULT_PROMPT_TEMPLATES.map((d) => [d.name, d.content]));
  assert.ok(currentByName.get('todo_workflow').includes('pend_ticket'),
    'sanity — current todo_workflow default must contain pend_ticket guidance (was the change rolled back?)');
  assert.ok(currentByName.get('in_progress_workflow').includes('When to park instead of bouncing back'),
    'sanity — current in_progress_workflow default must contain the park-vs-bounce section');

  step('Seed three workspaces: stale, customized, and missing');

  // Workspace A — stale: holds v0.34.2 default content for all three
  // refreshed templates. The migration MUST refresh all three.
  const wsStale = await createWorkspace(app, getDataSourceToken, 'stale');
  await tplRepo.save([
    tplRepo.create({
      workspace_id: wsStale.id, name: 'todo_workflow',
      description: 'pre-v0.34.3', category: 'default_workflow',
      // Use the byte-exact prior literal above.
      content: V0_34_2_TODO_WORKFLOW,
    }),
    // For plan / in_progress, copy the prior content directly from the
    // migration's PRIOR_DEFAULT_CONTENTS via the migration module so the
    // test fixture stays in lockstep with the migration. Loading them
    // here avoids dragging another ~120 lines of literal markdown into
    // this test for the byte-match check the migration enforces.
    ...['plan_workflow', 'in_progress_workflow'].map((name) => {
      const prior = migrationModule.PRIOR_DEFAULT_CONTENTS?.[name];
      assert.ok(prior && prior[0],
        `migration must export PRIOR_DEFAULT_CONTENTS['${name}'] for this test (add the export)`);
      return tplRepo.create({
        workspace_id: wsStale.id, name,
        description: 'pre-v0.34.3', category: 'default_workflow',
        content: prior[0],
      });
    }),
  ]);

  // Workspace B — customized: operator has edited the todo_workflow row
  // to something that does NOT match the v0.34.2 default. Migration MUST
  // leave it alone.
  const wsCustom = await createWorkspace(app, getDataSourceToken, 'custom');
  await tplRepo.save([
    tplRepo.create({
      workspace_id: wsCustom.id, name: 'todo_workflow',
      description: 'operator-customized', category: 'default_workflow',
      content: CUSTOM_CONTENT,
    }),
  ]);

  // Workspace C — missing: holds none of the three templates. Migration
  // must NOT insert (that's the seed/backfill path's job).
  const wsMissing = await createWorkspace(app, getDataSourceToken, 'missing');
  // No template rows seeded for this workspace by the test (createWorkspace
  // doesn't auto-seed defaults). Verify the precondition.
  const missingBefore = await tplRepo.find({ where: { workspace_id: wsMissing.id } });
  assert.equal(missingBefore.length, 0,
    'precondition — wsMissing must start with zero template rows');

  step('Run migration.up() — first pass');
  // Synthetic queryRunner: the migration only uses queryRunner.manager,
  // which the DataSource exposes as `ds.manager`. Wrap that.
  const queryRunner = { manager: ds.manager };
  const migration = new MigrationClass();
  await migration.up(queryRunner);

  step('Case 1 — stale workspace: all three refreshed templates now hold current default content');
  for (const name of ['todo_workflow', 'plan_workflow', 'in_progress_workflow']) {
    const row = await tplRepo.findOne({ where: { workspace_id: wsStale.id, name } });
    assert.ok(row, `wsStale must still have row ${name} after migration`);
    assert.equal(row.content, currentByName.get(name),
      `wsStale ${name} must hold current default content after refresh`);
  }
  // Sanity: the refreshed todo_workflow now contains the new guidance
  // string the reviewer specifically called out — the content match
  // alone isn't enough proof for a human reader.
  const refreshedTodo = await tplRepo.findOne({
    where: { workspace_id: wsStale.id, name: 'todo_workflow' },
  });
  assert.ok(refreshedTodo.content.includes('mcp__awb__pend_ticket'),
    'refreshed todo_workflow must surface the pend_ticket guidance the v0.34.3 change added');

  step('Case 2 — customized workspace: operator edit preserved byte-for-byte');
  const customAfter = await tplRepo.findOne({
    where: { workspace_id: wsCustom.id, name: 'todo_workflow' },
  });
  assert.equal(customAfter.content, CUSTOM_CONTENT,
    'operator-customized template MUST be left alone — content drift means the safety match is broken');

  step('Case 3 — missing workspace: no rows inserted by the refresh path');
  const missingAfter = await tplRepo.find({ where: { workspace_id: wsMissing.id } });
  assert.equal(missingAfter.length, 0,
    'wsMissing must still have zero rows — the refresh migration must not insert (seed path owns that)');

  step('Case 4 — re-run migration: idempotent no-op on already-refreshed rows');
  // After pass 1, wsStale rows hold current content (not prior), so a
  // second pass must update nothing. Capture updated_at timestamps to
  // prove no row was re-written.
  const beforeRerun = await tplRepo.find({
    where: { workspace_id: wsStale.id },
    order: { name: 'ASC' },
  });
  const beforeStamps = beforeRerun.map((r) => `${r.name}:${r.updated_at?.toISOString?.() ?? r.updated_at}`);
  // Pause a beat so any spurious save() would produce a fresh updated_at.
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
