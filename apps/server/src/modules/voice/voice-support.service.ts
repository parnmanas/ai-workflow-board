import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { LogService } from '../../services/log.service';

/**
 * 음성 지원 스위치(사이드바 OPERATORS 머리의 👂 on/off) 중 **서버가 알아야 하는 몫** — 세션이 끝났다는 소식을
 * operator 에게 보고할지(docs/voice-operator.md "음성 지원 · 잠들기").
 *
 * 스위치는 단말마다 따로다(듣는 것은 그 단말의 마이크다 — `apps/client/src/voice/wakeState.ts`). 그래서 단말마다
 * 상태를 받아 두고, 그 사용자의 **단말 중 하나라도 켜져 있으면** 보고한다. 모두 꺼져 있으면 세션 완료·오류를
 * operator 에게 보내지 않는다(2026-10-09 사용자 요청). 일주일 넘게 소식 없는 단말은 이 판단에서 빠지고, 남은
 * 단말이 없으면 마지막으로 알려 온 선택을 따른다. 한 번도 알려 온 적이 없으면 켜진 것으로 본다 — 스위치가 서버에
 * 닿기 전과 같은 동작이다.
 *
 * 배포마다 서버가 다시 뜨므로 메모리가 아니라 SystemSettings 에 둔다 — 다시 뜬 직후에 끝난 턴이 꺼 둔 사용자의
 * operator 에게 새어 들어가지 않게.
 */
export const VOICE_SUPPORT_SETTING_KEY = 'operator.voice_support_devices';
/** 이보다 오래 소식 없는 단말은 "하나라도 켜져 있나" 에서 뺀다. */
export const DEVICE_LIVE_MS = 7 * 24 * 60 * 60_000;
/** 이보다 오래된 단말은 잊는다. */
const DEVICE_FORGET_MS = 60 * 24 * 60 * 60_000;
const MAX_DEVICES_PER_USER = 10;
/** 같은 값이면 이 간격보다 자주 쓰지 않는다(시각만 새로 고친다). */
const TOUCH_WRITE_MS = 60 * 60_000;
const DEVICE_ID_MAX = 64;

export interface DeviceSupportState {
  enabled: boolean;
  at: number;
}

type Store = Record<string, Record<string, DeviceSupportState>>;

/** 이 사용자의 단말 상태들 → 세션 완료를 operator 에게 보고하는가. */
export function operatorReportsEnabled(devices: Record<string, DeviceSupportState> | undefined, now = Date.now()): boolean {
  const list = Object.values(devices ?? {});
  if (!list.length) return true;
  const live = list.filter((d) => now - d.at < DEVICE_LIVE_MS);
  if (live.length) return live.some((d) => d.enabled);
  return list.reduce((latest, d) => (d.at > latest.at ? d : latest)).enabled;
}

function sanitize(raw: unknown): Store {
  const out: Store = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [userId, devices] of Object.entries(raw as Record<string, unknown>)) {
    if (!userId || !devices || typeof devices !== 'object' || Array.isArray(devices)) continue;
    for (const [deviceId, state] of Object.entries(devices as Record<string, any>)) {
      if (!deviceId || deviceId.length > DEVICE_ID_MAX || typeof state?.enabled !== 'boolean' || !Number.isFinite(state?.at)) continue;
      (out[userId] ??= {})[deviceId] = { enabled: state.enabled, at: state.at };
    }
  }
  return out;
}

@Injectable()
export class VoiceSupportService {
  #store: Store | null = null;
  #chain: Promise<unknown> = Promise.resolve();

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly logService: LogService,
  ) {}

  private async load(): Promise<Store> {
    if (this.#store) return this.#store;
    const row: any = await this.dataSource.getRepository('SystemSetting').findOne({ where: { key: VOICE_SUPPORT_SETTING_KEY } });
    let parsed: unknown = {};
    try { parsed = row?.value ? JSON.parse(row.value) : {}; } catch { parsed = {}; }
    this.#store = sanitize(parsed);
    return this.#store;
  }

  private async save(store: Store): Promise<void> {
    const repo = this.dataSource.getRepository('SystemSetting');
    const value = JSON.stringify(store);
    const existing: any = await repo.findOne({ where: { key: VOICE_SUPPORT_SETTING_KEY } });
    if (existing) {
      existing.value = value;
      await repo.save(existing);
    } else {
      await repo.save(repo.create({ key: VOICE_SUPPORT_SETTING_KEY, value }));
    }
  }

  /** 단말 하나가 자기 스위치 상태를 알렸다(켤 때 · 끌 때 · 앱이 열릴 때). 알린 뒤의 판단을 돌려준다. */
  report(userId: string, deviceIdInput: string, enabled: boolean, now = Date.now()): Promise<boolean> {
    const deviceId = (deviceIdInput || '').trim().slice(0, DEVICE_ID_MAX);
    const run = this.#chain.then(async () => {
      const store = await this.load();
      const devices = { ...(store[userId] ?? {}) };
      const prev = devices[deviceId];
      devices[deviceId] = { enabled, at: now };
      const kept = Object.entries(devices)
        .filter(([, d]) => now - d.at < DEVICE_FORGET_MS)
        .sort(([, a], [, b]) => b.at - a.at)
        .slice(0, MAX_DEVICES_PER_USER);
      store[userId] = Object.fromEntries(kept);
      if (!prev || prev.enabled !== enabled || now - prev.at >= TOUCH_WRITE_MS) await this.save(store);
      const reports = operatorReportsEnabled(store[userId], now);
      if (!prev || prev.enabled !== enabled) {
        this.logService.info('Voice', `voice support ${enabled ? 'on' : 'off'} on a device — session reports to the operator ${reports ? 'continue' : 'stop'}`, {
          user_id: userId, device_id: deviceId.slice(0, 8),
        });
      }
      return reports;
    });
    this.#chain = run.catch(() => undefined);
    return run;
  }

  /** 이 사용자의 세션 완료·오류를 operator 에게 보고하는가. 읽지 못하면 켜진 것으로 본다(소식을 잃는 쪽을 피한다). */
  async reportsEnabledFor(userId: string, now = Date.now()): Promise<boolean> {
    try {
      return operatorReportsEnabled((await this.load())[userId], now);
    } catch (err: any) {
      this.logService.warn('Voice', `voice support state unreadable — reporting as before: ${err?.message ?? err}`);
      return true;
    }
  }
}
