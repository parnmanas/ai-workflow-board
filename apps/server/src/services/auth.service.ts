import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { randomBytes } from 'crypto';
import * as bcrypt from 'bcryptjs';
import { User } from '../entities/User';
import { MemoryMetricsRegistry } from './memory-metrics.registry';
import { LogService } from './log.service';

interface Session {
  userId: string;
  expiresAt: Date;
}

// 로그인 브루트포스 방어(M2) — IP와 이메일 각각을 키로 실패 횟수를 추적한다.
// 이메일 단독 추적만으로는 공격자가 IP를 바꿔가며 같은 계정을 계속 시도할 수
// 있고, IP 단독 추적만으로는 한 IP에서 여러 계정에 대한 스터핑을 놓칠 수 있어
// 둘 다 건다 — 둘 중 하나라도 잠금 상태면 로그인을 거부한다.
interface LoginAttemptState {
  count: number;
  firstAttemptAt: number;
  lockedUntil?: number;
}

const LOGIN_ATTEMPT_WINDOW_MS = 15 * 60 * 1000; // 15분 내 실패만 집계
const LOGIN_ATTEMPT_MAX = 5; // 이 횟수를 넘기면 잠금
const LOGIN_LOCKOUT_MS = 15 * 60 * 1000; // 잠금 유지 시간

const SALT_ROUNDS = 10;
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

@Injectable()
export class AuthService {
  private sessions = new Map<string, Session>();
  private loginAttemptsByEmail = new Map<string, LoginAttemptState>();
  private loginAttemptsByIp = new Map<string, LoginAttemptState>();

  constructor(
    @InjectRepository(User) private readonly userRepo: Repository<User>,
    metrics: MemoryMetricsRegistry,
    private readonly logService: LogService,
  ) {
    // Expose the live login-session count for memory observability.
    metrics.register('auth.sessions', () => this.sessions.size);
    // Clean expired sessions and stale login-attempt counters every 5 minutes
    setInterval(() => {
      const now = new Date();
      for (const [token, session] of this.sessions) {
        if (now > session.expiresAt) {
          this.sessions.delete(token);
        }
      }
      this._sweepAttempts(this.loginAttemptsByEmail);
      this._sweepAttempts(this.loginAttemptsByIp);
    }, 5 * 60 * 1000);
  }

  private _sweepAttempts(map: Map<string, LoginAttemptState>) {
    const now = Date.now();
    for (const [key, state] of map) {
      const stillLocked = state.lockedUntil !== undefined && now < state.lockedUntil;
      const windowFresh = now - state.firstAttemptAt <= LOGIN_ATTEMPT_WINDOW_MS;
      if (!stillLocked && !windowFresh) map.delete(key);
    }
  }

  /** 남은 잠금 시간(ms)을 반환한다. 잠겨있지 않으면 null. 만료된 항목은 정리한다. */
  private _remainingLockoutMs(map: Map<string, LoginAttemptState>, key: string): number | null {
    const state = map.get(key);
    if (!state) return null;
    const now = Date.now();
    if (state.lockedUntil !== undefined) {
      if (now < state.lockedUntil) return state.lockedUntil - now;
      map.delete(key); // 잠금 만료 — 리셋
      return null;
    }
    if (now - state.firstAttemptAt > LOGIN_ATTEMPT_WINDOW_MS) {
      map.delete(key); // 집계 윈도 만료 — 리셋
      return null;
    }
    return null;
  }

  private _recordLoginFailure(map: Map<string, LoginAttemptState>, key: string) {
    const now = Date.now();
    const state = map.get(key);
    if (!state || now - state.firstAttemptAt > LOGIN_ATTEMPT_WINDOW_MS) {
      map.set(key, { count: 1, firstAttemptAt: now });
      return;
    }
    state.count += 1;
    if (state.count >= LOGIN_ATTEMPT_MAX) {
      state.lockedUntil = now + LOGIN_LOCKOUT_MS;
    }
  }

  async hashPassword(plain: string): Promise<string> {
    return bcrypt.hash(plain, SALT_ROUNDS);
  }

  async verifyPassword(plain: string, hash: string): Promise<boolean> {
    return bcrypt.compare(plain, hash);
  }

  async verifyUserPassword(userId: string, plain: string): Promise<boolean> {
    const user = await this.userRepo
      .createQueryBuilder('user')
      .addSelect('user.password_hash')
      .where('user.id = :userId', { userId })
      .getOne();
    if (!user?.password_hash) return false;
    return this.verifyPassword(plain, user.password_hash);
  }

  generateSessionToken(): string {
    return randomBytes(32).toString('hex');
  }

  createSession(userId: string): string {
    const token = this.generateSessionToken();
    this.sessions.set(token, {
      userId,
      expiresAt: new Date(Date.now() + SESSION_TTL_MS),
    });
    return token;
  }

  validateSession(token: string): Session | null {
    const session = this.sessions.get(token);
    if (!session) return null;
    if (new Date() > session.expiresAt) {
      this.sessions.delete(token);
      return null;
    }
    return session;
  }

  destroySession(token: string): boolean {
    return this.sessions.delete(token);
  }

  async login(email: string, password: string, ip: string = 'unknown'): Promise<{ token: string; user: any } | { error: string; status?: number } | null> {
    // M2: 실패 카운터를 확인하기 전에 이메일/IP 둘 중 하나라도 잠금 상태면 바로
    // 거부한다 — 잠금 중에는 자격증명 검증(bcrypt.compare)조차 수행하지 않아
    // 잠금 우회를 노린 반복 요청의 비용도 낮게 유지한다.
    const emailKey = email.toLowerCase();
    const emailLockMs = this._remainingLockoutMs(this.loginAttemptsByEmail, emailKey);
    const ipLockMs = this._remainingLockoutMs(this.loginAttemptsByIp, ip);
    if (emailLockMs !== null || ipLockMs !== null) {
      this.logService.warn('Auth', `Login blocked — too many failed attempts (email=${emailKey}, ip=${ip})`);
      return { error: 'Too many failed login attempts. Please try again later.', status: 429 };
    }

    const user = await this.userRepo
      .createQueryBuilder('user')
      .addSelect('user.password_hash')
      .where('user.email = :email', { email })
      .getOne();

    const valid = user?.password_hash ? await this.verifyPassword(password, user.password_hash) : false;
    if (!user || !user.password_hash || !valid) {
      this._recordLoginFailure(this.loginAttemptsByEmail, emailKey);
      this._recordLoginFailure(this.loginAttemptsByIp, ip);
      this.logService.warn('Auth', `Failed login attempt (email=${emailKey}, ip=${ip})`);
      return null;
    }

    if ((user as any).status === 'pending') {
      return { error: 'Your account is pending admin approval' };
    }
    if ((user as any).status === 'rejected') {
      return { error: 'Your account has been rejected' };
    }

    // 로그인 성공 — 해당 이메일/IP의 실패 카운터를 리셋한다.
    this.loginAttemptsByEmail.delete(emailKey);
    this.loginAttemptsByIp.delete(ip);

    const token = this.createSession(user.id);
    const { password_hash, ...safeUser } = user as any;
    return { token, user: safeUser };
  }

  async getSessionUser(token: string): Promise<User | null> {
    const session = this.validateSession(token);
    if (!session) return null;
    return this.userRepo.findOne({ where: { id: session.userId } });
  }

  async needsSetup(): Promise<boolean> {
    const usersWithPassword = await this.userRepo
      .createQueryBuilder('user')
      .addSelect('user.password_hash')
      .where('user.password_hash IS NOT NULL AND user.password_hash != :empty', { empty: '' })
      .getCount();
    return usersWithPassword === 0;
  }
}
