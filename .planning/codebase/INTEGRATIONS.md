# External Integrations

**Analysis Date:** 2026-04-08

## APIs & External Services

**Model Context Protocol (MCP):**
- Service: OpenAI/Anthropic MCP server for AI agent integration
  - SDK/Client: @modelcontextprotocol/sdk 1.29.0
  - Endpoint: `/mcp` on server (port 7701)
  - Auth: MCP_API_KEYS environment variable or database API keys
  - Transport: WebStandardStreamableHTTPServerTransport (HTTP streaming)
  - Tools: 33 registered MCP tools for workflow board management (mcp-tools.ts)

**Discord API:**
- Service: Discord webhooks for channel notifications
  - Implementation: `apps/server/src/services/discord.service.ts`
  - API Version: Discord API v10
  - Endpoint: https://discord.com/api/v10/channels/{channel_id}/messages
  - Auth: Discord bot token stored per channel (Channel.bot_token)
  - Features:
    - Rate limit handling with automatic retry (max 10s wait)
    - Embed message formatting support
    - Connection testing endpoint

## Data Storage

**Databases:**
- **SQLite (default/development):**
  - Client: sql.js 1.12.0
  - Location: `database/data.db`
  - Auto-save enabled
  - No external dependency (file-based)

- **PostgreSQL (production):**
  - Client: pg 8.20.0 (native PostgreSQL driver)
  - Version: 16-alpine (Docker service)
  - ORM: TypeORM 0.3.20
  - Connection pooling: Via pg driver
  - Schema auto-sync: Disabled in production

- **MySQL (supported):**
  - ORM: TypeORM 0.3.20
  - Port: 3306 (default)
  - Currently not used in provided configs

**ORM/Database Interface:**
- TypeORM 0.3.20 - Abstraction layer for all database operations
  - @nestjs/typeorm 11.0.0 - NestJS integration module
  - DataSource pattern: Central AppDataSource in `apps/server/src/db.ts`
  - Entities defined in `apps/server/src/entities/`

**File Storage:**
- Local filesystem only
- Image attachments: Stored in database comments (not analyzed in detail)
- No external storage service (S3, etc.) configured

**Caching:**
- None detected

## Authentication & Identity

**Custom Session-Based Auth:**
- Implementation: `apps/server/src/services/auth.service.ts`
- Method: Session tokens (random 32-byte hex, 24hr TTL)
- Password hashing: bcryptjs (SALT_ROUNDS: 10)
- Session storage: In-memory map with 5-minute cleanup interval
- Entity: User table stores credentials and workspace associations

**MCP API Key Authentication:**
- Storage: ApiKey entity (database) + environment variable
- Format: "awb_" prefix + 20 random hex bytes
- Validation: Against both database keys and MCP_API_KEYS environment variable
- Masking: Last 4 characters visible, rest masked in logs (security.ts)
- Scope support: Per-key scope field ('full' default)
- Expiration: Optional expires_at timestamp

**Agent API Key Authentication:**
- Implementation: `apps/server/src/common/guards/agent-auth.guard.ts`
- Method: X-Agent-Key header validation
- Source: AGENT_API_KEY environment variable (single key, no database storage)
- Dev mode: AGENT_DEV_MODE=true bypasses authentication
- Used by: `/api/agent/*` endpoints for external agent integrations

## Monitoring & Observability

**Error Tracking:**
- None detected (no Sentry, DataDog, etc.)

**Logs:**
- Centralized: `apps/server/src/services/log.service.ts`
- Method: Custom LogService class (injected across modules)
- Output: Console (logs formatted with timestamp and category)
- Categories: 'System', 'MCP', 'Discord', 'Auth', etc.
- Logged at startup: Server port, MCP endpoint, MCP auth status, API key management endpoint

**Activity Logging:**
- Entity-level audit trail: ActivityLog entity
- Tracked: Entity changes (created, updated, deleted, moved)
- Fields: entity_type, entity_id, action, field_changed, old_value, new_value, actor_id, actor_name, ticket_id
- Event-driven: Emitted via activityEvents EventEmitter (activity.service.ts)

## CI/CD & Deployment

**Hosting:**
- Docker / Docker Compose (production)
- Container registry: GitHub Container Registry (ghcr.io/parnmanas/ai-workflow-board:latest)

**CI Pipeline:**
- Not detected in provided files
- Likely configured in GitHub Actions (not visible in codebase)

**Docker Deployment:**
- Orchestration: docker-compose.yml at root
- Services:
  - `db` - PostgreSQL 16-alpine (port 5432)
  - `server` - Application container (port 7701)
- Volume: pgdata for persistent database storage
- Environment: Loaded from .env file (see docker-compose.env.example)

## Environment Configuration

**Required env vars (Production):**
- `DB_PASS` - Database password (enforced with :? syntax in docker-compose.yml)
- `DB_NAME` - Database name (default: ai_workflow)
- `DB_USER` - Database username (default: postgres)
- `NODE_ENV` - Set to 'production' for production mode
- `PORT` - Server port (default: 7701)

**Optional env vars:**
- `MCP_API_KEYS` - Comma-separated API keys with optional agent names
- `AGENT_API_KEY` - Agent authentication key
- `CORS_ORIGIN` - Custom CORS origin (default: true = reflect request)
- `MCP_DEV_MODE` - 'true' to disable MCP API key requirement
- `AGENT_DEV_MODE` - 'true' to disable agent API key requirement

**Secrets location:**
- Environment variables (loaded from .env or docker-compose .env)
- No .env file in repository (see .gitignore)
- Example config: docker-compose.env.example

## Webhooks & Callbacks

**Incoming:**
- `/mcp` - MCP protocol endpoint (accepts JSON-RPC messages)
  - POST for JSON-RPC calls
  - JSON-RPC 2.0 compliant
  - Authentication via MCP_API_KEYS or database API keys
  - Used by: AI agents, Claude for Slack, other MCP clients

**Outgoing:**
- Discord webhooks: `https://discord.com/api/v10/channels/{channel_id}/messages`
  - Triggered by: Ticket creation, update, status change, comments
  - Controlled by: Channel notification flags (notify_on_status_change, notify_on_update, notify_on_comment)
  - Sent via: DiscordService (discord.service.ts)

## API Endpoints

**Public/Agent API:**
- `/api/agent/*` - External agent endpoints (requires AGENT_API_KEY)
  - Guarded by: AgentAuthGuard

**Protected API:**
- `/api/*` - Internal API endpoints
  - Users endpoint
  - Workspaces endpoint
  - Boards endpoint
  - Columns endpoint
  - Tickets endpoint
  - Comments endpoint
  - Channels endpoint (with Discord integration)
  - Admin endpoints
  - API keys management (listing, creating)
  - Activity logs endpoint

**Unprotected:**
- `/api/health` - Health check endpoint
- Static routes - Client assets (served from client/dist)

## Integration Summary

| Integration | Type | Status | Priority |
|------------|------|--------|----------|
| MCP Protocol | API | Core | Critical |
| Discord | Webhook | Optional | High |
| PostgreSQL | Database | Production | Critical |
| SQLite | Database | Development | Critical |
| Session Auth | Internal | Core | Critical |
| API Key Auth | Internal | Core | Critical |

---

*Integration audit: 2026-04-08*
