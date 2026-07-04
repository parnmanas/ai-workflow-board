/**
 * Feature/Epic intake MCP tools (ticket aae7644c) — the *entry point* of the
 * one-stop automated development loop.
 *
 * Flow the tools drive (no new execution engine — the deliverables are ordinary
 * tickets that the existing trigger loop / prerequisites machinery runs):
 *
 *   submit_feature_request  → create the intake + auto-dispatch a planning round
 *                             to the planner agent (fresh chat room spawn).
 *                             Chat promotion ("이거 기능으로 등록해줘") calls this
 *                             with `source_chat_room_id`.
 *   propose_feature_chain    → the planner submits a STRUCTURED chain proposal
 *                             (tickets + prerequisite edges), moving the Feature
 *                             to `proposed` (awaiting approval).
 *   approve_feature          → human/reporter accepts: the server atomically
 *                             creates every ticket, wires prereq edges, and
 *                             dispatches the root ticket(s) — the chain runs.
 *   reject_feature           → reporter rejects with feedback → re-plan round.
 *   list_features / get_feature → read the intake + progress rollup.
 *
 * Scope mirrors the workspace-schedule tools: `featuresService` is present only
 * in NestJS-integrated mode (the planning dispatch + atomic chain build need the
 * DI-wired trigger/prereq/messaging services). Standalone context omits it, so
 * every tool degrades to an explicit error.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Feature } from '../../../entities/Feature';
import type { FeatureRollup } from '../../features/features.service';
import { ok, err } from '../shared/helpers';
import { getCallerAgent } from '../shared/session-auth';
import type { ToolContext } from './context';

function featureToJson(f: Feature, rollup?: FeatureRollup) {
  return {
    id: f.id,
    workspace_id: f.workspace_id,
    board_id: f.board_id,
    title: f.title,
    requirement: f.requirement,
    status: f.status,
    planner_agent_id: f.planner_agent_id,
    proposal: f.proposal ?? null,
    generated_ticket_ids: f.generated_ticket_ids ?? [],
    planning_room_id: f.planning_room_id,
    feedback: f.feedback,
    source_chat_room_id: f.source_chat_room_id,
    created_by: f.created_by,
    created_at: f.created_at,
    updated_at: f.updated_at,
    ...(rollup ? { rollup } : {}),
  };
}

// zod shape mirroring FeatureProposedTicket / FeatureChainEdge in entities/Feature.
const proposedTicketShape = z.object({
  key: z.string().describe('Stable reference within THIS proposal (e.g. "t1"). Edges reference these.'),
  title: z.string().describe('Ticket title'),
  description: z.string().optional().describe('Ticket description / requirement body'),
  priority: z.enum(['low', 'medium', 'high', 'critical']).optional(),
  labels: z.array(z.string()).optional(),
  effort_preset: z.string().nullable().optional().describe('Abstract effort preset id (resolved per-CLI at dispatch). null/"" = board default'),
  column_name: z.string().optional().describe('Target column NAME (case-insensitive). Omit → board first routed column'),
  assignee_id: z.string().optional().describe('Assignee agent id. Omit → defaults to the Feature planner/creator'),
  reporter_id: z.string().optional(),
  reviewer_id: z.string().optional(),
});

const edgeShape = z.object({
  from: z.string().describe('proposal-local key of the prerequisite (blocker) ticket'),
  to: z.string().describe('proposal-local key of the dependent ticket — starts only after `from` reaches a terminal column'),
});

export function registerFeatureTools(server: McpServer, ctx: ToolContext): void {
  const { featuresService } = ctx;

  server.tool(
    'submit_feature_request',
    'Submit a feature/epic INTAKE — the entry point of the one-stop automated development loop. Captures one ' +
    'long requirement/spec and (unless auto_plan=false) immediately dispatches a PLANNING round to the planner ' +
    'agent: a fresh chat room is opened seating `planner_agent_id`, which is asked to research and call ' +
    '`propose_feature_chain` with a structured ticket chain. Use `source_chat_room_id` for the chat-promotion ' +
    'path ("이거 기능으로 등록해줘"). `board_id` is required — the approved chain lands on that board.',
    {
      workspace_id: z.string().describe('Workspace ID (required)'),
      board_id: z.string().describe('Target board the generated ticket chain lands on (required)'),
      title: z.string().describe('Short feature title'),
      requirement: z.string().describe('The raw requirement / spec text (free-form, multi-line)'),
      planner_agent_id: z.string().optional().describe('Agent the planning round dispatches to. Omit → the caller agent'),
      source_chat_room_id: z.string().optional().describe('Chat room this was promoted from (chat-promotion provenance)'),
      auto_plan: z.boolean().optional().describe('Dispatch the planning round immediately (default true)'),
    },
    async (args, extra: { sessionId?: string }) => {
      if (!featuresService) return err('Features service unavailable in this MCP context');
      const caller = getCallerAgent(extra);
      try {
        const feature = await featuresService.create({
          workspace_id: args.workspace_id,
          board_id: args.board_id,
          title: args.title,
          requirement: args.requirement,
          planner_agent_id: args.planner_agent_id,
          source_chat_room_id: args.source_chat_room_id,
          created_by: caller?.agentName ?? '',
          created_by_id: caller?.agentId ?? undefined,
          auto_plan: args.auto_plan,
        });
        const rollup = await featuresService.rollup(feature);
        return ok(featureToJson(feature, rollup));
      } catch (e: any) {
        return err(e?.message || 'Failed to submit feature request');
      }
    },
  );

  server.tool(
    'propose_feature_chain',
    'Submit a STRUCTURED chain proposal for a Feature intake (the planner deliverable — NOT free text). The ' +
    'server renders a preview and, on approval, builds this exact chain atomically. Provide `tickets` (3~5, ' +
    'high-cohesion, in reading order) and `edges` (prerequisite links; linear chain = t1→t2→t3). The first ' +
    'ticket with no incoming edge auto-starts on approval; dependents auto-resume when their blocker reaches a ' +
    'terminal column. Moves the Feature to `proposed` (awaiting reporter approval).',
    {
      feature_id: z.string().describe('Feature intake ID'),
      summary: z.string().optional().describe('One-line summary of the decomposition strategy (shown in preview)'),
      tickets: z.array(proposedTicketShape).min(1).describe('Tickets to create, in reading order (each with a unique `key`)'),
      edges: z.array(edgeShape).optional().describe('Prerequisite edges [{from, to}] — from must finish before to starts'),
    },
    async ({ feature_id, summary, tickets, edges }) => {
      if (!featuresService) return err('Features service unavailable in this MCP context');
      try {
        const feature = await featuresService.proposeChain(feature_id, {
          summary,
          tickets: tickets as any,
          edges: edges as any,
        });
        return ok(featureToJson(feature));
      } catch (e: any) {
        return err(e?.message || 'Failed to propose feature chain');
      }
    },
  );

  server.tool(
    'approve_feature',
    'Approve the current proposal of a `proposed` Feature: atomically create every proposed ticket, wire the ' +
    'prerequisite edges, then dispatch the root ticket(s) so the existing board loop takes over. Idempotent — ' +
    're-approving a `running`/`done` Feature returns the already-generated ticket ids. Returns the Feature + the ' +
    'created ticket ids + the progress rollup.',
    {
      feature_id: z.string().describe('Feature intake ID (must be in `proposed` state)'),
    },
    async ({ feature_id }) => {
      if (!featuresService) return err('Features service unavailable in this MCP context');
      try {
        const { feature, ticket_ids } = await featuresService.approve(feature_id);
        const rollup = await featuresService.rollup(feature);
        return ok({ ...featureToJson(feature, rollup), ticket_ids });
      } catch (e: any) {
        return err(e?.message || 'Failed to approve feature');
      }
    },
  );

  server.tool(
    'reject_feature',
    'Reject the current proposal of a `proposed` Feature with feedback. By default (replan=true) the feedback is ' +
    'threaded back into a fresh planning round so the planner can revise. Pass replan=false to park the Feature ' +
    'in `rejected` without re-dispatching.',
    {
      feature_id: z.string().describe('Feature intake ID (must be in `proposed` state)'),
      feedback: z.string().describe('Why the proposal was rejected / what to change (threaded to the re-plan prompt)'),
      replan: z.boolean().optional().describe('Re-dispatch a planning round with the feedback (default true)'),
    },
    async ({ feature_id, feedback, replan }) => {
      if (!featuresService) return err('Features service unavailable in this MCP context');
      try {
        const feature = await featuresService.reject(feature_id, feedback, { replan });
        return ok(featureToJson(feature));
      } catch (e: any) {
        return err(e?.message || 'Failed to reject feature');
      }
    },
  );

  server.tool(
    'list_features',
    'List feature intakes in a workspace (newest first). Optionally scope to a single board with `board_id`.',
    {
      workspace_id: z.string().describe('Workspace ID (required)'),
      board_id: z.string().optional().describe('Scope to a single board; omit for all boards in the workspace'),
    },
    async ({ workspace_id, board_id }) => {
      if (!featuresService) return err('Features service unavailable in this MCP context');
      try {
        const rows = await featuresService.list(workspace_id, board_id);
        return ok(rows.map((r) => featureToJson(r)));
      } catch (e: any) {
        return err(e?.message || 'Failed to list features');
      }
    },
  );

  server.tool(
    'get_feature',
    'Get a single feature intake + its progress rollup (N/M generated tickets done, and which column each sits ' +
    'in). Reading a `running` Feature whose every ticket has reached a terminal column lazily flips it to `done`.',
    {
      feature_id: z.string().describe('Feature intake ID'),
    },
    async ({ feature_id }) => {
      if (!featuresService) return err('Features service unavailable in this MCP context');
      try {
        const feature = await featuresService.get(feature_id);
        const rollup = await featuresService.rollup(feature);
        const fresh = await featuresService.get(feature_id);
        return ok(featureToJson(fresh, rollup));
      } catch (e: any) {
        return err(e?.message || 'Feature not found');
      }
    },
  );
}
