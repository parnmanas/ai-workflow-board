# ============================================
# Stage 1: Install dependencies
# ============================================
FROM node:22-alpine AS deps

WORKDIR /app

# Copy root package files
COPY package.json package-lock.json* turbo.json ./

# Copy workspace package.json files
COPY apps/server/package.json apps/server/
COPY apps/client/package.json apps/client/

# Install all dependencies (hoisted to root node_modules)
RUN npm install --frozen-lockfile || npm install

# ============================================
# Stage 2: Build with Turborepo
# ============================================
FROM node:22-alpine AS builder

WORKDIR /app

# Copy all dependencies (npm workspaces hoists to root)
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/package-lock.json ./

# Copy all source files
COPY . .

# Build both client and server via turborepo
RUN npx turbo run build

# ============================================
# Stage 3: Production image
# ============================================
FROM node:22-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=7701

# `git` is needed at runtime for `git ls-remote --heads` against repository
# Resources (branch picker in the Ticket panel + Resource manager test).
# node:22-alpine omits it, so without this the branches endpoint fails with
# `spawn git ENOENT`.
RUN apk add --no-cache git

# Copy root package files for workspace resolution
COPY package.json package-lock.json* turbo.json ./
COPY apps/server/package.json apps/server/

# Copy server build output
COPY --from=builder /app/apps/server/dist ./apps/server/dist

# Copy client build output (served by NestJS ServeStaticModule)
COPY --from=builder /app/apps/client/dist ./apps/client/dist

# Install production dependencies only
RUN npm install --omit=dev --workspace=server

# Writable data dir for the server. Currently used by the Credentials
# encryption service to persist its auto-generated AES key when
# ENCRYPTION_KEY isn't set. Owned by `node` so the runtime user can
# create the key file; in compose this is the mount point for a named
# volume so the key survives container rebuilds.
RUN mkdir -p /app/data && chown node:node /app/data
ENV AWB_DATA_DIR=/app/data

# Drop to the `node` user baked into node:22-alpine. The server only
# writes to AWB_DATA_DIR at runtime (logs are in-memory, DB is external
# Postgres, SQLite code path is dev-only), so world-readable files from
# the root-owned install stages are fine for execution.
USER node

EXPOSE 7701

# Container-level health probe. Independent of deploy-side curl checks —
# lets Docker / Swarm / Kubernetes mark the container unhealthy when the
# DB connection dies or the process wedges without crashing.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD wget -qO- http://127.0.0.1:7701/api/health | grep -q '"status":"ok"' || exit 1

# Start the NestJS server (serves both API + static client)
CMD ["node", "apps/server/dist/main.js"]
