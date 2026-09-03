import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api } from '../../api';
import type {
  Action,
  OrchestrationMissionDetail,
  OrchestrationMissionListItem,
  OrchestrationPostActionCondition,
  OrchestrationTeam,
  OrchestrationUpdateEvent,
} from '../../types';
import { useToast } from '../../contexts/ToastContext';
import { useBoardStreamEvent } from '../../contexts/BoardStreamContext';
import { tokens } from '../../tokens';
import PageHeader from '../PageHeader';
import { Button, EmptyState, Input, Modal, Select } from '../common';
import { relativeTime } from '../../utils/time';
import { missionStyle, progressPercent } from './status';
import { MISSIONS_CHANGED_EVENT } from '../workNavigation';

/**
 * Mission list — the landing surface of Orchestration mode.
 *
 * Live updates come from the `orchestration_update` SSE frame, which carries
 * status + counts, so an active mission's row animates without polling. The
 * frame is a headline only: anything richer (the plan, the timeline) lives in
 * the detail view, which refetches on the same signal.
 */
export default function OrchestrationPage() {
  const { wsId = '' } = useParams<{ wsId: string }>();
  const navigate = useNavigate();
  const { showToast } = useToast();

  const [missions, setMissions] = useState<OrchestrationMissionListItem[]>([]);
  const [teams, setTeams] = useState<OrchestrationTeam[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<'all' | 'active'>('all');
  const [showCreate, setShowCreate] = useState(false);

  const load = useCallback(async () => {
    if (!wsId) return;
    setLoading(true);
    try {
      const [missionList, teamList] = await Promise.all([
        api.listOrchestrationMissions(wsId),
        api.listOrchestrationTeams(wsId).catch(() => [] as OrchestrationTeam[]),
      ]);
      setMissions(missionList);
      setTeams(teamList);
    } catch (e: any) {
      showToast(e?.message || 'Failed to load missions', 'error');
    } finally {
      setLoading(false);
    }
  }, [wsId, showToast]);

  useEffect(() => {
    load();
  }, [load]);

  // Patch the affected row in place rather than refetching the whole list — a
  // busy mission emits an update per step transition and a full reload per
  // frame would thrash the list while the user is reading it.
  useBoardStreamEvent('orchestration_update', (data: OrchestrationUpdateEvent) => {
    if (!data || data.workspace_id !== wsId) return;
    // 삭제된 미션은 제자리 패치가 아니라 목록에서 빼야 한다 — 아래 분기는
    // "아는 미션이면 패치"라서, 그대로 두면 사라진 미션이 행으로 남는다.
    if (data.deleted) {
      setMissions((prev) => prev.filter((m) => m.id !== data.mission_id));
      return;
    }
    setMissions((prev) => {
      const idx = prev.findIndex((m) => m.id === data.mission_id);
      if (idx === -1) {
        // A mission created elsewhere (or by an agent) — pull the list once so
        // it appears without a manual refresh.
        void load();
        return prev;
      }
      const next = [...prev];
      next[idx] = {
        ...next[idx],
        status: data.status,
        counts: data.counts,
        plan_version: data.plan_version,
        updated_at: data.timestamp,
      };
      return next;
    });
  });

  const visible = useMemo(
    () =>
      filter === 'active'
        ? missions.filter((m) => !['completed', 'failed', 'cancelled'].includes(m.status))
        : missions,
    [missions, filter],
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <PageHeader
        title="Orchestrations"
        description="Hand a whole task to a team of agents — the orchestrator plans it, delegates it, and reports back."
        actions={
          <>
            <Select
              aria-label="Filter missions"
              options={[
                { value: 'all', label: 'All missions' },
                { value: 'active', label: 'Active only' },
              ]}
              value={filter}
              onChange={(e) => setFilter(e.target.value as 'all' | 'active')}
            />
            <Button variant="primary" onClick={() => setShowCreate(true)} disabled={teams.length === 0}>
              New mission
            </Button>
          </>
        }
      />

      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 20 }}>
        {loading ? (
          <div style={{ color: tokens.colors.textMuted, fontSize: 13 }}>Loading missions...</div>
        ) : teams.length === 0 ? (
          <EmptyState
            title="No teams yet"
            description="A mission runs on a team: one orchestrator agent that plans, plus the members it delegates to. Create a team first."
            action={<Button variant="primary" onClick={() => navigate(`/ws/${wsId}/teams`)}>Create a team</Button>}
          />
        ) : visible.length === 0 ? (
          <EmptyState
            title={filter === 'active' ? 'No active missions' : 'No missions yet'}
            description="Describe a task and pick a team — the orchestrator breaks it into steps and assigns them itself."
            action={<Button variant="primary" onClick={() => setShowCreate(true)}>New mission</Button>}
          />
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {visible.map((mission) => (
              <MissionRow
                key={mission.id}
                mission={mission}
                onOpen={() => navigate(`/ws/${wsId}/orchestration/missions/${mission.id}`)}
              />
            ))}
          </div>
        )}
      </div>

      <MissionFormModal
        isOpen={showCreate}
        wsId={wsId}
        teams={teams}
        mission={null}
        onClose={() => setShowCreate(false)}
        onSaved={(mission) => {
          setShowCreate(false);
          navigate(`/ws/${wsId}/orchestration/missions/${mission.id}`);
        }}
      />
    </div>
  );
}

function MissionRow({
  mission,
  onOpen,
}: {
  mission: OrchestrationMissionListItem;
  onOpen: () => void;
}) {
  const style = missionStyle(mission.status);
  const pct = progressPercent(mission.counts);

  return (
    <button
      type="button"
      onClick={onOpen}
      style={{
        display: 'block',
        width: '100%',
        textAlign: 'left',
        padding: '14px 16px',
        borderRadius: 10,
        border: `1px solid ${tokens.colors.border}`,
        borderLeft: `3px solid ${style.color}`,
        background: tokens.colors.surfaceCard,
        color: tokens.colors.textPrimary,
        cursor: 'pointer',
        fontFamily: 'inherit',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span
          style={{
            padding: '2px 8px',
            borderRadius: 999,
            fontSize: 10,
            fontWeight: 700,
            letterSpacing: '0.04em',
            textTransform: 'uppercase',
            color: style.color,
            background: style.background,
          }}
        >
          {style.label}
        </span>
        <span style={{ fontSize: 14, fontWeight: 600, flex: 1, minWidth: 0 }}>{mission.title}</span>
        <span style={{ fontSize: 11, color: tokens.colors.textMuted }}>
          {mission.finished_at
            ? `finished ${relativeTime(mission.finished_at)}`
            : mission.started_at
              ? `started ${relativeTime(mission.started_at)}`
              : `created ${relativeTime(mission.created_at)}`}
        </span>
      </div>

      <div style={{ marginTop: 6, display: 'flex', alignItems: 'center', gap: 14, fontSize: 11, color: tokens.colors.textSecondary }}>
        <span>
          Team <strong style={{ color: tokens.colors.textStrong }}>{mission.team_name}</strong>
        </span>
        {mission.orchestrator_name && <span>Orchestrator {mission.orchestrator_name}</span>}
        {mission.plan_version > 0 && <span>Plan v{mission.plan_version}</span>}
        <span style={{ marginLeft: 'auto' }}>
          {mission.counts.done}/{mission.counts.total} steps
          {mission.counts.inFlight > 0 && ` · ${mission.counts.inFlight} working`}
          {mission.counts.failed > 0 && ` · ${mission.counts.failed} failed`}
        </span>
      </div>

      <div
        style={{
          marginTop: 8,
          height: 4,
          borderRadius: 999,
          background: `${tokens.colors.border}80`,
          overflow: 'hidden',
          display: 'flex',
        }}
      >
        <div style={{ width: `${pct}%`, background: style.color, transition: 'width 300ms ease' }} />
      </div>
    </button>
  );
}

/**
 * Mission 생성/편집 모달 — `mission`이 null이면 생성, 그렇지 않으면 그 draft
 * 미션의 편집(TeamFormModal이 팀에 대해 쓰는 것과 동일한 단일-컴포넌트
 * create/edit 패턴). 편집은 서버 `updateMission`이 draft 상태에서만 브리핑
 * 필드 편집을 허용하므로 draft 미션에서만 열린다(MissionDetailPage 참고).
 */
export function MissionFormModal({
  isOpen,
  wsId,
  teams,
  mission,
  onClose,
  onSaved,
}: {
  isOpen: boolean;
  wsId: string;
  teams: OrchestrationTeam[];
  mission: OrchestrationMissionDetail | null;
  onClose: () => void;
  onSaved: (mission: OrchestrationMissionDetail) => void;
}) {
  const { showToast } = useToast();
  const [title, setTitle] = useState('');
  const [teamId, setTeamId] = useState('');
  const [objective, setObjective] = useState('');
  const [context, setContext] = useState('');
  const [criteria, setCriteria] = useState('');
  const [startNow, setStartNow] = useState(true);
  const [saving, setSaving] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [method, setMethod] = useState('');
  const [workspaceFolder, setWorkspaceFolder] = useState('');
  const [checkoutMode, setCheckoutMode] = useState<'reuse' | 'fresh'>('reuse');
  const [completionCriteria, setCompletionCriteria] = useState<Array<{ key: string; description: string }>>([]);
  const [postActions, setPostActions] = useState<
    Array<{ action_id: string; order: number; condition: OrchestrationPostActionCondition }>
  >([]);
  const [repoResourceId, setRepoResourceId] = useState('');
  const [repoUrl, setRepoUrl] = useState('');
  const [repoBranch, setRepoBranch] = useState('');
  const [actions, setActions] = useState<Action[]>([]);

  useEffect(() => {
    if (!isOpen) return;
    api.listActions(wsId).then(setActions).catch(() => setActions([]));
    setTitle(mission?.title || '');
    setObjective(mission?.objective || '');
    setContext(mission?.context || '');
    setCriteria(mission?.acceptance_criteria || '');
    setStartNow(true);
    setShowAdvanced(!!mission && (!!mission.method || mission.completion_criteria.length > 0 || mission.post_actions.length > 0 || !!mission.workspace_folder || !!mission.repo_ref));
    setMethod(mission?.method || '');
    setWorkspaceFolder(mission?.workspace_folder || '');
    setCheckoutMode(mission?.checkout_mode || 'reuse');
    setCompletionCriteria((mission?.completion_criteria || []).map((c) => ({ key: c.key, description: c.description })));
    setPostActions((mission?.post_actions || []).map((p) => ({ action_id: p.action_id, order: p.order, condition: p.condition })));
    setRepoResourceId(mission?.repo_ref?.resource_id || '');
    setRepoUrl(mission?.repo_ref?.url || '');
    setRepoBranch(mission?.repo_ref?.branch || '');
    setTeamId(mission?.team_id || teams.find((t) => t.enabled && t.members.length > 0)?.id || teams[0]?.id || '');
  }, [isOpen, mission, teams, wsId]);

  const selectedTeam = teams.find((t) => t.id === teamId) || null;

  const submit = async () => {
    if (!title.trim() || !objective.trim() || !teamId) {
      showToast('Title, objective and team are required', 'error');
      return;
    }
    const cleanCriteria = completionCriteria
      .map((c) => ({ key: c.key.trim(), description: c.description.trim() }))
      .filter((c) => c.key && c.description);
    // "+ Add"는 order를 그 시점의 postActions.length로, "Remove"는 재번호 없이
    // 그 자리만 뺀다 — 추가/삭제를 반복하면 order가 중복되거나 건너뛸 수 있다.
    // order는 이제 post-action의 상관관계 키(orchestration:<mission>:<order>)
    // 일부라 유일성이 실제로 중요하므로(리뷰 지적 반영, 티켓 2dc3c62f), 제출
    // 직전에 최종 배열 순서 그대로 0..N-1로 다시 매긴다.
    const cleanPostActions = postActions.filter((p) => p.action_id).map((p, idx) => ({ ...p, order: idx }));
    const repoRef =
      repoResourceId.trim() || repoUrl.trim() || repoBranch.trim()
        ? {
            ...(repoResourceId.trim() ? { resource_id: repoResourceId.trim() } : {}),
            ...(repoUrl.trim() ? { url: repoUrl.trim() } : {}),
            ...(repoBranch.trim() ? { branch: repoBranch.trim() } : {}),
          }
        : null;
    setSaving(true);
    try {
      const saved = mission
        ? await api.updateOrchestrationMission(mission.id, {
            workspace_id: wsId,
            title: title.trim(),
            objective: objective.trim(),
            context: context.trim(),
            acceptance_criteria: criteria.trim(),
            method: method.trim(),
            completion_criteria: cleanCriteria,
            post_actions: cleanPostActions,
            workspace_folder: workspaceFolder.trim(),
            repo_ref: repoRef,
            checkout_mode: checkoutMode,
          })
        : await api.createOrchestrationMission({
            workspace_id: wsId,
            team_id: teamId,
            title: title.trim(),
            objective: objective.trim(),
            context: context.trim(),
            acceptance_criteria: criteria.trim(),
            method: method.trim(),
            completion_criteria: cleanCriteria.length ? cleanCriteria : undefined,
            post_actions: cleanPostActions.length ? cleanPostActions : undefined,
            workspace_folder: workspaceFolder.trim(),
            repo_ref: repoRef,
            checkout_mode: checkoutMode,
            start: startNow,
          });
      if (!mission && saved.start_error) {
        showToast(`Mission created but not started: ${saved.start_error}`, 'error');
      } else {
        showToast(mission ? 'Mission updated' : startNow ? 'Mission briefed to the orchestrator' : 'Mission saved as a draft', 'success');
      }
      // 사이드바 WORK > Orchestrations 서브메뉴가 같은 목록을 그린다(티켓 03ca8b5b).
      // 생성/이름변경 모두 이 한 곳을 지나므로 여기서 방송한다.
      window.dispatchEvent(new CustomEvent(MISSIONS_CHANGED_EVENT));
      onSaved(saved);
    } catch (e: any) {
      showToast(e?.message || 'Failed to save mission', 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={mission ? 'Edit mission' : 'New mission'}
      maxWidth={640}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button variant="primary" onClick={submit} loading={saving}>
            {mission ? 'Save' : startNow ? 'Create & brief orchestrator' : 'Save draft'}
          </Button>
        </>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <Input label="Title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Ship the billing export" />

        <Select
          label="Team"
          disabled={!!mission}
          options={teams.map((t) => ({
            value: t.id,
            label:
              `${t.name} — ${t.orchestrator_name || 'no orchestrator'} + ${t.members.length} member(s)` +
              (t.enabled ? '' : ' (disabled)'),
          }))}
          value={teamId}
          onChange={(e) => setTeamId(e.target.value)}
        />
        {selectedTeam && selectedTeam.members.length === 0 && (
          <div style={{ fontSize: 11, color: tokens.colors.warningLight }}>
            This team has no members — the orchestrator will have nobody to delegate to.
          </div>
        )}

        <LabeledTextarea
          label="Objective"
          hint="What must be achieved. The orchestrator plans directly from this, so be concrete about scope."
          value={objective}
          onChange={setObjective}
          rows={5}
          placeholder="Add a CSV export of monthly invoices to the billing page, behind the existing feature flag."
        />
        <LabeledTextarea
          label="Context (optional)"
          hint="Background, links, prior art, constraints."
          value={context}
          onChange={setContext}
          rows={3}
        />
        <LabeledTextarea
          label="Acceptance criteria (optional)"
          hint="How the orchestrator decides the mission is finished. It is told to verify these before completing."
          value={criteria}
          onChange={setCriteria}
          rows={3}
        />

        <button
          type="button"
          onClick={() => setShowAdvanced((v) => !v)}
          style={{
            alignSelf: 'flex-start',
            border: 'none',
            background: 'transparent',
            color: tokens.colors.accentSubtle,
            cursor: 'pointer',
            fontSize: 12,
            fontFamily: 'inherit',
            padding: 0,
          }}
        >
          {showAdvanced ? '▾' : '▸'} Advanced — execution contract & workspace
        </button>

        {showAdvanced && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14, paddingLeft: 4, borderLeft: `2px solid ${tokens.colors.border}` }}>
            <LabeledTextarea
              label="Method (optional)"
              hint="How the team should approach it — constraints, non-negotiables, preferred approach. Separate from the objective (what)."
              value={method}
              onChange={setMethod}
              rows={2}
            />
            <div>
              <span style={{ display: 'block', fontSize: 12, fontWeight: 600, color: tokens.colors.textStrong, marginBottom: 4 }}>
                Structured completion criteria (optional)
              </span>
              <span style={{ display: 'block', fontSize: 11, color: tokens.colors.textMuted, marginBottom: 6, lineHeight: 1.4 }}>
                On top of the acceptance-criteria prose above — when set, the mission cannot be marked "completed"
                until the orchestrator has flipped every one of these to met.
              </span>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {completionCriteria.map((c, i) => (
                  <div key={i} style={{ display: 'flex', gap: 6 }}>
                    <input
                      value={c.key}
                      placeholder="key, e.g. tests-pass"
                      onChange={(e) => {
                        const next = [...completionCriteria];
                        next[i] = { ...next[i], key: e.target.value };
                        setCompletionCriteria(next);
                      }}
                      style={{ width: 140, padding: '7px 9px', borderRadius: 6, border: `1px solid ${tokens.colors.border}`, background: tokens.colors.surface, color: tokens.colors.textPrimary, fontSize: 12, fontFamily: 'inherit' }}
                    />
                    <input
                      value={c.description}
                      placeholder="Description — how it's verified"
                      onChange={(e) => {
                        const next = [...completionCriteria];
                        next[i] = { ...next[i], description: e.target.value };
                        setCompletionCriteria(next);
                      }}
                      style={{ flex: 1, padding: '7px 9px', borderRadius: 6, border: `1px solid ${tokens.colors.border}`, background: tokens.colors.surface, color: tokens.colors.textPrimary, fontSize: 12, fontFamily: 'inherit' }}
                    />
                    <Button variant="ghost" size="sm" onClick={() => setCompletionCriteria(completionCriteria.filter((_, j) => j !== i))}>
                      Remove
                    </Button>
                  </div>
                ))}
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => setCompletionCriteria([...completionCriteria, { key: '', description: '' }])}
                >
                  + Add criterion
                </Button>
              </div>
            </div>
            <div>
              <span style={{ display: 'block', fontSize: 12, fontWeight: 600, color: tokens.colors.textStrong, marginBottom: 4 }}>
                Post-completion actions (optional)
              </span>
              <span style={{ display: 'block', fontSize: 11, color: tokens.colors.textMuted, marginBottom: 6, lineHeight: 1.4 }}>
                Actions to dispatch once the mission ends. Fire-and-forget — a dispatch failure is recorded but never
                changes the mission's own outcome.
              </span>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {postActions.map((p, i) => (
                  <div key={i} style={{ display: 'flex', gap: 6 }}>
                    <select
                      value={p.action_id}
                      onChange={(e) => {
                        const next = [...postActions];
                        next[i] = { ...next[i], action_id: e.target.value };
                        setPostActions(next);
                      }}
                      style={{ flex: 1, padding: '7px 9px', borderRadius: 6, border: `1px solid ${tokens.colors.border}`, background: tokens.colors.surface, color: tokens.colors.textPrimary, fontSize: 12, fontFamily: 'inherit' }}
                    >
                      <option value="">Select an action…</option>
                      {actions.map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.name}
                        </option>
                      ))}
                    </select>
                    <select
                      value={p.condition}
                      onChange={(e) => {
                        const next = [...postActions];
                        next[i] = { ...next[i], condition: e.target.value as OrchestrationPostActionCondition };
                        setPostActions(next);
                      }}
                      style={{ width: 130, padding: '7px 9px', borderRadius: 6, border: `1px solid ${tokens.colors.border}`, background: tokens.colors.surface, color: tokens.colors.textPrimary, fontSize: 12, fontFamily: 'inherit' }}
                    >
                      <option value="always">always</option>
                      <option value="on_success">on_success</option>
                      <option value="on_failure">on_failure</option>
                    </select>
                    <Button variant="ghost" size="sm" onClick={() => setPostActions(postActions.filter((_, j) => j !== i))}>
                      Remove
                    </Button>
                  </div>
                ))}
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => setPostActions([...postActions, { action_id: '', order: postActions.length, condition: 'always' }])}
                >
                  + Add post-action
                </Button>
              </div>
            </div>
            <div>
              <Input
                label="Workspace folder root (optional)"
                value={workspaceFolder}
                onChange={(e) => setWorkspaceFolder(e.target.value)}
                placeholder=".awb/orch/<mission id> (default)"
              />
              <span style={{ display: 'block', fontSize: 11, color: tokens.colors.textMuted, marginTop: 4, lineHeight: 1.4 }}>
                working_dir-relative root every step's isolated folder nests under. Default: .awb/orch/&lt;mission id&gt;.
              </span>
            </div>
            <Select
              label="Checkout mode"
              options={[
                { value: 'reuse', label: 'Reuse — fetch + fast-forward before each step' },
                { value: 'fresh', label: 'Fresh — wipe + re-checkout before each step' },
              ]}
              value={checkoutMode}
              onChange={(e) => setCheckoutMode(e.target.value as 'reuse' | 'fresh')}
            />
            <div>
              <span style={{ display: 'block', fontSize: 12, fontWeight: 600, color: tokens.colors.textStrong, marginBottom: 4 }}>
                Repo (optional)
              </span>
              <span style={{ display: 'block', fontSize: 11, color: tokens.colors.textMuted, marginBottom: 6, lineHeight: 1.4 }}>
                Checked out for every step. Leave all blank to reuse the board/workspace environment_config repo.
              </span>
              <div style={{ display: 'flex', gap: 6 }}>
                <input
                  value={repoResourceId}
                  placeholder="Resource id (preferred)"
                  onChange={(e) => setRepoResourceId(e.target.value)}
                  style={{ flex: 1, padding: '7px 9px', borderRadius: 6, border: `1px solid ${tokens.colors.border}`, background: tokens.colors.surface, color: tokens.colors.textPrimary, fontSize: 12, fontFamily: 'inherit' }}
                />
                <input
                  value={repoUrl}
                  placeholder="or raw git URL"
                  onChange={(e) => setRepoUrl(e.target.value)}
                  style={{ flex: 1, padding: '7px 9px', borderRadius: 6, border: `1px solid ${tokens.colors.border}`, background: tokens.colors.surface, color: tokens.colors.textPrimary, fontSize: 12, fontFamily: 'inherit' }}
                />
                <input
                  value={repoBranch}
                  placeholder="branch (optional)"
                  onChange={(e) => setRepoBranch(e.target.value)}
                  style={{ width: 130, padding: '7px 9px', borderRadius: 6, border: `1px solid ${tokens.colors.border}`, background: tokens.colors.surface, color: tokens.colors.textPrimary, fontSize: 12, fontFamily: 'inherit' }}
                />
              </div>
            </div>
          </div>
        )}

        {!mission && (
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: tokens.colors.textSecondary }}>
            <input type="checkbox" checked={startNow} onChange={(e) => setStartNow(e.target.checked)} />
            Brief the orchestrator immediately
          </label>
        )}
      </div>
    </Modal>
  );
}

export function LabeledTextarea({
  label,
  hint,
  value,
  onChange,
  rows = 4,
  placeholder,
}: {
  label: string;
  hint?: string;
  value: string;
  onChange: (v: string) => void;
  rows?: number;
  placeholder?: string;
}) {
  return (
    <label style={{ display: 'block' }}>
      <span style={{ display: 'block', fontSize: 12, fontWeight: 600, color: tokens.colors.textStrong, marginBottom: 4 }}>
        {label}
      </span>
      {hint && (
        <span style={{ display: 'block', fontSize: 11, color: tokens.colors.textMuted, marginBottom: 6, lineHeight: 1.4 }}>
          {hint}
        </span>
      )}
      <textarea
        value={value}
        rows={rows}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        style={{
          width: '100%',
          padding: '9px 11px',
          borderRadius: 6,
          border: `1px solid ${tokens.colors.border}`,
          background: tokens.colors.surface,
          color: tokens.colors.textPrimary,
          fontSize: 13,
          fontFamily: 'inherit',
          lineHeight: 1.5,
          resize: 'vertical',
          boxSizing: 'border-box',
        }}
      />
    </label>
  );
}
