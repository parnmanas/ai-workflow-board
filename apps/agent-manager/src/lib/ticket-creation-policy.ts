/** Shared by native sessions and chat, including persistent follow-up turns. */
export const DIRECT_WORK_POLICY = [
  'AWB work policy:',
  '- Perform requested work directly in this session or conversation by default, regardless of task size.',
  '- Create AWB tickets, including child tickets and follow-up tickets, only when the user explicitly requests ticket creation for that work. Requests to implement, fix, investigate, plan, deploy, or continue are not requests to create a ticket.',
  '- Do not ask whether to create a ticket as a prerequisite to doing the work. Report blockers or suggested follow-ups in your reply; missing tools and newly discovered work do not authorize ticket creation.',
  '- If the user asks you to work on an existing ticket, use that ticket; do not create another one.',
].join('\n');

/** Remove only the manager-owned prefix; retain the actual prompt after it. */
export function stripDirectWorkPolicy(text: string): string {
  let rest = text.trimStart();
  if (!rest.startsWith(DIRECT_WORK_POLICY)) return text;
  rest = rest.slice(DIRECT_WORK_POLICY.length).trimStart();
  if (rest.startsWith('Session Git workflow: ')) rest = rest.replace(/^Session Git workflow: [^\n]*(?:\n|$)/, '').trimStart();
  return rest;
}

/** Native adapters may derive a (truncated) title from the injected first block. */
export function isDirectWorkPolicyTitle(title: string): boolean {
  return title.trimStart().startsWith('AWB work policy:');
}
