import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { RuntimeHost } from '../../entities/RuntimeHost';
import type { McpAgentContext } from '../mcp/shared/session-auth';
import { AgentSessionError, AgentSessionsService } from './agent-sessions.service';
import { resolveSessionCaller } from './session-caller';

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
    const { accountId, hostId, owner } = await resolveSessionCaller(this.dataSource, caller);
    const managerId = input.manager_id || hostId;
    const target = await this.dataSource.getRepository(RuntimeHost).findOne({ where: { id: managerId, account_id: accountId, is_active: 1 } });
    if (!target) throw new AgentSessionError(403, 'account_access_denied');
    if (input.session_id) {
      const live = this.sessions.liveSnapshot(managerId, input.cli, input.session_id);
      if (live?.driver_user_id && live.driver_user_id !== owner.id) throw new AgentSessionError(403, 'session_driver_mismatch');
    }
    // Deliberately project the accepted fields: MCP cannot force-kill another CLI,
    // override permission mode, change credentials, or inject a user-approved prompt.
    const live = await this.sessions.openSession(accountId, owner.id, managerId, input.cli, {
      session_id: input.session_id, cwd: input.cwd, title: input.title,
    });
    return {
      manager_id: live.manager_id, cli: live.cli, session_id: live.session_id,
      status: live.status, cwd: live.cwd, title: live.title,
      path: `/sessions/${encodeURIComponent(live.manager_id)}/${encodeURIComponent(live.cli)}/${encodeURIComponent(live.session_id)}`,
    };
  }
}
