import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { randomBytes, createHash } from 'crypto';
import { ApiKey } from '../entities/ApiKey';

@Injectable()
export class ApiKeyService {
  constructor(
    @InjectRepository(ApiKey) private readonly repo: Repository<ApiKey>,
  ) {}

  generateApiKey(): string {
    return 'awb_' + randomBytes(20).toString('hex');
  }

  // SHA-256 (hex) of the raw key. This is what we persist and look up by — the
  // raw key is never stored (security finding: secrets). The keys are 160 bits
  // of CSPRNG output, so a plain (unsalted) hash is appropriate: there is no
  // low-entropy/dictionary surface to defend against, and a per-key salt would
  // make constant-time hash lookup impossible.
  hashKey(rawKey: string): string {
    return createHash('sha256').update(rawKey, 'utf8').digest('hex');
  }

  maskKey(key: string): string {
    if (key.length <= 12) return key.slice(0, 4) + '***';
    return key.slice(0, 8) + '***' + key.slice(-4);
  }

  async createApiKey(params: {
    name: string;
    host_id?: string | null;
    scope?: string;
    expires_at?: Date | null;
    workspace_id?: string;
  }) {
    const rawKey = this.generateApiKey();
    const entity = this.repo.create({
      name: params.name,
      // Persist ONLY the hash + a display hint. The raw key leaves this method
      // once (raw_key below) and is never recoverable from the DB afterwards.
      key: this.hashKey(rawKey),
      key_prefix: this.maskKey(rawKey),
      host_id: params.host_id ?? null,
      scope: params.scope || 'full',
      expires_at: params.expires_at ?? null,
      workspace_id: params.workspace_id || '',
    });
    const saved = await this.repo.save(entity);
    const { key, ...rest } = saved;
    return {
      apiKey: { ...rest, key_masked: saved.key_prefix || '' },
      raw_key: rawKey,
    };
  }

  async listApiKeys(workspaceId?: string) {
    const where = workspaceId ? { workspace_id: workspaceId } : {};
    // P4c-4: Agent relation 삭제 — join 없음 (표시는 agent_id/host_id 스칼라).
    const keys = await this.repo.find({
      where,
      order: { created_at: 'DESC' },
    });
    return keys.map(({ key, ...rest }) => ({
      ...rest,
      key_masked: rest.key_prefix || '',
    }));
  }

  async getApiKey(id: string) {
    const found = await this.repo.findOne({ where: { id } });
    if (!found) return null;
    const { key, ...rest } = found;
    return { ...rest, key_masked: rest.key_prefix || '' };
  }

  async revokeApiKey(id: string): Promise<boolean> {
    const found = await this.repo.findOne({ where: { id } });
    if (!found) return false;
    found.is_active = 0;
    await this.repo.save(found);
    return true;
  }

  async deleteApiKeysByHostAndNamePrefix(hostId: string, key: string, workspaceId?: string): Promise<number> {
    const query = this.repo
      .createQueryBuilder()
      .delete()
      .where('host_id = :host_id AND name LIKE :suffix', {
        host_id: hostId,
        suffix: `%:${key}`,
      });
    if (workspaceId !== undefined) query.andWhere('workspace_id = :workspace_id', { workspace_id: workspaceId });
    const result = await query.execute();
    return result.affected ?? 0;
  }

  async deleteApiKey(id: string): Promise<boolean> {
    const result = await this.repo.delete(id);
    return (result.affected ?? 0) > 0;
  }

  async updateApiKey(id: string, updates: {
    name?: string;
    scope?: string;
    is_active?: number;
    expires_at?: Date | null;
    host_id?: string | null;
  }) {
    const found = await this.repo.findOne({ where: { id } });
    if (!found) return null;

    if (updates.name !== undefined) found.name = updates.name;
    if (updates.scope !== undefined) found.scope = updates.scope;
    if (updates.is_active !== undefined) found.is_active = updates.is_active;
    if (updates.expires_at !== undefined) found.expires_at = updates.expires_at;
    if (updates.host_id !== undefined) found.host_id = updates.host_id;

    const saved = await this.repo.save(found);
    const { key, ...rest } = saved;
    return { ...rest, key_masked: rest.key_prefix || '' };
  }

  async validateApiKey(rawKey: string): Promise<{ valid: boolean; reason?: string; apiKey?: ApiKey }> {
    // Look up by hash of the presented key — the raw key is never stored.
    // P4c-4: agent relation 제거 (Agent 테이블 없음).
    const found = await this.repo.findOne({
      where: { key: this.hashKey(rawKey) },
    });

    if (!found) return { valid: false, reason: 'Key not found' };
    if (!found.is_active) return { valid: false, reason: 'Key is revoked' };
    if (found.expires_at && new Date(found.expires_at) < new Date()) return { valid: false, reason: 'Key is expired' };

    this.repo.update(found.id, {
      last_used_at: new Date(),
      use_count: () => 'use_count + 1',
    } as any).catch(() => {});

    return { valid: true, apiKey: found };
  }
}
