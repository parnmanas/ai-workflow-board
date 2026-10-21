// CLI Memory 화면의 순수 로직 — docs/cli-memory.md.
//
// 고정하는 것:
//   1. 형식 규칙 — Hermes 항목은 hermes-agent 와 같은 `\n§\n` 규칙으로만 직렬화된다(그렇지 않으면
//      Hermes 의 drift guard 가 쓰기를 거부한다). frontmatter 편집이 다른 키·본문을 건드리지 않는다.
//      관리 블록은 다시 적용하면 그 블록만 바뀐다(멱등).
//   2. Claude auto memory 색인 재구성 — 사람이 다듬은 줄은 그대로 두고, 없는 파일 줄만 지우고, 빠진
//      주제 파일만 덧붙인다.
//   3. 분석 — 실제로 무엇이 일어나는지 말하는 지적: Codex 의 32KiB 잘림, 색인 200줄 상한, 세션 홈이
//      전역 지침을 못 보는 것, Hermes 상한, 비밀, 중복.
//   4. 번들 — 절대 경로가 아니라 위치로 적어 다른 장비(Windows 포함)에서도 같은 자리를 찾는다.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ENTRY_DELIMITER,
  claudeProjectKey,
  diffStats,
  entriesCharCount,
  entriesRoundTrip,
  entriesToMarkdown,
  estimateTokens,
  joinHostPath,
  lineDiff,
  markdownToEntries,
  mergeEntries,
  parseEntries,
  parseFrontmatter,
  parseIndexLinks,
  rebuildIndex,
  relativeHostPath,
  removeManagedBlock,
  serializeEntries,
  setAutoMemoryFields,
  upsertManagedBlock,
  findManagedBlock,
  wikiLinks,
} from '../src/components/memory/memoryFormat.logic.ts';
import {
  analyzeSnapshot,
  dedupeLines,
  duplicateLines,
  loadBudgets,
  optimizationPrompt,
} from '../src/components/memory/memoryAnalysis.logic.ts';
import {
  applyCandidates,
  applyContent,
  buildBundle,
  bundleToMarkdown,
  importOps,
  parseBundle,
  planImport,
  resolveTargetPath,
} from '../src/components/memory/memoryBundle.logic.ts';

// ─── fixtures ─────────────────────────────────────────────────────────────

let seq = 0;
const file = (over = {}) => ({
  home_id: 'operator',
  path: `/home/u/.claude/f${seq++}.md`,
  display_path: '~/.claude/f.md',
  scope: 'global',
  kind: 'instructions',
  format: 'markdown',
  label: 'User instructions',
  group: 'global',
  project_dir: null,
  loaded: 'always',
  load_limit_lines: null,
  char_limit: null,
  editable: true,
  exists: true,
  size: 0,
  mtime: '2026-10-20T00:00:00.000Z',
  hash: 'aaaaaaaaaaaaaaaa',
  content: '',
  truncated: false,
  omitted: false,
  link_target: null,
  shared_with: null,
  ...over,
  ...(over.content !== undefined && over.size === undefined ? { size: Buffer.byteLength(over.content ?? '') } : {}),
});

const cliSnap = (cli, files, over = {}) => ({
  cli,
  label: cli,
  summary: '',
  detected: true,
  homes: [{ id: 'operator', kind: 'operator', path: `/home/u/.${cli}`, display_path: `~/.${cli}`, credential_id: null, profile: null, exists: true }],
  files,
  dirs: [],
  settings: {},
  ...over,
});

const host = (clis, over = {}) => ({
  manager_id: 'm1',
  manager_name: 'rolf',
  hostname: 'rolf',
  platform: 'linux',
  generated_at: '2026-10-21T00:00:00.000Z',
  project_dirs: [{ path: '/repo/app', project_id: 'p1', project_name: 'app' }],
  clis,
  content_budget_exhausted: false,
  ...over,
});

// ─── 1. 형식 ──────────────────────────────────────────────────────────────

test('Hermes entries: parse/serialize match hermes-agent (§ on its own line, trimmed, empties dropped)', () => {
  const raw = '첫째 항목\n§\n둘째\n여러 줄\n§\n\n§\n셋째 § 안의 기호';
  assert.deepEqual(parseEntries(raw), ['첫째 항목', '둘째\n여러 줄', '셋째 § 안의 기호']);
  assert.equal(serializeEntries(parseEntries(raw)), '첫째 항목\n§\n둘째\n여러 줄\n§\n셋째 § 안의 기호');
  assert.equal(entriesRoundTrip(serializeEntries(['a', 'b'])), true);
  assert.equal(entriesRoundTrip('a\n§\n\n§\nb'), false, 'an empty entry is drift — Hermes would refuse to write');
  assert.equal(entriesRoundTrip('a\n§\n b'), false);
  // 상한은 코드 포인트로 잰다(Python len).
  assert.equal(entriesCharCount(['가나', 'ab']), 2 + ENTRY_DELIMITER.length + 2);
});

test('frontmatter: auto-memory fields edit in place and keep other keys and the body', () => {
  const text = '---\nname: foo\ndescription: old\nmetadata:\n  type: project\n  extra: keep\n---\n\nBody line\n';
  const fm = parseFrontmatter(text);
  assert.equal(fm.fields['metadata.type'], 'project');
  const next = setAutoMemoryFields(text, { description: 'new: with colon', type: 'feedback' });
  const after = parseFrontmatter(next);
  assert.equal(after.fields.name, 'foo');
  assert.equal(after.fields.description, 'new: with colon');
  assert.equal(after.fields['metadata.type'], 'feedback');
  assert.equal(after.fields['metadata.extra'], 'keep');
  assert.match(next, /\nBody line\n$/);
  // frontmatter 가 없으면 만든다.
  const created = parseFrontmatter(setAutoMemoryFields('just text', { name: 'n', type: 'user' }));
  assert.equal(created.present, true);
  assert.equal(created.fields['metadata.type'], 'user');
  assert.equal(created.body.trim(), 'just text');
});

test('managed block: upsert is idempotent and only the block changes on re-apply', () => {
  const base = '# Mine\n\nmy rule\n';
  const once = upsertManagedBlock(base, 'from:rolf:claude:CLAUDE.md', 'rule A');
  assert.equal(upsertManagedBlock(once, 'from:rolf:claude:CLAUDE.md', 'rule A'), once);
  const updated = upsertManagedBlock(once, 'from:rolf:claude:CLAUDE.md', 'rule B');
  assert.match(updated, /^# Mine\n\nmy rule\n\n<!-- awb-memory:begin/);
  assert.equal(findManagedBlock(updated, 'from:rolf:claude:CLAUDE.md'), 'rule B');
  assert.equal(removeManagedBlock(updated, 'from:rolf:claude:CLAUDE.md').trim(), '# Mine\n\nmy rule');
});

test('markdown ↔ entries: bullets and paragraphs become entries, headings are dropped', () => {
  const md = '# Title\n\n- one\n- two\n  continued\n\nA paragraph\nthat wraps.\n';
  assert.deepEqual(markdownToEntries(md), ['one', 'two\ncontinued', 'A paragraph\nthat wraps.']);
  assert.equal(entriesToMarkdown(['a', 'b\nc']), '- a\n- b\n  c');
  const merged = mergeEntries(['Keep **this**'], ['keep this', 'new one']);
  assert.deepEqual(merged.entries, ['Keep **this**', 'new one']);
  assert.equal(merged.added, 1);
});

test('auto memory index rebuild keeps curated lines, drops dangling, appends orphans from frontmatter', () => {
  const index = '# Index\n- [Kept title](kept.md) — my hook\n- [Gone](gone.md) — x\nfree text\n';
  const topics = [
    { file: 'kept.md', content: '---\nname: kept\ndescription: d\n---\n' },
    { file: 'new-topic.md', content: '---\nname: new-topic\ndescription: Fresh fact\nmetadata:\n  type: project\n---\nbody' },
  ];
  const { content, added, removed } = rebuildIndex(index, topics);
  assert.deepEqual(added, ['new-topic.md']);
  assert.deepEqual(removed, ['gone.md']);
  assert.equal(content, '# Index\n- [Kept title](kept.md) — my hook\nfree text\n- [New topic](new-topic.md) — Fresh fact\n');
  assert.deepEqual(parseIndexLinks(content).map((l) => l.file), ['kept.md', 'new-topic.md']);
  assert.deepEqual(wikiLinks('see [[a]] and [[b|alias]] and [[a]]'), ['a', 'b']);
});

test('lineDiff is a minimal line diff', () => {
  const diff = lineDiff('a\nb\nc\nd', 'a\nc\nd\ne');
  assert.deepEqual(diff, [
    { type: 'eq', text: 'a' },
    { type: 'del', text: 'b' },
    { type: 'eq', text: 'c' },
    { type: 'eq', text: 'd' },
    { type: 'add', text: 'e' },
  ]);
  assert.deepEqual(diffStats(diff), { added: 1, removed: 1 });
  assert.deepEqual(lineDiff('', ''), []);
  assert.deepEqual(lineDiff('', 'x'), [{ type: 'add', text: 'x' }]);
});

test('paths: Claude project key, host-aware join/relative (Windows too), token estimate', () => {
  assert.equal(claudeProjectKey('/mnt/data/repositories/ai-workflow-board'), '-mnt-data-repositories-ai-workflow-board');
  assert.equal(joinHostPath('win32', 'C:\\Users\\u\\.codex', 'memories/MEMORY.md'), 'C:\\Users\\u\\.codex\\memories\\MEMORY.md');
  assert.equal(relativeHostPath('win32', 'C:\\Users\\u\\.codex', 'C:\\Users\\u\\.codex\\memories\\MEMORY.md'), 'memories/MEMORY.md');
  assert.equal(relativeHostPath('linux', '/home/u/.claude', '/home/u/.claudex/x.md'), null);
  assert.ok(estimateTokens('a'.repeat(400)) === 100);
  assert.ok(estimateTokens('가'.repeat(160)) === 100);
});

// ─── 3. 분석 ──────────────────────────────────────────────────────────────

test('analysis: Codex silently drops project AGENTS.md beyond project_doc_max_bytes', () => {
  const big = 'x'.repeat(40 * 1024);
  const codex = cliSnap('codex', [
    file({ path: '/repo/app/AGENTS.md', scope: 'project', project_dir: '/repo/app', group: 'project:/repo/app', content: big }),
  ], { settings: { project_doc_max_bytes: 32768 } });
  const { findings } = analyzeSnapshot(host([codex]));
  const cap = findings.find((f) => f.category === 'truncation');
  assert.ok(cap, 'expected a truncation finding');
  assert.equal(cap.severity, 'critical');
  assert.match(cap.title, /drops 8\.0 KiB/);
});

test('analysis: a credential session home without the global file → warning with a link fix', () => {
  const op = file({ path: '/home/u/.claude/CLAUDE.md', content: 'Always use pnpm in this house and prefer small commits over large ones please.', hash: '1111111111111111' });
  const slot = file({ home_id: 'session:c1', path: '/awb/session-homes/claude/c1/CLAUDE.md', exists: false, content: null, hash: null, size: 0 });
  const claude = cliSnap('claude', [op, slot], {
    homes: [
      { id: 'operator', kind: 'operator', path: '/home/u/.claude', display_path: '~/.claude', credential_id: null, profile: null, exists: true },
      { id: 'session:c1', kind: 'session', path: '/awb/session-homes/claude/c1', display_path: '/awb/…/c1', credential_id: 'c1', credential_name: 'Team Max', profile: null, exists: true },
    ],
  });
  const { findings } = analyzeSnapshot(host([claude]));
  const gap = findings.find((f) => f.category === 'session_home');
  assert.ok(gap);
  assert.equal(gap.severity, 'warning');
  assert.match(gap.title, /Team Max/);
  assert.deepEqual(gap.fix, { kind: 'link_home', cli: 'claude', path: slot.path, target: op.path });
});

test('analysis: auto memory index over 200 lines, dangling links and orphans → index fix', () => {
  const dir = '/home/u/.claude/projects/-repo-app/memory';
  const lines = Array.from({ length: 230 }, (_, i) => `- [T${i}](t${i}.md) — hook`).join('\n');
  const index = file({ path: `${dir}/MEMORY.md`, kind: 'auto_index', loaded: 'index_head', load_limit_lines: 200, group: 'auto:-repo-app', scope: 'project', project_dir: '/repo/app', content: lines });
  const orphan = file({ path: `${dir}/orphan.md`, kind: 'auto_topic', loaded: 'on_demand', group: 'auto:-repo-app', scope: 'project', project_dir: '/repo/app', label: 'Auto memory · orphan', content: '---\nname: orphan\ndescription: d\nmetadata:\n  type: project\n---\nsee [[ghost]]' });
  const { findings } = analyzeSnapshot(host([cliSnap('claude', [index, orphan])]));
  const cats = findings.map((f) => f.category);
  assert.ok(cats.includes('truncation'));
  const idx = findings.find((f) => f.category === 'index');
  assert.match(idx.detail, /230 link\(s\) to missing files/);
  assert.match(idx.detail, /1 topic file\(s\) not in the index/);
  assert.deepEqual(idx.fix, { kind: 'rebuild_index', cli: 'claude', path: index.path });
  assert.ok(findings.some((f) => f.category === 'link' && /ghost/.test(f.detail)));
});

test('analysis: Hermes cap, drift, secrets, repeated lines, relative dates', () => {
  const full = Array.from({ length: 30 }, (_, i) => `entry number ${i} with some text to fill the store`).join(ENTRY_DELIMITER);
  const hermesMem = file({ path: '/home/u/.hermes/memories/MEMORY.md', kind: 'entries', format: 'section_entries', label: 'Agent notes', char_limit: 1000, content: full });
  const drift = file({ path: '/home/u/.hermes/memories/USER.md', kind: 'entries', format: 'section_entries', label: 'User profile', char_limit: 5000, content: 'a\n§\n\n§\nb 어제 바꿈' });
  const secret = file({ path: '/home/u/.hermes/SOUL.md', kind: 'persona', label: 'Persona', content: 'token sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAA here\nrepeat this exact line please\nrepeat this exact line please\n' });
  const { findings } = analyzeSnapshot(host([cliSnap('hermes', [hermesMem, drift, secret])]));
  const by = (cat) => findings.filter((f) => f.category === cat);
  assert.equal(by('limit')[0].severity, 'critical');
  assert.equal(by('format')[0].fix.kind, 'normalize_entries');
  assert.equal(by('secret')[0].severity, 'critical');
  assert.doesNotMatch(by('secret')[0].detail, /AAAAAAAAAAAA/, 'secrets are masked in the finding');
  assert.equal(by('duplicate')[0].fix.kind, 'dedupe_lines');
  assert.ok(by('relative_date').length >= 1);
  assert.equal(dedupeLines('x repeated line that is long\nother\nx repeated line that is long\n'), 'x repeated line that is long\nother\n');
  assert.deepEqual(duplicateLines('```\nsame code line repeated here\nsame code line repeated here\n```'), []);
});

test('analysis: budget counts global + project always-loaded files, index only its first lines', () => {
  const g = file({ content: 'g'.repeat(4000) });
  const p = file({ path: '/repo/app/CLAUDE.md', scope: 'project', project_dir: '/repo/app', group: 'project:/repo/app', content: 'p'.repeat(40000) });
  const idx = file({ path: '/x/MEMORY.md', kind: 'auto_index', loaded: 'index_head', load_limit_lines: 1, scope: 'project', project_dir: '/repo/app', content: 'line one\n' + 'z'.repeat(100000) });
  const topic = file({ path: '/x/t.md', kind: 'auto_topic', loaded: 'on_demand', scope: 'project', project_dir: '/repo/app', content: 'q'.repeat(400) });
  const cli = cliSnap('claude', [g, p, idx, topic]);
  const budgets = loadBudgets(cli);
  assert.equal(budgets[0].tokens, 1000);
  assert.equal(budgets[1].project_dir, '/repo/app');
  assert.equal(budgets[1].tokens, 1000 + 10000 + 2);
  const { findings, stats } = analyzeSnapshot(host([cli]));
  assert.equal(findings.find((f) => f.category === 'budget').severity, 'warning');
  assert.equal(stats[0].on_demand_tokens, 100);
});

test('analysis: cross-CLI sync gap is reported once per target with an apply fix', () => {
  const note = 'Run the full test suite before every push; never push red builds to main branch.';
  const claude = cliSnap('claude', [file({ path: '/home/u/.claude/CLAUDE.md', content: `# Rules\n${note}` })]);
  const codex = cliSnap('codex', [file({ path: '/home/u/.codex/AGENTS.md', content: '' , exists: false, hash: null })]);
  const { findings } = analyzeSnapshot(host([claude, codex]));
  const sync = findings.filter((f) => f.category === 'sync');
  assert.equal(sync.length, 1);
  assert.equal(sync[0].cli, 'codex');
  assert.deepEqual(sync[0].fix, { kind: 'apply', cli: 'claude', path: '/home/u/.claude/CLAUDE.md', target_cli: 'codex', target_path: '/home/u/.codex/AGENTS.md' });
  const prompt = optimizationPrompt(claude, findings);
  assert.match(prompt, /^\[AWB Memory optimization\]/);
  assert.match(prompt, /\/home\/u\/\.claude\/CLAUDE\.md/);
});

// ─── 4. 번들 ──────────────────────────────────────────────────────────────

test('bundle: export by location, re-import on a Windows host maps projects by id and recomputes the Claude key', () => {
  const src = host([
    cliSnap('claude', [
      file({ path: '/home/u/.claude/CLAUDE.md', content: 'global rule' }),
      file({ path: '/home/u/.claude/projects/-repo-app/memory/fact.md', kind: 'auto_topic', group: 'auto:-repo-app', scope: 'project', project_dir: '/repo/app', content: 'fact' }),
      file({ path: '/repo/app/CLAUDE.md', scope: 'project', project_dir: '/repo/app', group: 'project:/repo/app', content: 'project rule' }),
      file({ path: '/home/u/.claude/missing.md', exists: false, content: null }),
    ], { homes: [{ id: 'operator', kind: 'operator', path: '/home/u/.claude', display_path: '~/.claude', credential_id: null, profile: null, exists: true }] }),
  ]);
  const { bundle, skipped } = buildBundle(src, { now: new Date('2026-10-21T00:00:00Z') });
  assert.deepEqual(skipped, []);
  assert.deepEqual(bundle.files.map((f) => [f.anchor, f.rel]), [['home', 'CLAUDE.md'], ['claude_auto', 'fact.md'], ['project', 'CLAUDE.md']]);
  const roundTrip = parseBundle(JSON.stringify(bundle));
  assert.equal(roundTrip.files.length, 3);
  assert.match(bundleToMarkdown(roundTrip), /### User instructions/);

  const winHome = 'C:\\Users\\u\\.claude';
  const winDir = 'D:\\work\\app';
  const winKey = 'D--work-app';
  const target = host([
    cliSnap('claude', [
      file({ path: `${winHome}\\CLAUDE.md`, content: 'existing', hash: 'bbbbbbbbbbbbbbbb' }),
      file({ path: `${winDir}\\CLAUDE.md`, scope: 'project', project_dir: winDir, exists: false, content: null, hash: null }),
    ], {
      homes: [{ id: 'operator', kind: 'operator', path: winHome, display_path: winHome, credential_id: null, profile: null, exists: true }],
      dirs: [{ home_id: 'operator', path: `${winHome}\\projects\\${winKey}\\memory`, display_path: '', scope: 'project', kind: 'auto_topic', label: 'Auto memory', group: `auto:${winKey}`, project_dir: winDir, exists: false }],
    }),
  ], { platform: 'win32', project_dirs: [{ path: winDir, project_id: 'p1', project_name: 'app' }] });
  assert.equal(resolveTargetPath(target, roundTrip.files[1]).path, `${winHome}\\projects\\${winKey}\\memory\\fact.md`);
  const plan = planImport(target, roundTrip);
  assert.deepEqual(plan.map((p) => p.action), ['update', 'create', 'create']);
  const overwrite = importOps(plan, 'overwrite', roundTrip);
  assert.deepEqual(overwrite.map((o) => [o.path, o.base_hash]), [
    [`${winHome}\\CLAUDE.md`, 'bbbbbbbbbbbbbbbb'],
    [`${winHome}\\projects\\${winKey}\\memory\\fact.md`, null],
    [`${winDir}\\CLAUDE.md`, null],
  ]);
  assert.equal(importOps(plan, 'skip', roundTrip).length, 2, 'skip leaves existing files alone but still creates new ones');
  const merged = importOps(plan, 'merge', roundTrip)[0].content;
  assert.match(merged, /^existing\n\n<!-- awb-memory:begin import:rolf:claude:CLAUDE\.md -->\nglobal rule\n<!-- awb-memory:end/);
  assert.throws(() => parseBundle('{"format":"other"}'), /Not an AWB CLI memory bundle/);
});

test('bundle: unknown project or undeclared location is unmapped, never written', () => {
  const bundle = parseBundle(JSON.stringify({
    format: 'awb-cli-memory', version: 1, source: {},
    files: [
      { cli: 'claude', home: 'operator', anchor: 'project', rel: 'CLAUDE.md', project_id: 'nope', project_name: 'nope', content: 'x' },
      { cli: 'claude', home: 'operator', anchor: 'home', rel: '../escape.md', content: 'x' },
      { cli: 'claude', home: 'operator', anchor: 'home', rel: 'random/place.md', content: 'x' },
    ],
  }));
  assert.equal(bundle.files.length, 2, '`..` segments are rejected at parse time');
  const target = host([cliSnap('claude', [], { homes: [{ id: 'operator', kind: 'operator', path: '/home/u/.claude', display_path: '', credential_id: null, profile: null, exists: true }] })]);
  const plan = planImport(target, bundle);
  assert.deepEqual(plan.map((p) => p.action), ['unmapped', 'unmapped']);
  assert.deepEqual(importOps(plan, 'overwrite', bundle), []);
});

test('apply: markdown → Hermes entries merges; markdown → markdown uses an idempotent block', () => {
  const source = { cli: 'claude', host: 'rolf', file: file({ path: '/home/u/.claude/CLAUDE.md', format: 'markdown' }), content: '# Rules\n\n- Use pnpm\n- Small commits\n' };
  const hermes = file({ path: '/home/u/.hermes/memories/MEMORY.md', format: 'section_entries', kind: 'entries', content: 'Use pnpm' });
  assert.equal(applyContent(source, hermes, 'entries'), 'Use pnpm\n§\nSmall commits');
  const agents = file({ path: '/home/u/.codex/AGENTS.md', content: 'mine\n' });
  const once = applyContent(source, agents, 'block');
  const twice = applyContent(source, { ...agents, content: once }, 'block');
  assert.equal(once, twice);
  assert.match(once, /^mine\n\n<!-- awb-memory:begin from:rolf:claude:CLAUDE\.md -->/);
  assert.equal(applyContent(source, agents, 'replace'), source.content);

  const snap = host([
    cliSnap('claude', [source.file]),
    cliSnap('codex', [agents, file({ path: '/home/u/.codex/memories/MEMORY.md', kind: 'generated' })]),
    cliSnap('hermes', [hermes]),
  ]);
  const candidates = applyCandidates(snap, { cli: 'claude', file: source.file, sameHost: true, projectId: null });
  assert.deepEqual(candidates.map((c) => c.file.path), ['/home/u/.codex/AGENTS.md', '/home/u/.hermes/memories/MEMORY.md']);
});
