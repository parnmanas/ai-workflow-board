import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { OrchestrationMission } from '../../entities/OrchestrationMission';
import { OrchestrationStep } from '../../entities/OrchestrationStep';
import { LogService } from '../../services/log.service';
import { ReBACService } from '../../services/rebac.service';
import { UserChannelDispatcherService } from '../../services/notification-providers';
import { NotifyPayload } from '../../services/notification-providers/types';
import { AWAITING_USER_STATUS } from './orchestration.constants';
import { OrchestrationMissionService } from './orchestration-mission.service';

/**
 * 한 사람에게 보내는 데 허용하는 상한. providers 는 raw `fetch` 라 **요청 타임아웃이
 * 없다** — 응답하지 않는 Discord/Slack/Telegram 엔드포인트 하나가 이 호출을 영원히
 * 붙잡을 수 있다. 리퍼 스윕이 그걸 await 하면 스윕 자체가 영구 정지하므로 여기서 끊는다.
 */
const SEND_TIMEOUT_MS = 15_000;

/**
 * confirm 게이트가 열렸다는 사실을 **AWB 화면 밖으로** 내보낸다(티켓 a78cb566).
 *
 * ── 왜 필요한가 ────────────────────────────────────────────────────────────
 * confirm 노드(티켓 5dbe4aa2)는 타임아웃 없는 durable pause 다 — 리퍼가 죽이지 않고
 * 오케스트레이터도 깨우지 않는다. 그건 의도된 설계지만, 그 결과 **대기 사실을 아는
 * 유일한 방법이 사람이 미션 화면을 여는 것**이 됐다. 미션 헤더의 배지는 이미 화면을
 * 연 사람에게만 도달한다. confirm 은 정의상 사람이 답해야만 진행되는 유일한 상태라
 * "가만히 두면 언젠가 진행된다" 가 성립하지 않고, 따라서 아무도 안 보면 며칠이고 멈춘다.
 *
 * ── 왜 기존 UserChannel 경로를 그대로 쓰는가 ───────────────────────────────
 * 새 알림 채널을 만들지 않는다. `UserChannelDispatcherService` 가 이미 사용자별
 * discord/slack/telegram 바인딩으로 팬아웃하고 있고, discord 바인딩의 `target` 은
 * DM 뿐 아니라 채널 id 도 될 수 있다(UserChannel 엔티티 주석) — 즉 "푸시" 와
 * "Discord 채널" 이 이미 같은 한 경로로 커버된다.
 *
 * ── 왜 `notify_mention` 인가 ───────────────────────────────────────────────
 * 세 플래그의 UI 라벨이 판단 근거다: `notify_ticket` 은 "Ticket activity
 * (assigned/reported/reviewed)" 이고 Mission 은 **의도적으로 Ticket 이 아니다**
 * (OrchestrationMission 엔티티 상단 주석). 게다가 기본값이 0 이라 그 키를 쓰면 이
 * 기능이 기본 침묵으로 출시되어 티켓이 고치려는 실패 모드가 그대로 남는다.
 * `notify_mention` 은 "Mentions of me" — 시스템이 **당신을 콕 집어** 답을 요구하고
 * 그 답 없이는 일이 진행되지 않는다는 점에서 confirm 게이트는 미션 쪽 @-mention 에
 * 해당하고, 기본값이 1 이라 실제로 사람에게 닿는다.
 *
 * ── 실패 계약 ──────────────────────────────────────────────────────────────
 * 공개 메서드는 **절대 던지지 않는다**. `recordEvent` 와 같은 계약이다 — 알림 한 건을
 * 잃는 것이 게이트 오픈을 실패시키는 것보다 언제나 낫다. 게이트가 열리지 않으면 미션은
 * 사람이 답할 기회조차 얻지 못한다.
 */
@Injectable()
export class OrchestrationConfirmNotifyService {
  /**
   * 진행 중인 fire-and-forget 발송들. `openConfirmGate` 는 미션 락을 쥔 채로 불리므로
   * 발송을 **await 하지 않는다** — provider 에 타임아웃이 없어서, 한 번 매달리면 그
   * 미션의 락 체인이 통째로 멈추고 사용자가 판정을 제출하는 것조차 막힌다. 알림을
   * 못 보내는 것보다 훨씬 나쁜 결과다.
   *
   * 대신 여기에 담아 두고 `settled()` 로 기다릴 수 있게 한다(테스트·graceful shutdown).
   */
  private readonly inFlight = new Set<Promise<unknown>>();

  constructor(
    @InjectRepository(OrchestrationStep) private readonly stepRepo: Repository<OrchestrationStep>,
    private readonly dispatcher: UserChannelDispatcherService,
    private readonly rebac: ReBACService,
    private readonly missions: OrchestrationMissionService,
    private readonly logService: LogService,
  ) {}

  /**
   * 이 pass 의 최초 알림을 **DB 에서** 선점한다. 이긴 호출만 `true` 를 받고, 그 호출만
   * 발송한다. 진 호출은 아무것도 하지 않는다.
   *
   * ── 왜 읽고-판단하고-쓰기로는 안 되는가 ───────────────────────────────────
   * 프로세스 메모리의 미션 락은 **한 서버 안에서만** 유효하다. 운영(PostgreSQL)에서
   * 서버가 둘이면 두 pump 가 같은 pass 를 동시에 열 수 있고, 둘 다 "아직 안 보냈다"를
   * 읽은 뒤 둘 다 저장하고 둘 다 보낸다 — 사람에게 같은 질문이 두 번 울린다.
   * 승패를 애플리케이션이 아니라 **단일 UPDATE 의 WHERE 절**이 정하게 해서 막는다.
   *
   * ── 왜 발송 전에 쓰는가 ──────────────────────────────────────────────────
   * 발송 성공을 기다렸다가 쓰면 그 사이가 통째로 창(window)이다. 선점을 먼저 커밋하면
   * 최악의 경우가 "발송이 실패했는데 선점만 남는다"인데, 그건 리퍼의 리마인더 스윕이
   * 뒤에서 주워 간다 — 중복 발송보다 언제나 낫다.
   *
   * ── 실패 시 왜 `false` 인가(fail-closed) ─────────────────────────────────
   * `affected` 가 없거나 UPDATE 자체가 실패하면 **졌다고 본다**. 손에 든 낡은 스냅샷으로
   * 추측해 이겼다고 치면 두 경쟁자가 모두 승자가 되어 단일 승자 보장이 깨진다
   * (`ActionsService.completeRun` 이 같은 이유로 같은 선택을 한다). 여기서 지는 최악은
   * 알림 1회 유실이고 그건 회복 가능하다(리마인더 스윕).
   */
  async claimGateNotice(step: OrchestrationStep, visit: number): Promise<boolean> {
    return this.claim(step, visit, 'confirm_notified_visit', {
      confirm_notified_visit: visit,
      confirm_notified_at: new Date(),
    });
  }

  /**
   * 이 pass 의 리마인더를 선점한다. 여러 서버의 리퍼가 같은 주기에 스윕을 돌려도 한 번만
   * 나간다. `claimGateNotice` 와 같은 계약이다(발송 전 커밋, fail-closed, 던지지 않음).
   */
  async claimReminder(step: OrchestrationStep, visit: number): Promise<boolean> {
    return this.claim(step, visit, 'confirm_reminded_visit', { confirm_reminded_visit: visit });
  }

  /**
   * 선점 UPDATE 한 방. 조건 셋이 전부 DB 안에서 판정된다:
   *
   *   - `visit = :visit`   — 그 사이 loop 로 다음 pass 가 열렸으면 이 선점은 무효다.
   *   - `status = 'awaiting_user'` — 그 사이 사람이 판정을 제출했으면 보내지 않는다
   *                          (요구사항 4). 판정 후 침묵을 애플리케이션 검사가 아니라
   *                          선점 조건 자체가 보장한다.
   *   - `<column> IS NULL OR <column> <> :visit` — 이 pass 를 아직 아무도 선점하지 않았다.
   */
  private async claim(
    step: OrchestrationStep,
    visit: number,
    column: 'confirm_notified_visit' | 'confirm_reminded_visit',
    patch: Record<string, unknown>,
  ): Promise<boolean> {
    try {
      const result = await this.stepRepo
        .createQueryBuilder()
        .update(OrchestrationStep)
        .set(patch)
        .where('id = :id', { id: step.id })
        .andWhere('visit = :visit', { visit })
        .andWhere('status = :status', { status: AWAITING_USER_STATUS })
        .andWhere(`(${column} IS NULL OR ${column} <> :visit)`)
        .execute();
      return (result.affected ?? 0) > 0;
    } catch (e: any) {
      // 선점 실패가 게이트 오픈이나 리퍼 스윕을 죽이면 안 된다(요구사항 6). 알림만 잃는다.
      this.logService.warn(
        'Orchestration',
        `confirm notice claim failed for step ${step.step_key} (visit ${visit}): ${e?.message || e}`,
        { mission_id: step.mission_id },
      );
      return false;
    }
  }

  /**
   * 게이트가 열렸음을 알린다 — **동기 반환**이고 발송은 배경에서 끝난다.
   *
   * 호출자(`openConfirmGate`)는 `claimGateNotice` 로 이 pass 를 이긴 뒤에만 부른다. 즉
   * 중복 방지는 이 메서드가 아니라 **DB 가 판정한 선점**이 보장한다 — 발송이 배경에서
   * 도는 동안 pump 가 다시 돌든 다른 서버가 같은 pass 를 열든, 두 번째 선점이 실패한다.
   */
  scheduleGateNotice(mission: OrchestrationMission, step: OrchestrationStep): void {
    this.track(this.send(mission, step, 'initial', 0));
  }

  /**
   * 장기 미응답 리마인더(요구사항 5). **알림일 뿐 상태 전이가 아니다** — 리퍼가 미션을
   * 죽이지 않는다는 계약은 그대로다. 리퍼는 미션 락을 쥐고 있지 않으므로 await 해도
   * 안전하고, 상한(`SEND_TIMEOUT_MS`)이 걸려 있어 스윕이 매달리지 않는다.
   *
   * 호출자는 `claimReminder` 로 이 pass 를 이긴 뒤에만 부른다 — 여러 서버의 리퍼가 같은
   * 주기에 돌아도 실제 발송은 한 번이다.
   */
  async sendReminder(
    mission: OrchestrationMission,
    step: OrchestrationStep,
    waitedMs: number,
  ): Promise<{ recipients: number; sent: number; failed: number }> {
    return this.send(mission, step, 'reminder', waitedMs);
  }

  /** 진행 중인 모든 배경 발송이 끝날 때까지 기다린다(테스트·종료 시). 던지지 않는다. */
  async settled(): Promise<void> {
    while (this.inFlight.size > 0) {
      await Promise.allSettled(Array.from(this.inFlight));
    }
  }

  private track(p: Promise<unknown>): void {
    const wrapped = p.catch(() => undefined).finally(() => this.inFlight.delete(wrapped));
    this.inFlight.add(wrapped);
  }

  private async send(
    mission: OrchestrationMission,
    step: OrchestrationStep,
    kind: 'initial' | 'reminder',
    waitedMs: number,
  ): Promise<{ recipients: number; sent: number; failed: number }> {
    const result = { recipients: 0, sent: 0, failed: 0 };
    try {
      const userIds = await this.resolveRecipients(mission);
      result.recipients = userIds.length;

      if (userIds.length > 0) {
        const payload = this.buildPayload(mission, step, kind, waitedMs);
        // dispatchForUser 는 provider 오류를 ok:false 로 삼키지만 바인딩 조회(DB)는
        // 던질 수 있다. 한 사람의 실패가 나머지 수신자를 막지 않도록 개별로 감싼다.
        await Promise.all(
          userIds.map(async (uid) => {
            try {
              const r = await withTimeout(
                this.dispatcher.dispatchForUser(uid, 'notify_mention', payload),
                SEND_TIMEOUT_MS,
              );
              result.sent += r.sent;
              result.failed += r.failed;
            } catch (e: any) {
              result.failed += 1;
              this.logService.warn(
                'Orchestration',
                `confirm gate ${kind} notice to user ${uid} failed: ${e?.message || e}`,
                { mission_id: mission.id },
              );
            }
          }),
        );
      }

      this.logService.info(
        'Orchestration',
        `confirm gate ${kind} notice for step ${step.step_key} (visit ${step.visit ?? 1}): ` +
          `recipients=${result.recipients} sent=${result.sent} failed=${result.failed}`,
        { mission_id: mission.id, workspace_id: mission.workspace_id },
      );

      await this.recordNotifiedEvent(mission, step, kind, result);
    } catch (e: any) {
      // 여기까지 온 예외는 수신자 해석(ReBAC 질의) 실패다. 게이트는 그대로 열려 있고
      // 미션 실행은 영향받지 않는다.
      this.logService.error(
        'Orchestration',
        `confirm gate ${kind} notice failed for mission ${mission.id}: ${e?.message || e}`,
      );
    }
    return result;
  }

  private async recordNotifiedEvent(
    mission: OrchestrationMission,
    step: OrchestrationStep,
    kind: 'initial' | 'reminder',
    result: { recipients: number; sent: number; failed: number },
  ): Promise<void> {
    await this.missions.recordEvent(mission, {
      type: 'confirm_notified',
      step_id: step.id,
      step_key: step.step_key,
      message:
        kind === 'reminder'
          ? `Reminder sent for "${step.title}" — ${result.sent} channel(s) reached`
          : `Notified ${result.recipients} recipient(s) that "${step.title}" needs a decision ` +
            `— ${result.sent} channel(s) reached`,
      actor_type: 'system',
      data: {
        kind,
        visit: step.visit ?? 1,
        recipients: result.recipients,
        sent: result.sent,
        failed: result.failed,
      },
    });
  }

  /**
   * 누구에게 보낼 것인가.
   *
   * 1순위는 **미션 소유자**다 — REST 로 만든 미션은 `created_by_type='user'` 이고
   * `created_by` 가 그 사람의 user id 다(`orchestration.controller.ts` 의 createMission).
   * 가장 정확한 수신자이고 팬아웃이 1명이라 소음이 없다.
   *
   * 에이전트가 MCP `create_orchestration_mission` 으로 만든 미션은 사람 소유자가 아예
   * 없다(`created_by` 가 agent id). 그 미션의 게이트도 사람이 답해야만 열리므로 여기서
   * 끊으면 티켓이 고치려는 침묵이 그대로 남는다 — 그래서 워크스페이스의 owner/member 로
   * 넓힌다. 넓혀도 실제 소음은 작다: 채널 바인딩이 없는 사용자는 `dispatchForUser` 가
   * 그 자리에서 no-op 이라 아무 데도 가지 않는다.
   */
  private async resolveRecipients(mission: OrchestrationMission): Promise<string[]> {
    if (mission.created_by_type === 'user' && mission.created_by) {
      return [mission.created_by];
    }
    const object = { type: 'workspace', id: mission.workspace_id };
    const [owners, members] = await Promise.all([
      this.rebac.listSubjects(object, 'owner'),
      this.rebac.listSubjects(object, 'member'),
    ]);
    return Array.from(
      new Set([...owners, ...members].filter((s) => s.type === 'user' && !!s.id).map((s) => s.id)),
    );
  }

  /**
   * 요구사항 2 — 미션명 · 질문 · 판정 화면 링크가 모두 들어간다.
   *
   * 질문은 confirm step 의 `instructions` 다. 비어 있으면 step 제목으로 대체한다:
   * 링크만 있고 무엇을 묻는지 없는 알림은 사람이 화면을 열게 만들지 못한다.
   */
  private buildPayload(
    mission: OrchestrationMission,
    step: OrchestrationStep,
    kind: 'initial' | 'reminder',
    waitedMs: number,
  ): NotifyPayload {
    const visit = step.visit ?? 1;
    const question = (step.instructions || '').trim() || step.title;
    const passNote = visit > 1 ? ` (pass ${visit})` : '';
    const lines = [`${step.title}${passNote}`, '', question];
    if (kind === 'reminder') {
      lines.push(
        '',
        `No decision has been submitted for ${formatDuration(waitedMs)} — the mission stays paused until you answer.`,
      );
    }
    return {
      title:
        kind === 'reminder'
          ? `Still waiting on your decision: ${mission.title}`
          : `Your decision is needed: ${mission.title}`,
      body: lines.join('\n').slice(0, 3500),
      url: this.missionUrl(mission),
    };
  }

  /**
   * 판정 화면 딥링크. `AWB_PUBLIC_URL` 이 없으면 링크 없이 보낸다 — 알림 자체는 여전히
   * "무엇이 왜 멈춰 있는지" 를 전달하므로 링크 부재로 발송을 포기하지 않는다. 경로는
   * 클라이언트 라우트(`App.tsx` 의 `orchestration/missions/:missionId`)와 같다.
   */
  private missionUrl(mission: OrchestrationMission): string | undefined {
    const base = process.env.AWB_PUBLIC_URL?.replace(/\/$/, '') || '';
    if (!base) return undefined;
    return `${base}/ws/${mission.workspace_id}/orchestration/missions/${mission.id}`;
  }
}

/** provider 에 요청 타임아웃이 없어서 여기서 상한을 건다. 타이머는 항상 해제한다. */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`notification send timed out after ${ms}ms`)), ms);
    timer.unref?.();
  });
  return Promise.race([p, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  }) as Promise<T>;
}

/** "3h 20m" 처럼 사람이 읽는 대기 시간. 알림 본문에만 쓰인다. */
function formatDuration(ms: number): string {
  const totalMinutes = Math.max(0, Math.floor(ms / 60_000));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours <= 0) return `${minutes}m`;
  return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
}
