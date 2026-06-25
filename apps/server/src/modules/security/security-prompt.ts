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
          const source = c.source ? `\n     ↳ source: ${c.source}` : '';
          return `  - [\`${id}\`] **${c.title || '(untitled)'}**${cat}${sev}${guidance}${source}`;
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

/**
 * Render the instruction prompt for the `refresh_security_checklist` flow.
 *
 * The ticket boundary is explicit: there is **no** server-side advisory-feed
 * service. "Pull the latest security info" is agent-driven — this prompt tells
 * the inspection agent to WebSearch/WebFetch current guidance and fold it back
 * into the profile's `checklist` via the existing `update_security_profile`
 * tool. The three buckets the agent must cover:
 *   (a) the current OWASP Top 10 edition,
 *   (b) recent CVE/GHSA advisories for THIS stack — the agent reads the repo's
 *       package.json files for the real dependency set (NestJS / TypeORM / React /
 *       @modelcontextprotocol/sdk / pg / sql.js / bcryptjs / zod / express …),
 *   (c) Node.js / Express security advisories.
 *
 * Critically, `update_security_profile.checklist` REPLACES the whole array
 * (the server normalizes whatever it's handed), so the prompt instructs the
 * agent to pass the FULL merged list — preserve the curated baseline items by id,
 * then add/refresh the freshly-sourced ones — each carrying a `source` link and
 * an `added_at` stamp. Kept a pure function so the MCP tool and the REST endpoint
 * render byte-identical prompts.
 */
export function renderChecklistRefreshPrompt(profile: SecurityProfile): string {
  const checklist = Array.isArray(profile.checklist) ? profile.checklist : [];
  const existingLines = checklist.length
    ? checklist
        .map((c, i) => {
          const id = c.id || `item-${i}`;
          const cat = c.category ? ` _(${c.category})_` : '';
          const src = c.source ? ` — source: ${c.source}` : '';
          return `  - [\`${id}\`] ${c.title || '(untitled)'}${cat}${src}`;
        })
        .join('\n')
    : '  (empty — this refresh seeds the checklist from scratch)';

  return [
    `# Refresh security checklist: ${profile.name}`,
    ``,
    `Your job is to **bring this profile's security checklist up to date with current`,
    `security knowledge** and write it back. There is no server-side advisory feed —`,
    `you gather the latest information yourself with \`WebSearch\` / \`WebFetch\`.`,
    ``,
    `**Profile id:** \`${profile.id}\`  ·  **workspace_id:** \`${profile.workspace_id}\``,
    ``,
    `## Current checklist (${checklist.length} item${checklist.length === 1 ? '' : 's'})`,
    existingLines,
    ``,
    `## What to research (cover all three)`,
    `1. **OWASP Top 10 — current edition.** Search for the latest published OWASP Top 10`,
    `   (e.g. "OWASP Top 10 latest") and map each relevant category to a checklist item.`,
    `2. **CVE/GHSA for THIS stack.** Read the repo's dependency manifests first —`,
    `   \`apps/server/package.json\`, \`apps/client/package.json\`, \`apps/agent-manager/package.json\`,`,
    `   and the root \`package.json\` — to get the real dependency set (NestJS, TypeORM,`,
    `   React, @modelcontextprotocol/sdk, pg, sql.js, bcryptjs, zod, express, …). Then`,
    `   search recent advisories (GitHub Security Advisories / CVE / npm audit) for those`,
    `   packages and add an item for any class of issue worth checking in our code.`,
    `3. **Node.js / Express security advisories.** Search for current Node.js & Express`,
    `   security best-practices / recent advisories and add items where they apply.`,
    ``,
    `## How to normalize each item`,
    `Produce checklist items shaped exactly like the existing ones:`,
    '```',
    `{ id, title, category, severity_hint, guidance, source, added_at }`,
    '```',
    `  - \`id\`: stable kebab-case id (reuse the existing id when refreshing a known item).`,
    `  - \`category\`: one of injection / authz / secrets / dependencies / crypto / ssrf /`,
    `    xss / config / input-validation / data-exposure (free-text, but prefer these).`,
    `  - \`severity_hint\`: \`critical\` | \`high\` | \`medium\` | \`low\` | \`info\`.`,
    `  - \`guidance\`: how to check it **in this codebase** (name the concrete hotspot when you can).`,
    `  - \`source\`: **REQUIRED for every item you add or refresh** — the OWASP/CWE URL, the`,
    `    CVE/GHSA id, or the advisory URL you pulled it from. This is the whole point: every`,
    `    item must be backed by a link.`,
    `  - \`added_at\`: leave it off for new items (the server stamps it); keep the existing`,
    `    value when you carry a baseline item through unchanged.`,
    ``,
    `## How to write it back`,
    `Call \`update_security_profile\` ONCE with the **full merged checklist**:`,
    `  - \`profile_id\`: \`${profile.id}\``,
    `  - \`workspace_id\`: \`${profile.workspace_id}\``,
    `  - \`checklist\`: the COMPLETE array — preserve the curated baseline items above (by id),`,
    `    then add/refresh the freshly-sourced ones. The server REPLACES the checklist with`,
    `    whatever you pass, so do not omit the items you want to keep.`,
    ``,
    `Finally, post a short chat message summarizing what you changed: how many items added vs`,
    `refreshed, which OWASP edition you used, and the headline CVEs/advisories you folded in.`,
  ]
    .filter((l) => l !== undefined)
    .join('\n');
}
