/**
 * Build & Artifact Registry MCP tools (ticket 80d52250).
 *
 * A `BuildArtifact` is a first-class, server-authoritative record of "this commit
 * of this repo was built for this target → here is the resulting artifact". These
 * tools let a QA/dev agent turn "always rebuild" into "check the registry, reuse
 * if this exact commit is already built, otherwise build + register":
 *
 *   - get_latest_artifact   — freshness read: is THIS commit already built? (is_fresh)
 *   - register_build_artifact — record a successful build (default status 'ok')
 *   - report_build_failure  — record a failed build AND finalize the linked QaRun
 *                             as `build_failed` (first-class build death, no phantom)
 *
 * The registry is the deterministic replacement for the `last_built_commit`
 * heuristic (which flipped WARM whenever a commit was stamped, even if stale).
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { BuildArtifact } from '../../../entities/BuildArtifact';
import { buildRepoRefSchema } from '../../../common/build-artifact-options';
import { ok, err } from '../shared/helpers';
import { getCallerAgent } from '../shared/session-auth';
import type { ToolContext } from './context';

function buildArtifactToJson(a: BuildArtifact | null) {
  if (!a) return null;
  return {
    id: a.id,
    workspace_id: a.workspace_id,
    board_id: a.board_id,
    repo_key: a.repo_key,
    repo_resource_id: a.repo_resource_id,
    repo_url: a.repo_url,
    target: a.target,
    commit_sha: a.commit_sha,
    status: a.status,
    artifact_path: a.artifact_path,
    artifact_hash: a.artifact_hash,
    artifact_resource_id: a.artifact_resource_id,
    host: a.host,
    builder_agent_id: a.builder_agent_id,
    log_summary: a.log_summary,
    run_id: a.run_id,
    built_at: a.built_at ?? null,
    created_at: a.created_at,
    updated_at: a.updated_at,
  };
}

export function registerBuildTools(server: McpServer, ctx: ToolContext) {
  const { buildArtifactService, qaRunService } = ctx;

  server.tool(
    'get_latest_artifact',
    'Freshness read for the build registry: does an `ok` artifact already exist for this exact ' +
    'commit + target? Call this BEFORE building. Returns `{ artifact, commit_match, is_fresh }` — ' +
    'if `is_fresh` is true, `commit_match.artifact_path` is a usable build of THIS commit, so SKIP ' +
    'the build and reuse it. `artifact` is the newest `ok` build for the repo+target regardless of ' +
    'commit (provenance / fallback). Pass `host` to scope reuse to your machine (a Windows exe is ' +
    'only reusable on the machine that built it); legacy unscoped rows still match.',
    {
      workspace_id: z.string().describe('Workspace ID (required, scope guard)'),
      repo: buildRepoRefSchema,
      target: z.string().describe('Build target (platform/config), e.g. "StandaloneWindows64/Release". Must match what register used.'),
      commit_sha: z.string().optional().describe('The repo HEAD SHA you are about to test. Omit to just get the latest build. When set, is_fresh=true means this exact commit is already built.'),
      host: z.string().optional().describe('Your machine hostname — scopes reuse to artifacts built on this host (recommended).'),
    },
    async ({ workspace_id, repo, target, commit_sha, host }) => {
      if (!buildArtifactService) return err('Build artifact service unavailable in this MCP context');
      try {
        const res = await buildArtifactService.getLatest({ workspaceId: workspace_id, repo, target, commitSha: commit_sha, host });
        return ok({
          artifact: buildArtifactToJson(res.artifact),
          commit_match: buildArtifactToJson(res.commit_match),
          is_fresh: res.is_fresh,
        });
      } catch (e: any) {
        return err(e?.message || 'Failed to query build registry');
      }
    },
  );

  server.tool(
    'register_build_artifact',
    'Record a build in the registry so the next run (any scenario on the same repo+commit) can ' +
    'reuse it instead of rebuilding. Call this AFTER a successful build with the artifact path. ' +
    'Upserts by (workspace, repo, target, commit_sha, host) — a rebuild of the same commit updates ' +
    'the existing row. Default status is `ok`; pass status `building` to claim an in-flight build.',
    {
      workspace_id: z.string().describe('Workspace ID (required, scope guard)'),
      repo: buildRepoRefSchema,
      target: z.string().describe('Build target (platform/config), e.g. "StandaloneWindows64/Release". Keep it stable across runs so artifacts share.'),
      commit_sha: z.string().describe('The exact repo commit SHA this artifact was built from (git rev-parse HEAD).'),
      artifact_path: z.string().optional().describe('Where the artifact lives on this machine (abs or agent-home-relative) — what a warm run reuses.'),
      artifact_hash: z.string().optional().describe('Optional content hash for integrity/dedupe.'),
      artifact_resource_id: z.string().optional().describe('Optional Resource id if the artifact was also uploaded as a Resource blob.'),
      host: z.string().optional().describe('Machine hostname — reuse is same-machine, so record it (e.g. $(hostname)).'),
      log_summary: z.string().optional().describe('Optional build log summary.'),
      run_id: z.string().optional().describe('Optional linked QaRun id that produced this build.'),
      status: z.enum(['building', 'ok', 'failed']).optional().describe('Default "ok". Use "building" to claim an in-flight build; "failed" is better done via report_build_failure.'),
    },
    async ({ workspace_id, repo, target, commit_sha, artifact_path, artifact_hash, artifact_resource_id, host, log_summary, run_id, status }, extra: { sessionId?: string }) => {
      if (!buildArtifactService) return err('Build artifact service unavailable in this MCP context');
      const caller = getCallerAgent(extra);
      try {
        const row = await buildArtifactService.register({
          workspaceId: workspace_id,
          repo,
          target,
          commitSha: commit_sha,
          artifactPath: artifact_path,
          artifactHash: artifact_hash,
          artifactResourceId: artifact_resource_id,
          host,
          logSummary: log_summary,
          runId: run_id,
          status,
          builderAgentId: caller?.agentId ?? '',
        });
        return ok(buildArtifactToJson(row));
      } catch (e: any) {
        return err(e?.message || 'Failed to register build artifact');
      }
    },
  );

  server.tool(
    'report_build_failure',
    'Report a build FAILURE as a first-class event. Records a `failed` artifact row (with the log ' +
    'tail) AND, when `run_id` is given, finalizes that QaRun as `build_failed` — a distinct terminal ' +
    'status (never a phantom `running` or a generic `error`) that files the build log onto the ' +
    'auto-created fix ticket. Call this INSTEAD of complete_qa_run when the build itself failed.',
    {
      workspace_id: z.string().describe('Workspace ID (required, scope guard)'),
      repo: buildRepoRefSchema,
      target: z.string().describe('Build target (platform/config) that failed to build.'),
      log_summary: z.string().describe('The build error / log tail (~last 40 lines). Required — this is the evidence carried onto the fix ticket.'),
      commit_sha: z.string().optional().describe('The repo HEAD SHA that failed to build, if known.'),
      host: z.string().optional().describe('Machine hostname where the build failed.'),
      run_id: z.string().optional().describe('The QaRun id to finalize as build_failed. Omit for a standalone (non-run) build failure.'),
    },
    async ({ workspace_id, repo, target, log_summary, commit_sha, host, run_id }, extra: { sessionId?: string }) => {
      if (!buildArtifactService) return err('Build artifact service unavailable in this MCP context');
      const caller = getCallerAgent(extra);
      try {
        const artifact = await buildArtifactService.reportFailure({
          workspaceId: workspace_id,
          repo,
          target,
          commitSha: commit_sha,
          host,
          logSummary: log_summary,
          runId: run_id,
          builderAgentId: caller?.agentId ?? '',
        });

        // First-class propagation into the run lifecycle (ticket #4). The build
        // log becomes the run summary so QaFailureTicketService carries it onto
        // the fix ticket. Only QaRun is finalized here (security is a follow-up);
        // a missing/foreign run_id degrades to a note rather than failing the report.
        let run: any = null;
        let run_finalized = false;
        let run_note: string | undefined;
        if (run_id) {
          if (!qaRunService) {
            run_note = 'run_id given but QA run service is unavailable in this MCP context — artifact recorded, run NOT finalized';
          } else {
            try {
              const summary = `빌드 실패 (build_failed) — target=${target}${commit_sha ? ` commit=${commit_sha}` : ''}\n\n\`\`\`\n${log_summary}\n\`\`\``;
              run = await qaRunService.completeRun(run_id, workspace_id, 'build_failed', summary);
              run_finalized = true;
            } catch (e: any) {
              run_note = `artifact recorded, but finalizing run ${run_id} failed: ${e?.message || e}`;
            }
          }
        }

        return ok({ artifact: buildArtifactToJson(artifact), run_finalized, run_status: run?.status ?? null, run_note });
      } catch (e: any) {
        return err(e?.message || 'Failed to report build failure');
      }
    },
  );
}
