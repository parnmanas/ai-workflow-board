import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, Index } from 'typeorm';

// Closed vocabularies pinned by docs/ontology-graph/DESIGN.md axis 2 + the
// research-ontology.md §8.5 property-set this decision is built on. `type`/
// `kind` are deliberately NOT unions here — axis 2's workspace-extensibility
// model (core@X.Y.Z + additive workspace_profile@N) means the actual type
// taxonomy is an open, workspace-configurable registry, not a fixed enum.
//
// Shared with OntologyEdge (re-exported from there, not redefined) — both
// tables carry the same layer/status/confidence-method vocabulary.
export type OntologyLayer = 'structural' | 'derived' | 'semantic' | 'curated';
export type OntologyStatus = 'active' | 'stale' | 'removed' | 'quarantined';
export type OntologyConfidenceMethod = 'constant' | 'agreement' | 'support' | 'calibrated' | 'human';

// Ontology Graph node table (ticket 6ca4894a, DESIGN.md axis 2/3). One row
// per structural/derived/semantic graph entity — file, callable, community,
// concept, etc. Full property set + index shape mirror research-ontology.md
// §8.5 verbatim; `resource_id`/`folder_path` scoping follows Ticket.
// base_repo_resource_id's precedent (scout-server.md §1) — plain columns,
// no DB-level FK, resolved in application code.
//
// `graph_id` scopes every row to a (workspace_id, resource_id, folder_path)
// graph but there is no OntologyGraph table yet — that lifecycle entity is
// ticket #6's scope (graph_status auto-provisions it), so graph_id is a bare
// column here too, same FK-by-convention posture as everything else.
//
// STORAGE: on the sql.js (dev) backend this entity is fed to the second,
// independently-flushed `buildOntologyDataSourceOptions()` DataSource, never
// the primary data.db — see db.ts. On Postgres it lives in the single
// existing DataSource, unchanged. Auto-DDL'd by TypeORM `synchronize`
// (D-01, db.ts:395-474 hardcodes it on every branch) — no hand-written
// migration needed, same convention as every sibling table in this barrel.
@Index(['graph_id', 'symbol_id'], { unique: true })
@Index(['graph_id', 'path'])
@Index(['graph_id', 'type', 'layer'])
@Entity('ontology_nodes')
export class OntologyNode {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar' })
  workspace_id: string;

  // Repo resource this node was extracted from — Ticket.base_repo_resource_id's
  // "plain varchar, no FK" precedent (scout-server.md §1).
  @Column({ type: 'varchar', default: '' })
  resource_id: string;

  @Column({ type: 'varchar', default: '' })
  folder_path: string;

  @Column({ type: 'varchar' })
  graph_id: string;

  // Stable, content-addressed, SCIP-shaped identity — the precondition every
  // incremental-update mechanism (ticket #3/#4) depends on. Unique per graph,
  // not globally (see the composite index above, not a column-level unique).
  @Column({ type: 'varchar' })
  symbol_id: string;

  @Column({ type: 'varchar' })
  type: string;

  @Column({ type: 'varchar', default: '' })
  kind: string;

  @Column({ type: 'varchar' })
  layer: OntologyLayer;

  @Column({ type: 'varchar' })
  name: string;

  @Column({ type: 'varchar', default: '' })
  qualified_name: string;

  @Column({ type: 'varchar', default: '' })
  path: string;

  @Column({ type: 'int', nullable: true, default: null })
  start_line: number | null;

  @Column({ type: 'int', nullable: true, default: null })
  end_line: number | null;

  @Column({ type: 'varchar', default: '' })
  content_hash: string;

  @Column({ type: 'varchar', default: '' })
  lang: string;

  @Column({ type: 'varchar', default: 'active' })
  status: OntologyStatus;

  // Always explicitly computed by the extractor/resolver that wrote this row
  // — never DB-defaulted (DESIGN.md axis 2: confidence_method='agreement' is
  // a service-layer invariant, never self-reported/assumed).
  @Column({ type: 'float' })
  confidence: number;

  @Column({ type: 'varchar', default: 'constant' })
  confidence_method: OntologyConfidenceMethod;

  // Bitemporal versioning (commit-space, not wall-clock) — soft-delete only.
  @Column({ type: 'varchar', default: '' })
  first_seen_commit: string;

  @Column({ type: 'varchar', default: '' })
  last_seen_commit: string;

  @Column({ type: 'varchar', default: '' })
  valid_from_commit: string;

  @Column({ type: 'varchar', nullable: true, default: null })
  valid_to_commit: string | null;

  @Column({ type: 'varchar', default: '' })
  extraction_run_id: string;

  @Column({ type: 'varchar', default: '' })
  profile_version: string;

  // Free-form JSON bag for type-specific properties (e.g. Type.is_abstract,
  // Callable.arity) that don't warrant their own column — same posture as
  // Resource.content: text column, app-code owns the shape.
  @Column({ type: 'text', default: '{}' })
  props: string;

  @Column({ type: 'varchar', nullable: true, default: null })
  embedding_id: string | null;

  // Cached graph-algorithm outputs — 0 until a centrality pass has run.
  @Column({ type: 'int', default: 0 })
  degree: number;

  @Column({ type: 'float', default: 0 })
  pagerank: number;

  @CreateDateColumn()
  created_at: Date;

  @UpdateDateColumn()
  updated_at: Date;
}
