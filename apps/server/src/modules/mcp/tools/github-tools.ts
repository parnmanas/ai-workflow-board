/**
 * GitHub connector MCP tools.
 *
 * Tools: fetch_github_info, sync_github_resource, search_github
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { Resource } from '../../../entities/Resource';
import {
  isGitHubEnabled, parseGitHubUrl, fetchRepoInfo, buildSyncContent,
  searchGitHubRepos, searchGitHubCode, searchGitHubIssues,
} from '../../../services/github-connector.service';
import { ok, err } from '../shared/helpers';
import { resourceToJson, embedResource } from '../shared/resource-helpers';
import type { ToolContext } from './context';

export function registerGitHubTools(server: McpServer, ctx: ToolContext): void {
  const { dataSource, logger } = ctx;

  server.tool(
    'fetch_github_info',
    'Fetch metadata about a GitHub repository (description, README, file tree, topics). ' +
    'Uses credential_id for auth if provided, otherwise falls back to global GitHub token.',
    {
      url: z.string().optional().describe('GitHub repository URL (e.g. https://github.com/owner/repo)'),
      owner: z.string().optional().describe('Repository owner (alternative to url)'),
      repo: z.string().optional().describe('Repository name (alternative to url)'),
      credential_id: z.string().optional().describe('Credential ID from workspace credentials (overrides global token)'),
    },
    async ({ url, owner, repo, credential_id }) => {
      if (!(await isGitHubEnabled(credential_id))) {
        return err('GitHub token not configured. Add a credential or set global token in Admin Settings.');
      }
      let o = owner;
      let r = repo;
      if (url) {
        const parsed = parseGitHubUrl(url);
        if (!parsed) return err('Invalid GitHub URL. Expected format: https://github.com/owner/repo');
        o = parsed.owner;
        r = parsed.repo;
      }
      if (!o || !r) return err('Provide either url or both owner and repo');

      try {
        const info = await fetchRepoInfo(o, r, credential_id);
        return ok(info);
      } catch (e: any) {
        return err(`GitHub API error: ${e.message}`);
      }
    }
  );

  server.tool(
    'sync_github_resource',
    'Sync a GitHub repository into a resource. Fetches repo metadata, README, and file tree, ' +
    'stores them as resource content, and auto-embeds for vector search. ' +
    'If resource_id is provided, updates the existing resource; otherwise creates a new one. ' +
    'Uses credential_id for auth if provided.',
    {
      workspace_id: z.string().describe('Workspace ID'),
      url: z.string().describe('GitHub repository URL'),
      resource_id: z.string().optional().describe('Existing resource ID to update (omit to create new)'),
      board_id: z.string().optional().describe('Board ID for board-scoped resource'),
      credential_id: z.string().optional().describe('Credential ID for GitHub auth (overrides global token)'),
    },
    async ({ workspace_id, url, resource_id, board_id, credential_id }) => {
      if (!(await isGitHubEnabled(credential_id))) {
        return err('GitHub token not configured. Add a credential or set global token in Admin Settings.');
      }
      const parsed = parseGitHubUrl(url);
      if (!parsed) return err('Invalid GitHub URL');

      let info;
      try {
        info = await fetchRepoInfo(parsed.owner, parsed.repo, credential_id);
      } catch (e: any) {
        return err(`GitHub API error: ${e.message}`);
      }

      const resourceRepo = dataSource.getRepository(Resource);
      const content = buildSyncContent(info);
      const tags = [...info.topics];
      if (info.language && !tags.includes(info.language.toLowerCase())) {
        tags.push(info.language.toLowerCase());
      }

      if (resource_id) {
        const existing = await resourceRepo.findOne({ where: { id: resource_id, workspace_id } });
        if (!existing) return err('Resource not found in workspace');
        existing.name = info.full_name;
        existing.description = info.description;
        existing.type = 'repository';
        existing.url = info.html_url;
        existing.content = content;
        existing.tags = JSON.stringify(tags);
        if (credential_id) existing.credential_id = credential_id;
        const saved = await resourceRepo.save(existing);
        embedResource(dataSource, logger, saved).catch(() => {});
        logger.info('MCP', `Synced GitHub repo ${info.full_name} → resource ${saved.id}`);
        return ok(resourceToJson(saved));
      }

      const created = resourceRepo.create({
        workspace_id,
        board_id: board_id || null,
        credential_id: credential_id || null,
        name: info.full_name,
        description: info.description,
        type: 'repository',
        url: info.html_url,
        content,
        file_data: '',
        file_name: '',
        file_mimetype: '',
        tags: JSON.stringify(tags),
      });
      const saved = await resourceRepo.save(created);
      embedResource(dataSource, logger, saved).catch(() => {});
      logger.info('MCP', `Created GitHub resource ${info.full_name} → ${saved.id}`);
      return ok(resourceToJson(saved));
    }
  );

  server.tool(
    'search_github',
    'Search GitHub for repositories, code, or issues using the GitHub Search API. ' +
    'Uses credential_id for auth if provided, otherwise falls back to global token.',
    {
      query: z.string().describe('Search query (uses GitHub search syntax, e.g. "react language:typescript stars:>100")'),
      scope: z.enum(['repositories', 'code', 'issues']).default('repositories')
        .describe('What to search: repositories, code, or issues'),
      per_page: z.number().optional().default(10).describe('Results per page (max 30, default 10)'),
      sort: z.string().optional().describe('Sort field — repos: stars/forks/updated; issues: created/updated/comments'),
      credential_id: z.string().optional().describe('Credential ID for GitHub auth (overrides global token)'),
    },
    async ({ query, scope, per_page, sort, credential_id }) => {
      if (!(await isGitHubEnabled(credential_id))) {
        return err('GitHub token not configured. Add a credential or set global token in Admin Settings.');
      }
      const limit = Math.min(per_page ?? 10, 30);
      try {
        if (scope === 'code') {
          const results = await searchGitHubCode(query, { per_page: limit, credential_id });
          return ok({ scope: 'code', total_count: results.total_count, items: results.items });
        }
        if (scope === 'issues') {
          const results = await searchGitHubIssues(query, { per_page: limit, sort, credential_id });
          return ok({ scope: 'issues', total_count: results.total_count, items: results.items });
        }
        const results = await searchGitHubRepos(query, { per_page: limit, sort, credential_id });
        return ok({ scope: 'repositories', total_count: results.total_count, items: results.items });
      } catch (e: any) {
        return err(`GitHub search error: ${e.message}`);
      }
    }
  );
}
