import React, { useEffect, useState } from 'react';
import { api, getActiveAccountId } from '../../api';
import { tokens } from '../../tokens';
import { Input, Select } from '../common';
import type { CheckoutMode, BuildMode, RepoBranch, WorkspaceFolderRepoRef } from '../../types';
import { useProjects } from '../../projects/useProjects';

// 작업폴더 옵션화 (ticket 4c49f567 / 5-체인의 5/5 클라 UI).
//
// QaScenario / SecurityProfile / Action 이 동일한 작업폴더 옵션을 공유한다:
//   workspace_folder / repo_ref / checkout_mode / build_mode.
// 편집 폼들이 같은 입력 블록을 쓰므로 여기로 추출해 중복을 없앤다.
//
// repo_ref 는 Project(project_id) 또는 url+branch 중 하나로 표현된다
// (docs/tickets.md — `project_id` 가 옛 repository Resource 의 `resource_id` 를
// 대체한다. 프로젝트는 같은 id 로 이관됐으므로 저장된 `resource_id` 는 그대로
// 프로젝트를 가리킨다 — 읽기 폴백으로만 쓰고 절대 쓰지 않는다). 둘 다 비우면 null
// = 저장소를 지정하지 않는다. 폼은 노브만 편집하고, cold/warm 결정과 정규화는
// 서버가 한다.

/** 편집 폼이 들고 있는 작업폴더 옵션의 평면(flat) 상태. */
export interface WorkspaceFolderFormState {
  workspaceFolder: string;
  checkoutMode: CheckoutMode;
  buildMode: BuildMode;
  repoProjectId: string;
  repoUrl: string;
  repoBranch: string;
}

/** 저장된 repo_ref 가 가리키는 프로젝트 id — `project_id`, 없으면 레거시 `resource_id`. */
export function repoRefProjectId(ref: WorkspaceFolderRepoRef | null | undefined): string {
  return (ref?.project_id || ref?.resource_id || '').trim();
}

/** 서버에서 읽은 시나리오/프로파일(또는 null=신규)로 폼 초기 상태를 만든다. */
export function initWorkspaceFolderState(src: {
  workspace_folder?: string;
  checkout_mode?: CheckoutMode;
  build_mode?: BuildMode;
  repo_ref?: WorkspaceFolderRepoRef | null;
} | null | undefined): WorkspaceFolderFormState {
  const ref = src?.repo_ref ?? null;
  return {
    workspaceFolder: src?.workspace_folder ?? '',
    checkoutMode: src?.checkout_mode ?? 'reuse',
    buildMode: src?.build_mode ?? 'cold_then_warm',
    repoProjectId: repoRefProjectId(ref),
    repoUrl: ref?.url ?? '',
    repoBranch: ref?.branch ?? '',
  };
}

/**
 * `RepoRefPicker` 가 실제로 읽고 쓰는 필드만 추린 것. Orchestration Mission 모달처럼
 * workspace_folder/build_mode 개념이 없는 폼도 repo 블록만 떼어 재사용할 수 있게,
 * 넓은 `WorkspaceFolderFormState` 대신 이 좁은 타입을 요구한다(티켓 eb9cdd1c).
 */
export type RepoRefFormState = Pick<WorkspaceFolderFormState, 'repoProjectId' | 'repoUrl' | 'repoBranch'>;

/**
 * repo_ref 하나만 조립한다 — project_id 우선, 다음 url, 둘 다 비면 null. repo 블록을
 * 단독으로 쓰는 폼이 같은 규칙을 두 번 구현하지 않도록 여기 한 곳에만 둔다.
 *
 * 레거시 `resource_id` 는 절대 내보내지 않는다 — 저장된 `{resource_id}` 레코드도 폼을
 * 한 번 저장하면 `{project_id}` 로 바뀐다(같은 id).
 *
 * project_id 와 url 은 배타적으로 내보낸다. 서버는 url 을 먼저 보므로 둘 다 실어
 * 보내면 "프로젝트를 고르면 URL 은 무시된다"는 이 폼의 안내와 서버 동작이 정확히
 * 반대가 된다.
 *
 * branch 는 두 경로 모두에 실린다 — 서버가 project 경로에서도
 * `ref.branch || project.default_branch` 순으로 읽기 때문이다(티켓 af31e92d: branch 를
 * 버리면 MCP 로 저장된 `{.., branch}` 레코드가 폼 저장 한 번에 조용히 사라진다).
 *
 * branch 만 있고 저장소 지정이 없으면 null 이다 — 체크아웃할 저장소가 없으므로
 * 저장해봐야 아무 효과가 없는 값이다.
 */
export function buildRepoRefPayload(state: RepoRefFormState): WorkspaceFolderRepoRef | null {
  const projectId = state.repoProjectId.trim();
  const url = state.repoUrl.trim();
  const branch = state.repoBranch.trim();
  if (projectId) return { project_id: projectId, ...(branch ? { branch } : {}) };
  if (url) return { url, ...(branch ? { branch } : {}) };
  return null;
}

/**
 * 폼 상태를 create/update 페이로드 조각으로 변환한다. workspace_folder 는 항상
 * 보내고(빈 문자열 = 기본값 사용), repo_ref 는 `buildRepoRefPayload` 규칙을 그대로
 * 따른다. 서버가 추가 정규화를 한다.
 */
export function buildWorkspaceFolderPayload(state: WorkspaceFolderFormState): {
  workspace_folder: string;
  repo_ref: WorkspaceFolderRepoRef | null;
  checkout_mode: CheckoutMode;
  build_mode: BuildMode;
} {
  return {
    workspace_folder: state.workspaceFolder.trim(),
    repo_ref: buildRepoRefPayload(state),
    checkout_mode: state.checkoutMode,
    build_mode: state.buildMode,
  };
}

const CHECKOUT_OPTIONS: { value: CheckoutMode; label: string }[] = [
  { value: 'reuse', label: 'reuse (폴더 재사용)' },
  { value: 'fresh', label: 'fresh (매번 새 체크아웃)' },
];

const BUILD_OPTIONS: { value: BuildMode; label: string }[] = [
  { value: 'cold_then_warm', label: 'cold_then_warm (첫 빌드 cold, 이후 warm)' },
  { value: 'always_cold', label: 'always_cold (매번 클린 빌드)' },
  { value: 'always_warm', label: 'always_warm (매번 증분 빌드)' },
];

// 서버 runWorkspaceRootForKind()와 동일한 매핑(티켓 9fd27487). qa/security는
// .awb/qa 를 공유한다 — kind 문자열을 그대로 경로에 쓰면(예: "security/<id>")
// 실제 기본 폴더와 어긋난다.
const FOLDER_ROOT_BY_KIND: Record<'qa' | 'security' | 'action', string> = {
  qa: '.awb/qa',
  security: '.awb/qa',
  action: '.awb/act',
};

interface WorkspaceFolderOptionsProps {
  /** 'qa' | 'security' | 'action' — 기본 폴더 예시 placeholder 에 쓴다
   *  (티켓 9fd27487 이 'action' 을 추가; Action Run 은 `.awb/act/<leaf>`). */
  kind: 'qa' | 'security' | 'action';
  state: WorkspaceFolderFormState;
  onChange: (patch: Partial<WorkspaceFolderFormState>) => void;
  /** Action 은 cold/warm 빌드 개념이 없다(QaScenario.build_mode 상당 컬럼 없음) —
   *  build_mode 셀렉트를 숨긴다. 기본 true(QA/Security 는 계속 표시). */
  showBuildMode?: boolean;
  /** 프로젝트 목록을 조회할 workspace(티켓 af31e92d). 생략하면 다른 admin 화면들과
   *  동일하게 활성 workspace 로 폴백한다. */
  accountId?: string;
}

const fieldLabel: React.CSSProperties = {
  fontSize: 12, fontWeight: 600, color: tokens.colors.textSecondary, marginBottom: 4, display: 'block',
};
const helpText: React.CSSProperties = {
  fontSize: 12, color: tokens.colors.textMuted, marginTop: 4,
};
const linkButton: React.CSSProperties = {
  background: 'none', border: 'none', padding: 0,
  color: tokens.colors.accent, cursor: 'pointer',
  font: 'inherit', textDecoration: 'underline',
};

interface RepoRefPickerProps {
  /** 프로젝트 목록 조회에 쓸 workspace. 빈 문자열이면 조회를 건너뛴다. */
  accountId: string;
  state: RepoRefFormState;
  onChange: (patch: Partial<RepoRefFormState>) => void;
}

/**
 * repo_ref 편집 블록 — 검색형 프로젝트 드롭다운 + 브랜치 드롭다운(티켓 af31e92d 에서
 * 원시 UUID 입력을 대체; 저장소가 Resource 에서 Project 로 옮겨가며 목록 출처만
 * `useProjects` 로 바뀌었다).
 *
 * 설계상 지켜야 하는 것들:
 *  - 저장된 값은 절대 유실되지 않는다. 목록에 없는 id(직접 입력된 값, 삭제된
 *    프로젝트, 권한이 없어 목록을 못 받은 경우)도 선택 상태로 남는 option 을 만들어
 *    표시하므로, 편집 후 저장해도 같은 id 가 그대로 나간다.
 *  - 목록 조회가 실패해도 폼은 계속 동작한다(조용한 빈 목록 폴백 + 수동 입력).
 *  - url 직접 입력 경로는 프로젝트로 등록되지 않은 저장소용으로 남기되, 우선순위가
 *    낮다는 사실(프로젝트 선택 시 무시)을 UI 로 드러낸다.
 */
export function RepoRefPicker({ accountId, state, onChange }: RepoRefPickerProps) {
  const { projects, loading: projectsLoading, error: projectsError, reload } = useProjects(accountId);
  const [projectSearch, setProjectSearch] = useState('');
  const [branchReload, setBranchReload] = useState(0);

  const selectedProjectId = state.repoProjectId.trim();

  // 브랜치는 프로젝트를 고른 뒤에만 조회한다. 서버가 git ls-remote 를 돌리므로
  // 몇 초 걸릴 수 있어 로딩 상태를 드러내고, 실패하면 자유 입력으로 폴백한다.
  const [branches, setBranches] = useState<RepoBranch[]>([]);
  const [defaultBranch, setDefaultBranch] = useState('');
  const [branchesLoading, setBranchesLoading] = useState(false);
  const [branchesError, setBranchesError] = useState('');

  useEffect(() => {
    if (!accountId || !selectedProjectId) {
      setBranches([]);
      setDefaultBranch('');
      setBranchesLoading(false);
      setBranchesError('');
      return;
    }
    let cancelled = false;
    setBranchesLoading(true);
    setBranchesError('');
    api.listProjectBranches(selectedProjectId)
      .then((res) => {
        if (cancelled) return;
        setBranches(res?.branches || []);
        setDefaultBranch(res?.default_branch || '');
      })
      .catch((err: any) => {
        if (cancelled) return;
        setBranches([]);
        setDefaultBranch('');
        setBranchesError(err?.message || '브랜치 목록을 불러오지 못했습니다.');
      })
      .finally(() => { if (!cancelled) setBranchesLoading(false); });
    return () => { cancelled = true; };
  }, [accountId, selectedProjectId, branchReload]);

  const selectedProject = projects.find((p) => p.id === selectedProjectId) || null;
  const normalizedSearch = projectSearch.trim().toLocaleLowerCase();
  // 선택된 항목은 검색어와 무관하게 항상 목록에 남긴다 — 안 그러면 검색 도중
  // <select> 의 현재 값이 사라져 선택이 풀린다.
  const visibleProjects = projects.filter((p) => (
    p.id === selectedProjectId
    || !normalizedSearch
    || p.name.toLocaleLowerCase().includes(normalizedSearch)
    || (p.repo_url || '').toLocaleLowerCase().includes(normalizedSearch)
  ));

  // 목록에 없는 저장 값을 어떤 문구로 보존할지. "알 수 없는 프로젝트" 라고 단정할 수
  // 있는 건 목록을 실제로 다 받아본 뒤뿐이다 — 로딩 중이거나 조회가 실패한
  // 상태에서 그렇게 쓰면 멀쩡한 id 를 없는 것처럼 표시하게 된다.
  const danglingLabel = projectsLoading
    ? `${selectedProjectId} (프로젝트 목록 불러오는 중…)`
    : projectsError
      ? `${selectedProjectId} (프로젝트 목록을 불러오지 못했습니다)`
      : `알 수 없는 프로젝트 (${selectedProjectId})`;

  const projectOptions = [
    { value: '', label: '— 지정 안 함 —' },
    ...(selectedProjectId && !selectedProject ? [{ value: selectedProjectId, label: danglingLabel }] : []),
    ...visibleProjects.map((p) => ({ value: p.id, label: p.repo_url ? `${p.name} · ${p.repo_url}` : p.name })),
  ];

  // 목록을 못 쓰는 상태(권한 없음/조회 실패/워크스페이스에 프로젝트가 없음)
  // 에서는 id 를 직접 넣을 수 있어야 한다.
  const projectListUnusable = !projectsLoading && (Boolean(projectsError) || projects.length === 0);
  const branchSelectable = Boolean(selectedProjectId) && !branchesLoading && !branchesError;

  const branchOptions = [
    {
      value: '',
      label: defaultBranch ? `— 프로젝트 기본 브랜치 (${defaultBranch}) —` : '— 프로젝트 기본 브랜치 —',
    },
    // 저장된 브랜치가 원격에서 지워졌거나 목록에 없어도 선택 상태로 남긴다.
    ...(state.repoBranch && !branches.some((b) => b.name === state.repoBranch)
      ? [{ value: state.repoBranch, label: `${state.repoBranch} (목록에 없음)` }]
      : []),
    ...branches.map((b) => ({ value: b.name, label: b.name })),
  ];

  // 기존 레코드가 url 직접 입력 경로를 쓰고 있으면 접혀 있으면 안 된다.
  const [urlOpen, setUrlOpen] = useState(Boolean(state.repoUrl.trim()));
  useEffect(() => { if (state.repoUrl.trim()) setUrlOpen(true); }, [state.repoUrl]);

  return (
    <div>
      <label style={fieldLabel}>repo_ref (작업폴더로 체크아웃할 저장소 — 프로젝트를 고르세요)</label>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <Input
          type="search"
          aria-label="프로젝트 검색"
          placeholder="이름 또는 URL 로 검색"
          value={projectSearch}
          disabled={projectsLoading || projects.length === 0}
          onChange={(e) => setProjectSearch((e.target as HTMLInputElement).value)}
        />
        <Select
          aria-label="프로젝트 선택"
          value={selectedProjectId}
          options={projectOptions}
          onChange={(e) => {
            const next = (e.target as HTMLSelectElement).value;
            // 프로젝트가 바뀌면 이전 프로젝트에서 고른 브랜치는 의미가 없다.
            //
            // 빈 값은 "지정 안 함" 이라는 명시적 선택이므로 url 도 함께 비운다.
            // 남겨두면 buildRepoRefPayload 가 project 가 빈 것을 보고 그 url 을 활성
            // repo 로 내보내서, 방금 고른 라벨과 정반대로 URL checkout 이 계속된다.
            // `{project_id + url}` 로 저장된 레코드에서는 더 나쁘다 — 프로젝트에
            // 가려져 있던 url 이 "지정 안 함" 을 고르는 순간 오히려 되살아난다
            // (리뷰 지적, 티켓 eb9cdd1c).
            onChange({ repoProjectId: next, repoBranch: '', ...(next ? {} : { repoUrl: '' }) });
          }}
        />
        {projectsLoading && <div style={helpText}>프로젝트 목록을 불러오는 중…</div>}
        {!projectsLoading && projectsError && (
          <div style={{ ...helpText, color: tokens.colors.danger }}>
            {projectsError} 아래에서 project_id 를 직접 입력할 수 있습니다.{' '}
            <button type="button" onClick={() => { void reload(); }} style={linkButton}>다시 시도</button>
          </div>
        )}
        {!projectsLoading && !projectsError && projects.length === 0 && (
          <div style={helpText}>
            등록된 프로젝트가 없습니다.
            {accountId && (
              <>
                {' '}<a href={`/projects`} style={{ color: tokens.colors.accent }}>Projects</a>
                {' '}에서 저장소를 프로젝트로 등록하세요.
              </>
            )}
          </div>
        )}
        {projectListUnusable && (
          <Input
            label="project_id 직접 입력"
            aria-label="project_id 직접 입력"
            placeholder="등록된 프로젝트의 id"
            value={state.repoProjectId}
            onChange={(e) => onChange({ repoProjectId: (e.target as HTMLInputElement).value })}
          />
        )}
      </div>

      <div style={{ marginTop: 8 }}>
        {branchSelectable ? (
          <Select
            label="branch"
            aria-label="브랜치 선택"
            value={state.repoBranch}
            options={branchOptions}
            onChange={(e) => onChange({ repoBranch: (e.target as HTMLSelectElement).value })}
          />
        ) : (
          <Input
            label="branch"
            aria-label="브랜치 직접 입력"
            placeholder="기본 브랜치"
            value={state.repoBranch}
            onChange={(e) => onChange({ repoBranch: (e.target as HTMLInputElement).value })}
          />
        )}
        {selectedProjectId && branchesLoading && <div style={helpText}>브랜치 목록을 불러오는 중…</div>}
        {selectedProjectId && !branchesLoading && branchesError && (
          <div style={{ ...helpText, color: tokens.colors.danger }}>
            {branchesError} 브랜치 이름을 직접 입력하세요.{' '}
            <button type="button" onClick={() => setBranchReload((n) => n + 1)} style={linkButton}>다시 시도</button>
          </div>
        )}
      </div>

      <details
        open={urlOpen}
        onToggle={(e) => setUrlOpen((e.target as HTMLDetailsElement).open)}
        style={{ marginTop: 10 }}
      >
        <summary style={{ ...fieldLabel, marginBottom: 0, cursor: 'pointer' }}>
          프로젝트로 등록되지 않은 저장소를 URL 로 직접 지정 (고급)
        </summary>
        <div style={{ marginTop: 8 }}>
          <Input
            label="repo URL"
            aria-label="repo URL"
            placeholder="https://github.com/org/repo.git"
            value={state.repoUrl}
            onChange={(e) => onChange({ repoUrl: (e.target as HTMLInputElement).value })}
          />
          <div style={helpText}>
            위에서 프로젝트를 선택하면 이 URL 은 <b>무시됩니다</b>. 위 branch 값은 두 경로 모두에 적용됩니다.
          </div>
        </div>
      </details>

      <div style={helpText}>
        프로젝트가 있으면 그 저장소를, 없고 URL 이 있으면 url+branch 를 씁니다. 둘 다 비우면 저장소를
        지정하지 않습니다.
      </div>
    </div>
  );
}

/**
 * QA 시나리오 / 보안 프로파일 편집 폼에 끼워 넣는 작업폴더 옵션 블록.
 * read 표시 + 변경 시 onChange(patch) 로 상위 상태를 갱신한다(저장은 상위 폼이).
 */
export function WorkspaceFolderOptions({ kind, state, onChange, showBuildMode = true, accountId }: WorkspaceFolderOptionsProps) {
  const defaultFolderHint = `${FOLDER_ROOT_BY_KIND[kind]}/<id>`;
  const effectiveAccountId = accountId || getActiveAccountId() || '';
  return (
    <div style={{ borderTop: `1px solid ${tokens.colors.border}`, paddingTop: 12, marginTop: 4 }}>
      <div style={{ fontSize: 13, fontWeight: 600, color: tokens.colors.textPrimary }}>작업폴더 옵션</div>
      <div style={{ ...helpText, marginTop: 4 }}>
        run 이 “어느 폴더에서 어떻게 빌드할지”를 고정합니다. 기본값(<b>reuse + cold_then_warm</b>)은
        같은 폴더를 재사용하면서 첫 run 만 클린 빌드(cold)하고 이후 run 은 증분 빌드(warm)합니다.
        cold/warm 판정은 서버가 합니다 — 폼은 노브만 정합니다.
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 10 }}>
        <div>
          <Input
            label="작업폴더 (workspace_folder)"
            placeholder={`비우면 기본값 ${defaultFolderHint}`}
            value={state.workspaceFolder}
            onChange={(e) => onChange({ workspaceFolder: (e.target as HTMLInputElement).value })}
          />
          <div style={helpText}>
            agent home 아래 상대 경로. 비우면 서버가 결정적 기본값 <code>{defaultFolderHint}</code> 을 씁니다.
          </div>
        </div>

        <div style={{ display: 'flex', gap: 10 }}>
          <div style={{ flex: 1 }}>
            <Select
              label="checkout_mode"
              value={state.checkoutMode}
              options={CHECKOUT_OPTIONS}
              onChange={(e) => onChange({ checkoutMode: (e.target as HTMLSelectElement).value as CheckoutMode })}
            />
            <div style={helpText}>reuse = 폴더 유지, fresh = run 마다 새로 체크아웃.</div>
          </div>
          {showBuildMode && (
            <div style={{ flex: 1 }}>
              <Select
                label="build_mode"
                value={state.buildMode}
                options={BUILD_OPTIONS}
                onChange={(e) => onChange({ buildMode: (e.target as HTMLSelectElement).value as BuildMode })}
              />
              <div style={helpText}>cold = 클린 빌드, warm = 증분 빌드.</div>
            </div>
          )}
        </div>

        <RepoRefPicker accountId={effectiveAccountId} state={state} onChange={onChange} />
      </div>
    </div>
  );
}
