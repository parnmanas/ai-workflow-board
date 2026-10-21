import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { cliDescriptor } from '../../common/cli-catalog';
import { AgentSessionExecution } from '../../entities/AgentSessionExecution';
import { RuntimeHost } from '../../entities/RuntimeHost';
import { activityEvents } from '../../services/activity.service';
import { LogService } from '../../services/log.service';
import { AgentSessionsService } from '../agent-sessions/agent-sessions.service';
import { announcementLanguage } from './announcement-text';
import {
  AGENT_MANAGER_RESTART_RESUME_EVENT,
  INTERRUPTED_SESSION_TTL_MS,
  composeResumePrompt,
  interruptionDetail,
  type RestartResumeEvent,
} from './interrupted-sessions';
import { OperatorDecisionService, type DecisionCaller } from './operator-decision.service';
import { OperatorReportService } from './operator-report.service';
import { loadVoiceConfig } from './voice-config';

export class InterruptedSessionError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = 'InterruptedSessionError';
  }
}

interface Interrupted {
  account_id: string;
  user_id: string;
  interrupted_at: number;
  resumed: boolean;
}

const sessionKey = (managerId: string, cli: string, sessionId: string) => `${managerId}\0${cli}\0${sessionId}`;

/**
 * 재시작으로 끊긴 Agent Session(docs/voice-operator.md "재시작으로 끊긴 작업").
 *
 * 매니저가 재시작 뒤 넘긴 목록(`AGENT_MANAGER_RESTART_RESUME_EVENT`)을 받아 세션마다 `interrupted` 보고를 operator
 * 에게 보낸다 — 받는 operator 는 작업 보고와 같은 규칙(같은 호스트 → 없으면 가장 최근에 대화한 operator)으로
 * 정해진다. operator 가 `resume_interrupted_session` 을 부르면 고정된 재개 문구를 그 세션에 보낸다.
 *
 * 왜 제안(사용자 승인)을 거치지 않나: 이어서 하는 것은 사용자가 이미 시작한 일이고, 보내는 글은 AWB 가 정한다
 * (operator 가 고르는 것은 "재개할지" 뿐). 다른 세션이 쓴 글이 이 경로로 명령이 되지는 않는다. 그래서 문은
 * 좁다 — 등록된 operator 연결, AWB 가 끊김을 기록한 세션, 기록 뒤 6시간 안, 끊김마다 한 번.
 *
 * 끊김 기록은 메모리에만 둔다: 서버가 다시 뜨면(배포) 아직 재개하지 않은 끊김은 사라지고 그 세션은 사용자가 직접
 * 이어야 한다. 매니저 업데이트와 서버 배포는 같은 커밋에서 수 분 차이로 일어나므로 순서상 서버가 먼저 뜬다.
 */
@Injectable()
export class InterruptedSessionsService implements OnModuleInit, OnModuleDestroy {
  #interrupted = new Map<string, Interrupted>();
  #listener: ((e: RestartResumeEvent) => void) | null = null;

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly sessions: AgentSessionsService,
    private readonly decisions: OperatorDecisionService,
    private readonly reports: OperatorReportService,
    private readonly logService: LogService,
  ) {}

  onModuleInit(): void {
    this.#listener = (e) => {
      void this.handleRestart(e).catch((err) => this.logService.warn('Voice', `restart resume report failed: ${err?.message ?? err}`));
    };
    activityEvents.on(AGENT_MANAGER_RESTART_RESUME_EVENT, this.#listener);
  }

  onModuleDestroy(): void {
    if (this.#listener) activityEvents.removeListener(AGENT_MANAGER_RESTART_RESUME_EVENT, this.#listener);
    this.#listener = null;
  }

  /** 끊긴 세션을 기록하고 operator 에게 보고한다. 보고를 받은 operator 가 있었던 세션 수를 돌려준다. */
  async handleRestart(e: RestartResumeEvent, now = Date.now()): Promise<number> {
    this.prune(now);
    if (!e?.manager_id || !e.sessions?.length) return 0;
    const host = await this.dataSource.getRepository(RuntimeHost).findOne({ where: { id: e.manager_id } }).catch(() => null);
    const managerName = host?.name || e.manager_id.slice(0, 8);
    const lang = announcementLanguage((await loadVoiceConfig(this.dataSource)).stt.languages);
    let reported = 0;
    for (const s of e.sessions) {
      const execution = await this.dataSource.getRepository(AgentSessionExecution)
        .findOne({ where: { manager_id: e.manager_id, cli: s.cli, session_id: s.session_id } });
      // AWB 가 연 세션만 매니저에 라이브 턴이 있다 — 실행 기록이 없으면 누구 계정으로 이을지 모른다.
      if (!execution) {
        this.logService.warn('Voice', `interrupted session ${e.manager_id.slice(0, 8)}/${s.cli}/${s.session_id.slice(0, 8)} has no AWB execution — not reported`);
        continue;
      }
      const userId = this.sessions.liveSnapshot(e.manager_id, s.cli, s.session_id)?.driver_user_id || '';
      this.#interrupted.set(sessionKey(e.manager_id, s.cli, s.session_id), {
        account_id: execution.account_id, user_id: userId, interrupted_at: now, resumed: false,
      });
      const delivered = await this.reports.submit({
        kind: 'interrupted',
        user_id: userId,
        session: {
          manager_id: e.manager_id,
          manager_name: managerName,
          cli: s.cli,
          cli_label: cliDescriptor(s.cli)?.label || s.cli,
          session_id: s.session_id,
          title: s.title,
          cwd: s.cwd,
        },
        detail: interruptionDetail(s, e, lang, now),
        duration_ms: null,
        at: now,
      });
      if (delivered) reported += 1;
    }
    this.logService.info('Voice', `${e.sessions.length} session(s) interrupted by the ${e.reason} of ${managerName} — ${reported} reported to an operator`, {
      manager_id: e.manager_id, from_version: e.from_version, to_version: e.to_version,
    });
    return reported;
  }

  /** operator(MCP) — 끊긴 세션을 고정된 재개 문구로 잇는다. */
  async resume(
    caller: DecisionCaller | undefined,
    input: { manager_id: string; cli: string; session_id: string },
    now = Date.now(),
  ): Promise<{ resumed: true; turn_id: string }> {
    const operator = await this.decisions.operatorFor(caller);
    const { manager_id: managerId, cli, session_id: sessionId } = input;
    if (!managerId || !cli || !sessionId) throw new InterruptedSessionError(400, 'target_required', 'manager_id, cli and session_id are required.');
    if (operator.manager_id === managerId && operator.cli === cli && operator.session_id === sessionId) {
      throw new InterruptedSessionError(409, 'own_session', 'That is your own session — you are already running again. Carry on with the interrupted work in this turn if it still matters.');
    }
    this.prune(now);
    const key = sessionKey(managerId, cli, sessionId);
    const entry = this.#interrupted.get(key);
    if (!entry) {
      throw new InterruptedSessionError(404, 'not_interrupted',
        'AWB has no record of a restart cutting that session off (or it was more than 6 hours ago). Use propose_session_prompt for new work.');
    }
    if (entry.resumed) throw new InterruptedSessionError(409, 'already_resumed', 'That session was already resumed after this restart.');
    const lang = announcementLanguage((await loadVoiceConfig(this.dataSource)).stt.languages);
    const userId = entry.user_id || this.sessions.liveSnapshot(managerId, cli, sessionId)?.driver_user_id || operator.created_by;
    entry.resumed = true;
    try {
      const { turn_id } = await this.sessions.promptOnBehalf(entry.account_id, userId, managerId, cli, sessionId, composeResumePrompt(lang));
      this.logService.info('Voice', `operator "${operator.name}" resumed ${managerId.slice(0, 8)}/${cli}/${sessionId.slice(0, 8)} after a manager restart`, { turn_id });
      return { resumed: true, turn_id };
    } catch (err: any) {
      // 바쁘면 이미 누군가 이어서 진행 중이다 — 그 경우만 다시 시도할 수 없게 둔다.
      if (err?.code !== 'session_busy') entry.resumed = false;
      throw new InterruptedSessionError(err?.status || 502, err?.code || 'resume_failed', err?.message || String(err));
    }
  }

  private prune(now: number): void {
    for (const [key, entry] of this.#interrupted) {
      if (now - entry.interrupted_at > INTERRUPTED_SESSION_TTL_MS) this.#interrupted.delete(key);
    }
  }
}
