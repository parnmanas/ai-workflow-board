# Server scout: integration points for a workspace Ontology Graph feature

Codebase scout against the actual `apps/server/` source at the current worktree
commit (branch `ticket/d4510d7c-ontology-graph-research-design`). Every claim
below is grounded in a real file:line — no invented paths. Where a prior
finding needed direct verification (the `synchronize:true` / no-migration
claim), the current source is quoted, not assumed.

---

## 1. Resources module — how a "repository resource" is identified/stored today

**Entity**: `apps/server/src/entities/Resource.ts:8-65`. A single flat table
(`resources`) with a `type` discriminator column (`apps/server/src/entities/Resource.ts:32-33`,
default `'link'`) — `'repository'` is just one of five string values used
elsewhere (`link | document | image | comment_attachment | repository`, see
`resource-tools.ts:72`). There is **no separate `Repository` entity** — a
repo is a `Resource` row with:

- `url` (`Resource.ts:36`) — the clone URL
- `credential_id` (`Resource.ts:23-24`) — nullable FK-by-convention (plain
  `varchar`, no TypeORM `@ManyToOne`) into `Credential`
- `default_branch` (`Resource.ts:38-43`) — branch tickets default to when no
  per-ticket override is set
- `workspace_id` / `board_id` (`Resource.ts:14-21`) — Global (`workspace_id
  NULL`) vs Workspace catalog scope; `board_id` is legacy-only and always
  `NULL` going forward (comment at `Resource.ts:17-19`, enforced by
  `common/catalog-scope.ts`)

**Controller**: `apps/server/src/modules/resources/resources.controller.ts`.
CRUD lives at `@Controller('api/resources')` (`resources.controller.ts:30`),
gated by `PermissionGuard` + `RequirePermission(PERMISSIONS.MANAGE_RESOURCES)`
(`resources.controller.ts:31-32`). Beyond CRUD it already exposes **git-read**
endpoints scoped to a specific Resource id:
- `GET :id/refs` (`resources.controller.ts:353-368`)
- `GET :id/commits` / `:id/commits/:sha` (`resources.controller.ts:373-415`)
- `GET :id/tree?ref=&path=` (`resources.controller.ts:418-434`) — **already
  folder-scoped**, see §3
- `GET :id/file?ref=&path=` (`resources.controller.ts:438-455`)
- `GET :id/branches` / `POST branches/test` (`resources.controller.ts:234-295`,
  `git ls-remote`-based, separate from the tree/file/commit reads)

**Module**: `apps/server/src/modules/resources/resources.module.ts:10-14` —
`TypeOrmModule.forFeature([Resource, Credential])`, controllers
`[ResourcesController, ResourceMediaController]`.

**How another entity already references "a repository resource + branch"** —
the exact shape the Ontology Graph will want for "resource + folder path":
`Ticket.base_repo_resource_id` (`apps/server/src/entities/Ticket.ts:119-120`,
comment at `115-118`) + `Ticket.base_branch` (`Ticket.ts:122-126`) — both
plain `varchar` columns, no DB-level FK constraint, resolved by application
code (e.g. `resources.controller.ts`'s `_prepRepo`, `git-branches.ts`'s
`resolveGitCredential`). A new Ontology entity scoping to "this repo resource,
this folder" should follow the same convention: `resource_id: string` +
`folder_path: string` plain columns, validated/resolved in code, not a DB FK.

**False friend to avoid**: `Board.working_dir` (comment context at
`apps/server/src/entities/Board.ts:154,257-259`) is the **host filesystem**
worktree root the CLI harness `git worktree add`s into — completely
unrelated to "a folder path inside a Resource's git tree." Don't conflate the
two when scoping the Ontology feature's "folder path" input.

---

## 2. Entity + migration conventions — `synchronize:true` verified directly

**Verified, not assumed**: `apps/server/src/db.ts:395-474`
(`buildDataSourceOptions()`) hardcodes `synchronize: true` in **all three**
backend branches — mysql (`db.ts:410`), postgres (`db.ts:448`), and the
default sqljs/dev branch (`db.ts:470`) — with an explicit invariant comment at
the top of the file:

> `db.ts:9-14`: "D-01: synchronize is HARDCODED on in every branch
> (sqlite/mysql/postgres). It is NOT keyed off NODE_ENV... D-02: Migrations
> handle DATA only, not schema. The migrationsRun flag is hardcoded off..."

`migrationsRun: false` is likewise hardcoded in all three branches
(`db.ts:411,449,471`) and invoked manually elsewhere, not at TypeORM
`initialize()` time. **Confirmed: a brand-new entity/table needs zero
hand-written migration** — TypeORM's `synchronize` DDLs it into existence from
the entity class alone, on every boot, on every backend (sql.js dev included).

This is not just a `db.ts` docstring — the barrel file repeats the same
invariant inline, next to the most recently added tables, as a standing
convention: `apps/server/src/entities/index.ts:40-41` (`CiRedAlert`),
`:43-47` (`DispatchIntent`), `:49-51` (`ReviewDriftState`), `:85-88`
(`OutreachChannel`/`OutreachInboundItem`), `:97-100` (`OrchestrationTeam` and
siblings) — every one says some variant of "Auto-DDL'd by TypeORM
`synchronize` (D-01); no hand-written migration needed."

The 82 files under `apps/server/src/database/migrations/` (confirmed via
`ls | wc -l`) are exclusively **data** migrations — seeding/backfilling/
refreshing row content (e.g.
`1760000000073-RefreshDefaultPromptTemplatesReviewDrift.ts`, which
byte-exact-matches prior prompt template content before overwriting it —
see its docstring at lines 1-40). None of them `CREATE TABLE`.

**Concrete pattern a new `OntologyNode`/`OntologyEdge` entity would follow**
(mirroring `apps/server/src/entities/RelationTuple.ts:1-32`, which is
already a generic `subject_type/subject_id/relation/object_type/object_id`
tuple table with three composite `@Index()`s — the closest existing analog to
a graph-edge table, though it's ReBAC-permissions-only today, not reused for
ontology):

1. New file `apps/server/src/entities/OntologyNode.ts` (and `OntologyEdge.ts`)
   — `@Entity('ontology_nodes')`, `@PrimaryGeneratedColumn('uuid')`,
   plain `@Column()`s (`workspace_id`, `resource_id`, `folder_path` per §1),
   composite `@Index()` for the lookup patterns the query API needs (mirror
   `RelationTuple.ts:6-8`'s multi-index style, or `Resource.ts:8-9`'s single
   named index).
2. Barrel export in `apps/server/src/entities/index.ts` (append after
   `OrchestrationEvent` at line 105), with the same "Auto-DDL'd, no migration
   needed" comment convention.
3. That's sufficient for the table to exist — `entities` in `db.ts:28`
   (`Object.values(entitiesBarrel)`) feeds directly into
   `buildDataSourceOptions()`'s `entities` field on every branch
   (`db.ts:408,446,468`), so nothing else is required for `synchronize` to
   pick it up.
4. Repository access does **not** require NestJS module wiring —
   `dataSource.getRepository(Entity)` works anywhere the shared `DataSource`
   is reachable, which is exactly how MCP tools already touch `Resource`
   (`resource-tools.ts:32`) and how services touch `DispatchIntent`
   (`apps/server/src/modules/agents/dispatch-intent.service.ts:174`, via
   `manager.getRepository(DispatchIntent)`) without any `TypeOrmModule.forFeature`
   for that entity anywhere. Only add `TypeOrmModule.forFeature([...])`
   (pattern: `resources.module.ts:11`) if a REST controller wants
   `@InjectRepository()`.

---

## 3. github-connector — clone/fetch reality check (two distinct systems)

There are **two unrelated "GitHub" code paths** in `apps/server/src/` — the
task's phrasing ("github-connector... clones/fetches repository content")
maps mostly onto the second one, not the file literally named
`github-connector.service.ts`:

### 3a. `apps/server/src/services/github-connector.service.ts` — GitHub REST API client, NOT a git clone

`GitHubConnectorService` (`github-connector.service.ts:418-698`) never runs
`git clone`. It's a typed wrapper over `https://api.github.com`
(`GITHUB_API` const at `github-connector.service.ts:6`) used by three MCP
tools (`fetch_github_info`, `sync_github_resource`, `search_github` — see
`github-tools.ts:1-5`) plus `CiHealthMonitorService`. `fetchRepoInfo()`
(`github-connector.service.ts:581-642`) pulls repo metadata + README (one
`GET .../readme` call, capped 10KB, `:604-605`) + a **recursive, flat file
path list** via the git-trees API (`:611-621`, capped to 500 paths, no file
content) — this is a full-repo snapshot, not folder-scoped, and carries no
file bodies beyond the README.

**Auth**: `resolveToken()` (`:441-447`) resolves `credential_id` → decrypts a
`Credential` row (`getTokenForCredential`, `:428-439`, via `decrypt()` from
`./encryption.service`) → falls back to `process.env.GITHUB_TOKEN`
(`:424-426`). GitHub-specific only (`Authorization: Bearer <token>` REST
headers, `:250-255`).

Separately, `outreach/connectors/github.connector.ts` polls GitHub issues for
the *outreach* feature; per `github-connector.service.ts:238-244`'s own
docstring it deliberately resolves auth through a **different**,
workspace-scope-checked path (`outreach-credential.ts`) and "must never touch
the Credential table itself" — a second, intentionally-isolated auth path.
Not relevant to repo content extraction, but worth knowing it exists so it
isn't confused with the Resource `credential_id` path.

### 3b. `apps/server/src/modules/mcp/shared/git-repo-cache.ts` — the actual clone/fetch engine

This is the real "clone repository content" system, and it's what
`ResourcesController`'s git-read endpoints (§1) run on. Per its own header
(`git-repo-cache.ts:1-28`): maintains a **bare, blobless**
(`--filter=blob:none`) cache clone per Resource under
`AWB_GIT_CACHE_DIR` (default `os.tmpdir()/awb-git-cache`,
`git-repo-cache.ts:59`), keyed by `resourceId` (`repoPathFor`,
`:190-195`). Host-agnostic (works against GitHub/GitLab/self-hosted alike,
not a GitHub-specific client) — reuses the same HTTPS credential-injection
approach as the branch picker (`applyCredential`, `:89-103`, injects
`username:token@host` into the URL). SSH-only URLs are explicitly
unsupported (`SshUnsupportedError`, `:41-47`) — the server has no SSH key.

Lifecycle: `ensureRepoCache()` (`:222-269`) clones on first use, then
re-`fetch`es when stale (`FETCH_TTL_MS`, default 60s, `:65`) or on
`forceFetch`; a per-repo in-process lock (`withRepoLock`, `:177-188`)
serializes concurrent clone/fetch on the same cache dir. TTL + total-size
eviction sweep runs throttled (`evictStale`, `:285-315`).

**Folder-scoped access already exists** — this directly answers the task's
question. `listTree(repoPath, ref, treePath)` (`:551-570`) lists the
immediate children of an arbitrary `treePath` at an arbitrary `ref` (dirs
first, then files, alphabetical); `getFileContent(repoPath, ref, filePath)`
(`:606-645`) returns one file's content (512KB cap, binary-sniffed via NUL
byte, `:604,636`). Both are exposed today only via
`ResourcesController`'s `:id/tree` / `:id/file` REST endpoints (§1) — **there
is no MCP tool wrapping them yet** (`resource-tools.ts` only has
`list_resources/get_resource/save_resource/delete_resource/search_resources/
embed_resources/list_repo_branches` — no tree/file/commit tool). An
agent-driven extraction worker calling through MCP would need a new tool
wrapping `listTree`/`getFileContent`/`ensureRepoCache`; a server-side
extraction worker (a NestJS service/cron) can import these exported
functions directly, no new tool required.

Path safety is already handled: `normalizeRepoPath()` (`:363-370`) strips
leading/trailing slashes and rejects `..` segments; `isValidRef`/`isValidSha`
(`:350-360`) reject flag-injection-shaped ref/sha strings. A folder-path
input from an Ontology Graph UI can reuse `normalizeRepoPath` directly rather
than re-deriving path-traversal guards.

Also present and reusable for a future "is this graph node stale relative to
HEAD" check: `countBehindAhead()` (`:701-721`), `mergeBase()`
(`:732-746`), `diffChangedPaths()` (`:769-784`) — all already used by the
review-drift merge gate, all take validated refs against the same cache
clone.

---

## 4. fs-browser — exists, but it's the wrong primitive for repo-folder picking

AWB does have a folder-tree browsing API + reverse-RPC, and it **is
client-facing**, but it browses the **live filesystem of the machine an
agent-manager instance runs on** — not the content of a git repository. Don't
reuse it for "pick a folder inside this repo"; §3b's `git-repo-cache.ts`
`listTree` is the correct primitive for that. Confirmed:

- **Client-facing REST surface**: `apps/server/src/modules/agents/fs-browser.controller.ts`
  — `GET /api/agents/:id/fs/roots|drives|list|stat|read`, `POST .../mkdir`
  (`fs-browser.controller.ts:42-141`), gated by
  `PERMISSIONS.BROWSE_AGENT_FS` (`:43-44` etc.; permission label at
  `apps/server/src/common/types/permissions.ts:68`: "Browse files on an
  agent machine within scoped roots configured on the plugin side"). Wrapped
  client-side at `apps/client/src/api.ts:804-826` and consumed by
  `AgentsPage.tsx` / `AgentDetailModal.tsx` (grep hits) — used for things
  like configuring an agent's working-directory root, not for repo content.
- **Server-side bridge**: `apps/server/src/services/fs-browser.service.ts:121-197`
  (`FsBrowserService`) — a reverse-RPC bridge, not a direct filesystem
  reader. Per its header comment (`:9-25`): mints a `request_id`, emits an
  `fs_request` SSE event scoped to the target agent, and returns a Promise
  that resolves only when the plugin `POST`s back to
  `/api/fs/responses/:requestId` (handled by
  `fs-browser.controller.ts:145-173`, `AgentAuthGuard`-protected). 15s
  timeout (`REQUEST_TIMEOUT_MS`, `:115`).
- **Actual filesystem walk happens in agent-manager**, not in `apps/server/`:
  `apps/agent-manager/src/lib/fs-browser.ts` — scope enforcement via
  realpath-matching against configured roots (header comment,
  `fs-browser.ts:1-7`); always-on as of a prior ticket (`:38-45`, the old
  opt-in gate was removed).

So: this is a real, working, client-facing folder-tree browser — but of
**agent host machines**, gated by a different permission
(`BROWSE_AGENT_FS`) and a different transport (SSE reverse-RPC to
agent-manager) than what an Ontology Graph "pick a folder in this registered
repo" UI needs (which should hit `GET /api/resources/:id/tree` instead, §1/§3b).
If a future ticket needs to browse an agent's local checkout of a repo
specifically (as opposed to the server's git-repo-cache clone), this is the
mechanism — but that's a different use case from browsing a *registered
Resource's* repo content.

---

## 5. embedding.service.ts — existing pipeline, reusable with caveats

**File**: `apps/server/src/services/embedding.service.ts`. Two pure helpers
(`textHash` at `:17-19`, sha256-16hex; `cosineSimilarity` at `:42-55`) plus
`EmbeddingService` (`:68-130`), constructed either via NestJS DI
(`@InjectDataSource`) or directly (`new EmbeddingService(dataSource)`,
standalone MCP mode — same dual-construction pattern as
`GitHubConnectorService`).

**Provider**: OpenAI only, single model, config resolved per-call from
`SystemSetting` DB rows (`embedding.provider`/`embedding.api_key`/
`embedding.model`, `getDbSetting`/`getConfig` at `:74-95`) with env-var
fallback (`EMBEDDING_PROVIDER`/`OPENAI_API_KEY`/`EMBEDDING_MODEL`). API key
is DB-encrypted (`decrypt()` at `:90`). `generateEmbedding(text)`
(`:102-129`) truncates input to 8000 chars (`:107`) and calls
`POST https://api.openai.com/v1/embeddings` directly (no SDK, no retry
logic) — returns `null` on any failure rather than throwing (`:118-122,126`),
by design (callers `.catch(() => {})` it, e.g.
`resource-helpers.ts:107,131`).

**Storage**: `ResourceEmbedding` entity (`apps/server/src/entities/ResourceEmbedding.ts:3-25`)
— one row per `resource_id`, `embedding` stored as a JSON-stringified
`number[]` in a `text` column (**not** a vector column/pgvector — plain
TypeORM `text`), `text_hash` for change-dedup, `model`/`dimensions` recorded
per row (so a provider/model swap doesn't corrupt old rows silently).

**The reusable wiring pattern**: `embedResource()` in
`apps/server/src/modules/mcp/shared/resource-helpers.ts:97-136` — checks
`embeddingService.isEnabled()`, builds embed text via `buildResourceText()`
(`embedding.service.ts:21-40`, just concatenates name/description/type/url/
content/tags), hashes it, no-ops if unchanged (`resource-helpers.ts:114-115`),
else calls `generateEmbedding` and upserts. This is a ~40-line, fully
copy-paste-able pattern for an `embedOntologyNode()` sibling.

**Search today is brute-force, not indexed**: `search_resources`
(`resource-tools.ts:188-269`) loads **every** in-scope `Resource` row, then
every matching `ResourceEmbedding` row, then does an in-process
`cosineSimilarity` loop and `.sort()` (`resource-tools.ts:213-230`) — no
vector index (no pgvector, no sqlite-vss). Fine at Resource-table scale
(dozens–hundreds of rows per workspace); **a concern if the Ontology Graph's
semantic layer embeds one row per extracted symbol/entity** (could be
thousands per repo) — the same brute-force pattern would scale linearly per
query. A schema/query-API child ticket should decide up front whether
ontology-node embeddings reuse `ResourceEmbedding` (many-rows, generic) or
get their own table with the search cost explicitly re-evaluated, rather
than silently inheriting the O(n) scan.

**Direct reuse verdict**: yes, `EmbeddingService` itself (the OpenAI call +
config resolution) is provider-agnostic of *what* text you feed it — an
ontology node's embed text (name + kind + docstring + surrounding code
snippet) is just another string. What would need to change: (1) a new
embedding-storage entity or an extended `ResourceEmbedding` if ontology nodes
aren't `Resource` rows (they aren't — see §1/§2), and (2) the search path
needs a scale decision per the paragraph above before assuming
`search_resources`'s pattern verbatim.

---

## 6. MCP tool registration path — exact files and steps

Full checklist already exists as a project skill —
`.claude/skills/awb-mcp-tool-wiring/SKILL.md` — verified below against the
live source (no drift found; the skill's cited line numbers matched).

**(a) Register the tool** — new file
`apps/server/src/modules/mcp/tools/ontology-tools.ts` (or add to an existing
one), exporting `registerOntologyTools(server: McpServer, ctx: ToolContext)`.
Auto-discovered by filename convention alone — `discoverToolModules()` in
`apps/server/src/modules/mcp/tools/index.ts:42-65` globs `*-tools.{ts,js}`
(regex at `:46`) and resolves the `register[A-Z].*Tools` export
(`findRegisterFn`, `:67-75`); `registerAllTools()` (`:77-86`) needs **zero**
edits for a new domain file. `resource-tools.ts:20-298`
(`registerResourceTools`) is the closest existing template — same
`dataSource`/`logger`/`embeddingService` destructuring from `ctx`
(`resource-tools.ts:21`), same `ok()`/`err()` helper pattern
(`../shared/helpers`), same `z.object`-via-plain-object zod schema shape.

**(b)/(c) Authz tier** — every new tool name **must** be added to
`TOOL_AUTHZ_TABLE` in
`apps/server/src/modules/mcp/shared/tool-authz-gate.ts:103-142` as `'full'`
or `'caller'` (decision rule at `:57-77`, worked example at
`tool-authz-gate.ts:129-141` for the most recently added orchestration
tools). **Do not** add new tools to `KNOWN_EXISTING_TOOLS`
(`:186-257`) — its own docstring (`:166-185`) states it's a frozen snapshot
taken when the gate was written, not a home for new registrations.
`resolveAuthzTier()` (`:281-286`, confirmed current) denies any
unclassified name outright (`UNCLASSIFIED_TIER = 'deny'`, `:272`) —
independent of caller identity — so skipping this step ships a tool that
always returns `"Unauthorized: this tool is not classified..."`
(`:293-295`), for every caller, silently past a green build.

**(d) Ownership checks** live in the handler/service, not the gate — the
gate only expresses two static tiers (`checkAuthzTier`, `:288-301`); "is this
caller allowed to touch *this specific* ontology graph / workspace" must be
checked inside the tool handler itself (pattern:
`orchestration-tools.ts:539-546` — `create_orchestration_mission` rejecting a
caller whose agent id isn't `team.orchestrator_agent_id`; the skill doc cites
this as `:527-534`, which has drifted from the current file — verified
directly against source above, use `:539-546`).

**(e) Description** — the second `server.tool()` argument is returned
verbatim over `tools/list`; state the caller/authz boundary and where the
underlying data comes from in plain text (see `resource-tools.ts:23-26`'s
`list_resources` description for the house style).

**ToolContext wiring**, if the feature needs a stateful service beyond plain
`dataSource.getRepository()` access (interface at
`apps/server/src/modules/mcp/tools/context.ts:88-204`):
1. Add an optional field to the `ToolContext` interface
   (`context.ts:88-204`, follow the pattern of e.g.
   `orchestrationMissionService?` at `:199`).
2. NestJS-integrated construction: inject into `McpController`'s
   constructor and add to the object literal in `buildToolContext()`
   (`apps/server/src/modules/mcp/mcp.controller.ts:212-249`) — every current
   optional service is wired exactly here.
3. Register the owning module's provider by importing a new/existing domain
   module into `McpModule.imports`
   (`apps/server/src/modules/mcp/mcp.module.ts:24-56`; pattern:
   `OrchestrationModule` at `:21,55`).
4. Standalone parity (optional): construct a thin instance directly in
   `createStandaloneContext()` (`context.ts:213-292`) if the standalone
   `mcp-server.ts` entry point should support the tool too — many services
   are omitted there today by design when they need live SSE/DI (see the
   comments throughout `context.ts:96-204` explaining which services degrade
   to an explicit error in standalone mode).

**(f) Tests** — `apps/server/test/mcp-tool-authz.test.mjs` (build first,
imports compiled `dist/`, per the skill's exact command). New `*.test.mjs`
**files** additionally need registration in `apps/server/package.json`'s
`test` script args (`apps/server/test/test-registration-completeness.test.mjs`
guards this).

**(g) agent-manager card-capture classification** — separate, mandatory,
non-authz gate. Every new tool name must land in exactly one of
`TICKET_ACTION_TOOLS` or `TICKET_TOOL_EXCLUSIONS` in
`apps/agent-manager/src/lib/ticket-ref-capture.ts` (`TICKET_ACTION_TOOLS` at
`:37`, `TICKET_TOOL_EXCLUSIONS` at `:588`) — confirmed current, e.g.
`search_resources: 'read'` at `:612` and `embed_resources: 'non-ticket'` at
`:672` are the closest analogs for how new read-only/non-ticket ontology
tools (`query_ontology_graph`, `list_ontology_nodes`, etc.) would likely be
classified. Skipping this doesn't affect authz — it makes the tool's result
silently vanish from chat instead of erroring, so it's easy to miss in
testing. Guarded by
`apps/agent-manager/test/tool-surface-parity.test.mjs` (build agent-manager
first, same dist-import caveat).

---

## 7. Integration checklist for follow-on tickets

Each item is one concrete, file:line-anchored starting point.

**Schema ticket (OntologyNode/OntologyEdge entities)**
- [ ] New entity files in `apps/server/src/entities/`, following
      `RelationTuple.ts:1-32`'s tuple-table shape for edges and
      `Resource.ts:8-65`'s flat-column shape for nodes; scope columns
      (`workspace_id`, `resource_id`, `folder_path`) as plain `varchar`
      matching `Ticket.ts:119-126`'s `base_repo_resource_id`/`base_branch`
      convention (no DB FK).
- [ ] Barrel-export in `apps/server/src/entities/index.ts` (append after
      line 105) with the standing "auto-DDL, no migration" comment
      (precedent: `index.ts:97-100`). **No migration file needed** — verified
      against `db.ts:395-474` (§2).
- [ ] Only add `TypeOrmModule.forFeature([...])` (pattern:
      `resources.module.ts:11`) if a REST controller needs
      `@InjectRepository()`; MCP-only access does not need it
      (`resource-tools.ts:32`-style `dataSource.getRepository()`).

**Extraction worker ticket (repo folder → graph nodes/edges)**
- [ ] Reuse `ensureRepoCache`/`listTree`/`getFileContent` directly from
      `apps/server/src/modules/mcp/shared/git-repo-cache.ts` (`:222-269`,
      `:551-570`, `:606-645`) rather than re-implementing clone/fetch —
      folder-scoping via `treePath`/`normalizeRepoPath` (`:363-370`) already
      exists.
- [ ] Resolve the repo's credential via
      `resolveGitCredential`/`resolveToken` pattern already used by
      `resources.controller.ts:326` (git-branches path) — do not
      reimplement token-in-URL injection; reuse `applyCredential`
      (`git-repo-cache.ts:89-103`).
- [ ] If extraction runs as an agent (MCP-driven) rather than a server-side
      job, a **new MCP tool wrapping tree/file reads is required** —
      `resource-tools.ts` currently has no such tool (§3b); follow §6's
      7-touch-point checklist end to end (including the agent-manager
      classification in `ticket-ref-capture.ts`, easy to forget since this
      tool is non-ticket/read).
- [ ] Decide embedding-storage scale up front per §5 — brute-force
      `cosineSimilarity` over every row (`resource-tools.ts:213-230`) does
      not obviously scale to per-symbol embeddings; don't inherit it
      silently.

**Query API ticket (REST + MCP surfaces for the graph)**
- [ ] MCP tools land in a new `apps/server/src/modules/mcp/tools/ontology-tools.ts`
      (auto-discovered per `tools/index.ts:42-65`, §6a) — no changes to
      `registerAllTools` itself.
- [ ] Every tool name added to `TOOL_AUTHZ_TABLE`
      (`tool-authz-gate.ts:103-142`) — skipping this is a silent
      always-"Unauthorized" tool (§6b/c), the single highest-risk step to
      miss.
- [ ] If a stateful `OntologyService` is needed beyond raw repository
      access, wire it through `ToolContext` → `McpController.buildToolContext()`
      (`mcp.controller.ts:212-249`) → `McpModule.imports`
      (`mcp.module.ts:24-56`), per §6's numbered wiring steps.
- [ ] If a REST/admin surface is also wanted (e.g. for the graph
      visualization UI), model it after `resources.controller.ts`'s
      `PermissionGuard` + `RequirePermission` gating (`:31-32`) and its
      `catalog-scope.ts` Global/Workspace scope helpers
      (`canUseCatalogItem`/`normalizeCatalogScope`) rather than inventing a
      new scope model.

**Folder-picker UI ticket**
- [ ] Backend for "browse this repo's folders" is `GET /api/resources/:id/tree`
      (`resources.controller.ts:418-434`), **not** the `/api/agents/:id/fs/*`
      family (§4) — the latter browses an agent's live host filesystem via
      SSE reverse-RPC to agent-manager and is gated by a different
      permission (`BROWSE_AGENT_FS`). Confirm this distinction with whoever
      scopes the UI ticket before reusing fs-browser components by visual
      similarity alone.
