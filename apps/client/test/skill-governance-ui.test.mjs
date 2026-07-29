import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const root = join(import.meta.dirname, '..', 'src');
const read = (path) => readFileSync(join(root, path), 'utf8');

test('admin skill surface exposes catalog, exact versions, assignments and proposal review', () => {
  const page = read('components/admin/SkillsPage.tsx');
  const proposal = read('components/admin/SkillProposalReview.tsx');
  const api = read('api.ts');
  const routes = read('components/admin/AdminPage.tsx');
  const sidebar = read('components/Sidebar.tsx');

  assert.match(routes, /path="skills"/);
  assert.match(sidebar, /\/admin\/skills/);
  assert.match(page, /Publish immutable version/);
  assert.match(page, /Assign exact version/);
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
