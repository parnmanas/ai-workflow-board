// Run-workspace provisioning resolver (ticket 4 — QA/보안 시나리오 작업폴더 옵션화).
//
// Builds the `RunProvision` hint the server ships on a QA/security/action/
// orchestration run dispatch so the agent-manager provisioner can prepare the
// working folder BEFORE the run subagent spawns. The repo source is resolved
// server-side here (the manager has no DB): a `repo_ref` is expanded into a
// concrete clone url.
//
// Resolution order for the repo (first match wins):
//   1. repo_ref.url        — direct git url (escape hatch).
//   2. repo_ref.project_id — a Project in the run's workspace (url /
//                            default_branch / credential / clone_policy).
// There is no inherited repo: the board ⊕ workspace `environment_config`
// fallback went away with boards (docs/tickets.md), so a run without a
// repo_ref gets a `RunProvision` with `repo: null` — the manager just ensures
// the folder exists and the rendered prompt still tells the agent what to do.
//
// A Project-sourced repo additionally ships its decrypted git `credential` so
// the manager can clone/fetch a PRIVATE repo — the server-side half of ticket
// 622bc350's run-provisioner credential wiring. A direct url stays anonymous by
// design: no Project → no Credential row to decrypt, and any auth is the url
// author's to embed. Credential resolution is availability-first — any failure
// degrades to an anonymous clone rather than wedging the run (see
// `resolveRepoCredential`).

import { DataSource } from 'typeorm';
import { Account } from '../entities/Account';
import { Credential } from '../entities/Credential';
import { ProjectsService } from '../modules/projects/projects.service';
import { resolveGitCredential } from '../modules/mcp/shared/git-branches';
import {
  RunProvision,
  RunRepoSpec,
  RunWorkspaceKind,
  WorkspaceFolderRepoRef,
  CheckoutMode,
  normalizeCheckoutMode,
  normalizeRepoRef,
  resolveWorkspaceFolder,
} from './workspace-folder-options';
import { resolveClonePolicy } from './clone-policy';

export interface BuildRunProvisionInput {
  kind: RunWorkspaceKind;
  /** scenario / profile / action / room id — 결정론적 기본 폴더 계산에 사용된다. */
  id: string;
  runId: string;
  accountId: string;
  workspaceFolder: string | null | undefined;
  repoRef: WorkspaceFolderRepoRef | null | undefined;
  checkoutMode: CheckoutMode | null | undefined;
}

/**
 * Assemble the `RunProvision` for a run dispatch. Never throws — a lookup that
 * fails degrades the repo to null (the run still dispatches; only the
 * provisioner's clone is skipped) so a stale project id can't wedge a run.
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
    account_id: input.accountId,
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

  // 2. Project — account-scoped, so a stale id pointing at another
  //    workspace's project never gets its url (or credential) shipped.
  //    ProjectsService is stateless over the DataSource, so this plain helper
  //    builds one instead of threading DI through every caller.
  if (!ref?.project_id) return null;
  const project = await new ProjectsService(ds).getInWorkspace(ref.project_id, input.accountId);
  const url = (project?.repo_url || '').trim();
  if (!project || !url) return null;
  const credential = await resolveRepoCredential(ds, project.credential_id, input.accountId);
  const clone_policy = await resolveRunClonePolicy(ds, project.clone_policy, input.accountId);
  return {
    url,
    branch: ref.branch || (project.default_branch || '').trim() || undefined,
    ...(credential ? { credential } : {}),
    ...(clone_policy ? { clone_policy } : {}),
  };
}

/**
 * Project → Account 순으로 clone 정책을 합친다(ticket bddb63ee). 조회 실패는
 * 정책 없음(null)으로 degrade — 이 resolver 의 다른 lookup 과 동일하게
 * availability-first 다.
 */
async function resolveRunClonePolicy(
  ds: DataSource,
  projectRaw: string | null | undefined,
  accountId: string,
) {
  try {
    const ws = await ds.getRepository(Account).findOne({ where: { id: accountId } });
    return resolveClonePolicy(projectRaw, ws?.clone_policy);
  } catch {
    return resolveClonePolicy(projectRaw, null);
  }
}

/**
 * Resolve the https git credential for a Project (its `credential_id` →
 * decrypted `{ username?, token }`), degrading to null on ANY failure so a
 * missing / foreign-workspace / undecryptable Credential never wedges the run —
 * the provisioner just falls back to an anonymous clone (the pre-wiring
 * behavior). Mirrors the availability-first stance the rest of this resolver
 * takes: `resolveGitCredential` THROWS on a foreign-workspace / tokenless /
 * unreadable credential, and we swallow that to null here (the run still
 * dispatches — only auth is skipped, exactly as today for a public repo).
 */
async function resolveRepoCredential(
  ds: DataSource,
  credentialId: string | null | undefined,
  accountId: string,
): Promise<{ username?: string; token: string } | null> {
  if (!credentialId) return null;
  try {
    const cred = await resolveGitCredential(ds.getRepository(Credential), credentialId, accountId);
    if (cred && cred.token) {
      return cred.username ? { username: cred.username, token: cred.token } : { token: cred.token };
    }
    return null;
  } catch {
    return null;
  }
}
