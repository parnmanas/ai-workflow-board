/**
 * Agent-domain MCP tools.
 *
 * Tools:
 *   - Agent CRUD: list_agents, get_agent, create_agent, update_agent, delete_agent
 *   - Connection: ping (heartbeat)
 *   - Prompt templates (workspace-scoped, D-15/D-19):
 *       list_prompt_templates, save_prompt_template, delete_prompt_template
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { Agent } from '../../../entities/Agent';
import { PromptTemplate } from '../../../entities/PromptTemplate';
import { ok, err } from '../shared/helpers';
import type { ToolContext } from './context';

export function registerAgentTools(server: McpServer, ctx: ToolContext): void {
  const { dataSource, logger } = ctx;

  // ─── Agent CRUD ─────────────────────────────────────

  server.tool(
    'list_agents',
    'List all registered AI agents',
    {},
    async () => {
      const agents = await dataSource.getRepository(Agent).find({
        order: { name: 'ASC' },
      });
      return ok(agents);
    }
  );

  server.tool(
    'get_agent',
    'Get a single AI agent by ID',
    { agent_id: z.string().describe('Agent ID') },
    async ({ agent_id }) => {
      const agent = await dataSource.getRepository(Agent).findOne({
        where: { id: agent_id },
      });
      if (!agent) return err('Agent not found');
      return ok(agent);
    }
  );

  server.tool(
    'create_agent',
    'Register a new AI agent',
    {
      name: z.string().describe('Agent name'),
      description: z.string().optional().default('').describe('Agent description'),
      type: z.enum(['claude', 'gpt', 'custom']).optional().default('custom').describe('Agent type'),
      avatar_url: z.string().optional().default('').describe('Avatar URL'),
      is_active: z.number().optional().default(1).describe('Active (1) or inactive (0)'),
    },
    async ({ name, description, type, avatar_url, is_active }) => {
      const agentRepo = dataSource.getRepository(Agent);
      const agent = await agentRepo.save(agentRepo.create({ name, description, type, avatar_url, is_active }));
      return ok(agent);
    }
  );

  server.tool(
    'update_agent',
    'Update an AI agent (name, description, type, avatar_url, is_active, role_prompt, role_prompt_meta)',
    {
      agent_id: z.string().describe('Agent ID'),
      name: z.string().optional().describe('New name'),
      description: z.string().optional().describe('New description'),
      type: z.enum(['claude', 'gpt', 'custom']).optional().describe('New type'),
      avatar_url: z.string().optional().describe('New avatar URL'),
      is_active: z.number().optional().describe('Active (1) or inactive (0)'),
      role_prompt: z.string().optional().describe('Markdown role instructions delivered to this agent on every trigger'),
      role_prompt_meta: z.record(z.string(), z.unknown()).optional().describe(
        'Optional metadata sidecar: { version?, updated_by?, template_id?, ... } — forward-compat hook, safe to omit'
      ),
    },
    async ({ agent_id, name, description, type, avatar_url, is_active, role_prompt, role_prompt_meta }) => {
      const agentRepo = dataSource.getRepository(Agent);
      const agent = await agentRepo.findOne({ where: { id: agent_id } });
      if (!agent) return err('Agent not found');

      // Snapshot pre-update name so a rename leaves an audit line. Past
      // incident: manager Agent names silently flipped without any record
      // because none of the three mutation paths emitted an audit log.
      const prevName = agent.name;

      if (name !== undefined) agent.name = name;
      if (description !== undefined) agent.description = description;
      if (type !== undefined) agent.type = type;
      if (avatar_url !== undefined) agent.avatar_url = avatar_url;
      if (is_active !== undefined) agent.is_active = is_active;
      if (role_prompt !== undefined) agent.role_prompt = role_prompt;              // D-18
      if (role_prompt_meta !== undefined) agent.role_prompt_meta = role_prompt_meta as Record<string, any>; // D-18

      const updated = await agentRepo.save(agent);

      if (prevName !== updated.name) {
        logger.info(
          'AgentIdentity',
          `Agent name changed via MCP update_agent: "${prevName}" → "${updated.name}" (id=${updated.id.slice(0, 8)} type=${updated.type})`,
          {
            agent_id: updated.id,
            agent_type: updated.type,
            field: 'name',
            before: prevName,
            after: updated.name,
            via: 'MCP update_agent',
          },
        );
      }
      return ok(updated);
    }
  );

  server.tool(
    'delete_agent',
    'Delete an AI agent',
    { agent_id: z.string().describe('Agent ID') },
    async ({ agent_id }) => {
      const agentRepo = dataSource.getRepository(Agent);
      const agent = await agentRepo.findOne({ where: { id: agent_id } });
      if (!agent) return err('Agent not found');
      await agentRepo.delete(agent.id);
      return ok({ success: true });
    }
  );

  // ─── Prompt Templates (D-19) ─────────────────────────────────
  // Workspace-scoped per D-15. Three tools instead of a single polymorphic
  // `manage_prompt_template` — see D-19 rationale.

  server.tool(
    'list_prompt_templates',
    'List prompt templates in a workspace. Pass `id` to fetch a single template (get semantics) or `category` to filter.',
    {
      workspace_id: z.string().describe('Workspace ID (required — templates are workspace-scoped per D-15)'),
      id: z.string().optional().describe('If provided, return only the matching template (array of length 0 or 1)'),
      category: z.string().optional().describe('Optional category filter (free-form string match)'),
    },
    async ({ workspace_id, id, category }) => {
      const repo = dataSource.getRepository(PromptTemplate);
      if (id) {
        const tpl = await repo.findOne({ where: { id, workspace_id } });
        return ok(tpl ? [tpl] : []);
      }
      const where: any = { workspace_id };
      if (category) where.category = category;
      const tpls = await repo.find({ where, order: { name: 'ASC' } });
      return ok(tpls);
    }
  );

  server.tool(
    'save_prompt_template',
    'Upsert a prompt template. If `id` is provided → update; otherwise → create a new template.',
    {
      workspace_id: z.string().describe('Workspace ID (required — scope boundary)'),
      id: z.string().optional().describe('Template ID — omit to create a new template, provide to update an existing one'),
      name: z.string().describe('Template name (required, free-form)'),
      description: z.string().optional().describe('Short description (default: empty string)'),
      content: z.string().describe('Template body — markdown. This is what gets snapshot-copied into a ticket prompt_text when selected.'),
      category: z.string().optional().describe('Free-form category string (default: empty string)'),
    },
    async ({ workspace_id, id, name, description, content, category }) => {
      const repo = dataSource.getRepository(PromptTemplate);
      if (!name || !name.trim()) return err('Template name is required');
      if (!content) return err('Template content is required');

      if (id) {
        const existing = await repo.findOne({ where: { id, workspace_id } });
        if (!existing) return err('Template not found in workspace');
        existing.name = name;
        existing.description = description ?? '';
        existing.content = content;
        existing.category = category ?? '';
        const saved = await repo.save(existing);
        return ok(saved);
      }

      const created = repo.create({
        workspace_id,
        name,
        description: description ?? '',
        content,
        category: category ?? '',
      });
      const saved = await repo.save(created);
      return ok(saved);
    }
  );

  server.tool(
    'delete_prompt_template',
    'Delete a prompt template by id. Requires workspace_id as a safety scope to prevent cross-workspace deletes.',
    {
      workspace_id: z.string().describe('Workspace ID (required — scope boundary, must match the template)'),
      id: z.string().describe('Template ID'),
    },
    async ({ workspace_id, id }) => {
      const repo = dataSource.getRepository(PromptTemplate);
      const existing = await repo.findOne({ where: { id, workspace_id } });
      if (!existing) return err('Template not found in workspace');
      await repo.delete({ id, workspace_id });
      return ok({ success: true, id });
    }
  );

  // ─── Connection: ping ────────────────────────────────────────
  server.tool(
    'ping',
    'Heartbeat tool — call every 30 seconds to keep agent marked as online. ' +
    'Auto-stamps connected_at on first call. Returns current last_seen_at.',
    {
      agent_id: z.string().describe('Your agent ID (the UUID from list_agents)'),
    },
    async ({ agent_id }) => {
      const agentRepo = dataSource.getRepository(Agent);
      const agent = await agentRepo.findOne({ where: { id: agent_id } });
      if (!agent) return err(`Agent not found: ${agent_id}`);

      const now = new Date();
      if (!agent.connected_at) agent.connected_at = now;
      agent.last_seen_at = now;
      agent.is_online = 1;
      await agentRepo.save(agent);

      // No info-level log: every healthy proxy fires this every 30s and the
      // line drowned everything else in the MCP timeline. last_seen_at is
      // authoritative; the dashboard reads from there.
      return ok({ status: 'ok', agent_id, last_seen_at: now.toISOString() });
    }
  );
}
