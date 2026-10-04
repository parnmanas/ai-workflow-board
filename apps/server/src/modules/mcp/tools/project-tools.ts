/**
 * Project MCP tools (docs/tickets.md).
 *
 * Tools: list_projects, get_project, save_project
 *
 * A project is one repository plus its main clone folder on each Runtime
 * Host. Agents read it to know where a project lives on THEIR host
 * (`host_folders`) before working on it.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ok, err } from '../shared/helpers';
import { getCallerAgent } from '../shared/session-auth';
import { callerCanAccessWorkspace } from '../shared/authz';
import { ProjectInputError } from '../../projects/projects.service';
import type { ToolContext } from './context';

export function registerProjectTools(server: McpServer, ctx: ToolContext): void {
  const { dataSource, projectsService } = ctx;

  server.tool(
    'list_projects',
    'List the projects (repositories) of a workspace, each with its main clone folder per Runtime Host (`host_folders`).',
    { workspace_id: z.string().optional().describe('Workspace (defaults to the caller\'s workspace)') },
    async ({ workspace_id }, extra: { sessionId?: string }) => {
      const caller = getCallerAgent(extra);
      const ws = workspace_id || caller?.workspaceId || '';
      if (!ws) return err('workspace_id is required');
      if (!(await callerCanAccessWorkspace(dataSource, caller, ws))) return err('Unauthorized: caller does not belong to this workspace');
      return ok(await projectsService.list(ws));
    },
  );

  server.tool(
    'get_project',
    'Get one project: repository url, default branch, use_pr, instructions, default assignee and `host_folders` — the main clone folder on each Runtime Host. ' +
    'When you work on this project on a host that has a folder, that folder is the project\'s canonical checkout there.',
    { project_id: z.string().describe('Project ID') },
    async ({ project_id }, extra: { sessionId?: string }) => {
      const project = await projectsService.get(project_id);
      if (!project) return err('Project not found');
      if (!(await callerCanAccessWorkspace(dataSource, getCallerAgent(extra), project.workspace_id))) {
        return err('Project not found');
      }
      return ok(await projectsService.view(project));
    },
  );

  server.tool(
    'save_project',
    'Create (omit project_id) or update a project. `host_folders` sets the main clone folder per Runtime Host ' +
    '(absolute path on that host; an empty path removes the entry). Requires access to the project\'s workspace.',
    {
      project_id: z.string().optional().describe('Omit to create'),
      workspace_id: z.string().optional().describe('Workspace for a new project (defaults to the caller\'s workspace)'),
      name: z.string().optional(),
      description: z.string().optional(),
      repo_url: z.string().optional(),
      default_branch: z.string().optional(),
      credential_id: z.string().nullable().optional(),
      clone_policy: z.record(z.string(), z.any()).nullable().optional(),
      use_pr: z.boolean().optional().describe('Land through pull requests instead of direct fast-forward merges'),
      instructions: z.string().optional().describe('Shown to every agent working on the project (build/test commands, conventions)'),
      default_assignee: z.record(z.string(), z.any()).nullable().optional().describe('RuntimeSpec applied to new tickets of this project that name no assignee'),
      host_folders: z.array(z.object({ host_id: z.string(), path: z.string() })).optional(),
    },
    async (args, extra: { sessionId?: string }) => {
      const caller = getCallerAgent(extra);
      try {
        let workspaceId: string;
        let projectId: string;
        if (args.project_id) {
          const existing = await projectsService.get(args.project_id);
          if (!existing) return err('Project not found');
          workspaceId = existing.workspace_id;
          if (!(await callerCanAccessWorkspace(dataSource, caller, workspaceId))) return err('Project not found');
          projectId = (await projectsService.update(args.project_id, workspaceId, args)).id;
        } else {
          workspaceId = args.workspace_id || caller?.workspaceId || '';
          if (!workspaceId) return err('workspace_id is required');
          if (!(await callerCanAccessWorkspace(dataSource, caller, workspaceId))) return err('Unauthorized: caller does not belong to this workspace');
          projectId = (await projectsService.create(workspaceId, args)).id;
        }
        for (const folder of args.host_folders || []) {
          if (folder.path.trim()) await projectsService.setHostFolder(projectId, workspaceId, folder.host_id, folder.path);
          else await projectsService.clearHostFolder(projectId, workspaceId, folder.host_id);
        }
        const project = await projectsService.get(projectId);
        return ok(project ? await projectsService.view(project) : null);
      } catch (e: any) {
        if (e instanceof ProjectInputError) return err(e.message);
        throw e;
      }
    },
  );
}
