/**
 * Database compatibility module
 *
 * Provides AppDataSource + buildDataSourceOptions() for modules that need
 * direct DataSource access (mcp-tools.ts, mcp-server.ts) and for the NestJS
 * DatabaseModule, which imports buildDataSourceOptions() to keep the
 * TypeORM configuration unified (D-05).
 *
 * Invariants (locked by .planning/phases/01-foundation/01-CONTEXT.md):
 * - D-01: synchronize is HARDCODED on in every branch (sqlite/mysql/postgres).
 *         It is NOT keyed off NODE_ENV. Schema DDL is driven by entity definitions.
 * - D-02: Migrations handle DATA only, not schema. The migrationsRun flag is
 *         hardcoded off so we can invoke runMigrations() manually from
 *         DatabaseModule.onModuleInit() after the synchronize step has completed (P-03).
 * - D-05: This file is the single source of truth for DataSource options.
 */
import 'reflect-metadata';
import { DataSource, DataSourceOptions } from 'typeorm';
import * as path from 'path';
import * as fs from 'fs';
import * as entitiesBarrel from './entities';

const entities = Object.values(entitiesBarrel);

// PRESET — not enforced. New boards seed with these starter columns so the
// first-run UX isn't an empty page; the user can rename, reorder, delete,
// or add more freely. Critically distinct from the old "hardcoded routing
// fallback" that auto-mapped column names to assignee/reporter/reviewer
// roles — that remains removed (TriggerLoopService keys off routing_config
// only, no name-based magic). New columns are created with empty
// routing_config so they emit zero triggers until a workspace owner opts
// in via Board Settings.
//
// Set this to [] if a deployment wants every board to start blank.
//
// `is_terminal: true` on Done marks it as a workflow end-state — agents
// stop polling tickets parked there and the column toggles available in
// Board Settings reflect it. Other presets stay non-terminal so tickets
// can flow through them in either direction.
export const DEFAULT_COLUMNS: Array<{
  name: string;
  position: number;
  color: string;
  is_terminal?: boolean;
  /**
   * v0.41 — workflow-kind classification. Seeded into BoardColumn.kind so
   * runtime never has to match column names. See ColumnKind in the entity.
   */
  kind: 'intake' | 'active' | 'review' | 'merging' | 'terminal';
}> = [
  { name: 'Backlog',     position: 0, color: '#94a3b8',                       kind: 'intake'   },
  { name: 'To Do',       position: 1, color: '#60a5fa',                       kind: 'active'   },
  // 'Plan' inserts a deliberate planning beat between intake and execution
  // so the planner role has a column to live in. New default routing pairs
  // each planning column with the planner role; teams that prefer the v1
  // To Do → In Progress flow can rename or delete it.
  { name: 'Plan',        position: 2, color: '#22d3ee',                       kind: 'active'   },
  { name: 'In Progress', position: 3, color: '#fbbf24',                       kind: 'active'   },
  { name: 'Review',      position: 4, color: '#a78bfa',                       kind: 'review'   },
  { name: 'Merging',     position: 5, color: '#f472b6',                       kind: 'merging'  },
  { name: 'Done',        position: 6, color: '#34d399', is_terminal: true,    kind: 'terminal' },
];

/**
 * Default routing_config seeded onto every newly-created board. Keys are the
 * lowercased column names from DEFAULT_COLUMNS; values are arrays of role
 * slugs from BUILTIN_ROLES. Tickets entering one of these columns trigger
 * the listed roles (TriggerLoopService reads this verbatim).
 *
 * The "natural progression" — plan → execute → review — is wired up here so
 * the workflow is functional out of the box. Backlog/To Do/Done are left
 * unrouted: tickets sit there waiting for human intent (move forward) and
 * shouldn't auto-trigger anyone.
 *
 * Stringified at write time (Board.routing_config is a varchar JSON blob).
 */
export const DEFAULT_BOARD_ROUTING: Record<string, string[]> = {
  'plan':        ['planner'],
  'in progress': ['assignee'],
  'review':      ['reviewer'],
  'merging':     ['assignee'],
};

/**
 * v0.34 — built-in workspace role preset, seeded into every newly created
 * workspace and into existing workspaces by the
 * `1760000000008-SeedWorkspaceRoles` migration. The Planner role was added
 * later by `1760000000009-AddPlannerRoleAndPrompts` (and is auto-inserted
 * into existing workspaces by that migration).
 *
 * Same starter-pack semantics as DEFAULT_COLUMNS: rows show up so the
 * first-run UX has working slugs that match the `routing_config` keys
 * boards historically use; they're then fully editable (slug, name, prompt)
 * and deletable per-workspace once admins adjust them. Plain rows in the
 * same `workspace_roles` table — `is_builtin` is purely a UI badge, not a
 * special-case in any code path.
 *
 * `role_prompt` is the v0.34 default-prompt seed. It's prepended to the
 * agent's own role_prompt when the agent is triggered as that role, so the
 * text below describes the role's responsibility from the agent's POV.
 * Existing workspaces keep their custom prompts untouched — the
 * 1760000000009 migration only fills rows where role_prompt is currently
 * the empty string.
 */
export const BUILTIN_ROLES: Array<{
  slug: string;
  name: string;
  position: number;
  description: string;
  role_prompt: string;
}> = [
  {
    slug: 'planner',
    name: 'Planner',
    position: 0,
    description: 'Breaks the ticket down into a concrete plan before implementation begins.',
    role_prompt:
      "You are acting as the PLANNER on this ticket.\n" +
      "\n" +
      "Goal: turn the ticket's intent into a concrete, reviewable plan before " +
      "anyone starts implementing.\n" +
      "\n" +
      "Responsibilities:\n" +
      "- Read the ticket, its description, and any prior comments end-to-end before posting.\n" +
      "- Identify ambiguities, missing context, or hidden constraints. Resolve them by " +
      "@mentioning the reporter (or other relevant role) with a focused question — do not " +
      "guess.\n" +
      "- Produce a numbered task breakdown that an assignee can execute without re-deriving " +
      "the design. Each step should name files/components, expected behavior, and acceptance " +
      "criteria.\n" +
      "- Flag risks, edge cases, and rollback considerations explicitly. If subtasks are " +
      "warranted, create them.\n" +
      "- When the plan is complete and unblocked, move the ticket to In Progress so the " +
      "assignee picks it up.\n" +
      "\n" +
      "Do NOT implement the work yourself in this role — that's the assignee's job.",
  },
  {
    slug: 'assignee',
    name: 'Assignee',
    position: 1,
    description: 'Owns the work — implements the planned change and drives the ticket forward.',
    role_prompt:
      "You are acting as the ASSIGNEE on this ticket.\n" +
      "\n" +
      "Goal: deliver the planned change to a state where the reviewer can sign off.\n" +
      "\n" +
      "Responsibilities:\n" +
      "- Read the latest plan and any open questions before starting; if the plan is missing " +
      "or stale, ask the planner instead of improvising.\n" +
      "- Implement the change in small, focused commits with clear messages. Keep behavior " +
      "consistent with the plan; surface any plan-vs-reality conflicts as comments rather " +
      "than silent deviations.\n" +
      "- Self-test before handing off: run the relevant tests, exercise the user-visible " +
      "behavior, and report what you actually verified (not just what you wrote).\n" +
      "- When the work is ready for review, post a short summary comment (what changed, how " +
      "it was tested, any caveats) and move the ticket to Review.\n" +
      "- If the reviewer kicks it back, address every point in the same ticket — don't open " +
      "a new one for the same work.",
  },
  {
    slug: 'reporter',
    name: 'Reporter',
    position: 2,
    description: 'Filed the ticket — clarifies intent and acceptance criteria for the rest of the workflow.',
    role_prompt:
      "You are acting as the REPORTER on this ticket — the person (or agent) who filed it.\n" +
      "\n" +
      "Goal: keep the ticket's intent and acceptance criteria unambiguous as it moves through " +
      "the workflow.\n" +
      "\n" +
      "Responsibilities:\n" +
      "- Answer planner / assignee / reviewer questions promptly and concretely. If you " +
      "don't know an answer, say so and point to who would.\n" +
      "- When acceptance criteria are vague or implicit, edit the ticket description to make " +
      "them explicit. Prefer 'change the description' over 'leave it in a comment thread.'\n" +
      "- If the proposed plan or implementation drifts from the original intent, push back " +
      "early — don't wait for review.\n" +
      "- Sign off on the final outcome only when it actually solves the problem you filed " +
      "this ticket to solve.",
  },
  {
    slug: 'reviewer',
    name: 'Reviewer',
    position: 3,
    description: "Reviews the assignee's work for production-readiness before it advances.",
    role_prompt:
      "You are acting as the REVIEWER on this ticket.\n" +
      "\n" +
      "Goal: gate the change on production-readiness — correctness, safety, and fit with the " +
      "rest of the system.\n" +
      "\n" +
      "Responsibilities:\n" +
      "- Re-read the ticket goal and the plan before looking at the diff. Review against " +
      "intent, not just code style.\n" +
      "- Walk the actual diff. Check edge cases, error paths, observability, and breaking " +
      "behavior for callers and downstream systems.\n" +
      "- Verify the assignee's self-test claims where it's cheap to do so. If the test " +
      "evidence is thin, say what additional check you want.\n" +
      "- Leave actionable feedback. If everything passes, move the ticket to Merging (or " +
      "Done if there's no merge step). If issues remain, move it back to In Progress with a " +
      "clear list of what blocks approval — never silently drop a review.",
  },
];

export function buildDataSourceOptions(): DataSourceOptions {
  const dbType = (process.env.DB_TYPE || 'sqlite') as 'sqlite' | 'mysql' | 'postgres';
  // Migrations glob — matches both src/.ts (tsx dev mode) and dist/.js (compiled)
  const migrationsGlob = [path.join(__dirname, 'database', 'migrations', '*.{js,ts}')];

  if (dbType === 'mysql') {
    return {
      type: 'mysql',
      host: process.env.DB_HOST || 'localhost',
      port: parseInt(process.env.DB_PORT || '3306'),
      username: process.env.DB_USER || 'root',
      password: process.env.DB_PASS || '',
      database: process.env.DB_NAME || 'ai_workflow',
      entities,
      migrations: migrationsGlob,
      synchronize: true,   // D-01: always true, never NODE_ENV-gated
      migrationsRun: false, // D-02: invoked manually from DatabaseModule.onModuleInit()
      logging: false,
    };
  }

  if (dbType === 'postgres') {
    return {
      type: 'postgres',
      host: process.env.DB_HOST || 'localhost',
      port: parseInt(process.env.DB_PORT || '5432'),
      username: process.env.DB_USER || 'postgres',
      password: process.env.DB_PASS || '',
      database: process.env.DB_NAME || 'ai_workflow',
      entities,
      migrations: migrationsGlob,
      synchronize: true,   // D-01
      migrationsRun: false, // D-02
      logging: false,
    };
  }

  // Default: SQLite (sql.js — pure WASM, no native build required)
  const dbDir = path.join(__dirname, '..', '..', '..', 'database');
  if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });
  // Allow QA flow-test subprocess to target an isolated db file via env.
  // Two processes writing sqljs to the same file clobber each other on
  // autoSave, so the admin "Run Flow Tests" endpoint sets this to e.g.
  // database/qa-flows.db before spawning node --test.
  const sqliteLocation = process.env.SQLJS_DB_PATH
    ? (path.isAbsolute(process.env.SQLJS_DB_PATH)
        ? process.env.SQLJS_DB_PATH
        : path.join(dbDir, process.env.SQLJS_DB_PATH))
    : path.join(dbDir, 'data.db');
  return {
    type: 'sqljs',
    location: sqliteLocation,
    autoSave: true,
    entities,
    migrations: migrationsGlob,
    synchronize: true,   // D-01
    migrationsRun: false, // D-02
    logging: false,
  };
}

export const AppDataSource = new DataSource(buildDataSourceOptions());

export async function initDb() {
  await AppDataSource.initialize();
  const dbType = process.env.DB_TYPE || 'sqlite';
  console.log(`[DB] Connected using ${dbType}`);
}
