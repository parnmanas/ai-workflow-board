import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

/** A company's sign-in to a provider-hosted MCP server. Tokens, client registration and tool list stay encrypted. */
@Entity('business_mcp_connections')
@Index(['account_id', 'company_id'])
@Index('uq_business_mcp_company_provider', ['company_id', 'provider'], { unique: true })
@Index('uq_business_mcp_oauth_state', ['oauth_state_hash'], { unique: true })
export class BusinessMcpConnection {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column({ type: 'varchar' }) account_id: string;
  @Column({ type: 'varchar' }) company_id: string;
  @Column({ type: 'varchar' }) provider: string;
  @Column({ type: 'text' }) encrypted_data: string;
  @Column({ type: 'varchar', default: 'authorizing' }) status: 'authorizing' | 'connected' | 'error';
  @Column({ type: 'varchar', nullable: true }) oauth_state_hash: string | null;
  @Column({ type: 'varchar', nullable: true }) connected_at: string | null;
  @Column({ type: 'varchar', nullable: true }) tools_synced_at: string | null;
  @Column({ type: 'text', default: '' }) last_error: string;
  @Column({ type: 'integer', default: 0 }) revision: number;
  @CreateDateColumn() created_at: Date;
  @UpdateDateColumn() updated_at: Date;
}
