import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, ManyToOne, OneToMany, JoinColumn } from 'typeorm';
import { Board } from './Board';
import { Ticket } from './Ticket';

@Entity('columns')
export class BoardColumn {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', nullable: true, default: '' })
  workspace_id: string;

  @Column({ type: 'varchar' })
  board_id: string;

  @Column({ type: 'varchar' })
  name: string;

  @Column({ type: 'int' })
  position: number;

  @Column({ type: 'varchar', default: '#e2e8f0' })
  color: string;

  @Column({ type: 'varchar', default: '' })
  description: string;

  @Column({ type: 'boolean', default: false })
  is_terminal: boolean;

  @CreateDateColumn()
  created_at: Date;

  @ManyToOne(() => Board, board => board.columns, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'board_id' })
  board: Board;

  @OneToMany(() => Ticket, ticket => ticket.column, { cascade: true })
  tickets: Ticket[];
}
