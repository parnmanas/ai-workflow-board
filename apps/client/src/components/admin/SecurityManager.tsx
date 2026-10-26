import { t as translate } from '../../i18n/core';
import { useLocale } from '../../i18n/react';
import React, { useState, useEffect, useCallback } from 'react';
import { api, getActiveAccountId, rawResourceUrl } from '../../api';
import type {
  SecurityProfile, SecurityProfileListItem, SecurityRun, SecurityFinding,
  SecurityChecklistItem, SecurityOnFailureTicketConfig, SecurityRunBatch,
  SecuritySchedule, SecurityScheduleScope, SecurityScheduleKind, SecuritySeverity, SecurityScopeMode,
} from '../../types';
import { useToast } from '../../contexts/ToastContext';
import { tokens } from '../../tokens';
import { Button, Input, Select, Modal, Card, ConfirmDialog } from '../common';
import { relativeTime } from '../../utils/time';
import { formatAgentDisplayName } from '../../utils/agentName';
import DeclareRuntimeSection from '../runtime/DeclareRuntimeSection';
import MediaLightbox from '../common/MediaLightbox';
import { canOpenTicket, ticketPath } from '../../utils/ticketPath';
import { useProjects } from '../../projects/useProjects';
import OnFailureTicketTargetFields from './OnFailureTicketTargetFields';
import { onFailureTicketFromForm, onFailureTicketToForm, projectSelectOptions, type OnFailureTicketForm } from './onFailureTicket.logic';
import {
  WorkspaceFolderOptions,
  initWorkspaceFolderState,
  buildWorkspaceFolderPayload,
  type WorkspaceFolderFormState,
} from './WorkspaceFolderOptions';

// SecurityManager 내부에서 다루는 agent 표시용 최소 형태. 서버 GET /api/agents 가
// _enrichManagerNames 로 채워주는 manager_name 을 보존해 full name 렌더에 사용한다.
type SecAgent = { id: string; name: string; manager_name?: string };

interface SecurityManagerProps {
  accountId?: string;
  allScopes?: boolean;
}

const RUN_STATUS_VARIANT: Record<string, 'success' | 'danger' | 'warning' | 'info' | 'neutral'> = {
  passed: 'success',
  failed: 'danger',
  error: 'danger',
  running: 'info',
  pending: 'neutral',
};

function statusVariant(s: string) {
  return RUN_STATUS_VARIANT[s] ?? 'neutral';
}

// ── Severity model (critical → info) ─────────────────────────────────────────
// Distinct colors per severity so a findings list reads at a glance. Higher rank
// = more severe; used for ordering groups and computing a profile's worst.
const SEVERITY_ORDER: SecuritySeverity[] = ['critical', 'high', 'medium', 'low', 'info'];
const SEVERITY_RANK: Record<SecuritySeverity, number> = { critical: 4, high: 3, medium: 2, low: 1, info: 0 };
const SEVERITY_COLOR: Record<SecuritySeverity, { bg: string; fg: string; border: string }> = {
  critical: { bg: '#7f1d1d', fg: '#fecaca', border: '#dc2626' },
  high: { bg: '#7c2d12', fg: '#fed7aa', border: '#ea580c' },
  medium: { bg: '#78350f', fg: '#fde68a', border: '#d97706' },
  low: { bg: '#1e3a8a', fg: '#bfdbfe', border: '#3b82f6' },
  info: { bg: '#283548', fg: '#cbd5e1', border: '#475569' },
};

/** Highest severity among a run's findings (null when there are none). */
function highestSeverity(findings: SecurityFinding[] | null | undefined): SecuritySeverity | null {
  if (!findings || findings.length === 0) return null;
  let worst: SecuritySeverity = 'info';
  for (const f of findings) {
    if (SEVERITY_RANK[f.severity] > SEVERITY_RANK[worst]) worst = f.severity;
  }
  return worst;
}

// 텍스트 pill — 공유 <Pill> 는 children 을 버리고 점만 렌더하므로
// (driver/target/result 등 라벨이 사라짐) 텍스트가 보여야 하는 자리에는 이 Pill 을
// 쓴다. 대문자 강제 없이 컴팩트하게 — 표/상세의 라벨 컬럼이 한눈에 읽히도록.
const PILL_COLORS: Record<'success' | 'danger' | 'warning' | 'info' | 'neutral', { bg: string; fg: string }> = {
  success: { bg: `${tokens.colors.successBg}30`, fg: tokens.colors.successLight },
  danger: { bg: `${tokens.colors.dangerBg}30`, fg: tokens.colors.dangerLight },
  warning: { bg: `${tokens.colors.warningBg}30`, fg: tokens.colors.warningLight },
  info: { bg: `${tokens.colors.accent}20`, fg: tokens.colors.accentLight },
  neutral: { bg: `${tokens.colors.border}40`, fg: tokens.colors.textSecondary },
};

function Pill({ variant = 'neutral', children }: { variant?: keyof typeof PILL_COLORS; children: React.ReactNode }) {
  useLocale();
  const c = PILL_COLORS[variant];
  return (
    <span style={{
      display: 'inline-block', fontSize: 11, fontWeight: 600, padding: '2px 8px',
      borderRadius: tokens.radii.sm, background: c.bg, color: c.fg, whiteSpace: 'nowrap', lineHeight: 1.5,
    }}>
      {children}
    </span>
  );
}

function SeverityBadge({ severity, size = 'sm' }: { severity: SecuritySeverity; size?: 'sm' | 'md' }) {
  useLocale();
  const c = SEVERITY_COLOR[severity];
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 4,
      background: c.bg, color: c.fg, border: `1px solid ${c.border}`,
      borderRadius: tokens.radii.sm, fontWeight: 700, textTransform: 'uppercase',
      letterSpacing: 0.3, fontSize: size === 'md' ? 12 : 10,
      padding: size === 'md' ? '3px 9px' : '2px 6px', whiteSpace: 'nowrap',
    }}>
      {severity}
    </span>
  );
}

/** 'self' (AWB own codebase) vs 'repo' (a Project — same id as the old repo Resource). */
function TargetBadge({ resourceId }: { resourceId: string | null }) {
  useLocale();
  return resourceId
    ? <span title={translate('project {0}', { 0: resourceId })} style={{ display: 'inline-flex' }}><Pill variant="info">{translate('repo')}</Pill></span>
    : <span title={translate('AWB 자체 코드베이스 (agent worktree)')} style={{ display: 'inline-flex' }}><Pill variant="neutral">{translate('self')}</Pill></span>;
}

// 화면용 view-model — list projection 에 없는 pass_rate / highest_severity 를
// run history 에서 클라이언트가 계산해 합친다 (서버 run 로직은 #foundation 경계 밖).
interface ProfileRow extends SecurityProfileListItem {
  pass_rate: number | null;
  highest_severity: SecuritySeverity | null;
}

/**
 * Security panel — sibling of QaManager. Lists security profiles as a
 * status table (driver / target / scope / last result / worst severity /
 * pass-rate), runs them (single or sequential batch), and visualizes each run's
 * findings grouped by severity with evidence galleries + auto-fix-ticket links.
 */
export default function SecurityManager({ accountId, allScopes = false }: SecurityManagerProps) {
  useLocale();
  const { showToast } = useToast();
  const effectiveAccountId = accountId || (getActiveAccountId() || '');

  const [profiles, setProfiles] = useState<ProfileRow[]>([]);
  const [agents, setAgents] = useState<SecAgent[]>([]);
  // P4b: runtime 선언 → 매칭용 full 행.
  const [selected, setSelected] = useState<SecurityProfile | null>(null);
  const [running, setRunning] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState<string | null>(null);
  const [editing, setEditing] = useState<SecurityProfile | 'new' | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<SecurityProfile | null>(null);
  // Sequential-batch state.
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [activeBatch, setActiveBatch] = useState<SecurityRunBatch | null>(null);
  const [batchStarting, setBatchStarting] = useState(false);
  // Schedule (자동 트리거 레이어) state.
  const [schedules, setSchedules] = useState<SecuritySchedule[]>([]);
  const [editingSchedule, setEditingSchedule] = useState<SecuritySchedule | 'new' | null>(null);
  const [confirmDeleteSchedule, setConfirmDeleteSchedule] = useState<SecuritySchedule | null>(null);

  const load = useCallback(async () => {
    if (!effectiveAccountId) { setProfiles([]); setSchedules([]); return; }
    try {
      const [list, agentList, scheduleList] = await Promise.all([
        api.listSecurityProfiles(effectiveAccountId),
        Promise.resolve([]),
        api.listSecuritySchedules(effectiveAccountId).catch(() => []),
      ]);
      // Enrich each profile with pass_rate + worst severity from its run history.
      // The list projection carries the last-run rollup but not these two; we
      // compute them client-side (server run logic is out of this ticket's scope).
      const rows: ProfileRow[] = await Promise.all((list as SecurityProfileListItem[]).map(async (p) => {
        if (!p.run_count) return { ...p, pass_rate: null, highest_severity: null };
        try {
          const runs = await api.listSecurityRuns(p.id, effectiveAccountId, 30);
          const finished = runs.filter((r) => r.status === 'passed' || r.status === 'failed' || r.status === 'error');
          const passRate = finished.length
            ? Math.round((finished.filter((r) => r.status === 'passed').length / finished.length) * 100)
            : null;
          const latest = runs[0] ?? null;
          return { ...p, pass_rate: passRate, highest_severity: highestSeverity(latest?.findings) };
        } catch {
          return { ...p, pass_rate: null, highest_severity: null };
        }
      }));
      setProfiles(rows);
      setAgents((agentList || []).map((a: any) => ({ id: a.id, name: a.name, manager_name: a.manager_name })));
      // P4b: runtime 선언 → 매칭용 full 행 보관.
      setSchedules(scheduleList || []);
    } catch (err: any) {
      showToast(err?.message || translate('Failed to load security profiles'), 'error');
    }
  }, [effectiveAccountId, allScopes, showToast]);

  useEffect(() => { load(); }, [load]);

  // Live refresh while any profile has an in-flight run (no SSE channel — poll
  // and idle when nothing is running).
  const anyProfileRunning = profiles.some((p) => p.last_run_status === 'running');
  useEffect(() => {
    if (!anyProfileRunning) return;
    const t = setInterval(() => { load(); }, 3000);
    return () => clearInterval(t);
  }, [anyProfileRunning, load]);

  // manager_name 을 포함한 full name(Manager/Agent)으로 표시. 목록에 없는
  // agent 는 id 앞 8자리 fallback (QA 가 빠뜨렸던 버그 반복 금지).
  // P4c-3b: rt- target은 target_runtime 라벨로 표시한다.
  const agentName = useCallback((id: string, spec?: any) => {
    const a = agents.find((x) => x.id === id);
    if (a) return formatAgentDisplayName(a);
    const label = (spec?.label || '').trim();
    if (label) return label;
    return id.slice(0, 8);
  }, [agents]);

  const handleRun = async (p: SecurityProfile) => {
    setRunning(p.id);
    try {
      const result = await api.runSecurityProfile(p.id);
      showToast(translate('보안 점검 시작 (room {0})', { 0: result.room_id.slice(0, 8) }), 'success');
      setSelected(p);
    } catch (err: any) {
      showToast(err?.message || translate('Failed to start security run'), 'error');
    } finally {
      setRunning(null);
    }
  };

  const handleRefreshChecklist = async (p: SecurityProfile) => {
    setRefreshing(p.id);
    try {
      await api.refreshSecurityChecklist(p.id);
      showToast(translate('체크리스트 갱신 작업을 에이전트에 디스패치했습니다 (WebSearch → checklist 갱신)'), 'success');
    } catch (err: any) {
      showToast(err?.message || translate('Failed to refresh checklist'), 'error');
    } finally {
      setRefreshing(null);
    }
  };

  const toggleSelect = useCallback((id: string) => {
    setSelectedIds((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  // Profiles in display order whose id is checked — preserves table order so the
  // sequential batch runs top-to-bottom.
  const orderedSelected = profiles.filter((p) => selectedIds.has(p.id));

  const startBatch = useCallback(async (payload: { all?: boolean; profile_ids?: string[] }) => {
    setBatchStarting(true);
    try {
      const batch = await api.startSecurityBatch({
        account_id: effectiveAccountId,
        ...payload,
      });
      setActiveBatch(batch);
      showToast(translate('보안 점검 batch 시작 — {0}개 프로파일 순차 실행', { 0: batch.total }), 'success');
    } catch (err: any) {
      showToast(err?.message || translate('Failed to start security batch'), 'error');
    } finally {
      setBatchStarting(false);
    }
  }, [effectiveAccountId, showToast]);

  // Poll the active batch while it's running (dispatch is server-driven, one run
  // at a time).
  useEffect(() => {
    if (!activeBatch || activeBatch.status !== 'running') return;
    let cancelled = false;
    const tick = async () => {
      try {
        const fresh = await api.getSecurityBatch(activeBatch.id, effectiveAccountId);
        if (cancelled) return;
        setActiveBatch(fresh);
        if (fresh.status !== 'running') load();
      } catch { /* transient — keep polling */ }
    };
    const h = setInterval(tick, 4000);
    return () => { cancelled = true; clearInterval(h); };
  }, [activeBatch, effectiveAccountId, load]);

  const handleDelete = async (p: SecurityProfile) => {
    try {
      await api.deleteSecurityProfile(p.id, effectiveAccountId);
      showToast(translate('보안 프로파일 삭제됨'), 'success');
      setConfirmDelete(null);
      if (selected?.id === p.id) setSelected(null);
      await load();
    } catch (err: any) {
      showToast(err?.message || translate('Failed to delete profile'), 'error');
    }
  };

  const handleScheduleRunNow = async (s: SecuritySchedule) => {
    try {
      const { kind, batch, refreshes } = await api.runSecurityScheduleNow(s.id, effectiveAccountId);
      if (kind === 'checklist_refresh') {
        // No batch — a refresh updates checklists, not findings. Surface how many
        // profiles got a refresh dispatched.
        const n = refreshes?.length ?? 0;
        showToast(translate('스케줄 "{0}" 즉시 실행 — 체크리스트 갱신 {1}개 프로파일에 디스패치', { 0: s.name, 1: n }), 'success');
      } else if (batch) {
        setActiveBatch(batch);
        showToast(translate('스케줄 "{0}" 즉시 실행 — {1}개 프로파일', { 0: s.name, 1: batch.total }), 'success');
      }
      await load();
    } catch (err: any) {
      showToast(err?.message || translate('Failed to run schedule'), 'error');
    }
  };

  const handleScheduleToggle = async (s: SecuritySchedule) => {
    try {
      await api.updateSecuritySchedule(s.id, { account_id: effectiveAccountId, enabled: !s.enabled });
      await load();
    } catch (err: any) {
      showToast(err?.message || translate('Failed to toggle schedule'), 'error');
    }
  };

  const handleScheduleDelete = async (s: SecuritySchedule) => {
    try {
      await api.deleteSecuritySchedule(s.id, effectiveAccountId);
      showToast(translate('스케줄 삭제됨'), 'success');
      setConfirmDeleteSchedule(null);
      await load();
    } catch (err: any) {
      showToast(err?.message || translate('Failed to delete schedule'), 'error');
    }
  };

  if (!effectiveAccountId) {
    return <div style={{ color: tokens.colors.textSecondary }}>{translate('Ownership defaults are unavailable.')}</div>;
  }

  // Editor + delete-confirm modals are rendered once so they are reachable from
  // BOTH the list view and the profile detail view.
  const modals = (
    <>
      {editing && (
        <ProfileEditor
          profile={editing === 'new' ? null : editing}
          accountId={editing === 'new' ? effectiveAccountId : editing.account_id || effectiveAccountId}
          agents={agents}

          onClose={() => setEditing(null)}
          onSaved={async (saved) => {
            setEditing(null);
            await load();
            setSelected((cur) => (cur && cur.id === saved.id ? saved : cur));
          }}
        />
      )}
      {confirmDelete && (
        <ConfirmDialog
          isOpen={true}
          title={translate('보안 프로파일 삭제')}
          message={translate('"{0}" 과(와) 모든 run 을 삭제할까요? 되돌릴 수 없습니다.', { 0: confirmDelete.name })}
          confirmLabel={translate('Delete')}
          onConfirm={() => handleDelete(confirmDelete)}
          onCancel={() => setConfirmDelete(null)}
        />
      )}
      {editingSchedule && (
        <ScheduleEditor
          schedule={editingSchedule === 'new' ? null : editingSchedule}
          accountId={editingSchedule === 'new' ? effectiveAccountId : editingSchedule.account_id || effectiveAccountId}
          profiles={profiles}
          onClose={() => setEditingSchedule(null)}
          onSaved={async () => { setEditingSchedule(null); await load(); }}
        />
      )}
      {confirmDeleteSchedule && (
        <ConfirmDialog
          isOpen={true}
          title={translate('스케줄 삭제')}
          message={translate('스케줄 "{0}" 을 삭제할까요? 이미 시작된 batch 는 영향받지 않습니다.', { 0: confirmDeleteSchedule.name })}
          confirmLabel={translate('Delete')}
          onConfirm={() => handleScheduleDelete(confirmDeleteSchedule)}
          onCancel={() => setConfirmDeleteSchedule(null)}
        />
      )}
    </>
  );

  if (selected) {
    return (
      <>
        <ProfileDetail
          profile={selected}
          accountId={selected.account_id || effectiveAccountId}
          agentName={agentName}
          onBack={() => { setSelected(null); load(); }}
          onRun={() => handleRun(selected)}
          running={running === selected.id}
          onEdit={() => setEditing(selected)}
        />
        {modals}
      </>
    );
  }

  const batchRunning = activeBatch?.status === 'running';

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: tokens.spacing.md, gap: 12, flexWrap: 'wrap' }}>
        <div style={{ color: tokens.colors.textSecondary, fontSize: 13 }}>
          {translate('보안 점검 — 체크리스트로 코드를 검사하고 severity 별 finding 을 누적, 증분(변경분) diff 로 재실행해 비교합니다.')}</div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {/* 순차 batch 실행: 한 번에 하나씩, 끝나야 다음. */}
          <Button
            variant="secondary"
            size="md"
            disabled={profiles.length === 0 || batchStarting || batchRunning}
            onClick={() => startBatch({ all: true })}
            title={translate('현재 scope 의 enabled 프로파일을 순차 실행')}
          >
            {translate('▶ 전체 순차 실행')}</Button>
          <Button
            variant="secondary"
            size="md"
            disabled={orderedSelected.length === 0 || batchStarting || batchRunning}
            onClick={() => startBatch({ profile_ids: orderedSelected.map((p) => p.id) })}
            title={translate('체크한 프로파일을 위→아래 순서대로 순차 실행')}
          >
            {translate('▶ 선택 순차 실행')}{orderedSelected.length ? ` (${orderedSelected.length})` : ''}
          </Button>
          <Button variant="primary" size="md" onClick={() => setEditing('new')}>{translate('+ 새 프로파일')}</Button>
        </div>
      </div>

      {activeBatch && (
        <BatchProgressBanner
          batch={activeBatch}
          profileName={(id) => profiles.find((p) => p.id === id)?.name ?? id.slice(0, 8)}
          onDismiss={() => setActiveBatch(null)}
        />
      )}

      {profiles.length === 0 ? (
        <Card padding="20px">
          <div style={{ color: tokens.colors.textSecondary }}>
            {translate('아직 보안 프로파일이 없습니다. "+ 새 프로파일" 로 체크리스트와 scan driver(code-review / dependency / secrets)를 가리키는 프로파일을 만드세요.')}</div>
        </Card>
      ) : (
        <ProfileTable
          profiles={profiles}
          agentName={agentName}
          running={running}
          refreshing={refreshing}
          selectedIds={selectedIds}
          onToggleSelect={toggleSelect}
          onOpen={(p) => setSelected(p)}
          onRun={handleRun}
          onRefreshChecklist={handleRefreshChecklist}
          onEdit={(p) => setEditing(p)}
          onDelete={(p) => setConfirmDelete(p)}
        />
      )}

      <SchedulesSection
        schedules={schedules}
        profiles={profiles}
        disabled={profiles.length === 0}
        onNew={() => setEditingSchedule('new')}
        onEdit={(s) => setEditingSchedule(s)}
        onToggle={handleScheduleToggle}
        onRunNow={handleScheduleRunNow}
        onDelete={(s) => setConfirmDeleteSchedule(s)}
      />

      {modals}
    </div>
  );
}

// ── Sequential batch progress banner ─────────────────────────────────────────

const BATCH_STATUS_VARIANT: Record<string, 'success' | 'danger' | 'info'> = {
  running: 'info',
  done: 'success',
  aborted: 'danger',
};

function BatchProgressBanner({ batch, profileName, onDismiss }: {
  batch: SecurityRunBatch;
  profileName: (id: string) => string;
  onDismiss: () => void;
}) {
  useLocale();
  const done = batch.status !== 'running';
  const position = done ? batch.total : Math.min(batch.current_index + 1, batch.total);
  const currentId = batch.profile_ids[batch.current_index];
  return (
    <Card padding="14px">
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8 }}>
        <Pill variant={BATCH_STATUS_VARIANT[batch.status] ?? 'neutral'}>{translate('batch')} {batch.status}</Pill>
        <span style={{ fontSize: 13, fontWeight: 600, color: tokens.colors.textPrimary, fontVariantNumeric: 'tabular-nums' }}>
          {position} / {batch.total}
        </span>
        {!done && currentId && (
          <span style={{ fontSize: 13, color: tokens.colors.textSecondary }}>
            {translate('현재:')} <strong style={{ color: tokens.colors.textPrimary }}>{profileName(currentId)}</strong>
          </span>
        )}
        <span style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
          <Pill variant="success">{translate('pass')} {batch.passed}</Pill>
          <Pill variant="danger">{translate('fail')} {batch.failed}</Pill>
          {batch.errored > 0 && <Pill variant="warning">{translate('err')} {batch.errored}</Pill>}
        </span>
        {done && (
          <button
            onClick={onDismiss}
            style={{ background: 'none', border: 'none', color: tokens.colors.textMuted, cursor: 'pointer', fontSize: 13, padding: '2px 6px' }}
            title={translate('배너 닫기')}
          >
            ✕
          </button>
        )}
      </div>
      <div style={{ height: 6, borderRadius: 3, background: tokens.colors.surfaceHover, overflow: 'hidden' }}>
        <div style={{
          width: `${batch.total ? Math.round((position / batch.total) * 100) : 0}%`,
          height: '100%',
          background: batch.status === 'aborted' ? tokens.colors.danger : tokens.colors.success,
          transition: 'width 0.4s ease',
        }} />
      </div>
      {!done && (
        <div style={{ fontSize: 11, color: tokens.colors.textMuted, marginTop: 6 }}>
          {translate('한 프로파일이 끝나야(passed/failed/error) 다음이 시작됩니다 — 동시에 뜨지 않습니다.')}</div>
      )}
    </Card>
  );
}

// ── Schedules (자동 트리거 레이어) ────────────────────────────────────────────

/** Human-readable cadence string for a schedule (cron expr or interval). */
function formatCadence(s: Pick<SecuritySchedule, 'cron' | 'interval_ms'>): string {
  if (s.cron) return `cron: ${s.cron} (UTC)`;
  if (s.interval_ms && s.interval_ms > 0) {
    const ms = s.interval_ms;
    if (ms % 3_600_000 === 0) return translate('매 {0}시간', { 0: ms / 3_600_000 });
    if (ms % 60_000 === 0) return translate('매 {0}분', { 0: ms / 60_000 });
    if (ms % 1_000 === 0) return translate('매 {0}초', { 0: ms / 1_000 });
    return translate('매 {0}ms', { 0: ms });
  }
  return '—';
}

interface SchedulesSectionProps {
  schedules: SecuritySchedule[];
  profiles: SecurityProfileListItem[];
  disabled: boolean;
  onNew: () => void;
  onEdit: (s: SecuritySchedule) => void;
  onToggle: (s: SecuritySchedule) => void;
  onRunNow: (s: SecuritySchedule) => void;
  onDelete: (s: SecuritySchedule) => void;
}

function SchedulesSection({ schedules, profiles, disabled, onNew, onEdit, onToggle, onRunNow, onDelete }: SchedulesSectionProps) {
  useLocale();
  return (
    <div style={{ marginTop: 28 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: tokens.spacing.md, gap: 12, flexWrap: 'wrap' }}>
        <div>
          <SectionLabel>{translate('스케줄 — 자동 순차 실행')}</SectionLabel>
          <div style={{ color: tokens.colors.textSecondary, fontSize: 12 }}>
            {translate('예약된 시각이 되면 순차 batch 를 자동으로 시작합니다 (전체 또는 선택 프로파일). 순차-batch 와 같은 오케스트레이터를 재사용 — 진행 상황은 위 배너에 표시됩니다.')}</div>
        </div>
        <Button variant="primary" size="md" disabled={disabled} onClick={onNew} title={disabled ? translate('먼저 프로파일을 만드세요') : undefined}>
          {translate('+ 새 스케줄')}</Button>
      </div>

      {schedules.length === 0 ? (
        <Card padding="16px">
          <div style={{ color: tokens.colors.textSecondary, fontSize: 13 }}>
            {translate('스케줄이 없습니다. "+ 새 스케줄" 로 cron/주기 기반 자동 실행을 추가하세요.')}</div>
        </Card>
      ) : (
        <div style={{ overflowX: 'auto', border: `1px solid ${tokens.colors.border}`, borderRadius: tokens.radii.md }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 760 }}>
            <thead>
              <tr>
                <th style={TH}>{translate('Name')}</th>
                <th style={TH}>{translate('Kind')}</th>
                <th style={TH}>{translate('Scope')}</th>
                <th style={TH}>{translate('Cadence')}</th>
                <th style={TH}>{translate('Enabled')}</th>
                <th style={TH}>{translate('Next run (UTC)')}</th>
                <th style={TH}>{translate('Last run')}</th>
                <th style={{ ...TH, textAlign: 'right' }}>{translate('Actions')}</th>
              </tr>
            </thead>
            <tbody>
              {schedules.map((s) => (
                <ScheduleRow
                  key={s.id}
                  s={s}
                  profileCount={profiles.length}
                  onEdit={() => onEdit(s)}
                  onToggle={() => onToggle(s)}
                  onRunNow={() => onRunNow(s)}
                  onDelete={() => onDelete(s)}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function ScheduleRow({ s, profileCount, onEdit, onToggle, onRunNow, onDelete }: {
  s: SecuritySchedule;
  profileCount: number;
  onEdit: () => void;
  onToggle: () => void;
  onRunNow: () => void;
  onDelete: () => void;
}) {
  useLocale();
  const [hover, setHover] = useState(false);
  const scopeLabel = s.scope === 'all' ? translate('전체 ({0})', { 0: profileCount }) : translate('선택 {0}', { 0: s.profile_ids.length });
  const nextUtc = s.next_run_at ? new Date(s.next_run_at).toISOString().replace('T', ' ').slice(0, 16) : '—';
  const isRefresh = s.kind === 'checklist_refresh';
  return (
    <tr
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{ background: hover ? tokens.colors.surfaceHover : 'transparent' }}
    >
      <td style={TD}>
        <span style={{ fontWeight: 600, color: tokens.colors.textPrimary }}>{s.name}</span>
      </td>
      <td style={TD}>
        <span title={isRefresh ? translate('체크리스트 갱신 (run 미생성)') : translate('보안 점검 batch')}>
          <Pill variant={isRefresh ? 'warning' : 'success'}>
            {isRefresh ? translate('checklist refresh') : translate('scan')}
          </Pill>
        </span>
      </td>
      <td style={TD}>
        <Pill variant={s.scope === 'all' ? 'info' : 'neutral'}>{scopeLabel}</Pill>
      </td>
      <td style={{ ...TD, color: tokens.colors.textSecondary, fontFamily: 'monospace', fontSize: 12 }}>{formatCadence(s)}</td>
      <td style={TD}>
        <label style={{ display: 'inline-flex', gap: 6, alignItems: 'center', cursor: 'pointer' }}>
          <input type="checkbox" checked={s.enabled} onChange={onToggle} title="enable/disable" />
          {!s.enabled && <Pill variant="warning">{translate('disabled')}</Pill>}
        </label>
      </td>
      <td style={{ ...TD, color: tokens.colors.textSecondary, whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}>
        {s.enabled ? nextUtc : <span style={{ color: tokens.colors.textMuted }}>—</span>}
      </td>
      <td style={{ ...TD, color: tokens.colors.textSecondary, whiteSpace: 'nowrap' }}>
        {s.last_run_at ? relativeTime(s.last_run_at) : <span style={{ color: tokens.colors.textMuted }}>{translate('never')}</span>}
      </td>
      <td style={{ ...TD, textAlign: 'right', whiteSpace: 'nowrap' }}>
        <div style={{ display: 'inline-flex', gap: 6 }}>
          <Button variant="primary" size="sm" onClick={onRunNow} title={translate('지금 즉시 실행 (enabled 무시, next_run_at 안 건드림)')}>{translate('▶ Run now')}</Button>
          <Button variant="ghost" size="sm" onClick={onEdit}>{translate('Edit')}</Button>
          <Button variant="danger" size="sm" onClick={onDelete}>{translate('Delete')}</Button>
        </div>
      </td>
    </tr>
  );
}

// ── Profile list table (status-dashboard view) ───────────────────────────────

interface ProfileTableProps {
  profiles: ProfileRow[];
  agentName: (id: string, spec?: any) => string;
  running: string | null;
  refreshing: string | null;
  selectedIds: Set<string>;
  onToggleSelect: (id: string) => void;
  onOpen: (p: ProfileRow) => void;
  onRun: (p: ProfileRow) => void;
  onRefreshChecklist: (p: ProfileRow) => void;
  onEdit: (p: ProfileRow) => void;
  onDelete: (p: ProfileRow) => void;
}

const TH: React.CSSProperties = {
  textAlign: 'left', padding: '8px 12px', fontSize: 11, fontWeight: 700,
  textTransform: 'uppercase', letterSpacing: 0.5, color: tokens.colors.textMuted,
  borderBottom: `1px solid ${tokens.colors.border}`, whiteSpace: 'nowrap',
};
const TD: React.CSSProperties = {
  padding: '10px 12px', fontSize: 13, color: tokens.colors.textPrimary,
  borderBottom: `1px solid ${tokens.colors.border}`, verticalAlign: 'middle',
};

function ProfileTable({ profiles, agentName, running, refreshing, selectedIds, onToggleSelect, onOpen, onRun, onRefreshChecklist, onEdit, onDelete }: ProfileTableProps) {
  useLocale();
  const allSelected = profiles.length > 0 && profiles.every((p) => selectedIds.has(p.id));
  const toggleAll = () => {
    const target = !allSelected;
    profiles.forEach((p) => {
      if (selectedIds.has(p.id) !== target) onToggleSelect(p.id);
    });
  };
  return (
    <div style={{ overflowX: 'auto', border: `1px solid ${tokens.colors.border}`, borderRadius: tokens.radii.md }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 920 }}>
        <thead>
          <tr>
            <th style={{ ...TH, width: 36, textAlign: 'center' }}>
              <input type="checkbox" checked={allSelected} onChange={toggleAll} title={translate('전체 선택/해제')} />
            </th>
            <th style={TH}>{translate('Name')}</th>
            <th style={TH}>{translate('Driver')}</th>
            <th style={TH}>{translate('Target')}</th>
            <th style={TH}>{translate('Scope')}</th>
            <th style={TH}>{translate('Last run')}</th>
            <th style={TH}>{translate('Result')}</th>
            <th style={TH}>{translate('Worst')}</th>
            <th style={{ ...TH, textAlign: 'right' }}>{translate('Pass')}</th>
            <th style={{ ...TH, textAlign: 'right' }}>{translate('Actions')}</th>
          </tr>
        </thead>
        <tbody>
          {profiles.map((p) => (
            <ProfileRowView
              key={p.id}
              p={p}
              agentName={agentName}
              running={running === p.id}
              refreshing={refreshing === p.id}
              selected={selectedIds.has(p.id)}
              onToggleSelect={() => onToggleSelect(p.id)}
              onOpen={() => onOpen(p)}
              onRun={() => onRun(p)}
              onRefreshChecklist={() => onRefreshChecklist(p)}
              onEdit={() => onEdit(p)}
              onDelete={() => onDelete(p)}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

interface ProfileRowProps {
  p: ProfileRow;
  agentName: (id: string, spec?: any) => string;
  running: boolean;
  refreshing: boolean;
  selected: boolean;
  onToggleSelect: () => void;
  onOpen: () => void;
  onRun: () => void;
  onRefreshChecklist: () => void;
  onEdit: () => void;
  onDelete: () => void;
}

function ProfileRowView({ p, agentName, running, refreshing, selected, onToggleSelect, onOpen, onRun, onRefreshChecklist, onEdit, onDelete }: ProfileRowProps) {
  useLocale();
  const [hover, setHover] = useState(false);
  const stop = (fn: () => void) => (e: React.MouseEvent) => { e.stopPropagation(); fn(); };

  return (
    <tr
      onClick={onOpen}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{ cursor: 'pointer', background: hover ? tokens.colors.surfaceHover : 'transparent' }}
    >
      <td style={{ ...TD, textAlign: 'center' }} onClick={(e) => e.stopPropagation()}>
        <input type="checkbox" checked={selected} onChange={onToggleSelect} title={translate('순차 실행에 포함')} />
      </td>
      <td style={TD}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontWeight: 600, color: tokens.colors.textPrimary }}>{p.name}</span>
          {!p.enabled && <Pill variant="warning">{translate('disabled')}</Pill>}
        </div>
        <div style={{ fontSize: 11, color: tokens.colors.textMuted, marginTop: 2 }}>{agentName(p.target_agent_id, (p as any).target_runtime)}</div>
      </td>
      <td style={TD}>
        {p.scan_driver ? <Pill variant="info">{p.scan_driver}</Pill> : <span style={{ color: tokens.colors.textMuted }}>—</span>}
      </td>
      <td style={TD}><TargetBadge resourceId={p.target_resource_id} /></td>
      <td style={{ ...TD, color: tokens.colors.textSecondary, whiteSpace: 'nowrap' }}>
        <span style={{ fontFamily: 'monospace', fontSize: 12 }}>{p.scope_mode}</span>
      </td>
      <td style={{ ...TD, color: tokens.colors.textSecondary, whiteSpace: 'nowrap' }}>
        {p.last_run_at ? relativeTime(p.last_run_at) : <span style={{ color: tokens.colors.textMuted }}>{translate('never run')}</span>}
      </td>
      <td style={TD}>
        {p.last_run_status
          ? <Pill variant={statusVariant(p.last_run_status)}>{p.last_run_status}</Pill>
          : <span style={{ color: tokens.colors.textMuted }}>—</span>}
      </td>
      <td style={TD}>
        {p.highest_severity
          ? <SeverityBadge severity={p.highest_severity} />
          : <span style={{ color: tokens.colors.textMuted }}>—</span>}
      </td>
      <td style={{ ...TD, textAlign: 'right', whiteSpace: 'nowrap' }}>
        {p.pass_rate !== null
          ? <span title={translate('{0} run{1}', { 0: p.run_count, 1: p.run_count === 1 ? '' : translate('s') })} style={{ color: p.pass_rate === 100 ? tokens.colors.success : tokens.colors.textSecondary, fontVariantNumeric: 'tabular-nums' }}>{p.pass_rate}%</span>
          : <span style={{ color: tokens.colors.textMuted }}>—</span>}
      </td>
      <td style={{ ...TD, textAlign: 'right', whiteSpace: 'nowrap' }}>
        <div style={{ display: 'inline-flex', gap: 6 }} onClick={(e) => e.stopPropagation()}>
          <Button variant="primary" size="sm" onClick={stop(onRun)} disabled={running}>
            {running ? translate('Starting…') : translate('▶ Run')}
          </Button>
          <Button variant="ghost" size="sm" onClick={stop(onRefreshChecklist)} disabled={refreshing} title={translate('체크리스트를 최신 보안 정보로 갱신 (WebSearch)')}>
            {refreshing ? '…' : translate('↻ Checklist')}
          </Button>
          <Button variant="ghost" size="sm" onClick={stop(onEdit)}>{translate('Edit')}</Button>
          <Button variant="danger" size="sm" onClick={stop(onDelete)}>{translate('Delete')}</Button>
        </div>
      </td>
    </tr>
  );
}

// ── Profile detail: checklist + run history + run detail ─────────────────────

interface ProfileDetailProps {
  profile: SecurityProfile;
  accountId: string;
  agentName: (id: string, spec?: any) => string;
  onBack: () => void;
  onRun: () => void;
  running: boolean;
  onEdit: () => void;
}

function ProfileDetail({ profile, accountId, agentName, onBack, onRun, running, onEdit }: ProfileDetailProps) {
  useLocale();
  const { showToast } = useToast();
  const [runs, setRuns] = useState<SecurityRun[]>([]);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [lightbox, setLightbox] = useState<{ src: string; kind: 'image' | 'video' } | null>(null);

  const loadRuns = useCallback(async () => {
    try {
      const list = await api.listSecurityRuns(profile.id, accountId, 30);
      setRuns(list);
      setActiveRunId((cur) => cur ?? (list[0]?.id ?? null));
    } catch (err: any) {
      showToast(err?.message || translate('Failed to load runs'), 'error');
    }
  }, [profile.id, accountId, showToast]);

  useEffect(() => { loadRuns(); }, [loadRuns]);

  // Live refresh while a run is still in flight.
  const anyRunActive = running || runs.some((r) => r.status === 'running' || r.status === 'pending');
  useEffect(() => {
    if (!anyRunActive) return;
    const t = setInterval(() => { loadRuns(); }, 2500);
    return () => clearInterval(t);
  }, [anyRunActive, loadRuns]);

  const activeRun = runs.find((r) => r.id === activeRunId) || null;
  const checklist = profile.checklist ?? [];

  const passRate = (() => {
    const finished = runs.filter((r) => r.status === 'passed' || r.status === 'failed' || r.status === 'error');
    if (!finished.length) return null;
    const passed = finished.filter((r) => r.status === 'passed').length;
    return Math.round((passed / finished.length) * 100);
  })();

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
        <Button variant="ghost" size="sm" onClick={onBack}>{translate('← Back')}</Button>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 18, fontWeight: 600, color: tokens.colors.textPrimary }}>{profile.name}</div>
          <div style={{ display: 'flex', gap: 6, marginTop: 4, flexWrap: 'wrap', alignItems: 'center' }}>
            {profile.scan_driver && <Pill variant="info">{profile.scan_driver}</Pill>}
            <TargetBadge resourceId={profile.target_resource_id} />
            <Pill variant="neutral">{translate('scope:')} {profile.scope_mode}</Pill>
            <Pill variant="neutral">{translate('agent:')} {agentName(profile.target_agent_id, (profile as any).target_runtime)}</Pill>
            {passRate !== null && <Pill variant={passRate === 100 ? 'success' : 'warning'}>{passRate}{translate('% pass')}</Pill>}
            {profile.last_passed_commit && (
              <span style={{ fontSize: 11, color: tokens.colors.textMuted, fontFamily: 'monospace' }}>
                {translate('baseline')} {profile.last_passed_commit.slice(0, 10)}
              </span>
            )}
          </div>
        </div>
        <Button variant="ghost" size="sm" onClick={onEdit}>{translate('Edit')}</Button>
        <Button variant="primary" size="md" onClick={() => { onRun(); setTimeout(loadRuns, 800); }} disabled={running}>
          {running ? translate('Starting…') : translate('▶ Run / Re-run')}
        </Button>
      </div>

      {profile.description && (
        <div style={{ fontSize: 13, color: tokens.colors.textSecondary, marginBottom: 16, whiteSpace: 'pre-wrap' }}>{profile.description}</div>
      )}

      {/* Checklist */}
      <div style={{ marginBottom: 24 }}>
        <SectionLabel>{translate('체크리스트 (')}{checklist.length})</SectionLabel>
        {checklist.length === 0 ? (
          <div style={{ color: tokens.colors.textSecondary, fontSize: 13 }}>{translate('체크리스트 항목이 없습니다. Edit 에서 추가하거나 "↻ Checklist" 로 갱신하세요.')}</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {checklist.map((item) => <ChecklistItemRow key={item.id} item={item} />)}
          </div>
        )}
      </div>

      {/* Run history + detail */}
      <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start' }}>
        <div style={{ width: 230, flexShrink: 0 }}>
          <SectionLabel>{translate('Run history')}</SectionLabel>
          {runs.length === 0 && <div style={{ color: tokens.colors.textSecondary, fontSize: 13 }}>{translate('No runs yet.')}</div>}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {runs.map((r) => {
              const worst = highestSeverity(r.findings);
              return (
                <button
                  key={r.id}
                  onClick={() => setActiveRunId(r.id)}
                  style={{
                    display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8,
                    padding: '8px 10px', borderRadius: tokens.radii.sm, cursor: 'pointer', textAlign: 'left',
                    background: r.id === activeRunId ? tokens.colors.surfaceHover : tokens.colors.surfaceCard,
                    border: `1px solid ${r.id === activeRunId ? tokens.colors.borderStrong : tokens.colors.border}`,
                    color: tokens.colors.textPrimary,
                  }}
                >
                  <span style={{ fontSize: 12 }}>{relativeTime(r.created_at)}</span>
                  <span style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}>
                    {worst && <SeverityBadge severity={worst} />}
                    <Pill variant={statusVariant(r.status)}>{r.status}</Pill>
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        <div style={{ flex: 1, minWidth: 0 }}>
          <SectionLabel>{translate('Run detail')}</SectionLabel>
          {!activeRun ? (
            <div style={{ color: tokens.colors.textSecondary, fontSize: 13 }}>{translate('Select a run.')}</div>
          ) : (
            <RunDetail run={activeRun} onPreview={(src, kind) => setLightbox({ src, kind })} />
          )}
        </div>
      </div>

      {lightbox && <Lightbox {...lightbox} onClose={() => setLightbox(null)} />}
    </div>
  );
}

function ChecklistItemRow({ item }: { item: SecurityChecklistItem }) {
  useLocale();
  return (
    <div style={{ border: `1px solid ${tokens.colors.border}`, borderRadius: tokens.radii.sm, padding: 10, background: tokens.colors.surfaceCard }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        {item.severity_hint && <SeverityBadge severity={item.severity_hint} />}
        <span style={{ fontSize: 13, fontWeight: 600, color: tokens.colors.textPrimary }}>{item.title}</span>
        {item.category && <Pill variant="neutral">{item.category}</Pill>}
        {item.source && <SourceLink source={item.source} />}
        {item.added_at && (
          <span style={{ marginLeft: 'auto', fontSize: 11, color: tokens.colors.textMuted }} title={item.added_at}>
            {translate('added')} {relativeTime(item.added_at)}
          </span>
        )}
      </div>
      {item.guidance && (
        <div style={{ fontSize: 12, color: tokens.colors.textSecondary, marginTop: 6 }}>{item.guidance}</div>
      )}
    </div>
  );
}

/** A checklist item's source: a full URL renders as a link, a bare id as text. */
function SourceLink({ source }: { source: string }) {
  useLocale();
  const isUrl = /^https?:\/\//i.test(source);
  if (isUrl) {
    return (
      <a href={source} target="_blank" rel="noopener noreferrer"
        style={{ fontSize: 11, color: tokens.colors.info, textDecoration: 'none', fontFamily: 'monospace' }}
        title={source}
      >
        {translate('🔗 source')}</a>
    );
  }
  return <span style={{ fontSize: 11, color: tokens.colors.textMuted, fontFamily: 'monospace' }} title={translate('source')}>{source}</span>;
}

function RunDetail({ run, onPreview }: { run: SecurityRun; onPreview: (src: string, kind: 'image' | 'video') => void }) {
  useLocale();
  const findings = run.findings ?? [];
  const artifacts = run.artifact_resource_ids ?? [];
  // Group findings by severity, ordered critical → info.
  const grouped = SEVERITY_ORDER.map((sev) => ({ sev, items: findings.filter((f) => f.severity === sev) }))
    .filter((g) => g.items.length > 0);
  const ticketRef = run.auto_ticket_id
    ? { id: run.auto_ticket_id, account_id: run.account_id }
    : null;

  return (
    <div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8, flexWrap: 'wrap' }}>
        <Pill variant={statusVariant(run.status)}>{run.status}</Pill>
        <Pill variant="neutral">{translate('scope:')} {run.scope_used}</Pill>
        <span style={{ fontSize: 12, color: tokens.colors.textMuted }}>
          {findings.length} {translate('finding')}{findings.length === 1 ? '' : translate('s')} · {artifacts.length} {translate('artifact')}{artifacts.length === 1 ? '' : translate('s')}
        </span>
        {ticketRef && (
          canOpenTicket(ticketRef) ? (
            <a
              href={ticketPath(ticketRef.account_id, ticketRef.id)}
              style={{ fontSize: 12, fontWeight: 600, color: tokens.colors.danger, textDecoration: 'none', border: `1px solid ${tokens.colors.danger}`, borderRadius: tokens.radii.sm, padding: '2px 8px' }}
              title={translate('이 실패 run 이 자동 생성한 수정 티켓으로 이동')}
            >
              {translate('→ 티켓 #')}{ticketRef.id.slice(0, 8)}
            </a>
          ) : (
            <span
              style={{ fontSize: 12, fontWeight: 600, color: tokens.colors.textMuted, border: `1px solid ${tokens.colors.border}`, borderRadius: tokens.radii.sm, padding: '2px 8px' }}
              title={translate('티켓 정보를 확인할 수 없습니다')}
            >
              {translate('티켓 #')}{ticketRef.id.slice(0, 8)}
            </span>
          )
        )}
      </div>

      {/* Commit / scope bookkeeping */}
      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', fontSize: 11, color: tokens.colors.textMuted, fontFamily: 'monospace', marginBottom: 12 }}>
        <span>{translate('scanned:')} {run.scanned_commit ? run.scanned_commit.slice(0, 12) : '—'}</span>
        <span>{translate('baseline:')} {run.baseline_commit ? run.baseline_commit.slice(0, 12) : translate('— (full)')}</span>
      </div>

      {run.summary && (
        <div style={{ fontSize: 13, color: tokens.colors.textSecondary, marginBottom: 12, whiteSpace: 'pre-wrap' }}>{run.summary}</div>
      )}

      {/* Findings grouped by severity */}
      {findings.length === 0 ? (
        <div style={{ fontSize: 13, color: tokens.colors.textSecondary, marginBottom: 12 }}>
          {run.status === 'passed' ? translate('✅ finding 없음 — 통과.') : translate('finding 이 기록되지 않았습니다.')}
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {grouped.map(({ sev, items }) => (
            <div key={sev}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                <SeverityBadge severity={sev} size="md" />
                <span style={{ fontSize: 12, color: tokens.colors.textMuted, fontWeight: 600 }}>{items.length}</span>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {items.map((f) => <FindingCard key={f.id} f={f} />)}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Evidence gallery (run-level artifacts: reports / SBOM / screenshots) */}
      {artifacts.length > 0 && (
        <div style={{ marginTop: 16 }}>
          <SectionLabel>{translate('증거 (artifacts)')}</SectionLabel>
          <Gallery ids={artifacts} onPreview={onPreview} />
        </div>
      )}
    </div>
  );
}

function FindingCard({ f }: { f: SecurityFinding }) {
  useLocale();
  const c = SEVERITY_COLOR[f.severity];
  return (
    <div style={{ border: `1px solid ${tokens.colors.border}`, borderLeft: `3px solid ${c.border}`, borderRadius: tokens.radii.sm, padding: 10, background: tokens.colors.surfaceCard }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <SeverityBadge severity={f.severity} />
        <span style={{ fontSize: 13, fontWeight: 600, color: tokens.colors.textPrimary }}>{f.title}</span>
        {f.category && <Pill variant="neutral">{f.category}</Pill>}
      </div>
      {(f.file || typeof f.line === 'number') && (
        <div style={{ fontSize: 12, color: tokens.colors.info, marginTop: 6, fontFamily: 'monospace' }}>
          {f.file ?? '?'}{typeof f.line === 'number' ? `:${f.line}` : ''}
        </div>
      )}
      {f.evidence && (
        <pre style={{ fontSize: 12, color: tokens.colors.textSecondary, marginTop: 6, whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontFamily: 'monospace', background: tokens.colors.surface, padding: 8, borderRadius: tokens.radii.sm, overflowX: 'auto' }}>{f.evidence}</pre>
      )}
      {f.remediation && (
        <div style={{ fontSize: 12, color: tokens.colors.textSecondary, marginTop: 6 }}>
          <span style={{ color: tokens.colors.success, fontWeight: 600 }}>{translate('remediation:')} </span>{f.remediation}
        </div>
      )}
      {f.checklist_item_id && (
        <div style={{ fontSize: 11, color: tokens.colors.textMuted, marginTop: 4, fontFamily: 'monospace' }}>{translate('↳ checklist:')} {f.checklist_item_id}</div>
      )}
    </div>
  );
}

function Gallery({ ids, onPreview }: { ids: string[]; onPreview: (src: string, kind: 'image' | 'video') => void }) {
  useLocale();
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  const [kinds, setKinds] = useState<Record<string, 'image' | 'video'>>({});
  const srcs = ids.map((id) => rawResourceUrl(id));
  const items = srcs.map((src) => ({
    src,
    kind: kinds[src] || ('image' as const),
    caption: src,
  }));
  return (
    <>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {ids.map((id) => {
          const src = rawResourceUrl(id);
          return (
            <MediaThumb
              key={id}
              src={src}
              onClick={(kind) => {
                setKinds((prev) => (prev[src] ? prev : { ...prev, [src]: kind }));
                const idx = srcs.indexOf(src);
                if (idx >= 0) setLightboxIndex(idx);
                else onPreview(src, kind);
              }}
            />
          );
        })}
      </div>
      {lightboxIndex !== null && items[lightboxIndex] && (
        <MediaLightbox
          items={items}
          index={lightboxIndex}
          onIndexChange={(next) => setLightboxIndex(next)}
          onClose={() => setLightboxIndex(null)}
        />
      )}
    </>
  );
}

function MediaThumb({ src, onClick }: { src: string; onClick: (kind: 'image' | 'video') => void }) {
  useLocale();
  // Resolve the real mimetype before choosing the element. The previous version
  // always rendered an <img> and relied on its onError to swap to <video> — but
  // a video/* resource streams back HTTP 200, so the <img> just shows a broken
  // frame and never fires onError, leaving security video evidence completely
  // invisible. A tiny ranged GET (bytes=0-0) of the streaming endpoint gives us
  // the authoritative Content-Type while transferring a single byte (src already
  // carries the ?token the /raw route requires).
  const [kind, setKind] = useState<'image' | 'video' | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetch(src, { headers: { Range: 'bytes=0-0' } })
      .then((res) => (res.headers.get('content-type') || '').toLowerCase())
      .then((ct) => { if (!cancelled) setKind(ct.startsWith('video/') ? 'video' : 'image'); })
      .catch(() => { if (!cancelled) setKind('image'); });
    return () => { cancelled = true; };
  }, [src]);
  if (kind === 'video') {
    return (
      <div onClick={() => onClick('video')} style={{ width: 120, height: 76, borderRadius: tokens.radii.sm, overflow: 'hidden', position: 'relative', background: '#000', cursor: 'pointer', border: `1px solid ${tokens.colors.border}` }}>
        <video src={src} muted playsInline preload="metadata" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
        <span style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'rgba(255,255,255,0.85)', fontSize: 22 }}>▶</span>
      </div>
    );
  }
  // image (or not-yet-resolved): keep the onError→video fallback as a safety net
  // in case the Content-Type probe fails or is stripped by a proxy.
  return (
    <img
      src={src}
      onClick={() => onClick('image')}
      onError={() => setKind('video')}
      alt={translate('artifact')}
      style={{ width: 76, height: 76, objectFit: 'cover', borderRadius: tokens.radii.sm, cursor: 'pointer', border: `1px solid ${tokens.colors.border}` }}
    />
  );
}

function Lightbox({ src, kind, onClose }: { src: string; kind: 'image' | 'video'; onClose: () => void }) {
  useLocale();
  return (
    <MediaLightbox
      items={[{ src, kind, caption: src }]}
      index={0}
      onIndexChange={() => {}}
      onClose={onClose}
    />
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  useLocale();
  return <div style={{ fontSize: 12, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.5, color: tokens.colors.textMuted, marginBottom: 8 }}>{children}</div>;
}

// ── Create / edit profile modal ──────────────────────────────────────────────

interface ProfileEditorProps {
  profile: SecurityProfile | null;
  accountId: string;
  agents: SecAgent[];
  /** P4b: runtime 선언 → 매칭용 full 행. */

  onClose: () => void;
  onSaved: (p: SecurityProfile) => void;
}

function ProfileEditor({ profile, accountId, agents, onClose, onSaved }: ProfileEditorProps) {
  useLocale();
  const { showToast } = useToast();
  const [name, setName] = useState(profile?.name ?? '');
  const [description, setDescription] = useState(profile?.description ?? '');
  // P4c-3b: spec-direct target (QA와 동일).
  const [pendingSpec, setPendingSpec] = useState<Record<string, any> | null>((profile as any)?.target_runtime ?? null);
  // Which repo to inspect: '' = AWB itself (self), else a Project id (projects
  // keep the ids of the old repository Resources, so the field name stays).
  const [targetResourceId, setTargetResourceId] = useState(profile?.target_resource_id ?? '');
  const { projects, loading: projectsLoading } = useProjects(accountId);
  const [scanDriver, setScanDriver] = useState(profile?.scan_driver ?? 'code-review');
  const [scopeMode, setScopeMode] = useState<SecurityScopeMode>(profile?.scope_mode ?? 'incremental');
  const [enabled, setEnabled] = useState(profile?.enabled ?? true);
  const [checklistText, setChecklistText] = useState(JSON.stringify(profile?.checklist ?? [], null, 2));
  const [configText, setConfigText] = useState(JSON.stringify(profile?.scan_driver_config ?? {}, null, 2));
  const [tagsText, setTagsText] = useState((profile?.tags ?? []).join(', '));
  const [maxRuns, setMaxRuns] = useState(String(profile?.max_runs ?? 20));
  const [saving, setSaving] = useState(false);

  // 작업폴더 옵션 (workspace_folder / repo_ref / checkout_mode / build_mode).
  const [wf, setWf] = useState<WorkspaceFolderFormState>(initWorkspaceFolderState(profile));
  const patchWf = (patch: Partial<WorkspaceFolderFormState>) => setWf((prev) => ({ ...prev, ...patch }));

  // On-failure auto-ticket policy (실패 시 → 티켓 생성), severity-gated.
  // The ticket joins the account ticket pool (status / tags / project).
  const oft = profile?.on_failure_ticket ?? null;
  const [oftForm, setOftForm] = useState<OnFailureTicketForm>(() => onFailureTicketToForm(oft));
  const patchOft = (patch: Partial<OnFailureTicketForm>) => setOftForm((prev) => ({ ...prev, ...patch }));
  const [oftMinSeverity, setOftMinSeverity] = useState<SecuritySeverity>(oft?.min_severity ?? 'high');

  const handleSave = async () => {
    if (!name.trim()) { showToast(translate('이름을 입력하세요'), 'error'); return; }
    if (!pendingSpec) { showToast(translate('Target agent 를 선택하세요'), 'error'); return; }
    let checklist: any; let config: any;
    try { checklist = checklistText.trim() ? JSON.parse(checklistText) : []; } catch { showToast(translate('체크리스트는 유효한 JSON 배열이어야 합니다'), 'error'); return; }
    if (!Array.isArray(checklist)) { showToast(translate('체크리스트는 JSON 배열이어야 합니다'), 'error'); return; }
    try { config = configText.trim() ? JSON.parse(configText) : {}; } catch { showToast(translate('Driver config 는 유효한 JSON 이어야 합니다'), 'error'); return; }
    const tags = tagsText.split(',').map((t) => t.trim()).filter(Boolean);
    // Disabled → explicit { enabled:false } so an existing policy is turned off.
    const baseOft = onFailureTicketFromForm(oftForm, oft);
    const onFailureTicket = (oftForm.enabled
      ? { ...baseOft, min_severity: oftMinSeverity }
      : baseOft) as SecurityOnFailureTicketConfig;
    const maxRunsNum = Math.max(1, parseInt(maxRuns, 10) || 20);
    setSaving(true);
    try {
      let saved: SecurityProfile;
      // P4c-3b: pendingSpec이 있으면 spec-direct 저장.
      const targetPayload = { target_runtime: pendingSpec };
      const common = {
        name, description, ...targetPayload,
        target_resource_id: targetResourceId.trim() || null,
        scan_driver: scanDriver, scan_driver_config: config, scope_mode: scopeMode,
        checklist, tags, enabled, on_failure_ticket: onFailureTicket, max_runs: maxRunsNum,
        ...buildWorkspaceFolderPayload(wf),
      };
      if (profile) {
        saved = await api.updateSecurityProfile(profile.id, { account_id: accountId, ...common });
      } else {
        saved = await api.createSecurityProfile({ account_id: accountId, ...common });
      }
      showToast(translate('프로파일 {0}됨', { 0: profile ? translate('수정') : translate('생성') }), 'success');
      onSaved(saved);
    } catch (err: any) {
      showToast(err?.message || translate('Failed to save profile'), 'error');
    } finally {
      setSaving(false);
    }
  };

  const fieldLabel: React.CSSProperties = { fontSize: 12, fontWeight: 600, color: tokens.colors.textSecondary, marginBottom: 4, display: 'block' };
  const textareaStyle: React.CSSProperties = {
    width: '100%', minHeight: 120, fontFamily: 'monospace', fontSize: 12, padding: 8,
    background: tokens.colors.surface, color: tokens.colors.textPrimary,
    border: `1px solid ${tokens.colors.border}`, borderRadius: tokens.radii.sm, resize: 'vertical',
  };

  return (
    <Modal
      isOpen={true}
      onClose={onClose}
      title={profile ? translate('보안 프로파일 수정') : translate('새 보안 프로파일')}
      maxWidth={640}
      footer={
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <Button variant="ghost" onClick={onClose}>{translate('Cancel')}</Button>
          <Button variant="primary" onClick={handleSave} disabled={saving}>{saving ? translate('Saving…') : translate('Save')}</Button>
        </div>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <Input label={translate('Name')} value={name} onChange={(e) => setName((e.target as HTMLInputElement).value)} />
        <Input label={translate('Description')} value={description} onChange={(e) => setDescription((e.target as HTMLInputElement).value)} />
        <DeclareRuntimeSection
          initialValue={pendingSpec}
          accountId={accountId}

          onResolved={(spec) => {
            setPendingSpec(spec);
            showToast(
              translate('실행 설정을 적용했습니다'),
              'success',
            );
          }}
        />
        <Select
          label={translate('점검 대상 (Target)')}
          value={targetResourceId}
          options={projectSelectOptions(
            projects,
            targetResourceId,
            projectsLoading ? translate('AWB 자체 코드베이스 (self) — 프로젝트 불러오는 중…') : translate('AWB 자체 코드베이스 (self)'),
          )}
          onChange={(e) => setTargetResourceId((e.target as HTMLSelectElement).value)}
        />
        <div style={{ display: 'flex', gap: 10 }}>
          <div style={{ flex: 1 }}>
            <Input label={translate('Scan driver (code-review / dependency / secrets)')} value={scanDriver} onChange={(e) => setScanDriver((e.target as HTMLInputElement).value)} />
          </div>
          <div style={{ flex: 1 }}>
            <Select
              label={translate('Scope mode')}
              value={scopeMode}
              options={[
                { value: 'incremental', label: translate('incremental (변경분 diff)') },
                { value: 'full', label: translate('full (전체)') },
              ]}
              onChange={(e) => setScopeMode((e.target as HTMLSelectElement).value as SecurityScopeMode)}
            />
          </div>
        </div>
        <div>
          <label style={fieldLabel}>{translate('체크리스트 (JSON 배열 —')} {translate('{ id, title, category?, severity_hint?, guidance?, source? }')})</label>
          <textarea style={textareaStyle} value={checklistText} onChange={(e) => setChecklistText(e.target.value)} />
        </div>
        <div>
          <label style={fieldLabel}>{translate('Driver config (JSON)')}</label>
          <textarea style={{ ...textareaStyle, minHeight: 80 }} value={configText} onChange={(e) => setConfigText(e.target.value)} />
        </div>
        <div style={{ display: 'flex', gap: 10 }}>
          <div style={{ flex: 2 }}>
            <Input label={translate('Tags (comma separated)')} value={tagsText} onChange={(e) => setTagsText((e.target as HTMLInputElement).value)} />
          </div>
          <div style={{ flex: 1 }}>
            <Input label={translate('Max runs (FIFO)')} type="number" value={maxRuns} onChange={(e) => setMaxRuns((e.target as HTMLInputElement).value)} />
          </div>
        </div>
        <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13, color: tokens.colors.textSecondary }}>
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /> {translate('Enabled')}</label>

        {/* 작업폴더 옵션 (workspace_folder / repo_ref / checkout_mode / build_mode) */}
        <WorkspaceFolderOptions kind="security" state={wf} onChange={patchWf} accountId={accountId} />

        {/* 실패 시 → 티켓 생성 (severity-gated on-failure auto-ticket) */}
        <div style={{ borderTop: `1px solid ${tokens.colors.border}`, paddingTop: 12, marginTop: 4 }}>
          <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13, fontWeight: 600, color: tokens.colors.textPrimary }}>
            <input type="checkbox" checked={oftForm.enabled} onChange={(e) => patchOft({ enabled: e.target.checked })} />
            {translate('실패 시 → 수정 티켓 자동 생성 (severity gate)')}</label>
          <div style={{ fontSize: 12, color: tokens.colors.textMuted, margin: '4px 0 0 24px' }}>
            {translate('run 이 failed/error 로 끝나고')} <b>{translate('min_severity 이상')}</b>{translate('의 finding 이 있으면 수정 티켓을 자동 생성합니다. 그 미만이면 run 요약만 남기고 티켓은 만들지 않습니다.')}</div>
          {oftForm.enabled && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 10, paddingLeft: 24 }}>
              <Select
                label={translate('최소 severity (gate)')}
                value={oftMinSeverity}
                options={SEVERITY_ORDER.map((s) => ({ value: s, label: s }))}
                onChange={(e) => setOftMinSeverity((e.target as HTMLSelectElement).value as SecuritySeverity)}
              />
              <OnFailureTicketTargetFields
                accountId={accountId}
                form={oftForm}
                onChange={patchOft}
                defaultTagsHint={translate('비우면 서버 기본 태그로 생성됩니다.')}
              />
              <div style={{ fontSize: 12 }}>{translate('수정 티켓 실행 설정 (비우면 타깃 설정 → 프로젝트 기본 담당자)')}</div>
              <DeclareRuntimeSection accountId={accountId} initialValue={oftForm.assigneeRuntime} onResolved={(spec) => patchOft({ assigneeRuntime: spec })} />
              {oftForm.assigneeRuntime && <div style={{ fontSize: 12 }}>{oftForm.assigneeRuntime.label || oftForm.assigneeRuntime.cli} <button type="button" onClick={() => patchOft({ assigneeRuntime: null })}>{translate('초기화')}</button></div>}
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}

// ── Schedule create / edit modal ─────────────────────────────────────────────

interface ScheduleEditorProps {
  schedule: SecuritySchedule | null;
  accountId: string;
  profiles: SecurityProfileListItem[];
  onClose: () => void;
  onSaved: () => void;
}

function ScheduleEditor({ schedule, accountId, profiles, onClose, onSaved }: ScheduleEditorProps) {
  useLocale();
  const { showToast } = useToast();
  const [name, setName] = useState(schedule?.name ?? '');
  const [kind, setKind] = useState<SecurityScheduleKind>(schedule?.kind ?? 'scan');
  const [scope, setScope] = useState<SecurityScheduleScope>(schedule?.scope ?? 'all');
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set(schedule?.profile_ids ?? []));
  const [cadenceKind, setCadenceKind] = useState<'interval' | 'cron'>(schedule?.cron ? 'cron' : 'interval');
  const [cron, setCron] = useState(schedule?.cron ?? '0 3 * * *');
  const initInterval = (() => {
    const ms = schedule?.interval_ms ?? 3_600_000;
    if (ms % 3_600_000 === 0) return { value: String(ms / 3_600_000), unit: 'hours' as const };
    if (ms % 60_000 === 0) return { value: String(ms / 60_000), unit: 'minutes' as const };
    return { value: String(Math.max(1, Math.round(ms / 1_000))), unit: 'seconds' as const };
  })();
  const [intervalValue, setIntervalValue] = useState(initInterval.value);
  const [intervalUnit, setIntervalUnit] = useState<'seconds' | 'minutes' | 'hours'>(initInterval.unit);
  const [enabled, setEnabled] = useState(schedule?.enabled ?? true);
  const [stopOnFail, setStopOnFail] = useState(schedule?.stop_on_fail ?? false);
  const [saving, setSaving] = useState(false);

  const toggleProfile = (id: string) => {
    setSelectedIds((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const intervalMs = (() => {
    const n = parseInt(intervalValue, 10);
    if (!Number.isFinite(n) || n <= 0) return NaN;
    const factor = intervalUnit === 'hours' ? 3_600_000 : intervalUnit === 'minutes' ? 60_000 : 1_000;
    return n * factor;
  })();

  const handleSave = async () => {
    if (!name.trim()) { showToast(translate('이름을 입력하세요'), 'error'); return; }
    const orderedIds = profiles.filter((p) => selectedIds.has(p.id)).map((p) => p.id);
    if (scope === 'selected' && orderedIds.length === 0) {
      showToast(translate('scope=\'selected\' 는 프로파일을 1개 이상 선택해야 합니다'), 'error'); return;
    }
    if (cadenceKind === 'cron') {
      if (cron.trim().split(/\s+/).length !== 5) { showToast(translate('cron 은 5개 필드여야 합니다 (예: "0 3 * * *")'), 'error'); return; }
    } else if (!Number.isFinite(intervalMs) || intervalMs < 1000) {
      showToast(translate('주기는 1초 이상이어야 합니다'), 'error'); return;
    }

    const base = {
      account_id: accountId,
      name: name.trim(),
      kind,
      scope,
      profile_ids: scope === 'selected' ? orderedIds : [],
      enabled,
      // stop_on_fail is a scan-batch concept; a checklist refresh has no batch, so
      // store false for that kind (harmless, ignored by the server's refresh path).
      stop_on_fail: kind === 'scan' ? stopOnFail : false,
      cron: cadenceKind === 'cron' ? cron.trim() : null,
      interval_ms: cadenceKind === 'interval' ? intervalMs : null,
    };

    setSaving(true);
    try {
      if (schedule) {
        await api.updateSecuritySchedule(schedule.id, base);
      } else {
        await api.createSecuritySchedule(base);
      }
      showToast(translate('스케줄 {0}됨', { 0: schedule ? translate('수정') : translate('생성') }), 'success');
      onSaved();
    } catch (err: any) {
      showToast(err?.message || translate('Failed to save schedule'), 'error');
    } finally {
      setSaving(false);
    }
  };

  const fieldLabel: React.CSSProperties = { fontSize: 12, fontWeight: 600, color: tokens.colors.textSecondary, marginBottom: 4, display: 'block' };

  return (
    <Modal
      isOpen={true}
      onClose={onClose}
      title={schedule ? translate('보안 스케줄 수정') : translate('새 보안 스케줄')}
      maxWidth={620}
      footer={
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <Button variant="ghost" onClick={onClose}>{translate('Cancel')}</Button>
          <Button variant="primary" onClick={handleSave} disabled={saving}>{saving ? translate('Saving…') : translate('Save')}</Button>
        </div>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <Input label={translate('이름')} value={name} onChange={(e) => setName((e.target as HTMLInputElement).value)} />

        {/* Kind: 점검(scan) vs 체크리스트 갱신(checklist refresh) */}
        <div>
          <Select
            label={translate('종류')}
            value={kind}
            options={[
              { value: 'scan', label: translate('점검 (scan — 순차 batch 실행)') },
              { value: 'checklist_refresh', label: translate('체크리스트 갱신 (checklist refresh — 항목 update, run 미생성)') },
            ]}
            onChange={(e) => setKind((e.target as HTMLSelectElement).value as SecurityScheduleKind)}
          />
          <div style={{ fontSize: 12, color: tokens.colors.textMuted, marginTop: 4 }}>
            {kind === 'checklist_refresh'
              ? translate('대상 프로파일의 체크리스트를 최신 보안 지식(OWASP/CVE 등)으로 갱신합니다. 점검 run/배치를 만들지 않으므로 점검 히스토리를 더럽히지 않고 자주 돌려도 안전합니다.')
              : translate('대상 프로파일을 순차 점검하는 batch 를 실행합니다 (수동 "순차 실행" 과 동일).')}
          </div>
        </div>

        {/* Scope: 전체 vs 선택 프로파일 토글 */}
        <div>
          <label style={fieldLabel}>{translate('대상 프로파일')}</label>
          <div style={{ display: 'flex', gap: 16, marginBottom: scope === 'selected' ? 8 : 0 }}>
            <label style={{ display: 'inline-flex', gap: 6, alignItems: 'center', fontSize: 13, color: tokens.colors.textSecondary, cursor: 'pointer' }}>
              <input type="radio" name="sec-sched-scope" checked={scope === 'all'} onChange={() => setScope('all')} />
              {translate('전체 (실행 시점 enabled 프로파일로 자동 확장)')}</label>
            <label style={{ display: 'inline-flex', gap: 6, alignItems: 'center', fontSize: 13, color: tokens.colors.textSecondary, cursor: 'pointer' }}>
              <input type="radio" name="sec-sched-scope" checked={scope === 'selected'} onChange={() => setScope('selected')} />
              {translate('선택')}</label>
          </div>
          {scope === 'selected' && (
            <div style={{ maxHeight: 180, overflowY: 'auto', border: `1px solid ${tokens.colors.border}`, borderRadius: tokens.radii.sm, padding: 8, display: 'flex', flexDirection: 'column', gap: 4 }}>
              {profiles.length === 0 && <div style={{ fontSize: 12, color: tokens.colors.textMuted }}>{translate('프로파일이 없습니다.')}</div>}
              {profiles.map((p) => (
                <label key={p.id} style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13, color: tokens.colors.textPrimary, cursor: 'pointer' }}>
                  <input type="checkbox" checked={selectedIds.has(p.id)} onChange={() => toggleProfile(p.id)} />
                  {p.name}
                  {!p.enabled && <Pill variant="warning">{translate('disabled')}</Pill>}
                </label>
              ))}
            </div>
          )}
        </div>

        {/* Cadence: interval vs cron */}
        <div>
          <label style={fieldLabel}>{translate('실행 주기')}</label>
          <div style={{ display: 'flex', gap: 16, marginBottom: 8 }}>
            <label style={{ display: 'inline-flex', gap: 6, alignItems: 'center', fontSize: 13, color: tokens.colors.textSecondary, cursor: 'pointer' }}>
              <input type="radio" name="sec-sched-cadence" checked={cadenceKind === 'interval'} onChange={() => setCadenceKind('interval')} />
              {translate('주기 (interval)')}</label>
            <label style={{ display: 'inline-flex', gap: 6, alignItems: 'center', fontSize: 13, color: tokens.colors.textSecondary, cursor: 'pointer' }}>
              <input type="radio" name="sec-sched-cadence" checked={cadenceKind === 'cron'} onChange={() => setCadenceKind('cron')} />
              {translate('cron')}</label>
          </div>
          {cadenceKind === 'interval' ? (
            <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
              <div style={{ width: 120 }}>
                <Input label={translate('값')} type="number" value={intervalValue} onChange={(e) => setIntervalValue((e.target as HTMLInputElement).value)} />
              </div>
              <div style={{ flex: 1 }}>
                <Select
                  label={translate('단위')}
                  value={intervalUnit}
                  options={[
                    { value: 'seconds', label: translate('초') },
                    { value: 'minutes', label: translate('분') },
                    { value: 'hours', label: translate('시간') },
                  ]}
                  onChange={(e) => setIntervalUnit((e.target as HTMLSelectElement).value as 'seconds' | 'minutes' | 'hours')}
                />
              </div>
            </div>
          ) : (
            <Input label={translate('cron (5필드, UTC — 예: "0 3 * * *" = 매일 03:00 UTC)')} value={cron} onChange={(e) => setCron((e.target as HTMLInputElement).value)} />
          )}
        </div>

        {/* stop_on_fail 은 scan batch 전용 개념 — checklist refresh 에는 batch 가 없어 숨김 */}
        {kind === 'scan' && (
          <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13, color: tokens.colors.textSecondary }}>
            <input type="checkbox" checked={stopOnFail} onChange={(e) => setStopOnFail(e.target.checked)} />
            {translate('첫 실패에서 batch 중단 (stop on fail)')}</label>
        )}
        <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13, color: tokens.colors.textSecondary }}>
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          {translate('Enabled')}</label>

        <div style={{ fontSize: 12, color: tokens.colors.textMuted, borderTop: `1px solid ${tokens.colors.border}`, paddingTop: 10 }}>
          {kind === 'checklist_refresh' ? (
            <>{translate('체크리스트 갱신은 코드를 점검하지 않고')} <b>{translate('항목만 update')}</b> {translate('하므로 배포 타이밍 함정(옛 코드 통과)이 없어 자유롭게 자주 돌려도 됩니다. 갱신은 WebSearch 외부 의존이라 실패/레이트리밋 시 기존 체크리스트는')} <b>{translate('비파괴적으로 유지')}</b>{translate('됩니다. cron 은 모두')} <b>UTC</b> {translate('기준입니다.')}</>
          ) : (
            <>{translate('⚠️ 자동 실행은')} <b>{translate('돌고 있는 서버/코드')}</b>{translate('를 검사합니다. main→prod auto-deploy 지연이 있으면, 주기를 배포 지연보다 넉넉히 잡거나 고정 시각 cron 으로 배포 후에 실행되게 하세요. 각 run 은')} <b>scanned_commit</b> {translate('을 기록하므로 어떤 커밋을 검사했는지는 항상 추적 가능합니다. cron 은 모두')} <b>UTC</b> {translate('기준입니다.')}</>
          )}
        </div>
      </div>
    </Modal>
  );
}
