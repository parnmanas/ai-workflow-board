import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn } from 'typeorm';

@Entity('users')
export class User {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar' })
  name: string;

  @Column({ type: 'varchar', default: '' })
  email: string;

  @Column({ type: 'varchar', default: '' })
  avatar_url: string;

  @Column({ type: 'varchar', default: 'user' })
  role: string;

  @Column({ type: 'varchar', default: '' })
  discord_user_id: string;

  @Column({ type: 'varchar', default: '', select: false })
  password_hash: string;

  @Column({ type: 'varchar', default: 'active' })
  status: string; // 'active' | 'pending' | 'rejected'

  @Column({ type: 'varchar', default: '[]' })
  permissions: string;

  // Workspace the user selected during signup; set by Plan 03 auth flow
  @Column({ type: 'varchar', nullable: true, default: null })
  requested_workspace_id: string | null;

  @CreateDateColumn()
  created_at: Date;

  @UpdateDateColumn()
  updated_at: Date;
}
