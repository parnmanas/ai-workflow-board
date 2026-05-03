import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { UserChannel } from '../../entities/UserChannel';
import { encrypt, decrypt } from '../../services/encryption.service';
import {
  NotificationProviderRegistry,
  PROVIDER_IDS,
  ProviderId,
} from '../../services/notification-providers';

interface CreateChannelInput {
  provider: string;
  target: string;
  label?: string;
  credentials?: Record<string, string>;
  is_active?: number;
  notify_mention?: number;
  notify_chat?: number;
  notify_ticket?: number;
}

interface UpdateChannelInput {
  target?: string;
  label?: string;
  credentials?: Record<string, string>;
  is_active?: number;
  notify_mention?: number;
  notify_chat?: number;
  notify_ticket?: number;
}

/**
 * Public-shape view of UserChannel with credentials redacted.
 *
 * Bot tokens never round-trip through the API; PATCH treats `credentials`
 * as a partial overwrite (omit a key → keep current value).
 */
export interface PublicUserChannel {
  id: string;
  user_id: string;
  provider: string;
  target: string;
  label: string;
  is_active: number;
  notify_mention: number;
  notify_chat: number;
  notify_ticket: number;
  has_credentials: boolean;
  verified_at: string | null;
  created_at: string;
  updated_at: string;
}

@Injectable()
export class UserChannelsService {
  constructor(
    @InjectRepository(UserChannel) private readonly repo: Repository<UserChannel>,
    private readonly registry: NotificationProviderRegistry,
  ) {}

  list(userId: string): Promise<UserChannel[]> {
    return this.repo.find({ where: { user_id: userId }, order: { created_at: 'ASC' } });
  }

  async listPublic(userId: string): Promise<PublicUserChannel[]> {
    const rows = await this.list(userId);
    return rows.map((r) => this.toPublic(r));
  }

  async findOwned(userId: string, id: string): Promise<UserChannel> {
    const row = await this.repo.findOne({ where: { id, user_id: userId } });
    if (!row) throw new NotFoundException('Channel not found');
    return row;
  }

  async create(userId: string, input: CreateChannelInput): Promise<PublicUserChannel> {
    if (!input.provider || !this.registry.isSupported(input.provider)) {
      throw new BadRequestException(`Unsupported provider. Supported: ${PROVIDER_IDS.join(', ')}`);
    }
    if (!input.target || typeof input.target !== 'string') {
      throw new BadRequestException('target is required');
    }
    const credentials = this.encodeCredentials(input.credentials);
    const row = await this.repo.save(
      this.repo.create({
        user_id: userId,
        provider: input.provider,
        target: input.target.trim(),
        label: input.label || '',
        credentials,
        is_active: input.is_active ?? 1,
        notify_mention: input.notify_mention ?? 1,
        notify_chat: input.notify_chat ?? 1,
        notify_ticket: input.notify_ticket ?? 0,
        verified_at: null,
      }),
    );
    return this.toPublic(row);
  }

  async update(userId: string, id: string, input: UpdateChannelInput): Promise<PublicUserChannel> {
    const row = await this.findOwned(userId, id);
    if (input.target !== undefined) row.target = String(input.target).trim();
    if (input.label !== undefined) row.label = String(input.label);
    if (input.is_active !== undefined) row.is_active = input.is_active ? 1 : 0;
    if (input.notify_mention !== undefined) row.notify_mention = input.notify_mention ? 1 : 0;
    if (input.notify_chat !== undefined) row.notify_chat = input.notify_chat ? 1 : 0;
    if (input.notify_ticket !== undefined) row.notify_ticket = input.notify_ticket ? 1 : 0;

    if (input.credentials !== undefined) {
      // Merge: caller may PATCH only the bot_token without re-supplying
      // the rest of the credential blob. An explicitly-empty value means
      // "clear this credential field".
      const existing = this.decodeCredentials(row.credentials);
      const merged = { ...existing, ...input.credentials };
      for (const k of Object.keys(merged)) {
        if (merged[k] === '' || merged[k] === null || merged[k] === undefined) delete merged[k];
      }
      row.credentials = this.encodeCredentials(merged);
      // Credential change invalidates prior verification.
      row.verified_at = null;
    }
    if (input.target !== undefined) row.verified_at = null;

    const saved = await this.repo.save(row);
    return this.toPublic(saved);
  }

  async delete(userId: string, id: string): Promise<void> {
    const row = await this.findOwned(userId, id);
    await this.repo.delete(row.id);
  }

  /**
   * Run the provider's `test()` probe, mark the binding verified on success,
   * and return the result for the controller to surface.
   */
  async test(userId: string, id: string): Promise<{ success: boolean; error?: string }> {
    const row = await this.findOwned(userId, id);
    const provider = this.registry.get(row.provider);
    if (!provider) {
      return { success: false, error: `Provider "${row.provider}" is not implemented` };
    }
    const creds = this.decodeCredentials(row.credentials);
    const result = await provider.test(row.target, creds);
    if (result.ok) {
      row.verified_at = new Date();
      await this.repo.save(row);
      return { success: true };
    }
    return { success: false, error: result.error };
  }

  toPublic(row: UserChannel): PublicUserChannel {
    return {
      id: row.id,
      user_id: row.user_id,
      provider: row.provider,
      target: row.target,
      label: row.label,
      is_active: row.is_active,
      notify_mention: row.notify_mention,
      notify_chat: row.notify_chat,
      notify_ticket: row.notify_ticket,
      has_credentials: !!row.credentials,
      verified_at: row.verified_at ? row.verified_at.toISOString() : null,
      created_at: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
      updated_at: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at),
    };
  }

  listSupportedProviders(): { id: ProviderId; required_credentials: string[] }[] {
    // Right now every provider needs a single `bot_token`. Surfacing this as
    // a list lets the UI render provider-specific credential fields without
    // hardcoding a switch on provider id.
    return PROVIDER_IDS.map((id) => ({ id, required_credentials: ['bot_token'] }));
  }

  private encodeCredentials(creds: Record<string, string> | undefined | null): string {
    if (!creds || Object.keys(creds).length === 0) return '';
    return encrypt(JSON.stringify(creds));
  }

  private decodeCredentials(stored: string): Record<string, string> {
    if (!stored) return {};
    try {
      const json = decrypt(stored);
      const parsed = JSON.parse(json || '{}');
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }
}
