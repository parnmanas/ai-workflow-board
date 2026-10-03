import { DataSource } from 'typeorm';
import { Ticket } from '../entities/Ticket';
import { RuntimeHost } from '../entities/RuntimeHost';
import { ApiKey } from '../entities/ApiKey';
import { BoardColumn } from '../entities/BoardColumn';
import { Board } from '../entities/Board';
import { Workspace } from '../entities/Workspace';
import { appendBoardLanguageInstruction, resolveHarnessConfig, HarnessConfig } from './harness-config';
import { resolveEffortPreset, ResolvedEffortPreset } from './effort-presets';
import { cliDescriptor } from './cli-catalog';
import { CliRuntimeProfile } from './cli-runtime-profiles';
import { resolveClaudeBackendProfileForDispatch } from './claude-backend-registry';
import { mergeEnvironmentConfig, resolveEnvironmentConfig, ResolvedEnvironmentConfig } from './environment-config';
import { resolveBoardWorktreeMode, DEFAULT_WORKTREE_MODE, WorktreeMode } from './worktree-config';
import { holderAssigneeId, isRuntimeIdentityKey, type RuntimeSpec } from './runtime-spec';
import { isUuidShapedId } from '../utils/agent-name';
import { TicketRoleAssignment } from '../entities/TicketRoleAssignment';

export interface MentionDispatchExtras {
  harness_config: HarnessConfig | null;
  effort_preset: ResolvedEffortPreset | null;
  cli_runtime_profile: CliRuntimeProfile | null;
  environment_config: ResolvedEnvironmentConfig | null;
  worktree_mode: WorktreeMode;
}

/**
 * P4c-4: dispatch 부가값 계산에 필요한 최소 실행자 모양. Agent 행 대신
 * Host/spec pseudo 를 넘긴다 (type '' = 알 수 없음 → backend profile 미적용).
 */
export interface DispatchAgentLike {
  type: string | null;
  cli_runtime_profile: string | null;
  credential_id: string | null;
}

const EMPTY_EXTRAS: MentionDispatchExtras = {
  harness_config: null,
  effort_preset: null,
  cli_runtime_profile: null,
  environment_config: null,
  worktree_mode: DEFAULT_WORKTREE_MODE,
};

/**
 * 티켓 71532b4f — comment_mention dispatch(코멘트 @-멘션으로 깨우는 one-shot
 * subagent)용 harness / effort preset / Claude backend runtime profile /
 * environment env_vars / worktree mode를 계산한다. trigger-loop.service.ts의
 * 컬럼 트리거 해석과 동일한 ticket > agent > board 우선순위·동일한 공유 resolver
 * (resolveHarnessConfig/resolveEffortPreset/resolveClaudeBackendProfileForDispatch/
 * mergeEnvironmentConfig)를 재사용해, 같은 (agent, ticket)이 어느 dispatch 경로로
 * 깨든 같은 backend/harness/effort/env로 동작한다는 계약을 comment_mention에도
 * 확장한다. 이전에는 comment_mention이 이 값들을 전혀 계산하지 않아, agent에 명시
 * 핀된 cli_runtime_profile이 조용히 무시되고 순정 Claude로 돌았다.
 *
 * environment_config는 repositories 없이 env_vars만 채운다 — comment_mention은
 * 항상 agent-manager의 one-shot #subagentManager.spawn() 경로로만 나가고(영속
 * ticket 세션으로 forward되면 그 세션은 이미 컬럼 트리거로 원래 dispatch됐을 때
 * provisioning이 끝난 뒤라 새로 리졸브할 필요가 없다), 그 경로는 repositories를
 * 전혀 읽지 않는다(worktree 체크아웃은 WT/QA provisioning 전용). repoLookup을
 * 항상 null로 두면 resource_id 전용 repo 항목만 조용히 drop되고(부작용 없음),
 * workspace-scoped Resource 조회를 한 번 아낀다.
 *
 * harness/effort/environment 해석 실패는 기존 멘션 전달을 유지하도록 기본값으로
 * degrade한다. 반면 Claude runtime profile 해석과 credential 검증은 컬럼 트리거처럼
 * fail-closed다. 명시 프로파일 오류를 null로 바꾸면 기본 유료 backend로 조용히
 * 폴백하므로, 이 오류는 호출부까지 전파해 dispatch 자체를 중단해야 한다.
 *
 * 루트 티켓 컬럼 트리거만 다룬다(trigger-loop.service.ts와 동일 범위) — column_id가
 * 없는 서브태스크 코멘트 멘션은 board 카탈로그 없이 workspace 레벨로만 degrade한다.
 */
export async function resolveMentionDispatchExtras(
  dataSource: DataSource,
  ticket: Pick<Ticket, 'column_id' | 'workspace_id' | 'effort_preset' | 'cli_runtime_profile'>,
  agent: DispatchAgentLike,
): Promise<MentionDispatchExtras> {
  let extras = EMPTY_EXTRAS;
  try {
    const board = await resolveBoardForColumn(dataSource, ticket.column_id);
    const workspace = ticket.workspace_id
      ? await dataSource.getRepository(Workspace).findOne({ where: { id: ticket.workspace_id } })
      : null;

    let harnessConfig = resolveHarnessConfig(workspace?.harness_config, board?.harness_config);
    harnessConfig = appendBoardLanguageInstruction(harnessConfig, board?.language);
    const effortPreset = resolveEffortPreset(board?.effort_presets, ticket.effort_preset);
    const worktreeMode = resolveBoardWorktreeMode(board?.worktree_mode);
    const mergedEnv = mergeEnvironmentConfig(workspace?.environment_config, board?.environment_config);
    const environmentConfig = resolveEnvironmentConfig(mergedEnv, () => null);

    extras = {
      harness_config: harnessConfig,
      effort_preset: effortPreset,
      cli_runtime_profile: null,
      environment_config: environmentConfig,
      worktree_mode: worktreeMode,
    };
  } catch {
    // 비-runtime 부가 설정은 best-effort다. runtime profile은 아래에서 별도로
    // 다시 조회하므로 이 catch가 명시 프로파일 오류를 삼키지 않는다.
  }

  if (!cliDescriptor(agent.type)?.sessions.backend_profile) return extras;

  let runtimeProfile: CliRuntimeProfile | null;
  try {
    const runtimeBoard = await resolveBoardForColumn(dataSource, ticket.column_id);
    runtimeProfile = await resolveClaudeBackendProfileForDispatch(dataSource, [
      { source: 'run', value: ticket.cli_runtime_profile },
      { source: 'agent', value: agent.cli_runtime_profile },
      { source: 'board', value: runtimeBoard?.cli_runtime_profile },
    ]);
  } catch (error) {
    console.warn('[MentionDispatch] Claude runtime profile 해석 실패 — comment_mention dispatch를 중단합니다.', {
      workspace_id: ticket.workspace_id,
      error: String(error),
    });
    throw error;
  }
  if (runtimeProfile?.credential_required && runtimeProfile.credential_ref !== agent.credential_id) {
    const error = new Error(
      `Claude backend profile "${runtimeProfile.id}" requires credential ${runtimeProfile.credential_ref}; ` +
      'agent must select that credential before comment mention dispatch',
    );
    console.warn('[MentionDispatch] Claude runtime profile credential 불일치 — comment_mention dispatch를 중단합니다.', {
      workspace_id: ticket.workspace_id,
      profile_id: runtimeProfile.id,
    });
    throw error;
  }
  return { ...extras, cli_runtime_profile: runtimeProfile };
}

/**
 * P4c-4: mention 대상 해소 (uuid Agent 행 / rt- spec-direct 공통).
 * 반환이 null이면 호출자는 조용히 skip한다 (기존 `if (!agent) continue`와 동일).
 * rt 대상은 ticket assignment 행의 스냅샷에서 해소되며, extras 계산에는
 * spec 값을 pseudo-agent 형태로 넘긴다 (같은 ticket > agent > board 우선순위).
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
  ticket: Pick<Ticket, 'id' | 'column_id' | 'workspace_id' | 'effort_preset' | 'cli_runtime_profile'> & { id: string },
  memberId: string,
): Promise<MentionTarget | null> {
  if (isUuidShapedId(memberId)) {
    // P4c-4: Agent 행 없음 — Host 직접 조회 후 api_keys 페어링 링크.
    const host = await dataSource.getRepository(RuntimeHost).findOne({ where: { id: memberId } });
    let displayName: string | null = host?.name ?? null;
    if (!displayName) {
      const link = await dataSource.getRepository(ApiKey).findOne({
        where: { agent_id: memberId },
        select: { agent_id: true, host_id: true },
      });
      if (link?.host_id) {
        const linked = await dataSource.getRepository(RuntimeHost).findOne({ where: { id: link.host_id } });
        displayName = linked?.name ?? null;
      }
    }
    if (!displayName) return null;
    // P2 시절 agent 홀더 스냅샷이 assignment 행에 남아 있으면 실행 정체성으로
    // 쓴다 (테이블은 다르므로 drop 후에도 살아 있다).
    const holderRows = await dataSource.getRepository(TicketRoleAssignment).find({
      where: { ticket_id: ticket.id },
    });
    const holderRow = holderRows.find((r) => r.agent_id === memberId) ?? null;
    const holderSpec = (holderRow?.runtime_spec ?? null) as RuntimeSpec | null;
    const runtime = holderSpec && typeof holderSpec === 'object' ? { ...holderSpec } : null;
    const extras = await resolveMentionDispatchExtras(dataSource, ticket, runtime
      ? {
        type: (runtime as any).cli ?? '',
        cli_runtime_profile: (runtime as any).cli_runtime_profile ?? null,
        credential_id: (runtime as any).credential_id ?? null,
      }
      : {
        type: '',
        cli_runtime_profile: null,
        credential_id: null,
      });
    return {
      agentId: memberId,
      displayName,
      rolePrompt: (runtime as any)?.role_prompt || '',
      extras,
      runtime,
    };
  }
  if (!isRuntimeIdentityKey(memberId)) return null;
  const rows = await dataSource.getRepository(TicketRoleAssignment).find({ where: { ticket_id: ticket.id } });
  const row = rows.find((r) => holderAssigneeId(r) === memberId) ?? null;
  const spec = (row?.runtime_spec ?? null) as RuntimeSpec | null;
  if (!spec || typeof spec !== 'object') return null;
  const extras = await resolveMentionDispatchExtras(dataSource, ticket, {
    type: spec.cli,
    cli_runtime_profile: spec.cli_runtime_profile ?? null,
    credential_id: spec.credential_id ?? null,
  });
  const id: string = memberId;
  return {
    agentId: id,
    displayName: (spec.label || '').trim() || id.slice(0, 11),
    rolePrompt: spec.role_prompt || '',
    extras,
    runtime: { ...spec },
  };
}

async function resolveBoardForColumn(
  dataSource: DataSource,
  columnId: string | null | undefined,
): Promise<Board | null> {
  if (!columnId) return null;
  const col = await dataSource.getRepository(BoardColumn).findOne({ where: { id: columnId } });
  if (!col?.board_id) return null;
  return dataSource.getRepository(Board).findOne({ where: { id: col.board_id } });
}
