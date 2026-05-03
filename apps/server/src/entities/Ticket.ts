import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, VersionColumn, ManyToOne, OneToMany, JoinColumn } from 'typeorm';
import { BoardColumn } from './BoardColumn';
import { Comment } from './Comment';

@Entity('tickets')
export class Ticket {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', nullable: true, default: '' })
  workspace_id: string;

  @Column({ type: 'varchar', nullable: true })
  column_id: string;

  @Column({ type: 'varchar', nullable: true, default: null })
  parent_id: string | null;

  @Column({ type: 'int', default: 0 })
  depth: number;

  @Column({ type: 'varchar' })
  title: string;

  @Column({ type: 'varchar', default: '' })
  description: string;

  @Column({ type: 'text', default: '' })
  prompt_text: string;

  @Column({ type: 'varchar', default: 'medium' })
  priority: string;

  @Column({ type: 'varchar', default: '' })
  assignee: string;

  @Column({ type: 'varchar', default: '' })
  reporter: string;

  @Column({ type: 'varchar', default: '' })
  assignee_id: string;

  @Column({ type: 'varchar', default: '' })
  reporter_id: string;

  @Column({ type: 'varchar', default: '' })
  reviewer_id: string;

  @Column({ type: 'varchar', nullable: true, default: null })
  locked_by_agent_id: string | null;

  @Column({ type: Date, nullable: true, default: null })
  locked_at: Date | null;

  @VersionColumn({ default: 1 })
  version: number;

  @Column({ type: 'varchar', default: '[]' })
  labels: string;

  @Column({ type: 'varchar', default: '[]' })
  channel_ids: string;

  @Column({ type: 'int', default: 0 })
  position: number;

  @Column({ type: 'varchar', default: 'todo' })
  status: string;

  // Repository resource the ticket builds against. Empty when the ticket is
  // pure-discussion / non-code. UI sources the picker from workspace+board
  // resources of type='repository'; the agent uses this id (plus base_branch)
  // to locate the clone URL and pull the latest before branching.
  @Column({ type: 'varchar', default: '' })
  base_repo_resource_id: string;

  // Branch the agent should treat as the base when starting work — the feature
  // branch is cut from this. Empty falls back to the repository's default
  // branch (Resource.default_branch, then origin/HEAD).
  @Column({ type: 'varchar', default: '' })
  base_branch: string;

  @Column({ type: 'varchar', default: '' })
  created_by: string;

  @Column({ type: 'varchar', default: '' })
  created_by_type: string; // 'user' | 'agent'

  @Column({ type: 'varchar', default: '' })
  created_by_id: string;

  @CreateDateColumn()
  created_at: Date;

  @UpdateDateColumn()
  updated_at: Date;

  @ManyToOne(() => BoardColumn, col => col.tickets, { onDelete: 'CASCADE', nullable: true })
  @JoinColumn({ name: 'column_id' })
  column: BoardColumn;

  @ManyToOne(() => Ticket, ticket => ticket.children, { onDelete: 'CASCADE', nullable: true })
  @JoinColumn({ name: 'parent_id' })
  parent: Ticket | null;

  @OneToMany(() => Ticket, ticket => ticket.parent, { cascade: true })
  children: Ticket[];

  @OneToMany(() => Comment, comment => comment.ticket, { cascade: true })
  comments: Comment[];
}
