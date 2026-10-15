import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import { createHash, randomBytes } from 'crypto';
import { User } from '../../entities/User';
import { UserDevice } from '../../entities/UserDevice';
import { AuthService } from '../../services/auth.service';

const DEVICE_TOKEN_PREFIX = 'awbd_';

export function hashDeviceToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export interface DeviceSummary {
  id: string;
  name: string;
  platform: string;
  app_version: string;
  last_used_at: Date | null;
  created_at: Date;
}

/**
 * 앱 단말 자격(UserDevice) — 등록 · 세션 발급 · 회수.
 *
 * 단말 토큰은 사용자 세션을 다시 받는 데에만 쓴다. API 호출은 여전히 세션 토큰으로
 * 한다 — 단말 토큰이 새도 AuthGuard 를 직접 통과하지 못하고, 회수하면 즉시 끝난다.
 */
@Injectable()
export class DeviceAuthService {
  constructor(
    @InjectRepository(UserDevice) private readonly deviceRepo: Repository<UserDevice>,
    @InjectRepository(User) private readonly userRepo: Repository<User>,
    private readonly authService: AuthService,
  ) {}

  async register(
    userId: string,
    info: { name?: unknown; platform?: unknown; app_version?: unknown },
  ): Promise<{ device_id: string; device_token: string }> {
    const token = `${DEVICE_TOKEN_PREFIX}${randomBytes(32).toString('hex')}`;
    const row = this.deviceRepo.create({
      user_id: userId,
      name: clip(info.name, 120),
      platform: clip(info.platform, 32) || 'android',
      app_version: clip(info.app_version, 32),
      token_hash: hashDeviceToken(token),
      last_used_at: new Date(),
      revoked_at: null,
    });
    const saved = await this.deviceRepo.save(row);
    return { device_id: saved.id, device_token: token };
  }

  /** 살아 있는 단말 토큰이면 새 세션 토큰을 낸다. 회수됐거나 사용자가 막혔으면 null. */
  async mintSession(deviceToken: unknown, appVersion?: unknown): Promise<{ token: string; device_id: string } | null> {
    if (typeof deviceToken !== 'string' || !deviceToken.startsWith(DEVICE_TOKEN_PREFIX)) return null;
    const device = await this.deviceRepo.findOne({
      where: { token_hash: hashDeviceToken(deviceToken), revoked_at: IsNull() },
    });
    if (!device) return null;
    const user = await this.userRepo.findOne({ where: { id: device.user_id } });
    if (!user || (user as any).status !== 'active') return null;
    device.last_used_at = new Date();
    const version = clip(appVersion, 32);
    if (version) device.app_version = version;
    await this.deviceRepo.save(device);
    return { token: this.authService.createSession(user.id), device_id: device.id };
  }

  async revokeToken(deviceToken: unknown): Promise<boolean> {
    if (typeof deviceToken !== 'string' || !deviceToken.startsWith(DEVICE_TOKEN_PREFIX)) return false;
    const device = await this.deviceRepo.findOne({
      where: { token_hash: hashDeviceToken(deviceToken), revoked_at: IsNull() },
    });
    if (!device) return false;
    device.revoked_at = new Date();
    await this.deviceRepo.save(device);
    return true;
  }

  async revokeForUser(userId: string, deviceId: string): Promise<boolean> {
    const device = await this.deviceRepo.findOne({ where: { id: deviceId, user_id: userId, revoked_at: IsNull() } });
    if (!device) return false;
    device.revoked_at = new Date();
    await this.deviceRepo.save(device);
    return true;
  }

  async listForUser(userId: string): Promise<DeviceSummary[]> {
    const rows = await this.deviceRepo.find({
      where: { user_id: userId, revoked_at: IsNull() },
      order: { created_at: 'DESC' },
    });
    return rows.map((d) => ({
      id: d.id,
      name: d.name,
      platform: d.platform,
      app_version: d.app_version,
      last_used_at: d.last_used_at,
      created_at: d.created_at,
    }));
  }
}

function clip(v: unknown, max: number): string {
  return typeof v === 'string' ? v.trim().slice(0, max) : '';
}
