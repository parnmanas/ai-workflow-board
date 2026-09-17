import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { SystemSetting } from '../entities/SystemSetting';
import { decrypt } from './encryption.service';

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_USERINFO_URL = 'https://www.googleapis.com/oauth2/v3/userinfo';
const SCOPES = 'openid email profile';

export interface GoogleUserInfo {
  sub: string;
  email: string;
  name: string;
  picture: string;
  email_verified: boolean;
}

@Injectable()
export class GoogleOAuthService {
  constructor(
    @InjectRepository(SystemSetting) private readonly settingRepo: Repository<SystemSetting>,
  ) {}

  private async getSetting(key: string): Promise<string> {
    const row = await this.settingRepo.findOne({ where: { key } });
    if (!row?.value) return '';
    return row.value;
  }

  async isEnabled(): Promise<boolean> {
    const val = await this.getSetting('oauth.google.enabled');
    return val === 'true';
  }

  async getClientId(): Promise<string> {
    return this.getSetting('oauth.google.client_id');
  }

  private async getClientSecret(): Promise<string> {
    const raw = await this.getSetting('oauth.google.client_secret');
    if (!raw) return '';
    return decrypt(raw);
  }

  /** Build the Google consent page URL and return it, or null if not configured. */
  async getAuthUrl(redirectUri: string, state: string): Promise<string | null> {
    if (!await this.isEnabled()) return null;
    const clientId = await this.getClientId();
    if (!clientId) return null;

    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: SCOPES,
      access_type: 'online',
      state,
    });
    return `${GOOGLE_AUTH_URL}?${params.toString()}`;
  }

  /** Exchange authorization code for access token, then fetch user info. */
  async exchangeCodeForUser(code: string, redirectUri: string): Promise<GoogleUserInfo | null> {
    const clientId = await this.getClientId();
    const clientSecret = await this.getClientSecret();
    if (!clientId || !clientSecret) return null;

    // Exchange code → tokens
    const tokenRes = await fetch(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
      }).toString(),
    });

    if (!tokenRes.ok) return null;
    const tokenData = await tokenRes.json() as any;
    const accessToken = tokenData?.access_token as string | undefined;
    if (!accessToken) return null;

    // Fetch user info
    const userRes = await fetch(GOOGLE_USERINFO_URL, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!userRes.ok) return null;

    return userRes.json() as Promise<GoogleUserInfo>;
  }
}
