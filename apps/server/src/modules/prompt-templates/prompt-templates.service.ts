import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { PromptTemplate } from '../../entities/PromptTemplate';
import { BoardColumn } from '../../entities/BoardColumn';
import { DEFAULT_PROMPT_TEMPLATES } from '../../database/default-prompt-templates';

/**
 * Helpers shared by the workspace-create / board-create paths so a fresh
 * install lands with all 7 default workflow templates pre-attached to
 * their matching columns.
 *
 * The two methods are deliberately separate:
 *   - `seedDefaults` is workspace-scoped (templates live per workspace).
 *   - `computeDefaultColumnPrompts` is board-scoped (column_prompts is a
 *     per-board JSON map keyed by column id).
 *
 * Both are idempotent — re-running on already-seeded data is a no-op.
 */
@Injectable()
export class PromptTemplatesService {
  constructor(
    @InjectRepository(PromptTemplate)
    private readonly templateRepo: Repository<PromptTemplate>,
  ) {}

  /**
   * Insert any default templates that don't already exist (by name) in the
   * given workspace. Returns the full list of default templates currently
   * resident in the workspace — so callers can build column_prompts off
   * the result without a second query.
   */
  async seedDefaults(workspaceId: string): Promise<PromptTemplate[]> {
    if (!workspaceId) return [];
    const existing = await this.templateRepo.find({ where: { workspace_id: workspaceId } });
    const existingByName = new Map(existing.map(t => [t.name, t]));
    const result: PromptTemplate[] = [];

    for (const def of DEFAULT_PROMPT_TEMPLATES) {
      const found = existingByName.get(def.name);
      if (found) {
        result.push(found);
        continue;
      }
      const row = await this.templateRepo.save(this.templateRepo.create({
        workspace_id: workspaceId,
        name: def.name,
        description: def.description,
        content: def.content,
        category: def.category,
      }));
      result.push(row);
    }
    return result;
  }

  /**
   * Build the `Board.column_prompts` map by matching each column's name
   * (case-insensitive) against `DEFAULT_PROMPT_TEMPLATES.column_match`,
   * then resolving the matching template id within `workspaceId`.
   *
   * Columns whose name doesn't match any default get no entry — admins
   * can still wire them manually via Board Settings.
   *
   * If the workspace doesn't yet have the matching template (e.g.,
   * called before seedDefaults), it's silently skipped. Callers should
   * seedDefaults first when they want the auto-wiring to land.
   */
  async computeDefaultColumnPrompts(
    workspaceId: string,
    columns: Pick<BoardColumn, 'id' | 'name'>[],
  ): Promise<Record<string, string>> {
    if (!workspaceId || columns.length === 0) return {};
    const templates = await this.templateRepo.find({ where: { workspace_id: workspaceId } });
    const templateIdByName = new Map(templates.map(t => [t.name, t.id]));

    const out: Record<string, string> = {};
    for (const col of columns) {
      const colKey = (col.name || '').toLowerCase();
      const def = DEFAULT_PROMPT_TEMPLATES.find(d => d.column_match === colKey);
      if (!def) continue;
      const tplId = templateIdByName.get(def.name);
      if (!tplId) continue;
      out[col.id] = tplId;
    }
    return out;
  }
}
