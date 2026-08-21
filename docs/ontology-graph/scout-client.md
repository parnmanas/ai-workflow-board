# Client Scout — Ontology Graph integration points (`apps/client/`)

Codebase scout, not a research doc. Every claim below is grounded in a real file:line in this repo as of the current worktree (`ticket/d4510d7c-ontology-graph-research-design`). Read with Read/Grep before trusting; do not re-derive from memory.

Sibling docs in this same folder (`research-extraction.md`, `research-incremental.md`, `research-ontology.md`, `research-prior-art.md`, `research-storage.md`, `research-visualization.md`) cover extraction/storage/algorithm design — this file is scoped strictly to **`apps/client/`ᅠintegration surface**.

---

## 1. Sidebar navigation — the "Knowledge" group

### 1.1 Where it's defined

`apps/client/src/components/Sidebar.tsx:109-202` builds a `workspaceSections` array of `{ title, items: NavItem[] }` blocks, rendered generically at `Sidebar.tsx:518-599`. The `Knowledge` section is a single literal block:

```tsx
// apps/client/src/components/Sidebar.tsx:144-155
{
  title: 'Knowledge',
  items: [
    { key: 'resources', path: `${workspaceBase}/resources`, label: 'Resources', icon: 'R' },
    {
      key: 'prompt-templates',
      path: `${workspaceBase}/prompt-templates`,
      label: 'Prompt Templates',
      icon: 'P',
    },
  ],
},
```

`NavItem` is typed at `Sidebar.tsx:29-38` — `{ key, path, label, icon, badge?, badgeLabel?, exact? }`. `icon` is **not** an icon-library reference; it's a single uppercase letter rendered inside a colored circle by `iconStyle()` (`Sidebar.tsx:248-260`) — there is no icon library anywhere in the client (confirmed: no `lucide`, `react-icons`, `@heroicons` etc. in `apps/client/package.json`). An `Ontology Graph` entry would need only a free letter, e.g. `'G'` (not yet used within the `Knowledge` section; cross-section collisions like `'O'` already used by `orchestration` in the `Work` section don't matter — icons are per-row, not globally unique).

### 1.2 How a new item gets added

Add one object to the `items` array at `Sidebar.tsx:146-153`:

```tsx
{ key: 'ontology-graph', path: `${workspaceBase}/ontology-graph`, label: 'Ontology Graph', icon: 'G' },
```

Rendering, active-state styling (`isPathActive` at `Sidebar.tsx:100-101`), hover, and the generic `renderNavItem()` (`Sidebar.tsx:280-302`) all come for free — no other Sidebar.tsx change is needed. `badge`/`badgeLabel` are optional (`Sidebar.tsx:34-36`) — if a future ticket wants a sidebar badge for "graph build in progress" or "stale, N commits behind", it plugs into the same `NavBadge` mechanism already used for ticket/chat unread counts (`Sidebar.tsx:299`, component at `apps/client/src/components/common/NavBadge.tsx:1-40`) — no new UI primitive required, just a `badge: number` sourced from wherever workspace-scoped counts land (currently `NotificationContext`, see §3).

None of the existing `Knowledge` items are permission-gated (no `hasPermission()` check wraps `resources`/`prompt-templates`, unlike the `admin-users`/`system-settings` entries at `Sidebar.tsx:173-175` and `187-199` which are spread conditionally on `canAdmin = hasPermission('admin.access')`, `Sidebar.tsx:91`). Following the existing convention, Ontology Graph would default to unguarded (visible to anyone with workspace access); if it should be admin/opt-in-gated instead, wrap it the same way those two entries are wrapped.

### 1.3 Routing wire-up in App.tsx

Resources/Prompt Templates route through a shared `WorkspaceManagementPage` with a `kind` discriminator:

```tsx
// apps/client/src/App.tsx:218-219
<Route path="prompt-templates" element={<WorkspaceManagementPage kind="prompt-templates" />} />
<Route path="resources" element={<WorkspaceManagementPage kind="resources" />} />
```

both nested inside the workspace-scoped route group opened at `App.tsx:198` (`<Route path="ws/:wsId">`). **This `kind`-switch pattern is a CRUD-list pattern** — `WorkspaceManagementPage` (`apps/client/src/components/WorkspaceManagementPage.tsx:19-92`) is a `switch (kind)` that renders one of nine `*Manager` list/form components (`FunctionManager`, `ResourceManager`, `PromptTemplateManager`, etc., all imported at `WorkspaceManagementPage.tsx:8-17`), wrapped in one shared `PageHeader` (`WorkspaceManagementPage.tsx:96-99`) and an optional global/workspace scope selector (`WorkspaceManagementPage.tsx:100-129`). An Ontology Graph page is a canvas/SVG visualization, not a CRUD list — it should **not** be folded into `WorkspaceManagementKind` (`WorkspaceManagementPage.tsx:19-28`); it needs its own route and component, following the precedent already set by Orchestration (a non-CRUD, visualization-ish top-level feature):

```tsx
// apps/client/src/App.tsx:32-35 — same lazy-import pattern to copy
const OrchestrationPage = lazy(() => import('./components/orchestration/OrchestrationPage'));
const OrchestrationTeamsPage = lazy(() => import('./components/orchestration/OrchestrationTeamsPage'));
const MissionDetailPage = lazy(() => import('./components/orchestration/MissionDetailPage'));
```

```tsx
// apps/client/src/App.tsx:207-209 — same nested-route pattern to copy
<Route path="orchestration" element={<OrchestrationPage />} />
<Route path="orchestration/teams" element={<OrchestrationTeamsPage />} />
<Route path="orchestration/missions/:missionId" element={<MissionDetailPage />} />
```

Concretely, a future ticket adds: (a) one `const OntologyGraphPage = lazy(() => import('./components/ontology/OntologyGraphPage'));` near `App.tsx:33-35`, and (b) `<Route path="ontology-graph" element={<OntologyGraphPage />} />` inside the `ws/:wsId` group, e.g. right after the `resources` route at `App.tsx:219`. All lazy routes render behind the shared `<Suspense fallback={<RouteFallback />}>` at `App.tsx:184` / `App.tsx:38-51` — no new Suspense boundary needed.

**Guard pattern**: there is no per-route guard component (no `<RequireAuth>` wrapper element on individual `<Route>`s). Auth is gated once, above the whole `<Routes>` tree, by an early return in `AppContent()`:

```tsx
// apps/client/src/App.tsx:179-181
if (!isAuthenticated) {
  return <LoginPage />;
}
```

Fine-grained authorization (if any) is left to the page component itself calling `useAuth().hasPermission(perm: string)` (`apps/client/src/contexts/AuthContext.tsx:225-229` — checks `state.user.resolved_permissions.includes(perm)`), the same way `WorkspaceManagementPage.tsx:44` and `:59` do for `'admin.access'`. A future Ontology Graph page would follow this same in-component pattern, not a route-level guard, if it ever needs to restrict who can trigger a (potentially expensive) graph (re)build.

---

## 2. Design tokens — single source of truth

**There is no CSS file and no `:root { --custom-property }` anywhere in `apps/client/src/`** (`find src -iname "*.css"` → empty; `grep -rn ":root"` → no hits). Every color/spacing/typography/shadow value in the client is a plain TS object, imported and read directly in inline `style={{ ... }}` props:

```ts
// apps/client/src/tokens.ts:1-111 (full file)
export const tokens = {
  colors: {
    surface: '#0f172a', surfaceCard: '#1e293b', surfaceHover: '#283548', surfaceSubtle: '#1a2535',
    border: '#334155', borderStrong: '#475569',
    textPrimary: '#f1f5f9', textStrong: '#e2e8f0', textSecondary: '#94a3b8', textMuted: '#64748b', textDisabled: '#cbd5e1', textInverse: '#ffffff',
    focusRing: '#818cf8',
    accent: '#6366f1', accentViolet: '#8b5cf6', accentLight: '#a78bfa', accentSubtle: '#a5b4fc', accentMid: '#818cf8', accentPale: '#c7d2fe',
    success: '#10b981', successLight: '#34d399', successPale: '#6ee7b7', successBg: '#065f46', successDark: '#059669',
    danger: '#ef4444', dangerMid: '#f87171', dangerLight: '#fca5a5', dangerBg: '#7f1d1d',
    warning: '#f59e0b', warningLight: '#fbbf24', warningBg: '#78350f',
    info: '#60a5fa', infoLight: '#38bdf8',
    badgeSystemBg: '#1c1917', badgeSystemBorder: '#292524', badgeSystemSurface: '#0c0a09', badgeSystemText: '#a8a29e',
    badgeAgentBg: '#1e1b4b', badgeUserBg: '#0c4a6e',
  },
  overlays: { /* rgba tints, accentFaint..accentStronger, backdrop, scrim — tokens.ts:54-67 */ },
  gradients: { surfacePage, surfaceCard, accent, warning, accentShimmer — tokens.ts:68-74 },
  spacing: { xs:4, sm:8, md:16, lg:24, xl:32, '2xl':48, '3xl':64 — tokens.ts:75-83 },
  typography: { fontSizeXs:11 … fontSizeXl:16, fontWeightNormal:400, fontWeightSemibold:600, lineHeight* — tokens.ts:84-94 },
  radii: { xs:2, sm:4, md:6, lg:8, xl:12, full:'50%' — tokens.ts:95-102 },
  shadows: { card, dropdown, panel, modal, overlay, overlayDark — tokens.ts:103-110 },
} as const;
```

Every screenshot-able surface in the app (Sidebar, PageHeader, all admin managers, orchestration status banners) imports this one object — e.g. `Sidebar.tsx:8` `import { tokens } from '../tokens';`, `WorkspaceManagementPage.tsx:6`, `PageHeader.tsx:2`. A future graph renderer's node/edge/label palette should be **derived from `tokens.colors`/`tokens.gradients`**, not hand-picked, to stay on-brand — e.g. node-kind colors could map onto `accent`/`accentViolet`/`success`/`warning`/`danger`/`info` (already the app's categorical palette for status/badges), edges/lines onto `border`/`borderStrong`, and a "building" pulse onto the same `accentShimmer` gradient (`tokens.ts:73`) already used elsewhere for shimmer/loading states.

For accessible contrast between generated node/edge colors and the app's dark surfaces (`surface: #0f172a`, `surfaceCard: #1e293b`), reuse the existing WCAG contrast utility rather than reinventing one:

```ts
// apps/client/src/utils/contrast.ts:8-16, 27-30, 33-38
export function parseHex(hex: string): [number, number, number] { /* '#rrggbb' | '#rgb' → [r,g,b] */ }
export function relativeLuminance(hex: string): number { /* WCAG relative luminance */ }
export function contrastRatio(fg: string, bg: string): number { /* 1:1 … 21:1 */ }
```

This is already used to pin token-palette contrast pairs in a `node:test` — see the header comment at `contrast.ts:1-6` explaining *why* (jsdom+axe can't see real alpha compositing, so pairs are checked with a static formula instead). A graph coloring scheme that procedurally assigns hues to node "kinds" should validate each hue against `surfaceCard`/`surface` through this same function rather than trusting eyeballing.

There is no dark/light theme toggle in the client (tokens.ts is a single hard-coded dark palette, no `prefers-color-scheme` or theme context found) — a graph renderer only needs to target this one palette, not a themeable one.

---

## 3. SSE subscription pattern

### 3.1 Shape

One authoritative `EventSource`, owned by a Provider mounted above the router `<Outlet />`, with an internal `EventTarget` pub/sub so any number of components can subscribe without each opening their own connection:

```tsx
// apps/client/src/contexts/BoardStreamContext.tsx:48-66
interface BoardStreamContextValue {
  subscribe: (eventType: StreamNamedEventType, handler: (data: any) => void) => () => void;
  isConnected: boolean;
}
export function useBoardStream(): BoardStreamContextValue { /* throws if used outside provider */ }
export function useBoardStreamEvent(
  eventType: StreamNamedEventType,
  handler: (data: any) => void,
) { /* subscribes on mount, auto-unsubscribes on unmount, handler kept in a ref so callers can pass inline closures */ }
```

Mount point — `BoardStreamProvider` wraps the entire authenticated shell above `<Outlet />`, so the connection survives route changes (Board → Ontology Graph → Board would **not** reconnect):

```tsx
// apps/client/src/components/AppLayout.tsx:290, 397, 408
<BoardStreamProvider>
  ...
        <Outlet />                    {/* line 397 */}
  ...
</BoardStreamProvider>               {/* line 408 */}
```

The doc comment at `BoardStreamContext.tsx:10-32` states the architectural intent explicitly ("no downstream component may instantiate its own EventSource").

### 3.2 Adding a new event type

`StreamNamedEventType` (`BoardStreamContext.tsx:34-46`) is a union of every event name the client currently listens for (`board_update`, `agent_typing`, `agent_trigger`, `chat_message`, `agent_status`, `chat_room_message`, `chat_room_update`, `chat_room_typing`, `server_meta`, `user_mention`, `comment_typing`, `ticket_presence`, `subagent_registered`, `subagent_log`, `subagent_ended`, `agent_instance_update`, `consensus_update`, `orchestration_update`, `ticket_reads_cleared`). A new `ontology_graph_progress` (or similarly named) event needs: (1) one more literal added to this union, and (2) one more `eventSource.addEventListener('ontology_graph_progress', (event) => dispatch('ontology_graph_progress', event.data))` block inside `connect()` (pattern at `BoardStreamContext.tsx:153-224`, e.g. the `orchestration_update` listener at `BoardStreamContext.tsx:216-218`). This is a **server-driven SSE contract** (see `CLAUDE.md` project section on Agent Manager: SSE event types added/changed must ship server + client in the same PR — the server side of this specific event lives in `apps/server/src/modules/*` , outside this scout's scope).

### 3.3 Reconnect behavior

Plain 5s fixed-delay reconnect on error, no backoff growth, guarded against reconnecting after intentional unmount:

```ts
// apps/client/src/contexts/BoardStreamContext.tsx:226-233
eventSource.onerror = () => {
  setIsConnected(false);
  if (eventSource?.readyState === EventSource.CLOSED && !closed) {
    eventSource.close();
    reconnectTimer = setTimeout(connect, 5000);
  }
};
```

Connection URL/auth: `EventSource` is constructed directly (not through `api.ts`'s `fetch` wrapper), token read from `localStorage.getItem('auth_token')` and passed as a query param (`BoardStreamContext.tsx:117-126`) — `EventSource` has no custom-header support, hence the query-param auth. The stream is intentionally **workspace-agnostic** (no `?boardId=` filter, comment at `BoardStreamContext.tsx:26-27, 124-125`) — consumers filter by fields inside the payload (e.g. `data.board_id`, `data.workspace_id`) client-side, which is exactly the filter idiom a graph-progress consumer would also need (filter incoming frames by `workspace_id`/a graph-build-job id).

### 3.4 Is this reusable as-is for "342k/2.4M edges extracted"-style progress? Two existing precedents, pick based on payload size

**Pattern A — lightweight signal + refetch** (best if progress detail is too large/complex to push wholesale on every tick): server sends a bare headline frame, client debounces and refetches the full resource over REST.

```tsx
// apps/client/src/components/orchestration/MissionDetailPage.tsx:69-72, 78-81
const scheduleRefresh = useCallback(() => {
  if (refreshTimer.current) clearTimeout(refreshTimer.current);
  refreshTimer.current = setTimeout(() => void load({ silent: true }), 400);   // coalesces a burst of frames into one refetch
}, [load]);

useBoardStreamEvent('orchestration_update', (data: OrchestrationUpdateEvent) => {
  if (!data || data.mission_id !== missionId) return;
  scheduleRefresh();
});
```

...plus a 30s polling safety net for any dropped frame while the mission is still live (`MissionDetailPage.tsx:85-90`), and a rendered progress percentage computed from counts (`status.ts:114-117: progressPercent = round((done+failed)/total*100)`), shown in a status banner with a live-pulse dot (`MissionDetailPage.tsx:358-391`, pulse animation `awb-orch-pulse`).

**Pattern B — direct incremental payload, no refetch** (best for "N processed so far" counters, since the number itself is cheap to push every tick): server puts the actual delta in the SSE frame; client appends/increments local state directly.

```tsx
// apps/client/src/components/AgentSubagentsPanel.tsx:74-85
useBoardStreamEvent('subagent_log', (data: any) => {
  if (!wsId || data.workspace_id !== wsId) return;
  setSubagents((prev) => prev.map((s) =>
    s.subagent_id === data.subagent_id ? { ...s, line_count: s.line_count + 1 } : s,
  ));
  if (selectedId === data.subagent_id) {
    setTranscript((prev) => {
      const next = prev.concat({ direction: data.direction, line: data.line, ts: data.ts });
      return next.length > 500 ? next.slice(next.length - 500) : next;   // caps in-memory transcript
    });
  }
});
```

For "342k/2.4M edges extracted", **Pattern B is the closer fit**: the server would push periodic `{ workspace_id, job_id, edges_extracted, edges_total, nodes_extracted, ... }` frames and the client increments a counter directly (no refetch of the whole graph mid-build) — mirroring `AgentSubagentsPanel.tsx:74-78`'s counter-increment, not `MissionDetailPage`'s refetch-on-signal. Pattern A remains the right shape for "graph build finished / failed / status changed" transitions, where the client should then pull the finished graph payload.

There are 29 real call sites of `useBoardStreamEvent(` across the client today (`grep -rn "^\s*useBoardStreamEvent(" apps/client/src --include="*.tsx" --include="*.ts"` — excludes the hook's own definition/doc-comment mentions), spanning contexts (`NotificationContext.tsx`, `TicketMetaContext.tsx`), hooks (`useMentions.ts:51`), and components (`TicketPanel.tsx`, `ChatPage.tsx`, `AgentDetailModal.tsx`, `AgentSubagentsPanel.tsx`, `MissionDetailPage.tsx`, `OrchestrationPage.tsx`, etc.) — so this hook is a stable, heavily-reused integration point, not a one-off. A new Ontology Graph progress consumer would be the 30th, following an established idiom.

---

## 4. Existing large-list / virtualization / canvas-rendering patterns

**No canvas, WebGL, or graph-rendering library exists anywhere in `apps/client/`.** Confirmed by exhaustive grep:
- `grep -rln "canvas\|Canvas" src` → only two false-positive hits, both Korean/English comments about the mobile **off-canvas drawer** sidebar, not a `<canvas>` element (`apps/client/src/main.tsx:54`, `apps/client/src/components/AppLayout.tsx:41,278`).
- `grep -rln "<svg\|SVGSVGElement" src` → zero hits. No inline SVG diagrams anywhere.
- `apps/client/package.json` has no `d3`, `d3-force`, `cytoscape`, `sigma`, `vis-network`, `reactflow`/`@xyflow/react`, `three`, `pixi.js`, `elkjs`, or `dagre`.
- No existing `Ontology`/`node.*edge`/`force-directed`/`forcegraph` references anywhere in client source (fresh feature, not a partial rebuild).

**One virtualization library is present and in active use**: `@tanstack/react-virtual` (`apps/client/package.json:16`, resolved `3.14.9`), but with a **single consumer** — the ticket comment list:

```tsx
// apps/client/src/components/CommentList.tsx:106-119
const virtualizer = useVirtualizer({
  count: flatRows.length,
  getScrollElement: () => parentRef.current,
  estimateSize: () => 120,                         // rough row-height guess; corrected post-measure
  getItemKey: (index) => flatRows[index].comment.id, // keyed by id, NOT index — critical for stable heights when prepending
  overscan: 5,
});
```

This is a **1-D list virtualizer** (vertical scroll of variable-height rows) — directly reusable for an Ontology Graph feature's *adjacent* list-shaped UI (e.g. a searchable node/entity sidebar list, an edges-inspector table, a "recently changed nodes" feed) but **not** applicable to the 2-D canvas/force-layout graph rendering itself, which has no precedent in this codebase at all. A future graph renderer is a from-scratch integration (canvas 2D or WebGL, likely via a dedicated library chosen in `research-visualization.md`), not a reuse of an existing client primitive — the only transferable pieces from the existing codebase are: the **design tokens** (§2), the **SSE plumbing** (§3), and the **row-virtualization idiom** (`getItemKey`-by-id, `overscan`, `estimateSize`-then-measure) if the graph UI also ships a companion list view.

Small reusable UI primitives that a graph page's chrome (toolbar, empty/error/loading states, legend) can pull from rather than re-inventing, all token-driven, all exported from one barrel:

```ts
// apps/client/src/components/common/index.ts (full file)
export { Button } from './Button';
export { Input } from './Input';
export { Select } from './Select';
export { Modal } from './Modal';
export { default as ConfirmDialog } from './ConfirmDialog';
export { Card } from './Card';
export { Badge } from './Badge';
export { HeaderAction } from './HeaderAction';
export { HeaderOverflowMenu } from './HeaderOverflowMenu';
export { EmptyState } from './EmptyState';
export { ErrorState } from './ErrorState';
export { PermissionNotice } from './PermissionNotice';
```

`EmptyState`/`ErrorState` in particular are the natural fit for "no graph built yet" / "graph build failed" states; `PageHeader` (`apps/client/src/components/PageHeader.tsx:9-33`, `{ title, description, actions }`) is the natural fit for the page's top bar (title + a "Rebuild graph" action button), matching every other top-level page (`WorkspaceManagementPage.tsx:96-99`).

---

## 5. Integration checklist for a future Knowledge-UI child ticket

1. **Sidebar entry** — append one `NavItem` object to the `Knowledge` section's `items` array: `apps/client/src/components/Sidebar.tsx:146-153` (after the `prompt-templates` entry at `:148-153`). No other Sidebar.tsx change needed; `renderNavItem()` (`Sidebar.tsx:280-302`) handles active-state/hover/badge for free.
2. **Route + lazy import** — add `const OntologyGraphPage = lazy(() => import('./components/ontology/OntologyGraphPage'));` next to the other feature lazy-imports at `apps/client/src/App.tsx:32-35`, and `<Route path="ontology-graph" element={<OntologyGraphPage />} />` inside the `ws/:wsId` group, next to the `resources` route at `apps/client/src/App.tsx:219`. Do **not** route it through `WorkspaceManagementPage`'s `kind` switch (`apps/client/src/components/WorkspaceManagementPage.tsx:19-92`) — that pattern is CRUD-list-shaped, this feature is not.
3. **Auth/guard** — no route-level guard exists in this app; if the page needs restricting, gate it in-component via `useAuth().hasPermission('some.perm')` (`apps/client/src/contexts/AuthContext.tsx:225-229`), matching `WorkspaceManagementPage.tsx:44,59`. Default (matching the other two `Knowledge` items) is unguarded.
4. **Design tokens** — import `{ tokens } from '../tokens'` (`apps/client/src/tokens.ts`, full file, 111 lines) for every color/spacing/radius/shadow the graph UI's chrome uses; derive the node/edge categorical palette from `tokens.colors.{accent,accentViolet,success,warning,danger,info}` rather than new hex literals, and validate contrast against `tokens.colors.{surface,surfaceCard}` via `apps/client/src/utils/contrast.ts:33-38` (`contrastRatio`).
5. **Live build-progress SSE** — add the new server event name to `StreamNamedEventType` (`apps/client/src/contexts/BoardStreamContext.tsx:34-46`) and one `eventSource.addEventListener(...)` block in `connect()` (`BoardStreamContext.tsx:153-224`, pattern at `:216-218`). Consume with `useBoardStreamEvent('ontology_graph_progress', handler)` (hook at `BoardStreamContext.tsx:73-87`) inside the new page, incrementing local counters directly per §3.4 Pattern B (`apps/client/src/components/AgentSubagentsPanel.tsx:74-85`) rather than refetching on every frame. Remember: this is a cross-cutting SSE-contract change — per `CLAUDE.md`, the server-side emitter (`apps/server/src/modules/...`) must land in the **same PR**.
6. **REST fetch(es)** for the built graph payload / rebuild-trigger — add typed methods to the `api` object using the existing `request<T>()` wrapper (`apps/client/src/api.ts:170-194`), following the naming/shape convention of `listSubagents`/`getSubagentTranscript` (`api.ts:831-836`); add the new response types to `apps/client/src/types.ts` (2591 lines, e.g. near `SubagentSummary` at `types.ts:1878`) and import them at the top of `api.ts` alongside the existing type import block (`api.ts:1-49`).
7. **Empty/error/loading chrome + page header** — reuse `PageHeader` (`apps/client/src/components/PageHeader.tsx`, `{ title, description, actions }`) and `EmptyState`/`ErrorState` from the common barrel (`apps/client/src/components/common/index.ts`) instead of one-off markup, matching every other top-level page.
8. **Graph canvas/SVG rendering itself** — greenfield; no reusable primitive exists in this client (§4). If the graph page also ships a companion node/entity list view, reuse the `@tanstack/react-virtual` idiom from `apps/client/src/components/CommentList.tsx:106-119` (key rows by stable id, not index; `overscan: 5`; `estimateSize` + post-measure correction) rather than re-deriving virtualization from scratch.
