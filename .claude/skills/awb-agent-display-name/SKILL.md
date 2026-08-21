---
name: awb-agent-display-name
description: The `<Manager>/<Agent>` display-name contract for every surface that shows an agent — pickers, dropdowns, rosters, typing/status indicators, timelines, SSE frames, prompts. Use whenever code renders an agent's name, adds an agent picker, denormalizes an agent name into a payload or a DB column, or emits an event carrying an actor/agent name. Rendering a bare `agent.name` (or a raw agent id) is a bug, not a style choice — the same leaf name legitimately exists under multiple managers, so the prefix is the only thing that makes them distinguishable.
---

# Agent Display Name (`<Manager>/<Agent>`) Contract

## The rule

An agent's identity in the UI is **always** `<ManagerName>/<AgentName>`.
An agent with no manager (a Runtime Host / manager identity itself, or a
historical / non-executable identity) renders as its **bare name, with no
prefix**. Nothing else is ever acceptable — not a bare leaf name for a managed
agent, not a raw agent UUID, not a hand-rolled `${a.manager_name}/${a.name}`.

Two managers can each host an agent called `coder`. Without the prefix the
operator cannot tell them apart, and neither can an orchestrator reading its own
roster prompt.

## The two formatters — never inline the format

| Side | Module | Use |
|---|---|---|
| Server | `apps/server/src/utils/agent-name.ts` | `formatAgentDisplayName({ name, manager_name })`, `resolveAgentDisplayName(repo, id)` (single), `resolveAgentDisplayMap(repo, agents)` (batched — prefer for lists), `resolveAgentDisplayNamesByIds(repo, ids)` (mixed id sets; non-agent ids are absent from the map) |
| Client | `apps/client/src/utils/agentName.ts` | `formatAgentDisplayName(agent)`, `parseAgentDisplayName(input)`, `agentMatchesQuery(agent, query)` |

There is **no `fullName` field on the `Agent` entity** and there should not be:
the manager name lives on a different row (`Agent.manager_agent_id` →
`Agent.name`), so it is a resolved projection, never a stored column. That is
why every read path must go through one of the helpers above.

## Checklist — 6 touch points

Adding a surface that shows an agent? Walk all six. Each one has shipped broken
at least once.

| # | Touch point | What to do | Failure if missed |
|---|---|---|---|
| 1 | **Server list/detail projection** | Batch-resolve with `resolveAgentDisplayMap` and emit the resolved string (or emit `manager_name` alongside `name`) | Every consumer shows the bare leaf name |
| 2 | **API payload shape** | If the client formats, the payload MUST carry `manager_name`. Add it to the TS interface in `apps/client/src/types.ts` too | The client *cannot* render the prefix even if it wants to |
| 3 | **Client state mapping** | `.map((a) => ({ id, name }))` **drops** `manager_name` — carry it through | Picker renders bare names although the API returned the manager |
| 4 | **Client render** | `formatAgentDisplayName(a)` — never `{a.name}`, never a manual `/` join | Inconsistent labels across pages |
| 5 | **Denormalized writes / SSE frames** | Any `actor_name` / `agent_name` / `assignee_name` / `sender_name` written to a row or put on the wire must be resolved at emit time (or re-resolved on read, if a companion id is stored) | Stale or bare names; worst case a raw UUID on screen |
| 6 | **Agent-facing prompts** | Roster / dependency / assignee names in a prompt are user-visible too — resolve them | The orchestrator cannot distinguish two same-named members when assigning work |

## Specific traps

- **Typing / status indicators.** The indicator must be posted under the
  **responding agent's** id, not the manager's. `apps/agent-manager` runs many
  agents from one process, so `loadAgentInfo()` is the *manager's* identity —
  using it makes the UI say `<manager> is thinking`. It also breaks the
  client-side auto-clear, which keys the indicator by `agent_id` and clears it
  by the reply's `sender_id`: a mismatch leaves the indicator stuck until the
  15s safety timeout. **Set and clear must use the same id.**
- **Events with no name field.** `agent_typing` carried only `agent_id` and the
  registry flattened it as `actor_name: p.agent_id` — a UUID on screen. If an
  event feeds a label, give it a resolved name field.
- **Choke points beat call sites.** Prefer canonicalizing in one place that all
  writers pass through (e.g. `OrchestrationMissionService.recordEvent` resolves
  `actor_name` for every `actor_type: 'agent'` caller) over patching N call
  sites that will drift.
- **Non-agent actors must survive verbatim.** System labels
  (`BacklogPromotionService`), user names, and deleted rows have no Agent row.
  The resolvers return `null` / omit them from the map for exactly this reason —
  always fall back to the stored value rather than overwriting it.

## Verify

```bash
npm run build
# server-side contract (activity, pending, SSE, orchestration, typing)
cd apps/server && node test/run-suite.mjs \
  test/agent-fullname-display.test.mjs \
  test/agent-fullname-orchestration-typing.test.mjs
# agent-manager side: typing is attributed to the responder, not the manager
cd apps/agent-manager && npm test -- test/chat-typing-attribution.test.mjs
```

Add a case to `agent-fullname-orchestration-typing.test.mjs` for the surface you
touched. A useful test **fails on the pre-fix code** — verify that (stash your
`src` changes, rebuild, run) rather than assuming it.

Quick sweep for regressions before you ship:

```bash
# client: agent labels that bypass the helper
grep -rn "agents\.map\|\.agent_name\|agent\.name" --include=*.tsx apps/client/src \
  | grep -v formatAgentDisplayName
# server: bare-name denormalization into a payload
grep -rn "_name: .*\.name" --include=*.ts apps/server/src \
  | grep -vi "team\|mission\|column\|board\|workspace\|file"
```

## Related

- `apps/server/test/agent-fullname-display.test.mjs` — activity / pending / SSE
- `apps/server/test/agent-fullname-orchestration-typing.test.mjs` — orchestration + both typing indicators
- `apps/agent-manager/test/chat-typing-attribution.test.mjs` — responder attribution
- `.claude/skills/awb-mcp-tool-wiring/SKILL.md` — new MCP tools that return an agent name go through this contract too
