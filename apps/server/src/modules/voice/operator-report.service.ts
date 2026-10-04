import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { LogService } from '../../services/log.service';
import { AgentSessionsService } from '../agent-sessions/agent-sessions.service';
import { announcementLanguage } from './announcement-text';
import { cachedOperators, touchOperatorConversation, type OperatorEntry } from './operator-config';
import {
  MAX_REPORTS_PER_PROMPT,
  composeReportPrompt,
  isUrgentReport,
  mergeReport,
  routeOperators,
  type SessionReport,
} from './operator-report';
import type { FinishedTurnAnswer } from './turn-answer';
import { loadVoiceConfig } from './voice-config';

/** operator 의 보고 턴이 이보다 오래 끝나지 않으면 포기하고 직접 알린다. */
export const REPORT_TURN_TIMEOUT_MS = 10 * 60_000;
/** operator 가 다른 일로 바쁠 때 결정이 필요한 보고를 기다리는 한도 — 요청은 15분이면 취소된다. */
export const URGENT_REPORT_WAIT_MS = 2 * 60_000;
/** 그 밖의 보고를 기다리는 한도. */
export const REPORT_WAIT_MS = 20 * 60_000;
const SWEEP_MS = 30_000;

/** 대신 보내는 프롬프트 — 테스트가 가짜를 끼운다. */
export type OperatorPrompter = Pick<AgentSessionsService, 'promptOnBehalf'>;

interface QueuedReport extends SessionReport {
  /** 이미 닿지 못한 operator 들 — 다시 돌려보내지 않는다. */
  tried: string[];
}

interface InflightReport {
  turnId: string;
  reports: QueuedReport[];
  userId: string;
  sentAt: number;
}

export interface OperatorSummary {
  operator: OperatorEntry;
  userId: string;
  /** operator 가 쓴 답(마크다운 그대로) — 사용자에게 소리로 전해진다. */
  answer: string;
  reports: SessionReport[];
}

type SummaryListener = (summary: OperatorSummary) => void;
type UndeliverableListener = (reports: SessionReport[], reason: string) => void;

/**
 * 작업 보고의 배달(docs/voice-operator.md "작업 보고"). 보고를 operator 별로 줄 세우고, operator 가 한가할
 * 때 묶어서 한 프롬프트로 보낸 뒤(대신 보낸 프롬프트 = `promptOnBehalf`), 그 턴이 끝나면 operator 의 답을
 * 요약으로 내보낸다. 소리로 바꾸는 것은 음성 알림(VoiceAnnouncerService)의 몫이다.
 *
 * 닿지 못하면 조용히 버리지 않는다: 다음 후보 operator 로 돌리고, 아무에게도 닿지 못하거나 operator 가
 * 답하지 못하면(턴 실패·시간 초과·결정이 급한데 operator 가 계속 바쁨) **직접 알리도록** 넘긴다.
 */
@Injectable()
export class OperatorReportService implements OnModuleInit, OnModuleDestroy {
  #queues = new Map<string, QueuedReport[]>();
  #inflight = new Map<string, InflightReport>();
  #flushing = new Set<string>();
  #reportTurns = new Set<string>();
  #lastConversation = new Map<string, number>();
  #summaryListeners: SummaryListener[] = [];
  #undeliverableListeners: UndeliverableListener[] = [];
  #timer: NodeJS.Timeout | null = null;
  /** 테스트가 가짜를 끼운다. */
  prompter: OperatorPrompter;

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    sessions: AgentSessionsService,
    private readonly logService: LogService,
  ) {
    this.prompter = sessions;
  }

  onModuleInit(): void {
    this.#timer = setInterval(() => { void this.sweep(); }, SWEEP_MS);
    this.#timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }

  onSummary(listener: SummaryListener): void {
    this.#summaryListeners.push(listener);
  }

  onUndeliverable(listener: UndeliverableListener): void {
    this.#undeliverableListeners.push(listener);
  }

  /** 이 턴은 AWB 가 보낸 보고였나(대화가 아니다). */
  isReportTurn(turnId: string): boolean {
    return this.#reportTurns.has(turnId);
  }

  /** 사용자가 이 operator 와 대화했다 — 보고 받을 operator 를 고를 때 "가장 최근" 의 근거. */
  noteConversation(operatorId: string, at = Date.now()): void {
    this.#lastConversation.set(operatorId, at);
    void touchOperatorConversation(this.dataSource, operatorId, new Date(at))
      .catch((err) => this.logService.debug('Voice', `operator conversation time not saved: ${err?.message ?? err}`));
  }

  /**
   * 보고 하나. 받을 operator 가 있으면 줄 세우고 true, 등록된 operator 가 없으면 false(호출자가 직접 알린다).
   */
  async submit(report: SessionReport): Promise<boolean> {
    return this.enqueue({ ...report, tried: [] });
  }

  private async enqueue(report: QueuedReport): Promise<boolean> {
    const operators = await cachedOperators(this.dataSource);
    const [operator] = routeOperators(operators, report.session.manager_id, this.#lastConversation)
      .filter((op) => !report.tried.includes(op.id));
    if (!operator) return false;
    this.#queues.set(operator.id, mergeReport(this.#queues.get(operator.id) ?? [], report) as QueuedReport[]);
    await this.flush(operator.id);
    return true;
  }

  /** operator 가 받을 수 있으면 줄 선 보고를 묶어 보낸다. 바쁘면 그 턴이 끝날 때 다시 부른다. */
  async flush(operatorId: string): Promise<void> {
    if (this.#inflight.has(operatorId) || this.#flushing.has(operatorId)) return;
    const queue = this.#queues.get(operatorId) ?? [];
    if (!queue.length) return;
    this.#flushing.add(operatorId);
    try {
      const operator = (await cachedOperators(this.dataSource)).find((op) => op.id === operatorId);
      if (!operator) {
        this.#queues.delete(operatorId);
        await this.reroute(queue, operatorId, 'operator was unregistered');
        return;
      }
      const userId = queue[0].user_id;
      const batch = queue.filter((r) => r.user_id === userId).slice(0, MAX_REPORTS_PER_PROMPT);
      const lang = announcementLanguage((await loadVoiceConfig(this.dataSource)).stt.languages);
      const text = composeReportPrompt(batch, lang);
      const taken = () => this.#queues.set(operatorId, (this.#queues.get(operatorId) ?? []).filter((r) => !batch.includes(r)));
      try {
        const { turn_id } = await this.prompter.promptOnBehalf(
          await this.workspaceFor(operator), userId, operator.manager_id, operator.cli, operator.session_id, text,
        );
        taken();
        this.#reportTurns.add(turn_id);
        this.#inflight.set(operatorId, { turnId: turn_id, reports: batch, userId, sentAt: Date.now() });
      } catch (err: any) {
        if (err?.code === 'session_busy') return; // 사용자와 대화 중이거나 다른 일을 하는 중 — 그 턴이 끝나면 보낸다
        taken();
        this.logService.warn('Voice', `report to operator "${operator.name}" not delivered: ${err?.message ?? err}`);
        await this.reroute(batch, operatorId, String(err?.message || err));
      }
    } finally {
      this.#flushing.delete(operatorId);
    }
  }

  /** 닿지 못한 operator 를 빼고 다음 후보로. 후보가 없으면 직접 알리도록 넘긴다. */
  private async reroute(reports: QueuedReport[], failedOperatorId: string, reason: string): Promise<void> {
    const leftovers: QueuedReport[] = [];
    for (const report of reports) {
      const next = { ...report, tried: [...report.tried, failedOperatorId] };
      if (!(await this.enqueue(next))) leftovers.push(next);
    }
    if (leftovers.length) this.undeliverable(leftovers, reason);
  }

  /**
   * operator 세션의 상태가 바뀌었다. 보고 턴이 끝났으면 그 답을 요약으로 내보내고 true. 어떤 경우든 줄 선
   * 보고가 있으면 다시 보내 본다(사용자와의 대화 턴이 끝나 한가해졌을 수 있다).
   */
  async handleOperatorUpdate(operator: OperatorEntry, reason: string, finished: FinishedTurnAnswer | null): Promise<boolean> {
    const inflight = this.#inflight.get(operator.id);
    let wasReport = false;
    if (inflight && (reason === 'turn_finished' || reason === 'turn_failed') && (!finished || finished.turnId === inflight.turnId)) {
      wasReport = true;
      this.settle(operator.id, inflight);
      const answer = reason === 'turn_finished' && finished?.stopReason !== 'cancelled' ? (finished?.answer || '').trim() : '';
      if (answer) {
        const summary: OperatorSummary = { operator, userId: inflight.userId, answer, reports: inflight.reports };
        for (const listener of this.#summaryListeners) listener(summary);
      } else {
        this.undeliverable(inflight.reports, reason === 'turn_failed' ? `operator "${operator.name}" failed the report turn` : `operator "${operator.name}" gave no answer`);
      }
    } else if (inflight && (reason === 'process_exit' || reason === 'closed' || reason === 'host_offline')) {
      this.settle(operator.id, inflight);
      this.undeliverable(inflight.reports, `operator "${operator.name}" stopped (${reason})`);
    }
    await this.flush(operator.id);
    return wasReport;
  }

  private settle(operatorId: string, inflight: InflightReport): void {
    this.#inflight.delete(operatorId);
    // 턴 id 는 잠시 남긴다 — 같은 턴의 늦은 이벤트(사용량 행 등)가 대화로 잘못 세어지지 않게.
    setTimeout(() => this.#reportTurns.delete(inflight.turnId), 60_000).unref?.();
  }

  private undeliverable(reports: SessionReport[], reason: string): void {
    if (!reports.length) return;
    for (const listener of this.#undeliverableListeners) listener(reports, reason);
  }

  /**
   * 주기 점검: 끝나지 않는 보고 턴, 오래 기다린 보고를 직접 알리도록 넘긴다. 바쁨이 풀렸는데 이벤트를 놓친
   * 경우를 위해 줄 선 보고를 다시 보내 본다.
   */
  async sweep(now = Date.now()): Promise<void> {
    const operators = await cachedOperators(this.dataSource).catch(() => [] as OperatorEntry[]);
    for (const [operatorId, inflight] of [...this.#inflight]) {
      if (now - inflight.sentAt < REPORT_TURN_TIMEOUT_MS) continue;
      this.settle(operatorId, inflight);
      const name = operators.find((op) => op.id === operatorId)?.name || operatorId.slice(0, 8);
      this.undeliverable(inflight.reports, `operator "${name}" did not answer within ${Math.round(REPORT_TURN_TIMEOUT_MS / 60_000)} minutes`);
    }
    for (const [operatorId, queue] of [...this.#queues]) {
      const stale = queue.filter((r) => now - r.at >= (isUrgentReport(r) ? URGENT_REPORT_WAIT_MS : REPORT_WAIT_MS));
      if (stale.length) {
        this.#queues.set(operatorId, queue.filter((r) => !stale.includes(r)));
        this.undeliverable(stale, 'the operator stayed busy');
      }
      await this.flush(operatorId);
    }
  }

  /** 서버가 대신 프롬프트를 보낼 워크스페이스 — 그 워크스페이스의 CLI 설정(credential)으로 세션이 열린다. */
  private async workspaceFor(operator: OperatorEntry): Promise<string> {
    if (operator.workspace_id) return operator.workspace_id;
    // 워크스페이스를 남기기 전에 등록된 operator — 그 호스트×CLI 의 설정을 마지막으로 고친 워크스페이스.
    const row: any = await this.dataSource.getRepository('AgentSessionCliSetting')
      .findOne({ where: { manager_id: operator.manager_id, cli: operator.cli }, order: { updated_at: 'DESC' } })
      .catch(() => null);
    return row?.workspace_id ?? '';
  }
}
