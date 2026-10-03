// RuntimeSpec 클라이언트 헬퍼 — P3b. 서버 `common/runtime-spec.ts` 의 읽기 전용
// 미러다 (검증의 정본은 서버 `POST /api/runtime-specs/validate`). React 의존성
// 없음 — `test/runtime-spec.test.mjs` 가 직접 import 한다.

export interface RuntimeSpecDraft {
  manager_agent_id: string;
  cli: string;
  model: string | null;
  working_dir: string;
  folder_scope: 'shared' | 'isolated';
  credential_id: string | null;
  cli_runtime_profile: string | null;
  runtime_config: Record<string, any>;
  label: string;
  role_prompt: string;
}

export function emptyRuntimeSpec(): RuntimeSpecDraft {
  return {
    manager_agent_id: '',
    cli: '',
    model: null,
    working_dir: '',
    folder_scope: 'shared',
    credential_id: null,
    cli_runtime_profile: null,
    runtime_config: { strategy: 'single', permission_mode: 'approve' },
    label: '',
    role_prompt: '',
  };
}

/** 에디터 저장 가능 판정 — 서버 normalize와 같은 필수 3키. */
export function isRuntimeSpecComplete(spec: Partial<RuntimeSpecDraft>): boolean {
  const host = (spec.manager_agent_id || '').trim();
  const cli = (spec.cli || '').trim();
  const dir = (spec.working_dir || '').trim();
  if (!host || !cli || !dir) return false;
  return isAbsoluteHostPath(dir);
}

/** Windows (`C:\…`, `\\host\share`) + POSIX (`/…`) 절대 경로. 서버 판정과 동일. */
export function isAbsoluteHostPath(path: string): boolean {
  return path.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(path) || path.startsWith('\\\\');
}

/** 마지막 경로 조각 — label 폴백용. */
export function workingDirLeaf(workingDir: string): string {
  const parts = workingDir.split(/[/\\]+/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : workingDir;
}

/** 한 줄 요약 — picker 뱃지/토스트용. */
export function specSummary(spec: Partial<RuntimeSpecDraft>, hostName?: string): string {
  const host = hostName || (spec.manager_agent_id || '').slice(0, 8) || '?';
  const cli = (spec.cli || '?').trim() || '?';
  const model = (spec.model || '').trim();
  const leaf = workingDirLeaf((spec.working_dir || '').trim());
  return `${host}/${cli}${model ? `:${model}` : ''}${leaf ? ` @${leaf}` : ''}`;
}

/**
 * 선언된 spec에 정확히 일치하는 기존 Agent 행 찾기 (P4 전환 전까지의 과도기
 * 매칭 — Host+CLI+model+dir+credential 5키 일치). 찾으면 그 id를 쓰고,
 * 없으면 호출자가 createAgent로 만든다. 순서 보장 없음 — 첫 일치 반환.
 */
export function matchAgentForSpec(
  agents: Array<{ id: string; manager_agent_id?: string | null; type?: string; model?: string | null; working_dir?: string; credential_id?: string | null }>,
  spec: Pick<RuntimeSpecDraft, 'manager_agent_id' | 'cli' | 'model' | 'working_dir' | 'credential_id'>,
): string | null {
  const norm = (v: string | null | undefined) => (v || '').trim();
  for (const a of agents) {
    if (norm(a.manager_agent_id) !== norm(spec.manager_agent_id)) continue;
    if (norm(a.type).toLowerCase() !== norm(spec.cli).toLowerCase()) continue;
    if (norm(a.model) !== norm(spec.model)) continue;
    if (norm(a.working_dir) !== norm(spec.working_dir)) continue;
    if (norm(a.credential_id) !== norm(spec.credential_id)) continue;
    return a.id;
  }
  return null;
}
