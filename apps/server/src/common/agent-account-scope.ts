import { IsNull, type FindOperator } from 'typeorm';

export type AgentAccountId = string | null | undefined;
export type AgentAccountWhere = {
  account_id: string | FindOperator<string>;
};

/** Normalize every explicit global representation to the database invariant. */
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
  return agentAccount === null || agentAccount === target;
}

/** TypeORM OR branches for account-local plus global Agent discovery. */
export function agentAccountWhere(accountId: string): AgentAccountWhere[] {
  const target = accountId.trim();
  if (!target) return [];
  return [
    { account_id: target },
    { account_id: '' },
    { account_id: IsNull() },
  ];
}
