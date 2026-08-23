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
//   3. inherit                 — the merged board ⊕ workspace `environment_config`:
//                                the first entry that carries a resource_id, or
//                                (only if none do) the first url-only entry —
//                                mirrors pickBaseRepoResourceId's array scan on
//                                the dispatch path (ticket fff842c6).
// When none resolves the run still gets a `RunProvision` with `repo: null` —
// the manager just ensures the folder exists and the rendered prompt (ticket 3)
// still tells the agent what to do.
//
// A Resource-sourced repo (paths 2 & 3) additionally ships its decrypted git
// `credential` so the manager can clone/fetch a PRIVATE repo — the server-side
// half of ticket 622bc350's run-provisioner credential wiring. A direct url
// (path 1, or a direct env-config url) stays anonymous by design: no Resource →
// no Credential row to decrypt, and any auth is the url author's to embed.
// Credential resolution is availability-first — any failure degrades to an
// anonymous clone rather than wedging the run (see `resolveRepoCredential`).

import { DataSource } from 'typeorm';
import { Resource } from '../entities/Resource';
import { Board } from '../entities/Board';
import { Workspace } from '../entities/Workspace';
import { Credential } from '../entities/Credential';
import { resolveGitCredential } from '../modules/mcp/shared/git-branches';
import { mergeEnvironmentConfig } from './environment-config';
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

export interface BuildRunProvisionInput {
  kind: RunWorkspaceKind;
  /** scenario / profile / action / room id — 결정론적 기본 폴더 계산에 사용된다. */
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
    const r = await ds.getRepository(Resource).findOne({ where: { id: ref.resource_id } });
    if (r && r.workspace_id !== null && r.workspace_id !== input.workspaceId) return null;
    const url = (r?.url || '').trim();
    if (url) {
      const credential = await resolveRepoCredential(ds, r?.credential_id, input.workspaceId);
      return {
        url,
        branch: ref.branch || (r?.default_branch || '').trim() || undefined,
        ...(credential ? { credential } : {}),
      };
    }
    return null; // unresolvable resource → no repo
  }

  // 3. Inherit a repository of the merged board ⊕ workspace env config — prefer
  //    the FIRST entry that carries a resource_id (mirrors pickBaseRepoResourceId's
  //    array scan on the dispatch path, ticket 8c3befa8/fff842c6) so a QA/Security
  //    run and a ticket dispatch inheriting the SAME environment_config land on
  //    the SAME repo whenever a credentialed entry exists anywhere in the array.
  //    Only when NO entry has a resource_id do we fall back to the first url-only
  //    entry (anonymous clone) — a tier dispatch has no equivalent for (it would
  //    leave base_repo unbound instead), so this fallback never disagrees with
  //    dispatch, it only covers a case dispatch can't resolve at all.
  //    (이전엔 repositories[0]만 봐서, 레거시 multi-entry 설정에서 url-only
  //    entry가 0번을 차지하면 뒤쪽 resource_id entry를 영영 못 봤다 — ticket
  //    fff842c6에서 발견한 dispatch 경로와의 실제 정책 차이.)
  const board = input.boardId
    ? await ds.getRepository(Board).findOne({ where: { id: input.boardId } })
    : null;
  const ws = await ds.getRepository(Workspace).findOne({ where: { id: input.workspaceId } });
  const merged = mergeEnvironmentConfig(ws?.environment_config, board?.environment_config);
  const repos = merged?.repositories || [];
  const chosen = repos.find((r) => (r?.resource_id || '').trim())
    || repos.find((r) => (r?.url || '').trim());
  if (!chosen) return null;

  let url = (chosen.url || '').trim();
  let branch = (chosen.branch || '').trim();
  // Only a Resource-sourced repo carries auth: a direct env-config `url` (like
  // the direct-url escape hatch above) stays anonymous — its credential, if any,
  // is expected to be embedded in the url by whoever configured it.
  let credentialId: string | null = null;
  if (!url && chosen.resource_id) {
    const r = await ds.getRepository(Resource).findOne({ where: { id: chosen.resource_id.trim() } });
    if (r && r.workspace_id !== null && r.workspace_id !== input.workspaceId) return null;
    url = (r?.url || '').trim();
    if (!branch) branch = (r?.default_branch || '').trim();
    credentialId = r?.credential_id || null;
  }
  if (!url) return null;
  const credential = await resolveRepoCredential(ds, credentialId, input.workspaceId);
  return { url, branch: branch || undefined, ...(credential ? { credential } : {}) };
}

/**
 * Resolve the https git credential for a repo Resource (its `credential_id` →
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
  workspaceId: string,
): Promise<{ username?: string; token: string } | null> {
  if (!credentialId) return null;
  try {
    const cred = await resolveGitCredential(ds.getRepository(Credential), credentialId, workspaceId);
    if (cred && cred.token) {
      return cred.username ? { username: cred.username, token: cred.token } : { token: cred.token };
    }
    return null;
  } catch {
    return null;
  }
}
