import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

/**
 * An external skill registry — a git repository AWB pulls global skills from.
 *
 * Modelled on the "tap" pattern the Hermes agent uses for its own skill hub
 * (`~/.hermes/skills/.hub/taps.json`: `{ repo, path }` + a lock file), because
 * that is already how the ecosystem distributes skills and it keeps AWB out of
 * the business of vendoring other people's content.
 *
 * Taps are GLOBAL by construction: a synced skill lands as a global Skill row
 * (`workspace_id = NULL`, `source_kind = 'tap'`). There is no per-workspace
 * tap — a workspace that wants to diverge forks the skill into its own scope,
 * where it shadows the global one by slug.
 *
 * SECURITY: `enabled` defaults to 0 and nothing registers a tap automatically.
 * A skill body becomes agent-facing prompt text, so pulling one from a
 * third-party repository is an explicit operator decision, made once per tap,
 * not a boot-time side effect. The built-in pack that ships inside the AWB
 * repo is the only content seeded without an operator action.
 */
@Entity('skill_taps')
@Index(['repo_url', 'ref', 'path'], { unique: true })
export class SkillTap {
  @PrimaryGeneratedColumn('uuid') id: string;

  @Column({ type: 'varchar' }) name: string;

  /** Clone URL. https:// only — see skill-tap.service.ts `assertSafeRepoUrl`. */
  @Column({ type: 'varchar' }) repo_url: string;

  /** Branch or tag to track. Empty = the remote's default branch. */
  @Column({ type: 'varchar', default: '' }) ref: string;

  /** Subdirectory holding the skill tree, e.g. 'skills/'. Empty = repo root. */
  @Column({ type: 'varchar', default: '' }) path: string;

  /** 0 = registered but never synced. Operator must opt in explicitly. */
  @Column({ type: 'int', default: 0 }) enabled: number;

  /**
   * Licenses accepted from this tap, as a JSON string array (e.g.
   * '["MIT","Apache-2.0"]'). A SKILL.md whose `license:` frontmatter is not in
   * this list is SKIPPED and reported, so a tap that mixes permissive and
   * proprietary content (the common case — the Hermes hub carries both) can be
   * consumed without pulling in the parts AWB may not redistribute. Empty
   * array = accept everything, which the operator opts into deliberately.
   */
  @Column({ type: 'varchar', default: '["MIT","Apache-2.0"]' }) allowed_licenses: string;

  @Column({ type: Date, nullable: true, default: null }) last_synced_at: Date | null;
  @Column({ type: 'varchar', default: '' }) last_sync_status: '' | 'ok' | 'error';
  @Column({ type: 'text', default: '' }) last_sync_error: string;

  /** Commit sha the last successful sync resolved to — the lock, per tap. */
  @Column({ type: 'varchar', default: '' }) last_synced_commit: string;

  @Column({ type: 'simple-json', nullable: true, default: null })
  last_sync_summary: Record<string, any> | null;

  @Column({ type: 'varchar', default: '' }) created_by: string;

  @CreateDateColumn() created_at: Date;
  @UpdateDateColumn() updated_at: Date;
}
