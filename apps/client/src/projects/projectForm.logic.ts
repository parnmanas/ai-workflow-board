// Projects page — React-free form / validation / delete-409 logic
// (docs/tickets.md → Project). `test/projects-form-logic.test.mjs` imports this
// module directly; the components in `components/projects/*` only render it.

import type {
  ClonePolicy,
  Credential,
  Project,
  ProjectHostFolder,
  ProjectInput,
  ProjectTestConnectionResult,
} from '../types';
import {
  EMPTY_CLONE_POLICY_FORM,
  clonePolicyToForm,
  formToClonePolicy,
  type ClonePolicyFormState,
} from '../components/clonePolicy.logic';
import { isAbsoluteHostPath, type RuntimeSpecDraft } from '../runtime/runtimeSpec';

// ─── form ⇄ payload ─────────────────────────────────────────────────────────

export interface ProjectFormState {
  name: string;
  description: string;
  repoUrl: string;
  defaultBranch: string;
  credentialId: string;
  clonePolicy: ClonePolicyFormState;
  usePr: boolean;
  instructions: string;
  /** null = no default assignee (new tickets of this project stay unassigned). */
  defaultAssignee: RuntimeSpecDraft | null;
}

export interface ProjectFormErrors {
  name?: string;
  repoUrl?: string;
  clonePolicy?: string;
}

export function emptyProjectForm(): ProjectFormState {
  return {
    name: '',
    description: '',
    repoUrl: '',
    defaultBranch: '',
    credentialId: '',
    clonePolicy: EMPTY_CLONE_POLICY_FORM,
    usePr: false,
    instructions: '',
    defaultAssignee: null,
  };
}

export function projectToForm(project: Project): ProjectFormState {
  return {
    name: project.name || '',
    description: project.description || '',
    repoUrl: project.repo_url || '',
    defaultBranch: project.default_branch || '',
    credentialId: project.credential_id || '',
    clonePolicy: clonePolicyToForm(project.clone_policy),
    usePr: project.use_pr === true,
    instructions: project.instructions || '',
    defaultAssignee: project.default_assignee ? { ...project.default_assignee } : null,
  };
}

/**
 * Form → POST/PATCH body. Every field is sent (PATCH included) so clearing a
 * field in the form actually clears it on the server: empty credential →
 * `null`, empty clone policy → `null`, removed default assignee → `null`.
 */
export function buildProjectPayload(
  form: ProjectFormState,
): { ok: true; value: ProjectInput & { name: string; repo_url: string } } | { ok: false; errors: ProjectFormErrors } {
  const errors: ProjectFormErrors = {};
  const name = form.name.trim();
  const repoUrl = form.repoUrl.trim();
  if (!name) errors.name = '이름을 입력하세요.';
  if (!repoUrl) errors.repoUrl = '저장소 URL 을 입력하세요.';
  else if (/\s/.test(repoUrl)) errors.repoUrl = 'URL 에 공백이 들어갈 수 없습니다.';
  let clonePolicy: ClonePolicy | null = null;
  const built = formToClonePolicy(form.clonePolicy);
  if (!built.ok) errors.clonePolicy = built.error;
  else clonePolicy = built.value;
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      name,
      repo_url: repoUrl,
      description: form.description.trim(),
      default_branch: form.defaultBranch.trim(),
      credential_id: form.credentialId || null,
      clone_policy: clonePolicy,
      use_pr: form.usePr,
      instructions: form.instructions,
      default_assignee: form.defaultAssignee,
    },
  };
}

/** Whether the form differs from the stored project (new project: anything typed). */
export function isProjectFormDirty(form: ProjectFormState, project: Project | null): boolean {
  const base = project ? projectToForm(project) : emptyProjectForm();
  return JSON.stringify(form) !== JSON.stringify(base);
}

// ─── credentials ────────────────────────────────────────────────────────────

/**
 * Credentials a project may use: global ones plus this workspace's own — the
 * same rule ResourceManager applies to account-scoped resources. A credential
 * the project already points at stays selectable even if it would no longer be
 * listed (moved scope / other workspace) so editing never silently drops it.
 */
export function projectCredentialChoices(
  credentials: Credential[],
  accountId: string,
  currentId?: string | null,
): Credential[] {
  return credentials.filter((c) => (
    c.scope === 'global'
    || c.account_id == null
    || c.account_id === accountId
    || (!!currentId && c.id === currentId)
  ));
}

// ─── Test connection ────────────────────────────────────────────────────────

export interface TestConnectionView {
  ok: boolean;
  message: string;
  branches: string[];
  /** The remote's default branch, offered as the project's default branch. */
  suggestedDefault: string;
}

export function testConnectionView(result: ProjectTestConnectionResult | null | undefined): TestConnectionView {
  if (!result) return { ok: false, message: '응답이 없습니다.', branches: [], suggestedDefault: '' };
  const branches = (result.branches || [])
    .map((b: any) => (typeof b === 'string' ? b : b?.name))
    .filter((n: unknown): n is string => typeof n === 'string' && n.length > 0);
  if (!result.ok) {
    return { ok: false, message: result.error || '연결에 실패했습니다.', branches: [], suggestedDefault: '' };
  }
  const suggestedDefault = (result.default_branch || '').trim();
  const message = branches.length === 0
    ? '연결 성공 — 원격에 브랜치가 없습니다.'
    : `연결 성공 — 브랜치 ${branches.length}개${suggestedDefault ? ` (기본: ${suggestedDefault})` : ''}`;
  return { ok: true, message, branches, suggestedDefault };
}

/**
 * Branch choices for the default-branch select: the remote's branches with the
 * current value kept even when the remote does not list it (a not-yet-pushed
 * branch must stay pinnable). `''` = fall back to origin/HEAD.
 */
export function defaultBranchOptions(
  branches: string[],
  current: string,
): Array<{ value: string; label: string }> {
  const cur = current.trim();
  return [
    { value: '', label: '— 지정 안 함 (origin/HEAD) —' },
    ...(cur && !branches.includes(cur) ? [{ value: cur, label: `${cur} (원격 목록에 없음)` }] : []),
    ...branches.map((b) => ({ value: b, label: b })),
  ];
}

// ─── host folders ───────────────────────────────────────────────────────────

export interface HostFolderRow {
  host_id: string;
  host_name: string;
  /** The stored main clone folder on this host ('' = none). */
  saved_path: string;
  /** false = the folder names a host that is not in the Runtime Host list (offline / removed). */
  known: boolean;
}

/**
 * One row per Runtime Host (in the hosts' order), then every stored folder
 * whose host is not in that list — those still need a row so the operator can
 * clear a folder of a host that went away.
 */
export function hostFolderRows(
  hosts: Array<{ id: string; name: string }>,
  folders: ProjectHostFolder[] | null | undefined,
): HostFolderRow[] {
  const byHost = new Map<string, ProjectHostFolder>();
  for (const f of folders || []) if (f && f.host_id) byHost.set(f.host_id, f);
  const rows: HostFolderRow[] = hosts.map((h) => ({
    host_id: h.id,
    host_name: h.name || h.id.slice(0, 8),
    saved_path: (byHost.get(h.id)?.path || '').trim(),
    known: true,
  }));
  const hostIds = new Set(hosts.map((h) => h.id));
  for (const f of folders || []) {
    if (!f?.host_id || hostIds.has(f.host_id)) continue;
    rows.push({
      host_id: f.host_id,
      host_name: f.host_name || f.host_id.slice(0, 8),
      saved_path: (f.path || '').trim(),
      known: false,
    });
  }
  return rows;
}

/** Validation for a main clone folder path; null when it may be saved. */
export function hostFolderPathError(path: string): string | null {
  const p = path.trim();
  if (!p) return '경로를 입력하세요.';
  if (!isAbsoluteHostPath(p)) return 'Host 절대 경로여야 합니다 (예: /home/user/repo, C:\\repo).';
  return null;
}

// ─── delete 409 project_in_use ──────────────────────────────────────────────

export interface ProjectUsageCount {
  key: string;
  label: string;
  count: number;
}

const USAGE_LABELS: Record<string, string> = {
  tickets: '티켓',
  qa_scenarios: 'QA 시나리오',
  security_profiles: '보안 프로파일',
  actions: 'Action',
  missions: '미션',
  orchestration_missions: '미션',
  schedules: '스케줄',
  automation_schedules: '스케줄',
  ontology_graphs: '온톨로지 그래프',
  references: 'QA·보안·Action·미션·outreach 설정',
};

export function usageLabel(key: string): string {
  return USAGE_LABELS[key] || key.replace(/_/g, ' ');
}

/** True when a thrown api error is the 409 "project is still referenced" refusal. */
export function isProjectInUseError(err: unknown): boolean {
  const e = err as { code?: string; body?: any } | null;
  if (!e) return false;
  return e.code === 'project_in_use' || e.body?.code === 'project_in_use' || e.body?.error === 'project_in_use';
}

/**
 * Per-kind reference counts from a 409 `project_in_use` error (`error.body.usage`
 * — `{ tickets, references }` — or a `counts` bag),
 * or null when the error is something else. Whatever key/count pairs the server
 * sends are rendered — unknown keys fall back to the key itself. Accepts either
 * an object (`{ tickets: 3 }`) or a list (`[{ key|kind|type, count }]`); zero
 * counts are dropped.
 */
export function projectInUseCounts(err: unknown): ProjectUsageCount[] | null {
  if (!isProjectInUseError(err)) return null;
  const body = (err as { body?: any }).body;
  const raw = body?.counts ?? body?.usage;
  const out: ProjectUsageCount[] = [];
  const push = (key: unknown, value: unknown) => {
    const n = Number(value);
    if (typeof key !== 'string' || !key || !Number.isFinite(n) || n <= 0) return;
    out.push({ key, label: usageLabel(key), count: n });
  };
  if (Array.isArray(raw)) {
    for (const row of raw) push(row?.key ?? row?.kind ?? row?.type, row?.count);
  } else if (raw && typeof raw === 'object') {
    for (const [key, value] of Object.entries(raw)) push(key, value);
  }
  return out;
}

/** One line for the force-delete dialog: "티켓 3 · QA 시나리오 1". */
export function describeProjectUsage(counts: ProjectUsageCount[]): string {
  if (!counts.length) return '다른 항목이 아직 이 프로젝트를 참조하고 있습니다.';
  return counts.map((c) => `${c.label} ${c.count}`).join(' · ');
}

// ─── list ⇄ last write ──────────────────────────────────────────────────────

/**
 * The project list with the last write applied on top, so the page shows a
 * save immediately instead of waiting for the shared list refetch
 * (`notifyProjectsChanged`). The listed row wins once it is at least as new as
 * the saved one; a just-created project missing from the list is appended.
 */
export function mergeSavedProject(list: Project[], saved: Project | null): Project[] {
  if (!saved) return list;
  const idx = list.findIndex((p) => p.id === saved.id);
  if (idx < 0) return [...list, saved];
  const listed = list[idx];
  if ((listed.updated_at || '') >= (saved.updated_at || '')) return list;
  const next = list.slice();
  next[idx] = saved;
  return next;
}
