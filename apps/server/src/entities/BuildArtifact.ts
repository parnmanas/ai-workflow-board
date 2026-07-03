import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, Index } from 'typeorm';

/**
 * BuildArtifact — a first-class, server-authoritative record of "this commit of
 * this repo was built for this target, and here is the resulting artifact"
 * (ticket 80d52250).
 *
 * Before this entity, "a build" existed only as ad-hoc shell commands inside a
 * QA-run prompt, so the commit↔artifact mapping, freshness (cold/warm), and
 * build-failure propagation were all left to agent discretion / per-project
 * scripts — and leaked the same way every time (GameClient QA rot saga:
 * 58baab63 / de341210 / be2f998a / 0da1d237 / 3f28dd05). The registry makes the
 * cold/warm decision DETERMINISTIC: "is there an `ok` artifact for THIS exact
 * commit + target?" — killing the stale-warm-exe race where nobody knew which
 * commit the reused exe corresponded to.
 *
 * Conventions match the rest of the entity layer (QaRun/QaScenario):
 *   - uuid PK, varchar workspace_id / nullable board_id, @Create/@UpdateDateColumn.
 *   - `status` is a plain varchar + a TS union alias (NOT a TypeORM enum column),
 *     so sqlite (dev) and Postgres (prod) stay schema-sync-safe under
 *     `synchronize: true` (db.ts D-01).
 *
 * Lookup identity is `(workspace_id, repo_key, target, commit_sha[, host])`.
 * `repo_key` is a normalized repo identity (see buildRepoKey in
 * common/build-artifact-options.ts) so artifacts are SHARED across scenarios /
 * boards that point at the same repo — the same-machine reuse ticket item (#5).
 * `host` scopes reuse to a machine: a Windows `.exe` built on host A is useless
 * on host B, so a non-empty host narrows the match.
 */
@Entity('build_artifacts')
// Freshness lookup — "do I have an artifact for THIS commit+target?"
@Index(['workspace_id', 'repo_key', 'target', 'commit_sha'])
// Latest-ok lookup — newest usable artifact for a repo+target.
@Index(['workspace_id', 'repo_key', 'target', 'status', 'built_at'])
export class BuildArtifact {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar' })
  workspace_id: string;

  // null = workspace-scoped (any board can reuse it); <uuid> = pinned to a board.
  @Column({ type: 'varchar', nullable: true, default: null })
  board_id: string | null;

  // Normalized repo identity — the SHARE key. Derived at write time from
  // repo_resource_id || repo_url via buildRepoKey(). Two scenarios pointing at
  // the same repo produce the same repo_key, so a build one made is visible to
  // the other (ticket #5, kills the D-09 re-build whack-a-mole).
  @Column({ type: 'varchar' })
  repo_key: string;

  // Provenance — either may be set (repo_key is the lookup key, these record how
  // it was derived so a human/agent can trace the source back).
  @Column({ type: 'varchar', default: '' })
  repo_resource_id: string;

  @Column({ type: 'varchar', default: '' })
  repo_url: string;

  // Build target — platform/config, free-text like qa_driver (e.g.
  // 'StandaloneWindows64/Release', 'il2cpp-development'). A new target never
  // requires a schema change.
  @Column({ type: 'varchar' })
  target: string;

  // The exact repo commit SHA this artifact was built from. The heart of the
  // freshness decision: an `ok` row whose commit_sha == the run's HEAD means the
  // build can be skipped.
  @Column({ type: 'varchar' })
  commit_sha: string;

  // building → ok | failed.
  //  - 'building' claims an in-flight build (optional — lets a concurrent run see
  //    that a build is already underway for this commit+target).
  //  - 'ok'      is the default on register — the artifact is usable.
  //  - 'failed'  is written by report_build_failure with the log tail.
  @Column({ type: 'varchar', default: 'ok' })
  status: BuildArtifactStatus;

  // Where the artifact lives on the builder machine (agent-home-relative or
  // absolute). Consumed by a warm run to reuse the exe instead of rebuilding.
  @Column({ type: 'varchar', default: '' })
  artifact_path: string;

  // Optional content hash (integrity / dedupe). '' = not reported.
  @Column({ type: 'varchar', default: '' })
  artifact_hash: string;

  // Optional uploaded Resource id (when the artifact was also stored as a
  // Resource blob, e.g. a small build for cross-machine transfer). '' = local only.
  @Column({ type: 'varchar', default: '' })
  artifact_resource_id: string;

  // Machine identity — artifact reuse is same-machine by nature. Free-text,
  // agent-reported (hostname). '' = unscoped (any host may match).
  @Column({ type: 'varchar', default: '' })
  host: string;

  // The agent that produced (or attempted) this build.
  @Column({ type: 'varchar', default: '' })
  builder_agent_id: string;

  // Build log summary — the tail is especially important on status='failed', and
  // is what report_build_failure carries into the on-failure ticket.
  @Column({ type: 'text', default: '' })
  log_summary: string;

  // Optional linked QaRun/SecurityRun id that triggered or consumed this build.
  // '' = standalone build (e.g. a dev build not tied to a run).
  @Column({ type: 'varchar', default: '' })
  run_id: string;

  // When the build finished (ok or failed). null while status='building'.
  @Column({ type: Date, nullable: true, default: null })
  built_at: Date | null;

  @CreateDateColumn()
  created_at: Date;

  @UpdateDateColumn()
  updated_at: Date;
}

export type BuildArtifactStatus = 'building' | 'ok' | 'failed';
