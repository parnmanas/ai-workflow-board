import { api } from '../../api';
import { type RuntimeSpecDraft } from '../../runtime/runtimeSpec';

/**
 * Spec → 저장용 target 해석 (P4c-4).
 *
 * validate(서버 정규화) 후 정규화된 spec 을 그대로 돌려준다 — 호출 화면이
 * `target_runtime` 으로 저장하면 서버가 identity 키를 매긴다 (spec-direct,
 * Agent 행 없음). 매칭할 Agent 행이 없으므로 항상 created:true.
 */
export async function resolveSpecAgentId(
  workspaceId: string,
  spec: RuntimeSpecDraft,
  _fullAgents?: Array<any>,
): Promise<{ id: string; created: boolean; spec: Record<string, any> | null }> {
  const v = await api.validateRuntimeSpec(workspaceId || null, spec as any);
  if (!v?.ok || !v.spec) throw new Error(v?.error || 'Runtime spec validation failed');
  return { id: '', created: true, spec: v.spec };
}
