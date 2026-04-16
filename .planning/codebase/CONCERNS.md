# Codebase Concerns

**Analysis Date:** 2026-04-10

## Tech Debt

### Pervasive Type Safety Bypasses

**Issue:** Widespread use of `as any`, `unknown`, and untyped request bodies throughout codebase, undermining TypeScript's type safety benefits.

**Files:** 
- `apps/server/src/modules/tickets/tickets.controller.ts` (15+ instances: `body: any`, `req: any`, `c.images: JSON.parse(c.images)`)
- `apps/server/src/modules/auth/auth.controller.ts` (8+ instances: `(user as any).status`, `created as any`)
- `apps/server/src/modules/users/users.controller.ts` (6+ instances: `saved: User = (await save(created as any)) as any`)
- `apps/server/src/modules/mcp/mcp-tools.ts` (20+ instances: `null as any` for column_id defaults)
- `apps/server/src/database/database.module.ts` (2 instances: `where: { workspace_id: IsNull() as any }`)
- `apps/server/src/services/api-key.service.ts` (1 instance: `as any` in update query)

**Impact:** 
- Reduces IDE autocomplete effectiveness
- Increases likelihood of runtime type errors at boundaries
- Makes code harder to refactor safely
- Undermines the value of TypeScript as a safety tool
- 33+ `as any` instances found in codebase

**Fix Approach:**
1. Create typed DTO classes for request bodies (e.g., `CreateTicketDto`, `UpdateUserDto` using Zod)
2. Extract `resolveCreator()` type parameters from `any` objects into defined interfaces
3. Replace JSON parsing calls with strict parsing helpers with proper error handling
4. Use type guards for runtime checks on agent/user objects instead of unsafe casts

---

### In-Memory Session Storage Without Persistence

**Issue:** User sessions stored only in `AuthService.sessions` Map (in-memory), destroyed on server restart. No distributed session support.

**Files:** 
- `apps/server/src/services/auth.service.ts` (lines 18-31: `private sessions = new Map<string, Session>()`)

**Impact:** 
- Any server restart invalidates all user sessions (24-hour TTL hardcoded on line 14)
- Horizontal scaling impossible (sessions not shared across instances)
- No recovery mechanism for session loss during deployment
- Users must re-login on every server deployment
- No session replication for load-balanced setups

**Fix Approach:**
1. Migrate to Redis or database-backed sessions
2. Configure session TTL via environment variable (currently hardcoded `24 * 60 * 60 * 1000`)
3. Add graceful shutdown handler to persist active sessions
4. Support session replication across load-balanced instances
5. Consider signed JWT tokens with shorter TTL as alternative

---

### Inconsistent Error Handling in Background Tasks

**Issue:** Catch-all error handlers that silently swallow errors with `.catch(() => {})` or empty `catch {}` blocks, hiding failures.

**Files:**
- `apps/server/src/modules/mcp/mcp.controller.ts` (line 218: `.catch(() => {})` on transport.close)
- `apps/server/src/services/api-key.service.ts` (line 109: `.catch(() => {})` on use_count update)
- `apps/server/src/services/notification.service.ts` (lines 64, 300-318: multiple `.catch(() => null)`)
- `apps/server/src/mcp-server.ts` (line 111: `.catch(() => {})` on session cleanup)

**Impact:**
- API key use counts not incremented when update fails
- Notification failures go unlogged
- Silent failures make debugging harder
- No telemetry on background task health
- Operations appear successful but actually failed

**Fix Approach:**
1. Replace silent catches with proper logging: `.catch(e => logService.warn('Category', 'Operation failed', { error: e }))`
2. Add metrics/counters for failed operations
3. For non-critical operations (like use_count), log at `warn` level with context
4. Consider retry logic for transient failures with exponential backoff
5. Test error scenarios explicitly

---

### LogService In-Memory Unbounded Limit

**Issue:** LogService stores max 2000 entries in memory with hard-coded limit, losing older logs during high-volume periods.

**Files:** 
- `apps/server/src/services/log.service.ts` (lines 14-16: `private maxSize = 2000` hardcoded, no env config)

**Impact:**
- No persistent log history across restarts
- High-volume systems may lose critical error logs after 2000 entries
- No log rotation or archival strategy
- Admin UI logs incomplete during troubleshooting
- Cannot analyze historical issues

**Fix Approach:**
1. Make `maxSize` configurable via environment variable `LOG_MAX_SIZE` (default 2000)
2. Add periodic log rotation to files or external service (Datadog, Sentry, CloudWatch)
3. Implement log cleanup strategy (oldest-first FIFO or by category)
4. Add database table option for permanent audit logs with TTL-based cleanup
5. Export logs daily to cloud storage for long-term retention

---

## Known Bugs

### Ticket Column Lock TTL Depends on Server State

**Issue:** Expired ticket locks are only swept if NestJS server is running. Standalone `mcp-server.ts` relies on in-request TTL checks, creating inconsistent lock behavior between server modes.

**Files:**
- `apps/server/src/modules/agents/agent-connection.service.ts` (lines 29-37: comment explains NestJS-only lock sweep)
- `apps/server/src/mcp-server.ts` (no lock sweep interval defined, relies on claim_ticket TTL checks)

**Trigger:** 
1. Agent claims ticket via MCP (lock acquired with `locked_by_agent_id` and `locked_at`)
2. Agent crashes or disconnects without releasing lock
3. Lock TTL expires (30 min default in `LOCK_TTL_MS`)
4. If only standalone MCP server running: lock expires in-request only when someone calls claim_ticket
5. If NestJS running: sweep happens every 60 seconds via `sweepExpiredLocks()`

**Impact:**
- Tickets may appear locked to users even though agent is offline
- Different behavior when running standalone vs with NestJS
- No automatic lock cleanup in standalone mode

**Workaround:** Always run NestJS server alongside standalone MCP server, or manually clear locks.

**Fix Approach:**
1. Add identical lock sweep loop to standalone `mcp-server.ts` (copy lines from `agent-connection.service.ts`)
2. Or, persist lock acquisition time in database and check on every tool call
3. Or, make lock sweep available as MCP tool that agents can call
4. Document requirement that both servers must run together

---

### Orphan Board Cleanup Runs on Every Server Start

**Issue:** `DatabaseModule.onModuleInit()` creates a workspace for orphan boards every time server initializes, potentially duplicating workspaces if server restarts quickly.

**Files:** 
- `apps/server/src/database/database.module.ts` (lines 100-125: orphan board check and workspace creation in onModuleInit)

**Trigger:** 
1. Server starts normally (or restarts due to crash)
2. Orphan boards found (boards with `workspace_id = NULL`)
3. New workspace created with name 'Orphaned Boards' even if one already exists
4. Server restarts again → another workspace created

**Impact:** 
- Multiple "Orphaned Boards" workspaces if server restarts during migration
- Orphaned boards scattered across multiple workspaces over time
- Users confused by duplicate workspaces

**Workaround:** Manual cleanup via admin panel to merge orphaned workspaces.

**Fix Approach:**
1. Check if "Orphaned Boards" workspace already exists before creating: `SELECT * FROM workspaces WHERE name = 'Orphaned Boards'`
2. Or, run cleanup as a one-time migration with flag, not on every init
3. Or, add idempotency key (e.g., `created_at`) to prevent duplicates
4. Document this as a migration step that should only run once

---

## Security Considerations

### API Keys Exposed in Logs

**Risk:** When logging MCP authentication info, API keys (or hashed versions) may appear in logs if auth fails.

**Files:**
- `apps/server/src/modules/mcp/mcp.controller.ts` (lines 42-45: `maskKey()` function used in logging)
- `apps/server/src/services/api-key.service.ts` (line 17-20: maskKey implementation)

**Current Mitigation:** 
- `maskKey()` masks keys before logging: `key.slice(0, 8) + '***' + key.slice(-4)`
- Only masked versions appear in logs (e.g., `awb_12345***6789`)

**Recommendations:**
1. Ensure raw keys never logged anywhere (grep for `apiKey`, `MCP_API_KEYS`)
2. Add token/secret scrubber to LogService to catch missed cases automatically
3. Consider separate audit log for API key operations (creation, revocation, rotation)
4. Never log full raw key even in error cases

---

### Password Validation Insufficient

**Risk:** Password minimum length is only 8 characters, with no complexity requirements. Below NIST recommendations.

**Files:**
- `apps/server/src/modules/auth/auth.controller.ts` (line 92: `if (password.length < 8)`)

**Current Mitigation:** 
- SALT_ROUNDS = 10 (proper bcrypt strength per line 13 of auth.service.ts)
- Passwords hashed with bcryptjs

**Recommendations:**
1. Increase minimum to 12+ characters (NIST best practice)
2. Add password complexity check (uppercase, lowercase, digits, symbols)
3. Make minimum length configurable via `MIN_PASSWORD_LENGTH` env var
4. Add password breach check against HaveIBeenPwned API
5. Consider rate limiting on auth endpoints to prevent brute force

---

### In-Memory Session Storage Vulnerable to Memory Inspection

**Risk:** If process memory is inspected (e.g., via /proc in Linux containers), active sessions could be extracted.

**Files:**
- `apps/server/src/services/auth.service.ts` (line 18: `private sessions = new Map()`)

**Current Mitigation:** 
- Session tokens are 32-byte random hex strings (256-bit entropy, line 43)
- No session data exposed in logs
- Sessions cleared on logout

**Recommendations:**
1. Migrate to cryptographically signed session cookies (JWT) with shorter TTL
2. Add CSRF token support for state-changing operations
3. Consider HttpOnly flag for session cookies
4. Implement session binding to user agent and IP address
5. Use rotating tokens (refresh + access token pattern)

---

### MCP API Key Scope Not Validated

**Risk:** MCP API keys have a `scope` field (default: 'full') but scopes are never checked at request time.

**Files:**
- `apps/server/src/entities/ApiKey.ts` (has scope column)
- `apps/server/src/modules/mcp/mcp.controller.ts` (authenticates but doesn't enforce scope)
- `apps/server/src/modules/mcp/mcp-tools.ts` (no scope checks on tools)

**Current Mitigation:** 
- Scope field exists and is stored
- Logged in auth info but never enforced

**Recommendations:**
1. Define scope levels (e.g., 'read', 'write', 'admin', 'full')
2. Document what each tool requires (e.g., claim_ticket needs 'write')
3. Check scope in McpAgentContext before executing tools
4. Reject with 403 if scope insufficient

---

## Performance Bottlenecks

### Ticket Hierarchy Loading All Children at Every Level

**Issue:** `loadTicketFull()` eagerly loads all 3 levels of children (ticket → children → grandchildren), even if UI only displays 1 or 2 levels.

**Files:**
- `apps/server/src/modules/tickets/tickets.controller.ts` (lines 45-55: relations array with `children.children`)
- `apps/server/src/modules/mcp/mcp-tools.ts` (lines 116-144: same eager loading pattern)

**Impact:** 
- Deep nesting causes exponential child loads (N children × N children × N children = O(N³) complexity)
- Large memory footprint for tickets with many descendants (1000+ children × 1000+ grandchildren)
- Slow JSON serialization of deeply nested structures
- Network payload bloats with unused data (could be 10+ MB for deeply nested tickets)
- Database query time increases exponentially with depth

**Improvement Path:**
1. Accept optional depth parameter (1, 2, or 3 levels)
2. Default to depth=2 (children + comments only, no grandchildren)
3. Lazy-load grandchildren on demand from frontend (separate API call)
4. Cache full ticket trees with TTL to avoid repeated loads
5. For large hierarchies, implement pagination of children

---

### LogService Query Filters Entire In-Memory Log Array

**Issue:** `LogService.query()` applies filters by iterating entire log array in memory without indexes.

**Files:**
- `apps/server/src/services/log.service.ts` (lines 52-62: multiple filter passes over `this.logs`)

**Impact:** 
- Admin log viewer slow with 2000+ entries (O(n) per filter)
- Multiple filters require multiple passes (5 filters = 5 full scans)
- No pagination support (all 2000 returned at once)
- UI blocks while filtering large logs

**Improvement Path:**
1. Add pagination support (limit/offset)
2. Create in-memory index by category and level (Map<string, LogEntry[]>)
3. Or, externalize logs to TimescaleDB with proper indexing
4. Add search index on message text using simple substring matching or full-text search

---

### MCP Session Cleanup Interval Fixed at 2 Minutes

**Issue:** Sessions cleaned up only every 2 minutes, TTL is 10 minutes. Sessions may stay in memory 2+ minutes after expiry.

**Files:**
- `apps/server/src/modules/mcp/mcp.controller.ts` (lines 213-227: `setInterval(..., 2 * 60 * 1000)` hardcoded)

**Impact:** 
- Memory bloat if many agents connect and disconnect rapidly (1000+ sessions created/destroyed per minute)
- Unbounded session map growth between cleanups
- Max 2000 stale sessions in memory during high-churn periods

**Fix Approach:**
1. Make cleanup interval configurable: `MCP_SESSION_CLEANUP_MS` env var
2. Default to 1 minute (faster cleanup)
3. Consider heap-based priority queue for O(log n) eviction instead of O(n) scan
4. Or, use lazy cleanup on each request (check expiry when session used)
5. Add metrics for session count and cleanup efficiency

---

### Agent Trigger Dispatch on Every Activity Event

**Issue:** `TriggerLoopService` runs complex database queries on EVERY activity event (moved, updated, comment created), even if event shouldn't create triggers.

**Files:**
- `apps/server/src/modules/agents/trigger-loop.service.ts` (lines 60-140: _handleActivity runs for every activity)

**Impact:** 
- 10 activities = 10 trigger resolution queries (board routing config lookup, agent resolution)
- Under heavy activity (100 events/minute), generates 100 database queries just for trigger checking
- Cooldown checks add additional queries per trigger

**Improvement Path:**
1. Add caching of routing_config per board (with TTL)
2. Batch trigger creation instead of one-by-one
3. Skip trigger dispatch for non-triggerable event types (e.g., 'viewed', 'commented')
4. Add metrics to track trigger dispatch overhead

---

## Fragile Areas

### Routing Config JSON Parsing Without Schema Validation

**Files:** 
- `apps/server/src/modules/agents/trigger-loop.service.ts` (lines 120-122: `safeJsonParse()` returns {} if parse fails)
- `apps/server/src/modules/mcp/mcp-tools.ts` (lines 111-114: same function)

**Why Fragile:** 
- If routing_config malformed in database, silently falls back to `{}`
- No error logged when parsing fails
- Invalid routes don't trigger tickets (silent failure)
- Admin has no indication config is broken

**Safe Modification:**
1. Add explicit routing config schema validation (Zod or similar)
2. Reject updates with invalid routing_config in API with clear error message
3. Add database migration to validate and fix any existing malformed configs
4. Log warning when fallback parsing occurs

**Test Coverage Gaps:**
- No tests for malformed routing_config recovery
- No tests for missing agent resolution

---

### MCP Controller Authentication Logic Complex

**Files:**
- `apps/server/src/modules/mcp/mcp.controller.ts` (lines 242-340: `authenticate()` method, ~100 lines)

**Why Fragile:** 
- Supports 4 auth sources: DB keys (ApiKey table), ENV keys (MCP_API_KEYS), AGENT_API_KEY header, dev mode
- Multiple fallback paths (line 246-248: check Authorization, then x-api-key)
- maskKey() logic duplicated between controller and ApiKeyService
- Complex conditional logic for dev mode bypass

**Safe Modification:**
1. Extract auth logic to shared `McpAuthService` singleton
2. Write decision tree tests for all 4 auth paths
3. Add coverage for auth source precedence (which one wins if multiple set)
4. Consolidate maskKey() to single implementation

**Test Coverage Gaps:**
- No tests for mixed DB + ENV key scenarios
- No tests for key expiry during active session
- No tests for AGENT_API_KEY header fallback
- No tests for dev mode bypass conditions

---

### Comment Image Upload Size Limits Not Enforced at DB Level

**Files:**
- `apps/server/src/modules/tickets/tickets.controller.ts` (lines 12-13: `MAX_IMAGE_SIZE = 5MB`, `MAX_IMAGES_PER_COMMENT = 5`)

**Why Fragile:** 
- Limits are checked in controller, but not enforced by Comment entity
- No database constraint prevents oversized image JSON (Comment.images is just varchar)
- MCP tools might bypass image size limits (no validation in `add_comment` tool in mcp-tools.ts)
- No validation on total Comment payload size

**Safe Modification:**
1. Add `@Column({ type: 'longtext' })` with max length constraint to Comment.images
2. Or, move images to separate table with size constraints
3. Validate image payloads in MCP tools
4. Add pre-save hook to Comment entity to validate image count and size

**Test Coverage Gaps:**
- No tests for image upload size limits
- No tests for 5+ image rejection
- No tests for image validation in MCP tools

---

## Scaling Limits

### In-Memory Logs Capped at 2000 Entries

**Current Capacity:** 
- 2000 log entries in memory
- Each entry ~200 bytes = ~400 KB overhead

**Limit:** 
- System logs 100+ entries per minute during active operation
- 2000 entries = ~20 minutes of history only
- After 20 minutes of activity, oldest logs discarded

**Scaling Path:**
1. Externalize logs to database table (ActivityLog already exists, reuse for logs)
2. Or, ship logs to external service (DataDog, Cloudflare, CloudWatch, Sentry)
3. Keep in-memory cache of last 100 entries for fast admin UI access
4. Implement log archival (e.g., daily export to S3)

---

### Session Map Unbounded Growth (NestJS & MCP)

**Current Capacity:** 
- AuthService: ~100 concurrent users per process (24-hour TTL)
- McpController: ~50 concurrent MCP sessions per instance (10-minute TTL, cleanup every 2 min)

**Limit:** 
- Each session ~500 bytes overhead in memory
- 100 auth sessions = ~50 KB per service instance
- 50 MCP sessions = ~25 KB per instance
- No automatic cleanup if client crashes without unsubscribe
- Horizontal scaling with 10 instances = 500 sessions in memory total

**Scaling Path:**
1. Migrate to Redis sessions (supports 10k+ concurrent connections)
2. Add connection pool limits with queue
3. Implement LRU eviction if memory usage exceeds threshold
4. Use persistent session store (database) for clustering

---

### Activity Log Unbounded Database Growth

**Issue:** ActivityLog table has no retention policy and grows unbounded.

**Files:**
- All modules write to `ActivityLog` via `ActivityService` (emitted on activity event)
- `DatabaseModule` has no cleanup job

**Current Capacity:** 
- Assume 500 activity logs per day
- After 1 year: 180k rows (queries still fast with index)
- After 3 years: 540k rows (full table scans slow, need index on created_at)

**Scaling Path:**
1. Add `LOG_RETENTION_DAYS` environment variable (default 90 days)
2. Create migration to add index on `created_at`
3. Add cleanup job (cron or trigger) to delete logs older than retention period
4. Archive old logs to S3/blob storage if audit trail required
5. Implement partitioning by date if table grows beyond 10M rows

---

## Dependencies at Risk

### TypeORM Version 0.3.20 (Older Minor)

**Risk:** TypeORM 0.3.x is stable but 0.4+ available with breaking changes in relation syntax. Security patches may not be backported indefinitely.

**Current:** `0.3.20` in package-lock.json
**Latest:** `0.4.x` (breaking changes in relation/join syntax)

**Impact:** 
- May miss security patches if 0.3.x support ends
- Migration to 0.4.x requires code changes in entity definitions
- SQLJS support may change or be deprecated

**Migration Plan:** 
1. Audit 0.4.x breaking changes (especially relation syntax)
2. Create feature branch for 0.4.x upgrade
3. Test with SQLite, PostgreSQL, MySQL
4. Update CI to test against new version before merge

---

### @modelcontextprotocol/sdk Version Stability

**Risk:** MCP SDK is rapidly evolving. Current `1.29.0` may have breaking changes in 2.x.

**Current:** `1.29.0` in package-lock.json
**Latest:** Likely 1.30+ or 2.x by time of use

**Impact:** 
- Agent compatibility may break with SDK upgrades
- HTTP transport and tool registration signatures may change
- Downstream consumers of AWB may face breaking changes

**Migration Plan:**
1. Monitor SDK releases for breaking changes via GitHub/npm
2. Test new MCP SDK versions in feature branch before pinning
3. Consider pinning to exact version (not ^) to prevent surprises
4. Maintain compatibility layer if major version change required

---

## Missing Critical Features

### No Bulk Operation Support

**Problem:** Cannot bulk-assign, bulk-move, or bulk-update multiple tickets at once. Users must update each ticket individually.

**Blocks:** 
- Kanban board usability at scale (10+ tickets to move, requires 10+ clicks)
- Agent batch operations (e.g., "move all tickets in Review to Done")
- Spreadsheet-like bulk editing workflows

**Implementation Path:**
1. Add `/api/tickets/bulk` endpoint accepting array of ticket IDs + operation (move, update, assign)
2. Add MCP tools `bulk_move_tickets` and `bulk_update_tickets`
3. Keep activity logs per ticket (don't batch logs, one log entry per ticket for traceability)
4. Validate permissions per ticket before applying bulk operation

---

### No Comment Threading/Replies

**Problem:** Comments are flat list, not threaded. Hard to follow conversations on tickets with many comments.

**Blocks:**
- Team collaboration on complex tickets (unclear which comment references which)
- Agent → Human feedback loops unclear (no way to mark "this is reply to X comment")

**Implementation Path:**
1. Add `parent_comment_id` to Comment entity (nullable foreign key to Comment)
2. Add `threaded_view` toggle in frontend TicketDetail component
3. Preserve flat list for MCP tool output (for simplicity)
4. Add depth limit (e.g., max 5 levels of nesting)

---

### No Undo/Revert Mechanism

**Problem:** Ticket state changes cannot be undone except by manual reversal. Accidental moves or updates are permanent until fixed manually.

**Blocks:**
- Accidental ticket moves (no rollback to previous column)
- Data recovery after agent mistakes
- Reverting bulk operations that went wrong

**Implementation Path:**
1. Leverage ActivityLog as event store (already tracks all changes with old_value/new_value)
2. Add `/api/tickets/{id}/undo` endpoint that reverts last state change for that ticket
3. Limit undo to last 24 hours of changes (prevent data corruption from very old reverts)
4. Require admin or ticket owner permission to undo
5. Log undo operations in ActivityLog as well

---

*Concerns audit: 2026-04-10*
