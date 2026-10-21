// Knowledge 화면의 순수 로직 — docs/skills.md "Knowledge".
//
// 고정하는 것:
//   1. 배정은 범위별로 묶인다 — Shared 먼저, 프로젝트는 이름순(배정 없는 프로젝트도 자리를 낸다), 특정 실행 마지막.
//   2. 호스트 동기화 블록은 공용 메모리 + 공용 skill 목차 + 꺼내는 법만 싣는다(프로젝트 지식은 넣지 않는다 —
//      전역 파일은 모든 폴더에서 읽힌다).
//   3. 동기화 대상은 감지된 CLI 의 전역 지침 markdown(운영자 · 세션 · 프로필 홈)이고, 링크 사본·읽기 전용·
//      Hermes 항목·override 에 가려진 파일은 뺀다. 이미 최신인 파일은 쓰지 않고, 나머지 내용은 보존한다.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assignmentTargetLabel,
  groupAssignments,
  knowledgeBlockId,
  sharedKnowledgeBody,
  syncOps,
  syncStatus,
  syncTargets,
} from '../src/components/knowledge/knowledge.logic.ts';
import { upsertManagedBlock } from '../src/components/memory/memoryFormat.logic.ts';

const assignment = (over = {}) => ({
  id: `a-${Math.random().toString(16).slice(2)}`,
  scope: 'account',
  project_id: null,
  project_name: null,
  runtime_key: null,
  target_label: '',
  skill_id: 's1',
  skill_slug: 'review',
  skill_name: 'Review',
  skill_status: 'active',
  skill_version_id: 'v1',
  version: 1,
  latest_version: 1,
  assigned_by: '',
  created_at: '2026-10-22T00:00:00.000Z',
  ...over,
});

test('assignments group by scope: Shared, then projects by name (empty ones too), then specific runtimes', () => {
  const groups = groupAssignments([
    assignment({ skill_slug: 'zeta' }),
    assignment({ skill_slug: 'alpha' }),
    assignment({ scope: 'project', project_id: 'p2', project_name: 'beta', skill_slug: 'deploy' }),
    assignment({ scope: 'runtime', runtime_key: 'rt-abc', target_label: 'rolf/Claude Code' }),
  ], [{ id: 'p1', name: 'alpha-proj' }, { id: 'p2', name: 'beta' }]);
  assert.deepEqual(groups.map((g) => g.title), ['Shared', 'alpha-proj', 'beta', 'Specific runtime']);
  assert.deepEqual(groups[0].items.map((i) => i.skill_slug), ['alpha', 'zeta']);
  assert.equal(groups[1].items.length, 0, 'a project without skills still gets a slot to assign into');
  assert.equal(groups[2].project_id, 'p2');
  assert.equal(assignmentTargetLabel(groups[3].items[0]), 'rolf/Claude Code');
  assert.deepEqual(groupAssignments([], []).map((g) => g.key), ['account'], 'no runtime group when nothing is runtime-scoped');
});

test('shared knowledge block: memory + shared skill index + how to load; no project knowledge', () => {
  const body = sharedKnowledgeBody({
    accountName: 'Parn',
    memory: '- Prefer small commits.\n',
    skills: [{ slug: 'review', name: 'Review', version: 3 }, { slug: 'deploy', name: 'deploy', version: null }],
  });
  assert.match(body, /^# Parn — shared knowledge \(managed by AWB/);
  assert.match(body, /- Prefer small commits\./);
  assert.match(body, /- review \(v3\) — Review/);
  assert.match(body, /- deploy\n|- deploy$/m);
  assert.match(body, /get_skill/);
  assert.match(body, /get_knowledge` with `\{ project_id \}`/);
  assert.doesNotMatch(sharedKnowledgeBody({ accountName: 'x', memory: '', skills: [] }), /## Skills/);
  assert.equal(knowledgeBlockId('acc-1'), 'awb-knowledge:acc-1');
});

let n = 0;
const file = (over = {}) => ({
  home_id: 'operator', path: `/h/f${n++}.md`, display_path: '~/f.md', scope: 'global', kind: 'instructions', format: 'markdown',
  label: 'Global', group: 'global', project_dir: null, loaded: 'always', load_limit_lines: null, char_limit: null, editable: true,
  exists: true, size: 4, mtime: null, hash: 'aaaaaaaaaaaaaaaa', content: 'mine', truncated: false, omitted: false,
  link_target: null, shared_with: null, ...over,
});
const cli = (id, files, over = {}) => ({ cli: id, label: id, summary: '', detected: true, homes: [], files, dirs: [], settings: {}, ...over });

test('sync targets: global instruction markdown in every home; skip links, read-only, Hermes entries, overridden and project files', () => {
  const claudeOp = file({ path: '/h/.claude/CLAUDE.md' });
  const claudeSession = file({ home_id: 'session:c1', path: '/awb/sh/claude/c1/CLAUDE.md', exists: false, content: null, hash: null });
  const linked = file({ home_id: 'session:c2', path: '/awb/sh/claude/c2/CLAUDE.md', link_target: '/h/.claude/CLAUDE.md' });
  const project = file({ scope: 'project', path: '/repo/CLAUDE.md' });
  const overridden = file({ path: '/h/.codex/AGENTS.md', loaded: 'on_demand' });
  const override = file({ path: '/h/.codex/AGENTS.override.md' });
  const hermes = file({ path: '/h/.hermes/memories/MEMORY.md', kind: 'entries', format: 'section_entries' });
  const readOnly = file({ path: '/h/.gemini/GEMINI.md', editable: false });
  const snapshot = {
    manager_id: 'm', manager_name: 'rolf', hostname: 'rolf', platform: 'linux', generated_at: '', project_dirs: [], content_budget_exhausted: false,
    clis: [
      cli('claude', [claudeOp, claudeSession, linked, project]),
      cli('codex', [overridden, override]),
      cli('hermes', [hermes]),
      cli('antigravity', [readOnly]),
      cli('pi', [file({ path: '/h/.pi/agent/AGENTS.md' })], { detected: false }),
    ],
  };
  assert.deepEqual(syncTargets(snapshot).map((t) => t.file.path), ['/h/.claude/CLAUDE.md', '/awb/sh/claude/c1/CLAUDE.md', '/h/.codex/AGENTS.override.md']);
});

test('sync status and ops: block inserted once, kept current, rest of the file preserved, base hash guards', () => {
  const id = knowledgeBlockId('acc');
  const body = 'shared rules';
  const fresh = file({ content: '# Mine\n', hash: '1111111111111111' });
  const current = file({ content: upsertManagedBlock('# Mine\n', id, body), hash: '2222222222222222' });
  const outdated = file({ content: upsertManagedBlock('# Mine\n', id, 'old rules'), hash: '3333333333333333' });
  const absent = file({ exists: false, content: null, hash: null });
  const big = file({ omitted: true, content: null });
  assert.equal(syncStatus(fresh, id, body), 'missing');
  assert.equal(syncStatus(current, id, body), 'current');
  assert.equal(syncStatus(outdated, id, body), 'outdated');
  assert.equal(syncStatus(absent, id, body), 'missing');
  assert.equal(syncStatus(big, id, body), 'unknown');

  const c = cli('claude', []);
  const ops = syncOps([{ cli: c, file: fresh }, { cli: c, file: current }, { cli: c, file: outdated }, { cli: c, file: absent }], id, body);
  assert.deepEqual(ops.map((o) => o.path), [fresh.path, outdated.path, absent.path], 'an up-to-date file is not rewritten');
  assert.match(ops[0].content, /^# Mine\n\n<!-- awb-memory:begin awb-knowledge:acc -->\nshared rules\n<!-- awb-memory:end/);
  assert.equal(ops[0].base_hash, '1111111111111111');
  assert.doesNotMatch(ops[1].content, /old rules/);
  assert.equal(ops[2].base_hash, null, 'a missing file must still be missing when written');
  assert.equal(ops[0].reason, 'knowledge');
});
