// Global skill scope + the built-in pack / tap registry that feeds it.
//
// Before this work `Skill.workspace_id` was NOT NULL and every query was a
// plain equality, so a global skill was not merely missing — it was
// unrepresentable. These tests lock the contract that replaced it:
//
//   1. Global (workspace_id NULL) + Workspace scope, per docs/catalog-scopes.md.
//   2. A workspace skill SHADOWS a global one with the same slug (the
//      precedence WorkflowFunction uses for its key), and forking is how a
//      workspace diverges from a built-in.
//   3. A workspace caller may READ and ASSIGN a global skill but never publish
//      into it or quarantine it — those are admin/global operations.
//   4. A run's pinned manifest includes global skills. This is the regression
//      that would silently ship a run WITHOUT the built-in skills the operator
//      assigned, because the old resolver filtered versions by workspace.
//   5. The built-in pack seeds at boot, is idempotent, append-only, and treats
//      quarantine as an operator veto.
//
// Imports the compiled server from dist/ (built by `npm run build`).

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { bootApp, exitAfterTests } from './helpers/boot.mjs';
import { createAgent, setupKanbanScene } from './helpers/fixtures.mjs';

const BASE_PORT = parseInt(process.env.QA_SKILL_GLOBAL_PORT || '7894', 10);

const { app, modules } = await bootApp({ port: BASE_PORT });
after(() => { void app.close().catch(() => {}); });
const { getDataSourceToken } = modules;
const ds = app.get(getDataSourceToken());

const DIST = path.join(process.cwd(), 'dist');
const { SkillsService } = await import('file://' + path.join(DIST, 'modules', 'skills', 'skills.service.js'));
const { RunSkillSnapshotService } = await import(
  'file://' + path.join(DIST, 'modules', 'skills', 'run-skill-snapshot.service.js')
);
const { BuiltinSkillPackService } = await import(
  'file://' + path.join(DIST, 'modules', 'skills', 'builtin-skill-pack.service.js')
);
const { SkillTapService } = await import('file://' + path.join(DIST, 'modules', 'skills', 'skill-tap.service.js'));

const skills = app.get(SkillsService);
const snapshots = app.get(RunSkillSnapshotService);
const builtin = app.get(BuiltinSkillPackService);
const taps = app.get(SkillTapService);

const { ws } = await setupKanbanScene(app, getDataSourceToken, { workspaceName: 'skill-scope' });
const other = await setupKanbanScene(app, getDataSourceToken, { workspaceName: 'skill-scope-other' });
const agent = await createAgent(app, getDataSourceToken, ws.id, { name: 'skilled', type: 'hermes', hosted: false });

const stamp = Date.now();

// ─── 1. The built-in pack seeded at boot ─────────────────────────────────────
test('the in-repo built-in pack is seeded into the global scope at boot', async () => {
  const globals = await skills.listGlobal();
  assert.ok(globals.length > 0, 'boot must seed at least one global skill from skills/');
  assert.ok(
    globals.every((s) => s.workspace_id === null),
    'every row from listGlobal must carry workspace_id NULL',
  );
  const pack = globals.filter((s) => s.source_kind === 'builtin');
  assert.ok(pack.length > 0, 'seeded rows must be marked source_kind=builtin so a re-seed recognises them');
  assert.ok(
    pack.every((s) => s.source_path.endsWith('/SKILL.md')),
    'each row must record the SKILL.md path it came from — that is the sync key',
  );
});

test('re-seeding is idempotent — identical content publishes no new version', async () => {
  const before = await ds.getRepository('SkillVersion').count();
  const first = await builtin.seed();
  const after1 = await ds.getRepository('SkillVersion').count();
  assert.equal(first.created, 0, 'a second seed must create nothing');
  assert.equal(first.updated, 0, 'a second seed must publish no new version');
  assert.ok(first.alreadyCurrent > 0, 'every pack skill must report as already current');
  assert.equal(after1, before, 'version count must not move on a no-op seed');
});

// ─── 2. Scope, visibility, shadowing ─────────────────────────────────────────
test('a workspace sees global + its own skills, and never another workspace\'s', async () => {
  const mine = await skills.create(ws.id, {
    slug: `ws-only-${stamp}`, name: 'Workspace only', body: '# ws only\n',
  }, 'tester', 'workspace');
  await skills.create(other.ws.id, {
    slug: `other-only-${stamp}`, name: 'Other only', body: '# other only\n',
  }, 'tester', 'workspace');

  const visible = await skills.list(ws.id);
  const slugs = new Set(visible.map((s) => s.slug));
  assert.ok(slugs.has(`ws-only-${stamp}`), 'own workspace skill must be visible');
  assert.ok(slugs.has('systematic-debugging'), 'global built-in must be visible from a workspace');
  assert.ok(!slugs.has(`other-only-${stamp}`), "another workspace's skill must NOT leak in");

  assert.equal(mine.scope, 'workspace');
  assert.equal(visible.find((s) => s.slug === 'systematic-debugging').scope, 'global');
});

test('a workspace skill shadows a global one with the same slug; include_shadowed reveals both', async () => {
  const globalSkill = (await skills.listGlobal()).find((s) => s.slug === 'systematic-debugging');
  assert.ok(globalSkill, 'scene precondition: the built-in exists');

  const fork = await skills.fork(ws.id, globalSkill.id, 'tester');
  assert.equal(fork.slug, globalSkill.slug, 'a fork keeps the slug — that is what makes it shadow');
  assert.equal(fork.workspace_id, ws.id);

  const shadowed = await skills.list(ws.id);
  const matches = shadowed.filter((s) => s.slug === 'systematic-debugging');
  assert.equal(matches.length, 1, 'default listing must return ONE row per slug');
  assert.equal(matches[0].workspace_id, ws.id, 'the workspace fork must win over the global');

  const all = await skills.list(ws.id, { includeShadowed: true });
  const both = all.filter((s) => s.slug === 'systematic-debugging');
  assert.equal(both.length, 2, 'include_shadowed must surface the overridden global too');
  const globalRow = both.find((s) => !s.workspace_id);
  assert.equal(globalRow.shadowed, true, 'the overridden global must be flagged shadowed');

  // The other workspace has no fork, so it still resolves to the global.
  const elsewhere = await skills.list(other.ws.id);
  const theirs = elsewhere.filter((s) => s.slug === 'systematic-debugging');
  assert.equal(theirs.length, 1);
  assert.equal(theirs[0].workspace_id, null, 'a fork in one workspace must not affect another');
});

// ─── 3. Write authorization ──────────────────────────────────────────────────
test('a workspace caller cannot publish into or quarantine a global skill', async () => {
  const globalSkill = (await skills.listGlobal()).find((s) => s.slug === 'plan-before-building');

  await assert.rejects(
    () => skills.publish(ws.id, globalSkill.id, { body: '# hijacked\n' }, 'tester'),
    (err) => err.status === 403 && err.code === 'skill_scope_readonly',
    'publishing into a global skill from a workspace must be refused — it is inherited by every workspace',
  );
  await assert.rejects(
    () => skills.quarantine(ws.id, globalSkill.id),
    (err) => err.status === 403,
    'quarantining a global skill from a workspace must be refused',
  );

  // The admin path (empty workspace id) is allowed.
  const published = await skills.publish('', globalSkill.id, { body: '# admin edit\n' }, 'admin');
  assert.equal(published.workspace_id, null, "a global skill's versions must stay global");
  assert.equal(published.version, 2, 'version numbering must continue across the global skill');
});

test('a workspace caller cannot publish into another workspace\'s skill', async () => {
  const theirs = await skills.create(other.ws.id, {
    slug: `theirs-${stamp}`, name: 'Theirs', body: '# theirs\n',
  }, 'tester', 'workspace');
  await assert.rejects(
    () => skills.publish(ws.id, theirs.id, { body: '# nope\n' }, 'tester'),
    (err) => err.status === 403,
  );
});

// ─── 4. Global skills reach the run manifest ─────────────────────────────────
test('a run snapshot includes an assigned GLOBAL skill', async () => {
  const globalSkill = (await skills.listGlobal()).find((s) => s.slug === 'handoff-notes');
  const detail = await skills.get(ws.id, globalSkill.id);
  assert.ok(detail.versions.length > 0, 'a global skill must expose its versions to a workspace reader');

  await skills.assign(ws.id, globalSkill.id, {
    skill_version_id: detail.versions[0].id,
    agent_id: agent.id,
  }, 'tester');

  const snapshot = await snapshots.resolve({
    workspaceId: ws.id,
    runId: `run-global-${stamp}`,
    agentId: agent.id,
  });
  const slugs = snapshot.manifest.map((entry) => entry.slug);
  assert.ok(
    slugs.includes('handoff-notes'),
    `the pinned manifest must carry the assigned global skill, got ${JSON.stringify(slugs)}`,
  );
  const entry = snapshot.manifest.find((e) => e.slug === 'handoff-notes');
  assert.ok(entry.body.length > 0, 'the manifest entry must carry the actual body the agent will read');
});

// ─── 5. Quarantine is an operator veto over sync ─────────────────────────────
test('a quarantined global skill is skipped by a re-seed, not revived', async () => {
  const target = (await skills.listGlobal()).find((s) => s.slug === 'commit-messages');
  await skills.quarantine('', target.id);

  const summary = await builtin.seed();
  assert.ok(summary.quarantined >= 1, 're-seed must report the quarantined skill as skipped');

  const after2 = await ds.getRepository('Skill').findOne({ where: { id: target.id } });
  assert.equal(after2.status, 'quarantined', 'a re-seed must never flip an operator quarantine back to active');
});

// ─── 6. Tap registration guards ──────────────────────────────────────────────
test('taps refuse non-https, credential-bearing, and internal URLs, and start disabled', async () => {
  await assert.rejects(
    () => taps.create({ name: 'ssh', repo_url: 'git@github.com:org/skills.git' }, 'admin'),
    (err) => err.status === 400,
    'ssh remotes need a server-side key — a credential surface this feature does not open',
  );
  await assert.rejects(
    () => taps.create({ name: 'userinfo', repo_url: 'https://user:token@github.com/org/skills' }, 'admin'),
    (err) => err.status === 400,
    'credentials in the URL would be stored in plain text',
  );
  await assert.rejects(
    () => taps.create({ name: 'ssrf', repo_url: 'https://127.0.0.1/skills.git' }, 'admin'),
    (err) => err.status === 400,
    'a tap must not be usable to make the server fetch from its own network',
  );
  await assert.rejects(
    () => taps.create({ name: 'traversal', repo_url: 'https://example.com/x.git', path: '../etc' }, 'admin'),
    (err) => err.status === 400,
  );

  const tap = await taps.create({
    name: 'example', repo_url: 'https://example.com/skills.git', path: 'skills',
  }, 'admin');
  assert.equal(tap.enabled, 0, 'a new tap must be DISABLED — skill bodies become agent prompt text');
  assert.deepEqual(JSON.parse(tap.allowed_licenses), ['MIT', 'Apache-2.0'],
    'the default license filter must be permissive-only');

  await assert.rejects(
    () => taps.syncOne(tap.id),
    (err) => err.status === 409 && err.code === 'skill_tap_disabled',
    'a disabled tap must not sync without an explicit enable or force',
  );

  // Removing a tap keeps the skills it already synced — deleting them would
  // pull definitions out from under agents that have versions assigned.
  await taps.remove(tap.id);
  assert.ok((await taps.list()).every((t) => t.id !== tap.id));
});

// ─── 7. Tap CONTENT pipeline against a real on-disk skill tree ───────────────
// The git transport itself (spawn git clone) is deliberately not exercised
// here: assertSafeRepoUrl accepts https:// only, on purpose, so a local path
// cannot be tapped. What IS covered is everything downstream of the clone —
// frontmatter parsing, the license filter, support files, and the full
// create/update/idempotent/conflict reconciliation — driven from the same
// loader the tap sync calls after cloning.
test('the tap content pipeline: license filter, frontmatter, and append-only reconciliation', async () => {
  const { loadSkillTree } = await import('file://' + path.join(DIST, 'modules', 'skills', 'skill-source.js'));
  const { SkillSyncService } = await import('file://' + path.join(DIST, 'modules', 'skills', 'skill-sync.service.js'));
  const sync = app.get(SkillSyncService);

  // Self-contained fixture: the same `<category>/<slug>/SKILL.md` layout a
  // cloned tap presents, one permissive skill and one proprietary one.
  const tree = await mkdtemp(path.join(tmpdir(), 'awb-tap-fixture-'));
  after(() => { void rm(tree, { recursive: true, force: true }).catch(() => {}); });
  await mkdir(path.join(tree, 'testing', 'tap-mit'), { recursive: true });
  await mkdir(path.join(tree, 'testing', 'tap-proprietary'), { recursive: true });
  await writeFile(
    path.join(tree, 'testing', 'tap-mit', 'SKILL.md'),
    [
      '---',
      'name: Tapped MIT skill',
      'description: A permissively licensed skill from an external registry.',
      'version: 1.0.0',
      'author: Someone Else',
      'license: MIT',
      'platforms: [linux, macos]',
      'metadata:',
      '  hermes:',
      '    tags: [a, b]',
      '---',
      '# Tapped',
      'Body from the tap.',
      '',
    ].join('\n'),
  );
  await writeFile(
    path.join(tree, 'testing', 'tap-proprietary', 'SKILL.md'),
    ['---', 'name: Tapped proprietary skill', 'description: Must be skipped.', 'license: Proprietary', '---', '# Nope', ''].join('\n'),
  );

  // License filter: the permissive skill loads, the proprietary one is skipped
  // and REPORTED. This is what lets AWB tap a repository that mixes licenses
  // (the Hermes hub does) without redistributing the parts it may not.
  const report = await loadSkillTree(tree, { licenseFilter: ['MIT', 'Apache-2.0'] });
  assert.deepEqual(report.skills.map((s) => s.slug), ['tap-mit'],
    'only the permissively licensed skill may be accepted');
  assert.equal(report.skipped.length, 1, 'the rejected skill must be reported, not silently dropped');
  assert.match(report.skipped[0].reason, /license not allowed/);

  const loaded = report.skills[0];
  assert.equal(loaded.frontmatter.name, 'Tapped MIT skill');
  assert.equal(loaded.frontmatter.author, 'Someone Else');
  assert.equal(loaded.sourcePath, 'testing/tap-mit/SKILL.md');
  assert.ok(!loaded.body.startsWith('---'), 'frontmatter must be stripped from the stored body');
  assert.match(loaded.body, /Body from the tap/);

  // Unfiltered load accepts both — the filter, not the loader, is the gate.
  const unfiltered = await loadSkillTree(tree);
  assert.equal(unfiltered.skills.length, 2, 'with no filter every skill loads');

  const source = { kind: 'tap', id: 'fixture-tap', label: 'fixture' };

  const first = await sync.syncGlobalSkills(report.skills, source);
  assert.equal(first.created, 1, 'the first sync must create the skill');

  const second = await sync.syncGlobalSkills(report.skills, source);
  assert.equal(second.created, 0);
  assert.equal(second.updated, 0);
  assert.equal(second.alreadyCurrent, 1, 'an unchanged body must publish nothing (digest-idempotent)');

  // A changed body APPENDS a version — the old one must survive, because an
  // assignment may be pinned to it.
  const changed = [{ ...loaded, body: `${loaded.body}\nchanged`, digest: `${loaded.digest}-v2` }];
  const third = await sync.syncGlobalSkills(changed, source);
  assert.equal(third.updated, 1);
  const row = await ds.getRepository('Skill').findOne({ where: { slug: 'tap-mit' } });
  const versions = await ds.getRepository('SkillVersion').find({ where: { skill_id: row.id } });
  assert.equal(versions.length, 2, 'an update must APPEND, never overwrite');
  assert.ok(versions.some((v) => v.digest === loaded.digest), 'the original version must still exist');
  assert.equal(row.source_kind, 'tap');
  assert.equal(row.source_license, 'MIT', 'upstream attribution must be preserved');

  // Ownership: a DIFFERENT tap may not hijack a slug this one owns.
  const conflict = await sync.syncGlobalSkills(report.skills, {
    kind: 'tap', id: 'other-tap', label: 'other',
  });
  assert.equal(conflict.conflicted, 1, 'a second tap must not take over an owned global slug');
  assert.equal(conflict.updated, 0);
  const stillMine = await ds.getRepository('Skill').findOne({ where: { slug: 'tap-mit' } });
  assert.equal(stillMine.source_id, 'fixture-tap', 'ownership must be unchanged after a refused conflict');
});

exitAfterTests();
