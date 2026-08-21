# Ontology / Schema Design for a Per-Folder Software Knowledge Graph (AWB "Ontology Graph")

Research brief for the architect. Everything below is evidence-backed; URLs inline, full list at the end.

---

## 0. TL;DR decisions

| Question | Decision | Primary evidence |
|---|---|---|
| Graph model | **Labelled property graph (LPG)** stored relationally in SQLite; RDF/OWL used only as *vocabulary* + export (JSON-LD context) | edge-property need for confidence/provenance; RDF needs reification/RDF-star which inflates triples & joins (https://arxiv.org/pdf/2304.13097, https://arxiv.org/pdf/2110.13348, https://dl.acm.org/doi/pdf/10.1145/3534540.3534695) |
| Separating hard vs soft | Mandatory `layer` discriminator on **every node and edge**: `structural` / `derived` / `semantic` / `curated` — the quad/named-graph pattern collapsed to a column | named graphs as provenance/trust partitions (https://patterns.dataincubator.org/book/named-graphs.html, https://link.springer.com/chapter/10.1007/978-3-030-53199-7_2) |
| Code node/edge vocabulary | SEON `code.owl` class/property set, trimmed to declaration granularity; SCIP symbol strings as stable IDs | http://se-on.org/ , https://github.com/sourcegraph/scip , https://scip-code.org/ |
| Domain concept vocabulary | **SKOS** (`Concept`, `ConceptScheme`, `broader`/`narrower`/`related`, `*Match`) — deliberately *not* OWL classes | https://www.w3.org/TR/skos-reference/ |
| Provenance | PROV-O mapped onto columns (`ExtractionRun` = `prov:Activity`, extractor+model = `prov:SoftwareAgent`), statement-level like Wikidata references/rank | https://www.w3.org/TR/prov-o/ , https://www.wikidata.org/wiki/Wikidata:Data_model |
| Confidence | Per-edge `confidence` + `confidence_method` + `support`; **agreement-derived, not LLM-self-reported** | https://arxiv.org/html/2405.16929v2 , https://www.frontiersin.org/journals/immunology/articles/10.3389/fimmu.2026.1937268/full |
| Cost control at 1M+ LOC | 4-tier pipeline; LLM deferred to query/open time (LazyGraphRAG pattern) | https://www.microsoft.com/en-us/research/blog/lazygraphrag-setting-a-new-standard-for-quality-and-cost/ |
| Freshness | Per-file XXH3/blake3 content hash + git-diff driven re-parse; soft edges auto-`stale` when the hashed slice they cite changes | https://arxiv.org/html/2603.27277v1 , https://arxiv.org/abs/2211.01224 |
| Extensibility | Frozen versioned **core profile** + additive **workspace profile**; SHACL-shaped JSON constraints; deprecate-never-delete | https://www.w3.org/TR/shacl/ , https://www.w3.org/TR/owl2-syntax/ , http://obofoundry.org/principles/fp-004-versioning.html |

---

## 1. Model choice: property graph vs RDF/OWL vs hybrid

**The requirement that decides it:** every soft edge must carry `confidence`, `evidence_kind`, `evidence_ref[]`, `model_id`, `prompt_version`, `support`, `valid_from_commit`, `valid_to_commit`. That is 8+ properties *on an edge*.

- RDF has no native edge properties; you get them via reification (relationship becomes a blank node + ≥3 extra triples), n-ary relation classes, or named graphs — all of which "greatly increas[e] graph density and query complexity" (https://douroucouli.wordpress.com/2020/09/11/edge-properties-part-1-reification/, https://memgraph.com/docs/data-modeling/graph-data-model/lpg-vs-rdf).
- RDF-star fixes the syntax but is *not* semantically aligned with LPG multi-edges; the systematic comparison of RDF/RDF-star/LPG as DAGs finds remaining expressiveness gaps, notably distinguishing multiple parallel edges (https://arxiv.org/pdf/2304.13097). A benchmark of PG→RDF mappings found the *named-graph* mapping fastest for edge-property queries precisely because it needs fewer triples/joins (https://dl.acm.org/doi/pdf/10.1145/3534540.3534695).
- "Graph? Yes! Which one? Help!" (https://arxiv.org/pdf/2110.13348) is the canonical survey of the tradeoff: RDF wins on global identifiers, standard vocabularies, reasoning; LPG wins on locality, edge attributes, engineering ergonomics.
- OWL reasoning buys us almost nothing here: our inferences of value (transitive containment, call reachability, community rollup) are graph traversals, not description-logic entailments. CodeOntology needed HermiT only to check the *ontology* was coherent, not to run queries (https://link.springer.com/chapter/10.1007/978-3-319-68204-4_2).

**Recommendation — "labelled-property-hybrid":** LPG storage, ontology-grade discipline.
1. Store nodes/edges in two SQLite tables (AWB already has this exact pattern in `apps/server/src/entities/RelationTuple.ts` — subject/relation/object with three composite indexes).
2. Give every type an IRI-shaped canonical name (`awb:Callable`, `skos:Concept`, `seon:invokesMethod`) held in a type registry, and ship a JSON-LD `@context` mapping to `woc:` (CodeOntology), `seon:`, `skos:`, `prov:`, `schema:`, `spdx:`. This buys standards interop and export without paying triple-store costs.
3. Never materialise inverse edges. SEON's `code.owl` declares 68 terms that are largely inverse pairs (`invokesMethod`/`methodIsInvokedBy`, `declaresMethod`/`isDeclaredMethodOf`, `hasSuperClass`/`hasSubClass`) — an artifact of OWL needing named inverses. In an LPG that doubles the edge table; use two indexes `(src,type)` and `(dst,type)` instead.

---

## 2. Existing code ontologies — what to steal, what to skip

### 2.1 SEON (Software Evolution ONtologies) — the structural backbone
SEON is a **pyramid**: `general/` (main.owl, measurement.owl, annotations.owl) → `domain-specific/` (code.owl, history.owl, issues.owl, code-metrics.owl) → `domain-spanning/` (change-couplings.owl, clones.owl, code-flaws.owl, fine-grained-changes.owl, integration-code-history.owl, integration-history-issues-code.owl) → `system-specific/` (java.owl, jira.owl, bugzilla.owl). Its "most distinguishing feature … is its strict organization into different levels of abstraction" (https://link.springer.com/article/10.1007/s00607-012-0204-1, files: https://github.com/sealuzh/onts-seon).

Verbatim term inventory (extracted from the OWL files):

- **main.owl** — classes `SeonThing, Artifact, File, Directory, Product, Release, Milestone, Stakeholder, Developer, Activity`; properties `hasName, hasIdentifier, hasPath, hasParent, hasChild, hasSibling, containsFile, dependsOn, belongsToRelease, hasCreationDate, hasModificationDate, isBasedOn, isSimilar, carriesOutActivity, activityStart, activityEnd`.
- **code.owl** — classes `CodeEntity, ComplexType, ClassType, InterfaceType, EnumerationType, AnnotationType, ExceptionType, PrimitiveType, Datatype, Method, Constructor, Field, Parameter, Variable, Namespace, AccessModifier`; properties `containsCodeEntity, declaresMethod, declaresField, declaresConstructor, hasSubtype/hasSuperType, hasSubClass/hasSuperClass, hasSubInterface/hasSuperInterface, implementsInterface, invokesMethod, invokesConstructor, accessesField, instantiatesClass, usesComplexType, catchesException, throwsException, hasParameter, hasReturnType, hasDatatype, expectsDatatype, hasNamespaceMember, hasAccessModifier, hasPosition, startsAt, hasLength, hasDoc, hasCodeIdentifier, isAbstract, isStatic, isConstant`.
- **history.owl** — `Commit, Committer, Version, Branch, ChangeSet, FileUnderVersionControl`; `commitsVersion, commitsChangeSet, committedOn, hasCommitMessage, hasContentIdentifier, hasVersion, isVersionOf, followsVersion, precedesVersion, isOnBranch, hasTag, linesAdded, linesDeleted, appearsInRelease`.
- **issues.owl** — `Issue, Bug, BugFix, Enhancement, FeatureRequest, FeatureAddition, Improvement, Comment, Attachment, Priority, Severity, Status, Resolution, Reporter, Assignee`; `blocksIssue, dependsOnIssue, hasDuplicate, hasEstimatedEffort/hasActualEffort, …`.
- **integration-history-issues-code.owl** defines exactly two properties: `affectsCodeEntity` / `isAffectedBy` — the whole cross-domain bridge is one edge type. Strong precedent for keeping bridges minimal.

**Take:** code.owl's class set and `hasPosition/startsAt/hasLength` positional pattern; history.owl for the provenance/commit axis; the pyramid's layering idea (it maps 1:1 onto our `layer` column and onto core-vs-workspace profiles). **Skip:** the inverse-property explosion, the OWL-DL axioms, `system-specific/java.owl`-style per-language ontologies (use a `lang` property + `kind` enum instead of 30 subclasses).

Note for AWB directly: SEON's issues.owl + `affectsCodeEntity` is a ready-made bridge from **AWB tickets** to code nodes — a differentiating edge nobody else in the code-graph space has.

### 2.2 CodeOntology (`woc:`) — the RDF-ization reference
OWL 2, 65 classes / 86 object properties / 11 data properties, rooted at `woc:CodeElement`, with `ComplexType` covering class/enum/interface; applied to OpenJDK 8 to produce >2M triples (https://link.springer.com/chapter/10.1007/978-3-319-68204-4_2, http://codeontology.org/doc, namespace `http://rdf.webofcode.org/woc/`). Its lasting lesson is the *scale ratio*: a single JDK yields millions of triples at method granularity — which is why we cap granularity at declarations and never materialise AST nodes. Its DBpedia linking (code entity ↔ external concept) is the direct ancestor of our `REALIZES` edge, but CodeOntology's linking was lexical/heuristic and is where trust broke down — hence our confidence + evidence requirements.

### 2.3 Code Property Graph — the thing NOT to build
Yamaguchi et al. (IEEE S&P 2014) merge AST+CFG+PDG into one queryable graph, operationalised in Joern; excellent for vulnerability queries, but node counts are per-AST-node and per-statement (https://arxiv.org/pdf/2405.12841, https://arxiv.org/pdf/2403.10646). At "millions of LOC" a CPG is 10^8 nodes. **Decision: keep AST inside tree-sitter at parse time; persist only declarations + resolved references.** If a user ever needs data-flow, run Joern/semgrep on demand and attach results as `derived`-layer edges.

### 2.4 SCIP / LSIF / stack-graphs / Kythe — identity, not schema
SCIP (https://scip-code.org/, https://sourcegraph.com/blog/announcing-scip) gives the single most valuable artifact: a **human-readable, cross-file, cross-repo stable symbol string** `<scheme> <manager> <package-name> <version> <descriptor>+` with descriptor suffixes `Namespace/ Type# Term. Method() Parameter() TypeParameter[] Meta: Macro!`, plus `SymbolRole` bitset (`Definition 0x1, Import 0x2, WriteAccess 0x4, ReadAccess 0x8, Generated 0x10, Test 0x20, ForwardDefinition 0x40`) and relationship flags `is_reference / is_implementation / is_type_definition / is_definition`.
**Take:** (a) SCIP-shaped symbol IDs as our node primary identity (version-stripped, so nodes survive across commits); (b) `Generated` and `Test` roles as node flags — vital for noise control; (c) if a repo already emits SCIP (scip-typescript, scip-java, rust-analyzer, scip-python…), ingest it to upgrade `CALLS` edges from heuristic to exact.
GitHub's **stack graphs** (https://arxiv.org/abs/2211.01224, https://github.blog/open-source/introducing-stack-graphs/) prove the incrementality property we need: "graph construction and path-finding judgments are **file-incremental** — for each source file an isolated subgraph is created without any knowledge of … any other file". Design corollary: **all extraction must be per-file pure**; cross-file resolution is a separate, re-runnable join step.

### 2.5 SPDX 3.0 / CycloneDX — the dependency subgraph
SPDX 3.0 (2024) is explicitly an Element+Relationship graph: `Relationship` has `from` (1), `to` (1..n), `relationshipType`, `startTime`, `endTime`, and `completeness` (https://spdx.github.io/spdx-spec/v3.0.1/model/Core/Classes/Relationship/), with 70+ relationship types incl. `contains, dependsOn, describes, generates, ancestorOf, variantOf, hasTest, patchedBy, testedOn, usesTool, hasDeclaredLicense` (https://spdx.github.io/spdx-spec/v3.0.1/model/Core/Vocabularies/RelationshipType/). CycloneDX by contrast is a flat component list + separate `dependencies` array (https://fossa.com/blog/sbom-formats-compared-explained/).
**Take three things:** (1) reuse the *names* `CONTAINS`/`DEPENDS_ON`/`GENERATES`/`HAS_TEST`/`DESCRIBES` so our edge vocabulary is standards-aligned; (2) steal **`completeness`** — an explicit `complete | incomplete | noAssertion` marker per edge *set*, which is exactly what a partially-indexed 1M-LOC repo needs to say honestly; (3) steal `NoneElement` / `NoAssertionElement` semantics as a `no_assertion` status rather than silently omitting edges.

### 2.6 schema.org / CodeMeta — the repository-level node
`schema:SoftwareSourceCode` and `schema:SoftwareApplication`, extended by CodeMeta 2.0 (`https://doi.org/10.5063/schema/codemeta-2.0`), give ready-made properties for the graph's root node: `codeRepository, programmingLanguage, runtimePlatform, targetProduct, license, version, author, dateModified` (https://codemeta.github.io/terms/, https://github.com/SoftwareUnderstanding/software_types). Map AWB's existing `Resource{type:'repository', url, default_branch}` onto it directly — zero new modelling.

---

## 3. SKOS for the domain-concept half

Use SKOS, **not** OWL classes, for LLM-derived domain concepts (https://www.w3.org/TR/skos-reference/, https://www.w3.org/TR/skos-primer/). Why it is the right fit:

- SKOS is designed for *semi-formal*, human-ish vocabularies; "no formal relationship between SKOS concepts and OWL classes is asserted", so soft concepts can never accidentally contaminate formal reasoning over hard facts. That is exactly the separability property required.
- `skos:broader` is **deliberately non-transitive** (transitive closure is opt-in via `skos:broaderTransitive`). This is a feature for LLM output: a chain of 6 shaky `broader` links must not silently entail a 6-hop claim.
- Integrity conditions we should enforce as validation rules: one `prefLabel` per language per concept; `skos:related` is **disjoint** with `skos:broaderTransitive` (you may not assert both hierarchy and mere association between the same pair); `Concept`/`ConceptScheme`/`Collection` mutually disjoint.
- `skos:ConceptScheme` = our per-graph (per repo+folder) vocabulary container; cross-folder / cross-repo concept alignment uses the mapping properties `exactMatch / closeMatch / broadMatch / narrowMatch / relatedMatch` — note `exactMatch` is transitive+symmetric while `closeMatch` is not, so LLM-proposed alignments should default to `closeMatch` and only be promoted to `exactMatch` by human curation.
- `skos:notation`, `skos:definition`, `skos:scopeNote`, `skos:example`, `skos:historyNote`, `skos:changeNote` map onto the fields a concept card in the UI wants anyway; `changeNote`/`historyNote` are the natural home for "why this concept changed at commit X".

Design rule: **a `Concept` is a term in a controlled vocabulary, not a class with instances.** Code nodes are *not* instances of concepts; they are linked by an explicit `REALIZES` edge with evidence.

---

## 4. GraphRAG, LazyGraphRAG, ontology-grounded RAG → the extraction pipeline

### 4.1 What Standard GraphRAG costs
Per https://github.com/microsoft/graphrag/blob/main/docs/index/methods.md, standard indexing spends LLM calls on: entity extraction (per text unit), relationship extraction (per entity pair per text unit), entity summarisation (per entity across units), relationship summarisation, optional claim extraction, and community report generation. **Graph extraction alone is ~75% of indexing cost.** For a 1M-LOC repo that is a non-starter as a default.

### 4.2 FastGraphRAG and LazyGraphRAG — the affordable path
- **FastGraphRAG**: entities = noun phrases from NLTK/spaCy; relationships = **co-occurrence within a text unit** (no descriptions); no summarisation steps; LLM only for community reports.
- **LazyGraphRAG** (https://www.microsoft.com/en-us/research/blog/lazygraphrag-setting-a-new-standard-for-quality-and-cost/): *zero* LLM at index time — noun-phrase concepts + co-occurrence edges → concept graph → graph statistics → **hierarchical community structure**. All LLM use is deferred to query time under a single tunable **relevance test budget**, combining best-first (embedding-ranked chunks → rank communities by their best chunks) with breadth-first (LLM sentence-level relevance assessor over top-k untested chunks per community) and iterative deepening into subcommunities. Numbers: indexing cost **identical to vector RAG = 0.1% of full GraphRAG**; comparable global-query quality at **>700× lower query cost**; at a 500-test budget (4% of GraphRAG global-search query cost) it *beats* all conditions on both local and global queries.

**Direct consequence for our design:** the concept layer must exist in two states — **candidate** (cheap, LLM-free, from identifiers/docstrings/comments/README noun phrases + co-occurrence) and **promoted** (LLM-verified, typed, described, edge-justified). Only promote on demand: (a) folder/community the user actually opens; (b) folders touched by an active ticket; (c) top-N by centrality. Budget is one number in workspace settings.

Community structure: **Leiden**, which fixes Louvain's disconnected-community defect, runs in ~O(m log n), and yields a hierarchy by recursive aggregation (https://neo4j.com/docs/graph-data-science/current/algorithms/leiden/, https://github.com/microsoft/graphrag/discussions/1128). For incremental freshness see HIT-Leiden / "Maintaining Leiden Communities in Large Dynamic Graphs" (https://arxiv.org/abs/2601.08554) — communities can be maintained under updates instead of recomputed.

### 4.3 Ontology-grounded extraction is the accuracy lever
- **OG-RAG** (Microsoft, EMNLP 2025; https://arxiv.org/abs/2412.15235, https://aclanthology.org/2025.emnlp-main.1674/): ontology-grounded hypergraph retrieval → **+55% recall of accurate facts, +40% response correctness, +27% fact-based reasoning accuracy, 30% faster attribution**.
- Schema-guided extraction = inject the allowed type list into the prompt **and post-hoc type-check every triple, dropping out-of-schema ones** (https://arxiv.org/pdf/2511.05991, https://arxiv.org/html/2603.25152).
- Clinical ontology-grounded KG QA cut hallucination from **63% → 1.7%** (https://www.sciencedirect.com/science/article/abs/pii/S1532046426000171).
- LLM ontology induction is viable but novice-level: GPT-4-class output "approach[es] the quality of novice human modelers" (LLMs4OL, NeOn-GPT lines of work; surveys: https://arxiv.org/html/2510.20345v1, https://arxiv.org/pdf/2508.19428, https://arxiv.org/html/2602.01276v1).

**Therefore:** LLM induction is used to *populate* and to *propose extensions to* a schema we control; it never freely invents node/edge types into the live graph. Proposed new types land in a `proposed` state for human promotion (mirrors AWB's existing `propose_skill_change`/`SkillProposal` pattern).

### 4.4 Repository-graph prior art (node/edge taxonomies actually shipped)
- **RepoGraph** (ICLR 2025, https://arxiv.org/html/2410.14684v1): nodes = *code lines* typed definition|reference; edges = `invoke`, `contain`; tree-sitter; filters out repo-independent relations (stdlib/3rd-party) — a cheap, effective noise rule. k-hop ego-graph retrieval: 1-hop ≈ 11.6 nodes/37 edges, 2-hop ≈ 54.5 nodes/90 edges; whole graphs >1,000 nodes / 25,000 edges; **+32.8% relative improvement on SWE-bench** as a plug-in.
- **CodexGraph** (NAACL 2025, https://aclanthology.org/2025.naacl-long.7/): exposes the code graph to the agent as a **graph database the agent writes queries against** — the right MCP shape (query language, not a fixed retrieval endpoint).
- **Codebase-Memory** (https://arxiv.org/html/2603.27277v1) is the closest existing analogue to what AWB should build and validates our stack choices: **all state in a single SQLite file (WAL)**; 13 node types `Project, Package, Folder, File, Module, Function, Method, Class, Interface, Enum, Type, Route, Community`; edges `CALLS, HTTP_CALLS, ASYNC_CALLS, IMPORTS, CONTAINS_*, DEFINES, DEFINES_METHOD, IMPLEMENTS, INHERITS, DECORATES, USES_TYPE, USAGE, THROWS, READS, WRITES, MEMBER_OF`; incremental via **XXH3 file hash compare → re-parse only changed files (~4× speedup)**; measured **49K nodes in ~6s**, **Linux kernel 2.1M nodes in ~3 min**; query latency <1ms Cypher traversal, ~0.3ms BFS call-path; **~1,000 tokens/query vs ~10,000 for text exploration**, 2.3 vs 4.8 tool calls, 83% vs 92% quality across 31 languages.
- **LocAgent** (ACL 2025, https://arxiv.org/pdf/2503.09089): directed *heterogeneous* graph for multi-hop localisation; **KGCompass** links issues↔code entities and hits 58.3% on SWE-bench Lite — again endorsing the ticket↔code bridge.

The 83%-vs-92% number is the honest caveat: a graph alone is *worse* than letting an agent read files, unless the graph is used as a **cheap index that routes to file reads**. Design the MCP tools so every graph answer returns `path` + line ranges the agent can then read.

---

## 5. Provenance model

### 5.1 PROV-O mapping (https://www.w3.org/TR/prov-o/)
| PROV-O term | Our artifact |
|---|---|
| `prov:Entity` | every node and every edge version (statement-level, not just node-level) |
| `prov:Activity` | `ExtractionRun` row (id, graph_id, kind=`parse|lexical|llm|import|human`, started/ended, commit_sha, files_scanned, cost_tokens) |
| `prov:Agent` / `prov:SoftwareAgent` | extractor identity: `tool_name@version`, or `model_id + prompt_version + temperature` |
| `prov:wasGeneratedBy` | `node.extraction_run_id`, `edge.extraction_run_id` |
| `prov:used` | run → commit snapshot, run → input files (by content hash) |
| `prov:wasAssociatedWith` | run → extractor/model agent |
| `prov:wasAttributedTo` | curated nodes/edges → AWB user or agent id |
| `prov:wasDerivedFrom` | community summaries, concept merges, promoted candidates → their inputs |
| `prov:wasRevisionOf` | new version of a node after the file changed |
| `prov:wasInformedBy` | LLM promotion run ← lexical candidate run |
| `prov:startedAtTime` / `endedAtTime` | run timestamps |
| `prov:Bundle` | a graph *build* (`graph_version`) — provenance-of-provenance, i.e. "which pipeline version produced this whole snapshot" |

Store it as columns + one `extraction_runs` table, not as triples; emit PROV-O JSON-LD only on export.

### 5.2 Statement-level provenance: the Wikidata pattern
Wikidata's data model separates snak → claim → **statement = claim + qualifiers + references + rank** (https://www.wikidata.org/wiki/Wikidata:Data_model, https://www.wikidata.org/wiki/Help:Ranking). Mapping:
- **references** → our `evidence_ref[]`: `{path, start_line, end_line, content_hash, chunk_id}` — *required* for any `semantic`-layer edge.
- **qualifiers** → edge properties (`resolution`, `call_count`, `since_commit`).
- **rank** (`preferred|normal|deprecated`) → our `rank` column, used when two extraction runs disagree: keep both, mark the loser `deprecated` instead of deleting. This is what makes disagreement auditable rather than invisible.

### 5.3 Which commit/file/line produced each node — the concrete fields
`repo_resource_id, commit_sha (first_seen), last_seen_commit, path, start_line, end_line, start_byte, end_byte, content_hash (XXH3/blake3 of the defining slice), symbol_id (SCIP-shaped, version-stripped)`. SEON's `hasPosition/startsAt/hasLength` and SCIP's `Occurrence` ranges (with explicit position encoding: UTF-8 bytes vs UTF-16 code units — pick one and record it, this is a real interop bug source) both back this.

---

## 6. Confidence on LLM-derived edges

Evidence base: the Dagstuhl/TGDK survey *Uncertainty Management in the Construction of Knowledge Graphs* (https://arxiv.org/html/2405.16929v2, https://drops.dagstuhl.de/storage/08tgdk/tgdk-vol003/tgdk-vol003-issue001/TGDK.3.1.3/TGDK.3.1.3.pdf) taxonomises uncertainty as *granularity conflicts* (vagueness, fuzziness, incompleteness) vs *contradictory conflicts* (invalidity, ambiguity, timeliness), and distinguishes **three distinct confidences**: extraction-algorithm confidence, source confidence, source-reliability confidence. It documents that Knowledge Vault applies **Platt scaling** to normalise scores across heterogeneous extractors, ReVerb uses logistic regression, NELL/Probase model facts probabilistically, ConceptNet uses numeric edge weights — and critically that **downstream fusion steps usually throw extractor confidence away**, and that "LLMs lack provenance or reliability indicators despite extraction capabilities".

Reproducibility warning: a five-axis benchmark found different LLMs, given *the same text, prompt and schema*, "produce knowledge graphs that scarcely overlap" (https://www.frontiersin.org/journals/immunology/articles/10.3389/fimmu.2026.1937268/full). Self-reported confidence is therefore not a measurement. See also Double-Calibration (https://arxiv.org/html/2601.11956) and LLM-as-KG-validator benchmarking (https://arxiv.org/html/2602.10748v1).

**Concrete policy:**
1. `confidence REAL NOT NULL` in [0,1], plus **`confidence_method ENUM('constant','agreement','support','calibrated','human')`** — a bare float without its method is meaningless and must not be comparable across layers.
2. `structural` edges from a type-resolving indexer (SCIP): `confidence = 1.0, method='constant', resolution='exact'`. **Structural edges from tree-sitter-only name matching are NOT 1.0** — dynamic dispatch, duck typing, monkey patching, DI containers. Give them `resolution ∈ {exact, name_match, dynamic, unresolved}` and `confidence ≈ 0.75–0.9, method='constant'`. This is the single most common trust bug in code graphs.
3. `semantic` edges: `confidence = f(agreement across k independent samples/chunks)`, `support = #independent evidence chunks`, never the model's stated probability. Cheap version: k=3 self-consistency on high-stakes edges only; free version: `support` count from lexical co-occurrence.
4. Surface **ordinal buckets** in the UI/API (`asserted ≥0.9 / likely 0.6–0.9 / speculative <0.6`) since raw floats are not calibrated across models.
5. Never average confidence across layers, and never multiply confidences along a path without recording that you did (path confidence is a derived, labelled quantity).
6. **Orphan rule:** a `Concept` with zero evidence edges to any structural node is a hallucination smell — quarantine, don't publish.

---

## 7. Schema evolution / versioning

- Ontology-level: adopt OWL's versioning vocabulary semantics even in JSON — `versionIRI`-equivalent `profile_version` (semver), `priorVersion`, `backwardCompatibleWith`/`incompatibleWith`, and `owl:deprecated` (https://www.w3.org/TR/owl2-syntax/, https://arxiv.org/pdf/2003.13084). OBO Foundry's versioning principle (http://obofoundry.org/principles/fp-004-versioning.html) plus best-practice guidance: **deprecate with an explanatory note and keep for ≥1 release cycle before deletion**.
- Instance-level: **bitemporal**. Transaction time = `indexed_at` / `extraction_run_id`; valid time = *commit space*, `valid_from_commit` / `valid_to_commit` (NULL = current), ordered topologically, not by wall clock (rebases and merges reorder wall-clock time). Precedent: probabilistic bitemporal KGs (https://dl.acm.org/doi/fullHtml/10.1145/3184558.3191637), bitemporal RDF (https://www.mdpi.com/2227-7390/13/13/2109), schema-validation-and-evolution for graph DBs (https://arxiv.org/pdf/1902.06427).
- **Soft delete only.** A deleted function becomes `valid_to_commit = <sha>, status='removed'`; this is what lets the UI answer "when did this coupling appear/disappear" and lets agents see that a symbol *used to* exist.
- Migrations: because the graph is fully derived from git + the profile, the escape hatch is always "drop and re-extract at tier 0/1" (cheap: seconds-to-minutes per Codebase-Memory). Only `curated`-layer rows are precious — **back them up separately and re-attach by `symbol_id`, not by node UUID.** Design `symbol_id` to be stable so curation survives a rebuild.

---

## 8. PROPOSED CORE SCHEMA

### 8.1 Graph scoping
`OntologyGraph { id, workspace_id, resource_id (repository), root_path, ref/branch, profile_version, core_version, status, last_indexed_commit, node_count, edge_count, budget_settings }`. A graph = (workspace, repo resource, folder, profile). Concept schemes are per graph; cross-graph concept links use `CLOSE_MATCH`/`EXACT_MATCH`.

### 8.2 Layers (the separability primitive)
| layer | meaning | who may write | default confidence | shown by default |
|---|---|---|---|---|
| `structural` | deterministic facts from parsers/indexers/git | extractors only | 1.0 (exact) / 0.75–0.9 (heuristic) | yes |
| `derived` | deterministic algorithms over structural (communities, centrality, co-change, metrics, clones) | pipeline only | 1.0 with stats | yes |
| `semantic` | LLM- or lexically-derived domain concepts & links | LLM/lexical extractors | measured | opt-in / dimmed |
| `curated` | human (or explicitly approved agent) assertion | users, review flow | 1.0 | yes, pinned above conflicts |

**Invariant (enforce in code, not convention): an LLM extraction run may only INSERT nodes of type `Concept|Term|Policy|Actor|Capability` and edges of type `REALIZES|MENTIONS|BROADER|NARROWER|RELATED|CLOSE_MATCH|GOVERNS|DESCRIBES`. It may never create, mutate, or delete a `structural` node or edge.** That single write-scope rule is what makes the two halves permanently separable and independently rebuildable.

### 8.3 Node types (core profile)

**Structural (`layer='structural'`)**
| type | key props | notes |
|---|---|---|
| `Repository` | `resource_id, url, default_branch, langs[]` | maps to `schema:SoftwareSourceCode` / CodeMeta |
| `Directory` | `path, depth` | `CONTAINS` tree |
| `File` | `path, lang, loc, size, is_test, is_generated, content_hash` | `is_generated` from SCIP `Generated` role/heuristics |
| `Module` | `qualified_name` | package/namespace; SEON `Namespace` |
| `Type` | `kind ∈ {class,interface,struct,enum,type_alias,trait,annotation,exception}, is_abstract, visibility` | SEON `ComplexType` collapsed to one type + `kind` |
| `Callable` | `kind ∈ {function,method,constructor,getter,setter,lambda}, signature, arity, is_async, is_static, visibility, cyclomatic?` | SEON `Method`/`Constructor` |
| `Field` | `kind ∈ {field,property,constant,module_var}, type_ref, is_static, is_const` | |
| `Endpoint` | `protocol, method, route, handler_symbol` | Codebase-Memory `Route`; high value for domain linking |
| `DataEntity` | `kind ∈ {table,collection,index,migration}, name` | ORM entity / SQL table — the strongest bridge to domain concepts |
| `ExternalPackage` | `ecosystem, name, version_range, purl, license` | SPDX/CycloneDX bridge; `purl` as identity |
| `Doc` | `path, kind ∈ {readme,adr,comment_block,docstring,spec}` | the LLM's main evidence surface |
| `Test` | (or `Callable.is_test`) | prefer a flag; SPDX `hasTest` edge |
| `Commit` (optional) | `sha, author, authored_at, message` | only if history features enabled; SEON history.owl |

*Deliberately excluded:* AST nodes, statements, parameters-as-nodes (keep as JSON on `Callable`), local variables. Rationale: §2.3, §2.2 scale ratios.

**Derived (`layer='derived'`)**
`Community` (`level, algorithm='leiden', parent_community_id, size, cohesion`), `CommunityReport` (`title, summary, key_nodes[], generated_by_run`), `Metric` (optional, or props on nodes), `Clone` (SEON clones.owl), `Hotspot`.

**Semantic (`layer='semantic'|'curated'`)** — SKOS-shaped
| type | maps to | key props |
|---|---|---|
| `ConceptScheme` | `skos:ConceptScheme` | `title, scope, graph_id` |
| `Concept` | `skos:Concept` | `pref_label, alt_labels[], definition, scope_note, examples[], kind ∈ {domain_object, capability, process, rule, quality, external_system}` |
| `Term` | `skos:Concept` in a glossary scheme | ubiquitous-language token as written in code |
| `Actor` | | user/role/persona/service |
| `Policy` | | invariant, business rule, constraint |
| `Question`/`Decision` (optional) | ADR bridge | links to AWB tickets/ADRs |

Concept `kind` is a small closed enum on purpose — LLMs are far more reliable at classifying into ~6 buckets than at inventing a class hierarchy (https://arxiv.org/pdf/2508.19428).

### 8.4 Edge types (core profile)

**Structural**
`CONTAINS` (dir→dir/file, file→type/callable, type→callable/field) · `DECLARES` · `IMPORTS` (file→file|module|ExternalPackage) · `CALLS` (+`resolution`, `call_count`) · `REFERENCES` · `USES_TYPE` · `EXTENDS` · `IMPLEMENTS` · `OVERRIDES` · `INSTANTIATES` · `RETURNS_TYPE` · `THROWS` · `READS` / `WRITES` (callable→field/DataEntity) · `DEPENDS_ON` (module/repo→ExternalPackage) · `TESTS` (test callable→callable) · `EXPOSES` (Endpoint→Callable) · `CALLS_HTTP` (Callable→Endpoint, cross-service) · `PERSISTS_TO` (Callable/Type→DataEntity) · `DOCUMENTS` (Doc→any).

**Derived**
`MEMBER_OF` (node→Community) · `SUMMARIZES` (CommunityReport→Community) · `CO_CHANGED_WITH` (+`support`, `confidence` from lift/Jaccard over commit history; SEON change-couplings.owl) · `CLONE_OF` · `SIMILAR_TO` (embedding cosine, +`score`, +`model`).

**Semantic**
`REALIZES` (code node → Concept; "this code implements this domain concept") · `MENTIONS` (File/Doc → Concept; lexical, cheap, high-recall/low-precision) · `BROADER` / `NARROWER` / `RELATED` (Concept↔Concept, SKOS semantics incl. broader⊥related) · `CLOSE_MATCH` / `EXACT_MATCH` (cross-scheme alignment; LLM writes `CLOSE_MATCH` only) · `GOVERNS` (Policy→code/Concept) · `PERFORMS` (Actor→Concept/Endpoint) · `DERIVED_FROM` (`prov:wasDerivedFrom`) · `CONTRADICTS` (explicit conflict marker between two statements, with both retained and ranked).

**Bridge to AWB (differentiator)**
`AFFECTS_CODE` (Ticket→code node; SEON `affectsCodeEntity`) · `ABOUT` (Ticket→Concept). Lets an agent ask "which concepts does this ticket touch, and which code realises them" and lets the board show "this concept has 4 open tickets". KGCompass evidence (58.3% SWE-bench Lite) says issue↔code linking is worth real accuracy.

### 8.5 Required property sets

**Every node**
`id (uuid) · graph_id · symbol_id (stable, version-stripped, SCIP-shaped, UNIQUE per graph) · type · kind · layer · name · qualified_name · path · start_line · end_line · content_hash · lang · status ∈ {active, stale, removed, quarantined} · confidence · confidence_method · first_seen_commit · last_seen_commit · valid_from_commit · valid_to_commit · extraction_run_id · profile_version · props (JSON) · embedding_id (nullable) · degree, pagerank (cached) · updated_at`

**Every edge**
`id · graph_id · src_id · dst_id · type · layer · confidence · confidence_method · support · resolution (structural only) · evidence_kind ∈ {parser, indexer, git, heuristic, cooccurrence, embedding, llm, human} · evidence_ref (JSON [{path,start,end,content_hash}] — REQUIRED when layer='semantic') · rank ∈ {preferred, normal, deprecated} · completeness ∈ {complete, incomplete, no_assertion} · extraction_run_id · model_id · prompt_version · first_seen_commit · last_seen_commit · valid_from_commit · valid_to_commit · status · props (JSON)`

Indexes (mirroring `RelationTuple`): `(graph_id, src_id, type)`, `(graph_id, dst_id, type)`, `(graph_id, type, layer)`, `(graph_id, status, layer)`, and on nodes `(graph_id, symbol_id) UNIQUE`, `(graph_id, path)`, `(graph_id, type, layer)`.

### 8.6 Freshness / incrementality
1. `git diff last_indexed_commit..HEAD --name-status` → changed/renamed/deleted paths.
2. Per changed file: XXH3/blake3 hash; unchanged hash → skip (Codebase-Memory: ~4× speedup).
3. Re-parse changed files *in isolation* (stack-graphs' file-incremental discipline), diff node sets by `symbol_id`: unseen → insert; seen → update position/hash; missing → `valid_to_commit = HEAD`, `status='removed'`.
4. **Soft-edge invalidation without any LLM call:** any `semantic` edge whose `evidence_ref[].content_hash` no longer matches the file's current slice flips to `status='stale'` and is dimmed in UI / filtered from agent queries by default. Re-promotion is queued, budgeted, and lazy.
5. Communities: incremental Leiden maintenance (https://arxiv.org/abs/2601.08554), full recompute only on drift threshold.
6. Track `dirty_ratio` per graph; the UI shows "graph is 96% fresh as of <sha>" — honesty beats silent staleness (cf. SPDX `completeness`).

### 8.7 Scale/rendering note
Do not render the raw graph. Render the **community hierarchy** with level-of-detail expansion. sigma.js struggles at ~5k styled nodes and its force layout degrades past ~50k edges; cosmos.gl/Cosmograph runs the whole force simulation in GPU shaders and handles ~1M nodes/edges (https://www.sigmajs.org/, https://github.com/cosmosgl/graph, https://cosmograph.app/docs-general/concept/, https://nightingaledvs.com/how-to-visualize-a-graph-with-a-million-nodes/). Encode `layer` visually (solid = structural, dashed/translucent = semantic, gold = curated) and `confidence` as opacity — separability must be visible, not just queryable.

---

## 9. Workspace extensibility

**Two-tier profile system.**
- `core@X.Y.Z` — AWB-owned, frozen per release, semver'd, with `priorVersion` / `backwardCompatibleWith` / deprecation notes.
- `workspace_profile@N` — **additive only**, stored in `ontology_types` / `ontology_edge_types` tables:
  `{ name, iri, extends (a core type — REQUIRED), category (node|edge), description, domain[], range[], min_count, max_count, required_props[], prop_schema (JSON-Schema), allowed_layers[], color, icon, llm_hint, deprecated, since_profile_version }`.
- **Constraint language = SHACL-shaped JSON**, not full SHACL: node shapes / property shapes with `class, datatype, minCount, maxCount, in, pattern` (https://www.w3.org/TR/shacl/, https://www.w3.org/TR/shacl12-core/). SHACL's own spec notes shapes are usable "for a variety of purposes beside validation, including user interface building, code generation and data integration" — so the same profile record drives the graph legend, the node inspector form, and the LLM extraction prompt. One source of truth.
- **`extends` is mandatory** so every workspace type degrades gracefully: a core-only query for `Concept` still matches a workspace `RegulatoryConcept`; a core query for `CALLS` still matches `RPC_CALLS extends CALLS`.
- **Extraction is schema-constrained both ways:** the allowed type list is injected into the prompt, and every returned triple is type-checked against domain/range before insert; violations are dropped and counted (drop-rate is a quality metric worth showing). Evidence: OG-RAG +55%/+40%; schema-guided extraction with post-hoc type checking (https://arxiv.org/html/2603.25152).
- **Type proposals:** the LLM may emit `proposed_types` into a review queue (never live), matching AWB's existing `SkillProposal` flow. Promotion bumps `workspace_profile` version.
- **Never delete a type:** `deprecated=true` + note, keep ≥1 release; existing nodes keep working (OWL/OBO practice).
- Per-workspace **seed vocabularies**: let users upload a glossary (CSV/SKOS/Markdown) as the initial `ConceptScheme`; the LLM then *links* code to existing terms rather than inventing them — this is the single biggest precision win and directly mitigates the "LLMs build barely-overlapping KGs" reproducibility problem.

---

## 10. Answer to the key question

> **What is the right node/edge taxonomy for a per-folder ontology graph mixing hard code facts and soft LLM domain concepts, so both stay trustworthy and separable?**

**Two disjoint node namespaces joined by exactly one class of bridge edge, with a layer discriminator and write-scope enforcement.**

1. **Hard side** — a SEON-`code.owl`-derived, declaration-granularity structure graph (`Repository, Directory, File, Module, Type, Callable, Field, Endpoint, DataEntity, ExternalPackage, Doc`), identified by SCIP-shaped stable `symbol_id`, produced only by deterministic extractors, never by an LLM. Truth is *reproducible*: delete and re-derive from git at any time and you get the same graph.
2. **Soft side** — a SKOS concept scheme per graph (`Concept, Term, Actor, Policy` with a 6-value `kind` enum), deliberately not OWL classes so it can never entail anything about the hard side. `skos:broader` non-transitivity and `broader ⊥ related` are load-bearing safety properties.
3. **Bridge** — `REALIZES` (code → Concept) and `MENTIONS` (doc/file → Concept), each carrying **mandatory `evidence_ref` with content hashes**, `confidence` + `confidence_method`, `support`, `model_id`, `prompt_version`, `rank`. These edges are the only place the two worlds touch, so trust can be audited, filtered, bulk-invalidated, or bulk-deleted at exactly one join.
4. **Separability mechanics** (all four required, none optional):
   - `layer` column on nodes and edges, defaulted-filtered in the API and visually encoded in the UI;
   - a write-scope rule enforced in the service layer: LLM runs cannot touch `structural`/`derived` rows;
   - `resolution` on structural edges so heuristic tree-sitter call edges are not laundered as facts;
   - evidence-hash-based auto-staleness so soft claims expire the moment their justification changes.
5. **Trustworthiness mechanics:** agreement-based (not self-reported) confidence, ordinal buckets in the UI, orphan-concept quarantine, `CONTRADICTS` + `rank` instead of silent overwrite, `completeness` markers for partial indexes, and every agent-facing result returning `path:line` so the agent can verify by reading the source.

The economics that make it viable at 100k+ nodes: tier-0/1 (parse + noun-phrase + co-occurrence + Leiden) are LLM-free at vector-RAG cost (0.1% of GraphRAG indexing), and tier-2 LLM promotion happens lazily under an explicit budget only for folders the user opens or tickets touch — LazyGraphRAG's exact tradeoff, with published 700× query-cost and 1000× index-cost reductions at equal-or-better quality.

---

## Sources

1. SEON project — http://se-on.org/ ; ontology files — https://github.com/sealuzh/onts-seon (main.owl, code.owl, history.owl, issues.owl, integration-history-issues-code.owl)
2. Würsch, Ghezzi, Hert, Reif, Gall — "SEON: a pyramid of ontologies for software evolution and its applications", *Computing* 2012 — https://link.springer.com/article/10.1007/s00607-012-0204-1 ; PDF http://www.zora.uzh.ch/72255/1/20121211115643_merlin-id_7143.pdf
3. Atzeni & Atzori — "CodeOntology: RDF-ization of Source Code", ISWC 2017 — https://link.springer.com/chapter/10.1007/978-3-319-68204-4_2 ; docs http://codeontology.org/doc ; namespace http://rdf.webofcode.org/woc/ ; ISWC demo https://ceur-ws.org/Vol-1963/paper543.pdf
4. SCIP Code Intelligence Protocol — https://scip-code.org/ ; schema https://github.com/sourcegraph/scip ; announcement https://sourcegraph.com/blog/announcing-scip
5. Creager & van Antwerpen — "Stack graphs: Name resolution at scale" — https://arxiv.org/abs/2211.01224 ; https://github.blog/open-source/introducing-stack-graphs/
6. SPDX 3.0.1 Relationship class — https://spdx.github.io/spdx-spec/v3.0.1/model/Core/Classes/Relationship/ ; RelationshipType vocabulary — https://spdx.github.io/spdx-spec/v3.0.1/model/Core/Vocabularies/RelationshipType/ ; SBOM format comparison — https://fossa.com/blog/sbom-formats-compared-explained/
7. schema.org software terms / CodeMeta — https://codemeta.github.io/terms/ ; schema.org software-types profile — https://github.com/SoftwareUnderstanding/software_types
8. W3C SKOS Reference — https://www.w3.org/TR/skos-reference/ ; SKOS Primer — https://www.w3.org/TR/skos-primer/ ; ISKO encyclopedia entry — https://www.isko.org/cyclo/skos.htm
9. W3C PROV-O — https://www.w3.org/TR/prov-o/ ; PAV (provenance/authoring/versioning) — https://arxiv.org/pdf/1304.7224
10. Microsoft GraphRAG indexing methods (standard vs fast) — https://github.com/microsoft/graphrag/blob/main/docs/index/methods.md
11. LazyGraphRAG — https://www.microsoft.com/en-us/research/blog/lazygraphrag-setting-a-new-standard-for-quality-and-cost/
12. OG-RAG: Ontology-Grounded RAG (EMNLP 2025) — https://arxiv.org/abs/2412.15235 ; https://aclanthology.org/2025.emnlp-main.1674/ ; MSR page https://www.microsoft.com/en-us/research/publication/og-rag-ontology-grounded-retrieval-augmented-generation-for-large-language-models/
13. OMD-GraphRAG (ontology-guided extraction + multi-dim clustering) — https://arxiv.org/html/2603.25152 ; Ontology learning & KG construction survey — https://arxiv.org/pdf/2511.05991
14. LLM-empowered knowledge graph construction: a survey — https://arxiv.org/html/2510.20345v1 ; Heterogeneous LLM methods for ontology learning — https://arxiv.org/pdf/2508.19428 ; LLM-driven ontology construction for enterprise KGs — https://arxiv.org/html/2602.01276v1
15. Uncertainty Management in the Construction of Knowledge Graphs: a Survey — https://arxiv.org/html/2405.16929v2 ; TGDK PDF https://drops.dagstuhl.de/storage/08tgdk/tgdk-vol003/tgdk-vol003-issue001/TGDK.3.1.3/TGDK.3.1.3.pdf
16. "LLMs build inconsistent knowledge graphs from one corpus: a five-axis benchmark" — https://www.frontiersin.org/journals/immunology/articles/10.3389/fimmu.2026.1937268/full ; Double-Calibration — https://arxiv.org/html/2601.11956 ; Benchmarking LLMs for KG validation — https://arxiv.org/html/2602.10748v1
17. Ontology-grounded KGs reduce clinical LLM hallucination 63%→1.7% — https://www.sciencedirect.com/science/article/abs/pii/S1532046426000171
18. RDF vs LPG: "Bridging graph data models: RDF, RDF-star, and property graphs as DAGs" — https://arxiv.org/pdf/2304.13097 ; "Graph? Yes! Which one? Help!" — https://arxiv.org/pdf/2110.13348 ; "Converting Property Graphs to RDF" — https://dl.acm.org/doi/pdf/10.1145/3534540.3534695 ; edge properties & reification — https://douroucouli.wordpress.com/2020/09/11/edge-properties-part-1-reification/ ; https://memgraph.com/docs/data-modeling/graph-data-model/lpg-vs-rdf
19. Named graphs / quads as provenance-and-trust partitions — https://patterns.dataincubator.org/book/named-graphs.html ; "Knowledge Graphs: The Layered Perspective" — https://link.springer.com/chapter/10.1007/978-3-030-53199-7_2
20. Wikidata data model (statements, qualifiers, references, rank) — https://www.wikidata.org/wiki/Wikidata:Data_model ; https://www.wikidata.org/wiki/Help:Ranking ; https://www.wikidata.org/wiki/Help:Qualifiers
21. W3C SHACL — https://www.w3.org/TR/shacl/ ; SHACL 1.2 Core — https://www.w3.org/TR/shacl12-core/ ; "Type Checking Program Code using SHACL" — https://arxiv.org/pdf/1907.00855
22. OWL 2 Structural Specification (versionIRI, priorVersion, deprecated) — https://www.w3.org/TR/owl2-syntax/ ; FAIR vocabulary/ontology best practices — https://arxiv.org/pdf/2003.13084 ; OBO Foundry versioning principle — http://obofoundry.org/principles/fp-004-versioning.html
23. Bitemporal / probabilistic KGs — https://dl.acm.org/doi/fullHtml/10.1145/3184558.3191637 ; BiTemporal RDF — https://www.mdpi.com/2227-7390/13/13/2109 ; Schema Validation and Evolution for Graph Databases — https://arxiv.org/pdf/1902.06427
24. Code Property Graphs / IR survey — https://arxiv.org/pdf/2405.12841 ; source-code representations survey — https://arxiv.org/pdf/2403.10646
25. RepoGraph (ICLR 2025) — https://arxiv.org/html/2410.14684v1 ; CodexGraph (NAACL 2025) — https://aclanthology.org/2025.naacl-long.7/ ; LocAgent (ACL 2025) — https://arxiv.org/pdf/2503.09089
26. Codebase-Memory: tree-sitter KGs for LLM code exploration via MCP (SQLite, XXH3 incremental, 2.1M-node Linux kernel) — https://arxiv.org/html/2603.27277v1
27. Leiden — https://neo4j.com/docs/graph-data-science/current/algorithms/leiden/ ; GraphRAG hierarchical levels discussion — https://github.com/microsoft/graphrag/discussions/1128 ; Maintaining Leiden communities in large dynamic graphs — https://arxiv.org/abs/2601.08554
28. Large-graph rendering — https://www.sigmajs.org/ ; cosmos.gl — https://github.com/cosmosgl/graph ; Cosmograph concept — https://cosmograph.app/docs-general/concept/ ; "How to Visualize a Graph with a Million Nodes" — https://nightingaledvs.com/how-to-visualize-a-graph-with-a-million-nodes/ ; Carina million-node browser viz — https://arxiv.org/pdf/1702.07099
29. LLM architecture-traceability / concept location — https://fuchss.org/assets/pdf/2025/icsa-25.pdf ; "Extracting Conceptual Knowledge to Locate Software Issues" — https://arxiv.org/html/2509.21427v2 ; RECoRD multi-agent reverse engineering — https://openreview.net/pdf?id=TW0p8AwbAB
