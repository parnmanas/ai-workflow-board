/**
 * PromptTemplate drift check — ticket 4a48a0b8, a recurrence-prevention
 * follow-up to 623400e7.
 *
 * Background: 623400e7's migration 1760000000076 landed on `main` but this
 * workspace's serving deployment (`production.private`) was 21 minutes
 * behind, so the migration file didn't exist in the running code yet — an
 * expected, self-resolving deploy-lag gap (the next redeploy applies it via
 * DatabaseModule.onModuleInit()'s `runMigrations()`, see D-02 in `db.ts`).
 * That specific incident wasn't a bug, but it exposed a class of silent
 * failure this check targets instead: a content-refresh migration IS
 * recorded as applied (present in the `migrations` history table), yet a
 * workspace's live `PromptTemplate.content` row is still byte-exact stuck on
 * the PRIOR (pre-migration) snapshot — e.g. a future migration's byte-match
 * WHERE-equivalent logic missing a row's actual pre-image, or a crash
 * between recording the migration and finishing its row updates. Ordinary
 * deploy lag (migration not yet applied at all) is explicitly NOT flagged —
 * only "applied per history, but content didn't actually move" is drift.
 *
 * Registry: every content-refresh migration exports a `PRIOR_*_CONTENTS`
 * snapshot of the template content it's about to replace (established
 * pattern — 1760000000022/30/31/36/42/44/46/49/52/72/73/76). This file
 * imports each one directly rather than discovering them dynamically, so a
 * new content-refresh migration must add itself to DRIFT_REGISTRY below to
 * be covered — same explicit-registration style as DEFAULT_PROMPT_TEMPLATES.
 */
import { DataSource } from 'typeorm';
import { PromptTemplate } from '../entities/PromptTemplate';

import {
  PRIOR_DEFAULT_CONTENTS as PRIOR_V0_34_3_CONTENTS,
  RefreshDefaultPromptTemplatesV0_34_31760000000022,
} from './migrations/1760000000022-RefreshDefaultPromptTemplatesV0_34_3';
import {
  PRIOR_INTEGRATE_CONTENTS,
  RefreshDefaultPromptTemplatesIntegrate1760000000030,
} from './migrations/1760000000030-RefreshDefaultPromptTemplatesIntegrate';
import {
  PRIOR_OVERLAP_CHECK_CONTENTS,
  RefreshDefaultPromptTemplatesOverlapCheck1760000000031,
} from './migrations/1760000000031-RefreshDefaultPromptTemplatesOverlapCheck';
import {
  PRIOR_CLEANUP_VERIFY_CONTENTS,
  RefreshDefaultPromptTemplatesCleanupVerify1760000000036,
} from './migrations/1760000000036-RefreshDefaultPromptTemplatesCleanupVerify';
import {
  PRIOR_REVIEW_REBASE_CONTENTS,
  RefreshDefaultPromptTemplatesReviewRebase1760000000042,
} from './migrations/1760000000042-RefreshDefaultPromptTemplatesReviewRebase';
import {
  PRIOR_FOLLOWUP_GATE_CONTENTS,
  RefreshDefaultPromptTemplatesFollowupGate1760000000044,
} from './migrations/1760000000044-RefreshDefaultPromptTemplatesFollowupGate';
import {
  PRIOR_CONSENSUS_GATE_CONTENTS,
  RefreshDefaultPromptTemplatesConsensusGate1760000000046,
} from './migrations/1760000000046-RefreshDefaultPromptTemplatesConsensusGate';
import {
  PRIOR_WORK_FOLDER_CONTENTS,
  RefreshDefaultPromptTemplatesWorkFolder1760000000049,
} from './migrations/1760000000049-RefreshDefaultPromptTemplatesWorkFolder';
import {
  PRIOR_DEFAULT_CONTENTS as PRIOR_ACTION_GATE_CONTENTS,
  RefreshDefaultPromptTemplatesActionGate1760000000052,
} from './migrations/1760000000052-RefreshDefaultPromptTemplatesActionGate';
import {
  PRIOR_DEFAULT_CONTENTS as PRIOR_PROMPT_AUDIT_CONTENTS,
  RefreshDefaultPromptTemplatesPromptAudit1760000000072,
} from './migrations/1760000000072-RefreshDefaultPromptTemplatesPromptAudit';
import {
  PRIOR_REVIEW_DRIFT_CONTENTS,
  RefreshDefaultPromptTemplatesReviewDrift1760000000073,
} from './migrations/1760000000073-RefreshDefaultPromptTemplatesReviewDrift';
import {
  PRIOR_CI_DISPATCH_GATE_CONTENTS,
  RefreshDefaultPromptTemplatesCiDispatchGate1760000000076,
} from './migrations/1760000000076-RefreshDefaultPromptTemplatesCiDispatchGate';

export interface DriftRegistryEntry {
  /** Matches the `name` column TypeORM writes into the `migrations` history table. */
  migrationName: string;
  /** template name -> list of prior content snapshots (newest-relevant first), same shape the migration itself byte-matches against. */
  priorContents: Record<string, string[]>;
}

export const DRIFT_REGISTRY: DriftRegistryEntry[] = [
  { migrationName: new RefreshDefaultPromptTemplatesV0_34_31760000000022().name, priorContents: PRIOR_V0_34_3_CONTENTS },
  { migrationName: new RefreshDefaultPromptTemplatesIntegrate1760000000030().name, priorContents: PRIOR_INTEGRATE_CONTENTS },
  { migrationName: new RefreshDefaultPromptTemplatesOverlapCheck1760000000031().name, priorContents: PRIOR_OVERLAP_CHECK_CONTENTS },
  { migrationName: new RefreshDefaultPromptTemplatesCleanupVerify1760000000036().name, priorContents: PRIOR_CLEANUP_VERIFY_CONTENTS },
  { migrationName: new RefreshDefaultPromptTemplatesReviewRebase1760000000042().name, priorContents: PRIOR_REVIEW_REBASE_CONTENTS },
  { migrationName: new RefreshDefaultPromptTemplatesFollowupGate1760000000044().name, priorContents: PRIOR_FOLLOWUP_GATE_CONTENTS },
  { migrationName: new RefreshDefaultPromptTemplatesConsensusGate1760000000046().name, priorContents: PRIOR_CONSENSUS_GATE_CONTENTS },
  { migrationName: new RefreshDefaultPromptTemplatesWorkFolder1760000000049().name, priorContents: PRIOR_WORK_FOLDER_CONTENTS },
  { migrationName: new RefreshDefaultPromptTemplatesActionGate1760000000052().name, priorContents: PRIOR_ACTION_GATE_CONTENTS },
  { migrationName: new RefreshDefaultPromptTemplatesPromptAudit1760000000072().name, priorContents: PRIOR_PROMPT_AUDIT_CONTENTS },
  { migrationName: new RefreshDefaultPromptTemplatesReviewDrift1760000000073().name, priorContents: PRIOR_REVIEW_DRIFT_CONTENTS },
  { migrationName: new RefreshDefaultPromptTemplatesCiDispatchGate1760000000076().name, priorContents: PRIOR_CI_DISPATCH_GATE_CONTENTS },
];

export interface PromptTemplateDrift {
  workspace_id: string;
  template_name: string;
  migration_name: string;
}

export interface PromptTemplateDriftCheckResult {
  migrations_registered: number;
  migrations_applied: number;
  rows_checked: number;
  drifted: PromptTemplateDrift[];
}

/**
 * For every registered content-refresh migration that HAS run (present in
 * the `migrations` history table), verify no workspace's corresponding
 * template row is still byte-exact equal to that migration's PRIOR
 * (pre-migration) snapshot. A migration that hasn't run yet is skipped
 * entirely — that's ordinary deploy lag, not drift.
 */
export async function checkPromptTemplateDrift(dataSource: DataSource): Promise<PromptTemplateDriftCheckResult> {
  const result: PromptTemplateDriftCheckResult = {
    migrations_registered: DRIFT_REGISTRY.length,
    migrations_applied: 0,
    rows_checked: 0,
    drifted: [],
  };
  if (DRIFT_REGISTRY.length === 0) return result;

  const appliedRows: Array<{ name: string }> = await dataSource.query('SELECT name FROM migrations');
  const appliedNames = new Set(appliedRows.map((r) => r.name));

  const applicableEntries = DRIFT_REGISTRY.filter((entry) => appliedNames.has(entry.migrationName));
  result.migrations_applied = applicableEntries.length;
  if (applicableEntries.length === 0) return result;

  // One query per DISTINCT template name (not per workspace) — an install
  // with dozens of workspaces would otherwise pay workspaces × names ×
  // migrations sequential round trips for what is a one-shot boot check.
  const tplRepo = dataSource.getRepository(PromptTemplate);
  const rowsByName = new Map<string, PromptTemplate[]>();
  const distinctNames = new Set<string>();
  for (const entry of applicableEntries) {
    for (const name of Object.keys(entry.priorContents)) distinctNames.add(name);
  }
  for (const name of distinctNames) {
    rowsByName.set(name, await tplRepo.find({ where: { name } }));
  }

  for (const entry of applicableEntries) {
    for (const templateName of Object.keys(entry.priorContents)) {
      const priorVariants = entry.priorContents[templateName];
      for (const row of rowsByName.get(templateName) ?? []) {
        result.rows_checked += 1;
        if (priorVariants.includes(row.content)) {
          result.drifted.push({ workspace_id: row.workspace_id || '', template_name: templateName, migration_name: entry.migrationName });
        }
      }
    }
  }
  return result;
}
