import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, Index } from 'typeorm';
import { OntologyLayer, OntologyStatus, OntologyConfidenceMethod } from './OntologyNode';

export type { OntologyLayer, OntologyStatus, OntologyConfidenceMethod };

// Edge-specific closed vocabularies pinned by DESIGN.md axis 2. `type`
// (CONTAINS, CALLS, DECORATES, AFFECTS_CODE, ...) is deliberately NOT a
// union here — same open/workspace-extensible taxonomy reasoning as
// OntologyNode.type/kind.
//
// Pinned in DESIGN.md axis 2 (review finding, integrity/major) — name-resolution
// confidence vs. runtime-dispatch confidence are separate axes. Structural
// CALLS edges only; null/unused on every other edge type.
export type OntologyEdgeResolution = 'exact' | 'name_match' | 'dynamic' | 'unresolved';
export type OntologyEvidenceKind =
  | 'parser' | 'indexer' | 'git' | 'heuristic' | 'cooccurrence' | 'embedding' | 'llm' | 'human';
export type OntologyEdgeRank = 'preferred' | 'normal' | 'deprecated';
// SPDX-derived vocabulary (research-ontology.md §8.5/§8.6) — distinguishes
// "zero results" from "zero results, known-incomplete coverage".
export type OntologyCompleteness = 'complete' | 'incomplete' | 'no_assertion';

// Ontology Graph edge table (ticket 6ca4894a, DESIGN.md axis 2/3). Mirrors
// RelationTuple's subject/object tuple shape (research-ontology.md §8.5,
// scout-server.md §2) but both endpoints are always OntologyNode rows in the
// same graph, addressed by `src_id`/`dst_id` — OntologyNode.id, plain
// varchar, no DB-level FK, same convention as every cross-entity reference
// in this codebase (RelationTuple, Ticket.base_repo_resource_id, ...).
//
// STORAGE: sql.js (dev) → second, independently-flushed
// `buildOntologyDataSourceOptions()` DataSource, never the primary data.db.
// Postgres (prod) → single existing DataSource, unchanged. See db.ts.
@Index(['graph_id', 'src_id', 'type'])
@Index(['graph_id', 'dst_id', 'type'])
@Index(['graph_id', 'type', 'layer'])
@Index(['graph_id', 'status', 'layer'])
@Entity('ontology_edges')
export class OntologyEdge {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar' })
  workspace_id: string;

  @Column({ type: 'varchar' })
  graph_id: string;

  @Column({ type: 'varchar' })
  src_id: string;

  @Column({ type: 'varchar' })
  dst_id: string;

  @Column({ type: 'varchar' })
  type: string;

  @Column({ type: 'varchar' })
  layer: OntologyLayer;

  @Column({ type: 'float' })
  confidence: number;

  @Column({ type: 'varchar', default: 'constant' })
  confidence_method: OntologyConfidenceMethod;

  // Co-occurrence/agreement support count (e.g. CO_CHANGED_WITH's lift/Jaccard
  // sample size) — not every edge type populates this.
  @Column({ type: 'int', nullable: true, default: null })
  support: number | null;

  // Structural CALLS-only (DESIGN.md axis 2's resolution='dynamic' cap
  // mechanism). Null/unused on every other edge type.
  @Column({ type: 'varchar', nullable: true, default: null })
  resolution: OntologyEdgeResolution | null;

  // CALLS-specific counter, same "structural only" posture as resolution.
  @Column({ type: 'int', nullable: true, default: null })
  call_count: number | null;

  @Column({ type: 'varchar', default: '' })
  evidence_kind: OntologyEvidenceKind | '';

  // JSON [{path, start, end, content_hash}] — REQUIRED (app-enforced, not a
  // DB constraint) when layer='semantic'.
  @Column({ type: 'text', default: '[]' })
  evidence_ref: string;

  @Column({ type: 'varchar', default: 'normal' })
  rank: OntologyEdgeRank;

  @Column({ type: 'varchar', default: 'no_assertion' })
  completeness: OntologyCompleteness;

  @Column({ type: 'varchar', default: '' })
  extraction_run_id: string;

  @Column({ type: 'varchar', nullable: true, default: null })
  model_id: string | null;

  @Column({ type: 'varchar', nullable: true, default: null })
  prompt_version: string | null;

  // Bitemporal versioning (commit-space, not wall-clock) — soft-delete only,
  // same posture as OntologyNode.
  @Column({ type: 'varchar', default: '' })
  first_seen_commit: string;

  @Column({ type: 'varchar', default: '' })
  last_seen_commit: string;

  @Column({ type: 'varchar', default: '' })
  valid_from_commit: string;

  @Column({ type: 'varchar', nullable: true, default: null })
  valid_to_commit: string | null;

  @Column({ type: 'varchar', default: 'active' })
  status: OntologyStatus;

  @Column({ type: 'text', default: '{}' })
  props: string;

  @CreateDateColumn()
  created_at: Date;

  @UpdateDateColumn()
  updated_at: Date;
}
