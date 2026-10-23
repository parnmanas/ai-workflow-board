import { ForbiddenException, HttpException } from '@nestjs/common';
import type { DataSource } from 'typeorm';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { Account } from '../../../entities/Account';
import { User } from '../../../entities/User';
import { hasPermission, PERMISSIONS } from '../../../common/types/permissions';
import { getCallerAgent } from './session-auth';
import { resolveCallerAccountId, resolveCallerIdentityRow } from './authz';
import { err, ok } from './helpers';

/** Every entry point checks current ownership, even when a long-lived session predates a Host move. */
export async function businessAccess(ds: DataSource, extra: { sessionId?: string }, write: boolean) {
  const caller = getCallerAgent(extra);
  if (!caller || caller.source !== 'db' || !['read', 'write', 'full'].includes(caller.scope || '') || (write && caller.scope !== 'full')) {
    throw new ForbiddenException(write ? 'Business writes require a DB-backed full-scope MCP key.' : 'Business tools require a DB-backed MCP key.');
  }
  const identity = await resolveCallerIdentityRow(ds, caller.agentId);
  const accountId = await resolveCallerAccountId(ds, caller);
  if (!accountId || !identity || identity.account_id !== accountId) throw new ForbiddenException('The active Runtime Host must belong to the caller account.');
  const account = await ds.getRepository(Account).findOneBy({ id: accountId });
  const owner = account?.owner_user_id ? await ds.getRepository(User).findOneBy({ id: account.owner_user_id }) : null;
  const permissions = owner ? JSON.parse(owner.permissions || '[]') : [];
  if (!owner || owner.status !== 'active' || !hasPermission(owner.role, permissions, PERMISSIONS.MANAGE_BUSINESS)) throw new ForbiddenException('The active account owner needs business.manage permission.');
  const can = (permission: string) => hasPermission(owner.role, permissions, permission);
  return { accountId, ownerId: owner.id, actor: `mcp:${caller.runtimeKey || caller.agentId}`, can,
    marketing: can(PERMISSIONS.MANAGE_MARKETING) || can(PERMISSIONS.APPROVE_MARKETING_SPEND),
    ticketActor: { id: caller.runtimeKey || caller.agentId!, name: caller.agentName || identity.name, type: 'agent' as const } };
}
export type BusinessAccess = Awaited<ReturnType<typeof businessAccess>>;

/** Keep SQL errors, OAuth tokens and provider response bodies out of MCP results. */
export async function businessCall<T>(ds: DataSource, extra: { sessionId?: string }, write: boolean, work: (access: BusinessAccess) => Promise<T>, format: (value: T) => CallToolResult = ok) {
  try { return format(await work(await businessAccess(ds, extra, write))); }
  catch (error) {
    const status = error instanceof HttpException ? error.getStatus() : 500;
    return err(status < 500 && error instanceof Error ? error.message : 'Business operation failed. Existing records are preserved; inspect their status before retrying.', { status });
  }
}
