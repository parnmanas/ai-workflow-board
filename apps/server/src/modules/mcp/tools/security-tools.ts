/**
 * Security-inspection MCP tools (SecurityProfile / SecurityRun).
 *
 * A SecurityProfile is a reusable security-inspection definition addressed to a
 * target agent, carrying a `checklist` and a `scan_driver`. Starting a run
 * dispatches the rendered inspection prompt into a fresh ChatRoom (same pipeline
 * as QA/Actions). The agent then inspects the code — incrementally
 * (baseline..HEAD diff) or in full — records each issue via
 * record_security_finding, and finishes with complete_security_run, reporting the
 * scanned HEAD SHA. A PASS advances the profile's incremental baseline.
 *
 * Tools:
 *   Profiles: create_security_profile / update_security_profile /
 *             list_security_profiles / get_security_profile /
 *             delete_security_profile / refresh_security_checklist
 *   Runs:     start_security_run / record_security_finding /
 *             attach_security_artifact / complete_security_run
 *   Batches:  start_security_batch / get_security_batch (수동 전체 점검 —
 *             sequential multi-profile runs, one-at-a-time)
 *   Reads:    list_security_runs / get_security_run
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { SecurityProfile } from '../../../entities/SecurityProfile';
import { SecurityRun } from '../../../entities/SecurityRun';
import { SecurityRunBatch } from '../../../entities/SecurityRunBatch';
import { ok, err } from '../shared/helpers';
import { getCallerAgent } from '../shared/session-auth';
import type { ToolContext } from './context';

function profileToJson(p: SecurityProfile) {
  return {
    id: p.id,
    workspace_id: p.workspace_id,
    board_id: p.board_id,
    name: p.name,
    description: p.description,
    checklist: p.checklist ?? [],
    target_agent_id: p.target_agent_id,
    target_resource_id: p.target_resource_id,
    scan_driver: p.scan_driver,
    scan_driver_config: p.scan_driver_config ?? null,
    scope_mode: p.scope_mode,
    last_passed_commit: p.last_passed_commit,
    enabled: p.enabled,
    tags: p.tags ?? [],
    max_runs: p.max_runs,
    on_failure_ticket: p.on_failure_ticket ?? null,
    created_by: p.created_by,
    created_at: p.created_at,
    updated_at: p.updated_at,
  };
}

function runToJson(r: SecurityRun) {
  return {
    id: r.id,
    profile_id: r.profile_id,
    workspace_id: r.workspace_id,
    board_id: r.board_id,
    status: r.status,
    room_id: r.room_id,
    findings: r.findings ?? [],
    scanned_commit: r.scanned_commit,
    baseline_commit: r.baseline_commit,
    scope_used: r.scope_used,
    artifact_resource_ids: r.artifact_resource_ids ?? [],
    summary: r.summary,
    triggered_by_type: r.triggered_by_type,
    triggered_by_id: r.triggered_by_id,
    auto_ticket_id: r.auto_ticket_id ?? null,
    started_at: r.started_at,
    finished_at: r.finished_at,
    created_at: r.created_at,
  };
}

function batchToJson(b: SecurityRunBatch) {
  const ids = b.profile_ids ?? [];
  return {
    id: b.id,
    workspace_id: b.workspace_id,
    board_id: b.board_id,
    profile_ids: ids,
    run_ids: b.run_ids ?? [],
    current_index: b.current_index,
    total: ids.length,
    status: b.status,
    stop_on_fail: b.stop_on_fail,
    passed: b.passed,
    failed: b.failed,
    errored: b.errored,
    triggered_by_type: b.triggered_by_type,
    triggered_by_id: b.triggered_by_id,
    finished_at: b.finished_at,
    created_at: b.created_at,
    updated_at: b.updated_at,
  };
}

const severityEnum = z.enum(['critical', 'high', 'medium', 'low', 'info']);

const checklistItemSchema = z.object({
  id: z.string().describe('Stable id within the profile (findings reference it via checklist_item_id)'),
  title: z.string().describe('What to look for'),
  category: z.string().optional().describe('Grouping label, e.g. authz / input-validation / secrets / crypto'),
  severity_hint: severityEnum.optional().describe('Advisory worst-case severity for this item'),
  guidance: z.string().optional().describe('How to check this item'),
  source: z.string().optional().describe('Evidence link backing the item — an OWASP/CWE URL, a CVE/GHSA id, or an advisory URL'),
  added_at: z.string().optional().describe('ISO-8601 time the item entered the checklist (server stamps it when omitted)'),
});

const onFailureTicketSchema = z.object({
  enabled: z.boolean().describe('Master switch for the on-failure auto-ticket policy'),
  board_id: z.string().optional().describe('Board to file the fix ticket on (falls back to run.board_id → profile.board_id)'),
  column_name: z.string().optional().describe('Target column (default "To Do" → first non-terminal → first column)'),
  priority: z.enum(['low', 'medium', 'high', 'critical']).optional().describe('Fix ticket priority (default high)'),
  assignee_id: z.string().optional().describe('Assignee for the fix ticket (falls back to the profile target agent)'),
  labels: z.array(z.string()).optional().describe('Extra labels (security-profile:<id> back-ref is always added)'),
  min_severity: severityEnum.optional().describe('Severity gate (default "high"): a ticket is filed only when the run has a finding at or above this. critical>high>medium>low>info'),
  dedupe: z.enum(['per_run', 'per_open_ticket']).optional().describe('per_run (default) files one ticket per failed run; per_open_ticket appends a recurrence comment to an existing open security ticket for this profile instead'),
  title_template: z.string().optional().describe('Title override; {{profile.name}} is substituted. Default "보안 점검 실패: {{profile.name}}"'),
}).describe('On-failure auto-ticket policy (severity-gated). Pass null to clear.');

const findingSchema = z.object({
  id: z.string().optional().describe('Stable id for the finding (re-recording the same id overwrites it; auto-generated if omitted)'),
  severity: severityEnum.describe('Finding severity'),
  title: z.string().describe('Short finding title'),
  category: z.string().optional(),
  file: z.string().optional().describe('Source file, relative to repo root'),
  line: z.number().optional(),
  evidence: z.string().optional().describe('Offending snippet / short proof note'),
  remediation: z.string().optional().describe('Suggested fix'),
  checklist_item_id: z.string().optional().describe('Checklist item this maps back to'),
});

export function registerSecurityTools(server: McpServer, ctx: ToolContext): void {
  const { dataSource, securityProfileService, securityRunService } = ctx;

  // ── Profile CRUD ────────────────────────────────────────────────────────────

  server.tool(
    'list_security_profiles',
    'List security-inspection profiles in a workspace. Scope rule mirrors list_qa_scenarios: ' +
    'omit board_id → ALL (workspace+board); pass board_id="" → workspace-scope only ' +
    '(board_id IS NULL); pass board_id=<uuid> → that board only.',
    {
      workspace_id: z.string().describe('Workspace ID (required)'),
      board_id: z.string().optional().describe('"" → workspace-scope, <uuid> → board-scope, omit → all'),
    },
    async ({ workspace_id, board_id }) => {
      const repo = dataSource.getRepository(SecurityProfile);
      const qb = repo.createQueryBuilder('p').where('p.workspace_id = :ws', { ws: workspace_id });
      if (board_id !== undefined) {
        if (board_id) qb.andWhere('p.board_id = :bid', { bid: board_id });
        else qb.andWhere('p.board_id IS NULL');
      }
      const rows = await qb.orderBy('p.name', 'ASC').getMany();
      return ok(rows.map(profileToJson));
    },
  );

  server.tool(
    'get_security_profile',
    'Get a single security-inspection profile by id (includes its checklist + incremental baseline).',
    { profile_id: z.string().describe('SecurityProfile ID') },
    async ({ profile_id }) => {
      const repo = dataSource.getRepository(SecurityProfile);
      const row = await repo.findOne({ where: { id: profile_id } });
      if (!row) return err('security profile not found');
      return ok(profileToJson(row));
    },
  );

  server.tool(
    'create_security_profile',
    'Create a security-inspection profile. `checklist` is the list of things to look for ' +
    '(rendered into the run prompt). `scan_driver` selects the inspection lens ' +
    '(code-review / dependency / secrets / custom). `scope_mode` (default "incremental") + the ' +
    'auto-managed `last_passed_commit` drive incremental scoping: a passing run advances the ' +
    'baseline so the next run only diffs baseline..HEAD. `target_resource_id` points at a repo ' +
    'Resource to inspect, or omit for AWB\'s own codebase.',
    {
      workspace_id: z.string().describe('Workspace ID (required)'),
      board_id: z.string().optional().describe('Board ID to pin to, or omit/"" for workspace scope'),
      name: z.string().describe('Profile name (required)'),
      description: z.string().optional(),
      checklist: z.array(checklistItemSchema).optional().describe('Checklist items to inspect against'),
      target_agent_id: z.string().describe('Agent that runs this inspection (required)'),
      target_resource_id: z.string().optional().describe('Repo Resource to inspect, or omit for AWB\'s own codebase'),
      scan_driver: z.string().optional().describe('Driver selector, e.g. code-review / dependency / secrets'),
      scan_driver_config: z.record(z.string(), z.any()).optional().describe('Driver-specific config object'),
      scope_mode: z.enum(['incremental', 'full']).optional().describe('Inspection scope (default incremental)'),
      enabled: z.boolean().optional(),
      tags: z.array(z.string()).optional(),
      max_runs: z.number().optional().describe('FIFO run-history budget per profile (default 20)'),
      on_failure_ticket: onFailureTicketSchema.optional().describe('Severity-gated on-failure auto-ticket policy — file a fix ticket when a run fails with a finding at or above min_severity'),
    },
    async (args, extra: { sessionId?: string }) => {
      if (!securityProfileService) return err('security profile service unavailable in this MCP context');
      const caller = getCallerAgent(extra);
      try {
        const row = await securityProfileService.create({
          workspace_id: args.workspace_id,
          board_id: args.board_id ?? null,
          name: args.name,
          description: args.description,
          checklist: args.checklist,
          target_agent_id: args.target_agent_id,
          target_resource_id: args.target_resource_id ?? null,
          scan_driver: args.scan_driver,
          scan_driver_config: args.scan_driver_config ?? null,
          scope_mode: args.scope_mode,
          enabled: args.enabled,
          tags: args.tags,
          max_runs: args.max_runs,
          on_failure_ticket: args.on_failure_ticket,
          created_by: caller?.agentId ?? '',
        });
        return ok(profileToJson(row));
      } catch (e: any) {
        return err(e?.message || 'Failed to create security profile');
      }
    },
  );

  server.tool(
    'update_security_profile',
    'Update a security-inspection profile. Only the provided fields change. `workspace_id` is ' +
    'required for scope safety. Pass `last_passed_commit: ""` to reset the incremental baseline ' +
    '(force a full re-scan on the next run).',
    {
      profile_id: z.string().describe('SecurityProfile ID'),
      workspace_id: z.string().describe('Workspace ID (required, scope guard)'),
      board_id: z.string().optional(),
      name: z.string().optional(),
      description: z.string().optional(),
      checklist: z.array(checklistItemSchema).optional(),
      target_agent_id: z.string().optional(),
      target_resource_id: z.string().optional(),
      scan_driver: z.string().optional(),
      scan_driver_config: z.record(z.string(), z.any()).optional(),
      scope_mode: z.enum(['incremental', 'full']).optional(),
      last_passed_commit: z.string().optional().describe('Reset/override the incremental baseline ("" clears it)'),
      enabled: z.boolean().optional(),
      tags: z.array(z.string()).optional(),
      max_runs: z.number().optional(),
      on_failure_ticket: onFailureTicketSchema.nullable().optional().describe('Severity-gated on-failure auto-ticket policy; pass null to clear it'),
    },
    async ({ profile_id, workspace_id, ...patch }) => {
      if (!securityProfileService) return err('security profile service unavailable in this MCP context');
      try {
        const row = await securityProfileService.update(profile_id, workspace_id, patch as any);
        return ok(profileToJson(row));
      } catch (e: any) {
        return err(e?.message || 'Failed to update security profile');
      }
    },
  );

  server.tool(
    'delete_security_profile',
    'Delete a security-inspection profile and cascade-delete all its runs (and the chat room each run created).',
    {
      profile_id: z.string().describe('SecurityProfile ID'),
      workspace_id: z.string().describe('Workspace ID (required, scope guard)'),
    },
    async ({ profile_id, workspace_id }) => {
      if (!securityProfileService) return err('security profile service unavailable in this MCP context');
      try {
        await securityProfileService.remove(profile_id, workspace_id);
        return ok({ success: true, id: profile_id });
      } catch (e: any) {
        return err(e?.message || 'Failed to delete security profile');
      }
    },
  );

  // ── Runs ──────────────────────────────────────────────────────────────────

  server.tool(
    'start_security_run',
    'Start (or re-run) a security inspection. Creates a SecurityRun + a ChatRoom, adds the ' +
    'profile\'s target agent, and posts the rendered inspection prompt (which carries the ' +
    'incremental baseline when applicable). Returns run_id + room_id. Call again with the same ' +
    'profile to re-run — a fresh SecurityRun is stacked, preserving history.',
    { profile_id: z.string().describe('SecurityProfile ID to run') },
    async ({ profile_id }, extra: { sessionId?: string }) => {
      if (!securityRunService) return err('security run service unavailable in this MCP context');
      const caller = getCallerAgent(extra);
      try {
        const result = await securityRunService.startRun({
          profileId: profile_id,
          triggeredByType: caller?.agentId ? 'agent' : 'system',
          triggeredById: caller?.agentId ?? '',
        });
        return ok({ run_id: result.run.id, room_id: result.room_id, prompt: result.prompt });
      } catch (e: any) {
        return err(e?.message || 'Failed to start security run');
      }
    },
  );

  server.tool(
    'refresh_security_checklist',
    'Refresh a security profile\'s checklist with the LATEST security knowledge. Dispatches a task ' +
    'to the profile\'s target agent (in a fresh ChatRoom) instructing it to WebSearch/WebFetch the ' +
    'current OWASP Top 10, recent CVE/GHSA advisories for this stack (read from package.json), and ' +
    'Node/Express security guidance, then fold the result back into the checklist via ' +
    'update_security_profile — each item carrying a `source` link. This is NOT a SecurityRun (it ' +
    'updates the checklist, not findings). Returns room_id + the dispatched prompt.',
    { profile_id: z.string().describe('SecurityProfile ID whose checklist to refresh') },
    async ({ profile_id }, extra: { sessionId?: string }) => {
      if (!securityRunService) return err('security run service unavailable in this MCP context');
      const caller = getCallerAgent(extra);
      try {
        const result = await securityRunService.startChecklistRefresh({
          profileId: profile_id,
          triggeredByType: caller?.agentId ? 'agent' : 'system',
          triggeredById: caller?.agentId ?? '',
        });
        return ok({ profile_id: result.profile_id, room_id: result.room_id, prompt: result.prompt });
      } catch (e: any) {
        return err(e?.message || 'Failed to refresh security checklist');
      }
    },
  );

  server.tool(
    'record_security_finding',
    'Record one finding on a running SecurityRun. Re-recording the same finding id overwrites it. ' +
    'For multiple findings, call once per finding. Attach report/SBOM/dump artifacts separately ' +
    'with save_resource + attach_security_artifact.',
    {
      run_id: z.string().describe('SecurityRun ID'),
      workspace_id: z.string().describe('Workspace ID (required, scope guard)'),
      finding: findingSchema.describe('The finding to record'),
    },
    async ({ run_id, workspace_id, finding }) => {
      if (!securityRunService) return err('security run service unavailable in this MCP context');
      try {
        const row = await securityRunService.recordFindings(run_id, workspace_id, [finding]);
        return ok(runToJson(row));
      } catch (e: any) {
        return err(e?.message || 'Failed to record security finding');
      }
    },
  );

  server.tool(
    'attach_security_artifact',
    'Attach one or more artifact Resource ids (report/SBOM/dump) to a SecurityRun at the run level.',
    {
      run_id: z.string().describe('SecurityRun ID'),
      workspace_id: z.string().describe('Workspace ID (required, scope guard)'),
      resource_ids: z.array(z.string()).describe('Resource ids to attach'),
    },
    async ({ run_id, workspace_id, resource_ids }) => {
      if (!securityRunService) return err('security run service unavailable in this MCP context');
      try {
        const row = await securityRunService.attachArtifact(run_id, workspace_id, resource_ids);
        return ok(runToJson(row));
      } catch (e: any) {
        return err(e?.message || 'Failed to attach security artifact');
      }
    },
  );

  server.tool(
    'complete_security_run',
    'Finalize a SecurityRun. `status`: "passed" if there are no critical/high findings, else ' +
    '"failed" ("error" if the inspection could not complete). `scanned_commit` is the worktree ' +
    'HEAD SHA you inspected — REQUIRED on a PASS, since it becomes the profile\'s new incremental ' +
    'baseline. `scope_used` reports the scope you actually used (report "full" if you promoted ' +
    'from incremental). Stamps finished_at.',
    {
      run_id: z.string().describe('SecurityRun ID'),
      workspace_id: z.string().describe('Workspace ID (required, scope guard)'),
      status: z.enum(['passed', 'failed', 'error']).describe('Final run status'),
      scanned_commit: z.string().optional().describe('Worktree HEAD SHA inspected (becomes the new baseline on a PASS)'),
      scope_used: z.enum(['incremental', 'full']).optional().describe('Scope actually used (report "full" if promoted)'),
      summary: z.string().optional().describe('Human-readable run summary (counts by severity + headline risks)'),
    },
    async ({ run_id, workspace_id, status, scanned_commit, scope_used, summary }) => {
      if (!securityRunService) return err('security run service unavailable in this MCP context');
      try {
        const row = await securityRunService.completeRun(run_id, workspace_id, status, {
          summary,
          scannedCommit: scanned_commit,
          scopeUsed: scope_used,
        });
        return ok(runToJson(row));
      } catch (e: any) {
        return err(e?.message || 'Failed to complete security run');
      }
    },
  );

  server.tool(
    'list_security_runs',
    'List runs for a security-inspection profile, newest first (history). Each run carries status, ' +
    'findings, scanned_commit/baseline_commit/scope_used for comparison across re-runs.',
    {
      profile_id: z.string().describe('SecurityProfile ID'),
      workspace_id: z.string().describe('Workspace ID (required)'),
      limit: z.number().optional().describe('Max rows (default 20, cap 100)'),
    },
    async ({ profile_id, workspace_id, limit }) => {
      if (!securityRunService) return err('security run service unavailable in this MCP context');
      try {
        const rows = await securityRunService.listRuns(profile_id, workspace_id, limit ?? 20);
        return ok(rows.map(runToJson));
      } catch (e: any) {
        return err(e?.message || 'Failed to list security runs');
      }
    },
  );

  server.tool(
    'get_security_run',
    'Get a single security run with its findings and accumulated artifact_resource_ids.',
    {
      run_id: z.string().describe('SecurityRun ID'),
      workspace_id: z.string().describe('Workspace ID (required)'),
    },
    async ({ run_id, workspace_id }) => {
      if (!securityRunService) return err('security run service unavailable in this MCP context');
      try {
        const row = await securityRunService.getRun(run_id, workspace_id);
        return ok(runToJson(row));
      } catch (e: any) {
        return err(e?.message || 'security run not found');
      }
    },
  );

  // ── Batches (수동 전체 점검 — sequential multi-profile runs) ───────────────────

  server.tool(
    'start_security_batch',
    'Start a SEQUENTIAL batch of several security inspections ("수동 전체 점검") — profile N+1 only ' +
    'dispatches after profile N reaches a terminal status (passed/failed/error), never all at once. ' +
    'Pass an ordered `profile_ids` list, OR `all: true` to expand to every enabled profile in scope ' +
    '(board_id "" = workspace-scope, <uuid> = that board, omit = all) RESOLVED AT DISPATCH TIME (so ' +
    'profile add/remove is reflected automatically). `stop_on_fail` (default false) halts the batch on ' +
    'the first non-passed run. Returns the batch with current_index/total + pass/fail rollup; poll ' +
    'get_security_batch for progress.',
    {
      workspace_id: z.string().describe('Workspace ID (required)'),
      board_id: z.string().optional().describe('Scope for `all`: "" → workspace-scope, <uuid> → board, omit → all'),
      profile_ids: z.array(z.string()).optional().describe('Ordered profile ids to run (takes precedence over `all`)'),
      all: z.boolean().optional().describe('Run every enabled profile in scope, in name order'),
      stop_on_fail: z.boolean().optional().describe('Halt on first non-passed run (default false → continue)'),
    },
    async ({ workspace_id, board_id, profile_ids, all, stop_on_fail }, extra: { sessionId?: string }) => {
      if (!securityRunService) return err('security run service unavailable in this MCP context');
      const caller = getCallerAgent(extra);
      try {
        const batch = await securityRunService.startBatch({
          workspaceId: workspace_id,
          boardId: board_id,
          profileIds: profile_ids,
          all: !!all,
          stopOnFail: !!stop_on_fail,
          triggeredByType: caller?.agentId ? 'agent' : 'system',
          triggeredById: caller?.agentId ?? '',
        });
        return ok(batchToJson(batch));
      } catch (e: any) {
        return err(e?.message || 'Failed to start security batch');
      }
    },
  );

  server.tool(
    'get_security_batch',
    'Get a sequential security batch: ordered profile_ids + run_ids, current_index/total progress, ' +
    'status (running/done/aborted), and the passed/failed/errored rollup.',
    {
      batch_id: z.string().describe('SecurityRunBatch ID'),
      workspace_id: z.string().describe('Workspace ID (required)'),
    },
    async ({ batch_id, workspace_id }) => {
      if (!securityRunService) return err('security run service unavailable in this MCP context');
      try {
        const batch = await securityRunService.getBatch(batch_id, workspace_id);
        return ok(batchToJson(batch));
      } catch (e: any) {
        return err(e?.message || 'security batch not found');
      }
    },
  );
}
