import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { randomBytes } from 'crypto';
import * as bcrypt from 'bcryptjs';
import { User } from '../entities/User';

interface Session {
  userId: string;
  expiresAt: Date;
}

const SALT_ROUNDS = 10;
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

@Injectable()
export class AuthService {
  private sessions = new Map<string, Session>();

  constructor(
    @InjectRepository(User) private readonly userRepo: Repository<User>,
  ) {
    // Clean expired sessions every 5 minutes
    setInterval(() => {
      const now = new Date();
      for (const [token, session] of this.sessions) {
        if (now > session.expiresAt) {
          this.sessions.delete(token);
        }
      }
    }, 5 * 60 * 1000);
  }

  async hashPassword(plain: string): Promise<string> {
    return bcrypt.hash(plain, SALT_ROUNDS);
  }

  async verifyPassword(plain: string, hash: string): Promise<boolean> {
    return bcrypt.compare(plain, hash);
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

  async login(email: string, password: string): Promise<{ token: string; user: any } | { error: string } | null> {
    const user = await this.userRepo
      .createQueryBuilder('user')
      .addSelect('user.password_hash')
      .where('user.email = :email', { email })
      .getOne();

    if (!user || !user.password_hash) return null;

    const valid = await this.verifyPassword(password, user.password_hash);
    if (!valid) return null;

    if ((user as any).status === 'pending') {
      return { error: 'Your account is pending admin approval' };
    }
    if ((user as any).status === 'rejected') {
      return { error: 'Your account has been rejected' };
    }

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
