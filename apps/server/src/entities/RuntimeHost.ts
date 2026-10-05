import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn } from 'typeorm';

/** Paired execution host. Runtime specs and Agent templates reference its id.
 * Live capabilities and presence are held by InstanceRegistry.
 */
@Entity('runtime_hosts')
export class RuntimeHost {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar' })
  name: string;

  @Column({ type: 'varchar', default: '' })
  hostname: string;

  // 페어링 당시 workspace — ApiKey 스탬프와 같은 bookkeeping 용도이며 권한
  // 경계가 아니다. Host 키는 AgentAuthGuard에서 full-scope로 취급한다.
  @Column({ type: 'varchar', nullable: true, default: null })
  account_id: string | null;

  @Column({ type: 'int', default: 1 })
  is_active: number;

  @Column({ type: Date, nullable: true, default: null })
  last_seen_at: Date | null;

  @CreateDateColumn()
  created_at: Date;

  @UpdateDateColumn()
  updated_at: Date;
}
