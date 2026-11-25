import { Column, CreateDateColumn, Entity, Index, PrimaryColumn } from 'typeorm';

/** An approved remote MCP connection. Google credentials never enter this table. */
@Entity('mcp_oauth_grants')
@Index(['user_id', 'account_id'])
export class McpOAuthGrant {
  @PrimaryColumn('uuid') id: string;
  @Column('varchar') user_id: string;
  @Column('varchar') account_id: string;
  @Column('text') client_id: string;
  @Column('varchar') client_name: string;
  @Column('text') resource: string;
  // Grants issued before account actions were introduced retain their original consent.
  @Column({ type: 'varchar', default: 'awb.read' }) scope: string;
  @Index({ unique: true })
  @Column('varchar') access_hash: string;
  @Column({ type: Date }) access_expires_at: Date;
  @Column({ type: Date }) expires_at: Date;
  @Column({ type: 'int', default: 0 }) refresh_version: number;
  @CreateDateColumn() created_at: Date;
}
