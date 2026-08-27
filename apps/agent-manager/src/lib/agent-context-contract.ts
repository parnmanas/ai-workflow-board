import type { HarnessSpec, RuntimeProfileSpec } from './cli-adapters/base.js';
import type { TicketRepositoryContext } from './worktree-manager.js';

export const AGENT_CONTEXT_VERSION = '1.2';
export const AGENT_CONTEXT_MAX_CHARS = 16_000;
const CONTRACT_JSON_MAX_CHARS = 15_900;
const COLLECTION_MAX_ITEMS = 20;
const COLLECTION_ITEM_MAX_CHARS = 800;
const REDACTED = '[REDACTED]';
const SENSITIVE_KEY_NAMES = new Set([
  'authorization',
  'password',
  'passwd',
  'pwd',
  'token',
  'accesstoken',
  'refreshtoken',
  'apikey',
  'secret',
  'clientsecret',
  'credential',
  'credentialref',
  'privatekey',
]);

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
  return redactAgentContextText(String(value ?? '').replace(/\s+/g, ' ').trim()).slice(0, limit);
}

export function redactAgentContextText(value: string): string {
  return value
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+\/-]+=*/gi, `$1${REDACTED}`)
    .replace(/(["']?(?:authorization|password|passwd|pwd|token|access[_-]?token|refresh[_-]?token|api[_-]?key|secret|client[_-]?secret|credential(?:_ref)?|private[_-]?key)["']?\s*[:=]\s*)(["'])(.*?)(\2)/gi, `$1$2${REDACTED}$4`)
    .replace(/\b((?:authorization|password|passwd|pwd|token|access[_-]?token|refresh[_-]?token|api[_-]?key|secret|client[_-]?secret|credential(?:_ref)?|private[_-]?key)\s*[:=]\s*)[^\s,;]+/gi, `$1${REDACTED}`)
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9_-]{16,})\b/g, REDACTED);
}

function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_NAMES.has(key.replace(/[^a-z0-9]/gi, '').toLowerCase());
}

function boundedCollection(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.slice(-COLLECTION_MAX_ITEMS).map((item) =>
    compact(
      typeof item === 'string' ? item : JSON.stringify(redactContractValue(item)),
      COLLECTION_ITEM_MAX_CHARS,
    ));
}

function redactContractValue(value: any): any {
  if (typeof value === 'string') return redactAgentContextText(value).slice(0, 2048);
  if (Array.isArray(value)) return value.map(redactContractValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [
      key,
      isSensitiveKey(key) ? REDACTED : redactContractValue(item),
    ]));
  }
  return value;
}

/** 낮은 우선순위부터 제거해 JSON 본문을 고정 예산 안에 맞춘다. */
function enforceContextBudget(contract: any): any {
  contract = redactContractValue(contract);
  const order = ['priorProgress', 'relatedTickets', 'recentDecisions', 'unresolvedQuestions', 'verificationCommands'];
  for (const field of order) {
    while (JSON.stringify(contract, null, 2).length > CONTRACT_JSON_MAX_CHARS && contract[field].length > 0) {
      contract[field].shift();
    }
  }
  if (JSON.stringify(contract, null, 2).length > CONTRACT_JSON_MAX_CHARS) {
    throw new AgentContextPreflightError('ticket', '필수 Agent Context가 전체 크기 제한을 초과했습니다');
  }
  return contract;
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
  return enforceContextBudget({
    version: AGENT_CONTEXT_VERSION,
    authority: ['system_policy', 'role_instructions', 'project_instructions', 'task', 'prior_progress'],
    assignment: {
      workspaceId: compact(ticket.workspace_id, 256),
      boardId: compact(ticket.board_id || ticket.board?.id, 256),
      ticketId: compact(ticket.id, 256),
      role: compact(input.role, 120),
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
    relatedTickets: boundedCollection(metadata.relatedTickets),
    recentDecisions: boundedCollection(metadata.recentDecisions),
    unresolvedQuestions: boundedCollection(metadata.unresolvedQuestions),
    verificationCommands: boundedCollection(metadata.verificationCommands),
    priorProgress: comments.map((comment: any) => ({
      at: comment.created_at || '',
      author: compact(comment.author_name || comment.agent_name || comment.author || 'unknown', 120),
      content: compact(comment.body || comment.content, 1200),
    })),
  });
}

export function renderAgentContextContract(contract: ReturnType<typeof buildAgentContextContract>): string {
  const rendered = [
    `AWB Agent Context Contract v${contract.version} (provider-neutral, redacted):`,
    JSON.stringify(contract, null, 2),
  ].join('\n');
  if (rendered.length > AGENT_CONTEXT_MAX_CHARS) {
    throw new AgentContextPreflightError('ticket', '직렬화된 Agent Context가 전체 크기 제한을 초과했습니다');
  }
  return rendered;
}
