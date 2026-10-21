import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { IsNull, type FindOptionsWhere } from 'typeorm';
import { z } from 'zod';
import { Credential } from '../../../entities/Credential';
import { agentEnvNames } from '../../../common/credential-agent-env';
import { catalogScopeOf } from '../../../common/catalog-scope';
import { decryptStrict } from '../../../services/encryption.service';
import { callerCanAccessAccount, resolveCallerAccountId, resolveCallerIdentityRow } from '../shared/authz';
import { getCallerAgent } from '../shared/session-auth';
import { ok, err } from '../shared/helpers';
import type { ToolContext } from './context';

// Never serialize the entity or a masked secret: even a masked field can
// reveal short credentials. Decrypt only to report storage health/env names.
function credentialMetadata(row: Credential) {
  let status: 'ok' | 'empty' | 'unreadable' = 'unreadable';
  let fieldNames: string[] = [];
  try {
    const fields: unknown = JSON.parse(decryptStrict(row.encrypted_data));
    if (fields && typeof fields === 'object' && !Array.isArray(fields)) {
      fieldNames = Object.entries(fields).filter(([, value]) => typeof value === 'string' && value.trim() !== '').map(([key]) => key);
      status = fieldNames.length ? 'ok' : 'empty';
    }
  } catch { /* Corrupt payloads remain discoverable without leaking errors or values. */ }
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    provider: row.provider,
    account_id: row.account_id,
    scope: catalogScopeOf(row),
    credential_status: status,
    agent_env: row.agent_env,
    env_prefix: row.env_prefix,
    agent_env_names: row.agent_env ? agentEnvNames(row.provider, row.env_prefix, fieldNames) : [],
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function registerCredentialTools(server: McpServer, ctx: ToolContext): void {
  const { dataSource } = ctx;

  async function access(extra: { sessionId?: string }) {
    const caller = getCallerAgent(extra);
    if (!caller || caller.source !== 'db' || !['read', 'write', 'full'].includes(caller.scope || '')
      || !(await resolveCallerIdentityRow(dataSource, caller.agentId))) return null;
    const accountId = await resolveCallerAccountId(dataSource, caller);
    return accountId ? { caller: { ...caller, accountId }, accountId } : null;
  }

  server.tool(
    'list_credentials',
    'List credential metadata and IDs for GitHub/project/runtime credential_id references. DB-backed callers may read their own account and inherited globals. Credentials are managed in Settings > Credentials. No secret values. credential_status describes stored data, not provider validity.',
    {
      account_id: z.string().min(1).optional().describe('Filter to an accessible account plus globals; defaults to all caller-accessible credentials'),
      provider: z.string().min(1).optional(),
      scope: z.enum(['global', 'account']).optional(),
      limit: z.number().int().min(1).max(100).default(50),
      offset: z.number().int().min(0).default(0),
    },
    async ({ account_id, provider, scope, limit, offset }, extra) => {
      const allowed = await access(extra);
      if (!allowed) return err('Unauthorized: credential metadata requires a DB-backed caller with account access');
      if (account_id && !(await callerCanAccessAccount(dataSource, allowed.caller, account_id))) {
        return err('Unauthorized: caller does not belong to this account');
      }
      const accountId = allowed.accountId;
      const filter: FindOptionsWhere<Credential> = provider ? { provider } : {};
      const where: FindOptionsWhere<Credential>[] = scope === 'global'
        ? [{ ...filter, account_id: IsNull() }]
        : [{ ...filter, account_id: accountId }, ...(scope === 'account' ? [] : [{ ...filter, account_id: IsNull() }])];
      const [rows, total] = await dataSource.getRepository(Credential).findAndCount({ where, order: { name: 'ASC', id: 'ASC' }, take: limit, skip: offset });
      return ok({ credentials: rows.map(credentialMetadata), total, limit, offset });
    },
  );

  server.tool(
    'get_credential',
    'Get credential metadata by ID, including provider, owner, storage status and exposed environment variable names. Same DB-backed account/global access as list_credentials. Never returns tokens, passwords or encrypted data. Manage credentials in Settings > Credentials; status does not verify provider authentication.',
    { credential_id: z.string().uuid() },
    async ({ credential_id }, extra) => {
      const allowed = await access(extra);
      if (!allowed) return err('Unauthorized: credential metadata requires a DB-backed caller with account access');
      const row = await dataSource.getRepository(Credential).findOne({ where: { id: credential_id } });
      if (!row || (row.account_id !== null && !(await callerCanAccessAccount(dataSource, allowed.caller, row.account_id)))) {
        return err('Credential not found');
      }
      return ok(credentialMetadata(row));
    },
  );
}
