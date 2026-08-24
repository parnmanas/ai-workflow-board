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
#
# `--ignore-scripts` — 이 스테이지의 node_modules 는 builder 로 그대로 복사돼
# 배포 산출물(client/server dist)을 만든다. 즉 여기서 도는 서드파티
# preinstall/install/postinstall 은 **root 권한으로, 배포될 아티팩트를 만드는
# 트리 안에서** 임의 코드로 돈다. lockfile 축 허용목록
# (scripts/audit-install-scripts.mjs — esbuild/fsevents/@scarf/scarf)은 "어떤
# 패키지가 스크립트를 갖는가" 를 감시할 뿐 "그게 배포 이미지 빌드에서 돌아도
# 되는가" 는 묻지 않는다.
#
# 셋 다 이 플래그로 잃는 것이 없음을 실측 확인했다(2026-08-24 감사):
#   - esbuild — 바이너리는 postinstall 다운로드가 아니라 플랫폼 optionalDependency
#     (`@esbuild/linux-x64`)로 온다. `--ignore-scripts` 설치 후 transform/bundle
#     정상 동작 확인.
#   - fsevents — macOS 전용 optional. 리눅스 이미지엔 애초에 설치되지 않는다.
#   - @scarf/scarf — 텔레메트리. postinstall 이 child_process.exec + scarf.sh
#     HTTPS 전송을 한다. 루트 package.json 의 `scarfSettings.enabled:false` 는
#     **그 스크립트가 스스로 읽는 옵트아웃**이라 실행을 넘겨준 뒤의 선의에 기댄다.
# 실측: 이 플래그로 `npm ci` + `turbo run build` 3/3 스테이지 정상 빌드.
RUN npm ci --ignore-scripts

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

# Built-in global skill pack. Plain markdown, seeded into the GLOBAL skill
# scope at boot (BuiltinSkillPackService) so a fresh install has a usable skill
# set with no network access and no operator action. Seeding is idempotent and
# append-only, so re-running it on every container start is free — "always
# latest" is a property of upgrading this image, not of a runtime fetch.
# Operators tracking their own pack override the path with
# AWB_BUILTIN_SKILLS_DIR (typically a mounted git checkout).
COPY skills ./skills

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
#
# `--ignore-scripts` (2026-08-24 감사) — 이 스테이지는 **실제로 배포되는 레이어**다.
# 여기서 도는 install script 는 root 권한으로 최종 이미지에 무엇이든 남길 수 있다.
# 실측한 이 트리(247 패키지)의 install-script 패키지는 `@scarf/scarf` 하나뿐이고
# (swagger-ui-dist 의 비-optional 의존성 → @nestjs/swagger 경유로 prod 트리에 있다)
# 순수 텔레메트리라 실행할 이유가 전혀 없다. 플래그 적용 후 247 패키지 설치 →
# @ast-grep/napi · @node-rs/xxhash · sql.js 네이티브 로드 정상, 서버 부팅 정상 확인.
RUN npm ci --omit=dev --workspace=server --ignore-scripts

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
