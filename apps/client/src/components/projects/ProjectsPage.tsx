import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { api } from '../../api';
import type { Credential, Project } from '../../types';
import { useToast } from '../../contexts/ToastContext';
import { tokens } from '../../tokens';
import PageHeader from '../PageHeader';
import { Button, ConfirmDialog, Input } from '../common';
import { notifyProjectsChanged, useProjects } from '../../projects/useProjects';
import {
  describeProjectUsage,
  mergeSavedProject,
  projectInUseCounts,
  type ProjectUsageCount,
} from '../../projects/projectForm.logic';
import ProjectDetailPanel from './ProjectDetailPanel';

/**
 * Projects — one git repository + the knowledge every feature needs to work on
 * it (docs/tickets.md → Project). Replaces repository Resources (same ids).
 * Master/detail like ResourceManager: list on the left, the selected project
 * (settings · host folders · branches/history/files) on the right. Route
 * `/ws/:wsId/projects` (`?project=<id>` preselects one).
 */

// 이 폭 미만이면 리스트만 보여주고 detail 은 풀폭 오버레이로 띄운다(ResourceManager 와 같은 기준).
const NARROW_BREAKPOINT = 720;
const NEW = '__new__';

export default function ProjectsPage() {
  const { wsId = '' } = useParams<{ wsId: string }>();
  const [searchParams] = useSearchParams();
  const { showToast } = useToast();
  const { projects: listed, loading, error, reload } = useProjects(wsId);

  // 마지막 쓰기 결과 — 공유 목록 재조회가 따라오기 전까지 화면에 먼저 반영한다.
  const [lastSaved, setLastSaved] = useState<Project | null>(null);
  const projects = useMemo(() => mergeSavedProject(listed, lastSaved), [listed, lastSaved]);
  useEffect(() => {
    if (!lastSaved) return;
    const row = listed.find((p) => p.id === lastSaved.id);
    if (row && (row.updated_at || '') >= (lastSaved.updated_at || '')) setLastSaved(null);
  }, [listed, lastSaved]);

  const [selectedId, setSelectedId] = useState<string | null>(() => searchParams.get('project'));
  const [query, setQuery] = useState('');
  const [credentials, setCredentials] = useState<Credential[]>([]);
  const [hosts, setHosts] = useState<Array<{ id: string; name: string }>>([]);
  const [hostsLoading, setHostsLoading] = useState(true);

  const [deleteTarget, setDeleteTarget] = useState<Project | null>(null);
  const [inUse, setInUse] = useState<{ project: Project; counts: ProjectUsageCount[] } | null>(null);
  const [deleting, setDeleting] = useState(false);

  const [isNarrow, setIsNarrow] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = containerRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width ?? 0;
      setIsNarrow(w > 0 && w < NARROW_BREAKPOINT);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    if (!wsId) return;
    let cancelled = false;
    api.listCredentials(wsId)
      .then((rows) => { if (!cancelled) setCredentials(rows || []); })
      .catch(() => { if (!cancelled) setCredentials([]); });
    return () => { cancelled = true; };
  }, [wsId]);

  useEffect(() => {
    let cancelled = false;
    setHostsLoading(true);
    api.listTemplateHosts()
      .then((rows) => { if (!cancelled) setHosts((rows || []).map((h) => ({ id: h.id, name: h.name || h.id.slice(0, 8) }))); })
      .catch(() => { if (!cancelled) setHosts([]); })
      .finally(() => { if (!cancelled) setHostsLoading(false); });
    return () => { cancelled = true; };
  }, []);

  // 좁은 폭 오버레이는 Esc 로 닫는다.
  useEffect(() => {
    if (!isNarrow || !selectedId) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setSelectedId(null); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [isNarrow, selectedId]);

  const handleSaved = useCallback((saved: Project, created: boolean) => {
    setLastSaved(saved);
    if (created) setSelectedId(saved.id);
    notifyProjectsChanged();
  }, []);

  const runDelete = async (project: Project, force: boolean) => {
    setDeleting(true);
    try {
      await api.deleteProject(project.id, force ? { force: true } : undefined);
      showToast(`${project.name} 프로젝트를 삭제했습니다.`, 'success');
      setDeleteTarget(null);
      setInUse(null);
      if (selectedId === project.id) setSelectedId(null);
      if (lastSaved?.id === project.id) setLastSaved(null);
      notifyProjectsChanged();
    } catch (err) {
      const counts = force ? null : projectInUseCounts(err);
      setDeleteTarget(null);
      if (counts) {
        setInUse({ project, counts });
      } else {
        setInUse(null);
        showToast((err as Error)?.message || '프로젝트를 삭제하지 못했습니다.', 'error');
      }
    } finally {
      setDeleting(false);
    }
  };

  const q = query.trim().toLocaleLowerCase();
  const visible = q
    ? projects.filter((p) => p.name.toLocaleLowerCase().includes(q) || (p.repo_url || '').toLocaleLowerCase().includes(q))
    : projects;
  const selectedProject = selectedId && selectedId !== NEW ? projects.find((p) => p.id === selectedId) || null : null;
  const showDetail = selectedId === NEW || !!selectedProject;

  const detail = showDetail ? (
    <ProjectDetailPanel
      key={selectedId === NEW ? NEW : selectedProject!.id}
      project={selectedId === NEW ? null : selectedProject}
      workspaceId={wsId}
      credentials={credentials}
      hosts={hosts}
      hostsLoading={hostsLoading}
      onSaved={handleSaved}
      onDelete={setDeleteTarget}
      onCancelNew={() => setSelectedId(null)}
      onClose={isNarrow ? () => setSelectedId(null) : undefined}
      showToast={showToast}
    />
  ) : (
    <div style={{ minHeight: 240, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', textAlign: 'center', color: tokens.colors.textMuted, padding: 24 }}>
      <div style={{ fontSize: 15, fontWeight: 700, color: tokens.colors.textSecondary, marginBottom: 6 }}>프로젝트를 선택하세요</div>
      <div style={{ fontSize: 12 }}>왼쪽 목록에서 프로젝트를 고르거나 새 프로젝트를 만드세요.</div>
    </div>
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <PageHeader
        title="Projects"
        description="Git 저장소와 그 저장소를 작업하는 데 필요한 지식 — 티켓·QA·보안·Action·미션이 같은 프로젝트를 가리킵니다."
        actions={<Button variant="primary" size="md" onClick={() => setSelectedId(NEW)}>+ 새 프로젝트</Button>}
      />
      <div ref={containerRef} style={{ flex: 1, overflow: 'auto', minHeight: 0, padding: 24 }}>
        {loading && projects.length === 0 ? (
          <div style={{ fontSize: 13, color: tokens.colors.textSecondary, padding: 24 }}>불러오는 중…</div>
        ) : error && projects.length === 0 ? (
          <div style={{ fontSize: 13, color: tokens.colors.danger, padding: 24 }}>
            {error}{' '}
            <Button variant="secondary" size="sm" onClick={() => void reload()}>다시 시도</Button>
          </div>
        ) : (
          <div style={{ display: 'flex', gap: tokens.spacing.md, alignItems: 'flex-start' }}>
            <div style={{ width: isNarrow ? '100%' : 320, flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
              <Input
                type="search"
                aria-label="프로젝트 검색"
                placeholder={`${projects.length}개 프로젝트 — 이름·URL 검색`}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
              <div
                data-testid="project-list"
                style={{ border: `1px solid ${tokens.colors.border}`, borderRadius: tokens.radii.md, overflow: 'hidden', background: tokens.colors.surface }}
              >
                {visible.length === 0 ? (
                  <div style={{ fontSize: 12, color: tokens.colors.textMuted, padding: 16, lineHeight: 1.5 }}>
                    {projects.length === 0
                      ? '아직 프로젝트가 없습니다. "+ 새 프로젝트" 로 저장소를 등록하세요.'
                      : `"${query}" 와 일치하는 프로젝트가 없습니다.`}
                  </div>
                ) : visible.map((p) => (
                  <ProjectRow key={p.id} project={p} selected={p.id === selectedId} onSelect={() => setSelectedId(p.id)} />
                ))}
              </div>
            </div>
            {!isNarrow && (
              <div
                style={{
                  flex: 1, minWidth: 0, border: `1px solid ${tokens.colors.border}`, borderRadius: tokens.radii.md,
                  background: tokens.colors.surfaceCard, padding: 20,
                }}
              >
                {detail}
              </div>
            )}
          </div>
        )}
      </div>

      {isNarrow && showDetail && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={selectedProject?.name || '새 프로젝트'}
          style={{ position: 'fixed', inset: 0, background: tokens.colors.surface, zIndex: 9000, overflow: 'auto', padding: 20 }}
        >
          {detail}
        </div>
      )}

      <ConfirmDialog
        isOpen={!!deleteTarget}
        title="프로젝트를 삭제할까요?"
        confirmLabel={deleting ? '삭제 중…' : '삭제'}
        cancelLabel="취소"
        danger
        message={deleteTarget ? `${deleteTarget.name} 프로젝트와 Host 폴더 지정이 삭제됩니다. 저장소 자체와 Host 의 체크아웃은 지워지지 않습니다.` : undefined}
        onConfirm={() => { if (deleteTarget && !deleting) void runDelete(deleteTarget, false); }}
        onCancel={() => setDeleteTarget(null)}
      />

      <ConfirmDialog
        isOpen={!!inUse}
        title="아직 이 프로젝트를 쓰는 항목이 있습니다"
        confirmLabel={deleting ? '삭제 중…' : '강제 삭제'}
        cancelLabel="취소"
        danger
        message={inUse ? (
          <div data-testid="project-in-use">
            <div style={{ marginBottom: 8 }}>{inUse.project.name} 를 참조하는 항목: {describeProjectUsage(inUse.counts)}</div>
            {inUse.counts.length > 0 && (
              <ul style={{ margin: '0 0 8px 18px', padding: 0 }}>
                {inUse.counts.map((c) => <li key={c.key}>{c.label}: {c.count}</li>)}
              </ul>
            )}
            <div>강제 삭제하면 이 참조들은 프로젝트를 잃습니다(티켓·실행은 남고 저장소 지정만 빠집니다).</div>
          </div>
        ) : undefined}
        onConfirm={() => { if (inUse && !deleting) void runDelete(inUse.project, true); }}
        onCancel={() => setInUse(null)}
      />
    </div>
  );
}

function ProjectRow({ project, selected, onSelect }: { project: Project; selected: boolean; onSelect(): void }) {
  const folderCount = (project.host_folders || []).filter((f) => (f.path || '').trim()).length;
  return (
    <div
      role="button"
      tabIndex={0}
      aria-pressed={selected}
      data-testid={`project-row-${project.id}`}
      onClick={onSelect}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(); } }}
      style={{
        padding: '10px 12px',
        cursor: 'pointer',
        borderLeft: `3px solid ${selected ? tokens.colors.accent : 'transparent'}`,
        background: selected ? tokens.colors.surfaceCard : 'transparent',
        borderBottom: `1px solid ${tokens.colors.border}`,
        outline: 'none',
      }}
    >
      <div style={{ fontSize: 13, fontWeight: 600, color: tokens.colors.textStrong, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {project.name}
      </div>
      <div style={{ fontSize: 11, color: tokens.colors.textMuted, marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {project.repo_url || '(URL 없음)'}
      </div>
      <div style={{ fontSize: 11, color: tokens.colors.textMuted, marginTop: 2 }}>
        {project.default_branch ? `${project.default_branch} · ` : ''}Host 폴더 {folderCount}
      </div>
    </div>
  );
}
