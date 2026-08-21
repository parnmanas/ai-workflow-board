// Postgres-only: the GLOBAL skill slug constraint.
//
// `Skill` keeps `@Index(['workspace_id','slug'], {unique:true})` for the sql.js
// dev backend, but on Postgres that index does NOT constrain global rows —
// `NULL != NULL` there, so it would happily accept ten global skills sharing a
// slug, and `list()` would then return duplicates that shadow each other
// nondeterministically. The real guarantee is the PARTIAL unique index created
// in migration 1760000000077 (`uq_skills_global_slug`), and a partial index is
// exactly the thing sql.js cannot model — so this assertion only means
// anything here, in the Postgres dialect matrix.
//
// Runs under `npm run test:qa:pg` (CI job `postgres-dialect-matrix`). On any
// other backend it self-skips rather than asserting something untrue.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { bootApp, exitAfterTests } from '../helpers/boot.mjs';
import { setupKanbanScene } from '../helpers/fixtures.mjs';

const BASE_PORT = parseInt(process.env.QA_SKILL_PG_PORT || '7895', 10);

const { app, modules } = await bootApp({ port: BASE_PORT });
after(() => { void app.close().catch(() => {}); });
const ds = app.get(modules.getDataSourceToken());
const isPostgres = ds.options.type === 'postgres';

const DIST = path.join(process.cwd(), 'dist');
const { SkillsService } = await import('file://' + path.join(DIST, 'modules', 'skills', 'skills.service.js'));
const skills = app.get(SkillsService);

const stamp = Date.now();

test('two global skills cannot share a slug (partial unique index)', { skip: !isPostgres && 'postgres only' }, async () => {
  const slug = `pg-dup-${stamp}`;
  await skills.create('', { slug, name: 'First', body: '# first\n' }, 'admin', 'global');

  await assert.rejects(
    () => skills.create('', { slug, name: 'Second', body: '# second\n' }, 'admin', 'global'),
    'a second GLOBAL skill with the same slug must be refused',
  );

  const rows = await ds.query(
    'SELECT count(*)::int AS n FROM skills WHERE slug = $1 AND workspace_id IS NULL',
    [slug],
  );
  assert.equal(rows[0].n, 1, 'exactly one global row may exist for a slug');
});

test('the partial unique indexes exist and are scoped as documented', { skip: !isPostgres && 'postgres only' }, async () => {
  const rows = await ds.query(
    `SELECT indexname, indexdef FROM pg_indexes
     WHERE tablename = 'skills' AND indexname IN ('uq_skills_global_slug', 'uq_skills_workspace_slug')`,
  );
  const byName = new Map(rows.map((r) => [r.indexname, r.indexdef]));
  assert.ok(byName.has('uq_skills_global_slug'), 'migration 1760000000077 must create uq_skills_global_slug');
  assert.ok(byName.has('uq_skills_workspace_slug'), 'migration 1760000000077 must create uq_skills_workspace_slug');
  assert.match(byName.get('uq_skills_global_slug'), /WHERE .*workspace_id IS NULL/i);
  assert.match(byName.get('uq_skills_workspace_slug'), /WHERE .*workspace_id IS NOT NULL/i);
});

test('a workspace MAY reuse a global slug — that is the fork path, not a conflict', { skip: !isPostgres && 'postgres only' }, async () => {
  const { ws } = await setupKanbanScene(app, modules.getDataSourceToken, { workspaceName: `pgfork-${stamp}` });
  const slug = `pg-fork-${stamp}`;
  await skills.create('', { slug, name: 'Global', body: '# global\n' }, 'admin', 'global');
  const fork = await skills.create(ws.id, { slug, name: 'Fork', body: '# fork\n' }, 'tester', 'workspace');
  assert.equal(fork.workspace_id, ws.id);

  // ...but only once per workspace.
  await assert.rejects(
    () => skills.create(ws.id, { slug, name: 'Again', body: '# again\n' }, 'tester', 'workspace'),
    'a workspace may not hold two skills with the same slug',
  );

  const visible = await skills.list(ws.id);
  const matches = visible.filter((s) => s.slug === slug);
  assert.equal(matches.length, 1, 'shadowing must collapse to one row');
  assert.equal(matches[0].workspace_id, ws.id, 'the workspace fork must win');
});

test('a global skill\'s versions are stored with workspace_id NULL', { skip: !isPostgres && 'postgres only' }, async () => {
  const created = await skills.create(
    '', { slug: `pg-ver-${stamp}`, name: 'Versions', body: '# v1\n' }, 'admin', 'global',
  );
  await skills.publish('', created.id, { body: '# v2\n' }, 'admin');
  const rows = await ds.query(
    'SELECT version, workspace_id FROM skill_versions WHERE skill_id = $1 ORDER BY version',
    [created.id],
  );
  assert.equal(rows.length, 2, 'publishing must append, not replace');
  assert.deepEqual(rows.map((r) => r.version), [1, 2], 'version numbering must continue on a global skill');
  assert.ok(rows.every((r) => r.workspace_id === null), 'versions of a global skill must be global too');
});

exitAfterTests();
