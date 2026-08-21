# Code Graph Extraction — Deep Technology Research (for AWB Ontology Graph)

Date: 2026-08-21. Target: per-workspace Ontology Graph in a Node.js/TypeScript NestJS server (AWB), arbitrary user repos, many languages, must scale to millions of LOC / 100k+ nodes, incremental, cheap.

**Bottom line up front:** build a **tree-sitter tags pass as the mandatory always-on tier** (file-incremental, zero-config, embeddable in Node via WASM), add an **optional SCIP tier** (run indexers out-of-process in the agent worktree, ingest `scip.proto` payloads) for repos where users want compiler-accurate edges, and use **LLM only for a bounded enrichment layer** (domain concepts, module intents) that never sits on the critical path of structural extraction. Do **not** build on stack-graphs (archived), Kythe (unmaintained), or Kuzu (archived).

---

## 0. Landscape changes you must know (2024–2026)

These are recent, load-bearing facts that invalidate a lot of older blog advice:

| Fact | Evidence |
|---|---|
| **`github/stack-graphs` is ARCHIVED** (2025-09-09), "no longer supported or updated by GitHub… we recommend you fork it". Last crate release `stack-graphs 0.14.1` (2024-12-13); `tree-sitter-stack-graphs-typescript 0.4.0` (2024-12-13); npm `tree-sitter-stack-graphs@0.7.0` is from 2023. | https://github.com/github/stack-graphs , https://crates.io/crates/stack-graphs |
| **SCIP moved out of Sourcegraph into neutral governance** (announced 2026-03-25). New org `scip-code`, Core Steering Committee = Catherine Gasnier (Meta), Jamy Timmermans (Uber), Michal Kielbowicz (Sourcegraph). SEP (SCIP Enhancement Proposal) RFC process. | https://sourcegraph.com/blog/the-future-of-scip , https://github.com/scip-code/scip |
| **Kythe is effectively unmaintained** — dedicated Google team laid off April 2024; last stable tag v0.0.53 (2021). Repo still receives commits (pushed 2026-07-16) but no roadmap. | https://en.wikipedia.org/wiki/Google_Kythe , https://github.com/kythe/kythe |
| **KuzuDB (embedded Cypher graph DB) ARCHIVED 2025-10-10** after Apple acqui-hired the team. Many 2025 "code graph" blog stacks recommend it. Don't. | https://www.theregister.com/software/2025/10/14/kuzudb-graph-database-abandoned-community-mulls-options/1142229 |
| **Semgrep moved cross-file/cross-function analysis behind a proprietary binary** (Dec 2024 licensing change + Semgrep Rules License v1.0). Community fork **OpenGrep** (LGPL-2.1, Jan 2025) restores cross-function taint. | https://semgrep.dev/docs/semgrep-code/semgrep-pro-engine-intro , https://github.com/opengrep/opengrep |
| **`tree-sitter` native Node binding lags the WASM binding**: npm `tree-sitter@0.25.1` vs `web-tree-sitter@0.26.12` (2026-08-08). Grammar npm packages lag further (`tree-sitter-typescript@0.23.2` still peer-pins `tree-sitter ^0.21.0`). | npm registry, verified 2026-08-21 |
| LSIF is legacy. `sourcegraph/lsif-node` and `sourcegraph/lsif-go` are archived (2022/2023). Only `microsoft/lsif-node` is alive. Treat LSIF as an **import format only**. | https://github.com/sourcegraph/lsif-node |

---

## 1. Measured numbers from THIS machine (not from blogs)

I ran real benchmarks on the AWB host (Node v24.14.1, `/mnt/data/awb-agents/awb/repo`, 771 TS/TSX/JS files, 197.5 kLOC, 9.24 MB), single-threaded.

**web-tree-sitter (WASM) 0.25.10 + `tree-sitter-wasms` grammars, parse + tags-style query:**

```
files: 771   kLOC: 197.5   MB: 9.24
total wall:   2.42 s   -> 81,727 lines/s end-to-end (parse + query + extract)
parse only:   1.56 s   -> 126,654 lines/s
query only:   0.51 s
captures:  106,654
files with parse errors: 8 (1.0%)
RSS: 234 MB
```

**node-tree-sitter (native N-API) 0.25.1, parse only:**

```
1.15 s -> 171,877 lines/s  (8.05 MB/s), RSS 246 MB
```

→ **Native is ~1.36× faster than WASM on parse.** Given WASM's zero-toolchain distribution and 371-grammar availability, that 36% is worth paying. (Corroborates the Pulsar team: "WebAssembly penalty is small enough that most users won't notice", https://blog.pulsar-edit.dev/posts/20240902-savetheclocktower-modern-tree-sitter-part-7/)

**Graph-size density measured on the same corpus** (this is the number you size storage with):

```
definitions: 5,459   -> 27.6 defs / kLOC
references : 48,113  -> 243.6 refs / kLOC   (call sites + imports)
breakdown: method 2200, function 1634, interface 937, class 443, type 245
           reference.call 43,346, reference.import 4,767
```

**Extrapolations for AWB planning (single-threaded WASM, 82k lines/s wall):**

| Repo size | Parse+extract, 1 thread | 8 workers | Def nodes | Ref edges (raw) |
|---|---|---|---|---|
| 200 kLOC | 2.4 s | ~0.4 s | 5.5k | 48k |
| 1 MLOC | ~12 s | ~1.8 s | ~28k | ~244k |
| 10 MLOC | ~2 min | ~18 s | ~280k | ~2.4M |
| 100 MLOC | ~20 min | ~2.6 min | ~2.8M | ~24M |

Independent corroboration of the same order of magnitude: the Codebase-Memory paper indexes the **Linux kernel (≈30 MLOC) into 2.1M nodes / 4.9M edges in ~3 minutes**, and **Django into 49,398 nodes / 196,022 edges in ~6 s**, with **incremental re-index ~1.2 s** (https://arxiv.org/html/2603.27277v1). A production RFC quotes tree-sitter at **≈100k lines/second** and single-file update latency of **50–200 ms** vs **60–120 s** for a SCIP full reindex (https://github.com/orgs/sheeptechnologies/discussions/4).

**Conclusion: the syntactic pass is essentially free.** Even 100 MLOC is a few CPU-minutes. The cost centres are (a) storage/query, (b) the *semantic* pass, (c) any LLM pass.

---

## 2. Technology-by-technology

### 2.1 tree-sitter (+ tags queries)
- **What it yields.** A CST per file. The built-in *tagging* convention (`tags.scm`) captures `@definition.{class,function,method,module,interface}`, `@reference.{call,class,implementation}`, `@name`, `@doc`, plus `#strip!` / `#select-adjacent!` predicates; `tree-sitter tags` emits name, role, location, docstring. Explicitly **single-file scope, no cross-file resolution**. (https://tree-sitter.github.io/tree-sitter/4-code-navigation.html)
- **Node/edge types you can realistically derive:** File/Module/Class/Interface/Function/Method/Field/Type/Enum nodes; `CONTAINS`, `DEFINES`, `IMPORTS`, unresolved `CALLS_NAME`, `EXTENDS`/`IMPLEMENTS` (from heritage clauses), `DECORATED_BY`, `EXPORTS`. Everything cross-file requires your own resolver.
- **Language coverage.** 23 grammars in the official org; `kreuzberg-dev/tree-sitter-language-pack` ships **371 pre-compiled parsers at ABI 14** (tree-sitter 0.21–0.26 compatible) with **Node.js and WASM bindings**, MIT, on-demand parser download, and explicitly excludes copyleft grammars. `tree-sitter-wasms` (npm, Unlicense) ships 36 prebuilt WASM grammars. `@vscode/tree-sitter-wasm` (MIT) ships VS Code's curated set. (https://github.com/kreuzberg-dev/tree-sitter-language-pack)
- **Build cost / MLOC.** ~12 s/MLOC single-thread WASM measured here; ~8 s/MLOC native; linear, embarrassingly parallel.
- **Incrementality.** Best in class two ways: (1) *file-level* — hash the file (XXH3 at ~30 GB/s is what Codebase-Memory uses), reparse only changed files, no cross-file recompute needed; (2) *intra-file* — `tree.edit()` + reparse touches only the affected subtree (sub-ms for a 1-char edit in a 100k-line file).
- **License.** MIT. Grammars vary per-grammar (check: some community grammars are GPL — the language-pack curates this for you).
- **Node embeddable?** Yes, first-class. `web-tree-sitter` (WASM, MIT, 0.26.12) or `tree-sitter` (N-API, 0.25.1). WASM is the right default for a server that must ship arbitrary grammars.
- **Maturity.** 26.7k stars, active daily, 0.26.x line.

### 2.2 ast-grep
- Rust, MIT, 15.6k stars, active. Tree-sitter under the hood with a smarter matcher that skips trivial CST nodes. **Has an official N-API package: `@ast-grep/napi` (MIT, 0.45.1, 2026-08-07)** plus per-language packages (`@ast-grep/lang-typescript`). Multi-threaded via `ignore` crate, uses all cores.
- **Explicitly no semantic analysis**: no types, no CFG/DFG, no taint. (https://ast-grep.github.io/advanced/tool-comparison.html)
- **Use in AWB:** as the *rule engine* for language-specific extraction patterns (much nicer to author and version than raw `.scm` queries), not as the graph builder. Its rule YAML is a good format for "how do I find a Nest `@Controller` route in this language".

### 2.3 SCIP (SCIP Code Intelligence Protocol)
- **Data model.** Protobuf; `Index → Document[] → Occurrence[] + SymbolInformation[]`. Symbols are **human-readable strings** (scheme/manager/package/version/descriptors), which is the whole point: no cross-file ID join tables, symbols are globally comparable across indexers and repos. Occurrences carry ranges + `symbol_roles` bitmask (definition/reference/write/read/import/…) and `syntax_kind`; `SymbolInformation` carries `relationships` (implementation, type-definition, reference, definition). **Explicitly a transmission format, not a storage/query format** — "it is not meant as a storage format for querying". Document-centric arrays, no adjacency-list graph encoding, so it streams. (https://github.com/scip-code/scip/blob/main/docs/DESIGN.md)
- **vs LSIF:** LSIF gzip payloads are **~4× larger compressed / ~5× larger uncompressed**; replacing `lsif-node` with `scip-typescript` gave a **10× CI speedup**; Meta measured SCIP **8× smaller and 3× faster to process** than LSIF. (https://sourcegraph.com/blog/announcing-scip)
- **Indexers & languages** (https://scip-code.org/): `scip-typescript` (TS/JS), `scip-java` (Java/Scala/Kotlin), `scip-python`, `scip-go`, `scip-clang` (C/C++), `scip-dotnet` (C#/VB), `scip-ruby`, `scip-php`, `scip-dart`, `scip-rust`. `rust-analyzer` emits SCIP natively (`rust-analyzer scip`).
- **Build cost — hard numbers.** `scip-clang`: **30–50% more wall time than a full parallel type-check** of the project, measured on a 480k-SLOC project (22 cores) and a **2.75M-SLOC project (88 cores)**; ~50% more time than `lsif-clang`; index size **10–20% of the equivalent LSIF index**; **Chromium index ≈375 MB uncompressed / 53 MB compressed**. Requires a `compile_commands.json`. **Incremental indexing: not supported, on the roadmap.** (https://sourcegraph.com/blog/announcing-scip-clang)
- **`scip-typescript` practicalities.** Requires `tsconfig.json` (or `--infer-tsconfig`) **and a completed `npm/yarn/pnpm install`**; OOMs on large codebases → `node --max-old-space-size=16000` and/or `--no-global-caches` (slower). Apache-2.0. **CLI-only; not a Node library.** (https://github.com/sourcegraph/scip-typescript)
- **Incrementality.** The protocol's fatal flaw for AWB's "keep fresh incrementally" goal: **indexers are whole-project**. A production RFC measured **60–120 s full reindex for a single-file change on 10k+ file repos** and moved off SCIP entirely to tree-sitter for that reason (https://github.com/orgs/sheeptechnologies/discussions/4). Incremental indexing has been "on the roadmap" since 2022.
- **Node embeddable?** Not as a library. But **consuming** SCIP in Node is trivial: `scip.proto` → `protobufjs`/`ts-proto` codegen (there is **no official npm package** — `@sourcegraph/scip` does not exist; the npm name `scip` is an unrelated LLM protocol package). Producing SCIP = spawn a CLI in the repo checkout.
- **License.** Apache-2.0 across `scip`, `scip-typescript`, `scip-clang`, `scip-java`, `scip-go`. `scip-python` is NOASSERTION (derived from Pyright — check before shipping).

### 2.4 LSIF
Legacy predecessor. JSON-lines graph with opaque numeric IDs; hard to debug, big, and slow. Sourcegraph's own indexers are archived; only `microsoft/lsif-node` is maintained. **Recommendation: accept LSIF as an import (there is a SCIP→LSIF converter, and Glean has LSIF ingest), never emit it.**

### 2.5 GitHub stack-graphs
- **Idea (still the best idea in the space).** Per-file, build an isolated subgraph encoding name-binding rules; resolution = path-finding over a *symbol stack* where blue nodes push and red nodes pop and you may not enter a pop node unless its symbol tops the stack. Graphs are built from tree-sitter CSTs via the **`tree-sitter-graph` DSL** (stanzas → nodes/edges). **Zero config, no build system, no CI, no untrusted code execution** — GitHub processes "most commits within seconds of your push" across "millions of repositories, petabytes of code, thousands of pushes per minute". Powers GitHub's Precise Code Navigation (Python, then TypeScript, 2024-03). (https://github.blog/open-source/introducing-stack-graphs/ , https://arxiv.org/abs/2211.01224)
- **Nodes/edges:** push-symbol / pop-symbol / scope / root / jump nodes; edges are binding-precedence-ordered. It answers *reference → definition*, not a general property graph.
- **Cost/incrementality:** file-incremental at index time, resolution cost deferred to query time (path-finding, can be exponential in pathological cases; mitigated by partial-path stitching databases).
- **Maturity: DEAD as an upstream dependency** (archived 2025-09-09; last release Dec 2024). Rust only; would need a fork + N-API/WASM wrapper. `tree-sitter-graph` itself is Apache-2.0, last push 2024-12-11, also quiet.
- **Verdict for AWB: steal the design (file-isolated subgraphs + deferred cross-file resolution), do not take the dependency.**

### 2.6 Meta Glean
- **Model.** Facts in predicates (≈SQL tables of rows), declarative logic query language **Angle**, derived predicates computed at query time or ahead of time, **immutable stackable layers** giving non-destructive incremental updates. RocksDB storage. Designed for monorepos with **billions of facts**. Incremental cost is **O(fanout)** (the transitive set of files depending on the change) rather than O(repo).
- **Hard numbers (Hackage, 2,922 packages):** Glean **470 s** to index vs hiedb **1,021 s**; DB **0.8 GB** vs **5.2 GB**; find-references for `Data.Aeson.encode` **0.03 s raw / 0.39 s via Glass** vs hiedb **2.3 s** (415 vs 416 refs). (https://simonmar.github.io/posts/2025-05-22-Glean-Haskell.html)
- **Language coverage — and the key insight.** `glean/lang/` contains: `angle, clang, codemarkup, dotnet-scip, erlang, flow, go, hack, haskell, java-alpha, java-lsif, kotlin, lsif, python-pyrefly, python-scip, rust-scip, scip, swift, typescript-lsif, typescript`. **Meta's own answer to "how do I cover many languages" is: ingest SCIP/LSIF.** Only the top-value languages get native compiler-integrated indexers.
- **License.** BSD (repo LICENSE = "BSD License… Facebook, Inc."), GitHub reports NOASSERTION. Written in **Haskell + Hack**; server is a Thrift service. **Not embeddable in Node.** Operationally heavy (RocksDB + Thrift + Haskell toolchain).
- **Verdict:** copy the *schema philosophy* (facts + derived predicates + immutable layers), not the software.

### 2.7 Google Kythe
- **Model.** Language-agnostic node/edge graph with **VNames** (corpus/root/path/language/signature) as universal identifiers; deliberately open schema ("new node and edge kinds without central approval"); hub-and-spoke to turn O(L×C×B) integrations into O(L+C+B); serving tables built by post-processing pipelines (Beam).
- **Hard requirement:** an **instrumented build**. Extractors wrap the compiler to capture *compilation units* (full hermetic inputs), then per-language indexers run over them. **This is a non-starter for arbitrary user repos** — you'd have to run their build.
- Indexers: C++, Java, Go (partial), plus community. Apache-2.0. Go/C++/Java implementation, **not Node embeddable**.
- **Maturity: stagnant.** Team laid off April 2024, last stable v0.0.53 (2021).

### 2.8 Joern / Code Property Graphs
- **Model.** CPG = AST ∪ CFG ∪ PDG (control + data dependence) ∪ call graph ∪ type graph, as a directed edge-labeled attributed multigraph; queried with a Scala/Gremlin-flavoured DSL (CPGQL) over **OverflowDB** (in-memory graph with disk overflow).
- **Frontends (14, from `joern-cli/frontends`):** `c2cpg, jssrc2cpg, pysrc2cpg, javasrc2cpg, jimple2cpg` (JVM bytecode), `kotlin2cpg, gosrc2cpg, csharpsrc2cpg, php2cpg, rubysrc2cpg, rust2cpg, swiftsrc2cpg, abap2cpg, ghidra2cpg` (binaries), `x2cpg` (shared).
- **Cost.** Heavy. Dataflow (PDG) construction is the expensive part and is superlinear; OverflowDB is memory-hungry; JVM. Fine for a 8k-method audit, not for building a 100k-node graph on every push across arbitrary repos.
- **License** Apache-2.0. **Scala/JVM — not Node embeddable**; would be a spawned process + JVM in your image. 3.4k stars, very active (pushed today).
- **Verdict:** the *right* answer if AWB ever wants taint/dataflow-grade "what breaks if I change X" for C/Java/Python. Wrong answer for the general multi-language ontology graph. Keep as an optional deep-analysis plugin.

### 2.9 LSP-based indexing (language servers as extractors)
- **What you get:** `documentSymbol` (hierarchical symbol tree), `workspace/symbol`, `definition`, `typeDefinition`, `implementation`, `references`, `callHierarchy/incomingCalls|outgoingCalls`, `typeHierarchy`, `semanticTokens`. That is *almost exactly* an ontology graph edge set, compiler-accurate, and it is the **only** universal semantic API across languages.
- **Reference implementations:** `microsoft/multilspy` (Python; auto-downloads platform-specific server binaries, handles JSON-RPC lifecycle, per-language tuned configs; Python/Rust/Java/Go/JS/Ruby/C#/Dart) from the NeurIPS'23 Monitor-Guided Decoding paper (https://github.com/microsoft/multilspy). `oraios/serena` (MIT, **28.3k stars**, active) is the production-grade LSP→MCP bridge — the closest existing thing to what AWB wants to expose to agents.
- **Cost.** Servers are stateful and warm-up-bound, not throughput-bound. `references` on a hot symbol in a large repo is seconds. Batch-indexing an entire repo through LSP is *far* slower than tree-sitter and roughly comparable to SCIP (SCIP indexers are usually built on the same compiler frontends: `scip-python`←Pyright, `scip-typescript`←tsc, `scip-rust`←rust-analyzer).
- **Traps:** requires installed dependencies and a working build to be accurate; degrades silently on broken builds and generated code; each language server has its own install/JDK/venv/toolchain requirement; memory per server is 0.5–4 GB.
- **Node embeddable?** Yes as *clients* — `vscode-jsonrpc` / `vscode-languageserver-protocol` npm packages, spawn servers as child processes. This is a natural fit for AWB because agents already run in git worktrees where deps are installed.

### 2.10 Semgrep / OpenGrep
- tree-sitter parse → language-agnostic **IL** → YAML rule matching. Vendor claim **20k–100k LOC/s per rule**. OSS CE is **intraprocedural only** (single function); cross-function and cross-file (interfile) analysis is a **proprietary binary**; Semgrep Rules License v1.0 (Dec 2024) forbids commercial reuse of their rules. OCaml, LGPL-2.1 for the engine, **CLI only, not Node-embeddable**. **OpenGrep** (LGPL-2.1, community fork, Jan 2025) restores cross-function taint.
- **Verdict:** wrong tool for graph construction (rule-per-pattern, no whole-program symbol table, per-rule cost scales with rule count). Right tool if you later want "find all places matching a security/domain pattern" as *node annotations*. If you use it, use OpenGrep for licensing sanity.

### 2.11 universal-ctags
- **Yields:** flat tag records (name, file, line, kind, scope, optional `typeref`/`inherits`/`signature` fields). **Definitions only, no references, no call edges.** ~150 languages incl. regex-defined ones.
- **Speed:** measured dead-even with tree-sitter — **1.618 s (ctags) vs 1.645 s (tree-sitter)** over ~2,700 Go files (~1,600 files/s, 0.6 ms/file). (https://github.com/chrismwendt/ctags-vs-tree-sitter)
- **License: GPL-2.0** — a real problem if you want to link/bundle it into a commercial Node server; shelling out to a separate binary is the usual mitigation but adds a system dependency.
- **Verdict:** tree-sitter dominates it (same speed, gives you references and structure and a real tree). Only reason to keep ctags: instant coverage of long-tail/exotic languages with no tree-sitter grammar. Sourcegraph's own search-based nav is "powered by tools like ctags and tree-sitter" (https://sourcegraph.com/docs/code-search/code-navigation/precise_code_navigation).

### 2.12 srcML
- Source → **XML document** preserving all original text (round-trippable), queryable with XPath/XSLT/RELAX NG. **Only C, C++, C#, Java, Python.** Output is **~4.5× source size** uncompressed, ~1.5× compressed. GPL-3.0, C++ CLI, actively released (Aug 2025) but noted in the literature as lagging on new language features.
- **Verdict:** academic-grade, wrong language coverage, GPL-3.0, XML tax. Skip.

### 2.13 LLM-assisted extraction
- **Where it demonstrably helps:** (a) *enrichment* — short intent summaries per Folder/File/Class/Function, then embed them (Code-Craft/HCGS: hierarchical bottom-up summarization where each node's prompt includes its children's summaries, using **Claude Haiku 3.5**; +27.15 pp Pass@1 on large codebases, +25.55 pp on medium, over 7,531 functions / 5 repos — https://arxiv.org/html/2504.08975v1); (b) *domain-concept edges* that no parser can see (GitNexus/Graphify dual-graph: deterministic tree-sitter graph + LLM-inferred cross-layer semantic edges, with an explicit "when the two engines disagree, a human decides" gap — https://www.sidharthsatapathy.com/blog/gitnexus-dual-graph-engine-token-savings/).
- **Where it fails:** LLMs miss factory patterns and indirect imports (GitNexus's own postmortem); minor prompt wording changes produce materially different ontologies (LLMs4OL 2025); it is non-deterministic and non-incremental by nature.
- **Cost shape.** Per-node summarization is **O(nodes)** LLM calls. At the measured 27.6 definitions/kLOC, **1 MLOC ≈ 28k LLM calls**. Even at ~$0.50/M input tokens and ~600 tokens/call, that's ~$10–30/MLOC per full pass and hours of wall time — versus **12 seconds** for the whole structural pass. **This is the single biggest cost-blowup risk in the feature.**
- **Mitigation for AWB:** LLM enrichment must be (1) opt-in, (2) budgeted per workspace, (3) applied top-down only to *aggregate* nodes (folder/module/class), not every function, (4) cached by content hash so a file edit re-summarizes exactly one node + its ancestors, (5) never required for the graph to be queryable.

---

## 3. Comparison table

| Tech | Node/edge types yielded | Languages | Build cost / MLOC | Incremental | License | Embeddable in Node? | Maturity (2026-08) |
|---|---|---|---|---|---|---|---|
| **tree-sitter + tags** | Def nodes (class/fn/method/iface/module), unresolved refs (call/import), CONTAINS; no cross-file binding | 23 official, **371 prebuilt** via language-pack | **~12 s WASM / ~8 s native**, 1 thread (measured) | **Best**: per-file hash + intra-file tree edit (sub-ms) | MIT (grammars vary) | **Yes** (`web-tree-sitter` WASM / `tree-sitter` N-API) | Very high, 0.26.x, daily commits |
| **ast-grep** | Same as tree-sitter, via YAML rules; rewrite too | tree-sitter grammars | ~same, multi-threaded by default | file-level | MIT | **Yes** (`@ast-grep/napi`) | High, 15.6k★ |
| **SCIP** | Compiler-accurate defs/refs/impls/type-defs, cross-repo symbol strings, doc/hover | 10 indexers: TS/JS, Java/Scala/Kotlin, Py, Go, C/C++, C#/VB, Ruby, PHP, Dart, Rust | scip-clang: **+30–50% over a full type-check** (2.75 MLOC/88 cores); TS/Py similar order; needs deps installed | **None** (whole-project; roadmap only) | Apache-2.0 (scip-python NOASSERTION) | **Consume yes** (protobuf codegen); **produce = spawn CLI** | High + now neutral governance (SEP process, CSC w/ Meta+Uber) |
| **LSIF** | Same shape as SCIP, opaque IDs | historic Go/Java/Scala/Kotlin/TS/JS | 4–5× bigger, ~10× slower than SCIP | none | MIT | consume yes | **Legacy**; SG indexers archived |
| **stack-graphs** | Name-binding paths (ref→def) via push/pop symbol nodes | Python, TS, Java, JS (partial) | file-incremental index; path-find at query | **Best-in-class design** | Apache-2.0 / MIT | Rust only; needs N-API/WASM fork | **ARCHIVED 2025-09-09** |
| **Glean** | Arbitrary fact predicates + derived predicates (Angle) | native: C++, Hack, Python, Haskell, Flow, Erlang, Swift, Kotlin, TS; **rest via SCIP/LSIF ingest** | Hackage 2,922 pkgs in **470 s**, DB **0.8 GB** | **Yes** — immutable layers, O(fanout) | BSD | **No** (Haskell/Hack + Thrift + RocksDB) | High, Meta-internal-grade, active |
| **Kythe** | VName graph, open node/edge schema | C++, Java, (Go partial) | requires running the user's build | via re-extraction | Apache-2.0 | **No** | **Stagnant** (team cut 2024; v0.0.53 in 2021) |
| **Joern CPG** | AST+CFG+PDG+CALL+TYPE, full dataflow/taint | 14 frontends incl. C/C++, Java, JVM bytecode, JS, Py, Go, C#, PHP, Ruby, Rust, Swift, Kotlin, ABAP, binaries | Heavy/superlinear (PDG), JVM, RAM-bound | Weak | Apache-2.0 | **No** (Scala/JVM subprocess) | High, very active |
| **LSP servers** | documentSymbol, definition, references, callHierarchy, typeHierarchy, implementations, semanticTokens | ~every language with a server | Slow, stateful, warm-up bound; needs installed deps | Native (servers are incremental internally) | per-server (mostly MIT/EPL/Apache) | **Yes as client** (`vscode-jsonrpc`, spawn servers) | Very high (Serena 28.3k★, multilspy) |
| **Semgrep / OpenGrep** | Pattern matches (annotations), intra-function dataflow; interfile = proprietary | ~30 | 20k–100k LOC/s **per rule** | none | LGPL-2.1 engine; rules proprietary (Semgrep) | **No** (OCaml CLI) | High but licensing-hostile; use OpenGrep |
| **universal-ctags** | Definition tags only (+scope/inherits/typeref); **no references** | ~150 | ~1,600 files/s (0.6 ms/file) ≈ tree-sitter | file-level | **GPL-2.0** | No (spawn binary) | Very mature, active |
| **srcML** | Full AST-as-XML, round-trippable | C, C++, C#, Java, Python | fast; output **4.5× source size** | none | **GPL-3.0** | No | Maintained but niche/lagging |
| **LLM extraction** | Domain concepts, intents, cross-layer semantic edges | any | **~28k calls/MLOC**, $10–30/MLOC, hours | content-hash cache only | n/a | Yes | Research-grade; non-deterministic |

---

## 4. Hybrid pipelines: how the fast syntactic pass and the precise semantic pass are actually combined

Everyone who ships this converges on the **same three-tier ladder**, differing only in where they draw the line:

**Tier 0 — search/regex fallback.** Always available, always wrong sometimes.

**Tier 1 — syntactic (tree-sitter / ctags).** Fast, zero-config, always fresh, per-file incremental, universal language coverage. Produces *definitions* with high precision and *references by name* with low precision. Sourcegraph: "search-based code navigation is powered by tools like ctags and tree-sitter… fast and always available, but it can occasionally return false-positive and false-negative results" (https://sourcegraph.com/docs/code-search/code-navigation/precise_code_navigation).

**Tier 2 — semantic (SCIP / LSP / compiler).** "Compiler-accurate and works across repositories", but "requires custom configuration to set up" (ibid). Whole-project, slow, needs deps + build config.

**The combination patterns in production:**

1. **Fallback layering (Sourcegraph).** Query hits the precise index if one exists for that repo@commit and covers that file; otherwise falls back to syntactic, then to search. Every result carries a provenance/precision label. **This is the pattern AWB should copy: the graph is a union with a `confidence`/`source` property on every edge.**

2. **Semantic-as-ingest (Meta Glean).** Native indexers only for the handful of high-value languages; everything else enters through SCIP/LSIF ingest into the same fact schema (`dotnet-scip`, `python-scip`, `rust-scip`, `java-lsif`, `typescript-lsif` in `glean/lang/`). **Normalize on one internal schema; make SCIP an *importer*, not your model.**

3. **Syntactic skeleton + semantic upgrade (stack-graphs / CodexGraph).** Build a file-isolated graph with unresolved reference stubs; run a separate resolution phase that stitches them. CodexGraph does exactly this: "Phase 1 shallow indexing" (single-pass symbol extraction) then "Phase 2 complete edges" via DFS/AST to resolve cross-file and re-export relationships (https://arxiv.org/html/2408.03910v3).

4. **Confidence-scored heuristic resolution (Codebase-Memory).** When you have no compiler, resolve names with a **cascade** and *store the confidence*: import-map lookup 0.95 → same-module 0.90 → import-suffix 0.85 → unique-name project-wide 0.75 → suffix match 0.55 → fuzzy 0.30–0.40; for Go/C/C++ add LSP-style receiver-type/pointer/namespace tracking. (https://arxiv.org/html/2603.27277v1). **This is the single most directly reusable design in this whole report** — it turns "tree-sitter can't do cross-file" from a blocker into a graded edge property.

5. **Dual graph, deterministic + LLM (GitNexus + Graphify).** Structural graph from tree-sitter; a separate LLM pass adds semantic/cross-layer edges. Routing in practice: ~70% structural, ~25% semantic, ~5% grep.

6. **Deliberate de-escalation.** At least one production team ripped SCIP out entirely for latency reasons: single-file update **>60 s → <500 ms target**, achieved by going pure tree-sitter file-incremental (https://github.com/orgs/sheeptechnologies/discussions/4). Read this as: *don't put SCIP on the write path.*

---

## 5. Recommended stack for AWB

### 5.1 Extraction

**Tier 1 (mandatory, always-on) — tree-sitter in-process.**
- `web-tree-sitter` (WASM) in a **`worker_threads` pool** inside `apps/server` (or better: a dedicated `apps/indexer` process so a grammar segfault/OOM can't take down NestJS). Pin `web-tree-sitter` and the grammar bundle **as a matched pair** (see traps).
- Grammars from `kreuzberg-dev/tree-sitter-language-pack` (371 langs, ABI 14, MIT, permissive-only, on-demand download + prefetch) with `tree-sitter-wasms` / `@vscode/tree-sitter-wasm` as fallbacks for the top ~20 languages you bundle by default.
- Per-language extraction spec = a versioned `tags.scm`-style query file **plus** an optional `@ast-grep/napi` ruleset for framework-level concepts (routes, DI providers, entities, migrations). Version the query files; the query-file version is part of the file's cache key.
- Emit **per-file fact bundles**, never global state: `defs[]`, `refs[]` (unresolved, name + qualifier + call-shape), `imports[]`, `exports[]`, `heritage[]`, `docstrings[]`, plus `file_hash` (XXH3) and `extractor_version`.

**Tier 1.5 (mandatory) — a confidence-scored cross-file resolver.**
- A separate, cheap, whole-workspace pass that turns `refs[]` into `CALLS`/`REFERENCES` edges using the Codebase-Memory cascade (import-map 0.95 → same-module 0.90 → import-suffix 0.85 → unique-name 0.75 → suffix 0.55 → fuzzy 0.35). **Every edge stores `confidence` and `resolver` provenance.**
- Keep the resolver **incremental**: it only needs the (small) symbol table + import maps of the changed file plus the global name→symbol index. Rebuild the affected file's outgoing edges; recompute *incoming* edges only for symbols whose definitions changed.

**Tier 2 (optional, per-repo opt-in) — SCIP ingest, out of process.**
- AWB already has the perfect substrate: **agents run in git worktrees with dependencies installed**. Run `scip-typescript` / `scip-python` / `scip-go` / `scip-java` there, as a *scheduled/manual* job (Action), never on the push path.
- Ingest `index.scip` via `ts-proto`/`protobufjs` generated from `scip.proto`; map SCIP symbol strings → your node IDs; **upgrade** matching Tier-1.5 edges to `confidence = 1.0, resolver = 'scip'` and **add** edges Tier 1 could never find (interface implementations, type definitions, cross-package references). Keep Tier-1 edges that SCIP didn't cover.
- Store the SCIP-derived layer as its own **immutable layer** keyed by `(repo, commit, indexer, indexer_version)` — Glean's layering model. Then "stale semantic layer + fresh syntactic layer" is a first-class, queryable state, not a bug.

**Tier 2b (optional, interactive) — LSP on demand.**
- For "find all references to this exact symbol, precisely, right now", spawn the language server in the agent's worktree via `vscode-jsonrpc` and answer from `callHierarchy`/`references`. Don't batch-index through LSP. `oraios/serena` is the reference implementation to study.

**Tier 3 (optional, budgeted) — LLM enrichment.**
- Bottom-up hierarchical summaries (Code-Craft/HCGS style) on **folders, modules, classes only** — not functions. Cache by subtree content hash. Feed summaries into the existing `ResourceEmbedding` pipeline (AWB already has `embedding.service.ts` + OpenAI embeddings) so ontology nodes are semantically searchable alongside resources.
- Optional "domain concept" extraction pass producing `CONCEPT` nodes and `IMPLEMENTS_CONCEPT` edges, explicitly labelled `source='llm'` and excluded from any query that claims precision.

### 5.2 Storage note (flagging for the storage architect)
- **Do not pick Kuzu** — archived 2025-10-10 after an Apple acqui-hire, despite being the default recommendation in most 2025 code-graph blog posts.
- AWB already runs SQLite (better-sqlite3/sql.js) with a Postgres pre-sync path. **Adjacency tables in SQLite + recursive CTEs + FTS5 is the boring correct answer** and is exactly what Codebase-Memory ships ("single SQLite file, zero external dependencies", <1 ms Cypher-equivalent queries, ~0.3 ms BFS at depth 5, <10 ms regex symbol search). At the measured densities, a 10 MLOC repo is ~280k def nodes / ~2.4M edges — trivially within SQLite's comfort zone with the right indices.
- Sharding key should be `(workspace_id, resource_id, folder_root)` so the "pick a repo + folder path" UX maps to a physical partition and a folder-scoped graph can be dropped/rebuilt independently.

### 5.3 Agent exposure
- New MCP tools alongside `search_resources`/`embed_resources`: `graph_find_symbol`, `graph_neighbors(node, edge_types, depth)`, `graph_call_path(from, to)`, `graph_blast_radius(node)` (reverse-reachability = the query enterprises actually want and that no benchmark measures), `graph_module_summary`.
- **Every response must carry `{source: 'tree-sitter'|'scip'|'lsp'|'llm', confidence, indexed_at, commit}`.** The strongest recurring criticism of MCP code-intel tools is that they expose no freshness/confidence/provenance contract — a result "could come from a live language server, yesterday's graph, a vector guess or a generated summary" (https://anthonywest.co.uk/research/code-intelligence-indexing-2026-openai).
- Payoff evidence: graph-vs-file-exploration comparisons report **~10× fewer tokens (~1,000 vs ~10,000 per query)**, **2.1× fewer tool calls (2.3 vs 4.8)**, **>100× lower query latency**, at **83% of the file-explorer agent's answer quality (0.92 baseline)** — i.e. cheaper and faster but *not* strictly better; keep grep in the loop (https://arxiv.org/html/2603.27277v1). RepoGraph reports **+32.8% average relative improvement** across four SWE-bench frameworks at a cost of **+3.9k–17.5k tokens** of context (https://arxiv.org/html/2410.14684v1).

---

## 6. Top 5 traps

**1. Grammar/runtime ABI mismatch will bite you on day one — I hit it live.**
`npm i web-tree-sitter@0.26.12 tree-sitter-wasms` then loading a grammar throws inside `getDylinkMetadata` (a raw `Error` with no message, from Emscripten dylink parsing). Downgrading to `web-tree-sitter@0.25.10` fixed it instantly. The native path is worse: `tree-sitter@0.25.1` + `tree-sitter-typescript@0.23.2` is an unresolvable peer conflict (the grammar still pins `tree-sitter ^0.21.0`) and only installs with `--legacy-peer-deps`. Compatibility flows **one way only** — newer `web-tree-sitter` reads older parser builds, never the reverse — and each tree-sitter version needs a specific Emscripten version to build grammars. **Mitigations:** pin runtime+grammars as one versioned bundle; record `grammar_abi` and `extractor_version` in every row so a bundle bump triggers a controlled reindex, not silent corruption; smoke-test every grammar at startup (parse a 3-line fixture) and quarantine failures. Second-order trap: parsers can call arbitrary C stdlib functions that `web-tree-sitter` must pre-export at compile time — an unlisted call **fails silently at runtime** (Pulsar maintains a custom build tracking these).

**2. WASM memory is not garbage collected — `tree.delete()` or die.**
Every `Tree` (and `Query` cursor, and `Node` you retain) is an Emscripten heap allocation. Miss a `.delete()` in a loop over 100k files and you OOM the NestJS process, not just the indexer. My benchmark held RSS at 234 MB across 771 files *only* because it deletes every tree. **Mitigations:** run extraction in a `worker_threads` pool or a separate process with a hard `--max-old-space-size` and a restart-on-threshold policy; never hand raw tree-sitter `Node` objects across an async boundary; convert to plain JS facts immediately and drop the tree. Also cap per-file size (I skip >2 MB): minified bundles, generated protobuf/`*.pb.go`, lockfiles and vendored blobs are where tree-sitter's worst-case behaviour lives, and they contribute nothing to an ontology.

**3. The semantic tier is a freshness trap, not a quality upgrade.**
SCIP indexers are **whole-project** — 60–120 s to reflect a one-line change on a 10k-file repo, and `scip-clang` costs **30–50% more than a full parallel type-check** (2.75 MLOC / 88 cores) with **incremental indexing still unimplemented after four years**. They also need `tsconfig.json` + a completed `npm install` (and OOM at default Node heap: `--max-old-space-size=16000`, `--no-global-caches`), or a `compile_commands.json`, or a Gradle `maven-publish` block. On arbitrary user repos most of that will simply not be there. **Mitigation:** SCIP is a *batch enrichment layer on an immutable, commit-pinned layer*, never on the write path; the graph must be fully useful and fully fresh with Tier 1 alone; show users the semantic layer's commit vs HEAD.

**4. Naive cross-file resolution silently manufactures wrong edges — and nobody notices.**
Tree-sitter tagging is **explicitly single-file**; `foo.save()` is just the string `save`. Unique-name and suffix matching are how everyone bridges the gap, and they are wrong constantly in dynamic languages, in monorepos with 40 classes named `Service`, on re-exports/barrel files, on factories, on DI containers, and on method dispatch. Macro-heavy C is worse: **macros aren't represented in tree-sitter ASTs at all**. GitNexus's own postmortem admits the LLM pass "can miss factory patterns and indirect imports". A graph that confidently reports a wrong `CALLS` edge is more dangerous to an agent than no edge. **Mitigations:** never store an unqualified edge without a `confidence` and `resolver`; expose confidence through MCP and let agents threshold; default the UI and agent tools to ≥0.75; make `blast_radius` return `(certain[], probable[], possible[])` rather than one flat list; add an explicit `AMBIGUOUS_TARGETS` edge kind rather than picking a winner.

**5. Cost blows up in the LLM tier and in the reference-edge count, not in parsing.**
Parsing 10 MLOC is ~18 s on 8 workers. But at the measured **243.6 references/kLOC**, 10 MLOC is **~2.4M raw reference edges** (vs only ~280k definition nodes) — the edge table, not the node table, is what breaks your 100k-node budget, your rendering, and your query latency. And per-function LLM summarization is **~28k calls per MLOC** (~$10–30/MLOC, hours of wall time) for a graph whose structural pass cost twelve seconds. **Mitigations:** (a) aggregate reference edges — store `CALLS(caller_symbol → callee_symbol, count, first_line)` collapsed per pair rather than per call site, which typically cuts the edge table 3–10×; (b) never ship raw call-site edges to the renderer — render an aggregated module/package-level graph with drill-down (this is what Louvain community detection is for in Codebase-Memory); (c) budget LLM enrichment per workspace, restrict it to aggregate nodes, cache by subtree hash, make it strictly opt-in and strictly non-blocking; (d) treat "how many nodes will this folder produce" as a **pre-flight estimate shown to the user** (28 defs/kLOC is a good predictor) before they hit Build.

---

## Sources

- https://sourcegraph.com/blog/announcing-scip
- https://sourcegraph.com/blog/the-future-of-scip
- https://sourcegraph.com/blog/announcing-scip-clang
- https://scip-code.org/
- https://github.com/scip-code/scip/blob/main/docs/DESIGN.md
- https://github.com/sourcegraph/scip-typescript
- https://sourcegraph.com/docs/code-search/code-navigation/precise_code_navigation
- https://github.com/sourcegraph/lsif-node
- https://tree-sitter.github.io/tree-sitter/4-code-navigation.html
- https://github.com/tree-sitter/tree-sitter
- https://github.com/tree-sitter/tree-sitter/wiki/List-of-parsers
- https://github.com/kreuzberg-dev/tree-sitter-language-pack
- https://www.npmjs.com/package/web-tree-sitter
- https://blog.pulsar-edit.dev/posts/20240902-savetheclocktower-modern-tree-sitter-part-7/
- https://en.wikipedia.org/wiki/Tree-sitter_(parser_generator)
- https://ast-grep.github.io/advanced/tool-comparison.html
- https://ast-grep.github.io/blog/tree-sitter-rust-rewrite
- https://github.blog/open-source/introducing-stack-graphs/
- https://github.blog/changelog/2024-03-14-precise-code-navigation-for-typescript-projects/
- https://arxiv.org/abs/2211.01224
- https://github.com/github/stack-graphs
- https://crates.io/crates/stack-graphs
- https://engineering.fb.com/2024/12/19/developer-tools/glean-open-source-code-indexing/
- https://github.com/facebookincubator/glean
- https://simonmar.github.io/posts/2025-05-22-Glean-Haskell.html
- https://kythe.io/docs/kythe-overview.html
- https://kythe.io/docs/schema/writing-an-indexer.html
- https://en.wikipedia.org/wiki/Google_Kythe
- https://docs.joern.io/code-property-graph/
- https://github.com/joernio/joern
- https://cpg.joern.io/
- https://github.com/microsoft/multilspy
- https://arxiv.org/pdf/2306.10763
- https://github.com/oraios/serena
- https://docs.semgrep.dev/semgrep-code/semgrep-pro-engine-intro
- https://github.com/opengrep/opengrep
- https://github.com/universal-ctags/ctags
- https://github.com/chrismwendt/ctags-vs-tree-sitter/blob/master/README.md
- https://www.srcml.org/
- https://github.com/srcML/srcML
- https://arxiv.org/html/2603.27277v1
- https://arxiv.org/html/2410.14684v1
- https://arxiv.org/html/2408.03910v3
- https://aclanthology.org/2025.naacl-long.7.pdf
- https://arxiv.org/html/2504.08975v1
- https://arxiv.org/pdf/2503.09089
- https://github.com/orgs/sheeptechnologies/discussions/4
- https://anthonywest.co.uk/research/code-intelligence-indexing-2026-openai
- https://www.sidharthsatapathy.com/blog/gitnexus-dual-graph-engine-token-savings/
- https://github.com/codegraph-ai/CodeGraph
- https://www.theregister.com/software/2025/10/14/kuzudb-graph-database-abandoned-community-mulls-options/1142229
- https://arxiv.org/html/2510.20345v1
