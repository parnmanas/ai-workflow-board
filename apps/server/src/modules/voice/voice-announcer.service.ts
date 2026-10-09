import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import { activityEvents } from '../../services/activity.service';
import { LogService } from '../../services/log.service';
import { ReBACService } from '../../services/rebac.service';
import { cliDescriptor } from '../../common/cli-catalog';
import type { VoiceAnnouncementPayload, VoiceAnnouncementTarget } from '../../common/types/stream-events';
import {
  announcementLanguage,
  missionAnnouncementText,
  sessionAnnouncementText,
  type AnnouncementKind,
} from './announcement-text';
import { TurnAnswerTracker, type FinishedTurnAnswer } from './turn-answer';
import { loadVoiceConfig } from './voice-config';
import { VoiceError, VoiceService } from './voice.service';
import { cachedOperators, type OperatorEntry } from './operator-config';
import {
  elicitationDetail,
  isUrgentReport,
  routeOperators,
  permissionDetail,
  questionFields,
  type ReportedDecision,
  type ReportedDelegation,
  type ReportedRequest,
  type SessionReport,
  type SessionReportKind,
} from './operator-report';
import { OperatorReportService, type OperatorSummary } from './operator-report.service';
import { SPOKEN_SUMMARY_CHARS, toSpokenSummary } from './speakable';
import { VoicePresenceService } from './voice-presence.service';
import { VoiceSupportService } from './voice-support.service';

/**
 * 작업 알림(docs/voice-operator.md) — 작업 보고는 알림음, 사용자 대화 답변은 TTS.
 *
 * 세션(AWB 를 거쳐 연결된 Agent Session)의 턴 종료·오류·확인 대기는 **operator 에게 보고**한다
 * (`OperatorReportService`) — 같은 호스트의 operator, 없으면 가장 최근에 대화한 operator. operator 가 쓴
 * 요약이 사용자에게 `voice_announcement`(kind `operator_report`)로 간다. 화면은 선택한 알림음만 재생한다.
 * 사용자가 그 세션 화면을 보고 있으면(`VoicePresenceService`) 보고하지 않는다. 등록된 operator 가 없거나
 * 보고가 닿지 못하면 예전처럼 템플릿 문장으로 직접 알린다 — 조용히 버리지 않는다.
 *
 * 미션 종료·결정 대기는 템플릿 문장으로 직접 알린다. 소리는 **요청될 때 한 번** 합성한다 — 듣는 화면이
 * 없으면 엔진을 부르지 않는다.
 *
 * 이 이벤트는 UI 전용(user-only)이다 — agent-manager 는 구독하지 않는다(SSE contract 무관).
 */

/** operator 가 없을 때의 직접 알림에서, 이보다 짧은 턴은 알리지 않는다 — 짧은 문답은 대개 화면을 보며 기다린 것이다. */
export const MIN_ANNOUNCED_TURN_MS = 30_000;
/** operator 의 답을 알림 글로 옮길 때의 상한 — 첫 문단(요약)만, 이 길이까지. 상세는 operator 세션 화면에 있다. */
export const OPERATOR_SUMMARY_CHARS = SPOKEN_SUMMARY_CHARS;
/** 같은 세션의 "확인 필요" 를 이보다 자주 말하지 않는다(권한 요청이 연달아 올 때). */
const NEEDS_INPUT_COOLDOWN_MS = 60_000;
const ANNOUNCEMENT_TTL_MS = 2 * 60 * 60 * 1000;
const MAX_STORED_ANNOUNCEMENTS = 500;

const MISSION_EVENT_KINDS: Record<string, AnnouncementKind> = {
  mission_completed: 'mission_completed',
  mission_failed: 'mission_failed',
  mission_cancelled: 'mission_cancelled',
  confirm_notified: 'mission_needs_decision',
};

interface StoredAnnouncement extends VoiceAnnouncementPayload {
  expiresAt: number;
  audio: Promise<{ audio: Buffer; contentType: string }> | null;
}

const sessionKey = (managerId: string, cli: string, sessionId: string) => `${managerId}\u0000${cli}\u0000${sessionId}`;

const DIRECT_KIND: Record<SessionReportKind, Extract<AnnouncementKind, `session_${string}`>> = {
  finished: 'session_turn_finished',
  failed: 'session_turn_failed',
  needs_permission: 'session_needs_input',
  needs_input: 'session_needs_input',
};

/** 매니저가 중계한 요청 행 → 보고에 실을 요청(답을 전하는 데 필요한 id · 선택지 · 칸). */
function reportedRequest(pending: { type: string; payload: any }): ReportedRequest | undefined {
  const p = pending.payload || {};
  if (pending.type === 'permission_request' && typeof p.request_id === 'string') {
    return {
      kind: 'permission',
      id: p.request_id,
      title: String(p.title || '').trim(),
      options: Array.isArray(p.options)
        ? p.options.filter((o: any) => o && typeof o.option_id === 'string').map((o: any) => ({ option_id: o.option_id, name: String(o.name || o.option_id) }))
        : [],
      fields: [],
    };
  }
  if (pending.type === 'elicitation_request' && typeof p.elicitation_id === 'string') {
    return { kind: 'question', id: p.elicitation_id, title: String(p.message || '').trim(), options: [], fields: questionFields(p.schema) };
  }
  return undefined;
}

const findOperator = (operators: readonly OperatorEntry[], s: { manager_id: string; cli: string; session_id: string }) =>
  operators.find((op) => op.manager_id === s.manager_id && op.cli === s.cli && op.session_id === s.session_id) ?? null;

@Injectable()
export class VoiceAnnouncerService implements OnModuleInit, OnModuleDestroy {
  #store = new Map<string, StoredAnnouncement>();
  #answers = new TurnAnswerTracker();
  /** 세션 → 방금 끝난 턴의 답(같은 배치의 상태 패치가 곧바로 뒤따른다). */
  #finishedTurn = new Map<string, FinishedTurnAnswer>();
  #turnStartedAt = new Map<string, number>();
  /** 세션 → 지금(또는 방금) 도는 턴 id — operator 가 시킨 작업의 턴인지 알아보는 데 쓴다. */
  #turnIds = new Map<string, string>();
  #lastNeedsInputAt = new Map<string, number>();
  /** 세션 → 지금 사용자를 기다리는 요청(권한·질문)의 내용 — 보고에 무엇을 정해야 하는지 싣는다. */
  #pendingRequest = new Map<string, { type: string; payload: any }>();
  /** 세션 → 요청 id → 요청 행(결정 행이 오면 무엇을 정했는지 글로 만든다). */
  #requests = new Map<string, Map<string, { type: string; payload: any }>>();
  /** 세션 → 이번 턴에서 정해진 것들 — 턴이 끝나면 그 보고에 실려 operator 가 결과까지 안다. */
  #decisions = new Map<string, ReportedDecision[]>();
  #listeners: Array<[string, (...args: any[]) => void]> = [];

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly voice: VoiceService,
    private readonly logService: LogService,
    private readonly rebac: ReBACService,
    private readonly reports: OperatorReportService,
    private readonly presence: VoicePresenceService,
    private readonly support: VoiceSupportService,
  ) {}

  onModuleInit(): void {
    this.listen('agent_session_event', (e) => this.onSessionEvent(e));
    this.listen('agent_session_update', (e) => this.onSessionUpdate(e));
    this.listen('orchestration_update', (e) => this.onMissionUpdate(e));
    this.reports.onSummary((summary) => this.guard('operator summary', () => this.announceOperatorSummary(summary)));
    this.reports.onUndeliverable((list, reason) => this.guard('undelivered report', async () => {
      this.logService.info('Voice', `announcing ${list.length} session report(s) directly: ${reason}`);
      await this.announceReportsDirectly(list);
    }));
  }

  private guard(what: string, fn: () => Promise<unknown>): void {
    fn().catch((err) => this.logService.warn('Voice', `${what} failed: ${err?.message ?? err}`));
  }

  onModuleDestroy(): void {
    for (const [name, fn] of this.#listeners) activityEvents.removeListener(name, fn);
    this.#listeners = [];
  }

  private listen(name: string, handler: (e: any) => unknown): void {
    const fn = (e: any) => {
      Promise.resolve()
        .then(() => handler(e))
        .catch((err) => this.logService.warn('Voice', `announcement from ${name} failed: ${err?.message ?? err}`));
    };
    activityEvents.on(name, fn);
    this.#listeners.push([name, fn]);
  }

  // ─── 세션 ────────────────────────────────────────────────────────────────

  private async onSessionEvent(e: any): Promise<void> {
    const ev = e?.event;
    if (!ev) return;
    const key = sessionKey(e.manager_id, e.cli, e.session_id);
    if (ev.type === 'permission_request' || (ev.type === 'elicitation_request' && ev.payload?.mode !== 'url')) {
      this.#pendingRequest.set(key, { type: ev.type, payload: ev.payload });
      const id = String(ev.payload?.request_id || ev.payload?.elicitation_id || '');
      if (id) {
        if (!this.#requests.has(key)) this.#requests.set(key, new Map());
        this.#requests.get(key)!.set(id, { type: ev.type, payload: ev.payload });
      }
    } else if (ev.type === 'permission_decision' || ev.type === 'elicitation_decision') {
      const decision = this.decisionOf(key, ev.type, ev.payload);
      if (decision) {
        const list = this.#decisions.get(key) ?? [];
        list.push(decision);
        this.#decisions.set(key, list.slice(-10));
      }
    }
    const finished = this.#answers.push(ev);
    if (finished) this.#finishedTurn.set(key, finished);
    if (ev.type === 'turn' && ev.payload?.phase === 'started' && ev.turn_id) this.#turnIds.set(key, ev.turn_id);
    // operator 세션의 턴 — 지금 무슨 턴인지 기록하고(말로 받은 답을 전하는 도구의 근거), 사용자가 시작한 턴이면
    // "가장 최근에 대화한" 의 근거로 남긴다(AWB 가 보낸 보고 턴은 대화가 아니다).
    const phase = ev.type === 'turn' ? ev.payload?.phase : null;
    if ((phase === 'started' || phase === 'finished') && ev.turn_id) {
      const operator = findOperator(await cachedOperators(this.dataSource), e);
      if (operator) {
        this.reports.noteOperatorTurn(operator.id, ev.turn_id, phase);
        if (phase === 'started' && !this.reports.isReportTurn(ev.turn_id)) this.reports.noteConversation(operator.id);
      }
    }
  }

  private async onSessionUpdate(e: any): Promise<void> {
    const session = e?.session;
    // driver 가 없을 수 있다(서버 재시작 뒤 아무도 그 세션을 다시 열지 않았다). 그래도 operator 에게는 보고한다 —
    // 받을 사람은 그 operator 를 등록한 사용자가 된다(OperatorReportService). 직접 알림은 받을 사람이 있어야 한다.
    const userId: string = e?.driver_user_id || session?.driver_user_id || '';
    if (!session) return;
    const key = sessionKey(session.manager_id, session.cli, session.session_id);
    const reason = String(e.reason || '');
    const now = Date.now();

    if (reason === 'turn_started' || reason === 'prompt') {
      if (!this.#turnStartedAt.has(key)) this.#turnStartedAt.set(key, now);
      return;
    }
    const operator = findOperator(await cachedOperators(this.dataSource), session);
    const viewing = () => !!userId && this.presence.isViewing(userId, session.manager_id, session.cli, session.session_id);

    let kind: SessionReportKind | null = null;
    let detail = '';
    let durationMs: number | null = null;
    let request: ReportedRequest | undefined;
    let decisions: ReportedDecision[] = [];
    let turnId: string | null = null;
    if (reason === 'turn_finished' || reason === 'turn_failed') {
      const startedAt = this.#turnStartedAt.get(key);
      this.#turnStartedAt.delete(key);
      const finished = this.#finishedTurn.get(key) ?? null;
      this.#finishedTurn.delete(key);
      turnId = finished?.turnId ?? this.#turnIds.get(key) ?? null;
      this.#turnIds.delete(key);
      this.#pendingRequest.delete(key);
      this.#requests.delete(key);
      decisions = this.#decisions.get(key) ?? [];
      this.#decisions.delete(key);
      if (operator) {
        // operator 자신의 턴 — 보고 턴이면 그 답이 요약으로 나간다. 사용자와의 대화 턴이면, 사용자가 그 화면을
        // 떠나 있을 때 operator 의 답을 그대로 들려준다(operator 는 보고하지 않는다 — 그것이 보고 받는 쪽이다).
        if (await this.reports.handleOperatorUpdate(operator, reason, finished)) return;
        if (viewing()) return;
        if (reason === 'turn_finished') {
          if (finished && finished.stopReason !== 'cancelled' && finished.answer) {
            await this.announceOperator([userId], 'operator_reply', operator, finished.answer, {
              type: 'session', manager_id: session.manager_id, cli: session.cli, session_id: session.session_id,
            });
          }
          return;
        }
        await this.announceReportsDirectly([this.toReport('failed', userId, session, session.last_error || '', null, now)]);
        return;
      }
      if (finished?.stopReason === 'cancelled') return; // 사용자가 멈춘 턴
      // 시작 시각을 모르면(서버가 턴 도중에 재시작) 길이를 모른다 — null.
      durationMs = startedAt === undefined ? null : now - startedAt;
      kind = reason === 'turn_finished' ? 'finished' : 'failed';
      detail = reason === 'turn_finished' ? (finished?.answer || '') : (session.last_error || '');
    } else if (reason === 'async_question' || session.status === 'awaiting_permission' || session.status === 'awaiting_input') {
      const last = this.#lastNeedsInputAt.get(key) ?? 0;
      if (reason !== 'async_question' && now - last < NEEDS_INPUT_COOLDOWN_MS) return;
      this.#lastNeedsInputAt.set(key, now);
      kind = reason !== 'async_question' && session.status === 'awaiting_permission' ? 'needs_permission' : 'needs_input';
      const lang = announcementLanguage((await loadVoiceConfig(this.dataSource)).stt.languages);
      const pending = this.#pendingRequest.get(key);
      detail = !pending ? ''
        : pending.type === 'permission_request' ? permissionDetail(pending.payload, lang) : elicitationDetail(pending.payload, lang);
      request = pending ? reportedRequest(pending) : undefined;
      turnId = this.#turnIds.get(key) ?? null;
      if (operator) {
        // operator 자신이 사용자의 승인을 기다린다 — 다른 operator 를 거치지 않고 직접 알린다.
        if (!viewing()) await this.announceReportsDirectly([this.toReport(kind, userId, session, detail, null, now)]);
        return;
      }
    } else if (reason === 'closed' || reason === 'process_exit' || reason === 'host_offline') {
      this.#turnStartedAt.delete(key);
      this.#turnIds.delete(key);
      this.#lastNeedsInputAt.delete(key);
      this.#pendingRequest.delete(key);
      this.#requests.delete(key);
      this.#decisions.delete(key);
    }

    if (operator) {
      // 그 밖의 operator 상태 변화(열림·종료·하트비트) — 보고 턴의 정리와 줄 선 보고의 재전송을 맡긴다.
      await this.reports.handleOperatorUpdate(operator, reason, null);
      return;
    }
    if (!kind) return;
    // 사용자가 그 세션 화면을 보고 있어도 operator 에게는 보고한다 — operator 가 사이트의 흐름(결과·결정까지)을
    // 알게. 보고 있었다는 표시(viewed)가 붙은 보고는 소리로 전하지 않는다(사용자는 이미 보고 있다). 단 승인·질문은
    // 보고 있어도 알림음을 낸다. 선택지 설명과 음성 답변은 사용자가 자세한 내용을 요청한 뒤 시작한다.
    const decisionAwaited = kind === 'needs_permission' || kind === 'needs_input';
    // operator 가 시킨 작업의 턴이면 그 결과(또는 그 턴의 승인·질문)는 시킨 operator 에게 간다.
    const delegated = turnId ? await this.delegationFor(session, turnId) : undefined;
    const report: SessionReport = {
      ...this.toReport(kind, userId, session, detail, durationMs, now),
      ...(request ? { request } : {}),
      ...(decisions.length ? { decisions } : {}),
      ...(!decisionAwaited && viewing() ? { viewed: true } : {}),
      ...(delegated ? { delegated } : {}),
    };
    // 음성 지원 스위치가 그 사용자의 모든 단말에서 꺼져 있으면 세션 완료·오류를 operator 를 통해 전하지 않는다
    // (직접 알림으로 돌리지도 않는다 — 결과를 전하는 기능 자체를 끈 것이다). 예외 둘: operator 가 시킨 작업의 결과는
    // 그 operator 의 일이라 보내고(소리와 무관하게 받기로 한 것), 승인·질문 대기는 놓치면 15분 뒤 취소되므로 보낸다.
    // operator 가 없으면 스위치도 보이지 않는다 — 그때의 직접 알림은 이 스위치와 무관하다.
    const operators = !decisionAwaited && !delegated ? await cachedOperators(this.dataSource) : [];
    if (operators.length) {
      const who = userId || routeOperators(operators, session.manager_id)[0]?.created_by || '';
      if (who && !(await this.support.reportsEnabledFor(who))) {
        this.logService.debug('Voice', `voice support is off on every device of ${who.slice(0, 8)} — ${kind} of ${session.manager_id?.slice?.(0, 8)}/${session.cli}/${String(session.session_id).slice(0, 8)} not reported`);
        return;
      }
    }
    if (await this.reports.submit(report)) return;
    // 등록된 operator 가 없다 — 템플릿 문장으로 직접 알린다(보고 있는 것·짧은 턴은 말하지 않는다).
    if (report.viewed || (kind === 'finished' && durationMs !== null && durationMs < MIN_ANNOUNCED_TURN_MS)) return;
    await this.announceReportsDirectly([report]);
  }

  /** 이 턴이 operator 가 제안하고 사용자가 승인해 보낸 작업이었나(docs/voice-operator.md "작업 제안"). */
  private async delegationFor(session: any, turnId: string): Promise<ReportedDelegation | undefined> {
    try {
      const row: any = await this.dataSource.getRepository('AgentSessionPromptProposal').findOne({
        where: { manager_id: session.manager_id, cli: session.cli, session_id: session.session_id, delivered_turn_id: turnId },
      });
      return row ? { proposal_id: row.id, operator_id: row.operator_id, operator_name: row.operator_name, task: row.text } : undefined;
    } catch (err: any) {
      this.logService.debug('Voice', `delegated-task lookup failed: ${err?.message ?? err}`);
      return undefined;
    }
  }

  /** 결정 행 → 무엇을 정했는지. 요청 행을 못 봤으면(서버 재시작) 제목 없이 결과만. */
  private decisionOf(key: string, type: string, payload: any): ReportedDecision | null {
    const id = String(payload?.request_id || payload?.elicitation_id || '');
    const request = id ? this.#requests.get(key)?.get(id) : undefined;
    if (id) this.#requests.get(key)?.delete(id);
    const by = String(payload?.decided_by || 'user');
    if (type === 'permission_decision') {
      const options: any[] = Array.isArray(request?.payload?.options) ? request!.payload.options : [];
      const chosen = payload?.option_id ? options.find((o) => o?.option_id === payload.option_id) : null;
      const outcome = payload?.option_id ? String(chosen?.name || payload.option_id) : 'cancelled';
      return { kind: 'permission', title: String(request?.payload?.title || ''), outcome, by };
    }
    const action = String(payload?.action || '');
    const content = payload?.content && typeof payload.content === 'object' ? payload.content : null;
    const values = content ? Object.entries(content).map(([k, v]) => `${k}=${Array.isArray(v) ? v.join('/') : typeof v === 'object' ? JSON.stringify(v) : String(v)}`).join(', ') : '';
    return { kind: 'question', title: String(request?.payload?.message || ''), outcome: action === 'accept' ? (values || 'accepted') : action || 'cancelled', by };
  }

  private toReport(kind: SessionReportKind, userId: string, session: any, detail: string, durationMs: number | null, at: number): SessionReport {
    return {
      kind,
      user_id: userId,
      session: {
        manager_id: session.manager_id,
        manager_name: session.manager_name || String(session.manager_id || '').slice(0, 8),
        cli: session.cli,
        cli_label: cliDescriptor(session.cli)?.label || session.cli,
        session_id: session.session_id,
        title: session.title || '',
        cwd: session.cwd || '',
      },
      detail,
      duration_ms: durationMs,
      at,
    };
  }

  /** 템플릿 문장으로 직접 — operator 가 없거나, 보고가 operator 에게 닿지 못했을 때. */
  private async announceReportsDirectly(all: SessionReport[]): Promise<void> {
    const reports = all.filter((r) => !r.viewed); // 보고 있던 것은 말하지 않는다
    if (!reports.length) return;
    const lang = announcementLanguage((await loadVoiceConfig(this.dataSource)).stt.languages);
    for (const report of reports) {
      const kind = DIRECT_KIND[report.kind];
      const s = report.session;
      const text = sessionAnnouncementText(kind, {
        hostName: s.manager_name,
        cliLabel: s.cli_label,
        title: s.title,
        answer: report.kind === 'finished' ? report.detail : null,
      }, lang);
      this.announce([report.user_id], kind, text, { type: 'session', manager_id: s.manager_id, cli: s.cli, session_id: s.session_id });
    }
  }

  /** operator 가 보고를 요약했다 — 그 답을 사용자에게. 화면 이동은 결정이 필요한 세션이 먼저다. */
  private async announceOperatorSummary(summary: OperatorSummary): Promise<void> {
    // 사용자가 모두 화면에서 보고 있던 소식이면 operator 가 기록만 하고 소리로는 전하지 않는다.
    const unseen = summary.reports.filter((r) => !r.viewed);
    const focus = unseen.find(isUrgentReport) ?? unseen[unseen.length - 1];
    if (!focus) {
      this.logService.debug('Voice', `operator "${summary.operator.name}" took note of ${summary.reports.length} viewed report(s) — not spoken`);
      return;
    }
    if (!toSpokenSummary(summary.answer, OPERATOR_SUMMARY_CHARS)) {
      await this.announceReportsDirectly(unseen); // 읽을 말이 없는 답(코드뿐) — 템플릿으로
      return;
    }
    await this.announceOperator([summary.userId], 'operator_report', summary.operator, summary.answer, {
      type: 'session', manager_id: focus.session.manager_id, cli: focus.session.cli, session_id: focus.session.session_id,
    }, unseen.some(isUrgentReport));
  }

  private async announceOperator(
    userIds: string[],
    kind: Extract<AnnouncementKind, `operator_${string}`>,
    operator: OperatorEntry,
    answer: string,
    target: VoiceAnnouncementTarget,
    needsDecision = false,
  ): Promise<void> {
    if (kind === 'operator_reply' && !(await this.ttsReady())) return;
    // operator 의 답은 첫 문단(귀로 들을 요약)만 — 결과를 통째로 읽으면 길고 장황하다.
    const text = toSpokenSummary(answer, OPERATOR_SUMMARY_CHARS);
    if (!text) return;
    this.announce(userIds, kind, text, target, { id: operator.id, name: operator.name }, needsDecision);
  }

  // ─── 미션 ────────────────────────────────────────────────────────────────

  private async onMissionUpdate(e: any): Promise<void> {
    const eventType = String(e?.last_event?.type || '');
    const kind = MISSION_EVENT_KINDS[eventType];
    if (!kind || !e?.mission_id || e.deleted) return;
    const mission: any = await this.dataSource.getRepository('OrchestrationMission').findOne({ where: { id: e.mission_id } });
    if (!mission) return;
    const recipients = await this.missionRecipients(mission);
    if (!recipients.length) return;
    let stepTitle: string | null = null;
    if (kind === 'mission_needs_decision' && e.last_event?.step_key) {
      const step: any = await this.dataSource.getRepository('OrchestrationStep')
        .findOne({ where: { mission_id: mission.id, step_key: e.last_event.step_key } });
      stepTitle = step?.title || e.last_event.step_key;
    }
    const config = await loadVoiceConfig(this.dataSource);
    const text = missionAnnouncementText(kind as Extract<AnnouncementKind, `mission_${string}`>, {
      title: mission.title || e.title || '',
      counts: e.counts,
      summary: kind === 'mission_completed' ? mission.result_summary : kind === 'mission_failed' ? (mission.failure_reason || mission.result_summary) : null,
      stepTitle,
    }, announcementLanguage(config.stt.languages));
    this.announce(recipients, kind, text, { type: 'mission', account_id: mission.account_id, mission_id: mission.id });
  }

  /**
   * 사람이 만든 미션은 그 사람에게. 에이전트가 만든 미션은 사람 소유자가 없으므로 워크스페이스 owner 에게
   * (확인 게이트 알림 `orchestration-confirm-notify.service.ts` 와 같은 출발점이되, 소리는 member 전원까지
   * 넓히지 않는다 — 말소리는 채팅 알림보다 훨씬 거슬린다).
   */
  private async missionRecipients(mission: any): Promise<string[]> {
    if (mission.created_by_type === 'user' && mission.created_by) return [mission.created_by];
    const owners = await this.rebac.listSubjects({ type: 'account', id: mission.account_id }, 'owner');
    return Array.from(new Set(owners.filter((s: any) => s.type === 'user' && !!s.id).map((s: any) => s.id)));
  }

  // ─── 발행 · 소리 ─────────────────────────────────────────────────────────

  /** TTS is required only for a conversational reply; work cues are generated in the browser. */
  private async ttsReady(): Promise<boolean> {
    try {
      return (await this.voice.status(false)).tts.ready;
    } catch {
      return false;
    }
  }

  private announce(
    userIds: string[],
    kind: AnnouncementKind,
    text: string,
    target: VoiceAnnouncementTarget,
    operator?: { id: string; name: string },
    needsDecision = false,
  ): void {
    this.prune();
    for (const userId of userIds.filter(Boolean)) { // 받을 사람을 모르는 소식(driver 없음)은 말하지 않는다
      const payload: VoiceAnnouncementPayload = {
        id: randomUUID(),
        user_id: userId,
        kind,
        text,
        target,
        ...(operator ? { operator } : {}),
        ...(needsDecision ? { needs_decision: true } : {}),
        created_at: new Date().toISOString(),
      };
      this.#store.set(payload.id, { ...payload, expiresAt: Date.now() + ANNOUNCEMENT_TTL_MS, audio: null });
      activityEvents.emit('voice_announcement', payload);
    }
  }

  private prune(): void {
    const now = Date.now();
    for (const [id, a] of this.#store) if (a.expiresAt <= now) this.#store.delete(id);
    while (this.#store.size >= MAX_STORED_ANNOUNCEMENTS) {
      const oldest = this.#store.keys().next().value;
      if (oldest === undefined) break;
      this.#store.delete(oldest);
    }
  }

  /** 알림의 소리. 받는 사람만, 처음 요청될 때 한 번 합성하고 이후에는 같은 바이트를 준다. */
  async audio(id: string, userId: string): Promise<{ audio: Buffer; contentType: string }> {
    const record = this.#store.get(id);
    if (!record || record.expiresAt <= Date.now() || record.user_id !== userId) {
      throw new VoiceError(404, 'voice_announcement_not_found', 'This announcement is gone or not yours.');
    }
    if (!record.audio) {
      const spoken = this.voice.speakable(record.text).join(' ');
      record.audio = this.voice.synthesize(spoken).then(({ audio, contentType }) => ({ audio, contentType }));
      // 실패한 합성을 붙들고 있지 않는다 — 다음 요청이 다시 시도한다.
      record.audio.catch(() => { if (this.#store.get(id) === record) record.audio = null; });
    }
    return record.audio;
  }
}
