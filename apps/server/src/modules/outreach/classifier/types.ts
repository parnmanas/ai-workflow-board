import { InboundItem } from '../connectors/types';
import { OutreachChannelKind } from '../../../entities/OutreachChannel';

/** NestJS DI token — OutreachClassifier is an interface, so it needs a token
 *  to bind against (the default provider is AgentDispatchClassifier, which
 *  itself falls back to RuleBasedClassifier — see that class's docstring). */
export const OUTREACH_CLASSIFIER = 'OUTREACH_CLASSIFIER';

export type OutreachCategory = 'bug' | 'feature_request' | 'question' | 'noise';

export interface ClassificationResult {
  category: OutreachCategory;
  /** 0-100, same scale as TicketDuplicateDecision.confidence. */
  confidence: number;
}

/**
 * Per-call context classify() needs beyond the item's own content. `item`
 * (InboundItem) carries no workspace/channel reference at all — it's the
 * channel-agnostic connector shape — so a dispatch-based classifier that
 * needs to open a chat room (workspace-scoped) and pick a target agent
 * (channel-configured) has no way to get there from `item` alone.
 */
export interface ClassificationContext {
  workspaceId: string;
  channelId: string;
  channelKind: OutreachChannelKind;
  /** OutreachChannel.classifier_agent_id — null means "stay rule-based". */
  classifierAgentId: string | null;
}

/**
 * OutreachClassifier — tags one inbound item. A real (LLM-backed) classifier
 * is ticket 20fa0197 (2500fea3 D5's follow-up): AgentDispatchClassifier wraps
 * the async agent-dispatch pattern every other "AI judgment" in this codebase
 * uses (comment-summary, Action run, QA/Security run) — dispatch a chat room,
 * the agent reports back via record_outreach_classification — with
 * RuleBasedClassifier as the synchronous fallback when no agent is
 * configured, dispatch fails, or the agent doesn't report back in time.
 */
export interface OutreachClassifier {
  classify(item: InboundItem, context: ClassificationContext): Promise<ClassificationResult>;
}
