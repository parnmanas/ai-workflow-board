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
import { normalizeConfirmPolicy } from './orchestration.constants';

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

  // 사용자 확인 게이트(티켓 5dbe4aa2). graph 모드에서만 confirm node 를 만들 수 있으므로
  // graph 가 꺼진 미션에는 아예 노출하지 않는다 — 쓸 수도 없는 기능을 설명하면
  // orchestrator 가 만들 수 없는 계획을 짜고 제출에서 거부당한다.
  if (mission.graph_enabled) {
    lines.push(section('User confirmation gates', renderConfirmPolicyGuidance(mission.confirm_policy)));
  }

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

/**
 * 미션의 `confirm_policy` 를 orchestrator 가 계획에 반영할 수 있는 지시로 펼친다.
 *
 * `none` 만 서버가 강제한다(`validateGraphSpec` 이 confirm node 를 거부). 나머지는
 * 여기서 전달되는 지시가 전부다 — "몇 개면 key_steps 를 만족하는가" 를 서버가 셀 수
 * 없어서 정량 강제는 정상 계획까지 막는 브리틀한 게이트가 된다.
 */
export function renderConfirmPolicyGuidance(policy: string): string {
  const normalized = normalizeConfirmPolicy(policy);
  const intent = {
    none:
      `**This mission does NOT allow user confirmation gates.** Do not create any node with ` +
      `\`kind: "confirm"\` — the plan will be rejected. Plan the work to run end to end on its own.`,
    auto:
      `Use a confirm node **where a human judgement genuinely changes the outcome**: irreversible or ` +
      `outward-facing actions, work whose quality only a person can see (visual/UX output), and points ` +
      `where you are materially uncertain. Do not gate routine internal steps — every gate stops the ` +
      `mission until someone answers.`,
    key_steps:
      `Put a confirm node **before each key deliverable is locked in and before anything leaves the ` +
      `system** — publishing, deploying, sending, or handing a result to another team. Intermediate ` +
      `internal steps do not each need one.`,
    every_step:
      `Put a confirm node after **every step that produces a reviewable result**. The operator has asked ` +
      `to see the work as it goes; prefer more gates over fewer, but still skip steps whose output a ` +
      `person cannot meaningfully judge.`,
  }[normalized];

  if (normalized === 'none') return intent;

  return [
    `Current policy: **${normalized}**.`,
    ``,
    intent,
    ``,
    `How to write one:`,
    `- Add a normal step for it (\`step_key\`, \`title\`, and \`instructions\` written as **the question you`,
    `  are asking the person** — what to look at and what "pass" would mean). It needs **no assignee**.`,
    `- In the graph, mark that node \`kind: "confirm"\`.`,
    `- Give it **two outgoing edges**: one \`when: { verdict: ["pass"] }\` and one`,
    `  \`when: { verdict: ["fail"] }\`. Both are required — a confirm node with only one routed answer is`,
    `  rejected, because the other answer would silently dead-end the mission.`,
    `- The usual shape for "fail" is a \`loop_back\` edge to the step that has to be redone. The person's`,
    `  written feedback is handed to that step automatically when it re-runs.`,
    `- Evidence is automatic: whatever \`artifacts\` the upstream steps reported (screenshots, video, URLs,`,
    `  file paths) are attached to the confirm screen. If you want the person to see something specific,`,
    `  tell the upstream step to report it as an artifact.`,
    ``,
    `The mission **pauses** at a confirm node until a person answers — it does not time out, and you are`,
    `not woken for it. Budget for that wait when you decide how many gates to place.`,
  ].join('\n');
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
 * 이 step 에 도달할 수 있는 confirm node 가 사람에게서 받은 판정(티켓 5dbe4aa2).
 *
 * `dependencies` 와 **별개 축**이라 따로 받는다: 표준 형태인
 * `build → confirm ─(fail, loop_back)→ build` 에서 build 의 `depends_on` 에는 confirm 이
 * 없다(그 방향이면 순환이다). 그래서 dependency context 만으로는 사용자의 피드백이
 * 재실행되는 build 에 절대 도달하지 못한다 — 요구사항 5가 깨지는 정확한 지점이다.
 */
export interface ConfirmFeedbackContext {
  step_key: string;
  title: string;
  verdict: string;
  feedback: string;
  decided_by_name: string;
  decided_at: string;
  visit: number;
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
  /**
   * 그래프 모드에서 이 step이 맡은 node의 실행 계약(티켓 1ca9e49b). null이면
   * 기존 wave 프롬프트와 한 글자도 다르지 않다.
   */
  graphNode?: {
    kind: string;
    visit: number;
    max_visits: number;
    /** 이 node에서 나가는 분기가 기대하는 verdict 값들. */
    verdicts: string[];
  } | null;
  /** 이 step 으로 이어지는 confirm node 들의 사용자 판정(티켓 5dbe4aa2). */
  confirmFeedback?: ConfirmFeedbackContext[];
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

  // 복구 재개(티켓 4d065f82, 리뷰 라운드1 P0-2) — 이전 attempt 가 남긴 체크포인트를
  // 그대로 실어 보낸다. 이게 없으면 자동 재디스패치는 "처음부터 다시"와 같아져서
  // "재시작 후 이어서 재개"라는 요구가 성립하지 않는다.
  if (step.checkpoint) {
    lines.push(
      section(
        'Resume from this checkpoint',
        `A previous attempt of this step saved the state below before it went silent. Continue from it ` +
          `instead of starting over, and verify anything you did not do yourself:\n\n` +
          '```json\n' +
          JSON.stringify(step.checkpoint, null, 2).slice(0, 4000) +
          '\n```',
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

  const confirmFeedback = args.confirmFeedback ?? [];
  if (confirmFeedback.length > 0) {
    const failed = confirmFeedback.filter((c) => c.verdict === 'fail');
    const passed = confirmFeedback.filter((c) => c.verdict !== 'fail');
    const render = (c: ConfirmFeedbackContext) =>
      [
        `### ${c.title} (\`${c.step_key}\`) — ${c.verdict.toUpperCase()}` +
          `${c.decided_by_name ? `, by ${c.decided_by_name}` : ''} on pass ${c.visit}`,
        c.feedback || '(no reason given)',
      ].join('\n');
    const body = [
      ...(failed.length > 0
        ? [
            `A person reviewed this work and **rejected** it. Their feedback is the specification for this ` +
              `pass — address it directly; do not re-submit the same result:`,
            '',
            failed.map(render).join('\n\n'),
          ]
        : []),
      ...(failed.length > 0 && passed.length > 0 ? [''] : []),
      ...(passed.length > 0
        ? [
            `A person already approved the work upstream of you. Treat their notes as constraints you must ` +
              `not undo:`,
            '',
            passed.map(render).join('\n\n'),
          ]
        : []),
    ].join('\n');
    lines.push(section('User confirmation', body));
  }

  const graph = args.graphNode ?? null;
  if (graph && graph.max_visits > 1 && graph.visit > 1) {
    lines.push(
      section(
        `Revision pass ${graph.visit} of at most ${graph.max_visits}`,
        `An evaluator sent this work back for another pass. Everything you produced in the previous pass was ` +
          `reset — redo the work with the evaluator's feedback (above, in the results of the steps you depend ` +
          `on) applied. This loop stops after pass ${graph.max_visits} whether or not the evaluator is ` +
          `satisfied, so treat this pass as the one that has to land.`,
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
      ...(step.lease_token
        ? [
            `- \`lease_token\`: \`${step.lease_token}\` — copy this verbatim. It proves you are the attempt that`,
            `  is currently live. If this step gets re-dispatched while you work (a retry, or a loop re-entry),`,
            `  your token stops being valid and your report is refused rather than allowed to overwrite the`,
            `  newer attempt. Send it on progress heartbeats too.`,
          ]
        : []),
      ...(graph
        ? [
            `- \`visit\`: \`${graph.visit}\` — copy this number verbatim. It identifies which pass of this step`,
            `  you are reporting; a report carrying a stale number is rejected instead of overwriting a newer pass.`,
          ]
        : []),
      ...(graph && graph.verdicts.length > 0
        ? [
            `- \`verdict\`: **required for this step** — one of ${graph.verdicts.map((v) => `\`"${v}"\``).join(', ')}.`,
            `  The mission branches on this value: it decides which downstream step runs next, or whether the work`,
            `  goes back for another pass. Choose it from what you actually found, and explain the choice in`,
            `  \`summary\`. A missing or unrecognised verdict leaves every branch out of this step dead, which`,
            `  stalls the mission.`,
          ]
        : []),
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
 * lease 가 만료된 것으로 관측됐을 때 그 attempt 의 방에 포스트하는 재연결 요청
 * (티켓 4d065f82, 리뷰 라운드1 P0-1).
 *
 * 아직 살아 있는 작업자라면 이걸 읽고 heartbeat 하나만 보내도 lease 가 되살아난다 —
 * 그래서 "죽었다고 판정하기 전에 물어본다"는 유예 단계가 실제 동작을 갖는다.
 */
export function renderLeaseRecoveryNudge(args: {
  step: OrchestrationStep;
  silentMs: number;
  graceMs: number;
}): string {
  const { step, silentMs, graceMs } = args;
  const minutes = (ms: number) => Math.max(1, Math.round(ms / 60_000));
  return [
    `## Are you still working on "${step.title}"?`,
    ``,
    `We have not heard from you for ${minutes(silentMs)} minutes, so this step's lease is treated as stale.`,
    ``,
    `**If you are still working**, call \`mcp__awb__report_orchestration_progress\` right now with:`,
    `- \`step_id\`: \`${step.id}\``,
    ...(step.lease_token ? [`- \`lease_token\`: \`${step.lease_token}\``] : []),
    `- \`message\`: what you are doing`,
    `- \`checkpoint\` (recommended): the state a fresh attempt would need to resume from where you are`,
    ``,
    `That single call renews the lease and nothing else happens.`,
    ``,
    `**If you do not answer within ${minutes(graceMs)} minutes**, the step is re-dispatched as a new attempt`,
    `and anything you report afterwards is refused — your lease token stops being valid the moment the new`,
    `attempt goes out. So do not keep working silently: either check in, or stop.`,
  ].join('\n');
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
