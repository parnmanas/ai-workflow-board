# Beautiful Large-Scale Visualization — Rendering, Layout, and Navigation Research (for AWB Ontology Graph)

Date: 2026-08-22. Target: the rendering/interaction layer for a per-workspace Ontology Graph, React 18 + Vite frontend, must stay legible and responsive from a single small folder up to the ~280k definition-node / ~2.4M raw-reference-edge regime `research-extraction.md` §1 measures for a 10 MLOC repo. This document does **not** re-litigate the aggregation-graph-plus-drill-down architecture — that is already decided in `research-extraction.md` §5.3/§6 and `research-ontology.md` §8.7/§10 — it answers the concrete follow-on question those documents left open: *which rendering engine, which layout-stability mechanism, which semantic-zoom mapping, which clustering algorithm, and which focus+context interaction actually implement that architecture in a React app, with evidence.*

**Bottom line up front:** run **two rendering engines behind one interaction model, not one engine for everything.** The default view — the aggregated community/module graph the architecture already mandates — is small (thousands, not millions, of meta-nodes even at 10 MLOC) and belongs on **sigma.js + graphology + `@react-sigma/core`**, because that stack's `nodeReducer`/`edgeReducer` and `camera.ratio` primitives are the actual mechanism that implements semantic zoom, and its styling/interaction richness is what a "beautiful" graph needs at that node count. **cosmos.gl (via `@cosmograph/react`)** is the *opt-in raw/expanded mode* — GPU-simulated, real-world-verified past a million nodes/edges — for when a user deliberately expands past the point sigma.js's own maintainers and issue tracker document it degrading, empirically **~5,000 richly-styled nodes / ~50,000–100,000 edges** (https://github.com/jacomyal/sigma.js/issues/239, https://github.com/jacomyal/sigma.js/issues/567, https://github.com/safishamsi/graphify/issues/447). Layout stability across incremental rebuilds is **not** a layout-algorithm feature you turn on — it is **a position-persistence contract you build**: store each node's last converged `(x, y)` keyed by its stable `symbol_id` (the identity `research-ontology.md` §8.5 already mandates), reseed unchanged nodes at their old coordinates and mark them `fixed` so ForceAtlas2 only moves the new/changed ones, and animate the transition with `animateNodes` so even the nodes that do move don't jump (https://github.com/graphology/graphology/blob/master/src/layout-forceatlas2/README.md, https://github.com/graphology/graphology/discussions/375, sigma.js `animateNodes`). For community detection, use **Leiden, not Louvain** — the connectivity guarantee is not academic hygiene, it is a correctness requirement for an aggregated view: a Louvain "module" node can silently represent a **disconnected** set of files (up to 16% of communities in the algorithm's own validation, https://www.nature.com/articles/s41598-019-41695-z), which would render as one blob two things that have nothing to do with each other. Two real, small, TypeScript-native packages exist today — `graphology-communities-leiden` (upstream graphology, same author as sigma's data layer) and `leiden-ts` (zero-dependency) — so this is a same-ecosystem swap, not a new dependency class, unlike the closest analog system (Codebase-Memory), which shipped plain Louvain (https://arxiv.org/html/2603.27277v1). Focus+context is the UI expression of the bounded-BFS `graph_neighbors`/`graph_blast_radius` tools `research-storage.md` §2.4 already mandates be application-orchestrated rather than one open-ended recursive CTE — the interaction pattern to copy is Neo4j Bloom's **Expand** / **Advanced Expansion** (selective by edge type and direction) plus yFiles' "start at 20–50 nodes, expand on demand" discipline, not a bigger initial render.

---

## 0. TL;DR decisions

| Question | Decision | Primary evidence |
|---|---|---|
| Default rendering engine (aggregated view) | **sigma.js + graphology + `@react-sigma/core`** — WebGL 2D, `nodeReducer`/`edgeReducer` for semantic zoom, mature React bindings | https://www.sigmajs.org/ , https://www.npmjs.com/package/@react-sigma/core |
| Opt-in raw/expanded engine | **cosmos.gl via `@cosmograph/react`** — GPU force sim + render, verified past 1M nodes/edges on real datasets | https://openjsf.org/blog/introducing-cosmos-gl , https://nightingaledvs.com/how-to-visualize-a-graph-with-a-million-nodes/ , https://www.npmjs.com/package/@cosmograph/react |
| Where sigma.js actually breaks (measured, not marketing) | **~5,000 nodes / ~50,000–166,000 edges**, documented across four independent reports spanning 2014→2026 | https://github.com/jacomyal/sigma.js/issues/239 , https://github.com/jacomyal/sigma.js/issues/567 , https://github.com/safishamsi/graphify/issues/447 , CESTA Stanford (via search) |
| Layout stability mechanism | **Position persistence, not a layout feature**: store `(x,y)` per `symbol_id`, reseed + `fixed=true` on unchanged nodes, run FA2 only for new/moved nodes, `animateNodes` the transition | https://github.com/graphology/graphology/blob/master/src/layout-forceatlas2/README.md , https://github.com/graphology/graphology/discussions/375 |
| cosmos.gl's equivalent | Weaker: `disableSimulation` + initial positions is **init-time only**, no per-node pin mid-simulation — accept more drift in raw mode | https://github.com/cosmosgl/graph/wiki |
| Semantic zoom mechanism | `camera.ratio` threshold → swap which node **type-tier** (`Community`→`Module/File`→`Type/Callable`) the `nodeReducer` renders, mirroring `research-ontology.md` §8.3's node taxonomy | https://www.sigmajs.org/docs/advanced/sizes/ , CodeCharta/ExplorViz precedent below |
| Semantic-zoom prior art that transfers | **CodeCharta** (city metaphor), **ExplorViz** (camera-distance LOD + mini-map, VISSOFT 2025), **CodeCity** (Wettel & Lanza, +24%/-12% controlled experiment) | https://github.com/maibornwolff/codecharta , https://arxiv.org/abs/2510.00003 , https://wettel.github.io/codecity.html |
| Semantic-zoom prior art that does **not** transfer | GitHub's "dependency graph" is a **flat list/table**, not a zoomable node-link view; Gource is **history replay**, not a live structural browser — both commonly assumed otherwise | https://docs.github.com/en/free-pro-team@latest/github/visualizing-repository-data-with-graphs/about-the-dependency-graph , https://gource.io/ |
| Closest commercial analog | **CodeSee Maps** (now GitKraken, acquired May 2024 after CodeSee's Feb 2024 shutdown) — explicit "zoom in for detail, zoom out for overview" over a real multi-language code graph | https://www.codesee.io/codebase-maps , LinkedIn shutdown post (Shanea Leven) |
| Community-detection algorithm | **Leiden**, not Louvain — connectivity-guaranteed, faster at scale, two same-ecosystem JS packages exist | https://www.nature.com/articles/s41598-019-41695-z , `graphology-communities-leiden`, `leiden-ts` |
| Real-world scale evidence for Leiden | **3.8M nodes / 16.5M edges** citation graph, GPU 3–4s vs CPU Louvain-class ~145s; genomics graph **315× speedup** | https://developer.nvidia.com/blog/how-to-accelerate-community-detection-in-python-using-gpu-powered-leiden/ |
| What the closest analog actually shipped | Codebase-Memory uses **plain Louvain** (local-moving + <1%-density refinement, 3–5 iterations) — a deliberate simplicity choice AWB should not copy given the connectivity risk | https://arxiv.org/html/2603.27277v1 |
| Focus+context interaction | **Bounded N-hop Expand**, selective by edge type/direction (Neo4j Bloom pattern), start render at 20–50 nodes (yFiles guidance), reuse the same bounded-BFS backend `research-storage.md` §2.4 already mandates | https://neo4j.com/docs/bloom-user-guide/current/bloom-visual-tour/bloom-scene-interactions/ , https://www.yfiles.com/resources/how-to/guide-to-visualizing-knowledge-graphs |
| React library with expand/collapse + clustering built in (fallback option) | **reagraph** (Three.js/React-Three-Fiber) — worth evaluating if sigma.js's DOM/WebGL-2D interaction model proves too low-level to build Expand on quickly | https://reagraph.dev/docs |

---

## 1. What this document assumes from its siblings

`research-extraction.md` §1 and §5.3 already fix the numbers this whole document is sized against: **10 MLOC ≈ 280k definition nodes, ~2.4M raw reference edges**, and the mandate to **never render raw edges — aggregate call-pairs, render the aggregate graph, drill down.** `research-ontology.md` §8.3–8.4 already fixes the **node/edge type taxonomy** (`Repository → Directory → File → Module → Type → Callable → Field`, plus `Community`/`CommunityReport` as *derived*-layer nodes from clustering) and §8.7 already **named** sigma.js and cosmos.gl as the two candidates and asserted, without primary sourcing, that "sigma.js struggles at ~5k styled nodes and its force layout degrades past ~50k edges" and that "cosmos.gl/Cosmograph runs the whole force simulation in GPU shaders and handles ~1M nodes/edges." Section 2 below is the **primary-source verification** of that claim (it holds, with receipts), and the rest of this document is the part `research-ontology.md` explicitly punted: layout stability, semantic zoom, clustering algorithm choice, and focus+context — none of which the prior two documents researched.

---

## 2. Rendering engines at scale: sigma.js + graphology vs. cosmos.gl

### 2.1 sigma.js + graphology

Sigma.js is a WebGL 2D graph renderer built on top of **graphology**, the graph-data-structure library that also ships layout algorithms (ForceAtlas2, a plain force layout), metrics, and — as of the current monorepo — Louvain *and* Leiden community detection, all as one coherent ecosystem with one graph object shared across rendering, layout, and analysis (https://github.com/jacomyal/sigma.js, https://graphology.github.io/standard-library/). Its two load-bearing performance primitives are:

- **`nodeReducer` / `edgeReducer`** — functions called once per node/edge *per frame*, immediately before rendering, that can override any visual attribute (size, color, label, hidden) without mutating the underlying graphology instance. This is the actual mechanism semantic zoom is built from (§4.8 below), and it is also how large graphs stay interactive: hide labels, shrink or hide edges, or drop whole node classes when the camera is zoomed out, all without touching graph data.
- **`camera.ratio`-driven size scaling** — node/edge pixel sizes scale by `Math.sqrt(zoomRatio)` by default, overridable via `zoomToSizeRatioFunction`, so the renderer already has a first-class notion of "what zoom level am I at" to key a reducer off of (https://www.sigmajs.org/docs/advanced/sizes/).

### 2.2 cosmos.gl / Cosmograph

cosmos.gl is a GPU-accelerated force-directed layout **and** rendering engine — the force simulation itself runs in WebGL fragment/vertex shaders, not on the CPU/JS main thread, which is the structural reason it scales past where sigma.js does: "All the computations and drawing occur on the GPU in fragment and vertex shaders," avoiding the CPU↔GPU memory round-trips that bottleneck CPU-simulated + WebGL-rendered approaches (https://github.com/cosmosgl/graph). It joined the **OpenJS Foundation** as an incubating project in 2025/2026, with the foundation's own framing: it "enables scalable and performant visualization of **over one million nodes and links**, offering unprecedented capabilities in real-time graph rendering" (https://openjsf.org/blog/introducing-cosmos-gl). Version 3.0 (2025) added a new rendering engine, async initialization, and moved to `luma.gl` (WebGL2) (https://openjsf.org/blog/cosmos-gl-v3). It powers **Cosmograph**, the hosted/embeddable product (`cosmograph.app`), which the OpenJS post separately describes as GPU parallel processing that computes "force-directed layouts for graphs with hundreds of thousands or millions of nodes in seconds."

### 2.3 Six independent benchmark/demo data points

This table exists to verify — with primary sources, not vendor marketing — the specific numeric ceilings `research-ontology.md` §8.7 asserted without citation.

| # | Source | System | What it shows |
|---|---|---|---|
| 1 | https://github.com/jacomyal/sigma.js/issues/239 (2014) | sigma.js | User asks whether anyone has rendered **~5,000 nodes / ~100,000 edges**; reports ForceAtlas "not spacing the graph out" and "latency" issues. Closed `wontfix` — twelve years later, the underlying CPU-layout limitation is architectural, not a bug to patch. |
| 2 | https://github.com/jacomyal/sigma.js/issues/567 | sigma.js | A **423-node / 17,000-edge** graph already struggles; disabling edge rendering (`drawEdges=false`) "does not seem to result in any increased performance" — i.e. past a threshold, the bottleneck is the **layout simulation**, not the renderer, so renderer-side mitigations don't help. |
| 3 | https://github.com/safishamsi/graphify/issues/447 | Graphify (an LLM-assisted code-graph tool, same design space as this document) | Concrete real-world failure: **8,333-node** code graph is rejected outright ("too large for HTML viz") because the underlying renderer (vis.js) "degrades past ~3–5K DOM nodes." The filed fix, ranked by effort: (1) **aggregated view** — collapse communities into meta-nodes with weighted inter-community edges, expand on demand [= exactly the architecture `research-extraction.md` already mandates]; (2) switch to **sigma.js or Cosmograph**, stated to handle **50,000+ nodes at 60fps**; (3) a `--force-html` escape hatch. |
| 4 | Stanford CESTA (Center for Spatial and Textual Analysis) blog, retrieved via search snippet | Cosmograph vs sigma.js | Direct quote: "A network with **seven thousand nodes and 166,000 edges** brought Sigma.js to its knees" — browser slowdown, sluggish interaction — motivating their move to Cosmograph specifically because "both rendering... and layout... are computationally expensive, and browser-based tools have traditionally tried to solve them on the CPU... where JavaScript runs," which cosmos.gl avoids by running both on GPU. |
| 5 | https://openjsf.org/blog/introducing-cosmos-gl | cosmos.gl | Real-time visualization "of over one million nodes and links" as the foundation's own headline capability claim, corroborated by the GPU-shader architecture in #6. |
| 6 | https://nightingaledvs.com/how-to-visualize-a-graph-with-a-million-nodes/ | Cosmograph, real (non-synthetic) datasets | Three concrete production datasets rendered: **ABACUS shell** sparse matrix (23,412 nodes / 195,072 edges), a **patient-distribution system** (475,448 nodes / 1,014,134 edges), a **Jacobian model** (13,694 nodes / 69,148 edges) — "capable of visualizing networks that have a million nodes and edges, and that's not the limit." |

Rows 1–4 triangulate sigma.js's practical ceiling at **~5,000 nodes** once styling/interaction is real (not a bare unstyled demo) and **~50,000–166,000 edges** depending on how much of that is force-simulated vs. just rendered; rows 5–6 corroborate cosmos.gl clearing two to three orders of magnitude past that on real, not synthetic, data. Note the mechanism difference this implies: sigma.js's ceiling is **layout-CPU-bound** (issue #567's finding that disabling edge rendering didn't help), while cosmos.gl's advantage is specifically that it **moves the layout computation itself to the GPU**, not just the drawing — so the fix is architectural, not tunable, and AWB should not expect to tune sigma.js's way past its ceiling.

### 2.4 Comparison table

| | sigma.js + graphology | cosmos.gl (Cosmograph) |
|---|---|---|
| Layout compute location | CPU (JS), via graphology's ForceAtlas2/force | **GPU** (fragment/vertex shaders) |
| Render location | GPU (WebGL) | GPU (WebGL2 via luma.gl as of v3) |
| Practical node ceiling (styled, interactive) | ~5,000 (issues #239, #567, graphify #447) | 1,000,000+ (real datasets, Nightingale/CESTA) |
| Per-node/edge dynamic styling | `nodeReducer`/`edgeReducer`, per-frame, rich | Coarser — GPU buffers, less per-element JS-side logic |
| Ecosystem | graphology (shared graph object with layout + Louvain/Leiden + metrics) | Own data model (Apache Arrow-backed for data transfer) |
| React binding | `@react-sigma/core` (v5.0.6, active) | `@cosmograph/react` (v2.5.0, published within the last day at research time — actively maintained) |
| Governance | Independent OSS (jacomyal/Yomguithereal) | OpenJS Foundation incubating project (2025/2026) |
| Best fit | Aggregated/community view; anything requiring rich interaction, tooltips, per-node color/shape logic | Raw/expanded "show me everything" mode; embeddings/similarity maps |

Sources: as cited inline above, plus https://www.npmjs.com/package/@react-sigma/core , https://www.npmjs.com/package/@cosmograph/react .

### 2.5 Verdict: a two-tier rendering strategy, not a single winner

Given `research-extraction.md`'s own numbers, the aggregated/community view of even a 10 MLOC repo collapses ~280k definition nodes into what is very likely **hundreds to low thousands** of `Community`/`Module`/`File` meta-nodes after Leiden clustering (§5 below) — i.e. it lands **inside** sigma.js's comfortable envelope, not past it. That means:

- **Default view = sigma.js.** Richer interaction, smaller bundle, no WebGL2/GPU-shader compatibility risk, mature React bindings, and — critically — `nodeReducer`/`camera.ratio` are the *actual implementation mechanism* for semantic zoom (§4.8), which cosmos.gl's coarser per-element styling model does not offer as directly.
- **cosmos.gl is the deliberate opt-in.** When a user drills into one folder and asks to "expand everything" past what the aggregated view shows — or on a repo whose *aggregated* graph itself is still large because the workspace genuinely has an unusually flat/uncohesive structure — swap the renderer, not the architecture. `@cosmograph/react`'s own pitch is exactly this: "ship interactive knowledge graph explorers... without reimplementing layout or WebGL," i.e. it is meant to be dropped in as an alternate view, not rearchitected around.

This mirrors what production tools independently converged on: Graphify's own fix ladder (aggregate first, WebGL-swap second) is the same two-tier shape, arrived at from a real failure, not a design exercise (https://github.com/safishamsi/graphify/issues/447).

---

## 3. Layout stability across incremental rebuilds

### 3.1 Why this is the hard part, not a solved problem

Force-directed layouts (ForceAtlas2 included) are, by design, **not deterministic across runs** unless seeded identically: "ForceAtlas2 assigns initial random positions, and nodes converge across several iterations... there is no one correct layout" — only the *relative* clustering structure is guaranteed to persist across different random initial positions, not the absolute coordinates (graphology/NetworkX documentation, corroborated by the algorithm's own paper: Jacomy, Venturini, Heymann, Bastian, "ForceAtlas2, a Continuous Graph Layout Algorithm for Handy Network Visualization Designed for the Gephi Software," PLOS ONE 9(6): e98679, 2014, https://journals.plos.org/plosone/article?id=10.1371%2Fjournal.pone.0098679 — explicitly a *continuous, exploratory-analysis* algorithm, not a layout with a defined ground truth). Left to its defaults, re-running the layout after every incremental graph rebuild (file edit → reindex, per `research-ontology.md` §8.6) will re-randomize starting positions and produce a **visually unrelated** layout every time — every node appears to "jump," destroying the spatial memory a user builds up navigating the graph. This is not a hypothetical: it is exactly the complaint that generated a multi-year, still-open Obsidian feature request and an unofficial plugin to work around it (§3.5).

### 3.2 The general mechanism: fixed/pinned nodes + seeded positions, not a special "incremental mode"

No library in this space ships an "incremental layout" button. What they ship instead — consistently, across three independent implementations — is the same two-primitive mechanism, which composes into incrementality:

1. **You must seed positions before running the layout.** graphology's ForceAtlas2 README is explicit: "Each node's starting position must be set before running ForceAtlas 2 layout. Two attributes called `x` and `y` must therefore be defined for all the graph nodes" — with a documented edge case that **all nodes at `(0,0)`** breaks the algorithm (https://github.com/graphology/graphology/blob/master/src/layout-forceatlas2/README.md). This is not friction; it is the hook: if you seed continuing nodes at their **previously stored** converged position instead of a random one, the layout starts "warm" and, because ForceAtlas2 is a *continuous* relaxation (small local moves per iteration, not a global re-solve), it tends to stay near a good local seed rather than converge to a visually unrelated new configuration.
2. **You can pin a subset of nodes so the simulation never moves them.** Both of graphology's layout packages expose this: ForceAtlas2 nodes are pinned via a boolean `fixed` node attribute, and the plain force layout (`graphology-layout-force`) exposes the equivalent as `isNodeFixed` (a string attribute name or predicate function), documented use case explicitly being "drag-and-drop interactions where you want to maintain a node's position once the user has placed it" (https://github.com/graphology/graphology/discussions/375, https://graphology.github.io/standard-library/layout-force.html). Nothing about this primitive is drag-and-drop-specific — it composes directly into "keep every unchanged node exactly where it was; only let new/changed nodes move."

The equivalent primitive exists in the D3 ecosystem too, for completeness: `simulation.alphaTarget(value)` re-heats a *running* simulation instead of jump-starting it from `alpha=1` ("set `alphaTarget` to a relatively low number when updating a layout, and node positions will update smoothly instead of suddenly jumping to life"), and `node.fx`/`node.fy` (fixed-x/fixed-y) pin individual nodes exactly like graphology's `fixed` attribute — the canonical example being drag interactions (`simulation.alphaTarget(0.3).restart()` then `d.fx = d.x; d.fy = d.y`) (https://d3js.org/d3-force/simulation, https://stamen.com/forcing-functions-inside-d3-v4-forces-and-layout-transitions-f3e89ee02d12/). Three independent force-layout implementations (graphology ForceAtlas2, graphology force, d3-force) converging on the same two-primitive design — seed + pin — is strong evidence this is *the* general solution, not a library-specific trick.

### 3.3 cosmos.gl's weaker equivalent — a real limitation to design around

cosmos.gl supports seeding via a `disableSimulation` configuration flag, documented as being for "when you just want to visualize your dataset with provided node coordinates," but with the explicit caveat that "it can be set on graph initialization only" (https://github.com/cosmosgl/graph/wiki). There is no documented per-node "pin this node, let that one move" primitive analogous to graphology's `fixed` attribute — cosmos.gl's GPU simulation model is closer to "all nodes simulated, or none." For AWB's raw/expanded cosmos.gl mode (§2.5), the practical consequence is: seed **all** node positions (old nodes at their stored coordinates, new nodes at a cheap heuristic placement — e.g., near their `CONTAINS`-parent's stored position, or near a resolved neighbor) and let the whole thing re-settle. Because force simulations are locally stable near a good seed, this will drift less than a cold random start, but it will drift more than graphology's true per-node pinning — a real, worth-flagging trade-off of choosing the GPU engine for the mode where layout stability matters most (a user re-opening a graph they've already explored).

### 3.4 Evidence this is a real, felt user need, not a nice-to-have

Obsidian's graph view — the most widely used force-directed graph UI most developers have personally used — has had an open feature request titled "Save Node Positions in Graph View" active across multiple forum pages, and lacking first-party support, the community shipped an unofficial plugin (**Persistent Graph**) specifically to "save and restore the positions of nodes," whose own README warns it "makes use of internal Obsidian APIs, so it may break with updates" and is "unlikely to be accepted as a community plugin" (https://github.com/Sanqui/obsidian-persistent-graph, https://forum.obsidian.md/t/save-node-positions-in-graph-view/1423). Read this as a warning, not just corroboration: **build position persistence as a first-class part of the ontology graph's data model** (§3.6) — don't leave it as a client-side-only, easily-lost cache the way Obsidian effectively did, which is precisely why users had to build a workaround plugin.

### 3.5 Perceptual continuity on top of positional continuity: `animateNodes`

Even with a good seed, some nodes will legitimately move (a file's community membership changed, a new caller was added nearby). sigma.js ships `animateNodes(graph, targetPositions, { duration })` specifically to interpolate from current to newly-computed positions over a set duration rather than snapping instantly (referenced in sigma.js issues #1215 and #275, "animateNodes improvements" and "node animation"). Composed with §3.2's seed+pin mechanism, the two together mean: nodes that didn't change don't move at all (pinned), and nodes that did change *glide* to their new position rather than teleport — the same two-layer discipline ("stable base, animated overlay") that Software Cartography's own definition names explicitly as its organizing principle: "thematic overlays on top of a **stable, spatial base layout**" (https://scg.unibe.ch/research/softwarecartography) — independent confirmation, from an entirely different research tradition (cartography-inspired software visualization, §4.1), that stability of the base layout is treated as a first-order design requirement, not a cosmetic nice-to-have.

### 3.6 Recommended mechanism for AWB

1. Add `last_x REAL`, `last_y REAL` to every node row (or a side table keyed by `symbol_id`, per `research-ontology.md` §8.5's identity design — `symbol_id` is stable across rebuilds by construction, which is exactly the join key position-persistence needs).
2. On each incremental rebuild (`research-ontology.md` §8.6's freshness algorithm): unchanged nodes get `x = last_x, y = last_y, fixed = true`; new nodes get a heuristic seed (parent `Directory`/`Module`'s last known centroid, or nearest resolved-edge neighbor's position) and `fixed = false`; removed nodes' positions are simply not reused.
3. Run ForceAtlas2 for a small, bounded iteration count (only the unfixed nodes actually move; convergence should be fast since most of the graph is pinned) — this is also a natural place to reuse the "don't let a query run unbounded" discipline `research-storage.md` already established for the backend, applied here to a layout iteration cap instead of a recursion depth cap.
4. Feed the result through `animateNodes` before committing it as the new `last_x/last_y` baseline.
5. For the cosmos.gl raw mode, accept the weaker guarantee from §3.3: seed everything, run with simulation enabled, and treat the resulting layout as more of a "close enough, re-converges near where you left it" than a hard guarantee — document this asymmetry to the user (e.g. a subtle "raw mode — layout may shift" indicator) rather than promising stability the engine can't deliver.

---

## 4. Semantic zoom / software cartography

### 4.1 The academic anchor: Software Cartography and CodeCity

The term the ticket asks about — "software cartography" — has a specific, citable origin: the **Software Composition Group** at the University of Bern (the same group behind CodeCity, §4.3) frames it explicitly as applying *thematic cartography* to software: "showing thematic overlays on top of a stable, spatial base layout," with the base layout itself typically a **city or map metaphor**, and thematic overlays being things like defect density (icons), call graphs (flow maps), or test coverage (choropleth/heat maps) (https://scg.unibe.ch/research/softwarecartography). This is a genuinely useful frame for AWB beyond just naming a research area: it separates two concerns AWB's own layer model (`research-ontology.md` §8.2: `structural`/`derived`/`semantic`/`curated`) already separates independently — a **stable base layout** (structural containment: `Directory`→`File`→`Type`) and **overlays that can change without moving anything** (derived metrics, semantic concept links, curated annotations) — i.e. the cartography literature's core design principle and AWB's layer model are the same idea arrived at from different directions, which is a good sign the layer model is the right one to render against.

**CodeCity** (Wettel & Lanza) is the field's most-cited instantiation: classes are buildings, packages are districts, building height/footprint/color encode metrics — and, unusually for this literature, it has an actual **controlled experiment**: subjects using CodeCity completed 10 maintenance tasks with **+24% correctness** and **-12% completion time** versus a control group using Eclipse + Excel (https://wettel.github.io/codecity.html, https://wettel.github.io/download/Wettel08b-wasdett.pdf). That is the strongest evidence in this whole document that a spatial code metaphor measurably helps, not just looks nice.

### 4.2 CodeCharta — the actively maintained, open implementation

**CodeCharta** (MaibornWolff, still active) is the direct engineering descendant of the CodeCity idea: "each file becomes a 'building' and each folder becomes a 'district'... files with metrics become buildings where the area, height and color represent different metrics, you can freely choose" — with a **Web Studio** for interactive 3D exploration (https://github.com/maibornwolff/codecharta). Its value to AWB is less "copy the 3D city" and more "copy the metric-to-visual-encoding pattern": area/height/color as three independently assignable channels for three different node properties (e.g., LOC, complexity, confidence) is a directly reusable idea for a 2D node-link renderer too — sigma.js's `nodeReducer` can map the same three channels onto node size/color/opacity.

### 4.3 ExplorViz — camera-distance semantic zoom, with a name and a paper

The most directly relevant prior art is a **2025 paper aimed at exactly this problem**: "Semantic Zoom and Mini-Maps for Software Cities" (Hansen, Bamberg, Baumann, Hasselbring; IEEE VISSOFT 2025 / SE 2026, https://arxiv.org/abs/2510.00003, https://ieeexplore.ieee.org/iel8/11175647/11175648/11175649.pdf). It defines semantic zoom precisely as the pattern AWB needs: "the graphical representation of the software landscape changes based on the virtual camera's distance from visual objects" — i.e. **zoom level, not a manual toggle, drives what level of the type hierarchy renders.** It pairs this with a **mini-map**: a 2D top-down projection giving spatial orientation while the camera is zoomed into a small part of a large landscape (directly analogous to a "you are here" indicator over a collapsed community graph). Both were implemented in the open-source, web-based **ExplorViz** tool and evaluated in **two separate user studies**, with results indicating both techniques were "especially useful for large software landscapes and collaborative software exploration," alongside a candid finding of "implementation shortcomings requiring future refinement" — i.e. this is validated-but-not-solved territory, consistent with everything else in this research area.

### 4.4 Gource — a tempting analog that does not actually transfer

Gource is worth naming because it will come up in any search for "code visualization," but it solves a **different problem**: it is a **git-history replay** tool, not a live structural browser. Its layout is a force-directed tree with the repository root at the center, directories as branches, and files as leaves, animated over commit time, requiring OpenGL/GPU acceleration to run (https://gource.io/). Its "semantic zoom" is really just tree depth, not a code-ontology type hierarchy, and it has no notion of cross-file reference edges at all (which is the entire point of AWB's graph). **Verdict: do not build on Gource** — but its tree-as-branches, files-as-leaves visual grammar is worth stealing for the *structural containment layer specifically* (Directory→File edges), since it is a proven, legible way to show a filesystem tree organically rather than as a rigid indented list.

### 4.5 Correcting a likely false lead: GitHub's "dependency graph" is not a zoomable graph UI

It is worth stating this precisely because the assumption is common and wrong: GitHub's actual **Dependency graph** feature (`docs.github.com`) is a **flat, tabular list** of dependencies — package name, version, license, vulnerability status, and (for supported ecosystems) a click-through "Show paths" for the transitive chain — not a pannable/zoomable node-link visualization at all (https://docs.github.com/en/free-pro-team@latest/github/visualizing-repository-data-with-graphs/about-the-dependency-graph). The separate "network graph" feature is a **branch/commit timeline**, also not a structural code graph. Neither is a source of semantic-zoom UI patterns; if the ticket's mention of "GitHub dependency graph" meant "the general idea of a package-level dependency view," the actually-applicable prior art is `npmgraph.js.org` (renders an npm dependency tree with a zoom mode) or `dependency-cruiser` (generates interactive HTML dependency graphs with hover-driven incoming/outgoing edge highlighting) — both worth a look for the "zoomed out to package/module level" rendering specifically, though neither implements camera-distance semantic zoom the way ExplorViz does.

### 4.6 CodeSee Maps (now GitKraken) — the closest commercial analog, and a maturity warning

CodeSee Maps is the closest **product**, not research prototype, to "zoom in for detail, zoom out for overview" over a real, multi-language code graph, supporting JavaScript/TypeScript, Python, Java, Rust, .NET/C#, Kotlin and more, with "auto-generated, self-updating code diagrams that sync your codebase as code evolves" (https://www.codesee.io/codebase-maps). It is also a cautionary tale worth stating plainly: CodeSee shut down as an independent company on **February 22, 2024**, and was acquired by **GitKraken on May 14, 2024**, continuing to operate inside GitKraken's developer-experience platform (LinkedIn post by CodeSee's CEO, Shanea Leven, announcing the closure; general GitKraken acquisition coverage). Treat it as validated product-market direction, not a dependency to integrate with or a company whose longevity to bet on.

### 4.7 FalkorDB Code-Graph — a recent, open, drill-down example

FalkorDB's **Code-Graph** is a current (2025-era) open tool in the same design space as AWB's feature: it indexes a repository's files/functions/classes into a graph database and provides "an interactive web UI and CLI for exploring code structure," with a documented drill-down workflow — isolating one file's node and tracing exactly which classes/functions connect to it (https://www.falkordb.com/blog/code-graph-analysis-visualize-source-code/). It currently supports Python, Java, and C# only, and its own materials do not document a specific semantic-zoom or clustering mechanism — useful as evidence the "drill down from a graph to one file" interaction is a validated, expected feature in this product category, but not a source of implementation technique beyond that.

### 4.8 Recommended mechanism for AWB

Implement semantic zoom as a **`camera.ratio` threshold table driving `nodeReducer`**, directly reusing sigma.js's existing zoom-to-size primitive (§2.1) rather than inventing a separate LOD system, and mapping each tier onto the node-type hierarchy `research-ontology.md` §8.3 already defines:

| Camera zoomed... | Render tier | AWB node types shown |
|---|---|---|
| all the way out | `Community`/`Module` only (derived layer) | `Community`, `CommunityReport` |
| mid | package/file level | `Directory`, `File`, `Module` |
| zoomed in | declaration level | `Type`, `Callable`, `Field`, `Endpoint`, `DataEntity` |

This is a direct implementation of ExplorViz's camera-distance principle (§4.3) using sigma's own reducer API, and it composes with the aggregation architecture for free: the `Community`-tier render *is* the aggregated graph `research-extraction.md` already mandates as the default, and zooming in is the "drill down" that architecture calls for — semantic zoom is not a separate feature from the aggregation architecture, it is the aggregation architecture's UI expression.

---

## 5. Community clustering: Louvain vs. Leiden for a code graph

### 5.1 The theoretical case against Louvain

The Leiden algorithm exists specifically because Louvain has a **structural defect**, not just a speed deficit: Traag, Waltman, and van Eck's 2019 paper "From Louvain to Leiden: guaranteeing well-connected communities" (Scientific Reports 9:5233, https://www.nature.com/articles/s41598-019-41695-z, preprint https://arxiv.org/abs/1810.08473) shows Louvain can and does produce communities that are **internally disconnected** — i.e. Louvain will sometimes group two things into "one community" that have **no path between them at all** in the underlying graph. Leiden's three-phase design (local moving → **refinement**, which explicitly re-splits communities to guarantee internal connectivity → aggregation) closes this gap while also running faster and finding higher-modularity (better-quality) partitions than Louvain on the same benchmark networks.

This is not an academic nicety for AWB specifically: a `Community` node in the aggregated graph (§4.8's outermost zoom tier) is rendered as **one visual blob** the user reads as "these files belong together." If the clustering algorithm can silently produce a disconnected community, the graph is **lying about relatedness** at exactly the tier most users will look at first (fully zoomed out) — this is the same class of trust failure `research-ontology.md` §6 spent an entire section preventing for LLM-derived edges, just arriving via a different, purely-algorithmic path. **A confidence/provenance-honest graph (research-ontology.md's entire design premise) cannot use an algorithm with a known, unguarded connectivity hole for its primary aggregation tier.**

### 5.2 Real numbers at scale

NVIDIA's engineering write-up on GPU-accelerated Leiden (`cuGraph`, https://developer.nvidia.com/blog/how-to-accelerate-community-detection-in-python-using-gpu-powered-leiden/) is the strongest scale evidence available, and it is recent (their own dating places it in the 2025/2026 window) and directly quantified:

- A **3.8-million-node, 16.5-million-edge citation graph**: `cuGraph` GPU Leiden runs in **3.05–4.14 seconds**; CPU `igraph` takes **~27–145 seconds** (8.8× slower); CPU `graspologic` (the reference Python implementation) takes **~145 seconds** (47.5× slower).
- A **14.7k-node, 83.8-million-edge genomics graph**: GPU Leiden finishes in **under 4 seconds**, versus **~21 minutes** for CPU-based NetworkX Louvain — a **315× speedup**.
- The article states the qualitative point directly: "Leiden guarantees all resulting communities are well-connected," while Louvain's communities "are not guaranteed to be well-connected."

Even without GPU acceleration, Neo4j's own Graph Data Science documentation states Leiden's complexity as **O(m log n)** (edges × log of nodes) and frames it as suitable for large-scale networks; a real citation-graph test in their docs shows both Louvain and Leiden completing in about a minute at the scales they tested (https://neo4j.com/docs/graph-data-science/current/algorithms/leiden/). At AWB's 10 MLOC target (~280k nodes / a much smaller *aggregated* edge count than the raw 2.4M once call-pair collapsing per `research-extraction.md` §5.3 has already run), this is comfortably inside CPU-Leiden's demonstrated range — GPU acceleration is a scale-up option to keep in reserve, not a day-one requirement.

### 5.3 What the closest analog system actually shipped — and why AWB should not copy it here

`research-ontology.md` §4.4 already identifies Codebase-Memory as the closest existing analog to AWB's whole design. Worth stating plainly: **it uses plain Louvain, not Leiden** — "The system applies Louvain modularity optimization to partition the call graph into functional communities," with a hand-rolled two-phase implementation (local moving, then a refinement pass that splits any community whose internal density falls under 1%, converging in "typically 3–5 iterations"), operating over `CALLS`/`HTTP_CALLS`/`ASYNC_CALLS` edges and producing `Community` nodes plus `MEMBER_OF` edges (https://arxiv.org/html/2603.27277v1). Its own density-based refinement step is, in effect, a hand-rolled, partial workaround for exactly the disconnection problem Leiden solves natively — evidence the problem is real enough that even a Louvain-based system needed *some* mitigation, just not the complete, proven one. Given that (a) AWB already cares more about provenance/trust honesty than this class of system typically does (`research-ontology.md`'s entire confidence/layer apparatus), and (b) real, small, same-language packages exist today (§5.4), there is no reason to replicate Codebase-Memory's workaround instead of using the algorithm that doesn't need one.

### 5.4 JS-native Leiden implementations available today

Two packages make this a same-ecosystem swap, not a new dependency class:

- **`graphology-communities-leiden`** — lives in the **upstream graphology monorepo itself**, credited to Guillaume Plique, graphology's own author — i.e. the same project that already provides AWB's graph data structure, ForceAtlas2 layout, and sigma.js's data layer also ships Leiden as a first-class citizen. API mirrors the Louvain package: `leiden(graph)` returns a partition, `leiden.assign(graph, options)` writes community IDs onto node attributes directly, `leiden.detailed(graph, options)` returns modularity/dendrogram detail; options include `resolution`, `randomWalk`, `rng` (seeding), `weighted`. A maintained fork (https://github.com/aflsolutions/graphology-communities-leiden) adds a `maxIterations` cap "to solve a specific performance problem on large graphs (>100k nodes)" while preserving default behavior otherwise — directly relevant at AWB's target scale, and consistent with the "never let a query/algorithm run unbounded" discipline `research-storage.md` already established for recursive CTEs.
- **`leiden-ts`** — a from-scratch, **zero-runtime-dependency**, pure-TypeScript implementation (16–24 KB) that runs identically in Node, the browser, Deno, Bun, or edge runtimes with no WASM or native module — implements all three Leiden phases including the refinement/connectivity-preserving step, with the connectivity guarantee **tested**, not just claimed (BFS-assertion over every fixture in its test suite), and a drop-in-compatible API with `graspologic` (`leiden(graph, { seed, resolution })`) for anyone porting from a Python prototype. It is early-stage (v0.1.0 at research time) — evaluate it, but `graphology-communities-leiden`'s deeper ecosystem integration (same graph object as rendering/layout) is the safer first choice given AWB is not on WASM-constrained sql.js for this computation (unlike the storage layer's sqlite-vec problem in `research-storage.md` §6.1 — this is pure JS logic over an in-memory graphology graph, no WASM-extension-loading wall applies here).

### 5.5 Domain-fit precedent beyond Codebase-Memory

Louvain-family clustering over call/dependency graphs is independently well-established in the **software architecture recovery / microservice extraction** literature — a genuinely adjacent problem to "which files belong together" — including constrained-Louvain variants specifically for monolith decomposition, and IBM's **Mono2Micro** as a real, practical tool in this space (https://arxiv.org/pdf/2107.09698). This corroborates that community detection over code dependency structure is a validated, not speculative, approach to the aggregation problem; it does not change the Louvain-vs-Leiden recommendation, since none of this literature specifically engages with the connectivity-guarantee question §5.1 raises — it simply confirms the *category* of algorithm (modularity-based graph clustering) is the right one for code.

### 5.6 Recommendation

Use **`graphology-communities-leiden`** as the default community-detection algorithm for the `derived`-layer `Community`/`MEMBER_OF` nodes and edges `research-ontology.md` §8.3 already defines, running over the aggregated `CALLS`/`IMPORTS`/`USES_TYPE` edge set (post call-pair-collapse, per `research-extraction.md` §5.3), with `maxIterations` capped per the hardened fork's pattern once AWB's own measured graphs approach the >100k-node range that package was built to guard against. Reserve GPU-accelerated Leiden (cuGraph-class) as a documented scale-up path, not a day-one dependency — CPU Leiden's demonstrated performance (§5.2) comfortably covers AWB's near-term target.

---

## 6. Focus+context: N-hop expansion around a symbol

### 6.1 The pattern, named and specified

"Focus+context" is the standard term for showing one area of interest in full detail while keeping the rest of the structure visible but reduced (https://infovis-wiki.net/wiki/Focus-plus-Context, https://www.uxtweak.com/ux-glossary/focus-context/). For AWB the concrete instantiation is: click a symbol → expand its N-hop neighborhood into full detail (nodes rendered, edges labeled) while everything outside that neighborhood collapses to its containing `Community` (§4.8's outermost tier) rather than disappearing — focus+context and semantic zoom compose directly, they are not competing patterns.

### 6.2 Production precedent: Neo4j Bloom's Expand

Neo4j Bloom — a mature, widely deployed graph-exploration product — implements exactly this interaction as **Expand**: right-click a node (or use the Inspector) to pull in its neighbors, with an **Advanced Expansion** dialog that lets the user be selective — expand along one specific relationship type and direction only, or a chosen combination of relationship types and neighboring node types, specifically so results stay "manageable and intelligible" on nodes with many relationships (https://neo4j.com/docs/bloom-user-guide/current/bloom-visual-tour/bloom-scene-interactions/). This maps precisely onto AWB's edge-type taxonomy (`research-ontology.md` §8.4: `CALLS`, `IMPORTS`, `EXTENDS`, `REFERENCES`, …) — "expand only `CALLS` edges" or "expand only `IMPLEMENTS` edges" is a directly reusable filter, not a new concept to design.

### 6.3 Guidance on initial render size

The yFiles knowledge-graph guide is unusually concrete on the numeric side of this: start with **50–100 nodes** for testing, and in practice open on a **focused view of 20–50 relevant nodes**, then let interaction (expand-on-demand, backed by live SPARQL/Cypher/Gremlin-equivalent queries) grow the view — explicitly to avoid the "hairball" failure mode of rendering everything at once (https://www.yfiles.com/resources/how-to/guide-to-visualizing-knowledge-graphs). This is a strong, independent confirmation of `research-storage.md` §2.4's backend-side mandate (bounded, leveled, application-orchestrated BFS, default `max_depth` 3–6 hops) — the UI-side default node budget and the backend-side query bound should be the same design decision seen from two ends, not two separately-tuned numbers.

### 6.4 Research-side reinforcement

Two research systems independently validate the same shape at the ontology-graph-specific level (rather than generic knowledge graphs): **Context-KG** filters what to show around a focal node using a combination of **ontology structure and user preference** rather than raw graph distance alone (https://arxiv.org/abs/2604.10384) — directly relevant given AWB's own type/layer taxonomy is exactly the kind of ontology structure such filtering would key off (e.g., "when expanding, prefer `structural` edges over `semantic` ones unless the user asks"). **OnionGraph** (Shi et al., IEEE Pacific Visualization Symposium 2014) proposes a **hierarchical** focus+context specifically for **heterogeneous** networks — i.e. graphs with multiple node/edge types, which is precisely AWB's shape (structural + derived + semantic + curated layers, a dozen-plus node types) rather than the single-type networks most focus+context literature assumes (http://yifanhu.net/PUB/OnionGraph_PacificVis14.pdf).

### 6.5 A React-native fallback worth evaluating: reagraph

If building the Expand interaction directly on sigma.js's lower-level primitives (graph mutation + re-run layout on the expanded subgraph + `nodeReducer` to dim context nodes) proves slower to build than expected, **reagraph** (Three.js / React Three Fiber, https://reagraph.dev/docs) ships **"Expand/Collapse Nodes" as a named, built-in feature**, alongside its own clustering support — worth a spike specifically to see whether its higher-level API shortens the path to a working focus+context interaction, at the cost of moving off the graphology/sigma ecosystem this document otherwise recommends (§2, §5). This is flagged as a fallback, not a primary recommendation, precisely because splitting the rendering stack (Three.js here, WebGL-2D there) reintroduces the "two engines" complexity §2.5 already accepts once (sigma.js/cosmos.gl) — a third rendering paradigm should only enter if the first two demonstrably can't build this interaction well.

### 6.6 Recommended mechanism for AWB

Implement "click a node → Expand" as a thin UI layer over the **exact same bounded-BFS query** `research-storage.md` §2.4 already mandates AWB's `graph_neighbors`/`graph_blast_radius` MCP tools use (application-orchestrated, leveled, depth-capped 3–6 hops by default) — the agent-facing tool and the human-facing UI interaction should be **the same backend call**, not two independently-tuned implementations of "get N-hop neighbors." On expand: merge the returned nodes/edges into the current sigma.js graph at full detail; everything else stays at (or collapses to) its `Community`-tier rendering from §4.8; offer a Neo4j-Bloom-style edge-type filter (checkbox per `research-ontology.md` §8.4 edge type) on the expansion so a user can, e.g., "expand only `CALLS`" on a symbol with too many `REFERENCES` to usefully render at once. Default the very first render of any graph to the yFiles-recommended **20–50 node** budget — i.e. open on the `Community` tier's top-N-by-size or top-N-by-centrality nodes, never on an unfiltered dump.

---

## 7. Recommended stack for AWB (concrete)

| Layer | Package | Role |
|---|---|---|
| Graph data structure | `graphology` | Shared graph object across rendering, layout, and clustering |
| Default renderer | `sigma.js` + `@react-sigma/core` (v5.0.6) | Aggregated/community view; semantic zoom via `nodeReducer`/`camera.ratio`; focus+context expansion target |
| Layout (default renderer) | `graphology-layout-forceatlas2` | Seeded via stored `(x,y)` per `symbol_id`; `fixed=true` on unchanged nodes |
| Transition | sigma.js `animateNodes` | Perceptual continuity for nodes that do move |
| Opt-in raw/expanded renderer | `cosmos.gl` via `@cosmograph/react` (v2.5.0) | GPU-simulated, past sigma.js's ~5k-node ceiling; seed via `disableSimulation`-time initial positions, accept weaker per-node pinning |
| Community detection | `graphology-communities-leiden` (upstream graphology; `maxIterations`-capped fork past ~100k nodes) | Populates `Community`/`MEMBER_OF` derived-layer nodes/edges; connectivity-guaranteed, unlike Louvain |
| Focus+context backend | Same bounded-BFS implementation as `graph_neighbors`/`graph_blast_radius` MCP tools (`research-storage.md` §2.4) | One implementation serves both the agent-facing tool and the human "Expand" interaction |
| Fallback renderer (evaluate only if needed) | `reagraph` | Built-in Expand/Collapse + clustering, at the cost of a third rendering paradigm (Three.js) |

This stack is a direct, additive continuation of the architecture `research-extraction.md` and `research-ontology.md` already fixed: it does not introduce a new storage model, a new node/edge taxonomy, or a new query shape — it wires the existing aggregation-graph-plus-drill-down architecture, the existing `symbol_id` identity scheme, and the existing bounded-BFS query mandate into a concrete, evidence-backed set of rendering, layout, clustering, and interaction libraries a React 18 + Vite frontend can ship.

---

## 8. Top traps

**1. "GPU-accelerated" is not a synonym for "stable."** cosmos.gl's raw scale advantage (§2) and its weaker layout-stability primitive (§3.3) are two independent axes — do not assume the engine that wins on node-count also wins on "doesn't jump around on rebuild." Design position persistence (§3.6) as backend/data-model work that both renderers consume, not as a renderer feature you get for free by picking the fancier engine.

**2. Sigma.js's ceiling is a layout problem wearing a rendering costume.** Issue #567's finding — that disabling edge *rendering* didn't help a struggling graph — means the naive fix ("just hide more stuff visually") does not work once you're past sigma's real ceiling; the fix is architectural (switch which engine does the *layout*, not just the drawing), which is exactly why §2.5 recommends switching the whole engine for raw mode rather than trying to tune sigma.js further.

**3. A disconnected "community" is a silent trust bug, not a cosmetic clustering quirk.** Louvain's own validated failure mode (up to 16% of communities disconnected, per the Leiden paper) means an aggregated `Community` node can visually claim two unrelated files "belong together" with zero graph-theoretic justification — exactly the class of unearned confidence `research-ontology.md` §6 built an entire confidence/provenance system to prevent for LLM edges. Don't let the purely-algorithmic clustering step reintroduce the same failure mode through a side door; use Leiden.

**4. Semantic zoom and focus+context are the same feature seen from two directions — build one mechanism, not two.** §4.8's camera-driven tier table and §6.6's Expand-collapses-to-community behavior must share state: expanding a node's neighborhood at a zoomed-out camera position should either force a zoom-in or render the expanded detail nodes as an explicit exception to the current tier — if these are built as two independent systems they will fight each other (e.g. a freshly-expanded `Callable` node immediately vanishing because the camera is still at `Community` zoom level).

**5. Don't assume popular tools do what their name suggests — verify before you architect around them.** Two purely-name-driven wrong turns were caught in this research and are worth internalizing as a general caution: "GitHub's dependency graph" is not a zoomable graph UI at all (§4.5), and "Gource" is a git-history animator, not a structural code browser (§4.4). Both would have been natural first guesses for prior art; both were wrong on inspection of the primary source. Verify every "X already does this" claim against the tool's actual docs before designing around it — the same discipline this document's own house style (and this repo's own `feedback_doc-example-must-satisfy-own-literal-rule.md` lesson) already demands.

---

## Sources

- https://github.com/jacomyal/sigma.js
- https://github.com/jacomyal/sigma.js/issues/239
- https://github.com/jacomyal/sigma.js/issues/567
- https://github.com/jacomyal/sigma.js/issues/1215
- https://github.com/jacomyal/sigma.js/issues/275
- https://www.sigmajs.org/
- https://www.sigmajs.org/docs/advanced/sizes/
- https://v4.sigmajs.org/
- https://www.npmjs.com/package/@react-sigma/core
- https://graphology.github.io/standard-library/
- https://github.com/graphology/graphology/blob/master/src/layout-forceatlas2/README.md
- https://github.com/graphology/graphology/discussions/375
- https://graphology.github.io/standard-library/layout-force.html
- https://github.com/safishamsi/graphify/issues/447
- https://github.com/cosmosgl/graph
- https://github.com/cosmosgl/graph/wiki
- https://openjsf.org/blog/introducing-cosmos-gl
- https://openjsf.org/blog/cosmos-gl-v3
- https://nightingaledvs.com/how-to-visualize-a-graph-with-a-million-nodes/
- https://www.npmjs.com/package/@cosmograph/react
- https://d3js.org/d3-force/simulation
- https://stamen.com/forcing-functions-inside-d3-v4-forces-and-layout-transitions-f3e89ee02d12/
- https://github.com/Sanqui/obsidian-persistent-graph
- https://forum.obsidian.md/t/save-node-positions-in-graph-view/1423
- https://journals.plos.org/plosone/article?id=10.1371%2Fjournal.pone.0098679
- https://scg.unibe.ch/research/softwarecartography
- https://wettel.github.io/codecity.html
- https://wettel.github.io/download/Wettel08b-wasdett.pdf
- https://github.com/maibornwolff/codecharta
- https://arxiv.org/abs/2510.00003
- https://ieeexplore.ieee.org/iel8/11175647/11175648/11175649.pdf
- https://gource.io/
- https://docs.github.com/en/free-pro-team@latest/github/visualizing-repository-data-with-graphs/about-the-dependency-graph
- https://www.codesee.io/codebase-maps
- https://www.falkordb.com/blog/code-graph-analysis-visualize-source-code/
- https://www.nature.com/articles/s41598-019-41695-z
- https://arxiv.org/abs/1810.08473
- https://developer.nvidia.com/blog/how-to-accelerate-community-detection-in-python-using-gpu-powered-leiden/
- https://neo4j.com/docs/graph-data-science/current/algorithms/leiden/
- https://arxiv.org/html/2603.27277v1
- https://github.com/aflsolutions/graphology-communities-leiden
- https://libraries.io/npm/leiden-ts
- https://arxiv.org/pdf/2107.09698
- https://neo4j.com/docs/bloom-user-guide/current/bloom-visual-tour/bloom-scene-interactions/
- https://www.yfiles.com/resources/how-to/guide-to-visualizing-knowledge-graphs
- https://arxiv.org/abs/2604.10384
- http://yifanhu.net/PUB/OnionGraph_PacificVis14.pdf
- https://reagraph.dev/docs
- https://infovis-wiki.net/wiki/Focus-plus-Context
- https://www.uxtweak.com/ux-glossary/focus-context/
- `research-extraction.md` (this repo, `docs/ontology-graph/`)
- `research-ontology.md` (this repo, `docs/ontology-graph/`)
- `research-storage.md` (this repo, `docs/ontology-graph/`)
