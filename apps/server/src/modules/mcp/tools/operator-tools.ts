/**
 * Operator tools — 말로 답하기(docs/voice-operator.md "말로 답하기").
 *
 * AWB 는 세션의 승인 대기·질문을 operator 에게 보고하고(작업 보고), operator 는 그것을 사용자에게 선택지와
 * 함께 말로 전한다. 사용자가 말로 고르면 operator 가 이 도구로 그 세션에 답을 전한다.
 *
 * Tools:
 *   - list_pending_session_requests: 사용자의 세션들이 지금 기다리는 승인·질문.
 *   - answer_session_permission:     권한 요청에 사용자가 고른 선택지를 전한다.
 *   - answer_session_question:       질문(form)에 사용자의 답을 전한다.
 *
 * 누가 부를 수 있나 — 등록된 operator 세션의 연결만, 그리고 답을 전하는 두 도구는 **사용자가 시작한 턴** 안에서만
 * (AWB 가 보낸 보고 턴에서는 거절한다). 조건과 이유는 `voice/operator-decision.service.ts`.
 *
 * 작업 제안(docs/voice-operator.md "작업 제안") — operator 는 다른 세션에 일을 직접 시키지 못하고 제안만 한다:
 *   - propose_session_prompt:          대상 세션에 보낼 프롬프트를 제안한다(어느 턴에서든). 사용자가 승인해야 간다.
 *   - send_session_prompt_proposal:    사용자가 말로 승인한 제안을 보낸다 — 사용자가 시작한 턴에서만.
 *   - withdraw_session_prompt_proposal: 자기 제안을 거둔다.
 *   - list_session_prompt_proposals:   자기 제안의 상태(승인 대기 · 보낼 차례 · 보냄 · 거절 …).
 * 조건과 이유는 `voice/operator-proposal.service.ts`.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ok, err } from '../shared/helpers';
import { getCallerAgent } from '../shared/session-auth';
import type { ToolContext } from './context';

const WHO = 'Only a registered AWB operator session (an Agent Session the user named as an operator) may call this.';

function failure(e: any) {
  return err(e?.message || String(e), e?.code ? { code: e.code } : undefined);
}

export function registerOperatorTools(server: McpServer, ctx: ToolContext): void {
  const { operatorDecisionService, operatorProposalService } = ctx;
  const unavailable = () => err('operator tools need the NestJS-integrated AWB server — live session state is not available in standalone MCP mode.');

  server.tool(
    'list_pending_session_requests',
    `${WHO} Lists the permission requests and questions that Agent Sessions driven by the user you are talking with are ` +
    'waiting on right now: the session (host, CLI, title), and for each request its id, title, and the choices — permission ' +
    'options (option_id + name) or the question\'s fields with their allowed values. Read the choices to the user, numbered; ' +
    'when they pick, pass it on with answer_session_permission / answer_session_question. Requests are raised by the ' +
    'sessions themselves — this tool only reads them.',
    {},
    async (_args, extra) => {
      if (!operatorDecisionService) return unavailable();
      try {
        return ok({ sessions: await operatorDecisionService.listPending(getCallerAgent(extra)) });
      } catch (e: any) {
        return failure(e);
      }
    },
  );

  server.tool(
    'answer_session_permission',
    `${WHO} Passes the user's choice on to a session that is waiting for permission (e.g. "allow once"). Call it only in ` +
    'the turn where the user told you what to pick — AWB refuses it in the turn that answers an AWB work report, because ' +
    'no human spoke in that turn. The option must be one of the request\'s option_ids (see list_pending_session_requests ' +
    'or the work report). The request must still be waiting, and the session must be driven by the same user.',
    {
      manager_id: z.string().describe('Runtime Host id of the waiting session'),
      cli: z.string().describe('CLI of the waiting session (e.g. claude, codex)'),
      session_id: z.string().describe('The waiting session\'s id'),
      request_id: z.string().describe('The permission request id'),
      option_id: z.string().describe('The option the user picked — one of the request\'s option_ids'),
    },
    async (args, extra) => {
      if (!operatorDecisionService) return unavailable();
      try {
        return ok({ passed_on: await operatorDecisionService.answerPermission(getCallerAgent(extra), args) });
      } catch (e: any) {
        return failure(e);
      }
    },
  );

  server.tool(
    'answer_session_question',
    `${WHO} Passes the user's answer on to a session that asked a question (an elicitation form). Call it only in the ` +
    'turn where the user told you the answer — AWB refuses it in the turn that answers an AWB work report. action: ' +
    "'accept' with content (field name → value; fields with listed choices take exactly those values, arrays for " +
    "multi-select), 'decline' to refuse, 'cancel' to dismiss. The question must still be waiting and the session must be " +
    'driven by the same user.',
    {
      manager_id: z.string().describe('Runtime Host id of the waiting session'),
      cli: z.string().describe('CLI of the waiting session'),
      session_id: z.string().describe('The waiting session\'s id'),
      elicitation_id: z.string().describe('The question id'),
      action: z.enum(['accept', 'decline', 'cancel']).describe("'accept' to answer with content, 'decline' or 'cancel'"),
      content: z.record(z.string(), z.unknown()).optional().describe('Answers by field name, for action accept'),
    },
    async (args, extra) => {
      if (!operatorDecisionService) return unavailable();
      try {
        return ok({ passed_on: await operatorDecisionService.answerQuestion(getCallerAgent(extra), args) });
      } catch (e: any) {
        return failure(e);
      }
    },
  );

  server.tool(
    'propose_session_prompt',
    `${WHO} Proposes a prompt for another Agent Session to work on next — e.g. after a work report says a session ` +
    'finished, propose the follow-up. You may call it in any turn, including the turn that answers an AWB work report, ' +
    'but it does NOT send anything: the user approves it first (the Send button on screen, or by telling you — then ' +
    'call send_session_prompt_proposal in that turn). Approved prompts reach the session with a first line naming you ' +
    'and saying the user approved it; if the session is mid-turn, AWB sends it when that turn ends. Write the prompt ' +
    'exactly as the session should receive it, and tell the user in one sentence what you proposed and why. A newer ' +
    'proposal of yours for the same session replaces your older one that is still waiting. Operator sessions cannot ' +
    'be targets, and only sessions driven by the user you work for. Use manager_id / cli / session_id from a work report.',
    {
      manager_id: z.string().describe('Runtime Host id of the target session (from the work report)'),
      cli: z.string().describe('CLI of the target session (e.g. claude, codex)'),
      session_id: z.string().describe('The target session\'s id'),
      text: z.string().describe('The prompt the session should receive, verbatim'),
      reason: z.string().optional().describe('One line for the user: why you propose this'),
    },
    async (args, extra) => {
      if (!operatorProposalService) return unavailable();
      try {
        return ok({ proposal: await operatorProposalService.propose(getCallerAgent(extra), args) });
      } catch (e: any) {
        return failure(e);
      }
    },
  );

  server.tool(
    'send_session_prompt_proposal',
    `${WHO} Sends a proposal the user just approved by talking to you ("yes, send it"). Call it only in the turn where ` +
    'the user approved that proposal — AWB refuses it in the turn that answers an AWB work report, because no human ' +
    'spoke there. Before asking, tell the user which session it goes to and what it says. The proposal must still be ' +
    'waiting and must be one the user you are talking with decides.',
    { proposal_id: z.string().describe('The proposal id (from propose_session_prompt or list_session_prompt_proposals)') },
    async ({ proposal_id }, extra) => {
      if (!operatorProposalService) return unavailable();
      try {
        return ok({ proposal: await operatorProposalService.sendByVoice(getCallerAgent(extra), proposal_id) });
      } catch (e: any) {
        return failure(e);
      }
    },
  );

  server.tool(
    'withdraw_session_prompt_proposal',
    `${WHO} Withdraws one of your own proposals that has not been sent yet (waiting for approval, or approved and ` +
    'waiting for the session to finish its turn).',
    { proposal_id: z.string().describe('The proposal id') },
    async ({ proposal_id }, extra) => {
      if (!operatorProposalService) return unavailable();
      try {
        return ok({ proposal: await operatorProposalService.withdraw(getCallerAgent(extra), proposal_id) });
      } catch (e: any) {
        return failure(e);
      }
    },
  );

  server.tool(
    'list_session_prompt_proposals',
    `${WHO} Lists your own proposals that are still open (pending = waiting for the user, queued = approved and ` +
    'waiting for the session to finish its turn) and those decided in the last two hours (sent, dismissed by the user, ' +
    'withdrawn, replaced, failed). Proposals are created only by propose_session_prompt — this tool only reads them.',
    {},
    async (_args, extra) => {
      if (!operatorProposalService) return unavailable();
      try {
        return ok({ proposals: await operatorProposalService.listForOperator(getCallerAgent(extra)) });
      } catch (e: any) {
        return failure(e);
      }
    },
  );
}
