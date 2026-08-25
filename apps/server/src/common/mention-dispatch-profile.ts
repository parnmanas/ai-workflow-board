import { DataSource } from 'typeorm';
import { Ticket } from '../entities/Ticket';
import { Agent } from '../entities/Agent';
import { BoardColumn } from '../entities/BoardColumn';
import { Board } from '../entities/Board';
import { Workspace } from '../entities/Workspace';
import { appendBoardLanguageInstruction, resolveHarnessConfig, HarnessConfig } from './harness-config';
import { resolveEffortPreset, ResolvedEffortPreset } from './effort-presets';
import { CliRuntimeProfile } from './cli-runtime-profiles';
import { resolveClaudeBackendProfileForDispatch } from './claude-backend-registry';
import { mergeEnvironmentConfig, resolveEnvironmentConfig, ResolvedEnvironmentConfig } from './environment-config';
import { resolveBoardWorktreeMode, DEFAULT_WORKTREE_MODE, WorktreeMode } from './worktree-config';

export interface MentionDispatchExtras {
  harness_config: HarnessConfig | null;
  effort_preset: ResolvedEffortPreset | null;
  cli_runtime_profile: CliRuntimeProfile | null;
  environment_config: ResolvedEnvironmentConfig | null;
  worktree_mode: WorktreeMode;
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
  agent: Pick<Agent, 'type' | 'cli_runtime_profile' | 'credential_id'>,
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

  if (agent.type !== 'claude') return extras;

  let runtimeProfile: CliRuntimeProfile | null;
  try {
    const runtimeBoard = await resolveBoardForColumn(dataSource, ticket.column_id);
    const runtimeWorkspace = ticket.workspace_id
      ? await dataSource.getRepository(Workspace).findOne({ where: { id: ticket.workspace_id } })
      : null;
    runtimeProfile = await resolveClaudeBackendProfileForDispatch(dataSource, runtimeWorkspace, [
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

async function resolveBoardForColumn(
  dataSource: DataSource,
  columnId: string | null | undefined,
): Promise<Board | null> {
  if (!columnId) return null;
  const col = await dataSource.getRepository(BoardColumn).findOne({ where: { id: columnId } });
  if (!col?.board_id) return null;
  return dataSource.getRepository(Board).findOne({ where: { id: col.board_id } });
}
