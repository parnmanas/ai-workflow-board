import type { HarnessSpec, RuntimeProfileSpec } from './cli-adapters/base.js';
import type { TicketRepositoryContext } from './worktree-manager.js';

export const AGENT_CONTEXT_VERSION = '1.1';

export interface AgentContextContractInput {
  ticket: any;
  role: string;
  repository?: TicketRepositoryContext;
  harness?: HarnessSpec | null;
  runtimeProfile?: RuntimeProfileSpec | null;
  sessionMode?: 'persistent' | 'stateless' | 'hermes';
  mcpAvailable?: boolean;
  effort?: string | null;
}

export class AgentContextPreflightError extends Error {
  constructor(public readonly category: 'ticket' | 'column' | 'repository', message: string) {
    super(message);
    this.name = 'AgentContextPreflightError';
  }
}

function compact(value: unknown, limit: number): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, limit);
}

function redactRemoteUrl(value: unknown): string | null {
  const raw = compact(value, 2048);
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    parsed.username = '';
    parsed.password = '';
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return raw.replace(/:\/\/[^/@]+@/, '://').replace(/[?#].*$/, '');
  }
}

/** 비밀 원문은 계약에 받을 수도, 직렬화할 수도 없다. 가용 여부만 전달한다. */
export function buildAgentContextContract(input: AgentContextContractInput) {
  const ticket = input.ticket;
  if (!ticket?.id) throw new AgentContextPreflightError('ticket', 'ticket.id가 없습니다');
  if (!ticket.current_column_id || !ticket.current_column_name) {
    throw new AgentContextPreflightError('column', '현재 column 확정값이 없습니다');
  }
  const repositoryComplete = Boolean(
    input.repository?.resourceId
    && input.repository.cwd
    && input.repository.baseBranch
    && input.repository.baseSha,
  );
  if (ticket.__awb_require_repository_context && !repositoryComplete) {
    throw new AgentContextPreflightError('repository', '연결된 저장소의 준비 결과가 없습니다');
  }

  const comments = Array.isArray(ticket.comments) ? ticket.comments.slice(-5) : [];
  const metadata = ticket.__awb_context_metadata || {};
  return {
    version: AGENT_CONTEXT_VERSION,
    authority: ['system_policy', 'role_instructions', 'project_instructions', 'task', 'prior_progress'],
    assignment: {
      workspaceId: ticket.workspace_id || '',
      boardId: ticket.board_id || ticket.board?.id || '',
      ticketId: ticket.id,
      role: input.role,
      column: {
        id: ticket.current_column_id,
        name: ticket.current_column_name,
        kind: ticket.current_column_kind || '',
      },
    },
    repository: input.repository ? {
      resourceId: input.repository.resourceId,
      cwd: input.repository.cwd,
      remoteUrl: redactRemoteUrl(input.repository.remoteUrl ?? metadata.remoteUrl),
      defaultBranch: input.repository.defaultBranch ?? metadata.defaultBranch ?? null,
      baseBranch: input.repository.baseBranch,
      baseSha: input.repository.baseSha,
      fetchedSha: input.repository.fetchedSha ?? input.repository.baseSha,
      currentSha: input.repository.currentSha || null,
      currentShaFailure: input.repository.currentShaFailure ?? null,
      workingBranch: input.repository.workingBranch,
      dirty: input.repository.dirty,
      ahead: input.repository.ahead,
      behind: input.repository.behind,
      resumed: input.repository.resumed,
    } : null,
    execution: {
      model: input.harness?.model || input.runtimeProfile?.model || '',
      effort: input.effort ?? metadata.effort ?? null,
      permissionMode: input.harness?.permission_mode || 'managed-default',
      sandbox: metadata.sandbox ?? input.harness?.permission_mode ?? 'managed-default',
      mcpAvailable: input.mcpAvailable !== false,
      mcpServers: Array.isArray(metadata.mcpServers) ? metadata.mcpServers : [],
      sessionMode: input.sessionMode || 'stateless',
      credentialAvailable: metadata.credentialAvailable ?? input.repository?.credentialAvailable ?? null,
      credentialFailure: metadata.credentialFailure ?? input.repository?.credentialFailure ?? null,
      requestedGitOperation: metadata.requestedGitOperation ?? null,
    },
    relatedTickets: Array.isArray(metadata.relatedTickets) ? metadata.relatedTickets : [],
    recentDecisions: Array.isArray(metadata.recentDecisions) ? metadata.recentDecisions : [],
    unresolvedQuestions: Array.isArray(metadata.unresolvedQuestions) ? metadata.unresolvedQuestions : [],
    verificationCommands: Array.isArray(metadata.verificationCommands) ? metadata.verificationCommands : [],
    priorProgress: comments.map((comment: any) => ({
      at: comment.created_at || '',
      author: compact(comment.author_name || comment.agent_name || comment.author || 'unknown', 120),
      content: compact(comment.body || comment.content, 1200),
    })),
  };
}

export function renderAgentContextContract(contract: ReturnType<typeof buildAgentContextContract>): string {
  return [
    `AWB Agent Context Contract v${contract.version} (provider-neutral, redacted):`,
    JSON.stringify(contract, null, 2),
  ].join('\n');
}
