import { Entity, PrimaryColumn, Column, UpdateDateColumn } from 'typeorm';

@Entity('system_settings')
export class SystemSetting {
  @PrimaryColumn({ type: 'varchar' })
  key: string;

  @Column({ type: 'text', default: '' })
  value: string;

  @Column({ type: 'varchar', default: '' })
  description: string;

  @Column({ type: 'int', default: 0 })
  is_secret: number;

  @UpdateDateColumn()
  updated_at: Date;
}
