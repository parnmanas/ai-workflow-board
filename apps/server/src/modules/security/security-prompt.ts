import { SecurityProfile } from '../../entities/SecurityProfile';
import { SecurityRun } from '../../entities/SecurityRun';

/**
 * Render the instruction prompt sent to the inspection agent when a
 * SecurityRun starts.
 *
 * The prompt tells the agent to (1) resolve the worktree HEAD, (2) decide the
 * inspection scope — incremental (diff baseline..HEAD) vs full — applying the
 * profile's `checklist`, (3) record each finding via record_security_finding,
 * and (4) finish with complete_security_run, reporting back the scanned HEAD
 * SHA and the scope it actually used.
 *
 * The incremental-scoping rule is the heart of this prompt: when the run carries
 * a `baseline_commit` (scope_mode=incremental and the profile has a
 * last_passed_commit), the agent diffs `baseline..HEAD` and focuses on the
 * change — BUT must promote to a full inspection if any change touches a
 * security-sensitive area (auth/guards/crypto/SQL/input-validation/dependencies)
 * or if there is no usable baseline. The server has no local clone, so the agent
 * runs git itself inside its worktree; the server only stored/forwarded the
 * baseline SHA.
 *
 * Kept as a pure function so MCP start_security_run and the REST endpoint produce
 * byte-identical output for the same inputs.
 */
export function renderSecurityRunPrompt(profile: SecurityProfile, run: SecurityRun): string {
  const checklist = Array.isArray(profile.checklist) ? profile.checklist : [];
  const cfg = profile.scan_driver_config && Object.keys(profile.scan_driver_config).length
    ? JSON.stringify(profile.scan_driver_config, null, 2)
    : '(none)';

  const target = profile.target_resource_id
    ? `Resource \`${profile.target_resource_id}\``
    : "AWB's own codebase (your worktree)";

  const checklistLines = checklist.length
    ? checklist
        .map((c, i) => {
          const id = c.id || `item-${i}`;
          const cat = c.category ? ` _(${c.category})_` : '';
          const sev = c.severity_hint ? ` — severity hint: \`${c.severity_hint}\`` : '';
          const guidance = c.guidance ? `\n     ${c.guidance}` : '';
          return `  - [\`${id}\`] **${c.title || '(untitled)'}**${cat}${sev}${guidance}`;
        })
        .join('\n')
    : '  (no checklist defined — apply general OWASP Top 10 / authz / secrets / input-validation review)';

  // Scope block: incremental (baseline present) vs full.
  const incremental = run.scope_used === 'incremental' && !!run.baseline_commit;
  const scopeBlock = incremental
    ? [
        `**Planned scope: INCREMENTAL** — baseline \`${run.baseline_commit}\`.`,
        ``,
        `1. Resolve HEAD: \`git rev-parse HEAD\` (in your worktree).`,
        `2. List the changed files since the last passing inspection:`,
        '   ```',
        `   git diff --stat ${run.baseline_commit}..HEAD`,
        '   ```',
        `3. Inspect **those changed files first**, applying the checklist to the diff.`,
        `4. **Promote to a FULL inspection** (scan the whole codebase, not just the diff) if ANY`,
        `   changed file touches a security-sensitive area — authentication, guards/authorization,`,
        `   crypto, SQL/query building, input validation/sanitization, or dependency manifests`,
        `   (package.json / lockfiles) — OR if the baseline is unreachable (\`git cat-file -e ${run.baseline_commit}^{commit}\` fails).`,
        `   If you promote, report \`scope_used: "full"\` at completion.`,
      ].join('\n')
    : [
        `**Planned scope: FULL** — no usable baseline (first run, or full scope_mode).`,
        ``,
        `1. Resolve HEAD: \`git rev-parse HEAD\` (in your worktree).`,
        `2. Inspect the **whole codebase** against the checklist.`,
      ].join('\n');

  return [
    `# Security Inspection: ${profile.name}`,
    ``,
    `You are running a security inspection with the **${profile.scan_driver || 'code-review'}** driver`,
    `against ${target}.`,
    profile.description ? `\n${profile.description}\n` : ``,
    `**Driver config:**`,
    '```json',
    cfg,
    '```',
    ``,
    `**Run id:** \`${run.id}\``,
    ``,
    `## Scope`,
    scopeBlock,
    ``,
    `## Checklist`,
    checklistLines,
    ``,
    `## How to record findings`,
    `For every issue you find, call \`record_security_finding\` with:`,
    `  - \`run_id\`: \`${run.id}\``,
    `  - \`finding\`: \`{ id, severity, title, category?, file?, line?, evidence?, remediation?, checklist_item_id? }\``,
    `    - \`severity\`: one of \`critical\` | \`high\` | \`medium\` | \`low\` | \`info\``,
    `    - \`id\`: a stable id for the finding (re-recording the same id overwrites it)`,
    `    - \`checklist_item_id\`: the checklist item id this maps to, when applicable`,
    `Attach any report/SBOM/dump artifacts with \`save_resource\` + \`attach_security_artifact\`.`,
    ``,
    `## How to finish`,
    `When done, call \`complete_security_run\` with:`,
    `  - \`run_id\`: \`${run.id}\``,
    `  - \`status\`: \`passed\` if there are **no \`critical\` or \`high\` findings**, otherwise \`failed\` (\`error\` if you could not complete the inspection)`,
    `  - \`scanned_commit\`: the HEAD SHA you resolved in step 1 (required — this becomes the new incremental baseline on a PASS)`,
    `  - \`scope_used\`: \`incremental\` or \`full\` (report \`full\` if you promoted)`,
    `  - \`summary\`: a short overall summary (counts by severity + headline risks)`,
    ``,
    `A PASS advances this profile's baseline to \`scanned_commit\`, so the next incremental run only diffs from there.`,
  ]
    .filter((l) => l !== undefined)
    .join('\n');
}
