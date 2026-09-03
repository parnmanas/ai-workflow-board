import React, { useEffect, useState } from 'react';
import { api, getActiveWorkspaceId } from '../../api';
import { tokens } from '../../tokens';
import { Input, Select } from '../common';
import type { CheckoutMode, BuildMode, RepoBranch, Resource, WorkspaceFolderRepoRef } from '../../types';

// 작업폴더 옵션화 (ticket 4c49f567 / 5-체인의 5/5 클라 UI).
//
// QaScenario 와 SecurityProfile 이 동일한 작업폴더 옵션 4종을 공유한다:
//   workspace_folder / repo_ref / checkout_mode / build_mode.
// 두 편집 폼이 같은 입력 블록을 쓰므로 여기로 추출해 중복을 없앤다.
//
// repo_ref 는 resource(resource_id) 또는 url+branch 중 하나로 표현된다(서버
// WorkspaceFolderRepoRef). 둘 다 비우면 null → board/workspace environment_config
// 의 repo 를 재사용한다(서버 권위). 폼은 노브만 편집하고, cold/warm 결정과
// 정규화는 서버가 한다.

/** 편집 폼이 들고 있는 작업폴더 옵션의 평면(flat) 상태. */
export interface WorkspaceFolderFormState {
  workspaceFolder: string;
  checkoutMode: CheckoutMode;
  buildMode: BuildMode;
  repoResourceId: string;
  repoUrl: string;
  repoBranch: string;
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
    repoResourceId: ref?.resource_id ?? '',
    repoUrl: ref?.url ?? '',
    repoBranch: ref?.branch ?? '',
  };
}

/**
 * 폼 상태를 create/update 페이로드 조각으로 변환한다. workspace_folder 는 항상
 * 보내고(빈 문자열 = 기본값 사용), repo_ref 는 resource_id 우선, 다음 url+branch,
 * 둘 다 비면 null(= env repo 재사용)으로 보낸다. 서버가 추가 정규화를 한다.
 *
 * branch 는 두 경로 모두에 실린다 — 서버 `resolveRunRepo()` 가 resource 경로에서도
 * `ref.branch || resource.default_branch` 순으로 읽기 때문이다
 * (apps/server/src/common/run-workspace-resolver.ts). 예전엔 resource 를 고르면
 * branch 를 통째로 버려서, MCP 로 저장된 `{resource_id, branch}` 레코드를 폼에서
 * 한 번 저장하기만 해도 branch 가 조용히 사라졌다(티켓 af31e92d). 비어 있으면
 * 예전과 똑같이 `{resource_id}` 만 나가므로 기존 레코드의 페이로드는 그대로다.
 */
export function buildWorkspaceFolderPayload(state: WorkspaceFolderFormState): {
  workspace_folder: string;
  repo_ref: WorkspaceFolderRepoRef | null;
  checkout_mode: CheckoutMode;
  build_mode: BuildMode;
} {
  const resourceId = state.repoResourceId.trim();
  const url = state.repoUrl.trim();
  const branch = state.repoBranch.trim();
  let repo_ref: WorkspaceFolderRepoRef | null = null;
  if (resourceId) {
    repo_ref = { resource_id: resourceId, ...(branch ? { branch } : {}) };
  } else if (url) {
    repo_ref = { url, ...(branch ? { branch } : {}) };
  }
  return {
    workspace_folder: state.workspaceFolder.trim(),
    repo_ref,
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
  /** repo 리소스/브랜치 목록을 조회할 workspace(티켓 af31e92d). 생략하면 다른
   *  admin 화면들과 동일하게 활성 workspace 로 폴백한다. */
  workspaceId?: string;
}

const fieldLabel: React.CSSProperties = {
  fontSize: 12, fontWeight: 600, color: tokens.colors.textSecondary, marginBottom: 4, display: 'block',
};
const helpText: React.CSSProperties = {
  fontSize: 12, color: tokens.colors.textMuted, marginTop: 4,
};

interface RepoRefPickerProps {
  /** 리소스/브랜치 조회에 쓸 workspace. 빈 문자열이면 조회를 건너뛴다. */
  workspaceId: string;
  state: WorkspaceFolderFormState;
  onChange: (patch: Partial<WorkspaceFolderFormState>) => void;
}

/**
 * repo_ref 편집 블록(티켓 af31e92d). 예전엔 resource_id 를 UUID 자유 텍스트로
 * 받아서 사용자가 원시 id 를 타이핑/붙여넣기 해야 했다 — 다른 화면
 * (BoardSettingsPage / TicketPanel) 은 이미 `listResources(ws,'repository')`
 * 드롭다운을 쓰고 있었으므로 같은 방향으로 맞춘다.
 *
 * 설계상 지켜야 하는 것들:
 *  - 저장된 값은 절대 유실되지 않는다. 목록에 없는 id(직접 입력된 값, 삭제된
 *    리소스, 권한이 없어 목록을 못 받은 경우)도 선택 상태로 남는 option 을 만들어
 *    표시하므로, 편집 후 저장해도 같은 id 가 그대로 나간다.
 *  - 목록 조회가 실패해도 폼은 계속 동작한다(조용한 빈 목록 폴백 + 수동 입력).
 *  - url 직접 입력 경로는 리소스로 등록되지 않은 저장소용으로 남기되, 우선순위가
 *    낮다는 사실(resource 선택 시 무시)을 UI 로 드러낸다.
 */
function RepoRefPicker({ workspaceId, state, onChange }: RepoRefPickerProps) {
  const [repos, setRepos] = useState<Resource[]>([]);
  const [reposLoading, setReposLoading] = useState(false);
  const [reposError, setReposError] = useState('');
  const [repoSearch, setRepoSearch] = useState('');
  const [reloadToken, setReloadToken] = useState(0);

  const selectedRepoId = state.repoResourceId.trim();

  useEffect(() => {
    if (!workspaceId) {
      setRepos([]);
      setReposLoading(false);
      setReposError('');
      return;
    }
    let cancelled = false;
    setReposLoading(true);
    setReposError('');
    api.listResources(workspaceId, 'repository')
      .then((rows) => { if (!cancelled) setRepos(rows || []); })
      .catch((err: any) => {
        if (cancelled) return;
        setRepos([]);
        setReposError(err?.message || '저장소 리소스 목록을 불러오지 못했습니다.');
      })
      .finally(() => { if (!cancelled) setReposLoading(false); });
    return () => { cancelled = true; };
  }, [workspaceId, reloadToken]);

  // 브랜치는 리소스를 고른 뒤에만 조회한다. 서버가 git ls-remote 를 돌리므로
  // 몇 초 걸릴 수 있어 로딩 상태를 드러내고, 실패하면 자유 입력으로 폴백한다
  // (TicketPanel 의 base branch 피커와 같은 계약).
  const [branches, setBranches] = useState<RepoBranch[]>([]);
  const [defaultBranch, setDefaultBranch] = useState('');
  const [branchesLoading, setBranchesLoading] = useState(false);
  const [branchesError, setBranchesError] = useState('');

  useEffect(() => {
    if (!workspaceId || !selectedRepoId) {
      setBranches([]);
      setDefaultBranch('');
      setBranchesLoading(false);
      setBranchesError('');
      return;
    }
    let cancelled = false;
    setBranchesLoading(true);
    setBranchesError('');
    api.listRepoBranches(selectedRepoId, workspaceId)
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
  }, [workspaceId, selectedRepoId, reloadToken]);

  const selectedRepo = repos.find((r) => r.id === selectedRepoId) || null;
  const normalizedSearch = repoSearch.trim().toLocaleLowerCase();
  // 선택된 항목은 검색어와 무관하게 항상 목록에 남긴다 — 안 그러면 검색 도중
  // <select> 의 현재 값이 사라져 선택이 풀린다.
  const visibleRepos = repos.filter((r) => (
    r.id === selectedRepoId
    || !normalizedSearch
    || r.name.toLocaleLowerCase().includes(normalizedSearch)
    || (r.url || '').toLocaleLowerCase().includes(normalizedSearch)
  ));

  // 목록에 없는 저장 값을 어떤 문구로 보존할지. "알 수 없는 리소스" 라고 단정할 수
  // 있는 건 목록을 실제로 다 받아본 뒤뿐이다 — 로딩 중이거나 조회가 실패한
  // 상태에서 그렇게 쓰면 멀쩡한 id 를 없는 것처럼 표시하게 된다.
  const danglingLabel = reposLoading
    ? `${selectedRepoId} (리소스 목록 불러오는 중…)`
    : reposError
      ? `${selectedRepoId} (리소스 목록을 불러오지 못했습니다)`
      : `알 수 없는 리소스 (${selectedRepoId})`;

  const repoOptions = [
    { value: '', label: '— 지정 안 함 (board/workspace 환경설정 repo 재사용) —' },
    ...(selectedRepoId && !selectedRepo ? [{ value: selectedRepoId, label: danglingLabel }] : []),
    ...visibleRepos.map((r) => ({ value: r.id, label: r.url ? `${r.name} · ${r.url}` : r.name })),
  ];

  // 목록을 못 쓰는 상태(권한 없음/조회 실패/워크스페이스에 repo 리소스가 없음)
  // 에서는 예전처럼 id 를 직접 넣을 수 있어야 한다.
  const repoListUnusable = !reposLoading && (Boolean(reposError) || repos.length === 0);
  const branchSelectable = Boolean(selectedRepoId) && !branchesLoading && !branchesError;

  const branchOptions = [
    {
      value: '',
      label: defaultBranch ? `— 저장소 기본 브랜치 (${defaultBranch}) —` : '— 저장소 기본 브랜치 —',
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
      <label style={fieldLabel}>repo_ref (작업폴더로 체크아웃할 저장소 — 지정 안 하면 board/workspace 환경설정 repo 재사용)</label>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <Input
          type="search"
          aria-label="저장소 리소스 검색"
          placeholder="이름 또는 URL 로 검색"
          value={repoSearch}
          disabled={reposLoading || repos.length === 0}
          onChange={(e) => setRepoSearch((e.target as HTMLInputElement).value)}
        />
        <Select
          aria-label="저장소 리소스 선택"
          value={selectedRepoId}
          options={repoOptions}
          onChange={(e) => {
            // 저장소가 바뀌면 이전 저장소에서 고른 브랜치는 의미가 없다.
            onChange({ repoResourceId: (e.target as HTMLSelectElement).value, repoBranch: '' });
          }}
        />
        {reposLoading && <div style={helpText}>저장소 리소스 목록을 불러오는 중…</div>}
        {!reposLoading && reposError && (
          <div style={{ ...helpText, color: tokens.colors.danger }}>
            {reposError} 아래에서 resource_id 를 직접 입력할 수 있습니다.{' '}
            <button
              type="button"
              onClick={() => setReloadToken((n) => n + 1)}
              style={{
                background: 'none', border: 'none', padding: 0,
                color: tokens.colors.accent, cursor: 'pointer',
                font: 'inherit', textDecoration: 'underline',
              }}
            >다시 시도</button>
          </div>
        )}
        {!reposLoading && !reposError && repos.length === 0 && (
          <div style={helpText}>이 워크스페이스에 등록된 repository 리소스가 없습니다.</div>
        )}
        {repoListUnusable && (
          <Input
            label="resource_id 직접 입력"
            aria-label="resource_id 직접 입력"
            placeholder="등록된 repo 리소스의 id"
            value={state.repoResourceId}
            onChange={(e) => onChange({ repoResourceId: (e.target as HTMLInputElement).value })}
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
        {selectedRepoId && branchesLoading && <div style={helpText}>브랜치 목록을 불러오는 중…</div>}
        {selectedRepoId && !branchesLoading && branchesError && (
          <div style={{ ...helpText, color: tokens.colors.danger }}>
            {branchesError} 브랜치 이름을 직접 입력하세요.
          </div>
        )}
      </div>

      <details
        open={urlOpen}
        onToggle={(e) => setUrlOpen((e.target as HTMLDetailsElement).open)}
        style={{ marginTop: 10 }}
      >
        <summary style={{ ...fieldLabel, marginBottom: 0, cursor: 'pointer' }}>
          리소스로 등록되지 않은 저장소를 URL 로 직접 지정 (고급)
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
            위에서 저장소 리소스를 선택하면 이 URL 은 <b>무시됩니다</b>. 위 branch 값은 두 경로 모두에 적용됩니다.
          </div>
        </div>
      </details>

      <div style={helpText}>
        저장소 리소스가 있으면 그것을, 없고 URL 이 있으면 url+branch 를 씁니다. 둘 다 비우면
        board/workspace environment_config 의 repo 를 재사용합니다.
      </div>
    </div>
  );
}

/**
 * QA 시나리오 / 보안 프로파일 편집 폼에 끼워 넣는 작업폴더 옵션 블록.
 * read 표시 + 변경 시 onChange(patch) 로 상위 상태를 갱신한다(저장은 상위 폼이).
 */
export function WorkspaceFolderOptions({ kind, state, onChange, showBuildMode = true, workspaceId }: WorkspaceFolderOptionsProps) {
  const defaultFolderHint = `${FOLDER_ROOT_BY_KIND[kind]}/<id>`;
  const effectiveWorkspaceId = workspaceId || getActiveWorkspaceId() || '';
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

        <RepoRefPicker workspaceId={effectiveWorkspaceId} state={state} onChange={onChange} />
      </div>
    </div>
  );
}
