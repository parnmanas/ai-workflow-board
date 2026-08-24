import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { SystemSetting } from '../entities/SystemSetting';

// SystemSetting.key 값 — 별도 컬럼을 추가하는 대신 기존 글로벌 key/value 저장소를
// 재사용한다(ticket 0f638509). 인스턴스가 하나뿐이므로(Deployment 엔티티 문서 참고)
// 프로세스-로컬 캐시 + DB 백업만으로 재시작 생존 + 저비용 조회가 둘 다 성립한다.
const QUIESCED_KEY = 'instance.quiesced';
const QUIESCED_REASON_KEY = 'instance.quiesced_reason';

/**
 * 인스턴스 전역 fleet-dispatch quiesce 플래그 (ticket 0f638509 — live pull
 * import). true인 동안 트리거 발행(TriggerLoopService._emitTrigger), backlog
 * 승격(BacklogPromotionService.tryPromote), QA/Security/Workspace 스케줄
 * 틱, AgentAutostartService 기동을 전부 no-op으로 만든다 — 막 import된 도착지가
 * 아직 살아있는 소스와 동시에 같은 에이전트 fleet에 디스패치해 티켓을 중복
 * 처리하는 것을 막기 위함(설계 스케치 "quiesced 부팅" 참고).
 *
 * 운영자가 명시적으로 `setQuiesced(false)`를 호출하기 전까지는 서버가 몇 번을
 * 재시작해도 유지된다 — SystemSetting 행이 진실의 원천이고, 인메모리 캐시는
 * settings.controller.ts의 applyLiveSettingChange와 같은 자세로 "쓰기 시점에
 * 자기 캐시를 직접 갱신"할 뿐, TTL이나 폴링으로 재검증하지 않는다(이 서비스가
 * 유일한 쓰기 경로이므로 단일 프로세스 내에서는 항상 최신).
 */
@Injectable()
export class InstanceQuiesceService {
  private cached: boolean | null = null;

  constructor(
    @InjectRepository(SystemSetting) private readonly settingRepo: Repository<SystemSetting>,
  ) {}

  async isQuiesced(): Promise<boolean> {
    if (this.cached !== null) return this.cached;
    const row = await this.settingRepo.findOne({ where: { key: QUIESCED_KEY } });
    this.cached = row?.value === '1';
    return this.cached;
  }

  async setQuiesced(quiesced: boolean, reason: string = ''): Promise<void> {
    await this._upsert(
      QUIESCED_KEY,
      quiesced ? '1' : '0',
      'Instance-wide fleet-dispatch quiesce. While "1", no ticket triggers, schedules, or agent autostart fire. Cleared by an operator via the Migration admin page.',
    );
    if (quiesced && reason) {
      await this._upsert(QUIESCED_REASON_KEY, reason, 'Why the instance is currently quiesced.');
    } else if (!quiesced) {
      await this.settingRepo.delete({ key: QUIESCED_REASON_KEY });
    }
    this.cached = quiesced;
  }

  async getReason(): Promise<string> {
    const row = await this.settingRepo.findOne({ where: { key: QUIESCED_REASON_KEY } });
    return row?.value || '';
  }

  private async _upsert(key: string, value: string, description: string): Promise<void> {
    const existing = await this.settingRepo.findOne({ where: { key } });
    if (existing) {
      existing.value = value;
      await this.settingRepo.save(existing);
    } else {
      await this.settingRepo.save(this.settingRepo.create({ key, value, description, is_secret: 0 }));
    }
  }
}
