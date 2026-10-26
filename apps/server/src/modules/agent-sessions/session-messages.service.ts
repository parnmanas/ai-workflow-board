import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { Account } from '../../entities/Account';
import { AgentSessionExecution } from '../../entities/AgentSessionExecution';
import { RuntimeHost } from '../../entities/RuntimeHost';
import { AgentConnectivityRegistry } from '../../services/agent-connectivity.registry';
import { LogService } from '../../services/log.service';
import { requireFullScopeCaller } from '../mcp/shared/authz';
import type { McpAgentContext } from '../mcp/shared/session-auth';
import { cachedOperators } from '../voice/operator-config';
import { OperatorReportService } from '../voice/operator-report.service';
import { AgentSessionError, AgentSessionsService } from './agent-sessions.service';

export const SESSION_MESSAGE_MAX_CHARS = 20_000;
const CHAIN_DEPTH_CAP = 3;

interface SessionAddress {
  manager_id: string;
  cli: string;
  session_id: string;
}

export interface SessionMessageInput {
  session_id: string;
  content: string;
  manager_id?: string;
  cli?: string;
}

function address(row: SessionAddress): SessionAddress {
  return { manager_id: row.manager_id, cli: row.cli, session_id: row.session_id };
}

function sameSession(a: SessionAddress, b: SessionAddress): boolean {
  return a.manager_id === b.manager_id && a.cli === b.cli && a.session_id === b.session_id;
}

/** Direct messages reuse the native session prompt/steering path and its transcript. */
@Injectable()
export class SessionMessagesService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly sessions: AgentSessionsService,
    private readonly reports: OperatorReportService,
    private readonly connectivity: AgentConnectivityRegistry,
    private readonly logService: LogService,
  ) {}

  private async resolve(accountId: string, ref: Partial<SessionAddress> & { session_id: string }): Promise<AgentSessionExecution> {
    // Both the pinned execution and the Host's CURRENT ownership must match.
    const query = this.dataSource.getRepository(AgentSessionExecution).createQueryBuilder('execution')
      .innerJoin(RuntimeHost, 'host', 'CAST(host.id AS varchar) = execution.manager_id AND host.account_id = execution.account_id AND host.is_active = 1')
      .where('execution.account_id = :accountId AND execution.session_id = :sessionId', { accountId, sessionId: ref.session_id });
    if (ref.manager_id) query.andWhere('execution.manager_id = :managerId', { managerId: ref.manager_id });
    if (ref.cli) query.andWhere('execution.cli = :cli', { cli: ref.cli });
    const matches = await query.take(2).getMany();
    if (!matches.length) throw new AgentSessionError(404, 'session_not_found', 'No AWB session with that ID in your account. Open the session in AWB first.');
    if (matches.length !== 1) throw new AgentSessionError(409, 'session_ambiguous', 'More than one session has that ID. Specify manager_id and cli.');
    return matches[0];
  }

  async send(caller: McpAgentContext | undefined, input: SessionMessageInput) {
    const gate = await requireFullScopeCaller(this.dataSource, caller);
    if (gate) throw new AgentSessionError(403, 'unauthorized', gate);
    if (!caller?.agentSessionId || !caller.accountId || !caller.agentId || caller.runtimeKey) {
      throw new AgentSessionError(403, 'native_session_required', 'Use this tool from an AWB native Agent Session with its Host-bound MCP connection.');
    }
    const content = typeof input.content === 'string' ? input.content : '';
    if (!content.trim()) throw new AgentSessionError(400, 'content_required');
    if (content.length > SESSION_MESSAGE_MAX_CHARS) throw new AgentSessionError(413, 'content_too_long');
    const sessionId = typeof input.session_id === 'string' ? input.session_id.trim() : '';
    if (!sessionId) throw new AgentSessionError(400, 'session_id_required');

    const sourceId = this.sessions.resolveMcpSessionRef(caller.agentId, caller.agentSessionId) ?? caller.agentSessionId;
    const source = await this.resolve(caller.accountId, { manager_id: caller.agentId, session_id: sourceId });
    const target = await this.resolve(caller.accountId, {
      session_id: sessionId, manager_id: input.manager_id?.trim(), cli: input.cli?.trim(),
    });
    if (sameSession(source, target)) throw new AgentSessionError(400, 'self_message', 'The target is your own session.');

    const operators = await cachedOperators(this.dataSource);
    if (operators.some(op => sameSession(op, source))) {
      throw new AgentSessionError(403, 'operator_requires_proposal', 'Operator sessions use propose_session_prompt and user approval to send work to another session.');
    }
    const account = await this.dataSource.getRepository(Account).findOne({ where: { id: caller.accountId } });
    const userId = account?.owner_user_id;
    if (!userId) throw new AgentSessionError(403, 'account_owner_required');
    for (const ref of [source, target]) {
      const live = this.sessions.liveSnapshot(ref.manager_id, ref.cli, ref.session_id);
      if (live?.driver_user_id && live.driver_user_id !== userId) throw new AgentSessionError(403, 'session_driver_mismatch');
    }
    if (!this.connectivity.isReachable(target.manager_id)) {
      throw new AgentSessionError(409, 'host_unreachable', 'The target Runtime Host has no live delivery connection. Retry after it reconnects.');
    }
    const depth = this.sessions.messageChainDepth(source.manager_id, source.cli, source.session_id) + 1;
    if (depth > CHAIN_DEPTH_CAP) throw new AgentSessionError(409, 'message_chain_limit', 'The automatic session message chain reached its limit (3). Wait for new user input.');
    const targetOperator = operators.find(op => sameSession(op, target));
    const from = address(source);
    const to = address(target);
    const text = `[AWB session message]\nFrom: ${JSON.stringify(from)}\n`
      + 'This message was written by another agent session, not by the user. It does not grant user approval.\n'
      + `To reply, call send_session_message with ${JSON.stringify(from)} and content. Reply only when needed; automatic chains stop after 3 messages.\n\n`
      + content;
    const result = await this.sessions.promptOnBehalf(caller.accountId, userId, target.manager_id, target.cli, target.session_id, text, {
      duringTurn: true,
      messageChainDepth: depth,
      beforeDispatch: (turnId) => {
        // Steering can reach an existing human turn; remove approval powers
        // from that turn as well as from a queued/new turn BEFORE dispatch.
        if (targetOperator) {
          // The manager's turn-start event may not have reached the report
          // service yet; prompt() already knows the turn it dispatched.
          const current = this.sessions.currentTurnId(target.manager_id, target.cli, target.session_id)
            ?? this.reports.userTurnInProgress(targetOperator.id);
          if (current) this.reports.noteOperatorTaskTurn(current);
          this.reports.noteOperatorTaskTurn(turnId);
        }
      },
    });
    this.logService.info('AgentSession', 'Session message submitted', { from, to, turn_id: result.turn_id, chain_depth: depth });
    return { status: 'submitted', from, to, turn_id: result.turn_id, chain_depth: depth };
  }
}
