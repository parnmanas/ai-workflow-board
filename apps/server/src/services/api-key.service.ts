import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { randomBytes } from 'crypto';
import { ApiKey } from '../entities/ApiKey';

@Injectable()
export class ApiKeyService {
  constructor(
    @InjectRepository(ApiKey) private readonly repo: Repository<ApiKey>,
  ) {}

  generateApiKey(): string {
    return 'awb_' + randomBytes(20).toString('hex');
  }

  maskKey(key: string): string {
    if (key.length <= 12) return key.slice(0, 4) + '***';
    return key.slice(0, 8) + '***' + key.slice(-4);
  }

  async createApiKey(params: {
    name: string;
    agent_id?: string | null;
    scope?: string;
    expires_at?: Date | null;
    workspace_id?: string;
  }) {
    const rawKey = this.generateApiKey();
    const entity = this.repo.create({
      name: params.name,
      key: rawKey,
      agent_id: params.agent_id ?? null,
      scope: params.scope || 'full',
      expires_at: params.expires_at ?? null,
      workspace_id: params.workspace_id || '',
    });
    const saved = await this.repo.save(entity);
    const { key, ...rest } = saved;
    return {
      apiKey: { ...rest, key_masked: this.maskKey(key) },
      raw_key: rawKey,
    };
  }

  async listApiKeys(workspaceId?: string) {
    const where = workspaceId ? { workspace_id: workspaceId } : {};
    const keys = await this.repo.find({
      where,
      order: { created_at: 'DESC' },
      relations: ['agent'],
    });
    return keys.map(({ key, ...rest }) => ({
      ...rest,
      key_masked: this.maskKey(key),
    }));
  }

  async getApiKey(id: string) {
    const found = await this.repo.findOne({ where: { id }, relations: ['agent'] });
    if (!found) return null;
    const { key, ...rest } = found;
    return { ...rest, key_masked: this.maskKey(key) };
  }

  async revokeApiKey(id: string): Promise<boolean> {
    const found = await this.repo.findOne({ where: { id } });
    if (!found) return false;
    found.is_active = 0;
    await this.repo.save(found);
    return true;
  }

  /**
   * Bulk-revoke active apiKeys whose name starts with `namePrefix` and which
   * belong to the given agent. Used by the agent-manager apiKey provisioning
   * path so a rotation only invalidates the prior provisioner-issued key,
   * not user-minted keys an operator may have separately created for the
   * same agent.
   *
   * Returns the affected row count.
   */
  async revokeApiKeysByAgentAndNamePrefix(agentId: string, namePrefix: string): Promise<number> {
    const result = await this.repo
      .createQueryBuilder()
      .update()
      .set({ is_active: 0 })
      .where('agent_id = :agent_id AND is_active = :active AND name LIKE :prefix', {
        agent_id: agentId,
        active: 1,
        prefix: `${namePrefix}%`,
      })
      .execute();
    return result.affected ?? 0;
  }

  /**
   * Hard-delete every apiKey row for an agent matching a name prefix.
   * Use this for system-managed key paths (e.g., managed-agent
   * provisioning rotation) where the only reason a row exists is the
   * live secret — the moment we mint a replacement, the old row is
   * useless and the audit trail is captured in LogService instead.
   * Without hard-delete the table grew unbounded as every spawn /
   * restart minted a new row and only soft-revoked the previous,
   * leaving dozens of `is_active=0` rows per agent.
   *
   * Returns the affected row count.
   */
  async deleteApiKeysByAgentAndNamePrefix(agentId: string, namePrefix: string): Promise<number> {
    const result = await this.repo
      .createQueryBuilder()
      .delete()
      .where('agent_id = :agent_id AND name LIKE :prefix', {
        agent_id: agentId,
        prefix: `${namePrefix}%`,
      })
      .execute();
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
    agent_id?: string | null;
  }) {
    const found = await this.repo.findOne({ where: { id } });
    if (!found) return null;

    if (updates.name !== undefined) found.name = updates.name;
    if (updates.scope !== undefined) found.scope = updates.scope;
    if (updates.is_active !== undefined) found.is_active = updates.is_active;
    if (updates.expires_at !== undefined) found.expires_at = updates.expires_at;
    if (updates.agent_id !== undefined) found.agent_id = updates.agent_id;

    const saved = await this.repo.save(found);
    const { key, ...rest } = saved;
    return { ...rest, key_masked: this.maskKey(key) };
  }

  async validateApiKey(rawKey: string): Promise<{ valid: boolean; reason?: string; apiKey?: ApiKey }> {
    const found = await this.repo.findOne({
      where: { key: rawKey },
      relations: ['agent'],
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
