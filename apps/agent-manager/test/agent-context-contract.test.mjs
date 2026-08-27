import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import {
  AGENT_CONTEXT_MAX_CHARS,
  AgentContextPreflightError,
  buildAgentContextContract,
  renderAgentContextContract,
} from '../dist/lib/agent-context-contract.js';
import { composeTriggerPrompt, repositoryContextInstructions } from '../dist/lib/prompts.js';
import { composePersistentTriggerTurn } from '../dist/lib/ticket-session-manager.js';
import { ClaudeCliAdapter } from '../dist/lib/cli-adapters/claude.js';
import { CodexCliAdapter } from '../dist/lib/cli-adapters/codex.js';

const ticket = {
  id: 'ticket-1', workspace_id: 'workspace-1', board_id: 'board-1',
  current_column_id: 'column-1', current_column_name: 'In Progress', current_column_kind: 'active',
  comments: [{ created_at: '2026-08-27', author: 'Agent', content: '조사 완료; 다음은 테스트' }],
};
const repository = {
  resourceId: 'repo-1', cwd: '/work/ticket-1', baseBranch: 'main', baseSha: 'base-sha',
  currentSha: 'head-sha', workingBranch: 'ticket/ticket-1-work', dirty: true,
  ahead: 2, behind: 0, resumed: true,
};

function decoratedTicket(sessionMode, overrides = {}) {
  return {
    ...ticket,
    ...overrides,
    __awb_role: 'assignee',
    __awb_repository_context: { ...repository, ...(overrides.__awb_repository_context || {}) },
    __awb_session_mode: sessionMode,
    __awb_context_metadata: {
      remoteUrl: 'https://example.invalid/repo.git', defaultBranch: 'main',
      credentialAvailable: true, sandbox: 'strict', requestedGitOperation: 'commit_and_push',
      mcpServers: ['awb'], verificationCommands: ['npm test'],
    },
  };
}

test('provider와 무관하게 동일한 의미 계약을 직렬화한다', () => {
  const common = { ticket, role: 'assignee', repository, harness: { model: 'model-a', permission_mode: 'strict' } };
  const claude = buildAgentContextContract({ ...common, sessionMode: 'persistent' });
  const codex = buildAgentContextContract({ ...common, sessionMode: 'persistent' });
  assert.deepEqual(codex, claude);
  assert.match(renderAgentContextContract(claude), /"currentSha": "head-sha"/);
  assert.match(renderAgentContextContract(claude), /조사 완료/);
});

test('필수 column 누락은 실행 전 분류된 오류가 된다', () => {
  assert.throws(
    () => buildAgentContextContract({ ticket: { id: 'ticket-1' }, role: 'assignee' }),
    (error) => error instanceof AgentContextPreflightError && error.category === 'column',
  );
});

test('실제 trigger prompt 경계도 column 누락 시 spawn 전에 중단한다', () => {
  assert.throws(
    () => composeTriggerPrompt({ id: 'ticket-1', __awb_enforce_context_contract: true }, '', '', 'ticket-1', null),
    (error) => error instanceof AgentContextPreflightError && error.category === 'column',
  );
});

test('persistent 두 번째 dispatch는 최신 SHA, dirty, prior progress를 재주입한다', () => {
  const firstTicket = decoratedTicket('persistent');
  const secondTicket = decoratedTicket('persistent', {
    comments: [...ticket.comments, { created_at: '2026-08-28', author: 'Agent', content: '재검증 완료' }],
    __awb_repository_context: { currentSha: 'new-head-sha', dirty: false, ahead: 3 },
  });
  const base = {
    ticketId: ticket.id, role: 'assignee', triggerId: 'trigger-2', agentId: 'agent-1',
    rolePrompt: '', ticketPrompt: '', columnPrompt: null, forceRespawn: false,
  };
  const first = composePersistentTriggerTurn({ ...base, ticket: firstTicket });
  const second = composePersistentTriggerTurn({ ...base, ticket: secondTicket });
  assert.match(first, /"currentSha": "head-sha"/);
  assert.match(second, /"currentSha": "new-head-sha"/);
  assert.match(second, /"dirty": false/);
  assert.match(second, /재검증 완료/);
  assert.doesNotMatch(second, /"currentSha": "head-sha"/);
});

test('Claude/Codex adapter와 Hermes task 경계의 최종 입력 의미가 동등하다', () => {
  const contractPrompt = composeTriggerPrompt(decoratedTicket('stateless'), '', '', ticket.id, null);
  const claudeDescriptor = new ClaudeCliAdapter().buildOneshotSpawn({
    rolePrompt: '역할 지침', taskText: contractPrompt, mcpConfigPath: '/tmp/mcp.json',
    model: null, harness: null, effort: null, ultracode: false,
  });
  const claude = claudeDescriptor.args.at(-1);
  let codex = '';
  const codexDescriptor = new CodexCliAdapter().buildOneshotSpawn({
    rolePrompt: '역할 지침', taskText: contractPrompt, mcpConfigPath: null,
    model: null, harness: null, effort: null, ultracode: false, cwd: '/work/ticket-1',
  });
  codexDescriptor.writePrompt({ stdin: { write(value) { codex += value; }, end() {} } });
  // Hermes dispatcher가 RuntimeSupervisor.task로 넘기는 최종 task 경계와 동일하다.
  const hermes = composeTriggerPrompt(decoratedTicket('hermes'), '', '', ticket.id, null);
  const prompts = [claude, codex, hermes];
  for (const prompt of prompts) {
    assert.match(prompt, /"authority": \[/);
    assert.match(prompt, /"remoteUrl": "https:\/\/example.invalid\/repo.git"/);
    assert.match(prompt, /"credentialAvailable": true/);
    assert.match(prompt, /"requestedGitOperation": "commit_and_push"/);
    assert.match(prompt, /"verificationCommands": \[/);
    assert.match(prompt, /"currentSha": "head-sha"/);
  }
});

test('HEAD 조회 실패를 base SHA로 위장하지 않는다', () => {
  const contract = buildAgentContextContract({
    ticket, role: 'assignee', repository: { ...repository, currentSha: undefined, currentShaFailure: 'head_lookup_failed' },
  });
  assert.equal(contract.repository.currentSha, null);
  assert.equal(contract.repository.currentShaFailure, 'head_lookup_failed');
});

test('전체 예산 안에서 비밀을 제거하고 높은 우선순위 항목을 보존한다', () => {
  const huge = (prefix) => Array.from({ length: 40 }, (_, index) =>
    `${prefix}-${index} password=hunter2 token=tok_${'x'.repeat(40)} ${'z'.repeat(1200)}`);
  const contract = buildAgentContextContract({
    ticket: {
      ...ticket,
      comments: huge('comment').map((content) => ({ content, author: 'Bearer abcdefghijklmnop' })),
      __awb_context_metadata: {
        relatedTickets: huge('related'), recentDecisions: huge('decision'),
        unresolvedQuestions: huge('question'),
        verificationCommands: [...huge('verify'), 'npm test --workspace=apps/agent-manager'],
      },
    }, role: 'assignee', repository,
  });
  const rendered = renderAgentContextContract(contract);
  assert.ok(rendered.length <= AGENT_CONTEXT_MAX_CHARS);
  assert.doesNotMatch(rendered, /hunter2|tok_x|abcdefghijklmnop/);
  assert.match(rendered, /\[REDACTED\]/);
  assert.equal(contract.priorProgress.length, 0);
  assert.equal(contract.relatedTickets.length, 0);
  assert.match(rendered, /npm test --workspace=apps\/agent-manager/);
  const prompt = composeTriggerPrompt({
    ...decoratedTicket('stateless'),
    comments: [{ created_at: '2026-08-27', author: 'Agent', content: 'password=hunter2 Bearer abcdefghijklmnop' }],
  }, '', '', ticket.id, null);
  assert.doesNotMatch(prompt, /hunter2|abcdefghijklmnop/);
});

test('민감 키와 JSON 문자열의 일반 비밀값을 최종 trigger prompt에서 제거한다', () => {
  const metadataFields = {
    relatedTickets: [{ token: 'hunter2-related' }],
    recentDecisions: [{ apiKey: 'hunter2-decision' }],
    unresolvedQuestions: [{ password: 'hunter2-question' }],
    verificationCommands: [{ credential_ref: 'hunter2-verification' }],
  };
  const prompt = composeTriggerPrompt({
    ...decoratedTicket('stateless'),
    comments: [{
      created_at: '2026-08-27',
      author: 'Agent',
      content: '설정 JSON: {"token":"hunter2-comment","safe":"visible"}',
    }],
    __awb_context_metadata: {
      ...decoratedTicket('stateless').__awb_context_metadata,
      mcpServers: [{
        name: 'awb',
        transport: { headers: { token: 'hunter2-mcp', nested: { secret: 'hunter2-nested' } } },
      }],
      ...metadataFields,
    },
  }, '', '', ticket.id, null);

  assert.doesNotMatch(prompt, /hunter2/);
  assert.match(prompt, /\[REDACTED\]/);
  assert.match(prompt, /"safe":"visible"/);
});

test('메타데이터 컬렉션의 객체형 비밀값을 직렬화 전에 재귀 제거한다', () => {
  const contract = buildAgentContextContract({
    ticket: {
      ...ticket,
      __awb_context_metadata: {
        relatedTickets: [{ password: 'related-object-secret' }],
        recentDecisions: [{ nested: { token: 'decision-object-secret' } }],
        unresolvedQuestions: [{ values: [{ api_key: 'question-object-secret' }] }],
        verificationCommands: [{ credential_ref: 'vault://verification-object-secret' }],
      },
    },
    role: 'assignee',
    repository,
  });
  const rendered = renderAgentContextContract(contract);
  assert.doesNotMatch(rendered, /related-object-secret|decision-object-secret|question-object-secret|verification-object-secret/);
  assert.equal((rendered.match(/\[REDACTED\]/g) || []).length, 4);
});

test('최종 trigger prompt는 current SHA 실패를 base SHA로 오인시키지 않는다', () => {
  const decorated = decoratedTicket('stateless', {
    __awb_repository_context: { currentSha: undefined, currentShaFailure: 'head_lookup_failed' },
  });
  const prompt = composeTriggerPrompt(
    decorated, '', '', ticket.id, null,
    repositoryContextInstructions(decorated.__awb_repository_context),
  );
  assert.match(prompt, /current SHA: \(unknown; head_lookup_failed\)/);
  assert.doesNotMatch(prompt, /current SHA: base-sha/);
  assert.match(prompt, /"currentSha": null/);
});

test('remote URL의 credential과 query를 redaction한다', () => {
  const contract = buildAgentContextContract({
    ticket, role: 'assignee',
    repository: { ...repository, remoteUrl: 'https://user:secret@example.invalid/repo.git?token=secret' },
  });
  const rendered = renderAgentContextContract(contract);
  assert.match(rendered, /https:\/\/example.invalid\/repo.git/);
  assert.doesNotMatch(rendered, /user|secret|token=/);
});

test('AGENTS.md는 CLAUDE.md 공통 원본에서 생성된 상태다', async () => {
  const root = new URL('../../../', import.meta.url);
  const source = await readFile(new URL('CLAUDE.md', root), 'utf8');
  const agents = await readFile(new URL('AGENTS.md', root), 'utf8');
  assert.ok(agents.endsWith(source));
  assert.match(agents, /scripts\/sync-agent-instructions\.mjs가 CLAUDE\.md에서 생성했습니다/);
});
