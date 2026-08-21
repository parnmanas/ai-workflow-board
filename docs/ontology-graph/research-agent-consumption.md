# Agent Consumption of Code Graphs — Evidence and MCP Tool Surface (for AWB Ontology Graph)

Date: 2026-08-22. Target: the last mile of the Ontology Graph feature — not whether to build it (decided) or how to store/render it (`research-storage.md`, `research-visualization.md`), but whether an LLM coding agent actually gets measurably better at its job by querying it, and exactly what MCP tools it should be handed to do so. This document assumes and does not re-litigate `research-extraction.md` (tree-sitter mandatory tier, SCIP optional, LLM enrichment tier), `research-ontology.md` (LPG schema, `layer`/`confidence`/`symbol_id`), `research-storage.md` (bounded-BFS-only traversal, `graph_blast_radius`/`graph_call_path`/`graph_neighbors` as fixed tool names), and `research-visualization.md` (aggregation-first rendering, 20-50-node focus+context budget).

**Bottom line up front:** the evidence is real but two-sided, and AWB should build accordingly. Structural retrieval measurably wins on *efficiency* in every study that measured it: Codebase-Memory reports ~10× fewer tokens and 2.1× fewer tool calls than file exploration for the same question (`research-extraction.md` §5.3; https://arxiv.org/html/2603.27277v1), and a single consolidated code-graph MCP tool independently measured 88% fewer tool calls (median 2 vs. 14–43) and 62% fewer tokens across seven real repositories (https://github.com/colbymchenry/codegraph). It also wins on *accuracy*, but the win is concentrated and benchmark-dependent, not universal. LocAgent's graph-plus-agent pipeline reaches 77.74% file-localization accuracy against a BM25 floor of 38.69% and embedding-only floors of 49.64%–52.55% (https://arxiv.org/abs/2503.09089, ACL 2025); CodexGraph turns a 3.11% BM25 Pass@1 into 22.96% on SWE-bench-Lite (https://aclanthology.org/2025.naacl-long.7/, NAACL 2025); and a 2026 within-harness ablation, "Code Isn't Memory" (https://arxiv.org/abs/2606.22417), finds a statistically significant +8.5-point resolve-rate gain (41.9%→50.4%, paired Wilcoxon p=0.003) that concentrates almost entirely in multi-file changes (91.3% vs. 44.9% in the ≥3-file bucket) and is **not** statistically significant against a well-built "agentic-grep" baseline in cross-harness comparison (50.4% vs. 45.3%, p=0.087). On at least one benchmark (EvoCodeBench, CodexGraph 11.87% vs. no-retrieval 11.79%) and one closest-analog system (Codebase-Memory's own 83%-vs-92%-quality finding — the graph-based agent scored *lower* answer quality than the file-exploring one, just 10× cheaper), a graph alone measured no better, or slightly worse, than plain file exploration. The honest reading: **the graph's proven job is routing and cost control, not replacing ground truth** — which is exactly the design constraint `research-ontology.md` §10 already imposed ("every agent-facing result returning `path:line` so the agent can verify by reading the source"). AWB should therefore treat `research-storage.md`'s `graph_blast_radius`/`graph_call_path`/`graph_neighbors` as the fixed traversal engine and add exactly two tools that compose with it rather than duplicate it: **`graph_find_symbol`** (name/fuzzy resolution — the universal first move in every system surveyed here: Serena, AutoCodeRover, LocAgent, Polycodegraph, and `code-graph-mcp` all ship a same-named or synonymous tool) and **`graph_module_summary`** (a compact rollup, directly mirroring AWB's own already-shipped `get_board_summary` convention in `apps/server/src/modules/mcp/tools/board-tools.ts`). Ship both first, in the same PR; defer **`graph_search_symbols`** (semantic lookup) behind the same embedding-provider gate `search_resources` already uses; defer **`graph_hotspots`** (cheap but unvalidated by any surveyed accuracy evidence) to a later backlog ticket. Every response must carry the `path:line` grounding and `{source, confidence, indexed_at, commit}` provenance `research-extraction.md` §5.3 and `research-ontology.md` §10 already mandate, and every response must be bounded — 20–50 symbols per call by default, matching both `research-visualization.md`'s independently-derived UI focus+context budget and Anthropic's own Claude Code tool-response ceiling of 25,000 tokens (https://www.anthropic.com/engineering/writing-tools-for-agents) — because context waste, not raw inaccuracy, is where an unbounded graph tool actually fails an agent in practice.

---

## 0. TL;DR decisions

| Question | Decision | Primary evidence |
|---|---|---|
| Does repo-level structural context measurably improve agent accuracy vs. grep/embedding-only? | **Yes, but conditionally** — real, often large gains on localization/retrieval metrics; smaller, benchmark-dependent gains on end-to-end resolve rate, concentrated in multi-file tasks | LocAgent (https://arxiv.org/abs/2503.09089), CodexGraph (https://aclanthology.org/2025.naacl-long.7/), "Code Isn't Memory" (https://arxiv.org/abs/2606.22417) |
| Does embedding-only retrieval already close most of the grep→structure gap? | **Partially** — E5/CodeRankEmbed embeddings (49.6–52.6% file Acc@5) clear BM25 (38.7%) by a wide margin before any graph is added; the graph adds a further, smaller lift on top (→77.7%) | LocAgent baseline table (https://arxiv.org/abs/2503.09089) |
| Is there honest counter-evidence? | **Yes, from AWB's own closest analog** — graph-only exploration scored *lower* answer quality (83%) than file exploration (92%), just far cheaper; one benchmark shows a graph tool statistically tied with no retrieval at all | Codebase-Memory (`research-extraction.md` §5.3; https://arxiv.org/html/2603.27277v1); CodexGraph on EvoCodeBench (https://aclanthology.org/2025.naacl-long.7/) |
| Where do graph gains concentrate? | **Multi-file / cross-module changes**, not single-file edits — and the gain is *not* statistically significant against a strong grep-based agent on the full mixed workload | "Code Isn't Memory" (https://arxiv.org/abs/2606.22417) |
| What's the fixed part of AWB's tool surface? | `graph_blast_radius`, `graph_call_path`, `graph_neighbors` — bounded, leveled, application-orchestrated BFS only, never a free-form query | `research-storage.md` §2.4, §8 |
| What two tools does this document fully specify? | `graph_find_symbol` (name/fuzzy resolution) and `graph_module_summary` (compact rollup) — both already *named* but not schema'd in `research-extraction.md` §5.3 | this document §3 |
| Is a third tool justified? | `graph_search_symbols` (semantic/NL lookup over graph nodes), gated behind the same embedding-provider check `search_resources` uses | `research-storage.md` §6.4's ontology-node embedding table; AWB's `apps/server/src/modules/mcp/tools/resource-tools.ts` |
| Many narrow tools or one fat tool? | **Few, rich tools** — 2–3 new tools whose single response is dense enough to often avoid a follow-up call, not 18 narrow ones and not 1 do-everything tool | Tension between Polycodegraph (18 tools) and `codegraph` (1 tool, 88% fewer calls); Anthropic's tool-count guidance (https://www.anthropic.com/engineering/writing-tools-for-agents) |
| How much should one call return? | 20–50 symbols / compact rows by default, aggregated (not per-edge) counts for roll-ups, hard ceiling well under 25k tokens | Anthropic's 25,000-token Claude Code default; `research-visualization.md` §6.3's 20–50-node UI budget; AWB's own `search_resources`/`get_ticket_activity` default limits (10/50) |
| Why would an agent reach for these over grep/Read? | Precision on ambiguous/indirect names (3.11%→22.96% Pass@1 gap on one benchmark), and token/round-trip economy (88% fewer tool calls, 62% fewer tokens in one measured deployment) — **not** a blanket "always better" claim | CodexGraph (https://aclanthology.org/2025.naacl-long.7/); `codegraph` (https://github.com/colbymchenry/codegraph) |

---

## 1. Does structural context measurably improve agent accuracy? The evidence, numbers included

### 1.1 The cleanest apples-to-apples comparison: retrieval strategy alone (LocAgent)

LocAgent (Graph-Guided LLM Agents for Code Localization, ACL 2025, https://arxiv.org/abs/2503.09089, code at https://github.com/gersteinlab/LocAgent) is the single most useful data point here because it reports retrieval-only baselines and its own graph-plus-agent pipeline on the *same* localization metric, on the *same* benchmark (SWE-Bench-Lite). It parses a repo into a heterogeneous graph — node types `directory, file, class, function`; edge types `contain, import, invoke, inherit` — and exposes it to the agent through exactly three tools: **`SearchEntity`** (keyword search over a "Hierarchical Entity Index"), **`TraverseGraph`** (type-aware breadth-first search from a set of input entities), and **`RetrieveEntity`** (full attributes — file path, line number, code content — for a set of entity IDs). Its own reported localization table:

| Method | File Acc@5 | Module Acc@10 | Function Acc@10 |
|---|---|---|---|
| BM25 (lexical) | 38.69% | 52.92% | 36.86% |
| E5-base-v2 (embedding) | 49.64% | 72.26% | 51.09% |
| CodeRankEmbed (embedding) | 52.55% | 78.83% | 58.76% |
| LocAgent w/ Claude-3.5 backbone | 77.74% | 87.59% | 77.37% |
| LocAgent w/ fine-tuned Qwen2.5-Coder-32B | 75.91% | 87.23% | 77.01% |

Two honest readings, not one triumphant one. First: embeddings alone already buy most of the win over lexical search — E5/CodeRankEmbed clear BM25 by 11–14 points at the file level and 14–22 points at the function level, with **zero** graph structure involved. Second: the graph-plus-agent combination (LocAgent's own pipeline, using `TraverseGraph`'s multi-hop reasoning) adds a further, large jump on top of that embedding floor — but this specific comparison conflates two variables at once (agentic multi-hop reasoning *and* graph structure, vs. neither), so it demonstrates "graph+agent beats retrieval-only," not a clean isolated ablation of graph-vs-no-graph holding the agent constant. On cost, fine-tuning a 32B open model to match proprietary-model accuracy dropped per-example cost from $0.66 to $0.09 (86% reduction). Downstream, LocAgent's localization fed into repair raised Pass@10 issue-resolution from Agentless's 33.58% (Claude-3.5 backbone) to 37.59% (Claude-3.5 backbone) — a 4.01-point absolute, ~12% relative improvement.

### 1.2 The plug-in effect: bolting a graph onto four existing SWE-bench agents (RepoGraph)

RepoGraph (ICLR 2025, https://arxiv.org/abs/2410.14684, full text https://arxiv.org/html/2410.14684v1) answers a different, arguably more useful question: does adding repo-structure retrieval to an *existing*, already-competitive agent help, without changing anything else about it? It is consumed two ways — flattened directly into the prompt for procedural frameworks, or as an explicit agent-callable action (`search_repograph`) for agentic frameworks, i.e. exactly the "agent decides when to call a graph tool" shape AWB's MCP surface uses. Its own per-method table on SWE-bench:

| Base method (model) | Resolve rate, before | Resolve rate, after RepoGraph | Absolute Δ | Relative Δ |
|---|---|---|---|---|
| RAG (GPT-4) | 2.67% | 5.33% | +2.66 pp | +99.6% |
| Agentless (GPT-4o) | 27.33% | 29.67% | +2.34 pp | +8.6% |
| AutoCodeRover (GPT-4) | 19.00% | 21.33% | +2.33 pp | +12.3% |
| SWE-agent (GPT-4o) | 18.33% | 20.33% | +2.00 pp | +10.9% |

The paper's own headline is "an average relative improvement of 32.8%" — and the arithmetic checks out exactly ((99.6+8.6+12.3+10.9)/4 = 32.85%) — but that average is arithmetically dominated by the RAG(GPT-4) row's near-100% relative jump *from a 2.67% base*, where +2.66 absolute points doubles the rate simply because the starting point is tiny. Drop that outlier and the average relative improvement across the other three, already-competitive systems is ~10.6% — still real, but a materially more modest number than the headline figure alone suggests, and the absolute improvement across all four systems is a consistent, unglamorous **+2 to +2.7 percentage points**. Token cost rose in every case — RAG +3,703, Agentless +4,947, AutoCodeRover +6,449, SWE-agent +17,504 — confirming `research-extraction.md` §5.3's already-cited "+3.9k–17.5k tokens" figure. RepoGraph's own ego-graph statistics are also directly useful for §4 below: a 1-hop neighborhood averages 11.6 nodes / 37.1 edges, a 2-hop neighborhood 54.5 nodes / 89.9 edges, and the full repo graph averages 1,419.3 nodes / 26,392.1 edges — i.e. a *bounded* neighborhood query, exactly like `graph_neighbors`, stays two to three orders of magnitude smaller than "the whole graph" by construction.

### 1.3 Graph-as-query-interface vs. AST-search vs. grep, on three benchmarks at once (CodexGraph)

CodexGraph (NAACL 2025, https://aclanthology.org/2025.naacl-long.7/, full text https://arxiv.org/html/2408.03910v3) takes a different tool-design approach worth flagging separately in §2 — a live Neo4j/Cypher graph database, with a "write then translate" split (a primary agent writes a natural-language question; a second, specialized agent translates it into Cypher) rather than a fixed tool vocabulary. Its node types are `MODULE, CLASS, METHOD, FUNCTION, FIELD, GLOBAL_VARIABLE`; edges are `CONTAINS, HAS_METHOD, HAS_FIELD, INHERITS, USES`. Its own three-benchmark table, all on GPT-4o, is the most direct grep-vs-AST-search-vs-graph comparison found in this research:

| Benchmark | Metric | No retrieval | BM25 (grep-class) | AutoCodeRover (AST search) | CodexGraph (graph) |
|---|---|---|---|---|---|
| CrossCodeEval-Lite (Python) | Exact Match | 10.80% | 21.20% | 21.20% | **27.90%** |
| SWE-bench-Lite | Pass@1 | n/a | 3.11% | 22.96% | 22.96% |
| SWE-bench-Lite | Recall@1 | n/a | n/a | 28.78% | **36.02%** |
| EvoCodeBench | Recall@1 | 11.79% | n/a | 11.17% | 11.87% |

Read honestly, this table makes two opposite points at once, and both matter. On SWE-bench-Lite, the grep-class baseline (BM25) is catastrophic — 3.11% Pass@1 versus 22.96% for either AST-search or graph-search, a 7× gap that is the strongest single piece of evidence in this whole survey that *some* form of structural retrieval is close to mandatory once symbol names are ambiguous or indirectly referenced (re-exports, dynamic dispatch, common names). But on that same benchmark, CodexGraph's graph interface and AutoCodeRover's plain AST-search tie exactly on the downstream Pass@1 metric (22.96% each) — the graph only pulls ahead on the intermediate Recall@1 metric (36.02% vs. 28.78%), i.e. it retrieves better without that retrieval edge fully converting into more resolved issues. And on EvoCodeBench, the ranking is CodexGraph (11.87%) ≈ no-retrieval-at-all (11.79%) > AutoCodeRover (11.17%) — on this specific benchmark, adding a graph provided almost no measurable benefit over doing nothing, and adding AST-search actively *underperformed* doing nothing. This is exactly the kind of thin/mixed result the research brief asked to be reported honestly rather than smoothed over.

### 1.4 The narrow, well-scoped alternative that also works (AutoCodeRover, Agentless)

Two systems are worth citing precisely because they *don't* use a persisted graph and still perform credibly, which calibrates how much of the "structure helps" story is actually about the graph specifically versus simply "search precisely instead of grepping."

**AutoCodeRover** (https://arxiv.org/abs/2404.05427) exposes exactly seven AST-derived, narrowly-scoped tools to its LLM agent — `search_class(cls)`, `search_class_in_file(cls, f)`, `search_method(m)`, `search_method_in_class(m, cls)`, `search_method_in_file(m, f)`, `search_code(c)`, `search_code_in_file(c, f)` — built from a per-run AST, not a persisted cross-run graph. It resolves 19% of SWE-bench-lite (57/300) at $0.43/issue and 37k tokens/issue, averaging 195 seconds (26% at Pass@3, 520 seconds), against roughly 2.68 days for a human on the same issues per the paper's own framing. Its accuracy is consistently a close second to CodexGraph's graph-based numbers in §1.3's table — evidence that a well-scoped, symbol-and-scope-parameterized *search* API captures much of the value without requiring a live, persisted, cross-file graph at all.

**Agentless** (https://arxiv.org/abs/2407.01489, ACM TOSEM 2025 version at https://dl.acm.org/doi/abs/10.1145/3715754) goes further and removes the autonomous agent loop entirely — a fixed three-phase pipeline (localize to files → localize to classes/functions/variables → localize to edit locations, then repair, then validate) with no tool-calling agent and no graph — and still resolves 27.33% of SWE-bench-lite at $0.34/issue, a number this document's RepoGraph table above independently confirms as Agentless's baseline. The lesson for AWB is not "skip the graph" — Agentless's own number is *raised* by adding RepoGraph on top (§1.2) — it is that careful, well-scoped retrieval already buys a large fraction of the win before any graph enters the picture, so the graph's marginal contribution should be measured and messaged as an increment on a strong baseline, not as the thing that makes agentic coding work at all.

### 1.5 The load-bearing honest caveat: a graph alone can be worse than reading files (Codebase-Memory, "Code Isn't Memory")

This is the single most important nuance in this document, and it comes from AWB's own already-established closest analog. Codebase-Memory (https://arxiv.org/html/2603.27277v1, already the anchor citation across all four sibling documents) reports that graph-based exploration used **~10× fewer tokens** (~1,000 vs. ~10,000 per query) and **2.1× fewer tool calls** (2.3 vs. 4.8) than a file-exploring agent — but at **83% of the file-explorer agent's answer quality** (0.92 baseline). `research-ontology.md` §4.4 already drew the correct conclusion from this number: "a graph alone is *worse* than letting an agent read files, unless the graph is used as a cheap index that routes to file reads" — which is precisely why `research-ontology.md` §10 mandates every agent-facing graph result carry `path:line` so the agent can verify by reading the source, and why this document's tool designs in §3 treat that mandate as non-negotiable, not a nice-to-have.

A second, independent, and more recent source corroborates the same shape with statistical rigor. "Code Isn't Memory: A Structural Codebase Index Inside a Coding Agent" (2026, https://arxiv.org/abs/2606.22417) runs a within-harness ablation (structural index on vs. off, "SC-ON"/"SC-OFF") plus a cross-harness comparison against a separate, independently-built "agentic-grep" baseline (OpenCode), on SWE-PolyBench Verified and SWE-bench Pro. Within-harness, the effect is large and clean: localization accuracy 84.5% (ON) vs. 44.3% (OFF), a first-gold-rank@1 of 77.4% vs. 33.3%, and a resolve-rate lift from 41.9% to 50.4% (+8.5 points, paired Wilcoxon p=0.003) — all with cost *lower*, not higher, at the point of solving ($2.30/solved vs. $2.84/solved for SC-OFF), because a fixed per-attempt cost amortizes over fewer failed attempts when the resolve rate is higher. But cross-harness, against the independently-built agentic-grep baseline, the picture softens: SC-ON resolves 50.4% vs. OpenCode's 45.3%, a 5.1-point difference that is **not statistically significant at conventional thresholds** (p=0.087) — and cost is still favorable (SC-ON $2.30/solved vs. OpenCode $2.92/solved) even where the accuracy edge is not proven. Where the gains do concentrate is unambiguous and specific: the ≥3-file-change bucket shows 91.3% (ON) vs. 44.9% (OFF), while the paper's own framing states the deployment question directly: "not whether it is too expensive to run... but whether the workload includes multi-file changes where structural ranking pays off." The agent in this study accesses the index through exactly two tools — `codebase_search` (a natural-language query plus a `strategy` parameter: `vector | lexical | graph | hybrid`) and `codebase_graph` — which is independent validation that a small, named, strategy-parameterized tool pair is a workable production shape, not just an academic one.

### 1.6 Verdict

Taken together, five independent sources (LocAgent, RepoGraph, CodexGraph, Codebase-Memory, "Code Isn't Memory") converge on the same non-overstated conclusion: structural/graph retrieval reliably wins on *efficiency* (tokens, tool calls, cost-per-solve) and *localization precision* (finding the right file/symbol among ambiguous candidates), with the CodexGraph BM25-vs-graph Pass@1 gap (3.11% vs. 22.96%) being the starkest evidence that pure lexical search is close to unusable once names are indirect. Its win on *end-to-end resolve rate* is real but smaller, benchmark-dependent (near-null on EvoCodeBench), and concentrated specifically in multi-file/cross-module changes — with at least one rigorous cross-harness comparison finding the accuracy edge over a strong grep-based baseline not statistically significant on the full mixed workload. AWB's design response to this is already implicit in `research-ontology.md`'s and `research-storage.md`'s existing mandates (mandatory `path:line`, mandatory provenance, bounded BFS only) — this document's job is to make that response concrete in the tool surface (§3) and in explicit context budgets (§4), and to recommend ship order accordingly (§5) rather than pretend the evidence supports shipping a large, unbounded graph-query surface on day one.

---

## 2. What's already shipping: prior-art MCP tool surfaces

Before designing AWB's own tools it is worth surveying what other projects, both research prototypes and production MCP servers, actually named and shipped — because naming and granularity choices that recur independently across unrelated projects are the strongest available signal for what an agent will intuitively reach for.

| System | Kind | Tool count | Representative names | Design philosophy |
|---|---|---|---|---|
| Serena (oraios) | Production MCP server, LSP-backed, 28.3k★ | ~15+ | `find_symbol`, `symbol_overview`, `find_referencing_symbols`, `find_declaration`, `find_implementations`, `type_hierarchy` | many narrow, IDE-parity tools (search + refactor + edit) |
| Polycodegraph | Production MCP server | 18 | `find_symbol`, `callers`, `callees`, `blast_radius`, `subgraph`, `hotspots`, `hybrid_search` | fully granular — one tool per query shape |
| `code-graph-mcp` (sdsrss) | Production MCP server, tree-sitter + recursive CTE | 7 | `project_map`, `get_ast_node` (+`include_impact` flag), `module_overview`, `find_references` | mid-granularity; optional flags fold adjacent queries into one call |
| `codegraph` (colbymchenry) | Production MCP server | 1 primary | `codegraph_explore` | maximal consolidation — one rich response |
| LocAgent | Research prototype, ACL 2025 | 3 | `SearchEntity`, `TraverseGraph`, `RetrieveEntity` | minimal, orthogonal roles: search / traverse / hydrate |
| CodexGraph | Research prototype, NAACL 2025 | 1 query interface | write-then-translate Cypher | one flexible query tool, no fixed vocabulary |
| RepoGraph | Research plug-in, ICLR 2025 | 1 action | `search_repograph` | single tool, agent decides when to call it |
| AutoCodeRover | Research prototype | 7 | `search_class`, `search_method`, `search_code` (± `_in_file`/`_in_class`) | narrow, symmetric family (3 entity kinds × 2–3 scopes) |

(Sources: https://github.com/oraios/serena ; https://mcpservers.org/servers/smochan/polycodegraph ; https://github.com/sdsrss/code-graph-mcp ; https://github.com/colbymchenry/codegraph ; plus the academic sources cited in §1.)

Two things are worth pulling out explicitly because they directly inform §3. First, **`find_symbol` (or an exact synonym) appears in every single production system surveyed** — Serena, Polycodegraph, and `code-graph-mcp`'s `get_ast_node`/`ast_search` pair all converge on "resolve a name to a node" as a first-class, separately-named tool, which is strong, independent validation that this is not a bikeshed-able naming choice. Second, **LocAgent's academically-validated three-role minimal design (search / traverse / retrieve) is structurally what AWB already has, from a completely different starting point**: `graph_neighbors`/`graph_blast_radius`/`graph_call_path` (`research-storage.md`, fixed) play LocAgent's `TraverseGraph` role; the `graph_find_symbol` tool this document specifies plays `SearchEntity`; and the "detail" object `graph_find_symbol` returns on a unique match (§3.2) plays `RetrieveEntity`. AWB arrived at the same three-role shape LocAgent independently validated on SWE-Bench-Lite, via the storage-engine-first path `research-storage.md` took rather than an agent-tool-first design exercise — which is a meaningfully strong sign the shape is right, not merely convenient.

Third, there is a genuine, unresolved tension in the prior art between granularity extremes: Polycodegraph ships 18 narrow tools; `codegraph` ships 1 tool and reports (self-measured, not peer-reviewed, so treated here as directional vendor evidence rather than a verified statistic) 88% fewer tool calls (median 2 vs. 14–43 across seven real codebases), 53% faster resolution, 62% fewer tokens, and zero file reads on all seven repos when its single tool was available, on the stated rationale that "one strong tool steers agents better than a menu of narrower ones — fewer mis-picks, and it saves context every session." Anthropic's own tool-design guidance (https://www.anthropic.com/engineering/writing-tools-for-agents) is explicit that choosing the *right* tools to implement, not the most tools, is the first principle, and that tools should be namespaced (e.g. `asana_search`, `jira_search`) precisely because agents make worse choices as the menu grows. §3.6 resolves this tension for AWB directly.

---

## 3. AWB's MCP tool surface design

### 3.1 The composition contract with the fixed three

`research-storage.md` §2.4 and §8 fix `graph_blast_radius(node)`, `graph_call_path(from, to)`, and `graph_neighbors(node, edge_types, depth)` as bounded, leveled, application-orchestrated BFS — never a single unbounded recursive CTE, never exposed as free-form SQL. That decision is not revisited here. What those three tools have in common, and what makes them incomplete as a full agent-facing surface on their own, is that **all three require a `node` (or `from`/`to`) identifier as input** — none of them helps an agent go from "I'm looking for the function that validates JWTs" to a concrete `symbol_id`. `research-extraction.md` §5.3 already anticipated this gap and stubbed two names for it without a schema — `graph_find_symbol` and `graph_module_summary` — alongside the three fixed tools. This document gives both of those stubbed names a full input/output schema (§3.2, §3.3), adds one new, evidence-justified tool for the case name-lookup can't cover (§3.4), and names one further well-justified but deliberately deferred candidate (§3.5). None of the four duplicates traversal logic that already lives in the fixed three; every one of them is designed to *end* by handing the agent a `symbol_id` (or several) and a ready-to-use call into `graph_neighbors`/`graph_blast_radius`/`graph_call_path`, mirroring exactly the "graph answer routes to more precise follow-up, or to a file read" pattern §1.5 found to be the load-bearing difference between a graph that helps and a graph that merely looks impressive.

Every tool below is `workspace_id`-scoped as its first parameter and `graph_id`-scoped as its second — matching the universal pattern in every existing AWB MCP tool this research read (`list_resources`, `get_resource`, `save_resource`, `search_resources`, `get_board`, `get_board_summary` in `apps/server/src/modules/mcp/tools/resource-tools.ts` and `board-tools.ts`), and matching `research-storage.md`'s own SQL examples, which all bind a `:graph_id` parameter. Resolving *which* `graph_id` an agent should pass (i.e. the lifecycle of building/refreshing an `OntologyGraph` row per `research-ontology.md` §8.1) is a separate concern this document deliberately does not design — it belongs to a graph-lifecycle tool (e.g. a future `graph_status`/`graph_build`) that none of the five prior documents specified either; flagging that gap explicitly here rather than silently inventing an API for it.

### 3.2 `graph_find_symbol`

**Why this one, why first:** every production system surveyed in §2 ships this role under this exact name or a direct synonym, and it is the one tool an agent needs before any other graph tool becomes callable — `graph_neighbors`/`graph_blast_radius`/`graph_call_path` all take a resolved node, not a name.

Description string (mirrors AWB's dense, behavior-documenting convention seen in `resource-tools.ts`'s `save_resource`/`list_repo_branches` descriptions — explains defaults, scope, and how the result composes with other tools):

> "Resolve a symbol by name — exact, dotted/qualified, or fuzzy substring — to one or more nodes in the ontology graph. This is the entry point for the rest of the graph surface: `graph_neighbors`, `graph_call_path`, and `graph_blast_radius` all require a resolved node id, not a name. Returns a compact, ranked list (by confidence then centrality); when the query resolves to exactly one node at or above `confidence_min`, the response also includes full symbol detail (signature, one-line doc summary, one-hop counts) plus ready-to-call argument skeletons for `graph_neighbors`/`graph_blast_radius`/`graph_call_path` with the resolved id already filled in. Defaults to `structural`+`derived` layers and `confidence_min=0.75` (semantic/curated and lower-confidence heuristic matches are hidden unless asked for). Every match includes `path`/`start_line`/`end_line` so you can verify with Read."

Input schema:

```typescript
{
  workspace_id: z.string().describe('Workspace ID (required)'),
  graph_id: z.string().describe('Ontology graph ID (required) — see the graph you last built/refreshed for this repo+folder'),
  query: z.string().describe('Symbol name to resolve: exact name, dotted/qualified name (e.g. "UserService.getUserById"), or a fuzzy substring'),
  kind: z.enum(['class', 'interface', 'function', 'method', 'field', 'type', 'module', 'endpoint', 'data_entity'])
    .optional().describe('Restrict to one declaration kind (research-ontology.md §8.3 Type.kind/Callable.kind vocabulary)'),
  path_prefix: z.string().optional().describe('Restrict matches to files under this path prefix'),
  layers: z.array(z.enum(['structural', 'derived', 'semantic', 'curated'])).optional().default(['structural', 'derived'])
    .describe('Which layers to search. Semantic/curated are opt-in — see research-ontology.md §8.2'),
  confidence_min: z.number().min(0).max(1).optional().default(0.75)
    .describe('Hide matches below this confidence (research-extraction.md trap #4 default floor). Lower to 0 to see speculative matches too.'),
  limit: z.number().optional().default(20).describe('Max matches to return (hard ceiling 50)'),
}
```

Output shape (example):

```json
{
  "query": "getUserById",
  "total_matches": 3,
  "truncated": false,
  "matches": [
    {
      "symbol_id": "scip-ts npm awb 0.1.0 `src/services/user.service.ts`/UserService#getUserById().",
      "name": "getUserById",
      "qualified_name": "UserService.getUserById",
      "kind": "method",
      "layer": "structural",
      "path": "apps/server/src/services/user.service.ts",
      "start_line": 42,
      "end_line": 58,
      "signature": "getUserById(id: string): Promise<User | null>",
      "confidence": 1.0,
      "confidence_bucket": "asserted",
      "source": "tree-sitter",
      "degree": 14,
      "pagerank": 0.0021
    }
  ],
  "detail": {
    "doc_summary": "Loads a user row by primary key; returns null on miss.",
    "one_hop_counts": { "callers": 11, "callees": 3, "references": 14 },
    "indexed_at": "2026-08-21T09:12:00Z",
    "commit": "a1b2c3d",
    "suggested_next_calls": [
      { "tool": "graph_neighbors", "args": { "graph_id": "...", "node": "scip-ts npm awb 0.1.0 `src/services/user.service.ts`/UserService#getUserById().", "depth": 2 } },
      { "tool": "graph_blast_radius", "args": { "graph_id": "...", "node": "scip-ts npm awb 0.1.0 `src/services/user.service.ts`/UserService#getUserById()." } }
    ]
  }
}
```

`confidence_bucket` reuses `research-ontology.md` §6.4's ordinal vocabulary (`asserted` ≥0.9, `likely` 0.75–0.9 given the 0.75 floor, `speculative` <0.6 only visible when `confidence_min` is explicitly lowered) rather than exposing a bare float an agent has no calibrated way to interpret. `source`/`confidence`/`indexed_at`/`commit` on every match is the literal field set `research-extraction.md` §5.3 mandates ("Every response must carry `{source, confidence, indexed_at, commit}`"). The `suggested_next_calls` field is new to this document and directly operationalizes §3.1's composition contract: it gives the agent a syntactically-correct, pre-filled call into a fixed tool rather than requiring it to hand-copy a `symbol_id` string correctly — a real failure mode (`research-storage.md` §9's "TypeORM has no recursive-CTE builder" trap and every survey paper's own tool-use-error discussion both point at malformed follow-up calls as a common, avoidable agent failure).

### 3.3 `graph_module_summary`

**Why this one:** `get_board_summary` in `apps/server/src/modules/mcp/tools/board-tools.ts` already proves this exact pattern works for AWB's agents — its own description literally says "Get a compact LLM-friendly board summary with column names, ticket counts, and per-ticket overview" — and §1.5's central finding (a graph is a routing layer, not a replacement for reading code) means an agent needs a cheap way to decide *whether* a module is worth reading in full before it spends tokens on `Read`. Colloquially "explain a module" (the phrasing this ticket's brief used); the canonical name kept here is `graph_module_summary`, exactly as already stubbed in `research-extraction.md` §5.3, rather than introducing a second name for the same concept.

Description string:

> "Get a compact, LLM-friendly summary of one Directory/Module/File node: its declared symbols (top-N by centrality, not the full list — call `graph_find_symbol` or `graph_neighbors` for the rest), its aggregated (not per-edge) inbound/outbound dependency counts collapsed by target module, its freshness/provenance, and — if `include_semantic=true` — its derived Community membership. Mirrors `get_board_summary`'s role for tickets: read this before deciding whether to `Read` full files, or call `graph_blast_radius`/`graph_call_path` for precise impact analysis on one of the symbols it lists."

Input schema:

```typescript
{
  workspace_id: z.string().describe('Workspace ID (required)'),
  graph_id: z.string().describe('Ontology graph ID (required)'),
  node_id: z.string().optional().describe('Directory/Module/File symbol_id to summarize — omit if passing path'),
  path: z.string().optional().describe('Directory or file path to summarize — omit if passing node_id. Exactly one of node_id/path is required.'),
  depth: z.enum(['immediate', 'recursive']).optional().default('immediate')
    .describe('immediate = only this node\'s direct children; recursive = roll up nested subdirectories too'),
  children_limit: z.number().optional().default(30).describe('Max declared symbols to list, ranked by pagerank/fan-in (hard ceiling 100)'),
  include_semantic: z.boolean().optional().default(false)
    .describe('Include derived-layer Community membership and semantic/curated concept links (opt-in per research-ontology.md §8.2, dimmed by default)'),
}
```

Output shape (example):

```json
{
  "node": { "symbol_id": "...", "path": "apps/server/src/services", "kind": "Directory", "loc": 4210, "file_count": 9 },
  "freshness": { "indexed_at": "2026-08-21T09:12:00Z", "commit": "a1b2c3d", "dirty_ratio": 0.02 },
  "children": {
    "total": 41,
    "returned": 30,
    "truncated": true,
    "items": [
      { "symbol_id": "...", "name": "UserService", "kind": "class", "path": "apps/server/src/services/user.service.ts", "start_line": 10, "confidence_bucket": "asserted" }
    ]
  },
  "dependencies_summary": {
    "completeness": "complete",
    "by_target_module": [
      { "module": "apps/server/src/entities", "edge_types": { "IMPORTS": 6, "USES_TYPE": 11 }, "symbol_count": 4 },
      { "module": "external:typeorm", "edge_types": { "IMPORTS": 3 }, "symbol_count": 3 }
    ]
  },
  "dependents_summary": {
    "completeness": "incomplete",
    "total_dependent_modules": 22,
    "top": [ { "module": "apps/server/src/modules/mcp/tools", "edge_count": 9 } ],
    "note": "This is an aggregated, module-level count. Call graph_blast_radius(node) on a specific symbol for the full reverse-reachability set."
  },
  "community": null
}
```

Two design choices here are direct, deliberate reuses of decisions the sibling documents already made, not new inventions: `dependencies_summary`/`dependents_summary` are collapsed by **target module**, never per-edge, which is exactly `research-extraction.md` trap #5's mandate ("aggregate reference edges... never ship raw call-site edges") applied at the tool-output layer instead of the rendering layer; and `completeness` reuses the SPDX-derived `complete | incomplete | no_assertion` vocabulary `research-ontology.md` §2.5/§8.5 already chose for exactly this "is this list the whole truth or a partial index" honesty problem, rather than silently presenting a partial dependents list as if it were exhaustive.

### 3.4 `graph_search_symbols`

**Why this one is justified, and why it's genuinely new (not a stub already named elsewhere):** `graph_find_symbol` resolves a *name* the agent already suspects; every survey source in §1 that separated a lexical/name tool from a semantic one (LocAgent's embedding baselines, Polycodegraph's `semantic_search`/`hybrid_search`, "Code Isn't Memory"'s `codebase_search` with a `vector|lexical|graph|hybrid` strategy parameter, `code-graph-mcp`'s hybrid BM25+vector `semantic_code_search`) found the two roles genuinely complementary, not redundant — an agent that doesn't know a symbol's name at all ("where is rate limiting enforced") needs a different query shape than one resolving a known name. `research-storage.md` §6.4 already designed the storage this needs — an ontology-node embedding table that is "a direct structural mirror of `ResourceEmbedding`" — so this tool is a thin MCP wrapper over already-specified storage, not new architecture.

Description string:

> "Search graph symbols by natural-language meaning rather than exact name — use this when you don't know the symbol's name (e.g. 'where is rate limiting enforced') and `graph_find_symbol`'s name-based lookup won't help. Uses the same pattern as `search_resources`: vector cosine similarity when an embedding provider is configured, falling back to lexical substring matching over name/qualified_name/doc otherwise. Response includes `search_mode` so you know which one ran."

Input schema:

```typescript
{
  workspace_id: z.string().describe('Workspace ID (required)'),
  graph_id: z.string().describe('Ontology graph ID (required)'),
  query: z.string().describe('Natural language description of the symbol you\'re looking for'),
  kind: z.enum(['class', 'interface', 'function', 'method', 'field', 'type', 'module', 'endpoint', 'data_entity']).optional()
    .describe('Restrict to one declaration kind'),
  confidence_min: z.number().min(0).max(1).optional().default(0.75).describe('Hide matches below this structural confidence'),
  limit: z.number().optional().default(15).describe('Max results (hard ceiling 30 — semantic matches need more per-result scrutiny than exact-name ones)'),
}
```

Output shape mirrors `search_resources`'s exact field convention (`search_mode`, `relevance_score` rounded to 3 decimals, `total`) for consistency with the one semantic-search tool AWB already ships:

```json
{
  "results": [
    { "symbol_id": "...", "name": "rateLimiter", "kind": "function", "path": "apps/server/src/common/guards/rate-limit.guard.ts",
      "start_line": 8, "relevance_score": 0.842, "confidence_bucket": "likely" }
  ],
  "search_mode": "vector",
  "total": 6
}
```

### 3.5 `graph_hotspots` — well-justified, deliberately not v1

Polycodegraph ships a `hotspots` tool ("functions sorted by fan-in") and a `metrics` tool; `research-ontology.md` §8.5 already caches `degree, pagerank` on every node, which means a hotspots query is a trivial indexed `ORDER BY pagerank DESC LIMIT N` — no bounded-BFS concerns, no new storage. It answers a real question ("what's the riskiest/most-depended-on code in this module before I start a large refactor") that none of §1's evidence actually measured as improving task accuracy — it is a triage aid for human exploration and for `research-visualization.md`'s semantic-zoom "which nodes render at the outermost tier" question (§4.8 there) more than a demonstrated agent-task-completion lever. Sketch only, since §5 recommends deferring it:

```typescript
{
  workspace_id: z.string(), graph_id: z.string(),
  scope_node_id: z.string().optional().describe('Restrict to this module\'s subtree; omit for whole-graph'),
  metric: z.enum(['pagerank', 'fan_in', 'fan_out']).optional().default('pagerank'),
  limit: z.number().optional().default(20),
}
```

### 3.6 Narrow tools vs. one fat tool, resolved

§2's survey found real tools at both extremes — Polycodegraph's 18 and `codegraph`'s 1 — with `codegraph`'s consolidation reporting the more dramatic efficiency numbers (88% fewer calls). AWB cannot simply copy either extreme: the fixed three (`graph_blast_radius`/`graph_call_path`/`graph_neighbors`) are already separately named by `research-storage.md`, so full one-tool consolidation is out of scope by prior decision, and Anthropic's own guidance (https://www.anthropic.com/engineering/writing-tools-for-agents) warns against tool sprawl on the other end — "choosing the right tools to implement" over maximizing tool count, and namespacing (a shared `graph_` prefix, which every tool in this document and in `research-extraction.md` §5.3 already carries) specifically so an agent's tool menu reads as one coherent family rather than a grab-bag. AWB's resolution is the middle path `codegraph`'s own design note actually describes when explaining *why* consolidation helped: "everything they [other tools] return already arrives inline" — i.e. the lever that matters is **response richness**, not **tool count** per se. `graph_find_symbol`'s `detail`+`suggested_next_calls` payload and `graph_module_summary`'s aggregated dependency/dependent rollups are both applications of that same lever: each of AWB's 5–6 total graph tools (3 fixed + `graph_find_symbol` + `graph_module_summary` + optionally `graph_search_symbols`) is designed so a single call often answers the question completely, without needing either more narrow tools or one do-everything tool.

### 3.7 Authorization tier and wiring note

All four tools proposed here are read-only and workspace-scoped — no destructive or privilege-changing operation. Reading `apps/server/src/modules/mcp/shared/tool-authz-gate.ts` directly: any **new** tool name that isn't already in that file's `KNOWN_EXISTING_TOOLS` snapshot resolves to `UNCLASSIFIED_TIER = 'deny'` by default — rejected unconditionally before the handler runs, regardless of caller identity — until a maintainer explicitly adds it to `TOOL_AUTHZ_TABLE`. Shipping any of `graph_find_symbol`/`graph_module_summary`/`graph_search_symbols`/`graph_hotspots` therefore requires an explicit `TOOL_AUTHZ_TABLE` entry in the same PR, not an oversight to catch later — this is exactly the failure mode the `awb-mcp-tool-wiring` skill's tier-classification step exists to prevent ("skipping the tier-classification step ships a tool that always returns Unauthorized, regardless of caller"). The right tier is `'caller'` (any resolvable MCP identity, the same floor `create_user`/`update_user` use per that file's own comments) — these tools need *some* authenticated session, not full-scope/agent-bound privilege — layered with an explicit workspace-boundary check in each handler using `resolveCallerWorkspaceId`/`callerCanAccessWorkspace` from `apps/server/src/modules/mcp/shared/authz.ts`, since the central gate's coarse tiers deliberately leave per-resource workspace-matching to per-file logic (that file's own comment gives `update_workspace` as precedent for exactly this split).

---

## 4. Context-budget guidance: how much graph should one call return

Three independent sources converge on bounds AWB can adopt directly rather than guess at.

**Anthropic's own ceiling and the concise/detailed lever.** Anthropic's tool-design guidance for Claude Code states plainly: "we restrict tool responses to 25,000 tokens by default" (https://www.anthropic.com/engineering/writing-tools-for-agents), and recommends "pagination, range selection, filtering, and/or truncation with sensible default parameter values for any tool responses that could use up lots of context," plus an explicit `response_format` lever (`concise` vs. `detailed`) whose own worked example shows a detailed response at 206 tokens against a concise one at 72 tokens — roughly a 3× difference for the same underlying data. None of AWB's proposed tools should approach the 25k ceiling in normal use; it is a hard backstop, not a target.

**AWB's own established defaults are already conservative, and this document's tools match them.** Every existing AWB MCP tool this research read defaults to a bounded row count well under any token ceiling: `search_resources` defaults `limit` to 10 (`apps/server/src/modules/mcp/tools/resource-tools.ts`), `get_ticket_activity` defaults to 50, `get_recent_activity` defaults to 100 (`apps/server/src/modules/mcp/tools/activity-tools.ts`). Because AWB's `ok()` helper (`apps/server/src/modules/mcp/shared/helpers.ts`) returns `JSON.stringify(data, null, 2)` as the literal tool-response text, token cost is directly proportional to JSON size — bounding row counts genuinely bounds context tokens, not just visually. `graph_find_symbol`'s default `limit=20`/ceiling 50 and `graph_module_summary`'s `children_limit=30`/ceiling 100 (§3.2, §3.3) sit inside this same established range, deliberately — a compact symbol object (name/kind/path/lines/signature/confidence, per the example in §3.2) runs roughly 40–80 tokens as pretty-printed JSON, so a 30-child module summary lands at ~1.2k–2.4k tokens and a 50-match `graph_find_symbol` response at ~2k–4k tokens — comfortably inside Codebase-Memory's own measured ~1,000-tokens-per-query benchmark for a *useful* graph answer (`research-extraction.md` §5.3; https://arxiv.org/html/2603.27277v1) and nowhere near the 25k backstop.

**AWB's own measured density justifies the specific numbers, not just analogy.** `research-extraction.md` §1 measured 27.6 definitions/kLOC on AWB's own 197.5 kLOC codebase, and separately implies an average file size around 256 LOC (from its ~3.9 files/kLOC figure) — meaning a typical single-file `graph_module_summary` call has on the order of 7 declared symbols, well inside the `children_limit=30` default; the 100-row ceiling exists specifically to bound the long tail of unusually large generated or "god" files, not the common case. RepoGraph's own ego-graph measurements (§1.2) — 1-hop neighborhoods averaging 11.6 nodes, 2-hop averaging 54.5 — independently land in the same range, and `research-visualization.md` §6.3 already derived a 20–50-node initial-render budget for the *human* UI from the yFiles knowledge-graph guide (https://www.yfiles.com/resources/how-to/guide-to-visualizing-knowledge-graphs). That the agent-facing default (`graph_find_symbol`'s `limit=20`) and the human-facing UI default (20–50 nodes) land on the same number is not a coincidence to smooth over — it is the same design decision `research-visualization.md` §6.6 already made explicit for focus+context ("the agent-facing tool and the human UI interaction should be the same backend call... not two independently-tuned implementations"), extended here to symbol lookup instead of neighborhood expansion.

**Response richness over row count, once more.** `codegraph`'s measured (self-reported, vendor) 62% token reduction alongside an 88% cut in tool-call count (§2, §3.6) is evidence that the more expensive failure mode in practice is not "one graph response was slightly too large" but "the agent needed four round trips because the first response didn't carry enough inline context" — reinforcing why `graph_find_symbol`'s `detail` object and `graph_module_summary`'s aggregated dependency rollups are worth their modest token cost: they are designed to prevent a second call, not just to bound the first one.

---

## 5. Decisive recommendation

**Ship `graph_find_symbol` and `graph_module_summary` first, in the same PR, wired into `TOOL_AUTHZ_TABLE` at the `'caller'` tier from the start (§3.7).** Every system surveyed in §1–§2 needs a name-resolution tool before anything else becomes useful, and `graph_module_summary` directly reuses a pattern (`get_board_summary`) already proven in AWB's own codebase — this is the lowest-implementation-risk, highest-leverage pair, and neither duplicates the fixed `graph_blast_radius`/`graph_call_path`/`graph_neighbors` traversal engine (`research-storage.md`).

**Ship `graph_search_symbols` second, gated behind the same `embeddingService.isEnabled()` check `search_resources` already uses.** Its value is real (§3.4) but conditional on the ontology-node embedding table (`research-storage.md` §6.4) actually being populated for a given workspace; shipping it with the same lexical-fallback branch `search_resources` already has means it degrades gracefully rather than blocking on embedding infrastructure.

**Defer `graph_hotspots` to backlog.** It is cheap to build (§3.5) but no source in §1 measured it as improving task completion — it is a human-exploration and semantic-zoom aid (`research-visualization.md`) more than a validated agent-accuracy lever. Ship it only once usage data from the first two tools shows agents actually reaching for a "what's risky here" query on their own.

**Why an agent would reach for these over a plain grep/Read, stated precisely rather than generically:** not because the graph is "always better" — §1.5's honest counter-evidence rules that framing out — but because of three specific, sourced advantages. *Precision on ambiguous or indirect names*: CodexGraph's own numbers show BM25 collapsing to 3.11% Pass@1 against 22.96% for structural retrieval on SWE-bench-Lite (§1.3) — grep cannot see through re-exports, dynamic dispatch, or generic method names, and `graph_find_symbol` resolves those cases the way `search_class`/`search_method`'s AST-awareness or CodexGraph's graph traversal already do, empirically, in the cited studies. *Token and round-trip economy*: `codegraph`'s measured 88%-fewer-tool-calls, 62%-fewer-tokens result and Codebase-Memory's ~10×-fewer-tokens/2.1×-fewer-tool-calls result (§1.5) both show that even where a grep-and-Read loop would eventually land on the right answer, it costs materially more context and more round trips getting there — exactly the economics §4's token budgets are designed around. *Multi-file awareness, honestly scoped*: "Code Isn't Memory"'s statistically-tested finding that gains concentrate in the ≥3-file-change bucket (91.3% vs. 44.9%) is the most precise available answer to "when should an agent reach for this" — for an isolated single-file fix, grep-and-Read is a perfectly reasonable choice the same paper's own non-significant cross-harness result (p=0.087) does not contradict; for anything that ripples across modules, `graph_module_summary`'s aggregated dependency rollup and a follow-up `graph_blast_radius` call are the tools this whole survey's evidence actually supports reaching for.

---

## 6. Top traps

**1. Don't market "graph beats grep" as a blanket claim — the evidence doesn't support it, and overclaiming will erode agent trust in the tool.** §1.3's EvoCodeBench near-null result (CodexGraph 11.87% vs. no-retrieval 11.79%) and §1.5's cross-harness non-significant result (p=0.087) are real, sourced, and specifically the kind of result the research brief asked not to be smoothed over. Description strings (§3.2–3.4) should stay precise about *when* a tool helps (ambiguous names, multi-file changes), not oversell universal superiority — an agent that learns a tool over-promises will under-use it later, the same trust cost `research-ontology.md` §6 already built an entire confidence/provenance system to avoid for LLM-derived edges.

**2. A graph result without `path:line` is a regression, not a feature, per §1.5's central finding.** Codebase-Memory's own 83%-vs-92% quality gap is directly attributable to a graph-only agent not grounding back to source; every match in every schema in §3 carries `path`/`start_line`/`end_line` by construction — dropping that field to save a few tokens would reintroduce the exact failure mode the evidence warns against, not a harmless space optimization.

**3. New tool names default to `deny`, not to `ungated` — the `TOOL_AUTHZ_TABLE` step is not optional cleanup.** §3.7 already covers the mechanics; the trap is treating it as follow-up work after a tool "already works" locally. `apps/server/src/modules/mcp/shared/tool-authz-gate.ts`'s `UNCLASSIFIED_TIER = 'deny'` default means an un-wired `graph_find_symbol` fails closed for every caller, which reads at first glance like a bug in the tool itself rather than a missing registration line.

**4. Don't let `graph_search_symbols` silently duplicate `search_resources`.** They search different corpora (graph symbol nodes vs. the `Resource` entity) but share an embedding-provider gate and a response-shape convention on purpose (§3.4); a future maintainer "simplifying" by merging them would break the `Resource`/`OntologyGraph` scope boundary `research-ontology.md` §8.1 depends on — keep the shared conventions, keep the tools separate.

**5. Bounding row count is necessary but not sufficient — aggregate, don't just truncate.** `research-extraction.md` trap #5 already made this point for rendering; §3.3's `dependencies_summary`/`dependents_summary` apply the same discipline to tool output. A `graph_module_summary` that silently truncates a 200-edge dependents list to "the first 30, alphabetically" gives an agent a misleadingly confident, arbitrary subset; collapsing to aggregated per-module counts with an explicit `completeness` marker (§3.3) is the honest version of the same bound.

---

## Sources

- LocAgent (ACL 2025) — https://arxiv.org/abs/2503.09089 ; full text https://arxiv.org/html/2503.09089 ; https://aclanthology.org/2025.acl-long.426.pdf ; code https://github.com/gersteinlab/LocAgent
- RepoGraph (ICLR 2025) — https://arxiv.org/abs/2410.14684 ; full text https://arxiv.org/html/2410.14684v1
- CodexGraph (NAACL 2025) — https://aclanthology.org/2025.naacl-long.7/ ; full text https://arxiv.org/html/2408.03910v3
- AutoCodeRover — https://arxiv.org/abs/2404.05427 ; full text https://arxiv.org/html/2404.05427
- Agentless: Demystifying LLM-based Software Engineering Agents — https://arxiv.org/abs/2407.01489 ; ACM TOSEM version https://dl.acm.org/doi/abs/10.1145/3715754
- "Code Isn't Memory: A Structural Codebase Index Inside a Coding Agent" (2026) — https://arxiv.org/abs/2606.22417 ; full text https://arxiv.org/html/2606.22417
- Codebase-Memory: Tree-Sitter-Based Knowledge Graphs for LLM Code Exploration via MCP — https://arxiv.org/html/2603.27277v1
- OG-RAG: Ontology-Grounded RAG (EMNLP 2025, non-code analog cited for the general "structured retrieval improves grounded accuracy" pattern) — https://arxiv.org/abs/2412.15235 ; https://aclanthology.org/2025.emnlp-main.1674/
- Sourcegraph precise vs. search-based code navigation — https://sourcegraph.com/docs/code-search/code-navigation/precise_code_navigation
- Anthropic — "Writing effective tools for AI agents" — https://www.anthropic.com/engineering/writing-tools-for-agents
- Serena MCP (oraios) — https://github.com/oraios/serena
- Polycodegraph MCP server — https://mcpservers.org/servers/smochan/polycodegraph
- `code-graph-mcp` (sdsrss) — https://github.com/sdsrss/code-graph-mcp
- `codegraph` (colbymchenry) — https://github.com/colbymchenry/codegraph
- SWE-bench Verified leaderboard, used only to calibrate that this document's cited resolve-rate percentages (AutoCodeRover 19%, Agentless 27%, LocAgent Pass@10 33–38%) are from 2024-era GPT-4/GPT-4o-class models, not current frontier models, so absolute numbers are dated even where the relative retrieval-strategy comparisons remain informative — https://leaderboard.steel.dev/leaderboards/swe-bench-verified/

Direct reads of AWB's own source informing §3's schema/description conventions and §3.7's authorization design: `apps/server/src/modules/mcp/tools/resource-tools.ts`, `apps/server/src/modules/mcp/tools/board-tools.ts`, `apps/server/src/modules/mcp/tools/activity-tools.ts`, `apps/server/src/modules/mcp/tools/index.ts`, `apps/server/src/modules/mcp/shared/helpers.ts`, `apps/server/src/modules/mcp/shared/authz.ts`, `apps/server/src/modules/mcp/shared/tool-authz-gate.ts`.

Cross-referenced (already established, not re-argued here):
- `docs/ontology-graph/research-extraction.md` — Tier 1/1.5/2/3 pipeline, measured density (27.6 defs/kLOC, 243.6 refs/kLOC), the `graph_find_symbol`/`graph_module_summary` names this document schemas, the `{source, confidence, indexed_at, commit}` response mandate, the aggregate-not-per-edge trap
- `docs/ontology-graph/research-ontology.md` — LPG-in-SQLite schema, `layer`/`confidence`/`symbol_id`, the `path:line`-grounding mandate (§10), ordinal confidence buckets (§6.4), `completeness` vocabulary (§2.5/§8.5)
- `docs/ontology-graph/research-storage.md` — `graph_blast_radius`/`graph_call_path`/`graph_neighbors` as fixed, bounded-BFS-only tools this document composes with rather than duplicates
- `docs/ontology-graph/research-visualization.md` — the 20–50-node focus+context budget this document's `graph_find_symbol` default reuses, and the "agent tool and human UI should share one backend call" principle extended here to symbol lookup
