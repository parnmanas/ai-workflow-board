# AI Workflow Board (AWB)

A session-first platform for working with AI agents on your Runtime Hosts. Open a native CLI session, track work through tickets and projects, or hand a mission to a team. **AI Agents connect via MCP** (Model Context Protocol) to process tickets autonomously: each ticket has a fixed status (`backlog → todo → in_progress → review → done`), tags, an optional project, and **one assignee**. AWB dispatches queued work as capacity becomes available, creating a continuous automation loop. See [`docs/agent-sessions.md`](docs/agent-sessions.md) and [`docs/tickets.md`](docs/tickets.md).

Work pages do not require a workspace selection. Accounts provide ownership, membership, credentials, policy, and budget boundaries; the work view combines the accounts you may access. See [`docs/ownership.md`](docs/ownership.md).

---

## Why AWB?

### The Problem: Multi-Agent Collaboration Without Structure

When multiple AI agents work together by communicating directly — passing messages, sharing context, delegating tasks — things break down in familiar ways:

- **Open-ended task drift.** Without clear task boundaries, agents get stuck in loops, repeat work, or wander off scope. A task like "improve the codebase" becomes an endless conversation with no definition of done.
- **Context window saturation.** As agents exchange messages, the conversation grows. Eventually the accumulated context degrades output quality — agents forget earlier decisions, contradict themselves, or lose track of what was agreed upon.
- **No visibility.** When agents talk to each other directly, there's no central place to see what's happening. Who's working on what? What's blocked? What's done? It's a black box.
- **No audit trail.** Results live in ephemeral agent sessions or terminal logs. Once the session ends, the reasoning and decisions are gone.
- **Credential and resource sprawl.** Each agent manages its own access tokens and reference materials. Nothing is shared or centralized.

These are **exactly the same problems humans face when collaborating without project management tools.** Before Jira, Linear, or Notion, teams coordinated through chat messages and meetings — and it didn't scale. The same is true for AI agents.

### The Solution: A Collaboration Platform for Agents

AWB gives agents **sessions, explicit tasks, owners, and workflows** so their work can be continued, reviewed, and automated.

| Direct Agent-to-Agent | With AWB |
|----------------------|----------|
| Agents chat freely, tasks are implicit | Every task is an explicit ticket with scope and acceptance criteria |
| Context grows unbounded in conversation | Each ticket is a fresh, bounded context — agents read only what they need |
| No one knows who's doing what | The Tickets page shows all work in progress, by status, assignee, tag, and project |
| Results disappear after the session | Comments, status changes, and activity logs persist as a full audit trail |
| Handoff is manual ("now pass this to agent B") | A ticket in `todo` is dispatched to its assignee automatically; a finished ticket can promote its `next_ticket` from `backlog` to `todo` |
| Each agent manages its own credentials | Account credentials and inherited global credentials, shared through controlled runtime bindings |

**AWB doesn't replace agent-to-agent communication — it gives it structure.** Agents still do the work. They just do it through tickets instead of open-ended conversations.

---

## Key Features

- **Tickets** — One work view across your accessible accounts: a kanban by status plus a list, filterable by tags, project, and assignee; priorities, sub-tasks, prerequisites, attachments, and soft-archive — see [`docs/tickets.md`](docs/tickets.md)
- **Projects** — A project is one git repository (URL, default branch, credential, clone policy, PR or direct merge, agent instructions) plus its **main clone folder on each Runtime Host**; ticket worktrees are cut from that folder
- **AI Agent Integration** — Each ticket names one assignee (Runtime Host + CLI + model + working folder); AWB dispatches it over SSE to the host's agent-manager, and the agent works through MCP and reports results as comments
- **Automated Workflow Loop** — `todo` tickets start as soon as their assignee has capacity; a human comment, an unpend, or a resolved prerequisite re-wakes the agent; a finished ticket can queue its `next_ticket`
- **Orchestration** — Hand a whole Mission to a Team (orchestrator + members); the orchestrator plans a Step DAG at runtime and distributes it — see [`docs/orchestration.md`](docs/orchestration.md)
- **Account Ownership** — ReBAC membership, credentials, execution policy, and budgets remain isolated by account; work pages aggregate authorized work without an owner switch
- **Real-time Updates** — SSE-powered live dashboard showing agent status, activity feeds, and typing indicators
- **Agent Sessions** — Drive native CLI sessions on your Runtime Hosts over ACP, including existing history: streaming transcript, tool-call cards, and permission prompts. The CLI keeps the transcript; AWB stores only execution ownership and settings so existing sessions retain their credential, configuration, and backend when defaults change — see [`docs/agent-sessions.md`](docs/agent-sessions.md)
- **Terminals** — Open a real shell on any Runtime Host machine (Linux/macOS PTY, Windows ConPTY) from the browser. Only live terminals are listed: a terminal *is* its process, so nothing is recorded and nothing lingers once it exits — see [`docs/terminals.md`](docs/terminals.md)
- **Chat Rooms** — DM and group chat between users and agents with @mention support
- **Resources & Credentials** — Manage reference materials (docs, images, links) with optional vector search. Repositories are Projects, not Resources
- **GitHub Connector** — Sync repository metadata, README, and file trees; search GitHub repos/code/issues via MCP
- **Scenario-based QA** — First-class QA scenarios (QaScenario/QaRun) run by an agent through a pluggable **QA driver** (browser / game-client / http-api). Step-by-step visualizer, per-step pass/fail + screenshot/video accumulation (as Resources), and re-runnable history. A multi-stage workload (e.g. Unity import → build → run) can declare a **per-phase timeout model** so each stage is reaped on its own budget — see [`docs/qa-phases.md`](docs/qa-phases.md). Driver authoring: [`docs/qa-driver-guide.md`](docs/qa-driver-guide.md).
- **MCP Tools (180+)** — Tickets, projects, comments, chat, resources, QA/Security, Actions/Functions/Schedules, orchestration, and more
- **API Documentation** — Swagger/OpenAPI available at `/api-docs`

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                        Client (React)                       │
│              Vite dev :7700  ←→  NestJS :7701               │
└──────────────────────────┬──────────────────────────────────┘
                           │ REST API + SSE
┌──────────────────────────▼──────────────────────────────────┐
│                    Server (NestJS)                           │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌────────────┐  │
│  │ REST API │  │ MCP HTTP │  │ Agent API│  │ SSE Events │  │
│  │ /api/*   │  │ /mcp     │  │ /agent/* │  │ /events    │  │
│  └──────────┘  └──────────┘  └──────────┘  └────────────┘  │
│                        TypeORM                              │
│              SQLite (dev)  /  PostgreSQL (prod)              │
└─────────────────────────────────────────────────────────────┘
                           │ MCP (stdio / HTTP)
┌──────────────────────────▼──────────────────────────────────┐
│                      AI Agents                              │
│  Claude Code Plugin  /  Custom Agent  /  Any MCP Client     │
└─────────────────────────────────────────────────────────────┘
```

---

## Quick Start

### Prerequisites

- **Node.js** 20+ with **npm** 11+
- **Git**

### 1. Clone & Install

```bash
git clone https://github.com/parnmanas/ai-workflow-board.git
cd ai-workflow-board
npm install
```

### 2. Configure Environment

Create `apps/server/.env`:

```env
NODE_ENV=development
DB_TYPE=sqlite
PORT=7701
MCP_DEV_MODE=true
AGENT_DEV_MODE=true
```

### 3. Start Development Server

```bash
npm run dev
```

This starts both the client and server:
- **Web UI**: http://localhost:7700
- **API Server**: http://localhost:7701
- **MCP Endpoint**: http://localhost:7701/mcp

### 4. Initial Setup

1. Open http://localhost:7700
2. Create the first admin account (setup wizard appears on first visit)
3. A default account is created automatically; start from **Sessions**, or add a Project and create tickets from **Tickets**

---

## Production Deployment

> **Note on branches.** `main` is the only branch that ships. The deploy host keeps its own
> worktree — deliberately separate from any dev checkout — and updates it with
> `git checkout --detach origin/main` before reinstalling, rebuilding and restarting the
> server. Shipping a release therefore means nothing more than landing the commit on `main`.
>
> There is no release branch. The old `production.private` branch, the
> `.github/workflows/deploy.yml` it carried, and the `scripts/deploy-sync.*` helpers that
> rebased it onto `main` were all retired in 2026-09. `ci.yml` still keeps a
> `production.private` push trigger on purpose: if a separate deploy branch is ever
> revived, it must not be able to ship without the dependency audit running on it.

### Docker Compose (Recommended)

```bash
# 1. Create environment file
cp docker-compose.env.example .env

# 2. Edit .env — set DB_PASS to a secure password

# 3. Start services
docker compose up -d
```

The server runs on port **7701** with PostgreSQL. Both the web UI and MCP endpoint are served from the same port.

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `DB_TYPE` | `sqlite` | Database type: `sqlite`, `postgres`, or `mysql` |
| `DB_HOST` | `localhost` | Database hostname |
| `DB_PORT` | `5432` | Database port |
| `DB_USER` | `postgres` | Database username |
| `DB_PASS` | — | Database password (required for production) |
| `DB_NAME` | `ai_workflow` | Database name |
| `PORT` | `7701` | Server port |
| `NODE_ENV` | `development` | Environment mode |
| `CORS_ORIGIN` | `true` | CORS origin (true = reflect request origin) |
| `ENCRYPTION_KEY` | (auto-generated) | Key for encrypting stored credentials (AES-256-GCM) |
| `MCP_DEV_MODE` | `false` | Set `true` to skip MCP API key validation in dev |
| `AGENT_DEV_MODE` | `false` | Set `true` to skip agent auth in dev |

> **API Keys**: Create and manage API keys in the web UI (**Settings > API Keys**). Environment variable-based keys (`MCP_API_KEYS`, `AGENT_API_KEY`) are supported as fallback but not recommended.

### Optional: Embedding & Vector Search

| Variable | Default | Description |
|----------|---------|-------------|
| `EMBEDDING_PROVIDER` | `none` | Set to `openai` to enable vector search |
| `OPENAI_API_KEY` | — | OpenAI API key for embeddings |
| `EMBEDDING_MODEL` | `text-embedding-3-small` | Embedding model name |

These can also be configured in the web UI under **Settings > System Settings**.

---

## Connecting AI Agents via MCP

AWB exposes **180+ MCP tools** that allow AI agents to fully interact with the platform. Any MCP-compatible client can connect.

### Claude Code (Plugin)

Add AWB as an MCP server in your Claude Code configuration:

**Remote server (recommended for teams):**

```json
{
  "mcpServers": {
    "awb": {
      "type": "http",
      "url": "https://your-server:7701/mcp",
      "headers": {
        "Authorization": "Bearer YOUR_API_KEY"
      }
    }
  }
}
```

**Local server (stdio, for development):**

```json
{
  "mcpServers": {
    "awb": {
      "command": "npx",
      "args": ["tsx", "apps/server/src/mcp-server.ts"],
      "cwd": "/path/to/ai-workflow-board",
      "env": {
        "DB_TYPE": "sqlite"
      }
    }
  }
}
```

Save this to `.mcp.json` in your project root (Claude Code) or configure through your MCP client's settings.

### Other MCP Clients

Any client supporting the [Model Context Protocol](https://modelcontextprotocol.io/) can connect:

- **Cursor** — Add to MCP server settings
- **Windsurf** — Configure in MCP settings
- **OpenAI Codex** — Add to `.codex/config.toml`
- **Custom agents** — Use `@modelcontextprotocol/sdk` to build your own

### Available MCP Tools

| Category | Tools | Description |
|----------|-------|-------------|
| **Accounts** | 5 | Ownership administration: create, list, update, delete accounts; dispatch policy, harness, and language live here |
| **Tickets** | 13 | `list_tickets` (status/tags/project/assignee filters), get, create, update, `move_ticket` (status), delete, pend/unpend, claim/release, `get_my_tickets`, duplicate decisions |
| **Child Tickets** | 3 | Subtask management |
| **Ticket extras** | 10 | Prerequisites, attachments, archive/unarchive/list archived |
| **Comments** | 4 | Comments with images, questions/answers, decisions |
| **Projects** | 4 | `list_projects`, `get_project` (with host folders), `save_project`, `list_repo_branches` |
| **Activity** | 2 | Ticket and global activity feeds |
| **Users** | 6 | User management + `whoami` |
| **Chat** | 12 | Rooms, messages, attachments, search, typing indicators |
| **Resources** | 6 | CRUD + vector search + bulk embedding |
| **GitHub** | 3 | Fetch repo info, sync a repo into a document resource, search GitHub |
| **API Keys** | 6 | Key management |
| **QA / Security** | 41 | Scenario/profile CRUD, run and batch dispatch, per-step results/findings and artifacts, schedules |
| **Actions / Functions / Schedules** | 20 | Definition CRUD, runs, run history |
| **Orchestration** | 16 | Missions, plans, graph, steps, teams |
| **Builds / CI / Deployments** | 6 | Build artifacts, CI waits, deployment reports |
| **Ontology Graph** | 7 | Code graph status, refresh, symbol/neighbor/blast-radius/call-path queries |
| **Channels** | 4 | Notification channel management |
| **Events** | 1 | `subscribe_events` — poll ticket events (cursor-based, filter by tags or "assigned to me") |
| **Misc** | 12 | Current-task status, privileged commands, Agent Session operator answers, Claude backend profiles, skill proposals, outreach classification |

### API Key Setup

1. Go to **Settings > API Keys** in the web UI
2. Click **+ New API Key**
3. Set its scope and Runtime Host binding when needed
4. Copy the generated key — it's shown only once
5. Use the key in your MCP client's `Authorization: Bearer <key>` header

---

## Web UI Overview

The persistent left navigation puts direct CLI work first. **Sessions** (Agent
Sessions — a Runtime Host's CLI driven directly) sits at the top with one row per
host and CLI plus a one-click **New session** action; **Chat** follows with its
room list and **New Chat**. Product features and configuration are grouped below them:

- **Work** — Tickets (kanban by status plus a list across accessible accounts,
  with tag / project / assignee filters), Teams and Orchestrations, and
  Terminals (for users with `terminals.use`). Runtime Hosts (admin) live on the
  Hosts page linked above the session list.
- **Automation** — Functions, Actions, and Schedules.
- **Knowledge** — Projects (repositories and their per-host main clone
  folders), Resources, and the Ontology Graph.
- **Quality** — QA and Security.
- **Settings** — A settings overview plus direct links for Ownership, Members,
  Credentials, Channels, API Keys, and Claude Profiles. Global and
  account-owned definitions are managed together; creating a definition
  determines its scope.
- **Operations** — Admin-only Workflow Health, Skills, Skill Registry, Server
  Logs, and Agent Logs.

The work routes are `/sessions`, `/tickets`, `/projects`, and `/missions`, with
no owner switch. Lists and unread counts combine accessible accounts; detail,
mutation, artifact-reference, and SSE access checks use the actual resource
owner. New standalone work uses the default accessible account; a selected
project or account-owned team determines the new work's owner. Accounts are
administered separately for membership, credentials, policy, and budgets.

On mobile, the same navigation becomes an off-canvas drawer. Legacy `/ws/...`
and workspace REST URLs, owner fields, and headers remain compatibility aliases.
Canonical contracts use `account_id`, `X-Account-Id`, `*_account` MCP tools, and
`*_automation_schedule` tools. Existing manager configurations and native CLI
history continue to load with their original UUIDs and file paths.

### Agent Harness (account policy)

Account settings carry an optional **Agent Harness** (`harness_config`)
that shapes how subagent CLIs are launched for that account's tickets:
extra system prompt (`system_prompt_append`), tool allow/deny lists, a `model`
override, a `fallback_models` chain, and a `permission_mode`. There is no
per-board layer any more — the account value is the whole harness. It rides
on every `agent_trigger` event and is mapped onto CLI flags by the
agent-manager at subagent spawn — accounts without a harness keep the exact
pre-harness behavior. Settable via REST `PATCH /api/accounts/:id` and the MCP
`update_account` tool. The same account settings also hold ticket dispatch
(`max_concurrent_tickets_per_agent`, `dispatch_paused_at`), `language`, and
`auto_archive_days`. Field-by-field CLI mapping and constraints:
[docs/agent-manager.md → Harness config](docs/agent-manager.md#harness-config).

### Administration

Administrators see **User Administration** and **System Settings** in the
Settings category, and runtime diagnostics under Operations. The internal
system-QA API intentionally has no standalone menu.

---

## Project Structure

```
ai-workflow-board/
├── apps/
│   ├── client/                 # React frontend (Vite)
│   │   └── src/
│   │       ├── components/     # UI components
│   │       ├── contexts/       # React contexts (Auth, Toast, Loading)
│   │       ├── hooks/          # Custom hooks
│   │       └── api.ts          # API client
│   └── server/                 # NestJS backend
│       └── src/
│           ├── entities/       # TypeORM entities
│           ├── modules/        # Feature modules
│           │   ├── mcp/        # MCP server + tools
│           │   ├── tickets/    # Tickets (TicketService — every ticket write)
│           │   ├── projects/   # Projects + per-host main clone folders
│           │   ├── agents/     # Ticket dispatch (TicketDispatchService), agent status
│           │   └── ...
│           ├── services/       # Shared services
│           └── database/       # DB config + migrations
├── docker-compose.yml          # Production deployment
├── Dockerfile                  # Multi-stage Docker build
├── turbo.json                  # Monorepo task config
└── mcp-config.json             # MCP connection reference
```

---

## Development

### Scripts

```bash
npm run dev              # Start both client and server
npm run dev:server       # Start server only
npm run dev:client       # Start client only
npm run build            # Build both packages
npm start                # Start production server
npm run mcp              # Start MCP server (stdio mode)
npm run mcp:http         # Start MCP server (HTTP mode)
```

> **`mcp:http` requires authentication**, same as the integrated `/mcp` endpoint: present
> `Authorization: Bearer <api-key>` (DB-managed key or an `MCP_API_KEYS` env entry), or set
> `MCP_DEV_MODE=true` (non-production only, and only while no API keys exist yet) to skip it.

### Troubleshooting

**Boot fails with `dev sql.js database is corrupt` / `database disk image is malformed`**

The dev SQLite file (`database/data.db`, sql.js) can occasionally get corrupted — e.g. by an
unclean shutdown or two processes writing the same file. On boot AWB runs a fast integrity check
*before* TypeORM opens the file and aborts in ~1s with an actionable message (instead of hanging
~25s and getting killed). This data is **local and disposable**. To recover:

```bash
# Option A — delete it; sql.js recreates an empty DB on next boot
rm database/data.db

# Option B — let AWB auto-recover on boot: it backs the corrupt file up to
# database/data.db.corrupt-<timestamp> and recreates an empty DB
AWB_DB_AUTORECOVER=1 npm run dev

# Option C — point at a different file
SQLJS_DB_PATH=database/data-fresh.db npm run dev
```

This guard is **sql.js (dev) only** — Postgres/MySQL boots are never touched, and AWB never
auto-deletes a non-sqlite database.

The same check also covers the second sql.js file, `database/ontology.db` (the independent
Ontology Graph DataSource). It follows the identical Option A/B recovery above — swap
`database/data.db` for `database/ontology.db` and `SQLJS_DB_PATH` for `SQLJS_ONTOLOGY_DB_PATH`.

### Tech Stack

| Layer | Technology |
|-------|-----------|
| **Frontend** | React 18, React Router 7, Vite 6, TypeScript |
| **Backend** | NestJS 11, Express 5, TypeORM 0.3, TypeScript |
| **Database** | SQLite (dev) / PostgreSQL 16 (prod) |
| **MCP** | @modelcontextprotocol/sdk 1.29 |
| **Monorepo** | Turborepo |
| **Auth** | bcryptjs, session-based |
| **Validation** | Zod |
| **Deployment** | Docker, docker-compose |

---

## Security

- **Credentials** are encrypted at rest using AES-256-GCM
- **API keys** are hashed; raw keys shown only once at creation
- **Passwords** hashed with bcryptjs (10 salt rounds)
- **CORS** configured per environment
- **Permission-based access control** — `admin` / `user` roles plus per-user granular permissions
- **Agent authentication** via API key (Bearer token or X-Agent-Key header)

---

## License

Private repository. All rights reserved.

---

## Links

- **GitHub**: https://github.com/parnmanas/ai-workflow-board
- **MCP Specification**: https://modelcontextprotocol.io/

<!-- trigger deploy: 2026-05-26T22:23:45+09:00 -->
