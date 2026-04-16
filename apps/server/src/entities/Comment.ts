import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, ManyToOne, JoinColumn } from 'typeorm';
import { Ticket } from './Ticket';

@Entity('comments')
export class Comment {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', nullable: true, default: '' })
  workspace_id: string;

  @Column({ type: 'varchar' })
  ticket_id: string;

  @Column({ type: 'varchar', default: 'user' })
  author_type: string;

  @Column({ type: 'varchar', default: '' })
  author_id: string;

  @Column({ type: 'varchar' })
  author: string;

  @Column({ type: 'varchar' })
  content: string;

  @Column({ type: 'text', default: '[]' })
  images: string;

  @CreateDateColumn()
  created_at: Date;

  @ManyToOne(() => Ticket, ticket => ticket.comments, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'ticket_id' })
  ticket: Ticket;
}
