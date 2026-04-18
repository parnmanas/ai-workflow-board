/**
 * Resource (workspace/board-scoped document & embedding) MCP tools.
 *
 * Tools: list_resources, get_resource, save_resource, delete_resource,
 *        search_resources, embed_resources
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { Resource } from '../../../entities/Resource';
import { ResourceEmbedding } from '../../../entities/ResourceEmbedding';
import { cosineSimilarity } from '../../../services/embedding.service';
import { ok, err } from '../shared/helpers';
import { parseResourceTags, resourceToJson, embedResource } from '../shared/resource-helpers';
import type { ToolContext } from './context';

export function registerResourceTools(server: McpServer, ctx: ToolContext): void {
  const { dataSource, logger, embeddingService } = ctx;

  server.tool(
    'list_resources',
    'List resources in a workspace. Optionally filter by board_id or type (repository/document/image/link). ' +
    'Resources with board_id=null are workspace-level; those with a board_id are board-scoped.',
    {
      workspace_id: z.string().describe('Workspace ID (required)'),
      board_id: z.string().optional().describe('Board ID to filter board-scoped resources. Omit for workspace-level resources.'),
      type: z.string().optional().describe('Filter by resource type: repository, document, image, link'),
    },
    async ({ workspace_id, board_id, type }) => {
      const repo = dataSource.getRepository(Resource);
      const where: any = { workspace_id };
      if (board_id !== undefined) where.board_id = board_id || null;
      if (type) where.type = type;
      const resources = await repo.find({ where, order: { name: 'ASC' } });
      return ok(resources.map(resourceToJson));
    }
  );

  server.tool(
    'get_resource',
    'Get a single resource by ID with full content (including file_data if present).',
    {
      id: z.string().describe('Resource ID'),
    },
    async ({ id }) => {
      const repo = dataSource.getRepository(Resource);
      const resource = await repo.findOne({ where: { id } });
      if (!resource) return err('Resource not found');
      return ok({
        ...resource,
        tags: parseResourceTags(resource),
      });
    }
  );

  server.tool(
    'save_resource',
    'Create or update a resource. If `id` is provided → update; otherwise → create. ' +
    'Supports four types: repository (GitHub repos etc.), document (text content), image (base64 file or URL), link (general URLs). ' +
    'Resources are automatically embedded for vector search when an embedding API is configured.',
    {
      workspace_id: z.string().describe('Workspace ID (required)'),
      id: z.string().optional().describe('Resource ID — omit to create, provide to update'),
      board_id: z.string().optional().describe('Board ID for board-scoped resources. Omit or null for workspace-level.'),
      name: z.string().describe('Resource name'),
      description: z.string().optional().describe('Short description'),
      type: z.enum(['repository', 'document', 'image', 'link']).optional().default('link').describe('Resource type'),
      url: z.string().optional().describe('External URL (for repository/link/image types)'),
      content: z.string().optional().describe('Text content (for document type or notes)'),
      file_data: z.string().optional().describe('Base64-encoded file data (for image type)'),
      file_name: z.string().optional().describe('Original file name'),
      file_mimetype: z.string().optional().describe('File MIME type'),
      tags: z.array(z.string()).optional().describe('Tags for categorization'),
    },
    async ({ workspace_id, id, board_id, name, description, type, url, content, file_data, file_name, file_mimetype, tags }) => {
      const repo = dataSource.getRepository(Resource);
      if (!name || !name.trim()) return err('Resource name is required');

      if (id) {
        const existing = await repo.findOne({ where: { id, workspace_id } });
        if (!existing) return err('Resource not found in workspace');
        existing.name = name.trim();
        if (description !== undefined) existing.description = description;
        if (type !== undefined) existing.type = type;
        if (url !== undefined) existing.url = url;
        if (content !== undefined) existing.content = content;
        if (file_data !== undefined) existing.file_data = file_data;
        if (file_name !== undefined) existing.file_name = file_name;
        if (file_mimetype !== undefined) existing.file_mimetype = file_mimetype;
        if (board_id !== undefined) existing.board_id = board_id || null;
        if (tags !== undefined) existing.tags = JSON.stringify(tags);
        const saved = await repo.save(existing);
        embedResource(dataSource, logger, embeddingService, saved).catch(() => {});
        return ok(resourceToJson(saved));
      }

      const created = repo.create({
        workspace_id,
        board_id: board_id || null,
        name: name.trim(),
        description: description ?? '',
        type: type ?? 'link',
        url: url ?? '',
        content: content ?? '',
        file_data: file_data ?? '',
        file_name: file_name ?? '',
        file_mimetype: file_mimetype ?? '',
        tags: JSON.stringify(tags ?? []),
      });
      const saved = await repo.save(created);
      embedResource(dataSource, logger, embeddingService, saved).catch(() => {});
      return ok(resourceToJson(saved));
    }
  );

  server.tool(
    'delete_resource',
    'Delete a resource by ID. Also removes its vector embedding if one exists.',
    {
      workspace_id: z.string().describe('Workspace ID (required — scope boundary)'),
      id: z.string().describe('Resource ID'),
    },
    async ({ workspace_id, id }) => {
      const repo = dataSource.getRepository(Resource);
      const existing = await repo.findOne({ where: { id, workspace_id } });
      if (!existing) return err('Resource not found in workspace');
      await repo.delete({ id, workspace_id });
      const embRepo = dataSource.getRepository(ResourceEmbedding);
      await embRepo.delete({ resource_id: id });
      return ok({ success: true, id });
    }
  );

  server.tool(
    'search_resources',
    'Search resources using semantic vector similarity (when embedding API configured) or text matching (fallback). ' +
    'Returns resources ranked by relevance. Use this to find relevant documents, repos, images, or links.',
    {
      workspace_id: z.string().describe('Workspace ID (required)'),
      query: z.string().describe('Natural language search query'),
      board_id: z.string().optional().describe('Limit search to a specific board. Omit to search workspace-level resources.'),
      type: z.string().optional().describe('Filter by resource type'),
      limit: z.number().optional().default(10).describe('Max results to return (default: 10)'),
    },
    async ({ workspace_id, query, board_id, type, limit }) => {
      const repo = dataSource.getRepository(Resource);
      const where: any = { workspace_id };
      if (board_id !== undefined) where.board_id = board_id || null;
      if (type) where.type = type;
      const resources = await repo.find({ where, order: { name: 'ASC' } });

      if (resources.length === 0) return ok({ results: [], search_mode: 'none', total: 0 });

      // Try vector search first
      if (await embeddingService.isEnabled()) {
        const queryEmbedding = await embeddingService.generateEmbedding(query);
        if (queryEmbedding) {
          const embRepo = dataSource.getRepository(ResourceEmbedding);
          const resourceIds = resources.map(r => r.id);
          const embeddings = await embRepo
            .createQueryBuilder('e')
            .where('e.resource_id IN (:...ids)', { ids: resourceIds })
            .getMany();

          if (embeddings.length > 0) {
            const embMap = new Map(embeddings.map(e => [e.resource_id, e]));
            const scored = resources
              .filter(r => embMap.has(r.id))
              .map(r => {
                const emb = embMap.get(r.id)!;
                const vec = JSON.parse(emb.embedding);
                const score = cosineSimilarity(queryEmbedding.embedding, vec);
                return { resource: r, score };
              })
              .sort((a, b) => b.score - a.score)
              .slice(0, limit);

            return ok({
              results: scored.map(s => ({
                ...resourceToJson(s.resource),
                relevance_score: Math.round(s.score * 1000) / 1000,
              })),
              search_mode: 'vector',
              total: scored.length,
            });
          }
        }
      }

      // Fallback: text search
      const q = query.toLowerCase();
      const scored = resources
        .map(r => {
          let score = 0;
          if (r.name.toLowerCase().includes(q)) score += 3;
          if (r.description.toLowerCase().includes(q)) score += 2;
          if (r.content.toLowerCase().includes(q)) score += 1;
          if (r.url.toLowerCase().includes(q)) score += 1;
          const tags = parseResourceTags(r);
          if (tags.some((t: string) => t.toLowerCase().includes(q))) score += 2;
          return { resource: r, score };
        })
        .filter(s => s.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);

      return ok({
        results: scored.map(s => ({
          ...resourceToJson(s.resource),
          relevance_score: s.score,
        })),
        search_mode: 'text',
        total: scored.length,
      });
    }
  );

  server.tool(
    'embed_resources',
    'Trigger embedding generation for all resources in a workspace that do not yet have embeddings. ' +
    'Requires EMBEDDING_PROVIDER and OPENAI_API_KEY environment variables to be configured. ' +
    'Returns the count of newly embedded resources.',
    {
      workspace_id: z.string().describe('Workspace ID'),
    },
    async ({ workspace_id }) => {
      if (!(await embeddingService.isEnabled())) {
        return err('Embedding not configured. Set EMBEDDING_PROVIDER=openai and OPENAI_API_KEY env vars.');
      }
      const repo = dataSource.getRepository(Resource);
      const resources = await repo.find({ where: { workspace_id } });
      let embedded = 0;
      for (const resource of resources) {
        try {
          await embedResource(dataSource, logger, embeddingService, resource);
          embedded++;
        } catch (e: any) {
          logger.info('MCP', `Failed to embed resource ${resource.id}: ${e.message}`);
        }
      }
      return ok({ success: true, total: resources.length, embedded });
    }
  );
}
