import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { Account } from '../../entities/Account';
import { RuntimeHost } from '../../entities/RuntimeHost';
import { User } from '../../entities/User';
import { hasPermission, PERMISSIONS } from '../../common/types/permissions';
import { requireFullScopeCaller } from '../mcp/shared/authz';
import type { McpAgentContext } from '../mcp/shared/session-auth';
import { AgentSessionError, AgentSessionsService } from './agent-sessions.service';

export interface SessionOpenInput {
  manager_id?: string;
  cli: string;
  session_id?: string;
  cwd?: string;
  title?: string;
}

/** MCP opens use the same owner, launch settings and native RPC as the web UI. */
@Injectable()
export class SessionOpenService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly sessions: AgentSessionsService,
  ) {}

  async open(caller: McpAgentContext | undefined, input: SessionOpenInput) {
    const gate = await requireFullScopeCaller(this.dataSource, caller);
    if (gate) throw new AgentSessionError(403, 'unauthorized', gate);
    if (!caller?.accountId || !caller.agentId || caller.runtimeKey) {
      throw new AgentSessionError(403, 'host_key_required', 'A full-scope Host MCP key is required; runtime keys cannot open native sessions.');
    }
    // A session's cached account must still agree with the Host's CURRENT owner.
    const hosts = this.dataSource.getRepository(RuntimeHost);
    const source = await hosts.findOne({ where: { id: caller.agentId, account_id: caller.accountId, is_active: 1 } });
    if (!source) throw new AgentSessionError(403, 'account_access_denied');
    const managerId = input.manager_id || source.id;
    const target = await hosts.findOne({ where: { id: managerId, account_id: caller.accountId, is_active: 1 } });
    if (!target) throw new AgentSessionError(403, 'account_access_denied');
    const account = await this.dataSource.getRepository(Account).findOne({ where: { id: caller.accountId } });
    const owner = account?.owner_user_id
      ? await this.dataSource.getRepository(User).findOne({ where: { id: account.owner_user_id } }) : null;
    if (!owner || owner.status !== 'active') throw new AgentSessionError(403, 'account_owner_required');
    let permissions: string[] = [];
    try {
      const parsed = JSON.parse(owner.permissions);
      if (Array.isArray(parsed)) permissions = parsed.filter((p): p is string => typeof p === 'string');
    } catch { /* Invalid permission data grants nothing. */ }
    if (!hasPermission(owner.role, permissions, PERMISSIONS.USE_AGENT_SESSIONS)) {
      throw new AgentSessionError(403, 'session_permission_required', 'The account owner needs agent_sessions.use permission.');
    }
    if (input.session_id) {
      const live = this.sessions.liveSnapshot(managerId, input.cli, input.session_id);
      if (live?.driver_user_id && live.driver_user_id !== owner.id) throw new AgentSessionError(403, 'session_driver_mismatch');
    }
    // Deliberately project the accepted fields: MCP cannot force-kill another CLI,
    // override permission mode, change credentials, or inject a user-approved prompt.
    const live = await this.sessions.openSession(caller.accountId, owner.id, managerId, input.cli, {
      session_id: input.session_id, cwd: input.cwd, title: input.title,
    });
    return {
      manager_id: live.manager_id, cli: live.cli, session_id: live.session_id,
      status: live.status, cwd: live.cwd, title: live.title,
      path: `/sessions/${encodeURIComponent(live.manager_id)}/${encodeURIComponent(live.cli)}/${encodeURIComponent(live.session_id)}`,
    };
  }
}
