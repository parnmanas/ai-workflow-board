/**
 * Deployment-awareness MCP tools (ticket 8ce72b18).
 *
 * A `Deployment` is the server-authoritative "what commit is LIVE in this
 * environment right now". `report_deployment` lets a deploy webhook / CI step /
 * agent tell AWB that an environment moved to a new commit — which un-gates any
 * deployment-waiting QA rerun (QaRerunOnFixService) the instant the fix's commit
 * is live, replacing the brittle `rerun_delay_seconds` time guess with a fact.
 *
 *   - report_deployment — upsert the live commit for an environment (+ ancestry).
 *
 * Reads (the "live commit" badge) go over REST GET /api/deployments; the write is
 * exposed here so a pure-MCP agent can report a deploy without a user session.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { Deployment } from '../../../entities/Deployment';
import { DEPLOYMENT_SOURCES } from '../../../common/deployment-options';
import { ok, err } from '../shared/helpers';
import { getCallerAgent } from '../shared/session-auth';
import type { ToolContext } from './context';

function deploymentToJson(d: Deployment | null) {
  if (!d) return null;
  return {
    id: d.id,
    workspace_id: d.workspace_id,
    environment: d.environment,
    base_url: d.base_url,
    repo_resource_id: d.repo_resource_id,
    deployed_commit_sha: d.deployed_commit_sha,
    ancestor_shas: d.ancestor_shas ?? [],
    source: d.source,
    reported_by: d.reported_by,
    deployed_at: d.deployed_at ?? null,
    created_at: d.created_at,
    updated_at: d.updated_at,
  };
}

export function registerDeploymentTools(server: McpServer, ctx: ToolContext) {
  const { deploymentService } = ctx;

  server.tool(
    'report_deployment',
    'Tell AWB that an ENVIRONMENT is now live on a specific commit — the "merged ≠ deployed" fix ' +
    '(ticket 8ce72b18). Upserts one record per (workspace, environment): the CURRENT live commit. ' +
    'Call this from your deploy webhook / CI finish step. It un-gates any QA rerun that is WAITING ' +
    'for this environment to deploy the fix: the rerun fires the moment `deployed_commit_sha` (or one ' +
    'of `ancestor_shas`) includes the fix commit — no time guessing. Pass `ancestor_shas` (e.g. ' +
    '`git rev-list --max-count=200 HEAD`) so the "does this deploy include the fix" ancestor check ' +
    'works without AWB holding a clone. Omit `workspace_id` for a GLOBAL/shared environment (e.g. the ' +
    'AWB server itself); set it to scope the environment to one workspace.',
    {
      environment: z.string().describe('Environment name, e.g. "production", "staging", "awb-server". This is what a QA scenario points at via target_environment.'),
      deployed_commit_sha: z.string().describe('The commit SHA now LIVE in this environment (git rev-parse HEAD of what was deployed).'),
      workspace_id: z.string().optional().describe('Scope to one workspace. Omit for a GLOBAL environment shared across workspaces.'),
      base_url: z.string().optional().describe('Public base URL of the environment (for the UI badge link / poller).'),
      repo_resource_id: z.string().optional().describe('Optional Resource id of the repo this environment deploys (provenance).'),
      ancestor_shas: z.array(z.string()).optional().describe('Recent commit ancestry of deployed_commit_sha (newest→oldest, e.g. `git rev-list --max-count=200 HEAD`). Enables the "deploy includes the fix commit" ancestor gate without a server-side clone.'),
      source: z.enum(DEPLOYMENT_SOURCES as [string, ...string[]]).optional().describe('How this was collected. Default "mcp".'),
      deployed_at: z.string().optional().describe('ISO timestamp the environment went live on this commit. Defaults to now.'),
    },
    async ({ environment, deployed_commit_sha, workspace_id, base_url, repo_resource_id, ancestor_shas, source, deployed_at }, extra: { sessionId?: string }) => {
      if (!deploymentService) return err('Deployment service unavailable in this MCP context');
      const caller = getCallerAgent(extra);
      try {
        const row = await deploymentService.report({
          workspaceId: workspace_id ?? null,
          environment,
          deployedCommitSha: deployed_commit_sha,
          baseUrl: base_url,
          repoResourceId: repo_resource_id,
          ancestorShas: ancestor_shas,
          source: (source as any) ?? 'mcp',
          reportedBy: caller?.agentId ?? '',
          deployedAt: deployed_at ?? null,
        });
        return ok(deploymentToJson(row));
      } catch (e: any) {
        return err(e?.message || 'Failed to report deployment');
      }
    },
  );
}
