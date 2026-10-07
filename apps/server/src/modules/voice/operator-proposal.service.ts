import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, In } from 'typeorm';
import { cliDescriptor } from '../../common/cli-catalog';
import { agentSessionAcceptsPrompt } from '../../common/types/agent-sessions';
import { AgentSessionExecution } from '../../entities/AgentSessionExecution';
import { AgentSessionPromptProposal } from '../../entities/AgentSessionPromptProposal';
import { RuntimeHost } from '../../entities/RuntimeHost';
import { activityEvents } from '../../services/activity.service';
import { LogService } from '../../services/log.service';
import { AgentSessionsService } from '../agent-sessions/agent-sessions.service';
import { cachedOperators } from './operator-config';
import { OperatorDecisionService, type DecisionCaller } from './operator-decision.service';
import {
  PROPOSAL_OPEN_STATUSES,
  PROPOSAL_REASON_MAX_CHARS,
  PROPOSAL_TEXT_MAX_CHARS,
  composeOperatorTaskPrompt,
  proposalView,
  type SessionProposalView,
} from './operator-proposal';
import { OperatorReportService } from './operator-report.service';

export class OperatorProposalError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = 'OperatorProposalError';
  }
}

const SWEEP_MS = 30_000;
/** 화면이 보여 주는 실패 — 이 시간이 지나면 목록에서 뺀다(행은 남는다). */
const FAILED_VISIBLE_MS = 24 * 60 * 60_000;
/** operator 가 결과를 확인할 수 있는 최근 결정. */
const RECENT_DECIDED_MS = 2 * 60 * 60_000;

const targetKey = (r: { manager_id: string; cli: string; session_id: string }) => `${r.manager_id}\0${r.cli}\0${r.session_id}`;

/**
 * 작업 제안(docs/voice-operator.md "작업 제안") — operator 가 다른 세션에 시킬 일을 **제안**하고, 사용자가 승인하면
 * AWB 가 그 세션에 보낸다.
 *
 * 왜 바로 보내지 않나: operator 는 보고(다른 세션이 쓴 글, 믿을 수 없는 입력)를 보고 다음 일을 떠올린다. 그 글만으로
 * 다른 세션을 움직이게 두면 한 세션의 문장이 다른 세션에 대한 명령이 된다. 그래서 제안은 어느 턴에서든 남길 수
 * 있지만, 보내는 것은 사람이 정한다:
 *   - 화면: 로그인한 사용자가 제안 카드의 Send 를 누른다(REST).
 *   - 음성: 사용자가 operator 에게 "보내" 라고 말한 턴 — 말로 답하기와 같은 문(등록된 operator 연결 · 사용자가
 *     시작한 턴 · 같은 사용자, OperatorDecisionService)을 지난다.
 * 대상이 턴 중이면 승인된 채 기다렸다가(queued) 그 턴이 끝나면 보낸다. operator 세션은 대상이 될 수 없다 —
 * 승인된 글로 시작한 턴이 다른 operator 의 "사용자 턴" 으로 세어져 승인 권한을 얻는 길이 생긴다.
 */
@Injectable()
export class OperatorProposalService implements OnModuleInit, OnModuleDestroy {
  #delivering = new Set<string>();
  /** 승인된 채 기다리는 제안이 있는 세션 — 세션 갱신마다 DB 를 묻지 않게. 부팅 뒤 첫 점검이 채운다. */
  #queuedTargets = new Set<string>();
  #timer: NodeJS.Timeout | null = null;
  #listener: ((e: any) => void) | null = null;

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly sessions: AgentSessionsService,
    private readonly decisions: OperatorDecisionService,
    private readonly reports: OperatorReportService,
    private readonly logService: LogService,
  ) {}

  onModuleInit(): void {
    // 대상 세션이 한가해지면(턴 종료 · 오류 · 닫힘) 승인된 채 기다리던 제안을 보낸다.
    this.#listener = (e: any) => {
      const s = e?.session;
      if (!s || !agentSessionAcceptsPrompt(s.status) || !this.#queuedTargets.has(targetKey(s))) return;
      void this.deliverQueuedFor(s.manager_id, s.cli, s.session_id)
        .catch((err) => this.logService.warn('Voice', `queued proposal delivery failed: ${err?.message ?? err}`));
    };
    activityEvents.on('agent_session_update', this.#listener);
    // 이벤트를 놓쳤거나(서버 재시작) 대상에 라이브 프로세스가 없을 때를 위한 주기 점검.
    this.#timer = setInterval(() => { void this.sweep().catch(() => undefined); }, SWEEP_MS);
    this.#timer.unref?.();
    void this.sweep().catch(() => undefined);
  }

  onModuleDestroy(): void {
    if (this.#listener) activityEvents.removeListener('agent_session_update', this.#listener);
    this.#listener = null;
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }

  private get repo() {
    return this.dataSource.getRepository(AgentSessionPromptProposal);
  }

  // ─── operator(MCP) ─────────────────────────────────────────────────────

  /** 제안을 남긴다 — 어느 operator 턴에서든. 같은 operator 가 같은 세션에 남긴 미결 제안은 새것으로 바뀐다. */
  async propose(
    caller: DecisionCaller | undefined,
    input: { manager_id: string; cli: string; session_id: string; text: string; reason?: string },
  ): Promise<SessionProposalView> {
    const operator = await this.decisions.operatorFor(caller);
    const text = typeof input.text === 'string' ? input.text.trim() : '';
    const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
    if (!text) throw new OperatorProposalError(400, 'text_required', 'Write the prompt you want the session to receive.');
    if (text.length > PROPOSAL_TEXT_MAX_CHARS) {
      throw new OperatorProposalError(413, 'text_too_long', `Keep the prompt under ${PROPOSAL_TEXT_MAX_CHARS} characters.`);
    }
    if (reason.length > PROPOSAL_REASON_MAX_CHARS) {
      throw new OperatorProposalError(413, 'reason_too_long', `Keep the reason under ${PROPOSAL_REASON_MAX_CHARS} characters.`);
    }
    const { manager_id: managerId, cli, session_id: sessionId } = input;
    if (!managerId || !cli || !sessionId) throw new OperatorProposalError(400, 'target_required', 'manager_id, cli and session_id are required.');
    const operators = await cachedOperators(this.dataSource);
    if (operators.some((op) => op.manager_id === managerId && op.cli === cli && op.session_id === sessionId)) {
      throw new OperatorProposalError(409, 'target_is_operator',
        'Operator sessions talk with the user, not with each other — propose work only for ordinary sessions.');
    }
    const live = this.sessions.liveSnapshot(managerId, cli, sessionId);
    const execution = await this.dataSource.getRepository(AgentSessionExecution).findOne({ where: { manager_id: managerId, cli, session_id: sessionId } });
    if (!live && !execution) {
      throw new OperatorProposalError(404, 'session_unknown',
        'AWB does not know that session — use the manager_id / cli / session_id from a work report.');
    }

    // 승인할 사람: 보고 턴이면 그 보고의 사용자, 사용자 턴이면 지금 대화하는 사람, 모르면 그 operator 의 사용자.
    const reportUser = this.reports.reportTurnUser(operator.id);
    const userTurn = reportUser ? null : this.reports.userTurnInProgress(operator.id);
    const origin = reportUser ? 'report' : userTurn ? 'user' : 'unknown';
    const userId = reportUser
      ?? this.sessions.liveSnapshot(operator.manager_id, operator.cli, operator.session_id)?.driver_user_id
      ?? operator.created_by;
    if (!userId) throw new OperatorProposalError(409, 'user_unknown', 'AWB does not know which user to ask — ask the user to talk to you once.');
    if (live?.driver_user_id && live.driver_user_id !== userId) {
      throw new OperatorProposalError(403, 'not_this_user', 'That session is driven by someone other than the user you work for — AWB does not propose work there.');
    }

    // 같은 operator 가 같은 세션에 남긴 미결 제안 — 마지막 생각만 남긴다(승인된 것은 그대로 보낸다).
    const superseded = await this.repo.find({ where: { operator_id: operator.id, manager_id: managerId, cli, session_id: sessionId, status: 'pending' } });
    for (const old of superseded) {
      old.status = 'superseded';
      old.decided_via = 'operator';
      old.decided_at = new Date();
      await this.repo.save(old);
      await this.emit(old, 'superseded');
    }
    const row = await this.repo.save(this.repo.create({
      account_id: execution?.account_id || operator.account_id || '',
      user_id: userId,
      operator_id: operator.id,
      operator_name: operator.name,
      origin,
      manager_id: managerId,
      cli,
      session_id: sessionId,
      target_title: (live?.title || '').slice(0, 300),
      text,
      reason,
      status: 'pending',
    }));
    this.logService.info('Voice', `operator "${operator.name}" proposed work for a session`, {
      proposal_id: row.id, operator_id: operator.id, user_id: userId, origin,
      manager_id: managerId, cli, session_id: sessionId, chars: text.length,
    });
    return this.emit(row, 'proposed');
  }

  /** 사용자가 말로 승인했다 — 그 사용자가 시작한 operator 턴에서만. */
  async sendByVoice(caller: DecisionCaller | undefined, proposalId: string): Promise<SessionProposalView> {
    const operator = await this.decisions.operatorFor(caller);
    const turnId = this.decisions.requireUserTurn(operator);
    const userId = this.decisions.userOf(operator);
    const row = await this.requireOwn(userId, proposalId);
    this.logService.info('Voice', `operator "${operator.name}" passed on the user's approval of a proposal`, {
      proposal_id: row.id, operator_id: operator.id, user_id: userId, operator_turn_id: turnId,
    });
    return this.approve(row, userId, 'voice');
  }

  /** operator 가 자기 제안을 거둔다 — 거두는 것은 언제나 안전하다. */
  async withdraw(caller: DecisionCaller | undefined, proposalId: string): Promise<SessionProposalView> {
    const operator = await this.decisions.operatorFor(caller);
    const row = await this.repo.findOne({ where: { id: proposalId } });
    if (!row || row.operator_id !== operator.id) throw new OperatorProposalError(404, 'proposal_unknown', 'No such proposal of yours.');
    return this.close(row, 'withdrawn', null, 'operator'); // 사람이 정한 것이 아니다 — decided_by 는 비운다
  }

  /** 이 operator 의 열린 제안과 최근 결과 — 사용자가 화면에서 보냈는지·거절했는지 알 수 있게. */
  async listForOperator(caller: DecisionCaller | undefined): Promise<SessionProposalView[]> {
    const operator = await this.decisions.operatorFor(caller);
    const rows = await this.repo.find({ where: { operator_id: operator.id }, order: { created_at: 'DESC' }, take: 50 });
    const now = Date.now();
    const visible = rows.filter((r) => (PROPOSAL_OPEN_STATUSES as readonly string[]).includes(r.status)
      || (r.decided_at && now - new Date(r.decided_at).getTime() < RECENT_DECIDED_MS));
    return Promise.all(visible.slice(0, 20).map((r) => this.view(r)));
  }

  // ─── 사용자(REST) ─────────────────────────────────────────────────────

  /** 이 사용자가 정할 제안 — 승인 대기 · 보낼 차례를 기다리는 것 · 최근 실패. */
  async listForUser(userId: string): Promise<SessionProposalView[]> {
    const rows = await this.repo.find({
      where: { user_id: userId, status: In([...PROPOSAL_OPEN_STATUSES, 'failed']) },
      order: { created_at: 'ASC' },
      take: 100,
    });
    const now = Date.now();
    const visible = rows.filter((r) => r.status !== 'failed' || now - new Date(r.updated_at).getTime() < FAILED_VISIBLE_MS);
    return Promise.all(visible.map((r) => this.view(r)));
  }

  async sendByUser(userId: string, proposalId: string): Promise<SessionProposalView> {
    return this.approve(await this.requireOwn(userId, proposalId), userId, 'screen');
  }

  async dismiss(userId: string, proposalId: string): Promise<SessionProposalView> {
    return this.close(await this.requireOwn(userId, proposalId), 'dismissed', userId, 'screen');
  }

  // ─── 승인 · 배달 ──────────────────────────────────────────────────────

  private async requireOwn(userId: string, proposalId: string): Promise<AgentSessionPromptProposal> {
    const row = typeof proposalId === 'string' && proposalId ? await this.repo.findOne({ where: { id: proposalId } }) : null;
    if (!row) throw new OperatorProposalError(404, 'proposal_unknown', 'No such proposal.');
    if (row.user_id !== userId) throw new OperatorProposalError(403, 'not_your_proposal', 'This proposal is waiting for another user.');
    return row;
  }

  private async approve(row: AgentSessionPromptProposal, userId: string, via: 'screen' | 'voice'): Promise<SessionProposalView> {
    // 실패한 것은 다시 보낼 수 있다(대상 호스트가 꺼져 있었다 등). 그 밖에 이미 정해진 것은 되돌리지 않는다.
    if (row.status !== 'pending' && row.status !== 'failed') {
      throw new OperatorProposalError(409, 'proposal_closed', `This proposal is already ${row.status}.`);
    }
    const claimed = await this.repo.update(
      { id: row.id, status: row.status },
      { status: 'queued', decided_by: userId, decided_via: via, decided_at: new Date(), error: null },
    );
    if (claimed.affected !== 1) throw new OperatorProposalError(409, 'proposal_closed', 'This proposal was decided meanwhile — reload.');
    const queued = (await this.repo.findOne({ where: { id: row.id } }))!;
    this.#queuedTargets.add(targetKey(queued));
    await this.emit(queued, 'approved');
    return this.deliver(queued);
  }

  private async close(row: AgentSessionPromptProposal, status: 'dismissed' | 'withdrawn', userId: string | null, via: string): Promise<SessionProposalView> {
    if (!['pending', 'queued', 'failed'].includes(row.status)) {
      throw new OperatorProposalError(409, 'proposal_closed', `This proposal is already ${row.status}.`);
    }
    const updated = await this.repo.update(
      { id: row.id, status: row.status },
      { status, decided_by: userId, decided_via: via, decided_at: new Date() },
    );
    if (updated.affected !== 1) throw new OperatorProposalError(409, 'proposal_closed', 'This proposal was decided meanwhile — reload.');
    return this.emit((await this.repo.findOne({ where: { id: row.id } }))!, status);
  }

  /** 승인된 제안을 보낸다. 대상이 턴 중이면 그대로 두고(queued) 그 턴이 끝날 때 다시 부른다. */
  private async deliver(row: AgentSessionPromptProposal): Promise<SessionProposalView> {
    if (this.#delivering.has(row.id)) return this.view(row);
    this.#delivering.add(row.id);
    try {
      const fresh = await this.repo.findOne({ where: { id: row.id } });
      if (!fresh || fresh.status !== 'queued') return this.view(fresh ?? row);
      try {
        const { turn_id } = await this.sessions.promptOnBehalf(
          fresh.account_id, fresh.user_id, fresh.manager_id, fresh.cli, fresh.session_id,
          composeOperatorTaskPrompt(fresh.operator_name, fresh.text),
        );
        await this.repo.update({ id: fresh.id, status: 'queued' }, { status: 'sent', delivered_turn_id: turn_id });
        this.logService.info('Voice', `sent an approved operator proposal to its session`, {
          proposal_id: fresh.id, operator: fresh.operator_name, turn_id,
          manager_id: fresh.manager_id, cli: fresh.cli, session_id: fresh.session_id,
        });
        return this.emit((await this.repo.findOne({ where: { id: fresh.id } }))!, 'sent');
      } catch (err: any) {
        if (err?.code === 'session_busy') return this.view(fresh); // 턴이 끝나면 보낸다
        const message = String(err?.message || err).slice(0, 1000);
        await this.repo.update({ id: fresh.id, status: 'queued' }, { status: 'failed', error: message });
        this.logService.warn('Voice', `approved operator proposal not delivered: ${message}`, { proposal_id: fresh.id });
        return this.emit((await this.repo.findOne({ where: { id: fresh.id } }))!, 'failed');
      }
    } finally {
      this.#delivering.delete(row.id);
    }
  }

  /** 이 세션에 승인된 채 기다리는 제안 중 가장 먼저 승인된 것 하나 — 보내면 세션이 다시 바빠진다. */
  async deliverQueuedFor(managerId: string, cli: string, sessionId: string): Promise<void> {
    const next = await this.repo.findOne({
      where: { manager_id: managerId, cli, session_id: sessionId, status: 'queued' },
      order: { decided_at: 'ASC' },
    });
    if (!next) {
      this.#queuedTargets.delete(targetKey({ manager_id: managerId, cli, session_id: sessionId }));
      return;
    }
    await this.deliver(next);
  }

  async sweep(): Promise<void> {
    const queued = await this.repo.find({ where: { status: 'queued' }, order: { decided_at: 'ASC' }, take: 50 });
    const seen = new Set<string>();
    for (const row of queued) this.#queuedTargets.add(targetKey(row));
    for (const row of queued) {
      const key = targetKey(row);
      if (seen.has(key)) continue;
      seen.add(key);
      const live = this.sessions.liveSnapshot(row.manager_id, row.cli, row.session_id);
      if (live && !agentSessionAcceptsPrompt(live.status)) continue;
      await this.deliver(row).catch((err) => this.logService.warn('Voice', `proposal sweep: ${err?.message ?? err}`));
    }
  }

  // ─── 보기 · 알림 ──────────────────────────────────────────────────────

  private async view(row: AgentSessionPromptProposal): Promise<SessionProposalView> {
    const live = this.sessions.liveSnapshot(row.manager_id, row.cli, row.session_id);
    let managerName = live?.manager_name || '';
    if (!managerName) {
      const host = await this.dataSource.getRepository(RuntimeHost).findOne({ where: { id: row.manager_id } }).catch(() => null);
      managerName = host?.name || row.manager_id.slice(0, 8);
    }
    return proposalView(row, { manager_name: managerName, cli_label: cliDescriptor(row.cli)?.label || row.cli });
  }

  /** 화면에 알린다(SSE `agent_session_proposal`, 승인할 사용자에게만). */
  private async emit(row: AgentSessionPromptProposal, reason: string): Promise<SessionProposalView> {
    const proposal = await this.view(row);
    activityEvents.emit('agent_session_proposal', { proposal, user_id: row.user_id, reason, timestamp: new Date().toISOString() });
    return proposal;
  }
}

