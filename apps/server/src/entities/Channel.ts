import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn } from 'typeorm';

@Entity('channels')
export class Channel {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', nullable: true, default: '' })
  workspace_id: string;

  @Column({ type: 'varchar' })
  name: string;

  @Column({ type: 'varchar', default: 'discord' })
  type: string;

  @Column({ type: 'varchar', default: '' })
  bot_token: string;

  @Column({ type: 'varchar', default: '' })
  channel_id: string;

  @Column({ type: 'int', default: 1 })
  is_active: number;

  @Column({ type: 'int', default: 1 })
  notify_on_status_change: number;

  @Column({ type: 'int', default: 1 })
  notify_on_update: number;

  @Column({ type: 'int', default: 1 })
  notify_on_comment: number;

  @CreateDateColumn()
  created_at: Date;

  @UpdateDateColumn()
  updated_at: Date;
}
