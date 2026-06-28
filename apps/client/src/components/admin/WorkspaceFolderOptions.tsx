import React from 'react';
import { tokens } from '../../tokens';
import { Input, Select } from '../common';
import type { CheckoutMode, BuildMode, WorkspaceFolderRepoRef } from '../../types';

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
    repo_ref = { resource_id: resourceId };
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

interface WorkspaceFolderOptionsProps {
  /** 'qa' | 'security' — 기본 폴더 예시 placeholder 에 쓴다. */
  kind: 'qa' | 'security';
  state: WorkspaceFolderFormState;
  onChange: (patch: Partial<WorkspaceFolderFormState>) => void;
}

const fieldLabel: React.CSSProperties = {
  fontSize: 12, fontWeight: 600, color: tokens.colors.textSecondary, marginBottom: 4, display: 'block',
};
const helpText: React.CSSProperties = {
  fontSize: 12, color: tokens.colors.textMuted, marginTop: 4,
};

/**
 * QA 시나리오 / 보안 프로파일 편집 폼에 끼워 넣는 작업폴더 옵션 블록.
 * read 표시 + 변경 시 onChange(patch) 로 상위 상태를 갱신한다(저장은 상위 폼이).
 */
export function WorkspaceFolderOptions({ kind, state, onChange }: WorkspaceFolderOptionsProps) {
  const defaultFolderHint = `${kind}/<id>`;
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
          <div style={{ flex: 1 }}>
            <Select
              label="build_mode"
              value={state.buildMode}
              options={BUILD_OPTIONS}
              onChange={(e) => onChange({ buildMode: (e.target as HTMLSelectElement).value as BuildMode })}
            />
            <div style={helpText}>cold = 클린 빌드, warm = 증분 빌드.</div>
          </div>
        </div>

        <div>
          <label style={fieldLabel}>repo_ref (작업폴더로 체크아웃할 저장소 — 비우면 board/workspace 환경설정 repo 재사용)</label>
          <Input
            label="resource_id (등록된 repo 리소스)"
            placeholder="resource 선택 시 우선 적용 (url+branch 무시)"
            value={state.repoResourceId}
            onChange={(e) => onChange({ repoResourceId: (e.target as HTMLInputElement).value })}
          />
          <div style={{ display: 'flex', gap: 10, marginTop: 8 }}>
            <div style={{ flex: 2 }}>
              <Input
                label="repo URL"
                placeholder="https://github.com/org/repo.git"
                value={state.repoUrl}
                onChange={(e) => onChange({ repoUrl: (e.target as HTMLInputElement).value })}
              />
            </div>
            <div style={{ flex: 1 }}>
              <Input
                label="branch"
                placeholder="기본 브랜치"
                value={state.repoBranch}
                onChange={(e) => onChange({ repoBranch: (e.target as HTMLInputElement).value })}
              />
            </div>
          </div>
          <div style={helpText}>
            resource_id 가 있으면 그것을, 없고 URL 이 있으면 url+branch 를 씁니다. 셋 다 비우면
            board/workspace environment_config 의 repo 를 재사용합니다.
          </div>
        </div>
      </div>
    </div>
  );
}
