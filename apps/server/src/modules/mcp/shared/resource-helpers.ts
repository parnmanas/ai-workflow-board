/**
 * Resource serialization + embedding helpers.
 *
 * Shared between resource-tools.ts and github-tools.ts (sync_github_resource
 * also auto-embeds and shapes output via `resourceToJson`).
 */

import type { DataSource } from 'typeorm';
import { Resource } from '../../../entities/Resource';
import { ResourceEmbedding } from '../../../entities/ResourceEmbedding';
import { EmbeddingService, buildResourceText, textHash } from '../../../services/embedding.service';
import type { McpLogger } from '../tools/context';

export function parseResourceTags(r: Resource): string[] {
  try { return JSON.parse(r.tags || '[]'); } catch { return []; }
}

/**
 * Compact JSON view of a resource for list/search responses. Truncates
 * content at 500 chars with ellipsis so agents don't accidentally stream
 * huge blobs through the tool response channel.
 */
export function resourceToJson(r: Resource) {
  return {
    id: r.id,
    workspace_id: r.workspace_id,
    board_id: r.board_id,
    name: r.name,
    description: r.description,
    type: r.type,
    url: r.url,
    content: r.content ? r.content.slice(0, 500) + (r.content.length > 500 ? '...' : '') : '',
    file_name: r.file_name,
    file_mimetype: r.file_mimetype,
    has_file: !!r.file_data,
    tags: parseResourceTags(r),
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

/**
 * Re-embed a resource iff the embedding provider is configured AND the
 * text's hash has changed. No-op otherwise. Safe to `.catch(() => {})` from
 * the caller.
 */
export async function embedResource(
  dataSource: DataSource,
  logger: McpLogger,
  embeddingService: EmbeddingService,
  resource: Resource,
): Promise<void> {
  if (!(await embeddingService.isEnabled())) return;
  const text = buildResourceText({
    name: resource.name,
    description: resource.description,
    type: resource.type,
    url: resource.url,
    content: resource.content,
    tags: resource.tags,
  });
  const hash = textHash(text);
  const embRepo = dataSource.getRepository(ResourceEmbedding);
  const existing = await embRepo.findOne({ where: { resource_id: resource.id } });
  if (existing && existing.text_hash === hash) return;

  const result = await embeddingService.generateEmbedding(text);
  if (!result) return;

  if (existing) {
    existing.embedding = JSON.stringify(result.embedding);
    existing.model = result.model;
    existing.dimensions = result.dimensions;
    existing.text_hash = hash;
    await embRepo.save(existing);
  } else {
    await embRepo.save(embRepo.create({
      resource_id: resource.id,
      embedding: JSON.stringify(result.embedding),
      model: result.model,
      dimensions: result.dimensions,
      text_hash: hash,
    }));
  }
  logger.info('MCP', `Embedded resource ${resource.id} (${resource.name})`);
}
