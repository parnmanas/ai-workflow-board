import { createHash } from 'crypto';
import { DataSource } from 'typeorm';
import { decrypt } from './encryption.service';

export interface EmbeddingResult {
  embedding: number[];
  model: string;
  dimensions: number;
}

let _dataSource: DataSource | null = null;

export function setEmbeddingDataSource(ds: DataSource) {
  _dataSource = ds;
}

async function getDbSetting(key: string): Promise<string | null> {
  if (!_dataSource?.isInitialized) return null;
  try {
    const repo = _dataSource.getRepository('SystemSetting');
    const row = await repo.findOne({ where: { key } });
    return (row as any)?.value || null;
  } catch {
    return null;
  }
}

async function getConfig() {
  const dbProvider = await getDbSetting('embedding.provider');
  const dbApiKeyRaw = await getDbSetting('embedding.api_key');
  const dbModel = await getDbSetting('embedding.model');

  const dbApiKey = dbApiKeyRaw ? decrypt(dbApiKeyRaw) : '';
  const provider = (dbProvider || process.env.EMBEDDING_PROVIDER || 'none').toLowerCase();
  const apiKey = dbApiKey || process.env.OPENAI_API_KEY || '';
  const model = dbModel || process.env.EMBEDDING_MODEL || 'text-embedding-3-small';
  return { provider, apiKey, model };
}

export async function isEmbeddingEnabled(): Promise<boolean> {
  const { provider, apiKey } = await getConfig();
  return provider === 'openai' && !!apiKey;
}

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

export async function generateEmbedding(text: string): Promise<EmbeddingResult | null> {
  const { provider, apiKey, model } = await getConfig();

  if (provider !== 'openai' || !apiKey) return null;

  const truncated = text.slice(0, 8000);

  const res = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      input: truncated,
      model,
    }),
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
