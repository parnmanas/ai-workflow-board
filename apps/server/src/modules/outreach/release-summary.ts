/**
 * ReleaseSummarizer — turns "what changed since the last publish" into a
 * post/reply body for OutreachPublisherService (ticket d86d0c24 step 4).
 *
 * Same interface+fake scope cut as OutreachClassifier (classifier/types.ts
 * docstring, ticket 2500fea3 D5): a real LLM-backed summarizer is a follow-up
 * ticket (this codebase's only synchronous "AI judgment" calls are the rule-
 * based classifier and embedding.service.ts's OpenAI embedding — every real
 * generative-LLM interaction elsewhere is an async agent-dispatch pattern,
 * which a synchronous summarize() doesn't fit). `TemplateReleaseSummarizer`
 * is deterministic and fake-HTTP-testable, satisfying the ticket's completion
 * criteria; the mandatory approval gate (OutreachOutboundPost status='draft'
 * + REST approve-with-body-override) is what lets a human upgrade a
 * template body before it ever reaches Reddit, so this cut does not weaken
 * the "no ad-tone posts" requirement.
 *
 * DI token mirrors OUTREACH_CLASSIFIER exactly (classifier/types.ts).
 */
export const OUTREACH_RELEASE_SUMMARIZER = 'OUTREACH_RELEASE_SUMMARIZER';

export interface ReleaseDoneTicket {
  id: string;
  title: string;
}

export interface ReleaseSummaryInput {
  environment: string;
  deployedCommitSha: string;
  /** '' when this is the first publish for the channel — no diff base yet. */
  previousCommitSha: string;
  /** Tickets that reached Done since the previous publish, oldest first. */
  doneTickets: ReleaseDoneTicket[];
}

export interface ReleaseSummary {
  title: string;
  body: string;
}

export interface ReleaseSummarizer {
  summarize(input: ReleaseSummaryInput): Promise<ReleaseSummary>;
}

// Fixed disclosure footer — the ticket's bot-account-convention requirement
// ("봇임을 밝히는 문구 준수"). Every generated body carries this verbatim;
// approval-time edits (step 6) may reword it but a template body never omits it.
const BOT_DISCLOSURE_FOOTER = '*This update was posted automatically by an AWB outreach bot.*';

function shortSha(sha: string): string {
  return sha ? sha.slice(0, 12) : '(unknown)';
}

/**
 * Deterministic, non-promotional template: a bullet list of what shipped
 * (ticket titles only — no marketing copy) plus the environment/commit and
 * the bot disclosure footer. No keyword/tone scoring — that is exactly the
 * kind of judgment the real (LLM) summarizer earns its follow-up ticket for.
 */
export class TemplateReleaseSummarizer implements ReleaseSummarizer {
  async summarize(input: ReleaseSummaryInput): Promise<ReleaseSummary> {
    const title = `Update — ${input.environment} (${shortSha(input.deployedCommitSha)})`;

    const lines: string[] = [];
    if (input.doneTickets.length > 0) {
      lines.push('Changes in this release:');
      for (const t of input.doneTickets) lines.push(`- ${t.title}`);
    } else {
      lines.push('This release contains maintenance/infrastructure changes with no user-facing ticket log.');
    }
    lines.push('');
    lines.push(`Environment: ${input.environment}`);
    lines.push(`Commit: ${shortSha(input.deployedCommitSha)}`);
    if (input.previousCommitSha) lines.push(`Previous: ${shortSha(input.previousCommitSha)}`);
    lines.push('');
    lines.push(BOT_DISCLOSURE_FOOTER);

    return { title, body: lines.join('\n') };
  }
}
