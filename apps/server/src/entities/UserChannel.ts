import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, Index } from 'typeorm';

/**
 * Per-user notification channel binding. One row per (user, provider, target).
 *
 * `credentials` holds provider-specific secrets (bot tokens, API keys) as a
 * JSON-encoded string that the application layer encrypts via
 * `services/encryption.service.ts` before write. Plaintext never lands here.
 */
@Entity('user_channels')
@Index(['user_id', 'provider'])
export class UserChannel {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar' })
  user_id: string;

  // 'discord' | 'slack' | 'telegram'
  @Column({ type: 'varchar' })
  provider: string;

  // Provider-specific delivery target:
  //  - discord: recipient discord user id (DM) OR channel id
  //  - slack:   slack member id (DM) OR channel id
  //  - telegram: chat id (numeric, but stored as varchar for portability)
  @Column({ type: 'varchar' })
  target: string;

  @Column({ type: 'varchar', default: '' })
  label: string;

  // Encrypted JSON blob, e.g. {"bot_token":"..."}. Always passed through
  // encryption.service.encrypt() before being written and decrypt() on read.
  @Column({ type: 'text', default: '' })
  credentials: string;

  @Column({ type: 'int', default: 1 })
  is_active: number;

  @Column({ type: 'int', default: 1 })
  notify_mention: number;

  @Column({ type: 'int', default: 1 })
  notify_chat: number;

  @Column({ type: 'int', default: 0 })
  notify_ticket: number;

  @Column({ type: Date, nullable: true, default: null })
  verified_at: Date | null;

  @CreateDateColumn()
  created_at: Date;

  @UpdateDateColumn()
  updated_at: Date;
}
