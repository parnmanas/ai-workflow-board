// Knowledge — 공용 메모리 + 범위별 skill 배정(docs/skills.md "Knowledge", "배정 범위").
//
// 고정하는 것:
//   1. skill 은 공용(account) · 프로젝트 · 실행(runtime) 범위로 배정되고, 배정 현황이 범위·대상 이름과 함께
//      보이고, 재핀(같은 대상, 다른 버전)·해제가 된다.
//   2. 한 실행의 skill = 공용 ∪ 그 프로젝트 ∪ 그 실행. 같은 skill 이 여러 범위에 있으면 좁은 범위가 이긴다.
//   3. 공용 메모리는 계정 소유자가 고치고(상한 있음), 티켓 work order 의 Knowledge 섹션에 skill 목차와 함께
//      실린다(본문은 싣지 않는다 — get_skill 로 꺼낸다).
//   4. MCP get_knowledge / get_skill 이 같은 답을 준다. 티켓 안에서는 그 런에 고정된 버전을 준다(나중에
//      재핀해도 그 런은 바뀌지 않는다). 다른 계정에 묶인 키는 거부된다.
//
// 실행: node --test --test-force-exit test/knowledge-scopes.test.mjs (dist 필요)

import test from 'node:test';
import assert from 'node:assert/strict';
import { bootApp, closeTestApp } from './helpers/boot.mjs';
import { createAccount, createAgent, createApiKey, createProject, createTicket, createUser } from './helpers/fixtures.mjs';
import { McpClient } from './helpers/mcp-client.mjs';

process.env.PORT = process.env.TEST_SERVER_PORT || '0';
process.env.AGENT_DEV_MODE = 'false';

async function call(url, init) {
  const res = await fetch(url, init);
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = null; }
  return { status: res.status, body, text };
}

test('knowledge: scoped skill assignments, shared memory, work order and MCP read the same answer', async (t) => {
  const { app, port, modules } = await bootApp({ port: parseInt(process.env.PORT, 10) });
  t.after(async () => { await closeTestApp(app); });
  const { getDataSourceToken, AuthService } = modules;
  const base = `http://localhost:${port}`;
  const { RunSkillSnapshotService } = await import('../dist/modules/skills/run-skill-snapshot.service.js');
  const { renderTicketWorkOrder } = await import('../dist/common/ticket-work-order.js');

  const ws = await createAccount(app, getDataSourceToken, 'knowledge');
  const other = await createAccount(app, getDataSourceToken, 'knowledge-other');
  const owner = await createUser(app, getDataSourceToken, { name: 'owner', role: 'admin' });
  const headers = { Authorization: `Bearer ${app.get(AuthService).createSession(owner.id)}`, 'X-Account-Id': ws.id, 'Content-Type': 'application/json' };
  const api = (path, init = {}) => call(`${base}/api/accounts/${ws.id}${path}`, { headers, ...init });

  const agent = await createAgent(app, getDataSourceToken, ws.id, { name: 'coder', type: 'claude', runtime: true });
  const project = await createProject(app, getDataSourceToken, ws.id, { name: 'app', instructions: 'Build with npm run build.' });

  const createSkill = async (slug, body) => {
    const res = await api('/skills', { method: 'POST', body: JSON.stringify({ slug, name: slug.toUpperCase(), description: `${slug} help`, body }) });
    assert.equal(res.status, 201, res.text);
    const detail = await api(`/skills/${res.body.id}`);
    return { id: res.body.id, v1: detail.body.versions[0].id };
  };
  const shared = await createSkill('shared-rules', '# Shared v1');
  const proj = await createSkill('proj-tool', '# Project tool');
  const mine = await createSkill('mine', '# Mine');
  const v2res = await api(`/skills/${shared.id}/versions`, { method: 'POST', body: JSON.stringify({ body: '# Shared v2' }) });
  assert.ok(v2res.status < 300, v2res.text);
  const sharedV2 = v2res.body.id;

  const assign = (skill, version, target) => api(`/skills/${skill.id}/assignments`, { method: 'POST', body: JSON.stringify({ skill_version_id: version, target }) });
  assert.ok((await assign(shared, shared.v1, { scope: 'account' })).status < 300);
  assert.ok((await assign(proj, proj.v1, { scope: 'project', project_id: project.id })).status < 300);
  assert.ok((await assign(mine, mine.v1, { scope: 'runtime', runtime: agent.runtime_spec })).status < 300);
  // 같은 skill 을 실행 범위로 다른 버전에 — 좁은 범위가 이겨야 한다.
  assert.ok((await assign(shared, sharedV2, { scope: 'runtime', runtime: agent.runtime_spec })).status < 300);
  const badProject = await assign(proj, proj.v1, { scope: 'project', project_id: '00000000-0000-4000-8000-000000000000' });
  assert.equal(badProject.status, 404);

  // 1. 배정 현황
  const list = await api('/skills/assignments');
  assert.equal(list.status, 200, list.text);
  const byKey = (scope, slug) => list.body.find((a) => a.scope === scope && a.skill_slug === slug);
  assert.equal(byKey('account', 'shared-rules').version, 1);
  assert.equal(byKey('account', 'shared-rules').latest_version, 2);
  assert.equal(byKey('project', 'proj-tool').project_name, project.name);
  assert.match(byKey('runtime', 'mine').target_label, /\//, 'runtime targets read as <Host>/<label>');

  // 2. 실행의 skill = 공용 ∪ 프로젝트 ∪ 실행, 좁은 범위 우선
  const snapshots = app.get(RunSkillSnapshotService);
  const manifest = await snapshots.manifestFor({ accountId: ws.id, runtimeKey: agent.id, projectId: project.id });
  assert.deepEqual(manifest.map((m) => [m.slug, m.version, m.scope]), [
    ['mine', 1, 'runtime'],
    ['proj-tool', 1, 'project'],
    ['shared-rules', 2, 'runtime'],
  ]);
  const elsewhere = await snapshots.manifestFor({ accountId: ws.id, runtimeKey: 'rt-someone-else', projectId: null });
  assert.deepEqual(elsewhere.map((m) => [m.slug, m.version, m.scope]), [['shared-rules', 1, 'account']], 'other agents get only the shared skill');

  // 3. 공용 메모리
  const tooLong = await call(`${base}/api/accounts/${ws.id}`, { method: 'PATCH', headers, body: JSON.stringify({ knowledge_memory: 'x'.repeat(32_001) }) });
  assert.equal(tooLong.status, 400);
  const saved = await call(`${base}/api/accounts/${ws.id}`, { method: 'PATCH', headers, body: JSON.stringify({ knowledge_memory: 'Always report how you verified.' }) });
  assert.ok(saved.status < 300, saved.text);
  assert.equal((await call(`${base}/api/accounts/${ws.id}`, { headers })).body.knowledge_memory, 'Always report how you verified.');

  // 티켓 런 스냅샷 + work order
  const ticket = await createTicket(app, getDataSourceToken, { accountId: ws.id, title: 'build it', assignee: agent, projectId: project.id });
  const snapshot = await snapshots.resolve({ accountId: ws.id, runId: `ticket:${ticket.id}:assignee`, agentId: agent.id, projectId: project.id });
  const order = renderTicketWorkOrder({
    base_branch: '',
    ticket_id: ticket.id,
    project: { name: 'app', repo_url: '', default_branch: 'main', use_pr: false, instructions: 'Build with npm run build.', main_clone_dir: null },
    knowledge: { shared_memory: 'Always report how you verified.', skills: RunSkillSnapshotService.index(snapshot.manifest) },
  });
  assert.match(order, /## Knowledge\n\n### Shared memory[^\n]*\n\nAlways report how you verified\./);
  assert.match(order, /- \*\*proj-tool\*\* \(v1, project\) — PROJ-TOOL: proj-tool help/);
  assert.match(order, new RegExp(`mcp__awb__get_skill\` with \`\\{ slug, ticket_id: "${ticket.id}" \\}`));
  assert.doesNotMatch(order, /# Project tool/, 'skill bodies are not inlined — the agent loads them on demand');
  const plain = renderTicketWorkOrder({ base_branch: '', project: null, knowledge: { shared_memory: '', skills: [] } });
  assert.doesNotMatch(plain, /## Knowledge/, 'no knowledge → the work order is unchanged');

  // 4. MCP
  const key = await createApiKey(app, getDataSourceToken, agent.id, { accountId: ws.id, label: 'knowledge' });
  const client = new McpClient({ baseUrl: `http://127.0.0.1:${port}`, apiKey: key.raw_key });
  t.after(() => client.close().catch(() => {}));
  const knowledge = await client.callTool('get_knowledge', { project_id: project.id });
  assert.equal(knowledge.shared_memory, 'Always report how you verified.');
  assert.deepEqual(knowledge.project, { id: project.id, name: project.name, memory: 'Build with npm run build.' });
  assert.deepEqual(knowledge.skills.map((s) => `${s.slug}@${s.version}:${s.scope}`), ['mine@1:runtime', 'proj-tool@1:project', 'shared-rules@2:runtime']);
  const tool = await client.callTool('get_skill', { slug: 'proj-tool', project_id: project.id });
  assert.equal(tool.body, '# Project tool');
  const missing = await client.callTool('get_skill', { slug: 'nope' });
  assert.equal(missing.isError, true);

  // 재핀해도 이미 시작한 티켓 런은 고정된 버전을 읽는다.
  const sharedRuntime = (await api('/skills/assignments')).body.find((a) => a.scope === 'runtime' && a.skill_slug === 'shared-rules');
  const repin = await api(`/skills/assignments/${sharedRuntime.id}`, { method: 'PATCH', body: JSON.stringify({ skill_version_id: shared.v1 }) });
  assert.ok(repin.status < 300, repin.text);
  const pinned = await client.callTool('get_skill', { slug: 'shared-rules', ticket_id: ticket.id });
  assert.equal(pinned.version, 2);
  assert.equal(pinned.pinned_for_ticket, true);
  const live = await client.callTool('get_skill', { slug: 'shared-rules' });
  assert.equal(live.version, 1, 'outside the ticket the current assignment applies');

  // 해제
  const projAssignment = (await api('/skills/assignments')).body.find((a) => a.scope === 'project');
  assert.equal((await api(`/skills/assignments/${projAssignment.id}`, { method: 'DELETE' })).status, 200);
  const after = await client.callTool('get_knowledge', { project_id: project.id });
  assert.equal(after.skills.some((s) => s.slug === 'proj-tool'), false);

  // 다른 계정에 묶인 키는 이 프로젝트를 읽지 못한다.
  const otherAgent = await createAgent(app, getDataSourceToken, other.id, { name: 'stranger', type: 'claude', runtime: true });
  const otherKey = await createApiKey(app, getDataSourceToken, otherAgent.id, { accountId: other.id, label: 'stranger' });
  const stranger = new McpClient({ baseUrl: `http://127.0.0.1:${port}`, apiKey: otherKey.raw_key });
  t.after(() => stranger.close().catch(() => {}));
  const denied = await stranger.callTool('get_knowledge', { project_id: project.id });
  assert.equal(denied.isError, true);
});
