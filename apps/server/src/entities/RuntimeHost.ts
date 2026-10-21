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

  // The pairing account owns this host and every manager/runtime credential.
  // A legacy NULL is unassigned and grants no access; hosts are never implicitly Global.
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
