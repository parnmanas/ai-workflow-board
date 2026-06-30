import { QaScenario } from '../../entities/QaScenario';
import { renderWorkspaceFolderBlock } from '../../common/workspace-folder-options';

/**
 * Render the instruction prompt sent to the QA agent when a QaRun starts.
 *
 * The prompt tells the agent to drive the scenario's `qa_driver` MCP step by
 * step, recording each step's pass/fail + screenshot via `record_qa_step`, and
 * to finish with `complete_qa_run`. Kept as a pure function so MCP `start_qa_run`
 * and the REST endpoint produce byte-identical output for the same inputs.
 */
export function renderQaRunPrompt(scenario: QaScenario, runId: string): string {
  const steps = Array.isArray(scenario.steps) ? scenario.steps : [];
  const cfg = scenario.qa_driver_config && Object.keys(scenario.qa_driver_config).length
    ? JSON.stringify(scenario.qa_driver_config, null, 2)
    : '(none)';

  const stepLines = steps.length
    ? steps
        .map((s, i) => {
          const idx = typeof s.idx === 'number' ? s.idx : i;
          const tool = s.mcp_tool ? ` — tool: \`${s.mcp_tool}\`` : '';
          const params = s.params ? ` — params: \`${JSON.stringify(s.params)}\`` : '';
          const expect = s.expect ? `\n     expect: ${s.expect}` : '';
          return `  ${idx}. ${s.action}${tool}${params}${expect}`;
        })
        .join('\n')
    : '  (no steps defined — inspect the driver and report what you find)';

  return [
    `# QA Run: ${scenario.name}`,
    ``,
    `You are executing a QA scenario against the **${scenario.qa_driver || 'unspecified'}** driver.`,
    scenario.description ? `\n${scenario.description}\n` : ``,
    `**Driver config:**`,
    '```json',
    cfg,
    '```',
    ``,
    `**Run id:** \`${runId}\``,
    ``,
    renderWorkspaceFolderBlock({
      workspace_folder: scenario.workspace_folder,
      repo_ref: scenario.repo_ref,
      checkout_mode: scenario.checkout_mode,
      build_mode: scenario.build_mode,
      last_built_commit: scenario.last_built_commit,
      kind: 'qa',
      id: scenario.id,
    }),
    ``,
    `## Steps`,
    stepLines,
    ``,
    `## How to run`,
    `1. Use the QA driver MCP (the "${scenario.qa_driver}" driver) to perform each step **in order**.`,
    `2. After each step, capture evidence (screenshot / video / state dump) by uploading it as a Resource (\`save_resource\`), then call \`record_qa_step\` with:`,
    `   - \`run_id\`: \`${runId}\``,
    `   - \`idx\`: the step index`,
    `   - \`status\`: \`passed\` or \`failed\` (\`skipped\` if not reachable)`,
    `   - \`log\`: a short evidence note`,
    `   - \`artifact_resource_ids\`: the Resource id(s) you just uploaded`,
    `3. If a step fails, keep going where it makes sense, but record the failure.`,
    `4. When all steps are done, call \`complete_qa_run\` with \`run_id\` \`${runId}\`, a final \`status\` (\`passed\` if every step passed, otherwise \`failed\`/\`error\`), and a \`summary\`.`,
    `   - **On a PASS, also pass \`built_commit\`** = the repo HEAD SHA you built/tested (e.g. \`git -C <work folder> rev-parse HEAD\`). The server records it as this scenario's \`last_built_commit\` so the **next run builds warm** (incremental, minutes) instead of a full cold rebuild (~35min). Omit it and the next run stays cold.`,
    ``,
    `Refer to \`docs/qa-driver-guide.md\` for the driver contract (setup/do/observe/assert) and the step ↔ driver-action mapping.`,
  ]
    .filter((l) => l !== undefined)
    .join('\n');
}
