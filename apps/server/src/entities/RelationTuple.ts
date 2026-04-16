import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index } from 'typeorm';

// ReBAC tuple storage: subject has relation to object.
// E.g. user:alice member workspace:main
// Three composite indexes cover the main query patterns.
@Index(['object_type', 'object_id', 'relation'])    // check membership, list members
@Index(['subject_type', 'subject_id', 'relation'])  // list user's objects
@Index(['subject_type', 'subject_id', 'object_type', 'object_id'])  // exact tuple check
@Entity('relation_tuples')
export class RelationTuple {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar' })
  subject_type: string;

  @Column({ type: 'varchar' })
  subject_id: string;

  @Column({ type: 'varchar' })
  relation: string;

  @Column({ type: 'varchar' })
  object_type: string;

  @Column({ type: 'varchar' })
  object_id: string;

  // Tuples are immutable once created — no updated_at
  @CreateDateColumn()
  created_at: Date;
}
