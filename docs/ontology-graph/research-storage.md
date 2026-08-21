# Storage & Query Engine — Deep Technology Research (for AWB Ontology Graph)

Date: 2026-08-22. Target: validate and harden — not re-litigate — the base decision already made in `research-ontology.md` ("Labelled property graph, stored relationally in SQLite (dev) / PostgreSQL (prod); RDF/OWL is vocabulary + export only"). This document answers the operational question that decision left open: **does that storage actually hold up at AWB's projected scale (~280k definition nodes / ~2.4M raw reference edges at 10 MLOC, per `research-extraction.md` §1), on both required backends, for the query shapes an agent will actually issue (blast radius, N-hop neighbors, shortest call path)?** And it resolves the four adjacent tooling questions the architect needs before implementation: DuckDB as an OLAP sidecar, Oxigraph/RDF for export, sqlite-vec/pgvector for the semantic layer, and what comparable code-intelligence systems chose for storage and why.

**Bottom line up front:** SQLite recursive CTEs and Postgres recursive CTEs are the right engine for AWB's actual workload — **bounded-depth, cycle-guarded traversal** (blast radius, N-hop neighbors) — and there is direct evidence this holds at scales larger than AWB's target. But there is one **specific, well-documented, catastrophic failure mode** — unbounded shortest-path / distance-relaxation queries expressed as a single monolithic recursive CTE — that both engines share and neither has a native fix for (that fix, DuckDB's `USING KEY`, is 2025-2026-vintage and DuckDB-only). AWB's `graph_call_path` tool must be implemented as **bounded, leveled, application-orchestrated BFS**, never as one open-ended recursive CTE. DuckDB earns a real but narrowly-scoped role: a **read-only, ATTACH-based analytics sidecar** over the exact same SQLite file or Postgres instance AWB already runs (zero ETL), for OLAP-shaped aggregate queries — not (yet) as a live graph-traversal engine, since its graph-native features (SQL/PGQ, algorithm extensions) are still community-maintained and pre-1.0. Oxigraph is **not worth embedding**: its JS/WASM binding is explicitly "work in progress," in-memory-only, with no `LOAD` support — a plain streaming relational→RDF serializer (`N3.js` + `jsonld.js`) does everything the export-only requirement needs at a fraction of the dependency cost. sqlite-vec **cannot be adopted today** without forking AWB's `sql.js` dependency, because — confirmed by the extension's own author — a WASM SQLite build cannot dynamically load *any* extension, sqlite-vec included; AWB's existing brute-force JS cosine-similarity pattern (`ResourceEmbedding` + `embedding.service.ts`) already satisfies the dual-backend constraint by construction and should stay the default, with pgvector added later as a Postgres-only accelerator once measured volume warrants it. And every serious code-intelligence system surveyed (Sourcegraph, CodeQL, Glean) either uses a relational store for structured/metadata data plus a specialized index for exactly one hot workload, or — like Glean — accepts heavy, RocksDB-class operational cost that AWB's multi-tenant, TypeORM-integrated, no-dedicated-ops-team reality doesn't support. AWB's existing pattern (relational core + narrow specialized add-ons) is the industry-standard shape, not a compromise.

---

## 0. TL;DR decisions

| Question | Decision | Primary evidence |
|---|---|---|
| SQLite recursive CTE at 280k nodes/2.4M edges | **Yes for bounded traversal** (blast radius, N-hop neighbors) with a depth cap + path cycle-guard; **no** for unbounded shortest path as a single query | https://sqlite.org/lang_with.html , https://sqlite.org/forum/info/3b309a9765636b79 , https://arxiv.org/html/2603.27277v1 |
| Same pattern on Postgres | **Yes**, same mechanics (+ nicer `SEARCH`/`CYCLE` sugar), **same** catastrophic-shortest-path risk, **real production incident on record** | https://www.postgresql.org/docs/current/queries-with.html , https://gitlab.com/gitlab-org/gitlab/-/issues/325688 |
| Root cause of the failure mode | Standard `UNION ALL` recursive-CTE semantics re-derive every distinct path to a node (no cross-path "already settled" memory) — universal to SQLite/Postgres, not an implementation bug | https://sqlite.org/forum/info/3b309a9765636b79 (Keith Medcalf), https://duckdb.org/2025/05/23/using-key |
| Quantified blowup | Vanilla recursive CTE on a **424-node** toy graph: **605.9M** rows vs **19,213** with settled-set semantics (31,500×) | https://duckdb.org/2025/05/23/using-key |
| `graph_call_path` implementation | **Application-orchestrated, bounded, leveled BFS** (one small query per hop, running visited-set), never one open-ended recursive CTE | derived from above + https://sqlite.org/forum/info/3b309a9765636b79 |
| TypeORM support | **None** — no recursive-CTE query-builder API on either dialect; must use `dataSource.query()` raw SQL, one hand-maintained variant per dialect | https://github.com/typeorm/typeorm/issues/1116 , https://github.com/typeorm/typeorm/issues/10731 |
| DuckDB role | **Read-only ATTACH-based OLAP sidecar** (zero ETL, reads the same SQLite file / Postgres instance) for aggregate queries; graph-native features (SQL/PGQ, algorithms) are real but pre-1.0, community-maintained — defer | https://github.com/motherduckdb/sqlite_scanner , https://duckdb.org/docs/current/core_extensions/postgres/overview , https://duckpgq.org/documentation/graph_functions/ |
| Oxigraph for RDF export | **Skip it.** JS/WASM binding is in-memory-only, "work in progress," `LOAD` unsupported (own README) — no benefit over direct serialization for an export-only requirement | https://github.com/oxigraph/oxigraph/blob/main/js/README.md |
| RDF/JSON-LD export mechanism | **N3.js** (Turtle/N-Quads streaming writer) + **jsonld.js** (compact/expand/canonicalize) directly off the relational tables | https://github.com/rdfjs/N3.js , https://www.npmjs.com/package/jsonld |
| sqlite-vec adoption | **Not now.** AWB's dev backend is `sql.js`; WASM SQLite cannot dynamically load *any* extension (confirmed by sqlite-vec's own author) — would require forking `sql.js` to statically bundle it | https://alexgarcia.xyz/sqlite-vec/wasm.html |
| Vector schema | **Mirror `ResourceEmbedding`** exactly for ontology nodes; brute-force JS cosine stays the default (dual-support by construction); pgvector HNSW as an **optional Postgres-only** accelerator gated by measured volume | direct repo read: `apps/server/src/entities/ResourceEmbedding.ts`, `apps/server/src/services/embedding.service.ts` ; https://github.com/pgvector/pgvector |
| Other backends' storage choice | Sourcegraph: Postgres (structured) + Zoekt (bespoke mmap'd trigram shards); CodeQL: bespoke Datalog EDB, not SQL at all; Glean: RocksDB LSM-tree; Aider: **no persistent storage** (in-memory networkx, rebuilt per run) | see §7 |

---

## 1. AWB's actual storage surface today (grounding, not theory)

Before evaluating anything new, it matters what AWB already runs, because two existing patterns are direct precedent for the ontology graph and constrain the answer:

**`RelationTuple`** (`apps/server/src/entities/RelationTuple.ts`) is already a subject/relation/object edge table with three composite indexes — `(object_type, object_id, relation)`, `(subject_type, subject_id, relation)`, `(subject_type, subject_id, object_type, object_id)` — used for the ReBAC permission graph. `research-ontology.md` §1 already points at this as the pattern to reuse for the ontology graph's node/edge tables. This document's index recommendations in §8 are index *additions* on top of that same shape, not a new one.

**`ResourceEmbedding`** (`apps/server/src/entities/ResourceEmbedding.ts`) + `embedding.service.ts` is AWB's *only* existing vector-search code today, and it is instructive precisely because of what it does **not** do: the embedding column is `@Column({ type: 'text' })` holding a JSON-stringified `number[]`, and `search_resources` (`apps/server/src/modules/mcp/tools/resource-tools.ts:198-239`) loads every candidate row, `JSON.parse`s the vector, and calls the hand-written `cosineSimilarity()` helper in a JS loop — **100% brute force, zero vector index, on either backend.** This is AWB's real dual-support baseline for embeddings, and it works today only because resource counts are small. §6 below revisits whether that assumption survives ontology-graph volumes.

**`db.ts`** confirms two facts load-bearing for this report: (1) dev is **`sql.js`** (a WASM build of SQLite), not `better-sqlite3` or `node:sqlite` — this matters enormously for §2 and §6 below, because WASM SQLite cannot dynamically load native extensions at all; (2) sql.js runs a **batched-flush model** — writes mark a `sqljsDirty` flag and are periodically persisted to `database/data.db` on disk, not written through synchronously. Any tool (like DuckDB, §4) that reads the on-disk file directly is reading a slightly-stale snapshot unless a flush is forced first.

**TypeORM** provides no query-builder API for `WITH RECURSIVE` on any dialect (open since 2017: https://github.com/typeorm/typeorm/issues/1116; a 2024+ proposal for dynamic recursive query building is still a PoC: https://github.com/typeorm/typeorm/issues/10731). Every recursive-CTE query in this design will go through `dataSource.query(rawSql, params)` — TypeORM's raw-SQL escape hatch — with one hand-maintained SQL string per dialect family. This is a real, if small, implementation tax worth budgeting into the design now rather than discovering mid-build.

---

## 2. Does a SQLite recursive CTE actually carry a 280k-node / 2.4M-edge graph?

### 2.1 The mechanics, from the primary source

SQLite's own documentation (https://sqlite.org/lang_with.html) is unambiguous on the two levers that determine whether a recursive CTE is safe: **(a)** `ORDER BY` on the recursive-select controls depth-first vs. breadth-first emission order, and **(b)** `UNION` (not `UNION ALL`) is what prevents infinite loops on a cyclic graph — but at a cost: "when using `UNION ALL`, SQLite does *not* accumulate a temporary table," whereas `UNION` must retain and compare every previously generated row to deduplicate, which is real memory and CPU. The docs explicitly recommend an unconditional `LIMIT` as "a safety if an upper bound on the size of the recursion is known" — the single cheapest defense against a runaway query, and one AWB should make **structurally mandatory**, not optional, on every MCP-exposed traversal tool.

### 2.2 Evidence at scale — and its limits

Three independent data points bound the safe zone:

- **`sqlite-graph`** (a small production-oriented library implementing exactly this pattern) states its own design envelope plainly: **"designed for graphs up to ~100K nodes," single-digit-millisecond traversal at depth 2–3**, and explicitly recommends graduating to Neo4j/Memgraph past 100K entities *with deep traversals*, or Postgres for concurrent multi-writer needs (https://github.com/shwetarkadam/sqlite-graph). This is smaller than AWB's 280k-node target, and the caveat ("with deep traversals") matters — it is depth, not raw row count, that is the actual danger axis (see §2.3).
- **Codebase-Memory** (`arxiv.org/html/2603.27277v1`, already the closest analog cited in both prior AWB research docs) reports **~0.3 ms** for a BFS call-path trace at depth 5, and sub-millisecond Cypher-equivalent lookups, via **recursive CTE** — explicitly: "the MCP Agent resolves structural queries via pre-computed graph lookups (breadth-first search via SQL recursive Common Table Expression: ∼0.3 ms)." The measured corpus for that number is **Django: 49,398 nodes / 196,022 edges** — roughly **1/6 the nodes and 1/12 the edges** of AWB's 280k/2.4M target. The paper separately indexes the Linux kernel (2.1M nodes / 4.9M edges, larger than AWB's target) but does not publish a query-latency number at that scale — so the closest *directly measured* analog is smaller than AWB's target, not larger. Treat 0.3 ms as strong directional evidence for **bounded, shallow (≤5-hop) traversal**, not as proof at 280k/2.4M.
- The **SQLite official forum** ("Breadth-first graph traversal", https://sqlite.org/forum/info/3b309a9765636b79) surfaces the actual mechanical limitation, from core contributor Keith Medcalf: *"the reference to the recursive table in the recursive select is a reference to the singleton row being recursed. You do not have access to other rows in the recursive table."* In plain terms: **a recursive CTE step cannot see whether a *different* branch of the recursion has already visited a node.** The only per-step protection available is a path-column cycle guard, which prevents *re-entering the current path* (true cycles) but does **nothing** to stop the same node being re-explored once per distinct **incoming** path — which is exactly what happens at every fan-in point (a popular shared utility function called from 40 places) in a real call graph. This is the mechanical root cause behind §2.3, and it is dialect-agnostic — Postgres has the identical limitation (§3). The thread's own resolution was a bespoke **C virtual-table extension using an in-memory AVL tree** to maintain a true cross-branch visited set (https://github.com/abetlen/sqlite3-bfsvtab-ext) — which, being a loadable extension, **cannot be used from `sql.js`** either (see the WASM extension-loading constraint in §6.1 — this is the same wall sqlite-vec hits).

### 2.3 The failure mode nobody warns you about — quantified

The clearest, most concretely quantified evidence in this whole investigation comes not from a SQLite blog but from DuckDB's own engineering writeup of **why they had to add non-standard SQL** to fix exactly this class of query. DuckDB's `USING KEY` post (https://duckdb.org/2025/05/23/using-key) explains that a **standard recursive CTE accumulates every distinct path to every node** — it has no notion of "this node is already settled at its best distance, stop deriving worse paths to it." Their benchmark, computing shortest paths over small social-network graphs:

| Graph size (nodes / edges) | Rows with settled-set semantics (`USING KEY`) | Rows with a vanilla recursive CTE |
|---|---|---|
| 184 / 233 | 744 | 352,906 |
| 322 / 903 | 8,232 | ~40,700,000 |
| 424 / 1,446 | 19,213 | ~605,900,000 |
| 484–1,618 nodes | scales smoothly | **out-of-memory crash** |

A **424-node** graph — smaller than a single mid-sized AWB folder — produces **606 million rows** and a memory blowup under the vanilla approach; the row count is growing worse than exponentially with graph size in this data. `USING KEY` is DuckDB's fix, shipped in DuckDB v1.3+ and hardened for the v2.0 line (https://duckdb.org/2026/08/17/duckdb-20-highlights), but it is **DuckDB-only, standard-SQL-noncompliant, and 2025–2026-vintage** — neither SQLite nor Postgres has an equivalent, and none is on either project's public roadmap as of this research. **Extrapolating the trend to AWB's 280k-node target is not optimistic: a single unbounded recursive-CTE shortest-path query at that scale is not "slow," it is essentially certain to exhaust memory before returning**, for exactly the mechanical reason Keith Medcalf described in §2.2 (no cross-path dedup) applied at a scale three orders of magnitude past where it already crashes on toy data.

### 2.4 The concrete implication for AWB's two traversal shapes

`research-extraction.md` §5.3 already proposes `graph_neighbors(node, edge_types, depth)`, `graph_blast_radius(node)`, and `graph_call_path(from, to)` as MCP tools. §2.1–2.3 above split these into two mechanically different risk classes:

**Blast radius / N-hop neighbors — safe, with two mandatory guards.** This is *bounded* by construction: a small `max_depth` (AWB should default this low — 3 to 6 hops — and refuse to run unbounded) means the recursion terminates in a fixed number of steps regardless of graph size, and per-step fan-out is bounded by real-world average out-degree (`research-extraction.md`'s measured 243.6 refs/kLOC implies modest average degree, not a complete graph). An illustrative shape (SQLite dialect; cycle guard via delimited-string `instr()`, ported to a Postgres `text[]`/`ANY()` check for that dialect):

```sql
WITH RECURSIVE reach(id, depth, path) AS (
  SELECT :start_id, 0, ',' || :start_id || ','
  UNION ALL
  SELECT e.dst_id, r.depth + 1, r.path || e.dst_id || ','
  FROM edges e JOIN reach r ON e.src_id = r.id
  WHERE r.depth < :max_depth
    AND e.graph_id = :graph_id
    AND instr(r.path, ',' || e.dst_id || ',') = 0      -- cycle guard: current path only
)
SELECT id, MIN(depth) AS depth FROM reach GROUP BY id LIMIT :row_cap;   -- LIMIT: SQLite docs' mandatory safety valve
```
Note this still re-explores a node once per *distinct incoming path within the depth cap* (§2.2's fan-in problem) — acceptable because depth is capped, but it means query cost is closer to Σ(fan-in × fan-out)^depth than to node count, and **the `graph_id`-scoped indexes from `research-ontology.md` §8.5 are what keep each step an index seek rather than a scan.**

**Shortest call path — unsafe as one query, safe as an orchestrated loop.** `graph_call_path(from, to)` must **not** be implemented as a single recursive CTE reaching for an arbitrary, unbounded target. The safe pattern is **application-orchestrated bidirectional level-BFS**: issue one small SQL query per hop level (`SELECT dst_id FROM edges WHERE src_id IN (:frontier) AND dst_id NOT IN (:visited)`), maintain the running visited-set in application memory (or a temp table) between rounds, expand from both `from` and `to` simultaneously, and stop the instant the frontiers intersect or a hard depth ceiling (e.g. 10 hops) is hit. This is mechanically the same BFS Codebase-Memory measured at 0.3 ms — the difference is *where* the visited-set lives (application loop vs. inside one CTE), which is exactly the missing capability Medcalf's forum post identifies. For workspaces that want true weighted/all-pairs shortest-path analytics at the *module or community* level (not raw-symbol level, and not a live per-request MCP call), route that to the DuckDB sidecar in §4, whose whole reason for existing (`USING KEY`) is this exact query shape.

### 2.5 Why not just precompute the full transitive closure?

SQLite ships an official extension for exactly this — `ext/misc/closure.c`, a `transitive_closure` virtual table backed by an in-memory AVL tree (source: https://github.com/sqlite/sqlite/blob/master/ext/misc/closure.c, listing: https://sqlite.org/src/dir?ci=trunk&name=ext%2Fmisc; explained with benchmarks in https://charlesleifer.com/blog/querying-tree-structures-in-sqlite-using-python-and-the-transitive-closure-extension/, which found it "performed better in every case" than materialized-path alternatives on tree data, though the author flags those benchmarks as informal). It is the right idea for **hierarchical containment** (folder → file → class, which is a tree, not a general graph) but wrong for the reference/call graph: transitive closure of a 280k-node graph with realistic fan-out is **O(n²) in the worst case** and unbounded in practice for a graph with cycles (mutual recursion, circular imports are common in real code) — precomputing "everyone reachable from everyone" is a different, much larger problem than "everyone reachable from X within N hops," and AWB never needs the former. Skip it; it is also — like the AVL-tree BFS virtual table in §2.2 — a loadable C extension, so it inherits the same `sql.js` WASM-loading wall described in §6.1 and would not even be available in dev.

---

## 3. Does the same pattern hold on Postgres?

**Yes, with better syntax and a real production incident to prove the risk is not theoretical.** Postgres 14+ added standard-SQL `SEARCH ... SET ...` (depth-first/breadth-first control) and `CYCLE ... SET ... USING` clauses (https://www.postgresql.org/docs/current/queries-with.html) — genuinely nicer than SQLite's manual `ORDER BY`/path-column idioms, since Postgres will maintain the cycle-detection path column for you. But the underlying mechanics — §2.2's "no cross-path visited-set," §2.3's row-explosion on unbounded shortest-path queries — are **general properties of standard `UNION ALL` recursive-CTE semantics**, not a SQLite implementation quirk, and Postgres has no `USING KEY`-equivalent either. GitLab's own incident tracker documents a real occurrence: issue #325688 records an SLO alert where a `WITH RECURSIVE "namespaces_cte"` query traversing namespace/group-membership hierarchies "dominated" `pg_stat_statements` and drove a production Sidekiq/rails_sql slowdown (https://gitlab.com/gitlab-org/gitlab/-/issues/325688) — a company running Postgres at some of the largest scale in the industry still got bitten by exactly this query shape. Community reports corroborate the general pattern independent of this incident: Postgres recursive-CTE row-estimate misestimation is a recurring theme on the pgsql-performance mailing list, and query plans for recursive CTEs are documented as comparatively unsophisticated versus Postgres's non-recursive optimizer.

**Practical conclusion for AWB:** write the bounded-depth-plus-cycle-guard pattern from §2.4 **once per dialect** behind a small internal graph-query service (not exposed to agents as free-form SQL), using Postgres's `SEARCH`/`CYCLE` sugar where it simplifies the SQLite-style manual path-column approach, but applying the **identical depth cap, `LIMIT`, and never-a-single-unbounded-shortest-path rule to both dialects** — the risk is not SQLite-specific, and neither engine gets a pass.

---

## 4. DuckDB — real value, correctly scoped

### 4.1 The actual killer feature: zero-ETL ATTACH

DuckDB's `sqlite_scanner` and `postgres` extensions (https://github.com/motherduckdb/sqlite_scanner , https://duckdb.org/docs/current/core_extensions/postgres/overview) let DuckDB `ATTACH` directly to a live SQLite file *or* a running Postgres instance and query its tables as native DuckDB tables — no export, no second copy, no second consistency domain. For AWB's dual-support constraint this is close to ideal: the **same** DuckDB SQL runs against `database/data.db` in dev and against the production Postgres connection, because DuckDB itself is the thing that's portable, not the underlying store. This single fact is why DuckDB clears the bar the other candidates in this report don't: it does not ask AWB to pick a side of the SQLite/Postgres split.

**AWB-specific caveat, direct from `db.ts`:** because sql.js runs a batched-flush model (§1), a DuckDB `ATTACH 'database/data.db' (TYPE sqlite, READ_ONLY)` sweep in dev is reading whatever was last flushed to disk, **not** sql.js's live in-memory state. Any scheduled analytics job must force a flush first, or accept and label the staleness — this is a real, specific, previously-undocumented integration detail, not a generic caveat.

### 4.2 Graph-native features exist — but are pre-1.0

DuckDB's SQL/PGQ implementation (the `DuckPGQ` community extension, https://duckpgq.org/documentation/graph_functions/ , https://duckdb.org/docs/current/guides/sql_features/graph_queries) implements the SQL:2023 property-graph-query standard directly: `CREATE PROPERTY GRAPH ... VERTEX TABLES (...) EDGE TABLES (...)`, then `FROM GRAPH_TABLE(g MATCH (a)-[e]->(b) ...)` with variable-length-path quantifiers (`{1,3}`, `+`). It ships PageRank, weakly-connected-components, and local-clustering-coefficient as built-in algorithms. Several *other* community extensions add more (`DuckGQL`: CSR-backed PageRank/Louvain/degree/closeness/triangle-counting; `duckdb_petgraph`: PageRank/betweenness/closeness/eigenvector-centrality/Louvain via the Rust `petgraph` crate; `Onager`: centrality + community detection via the `Graphina` library) — a real, converging ecosystem. But DuckPGQ's own documentation states plainly: **"DuckPGQ is a community extension and is still under active development. It is not available in the latest DuckDB release (1.5.x)"** — pin to v1.4.4 for compatibility. None of the example usage shown for any of these extensions demonstrates running directly over an `ATTACH`ed external table; every example loads data into DuckDB's own native tables first, which would mean a **second, ETL'd copy of the graph inside DuckDB** — precisely the consistency-domain duplication §4.1's zero-ETL story was meant to avoid. **Not ready to be load-bearing yet.**

### 4.3 `USING KEY` is DuckDB quietly fixing §2.3's exact problem

Framed against §2.3: DuckDB's `USING KEY` recursive-CTE extension (https://duckdb.org/2025/05/23/using-key, formalized in a SIGMOD 2025 companion paper: https://dl.acm.org/doi/10.1145/3722212.3725107) is precisely the settled-set semantics that would make an *unbounded* shortest-path query safe — the thing SQLite and Postgres do not have. This is the concrete reason DuckDB earns a role in this architecture at all beyond "nice-to-have OLAP": it is a legitimate escape valve for the one query shape §2.3/§3 rule out on the two primary engines, *if and when* the workspace explicitly wants module/community-level all-pairs analytics as a scheduled batch job rather than a live per-request MCP call.

### 4.4 Embeddability and integration point

DuckDB is fully embeddable in the NestJS process via the official `@duckdb/node-api` package (npm; a modern promise-native client wrapping DuckDB's C API, superseding the older deprecated `duckdb` npm package — https://www.npmjs.com/package/@duckdb/node-api , https://github.com/duckdb/duckdb-node). No subprocess, no separate service to operate.

### 4.5 Recommendation

Adopt DuckDB **today** as a **scheduled, read-only, ATTACH-based analytics sidecar** — a background job (AWB already has the `WorkspaceSchedule`/`QaSchedule` pattern to model this on) that forces a sql.js flush (dev) or connects read-only to Postgres (prod), attaches, runs plain columnar `GROUP BY` aggregates (degree distribution, per-layer/per-type edge counts, community size histograms, "top-N highest fan-in symbols") that would otherwise mean either hand-written aggregate SQL competing with live OLTP traffic or loading the whole edge table into Node to aggregate in JS, and materializes the results into a small stats table the UI reads. **Defer** SQL/PGQ and the algorithm extensions until DuckPGQ (or an equivalent) stabilizes into a non-community, ATTACH-compatible feature — track the DuckDB v2.0 release notes (https://duckdb.org/2026/08/17/duckdb-20-highlights) as the maturity signal to watch.

---

## 5. RDF/OWL export: Oxigraph vs. rdflib vs. plain serialization

`research-ontology.md` §1 already decided RDF/OWL is "vocabulary + export (JSON-LD context)," never the live store. The only open question is *what serializes the export* — and the answer is: **nothing resembling a triple store.**

**Oxigraph** (https://github.com/oxigraph/oxigraph) is a genuinely fast Rust SPARQL engine, but its **JS/WASM binding is explicitly immature by its own documentation**: *"Oxigraph for JavaScript is a work in progress and currently offers a simple in-memory store... The LOAD operation is not supported yet"* (https://github.com/oxigraph/oxigraph/blob/main/js/README.md) — **no disk persistence at all** in the Node/browser binding, unlike the native Rust/Python (RocksDB-backed) build. A maintainer-run benchmark discussion (https://github.com/oxigraph/oxigraph/discussions/1092) shows Oxigraph's in-memory store beating Python RDFLib substantially on parse (19.6 ms vs. 59.3 ms), SPARQL query (20 ms vs. 752 ms), and serialization (5.6 ms vs. 58.2 ms) — but **losing** to RDFLib on direct triple-pattern matching (240–300 ms vs. 92 ms), attributed to term-conversion overhead across the Rust/Python boundary. For AWB's use case — a one-shot, on-demand export of an already-materialized relational graph, not live SPARQL querying — none of Oxigraph's strengths are relevant, and its two real weaknesses (immature JS binding, no persistence) are directly disqualifying. Adopting it would mean materializing the **entire graph into RDF in WASM memory** before you could serialize it — the same cost as direct serialization, plus a WASM dependency, plus an admittedly-unstable API surface.

**rdflib**, if the Python library is meant, is a **non-starter for embedding**: AWB's server is NestJS/TypeScript; pulling in Python rdflib means a subprocess or a separate microservice, a categorically heavier integration than anything else considered in this report. **rdflib.js** (the JS library, https://github.com/linkeddata/rdflib.js) is actively maintained (v2.4.0, ~2 months old as of this research) but is a general Solid/Linked-Data-Platform client library, not a purpose-built serializer, and offers no advantage over the RDF/JS-ecosystem alternative below.

**The right answer**: **N3.js** (https://github.com/rdfjs/N3.js — "Lightning fast, spec-compatible, **streaming** RDF for JavaScript," implements the standard RDF/JS interfaces, parses/writes Turtle, TriG, N-Triples, N-Quads, actively maintained) for Turtle/N-Quads output, paired with **jsonld.js** (https://www.npmjs.com/package/jsonld, the reference `digitalbazaar/jsonld.js` implementation — compact/expand/flatten/frame/canonicalize per the W3C algorithms) for the JSON-LD path `research-ontology.md` already specified. Both stream, both are RDF/JS-standard (interoperable with each other and with Comunica if a query engine is ever needed later), and together they do **exactly** the export job — `SELECT` the relational nodes/edges, map through the `@context` (`woc:`, `seon:`, `skos:`, `prov:`, `schema:`, `spdx:` — all already chosen in `research-ontology.md` §1) — with zero intermediate graph database, zero WASM, zero new runtime dependency class.

**If AWB ever needs live SPARQL** (explicitly out of current scope), the correct future path is **`quadstore`** (https://www.npmjs.com/package/quadstore — an RDF/JS-compatible, pluggable-backend persistent quad store, typically paired with Comunica for SPARQL execution), because it composes natively with the same N3.js/jsonld.js/RDF-JS ecosystem this section already recommends, rather than Oxigraph's separate, immature, WASM-isolated API surface.

---

## 6. Vector hybrid: sqlite-vec vs. pgvector vs. AWB's existing pattern

### 6.1 The WASM wall — confirmed by sqlite-vec's own author

This is the single most AWB-specific, load-bearing finding in this section. sqlite-vec's author states the constraint directly on the project's own documentation page: *"It's not possibl[e] to dynamically load a SQLite extension into a WASM build of SQLite. So `sqlite-vec` must be statically compiled into custom WASM builds"* (https://alexgarcia.xyz/sqlite-vec/wasm.html). This is not a sqlite-vec limitation specifically — it is a property of WASM sandboxes generally (no filesystem, no dynamic linker to resolve `.so`/`.dylib` loads) — and it applies identically to *any* SQLite loadable extension, including the BFS virtual table from §2.2 and the closure table from §2.5. **AWB's dev backend is `sql.js`** (confirmed in `db.ts`, §1) — a stock WASM SQLite build. Using sqlite-vec in dev today would require forking `sql.js` to statically bundle sqlite-vec in (a real, ongoing option — `sqlite-vec-wasm-demo` and projects like `sqliteai/sqlite-wasm` demonstrate it's *possible* — but it means AWB owns tracking two projects' version compatibility together going forward, not a drop-in `npm install`).

### 6.2 pgvector — mature, no caveats of this kind

pgvector (official README: https://github.com/pgvector/pgvector) is a standard `CREATE EXTENSION vector` on Postgres with no WASM-class restriction. It supports **HNSW** and **IVFFlat** indexes, six distance functions (L2, inner product, cosine, L1, Hamming, Jaccard), **`halfvec`** half-precision storage (up to 4,000 dims, roughly half the storage of full precision), and binary quantization (up to 64,000 dims with re-ranking). 2026-vintage community benchmarks report **18 ms p50 / 90 ms p99** at 1M vectors × 1536 dimensions with a properly tuned HNSW index, and comfortable operation into the 10–50M-vector range on a single well-tuned node; 2026 releases added parallel HNSW builds (30–50% faster index construction on multi-core machines). Contrasted directly against sqlite-vec by a recent comparison piece (https://llbbl.blog/2026/04/26/pgvector-vs-sqlitevec-you-probably.html): pgvector benefits from Postgres's shared buffer cache and background workers for memory management, while sqlite-vec runs fully in-process, so a large vector index competes directly with the host application's own memory — a second reason (independent of the WASM wall) to be conservative about sqlite-vec inside a shared NestJS process even where it *can* load.

### 6.3 Scale check against AWB's own extraction numbers

`research-ontology.md` §4.2 already restricts LLM/embedding enrichment to **aggregate nodes only** (folder/module/class), never per-function — a deliberate cost control, not a limitation this document introduces. Applying `research-extraction.md` §1's measured definition-kind breakdown (class 443 + interface 937 out of 5,459 total definitions in the 197.5 kLOC sample, ≈25%) to the 10 MLOC / ~280k-def extrapolation, plus one embeddable node per file (≈3.9 files/kLOC → ~39k files at 10 MLOC) and a modest folder count, yields an estimated **~100k–150k aggregate-node embeddings** at AWB's largest projected repo size — **and that figure is per-workspace**, since every ontology-graph query in this design is `graph_id`-scoped (§8). That is within the range where AWB's existing brute-force pattern is workable-but-not-free (an independent brute-force vector-search project reports ~50 ms for a 100K-embedding sweep, cited here only as an order-of-magnitude anchor, not a direct AWB measurement) — not the multi-million-vector range where an index becomes mandatory.

### 6.4 Recommendation

**Keep one logical schema everywhere.** Add an ontology-node embedding table that is a direct structural mirror of `ResourceEmbedding` — `{ id, node_id, embedding (text, JSON-serialized float array), model, dimensions, text_hash, created_at }` — so the same `EmbeddingService`/`cosineSimilarity()` code path AWB already runs today works unchanged as the **portable default on both backends**. **Do not adopt sqlite-vec now**: the WASM wall in §6.1 means it isn't a drop-in dependency for AWB's actual dev backend, and the projected embedding volume (§6.3) doesn't yet justify forking `sql.js` to get it. **Add pgvector as an optional, Postgres-only, production-only accelerator**, gated behind the same `DB_TYPE === 'postgres'` branch `db.ts` already uses elsewhere: create the HNSW index only on that path, and have the query layer feature-detect the index (try the `<=>` operator fast path, fall back to brute force) rather than hard-branching on backend — so SQLite dev never needs the index and Postgres prod can opt in exactly when a workspace's measured embedding count makes brute force user-visibly slow.

---

## 7. What other code-intelligence backends chose, and why

### 7.1 Sourcegraph — relational for structure, one bespoke index for the one hot workload

Sourcegraph "stores its list of repositories in a PostgreSQL database, along with most other Sourcegraph metadata" (https://sourcegraph.com/docs/admin/architecture), and layers **Zoekt**, a purpose-built trigram-indexed search engine, only for the one workload relational storage is genuinely bad at: full-text code search across the whole corpus. Zoekt's own design doc (https://github.com/sourcegraph/zoekt/blob/main/doc/design.md) is precise about the cost: index shards run **~3.5× corpus size on disk** (1× original content + ~2.5× posting lists/metadata), are capped near **1 GB of source per shard** (uint32 offsets, 4 GB shard ceiling), require only **~1.2× corpus size in RAM** because shards are memory-mapped rather than loaded whole, and target **sub-50 ms results** on codebases the size of Android or Chrome. The architectural lesson: **don't ask the relational store to do the one thing a specialized index does two orders of magnitude better at — but don't move everything else off relational storage either.** This is structurally the same shape as this report's DuckDB recommendation (§4): a narrow, purpose-built specialized engine bolted onto a relational core for exactly one workload, not a replacement for it.

### 7.2 CodeQL — the cost of building your own engine from scratch

CodeQL does not use SQLite, Postgres, or any general-purpose SQL engine at all. Its pipeline extracts `.trap` files per source file (https://codeql.github.com/docs/codeql-overview/codeql-glossary/), imports them into a **language-specific relational schema** whose semantics are Datalog, not SQL — "the syntax of QL is similar to SQL, but the semantics of QL are based on Datalog" — and evaluates queries with a bespoke evaluator that maintains its own **disk cache for intermediate results**, sized heuristically against dataset size and query complexity (https://codeql.github.com/docs/codeql-overview/about-codeql/). This is a fully custom relational-Datalog engine, built and maintained by a team solely for this purpose. It corroborates a point `research-extraction.md` §2.8 already made about Joern/CPGs at a different layer of the stack: **building a bespoke query engine is the industry answer only when the workload is batch, whole-program, security/compliance-grade static analysis** — not AWB's requirement of a live, incrementally-updated, multi-tenant, TypeORM-integrated graph an agent queries mid-session. The cost of CodeQL's approach (a dedicated engine team, no incremental updates, batch-only) is precisely the cost AWB's relational choice avoids.

### 7.3 Glean — RocksDB fits Meta's operating model, not AWB's

Glean's storage is RocksDB, an embedded LSM-tree key-value store (https://engineering.fb.com/2024/12/19/developer-tools/glean-open-source-code-indexing/): "facts... are automatically de-duplicated by the storage backend," with the declarative **Angle** query language layered on top for both stored and derived-at-query-time predicates. RocksDB's LSM-tree write path is an excellent fit for Glean's actual design constraint — **immutable, append-only, monotonically-growing fact layers** at Meta-monorepo scale (billions of facts, `research-extraction.md` §2.6 already cites the 470 s / 0.8 GB Hackage-index numbers) — but it is a genuinely separate operational component: no SQL, no joins against AWB's existing `Ticket`/`User`/`Resource`/`Workspace` TypeORM entities, no dual SQLite/Postgres story, and a Thrift server + Haskell/Hack toolchain to operate (already noted as "not embeddable in Node" in `research-extraction.md` §2.6). RocksDB is the right choice for a single team running one enormous fact store; it is the wrong choice for AWB's per-workspace, multi-tenant graphs that need to join against data that already lives in TypeORM-managed relational tables.

### 7.4 Aider — the credible floor, and why AWB doesn't qualify for it

Aider's repo-map is the useful lower bound in this survey: **no persistent storage of any kind.** Per Aider's own engineering post (https://aider.chat/2023/10/22/repomap.html), it "uses tree sitter to build the map" and applies "a graph ranking algorithm, computed on a graph where each source file is a node and edges connect files which have dependencies" — implemented with tree-sitter parsing feeding a NetworkX `DiGraph` and NetworkX's personalized-PageRank implementation, entirely **in memory, rebuilt from scratch on every invocation**, with output capped to a configurable token budget (default 1k tokens via `--map-tokens`). This works precisely because Aider's unit of work is a single CLI session against one local checkout — there is no persistence requirement because there is no cross-session, cross-user, cross-agent state to persist. **AWB explicitly does not qualify for this floor**: the ontology graph must survive across agent sessions, be queryable by multiple concurrent agents and human users in the same workspace, and support incremental updates without a full rebuild on every query — Aider's zero-storage model is the right answer to a different problem than AWB's.

### 7.5 What AWB should take from all four

The pattern that recurs across every system that isn't Aider (which doesn't need persistence at all) is: **relational storage for structured, joinable, multi-tenant data, plus at most one narrow, purpose-built addition for the single workload relational storage handles poorly** — Zoekt for full-text search at Sourcegraph, RocksDB's LSM-tree for immutable-fact-layer scale at Glean (a workload AWB doesn't have — no monorepo-scale immutable fact stream), a bespoke Datalog evaluator for batch whole-program analysis at CodeQL (a workload AWB also doesn't have — no compliance-grade whole-program static analysis requirement). AWB's actual missing workload, per §2–§6 of this document, is **OLAP-shaped aggregate/analytics queries** — and DuckDB's zero-ETL `ATTACH` (§4) is the correctly-scoped answer to *that* specific gap, not a wholesale second storage engine.

---

## 8. Recommended architecture for AWB

1. **Primary engine — unchanged.** SQLite (`sql.js`, dev) / PostgreSQL (prod), the relational LPG schema exactly as specified in `research-ontology.md` §8 (nodes/edges tables, `layer` discriminator, the index set in §8.5). This document does not revise that schema; it validates that the query patterns it needs to serve are achievable on it, with the constraints in §2–3.
2. **Query layer.** A small internal graph-query service (not exposed to agents as free-form SQL) issuing `dataSource.query()` raw SQL, one hand-maintained variant per dialect (§1, §3). Every MCP-exposed traversal (`graph_neighbors`, `graph_blast_radius`) is bounded-depth + path-cycle-guarded + `LIMIT`-capped by construction, never optional (§2.4). `graph_call_path` is implemented as application-orchestrated bidirectional level-BFS with a running visited-set, never a single unbounded recursive CTE (§2.3–2.4). All queries are `graph_id`-scoped, which — combined with `research-ontology.md`'s per-(workspace, repo, folder) graph scoping and `research-extraction.md` §5.2's sharding key — is itself the single biggest performance lever: a per-folder graph is a small fraction of the platform-wide total.
3. **Analytics sidecar.** DuckDB, embedded via `@duckdb/node-api`, in a scheduled background job (modeled on AWB's existing `WorkspaceSchedule` pattern): force a `sql.js` flush (dev) or connect read-only (prod Postgres), `ATTACH` via `sqlite_scanner`/`postgres`, run columnar aggregate queries, materialize into a small stats table the UI reads (§4.5). Defer DuckDB's graph-native features (SQL/PGQ, algorithm extensions) until they exit community-extension status.
4. **RDF/JSON-LD export.** A streaming serializer over the relational tables using **N3.js** (Turtle/N-Quads) and **jsonld.js** (JSON-LD compact/expand/canonicalize) against the `@context` `research-ontology.md` §1 already defined. No embedded triple store (§5).
5. **Embeddings.** A new table structurally identical to `ResourceEmbedding`, feeding the same `EmbeddingService`/`cosineSimilarity()` brute-force path as the portable default; pgvector HNSW as an optional Postgres-only, volume-gated accelerator behind a feature-detected fast path, never a hard backend branch in the query layer (§6.4). sqlite-vec deferred pending either a measured volume that justifies forking `sql.js`, or an upstream fix to WASM extension loading (neither imminent per §6.1).

---

## 9. Top 5 traps

**1. A single unbounded recursive-CTE shortest-path query will exhaust memory on both target engines, not just one.** §2.3's DuckDB numbers (606M rows from a 424-node graph) are the clearest quantified evidence available that standard `UNION ALL` recursive-CTE semantics have no cross-path memory, and this is a property of the SQL standard's recursive-CTE semantics, not a SQLite or Postgres bug — GitLab's production incident (§3) proves it happens on Postgres too. **Mitigation:** ship `graph_call_path` as bounded, leveled, application-orchestrated BFS from day one; never let an agent-facing tool run an open-ended recursive CTE toward an arbitrary target.

**2. TypeORM has no recursive-CTE builder — budget the raw-SQL escape hatch now, not mid-implementation.** Confirmed via two long-open TypeORM issues (#1116 since 2017, #10731 still a PoC). **Mitigation:** design the graph-query service around `dataSource.query()` from the start, with one SQL string per dialect, rather than assuming a query-builder API will materialize.

**3. `sql.js` cannot dynamically load *any* SQLite extension — this forecloses more than sqlite-vec.** Confirmed directly from sqlite-vec's own author (§6.1) but the constraint (no filesystem/dynamic linker inside a WASM sandbox) is general: it also rules out the AVL-tree BFS virtual table (§2.2) and the official closure-table extension (§2.5) as dev-side accelerators, not just the vector extension. **Mitigation:** treat "ships as a loadable extension" as a disqualifier for any dev-path tool unless AWB commits to forking `sql.js` to statically bundle it — a real, trackable, but non-trivial ongoing cost.

**4. A DuckDB analytics sweep silently reads stale data if you forget to flush `sql.js` first.** `db.ts`'s batched-flush model (§1, §4.1) means the on-disk SQLite file DuckDB attaches to lags the live in-memory state by up to one flush interval. **Mitigation:** the scheduled analytics job must force-flush before attaching in dev, and the UI should label results with the snapshot's `indexed_at`/commit, consistent with `research-ontology.md` §6's freshness/provenance requirements generally.

**5. Don't precompute full transitive closure at 280k nodes.** It looks like a tempting shortcut for "who can reach whom" queries, but is O(n²) worst-case and unbounded on a cyclic call graph (§2.5) — a categorically different, much larger problem than the bounded N-hop queries AWB actually needs. **Mitigation:** bounded-depth traversal (§2.4) for the interactive case; route true all-pairs-style analytics to the DuckDB sidecar (§4.3) as a batch job, never as a precomputed table in the primary OLTP store.

---

## Sources

- https://sqlite.org/lang_with.html
- https://sqlite.org/forum/info/3b309a9765636b79
- https://github.com/abetlen/sqlite3-bfsvtab-ext
- https://github.com/shwetarkadam/sqlite-graph
- https://arxiv.org/html/2603.27277v1
- https://www.postgresql.org/docs/current/queries-with.html
- https://gitlab.com/gitlab-org/gitlab/-/issues/325688
- https://github.com/sqlite/sqlite/blob/master/ext/misc/closure.c
- https://sqlite.org/src/dir?ci=trunk&name=ext%2Fmisc
- https://charlesleifer.com/blog/querying-tree-structures-in-sqlite-using-python-and-the-transitive-closure-extension/
- https://intuitem.com/postgresql-vs-sqlite-2026-benchmark/
- https://arxiv.org/abs/2601.06705
- https://github.com/motherduckdb/sqlite_scanner
- https://duckdb.org/docs/current/core_extensions/postgres/overview
- https://duckdb.org/docs/current/guides/sql_features/graph_queries
- https://duckpgq.org/documentation/graph_functions/
- https://duckdb.org/2025/05/23/using-key
- https://dl.acm.org/doi/10.1145/3722212.3725107
- https://duckdb.org/2026/08/17/duckdb-20-highlights
- https://github.com/rahul-iyer/duckdb-gql
- https://github.com/alitrack/duckdb_petgraph
- https://github.com/CogitatorTech/onager
- https://www.npmjs.com/package/@duckdb/node-api
- https://github.com/duckdb/duckdb-node
- https://github.com/oxigraph/oxigraph
- https://github.com/oxigraph/oxigraph/blob/main/js/README.md
- https://github.com/oxigraph/oxigraph/discussions/1092
- https://github.com/linkeddata/rdflib.js
- https://github.com/rdfjs/N3.js
- https://www.npmjs.com/package/jsonld
- https://github.com/digitalbazaar/jsonld.js
- https://www.npmjs.com/package/quadstore
- https://alexgarcia.xyz/sqlite-vec/wasm.html
- https://alexgarcia.xyz/blog/2024/sqlite-vec-stable-release/index.html
- https://llbbl.blog/2026/04/26/pgvector-vs-sqlitevec-you-probably.html
- https://github.com/pgvector/pgvector
- https://www.crunchydata.com/blog/hnsw-indexes-with-postgres-and-pgvector
- https://sourcegraph.com/docs/admin/architecture
- https://github.com/sourcegraph/zoekt/blob/main/doc/design.md
- https://codeql.github.com/docs/codeql-overview/about-codeql/
- https://codeql.github.com/docs/codeql-overview/codeql-glossary/
- https://engineering.fb.com/2024/12/19/developer-tools/glean-open-source-code-indexing/
- https://aider.chat/2023/10/22/repomap.html
- https://github.com/typeorm/typeorm/issues/1116
- https://github.com/typeorm/typeorm/issues/10731

(Plus direct reads of AWB's own source: `apps/server/src/entities/RelationTuple.ts`, `apps/server/src/entities/ResourceEmbedding.ts`, `apps/server/src/services/embedding.service.ts`, `apps/server/src/modules/mcp/tools/resource-tools.ts`, `apps/server/src/db.ts`.)
