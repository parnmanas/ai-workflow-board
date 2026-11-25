import { DataSource } from 'typeorm';
import { Account } from '../../entities/Account';
import { RuntimeHost } from '../../entities/RuntimeHost';
import { User } from '../../entities/User';
import { hasPermission, PERMISSIONS } from '../../common/types/permissions';
import { requireFullScopeCaller } from '../mcp/shared/authz';
import type { McpAgentContext } from '../mcp/shared/session-auth';
import { AgentSessionError } from './agent-sessions.service';

export interface SessionCaller {
  accountId: string;
  /** 호출자의 Host — `manager_id` 를 생략한 도구의 기본 Host. */
  hostId?: string;
  /** Account 소유자 — 세션 RPC 를 그 사람으로 보낸다(화면과 같은 driver). */
  owner: User;
}

/**
 * MCP 네이티브 세션 도구(open_session · list_* · get_session_info)의 호출자 확인. 화면의 세션 표면과 같은 경계다:
 * Host 키는 현재 Host 소유권을, 앱은 동의한 사용자와 계정을 확인한다. 두 경로 모두 소유자의 `agent_sessions.use`가 필요하다.
 * 호출 때마다 다시 읽는다 — Host 가 다른 Account 로 옮겨졌거나 소유자 권한이 빠졌으면 그 즉시 거절한다.
 */
export async function resolveSessionCaller(dataSource: DataSource, caller: McpAgentContext | undefined): Promise<SessionCaller> {
  if (caller?.source === 'oauth') {
    if (caller.scope !== 'full' || !caller.userId || !caller.accountId) throw new AgentSessionError(403, 'account_access_denied');
  } else {
    const gate = await requireFullScopeCaller(dataSource, caller);
    if (gate) throw new AgentSessionError(403, 'unauthorized', gate);
    if (!caller?.agentId || !caller.accountId || caller.runtimeKey) throw new AgentSessionError(403, 'host_key_required', 'A Host MCP key is required for native sessions.');
    const source = await dataSource.getRepository(RuntimeHost).findOneBy({ id: caller.agentId, account_id: caller.accountId, is_active: 1 });
    if (!source) throw new AgentSessionError(403, 'account_access_denied');
  }
  const account = await dataSource.getRepository(Account).findOne({ where: { id: caller.accountId } });
  const owner = account?.owner_user_id
    ? await dataSource.getRepository(User).findOne({ where: { id: account.owner_user_id } }) : null;
  if (!owner || owner.status !== 'active' || (caller.source === 'oauth' && owner.id !== caller.userId)) throw new AgentSessionError(403, 'account_owner_required');
  let permissions: string[] = [];
  try {
    const parsed = JSON.parse(owner.permissions);
    if (Array.isArray(parsed)) permissions = parsed.filter((p): p is string => typeof p === 'string');
  } catch { /* Invalid permission data grants nothing. */ }
  if (!hasPermission(owner.role, permissions, PERMISSIONS.USE_AGENT_SESSIONS)) {
    throw new AgentSessionError(403, 'session_permission_required', 'The account owner needs agent_sessions.use permission.');
  }
  return { accountId: caller.accountId, hostId: caller.source === 'oauth' ? undefined : caller.agentId, owner };
}
