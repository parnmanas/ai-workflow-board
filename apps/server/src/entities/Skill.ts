import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

/**
 * A skill definition.
 *
 * Scope follows the catalog model documented in `docs/catalog-scopes.md`:
 *
 *   | Scope     | workspace_id | Resolution priority |
 *   | Global    | NULL         | 1 (fallback)        |
 *   | Workspace | workspace id | 2 (shadows global)  |
 *
 * A Workspace skill SHADOWS a Global skill carrying the same `slug`, exactly
 * like WorkflowFunction resolves by key. That is what lets a workspace fork a
 * built-in skill without the operator having to delete the global one.
 *
 * NOTE on uniqueness: a plain `(workspace_id, slug)` unique index does NOT
 * constrain global rows — two NULLs are never equal (Postgres and SQLite alike),
 * so it would accept ten global skills with the same slug. Uniqueness is the
 * two PARTIAL indexes below, the same split workflow_functions uses. They live
 * on the entity, not in a migration: synchronize drops any index the metadata
 * does not declare, which is how the migration-only copies (…077) disappeared
 * from production.
 *
 * `board_id` is deliberately ABSENT — per docs/catalog-scopes.md new catalog
 * entities never add it. Callers that need `canUseCatalogItem()` adapt with a
 * literal `board_id: null` (see skill-scope.ts).
 */
@Entity('skills')
@Index('uq_skills_global_slug', ['slug'], { unique: true, where: 'workspace_id IS NULL' })
@Index('uq_skills_workspace_slug', ['workspace_id', 'slug'], { unique: true, where: 'workspace_id IS NOT NULL' })
export class Skill {
  @PrimaryGeneratedColumn('uuid') id: string;

  /** NULL = global (available to every workspace). */
  @Column({ type: 'varchar', nullable: true, default: null }) workspace_id: string | null;

  @Column({ type: 'varchar' }) slug: string;
  @Column({ type: 'varchar' }) name: string;
  @Column({ type: 'text', default: '' }) description: string;
  @Column({ type: 'varchar', default: 'active' }) status: 'active' | 'quarantined';

  /**
   * Where this definition came from, and therefore who may republish it:
   *   - `local`   — authored in AWB (UI/MCP). Never touched by a sync.
   *   - `builtin` — shipped in the AWB repo's `skills/` pack, seeded at boot.
   *   - `tap`     — pulled from an external git registry (see SkillTap).
   *
   * Sync only ever APPENDS a new immutable SkillVersion; it never edits or
   * deletes an existing one, so a hand-published version can't be lost. A
   * `quarantined` skill is skipped entirely — quarantine is an operator veto
   * and an upstream push must not silently revive the skill.
   */
  @Column({ type: 'varchar', default: 'local' }) source_kind: 'local' | 'builtin' | 'tap';

  /** SkillTap.id for `tap`, the pack id for `builtin`, '' for `local`. */
  @Column({ type: 'varchar', default: '' }) source_id: string;

  /** Path of the SKILL.md inside its source tree — the update key for a sync. */
  @Column({ type: 'varchar', default: '' }) source_path: string;

  /** Upstream `version:` frontmatter, informational (AWB versions are integers). */
  @Column({ type: 'varchar', default: '' }) source_version: string;

  /** Upstream `license:` / `author:` frontmatter, preserved for attribution. */
  @Column({ type: 'varchar', default: '' }) source_license: string;
  @Column({ type: 'varchar', default: '' }) source_author: string;

  @CreateDateColumn() created_at: Date;
  @UpdateDateColumn() updated_at: Date;
}
