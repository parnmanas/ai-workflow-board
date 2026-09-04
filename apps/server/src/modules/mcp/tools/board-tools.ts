/**
 * Board MCP tools.
 *
 * Tools: list_boards, get_board, get_board_summary, create_board, update_board,
 *        delete_board, move_board_to_workspace
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { IsNull } from 'typeorm';
import { z } from 'zod';
import { Workspace } from '../../../entities/Workspace';
import { Board } from '../../../entities/Board';
import { BoardColumn } from '../../../entities/BoardColumn';
import { Ticket } from '../../../entities/Ticket';
import { DEFAULT_COLUMNS, DEFAULT_BOARD_ROUTING } from '../../../db';
import { DEFAULT_PROMPT_TEMPLATES } from '../../../database/default-prompt-templates';
import { PromptTemplate } from '../../../entities/PromptTemplate';
import { canUseCatalogItem } from '../../../common/catalog-scope';
import { ok, err, safeJsonParse, withArtifactRef } from '../shared/helpers';
import { HarnessConfigSchema, serializeHarnessConfig } from '../../../common/harness-config';
import { EffortPresetsConfigSchema, validateEffortPresetsInput, serializeEffortPresets } from '../../../common/effort-presets';
import { EnvironmentConfigSchema, validateEnvironmentConfigInput, serializeEnvironmentConfig } from '../../../common/environment-config';
import { MergeGateConfigSchema, serializeMergeGateConfig } from '../../../common/merge-gate-config';
import { MergeLeaseConfigSchema, serializeMergeLeaseConfig } from '../../../common/merge-lease-config';
import { RespawnStormConfigSchema, serializeRespawnStormConfig } from '../../../common/respawn-storm-config';
import { BoardHardBudgetConfigSchema, serializeHardBudgetConfig } from '../../../common/hard-budget-config';
import { DefaultRoleAssignmentsSchema, validateDefaultRoleAssignmentsInput, serializeDefaultRoleAssignments } from '../../../common/default-role-assignments-config';
import { WORKTREE_MODES } from '../../../common/worktree-config';
import { LivenessPolicySchema, serializeLivenessPolicy } from '../../qa/qa-liveness-policy';
import { QaPhasesSchema, serializeQaPhases } from '../../qa/qa-phases';
import { writeRoutingConfigThrough } from '../../boards/routing-config.helper';
import { getCallerAgent } from '../shared/session-auth';
import { WorkspaceMoveService, WorkspaceMoveBlockedError } from '../../../services/workspace-move.service';
import { validateCliRuntimeProfileSelection } from '../../../common/claude-backend-registry';
import type { ToolContext } from './context';

export function registerBoardTools(server: McpServer, ctx: ToolContext): void {
  const { dataSource } = ctx;

  server.tool(
    'list_boards',
    'List all boards. Optionally filter by workspace_id.',
    {
      workspace_id: z.string().optional().describe('Filter by workspace ID'),
    },
    async ({ workspace_id }) => {
      const where: any = {};
      if (workspace_id) where.workspace_id = workspace_id;
      const boards = await dataSource.getRepository(Board).find({ where, order: { created_at: 'DESC' } });
      return ok(boards.map(board => withArtifactRef('board', board, board.name)));
    }
  );

  server.tool(
    'get_board',
    'Get a board with all columns, tickets (with children and comments). Archived tickets are excluded by default — pass include_archived=true to surface them.',
    {
      board_id: z.string().describe('Board ID'),
      include_archived: z.boolean().optional().default(false).describe('Include archived tickets (archived_at IS NOT NULL). Default false matches REST /api/boards/:id.'),
    },
    async ({ board_id, include_archived }) => {
      const board = await dataSource.getRepository(Board).findOne({ where: { id: board_id } });
      if (!board) return err('Board not found');

      const columns = await dataSource.getRepository(BoardColumn).find({
        where: { board_id: board.id },
        order: { position: 'ASC' },
      });

      const ticketRepo = dataSource.getRepository(Ticket);
      const columnsWithTickets = await Promise.all(
        columns.map(async (col) => {
          const whereTickets: any = { column_id: col.id };
          if (!include_archived) whereTickets.archived_at = IsNull();
          const tickets = await ticketRepo.find({
            where: whereTickets,
            relations: ['children', 'children.children', 'comments'],
            order: { position: 'ASC' },
          });
          return {
            ...col,
            tickets: tickets.map(t => ({
              ...t,
              labels: safeJsonParse(t.labels),
              channel_ids: safeJsonParse(t.channel_ids),
              children: (t.children || []).sort((a, b) => a.position - b.position).map(child => ({
                ...child,
                labels: safeJsonParse(child.labels),
                channel_ids: safeJsonParse(child.channel_ids),
                children: (child.children || []).sort((a, b) => a.position - b.position).map(gc => ({
                  ...gc,
                  labels: safeJsonParse(gc.labels),
                  channel_ids: safeJsonParse(gc.channel_ids),
                  children: [],
                })),
              })),
              comments: (t.comments || []).sort((a, b) =>
                new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
              ),
            })),
          };
        })
      );

      return ok(withArtifactRef('board', { ...board, columns: columnsWithTickets }, board.name));
    }
  );

  server.tool(
    'get_board_summary',
    'Get a compact LLM-friendly board summary with column names, ticket counts, and per-ticket overview. Archived tickets are excluded by default — pass include_archived=true to surface them.',
    {
      board_id: z.string().optional().describe('Board ID'),
      include_archived: z.boolean().optional().default(false).describe('Include archived tickets (archived_at IS NOT NULL). Default false matches the rest of the active-ticket surface.'),
    },
    async ({ board_id, include_archived }) => {
      const board = await dataSource.getRepository(Board).findOne({ where: { id: board_id } });
      if (!board) return err('Board not found');

      const columns = await dataSource.getRepository(BoardColumn).find({
        where: { board_id: board.id },
        order: { position: 'ASC' },
      });

      // Single query: load all tickets for all columns with children
      const columnIds = columns.map(c => c.id);
      const allTickets = columnIds.length > 0
        ? await dataSource.getRepository(Ticket).find({
            where: columnIds.map(cid => include_archived
              ? { column_id: cid }
              : { column_id: cid, archived_at: IsNull() }),
            relations: ['children'],
            order: { position: 'ASC' },
          })
        : [];

      // Group tickets by column
      const ticketsByColumn = new Map<string, typeof allTickets>();
      for (const t of allTickets) {
        const list = ticketsByColumn.get(t.column_id) || [];
        list.push(t);
        ticketsByColumn.set(t.column_id, list);
      }

      const summary = {
        id: board.id,
        board: board.name,
        _ref: withArtifactRef('board', board, board.name)._ref,
        description: board.description,
        columns: columns.map(col => {
          const tickets = ticketsByColumn.get(col.id) || [];
          return {
            name: col.name,
            ticketCount: tickets.length,
            tickets: tickets.map(t => {
              const children = t.children || [];
              const done = children.filter(c => c.status === 'done').length;
              return {
                id: t.id,
                title: t.title,
                _ref: withArtifactRef('ticket', t, t.title)._ref,
                priority: t.priority,
                assignee: t.assignee || 'unassigned',
                subtasks: `${done}/${children.length} done`,
              };
            }),
          };
        }),
      };

      return ok(summary);
    }
  );

  server.tool(
    'create_board',
    'Create a new board with default columns (Backlog, To Do, Plan, In Progress, Review, Merging, Done) and the planner→assignee→reviewer routing preset, inside a workspace',
    {
      workspace_id: z.string().describe('Workspace ID'),
      name: z.string().describe('Board name'),
      description: z.string().optional().default('').describe('Board description'),
    },
    async ({ workspace_id, name, description }) => {
      const ws = await dataSource.getRepository(Workspace).findOne({ where: { id: workspace_id } });
      if (!ws) return err('Workspace not found');

      const boardRepo = dataSource.getRepository(Board);
      const colRepo = dataSource.getRepository(BoardColumn);

      const board = await boardRepo.save(boardRepo.create({
        name, description, workspace_id,
        routing_config: JSON.stringify(DEFAULT_BOARD_ROUTING),
      }));
      const defaultCols = DEFAULT_COLUMNS.map(c => ({ ...c, board_id: board.id }));
      const savedCols = await colRepo.save(defaultCols.map(c => colRepo.create(c)));
      // v0.41 — write routing_config through to per-column role_routing.
      await writeRoutingConfigThrough(dataSource, board.id);

      // Idempotently seed default workflow templates into the workspace
      // (existing rows by name are left alone) and auto-link each new
      // column to its matching template via Board.column_prompts.
      const tplRepo = dataSource.getRepository(PromptTemplate);
      const existing = await tplRepo.find({ where: { workspace_id } });
      const existingByName = new Map(existing.map(t => [t.name, t]));
      const inserted: PromptTemplate[] = [];
      for (const def of DEFAULT_PROMPT_TEMPLATES) {
        if (existingByName.has(def.name)) continue;
        inserted.push(await tplRepo.save(tplRepo.create({
          workspace_id,
          name: def.name,
          description: def.description,
          content: def.content,
          category: def.category,
        })));
      }
      const tplIdByName = new Map([
        ...existing.map(t => [t.name, t.id] as const),
        ...inserted.map(t => [t.name, t.id] as const),
      ]);
      const colPrompts: Record<string, string> = {};
      for (const col of savedCols) {
        // SEED-ONLY name match (workspace/board creation). Runtime dispatch
        // never reads column names — see ticket 47a90ea3 AC #3. TODO:
        // migrate `column_match` to a `kind_match` enum so the last seed
        // hardcode goes away.
        const def = DEFAULT_PROMPT_TEMPLATES.find(d => d.column_match === col.name.toLowerCase());
        if (!def) continue;
        const tplId = tplIdByName.get(def.name);
        if (tplId) colPrompts[col.id] = tplId;
      }
      if (Object.keys(colPrompts).length > 0) {
        await boardRepo.update({ id: board.id }, { column_prompts: JSON.stringify(colPrompts) });
      }

      const result = await boardRepo.findOne({ where: { id: board.id } });
      return ok(result);
    }
  );

  server.tool(
    'update_board',
    'Update a board name, description, routing_config, column→prompt-template mapping, auto-archive policy, agent harness override, output language, or cli_runtime_profile pin',
    {
      board_id: z.string().describe('Board ID'),
      name: z.string().optional().describe('New name'),
      description: z.string().optional().describe('New description'),
      routing_config: z.record(z.string(), z.array(z.string())).nullable().optional()
        .describe('Column→role routing: { [lowercased column name]: ["assignee"|"reviewer"|"reporter", ...] }. Pass null or {} to clear all.'),
      column_prompts: z.record(z.string(), z.string().nullable()).nullable().optional()
        .describe('Column→PromptTemplate mapping: { [column_id]: prompt_template_id }. Pass null or {} to clear all.'),
      auto_archive_days: z.number().int().min(1).max(365).nullable().optional()
        .describe('Auto-archive policy: null disables; 1..365 archives Done-column tickets older than N days. Consumed by the TicketArchiverService background job; takes effect on the next archiver tick (no restart needed).'),
      harness_config: HarnessConfigSchema.nullable().optional()
        .describe('Per-board agent harness override. Set keys override the workspace default per key at dispatch; unset keys inherit. Pass null to clear.'),
      effort_presets: EffortPresetsConfigSchema.nullable().optional()
        .describe('Per-board abstract effort preset catalog. A ticket carries an abstract preset id (effort_preset); dispatch resolves it against this catalog, and agent-manager maps the match onto per-CLI options. Pass null to clear (falls back to the built-in catalog).'),
      language: z.string().nullable().optional()
        .describe('Per-board output language: a human-readable language name (e.g. "Korean", "English", "日本語"). Agents dispatched on this board write comments, chat, commit messages, and code comments in it. Empty string or null clears (falls back to English).'),
      environment_config: EnvironmentConfigSchema.nullable().optional()
        .describe('Per-board environment setup — a repository-Resource picker. Only repositories[].resource_id is used: the server expands it to the repo url/default_branch/credential, and agent-manager checks out the FIRST repository as the ticket worktree when the ticket has no base_repo binding. Every other field this schema accepts (legacy per-repo url/branch/target_dir/post_clone_commands; top-level env_vars/setup_commands/setup_timeout_seconds/version) is ACCEPTED but IGNORED on save (dropped, not stored). Overrides the workspace default per top-level key. Pass null to clear.'),
      paused: z.boolean().optional()
        .describe('Board-wide soft pause. true sets paused_at=now: every agent_trigger for this board\'s tickets is dropped (TriggerLoopService gate) and backlog promotion short-circuits; humans can still read/comment/drag. false clears paused_at to resume dispatch. Mirrors REST POST /api/boards/:id/pause|resume. Omit to leave unchanged.'),
      liveness_policy: LivenessPolicySchema.nullable().optional()
        .describe('Per-board QaRun liveness policy for the reaper. "zero_progress" (default) reaps when a run\'s age exceeds deadline_sec (falls back to the global QA_RUN_TTL_MS if unset); "heartbeat_deadline" reaps only when the run\'s monotonic qa_run_heartbeat token has not strictly advanced within deadline_sec. Scenario-level liveness_policy overrides this. Pass null to clear (falls back to zero_progress, the pre-existing behavior).'),
      qa_phases: QaPhasesSchema.nullable().optional()
        .describe('Per-board QA multi-phase model, e.g. phases: [{ id: "import", timeout_sec: 600 }, { id: "build", timeout_sec: 1800 }]. Array order = phase order; ids unique; timeout_sec a positive integer. When set (unless liveness_policy overrides it), the reaper auto-selects phase_timeouts: each phase is judged against its own timeout_sec from when the run entered it (set_qa_phase). Scenario-level qa_phases overrides this. Pass null to clear (falls back to legacy single-running behavior).'),
      merge_gate_config: MergeGateConfigSchema.nullable().optional()
        .describe('Per-board merge/integration gate. When enabled, the server checks git invariants at the Merging boundary: Review→Merging blocks if the feature branch is BEHIND base (stale-base; require_fresh_base); Merging→Done blocks if the branch is not fully merged into base (partial-merge; require_full_merge). Each check is ON unless explicitly set false, and degrades to a pass (never a false block) when the repo/branch can\'t be resolved. Pass null (or enabled:false) to disable — reverts to prompt-driven merge with no server checks.'),
      merge_lease_config: MergeLeaseConfigSchema.nullable().optional()
        .describe('Per-board LANDING LEASE (ticket e630b530). Serializes the "start pre-landing CI verification → land" window per (repo, base branch), so the base cannot advance under a ticket\'s CI run and force it to rebase + re-verify the same change indefinitely. UNLIKE merge_gate_config this is ON BY DEFAULT — null means default-enabled, not disabled; pass {"enabled": false} to turn it off for this board (kill switch). Safety comes from fail-open, not from the default: an unresolvable repo, a service error, or exceeding max_wait_minutes all let the ticket proceed WITHOUT a lease rather than blocking it. Tunables: idle_timeout_minutes (liveness, not a work budget — an unresolved CI wait counts as progress), max_hold_minutes (absolute backstop), max_wait_minutes (waiter cap before fail-open), max_reverify_attempts (bounded retries before an explicit failure).'),
      respawn_storm_config: RespawnStormConfigSchema.nullable().optional()
        .describe('Per-board respawn-storm circuit breaker (ticket ab06eac2). Counts abnormal QUICK subagent deaths per (ticket,role) off the durable subagents table; past min_deaths inside window_minutes with ZERO forward progress (no fresh comment / column move), it auto-pends the ticket + alerts + writes a respawn_storm_halted activity. Cause-agnostic last line of defence against death-loops/twin-echo. Defaults are ON (30m window, 5 quick deaths, 120s quick-death) so an untouched board is protected. Pass null (or {}) to clear back to the env baseline; enabled:false opts out.'),
      hard_budget_config: BoardHardBudgetConfigSchema.nullable().optional()
        .describe('Per-board hard-budget ceiling (ticket a940d75b; token ceiling added by ef53fdf4). Three content-agnostic ceilings on top of the pattern-based ping-pong guard: max_auto_responses caps the lifetime count of agent-authored non-system comments on a ticket; max_dispatches_per_window and max_tokens_per_window (summed input+output tokens off the subagents table\'s usage columns — CLIs that don\'t report usage are excluded, not blocked) share the SAME rolling window_minutes window. All three counters anchor to the ticket\'s last human-driven unpend, so clearing a breach never immediately re-trips. On breach: auto-pend (if auto_pend) + a chat alert (if notify). Defaults are ON (100 responses, 60m window, 30 dispatches, 2,000,000 tokens) so an untouched board is protected. Pass null (or {}) to clear back to the env baseline; enabled:false opts out. max_runs_per_window is workspace-only (see update_workspace) — rejected here (400), not silently accepted-but-ignored.'),
      default_role_assignments: DefaultRoleAssignmentsSchema.nullable().optional()
        .describe('Per-board DEFAULT role holders (ticket d94a1b87), e.g. { "assignee": [{ "agent_id": "a1" }], "reviewer": [{ "agent_id": "a2" }] }. At ticket-creation time (create_ticket MCP/REST, plus QA/Security/Feature auto-tickets), every role the caller did NOT explicitly staff is filled from this map so a fresh ticket lands on the loop without manual assignee/reviewer/reporter wiring. Priority: explicit holder > board default > unassigned; skip_default_assignments=true on create opts out entirely (true zero-holder, e.g. QA orphan probes). Each slug must be a real workspace role and each id a real agent/user (400 otherwise); a holder sets at most one of agent_id/user_id. Applied to NEW tickets only, never retroactively. Pass null or {} to clear.'),
      worktree_mode: z.enum(WORKTREE_MODES).optional()
        .describe('Per-board worktree layout (worktree 규약 chain, ticket 4ba844ea): "per_ticket" (default) gives each ticket its own worktree under `<working_dir>/.awb/wt/<ticket8>/`; "shared" reuses one worktree at `<working_dir>/.awb/wt/shared/`. Both are always rooted inside the working_dir\'s `.awb/`. Omit to leave unchanged.'),
      use_pr: z.boolean().optional()
        .describe('Per-board PR usage (worktree 규약 chain, ticket 4ba844ea): false (default) does a direct fast-forward merge on the Merging boundary; true opts into the PR create/merge path. Omit to leave unchanged.'),
      cli_runtime_profile: z.string().nullable().optional().describe(
        "Claude backend profile id this board's dispatch pins to. Profiles are instance-global. 'none' = explicit " +
        'opt-out (stop inheriting the global default); null = clear the pin and inherit again. Empty string is preserved for REST ' +
        "compatibility and also stops inheritance (behaves like 'none') — pass null if you actually want to " +
        'resume inheriting. Takes effect on the next dispatch.'
      ),
    },
    async ({ board_id, name, description, routing_config, column_prompts, auto_archive_days, harness_config, effort_presets, language, environment_config, paused, liveness_policy, qa_phases, merge_gate_config, merge_lease_config, respawn_storm_config, hard_budget_config, default_role_assignments, worktree_mode, use_pr, cli_runtime_profile }) => {
      const boardRepo = dataSource.getRepository(Board);
      const board = await boardRepo.findOne({ where: { id: board_id } });
      if (!board) return err('Board not found');

      if (name !== undefined) board.name = name;
      if (description !== undefined) board.description = description;
      const routingChanged = routing_config !== undefined;
      if (routingChanged) {
        if (routing_config === null) {
          board.routing_config = '{}';
        } else {
          board.routing_config = JSON.stringify(routing_config);
        }
      }
      if (column_prompts !== undefined) {
        if (column_prompts === null) {
          board.column_prompts = null;
        } else {
          // Drop null mappings so stored shape stays { [col]: templateId } without nullables
          const cleaned: Record<string, string> = {};
          for (const [colId, tplId] of Object.entries(column_prompts)) {
            if (!tplId) continue;
            const column = await dataSource.getRepository(BoardColumn).findOne({ where: { id: colId, board_id: board.id } });
            if (!column) return err(`column ${colId} does not belong to board`);
            const template = await dataSource.getRepository(PromptTemplate).findOne({ where: { id: tplId } });
            if (!template || !canUseCatalogItem(template, board.workspace_id)) {
              return err(`prompt template ${tplId} is not available to board`);
            }
            cleaned[colId] = tplId;
          }
          board.column_prompts = Object.keys(cleaned).length === 0 ? null : JSON.stringify(cleaned);
        }
      }
      if (auto_archive_days !== undefined) {
        board.auto_archive_days = auto_archive_days;
      }
      // Board output language (i18n, ticket ae28dcaf). Empty/whitespace → null
      // so the override clears back to the agent default (English).
      if (language !== undefined) {
        const trimmed = language == null ? null : String(language).trim();
        board.language = trimmed ? trimmed : null;
      }
      // Board-wide soft pause (mirrors REST /pause|/resume). true stamps
      // paused_at=now so the TriggerLoopService gate drops every emission;
      // false clears it back to null. Idempotent on repeat-true (refreshes
      // the timestamp) just like the REST endpoint.
      if (paused !== undefined) {
        board.paused_at = paused ? new Date() : null;
      }
      // Harness override (ticket 7122600c). Args already passed the strict
      // HarnessConfigSchema, so storage is a straight serialize; empty
      // objects collapse to null (same null = "no override" contract as
      // column_prompts).
      if (harness_config !== undefined) {
        board.harness_config = serializeHarnessConfig(harness_config);
      }
      // Effort preset catalog (abstract ticket effort option). null clears
      // (board falls back to the built-in catalog). Args already passed the
      // EffortPresetsConfigSchema; re-run validateEffortPresetsInput for the
      // cross-field default-matches-an-id / unique-id invariant the schema
      // alone can't express, then serialize (empty / equal-to-builtin → null).
      if (effort_presets !== undefined) {
        if (effort_presets === null) {
          board.effort_presets = null;
        } else {
          const checked = validateEffortPresetsInput(effort_presets);
          if (!checked.ok) return err(checked.error);
          board.effort_presets = serializeEffortPresets(checked.value);
        }
      }
      // Environment setup override (ticket 354d336b). null clears the board
      // override (workspace default, if any, then applies). validateEnvironment-
      // ConfigInput normalises to repositories[].resource_id only — legacy keys
      // (env_vars / setup_commands / url / branch / …) are accepted but dropped
      // (8fbe90e9); a repo missing resource_id errors. Then serialize (empty → null).
      if (environment_config !== undefined) {
        if (environment_config === null) {
          board.environment_config = null;
        } else {
          const checked = validateEnvironmentConfigInput(environment_config);
          if (!checked.ok) return err(checked.error);
          board.environment_config = serializeEnvironmentConfig(checked.value);
        }
      }
      // QaRun liveness policy (ticket 40010b25). Args already passed the strict
      // LivenessPolicySchema, so storage is a straight serialize; null clears the
      // override back to the built-in zero_progress default.
      if (liveness_policy !== undefined) {
        board.liveness_policy = serializeLivenessPolicy(liveness_policy);
      }
      // QA multi-phase model (ticket 90cc22f7 / 38192044). Args already passed the
      // strict QaPhasesSchema, so storage is a straight serialize; null clears the
      // model back to legacy single-running behavior.
      if (qa_phases !== undefined) {
        board.qa_phases = serializeQaPhases(qa_phases);
      }
      // Merge/integration gate (ticket c806bad3). Args already passed the strict
      // MergeGateConfigSchema, so storage is a straight serialize; null (or an
      // empty object) clears the override back to "no gate" (prompt-driven merge).
      if (merge_gate_config !== undefined) {
        board.merge_gate_config = serializeMergeGateConfig(merge_gate_config);
      }
      // 랜딩 lease (ticket e630b530). 인자는 이미 strict 스키마를 통과했으므로
      // 저장은 직렬화뿐이다. null(또는 빈 객체)은 **기본값(활성)** 으로 되돌리는
      // 것이지 끄는 것이 아니다 — 끄려면 {"enabled": false}.
      if (merge_lease_config !== undefined) {
        board.merge_lease_config = serializeMergeLeaseConfig(merge_lease_config);
      }
      // Respawn-storm circuit breaker (ticket ab06eac2). Args already passed the
      // strict RespawnStormConfigSchema, so storage is a straight serialize; null
      // (or an empty object) clears the override back to the env baseline.
      if (respawn_storm_config !== undefined) {
        board.respawn_storm_config = serializeRespawnStormConfig(respawn_storm_config);
      }
      // Hard-budget ceiling (티켓 a940d75b). args는 이미 strict한
      // BoardHardBudgetConfigSchema(board-scope 서브셋 — max_runs_per_window는
      // 거부됨, 티켓 73b92d23)를 통과했으므로 저장은 단순 serialize다; null
      // (또는 빈 객체)이면 env baseline으로 override를 초기화한다.
      if (hard_budget_config !== undefined) {
        board.hard_budget_config = serializeHardBudgetConfig(hard_budget_config);
      }
      // Board default role holders (ticket d94a1b87). null / {} clears the
      // config. The JSON shape is validated by DefaultRoleAssignmentsSchema
      // above; the DB-existence layer (every slug a real workspace role, every
      // id a real agent/user) runs in validateBoardDefaults so a typo 400s
      // instead of silently manufacturing an orphan default at create time.
      if (default_role_assignments !== undefined) {
        if (default_role_assignments === null) {
          board.default_role_assignments = null;
        } else {
          const checked = validateDefaultRoleAssignmentsInput(default_role_assignments);
          if (!checked.ok) return err(checked.error);
          if (ctx.ticketRoleAssignmentService) {
            const dbCheck = await ctx.ticketRoleAssignmentService.validateBoardDefaults(board.workspace_id, checked.value);
            if (!dbCheck.ok) return err(dbCheck.error);
          }
          board.default_role_assignments = serializeDefaultRoleAssignments(checked.value);
        }
      }
      // Worktree / merge convention (ticket 4ba844ea). Args already passed the
      // strict z.enum / z.boolean, so storage is a straight assign. Omitting a
      // field leaves the stored value untouched; there is no "clear" state — the
      // columns are non-null scalars with a DB default (per_ticket / false).
      if (worktree_mode !== undefined) {
        board.worktree_mode = worktree_mode;
      }
      if (use_pr !== undefined) {
        board.use_pr = use_pr;
      }
      if (cli_runtime_profile !== undefined) {
        const checked = await validateCliRuntimeProfileSelection(dataSource, cli_runtime_profile);
        if (!checked.ok) return err(checked.error);
        board.cli_runtime_profile = checked.value;
      }

      await boardRepo.save(board);
      // v0.41 — fan routing_config edits through to per-column role_routing
      // so the runtime trigger / allocation paths read slugs straight off the
      // BoardColumn rows. See routing-config.helper for the contract.
      if (routingChanged) {
        await writeRoutingConfigThrough(dataSource, board.id);
      }
      return ok(withArtifactRef('board', board, board.name));
    }
  );

  server.tool(
    'delete_board',
    'Delete a board and all its columns, tickets (with subtasks) and comments. The delete cascades ' +
    'through the column → ticket → child-ticket / comment FK chain (same behaviour as DELETE /api/boards/:id). ' +
    'Unlike delete_workspace there is no "cannot delete the last board" guard — a workspace is allowed to hold ' +
    'zero boards. Irreversible: there is no archive/restore here (use update_board / the Archive page for soft ' +
    'archival instead).',
    { board_id: z.string().describe('Board ID to delete') },
    async ({ board_id }) => {
      const boardRepo = dataSource.getRepository(Board);
      const board = await boardRepo.findOne({ where: { id: board_id } });
      if (!board) return err('Board not found');

      await boardRepo.delete(board.id);
      return ok({ success: true });
    }
  );

  server.tool(
    'move_board_to_workspace',
    'Move a board (with all its columns + tickets) to a DIFFERENT workspace, carrying its workspace-scoped ' +
    'dependencies along. A workspace is a scope boundary, so this hard re-stamps workspace_id on the board, every ' +
    'column and every ticket (roots + subtasks), remaps each ticket role assignment to the destination ' +
    'workspace\'s same-slug role (creating the role there if missing), and copies referenced prompt templates / ' +
    'ws-level actions / resources / channels into the destination by name if absent (non-destructive). ' +
    'ALWAYS dry-run first (dry_run=true, the default) to see exactly what will move / copy / remap and what blocks ' +
    'the move — then re-call with dry_run=false to commit atomically (single transaction, all-or-nothing). ' +
    'Companion agents (those holding roles on the board\'s tickets) are reported; pass carry_agents=true to move ' +
    'them too, which is refused for any agent that also holds roles on tickets outside this board (pass that agent\'s ' +
    'id in exclude_agent_ids to move the board without it). The dry-run report\'s `blockers` are STRUCTURED objects ' +
    '({ code, message, agent_id?, ticket_ids?, remedies[] }) — `message` is the human-readable reason; `remedies` ' +
    'lists the actions that clear each blocker. Admin-gated.',
    {
      board_id: z.string().describe('Board ID to move'),
      target_workspace_id: z.string().describe('Destination workspace ID'),
      dry_run: z.boolean().optional().default(true)
        .describe('true (default) returns the preview report without writing; false commits the move atomically'),
      carry_agents: z.boolean().optional().default(false)
        .describe('Also move companion agents (workspace_id + api keys + credential) when they hold no roles outside this board'),
      exclude_agent_ids: z.array(z.string()).optional()
        .describe('Companion agent ids to EXCLUDE from the carry even when carry_agents=true — the board moves without them (write-free way to clear a companion_agent_outside_roles blocker)'),
    },
    async ({ board_id, target_workspace_id, dry_run, carry_agents, exclude_agent_ids }, extra: { sessionId?: string }) => {
      const caller = getCallerAgent(extra);
      const mover = new WorkspaceMoveService(dataSource as any, ctx.activityService);
      const opts = { carry_agents, exclude_agent_ids, actor_id: caller?.agentId, actor_name: caller?.agentName };
      try {
        const report = dry_run
          ? await mover.previewBoardMove(board_id, target_workspace_id, opts)
          : await mover.commitBoardMove(board_id, target_workspace_id, opts);
        return ok(report);
      } catch (e: any) {
        if (e instanceof WorkspaceMoveBlockedError) return err(`Move blocked: ${e.messages.join('; ')}`);
        return err(e?.message || 'Cross-workspace move failed');
      }
    }
  );
}
