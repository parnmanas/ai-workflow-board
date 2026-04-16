# Technology Stack

**Analysis Date:** 2026-04-08

## Languages

**Primary:**
- TypeScript 5.6.0 - Used throughout client and server
- HTML/CSS - Client UI rendering

**Secondary:**
- JavaScript (Node.js) - Runtime and build tooling

## Runtime

**Environment:**
- Node.js (version specified via packageManager: npm@11.6.1)

**Package Manager:**
- npm 11.6.1
- Lockfile: package-lock.json present

## Frameworks

**Core:**
- NestJS 11.0.0 - Backend REST API framework
  - @nestjs/common, @nestjs/core, @nestjs/platform-express
- React 18.3.0 - Frontend UI library
- React Router 7.14.0 - Client-side routing

**Testing:**
- None detected in package.json (no jest, vitest, mocha configured)

**Build/Dev:**
- Vite 6.0.0 - Frontend bundler and dev server
  - @vitejs/plugin-react 4.3.0
- Turbo 2.4.0 - Monorepo build orchestration
- TypeScript 5.6.0 - Language compiler
- tsx 4.19.0 - TypeScript executor (server dev)

**Static Content Serving:**
- @nestjs/serve-static 5.0.0 - Serves client dist from server

## Key Dependencies

**Critical:**
- @modelcontextprotocol/sdk 1.29.0 - MCP server implementation (core feature)
- TypeORM 0.3.20 - ORM for database abstraction
  - @nestjs/typeorm 11.0.0 - NestJS TypeORM integration
- pg 8.20.0 - PostgreSQL client driver
- sql.js 1.12.0 - SQLite (for embedded database mode)

**Authentication & Security:**
- bcryptjs 3.0.3 - Password hashing (SALT_ROUNDS: 10)

**Data Validation:**
- zod 4.3.6 - Schema validation and type inference

**Utilities:**
- reflect-metadata 0.2.0 - Decorator metadata reflection (required by NestJS)
- rxjs 7.8.0 - Reactive programming library (NestJS dependency)
- dotenv - Environment variable loading in main.ts

**HTTP & API:**
- Express 5.0.0 (via @nestjs/platform-express) - Underlying HTTP server
- cors enabled via NestJS app configuration

## Configuration

**Environment:**
- Configured via environment variables (see .env section below)
- `.env` file expected (not committed, see docker-compose.env.example)
- Development mode: uses SQLite by default (auto-saves to database/data.db)
- Production mode: uses PostgreSQL

**Build:**
- `nest build` - Compiles server to dist/
- `tsc && vite build` - Builds client (TypeScript + Vite bundle)
- Turbo handles monorepo task orchestration
- Client dist served from server's static directory: `join(__dirname, '..', '..', 'client', 'dist')`

**Server Entry Points:**
- Development: `nest start --watch` (via tsx)
- Production: `node dist/main.js`
- Compiled output: `apps/server/dist/`

**Client Entry Points:**
- Development: Vite dev server on port 7700 (proxies /api and /mcp to 7701)
- Build output: `apps/client/dist/`
- React entry: `src/main.tsx`

## Platform Requirements

**Development:**
- Node.js with npm 11.6.1+
- Port 7700 available (Vite dev server)
- Port 7701 available (NestJS server)
- Port 5432 available (PostgreSQL, if using Postgres in dev)

**Production:**
- Docker and docker-compose (see docker-compose.yml)
- PostgreSQL 16-alpine (as service)
- Node.js runtime
- Port 7701 for server
- GitHub Container Registry access (image: ghcr.io/parnmanas/ai-workflow-board:latest)

## Database Configuration

**Default (Development):**
- Type: SQLite (sql.js)
- Location: `database/data.db` (auto-created)
- Auto-save enabled
- Synchronize enabled (auto-migrate schema)

**PostgreSQL (Production/Docker):**
- Port: 5432
- Connection via TypeORM DataSource
- Schema auto-sync disabled in production

**MySQL Support:**
- Also supported via TypeORM (configurable via DB_TYPE env var)

## Environment Variables

**Database:**
- `DB_TYPE` - 'sqlite' | 'postgres' | 'mysql' (default: sqlite)
- `DB_HOST` - Database hostname (default: localhost)
- `DB_PORT` - Database port (sqlite ignored, postgres 5432, mysql 3306)
- `DB_USER` - Database username (default: postgres/root)
- `DB_PASS` - Database password (required for production)
- `DB_NAME` - Database name (default: ai_workflow)

**Server:**
- `NODE_ENV` - 'development' | 'production'
- `PORT` - Server port (default: 7701)
- `CORS_ORIGIN` - CORS origin (default: true = reflect request origin in dev)

**MCP Integration:**
- `MCP_API_KEYS` - Comma-separated API keys, optionally with agent names (format: "agentName:key,key2")
- `MCP_DEV_MODE` - Set to 'true' to disable API key requirement in dev

**Agent API:**
- `AGENT_API_KEY` - Static API key for agent authentication (checked via X-Agent-Key header)
- `AGENT_DEV_MODE` - Set to 'true' to allow unauthenticated agent access

## Port Configuration

**Development:**
- 7700 - Vite client dev server (with /api and /mcp proxies)
- 7701 - NestJS server API and MCP endpoint

**Production:**
- 7701 - Combined server (serves client + API + MCP)

---

*Stack analysis: 2026-04-08*
