import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ok, err } from '../shared/helpers';
import { getCallerAgent } from '../shared/session-auth';
import type { ToolContext } from './context';

function scopeAllowed(caller: ReturnType<typeof getCallerAgent>, workspaceId: string): boolean {
  return !caller?.workspaceId || caller.workspaceId === workspaceId;
}

export function registerWorkflowFunctionTools(server: McpServer, ctx: ToolContext): void {
  const service = ctx.workflowFunctionsService;

  server.tool(
    'list_functions',
    'List executable Functions resolved for a workspace. Global Functions are included; a workspace Function with the same key overrides the global definition.',
    { workspace_id: z.string().describe('Workspace ID used to resolve global + workspace overrides') },
    async ({ workspace_id }, extra: { sessionId?: string }) => {
      if (!service) return err('Workflow Functions service unavailable in this MCP context');
      if (!scopeAllowed(getCallerAgent(extra), workspace_id)) return err('Workspace scope mismatch');
      try {
        return ok(await service.list(workspace_id));
      } catch (error: any) {
        return err(error?.message || 'Failed to list Functions');
      }
    },
  );

  server.tool(
    'get_function',
    'Get a Function definition by ID, including executor config and JSON input/output schemas.',
    { id: z.string().describe('Function ID'), workspace_id: z.string().describe('Workspace scope boundary') },
    async ({ id, workspace_id }, extra: { sessionId?: string }) => {
      if (!service) return err('Workflow Functions service unavailable in this MCP context');
      if (!scopeAllowed(getCallerAgent(extra), workspace_id)) return err('Workspace scope mismatch');
      try {
        const view = await service.get(id);
        if (view.workspace_id !== null && view.workspace_id !== workspace_id) return err('Function belongs to a different workspace');
        return ok(view);
      } catch (error: any) {
        return err(error?.message || 'Function not found');
      }
    },
  );

  server.tool(
    'save_function',
    'Create or update a workspace Function. Global Functions are managed by authenticated admins in Admin → Functions. Provide id to update.',
    {
      workspace_id: z.string().describe('Workspace scope (required; MCP cannot author global Functions)'),
      id: z.string().optional(),
      key: z.string().describe('Stable lowercase identifier such as git.inspect_repository'),
      name: z.string(),
      description: z.string().optional(),
      executor_type: z.enum(['builtin', 'pipeline', 'http', 'agent_action']).optional(),
      input_schema: z.record(z.string(), z.any()).optional(),
      output_schema: z.record(z.string(), z.any()).optional(),
      config: z.record(z.string(), z.any()).optional(),
      risk_level: z.enum(['read', 'write', 'destructive', 'high_impact']).optional(),
      idempotency_mode: z.enum(['none', 'key']).optional(),
      timeout_ms: z.number().optional(),
      max_attempts: z.number().optional(),
      approval_policy: z.enum(['none', 'admin']).optional(),
      enabled: z.boolean().optional(),
    },
    async (input, extra: { sessionId?: string }) => {
      if (!service) return err('Workflow Functions service unavailable in this MCP context');
      if (!scopeAllowed(getCallerAgent(extra), input.workspace_id)) return err('Workspace scope mismatch');
      try {
        return ok(input.id
          ? await service.update(input.id, input)
          : await service.create(input));
      } catch (error: any) {
        return err(error?.message || 'Failed to save Function');
      }
    },
  );

  server.tool(
    'delete_function',
    'Delete a workspace-authored Function. Built-in Functions cannot be deleted.',
    { id: z.string(), workspace_id: z.string() },
    async ({ id, workspace_id }, extra: { sessionId?: string }) => {
      if (!service) return err('Workflow Functions service unavailable in this MCP context');
      if (!scopeAllowed(getCallerAgent(extra), workspace_id)) return err('Workspace scope mismatch');
      try {
        const view = await service.get(id);
        if (view.workspace_id !== workspace_id) return err('Only Functions in the caller workspace can be deleted through MCP');
        await service.remove(id);
        return ok({ success: true, id });
      } catch (error: any) {
        return err(error?.message || 'Failed to delete Function');
      }
    },
  );

  server.tool(
    'execute_function',
    'Execute a Function by stable key or ID and persist an auditable run. Use idempotency_key when the Function requires it.',
    {
      workspace_id: z.string(),
      function_key: z.string().optional(),
      function_id: z.string().optional(),
      board_id: z.string().optional(),
      ticket_id: z.string().optional(),
      inputs: z.record(z.string(), z.any()).optional(),
      idempotency_key: z.string().optional(),
    },
    async (input, extra: { sessionId?: string }) => {
      if (!service) return err('Workflow Functions service unavailable in this MCP context');
      const caller = getCallerAgent(extra);
      if (!scopeAllowed(caller, input.workspace_id)) return err('Workspace scope mismatch');
      if (!input.function_key && !input.function_id) return err('function_key or function_id is required');
      try {
        return ok(await service.execute({
          functionKey: input.function_key,
          functionId: input.function_id,
          workspaceId: input.workspace_id,
          boardId: input.board_id,
          ticketId: input.ticket_id,
          inputs: input.inputs,
          idempotencyKey: input.idempotency_key,
          actorType: caller?.agentId ? 'agent' : 'system',
          actorId: caller?.agentId || '',
          actorName: caller?.agentName || '',
        }));
      } catch (error: any) {
        return err(error?.message || 'Failed to execute Function', error?.run_id ? { run_id: error.run_id } : undefined);
      }
    },
  );

  server.tool(
    'list_function_runs',
    'List auditable Function execution records for a workspace, optionally filtered by Function or ticket.',
    {
      workspace_id: z.string(),
      function_id: z.string().optional(),
      ticket_id: z.string().optional(),
      limit: z.number().optional(),
    },
    async ({ workspace_id, function_id, ticket_id, limit }, extra: { sessionId?: string }) => {
      if (!service) return err('Workflow Functions service unavailable in this MCP context');
      if (!scopeAllowed(getCallerAgent(extra), workspace_id)) return err('Workspace scope mismatch');
      try {
        return ok(await service.listRuns(workspace_id, function_id, ticket_id, limit));
      } catch (error: any) {
        return err(error?.message || 'Failed to list Function runs');
      }
    },
  );
}
