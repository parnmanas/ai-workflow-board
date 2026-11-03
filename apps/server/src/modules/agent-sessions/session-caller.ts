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
  hostId: string;
  /** Account 소유자 — 세션 RPC 를 그 사람으로 보낸다(화면과 같은 driver). */
  owner: User;
}

/**
 * MCP 네이티브 세션 도구(open_session · list_* · get_session_info)의 호출자 확인. 화면의 세션 표면과 같은 경계다:
 * DB 의 full-scope Host 키(runtime 키 제외), 그 Host 의 **현재** 소유 Account, 소유자의 `agent_sessions.use`.
 * 호출 때마다 다시 읽는다 — Host 가 다른 Account 로 옮겨졌거나 소유자 권한이 빠졌으면 그 즉시 거절한다.
 */
export async function resolveSessionCaller(dataSource: DataSource, caller: McpAgentContext | undefined): Promise<SessionCaller> {
  const gate = await requireFullScopeCaller(dataSource, caller);
  if (gate) throw new AgentSessionError(403, 'unauthorized', gate);
  if (!caller?.accountId || !caller.agentId || caller.runtimeKey) {
    throw new AgentSessionError(403, 'host_key_required', 'A full-scope Host MCP key is required; runtime keys cannot use native sessions.');
  }
  // A session's cached account must still agree with the Host's CURRENT owner.
  const source = await dataSource.getRepository(RuntimeHost).findOne({ where: { id: caller.agentId, account_id: caller.accountId, is_active: 1 } });
  if (!source) throw new AgentSessionError(403, 'account_access_denied');
  const account = await dataSource.getRepository(Account).findOne({ where: { id: caller.accountId } });
  const owner = account?.owner_user_id
    ? await dataSource.getRepository(User).findOne({ where: { id: account.owner_user_id } }) : null;
  if (!owner || owner.status !== 'active') throw new AgentSessionError(403, 'account_owner_required');
  let permissions: string[] = [];
  try {
    const parsed = JSON.parse(owner.permissions);
    if (Array.isArray(parsed)) permissions = parsed.filter((p): p is string => typeof p === 'string');
  } catch { /* Invalid permission data grants nothing. */ }
  if (!hasPermission(owner.role, permissions, PERMISSIONS.USE_AGENT_SESSIONS)) {
    throw new AgentSessionError(403, 'session_permission_required', 'The account owner needs agent_sessions.use permission.');
  }
  return { accountId: caller.accountId, hostId: source.id, owner };
}
