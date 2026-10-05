import { DataSource } from 'typeorm';
import { Ticket } from '../entities/Ticket';
import { Account } from '../entities/Account';
import { appendBoardLanguageInstruction, parseHarnessConfig, HarnessConfig } from './harness-config';
import { cliDescriptor } from './cli-catalog';
import { CliRuntimeProfile } from './cli-runtime-profiles';
import { resolveClaudeBackendProfileForDispatch } from './claude-backend-registry';
import { parseEnvironmentConfig, resolveEnvironmentConfig, ResolvedEnvironmentConfig } from './environment-config';
import { DEFAULT_WORKTREE_MODE, WorktreeMode } from './worktree-config';
import { isRuntimeIdentityKey, parseRuntimeSpec, type RuntimeSpec } from './runtime-spec';

export interface MentionDispatchExtras {
  harness_config: HarnessConfig | null;
  /** Always null since board removal — effort rides the runtime spec. */
  effort_preset: null;
  cli_runtime_profile: CliRuntimeProfile | null;
  environment_config: ResolvedEnvironmentConfig | null;
  worktree_mode: WorktreeMode;
}

/** The minimal executor shape the extras need (from a RuntimeSpec). */
export interface DispatchAgentLike {
  type: string | null;
  cli_runtime_profile: string | null;
  credential_id: string | null;
}

/**
 * 티켓 71532b4f — comment_mention dispatch(코멘트 @-멘션으로 깨우는 one-shot
 * subagent)용 harness / Claude backend runtime profile / environment env_vars /
 * worktree mode. TicketDispatchService 가 agent_trigger 에 싣는 것과 같은
 * 워크스페이스 레이어를 쓰므로, 같은 (agent, ticket) 이 어느 경로로 깨든 같은
 * backend/harness/env 로 동작한다.
 *
 * environment_config 는 env_vars 만 — repository 는 티켓의 project 에서만 온다.
 * harness/environment 해석 실패는 멘션 전달을 유지하도록 기본값으로 degrade 하고,
 * Claude runtime profile 해석과 credential 검증은 fail-closed 다(명시 프로파일
 * 오류를 null 로 바꾸면 기본 유료 backend 로 조용히 폴백한다).
 */
export async function resolveMentionDispatchExtras(
  dataSource: DataSource,
  ticket: Pick<Ticket, 'account_id'>,
  agent: DispatchAgentLike,
): Promise<MentionDispatchExtras> {
  let extras: MentionDispatchExtras = {
    harness_config: null,
    effort_preset: null,
    cli_runtime_profile: null,
    environment_config: null,
    worktree_mode: DEFAULT_WORKTREE_MODE,
  };
  try {
    const workspace = ticket.account_id
      ? await dataSource.getRepository(Account).findOne({ where: { id: ticket.account_id } })
      : null;
    const env = parseEnvironmentConfig(workspace?.environment_config);
    extras = {
      ...extras,
      harness_config: appendBoardLanguageInstruction(parseHarnessConfig(workspace?.harness_config), workspace?.language),
      environment_config: env ? resolveEnvironmentConfig({ ...env, repositories: [] }, () => null) : null,
    };
  } catch {
    // best-effort — runtime profile below is resolved separately and fails closed.
  }

  if (!cliDescriptor(agent.type)?.sessions.backend_profile) return extras;
  let runtimeProfile: CliRuntimeProfile | null;
  try {
    runtimeProfile = await resolveClaudeBackendProfileForDispatch(dataSource, [
      { source: 'agent', value: agent.cli_runtime_profile },
    ]);
  } catch (error) {
    console.warn('[MentionDispatch] Claude runtime profile 해석 실패 — comment_mention dispatch를 중단합니다.', {
      account_id: ticket.account_id,
      error: String(error),
    });
    throw error;
  }
  if (runtimeProfile?.credential_required && runtimeProfile.credential_ref !== agent.credential_id) {
    throw new Error(
      `Claude backend profile "${runtimeProfile.id}" requires credential ${runtimeProfile.credential_ref}; ` +
      'agent must select that credential before comment mention dispatch',
    );
  }
  return { ...extras, cli_runtime_profile: runtimeProfile };
}

/**
 * A mention target that can actually be woken: the ticket's assignee. Other
 * agents are not attached to a ticket anymore (no roles), so there is no
 * RuntimeSpec to dispatch them with — the caller skips them (the mention still
 * shows in the comment).
 */
export interface MentionTarget {
  agentId: string;
  displayName: string;
  rolePrompt: string;
  extras: MentionDispatchExtras;
  runtime: RuntimeSpec | null;
}

export async function resolveMentionTarget(
  dataSource: DataSource,
  ticket: Pick<Ticket, 'id' | 'account_id' | 'assignee' | 'assignee_key'>,
  memberId: string,
): Promise<MentionTarget | null> {
  if (!isRuntimeIdentityKey(memberId) || memberId !== ticket.assignee_key) return null;
  const spec = parseRuntimeSpec(ticket.assignee);
  if (!spec) return null;
  const extras = await resolveMentionDispatchExtras(dataSource, ticket, {
    type: spec.cli,
    cli_runtime_profile: spec.cli_runtime_profile ?? null,
    credential_id: spec.credential_id ?? null,
  });
  return {
    agentId: memberId,
    displayName: (spec.label || '').trim() || memberId.slice(0, 11),
    rolePrompt: spec.role_prompt || '',
    extras,
    runtime: { ...spec },
  };
}
