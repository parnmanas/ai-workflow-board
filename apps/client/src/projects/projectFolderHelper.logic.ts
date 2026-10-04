// "Use project folder" helper — React-free option logic for
// `components/runtime/ProjectFolderHelper.tsx` (docs/tickets.md → "Main clone
// folder per host"). Picking a project fills the runtime's working_dir with that
// project's main clone folder on the currently selected host. Projects with no
// folder on that host stay listed but disabled, so the operator learns WHY a
// project cannot be picked instead of not seeing it at all.
// `test/project-folder-helper.test.mjs` imports this module directly.

import { projectFolderForHost, type ProjectFolderSource } from './projectFolders';

export const NO_HOST_HINT = '먼저 Runtime Host 를 고르세요';
export const NO_FOLDER_HINT = '이 Host 에 프로젝트 폴더가 없습니다';

export interface ProjectFolderHelperOption {
  /** project id ('' for the placeholder row). */
  value: string;
  label: string;
  disabled: boolean;
  /** The folder this option fills in (null when disabled). */
  path: string | null;
}

export interface ProjectFolderHelperView {
  /** Whole control disabled (no host picked). */
  disabled: boolean;
  /** Explanation shown under the control, or null. */
  hint: string | null;
  options: ProjectFolderHelperOption[];
}

/**
 * Options for the helper select.
 *
 * `hostIds` is the selected host — a single id or a list of ids naming the same
 * host (Host id + its legacy manager Agent uuid alias, as team slots carry).
 * `currentDir` marks the project whose folder is already the working_dir.
 */
export function projectFolderHelperView(
  projects: ProjectFolderSource[],
  hostIds: string | null | undefined | ReadonlyArray<string | null | undefined>,
  currentDir = '',
): ProjectFolderHelperView {
  const ids = (Array.isArray(hostIds) ? hostIds : [hostIds]).filter((v): v is string => !!v);
  const placeholder: ProjectFolderHelperOption = {
    value: '',
    label: '프로젝트 폴더 사용…',
    disabled: false,
    path: null,
  };
  if (!ids.length) {
    return {
      disabled: true,
      hint: NO_HOST_HINT,
      options: [placeholder, ...projects.map((p) => ({
        value: p.id, label: p.name || p.id, disabled: true, path: null,
      }))],
    };
  }
  const dir = currentDir.trim();
  const options = projects.map((p) => {
    const path = projectFolderForHost(p, ids);
    const name = p.name || p.id;
    if (!path) return { value: p.id, label: `${name} — ${NO_FOLDER_HINT}`, disabled: true, path: null };
    return { value: p.id, label: `${name} — ${path}${path === dir ? ' (사용 중)' : ''}`, disabled: false, path };
  });
  const anyUsable = options.some((o) => !o.disabled);
  return {
    disabled: false,
    hint: anyUsable ? null : `${NO_FOLDER_HINT} — Projects 화면에서 이 Host 의 폴더를 지정하세요.`,
    options: [placeholder, ...options],
  };
}
