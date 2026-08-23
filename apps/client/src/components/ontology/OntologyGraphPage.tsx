import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api } from '../../api';
import type { OntologyGraphProgressEvent, OntologyGraphStatusResponse, Resource } from '../../types';
import { useToast } from '../../contexts/ToastContext';
import { useBoardStreamEvent } from '../../contexts/BoardStreamContext';
import { tokens } from '../../tokens';
import PageHeader from '../PageHeader';
import { Button, EmptyState, Input, Select } from '../common';
import { freshnessBadge, type FreshnessTone } from './freshness';

// tokens.colors 조합만 사용(hex 리터럴 금지) — 아래 4개 쌍(success/danger/
// warning/info Light 변형 on surface)은 contrast.test.mjs가 이미
// AA(4.5:1)를 고정 검증하는 조합이라 새 대비 검증이 필요 없다.
const TONE_COLOR: Record<FreshnessTone, { fg: string; bg: string }> = {
  building: { fg: tokens.colors.info, bg: `${tokens.colors.info}20` },
  fresh: { fg: tokens.colors.successLight, bg: `${tokens.colors.successBg}40` },
  stale: { fg: tokens.colors.warningLight, bg: `${tokens.colors.warningBg}40` },
  error: { fg: tokens.colors.dangerMid, bg: `${tokens.colors.dangerBg}40` },
  unknown: { fg: tokens.colors.textSecondary, bg: `${tokens.colors.border}40` },
};

const POLL_MS = 3000;

/**
 * Ontology Graph UI 셸(ticket d22b83b4, DESIGN.md 축 5) — 라우트/사이드바
 * 진입점. 캔버스 렌더러는 별도 게이트 티켓(32973924)의 몫이라 여기서는
 * repo+folder 선택 → graph_status 프로비저닝 → 프레시니스 배지만 다룬다.
 */
export default function OntologyGraphPage() {
  const { wsId = '' } = useParams<{ wsId: string }>();
  const { showToast } = useToast();

  const [repos, setRepos] = useState<Resource[]>([]);
  const [resourceId, setResourceId] = useState('');
  const [folderPath, setFolderPath] = useState('');
  const [statusResp, setStatusResp] = useState<OntologyGraphStatusResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 같은 (resource_id, folder_path) 선택에 대해 재방문 로그를 중복 기록하지
  // 않기 위한 마지막 로깅 키 — 폴링 tick마다가 아니라 "사람이 다른
  // repo/folder를 골랐을 때"만 1회 기록되게 한다.
  const loggedViewKey = useRef<string | null>(null);

  useEffect(() => {
    if (!wsId) return;
    api.listResources(wsId, 'repository').then(setRepos).catch(() => setRepos([]));
  }, [wsId]);

  const load = useCallback(
    async (opts?: { silent?: boolean }) => {
      if (!wsId || !resourceId) return;
      if (!opts?.silent) setLoading(true);
      try {
        const resp = await api.getOntologyGraphStatus(wsId, { resourceId, folderPath });
        setStatusResp(resp);
      } catch (e: any) {
        if (!opts?.silent) showToast(e?.message || 'Failed to load graph status', 'error');
      } finally {
        if (!opts?.silent) setLoading(false);
      }
    },
    [wsId, resourceId, folderPath, showToast],
  );

  // 선택이 바뀔 때마다 상태를 다시 불러온다 — 최초 (resource_id, folder_path)
  // 참조라면 이 호출 자체가 자동 프로비저닝+빌드 킥오프다(resolveOrProvision,
  // graph_status MCP 툴과 동일 계약).
  useEffect(() => {
    if (!resourceId) { setStatusResp(null); return; }
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wsId, resourceId, folderPath]);

  // 휴먼 그래프뷰 재방문 텔레메트리(Done-when) — 폴링이 아니라 실제로 다른
  // repo/folder를 선택했을 때만 1회 기록.
  useEffect(() => {
    if (!wsId || !resourceId) return;
    const key = `${resourceId}::${folderPath}`;
    if (loggedViewKey.current === key) return;
    loggedViewKey.current = key;
    api.logOntologyGraphViewOpened(wsId, { resourceId, folderPath }).catch(() => { /* 텔레메트리 실패는 조용히 무시 */ });
  }, [wsId, resourceId, folderPath]);

  // "Build/Refresh Graph" 액션(리뷰 지적, 승인 블로커) — load()(GET
  // /status)는 조회+최초 프로비저닝만 할 뿐, 이미 존재하는(ready/stale/
  // error) 그래프는 재시작하지 않는다(resolveOrProvision은 created===true일
  // 때만 kickOffInitialBuild를 부른다). 기존 그래프에 대해서는 별도
  // POST /refresh(forceRebuild, 원자적 단일-승자 UPDATE)로 실제 재빌드를
  // 킥오프한 뒤, 그 결과(대개 status='building')를 반영하도록 load()를
  // 다시 불러 폴링을 재개시킨다.
  const handleBuildOrRefresh = useCallback(async () => {
    if (!wsId || !resourceId) return;
    if (!statusResp) {
      void load();
      return;
    }
    setRefreshing(true);
    try {
      await api.refreshOntologyGraph(wsId, statusResp.graph_id);
    } catch (e: any) {
      showToast(e?.message || 'Failed to refresh graph', 'error');
    } finally {
      setRefreshing(false);
    }
    void load({ silent: true });
  }, [wsId, resourceId, statusResp, load, showToast]);

  // building 동안만 폴링 — ready/error/stale 도달 즉시 멈춘다
  // (MissionDetailPage.tsx의 isLive 안전망 폴링과 같은 자세).
  const isBuilding = statusResp?.status === 'building';
  useEffect(() => {
    if (!isBuilding) return;
    const handle = setInterval(() => void load({ silent: true }), POLL_MS);
    return () => clearInterval(handle);
  }, [isBuilding, load]);

  // 배경 스윕/증분 갱신(오늘은 대개 무음 — incremental scheduler가 아직
  // 어떤 실 트리거에도 배선돼 있지 않음, ontology-graph-freshness.test.mjs
  // 코멘트 참고)이 이 그래프를 건드리면 즉시(디바운스) 재조회한다 —
  // MissionDetailPage.tsx의 scheduleRefresh와 같은 패턴.
  useBoardStreamEvent('ontology_graph_progress', (data: OntologyGraphProgressEvent) => {
    if (!data || data.workspace_id !== wsId || !statusResp || data.graph_id !== statusResp.graph_id) return;
    if (refreshTimer.current) clearTimeout(refreshTimer.current);
    refreshTimer.current = setTimeout(() => void load({ silent: true }), 400);
  });

  useEffect(() => () => {
    if (refreshTimer.current) clearTimeout(refreshTimer.current);
  }, []);

  const badge = statusResp
    ? freshnessBadge({
        status: statusResp.status,
        indexedAt: statusResp.indexed_at,
        commit: statusResp.commit,
        behind: statusResp.behind,
        ahead: statusResp.ahead,
        dirtyRatio: statusResp.dirty_ratio,
        freshnessError: statusResp.freshness_error,
      })
    : null;
  const tone = badge ? TONE_COLOR[badge.tone] : null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <PageHeader
        title="Ontology Graph"
        description="Extracted structural and semantic graph of a repository — symbols, calls, imports, and how they relate."
        actions={
          <Button
            variant="primary"
            onClick={() => void handleBuildOrRefresh()}
            disabled={!resourceId || loading || refreshing || isBuilding}
          >
            {statusResp ? 'Refresh Graph' : 'Build Graph'}
          </Button>
        }
      />

      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 20, display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <Select
            label="Repository"
            value={resourceId}
            onChange={(e) => setResourceId(e.target.value)}
            options={[
              { value: '', label: repos.length ? 'Select a repository…' : 'No repository resources in this workspace yet', disabled: true },
              ...repos.map((r) => ({ value: r.id, label: r.name })),
            ]}
          />
          <Input
            label="Folder (optional)"
            placeholder="repo root"
            value={folderPath}
            onChange={(e) => setFolderPath(e.target.value)}
          />
        </div>

        {!resourceId && (
          <EmptyState
            title="Pick a repository"
            description="Select a repository resource (and optionally a folder) to build or view its Ontology Graph."
          />
        )}

        {resourceId && badge && (
          <div
            style={{
              padding: '12px 16px',
              borderRadius: tokens.radii.md,
              background: tone!.bg,
              color: tone!.fg,
              display: 'flex',
              flexDirection: 'column',
              gap: 4,
            }}
          >
            <div style={{ fontWeight: tokens.typography.fontWeightSemibold, fontSize: tokens.typography.fontSizeMd }}>
              {badge.headline}
            </div>
            {badge.detail && (
              <div style={{ fontSize: tokens.typography.fontSizeXs, opacity: 0.85 }}>{badge.detail}</div>
            )}
          </div>
        )}

        {resourceId && statusResp?.status === 'error' && (
          <EmptyState
            title="Graph build failed"
            description={statusResp.error || 'The last build attempt failed — try Refresh Graph to retry.'}
          />
        )}

        {resourceId && (statusResp?.status === 'ready' || statusResp?.status === 'stale') && (
          <EmptyState
            title="Graph canvas coming soon"
            description="The interactive graph renderer ships in a separate follow-up ticket. The graph itself is already built and queryable via the graph_ MCP tools."
          />
        )}
      </div>
    </div>
  );
}
