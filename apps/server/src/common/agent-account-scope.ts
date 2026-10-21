import type { FindOperator } from 'typeorm';

export type AgentAccountId = string | null | undefined;
export type AgentAccountWhere = {
  account_id: string | FindOperator<string>;
};

/** Normalize an execution owner's id. A missing owner grants no access. */
export function normalizeAgentAccountId(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/** True when an Agent can be referenced by an artifact in targetAccountId. */
export function agentIsVisibleInAccount(
  agentAccountId: AgentAccountId,
  targetAccountId: string,
): boolean {
  const target = targetAccountId.trim();
  if (!target) return false;
  const agentAccount = normalizeAgentAccountId(agentAccountId);
  return agentAccount === target;
}

/** Runtime identities are local to their owning account. */
export function agentAccountWhere(accountId: string): AgentAccountWhere[] {
  const target = accountId.trim();
  if (!target) return [];
  return [{ account_id: target }];
}
