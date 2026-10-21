/**
 * Skill 배정 대상 — docs/skills.md "배정 범위".
 *
 * 배정은 (account, 대상, skill) 하나에 버전 하나를 핀한다. 대상은 세 가지다:
 *   - 공용(account)  — 그 계정의 모든 Agent
 *   - 프로젝트       — 그 프로젝트의 작업(티켓·미션 step)을 하는 Agent
 *   - 실행(runtime)  — 한 실행 신원(`runtimeIdentityKey`, cli + 폴더 + credential)
 *
 * 저장은 `RuntimeSkillAssignment.runtime_key` 한 칸에 인코딩한다 — 실행 신원은 `rt-<hex>` 라서
 * `*` / `project:<id>` 와 겹치지 않고, 기존 유일 인덱스 (account, runtime_key, skill)가 그대로
 * "대상마다 skill 하나" 를 지킨다(스키마 변경 없이 기존 배정이 전부 실행 범위로 읽힌다).
 *
 * 한 실행에 같은 skill 이 여러 범위로 배정돼 있으면 **좁은 범위가 이긴다**: 실행 > 프로젝트 > 공용.
 */

export type SkillAssignmentScope = 'account' | 'project' | 'runtime';

export const ACCOUNT_TARGET_KEY = '*';
const PROJECT_PREFIX = 'project:';

export function projectTargetKey(projectId: string): string {
  return `${PROJECT_PREFIX}${projectId}`;
}

export function parseAssignmentTarget(runtimeKey: string | null | undefined): { scope: SkillAssignmentScope; project_id: string | null; runtime_key: string | null } {
  const key = typeof runtimeKey === 'string' ? runtimeKey : '';
  if (key === ACCOUNT_TARGET_KEY) return { scope: 'account', project_id: null, runtime_key: null };
  if (key.startsWith(PROJECT_PREFIX)) return { scope: 'project', project_id: key.slice(PROJECT_PREFIX.length), runtime_key: null };
  return { scope: 'runtime', project_id: null, runtime_key: key || null };
}

const SCOPE_RANK: Record<SkillAssignmentScope, number> = { account: 0, project: 1, runtime: 2 };

/** 이 실행에 해당하는 대상 키들(넓은 것부터). */
export function targetKeysFor(args: { runtimeKey?: string | null; projectId?: string | null }): string[] {
  const keys = [ACCOUNT_TARGET_KEY];
  if (args.projectId) keys.push(projectTargetKey(args.projectId));
  if (args.runtimeKey) keys.push(args.runtimeKey);
  return keys;
}

/** skill 마다 가장 좁은 범위의 배정 하나만 남긴다. */
export function pickNarrowest<T extends { runtime_key: string; skill_id: string; skill_version_id: string }>(rows: readonly T[]): Array<T & { scope: SkillAssignmentScope }> {
  const best = new Map<string, T & { scope: SkillAssignmentScope }>();
  for (const row of rows) {
    const scope = parseAssignmentTarget(row.runtime_key).scope;
    // skill_id 가 없는 행(예전 모양)은 버전 단위로 둔다 — 서로 다른 skill 을 하나로 접지 않게.
    const key = row.skill_id || `version:${row.skill_version_id}`;
    const current = best.get(key);
    if (!current || SCOPE_RANK[scope] > SCOPE_RANK[current.scope]) best.set(key, { ...row, scope });
  }
  return Array.from(best.values());
}
