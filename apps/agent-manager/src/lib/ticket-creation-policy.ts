/** Shared by native sessions and chat, including persistent follow-up turns. */
export const DIRECT_WORK_POLICY = [
  'AWB work policy:',
  '- Perform requested work directly in this session or conversation by default, regardless of task size.',
  '- Create AWB tickets, including child tickets and follow-up tickets, only when the user explicitly requests ticket creation for that work. Requests to implement, fix, investigate, plan, deploy, or continue are not requests to create a ticket.',
  '- Do not ask whether to create a ticket as a prerequisite to doing the work. Report blockers or suggested follow-ups in your reply; missing tools and newly discovered work do not authorize ticket creation.',
  '- If the user asks you to work on an existing ticket, use that ticket; do not create another one.',
].join('\n');
