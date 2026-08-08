# ============================================
# Stage 1: Install dependencies
# ============================================
# Base는 debian-slim(glibc). musl(alpine)은 시놀로지처럼 오래된 libseccomp 가
# getrandom(2) 을 ENOSYS 로 막으면 /dev/urandom 폴백이 약해 git bare clone 이
# 죽는다(Resource History 실패). glibc 는 ENOSYS 시 /dev/urandom 으로 자동
# 폴백하므로 seccomp 를 건드리지 않고 풀린다. (티켓 b2ea5876)
# musl↔glibc ABI 가 갈리면 native 모듈이 깨지므로 세 스테이지 모두 slim 으로 통일.
FROM node:22-slim AS deps

WORKDIR /app

# Copy root package files
COPY package.json package-lock.json* turbo.json ./

# Copy workspace package.json files
COPY apps/server/package.json apps/server/
COPY apps/client/package.json apps/client/
COPY apps/agent-manager/package.json apps/agent-manager/

# Install all dependencies (hoisted to root node_modules)
RUN npm ci

# ============================================
# Stage 2: Build with Turborepo
# ============================================
FROM node:22-slim AS builder

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
FROM node:22-slim AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=7701

# `git` is needed at runtime for `git ls-remote --heads` against repository
# Resources (branch picker in the Ticket panel + Resource manager test) and the
# bare cache clone behind Resource History. `wget` backs the HEALTHCHECK below.
# `--no-install-recommends` does not guarantee Debian's CA bundle arrives with
# git/wget, so install it explicitly; without it GitHub HTTPS fails with
# "server certificate verification failed. CAfile: none".
RUN apt-get update && apt-get install -y --no-install-recommends git wget ca-certificates \
    && update-ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Copy root package files for workspace resolution
COPY package.json package-lock.json* turbo.json ./
COPY apps/server/package.json apps/server/

# Copy server build output
COPY --from=builder /app/apps/server/dist ./apps/server/dist

# Copy client build output (served by NestJS ServeStaticModule)
COPY --from=builder /app/apps/client/dist ./apps/client/dist

# Install production dependencies only.
#
# `npm ci`, not `npm install` — 이 스테이지가 배포 이미지의 런타임 트리를
# 만든다. `npm install` 은 lockfile 을 "제안"으로만 취급해서, 같은 커밋을
# 두 번 빌드해도 semver 범위 안에서 다른 버전으로 해결될 수 있고,
# 컨테이너 안의 package-lock.json 을 실제로 덮어쓴다(런너 레이아웃 재현
# 실험에서 1743 라인 변경 — 워크스페이스가 `extraneous` 로 표시되고 dev
# 엔트리가 잘려나감). 즉 `npm audit` 으로 감사한 트리와 배포된 트리가
# 같다는 보장이 없었다. `npm ci` 는 lockfile 을 그대로 강제하고 integrity
# 해시 불일치 시 실패하므로, 감사 대상 == 배포 대상이 성립한다.
#
# 이 레이아웃(루트 package.json + lockfile + apps/server/package.json 만
# 존재)에서도 `npm ci --workspace=server` 는 정상 동작하며, 설치 결과 트리는
# 기존 `npm install` 과 패키지 200개 전부 동일하다 — 동작 변화 없음.
RUN npm ci --omit=dev --workspace=server

# Writable data dir for the server. Currently used by the Credentials
# encryption service to persist its auto-generated AES key when
# ENCRYPTION_KEY isn't set. Owned by `node` so the runtime user can
# create the key file; in compose this is the mount point for a named
# volume so the key survives container rebuilds.
RUN mkdir -p /app/data && chown node:node /app/data
ENV AWB_DATA_DIR=/app/data

# Drop to the `node` user baked into node:22-slim. The server only
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
