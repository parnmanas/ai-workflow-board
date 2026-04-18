import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { createHash } from 'crypto';
import { DataSource } from 'typeorm';
import { decrypt } from './encryption.service';

export interface EmbeddingResult {
  embedding: number[];
  model: string;
  dimensions: number;
}

// Pure helpers — no DB, no config. Kept as standalone exports so call sites
// that don't need config access (e.g. hashing request text before a cache
// lookup) can stay lightweight.

export function textHash(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

export function buildResourceText(resource: {
  name: string;
  description?: string;
  type?: string;
  url?: string;
  content?: string;
  tags?: string[] | string;
}): string {
  const parts: string[] = [];
  if (resource.name) parts.push(resource.name);
  if (resource.description) parts.push(resource.description);
  if (resource.type) parts.push(`Type: ${resource.type}`);
  if (resource.url) parts.push(`URL: ${resource.url}`);
  if (resource.content) parts.push(resource.content);
  const tags = Array.isArray(resource.tags)
    ? resource.tags
    : (() => { try { return JSON.parse(resource.tags || '[]'); } catch { return []; } })();
  if (tags.length > 0) parts.push(`Tags: ${tags.join(', ')}`);
  return parts.join('\n');
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  if (denominator === 0) return 0;
  return dotProduct / denominator;
}

/**
 * OpenAI embedding access with DB-backed config overrides.
 *
 * Two construction paths:
 *   - NestJS: injected via constructor (provider in SharedServicesModule)
 *   - Standalone (mcp-server.ts): `new EmbeddingService(dataSource)`
 *
 * Previously this module held a `let _dataSource = null` global and a
 * `setEmbeddingDataSource()` setter — three code paths had to remember to
 * hydrate it before first use, which is brittle on cold start.
 */
@Injectable()
export class EmbeddingService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  private async getDbSetting(key: string): Promise<string | null> {
    if (!this.dataSource?.isInitialized) return null;
    try {
      const repo = this.dataSource.getRepository('SystemSetting');
      const row = await repo.findOne({ where: { key } });
      return (row as any)?.value || null;
    } catch {
      return null;
    }
  }

  private async getConfig() {
    const dbProvider = await this.getDbSetting('embedding.provider');
    const dbApiKeyRaw = await this.getDbSetting('embedding.api_key');
    const dbModel = await this.getDbSetting('embedding.model');

    const dbApiKey = dbApiKeyRaw ? decrypt(dbApiKeyRaw) : '';
    const provider = (dbProvider || process.env.EMBEDDING_PROVIDER || 'none').toLowerCase();
    const apiKey = dbApiKey || process.env.OPENAI_API_KEY || '';
    const model = dbModel || process.env.EMBEDDING_MODEL || 'text-embedding-3-small';
    return { provider, apiKey, model };
  }

  async isEnabled(): Promise<boolean> {
    const { provider, apiKey } = await this.getConfig();
    return provider === 'openai' && !!apiKey;
  }

  async generateEmbedding(text: string): Promise<EmbeddingResult | null> {
    const { provider, apiKey, model } = await this.getConfig();

    if (provider !== 'openai' || !apiKey) return null;

    const truncated = text.slice(0, 8000);

    const res = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ input: truncated, model }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.error('[Embedding] OpenAI API error:', res.status, body);
      return null;
    }

    const json = await res.json();
    const embedding = json.data?.[0]?.embedding;
    if (!Array.isArray(embedding)) return null;

    return { embedding, model, dimensions: embedding.length };
  }
}
