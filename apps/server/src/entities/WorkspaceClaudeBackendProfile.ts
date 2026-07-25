import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

@Entity('workspace_claude_backend_profiles')
@Index('uq_workspace_claude_backend_profile', ['workspace_id', 'profile_id'], { unique: true })
export class WorkspaceClaudeBackendProfile {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar' })
  workspace_id: string;

  @Column({ type: 'varchar' })
  profile_id: string;
}
