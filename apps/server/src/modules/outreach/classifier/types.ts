import { InboundItem } from '../connectors/types';

/** NestJS DI token — OutreachClassifier is an interface, so it needs a token
 *  to bind against (the default provider is RuleBasedClassifier). */
export const OUTREACH_CLASSIFIER = 'OUTREACH_CLASSIFIER';

export type OutreachCategory = 'bug' | 'feature_request' | 'question' | 'noise';

export interface ClassificationResult {
  category: OutreachCategory;
  /** 0-100, same scale as TicketDuplicateDecision.confidence. */
  confidence: number;
}

/**
 * OutreachClassifier — tags one inbound item. A real (LLM-backed) classifier
 * is a follow-up ticket (ticket 2500fea3 D5): no server code makes a real
 * generative-LLM call today (the only external AI call is
 * embedding.service.ts's OpenAI embedding for Resource search), and every
 * existing "AI judgment" in this codebase is an async agent-dispatch pattern
 * (comment-summary, Action run, QA/Security run) rather than a synchronous
 * classify() — matching that shape is out of scope here, mirroring the
 * connector cut (interface + fake now, real implementation later).
 */
export interface OutreachClassifier {
  classify(item: InboundItem): Promise<ClassificationResult>;
}
