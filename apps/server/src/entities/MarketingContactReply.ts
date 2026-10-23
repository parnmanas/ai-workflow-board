import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/** Notice-only replies for human operators. Never feed these into campaign feedback or agent prompts. */
@Entity('marketing_contact_replies')
@Index(['account_id', 'created_at'])
@Index('uq_marketing_contact_reply_source', ['account_id', 'source_key'], { unique: true })
export class MarketingContactReply {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar' })
  account_id: string;

  @Column({ type: 'varchar' })
  contact_id: string;

  @Column({ type: 'varchar' })
  notice_id: string;

  @Column({ type: 'varchar', default: '' })
  brand_id: string;

  /** Hash of credential + provider message id (or cleaned message fallback). No raw headers or addresses. */
  @Column({ type: 'varchar' })
  source_key: string;

  /** Untrusted plain text, processed by cleanReplyText. */
  @Column({ type: 'text' })
  content: string;

  @CreateDateColumn()
  created_at: Date;
}
