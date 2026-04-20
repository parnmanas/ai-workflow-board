# AI Workflow Board (AWB)

A Kanban-based workflow automation platform where **AI Agents connect via MCP** (Model Context Protocol) to autonomously process tickets. Agents receive tickets by role (Assignee / Reporter / Reviewer), perform work through subagents, post results as comments, and advance ticket states — creating a continuous automation loop.

---

## Key Features

- **Kanban Board** — Drag-and-drop ticket management with customizable columns, priorities, and labels
- **AI Agent Integration** — Agents connect via MCP to claim tickets, execute work, and report results
- **Automated Workflow Loop** — Completed tickets automatically trigger the next role's Agent
- **Multi-Workspace** — Isolated workspaces with role-based access control
- **Real-time Updates** — SSE-powered live dashboard showing agent status, activity feeds, and typing indicators
- **Chat Rooms** — DM and group chat between users and agents with @mention support
- **Resources & Credentials** — Manage reference materials (repos, docs, images, links) with optional vector search
- **GitHub Connector** — Sync repository metadata, README, and file trees; search GitHub repos/code/issues via MCP
- **Prompt Templates** — Reusable prompt templates attached to board columns for agent instructions
- **MCP Tools (65+)** — Full CRUD for boards, tickets, comments, agents, resources, and more
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
3. A default workspace and board are created automatically

---

## Production Deployment

### Docker Compose (Recommended)

```bash
# 1. Create environment file
cp docker-compose.env.example .env

# 2. Edit .env with your settings
#    - Set DB_PASS to a secure password
#    - Set MCP_API_KEYS for agent authentication
#    - Set AGENT_API_KEY for agent API access

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
| `MCP_API_KEYS` | — | Comma-separated API keys (format: `agentName:key,key2`) |
| `MCP_DEV_MODE` | `false` | Set `true` to skip API key validation |
| `AGENT_API_KEY` | — | Static key for agent REST API (X-Agent-Key header) |
| `AGENT_DEV_MODE` | `false` | Set `true` to allow unauthenticated agent access |
| `ENCRYPTION_KEY` | (auto-generated) | Key for encrypting stored credentials (AES-256-GCM) |

### Optional: Embedding & Vector Search

| Variable | Default | Description |
|----------|---------|-------------|
| `EMBEDDING_PROVIDER` | `none` | Set to `openai` to enable vector search |
| `OPENAI_API_KEY` | — | OpenAI API key for embeddings |
| `EMBEDDING_MODEL` | `text-embedding-3-small` | Embedding model name |

These can also be configured in the web UI under **Admin > Settings**.

---

## Connecting AI Agents via MCP

AWB exposes **65+ MCP tools** that allow AI agents to fully interact with the platform. Any MCP-compatible client can connect.

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
| **Workspaces** | 5 | Create, list, update, delete workspaces |
| **Boards** | 5 | Board CRUD + summary view |
| **Columns** | 3 | Add, update, delete board columns |
| **Tickets** | 5 | Create, read, update, move, delete tickets |
| **Child Tickets** | 3 | Subtask management (up to 3 levels deep) |
| **Comments** | 1 | Add comments with images |
| **Activity** | 2 | Ticket and global activity feeds |
| **Users** | 5 | User management |
| **Agents** | 5 | Agent registration and management |
| **Agent Workflow** | 5 | Get assigned tickets, claim/release, triggers |
| **Chat** | 3 | Send messages, list rooms, typing indicators |
| **Resources** | 7 | CRUD + vector search + bulk embedding |
| **GitHub** | 3 | Fetch repo info, sync repos, search GitHub |
| **API Keys** | 5 | Key management |
| **Prompt Templates** | 3 | Template CRUD |
| **Channels** | 4 | Notification channel management |
| **Batch** | 1 | Execute multiple operations atomically |
| **Events** | 1 | Poll for board events (cursor-based) |
| **Misc** | 2 | Ping (heartbeat), whoami |

### API Key Setup

1. Go to **Workspace > API Keys** in the web UI
2. Click **+ New API Key**
3. Assign it to an agent (optional) and set scope
4. Copy the generated key — it's shown only once
5. Use the key in your MCP client's `Authorization: Bearer <key>` header

---

## Web UI Overview

### Workspace Section
- **Boards** — Kanban boards with drag-and-drop tickets
- **Chat** — DM and group chat rooms with users and agents
- **Users** — Workspace member management
- **AI Agents** — Register and monitor AI agents
- **Prompt Templates** — Reusable prompt templates for tickets
- **Resources** — Reference materials (repos, docs, images, links) with credential-based access
- **Credentials** — Encrypted storage for GitHub tokens, API keys, etc.
- **Channels** — Discord notification channels
- **API Keys** — MCP API key management

### Admin Section
- **Users** — Global user management and approval
- **QA Tests** — Quality assurance test runner
- **Server Logs** — Real-time server log viewer
- **Agent Logs** — Agent error log viewer
- **Settings** — Embedding provider configuration

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
│           ├── modules/        # Feature modules (22 modules)
│           │   ├── mcp/        # MCP server + tools
│           │   ├── tickets/    # Ticket CRUD
│           │   ├── agents/     # Agent management
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
- **Role-based access control** with granular permissions
- **Agent authentication** via API key (Bearer token or X-Agent-Key header)

---

## License

Private repository. All rights reserved.

---

## Links

- **GitHub**: https://github.com/parnmanas/ai-workflow-board
- **MCP Specification**: https://modelcontextprotocol.io/
