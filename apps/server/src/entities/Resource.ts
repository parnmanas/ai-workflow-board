import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn } from 'typeorm';

@Entity('resources')
export class Resource {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar' })
  workspace_id: string;

  @Column({ type: 'varchar', nullable: true, default: null })
  board_id: string | null;

  @Column({ type: 'varchar' })
  name: string;

  @Column({ type: 'varchar', default: '' })
  description: string;

  @Column({ type: 'varchar', default: 'link' })
  type: string;

  @Column({ type: 'varchar', default: '' })
  url: string;

  @Column({ type: 'text', default: '' })
  content: string;

  @Column({ type: 'text', default: '' })
  file_data: string;

  @Column({ type: 'varchar', default: '' })
  file_name: string;

  @Column({ type: 'varchar', default: '' })
  file_mimetype: string;

  @Column({ type: 'varchar', default: '[]' })
  tags: string;

  @CreateDateColumn()
  created_at: Date;

  @UpdateDateColumn()
  updated_at: Date;
}
