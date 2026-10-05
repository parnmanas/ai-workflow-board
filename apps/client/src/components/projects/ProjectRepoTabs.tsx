import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../../api';
import type { Project, RepoBranch, RepoRefs } from '../../types';
import { tokens } from '../../tokens';
import { Badge, Button, Input } from '../common';
import RepoHistoryTab from '../admin/RepoHistoryTab';
import RepoFilesTab from '../admin/RepoFilesTab';
import { ErrorBox, MONO } from '../admin/repoTabCommon';

// 프로젝트 저장소 읽기 탭 — Branches / History / Files (옛 repository Resource 상세
// 패널에서 옮겨왔다). History/Files 의 무거운 git 읽기(log/diff/tree)는 서버의
// per-project 캐시 클론에서 오고, ref 선택기는 두 탭이 같은 ref 를 따라가도록
// 공유한다. 호출 측(ProjectDetailPanel)이 project.id 를 key 로 넘겨 선택이 바뀌면
// remount 되므로, 이전 프로젝트의 늦은 응답이 새 프로젝트 위에 덮이지 않는다.

export type ProjectRepoTab = 'branches' | 'history' | 'files';

interface ProjectRepoTabsProps {
  project: Project;
  accountId: string;
  tab: ProjectRepoTab;
}

export default function ProjectRepoTabs({ project, accountId, tab }: ProjectRepoTabsProps) {
  // Branches 탭 상태 — 마운트 시 1회 + 새로고침.
  const [branchLoading, setBranchLoading] = useState(false);
  const [branchError, setBranchError] = useState<string | null>(null);
  const [branches, setBranches] = useState<RepoBranch[] | null>(null);
  const [remoteDefault, setRemoteDefault] = useState('');
  const [branchQuery, setBranchQuery] = useState('');

  // History/Files 공유 ref 선택기. 캐시 클론을 처음 만드는 비용이 있어(clone)
  // 마운트가 아니라 History/Files 탭을 처음 열 때 lazy 로 조회한다.
  const [refs, setRefs] = useState<RepoRefs | null>(null);
  const [refsLoading, setRefsLoading] = useState(false);
  const [refsError, setRefsError] = useState<string | null>(null);
  // 'SSH 전용 URL 미지원'(code 'ssh_unsupported') 일 때만 그 안내를 띄운다 — 그 외
  // 실패는 git stderr 원문만 보여줘 진짜 원인을 가리지 않는다.
  const [refsErrorSshOnly, setRefsErrorSshOnly] = useState(false);
  const [selectedRef, setSelectedRef] = useState('');

  const loadBranches = useCallback(async () => {
    setBranchLoading(true);
    setBranchError(null);
    try {
      const result = await api.listProjectBranches(project.id);
      setBranches(result?.branches || []);
      setRemoteDefault(result?.default_branch || '');
    } catch (err: any) {
      setBranchError(err?.message || '브랜치 목록을 불러오지 못했습니다.');
      setBranches(null);
    } finally {
      setBranchLoading(false);
    }
  }, [project.id]);

  useEffect(() => {
    if (tab === 'branches' && !branches && !branchLoading && !branchError) void loadBranches();
  }, [tab, branches, branchLoading, branchError, loadBranches]);

  const loadRefs = useCallback(async (refresh = false) => {
    setRefsLoading(true);
    setRefsError(null);
    setRefsErrorSshOnly(false);
    try {
      const result = await api.getProjectRefs(project.id, accountId, refresh);
      setRefs(result);
      // 기본 선택 = 원격 HEAD, 없으면 첫 브랜치, 그것도 없으면 빈 값(서버가 HEAD).
      setSelectedRef((prev) => prev || result.head || result.branches[0] || '');
    } catch (err: any) {
      setRefsError(err?.message || 'ref 목록을 불러오지 못했습니다.');
      setRefsErrorSshOnly(err?.code === 'ssh_unsupported');
      setRefs(null);
    } finally {
      setRefsLoading(false);
    }
  }, [project.id, accountId]);

  useEffect(() => {
    if ((tab === 'history' || tab === 'files') && !refs && !refsLoading && !refsError) void loadRefs();
  }, [tab, refs, refsLoading, refsError, loadRefs]);

  const defaultBranch = (project.default_branch || remoteDefault || '').trim();
  const filteredBranches = useMemo(() => {
    if (!branches) return [];
    const q = branchQuery.trim().toLowerCase();
    const list = q ? branches.filter((b) => b.name.toLowerCase().includes(q)) : branches;
    // 기본 브랜치를 항상 맨 위로 핀 고정.
    return [...list].sort((a, b) => {
      const ad = a.name === defaultBranch ? 0 : 1;
      const bd = b.name === defaultBranch ? 0 : 1;
      if (ad !== bd) return ad - bd;
      return a.name.localeCompare(b.name);
    });
  }, [branches, branchQuery, defaultBranch]);

  if (tab === 'branches') {
    return (
      <div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
          <div style={{ flex: 1 }}>
            <Input value={branchQuery} onChange={(e) => setBranchQuery(e.target.value)} placeholder="브랜치 검색…" />
          </div>
          <Button variant="secondary" size="md" onClick={() => void loadBranches()} disabled={branchLoading} loading={branchLoading}>
            새로고침
          </Button>
        </div>

        {branchLoading && (
          <div style={{ fontSize: 13, color: tokens.colors.textSecondary, padding: '16px 4px' }}>브랜치 불러오는 중…</div>
        )}

        {!branchLoading && branchError && (
          <div data-testid="project-branch-error">
            <ErrorBox message={`브랜치를 불러오지 못했습니다: ${branchError}`} />
            {/^(ssh:\/\/|git@)/i.test(project.repo_url || '') && (
              <div style={{ fontSize: 12, color: tokens.colors.textMuted, marginTop: 8, lineHeight: 1.5 }}>
                SSH 전용 URL은 서버 측 SSH 키가 필요합니다. HTTPS URL + credential을 사용해 주세요.
              </div>
            )}
          </div>
        )}

        {!branchLoading && !branchError && branches && branches.length === 0 && (
          <div style={{ fontSize: 13, color: tokens.colors.textMuted, padding: '16px 4px', lineHeight: 1.5 }}>
            원격에서 브랜치를 찾지 못했습니다. 빈 저장소이거나, SSH 전용 URL 이라 인증 키가 필요할 수 있습니다.
          </div>
        )}

        {!branchLoading && !branchError && branches && branches.length > 0 && (
          <div>
            <div style={{ fontSize: 11, color: tokens.colors.textMuted, marginBottom: 6 }}>
              {filteredBranches.length} / {branches.length} branches
            </div>
            <div
              data-testid="project-branch-list"
              style={{ border: `1px solid ${tokens.colors.border}`, borderRadius: tokens.radii.md, overflow: 'hidden' }}
            >
              {filteredBranches.length === 0 ? (
                <div style={{ fontSize: 13, color: tokens.colors.textMuted, padding: 12 }}>
                  "{branchQuery}" 과 일치하는 브랜치가 없습니다.
                </div>
              ) : (
                filteredBranches.map((b, idx) => {
                  const isDefault = b.name === defaultBranch;
                  return (
                    <div
                      key={b.name}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 8,
                        padding: '8px 12px',
                        borderTop: idx === 0 ? 'none' : `1px solid ${tokens.colors.border}`,
                        background: isDefault ? tokens.colors.surfaceCard : 'transparent',
                      }}
                    >
                      <span
                        aria-hidden
                        style={{
                          width: 8, height: 8, borderRadius: 4, flexShrink: 0,
                          background: isDefault ? tokens.colors.success : tokens.colors.border,
                        }}
                      />
                      <span
                        style={{
                          flex: 1, minWidth: 0, fontSize: 13, fontFamily: MONO, color: tokens.colors.textStrong,
                          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                        }}
                      >
                        {b.name}
                      </span>
                      {isDefault && <Badge variant="info">default</Badge>}
                      <span style={{ fontSize: 11, fontFamily: MONO, color: tokens.colors.textMuted, flexShrink: 0 }} title={b.sha}>
                        {(b.sha || '').slice(0, 8)}
                      </span>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        )}
      </div>
    );
  }

  // History / Files — ref 로딩/에러를 먼저 처리하고, 준비되면 본문 탭을 렌더한다.
  // ref 조회가 캐시 클론 생성을 트리거하므로 에러(예: SSH-only)도 여기서 한 번에 노출된다.
  if (refsLoading && !refs) {
    return (
      <div style={{ fontSize: 13, color: tokens.colors.textSecondary, padding: '16px 4px' }}>
        저장소 캐시 준비 중… (최초 1회 클론이 필요해 시간이 걸릴 수 있습니다)
      </div>
    );
  }
  if (refsError) {
    return (
      <div>
        <ErrorBox message={refsError} />
        {refsErrorSshOnly && (
          <div style={{ fontSize: 12, color: tokens.colors.textMuted, marginTop: 8, lineHeight: 1.5 }}>
            SSH 전용 URL 은 서버에 인증 키가 없어 지원되지 않습니다. HTTPS URL + credential 로
            연결된 프로젝트만 히스토리/파일 조회가 가능합니다.
          </div>
        )}
        <div style={{ marginTop: 10 }}>
          <Button variant="secondary" size="sm" onClick={() => void loadRefs(true)} loading={refsLoading}>
            다시 시도
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
        <select
          data-testid="repo-ref-select"
          aria-label="ref 선택"
          value={selectedRef}
          onChange={(e) => setSelectedRef(e.target.value)}
          disabled={refsLoading || !refs}
          style={{
            flex: 1, minWidth: 0, fontSize: 13, fontFamily: 'inherit', padding: '7px 10px',
            borderRadius: tokens.radii.md, border: `1px solid ${tokens.colors.border}`,
            background: tokens.colors.surface, color: tokens.colors.textStrong,
          }}
        >
          {refs && refs.branches.length > 0 && (
            <optgroup label="Branches">
              {refs.branches.map((b) => <option key={`b/${b}`} value={b}>{b}</option>)}
            </optgroup>
          )}
          {refs && refs.tags.length > 0 && (
            <optgroup label="Tags">
              {refs.tags.map((t) => <option key={`t/${t}`} value={t}>{t}</option>)}
            </optgroup>
          )}
          {(!refs || (refs.branches.length === 0 && refs.tags.length === 0)) && (
            <option value="">{refsLoading ? '불러오는 중…' : 'HEAD'}</option>
          )}
        </select>
        <Button variant="secondary" size="md" onClick={() => void loadRefs(true)} disabled={refsLoading} loading={refsLoading}>
          새로고침
        </Button>
      </div>
      {tab === 'history'
        ? <RepoHistoryTab projectId={project.id} accountId={accountId} refKey={selectedRef} />
        : <RepoFilesTab projectId={project.id} accountId={accountId} refKey={selectedRef} />}
    </div>
  );
}
