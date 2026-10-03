/**
 * Agent-domain MCP tools.
 *
 * P4c-4: the Agent table is dropped — list_agents / get_agent / ping no
 * longer exist. Execution is declared as RuntimeSpec, presence comes from
 * the Runtime Host heartbeat/registry. What remains here:
 *   - Prompt templates (Global/Workspace inherited catalog):
 *       list_prompt_templates, save_prompt_template, delete_prompt_template
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { PromptTemplate } from '../../../entities/PromptTemplate';
import { ok, err } from '../shared/helpers';
import type { ToolContext } from './context';
import { canUseCatalogItem } from '../../../common/catalog-scope';

export function registerAgentTools(server: McpServer, ctx: ToolContext): void {
  const { dataSource, logger } = ctx;

  // ─── Agent reads/writes removed (P4c-3b/4) ─────────────────────
  // create/update/delete/move (P4c-3b) then list/get/ping (P4c-4) no longer
  // exist — execution is declared as RuntimeSpec (Host + CLI + model +
  // working_dir), not as Agent rows.

  // ─── Prompt Templates (D-19) ─────────────────────────────────
  // Global/workspace/board inherited catalog. MCP can author workspace and
  // board rows; authenticated admins own Global authoring through REST/UI.

  server.tool(
    'list_prompt_templates',
    'List inherited prompt templates (Global + Workspace). Pass id for get semantics or category to filter.',
    {
      workspace_id: z.string().describe('Workspace scope boundary'),
      id: z.string().optional().describe('If provided, return only the matching template (array of length 0 or 1)'),
      category: z.string().optional().describe('Optional category filter (free-form string match)'),
    },
    async ({ workspace_id, id, category }) => {
      const repo = dataSource.getRepository(PromptTemplate);
      if (id) {
        const tpl = await repo.findOne({ where: { id } });
        if (tpl && !canUseCatalogItem(tpl, workspace_id)) return ok([]);
        return ok(tpl ? [tpl] : []);
      }
      const qb = repo.createQueryBuilder('t')
        .where('(t.workspace_id IS NULL OR t.workspace_id = :workspaceId)', { workspaceId: workspace_id });
      qb.andWhere('t.board_id IS NULL');
      if (category) qb.andWhere('t.category = :category', { category });
      const tpls = await qb.orderBy('t.name', 'ASC').getMany();
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
        if (existing.board_id !== null) return err('Template has not been migrated to Workspace scope');
        existing.name = name;
        existing.description = description ?? '';
        existing.content = content;
        existing.category = category ?? '';
        const saved = await repo.save(existing);
        return ok(saved);
      }

      const created = repo.create({
        workspace_id,
        board_id: null,
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

  void logger;
}
