// Run-workspace provisioning resolver (ticket 4 — QA/보안 시나리오 작업폴더 옵션화).
//
// Builds the `RunProvision` hint the server ships on a QA/security run dispatch
// so the agent-manager provisioner can prepare the working folder BEFORE the run
// subagent spawns. The repo source is resolved server-side here (the manager has
// no DB): a `repo_ref` is expanded into a concrete clone url the same way the
// ticket-trigger path expands board/workspace `environment_config` repos.
//
// Resolution order for the repo (first match wins):
//   1. repo_ref.url            — direct git url (escape hatch).
//   2. repo_ref.resource_id    — a checked-in repo Resource (workspace-scoped).
//   3. inherit                 — the first repository of the merged
//                                board ⊕ workspace `environment_config`.
// When none resolves the run still gets a `RunProvision` with `repo: null` —
// the manager just ensures the folder exists and the rendered prompt (ticket 3)
// still tells the agent what to do.

import { DataSource } from 'typeorm';
import { Resource } from '../entities/Resource';
import { Board } from '../entities/Board';
import { Workspace } from '../entities/Workspace';
import { mergeEnvironmentConfig } from './environment-config';
import {
  RunProvision,
  RunRepoSpec,
  WorkspaceFolderRepoRef,
  CheckoutMode,
  normalizeCheckoutMode,
  normalizeRepoRef,
  resolveWorkspaceFolder,
} from './workspace-folder-options';

export interface BuildRunProvisionInput {
  kind: 'qa' | 'security';
  /** Scenario / profile id — feeds the deterministic default folder. */
  id: string;
  runId: string;
  workspaceId: string;
  boardId: string | null;
  workspaceFolder: string | null | undefined;
  repoRef: WorkspaceFolderRepoRef | null | undefined;
  checkoutMode: CheckoutMode | null | undefined;
}

/**
 * Assemble the `RunProvision` for a run dispatch. Never throws — a lookup that
 * fails degrades the repo to null (the run still dispatches; only the
 * provisioner's clone is skipped) so a stale resource id can't wedge a run.
 */
export async function buildRunProvision(
  ds: DataSource,
  input: BuildRunProvisionInput,
): Promise<RunProvision> {
  const workspace_folder = resolveWorkspaceFolder(input.workspaceFolder, input.kind, input.id);
  const checkout_mode = normalizeCheckoutMode(input.checkoutMode);
  let repo: RunRepoSpec | null = null;
  try {
    repo = await resolveRunRepo(ds, input);
  } catch {
    repo = null;
  }
  return {
    kind: input.kind,
    run_id: input.runId,
    workspace_id: input.workspaceId,
    workspace_folder,
    checkout_mode,
    repo,
  };
}

async function resolveRunRepo(
  ds: DataSource,
  input: BuildRunProvisionInput,
): Promise<RunRepoSpec | null> {
  const ref = normalizeRepoRef(input.repoRef);

  // 1. Direct url.
  if (ref?.url) {
    return { url: ref.url, branch: ref.branch || undefined };
  }

  // 2. Checked-in repo Resource (workspace-scoped — a stale id pointing at
  //    another workspace's Resource never gets its url shipped).
  if (ref?.resource_id) {
    const r = await ds.getRepository(Resource).findOne({
      where: { id: ref.resource_id, workspace_id: input.workspaceId },
    });
    const url = (r?.url || '').trim();
    if (url) return { url, branch: ref.branch || (r?.default_branch || '').trim() || undefined };
    return null; // unresolvable resource → no repo
  }

  // 3. Inherit the first repository of the merged board ⊕ workspace env config.
  const board = input.boardId
    ? await ds.getRepository(Board).findOne({ where: { id: input.boardId } })
    : null;
  const ws = await ds.getRepository(Workspace).findOne({ where: { id: input.workspaceId } });
  const merged = mergeEnvironmentConfig(ws?.environment_config, board?.environment_config);
  const first = merged?.repositories?.[0];
  if (!first) return null;

  let url = (first.url || '').trim();
  let branch = (first.branch || '').trim();
  if (!url && first.resource_id) {
    const r = await ds.getRepository(Resource).findOne({
      where: { id: first.resource_id.trim(), workspace_id: input.workspaceId },
    });
    url = (r?.url || '').trim();
    if (!branch) branch = (r?.default_branch || '').trim();
  }
  if (!url) return null;
  return { url, branch: branch || undefined };
}
