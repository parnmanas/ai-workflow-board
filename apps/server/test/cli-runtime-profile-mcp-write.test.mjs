// 티켓 0d2c53bf — 기본 backend/runtime 프로파일을 opt-out(`'none'`)으로 핀하려면
// REST/웹 UI 개입이 항상 필요했던 문제의 회귀 테스트.
//
// 원래 표면이던 MCP `update_agent` / `update_board` 는 사라졌다(P4c-4 Agent
// 테이블 제거, 보드 제거). 이제 티켓 실행 설정은 assignee RuntimeSpec 이 갖고
// (docs/tickets.md), 프로필 핀은 그 spec 의 `cli_runtime_profile` 에 실린다 —
// MCP `create_ticket` / `update_ticket` 의 `assignee` 가 그 쓰기 표면이다.
// 디스패치는 ticket-dispatch.service.ts 가 `[{ source: 'agent', value:
// spec.cli_runtime_profile }]` → 전역 기본값 순으로 해석한다.

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { bootApp } from './helpers/boot.mjs';
import { createAgent, createApiKey, createUser, createWorkspace } from './helpers/fixtures.mjs';
import { McpClient } from './helpers/mcp-client.mjs';

let app;
let port;
let ds;
let mcp;
let token;
let workspace;
let agent;
let profile;
let resolveClaudeBackendProfileForDispatch;

const assigneeWith = (cli_runtime_profile) => ({ ...agent.runtime_spec, cli: 'claude', cli_runtime_profile });

async function api(method, path, body) {
  const res = await fetch(`http://localhost:${port}/api${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'X-Workspace-Id': workspace.id },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, body: json };
}

// backlog 티켓은 디스패치되지 않는다 — 핀 저장 경로만 본다.
async function makeTicket(cliRuntimeProfile = null) {
  const created = await mcp.callTool('create_ticket', {
    workspace_id: workspace.id,
    title: `profile pin ${randomUUID().slice(0, 8)}`,
    status: 'backlog',
    assignee: assigneeWith(cliRuntimeProfile),
  });
  assert.ok(created?.id, `create_ticket failed: ${JSON.stringify(created)}`);
  return created;
}

const storedProfile = async (ticketId) =>
  (await ds.getRepository('Ticket').findOneByOrFail({ id: ticketId })).assignee?.cli_runtime_profile ?? null;

before(async () => {
  let modules;
  ({ app, port, modules } = await bootApp({ port: 0 }));
  const gdst = modules.getDataSourceToken;
  ds = app.get(gdst());
  ({ resolveClaudeBackendProfileForDispatch } = await import('../dist/common/claude-backend-registry.js'));
  const { AuthService } = await import('../dist/services/auth.service.js');

  workspace = await createWorkspace(app, gdst, 'cli-profile-mcp-write');
  const admin = await createUser(app, gdst, { name: 'admin', role: 'admin' });
  token = app.get(AuthService).createSession(admin.id);
  agent = await createAgent(app, gdst, workspace.id, { name: 'profile-writer', runtime: true });
  const key = await createApiKey(app, gdst, agent.id, { workspaceId: workspace.id, label: 'profile-writer' });
  mcp = new McpClient({ baseUrl: `http://localhost:${port}`, apiKey: key.raw_key });
  await mcp.initialize();

  profile = await ds.getRepository('ClaudeBackendProfile').save(
    ds.getRepository('ClaudeBackendProfile').create({
      id: randomUUID(),
      name: 'Global default vLLM',
      protocol: 'anthropic-compatible',
      base_url: 'http://vllm.invalid:8000',
      model: 'qwen3-coder-next',
      config: '{}',
    }),
  );
  // 프로필은 인스턴스 전역이라 워크스페이스 배정이 없다(티켓 e616dbfc).
  // 상속의 마지막 단계는 SystemSetting 의 전역 기본값 하나뿐이다.
  await ds.getRepository('SystemSetting').save(
    ds.getRepository('SystemSetting').create({
      key: 'claude_backend_profiles.default',
      value: profile.id,
      description: 'Instance default Claude backend profile',
      is_secret: 0,
    }),
  );
});

after(async () => {
  await mcp?.close().catch(() => {});
  await app?.close();
});

describe('MCP cli_runtime_profile write (ticket 0d2c53bf)', () => {
  it("update_ticket stores an explicit 'none' opt-out on the assignee", async () => {
    const ticket = await makeTicket();
    const result = await mcp.callTool('update_ticket', { ticket_id: ticket.id, assignee: assigneeWith('none') });
    assert.ok(result?.id, `update_ticket failed: ${JSON.stringify(result)}`);
    assert.equal(await storedProfile(ticket.id), 'none');
  });

  it("assignee-level 'none' stops dispatch from inheriting the global default (success criterion 4)", async () => {
    const ticket = await makeTicket('none');
    const pinned = await storedProfile(ticket.id);

    const withOptOut = await resolveClaudeBackendProfileForDispatch(ds, [{ source: 'agent', value: pinned }]);
    assert.equal(withOptOut, null, "assignee 'none' must not inherit the global default");

    // 대조군: 핀이 없으면 같은 체인이 전역 기본값으로 떨어진다.
    const inherited = await resolveClaudeBackendProfileForDispatch(ds, [{ source: 'agent', value: null }]);
    assert.equal(inherited?.id, profile.id);
  });

  it('전역 기본값이 비어 있으면 아무 핀도 없을 때 null 로 해석한다', async () => {
    const settings = ds.getRepository('SystemSetting');
    const saved = await settings.findOneByOrFail({ key: 'claude_backend_profiles.default' });
    try {
      await settings.update({ key: 'claude_backend_profiles.default' }, { value: '' });
      const resolved = await resolveClaudeBackendProfileForDispatch(ds, [{ source: 'agent', value: null }]);
      assert.equal(resolved, null, '상속 체인이 모두 비면 프로필 없이 디스패치한다');
    } finally {
      await settings.update({ key: 'claude_backend_profiles.default' }, { value: saved.value });
    }
  });

  // TODO(board removal): server bug — ticket assignee writes do not validate
  // `cli_runtime_profile` against the global profile list. TicketService
  // .normalizeAssignee (src/modules/tickets/ticket.service.ts:121) only runs
  // normalizeRuntimeSpec (shape), so a bogus id is stored and only fails later
  // at dispatch (ticket-dispatch.service.ts buildPayload → 'build_failed').
  // Team slots (orchestration-team.service.ts) and POST /runtime-specs/validate
  // still reject it; validateCliRuntimeProfileSelection
  // (common/claude-backend-registry.ts) lost its last caller. Remove `todo`
  // once ticket create/update reject it with that helper's message.
  it(
    'REST PATCH /tickets/:id and MCP update_ticket reject a nonexistent profile id with the same message and leave the pin unchanged (fail-closed)',
    async () => {
      const ticket = await makeTicket('none');

      const rest = await api('PATCH', `/tickets/${ticket.id}`, { assignee: assigneeWith('does-not-exist') });
      assert.equal(rest.status, 400, JSON.stringify(rest.body));
      assert.match(rest.body.error, /cli_runtime_profile "does-not-exist" does not exist$/);
      assert.equal(await storedProfile(ticket.id), 'none');

      const mcpResult = await mcp.callTool('update_ticket', { ticket_id: ticket.id, assignee: assigneeWith('does-not-exist') });
      assert.equal(mcpResult?.isError, true, JSON.stringify(mcpResult));
      assert.equal(mcpResult.error?.error, rest.body.error, 'REST and MCP must return the identical error message');
      assert.equal(await storedProfile(ticket.id), 'none', 'both rejected paths must leave the pin unchanged');
    },
  );
});
