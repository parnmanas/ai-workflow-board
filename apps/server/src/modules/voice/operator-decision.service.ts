import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { cliDescriptor } from '../../common/cli-catalog';
import { LogService } from '../../services/log.service';
import { AgentSessionsService, type PendingSessionInteraction } from '../agent-sessions/agent-sessions.service';
import { cachedOperators, type OperatorEntry } from './operator-config';
import { questionFields, type QuestionField } from './operator-report';
import { OperatorReportService } from './operator-report.service';

export class OperatorDecisionError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'OperatorDecisionError';
  }
}

/** MCP 호출자 중 이 서비스가 보는 부분(`McpAgentContext`). */
export interface DecisionCaller {
  source: string;
  agentId?: string;
  scope?: string;
  agentSessionId?: string;
}

export interface PendingRequestView {
  kind: 'permission' | 'question';
  id: string;
  title: string;
  description: string;
  options: Array<{ option_id: string; name: string; kind: string }>;
  fields: QuestionField[];
  waiting_since: string;
}

export interface PendingSessionView {
  manager_id: string;
  host: string;
  cli: string;
  cli_label: string;
  session_id: string;
  title: string;
  cwd: string;
  requests: PendingRequestView[];
}

const NOT_AN_OPERATOR = 'Only a registered AWB operator session can use this tool — register the session as an operator '
  + '(AWB → the session header → ☆ Operator).';

/**
 * 말로 답하기(docs/voice-operator.md "말로 답하기") — 사용자가 operator 에게 말로 고른 것을, 승인이나 답을
 * 기다리는 세션에 대신 전한다.
 *
 * 권한 요청은 사람이 결정하라고 있는 것이고, MCP 는 에이전트만 붙는 표면이라 "사람이 정했다" 를 증명하지
 * 못한다. 그래서 대신 전하는 조건을 **서버가 확인할 수 있는 사실**로만 정한다:
 *   1. 호출자가 등록된 operator 세션의 연결이다 — 매니저가 그 세션에 주입한 연결, 그 세션 id, 그 Host 의 full 키
 *      (`operator-config.ts` `isOperatorConnection` 과 같은 조건).
 *   2. 그 operator 가 지금 **사용자가 시작한 턴**을 돌고 있다 — 사람이 로그인한 화면에서 방금 말을 걸었다. AWB 가
 *      보낸 보고 턴이나 서버가 모르는 턴에서는 거절한다. 보고에는 다른 세션이 쓴 글(믿을 수 없는 입력)이 실려 오므로,
 *      그 글만 보고 operator 가 스스로 승인하는 길을 막는 것이 이 조건이다.
 *   3. 답을 기다리는 세션의 driver 가 지금 그 operator 와 대화하는 사람과 같다 — 남의 세션에 대신 답하지 않는다.
 *   4. 그 요청이 아직 미결이고, 고른 선택지·값이 그 요청의 것이다(자유 형식으로 승인을 만들어 내지 못한다).
 * 대신 전할 때마다 누가·무엇을·어느 턴에서 골랐는지 로그를 남긴다.
 */
@Injectable()
export class OperatorDecisionService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly sessions: AgentSessionsService,
    private readonly reports: OperatorReportService,
    private readonly logService: LogService,
  ) {}

  /** 호출자가 operator 세션이면 그 operator. 아니면 던진다. */
  async operatorFor(caller: DecisionCaller | undefined): Promise<OperatorEntry> {
    if (!caller || caller.source !== 'db' || caller.scope !== 'full' || !caller.agentId || !caller.agentSessionId) {
      throw new OperatorDecisionError('not_an_operator', NOT_AN_OPERATOR);
    }
    // 새로 만든 세션의 연결은 세션 id 대신 참조값을 보낸다 — 매니저가 하트비트로 알려 준 대응으로 바꾼다.
    const sessionId = this.sessions.resolveMcpSessionRef(caller.agentId, caller.agentSessionId) ?? caller.agentSessionId;
    const operator = (await cachedOperators(this.dataSource))
      .find((op) => op.manager_id === caller.agentId && op.session_id === sessionId);
    if (!operator) {
      // 옛 매니저는 새 세션의 연결에 글자 그대로 'new' 를 실었다 — 그 연결로는 어느 세션인지 알 수 없다.
      if (sessionId === 'new' || sessionId.startsWith('pending-')) {
        throw new OperatorDecisionError('session_unidentified',
          `${NOT_AN_OPERATOR} AWB cannot tell which session this connection belongs to yet (it was opened as a new session`
          + `${sessionId === 'new' ? ' by an older agent-manager' : ' and the Runtime Host has not reported it — wait ~30 s'}). `
          + 'If you are the operator, ask the user to restart this session once (session header → ⟳ Restart).');
      }
      throw new OperatorDecisionError('not_an_operator', NOT_AN_OPERATOR);
    }
    return operator;
  }

  /** 지금 이 operator 와 대화하는 사람 — operator 세션의 driver. */
  private userOf(operator: OperatorEntry): string {
    const live = this.sessions.liveSnapshot(operator.manager_id, operator.cli, operator.session_id);
    if (!live?.driver_user_id) {
      throw new OperatorDecisionError('user_unknown', 'AWB does not know who is talking with you right now — ask the user to say it again.');
    }
    return live.driver_user_id;
  }

  private requireUserTurn(operator: OperatorEntry): string {
    const turnId = this.reports.userTurnInProgress(operator.id);
    if (!turnId) {
      throw new OperatorDecisionError('not_user_turn',
        'AWB only passes on an answer in a turn the user started — this one is an AWB work report (or AWB lost track of it). '
        + 'Tell the user what is waiting and the choices; answer in the turn where they tell you what to pick.');
    }
    return turnId;
  }

  private sessionView(live: { manager_id: string; manager_name?: string; cli: string; session_id: string; title?: string; cwd?: string }, requests: PendingSessionInteraction[]): PendingSessionView {
    return {
      manager_id: live.manager_id,
      host: live.manager_name || live.manager_id.slice(0, 8),
      cli: live.cli,
      cli_label: cliDescriptor(live.cli)?.label || live.cli,
      session_id: live.session_id,
      title: live.title || '',
      cwd: live.cwd || '',
      requests: requests.map((r) => ({
        kind: r.kind,
        id: r.id,
        title: r.title,
        description: r.description,
        options: r.options,
        fields: r.kind === 'question' ? questionFields(r.schema) : [],
        waiting_since: r.created_at,
      })),
    };
  }

  /** 지금 이 사용자의 세션들이 기다리는 승인·질문(operator 자신은 빼고). */
  async listPending(caller: DecisionCaller | undefined): Promise<PendingSessionView[]> {
    const operator = await this.operatorFor(caller);
    const userId = this.userOf(operator);
    return this.sessions.pendingForDriver(userId)
      .filter(({ session }) => !(session.manager_id === operator.manager_id && session.cli === operator.cli && session.session_id === operator.session_id))
      .map(({ session, interactions }) => this.sessionView(session, interactions));
  }

  private requirePending(userId: string, ref: { manager_id: string; cli: string; session_id: string }, kind: 'permission' | 'question', id: string) {
    const live = this.sessions.liveSnapshot(ref.manager_id, ref.cli, ref.session_id);
    if (!live) {
      throw new OperatorDecisionError('session_unknown', 'AWB does not see that session live — check manager_id / cli / session_id with list_pending_session_requests.');
    }
    if (live.driver_user_id !== userId) {
      throw new OperatorDecisionError('not_this_user', 'That session is driven by someone other than the user you are talking with — AWB does not answer for them.');
    }
    const request = this.sessions.pendingInteractions(ref.manager_id, ref.cli, ref.session_id).find((r) => r.kind === kind && r.id === id);
    if (!request) {
      throw new OperatorDecisionError('request_gone',
        'That request is not waiting any more (already answered, timed out, or its turn ended). Call list_pending_session_requests for what is waiting now.');
    }
    return { live, request };
  }

  /** 권한 요청에 사용자가 고른 선택지를 전한다. */
  async answerPermission(
    caller: DecisionCaller | undefined,
    input: { manager_id: string; cli: string; session_id: string; request_id: string; option_id: string },
  ): Promise<{ session: string; request: string; chose: string }> {
    const operator = await this.operatorFor(caller);
    const turnId = this.requireUserTurn(operator);
    const userId = this.userOf(operator);
    const { live, request } = this.requirePending(userId, input, 'permission', input.request_id);
    const option = request.options.find((o) => o.option_id === input.option_id);
    if (!option) {
      throw new OperatorDecisionError('option_unknown',
        `"${input.option_id}" is not one of this request's options: ${request.options.map((o) => `${o.option_id} (${o.name})`).join(', ') || 'none'}.`);
    }
    await this.sessions.decidePermission(operator.account_id || '', userId, input.manager_id, input.cli, input.session_id, request.id, option.option_id);
    this.logService.info('Voice', `operator "${operator.name}" passed on the user's answer to a permission request`, {
      operator_id: operator.id, user_id: userId, operator_turn_id: turnId,
      manager_id: input.manager_id, cli: input.cli, session_id: input.session_id,
      request_id: request.id, request: request.title, option_id: option.option_id, option: option.name,
    });
    return { session: `${live.manager_name || live.manager_id.slice(0, 8)} / ${cliDescriptor(live.cli)?.label || live.cli}${live.title ? ` · ${live.title}` : ''}`, request: request.title, chose: option.name };
  }

  /** 질문에 사용자의 답을 전한다. 고를 값이 정해진 칸은 그 값만 받는다. */
  async answerQuestion(
    caller: DecisionCaller | undefined,
    input: { manager_id: string; cli: string; session_id: string; elicitation_id: string; action: string; content?: Record<string, unknown> | null },
  ): Promise<{ session: string; question: string; action: string }> {
    const operator = await this.operatorFor(caller);
    const turnId = this.requireUserTurn(operator);
    const userId = this.userOf(operator);
    const { live, request } = this.requirePending(userId, input, 'question', input.elicitation_id);
    if (input.action !== 'accept' && input.action !== 'decline' && input.action !== 'cancel') {
      throw new OperatorDecisionError('action_invalid', "action must be 'accept' (answer), 'decline' or 'cancel'.");
    }
    let content: Record<string, unknown> | null = null;
    if (input.action === 'accept') {
      content = input.content && typeof input.content === 'object' && !Array.isArray(input.content) ? input.content : {};
      for (const field of questionFields(request.schema)) {
        const value = content[field.name];
        if (value === undefined || value === null || value === '') {
          if (field.required) throw new OperatorDecisionError('field_missing', `"${field.title}" (${field.name}) needs an answer.`);
          continue;
        }
        if (!field.choices.length) continue;
        const allowed = new Set(field.choices.map((c) => c.value));
        const given = Array.isArray(value) ? value.map(String) : [String(value)];
        const bad = given.filter((v) => !allowed.has(v));
        if (bad.length || (!field.multiple && Array.isArray(value))) {
          throw new OperatorDecisionError('choice_unknown',
            `"${field.title}" (${field.name}) takes ${field.multiple ? 'a list of ' : ''}one of: ${field.choices.map((c) => (c.label === c.value ? c.value : `${c.value} (${c.label})`)).join(', ')}.`);
        }
      }
    }
    await this.sessions.answerElicitation(operator.account_id || '', userId, input.manager_id, input.cli, input.session_id, request.id, input.action, content);
    this.logService.info('Voice', `operator "${operator.name}" passed on the user's answer to a question`, {
      operator_id: operator.id, user_id: userId, operator_turn_id: turnId,
      manager_id: input.manager_id, cli: input.cli, session_id: input.session_id,
      elicitation_id: request.id, question: request.title, action: input.action, fields: content ? Object.keys(content) : [],
    });
    return { session: `${live.manager_name || live.manager_id.slice(0, 8)} / ${cliDescriptor(live.cli)?.label || live.cli}${live.title ? ` · ${live.title}` : ''}`, question: request.title, action: input.action };
  }
}
