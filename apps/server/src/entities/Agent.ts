import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn } from 'typeorm';
import { emptyToNullUuid, nullablePassThroughUuid } from '../database/uuid-column';

@Entity('agents')
export class Agent {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar' })
  name: string;

  @Column({ type: 'varchar', default: '' })
  description: string;

  @Column({ type: 'varchar', default: 'custom' })
  type: string;

  @Column({ type: 'varchar', default: '' })
  avatar_url: string;

  @Column({ type: 'int', default: 1 })
  is_active: number;

  @Column({ type: 'int', default: 0 })
  is_online: number;

  @Column({ type: 'varchar', default: '[]' })
  roles: string;  // JSON-serialised string array e.g. '["assignee","reviewer"]'

  @Column({ type: Date, nullable: true, default: null })
  connected_at: Date | null;

  @Column({ type: Date, nullable: true, default: null })
  last_seen_at: Date | null;

  @Column({ type: Date, nullable: true, default: null })
  last_error_upload_at: Date | null;

  @Column({ type: 'varchar', default: '' })
  webhook_url: string;

  @Column({ type: 'uuid', nullable: true, transformer: emptyToNullUuid })
  workspace_id: string;

  @Column({ type: 'uuid', nullable: true, transformer: nullablePassThroughUuid })
  parent_agent_id: string | null;

  @Column({ type: 'text', default: '' })
  role_prompt: string;

  @Column({ type: 'simple-json', nullable: true, default: null })
  role_prompt_meta: Record<string, any> | null;

  // ST-4: agent-manager-managed working directory on the host running the
  // agent CLI (claude/codex/gemini). Empty string = unset (manager will
  // refuse to spawn until the admin sets one). Plain text rather than JSON
  // because there is exactly one path per agent identity — multi-root
  // agents would need a different abstraction.
  @Column({ type: 'text', default: '' })
  working_dir: string;

  // ST-4: id of the agent-manager Agent row that supervises this agent.
  // null for legacy / standalone agents (e.g. Claude CLI running with the
  // bare plugin proxy). Set when an admin creates an agent identity through
  // the agent-manager UI so the manager can route spawn/stop SSE commands
  // to the right host.
  @Column({ type: 'uuid', nullable: true, transformer: nullablePassThroughUuid })
  manager_agent_id: string | null;

  // Optional Credential row that supplies CLI auth for the spawned agent
  // (claude / codex / gemini). When set, the agent-manager fetches the
  // decrypted payload at spawn time and either writes it into the per-agent
  // cli-home (subscription kind: copy of the .credentials.json / auth.json /
  // oauth file) or sets the corresponding env var (api_key kind:
  // ANTHROPIC_API_KEY / OPENAI_API_KEY / GEMINI_API_KEY). null = fall back
  // to the operator's main HOME (legacy behaviour).
  @Column({ type: 'uuid', nullable: true, transformer: nullablePassThroughUuid })
  credential_id: string | null;

  @CreateDateColumn()
  created_at: Date;

  @UpdateDateColumn()
  updated_at: Date;
}
