/**
 * Prompt rendering for Orchestration mode.
 *
 * Two audiences, two very different contracts:
 *
 *   - The ORCHESTRATOR gets a planning brief. It is explicitly told NOT to do
 *     the work itself and to express every decision as an MCP tool call, because
 *     the server can only render a plan it was handed structurally — prose in
 *     the chat room is invisible to the mission state machine.
 *   - A MEMBER gets a work order. It is told to do the work directly and to
 *     close with exactly one `report_orchestration_step` call, because that
 *     call is the ONLY signal that unblocks its dependents.
 *
 * Both prompts are rendered server-side and posted as the opening message of a
 * dedicated ChatRoom, i.e. the same dispatch pipeline QA runs and Action runs
 * use. That means the agent-manager already knows how to spawn a subagent for
 * them and needs no change for this feature.
 *
 * The single most important line in each prompt is the terminal-report
 * instruction. A subagent that finishes its work but never calls the reporting
 * tool leaves its step in flight until the reaper times it out — so both
 * prompts repeat the contract at the top and at the bottom.
 */

import type { OrchestrationMission } from '../../entities/OrchestrationMission';
import type { OrchestrationStep } from '../../entities/OrchestrationStep';

export interface RosterEntry {
  agent_id: string;
  agent_name: string;
  role_label: string;
  capabilities: string;
  max_concurrent: number;
  is_online: boolean;
}

function section(title: string, body: string): string {
  const trimmed = (body || '').trim();
  if (!trimmed) return '';
  return `## ${title}\n${trimmed}\n`;
}

function renderRoster(roster: RosterEntry[]): string {
  if (roster.length === 0) return '(no members — you cannot delegate; report this immediately)';
  return roster
    .map((m) => {
      const bits = [`- **${m.agent_name}** (agent_id: \`${m.agent_id}\`)`];
      if (m.role_label) bits.push(`  - role: ${m.role_label}`);
      bits.push(`  - concurrent step capacity: ${m.max_concurrent}`);
      bits.push(`  - currently: ${m.is_online ? 'online' : 'offline (work will queue until it connects)'}`);
      if (m.capabilities) bits.push(`  - capabilities: ${m.capabilities}`);
      return bits.join('\n');
    })
    .join('\n');
}

/**
 * The opening brief posted into the Mission room. Sent once when the mission
 * starts, and again (with `replan: true`) whenever an operator explicitly asks
 * the orchestrator to reconsider.
 */
export function renderMissionPrompt(args: {
  mission: OrchestrationMission;
  teamName: string;
  teamPrompt: string;
  roster: RosterEntry[];
  replan?: boolean;
}): string {
  const { mission, teamName, teamPrompt, roster } = args;
  const lines: string[] = [];

  lines.push(
    args.replan
      ? `# Orchestration Mission — REPLAN REQUESTED: ${mission.title}`
      : `# Orchestration Mission: ${mission.title}`,
  );
  lines.push('');
  lines.push(
    `You are the **orchestrator** of team "${teamName}". You own this mission end to end: ` +
      `you break it into steps, decide who does what, watch the results come back, and decide when it is done.`,
  );
  lines.push('');
  lines.push(`Mission id: \`${mission.id}\``);
  lines.push('');

  lines.push(section('Objective', mission.objective));
  if (mission.context) lines.push(section('Context', mission.context));
  if (mission.method) lines.push(section('Method — how to approach this', mission.method));
  if (mission.acceptance_criteria) lines.push(section('Acceptance criteria', mission.acceptance_criteria));
  if (Array.isArray(mission.completion_criteria) && mission.completion_criteria.length > 0) {
    const body = mission.completion_criteria
      .map((c) => `- [${c.met ? 'x' : ' '}] \`${c.key}\` — ${c.description}${c.note ? ` (${c.note})` : ''}`)
      .join('\n');
    lines.push(
      section(
        'Structured completion criteria (BLOCKING)',
        `${body}\n\ncomplete_orchestration_mission(status:"completed") is REJECTED until every item above is ` +
          `checked. Flip one with \`mcp__awb__update_orchestration_criteria\` once you have verified it — do ` +
          `not check one you have not actually confirmed.`,
      ),
    );
  }
  if (teamPrompt) lines.push(section('Team standing instructions', teamPrompt));

  lines.push(section('Your team', renderRoster(roster)));

  lines.push('## How this works');
  lines.push(
    [
      `1. Call \`mcp__awb__get_orchestration_mission\` with mission_id \`${mission.id}\` FIRST. It returns the`,
      `   live roster, the current plan, every step result so far, and the recent timeline. Do this even now —`,
      `   the mission may already be part-way through if you are being woken up rather than started.`,
      `2. Decide the plan. Size it to the work: a small mission may be 2–3 steps, a large one 8–15. Do not`,
      `   invent busywork steps, and do not collapse genuinely parallel work into one serial step.`,
      `3. Submit it with \`mcp__awb__submit_orchestration_plan\`. Each step needs a \`step_key\` (short slug),`,
      `   a \`title\`, \`instructions\` written for the assignee (they do NOT see this brief), an`,
      `   \`assignee_agent_id\` from the roster above, and \`depends_on\` listing the step_keys that must`,
      `   finish first. Steps with no shared dependency run in PARALLEL, so express real independence.`,
      `4. The server dispatches every step whose dependencies are satisfied, up to`,
      `   ${mission.max_parallel_steps} at a time. You do not need to dispatch them yourself.`,
      `5. You will be woken in this room when a step fails or blocks, when nothing further can be dispatched,`,
      `   and when every step has finished. While work is progressing on its own you are NOT woken — that is`,
      `   normal. On each wake: call \`get_orchestration_mission\` again, then act — retry, reassign, add`,
      `   steps, or finish.`,
      `6. When the acceptance criteria are met, call \`mcp__awb__complete_orchestration_mission\` with a`,
      `   \`summary\` of what was delivered. If the mission cannot be delivered, call it with`,
      `   \`status: "failed"\` and explain why. **The mission never ends on its own — only this call ends it.**`,
    ].join('\n'),
  );
  lines.push('');

  lines.push('## Rules');
  lines.push(
    [
      `- **Delegate, do not execute.** Your job is planning, assignment, review and judgement. Do not write`,
      `  the code, run the migrations, or produce the deliverable yourself — that is what the team is for.`,
      `  Reading the repo, inspecting existing tickets and verifying a member's claim IS your job.`,
      `- **Every decision must be a tool call.** Prose in this room does not move the mission. If you decide`,
      `  to retry a step, call \`update_orchestration_step\`; if you decide to add work, submit a new plan.`,
      `- **Write instructions the assignee can act on cold.** They get only your \`instructions\`, the mission`,
      `  objective, and the results of the steps they depend on. Include file paths, commands, and`,
      `  acceptance criteria.`,
      `- **Handle failure explicitly.** A failed step blocks everything downstream. Either retry it`,
      `  (\`update_orchestration_step\` with \`action: "retry"\`, optionally reassigning), route around it with`,
      `  a revised plan, or fail the mission. Do not leave it sitting.`,
      `- Budget: at most ${mission.max_steps} steps total and ${mission.max_plan_versions} plan submissions`,
      `  for this mission. Plan accordingly.`,
    ].join('\n'),
  );
  lines.push('');
  lines.push(
    `Start now: call \`mcp__awb__get_orchestration_mission\` (mission_id \`${mission.id}\`), then ` +
      `\`mcp__awb__submit_orchestration_plan\`.`,
  );

  return lines.filter((l) => l !== '').join('\n');
}

export interface DependencyContext {
  step_key: string;
  title: string;
  status: string;
  assignee_name: string;
  result_summary: string;
  artifacts: Array<{ kind: string; ref: string; label: string }>;
}

/**
 * The work order posted into a Step room. This is the ONLY thing the member
 * agent sees — it never reads the mission brief — so it has to carry enough
 * mission context to be actionable on its own.
 */
export function renderStepPrompt(args: {
  mission: OrchestrationMission;
  step: OrchestrationStep;
  teamName: string;
  orchestratorName: string;
  dependencies: DependencyContext[];
  isRetry: boolean;
  /** agent-manager가 스폰 전에 프로비저닝하는 working_dir-relative 폴더(티켓 2dc3c62f). */
  workspaceFolder?: string;
}): string {
  const { mission, step, teamName, orchestratorName, dependencies } = args;
  const lines: string[] = [];

  lines.push(
    args.isRetry
      ? `# Assigned task (RETRY, attempt ${step.attempt}): ${step.title}`
      : `# Assigned task: ${step.title}`,
  );
  lines.push('');
  lines.push(
    `${orchestratorName} (orchestrator of team "${teamName}") has assigned you this step of the mission ` +
      `**${mission.title}**. Do the work directly and report the result — you are the agent meant to do this.`,
  );
  lines.push('');
  lines.push(`Step id: \`${step.id}\`  ·  step_key: \`${step.step_key}\`  ·  mission id: \`${mission.id}\``);
  lines.push('');

  lines.push(section('Mission objective (why this step exists)', mission.objective));
  if (mission.method) lines.push(section('Method — how the orchestrator wants this approached', mission.method));
  if (args.workspaceFolder) {
    lines.push(
      section(
        'Working folder (server-decided — do NOT improvise)',
        `\`<working_dir>/${args.workspaceFolder}\` — prepared for you and set as your current directory before ` +
          `you were spawned. Work only here; do not \`cd\` elsewhere or clone a fresh copy yourself.`,
      ),
    );
  }
  lines.push(section('Your task', step.instructions));
  if (step.acceptance_criteria) lines.push(section('Done when', step.acceptance_criteria));

  if (dependencies.length > 0) {
    const body = dependencies
      .map((d) => {
        const bits = [`### ${d.title} (\`${d.step_key}\`) — ${d.status}, by ${d.assignee_name || 'unknown'}`];
        bits.push(d.result_summary || '(no summary reported)');
        if (d.artifacts.length > 0) {
          bits.push('Artifacts:');
          for (const a of d.artifacts) bits.push(`- ${a.kind}: ${a.ref}${a.label ? ` — ${a.label}` : ''}`);
        }
        return bits.join('\n');
      })
      .join('\n\n');
    lines.push(
      section(
        'Results of the steps you depend on',
        `${body}\n\nBuild on this work — do not redo it.`,
      ),
    );
  }

  if (args.isRetry && step.result_summary) {
    lines.push(
      section(
        'Previous attempt',
        `The previous attempt did not succeed. Its report was:\n\n${step.result_summary}\n\n` +
          `Read it before starting so you do not repeat the same failure.`,
      ),
    );
  }

  lines.push('## Reporting (required)');
  lines.push(
    [
      `When you are finished — successfully or not — call **\`mcp__awb__report_orchestration_step\`** exactly`,
      `once with:`,
      `- \`step_id\`: \`${step.id}\``,
      `- \`status\`: \`"done"\` if you met the acceptance criteria, \`"failed"\` if you tried and could not,`,
      `  \`"blocked"\` if something outside your control stops you (missing access, unclear spec, upstream bug).`,
      `- \`summary\`: what you did, what you changed, and anything the next agent must know. Downstream steps`,
      `  receive this text verbatim as their context, so write it for them, not for a human reader.`,
      `- \`artifacts\` (optional): PR urls, branch names, ticket ids, file paths you produced.`,
      ``,
      `For long work, call \`mcp__awb__report_orchestration_progress\` along the way so the mission board shows`,
      `you are alive — it does not end the step.`,
      ``,
      `**Nothing downstream of you can start until you make that report call.** Do not end your turn without`,
      `it, and do not report \`done\` for work you did not actually verify.`,
    ].join('\n'),
  );

  return lines.filter((l) => l !== '').join('\n');
}

/**
 * The system-authored nudge posted into the Mission room to wake the
 * orchestrator after step activity. Kept terse on purpose: the orchestrator is
 * told to re-read live state through the tool rather than trust a snapshot
 * embedded in a message that may already be stale by the time it is processed.
 */
export function renderWakePrompt(args: {
  mission: OrchestrationMission;
  reason: 'step_failed' | 'step_blocked' | 'all_steps_terminal' | 'stalled' | 'manual';
  detail: string;
  counts: { total: number; done: number; failed: number; inFlight: number; pending: number };
}): string {
  const { mission, reason, detail, counts } = args;
  const headline = {
    step_failed: 'A step FAILED and needs your decision.',
    step_blocked: 'A step is BLOCKED and needs your decision.',
    all_steps_terminal: 'Every step has reached a terminal state.',
    stalled: 'The mission has nothing left to dispatch but is not finished.',
    manual: 'An operator asked you to reassess this mission.',
  }[reason];

  const lines = [
    `# Orchestrator wake-up — ${mission.title}`,
    '',
    headline,
    '',
    detail.trim(),
    '',
    `Progress: ${counts.done}/${counts.total} done · ${counts.failed} failed/blocked · ` +
      `${counts.inFlight} in flight · ${counts.pending} not started.`,
    '',
    `Call \`mcp__awb__get_orchestration_mission\` (mission_id \`${mission.id}\`) for the authoritative state, ` +
      `then act:`,
    `- retry or reassign a step → \`mcp__awb__update_orchestration_step\``,
    `- add / restructure work → \`mcp__awb__submit_orchestration_plan\` (it merges into the existing plan)`,
    `- finish → \`mcp__awb__complete_orchestration_mission\``,
    '',
    `Do not simply acknowledge this message — the mission only advances through a tool call.`,
  ];
  return lines.join('\n');
}
