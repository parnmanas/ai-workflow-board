import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const root = join(import.meta.dirname, '..', 'src');
const read = (path) => readFileSync(join(root, path), 'utf8');

test('skill surface (Knowledge → Skills) exposes scoped assignments, catalog, exact versions and proposal review', () => {
  const page = read('components/admin/SkillsPage.tsx');
  const proposal = read('components/admin/SkillProposalReview.tsx');
  const api = read('api.ts');
  const routes = read('components/admin/AdminPage.tsx');
  const app = read('App.tsx');
  const sidebar = read('components/Sidebar.tsx');
  const panel = read('components/knowledge/SkillAssignmentsPanel.tsx');

  // Skills 는 Knowledge 아래 /skills — 예전 /admin/skills 는 그리로 보낸다.
  assert.match(app, /path="skills" element=\{<SkillsKnowledgePage \/>\}/);
  assert.match(routes, /path="skills" element=\{<WorkRouteRedirect path="skills" \/>\}/);
  assert.match(sidebar, /key: 'skills',\s*path: `\$\{basePath\}\/skills`/);
  assert.doesNotMatch(sidebar, /path: '\/admin\/skills'/);
  assert.match(page, /Publish immutable version/);
  assert.match(page, /Assign this version/);
  // 배정 범위: 공용 · 프로젝트 · 특정 실행
  assert.match(page, /'account', 'Shared — every agent'/);
  assert.match(page, /'project', 'A project'/);
  assert.match(page, /'runtime', 'One runtime'/);
  assert.match(panel, /unassignSkill/);
  assert.match(panel, /repinSkillAssignment/);
  assert.match(page, /Runtime learning creates proposals only/);
  assert.match(proposal, /SHA-256/);
  assert.match(proposal, /Approve new version/);
  assert.match(api, /reviewSkillProposal/);
  assert.match(api, /skill_version_id/);
});

test('runtime proposal surface is proposal-only and human review remains user-authenticated', () => {
  const runtimeTool = readFileSync(
    join(import.meta.dirname, '..', '..', 'server', 'src', 'modules', 'mcp', 'tools', 'skill-proposal-tools.ts'),
    'utf8',
  );
  const controller = readFileSync(
    join(import.meta.dirname, '..', '..', 'server', 'src', 'modules', 'skills', 'skills.controller.ts'),
    'utf8',
  );
  assert.match(runtimeTool, /propose_skill_change/);
  assert.match(runtimeTool, /status:\s*'pending'/);
  assert.doesNotMatch(runtimeTool, /approve_skill|publish_skill|assign_skill/);
  assert.match(controller, /@UseGuards\(AuthGuard, PermissionGuard\)/);
  assert.match(controller, /MANAGE_AGENTS/);
});
