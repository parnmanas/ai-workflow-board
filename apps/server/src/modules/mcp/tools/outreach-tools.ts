/**
 * Outreach MCP tools (ticket 20fa0197). The only tool here —
 * `record_outreach_classification` — is the completion half of
 * AgentDispatchClassifier's dispatch: the agent seated in the classification
 * ChatRoom calls this exactly once to report category + confidence, which
 * resolves the classify() call still awaiting it via ClassificationBridgeService.
 *
 * 2500fea3 (the source ticket) deliberately added no outreach MCP tools —
 * this is the first one, now that AgentDispatchClassifier is the first agent
 * consumer of the outreach pipeline.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ok, err } from '../shared/helpers';
import { getCallerAgent } from '../shared/session-auth';
import type { ToolContext } from './context';

const CATEGORIES = ['bug', 'feature_request', 'question', 'noise'] as const;

export function registerOutreachTools(server: McpServer, ctx: ToolContext): void {
  const { classificationBridgeService } = ctx;

  server.tool(
    'record_outreach_classification',
    'Report the classification result for one outreach inbound item back to the dispatch ' +
    'that is waiting on it — the room prompt that dispatched you names the run_id to use. ' +
    'Call exactly once per dispatch; a stale, unknown, or already-resolved run_id is a no-op error.',
    {
      run_id: z.string().describe('Run id from the dispatch prompt'),
      category: z.enum(CATEGORIES).describe('bug | feature_request | question | noise'),
      confidence: z.number().min(0).max(100).describe('0-100 confidence in this classification'),
    },
    async ({ run_id, category, confidence }, extra: { sessionId?: string }) => {
      if (!classificationBridgeService) return err('outreach classification bridge unavailable in this MCP context');
      const caller = getCallerAgent(extra);
      if (!caller?.agentId) return err('record_outreach_classification requires an authenticated agent session');
      const accepted = classificationBridgeService.report(run_id, caller.agentId, category, Math.round(confidence));
      if (!accepted) return err('run_id not found, already resolved/timed out, or dispatched to a different agent');
      return ok({ success: true, run_id });
    },
  );
}
