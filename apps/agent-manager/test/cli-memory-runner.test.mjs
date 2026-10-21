// CLI Memory 러너 — docs/cli-memory.md.
//
// 실제 CLI 모듈의 memory 슬라이스(claude / codex / hermes)를 임시 홈에 돌려 고정한다:
//   1. scan 이 CLI 마다 선언된 자리(전역 · 프로젝트 · auto memory · 세션 홈)를 찾고, 링크로 공유된
//      세션 홈 사본은 내용 없이 `shared_with` 로만 낸다.
//   2. 쓰기는 **선언된 위치에서만** — 서버가 준 프로젝트 폴더 밖, 선언 디렉터리 밖, 안전하지 않은 이름은
//      거부한다.
//   3. base_hash 로 동시 편집을 막고, 모든 변경 앞에 백업을 떠서 history / read_version / restore 로 되돌린다.
//   4. 링크된 파일을 고치면 링크가 아니라 대상이 바뀐다. link op 는 세션 홈 자리를 운영자 파일로 잇는다.
//   5. 경로 검사는 API 경로(`/api/...`)를 파일로 오인하지 않는다.

import test from 'node:test';
import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { MemoryRunner, referencedPaths, memoryHash } = await import('../dist/lib/cli-memory-runner.js');
const { cliModulesWith } = await import('../dist/lib/clis/index.js');

const UUID = '11111111-2222-3333-4444-555555555555';

/**
 * `alias` — fixture 를 심볼릭 링크 별칭 경로로 잡는다. 선언 경로(별칭)와 realpath(실제)가 글자로 다르게 되어
 * Windows 의 8.3 단축명(`C:\\Users\\RUNNER~1\\…` vs realpath 의 `runneradmin`)과 같은 종류의 불일치를 재현한다.
 */
async function fixture(t, { alias = false } = {}) {
  const real = await mkdtemp(join(tmpdir(), 'awb-mem-'));
  t.after(() => rm(real, { recursive: true, force: true }));
  let root = real;
  if (alias) {
    root = `${real}-alias`;
    await symlink(real, root, 'dir');
    t.after(() => rm(root, { force: true }));
  }
  const claudeHome = join(root, 'claude-home');
  const codexHome = join(root, 'codex-home');
  const hermesHome = join(root, 'hermes-home');
  const sessionHomes = join(root, 'session-homes');
  const project = join(root, 'repo');
  const key = project.replace(/[^a-zA-Z0-9]/g, '-');

  await mkdir(join(claudeHome, 'rules'), { recursive: true });
  await mkdir(join(claudeHome, 'projects', key, 'memory'), { recursive: true });
  await mkdir(join(project, 'src'), { recursive: true });
  await writeFile(join(claudeHome, 'CLAUDE.md'), '# Global\nUse pnpm. See `/api/agent/sessions` and ~/nope/missing.txt\n');
  await writeFile(join(claudeHome, 'rules', 'ts.md'), '---\npaths: ["**/*.ts"]\n---\nStrict TS.\n');
  await writeFile(join(claudeHome, 'projects', key, 'memory', 'MEMORY.md'), '- [Fact](fact.md) — a fact\n');
  await writeFile(join(claudeHome, 'projects', key, 'memory', 'fact.md'), '---\nname: fact\n---\nReal file: `src/index.ts`, gone: `src/old.ts`\n');
  await writeFile(join(project, 'CLAUDE.md'), 'project rules\n');
  await writeFile(join(project, 'src', 'index.ts'), '');
  // AWB 세션 홈 — agent-session-runner 처럼 `projects` 만 운영자 홈으로 링크한다.
  await mkdir(join(sessionHomes, 'claude', UUID), { recursive: true });
  await symlink(join(claudeHome, 'projects'), join(sessionHomes, 'claude', UUID, 'projects'), 'dir');
  await mkdir(join(sessionHomes, 'claude', 'cred-auth'), { recursive: true }); // credential id 가 아니면 세션 홈이 아니다

  await mkdir(join(codexHome, 'memories', 'rollout_summaries'), { recursive: true });
  await writeFile(join(codexHome, 'AGENTS.md'), 'codex global\n');
  await writeFile(join(codexHome, 'memories', 'memory_summary.md'), 'summary\n');
  await writeFile(join(codexHome, 'memories', 'rollout_summaries', 'r1.md'), 'r1\n');
  await writeFile(join(codexHome, 'config.toml'), 'model = "x"\nproject_doc_max_bytes = 4096\n[features]\nmemories = true\n');

  await mkdir(join(hermesHome, 'memories'), { recursive: true });
  await writeFile(join(hermesHome, 'memories', 'MEMORY.md'), 'one\n§\ntwo');
  await writeFile(join(hermesHome, 'config.yaml'), 'memory:\n  memory_enabled: true\n  memory_char_limit: 900\n  user_char_limit: 500\n');

  const env = { ...process.env, CLAUDE_CONFIG_DIR: claudeHome, CODEX_HOME: codexHome, HERMES_HOME: hermesHome };
  const modules = cliModulesWith('memory').filter((m) => ['claude', 'codex', 'hermes'].includes(m.id)).map((m) => ({ id: m.id, label: m.label, memory: m.memory }));
  const responses = [];
  const runner = new MemoryRunner({ url: 'http://awb.invalid', apiKey: 'k' }, {
    getManagerId: () => 'mgr',
    env,
    sessionHomesDir: sessionHomes,
    backupDir: join(root, 'backups'),
    userHome: root,
    modules,
    respond: (id, body) => { responses.push({ id, body }); },
  });
  return { root, claudeHome, codexHome, hermesHome, sessionHomes, project, key, runner, responses };
}

const byPath = (cli, path) => cli.files.find((f) => f.path === path);

test('scan: declared locations per CLI, session-home copies are shared, settings and path checks', async (t) => {
  const fx = await fixture(t);
  const out = await fx.runner.run({ manager_id: 'mgr', op: 'scan', project_dirs: [fx.project], check_paths: true });
  const claude = out.clis.find((c) => c.cli === 'claude');
  assert.deepEqual(claude.homes.map((h) => h.id), ['operator', `session:${UUID}`], 'non-uuid dirs are not session homes');

  const global = byPath(claude, join(fx.claudeHome, 'CLAUDE.md'));
  assert.equal(global.loaded, 'always');
  assert.equal(global.hash, memoryHash(await readFile(join(fx.claudeHome, 'CLAUDE.md'))));
  assert.deepEqual(global.missing_paths, [join('~', 'nope', 'missing.txt')], '/api/... is not a file path; ~/ resolves against the user home');
  assert.equal(byPath(claude, join(fx.claudeHome, 'rules', 'ts.md')).loaded, 'conditional', '`paths:` frontmatter → conditional');
  const index = byPath(claude, join(fx.claudeHome, 'projects', fx.key, 'memory', 'MEMORY.md'));
  assert.equal(index.kind, 'auto_index');
  assert.equal(index.load_limit_lines, 200);
  assert.equal(index.project_dir, fx.project, 'auto memory key maps back to the known project folder');
  const fact = byPath(claude, join(fx.claudeHome, 'projects', fx.key, 'memory', 'fact.md'));
  assert.deepEqual(fact.missing_paths, [join('~', 'repo', 'src', 'old.ts')], 'backticked relative paths resolve against the project folder');
  assert.equal(byPath(claude, join(fx.project, 'CLAUDE.md')).scope, 'project');

  // 세션 홈: 링크된 auto memory 는 shared_with 로만, 전역 지침은 "없음" 자리로.
  const sessionFact = claude.files.find((f) => f.home_id === `session:${UUID}` && f.path.endsWith('fact.md'));
  assert.equal(sessionFact.shared_with, 'operator');
  assert.equal(sessionFact.content, null);
  const sessionGlobal = byPath(claude, join(fx.sessionHomes, 'claude', UUID, 'CLAUDE.md'));
  assert.equal(sessionGlobal.exists, false);
  assert.ok(!claude.files.some((f) => f.home_id !== 'operator' && f.scope === 'project' && f.kind === 'instructions'), 'project files are listed once (operator home)');

  const codex = out.clis.find((c) => c.cli === 'codex');
  assert.equal(codex.settings.project_doc_max_bytes, 4096);
  assert.equal(codex.settings.memories_feature, true);
  assert.equal(byPath(codex, join(fx.codexHome, 'memories', 'memory_summary.md')).loaded, 'always');
  assert.equal(byPath(codex, join(fx.codexHome, 'memories', 'rollout_summaries', 'r1.md')).kind, 'generated');

  const hermes = out.clis.find((c) => c.cli === 'hermes');
  const notes = byPath(hermes, join(fx.hermesHome, 'memories', 'MEMORY.md'));
  assert.equal(notes.format, 'section_entries');
  assert.equal(notes.char_limit, 900);
  assert.equal(byPath(hermes, join(fx.hermesHome, 'memories', 'USER.md')).char_limit, 500);
  assert.equal(hermes.settings.memory_enabled, true);
});

test('write: only declared locations; base_hash guards; every change is backed up and restorable', async (t) => {
  const fx = await fixture(t);
  const path = join(fx.claudeHome, 'CLAUDE.md');
  const original = await readFile(path, 'utf8');
  const hash = memoryHash(original);
  const run = (req) => fx.runner.run({ manager_id: 'mgr', project_dirs: [fx.project], ...req });

  await assert.rejects(run({ op: 'write', cli: 'claude', path, content: 'x', base_hash: 'ffffffffffffffff' }), (e) => e.code === 'conflict');
  await assert.rejects(run({ op: 'write', cli: 'claude', path, content: 'x', base_hash: null }), (e) => e.code === 'conflict', 'null means "must not exist"');

  const written = await run({ op: 'write', cli: 'claude', path, content: 'v2\n', base_hash: hash });
  assert.equal(written.file.content, 'v2\n');
  assert.equal(await readFile(path, 'utf8'), 'v2\n');
  await run({ op: 'write', cli: 'claude', path, content: 'v3\n', base_hash: written.file.hash });

  const { versions } = await run({ op: 'history', cli: 'claude', path });
  assert.equal(versions.length, 2);
  assert.equal(versions[1].hash, hash, 'oldest backup is the original');
  const old = await run({ op: 'read_version', cli: 'claude', path, version_id: versions[1].version_id });
  assert.equal(old.content, original);
  const restored = await run({ op: 'restore', cli: 'claude', path, version_id: versions[1].version_id, base_hash: memoryHash('v3\n') });
  assert.equal(restored.file.content, original);
  assert.equal((await run({ op: 'history', cli: 'claude', path })).versions[0].hash, memoryHash('v3\n'), 'restore backs up what it replaces');

  // 선언 밖은 전부 거부.
  const outside = join(fx.root, 'elsewhere', 'CLAUDE.md');
  await assert.rejects(run({ op: 'write', cli: 'claude', path: outside, content: 'x' }), (e) => e.code === 'path_not_allowed');
  await assert.rejects(fx.runner.run({ manager_id: 'mgr', op: 'write', cli: 'claude', path: join(fx.project, 'CLAUDE.md'), content: 'x', project_dirs: [] }),
    (e) => e.code === 'path_not_allowed', 'project files are writable only for server-provided project folders');
  await assert.rejects(run({ op: 'write', cli: 'claude', path: join(fx.claudeHome, 'rules', 'note.txt'), content: 'x' }), (e) => e.code === 'path_not_allowed');
  await assert.rejects(run({ op: 'write', cli: 'claude', path: join(fx.claudeHome, 'rules', '.hidden.md'), content: 'x' }), (e) => e.code === 'path_not_allowed');
  await assert.rejects(run({ op: 'write', cli: 'claude', path: join(fx.claudeHome, 'rules', 'sub', 'deep.md'), content: 'x' }), (e) => e.code === 'path_not_allowed');
  await assert.rejects(run({ op: 'write', cli: 'claude', path: 'relative/CLAUDE.md', content: 'x' }), (e) => e.code === 'path_invalid');
  await assert.rejects(run({ op: 'write', cli: 'nope', path, content: 'x' }), (e) => e.code === 'cli_unsupported');

  // 선언된 디렉터리 바로 아래의 새 .md 는 된다 — 아직 없는 auto memory 폴더도.
  const created = await run({ op: 'write', cli: 'claude', path: join(fx.claudeHome, 'rules', 'testing.md'), content: 'Run tests.\n', base_hash: null });
  assert.equal(created.file.kind, 'rules');
  const other = join(fx.root, 'repo2');
  await mkdir(other);
  const newAuto = join(fx.claudeHome, 'projects', other.replace(/[^a-zA-Z0-9]/g, '-'), 'memory', 'first.md');
  await fx.runner.run({ manager_id: 'mgr', op: 'write', cli: 'claude', path: newAuto, content: 'x', base_hash: null, project_dirs: [fx.project, other] });
  assert.equal(await readFile(newAuto, 'utf8'), 'x');
});

test('links: writing through a link replaces the target; link op connects a session home; delete removes only the link', async (t) => {
  // 별칭 경로 위에서 돈다 — 선언 경로와 realpath 가 달라도 메모리 위치끼리의 링크는 허용돼야 한다.
  const fx = await fixture(t, { alias: true });
  const run = (req) => fx.runner.run({ manager_id: 'mgr', project_dirs: [fx.project], ...req });
  const operator = join(fx.claudeHome, 'CLAUDE.md');
  const slot = join(fx.sessionHomes, 'claude', UUID, 'CLAUDE.md');

  await assert.rejects(run({ op: 'link', cli: 'claude', path: operator, target: operator }), (e) => e.code === 'link_invalid');
  await assert.rejects(run({ op: 'link', cli: 'claude', path: slot, target: join(fx.project, 'CLAUDE.md') }), (e) => e.code === 'path_not_allowed',
    'only operator-home files can be link targets');
  const linked = await run({ op: 'link', cli: 'claude', path: slot, target: operator });
  assert.equal(linked.linked, true);
  assert.equal(await readlink(slot), operator);

  const before = await readFile(operator, 'utf8');
  await run({ op: 'write', cli: 'claude', path: slot, content: 'through the link\n', base_hash: memoryHash(before) });
  assert.equal(await readFile(operator, 'utf8'), 'through the link\n');
  assert.ok((await lstat(slot)).isSymbolicLink(), 'the link survives the atomic write');

  // 링크가 메모리 밖을 가리키면 따라가 쓰지 않는다.
  const evil = join(fx.claudeHome, 'rules', 'evil.md');
  const victim = join(fx.root, 'victim.txt');
  await writeFile(victim, 'keep');
  await symlink(victim, evil);
  await assert.rejects(run({ op: 'write', cli: 'claude', path: evil, content: 'pwned', base_hash: memoryHash('keep') }), (e) => e.code === 'path_not_allowed');
  assert.equal(await readFile(victim, 'utf8'), 'keep');

  // 메모리 위치끼리의 링크(`CLAUDE.md` → 같은 프로젝트의 `AGENTS.md`)는 어느 CLI 탭에서 고쳐도 된다 —
  // 대상이 다른 CLI(codex)가 선언한 파일이어도. 반대로 CLI 홈 안이라도 메모리가 아닌 파일은 거부한다.
  const agents = join(fx.project, 'AGENTS.md');
  await writeFile(agents, 'shared rules\n');
  await rm(join(fx.project, 'CLAUDE.md'));
  await symlink(agents, join(fx.project, 'CLAUDE.md'));
  await run({ op: 'write', cli: 'claude', path: join(fx.project, 'CLAUDE.md'), content: 'shared rules v2\n', base_hash: memoryHash('shared rules\n') });
  assert.equal(await readFile(agents, 'utf8'), 'shared rules v2\n');
  const creds = join(fx.claudeHome, '.credentials.json');
  await writeFile(creds, '{"secret":1}');
  const sneaky = join(fx.claudeHome, 'rules', 'sneaky.md');
  await symlink(creds, sneaky);
  await assert.rejects(run({ op: 'write', cli: 'claude', path: sneaky, content: 'x', base_hash: memoryHash('{"secret":1}') }), (e) => e.code === 'path_not_allowed');
  assert.equal(await readFile(creds, 'utf8'), '{"secret":1}');

  await run({ op: 'delete', cli: 'claude', path: slot });
  await assert.rejects(lstat(slot));
  assert.equal(await readFile(operator, 'utf8'), 'through the link\n', 'deleting the link leaves the operator file');
});

test('batch + handle: per-op results, errors carry codes back to the server', async (t) => {
  const fx = await fixture(t);
  const { results } = await fx.runner.run({
    manager_id: 'mgr', op: 'batch', project_dirs: [fx.project],
    ops: [
      { op: 'write', cli: 'hermes', path: join(fx.hermesHome, 'memories', 'USER.md'), content: 'likes tea', base_hash: null, reason: 'import' },
      { op: 'write', cli: 'hermes', path: join(fx.root, 'nope.md'), content: 'x' },
      { op: 'delete', cli: 'codex', path: join(fx.codexHome, 'memories', 'rollout_summaries', 'r1.md') },
    ],
  });
  assert.deepEqual(results.map((r) => [r.ok, r.code ?? null]), [[true, null], [false, 'path_not_allowed'], [true, null]]);
  assert.equal(await readFile(join(fx.hermesHome, 'memories', 'USER.md'), 'utf8'), 'likes tea');
  const hist = await fx.runner.run({ manager_id: 'mgr', op: 'history', cli: 'codex', path: join(fx.codexHome, 'memories', 'rollout_summaries', 'r1.md'), project_dirs: [] });
  assert.equal(hist.versions[0].reason, 'delete', 'deleted files are recoverable');
  const r1 = join(fx.codexHome, 'memories', 'rollout_summaries', 'r1.md');
  const back = await fx.runner.run({ manager_id: 'mgr', op: 'restore', cli: 'codex', path: r1, version_id: hist.versions[0].version_id, base_hash: null, project_dirs: [] });
  assert.equal(back.file.kind, 'generated', 'the restored file keeps the declaration it had when backed up');
  assert.equal(await readFile(r1, 'utf8'), 'r1\n');

  await fx.runner.handle({ manager_id: 'mgr', op: 'write', request_id: 'r-1', cli: 'claude', path: join(fx.claudeHome, 'CLAUDE.md'), content: 'x', base_hash: 'ffffffffffffffff' });
  const reply = fx.responses.find((r) => r.id === 'r-1').body;
  assert.equal(reply.ok, false);
  assert.equal(reply.code, 'conflict');
  assert.match(reply.result.current_hash, /^[0-9a-f]{16}$/, 'conflict tells the caller the current hash');
});

test('referencedPaths ignores URLs and API routes, keeps real absolute and home paths', () => {
  const refs = referencedPaths(
    'see https://example.com/a/b and /api/agent/sessions and /mnt/data/x.md, `~/.codex/AGENTS.md`',
    { projectDir: null, userHome: '/home/u', rootEntries: new Set(['mnt', 'home']), platform: 'linux' },
  );
  assert.deepEqual(refs.sort(), [join('/home/u', '.codex/AGENTS.md'), '/mnt/data/x.md'].sort());
  // `~/x` 처럼 구간이 하나여도 홈 아래 경로다(합친 뒤 `/` 로 세던 버그는 Windows 에서 이것을 버렸다).
  assert.deepEqual(referencedPaths('see ~/notes.md', { projectDir: null, userHome: '/home/u', rootEntries: new Set(), platform: 'linux' }), [join('/home/u', 'notes.md')]);
});
