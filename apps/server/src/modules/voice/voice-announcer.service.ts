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

/**
 * 음성 알림(docs/voice-operator.md "음성 알림") — 일이 끝나면 AWB 가 먼저 말한다.
 *
 * 서버 이벤트를 듣고(세션 턴 종료·오류·확인 대기, 미션 종료·결정 대기) 말할 문장을 만들어
 * 대상 사용자에게 `voice_announcement` 로 보낸다. 소리는 **요청될 때 한 번** 합성한다 — 듣는
 * 화면이 없으면 엔진을 부르지 않는다. 보고 있는 화면에서 이미 읽고 있는 것(그 세션을 열어 둔 경우)은
 * 화면이 걸러 낸다.
 *
 * 이 이벤트는 UI 전용(user-only)이다 — agent-manager 는 구독하지 않는다(SSE contract 무관).
 */

/** 이보다 짧은 턴은 알리지 않는다 — 짧은 문답은 대개 화면을 보며 기다린 것이다. */
export const MIN_ANNOUNCED_TURN_MS = 30_000;
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

@Injectable()
export class VoiceAnnouncerService implements OnModuleInit, OnModuleDestroy {
  #store = new Map<string, StoredAnnouncement>();
  #answers = new TurnAnswerTracker();
  /** 세션 → 방금 끝난 턴의 답(같은 배치의 상태 패치가 곧바로 뒤따른다). */
  #finishedTurn = new Map<string, FinishedTurnAnswer>();
  #turnStartedAt = new Map<string, number>();
  #lastNeedsInputAt = new Map<string, number>();
  #listeners: Array<[string, (...args: any[]) => void]> = [];

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly voice: VoiceService,
    private readonly logService: LogService,
    private readonly rebac: ReBACService,
  ) {}

  onModuleInit(): void {
    this.listen('agent_session_event', (e) => this.onSessionEvent(e));
    this.listen('agent_session_update', (e) => this.onSessionUpdate(e));
    this.listen('orchestration_update', (e) => this.onMissionUpdate(e));
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

  private onSessionEvent(e: any): void {
    if (!e?.event) return;
    const finished = this.#answers.push(e.event);
    if (finished) this.#finishedTurn.set(sessionKey(e.manager_id, e.cli, e.session_id), finished);
  }

  private async onSessionUpdate(e: any): Promise<void> {
    const session = e?.session;
    const userId: string | undefined = e?.driver_user_id || session?.driver_user_id;
    if (!session || !userId) return;
    const key = sessionKey(session.manager_id, session.cli, session.session_id);
    const reason = String(e.reason || '');
    const now = Date.now();

    if (reason === 'turn_started' || reason === 'prompt') {
      if (!this.#turnStartedAt.has(key)) this.#turnStartedAt.set(key, now);
      return;
    }

    let kind: AnnouncementKind | null = null;
    let answer: string | null = null;
    if (reason === 'turn_finished' || reason === 'turn_failed') {
      const startedAt = this.#turnStartedAt.get(key);
      this.#turnStartedAt.delete(key);
      const finished = this.#finishedTurn.get(key) ?? null;
      this.#finishedTurn.delete(key);
      if (finished?.stopReason === 'cancelled') return; // 사용자가 멈춘 턴
      // 시작 시각을 모르면(서버가 턴 도중에 재시작) 길었다고 본다 — 놓치는 쪽보다 한 번 더 말하는 쪽이 낫다.
      const long = startedAt === undefined || now - startedAt >= MIN_ANNOUNCED_TURN_MS;
      if (reason === 'turn_finished') {
        if (!long) return;
        kind = 'session_turn_finished';
        answer = finished?.answer || null;
      } else {
        kind = 'session_turn_failed';
      }
    } else if (session.status === 'awaiting_permission' || session.status === 'awaiting_input') {
      const last = this.#lastNeedsInputAt.get(key) ?? 0;
      if (now - last < NEEDS_INPUT_COOLDOWN_MS) return;
      this.#lastNeedsInputAt.set(key, now);
      kind = 'session_needs_input';
    } else if (reason === 'closed' || reason === 'process_exit') {
      this.#turnStartedAt.delete(key);
      this.#lastNeedsInputAt.delete(key);
      return;
    }
    if (!kind) return;

    const config = await loadVoiceConfig(this.dataSource);
    if (!(await this.ttsReady())) return;
    const text = sessionAnnouncementText(kind as Extract<AnnouncementKind, `session_${string}`>, {
      hostName: session.manager_name || String(session.manager_id || '').slice(0, 8),
      cliLabel: cliDescriptor(session.cli)?.label || session.cli,
      title: session.title || '',
      answer,
    }, announcementLanguage(config.stt.languages));
    this.announce([userId], kind, text, {
      type: 'session',
      manager_id: session.manager_id,
      cli: session.cli,
      session_id: session.session_id,
    });
  }

  // ─── 미션 ────────────────────────────────────────────────────────────────

  private async onMissionUpdate(e: any): Promise<void> {
    const eventType = String(e?.last_event?.type || '');
    const kind = MISSION_EVENT_KINDS[eventType];
    if (!kind || !e?.mission_id || e.deleted) return;
    if (!(await this.ttsReady())) return;
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
    this.announce(recipients, kind, text, { type: 'mission', workspace_id: mission.workspace_id, mission_id: mission.id });
  }

  /**
   * 사람이 만든 미션은 그 사람에게. 에이전트가 만든 미션은 사람 소유자가 없으므로 워크스페이스 owner 에게
   * (확인 게이트 알림 `orchestration-confirm-notify.service.ts` 와 같은 출발점이되, 소리는 member 전원까지
   * 넓히지 않는다 — 말소리는 채팅 알림보다 훨씬 거슬린다).
   */
  private async missionRecipients(mission: any): Promise<string[]> {
    if (mission.created_by_type === 'user' && mission.created_by) return [mission.created_by];
    const owners = await this.rebac.listSubjects({ type: 'workspace', id: mission.workspace_id }, 'owner');
    return Array.from(new Set(owners.filter((s: any) => s.type === 'user' && !!s.id).map((s: any) => s.id)));
  }

  // ─── 발행 · 소리 ─────────────────────────────────────────────────────────

  /** 소리를 낼 수 없으면 알리지 않는다 — 음성 알림이지 새 텍스트 알림 채널이 아니다. */
  private async ttsReady(): Promise<boolean> {
    try {
      return (await this.voice.status(false)).tts.ready;
    } catch {
      return false;
    }
  }

  private announce(userIds: string[], kind: AnnouncementKind, text: string, target: VoiceAnnouncementTarget): void {
    this.prune();
    for (const userId of userIds) {
      const payload: VoiceAnnouncementPayload = {
        id: randomUUID(),
        user_id: userId,
        kind,
        text,
        target,
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
