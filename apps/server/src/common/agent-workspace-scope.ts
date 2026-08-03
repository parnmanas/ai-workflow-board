import { IsNull, type FindOperator } from 'typeorm';

export type AgentWorkspaceId = string | null | undefined;
export type AgentWorkspaceWhere = {
  workspace_id: string | FindOperator<string>;
};

/** Normalize every explicit global representation to the database invariant. */
export function normalizeAgentWorkspaceId(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/** True when an Agent can be referenced by an artifact in targetWorkspaceId. */
export function agentIsVisibleInWorkspace(
  agentWorkspaceId: AgentWorkspaceId,
  targetWorkspaceId: string,
): boolean {
  const target = targetWorkspaceId.trim();
  if (!target) return false;
  const agentWorkspace = normalizeAgentWorkspaceId(agentWorkspaceId);
  return agentWorkspace === null || agentWorkspace === target;
}

/** TypeORM OR branches for workspace-local plus global Agent discovery. */
export function agentWorkspaceWhere(workspaceId: string): AgentWorkspaceWhere[] {
  const target = workspaceId.trim();
  if (!target) return [];
  return [
    { workspace_id: target },
    { workspace_id: '' },
    { workspace_id: IsNull() },
  ];
}
