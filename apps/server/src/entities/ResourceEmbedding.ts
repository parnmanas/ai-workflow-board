import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn } from 'typeorm';

@Entity('resource_embeddings')
export class ResourceEmbedding {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  resource_id: string;

  @Column({ type: 'text' })
  embedding: string;

  @Column({ type: 'varchar', default: '' })
  model: string;

  @Column({ type: 'int', default: 0 })
  dimensions: number;

  @Column({ type: 'varchar', default: '' })
  text_hash: string;

  @CreateDateColumn()
  created_at: Date;
}
