/**
 * Resource (workspace/board-scoped document & embedding) MCP tools.
 *
 * Tools: list_resources, get_resource, save_resource, delete_resource,
 *        search_resources, embed_resources, list_repo_branches
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { Resource } from '../../../entities/Resource';
import { Credential } from '../../../entities/Credential';
import { ResourceEmbedding } from '../../../entities/ResourceEmbedding';
import { cosineSimilarity } from '../../../services/embedding.service';
import { ok, err } from '../shared/helpers';
import { parseResourceTags, resourceToJson, embedResource, inferResourceMimetype } from '../shared/resource-helpers';
import { listRepoBranches, resolveGitCredential } from '../shared/git-branches';
import type { ToolContext } from './context';

export function registerResourceTools(server: McpServer, ctx: ToolContext): void {
  const { dataSource, logger, embeddingService } = ctx;

  server.tool(
    'list_resources',
    'List resources in a workspace. Scope rule: omit board_id → returns ALL (workspace+board); ' +
    'pass board_id="" → workspace-scope only (board_id IS NULL); pass board_id=<uuid> → that board only. ' +
    'Types: repository, document, image, link, comment_attachment (auto-managed, hidden from default UI).',
    {
      workspace_id: z.string().describe('Workspace ID (required)'),
      board_id: z.string().optional().describe('"" → workspace-scope, <uuid> → board-scope, omit → all'),
      type: z.string().optional().describe('Filter by resource type: repository, document, image, link, comment_attachment'),
    },
    async ({ workspace_id, board_id, type }) => {
      const repo = dataSource.getRepository(Resource);
      const qb = repo.createQueryBuilder('r').where('r.workspace_id = :ws', { ws: workspace_id });
      if (board_id !== undefined) {
        if (board_id) qb.andWhere('r.board_id = :bid', { bid: board_id });
        else qb.andWhere('r.board_id IS NULL');
      }
      if (type) qb.andWhere('r.type = :t', { t: type });
      else qb.andWhere('r.type != :hidden', { hidden: 'comment_attachment' });
      const resources = await qb.orderBy('r.name', 'ASC').getMany();
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
    'Supports five types: repository (GitHub repos etc.), document (text content), image (base64 file or URL), link (general URLs), comment_attachment (file payload to be tagged into a comment). ' +
    'To attach a file to a comment from MCP: (1) call save_resource with type="comment_attachment" + file_data (base64) + file_name + file_mimetype, scoped to the same workspace as the target ticket; (2) pass the returned id in add_comment.attachment_resource_ids. Images render inline; videos render with an inline player; everything else renders as a download chip. ' +
    'Resources are automatically embedded for vector search when an embedding API is configured.',
    {
      workspace_id: z.string().describe('Workspace ID (required)'),
      id: z.string().optional().describe('Resource ID — omit to create, provide to update'),
      board_id: z.string().optional().describe('Board ID for board-scoped resources. Omit or null for workspace-level.'),
      name: z.string().describe('Resource name'),
      description: z.string().optional().describe('Short description'),
      type: z.enum(['repository', 'document', 'image', 'link', 'comment_attachment']).optional().default('link').describe('Resource type. Use comment_attachment for files you intend to attach to a comment via add_comment.attachment_resource_ids — they are hidden from the default Resources UI but linked from the comment that owns them.'),
      url: z.string().optional().describe('External URL (for repository/link/image types)'),
      content: z.string().optional().describe('Text content (for document type or notes)'),
      file_data: z.string().optional().describe('Base64-encoded file data (for image type)'),
      file_name: z.string().optional().describe('Original file name'),
      file_mimetype: z.string().optional().describe('File MIME type'),
      tags: z.array(z.string()).optional().describe('Tags for categorization'),
      default_branch: z.string().optional().describe('For type=repository: branch tickets default to when none is set on them. Empty string clears.'),
    },
    async ({ workspace_id, id, board_id, name, description, type, url, content, file_data, file_name, file_mimetype, tags, default_branch }) => {
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
        // Backfill mimetype when the caller left it empty but we have bytes
        // to sniff or a filename to parse — prevents the client viewer from
        // falling through to the octet-stream download branch.
        if (existing.file_data && !existing.file_mimetype) {
          existing.file_mimetype = inferResourceMimetype(existing.file_data, existing.file_name || existing.name);
        }
        if (board_id !== undefined) existing.board_id = board_id || null;
        if (tags !== undefined) existing.tags = JSON.stringify(tags);
        if (default_branch !== undefined) existing.default_branch = default_branch || '';
        const saved = await repo.save(existing);
        embedResource(dataSource, logger, embeddingService, saved).catch(() => {});
        return ok(resourceToJson(saved));
      }

      const effectiveFileData = file_data ?? '';
      const effectiveFileName = file_name ?? '';
      const effectiveMimetype = file_mimetype && file_mimetype.length > 0
        ? file_mimetype
        : (effectiveFileData ? inferResourceMimetype(effectiveFileData, effectiveFileName || name) : '');
      const created = repo.create({
        workspace_id,
        board_id: board_id || null,
        name: name.trim(),
        description: description ?? '',
        type: type ?? 'link',
        url: url ?? '',
        content: content ?? '',
        file_data: effectiveFileData,
        file_name: effectiveFileName,
        file_mimetype: effectiveMimetype,
        tags: JSON.stringify(tags ?? []),
        default_branch: default_branch ?? '',
      });
      const saved = await repo.save(created);
      embedResource(dataSource, logger, embeddingService, saved).catch(() => {});
      return ok(resourceToJson(saved));
    }
  );

  server.tool(
    'list_repo_branches',
    'List branches of a repository Resource via `git ls-remote --heads`. The Resource must be type="repository" and carry a URL. ' +
    'Branches sort with the Resource\'s `default_branch` (when set) pinned to the top. Used by the Ticket panel to populate the Base Branch picker, and by agents that want to verify a base_branch exists upstream before pinning it.',
    {
      workspace_id: z.string().describe('Workspace ID — scope boundary so the resource lookup is workspace-bounded'),
      resource_id: z.string().describe('Resource ID (must be type=repository)'),
    },
    async ({ workspace_id, resource_id }) => {
      const repo = dataSource.getRepository(Resource);
      const resource = await repo.findOne({ where: { id: resource_id, workspace_id } });
      if (!resource) return err('Resource not found in workspace');
      if (resource.type !== 'repository') return err(`resource type must be 'repository' (got '${resource.type}')`);
      if (!resource.url) return err("resource has no URL — set the repository's URL before listing branches");
      try {
        const credential = await resolveGitCredential(
          dataSource.getRepository(Credential),
          resource.credential_id,
          workspace_id,
        );
        const branches = await listRepoBranches({
          url: resource.url,
          credential,
          defaultBranch: resource.default_branch || '',
        });
        return ok({ branches, default_branch: resource.default_branch || '' });
      } catch (e: any) {
        return err(`failed to list branches: ${String(e?.message || e)}`);
      }
    },
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
