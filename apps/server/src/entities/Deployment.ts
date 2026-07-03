import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, Index } from 'typeorm';
import { DeploymentSource } from '../common/deployment-options';

/**
 * Deployment — a server-authoritative record of "what commit is LIVE in this
 * environment right now" (ticket 8ce72b18, "배포 인지").
 *
 * The gap this closes: "merged ≠ deployed". QA rerun-on-fix, board pause/resume,
 * and "verify against the live server" all fired the instant a fix hit Done, but
 * the environment auto-deploys AFTER main merges — so they validated the PRE-fix
 * code (false-negative loop; see run c61d2eca board-pause). This entity lets the
 * server gate that automation on the DEPLOYMENT FACT (the live commit) instead of
 * a best-effort time delay.
 *
 * Identity = (workspace_id, environment). We UPSERT one row per environment (the
 * "current live commit"), not a history log — the badge + gate only ever need the
 * latest. `workspace_id` is NULLABLE: null = a GLOBAL/shared environment (the AWB
 * server self-report is global — the running server is one process, not per-
 * workspace), visible to every workspace's scenarios; a non-null row is a
 * workspace-private environment.
 *
 * Conventions mirror BuildArtifact (ticket 80d52250): uuid PK, plain varchar +
 * TS-union for `source` (NOT a TypeORM enum, so sqlite/postgres stay schema-sync-
 * safe under db.ts D-01 `synchronize: true`), @Create/@UpdateDateColumn. No
 * migration needed — synchronize creates the table from these decorators.
 */
@Entity('deployments')
// Current-live lookup — "what commit is live for this env in this workspace / globally?"
@Index(['workspace_id', 'environment'])
@Index(['environment', 'deployed_at'])
export class Deployment {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  // null = GLOBAL environment (shared across workspaces — e.g. the AWB server
  // self-report); <uuid> = a workspace-private environment.
  @Column({ type: 'varchar', nullable: true, default: null })
  workspace_id: string | null;

  // Logical environment name — free-text, the join key a QaScenario points at via
  // `target_environment` (e.g. 'awb-server', 'production', 'staging'). A new
  // environment never requires a schema change.
  @Column({ type: 'varchar' })
  environment: string;

  // Public base URL of the environment (for the UI badge link / poller). '' = unset.
  @Column({ type: 'varchar', default: '' })
  base_url: string;

  // Optional Resource id of the repo this environment deploys (provenance). '' = unset.
  @Column({ type: 'varchar', default: '' })
  repo_resource_id: string;

  // The commit SHA currently LIVE in this environment. The heart of the gate.
  @Column({ type: 'varchar', default: '' })
  deployed_commit_sha: string;

  // Recent commit ancestry of `deployed_commit_sha` (newest→oldest), so the
  // "does this deployment include commit X" check is data-driven without the
  // server needing a clone of the SUT (deploymentIncludesCommit). Bounded by the
  // reporter (self-report caps to ~200). null/[] = only exact-sha matches gate.
  @Column({ type: 'simple-json', nullable: true, default: null })
  ancestor_shas: string[] | null;

  // How this record was collected. self_report = the server recorded its own
  // build on boot; webhook/mcp = report_deployment; poll = periodic /api/version
  // scrape; manual = a human set it.
  @Column({ type: 'varchar', default: 'manual' })
  source: DeploymentSource;

  // The agent (or '') that reported this deployment via MCP.
  @Column({ type: 'varchar', default: '' })
  reported_by: string;

  // When the environment went live on this commit. The ordering key for the gate
  // (a rerun waits for a deployment whose deployed_at is at/after the fix's Done).
  @Column({ type: Date, nullable: true, default: null })
  deployed_at: Date | null;

  @CreateDateColumn()
  created_at: Date;

  @UpdateDateColumn()
  updated_at: Date;
}
