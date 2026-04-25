import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';

/**
 * Per-workspace, configurable workflow role definition.
 *
 * Replaces the v1 hardcoded triple ('assignee'|'reporter'|'reviewer') so each
 * workspace can grow its own role taxonomy (QA, Designer, PM, …). The three
 * legacy roles are seeded as `is_builtin: true` rows during the v0.34
 * migration; admins may rename their slug / name / prompt freely. Deletion is
 * gated server-side on whether any TicketRoleAssignment still references the
 * row — a live role can't be removed underneath active tickets.
 *
 * Mention syntax `@[role:<slug>|<display>]` and Board.routing_config keys
 * resolve against this table, scoped to the ticket's workspace.
 */
@Entity('workspace_roles')
@Index('uniq_workspace_role_slug', ['workspace_id', 'slug'], { unique: true })
export class WorkspaceRole {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar' })
  workspace_id: string;

  /** Mention / routing-config key. Workspace-unique (case sensitive). */
  @Column({ type: 'varchar' })
  slug: string;

  /** Display name shown in pickers, mention pills, activity feed. */
  @Column({ type: 'varchar' })
  name: string;

  /**
   * Role-level system prompt prepended to the agent's own role_prompt at
   * trigger / chat-request emit time. Empty string disables the role layer
   * (agent prompt alone). The prepend happens server-side; plugin payload
   * carries the combined text in the existing `role_prompt` field.
   */
  @Column({ type: 'text', default: '' })
  role_prompt: string;

  @Column({ type: 'varchar', default: '' })
  description: string;

  /** Display order in pickers. Lower first. */
  @Column({ type: 'int', default: 0 })
  position: number;

  /**
   * Marks the three legacy roles seeded during migration. Currently only used
   * to surface a "built-in" badge in the management UI; all fields including
   * slug remain editable. Deletion gating is by reference-count, not by this
   * flag.
   */
  @Column({ type: 'boolean', default: false })
  is_builtin: boolean;

  @CreateDateColumn()
  created_at: Date;

  @UpdateDateColumn()
  updated_at: Date;
}
